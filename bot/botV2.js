import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';

import {
  fetchMatches,
  fetchUpcomingMatchesForTeam,
  loadMatchesFromDb,
  searchTeams
} from '../api/matchBrowserV2.js';
import { getPredictionDebug, predictMatch } from '../ai/predictorV3.js';
import { getDb } from '../data/db.js';
import { setupDatabase } from '../data/dbSetup.js';

dotenv.config();
setupDatabase();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set in environment (.env)');

const bot = new Telegraf(TELEGRAM_TOKEN);

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: process.env.API_TIMEZONE ?? 'Europe/Berlin'
});

const PAGE_SIZE = 10;
const TEAM_SEARCH_CACHE = new Map();

const ICON = {
  live: '\u{1F534}',
  football: '\u{26BD}',
  basketball: '\u{1F3C0}',
  today: '\u{1F4C5}',
  soon: '\u{1F5D3}',
  search: '\u{1F50E}',
  debug: '\u{1F527}',
  home: '\u{1F3E0}',
  back: '\u{2B05}\u{FE0F}',
  next: '\u{27A1}\u{FE0F}'
};

const CATEGORY_KEYBOARD = () => Markup.inlineKeyboard([
  [Markup.button.callback(`${ICON.football} Fussball`, 'matches:sport:football')],
  [Markup.button.callback(`${ICON.basketball} Basketball`, 'matches:sport:basketball')],
  [Markup.button.callback(`${ICON.search} Team suchen`, 'search:help')]
]);

const SPORT_KEYBOARD = (sport) => Markup.inlineKeyboard([
  [Markup.button.callback(`${ICON.live} Live-Spiele`, `matches:${sport}:live:1`)],
  [Markup.button.callback(`${ICON.today} Heute`, `matches:${sport}:upcoming:today:1`)],
  [Markup.button.callback(`${ICON.soon} Demnächst`, `matches:${sport}:upcoming:soon:1`)],
  ...(sport === 'football' ? [[Markup.button.callback(`${ICON.search} Team suchen`, 'search:help')]] : []),
  [Markup.button.callback(`${ICON.home} Hauptmenü`, 'matches:root')]
]);

bot.start(async (ctx) => {
  await ctx.reply([
    'Willkommen bei GamblerGPT v3.',
    '',
    'Ich nutze API-Daten, Team-Historie, H2H, Odds, Injuries, Standings, lokale Stats und einen robusteren Predictor.',
    '',
    'Befehle:',
    '- /matches',
    '- /search Bayern',
    '- /team Real Madrid',
    '- /predict 1335952',
    '- /debug_match 1335952'
  ].join('\n'), CATEGORY_KEYBOARD());
});

bot.command('matches', async (ctx) => {
  await ctx.reply('Welche Sportart?', CATEGORY_KEYBOARD());
});

bot.command(['search', 'team'], async (ctx) => {
  const query = extractCommandArgs(ctx.message?.text);
  if (!query) {
    await ctx.reply('Bitte Teamnamen angeben, z. B. /search Bayern');
    return;
  }
  await handleTeamSearch(ctx, query, 'reply');
});

bot.command('predict', async (ctx) => {
  const id = Number(extractCommandArgs(ctx.message?.text).split(/\s+/)[0]);
  if (!Number.isFinite(id)) {
    await ctx.reply('Bitte gültige Match-ID angeben, z. B. /predict 1335952');
    return;
  }
  await ctx.reply(`Berechne Prediction für Match ${id} ...`);
  await respondWithPrediction(ctx, id, 'reply');
});

bot.command('debug_match', async (ctx) => {
  const id = Number(extractCommandArgs(ctx.message?.text).split(/\s+/)[0]);
  if (!Number.isFinite(id)) {
    await ctx.reply('Bitte gültige Match-ID angeben, z. B. /debug_match 1335952');
    return;
  }
  await ctx.reply(`Prüfe Datenbasis für Match ${id} ...`);
  await respondWithDebug(ctx, id, 'reply');
});

bot.action('matches:root', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Welche Sportart?', CATEGORY_KEYBOARD());
});

bot.action('search:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText([
    `${ICON.search} Team-Suche`,
    '',
    'Schreib:',
    '/search Bayern',
    '/team Real Madrid'
  ].join('\n'), CATEGORY_KEYBOARD());
});

bot.action(/^matches:sport:(football|basketball)$/, async (ctx) => {
  const sport = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Welche ${sport === 'basketball' ? 'Basketball' : 'Fussball'}-Spiele?`, SPORT_KEYBOARD(sport));
});

bot.action(/^matches:(football|basketball):live:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showMatches(ctx, ctx.match[1], 'live', undefined, Number(ctx.match[2]));
});

bot.action(/^matches:(football|basketball):upcoming:(today|soon):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showMatches(ctx, ctx.match[1], 'upcoming', ctx.match[2], Number(ctx.match[3]));
});

bot.action(/^team:(\d+):games:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showTeamUpcoming(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
});

bot.action(/^match:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Berechne Prediction für Match ${id} ...`);
  await respondWithPrediction(ctx, id, 'edit');
});

bot.action(/^debug:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Prüfe Datenbasis für Match ${id} ...`);
  await respondWithDebug(ctx, id, 'edit');
});

async function handleTeamSearch(ctx, query, mode) {
  try {
    const teams = await searchTeams(query, { sport: 'football', limit: 8 });
    if (!teams.length) {
      await send(ctx, mode, escapeHtml(`Keine Teams für "${query}" gefunden.`), CATEGORY_KEYBOARD());
      return;
    }

    for (const team of teams) TEAM_SEARCH_CACHE.set(team.id, team);
    const rows = teams.map((team) => [Markup.button.callback(formatTeamButton(team), `team:${team.id}:games:1`)]);
    rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'matches:root')]);

    await send(ctx, mode, escapeHtml(`${ICON.search} Suchergebnisse für "${query}":`), Markup.inlineKeyboard(rows));
  } catch (error) {
    await send(ctx, mode, escapeHtml(`Team-Suche fehlgeschlagen: ${error.message}`), CATEGORY_KEYBOARD());
  }
}

async function showTeamUpcoming(ctx, teamId, page = 1) {
  const team = TEAM_SEARCH_CACHE.get(teamId) ?? { id: teamId, name: `Team ${teamId}` };
  const limit = page * PAGE_SIZE + 1;
  let matches = await fetchUpcomingMatchesForTeam(teamId, { sport: 'football', limit });
  if (!matches.length) matches = loadTeamMatchesFromDb(teamId, limit);

  const sliceStart = (page - 1) * PAGE_SIZE;
  const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);

  if (!pageItems.length) {
    await ctx.editMessageText(`Keine kommenden Spiele für ${team.name} gefunden.`, CATEGORY_KEYBOARD());
    return;
  }

  const rows = pageItems.map((match) => [Markup.button.callback(formatMatchLabel(match, 'football'), `match:${resolveMatchId(match, 'football')}`)]);
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback(`${ICON.back} Zurück`, `team:${teamId}:games:${page - 1}`));
  if (matches.length > sliceStart + PAGE_SIZE) nav.push(Markup.button.callback(`${ICON.next} Mehr`, `team:${teamId}:games:${page + 1}`));
  if (nav.length) rows.push(nav);

  const firstId = resolveMatchId(pageItems[0], 'football');
  if (firstId) rows.push([Markup.button.callback(`${ICON.debug} Debug erstes Spiel`, `debug:${firstId}`)]);
  rows.push([Markup.button.callback(`${ICON.search} Andere Suche`, 'search:help')]);
  rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'matches:root')]);

  await ctx.editMessageText(`${ICON.football} Nächste Spiele für ${team.name}:`, Markup.inlineKeyboard(rows));
}

async function showMatches(ctx, sport, mode, range, page = 1) {
  const sliceStart = (page - 1) * PAGE_SIZE;
  const limit = sliceStart + PAGE_SIZE + 1;
  const apiMatches = await fetchMatches({ sport, mode, range, limit });
  let matches = apiMatches;
  if (!matches.length) matches = loadMatchesFromDb(mode, limit, range, sport);

  const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);
  if (!pageItems.length) {
    await ctx.editMessageText('Keine Spiele gefunden.', SPORT_KEYBOARD(sport));
    return;
  }

  const rows = pageItems
    .map((match) => {
      const id = resolveMatchId(match, sport);
      return id ? [Markup.button.callback(formatMatchLabel(match, sport), `match:${id}`)] : null;
    })
    .filter(Boolean);

  const nav = [];
  const rangePart = mode === 'upcoming' ? `:upcoming:${range}` : ':live';
  if (page > 1) nav.push(Markup.button.callback(`${ICON.back} Zurück`, `matches:${sport}${rangePart}:${page - 1}`));
  if (matches.length > sliceStart + PAGE_SIZE) nav.push(Markup.button.callback(`${ICON.next} Mehr`, `matches:${sport}${rangePart}:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback(`${sport === 'basketball' ? ICON.basketball : ICON.football} Menü`, `matches:sport:${sport}`)]);
  rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'matches:root')]);

  await ctx.editMessageText('Wähle ein Match für eine Prediction:', Markup.inlineKeyboard(rows));
}

async function respondWithPrediction(ctx, matchId, mode) {
  try {
    const result = await predictMatch(matchId);
    if (!result || result.error) {
      await send(ctx, mode, escapeHtml(`Fehler: ${result?.error ?? 'Keine Prediction verfügbar'}`), CATEGORY_KEYBOARD());
      return;
    }

    const match = getMatchDetails(matchId);
    const text = formatPredictionMessage(result, match);
    const sport = match?.sport ?? 'football';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`${ICON.debug} Datenbasis anzeigen`, `debug:${matchId}`)],
      [Markup.button.callback(`${ICON.live} Live-Spiele`, `matches:${sport}:live:1`)],
      [Markup.button.callback(`${ICON.soon} Demnächst`, `matches:${sport}:upcoming:soon:1`)],
      [Markup.button.callback(`${ICON.home} Hauptmenü`, 'matches:root')]
    ]);
    await send(ctx, mode, text, keyboard);
  } catch (error) {
    await send(ctx, mode, escapeHtml(`Prediction fehlgeschlagen: ${error.message}`), CATEGORY_KEYBOARD());
  }
}

async function respondWithDebug(ctx, matchId, mode) {
  try {
    const debug = await getPredictionDebug(matchId);
    const text = formatDebugMessage(debug);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Prediction berechnen', `match:${matchId}`)],
      [Markup.button.callback(`${ICON.home} Hauptmenü`, 'matches:root')]
    ]);
    await send(ctx, mode, text, keyboard);
  } catch (error) {
    await send(ctx, mode, escapeHtml(`Debug fehlgeschlagen: ${error.message}`), CATEGORY_KEYBOARD());
  }
}

async function send(ctx, mode, html, replyMarkup) {
  const extra = { parse_mode: 'HTML', ...(replyMarkup ?? {}) };
  if (mode === 'edit') await ctx.editMessageText(trimTelegram(html), extra);
  else await ctx.reply(trimTelegram(html), extra);
}

function formatPredictionMessage(result, match) {
  const home = match?.home_team ?? 'Heimteam';
  const away = match?.away_team ?? 'Auswärtsteam';
  const probs = result.probabilities ?? {};
  const betting = result.betting_advice ?? {};
  const diag = result.data_quality?.diagnostics;
  const kickOff = match?.date ? DATE_TIME_FORMAT.format(new Date(match.date)) : 'Unbekannt';

  return [
    `<b>Match:</b> ${escapeHtml(home)} vs ${escapeHtml(away)}`,
    match?.league_name ? `<b>Liga:</b> ${escapeHtml(match.league_name)}` : null,
    `<b>Anstoß:</b> ${escapeHtml(kickOff)}`,
    `<b>Engine:</b> ${escapeHtml(result.engine ?? 'unknown')}`,
    diag ? `<b>Daten:</b> ${escapeHtml(diag.localQualityLabel)} | Samples ${escapeHtml(diag.totalGames)} | H2H ${escapeHtml(diag.h2hCount)} | usable ${diag.hasUsableSamples ? 'ja' : 'nein'}` : null,
    '',
    '<u>Prediction</u>',
    `<b>Vorhersage:</b> ${escapeHtml(describePrediction(result.prediction, home, away))}`,
    `<b>${escapeHtml(home)}:</b> ${escapeHtml(formatPercent(probs.home))}`,
    `<b>Unentschieden:</b> ${escapeHtml(formatPercent(probs.draw))}`,
    `<b>${escapeHtml(away)}:</b> ${escapeHtml(formatPercent(probs.away))}`,
    '',
    '<u>Wett-Empfehlung</u>',
    `<b>Empfehlung:</b> ${escapeHtml(describePrediction(betting.recommendation, home, away))}`,
    `<b>Sicherheit:</b> ${escapeHtml(formatPercent(betting.confidence))}`,
    betting.reasoning ? `<b>Begründung:</b> ${escapeHtml(betting.reasoning)}` : null,
    '',
    result.explanation ? `<b>Analyse:</b> ${escapeHtml(result.explanation)}` : null,
    '',
    '<i>Nur Analyse, keine sichere Wette. Spiel nicht mit Geld, das du brauchst.</i>'
  ].filter((line) => line !== null).join('\n');
}

function formatDebugMessage(debug) {
  if (debug.error) return escapeHtml(`Debug-Fehler: ${debug.error}`);
  const match = debug.match ?? {};
  const diag = debug.diagnostics ?? {};
  const features = debug.features ?? {};
  const external = debug.external ?? {};
  const recentFetches = (debug.recentApiFetches ?? []).slice(0, 5)
    .map((row) => `- ${row.ok ? 'OK' : 'FAIL'} ${row.label} | count=${row.response_count}${row.error ? ` | ${row.error}` : ''}`)
    .join('\n');

  return [
    `<b>${ICON.debug} Debug Match ${escapeHtml(match.match_id ?? '?')}</b>`,
    `<b>Match:</b> ${escapeHtml(match.home_team ?? '?')} vs ${escapeHtml(match.away_team ?? '?')}`,
    `<b>Datum:</b> ${escapeHtml(match.date ?? '?')}`,
    `<b>Liga:</b> ${escapeHtml(match.league_name ?? '?')}`,
    '',
    '<u>Lokale Daten</u>',
    `<b>Feature Row:</b> ${diag.hasFeatureRow ? 'ja' : 'nein'}`,
    `<b>Usable Samples:</b> ${diag.hasUsableSamples ? 'ja' : 'nein'}`,
    `<b>Qualität:</b> ${escapeHtml(diag.localQualityLabel ?? '?')}`,
    `<b>Home History:</b> ${escapeHtml(debug.localData?.homeRecentCount ?? 0)}`,
    `<b>Away History:</b> ${escapeHtml(debug.localData?.awayRecentCount ?? 0)}`,
    `<b>H2H:</b> ${escapeHtml(debug.localData?.h2hCount ?? 0)}`,
    `<b>Home Games:</b> ${escapeHtml(features.home_games ?? 0)} | Form ${escapeHtml(features.home_recent_form ?? 'n/a')}`,
    `<b>Away Games:</b> ${escapeHtml(features.away_games ?? 0)} | Form ${escapeHtml(features.away_recent_form ?? 'n/a')}`,
    '',
    '<u>Externe Daten</u>',
    `<b>Verfügbar:</b> ${external.available ? 'ja' : 'nein'}`,
    external.reason ? `<b>Grund:</b> ${escapeHtml(external.reason)}` : null,
    `<b>API Prediction:</b> ${external.hasApiPrediction ? 'ja' : 'nein'}`,
    `<b>Odds:</b> ${external.hasOdds ? 'ja' : 'nein'}`,
    `<b>Standings:</b> ${external.hasStandings ? 'ja' : 'nein'}`,
    external.quality ? `<b>Qualität:</b> ${escapeHtml(external.quality.label)} (${escapeHtml(external.quality.score)}/100)` : null,
    '',
    '<u>Letzte API Fetches</u>',
    recentFetches ? escapeHtml(recentFetches) : 'Keine Fetch-Logs.',
    '',
    '<u>AI</u>',
    `<b>Ollama:</b> ${debug.ollama?.enabled ? escapeHtml(debug.ollama.model) : 'aus'}`,
    `<b>Remote Llama:</b> ${debug.llama?.enabled ? 'an' : 'aus'}`
  ].filter((line) => line !== null).join('\n');
}

function loadTeamMatchesFromDb(teamId, limit) {
  const db = getDb();
  return db.prepare(`
    SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals, league_name
    FROM matches
    WHERE sport = 'football'
      AND (home_team_id = @teamId OR away_team_id = @teamId)
      AND date IS NOT NULL
      AND datetime(date) >= datetime('now')
    ORDER BY datetime(date) ASC
    LIMIT @limit
  `).all({ teamId, limit });
}

function getMatchDetails(matchId) {
  const id = Number(matchId);
  if (!Number.isFinite(id)) return null;
  const db = getDb();
  return db.prepare(`
    SELECT match_id, sport, date, status, home_team, away_team, home_goals, away_goals, league_name, league_country, season, round
    FROM matches
    WHERE match_id = @id
  `).get({ id }) ?? null;
}

function resolveMatchId(match, sportHint = 'football') {
  if (!match) return null;
  if (match.match_id !== undefined && match.match_id !== null) return Number(match.match_id);
  if (sportHint === 'basketball') return 5_000_000_000 + Number(match.id ?? match.game_id);
  const fixtureId = match.fixture?.id ?? match.id;
  return Number.isFinite(Number(fixtureId)) ? Number(fixtureId) : null;
}

function formatMatchLabel(match, sportHint = 'football') {
  const sport = match.sport ?? sportHint;
  const icon = sport === 'basketball' ? ICON.basketball : ICON.football;
  const home = match.teams?.home?.name ?? match.home_team ?? 'Heimteam';
  const away = match.teams?.away?.name ?? match.away_team ?? 'Auswärtsteam';
  const date = match.fixture?.date ?? match.date ?? null;
  const dateText = date ? DATE_TIME_FORMAT.format(new Date(date)) : match.status ?? 'Zeit offen';
  return `${icon} ${home} vs ${away} | ${dateText}`.slice(0, 64);
}

function formatTeamButton(team) {
  const country = team.country ? ` | ${team.country}` : '';
  const venue = team.venue ? ` | ${team.venue}` : '';
  return `${ICON.football} ${team.name}${country}${venue}`.slice(0, 64);
}

function describePrediction(value, home, away) {
  const text = String(value ?? 'Keine Empfehlung');
  const lower = text.toLowerCase();
  if (lower.includes('keine')) return text;
  if (lower.includes('heim')) return `${text} (${home})`;
  if (lower.includes('away') || lower.includes('auswaert') || lower.includes('auswärt')) return `${text} (${away})`;
  return text;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${Math.round(number * 100)}%`;
}

function extractCommandArgs(text) {
  return String(text ?? '').replace(/^\/\S+\s*/, '').trim();
}

function trimTelegram(text) {
  const max = 3900;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n... gekürzt, weil Telegram meint, Texte brauchen eine Diät.`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

bot.catch((error) => {
  console.error('Telegram bot error:', error);
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
