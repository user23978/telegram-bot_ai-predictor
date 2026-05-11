import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';

import { fetchMatches, fetchUpcomingMatchesForTeam, loadMatchesFromDb, searchTeams } from '../api/matchBrowserV3.js';
import { getPredictionDebug, predictMatch } from '../ai/predictorV3.js';
import { predictTeamMatchup } from '../ai/matchupPredictorSafe.js';
import { getDb } from '../data/db.js';
import { setupDatabase } from '../data/dbSetup.js';

dotenv.config();
setupDatabase();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set in environment (.env)');

const bot = new Telegraf(TELEGRAM_TOKEN);
const userState = new Map();
const teamCache = new Map();

const PAGE_SIZE = 10;
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: process.env.API_TIMEZONE ?? 'Europe/Berlin'
});

const ICON = {
  football: '\u{26BD}', search: '\u{1F50E}', live: '\u{1F534}', today: '\u{1F4C5}', soon: '\u{1F5D3}',
  debug: '\u{1F527}', home: '\u{1F3E0}', next: '\u{27A1}\u{FE0F}', back: '\u{2B05}\u{FE0F}', vs: '\u{2694}\u{FE0F}'
};

const MAIN_MENU = () => Markup.inlineKeyboard([
  [Markup.button.callback(`${ICON.search} Team suchen`, 'search:start')],
  [Markup.button.callback(`${ICON.today} Spiele heute`, 'matches:upcoming:today:1')],
  [Markup.button.callback(`${ICON.soon} Spiele im erlaubten Fenster`, 'matches:upcoming:soon:1')],
  [Markup.button.callback(`${ICON.live} Live-Spiele`, 'matches:live:1')]
]);

bot.start(async (ctx) => {
  clearState(ctx.from?.id);
  await ctx.reply([
    'GamblerGPT v3 läuft.',
    '',
    'Such ein Team. Wenn keine kommenden Spiele verfügbar sind, kannst du manuell einen Gegner wählen und ich berechne eine Prediction aus historischen Free-Daten.'
  ].join('\n'), MAIN_MENU());
});

bot.command('matches', async (ctx) => {
  clearState(ctx.from?.id);
  await ctx.reply('Was willst du sehen?', MAIN_MENU());
});

bot.command(['search', 'team'], async (ctx) => {
  const query = extractCommandArgs(ctx.message?.text);
  if (!query) {
    setState(ctx.from?.id, { mode: 'await_team_search' });
    await ctx.reply('Schick mir einfach den Teamnamen, z. B. Bayern oder Real Madrid. Keine Slash-Akrobatik nötig, danke endlich Fortschritt.', MAIN_MENU());
    return;
  }
  await handleTeamSearch(ctx, query);
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

bot.on('text', async (ctx, next) => {
  const text = String(ctx.message?.text ?? '').trim();
  if (!text || text.startsWith('/')) return next();

  const state = getState(ctx.from?.id);
  if (!state) return;

  if (state.mode === 'await_team_search') {
    await handleTeamSearch(ctx, text);
    return;
  }

  if (state.mode === 'await_manual_away' && state.homeTeam) {
    await handleManualAwaySearch(ctx, state.homeTeam, text);
    return;
  }
});

bot.action('home', async (ctx) => {
  clearState(ctx.from?.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('Hauptmenü:', MAIN_MENU());
});

bot.action('search:start', async (ctx) => {
  setState(ctx.from?.id, { mode: 'await_team_search' });
  await ctx.answerCbQuery();
  await ctx.editMessageText('Schick mir jetzt einfach den Teamnamen als normale Nachricht.', MAIN_MENU());
});

bot.action(/^matches:(live):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showMatches(ctx, 'live', undefined, Number(ctx.match[2]));
});

bot.action(/^matches:upcoming:(today|soon):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showMatches(ctx, 'upcoming', ctx.match[1], Number(ctx.match[2]));
});

bot.action(/^team:(\d+):games:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const team = getCachedTeam(Number(ctx.match[1]));
  await showTeamUpcoming(ctx, team ?? { id: Number(ctx.match[1]), name: `Team ${ctx.match[1]}` }, Number(ctx.match[2]));
});

bot.action(/^team:(\d+):manual$/, async (ctx) => {
  const team = getCachedTeam(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!team) {
    await ctx.editMessageText('Team nicht mehr im Cache. Such es nochmal, leider ist Speicher auch nur ein sterblicher Container.', MAIN_MENU());
    return;
  }
  setState(ctx.from?.id, { mode: 'await_manual_away', homeTeam: team });
  await ctx.editMessageText(`Okay. ${team.name} ist Team A. Schick mir jetzt den Gegner als normale Nachricht.`, Markup.inlineKeyboard([
    [Markup.button.callback(`${ICON.search} Neues Team suchen`, 'search:start')],
    [Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]
  ]));
});

bot.action(/^manualpick:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const home = getCachedTeam(Number(ctx.match[1]));
  const away = getCachedTeam(Number(ctx.match[2]));
  if (!home || !away) {
    await ctx.editMessageText('Teams nicht mehr im Cache. Bitte nochmal suchen.', MAIN_MENU());
    return;
  }
  await ctx.editMessageText(`Berechne manuelles Matchup: ${home.name} vs ${away.name} ...`);
  await respondWithManualPrediction(ctx, home, away, 'edit');
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

async function handleTeamSearch(ctx, query) {
  const teams = await searchTeams(query, { sport: 'football', limit: 8 });
  if (!teams.length) {
    setState(ctx.from?.id, { mode: 'await_team_search' });
    await ctx.reply(`Keine Teams für "${query}" gefunden. Versuch einen anderen Namen.`, MAIN_MENU());
    return;
  }

  teams.forEach(cacheTeam);
  clearState(ctx.from?.id);

  const rows = teams.map((team) => [Markup.button.callback(formatTeamButton(team), `team:${team.id}:games:1`)]);
  rows.push([Markup.button.callback(`${ICON.search} Andere Suche`, 'search:start')]);
  rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]);

  await ctx.reply(`${ICON.search} Suchergebnisse für "${escapeText(query)}":`, Markup.inlineKeyboard(rows));
}

async function handleManualAwaySearch(ctx, homeTeam, query) {
  const teams = await searchTeams(query, { sport: 'football', limit: 8 });
  if (!teams.length) {
    await ctx.reply(`Keinen Gegner für "${query}" gefunden. Versuch einen anderen Namen.`);
    return;
  }

  teams.forEach(cacheTeam);
  const rows = teams
    .filter((team) => Number(team.id) !== Number(homeTeam.id))
    .map((team) => [Markup.button.callback(`${ICON.vs} ${homeTeam.name} vs ${team.name}`, `manualpick:${homeTeam.id}:${team.id}`)]);
  rows.push([Markup.button.callback(`${ICON.search} Gegner neu suchen`, `team:${homeTeam.id}:manual`)]);
  rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]);

  await ctx.reply(`Wähle den Gegner für ${homeTeam.name}:`, Markup.inlineKeyboard(rows));
}

async function showTeamUpcoming(ctx, team, page = 1) {
  cacheTeam(team);
  const limit = page * PAGE_SIZE + 1;
  let matches = await fetchUpcomingMatchesForTeam(team.id, { sport: 'football', limit });
  if (!matches.length) matches = loadTeamMatchesFromDb('upcoming', limit, undefined, 'football').filter((m) => Number(m.home_team_id) === Number(team.id) || Number(m.away_team_id) === Number(team.id));

  const sliceStart = (page - 1) * PAGE_SIZE;
  const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);

  if (!pageItems.length) {
    await ctx.editMessageText([
      `Keine kommenden Spiele für ${team.name} im erlaubten API-Zeitfenster gefunden.`,
      '',
      'Du kannst trotzdem einen Gegner suchen und ich berechne ein manuelles Matchup aus alten Free-Daten.'
    ].join('\n'), Markup.inlineKeyboard([
      [Markup.button.callback(`${ICON.vs} Gegner suchen / manuelles Matchup`, `team:${team.id}:manual`)],
      [Markup.button.callback(`${ICON.search} Andere Team-Suche`, 'search:start')],
      [Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]
    ]));
    return;
  }

  const rows = pageItems.map((match) => [Markup.button.callback(formatMatchLabel(match), `match:${resolveMatchId(match)}`)]);
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback(`${ICON.back} Zurück`, `team:${team.id}:games:${page - 1}`));
  if (matches.length > sliceStart + PAGE_SIZE) nav.push(Markup.button.callback(`${ICON.next} Mehr`, `team:${team.id}:games:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback(`${ICON.vs} Manuelles Matchup`, `team:${team.id}:manual`)]);
  rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]);

  await ctx.editMessageText(`${ICON.football} Spiele für ${team.name}:`, Markup.inlineKeyboard(rows));
}

async function showMatches(ctx, mode, range, page = 1) {
  const sliceStart = (page - 1) * PAGE_SIZE;
  const limit = sliceStart + PAGE_SIZE + 1;
  let matches = await fetchMatches({ sport: 'football', mode, range, limit });
  if (!matches.length) matches = loadMatchesFromDb(mode, limit, range, 'football');

  const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);
  if (!pageItems.length) {
    await ctx.editMessageText('Keine Spiele im erlaubten API-Fenster gefunden.', MAIN_MENU());
    return;
  }

  const rows = pageItems.map((match) => [Markup.button.callback(formatMatchLabel(match), `match:${resolveMatchId(match)}`)]);
  const nav = [];
  const key = mode === 'live' ? 'matches:live' : `matches:upcoming:${range}`;
  if (page > 1) nav.push(Markup.button.callback(`${ICON.back} Zurück`, `${key}:${page - 1}`));
  if (matches.length > sliceStart + PAGE_SIZE) nav.push(Markup.button.callback(`${ICON.next} Mehr`, `${key}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback(`${ICON.search} Team suchen`, 'search:start')]);
  rows.push([Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]);

  await ctx.editMessageText('Wähle ein Match:', Markup.inlineKeyboard(rows));
}

async function respondWithPrediction(ctx, matchId, mode) {
  try {
    const result = await predictMatch(matchId);
    if (!result || result.error) return send(ctx, mode, `Fehler: ${escapeHtml(result?.error ?? 'Keine Prediction')}`, MAIN_MENU());
    await send(ctx, mode, formatPredictionMessage(result, getMatchDetails(matchId)), predictionKeyboard(matchId));
  } catch (error) {
    await send(ctx, mode, `Prediction fehlgeschlagen: ${escapeHtml(error.message)}`, MAIN_MENU());
  }
}

async function respondWithManualPrediction(ctx, home, away, mode) {
  try {
    const result = await predictTeamMatchup(home, away);
    if (!result || result.error) return send(ctx, mode, `Fehler: ${escapeHtml(result?.error ?? 'Keine Prediction')}`, MAIN_MENU());
    await send(ctx, mode, formatManualPredictionMessage(result, home, away), Markup.inlineKeyboard([
      [Markup.button.callback(`${ICON.vs} Anderen Gegner suchen`, `team:${home.id}:manual`)],
      [Markup.button.callback(`${ICON.search} Neue Team-Suche`, 'search:start')],
      [Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]
    ]));
  } catch (error) {
    await send(ctx, mode, `Manuelle Prediction fehlgeschlagen: ${escapeHtml(error.message)}`, MAIN_MENU());
  }
}

async function respondWithDebug(ctx, matchId, mode) {
  try {
    const debug = await getPredictionDebug(matchId);
    await send(ctx, mode, formatDebugMessage(debug), Markup.inlineKeyboard([
      [Markup.button.callback('Prediction berechnen', `match:${matchId}`)],
      [Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]
    ]));
  } catch (error) {
    await send(ctx, mode, `Debug fehlgeschlagen: ${escapeHtml(error.message)}`, MAIN_MENU());
  }
}

function predictionKeyboard(matchId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${ICON.debug} Datenbasis anzeigen`, `debug:${matchId}`)],
    [Markup.button.callback(`${ICON.search} Team suchen`, 'search:start')],
    [Markup.button.callback(`${ICON.home} Hauptmenü`, 'home')]
  ]);
}

async function send(ctx, mode, html, replyMarkup) {
  const extra = { parse_mode: 'HTML', ...(replyMarkup ?? {}) };
  if (mode === 'edit') await ctx.editMessageText(trimTelegram(html), extra);
  else await ctx.reply(trimTelegram(html), extra);
}

function formatPredictionMessage(result, match) {
  const home = match?.home_team ?? 'Heimteam';
  const away = match?.away_team ?? 'Auswärtsteam';
  return formatPredictionCore(result, home, away, false);
}

function formatManualPredictionMessage(result, home, away) {
  return formatPredictionCore(result, home.name, away.name, true);
}

function formatPredictionCore(result, home, away, manual) {
  const probs = result.probabilities ?? {};
  const betting = result.betting_advice ?? {};
  const diag = result.data_quality?.diagnostics;
  const aiError = result.data_quality?.ai_error;
  return [
    `<b>${manual ? 'Manuelles Matchup' : 'Match'}:</b> ${escapeHtml(home)} vs ${escapeHtml(away)}`,
    `<b>Engine:</b> ${escapeHtml(result.engine ?? 'unknown')}`,
    aiError ? `<b>AI-Fallback Grund:</b> ${escapeHtml(aiError)}` : null,
    diag ? `<b>Daten:</b> ${escapeHtml(diag.localQualityLabel)} | Samples ${escapeHtml(diag.totalGames)} | H2H ${escapeHtml(diag.h2hCount)} | usable ${diag.hasUsableSamples ? 'ja' : 'nein'}` : null,
    manual ? '<i>Keine echte kommende Fixture, Prediction basiert nur auf historischen Daten.</i>' : null,
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
    result.explanation ? `<b>Analyse:</b> ${escapeHtml(result.explanation)}` : null
  ].filter(Boolean).join('\n');
}

function formatDebugMessage(debug) {
  if (debug.error) return escapeHtml(`Debug-Fehler: ${debug.error}`);
  const match = debug.match ?? {};
  const diag = debug.diagnostics ?? {};
  const features = debug.features ?? {};
  const recentFetches = (debug.recentApiFetches ?? []).slice(0, 5).map((row) => `- ${row.ok ? 'OK' : 'FAIL'} ${row.label} | count=${row.response_count}${row.error ? ` | ${row.error}` : ''}`).join('\n');
  return [
    `<b>${ICON.debug} Debug Match ${escapeHtml(match.match_id ?? '?')}</b>`,
    `<b>Match:</b> ${escapeHtml(match.home_team ?? '?')} vs ${escapeHtml(match.away_team ?? '?')}`,
    `<b>Qualität:</b> ${escapeHtml(diag.localQualityLabel ?? '?')}`,
    `<b>Home History:</b> ${escapeHtml(debug.localData?.homeRecentCount ?? 0)}`,
    `<b>Away History:</b> ${escapeHtml(debug.localData?.awayRecentCount ?? 0)}`,
    `<b>H2H:</b> ${escapeHtml(debug.localData?.h2hCount ?? 0)}`,
    `<b>Home Games:</b> ${escapeHtml(features.home_games ?? 0)} | Form ${escapeHtml(features.home_recent_form ?? 'n/a')}`,
    `<b>Away Games:</b> ${escapeHtml(features.away_games ?? 0)} | Form ${escapeHtml(features.away_recent_form ?? 'n/a')}`,
    '',
    '<u>Letzte API Fetches</u>',
    recentFetches ? escapeHtml(recentFetches) : 'Keine Fetch-Logs.',
    '',
    `<b>Ollama:</b> ${debug.ollama?.enabled ? escapeHtml(debug.ollama.model) : 'aus'}`
  ].join('\n');
}

function loadTeamMatchesFromDb(teamId, limit) {
  const db = getDb();
  return db.prepare(`
    SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals, league_name
    FROM matches
    WHERE COALESCE(sport, 'football') = 'football'
      AND (home_team_id = @teamId OR away_team_id = @teamId)
      AND date IS NOT NULL
      AND datetime(date) >= datetime('now', '-1 day')
    ORDER BY datetime(date) ASC
    LIMIT @limit
  `).all({ teamId, limit });
}

function getMatchDetails(matchId) {
  const id = Number(matchId);
  if (!Number.isFinite(id)) return null;
  const db = getDb();
  return db.prepare(`SELECT * FROM matches WHERE match_id = @id`).get({ id }) ?? null;
}

function resolveMatchId(match) {
  if (!match) return null;
  if (match.match_id !== undefined && match.match_id !== null) return Number(match.match_id);
  const fixtureId = match.fixture?.id ?? match.id;
  return Number.isFinite(Number(fixtureId)) ? Number(fixtureId) : null;
}

function formatMatchLabel(match) {
  const home = match.teams?.home?.name ?? match.home_team ?? 'Heimteam';
  const away = match.teams?.away?.name ?? match.away_team ?? 'Auswärtsteam';
  const date = match.fixture?.date ?? match.date ?? null;
  const dateText = date ? DATE_TIME_FORMAT.format(new Date(date)) : match.status ?? 'Zeit offen';
  return `${ICON.football} ${home} vs ${away} | ${dateText}`.slice(0, 64);
}

function formatTeamButton(team) {
  const tag = team.source === 'local-db' ? 'DB' : 'API';
  const country = team.country ? ` | ${team.country}` : '';
  return `${ICON.football} ${team.name}${country} [${tag}]`.slice(0, 64);
}

function cacheTeam(team) { if (team?.id) teamCache.set(Number(team.id), team); }
function getCachedTeam(id) { return teamCache.get(Number(id)); }
function setState(id, state) { if (id) userState.set(id, state); }
function getState(id) { return id ? userState.get(id) : null; }
function clearState(id) { if (id) userState.delete(id); }
function extractCommandArgs(text) { return String(text ?? '').replace(/^\/\S+\s*/, '').trim(); }
function formatPercent(value) { const n = Number(value); return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'n/a'; }
function describePrediction(value, home, away) { const text = String(value ?? 'Keine Empfehlung'); const lower = text.toLowerCase(); if (lower.includes('keine')) return text; if (lower.includes('heim')) return `${text} (${home})`; if (lower.includes('away') || lower.includes('auswaert') || lower.includes('auswärt')) return `${text} (${away})`; return text; }
function escapeText(value) { return String(value ?? '').replace(/</g, '').replace(/>/g, ''); }
function trimTelegram(text) { return text.length <= 3900 ? text : `${text.slice(0, 3900)}\n\n... gekürzt.`; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

bot.catch((error) => console.error('Telegram bot error:', error));
bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
