import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { fetchMatches, loadMatchesFromDb } from '../api/apiHandler.js';
import { predictMatch, ensureMatchHistory } from '../ai/predictor.js';
import { calculateFeatures } from '../features/featureEngine.js';
import { getDb } from '../data/db.js';
import { setupDatabase } from '../data/dbSetup.js';

dotenv.config();

setupDatabase();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN not set in environment (.env)');
}

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
const EMOJI_BACK = '\u{2B05}\u{FE0F}';
const EMOJI_NEXT = '\u{27A1}\u{FE0F}';
const EMOJI_HOME = '\u{1F3E0}';

const MATCH_ID_OFFSETS = {
  football: 0,
  basketball: 5_000_000_000
};
const CATEGORY_KEYBOARD = () =>
  Markup.inlineKeyboard(
    [
      [Markup.button.callback(`${EMOJI_SOCCER} Fussball`, 'matches:sport:football')],
      [Markup.button.callback(`${EMOJI_BASKETBALL} Basketball`, 'matches:sport:basketball')]
    ],
    { columns: 1 }
  );

const SPORT_CATEGORY_KEYBOARD = (sport) =>
  Markup.inlineKeyboard(
    [
      [Markup.button.callback(`${EMOJI_LIVE} Live-Spiele`, `matches:${sport}:live:1`)],
      [Markup.button.callback(`${EMOJI_CAL_TODAY} Heute`, `matches:${sport}:upcoming:today:1`)],
      [Markup.button.callback(`${EMOJI_CAL_SOON} Demnächst`, `matches:${sport}:upcoming:soon:1`)],
      [Markup.button.callback(`${EMOJI_BACK} Zurück`, 'matches:root')]
    ],
    { columns: 1 }
  );

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Willkommen bei GamblerGPT!',
      ' ',
      'Ich analysiere Fussball- und Basketballspiele und liefere Wettempfehlungen.',
      ' ',
      'Befehle:',
      '- /matches : Sport auswaehlen und Spiele finden'
    ].join('\n')
  );
});

bot.command('matches', async (ctx) => {
  await ctx.reply(
    'Welche Sportart interessiert dich?',
    CATEGORY_KEYBOARD()
  );
});

bot.command('predict', async (ctx) => {
  const [matchId] = ctx.message.text.split(' ').slice(1);
  if (!matchId) {
    await ctx.reply(
      [
        'Bitte gib eine match_id an, zum Beispiel /predict 1335952.',
        'Oder nutze /matches, um ein Spiel auszuwaehlen.'
      ].join('\n')
    );
    return;
  }

  const id = Number(matchId);
  if (Number.isNaN(id)) {
    await ctx.reply('Ungültige match_id. Sie muss eine Zahl sein.');
    return;
  }

  await ctx.reply(`Berechne Vorhersage für Match "${id}". Bitte warten ...`);
  await respondWithPrediction(ctx, id, { mode: 'reply' });
});

bot.action('matches:root', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Welche Sportart interessiert dich?', CATEGORY_KEYBOARD());
});

bot.action('matches:back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Welche Sportart interessiert dich?', CATEGORY_KEYBOARD());
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

bot.action(/^match:(\d+)$/, async (ctx) => {
  const matchId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Berechne Vorhersage für Match "${matchId}". Bitte warten ...`);
  await respondWithPrediction(ctx, matchId, { mode: 'edit' });
});

async function showMatchesForMode(ctx, sport, mode, page = 1) {
  const sportName = sport === 'basketball' ? 'Basketball' : 'Fussball';
  const icon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  const label = mode === 'live' ? `${sportName}-Live-Spiele` : `${sportName}-Spiele`;
  try {
    const pageSize = 10;
    const sliceStart = (page - 1) * pageSize;
    const fetchLimit = sliceStart + pageSize + 1;

    const apiMatches = await fetchMatches({ sport, mode, limit: fetchLimit });
    let matches = apiMatches;
    if (!matches.length) {
      matches = loadMatchesFromDb(mode, fetchLimit, undefined, sport);
    }

    const pageItems = matches.slice(sliceStart, sliceStart + pageSize);
    if (!pageItems.length) {
      await ctx.editMessageText(
        `${label}: Keine Spiele gefunden.`,
        SPORT_CATEGORY_KEYBOARD(sport)
      );
      return;
    }

    const hasPrev = page > 1;
    const hasMore = matches.length > sliceStart + pageSize;

    const rows = pageItems
      .map((match) => {
        const matchSport = match?.sport ?? sport;
        const id = resolveMatchId(match, matchSport);
        if (!id) return null;
        return [Markup.button.callback(formatMatchLabel(match, mode, matchSport), `match:${id}`)];
      })
      .filter(Boolean);

    const navRow = [];
    if (hasPrev) {
      navRow.push(Markup.button.callback(`${EMOJI_BACK} Vorherige`, `matches:${sport}:live:${page - 1}`));
    }
    if (hasMore) {
      navRow.push(Markup.button.callback(`${EMOJI_NEXT} Mehr`, `matches:${sport}:live:${page + 1}`));
    }
    if (navRow.length) {
      rows.push(navRow);
    }

    rows.push([Markup.button.callback(`${icon} ${sportName}-Menü`, `matches:sport:${sport}`)]);
    rows.push([Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]);

    const keyboard = Markup.inlineKeyboard(rows);

    await ctx.editMessageText(
      `${EMOJI_LIVE} ${label} - wähle ein Match für eine Vorhersage:`,
      keyboard
    );
  } catch (error) {
    await ctx.editMessageText(
      `${label}: Fehler beim Abrufen der Spiele (${error.message}).`,
      SPORT_CATEGORY_KEYBOARD(sport)
    );
  }
}

async function showUpcomingByRange(ctx, sport, range, page = 1) {
  const sportName = sport === 'basketball' ? 'Basketball' : 'Fussball';
  const label = range === 'today' ? 'Heute' : 'Demnächst';
  const sportIcon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  try {
    const pageSize = 10;
    const sliceStart = (page - 1) * pageSize;
    const fetchLimit = sliceStart + pageSize + 1;

    const apiMatches = await fetchMatches({
      sport,
      mode: 'upcoming',
      limit: fetchLimit,
      range
    });
    let matches = apiMatches;
    if (!matches.length) {
      matches = loadMatchesFromDb('upcoming', fetchLimit, range, sport);
    }

    const pageItems = matches.slice(sliceStart, sliceStart + pageSize);
    if (!pageItems.length) {
      await ctx.editMessageText(
        `${label}: Keine Spiele gefunden.`,
        SPORT_CATEGORY_KEYBOARD(sport)
      );
      return;
    }

    const hasPrev = page > 1;
    const hasMore = matches.length > sliceStart + pageSize;

    const rows = pageItems
      .map((match) => {
        const matchSport = match?.sport ?? sport;
        const id = resolveMatchId(match, matchSport);
        if (!id) return null;
        return [Markup.button.callback(formatMatchLabel(match, 'upcoming', matchSport), `match:${id}`)];
      })
      .filter(Boolean);

    const navRow = [];
    if (hasPrev) {
      navRow.push(Markup.button.callback(`${EMOJI_BACK} Vorherige`, `matches:${sport}:upcoming:${range}:${page - 1}`));
    }
    if (hasMore) {
      navRow.push(Markup.button.callback(`${EMOJI_NEXT} Mehr`, `matches:${sport}:upcoming:${range}:${page + 1}`));
    }
    if (navRow.length) {
      rows.push(navRow);
    }

    rows.push([Markup.button.callback(`${sportIcon} ${sportName}-Menü`, `matches:sport:${sport}`)]);
    rows.push([Markup.button.callback(`${EMOJI_HOME} Hauptmenü`, 'matches:root')]);

    const rangeIcon = range === 'today' ? EMOJI_CAL_TODAY : EMOJI_CAL_SOON;
    const keyboard = Markup.inlineKeyboard(rows);
    await ctx.editMessageText(
      `${rangeIcon} ${label} (${sportName}) - wähle ein Match für eine Vorhersage:`,
      keyboard
    );
  } catch (error) {
    await ctx.editMessageText(
      `${label}: Fehler beim Abrufen der Spiele (${error.message}).`,
      SPORT_CATEGORY_KEYBOARD(sport)
    );
  }
}
async function respondWithPrediction(ctx, matchId, { mode }) {
  try {
    await ensureMatchHistory(matchId);
    calculateFeatures();
  } catch (error) {
    console.error('Feature-Berechnung fehlgeschlagen:', error);
  }

  let result;
  try {
    result = await predictMatch(matchId);
  } catch (error) {
    const message = `Fehler bei der Vorhersage: ${error.message}`;
    await sendMessage(ctx, mode, escapeHtml(message), {
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

async function sendMessage(ctx, mode, message, options = {}) {
  const extra = {
    parse_mode: options.parseMode ?? 'HTML',
    ...(options.replyMarkup ?? {})
  };

  if (mode === 'edit') {
    await ctx.editMessageText(message, extra);
  } else {
    await ctx.reply(message, extra);
  }
}

function getMatchDetails(matchId) {
  const numericId = toNumber(matchId);
  if (numericId === null) return null;

  const db = getDb();
  const stmt = db.prepare(
    `SELECT match_id, COALESCE(sport, 'football') AS sport, date, status, home_team, away_team, home_goals, away_goals
     FROM matches
     WHERE match_id = ?`
  );

  for (const candidate of makeCandidateMatchIds(numericId)) {
    const row = stmt.get(candidate);
    if (row) {
      return row;
    }
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

  const sections = [
    `<b>Match:</b> ${escapeHtml(homeTeam)} vs ${escapeHtml(awayTeam)}`,
    `<b>Sport:</b> ${escapeHtml(sportName)}`,
    `<b>Anstoss:</b> ${escapeHtml(kickOff)}`,
    match?.status ? `<b>Status:</b> ${escapeHtml(match.status)}` : null,
    `<b>Engine:</b> ${escapeHtml(source)}`,
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
    `<i>[GamblerGPT v1.1 | by Leo]</i>`,

  ].filter(Boolean);

  return sections.join('\n');
}

function formatMatchLabel(match, mode, sportHint = 'football') {
  const sport = match?.sport ?? sportHint ?? 'football';
  const sportIcon = sport === 'basketball' ? EMOJI_BASKETBALL : EMOJI_SOCCER;
  const fixture = match?.fixture ?? null;
  const teams = match?.teams ?? null;
  const rawStatus = fixture?.status ?? match?.status ?? {};
  const status =
    typeof rawStatus === 'object'
      ? rawStatus
      : { short: rawStatus, long: rawStatus };

  const extractNames = () => {
    if (teams) {
      return {
        home: teams.home?.name ?? match?.home_team ?? 'Heimteam',
        away: teams.away?.name ?? match?.away_team ?? 'Auswärtsteam'
      };
    }
    return {
      home: match?.home_team ?? 'Heimteam',
      away: match?.away_team ?? 'Auswärtsteam'
    };
  };

  const names = extractNames();

  if (mode === 'live') {
    const score = getLiveScore(match, sport);
    const statusText =
      status.short ?? status.long ?? match?.status ?? 'LIVE';
    return `${EMOJI_LIVE} ${sportIcon} ${names.home} ${score} ${names.away} | ${statusText}`;
  }

  const dateIso =
    fixture?.date ?? match?.date ?? (typeof match?.timestamp === 'number'
      ? new Date(match.timestamp * 1000).toISOString()
      : null);
  const dateText = dateIso ? DATE_TIME_FORMAT.format(new Date(dateIso)) : status.long ?? match?.status ?? 'Zeit offen';

  return `${sportIcon} ${names.home} vs ${names.away} | ${dateText}`;
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
  if (lower.includes('away') || lower.includes('auswaert'))
    return `${prediction} (${awayTeam})`;
  if (lower.includes('auswaerts')) return `${prediction} (${awayTeam})`;
  return `${prediction} (${homeTeam} vs ${awayTeam})`;
}

function describeRecommendation(recommendation, homeTeam, awayTeam) {
  if (!recommendation) return 'Keine Empfehlung';
  const lower = recommendation.toLowerCase();
  if (lower.includes('heim')) return `${recommendation} (${homeTeam})`;
  if (lower.includes('away') || lower.includes('auswaert'))
    return `${recommendation} (${awayTeam})`;
  if (lower.includes('auswaerts')) return `${recommendation} (${awayTeam})`;
  return recommendation;
}

function describeSource(engine) {
  if (engine === 'llama') {
    return 'Lokales LLM (LLAMA_SERVER_URL)';
  }
  if (engine === 'ollama') {
    return 'KI-Server (lokal)';
  }
  return 'Regelbasierte Analyse (Fallback)';
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
    if (numeric >= offset) {
      candidates.add(numeric - offset);
    }
  }
  return [...candidates].filter((value) => Number.isFinite(value) && value >= 0);
}

function resolveMatchId(match, sportHint = 'football') {
  if (!match) return null;
  if (match?.match_id !== undefined && match?.match_id !== null) {
    const stored = Number(match.match_id);
    if (Number.isFinite(stored)) {
      return stored;
    }
  }

  const sport = match?.sport ?? sportHint ?? 'football';
  const fixture = match?.fixture ?? {};
  const rawId = fixture.id ?? match?.id ?? null;
  const numericId = Number(rawId);
  if (!Number.isFinite(numericId)) {
    return null;
  }

  const offset = MATCH_ID_OFFSETS[sport] ?? 0;
  return offset + numericId;
}

function formatPercent(value) {
  if (value === undefined || value === null) return '0%';
  let number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return '0%';
  if (number <= 1 && number >= -1) {
    number = number * 100;
  }
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

export async function startBot() {
  await bot.launch();
  console.log('Bot läuft. Druecke Ctrl+C zum Beenden.');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startBot().catch((error) => {
    console.error('Fehler beim Starten des Bots:', error);
    process.exitCode = 1;
  });
}
