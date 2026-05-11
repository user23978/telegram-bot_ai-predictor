import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import {
  fetchTeamHistory,
  fetchHeadToHeadHistory,
  fetchMatchById,
  getRecentApiFetchLog
} from '../api/apiHandler.js';
import {
  buildFootballContext,
  formatFootballContextForPrompt,
  getFootballContextDebug
} from '../api/footballContext.js';
import { calculateFeatures } from '../features/featureEngine.js';

dotenv.config();

const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL ?? null;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:12b';

const TEAM_HISTORY_SIZE = Number(process.env.TEAM_HISTORY_SIZE) || 12;
const H2H_HISTORY_SIZE = Number(process.env.H2H_HISTORY_SIZE) || 10;
const SPORT_OFFSETS = { football: 0, basketball: 5_000_000_000 };
const historyFetchCache = new Set();

const SPORT_META = {
  football: {
    analyst: 'Fussball-Analyst',
    score: 'Tore',
    drawRelevant: true
  },
  basketball: {
    analyst: 'Basketball-Analyst',
    score: 'Punkte',
    drawRelevant: false
  }
};

export function getFeatures(matchId, sportHint = 'football') {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      s.*,
      COALESCE(s.sport, m.sport, @sportHint) AS resolved_sport
    FROM stats s
    LEFT JOIN matches m ON m.match_id = s.match_id
    WHERE s.match_id = @matchId
  `).get({ matchId, sportHint });

  if (!row) return null;
  return normalizeFeatures(row, sportHint);
}

export async function ensureMatchHistory(matchOrId) {
  const match = typeof matchOrId === 'object' ? matchOrId : getMatchRecord(matchOrId);
  if (!match) return { fetched: false, reason: 'match_not_found' };
  return hydrateMatchHistory(match);
}

export async function predictMatch(matchId) {
  const prepared = await preparePredictionInput(matchId);
  if (prepared.error) return { error: prepared.error };

  const { match, features, context, externalContext, diagnostics } = prepared;
  const prompt = buildPrompt(prepared);

  if (LLAMA_SERVER_URL) {
    const remote = await tryAiEngine('llama', () => callRemoteLlama(prompt), match, prepared);
    if (remote) return remote;
  }

  if (OLLAMA_MODEL) {
    const local = await tryAiEngine(`ollama:${OLLAMA_MODEL}`, () => callOllama(prompt), match, prepared);
    if (local) return local;
  }

  return addMeta(simpleRulePredict(match, features, context, externalContext, diagnostics), 'rule-based', prepared);
}

export async function getPredictionDebug(matchId) {
  const prepared = await preparePredictionInput(matchId);
  if (prepared.error) return { error: prepared.error };

  const { match, features, context, externalContext, diagnostics } = prepared;

  return {
    match,
    features,
    diagnostics,
    localData: {
      homeRecentCount: context.homeTeamRecent.length,
      awayRecentCount: context.awayTeamRecent.length,
      h2hCount: context.headToHead.length,
      homeRecent: context.homeTeamRecent.slice(0, 5),
      awayRecent: context.awayTeamRecent.slice(0, 5),
      h2h: context.headToHead.slice(0, 5)
    },
    external: getFootballContextDebug(externalContext),
    recentApiFetches: getRecentApiFetchLog(8),
    ollama: {
      host: OLLAMA_HOST,
      model: OLLAMA_MODEL,
      enabled: Boolean(OLLAMA_MODEL)
    },
    llama: {
      enabled: Boolean(LLAMA_SERVER_URL)
    }
  };
}

async function preparePredictionInput(matchId) {
  const numericId = toNumber(matchId);
  if (numericId === null) return { error: 'Ungueltige Match-ID' };

  let match = getMatchRecord(numericId);
  if (!match) {
    await fetchMatchById(numericId);
    match = getMatchRecord(numericId);
  }
  if (!match) return { error: 'Match nicht gefunden' };

  const hydration = await hydrateMatchHistory(match);
  calculateFeatures({ matchId: match.match_id });

  const featuresFromDb = getFeatures(match.match_id, match.sport);
  const features = featuresFromDb ?? createEmptyFeatures(match.sport);
  const context = getMatchContext(match);
  const diagnostics = buildDiagnostics({ match, features, context, hydration, hasFeatureRow: Boolean(featuresFromDb) });

  let externalContext;
  if (match.sport === 'football') {
    try {
      externalContext = await buildFootballContext(match);
    } catch (error) {
      externalContext = {
        available: false,
        reason: `Football-Context Fehler: ${error?.message ?? error}`,
        fixture: null,
        apiPrediction: null,
        odds: null,
        injuries: [],
        standings: null,
        quality: { score: 0, label: 'schwach', reason: 'external_context_failed' }
      };
    }
  } else {
    externalContext = {
      available: false,
      reason: 'Zusatzdaten aktuell nur fuer Fussball implementiert',
      quality: { score: 0, label: 'schwach', reason: 'unsupported_sport' }
    };
  }

  return { match, features, context, externalContext, diagnostics };
}

async function hydrateMatchHistory(match) {
  const sport = match.sport ?? 'football';
  const result = {
    homeTeamId: match.home_team_id ?? null,
    awayTeamId: match.away_team_id ?? null,
    teamFetches: [],
    h2hFetch: null
  };

  if (match.home_team_id) result.teamFetches.push(await fetchHistoryOnce(sport, match.home_team_id));
  if (match.away_team_id) result.teamFetches.push(await fetchHistoryOnce(sport, match.away_team_id));

  const db = getDb();
  const homeRecent = fetchRecentMatches(db, match, 'home', TEAM_HISTORY_SIZE);
  const awayRecent = fetchRecentMatches(db, match, 'away', TEAM_HISTORY_SIZE);
  const h2h = fetchHeadToHead(db, match, H2H_HISTORY_SIZE);

  if (homeRecent.length < 3 && match.home_team_id) {
    result.teamFetches.push(await forceFetchTeamHistory(sport, match.home_team_id));
  }
  if (awayRecent.length < 3 && match.away_team_id) {
    result.teamFetches.push(await forceFetchTeamHistory(sport, match.away_team_id));
  }
  if (h2h.length < 2 && match.home_team_id && match.away_team_id) {
    const rows = await fetchHeadToHeadHistory(match.home_team_id, match.away_team_id, H2H_HISTORY_SIZE, sport);
    result.h2hFetch = { requested: true, count: Array.isArray(rows) ? rows.length : 0 };
  }

  return result;
}

async function fetchHistoryOnce(sport, teamId) {
  const key = `${sport}:${teamId}`;
  if (historyFetchCache.has(key)) return { teamId, cached: true, count: null };
  const rows = await forceFetchTeamHistory(sport, teamId);
  if (rows.count > 0) historyFetchCache.add(key);
  return rows;
}

async function forceFetchTeamHistory(sport, teamId) {
  const rows = await fetchTeamHistory(teamId, TEAM_HISTORY_SIZE, sport);
  return { teamId, cached: false, count: Array.isArray(rows) ? rows.length : 0 };
}

function getMatchRecord(matchId) {
  const numericId = toNumber(matchId);
  if (numericId === null) return null;

  const db = getDb();
  const stmt = db.prepare(`
    SELECT match_id, COALESCE(sport, 'football') AS sport, date, status,
           home_team, away_team, home_team_id, away_team_id,
           league_id, league_name, league_country, season, round, raw_json
    FROM matches
    WHERE match_id = @matchId
  `);

  for (const candidate of makeCandidateMatchIds(numericId)) {
    const row = stmt.get({ matchId: candidate });
    if (row) return row;
  }
  return null;
}

function getMatchContext(match) {
  const db = getDb();
  return {
    sport: match.sport ?? 'football',
    homeTeam: match.home_team ?? null,
    awayTeam: match.away_team ?? null,
    homeTeamId: match.home_team_id ?? null,
    awayTeamId: match.away_team_id ?? null,
    homeTeamRecent: fetchRecentMatches(db, match, 'home', TEAM_HISTORY_SIZE),
    awayTeamRecent: fetchRecentMatches(db, match, 'away', TEAM_HISTORY_SIZE),
    headToHead: fetchHeadToHead(db, match, H2H_HISTORY_SIZE)
  };
}

function fetchRecentMatches(db, match, side, limit) {
  const teamId = side === 'home' ? toNumber(match.home_team_id) : toNumber(match.away_team_id);
  const teamName = side === 'home' ? match.home_team : match.away_team;
  if (teamId === null && !teamName) return [];

  const byId = teamId !== null;
  const stmt = db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
    FROM matches
    WHERE match_id != @exclude
      AND COALESCE(sport, 'football') = @sport
      AND date IS NOT NULL
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      ${match.date ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
      AND ${byId
        ? '(home_team_id = @teamId OR away_team_id = @teamId)'
        : '(LOWER(home_team) = LOWER(@teamName) OR LOWER(away_team) = LOWER(@teamName))'}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `);

  return stmt.all({
    exclude: match.match_id,
    sport: match.sport ?? 'football',
    beforeDate: match.date ?? null,
    teamId,
    teamName,
    limit
  });
}

function fetchHeadToHead(db, match, limit) {
  const homeId = toNumber(match.home_team_id);
  const awayId = toNumber(match.away_team_id);
  const useIds = homeId !== null && awayId !== null;
  if (!useIds && (!match.home_team || !match.away_team)) return [];

  const stmt = db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
    FROM matches
    WHERE match_id != @exclude
      AND COALESCE(sport, 'football') = @sport
      AND date IS NOT NULL
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      ${match.date ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
      AND ${useIds
        ? '((home_team_id = @homeId AND away_team_id = @awayId) OR (home_team_id = @awayId AND away_team_id = @homeId))'
        : '((LOWER(home_team) = LOWER(@homeName) AND LOWER(away_team) = LOWER(@awayName)) OR (LOWER(home_team) = LOWER(@awayName) AND LOWER(away_team) = LOWER(@homeName)))'}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `);

  return stmt.all({
    exclude: match.match_id,
    sport: match.sport ?? 'football',
    beforeDate: match.date ?? null,
    homeId,
    awayId,
    homeName: match.home_team,
    awayName: match.away_team,
    limit
  });
}

function buildPrompt(prepared) {
  const { match, features, context, externalContext, diagnostics } = prepared;
  const sport = match.sport ?? 'football';
  const meta = SPORT_META[sport] ?? SPORT_META.football;
  const rawInput = buildRawInput(prepared);

  return [
    `Du bist ein vorsichtiger, datengetriebener ${meta.analyst}.`,
    'Nutze nur die Daten in diesem Prompt. Erfinde keine Verletzungen, Quoten, Tabellenplaetze, News oder Formwerte.',
    'Wichtig: Wenn Daten fehlen, sind fehlende Werte NICHT als 0-Leistung zu interpretieren.',
    'Wenn local_stats.hasUsableSamples false ist, darfst du keine starke Empfehlung geben. Confidence dann maximal 0.45.',
    'Wenn odds/apiPrediction/standings fehlen, keine Value-Bet behaupten.',
    'Antwort ausschliesslich als JSON: match_id, prediction, probabilities {home, draw, away}, explanation, betting_advice {recommendation, confidence, reasoning}.',
    'probabilities und confidence sind Zahlen zwischen 0 und 1.',
    '',
    'RAW_DATA_JSON:',
    JSON.stringify(rawInput, null, 2),
    '',
    'LESBARE ZUSAMMENFASSUNG:',
    `Match: ${context.homeTeam ?? 'Heimteam'} vs ${context.awayTeam ?? 'Auswaertsteam'} | ${match.date ?? 'Datum unbekannt'} | ${match.league_name ?? 'Liga unbekannt'}`,
    formatFeatureBlock(features, meta),
    describeDataQuality(features, context, diagnostics),
    formatFootballContextForPrompt(externalContext, context.homeTeam, context.awayTeam),
    formatTeamHistory(context.homeTeamRecent, context.homeTeam, context.homeTeamId, `Letzte Spiele ${context.homeTeam ?? 'Heimteam'}`, sport),
    formatTeamHistory(context.awayTeamRecent, context.awayTeam, context.awayTeamId, `Letzte Spiele ${context.awayTeam ?? 'Auswaertsteam'}`, sport),
    formatHeadToHeadHistory(context.headToHead, `Direkte Duelle`, sport),
    '',
    'Antworte mit reinem JSON ohne Markdown.'
  ].join('\n');
}

function buildRawInput({ match, features, context, externalContext, diagnostics }) {
  return {
    match: {
      match_id: match.match_id,
      sport: match.sport,
      date: match.date,
      status: match.status,
      league: {
        id: match.league_id,
        name: match.league_name,
        country: match.league_country,
        season: match.season,
        round: match.round
      },
      home: { id: match.home_team_id, name: match.home_team },
      away: { id: match.away_team_id, name: match.away_team }
    },
    local_stats: {
      hasFeatureRow: diagnostics.hasFeatureRow,
      hasUsableSamples: diagnostics.hasUsableSamples,
      qualityLabel: diagnostics.localQualityLabel,
      totalGames: diagnostics.totalGames,
      h2hCount: diagnostics.h2hCount,
      features
    },
    local_history: {
      homeRecent: context.homeTeamRecent.slice(0, TEAM_HISTORY_SIZE),
      awayRecent: context.awayTeamRecent.slice(0, TEAM_HISTORY_SIZE),
      h2h: context.headToHead.slice(0, H2H_HISTORY_SIZE)
    },
    external: {
      available: Boolean(externalContext?.available),
      quality: externalContext?.quality ?? null,
      fixture: externalContext?.fixture ?? null,
      apiPrediction: externalContext?.apiPrediction ?? null,
      odds: externalContext?.odds ?? null,
      injuries: externalContext?.injuries ?? [],
      standings: externalContext?.standings ?? null,
      reason: externalContext?.reason ?? null
    },
    diagnostics
  };
}

async function tryAiEngine(engine, callFn, match, prepared) {
  try {
    const raw = await callFn();
    const parsed = normalizeIncomingPayload(raw);
    if (!parsed) return null;
    const validated = normalizePrediction(parsed, match.match_id, match.sport, prepared.diagnostics);
    if (!validated) return null;
    return addMeta(validated, engine, prepared);
  } catch (error) {
    console.warn(`${engine} fehlgeschlagen:`, error?.message ?? error);
    return null;
  }
}

async function callRemoteLlama(prompt) {
  const response = await axios.post(
    LLAMA_SERVER_URL,
    { prompt, maxTokens: 900, temperature: 0.08 },
    { timeout: 30000 }
  );
  return response.data ?? null;
}

async function callOllama(prompt) {
  const host = OLLAMA_HOST.replace(/\/$/, '');
  const response = await axios.post(
    `${host}/api/generate`,
    {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: {
        temperature: 0.05,
        top_p: 0.75,
        repeat_penalty: 1.08,
        num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 8192,
        num_predict: Number(process.env.OLLAMA_NUM_PREDICT) || 900
      }
    },
    { timeout: Number(process.env.OLLAMA_TIMEOUT_MS) || 90000 }
  );
  return response.data ?? null;
}

function normalizeIncomingPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return extractJson(raw) ?? parseJsonSafe(raw);
  if (typeof raw !== 'object') return null;
  if (raw.prediction && raw.probabilities) return raw;

  for (const key of ['response', 'completion', 'output', 'text']) {
    const parsed = normalizeIncomingPayload(raw[key]);
    if (parsed) return parsed;
  }

  for (const key of ['results', 'generations', 'choices']) {
    if (!Array.isArray(raw[key])) continue;
    for (const entry of raw[key]) {
      const parsed = normalizeIncomingPayload(entry);
      if (parsed) return parsed;
    }
  }

  return raw.probabilities ? raw : null;
}

function normalizePrediction(payload, matchId, sport, diagnostics) {
  const probs = payload?.probabilities ?? {};
  const home = normalizeProbabilityValue(probs.home);
  const draw = normalizeProbabilityValue(probs.draw);
  const away = normalizeProbabilityValue(probs.away);
  if (home === null || draw === null || away === null) return null;

  const probabilities = normalizeProbabilities({ home, draw, away }, sport);
  const confidenceRaw = normalizeProbabilityValue(payload?.betting_advice?.confidence);
  let confidence = confidenceRaw === null ? 0.35 : round(clamp(0, 1, confidenceRaw));

  if (diagnostics && !diagnostics.hasUsableSamples) confidence = Math.min(confidence, 0.45);
  if (diagnostics && diagnostics.localQualityLabel === 'schwach') confidence = Math.min(confidence, 0.58);

  const prediction = normalizePredictionLabel(payload.prediction ?? pickPrediction(probabilities, sport), sport);
  const recommendation = confidence < 0.58
    ? 'Keine klare Wette'
    : payload?.betting_advice?.recommendation ?? prediction;

  return {
    match_id: payload.match_id ?? matchId,
    prediction,
    probabilities,
    explanation: String(payload.explanation ?? 'Analyse auf Basis der verfuegbaren Daten.').slice(0, 1200),
    betting_advice: {
      recommendation,
      confidence: round(confidence),
      reasoning: String(payload?.betting_advice?.reasoning ?? 'Datenlage wurde konservativ bewertet.').slice(0, 1200)
    }
  };
}

function simpleRulePredict(match, features, context, externalContext, diagnostics) {
  const sport = match.sport ?? 'football';
  const meta = SPORT_META[sport] ?? SPORT_META.football;
  const sampleScore = clamp(0, 1, diagnostics.totalGames / 20);

  const formEdge = (features.home_form - features.away_form) * 0.35;
  const ppgEdge = ((features.home_points_per_game - features.away_points_per_game) / 3) * 0.25;
  const diffEdge = clamp(-1, 1, (features.home_goal_diff_avg - features.away_goal_diff_avg) / 3) * 0.25;
  const attackEdge = clamp(-1, 1, (features.home_goals_avg - features.away_goals_avg) / 3) * 0.15;
  const homeAdvantage = sport === 'basketball' ? 0.04 : 0.07;
  const apiEdge = getExternalApiEdge(externalContext, context.homeTeam, context.awayTeam) * 0.12;
  const edge = diagnostics.hasUsableSamples
    ? clamp(-0.85, 0.85, formEdge + ppgEdge + diffEdge + attackEdge + homeAdvantage + apiEdge)
    : homeAdvantage + apiEdge;

  const drawBase = sport === 'basketball' ? 0.02 : clamp(0.14, 0.34, 0.28 - Math.abs(edge) * 0.18);
  const remaining = 1 - drawBase;
  const homeShare = clamp(0.15, 0.85, 0.5 + edge / 1.65);
  const probabilities = normalizeProbabilities({ home: remaining * homeShare, draw: drawBase, away: remaining * (1 - homeShare) }, sport);
  const prediction = pickPrediction(probabilities, sport);

  const sorted = [probabilities.home, probabilities.draw, probabilities.away].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  const externalQuality = externalContext?.quality?.score ?? 0;
  let confidence = 0.38 + Math.abs(edge) * 0.22 + margin * 0.35 + sampleScore * 0.2 + (externalQuality / 100) * 0.12;
  if (!diagnostics.hasUsableSamples) confidence = Math.min(confidence, 0.45);
  if (diagnostics.localQualityLabel === 'schwach') confidence = Math.min(confidence, 0.58);
  confidence = round(clamp(0.3, 0.84, confidence));

  return {
    match_id: match.match_id,
    prediction,
    probabilities,
    explanation: [
      'Regelbasiertes Fallback-Modell.',
      `Datenqualitaet=${diagnostics.localQualityLabel}`,
      `Samples=${features.home_games}+${features.away_games}`,
      `H2H=${diagnostics.h2hCount}`,
      `Form=${features.home_recent_form || 'n/a'} vs ${features.away_recent_form || 'n/a'}`,
      `${meta.score} avg=${features.home_goals_avg}/${features.away_goals_avg}`,
      `External=${externalContext?.quality?.label ?? 'schwach'}`
    ].join(' | '),
    betting_advice: {
      recommendation: confidence < 0.58 ? 'Keine klare Wette' : prediction,
      confidence,
      reasoning: confidence < 0.58
        ? 'Datenlage oder Edge ist zu schwach. Keine aggressive Empfehlung.'
        : 'Empfehlung basiert auf Samples, Form, Tor-/Punktdifferenz, Heimvorteil und externem Kontext.'
    }
  };
}

function buildDiagnostics({ match, features, context, hydration, hasFeatureRow }) {
  const totalGames = (features.home_games ?? 0) + (features.away_games ?? 0);
  const h2hCount = context.headToHead.length;
  const hasUsableSamples = totalGames >= 4 || (context.homeTeamRecent.length >= 2 && context.awayTeamRecent.length >= 2);
  const localQualityLabel = totalGames >= 12 ? 'gut' : totalGames >= 6 ? 'mittel' : 'schwach';

  return {
    hasFeatureRow,
    hasUsableSamples,
    localQualityLabel,
    totalGames,
    h2hCount,
    homeRecentCount: context.homeTeamRecent.length,
    awayRecentCount: context.awayTeamRecent.length,
    missing: {
      homeTeamId: !match.home_team_id,
      awayTeamId: !match.away_team_id,
      league: !match.league_id,
      featureRow: !hasFeatureRow,
      localSamples: !hasUsableSamples
    },
    hydration
  };
}

function addMeta(result, engine, prepared) {
  return {
    ...result,
    engine,
    data_quality: {
      local: describeDataQuality(prepared.features, prepared.context, prepared.diagnostics),
      external: prepared.externalContext?.quality ?? null,
      diagnostics: prepared.diagnostics
    }
  };
}

function formatFeatureBlock(features, meta) {
  return [
    'Berechnete lokale Stats:',
    `Home form (0-1): ${features.home_form}`,
    `Away form (0-1): ${features.away_form}`,
    `Home sample: ${features.home_games} Spiele | Formkurve: ${features.home_recent_form || 'n/a'}`,
    `Away sample: ${features.away_games} Spiele | Formkurve: ${features.away_recent_form || 'n/a'}`,
    `Home ${meta.score} fuer/gegen avg: ${features.home_goals_avg}/${features.home_goals_against_avg}`,
    `Away ${meta.score} fuer/gegen avg: ${features.away_goals_avg}/${features.away_goals_against_avg}`,
    `Home diff avg: ${features.home_goal_diff_avg} | Away diff avg: ${features.away_goal_diff_avg}`,
    `Home PPG: ${features.home_points_per_game} | Away PPG: ${features.away_points_per_game}`,
    `Home W/D/L: ${features.home_win_rate}/${features.home_draw_rate}/${features.home_loss_rate}`,
    `Away W/D/L: ${features.away_win_rate}/${features.away_draw_rate}/${features.away_loss_rate}`
  ].join('\n');
}

function formatTeamHistory(rows, teamName, teamId, title, sport) {
  if (!rows.length) return `${title}: Keine Daten verfuegbar.`;
  const scoreLabel = sport === 'basketball' ? 'Punkte' : 'Tore';
  const stats = summarizeTeamHistory(rows, teamName, teamId);
  const lines = rows.map((row) => {
    const side = isTeamHome(row, teamName, teamId) ? 'H' : 'A';
    const opponent = side === 'H' ? row.away_team : row.home_team;
    const goalsFor = toNumber(side === 'H' ? row.home_goals : row.away_goals);
    const goalsAgainst = toNumber(side === 'H' ? row.away_goals : row.home_goals);
    const marker = goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';
    return `${marker} ${String(row.date ?? '').slice(0, 10)} | ${side} vs ${opponent} | ${goalsFor}-${goalsAgainst}`;
  });
  return `${title} (${stats.wins}S-${stats.draws}U-${stats.losses}N, ${scoreLabel} ${stats.goalsFor}:${stats.goalsAgainst}):\n- ${lines.join('\n- ')}`;
}

function formatHeadToHeadHistory(rows, title, sport) {
  if (!rows.length) return `${title}: Keine direkten Duelle gefunden.`;
  const scoreLabel = sport === 'basketball' ? 'Punkte' : 'Tore';
  const lines = rows.map((row) => `${String(row.date ?? '').slice(0, 10)} | ${row.home_team} ${row.home_goals}-${row.away_goals} ${row.away_team}`);
  return `${title} (${scoreLabel}):\n- ${lines.join('\n- ')}`;
}

function describeDataQuality(features, context, diagnostics) {
  const totalGames = (features.home_games ?? 0) + (features.away_games ?? 0);
  return `Lokale Datenqualitaet: ${diagnostics.localQualityLabel}. Team-Samples: home=${context.homeTeamRecent.length}, away=${context.awayTeamRecent.length}, Stats-Spiele=${totalGames}, H2H=${context.headToHead.length}, usable=${diagnostics.hasUsableSamples}.`;
}

function summarizeTeamHistory(rows, teamName, teamId) {
  const summary = { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  for (const row of rows) {
    const home = isTeamHome(row, teamName, teamId);
    const goalsFor = toNumber(home ? row.home_goals : row.away_goals);
    const goalsAgainst = toNumber(home ? row.away_goals : row.home_goals);
    if (goalsFor === null || goalsAgainst === null) continue;
    summary.goalsFor += goalsFor;
    summary.goalsAgainst += goalsAgainst;
    if (goalsFor > goalsAgainst) summary.wins += 1;
    else if (goalsFor < goalsAgainst) summary.losses += 1;
    else summary.draws += 1;
  }
  return summary;
}

function isTeamHome(row, teamName, teamId) {
  const id = toNumber(teamId);
  if (id !== null && toNumber(row.home_team_id) === id) return true;
  return normalizeName(row.home_team) === normalizeName(teamName);
}

function getExternalApiEdge(externalContext, homeTeam, awayTeam) {
  const prediction = externalContext?.apiPrediction;
  if (!prediction?.percent) return 0;
  const home = normalizeProbabilityValue(prediction.percent.home) ?? 0;
  const away = normalizeProbabilityValue(prediction.percent.away) ?? 0;
  let edge = home - away;
  const winner = normalizeName(prediction.winner);
  if (winner && normalizeName(homeTeam) === winner) edge += 0.08;
  if (winner && normalizeName(awayTeam) === winner) edge -= 0.08;
  return clamp(-1, 1, edge);
}

function normalizeFeatures(row, sportHint) {
  return {
    sport: row.resolved_sport ?? row.sport ?? sportHint,
    home_form: toNumber(row.home_form) ?? 0,
    away_form: toNumber(row.away_form) ?? 0,
    home_goals_avg: toNumber(row.home_goals_avg) ?? 0,
    away_goals_avg: toNumber(row.away_goals_avg) ?? 0,
    home_games: toNumber(row.home_games) ?? 0,
    away_games: toNumber(row.away_games) ?? 0,
    home_win_rate: toNumber(row.home_win_rate) ?? 0,
    away_win_rate: toNumber(row.away_win_rate) ?? 0,
    home_draw_rate: toNumber(row.home_draw_rate) ?? 0,
    away_draw_rate: toNumber(row.away_draw_rate) ?? 0,
    home_loss_rate: toNumber(row.home_loss_rate) ?? 0,
    away_loss_rate: toNumber(row.away_loss_rate) ?? 0,
    home_goals_against_avg: toNumber(row.home_goals_against_avg) ?? 0,
    away_goals_against_avg: toNumber(row.away_goals_against_avg) ?? 0,
    home_goal_diff_avg: toNumber(row.home_goal_diff_avg) ?? 0,
    away_goal_diff_avg: toNumber(row.away_goal_diff_avg) ?? 0,
    home_points_per_game: toNumber(row.home_points_per_game) ?? 0,
    away_points_per_game: toNumber(row.away_points_per_game) ?? 0,
    home_recent_form: row.home_recent_form ?? '',
    away_recent_form: row.away_recent_form ?? ''
  };
}

function createEmptyFeatures(sport = 'football') {
  return normalizeFeatures({ sport, resolved_sport: sport }, sport);
}

function normalizePredictionLabel(value, sport) {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('home') || text.includes('heim') || text.includes('1')) return 'Heimsieg';
  if (sport !== 'basketball' && (text.includes('draw') || text.includes('remis') || text.includes('unentschieden') || text === 'x')) return 'Unentschieden';
  if (text.includes('away') || text.includes('auswaert') || text.includes('auswärt') || text.includes('2')) return 'Auswaertssieg';
  return sport === 'basketball' ? 'Heimsieg' : 'Unentschieden';
}

function pickPrediction(probabilities, sport) {
  const entries = sport === 'basketball'
    ? [['Heimsieg', probabilities.home], ['Auswaertssieg', probabilities.away]]
    : [['Heimsieg', probabilities.home], ['Unentschieden', probabilities.draw], ['Auswaertssieg', probabilities.away]];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function normalizeProbabilities(probs, sport = 'football') {
  const values = {
    home: Math.max(0, probs.home ?? 0),
    draw: sport === 'basketball' ? 0.02 : Math.max(0, probs.draw ?? 0),
    away: Math.max(0, probs.away ?? 0)
  };
  const total = values.home + values.draw + values.away;
  if (!total || total <= 0) return sport === 'basketball'
    ? { home: 0.5, draw: 0.02, away: 0.48 }
    : { home: 0.34, draw: 0.33, away: 0.33 };
  return {
    home: round(values.home / total),
    draw: round(values.draw / total),
    away: round(values.away / total)
  };
}

function normalizeProbabilityValue(value) {
  const number = toNumber(value);
  if (number === null) return null;
  return number > 1 ? number / 100 : number;
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return parseJsonSafe(match[0]);
}

function parseJsonSafe(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function makeCandidateMatchIds(matchId) {
  const numeric = toNumber(matchId);
  if (numeric === null) return [];
  const candidates = new Set([numeric]);
  for (const offset of Object.values(SPORT_OFFSETS)) {
    if (!offset) continue;
    candidates.add(numeric + offset);
    if (numeric >= offset) candidates.add(numeric - offset);
  }
  return [...candidates].filter((value) => Number.isFinite(value) && value >= 0);
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
