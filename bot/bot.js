import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';

import {
  fetchMatches,
  fetchUpcomingMatchesForTeam,
  loadMatchesFromDb,
  searchTeams
} from '../api/apiHandler.js';
import { getPredictionDebug, predictMatch } from '../ai/predictor.js';
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
  timeZone: 'Europe/Berlin'
});

const EMOJI_LIVE = '\u{1F534}';
const EMOJI_SOCCER = '\u{26BD}';
const EMOJI_BASKETBALL = '\u{1F3C0}';
const EMOJI_CAL_TODAY = '\u{1F4C5}';
const EMOJI_CAL_SOON = '\u{1F5D3}';
const EMOJI_SEARCH = '\u{1F50E}';
const EMOJI_BACK = '\u{2B05}\u{FE0F}';
const EMOJI_NEXT = '\u{27A1}\u{FE0F}';
const EMOJI_HOME = '\u{1F3E0}';
const EMOJI_DEBUG = '\u{1F527}';

const MATCH_ID_OFFSETS = {
  football: 0,
  basketball: 5_000_000_000
};

const TEAM_SEARCH_CACHE = new Map();
const TEAM_MATCH_CACHE = new Map();
const PAGE_SIZE = 10;

const CATEGORY_KEYBOARD = () =>
  Markup.inlineKeyboard(
    [
      [Markup.button.callback(`${EMOJI_SOCCER} Fussball`, 'matches:sport:football')],
      [Markup.button.callback(`${EMOJI_BASKETBALL} Basketball`, 'matches:sport:basketball')],
      [Markup.button.callback(`${EMOJI_SEARCH} Team suchen`, 'search:help')]
    ],
    { columns: 1 }
  );

const SPORT_CATEGORY_KEYBOARD = (sport) =>
  Markup.inlineKeyboard(
    [
      [Markup.button.callback(`${EMOJI_LIVE} Live-Spiele`, `matches:${sport}:live:1`)],
      [Markup.button.callback(`${EMOJI_CAL_TODAY} Heute`, `matches:${sport}:upcoming:today:1`)],
      [Markup.button.callback(`${EMOJI_CAL_SOON} Demnächst`, `matches:${sport}:upcoming:soon:1`)],
      sport === 'football' ? [Markup.button.callback(`${EMOJI_SEARCH} Team suchen`, 'search:help')] : [],
      [Markup.button.callback(`${EMOJI_BACK} Zurück`, 'matches:root')]
    ].filter((row) => row.length),
    { columns: 1 }
  );

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Willkommen bei GamblerGPT.',
      '',
      'Ich analysiere Spiele mit API-Daten, Team-Historie, H2H, Odds, Injuries, Standings und lokaler Feature-Engine.',
      '',
      'Befehle:',
      '- /matches - Sport auswählen und Spiele finden',
      '- /search Bayern - Team suchen und nächste Spiele anzeigen',
      '- /team Real Madrid - gleich wie /search',
      '- /predict 1335952 - Match-ID direkt analysieren',
      '- /debug_match 1335952 - Datenbasis prüfen'
    ].join('\n'),
    CATEGORY_KEYBOARD()
  );
});

bot.command('matches', async (ctx) => {
  await ctx.reply('Welche Sportart interessiert dich?', CATEGORY_KEYBOARD());
});

bot.command(['search', 'team'], async (ctx) => {
  const query = extractCommandArgs(ctx.message?.text);
  if (!query) {
    await ctx.reply(
      [
        'Bitte gib einen Teamnamen ein.',
        'Beispiel: /search Bayern',
        'Oder: /team Real Madrid'
      ].join('\n')
    );
    return;
  }

  await handleTeamSearch(ctx, query, { mode: 'reply' });
});

bot.command('predict', async (ctx) => {
  const [matchId] = extractCommandArgs(ctx.message?.text).split(/\s+/).filter(Boolean);
  if (!matchId) {
    await ctx.reply([
      'Bitte gib eine match_id an, zum Beispiel /predict 1335952.',
      'Oder nutze /matches bzw. /search Bayern, um ein Spiel auszuwählen.'
    ].join('\n'));
    return;
  }

  const id = Number(matchId);
  if (!Number.isFinite(id)) {
    await ctx.reply('Ungültige match_id. Sie muss eine Zahl sein.');
    return;
  }

  await ctx.reply(`Berechne Vorhersage für Match "${id}" ...`);
  await respondWithPrediction(ctx, id, { mode: 'reply' });
});

bot.command('debug_match', async (ctx) => {
  const [matchId] = extractCommandArgs(ctx.message?.text).split(/\s+/).filter(Boolean);
  if (!matchId || !Number.isFinite(Number(matchId))) {
    await ctx.reply('Bitte gib eine gültige Match-ID an, z. B. /debug_match 1335952.');
    return;
  }

  await ctx.reply(`Prüfe Datenbasis für Match "${matchId}" ...`);
  await respondWithDebug(ctx, Number(matchId), { mode: 'reply' });
});

bot.action('matches:root', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Welche Sportart interessiert dich?', CATEGORY_KEYBOARD());
});

bot.action('matches:back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Welche Sportart interessiert dich?', CATEGORY_KEYBOARD());
});

bot.action('search:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    [
      `${EMOJI_SEARCH} Team-Suche`,
      '',
      'Schreib einfach:',
      '/search Bayern',
      '/team Real Madrid',
      '',
      'Danach wählst du das Team aus und bekommst die nächsten Spiele als Buttons.'
    ].join('\n'),
    CATEGORY_KEYBOARD()
  );
});

bot.action(/^matches:sport:(football|basketball)$/, async (ctx) => {
  const sport = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `Welche ${sport === 'basketball' ? 'Basketball' : 'Fussball'}-Spiele interessieren dich?`,
    SPORT_CATEGORY_KEYBOARD(sport)
  );
});

bot.action(/^matches:(football|basketball):live:(\d+)$/, async (ctx) => {
  const sport = ctx.match[1];
  const page = Number(ctx.match[2]);
  await ctx.answerCbQuery();
  await showMatchesForMode(ctx, sport, 'live', page);
});

bot.action(/^matches:(football|basketball):upcoming:(today|soon):(\d+)$/, async (ctx) => {
  const sport = ctx.match[1];
  const range = ctx.match[2];
  const page = Number(ctx.match[3]);
  await ctx.answerCbQuery();
  await showUpcomingByRange(ctx, sport, range, page);
});

bot.action(/^team:(\d+):games:(\d+)$/, async (ctx) => {
  const teamId = Number(ctx.match[1]);
  const page = Number(ctx.match[2]);
  await ctx.answerCbQuery();
  await showTeamUpcomingMatches(ctx, teamId, page);
});

bot.action(/^match:(\d+)$/, async (ctx) => {
  const matchId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Berechne Vorhersage für Match "${matchId}" ...`);
  await respondWithPrediction(ctx, matchId, { mode: 'edit' });
});

bot.action(/^debug:(\d+)$/, async (ctx) => {
  const matchId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Prüfe Datenbasis für Match "${matchId}" ...`);
  await respondWithDebug(ctx, matchId, { mode: 'edit' });
});

async function handleTeamSearch(ctx, query, { mode }) {
  const normalized = query.trim();
  try {
    const teams = await searchTeams(normalized, { sport: 'football', limit: 8 });
    if (!teams.length) {
      await sendMessage(ctx, mode, escapeHtml(`Keine Teams für "${normalized}" gefunden.`), {
        replyMarkup: CATEGORY_KEYBOARD(),
        parseMode: 'HTML'
      });
      return;
    }

    for (const team of teams) {
      TEAM_SEARCH_CACHE.set(team.id, team);
    }

    const rows = teams.map((team) => [
      Markup.button.callback(formatTeamButton(team), `team:${team.id}:games:1`)
    ]);
    rows.push([Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]);

    await sendMessage(ctx, mode, escapeHtml(`${EMOJI_SEARCH} Suchergebnisse für "${normalized}":`), {
      replyMarkup: Markup.inlineKeyboard(rows),
      parseMode: 'HTML'
    });
  } catch (error) {
    await sendMessage(ctx, mode, escapeHtml(`Fehler bei der Team-Suche: ${error.message}`), {
      replyMarkup: CATEGORY_KEYBOARD(),
      parseMode: 'HTML'
    });
  }
}

async function showTeamUpcomingMatches(ctx, teamId, page = 1) {
  const team = TEAM_SEARCH_CACHE.get(teamId) ?? { id: teamId, name: `Team ${teamId}`, sport: 'football' };
  try {
    const fetchLimit = Math.max(page * PAGE_SIZE + 1, 12);
    let matches = await fetchUpcomingMatchesForTeam(teamId, { sport: 'football', limit: fetchLimit });
    if (!matches.length) {
      matches = loadTeamMatchesFromDb(teamId, fetchLimit);
    }
    TEAM_MATCH_CACHE.set(teamId, matches);

    const sliceStart = (page - 1) * PAGE_SIZE;
    const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);

    if (!pageItems.length) {
      await ctx.editMessageText(
        `Keine kommenden Spiele für ${team.name} gefunden.`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`${EMOJI_SEARCH} Andere Suche`, 'search:help')],
          [Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]
        ])
      );
      return;
    }

    const rows = pageItems
      .map((match) => {
        const id = resolveMatchId(match, 'football');
        if (!id) return null;
        return [Markup.button.callback(formatMatchLabel(match, 'upcoming', 'football'), `match:${id}`)];
      })
      .filter(Boolean);

    const navRow = [];
    if (page > 1) navRow.push(Markup.button.callback(`${EMOJI_BACK} Vorherige`, `team:${teamId}:games:${page - 1}`));
    if (matches.length > sliceStart + PAGE_SIZE) navRow.push(Markup.button.callback(`${EMOJI_NEXT} Mehr`, `team:${teamId}:games:${page + 1}`));
    if (navRow.length) rows.push(navRow);

    rows.push([Markup.button.callback(`${EMOJI_DEBUG} Debug erstes Spiel`, `debug:${resolveMatchId(pageItems[0], 'football')}`)]);
    rows.push([Markup.button.callback(`${EMOJI_SEARCH} Andere Suche`, 'search:help')]);
    rows.push([Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]);

    await ctx.editMessageText(
      `${EMOJI_SOCCER} Nächste Spiele für ${team.name}:`,
      Markup.inlineKeyboard(rows)
    );
  } catch (error) {
    await ctx.editMessageText(
      `Fehler beim Abrufen der Teamspiele (${error.message}).`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`${EMOJI_SEARCH} Andere Suche`, 'search:help')],
        [Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]
      ])
    );
  }
}

async function showMatchesForMode(ctx, sport, mode, page = 1) {
  const sportName = sport === 'basketball' ? 'Basketball' : 'Fussball';
  const icon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  const label = mode === 'live' ? `${sportName}-Live-Spiele` : `${sportName}-Spiele`;
  try {
    const sliceStart = (page - 1) * PAGE_SIZE;
    const fetchLimit = sliceStart + PAGE_SIZE + 1;
    const apiMatches = await fetchMatches({ sport, mode, limit: fetchLimit });
    let matches = apiMatches;
    if (!matches.length) matches = loadMatchesFromDb(mode, fetchLimit, undefined, sport);

    const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);
    if (!pageItems.length) {
      await ctx.editMessageText(`${label}: Keine Spiele gefunden.`, SPORT_CATEGORY_KEYBOARD(sport));
      return;
    }

    const rows = buildMatchRows(pageItems, mode, sport);
    const navRow = [];
    if (page > 1) navRow.push(Markup.button.callback(`${EMOJI_BACK} Vorherige`, `matches:${sport}:live:${page - 1}`));
    if (matches.length > sliceStart + PAGE_SIZE) navRow.push(Markup.button.callback(`${EMOJI_NEXT} Mehr`, `matches:${sport}:live:${page + 1}`));
    if (navRow.length) rows.push(navRow);
    rows.push([Markup.button.callback(`${icon} ${sportName}-Menü`, `matches:sport:${sport}`)]);
    rows.push([Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]);

    await ctx.editMessageText(`${EMOJI_LIVE} ${label} - wähle ein Match für eine Vorhersage:`, Markup.inlineKeyboard(rows));
  } catch (error) {
    await ctx.editMessageText(`${label}: Fehler beim Abrufen der Spiele (${error.message}).`, SPORT_CATEGORY_KEYBOARD(sport));
  }
}

async function showUpcomingByRange(ctx, sport, range, page = 1) {
  const sportName = sport === 'basketball' ? 'Basketball' : 'Fussball';
  const label = range === 'today' ? 'Heute' : 'Demnächst';
  const sportIcon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  try {
    const sliceStart = (page - 1) * PAGE_SIZE;
    const fetchLimit = sliceStart + PAGE_SIZE + 1;
    const apiMatches = await fetchMatches({ sport, mode: 'upcoming', limit: fetchLimit, range });
    let matches = apiMatches;
    if (!matches.length) matches = loadMatchesFromDb('upcoming', fetchLimit, range, sport);

    const pageItems = matches.slice(sliceStart, sliceStart + PAGE_SIZE);
    if (!pageItems.length) {
      await ctx.editMessageText(`${label}: Keine Spiele gefunden.`, SPORT_CATEGORY_KEYBOARD(sport));
      return;
    }

    const rows = buildMatchRows(pageItems, 'upcoming', sport);
    const navRow = [];
    if (page > 1) navRow.push(Markup.button.callback(`${EMOJI_BACK} Vorherige`, `matches:${sport}:upcoming:${range}:${page - 1}`));
    if (matches.length > sliceStart + PAGE_SIZE) navRow.push(Markup.button.callback(`${EMOJI_NEXT} Mehr`, `matches:${sport}:upcoming:${range}:${page + 1}`));
    if (navRow.length) rows.push(navRow);
    rows.push([Markup.button.callback(`${sportIcon} ${sportName}-Menü`, `matches:sport:${sport}`)]);
    rows.push([Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]);

    const rangeIcon = range === 'today' ? EMOJI_CAL_TODAY : EMOJI_CAL_SOON;
    await ctx.editMessageText(`${rangeIcon} ${label} (${sportName}) - wähle ein Match für eine Vorhersage:`, Markup.inlineKeyboard(rows));
  } catch (error) {
    await ctx.editMessageText(`${label}: Fehler beim Abrufen der Spiele (${error.message}).`, SPORT_CATEGORY_KEYBOARD(sport));
  }
}

async function respondWithPrediction(ctx, matchId, { mode }) {
  let result;
  try {
    result = await predictMatch(matchId);
  } catch (error) {
    await sendMessage(ctx, mode, escapeHtml(`Fehler bei der Vorhersage: ${error.message}`), {
      replyMarkup: CATEGORY_KEYBOARD(),
      parseMode: 'HTML'
    });
    return;
  }

  if (!result) {
    await sendMessage(ctx, mode, escapeHtml('Keine Vorhersage verfügbar.'), {
      replyMarkup: CATEGORY_KEYBOARD(),
      parseMode: 'HTML'
    });
    return;
  }

  if (result.error) {
    await sendMessage(ctx, mode, escapeHtml(`Fehler: ${result.error}`), {
      replyMarkup: CATEGORY_KEYBOARD(),
      parseMode: 'HTML'
    });
    return;
  }

  const matchDetails = getMatchDetails(matchId);
  const message = formatBettingMessage(result, matchDetails);
  const sport = matchDetails?.sport ?? 'football';
  const sportName = sport === 'basketball' ? 'Basketball' : 'Fussball';
  const sportIcon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`${EMOJI_DEBUG} Datenbasis anzeigen`, `debug:${matchId}`)],
    [Markup.button.callback(`${EMOJI_LIVE} Weitere Live-Spiele`, `matches:${sport}:live:1`)],
    [Markup.button.callback(`${EMOJI_CAL_SOON} Weitere bevorstehende Spiele`, `matches:${sport}:upcoming:soon:1`)],
    [Markup.button.callback(`${sportIcon} ${sportName}-Menü`, `matches:sport:${sport}`)],
    [Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]
  ]);

  await sendMessage(ctx, mode, message, {
    replyMarkup: keyboard,
    parseMode: 'HTML'
  });
}

async function respondWithDebug(ctx, matchId, { mode }) {
  try {
    const debug = await getPredictionDebug(matchId);
    const message = formatDebugMessage(debug);
    await sendMessage(ctx, mode, message, {
      replyMarkup: Markup.inlineKeyboard([
        [Markup.button.callback('Prediction berechnen', `match:${matchId}`)],
        [Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]
      ]),
      parseMode: 'HTML'
    });
  } catch (error) {
    await sendMessage(ctx, mode, escapeHtml(`Debug fehlgeschlagen: ${error.message}`), {
      replyMarkup: CATEGORY_KEYBOARD(),
      parseMode: 'HTML'
    });
  }
}

async function sendMessage(ctx, mode, message, options = {}) {
  const extra = {
    parse_mode: options.parseMode ?? 'HTML',
    ...(options.replyMarkup ?? {})
  };
  if (mode === 'edit') await ctx.editMessageText(message, extra);
  else await ctx.reply(message, extra);
}

function buildMatchRows(matches, mode, sport) {
  return matches
    .map((match) => {
      const matchSport = match?.sport ?? sport;
      const id = resolveMatchId(match, matchSport);
      if (!id) return null;
      return [Markup.button.callback(formatMatchLabel(match, mode, matchSport), `match:${id}`)];
    })
    .filter(Boolean);
}

function loadTeamMatchesFromDb(teamId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals
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
  const numericId = toNumber(matchId);
  if (numericId === null) return null;
  const db = getDb();
  const stmt = db.prepare(
    `SELECT match_id, COALESCE(sport, 'football') AS sport, date, status, home_team, away_team, home_goals, away_goals,
            league_name, league_country, season, round
     FROM matches
     WHERE match_id = ?`
  );
  for (const candidate of makeCandidateMatchIds(numericId)) {
    const row = stmt.get(candidate);
    if (row) return row;
  }
  return null;
}

function formatBettingMessage(result, match) {
  const homeTeam = match?.home_team ?? 'Heimteam';
  const awayTeam = match?.away_team ?? 'Auswaertsteam';
  const kickOff = match?.date ? DATE_TIME_FORMAT.format(new Date(match.date)) : 'Unbekannt';
  const source = describeSource(result.engine);
  const sportName = describeSport(match?.sport);
  const probs = result.probabilities ?? {};
  const betting = result.betting_advice ?? {};
  const externalQuality = result.data_quality?.external;

  const sections = [
    `<b>Match:</b> ${escapeHtml(homeTeam)} vs ${escapeHtml(awayTeam)}`,
    `<b>Sport:</b> ${escapeHtml(sportName)}`,
    match?.league_name ? `<b>Liga:</b> ${escapeHtml(match.league_name)}${match.league_country ? ` (${escapeHtml(match.league_country)})` : ''}` : null,
    `<b>Anstoss:</b> ${escapeHtml(kickOff)}`,
    match?.status ? `<b>Status:</b> ${escapeHtml(match.status)}` : null,
    `<b>Engine:</b> ${escapeHtml(source)}`,
    externalQuality ? `<b>Datenqualität:</b> ${escapeHtml(externalQuality.label)} (${escapeHtml(externalQuality.score)}/100)` : null,
    ' ',
    `<u>Ergebnis-Prognose</u>`,
    `<b>Vorhersage:</b> ${escapeHtml(describePrediction(result.prediction, homeTeam, awayTeam))}`,
    `<b>${escapeHtml(homeTeam)}:</b> ${escapeHtml(formatPercent(probs.home))}`,
    `<b>Unentschieden:</b> ${escapeHtml(formatPercent(probs.draw))}`,
    `<b>${escapeHtml(awayTeam)}:</b> ${escapeHtml(formatPercent(probs.away))}`,
    ' ',
    `<u>Wett-Empfehlung</u>`,
    `<b>Empfehlung:</b> ${escapeHtml(describeRecommendation(betting.recommendation, homeTeam, awayTeam))}`,
    `<b>Sicherheit:</b> ${escapeHtml(formatPercent(betting.confidence))}`,
    betting.reasoning ? `<b>Begründung:</b> ${escapeHtml(betting.reasoning)}` : null,
    ' ',
    result.explanation ? `<b>Analyse:</b>\n${escapeHtml(result.explanation)}` : null,
    ' ',
    `<i>Wette verantwortungsvoll und nur Beträge, die du dir leisten kannst zu verlieren.</i>`,
    `<i>[GamblerGPT v1.2 | by Leo]</i>`
  ].filter(Boolean);

  return sections.join('\n');
}

function formatDebugMessage(debug) {
  if (debug.error) return escapeHtml(`Debug-Fehler: ${debug.error}`);
  const match = debug.match ?? {};
  const external = debug.external ?? {};
  const features = debug.features ?? {};
  const lines = [
    `<b>${EMOJI_DEBUG} Debug Match ${escapeHtml(match.match_id)}</b>`,
    `<b>Match:</b> ${escapeHtml(match.home_team ?? '?')} vs ${escapeHtml(match.away_team ?? '?')}`,
    `<b>Sport:</b> ${escapeHtml(match.sport ?? '?')}`,
    `<b>Status:</b> ${escapeHtml(match.status ?? '?')}`,
    `<b>Datum:</b> ${escapeHtml(match.date ?? '?')}`,
    '',
    '<u>Lokale Daten</u>',
    `<b>Home History:</b> ${escapeHtml(debug.localData?.homeRecentCount ?? 0)}`,
    `<b>Away History:</b> ${escapeHtml(debug.localData?.awayRecentCount ?? 0)}`,
    `<b>H2H:</b> ${escapeHtml(debug.localData?.h2hCount ?? 0)}`,
    `<b>Home Games:</b> ${escapeHtml(features.home_games ?? 0)}`,
    `<b>Away Games:</b> ${escapeHtml(features.away_games ?? 0)}`,
    `<b>Home Form:</b> ${escapeHtml(features.home_recent_form ?? 'n/a')}`,
    `<b>Away Form:</b> ${escapeHtml(features.away_recent_form ?? 'n/a')}`,
    '',
    '<u>Externe API-Daten</u>',
    `<b>Verfügbar:</b> ${external.available ? 'ja' : 'nein'}`,
    external.reason ? `<b>Grund:</b> ${escapeHtml(external.reason)}` : null,
    `<b>Prediction:</b> ${external.hasApiPrediction ? 'ja' : 'nein'}`,
    `<b>Odds:</b> ${external.hasOdds ? 'ja' : 'nein'}`,
    `<b>Injuries:</b> ${escapeHtml(external.injuriesCount ?? 0)}`,
    `<b>Standings:</b> ${external.hasStandings ? 'ja' : 'nein'}`,
    external.quality ? `<b>Qualität:</b> ${escapeHtml(external.quality.label)} (${escapeHtml(external.quality.score)}/100)` : null,
    '',
    '<u>AI</u>',
    `<b>Ollama:</b> ${debug.ollama?.enabled ? escapeHtml(debug.ollama.model) : 'aus'}`,
    `<b>Remote Llama:</b> ${debug.llama?.enabled ? 'an' : 'aus'}`
  ].filter(Boolean);
  return lines.join('\n');
}

function formatTeamButton(team) {
  const country = team.country ? ` | ${team.country}` : '';
  const venue = team.venue ? ` | ${team.venue}` : '';
  return `${EMOJI_SOCCER} ${team.name}${country}${venue}`.slice(0, 64);
}

function formatMatchLabel(match, mode, sportHint = 'football') {
  const sport = match?.sport ?? sportHint ?? 'football';
  const sportIcon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  const fixture = match?.fixture ?? null;
  const teams = match?.teams ?? null;
  const rawStatus = fixture?.status ?? match?.status ?? {};
  const status = typeof rawStatus === 'object' ? rawStatus : { short: rawStatus, long: rawStatus };
  const names = teams
    ? {
        home: teams.home?.name ?? match?.home_team ?? 'Heimteam',
        away: teams.away?.name ?? match?.away_team ?? 'Auswärtsteam'
      }
    : {
        home: match?.home_team ?? 'Heimteam',
        away: match?.away_team ?? 'Auswärtsteam'
      };

  if (mode === 'live') {
    const score = getLiveScore(match, sport);
    const statusText = status.short ?? status.long ?? match?.status ?? 'LIVE';
    return `${EMOJI_LIVE} ${sportIcon} ${names.home} ${score} ${names.away} | ${statusText}`.slice(0, 64);
  }

  const dateIso = fixture?.date ?? match?.date ?? (typeof match?.timestamp === 'number' ? new Date(match.timestamp * 1000).toISOString() : null);
  const dateText = dateIso ? DATE_TIME_FORMAT.format(new Date(dateIso)) : status.long ?? match?.status ?? 'Zeit offen';
  return `${sportIcon} ${names.home} vs ${names.away} | ${dateText}`.slice(0, 64);
}

function getLiveScore(match, sport) {
  if (sport === 'basketball') {
    const scores = match?.scores ?? {};
    const home = scores.home?.total ?? scores.home?.points ?? match?.home_goals;
    const away = scores.away?.total ?? scores.away?.points ?? match?.away_goals;
    return `${normalizeScore(home)}:${normalizeScore(away)}`;
  }
  const goals = match?.goals ?? {};
  const home = goals.home ?? match?.home_goals;
  const away = goals.away ?? match?.away_goals;
  return `${normalizeScore(home)}:${normalizeScore(away)}`;
}

function normalizeScore(value) {
  return Number.isFinite(value) ? value : value === null ? '-' : value;
}

function describePrediction(prediction, homeTeam, awayTeam) {
  if (!prediction) return 'Keine Prognose verfuegbar';
  const lower = prediction.toLowerCase();
  if (lower.includes('heim')) return `${prediction} (${homeTeam})`;
  if (lower.includes('away') || lower.includes('auswaert')) return `${prediction} (${awayTeam})`;
  if (lower.includes('auswaerts')) return `${prediction} (${awayTeam})`;
  return `${prediction} (${homeTeam} vs ${awayTeam})`;
}

function describeRecommendation(recommendation, homeTeam, awayTeam) {
  if (!recommendation) return 'Keine Empfehlung';
  const lower = recommendation.toLowerCase();
  if (lower.includes('heim')) return `${recommendation} (${homeTeam})`;
  if (lower.includes('away') || lower.includes('auswaert')) return `${recommendation} (${awayTeam})`;
  if (lower.includes('auswaerts')) return `${recommendation} (${awayTeam})`;
  return recommendation;
}

function describeSource(engine) {
  if (!engine) return 'Unbekannt';
  if (engine.startsWith('ollama')) return `Ollama (${engine.replace('ollama:', '')})`;
  if (engine === 'llama') return 'Lokales LLM (LLAMA_SERVER_URL)';
  if (engine === 'rule-based') return 'Regelbasierte Analyse (Fallback)';
  return engine;
}

function describeSport(sport) {
  return sport === 'basketball' ? 'Basketball' : 'Fussball';
}

function makeCandidateMatchIds(matchId) {
  const numeric = toNumber(matchId);
  if (numeric === null) return [];
  const candidates = new Set([numeric]);
  for (const offset of Object.values(MATCH_ID_OFFSETS)) {
    if (!Number.isFinite(offset) || offset === 0) continue;
    candidates.add(numeric + offset);
    if (numeric >= offset) candidates.add(numeric - offset);
  }
  return [...candidates].filter((value) => Number.isFinite(value) && value >= 0);
}

function resolveMatchId(match, sportHint = 'football') {
  if (!match) return null;
  if (match?.match_id !== undefined && match?.match_id !== null) {
    const stored = Number(match.match_id);
    if (Number.isFinite(stored)) return stored;
  }
  const sport = match?.sport ?? sportHint ?? 'football';
  const fixture = match?.fixture ?? {};
  const rawId = fixture.id ?? match?.id ?? null;
  const numericId = Number(rawId);
  if (!Number.isFinite(numericId)) return null;
  const offset = MATCH_ID_OFFSETS[sport] ?? 0;
  return offset + numericId;
}

function extractCommandArgs(text) {
  return String(text ?? '').split(' ').slice(1).join(' ').trim();
}

function formatPercent(value) {
  if (value === undefined || value === null) return '0%';
  let number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return '0%';
  if (number <= 1 && number >= -1) number *= 100;
  number = Math.max(0, Math.min(number, 100));
  return `${Math.round(number)}%`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

bot.catch((error, ctx) => {
  console.error('Telegram bot error:', error);
  if (ctx?.reply) {
    ctx.reply('Ein Fehler ist aufgetreten. Check die Logs, Bruder, die Wahrheit liegt wie immer in der Konsole.').catch(() => {});
  }
});

export async function startBot() {
  await bot.launch();
  console.log('Bot läuft. Druecke Ctrl+C zum Beenden.');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startBot().catch((error) => {
    console.error('Fehler beim Starten des Bots:', error);
    process.exitCode = 1;
  });
}
