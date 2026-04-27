import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import { fetchTeamHistory, fetchHeadToHeadHistory, fetchMatchById } from '../api/apiHandler.js';
import { buildFootballContext, formatFootballContextForPrompt, getFootballContextDebug } from '../api/footballContext.js';
import { calculateFeatures } from '../features/featureEngine.js';

dotenv.config();

const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL ?? null;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:8b';

const TEAM_HISTORY_SIZE = 12;
const H2H_HISTORY_SIZE = 10;
const fetchedHistoryTeams = new Set();

const SPORT_OFFSETS = { football: 0, basketball: 5_000_000_000 };

const SPORT_PROMPT_META = {
  football: {
    analystLabel: 'Fussball-Analyst',
    scoringLabel: 'Tore',
    scoringLong: 'Torproduktion',
    drawLabel: 'Unentschieden'
  },
  basketball: {
    analystLabel: 'Basketball-Analyst',
    scoringLabel: 'Punkte',
    scoringLong: 'Punktproduktion',
    drawLabel: 'Unentschieden praktisch nicht relevant'
  }
};

export function getFeatures(matchId, sportHint = 'football') {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         s.home_form,
         s.away_form,
         s.home_goals_avg,
         s.away_goals_avg,
         COALESCE(s.home_games, 0) AS home_games,
         COALESCE(s.away_games, 0) AS away_games,
         COALESCE(s.home_win_rate, 0) AS home_win_rate,
         COALESCE(s.away_win_rate, 0) AS away_win_rate,
         COALESCE(s.home_draw_rate, 0) AS home_draw_rate,
         COALESCE(s.away_draw_rate, 0) AS away_draw_rate,
         COALESCE(s.home_loss_rate, 0) AS home_loss_rate,
         COALESCE(s.away_loss_rate, 0) AS away_loss_rate,
         COALESCE(s.home_goals_against_avg, 0) AS home_goals_against_avg,
         COALESCE(s.away_goals_against_avg, 0) AS away_goals_against_avg,
         COALESCE(s.home_goal_diff_avg, 0) AS home_goal_diff_avg,
         COALESCE(s.away_goal_diff_avg, 0) AS away_goal_diff_avg,
         COALESCE(s.home_points_per_game, 0) AS home_points_per_game,
         COALESCE(s.away_points_per_game, 0) AS away_points_per_game,
         COALESCE(s.home_recent_form, '') AS home_recent_form,
         COALESCE(s.away_recent_form, '') AS away_recent_form,
         COALESCE(s.sport, m.sport, @defaultSport) AS sport
       FROM stats s
       LEFT JOIN matches m ON m.match_id = s.match_id
       WHERE s.match_id = @matchId`
    )
    .get({ matchId, defaultSport: sportHint });

  if (!row) return null;
  return normalizeFeatures(row, sportHint);
}

export async function predictMatch(matchId) {
  const prepared = await preparePredictionInput(matchId);
  if (prepared.error) return { error: prepared.error };

  const { match, features, context, externalContext } = prepared;
  const prompt = buildPrompt(match, features, context, externalContext);

  if (LLAMA_SERVER_URL) {
    try {
      const remoteRaw = await callRemoteLlama(prompt);
      const parsed = normalizeIncomingPayload(remoteRaw);
      if (parsed) {
        const validated = normalizePrediction(parsed, match.match_id, match.sport);
        if (validated) return addMeta(validated, 'llama', prepared);
        console.warn('Remote Llama lieferte ein ungueltiges Format, wechsle zum naechsten Fallback.');
      }
    } catch (error) {
      console.warn('Remote Llama Anfrage fehlgeschlagen, nutze Fallback:', error?.message ?? error);
    }
  }

  if (OLLAMA_MODEL) {
    try {
      const ollamaRaw = await callOllama(prompt);
      const parsed = normalizeIncomingPayload(ollamaRaw);
      if (parsed) {
        const validated = normalizePrediction(parsed, match.match_id, match.sport);
        if (validated) return addMeta(validated, `ollama:${OLLAMA_MODEL}`, prepared);
        console.warn('Ollama lieferte ein ungueltiges Format, nutze das regelbasierte Modell.');
      }
    } catch (error) {
      console.warn('Ollama-Anfrage fehlgeschlagen, nutze Fallback:', error?.message ?? error);
    }
  }

  return addMeta(simpleRulePredict(match, features, context, externalContext), 'rule-based', prepared);
}

export async function ensureMatchHistory(matchId) {
  const numericId = typeof matchId === 'object' ? null : toNumber(matchId);
  const match = typeof matchId === 'object' ? matchId : numericId === null ? null : getMatchRecord(numericId);
  if (!match) return;
  await hydrateMatchHistory(match);
}

export async function getPredictionDebug(matchId) {
  const prepared = await preparePredictionInput(matchId);
  if (prepared.error) return { error: prepared.error };
  const { match, features, context, externalContext } = prepared;
  return {
    match,
    features,
    localData: {
      homeRecentCount: context.homeTeamRecent.length,
      awayRecentCount: context.awayTeamRecent.length,
      h2hCount: context.headToHead.length,
      homeRecent: context.homeTeamRecent.slice(0, 5),
      awayRecent: context.awayTeamRecent.slice(0, 5),
      h2h: context.headToHead.slice(0, 5)
    },
    external: getFootballContextDebug(externalContext),
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

  await hydrateMatchHistory(match);
  calculateFeatures({ matchId: match.match_id });

  const features = getFeatures(match.match_id, match.sport) ?? createEmptyFeatures(match.sport);
  const context = getMatchContext(match);
  const externalContext = match.sport === 'football'
    ? await buildFootballContext(match)
    : { available: false, reason: 'Nur Fussball-Context implementiert', quality: { score: 0, label: 'schwach', reason: 'kein Fussball' } };

  return { match, features, context, externalContext };
}

function buildPrompt(match, features, context, externalContext) {
  const sport = match.sport ?? 'football';
  const meta = SPORT_PROMPT_META[sport] ?? SPORT_PROMPT_META.football;

  const homeHistory = formatTeamHistory(context.homeTeamRecent, context.homeTeam, `Letzte Spiele ${context.homeTeam ?? 'Heimteam'}`, sport);
  const awayHistory = formatTeamHistory(context.awayTeamRecent, context.awayTeam, `Letzte Spiele ${context.awayTeam ?? 'Auswaertsteam'}`, sport);
  const h2hHistory = formatHeadToHeadHistory(context.headToHead, `Direkte Duelle (${context.homeTeam ?? 'Heimteam'} vs ${context.awayTeam ?? 'Auswaertsteam'})`, sport);
  const externalBlock = formatFootballContextForPrompt(externalContext, context.homeTeam, context.awayTeam);

  return [
    `Du bist ein vorsichtiger, datengetriebener ${meta.analystLabel}.`,
    'Nutze nur die unten gegebenen Daten. Erfinde keine News, Verletzungen, Quoten, Tabellenplaetze oder Formwerte.',
    'Wenn die Datenlage schwach oder widerspruechlich ist, senke die confidence und schreibe das klar in reasoning.',
    'Gib keine starke Wettempfehlung aus, wenn Sample Size, Odds-Markt, API-Prediction oder Teamdaten keinen klaren Edge zeigen.',
    'Antworte ausschliesslich mit einem JSON-Objekt mit diesen Feldern:',
    'match_id, prediction, probabilities {home, draw, away}, explanation, betting_advice {recommendation, confidence, reasoning}.',
    'probabilities und confidence muessen Werte zwischen 0 und 1 sein.',
    '',
    `Match ID: ${match.match_id}`,
    `Sportart: ${sport}`,
    `Status: ${match.status ?? 'unbekannt'}`,
    `Anstoss: ${match.date ?? 'unbekannt'}`,
    `Heimteam: ${context.homeTeam ?? 'Unbekannt'}`,
    `Auswaertsteam: ${context.awayTeam ?? 'Unbekannt'}`,
    '',
    'Berechnete lokale Stats:',
    formatFeatureBlock(features, meta),
    '',
    'Lokale Datenqualitaet:',
    describeDataQuality(features, context),
    '',
    externalBlock,
    '',
    homeHistory,
    '',
    awayHistory,
    '',
    h2hHistory,
    '',
    `Bewerte in genau dieser Reihenfolge: Datenqualitaet, Teamform, ${meta.scoringLong}, Defensive, Heim-/Auswaertslage, H2H, Tabellenlage, Verletzungen/Sperren, Odds/Marktvergleich, API-Prediction.`,
    'Wenn Odds implizite Wahrscheinlichkeiten deutlich von deiner Prognose abweichen, erklaere die Abweichung.',
    'Wenn keine Odds oder keine Zusatzdaten verfuegbar sind, keine Value-Bet behaupten.',
    'Antwort: reines JSON ohne Markdown.'
  ].join('\n');
}

async function callRemoteLlama(prompt) {
  const response = await axios.post(
    LLAMA_SERVER_URL,
    { prompt, maxTokens: 700, temperature: 0.12, stop: ['\n\n'] },
    { timeout: 25000 }
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
        temperature: 0.1,
        top_p: 0.8,
        repeat_penalty: 1.08,
        num_predict: 700
      }
    },
    { timeout: 45000 }
  );
  return response.data ?? null;
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    try {
      const sanitized = match[0].replace(/'/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function normalizeIncomingPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return extractJson(raw) ?? parseJsonSafe(raw);
  if (typeof raw !== 'object') return null;
  if (raw.prediction && raw.probabilities) return raw;

  for (const key of ['response', 'completion', 'output', 'text']) {
    const value = raw[key];
    if (typeof value === 'string') {
      const parsed = normalizeIncomingPayload(value);
      if (parsed) return parsed;
    }
  }

  for (const key of ['results', 'generations', 'choices']) {
    const entries = raw[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const parsed = normalizeIncomingPayload(entry);
      if (parsed) return parsed;
    }
  }

  return raw.match_id || raw.probabilities ? raw : null;
}

function parseJsonSafe(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function getMatchRecord(matchId) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT match_id, COALESCE(sport, 'football') AS sport, date, status,
            home_team, away_team, home_team_id, away_team_id,
            league_id, league_name, league_country, season, round
     FROM matches
     WHERE match_id = @matchId`
  );

  for (const candidate of makeCandidateMatchIds(matchId)) {
    const row = stmt.get({ matchId: candidate });
    if (row) return row;
  }
  return null;
}

async function hydrateMatchHistory(match) {
  const sport = match.sport ?? 'football';
  const db = getDb();

  if (match.home_team_id) await fetchHistoryOnce(sport, match.home_team_id);
  if (match.away_team_id) await fetchHistoryOnce(sport, match.away_team_id);

  let homeRecent = fetchRecentMatches(db, match.home_team, match.match_id, match.date, sport, TEAM_HISTORY_SIZE);
  if (homeRecent.length < 3 && match.home_team_id) {
    await fetchTeamHistory(match.home_team_id, TEAM_HISTORY_SIZE, sport);
  }

  let awayRecent = fetchRecentMatches(db, match.away_team, match.match_id, match.date, sport, TEAM_HISTORY_SIZE);
  if (awayRecent.length < 3 && match.away_team_id) {
    await fetchTeamHistory(match.away_team_id, TEAM_HISTORY_SIZE, sport);
  }

  let headToHead = fetchHeadToHead(db, match.home_team, match.away_team, match.match_id, match.date, sport, H2H_HISTORY_SIZE);
  if (headToHead.length < 2 && match.home_team_id && match.away_team_id) {
    await fetchHeadToHeadHistory(match.home_team_id, match.away_team_id, H2H_HISTORY_SIZE, sport);
  }
}

async function fetchHistoryOnce(sport, teamId) {
  const key = buildHistoryKey(sport, teamId);
  if (fetchedHistoryTeams.has(key)) return;
  const fetched = await fetchTeamHistory(teamId, TEAM_HISTORY_SIZE, sport);
  if (Array.isArray(fetched) && fetched.length) fetchedHistoryTeams.add(key);
}

function getMatchContext(match) {
  const db = getDb();
  const sport = match.sport ?? 'football';
  return {
    sport,
    homeTeam: match.home_team ?? null,
    awayTeam: match.away_team ?? null,
    homeTeamRecent: fetchRecentMatches(db, match.home_team, match.match_id, match.date, sport, TEAM_HISTORY_SIZE),
    awayTeamRecent: fetchRecentMatches(db, match.away_team, match.match_id, match.date, sport, TEAM_HISTORY_SIZE),
    headToHead: fetchHeadToHead(db, match.home_team, match.away_team, match.match_id, match.date, sport, H2H_HISTORY_SIZE)
  };
}

function fetchRecentMatches(db, teamName, excludeMatchId, beforeDate, sport, limit = TEAM_HISTORY_SIZE) {
  if (!teamName) return [];
  const stmt = db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_goals, away_goals
    FROM matches
    WHERE (home_team = @team OR away_team = @team)
      AND match_id != @exclude
      AND COALESCE(sport, 'football') = @sport
      AND date IS NOT NULL
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      ${beforeDate ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `);

  return stmt.all({ team: teamName, exclude: excludeMatchId, beforeDate: beforeDate ?? null, sport, limit });
}

function fetchHeadToHead(db, homeTeam, awayTeam, excludeMatchId, beforeDate, sport, limit = H2H_HISTORY_SIZE) {
  if (!homeTeam || !awayTeam) return [];
  const stmt = db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_goals, away_goals
    FROM matches
    WHERE match_id != @exclude
      AND COALESCE(sport, 'football') = @sport
      AND ((home_team = @home AND away_team = @away) OR (home_team = @away AND away_team = @home))
      AND date IS NOT NULL
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      ${beforeDate ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `);

  return stmt.all({ exclude: excludeMatchId, sport, home: homeTeam, away: awayTeam, beforeDate: beforeDate ?? null, limit });
}

function formatFeatureBlock(features, meta) {
  return [
    `Home form gewichtet (0-1): ${features.home_form}`,
    `Away form gewichtet (0-1): ${features.away_form}`,
    `Home sample: ${features.home_games} Spiele | Formkurve: ${features.home_recent_form || 'n/a'}`,
    `Away sample: ${features.away_games} Spiele | Formkurve: ${features.away_recent_form || 'n/a'}`,
    `Home ${meta.scoringLabel} fuer/gegen avg: ${features.home_goals_avg}/${features.home_goals_against_avg}`,
    `Away ${meta.scoringLabel} fuer/gegen avg: ${features.away_goals_avg}/${features.away_goals_against_avg}`,
    `Home diff avg: ${features.home_goal_diff_avg} | Away diff avg: ${features.away_goal_diff_avg}`,
    `Home PPG: ${features.home_points_per_game} | Away PPG: ${features.away_points_per_game}`,
    `Home W/D/L: ${features.home_win_rate}/${features.home_draw_rate}/${features.home_loss_rate}`,
    `Away W/D/L: ${features.away_win_rate}/${features.away_draw_rate}/${features.away_loss_rate}`
  ].join('\n');
}

function formatTeamHistory(rows, teamName, title, sport) {
  if (!rows || rows.length === 0) return `${title}: Keine Daten verfuegbar.`;
  const recent = rows.slice(0, TEAM_HISTORY_SIZE);
  const stats = summarizeTeamHistory(recent, teamName);
  const scoreLabel = sport === 'basketball' ? 'Punkte' : 'Tore';
  const lines = recent.map((row) => {
    const date = row.date ? row.date.split('T')[0] : 'Unbekannt';
    const isHome = row.home_team === teamName;
    const opponent = isHome ? row.away_team : row.home_team;
    const goalsFor = toNumber(isHome ? row.home_goals : row.away_goals);
    const goalsAgainst = toNumber(isHome ? row.away_goals : row.home_goals);
    const venue = isHome ? 'H' : 'A';
    const marker = goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';
    return `${marker} ${date} | ${venue} vs ${opponent} | ${goalsFor}-${goalsAgainst}`;
  });
  return `${title} (Bilanz ${stats.wins}S-${stats.draws}U-${stats.losses}N, ${scoreLabel} ${stats.goalsFor}:${stats.goalsAgainst}):\n- ${lines.join('\n- ')}`;
}

function formatHeadToHeadHistory(rows, title, sport) {
  if (!rows || rows.length === 0) return `${title}: Keine direkten Duelle gefunden.`;
  const recent = rows.slice(0, H2H_HISTORY_SIZE);
  const stats = summarizeHeadToHead(recent);
  const scoreLabel = sport === 'basketball' ? 'Punkte' : 'Tore';
  const lines = recent.map((row) => {
    const date = row.date ? row.date.split('T')[0] : 'Unbekannt';
    const goalsHome = toNumber(row.home_goals);
    const goalsAway = toNumber(row.away_goals);
    const winner = goalsHome > goalsAway ? 'H' : goalsHome < goalsAway ? 'A' : 'D';
    return `${winner} ${date}: ${row.home_team} ${goalsHome}-${goalsAway} ${row.away_team}`;
  });
  return `${title} (Bilanz ${stats.homeWins} Heimsiege / ${stats.awayWins} Auswaertssiege / ${stats.draws} Remis, ${scoreLabel}):\n- ${lines.join('\n- ')}`;
}

function summarizeTeamHistory(rows, teamName) {
  const summary = { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  for (const row of rows) {
    const isHome = row.home_team === teamName;
    const goalsFor = toNumber(isHome ? row.home_goals : row.away_goals);
    const goalsAgainst = toNumber(isHome ? row.away_goals : row.home_goals);
    if (goalsFor === null || goalsAgainst === null) continue;
    summary.goalsFor += goalsFor;
    summary.goalsAgainst += goalsAgainst;
    if (goalsFor > goalsAgainst) summary.wins += 1;
    else if (goalsFor < goalsAgainst) summary.losses += 1;
    else summary.draws += 1;
  }
  return summary;
}

function summarizeHeadToHead(rows) {
  const summary = { homeWins: 0, awayWins: 0, draws: 0 };
  for (const row of rows) {
    const homeGoals = toNumber(row.home_goals);
    const awayGoals = toNumber(row.away_goals);
    if (homeGoals === null || awayGoals === null) continue;
    if (homeGoals > awayGoals) summary.homeWins += 1;
    else if (homeGoals < awayGoals) summary.awayWins += 1;
    else summary.draws += 1;
  }
  return summary;
}

function normalizePrediction(payload, matchId, sport = 'football') {
  if (!payload || typeof payload !== 'object') return null;
  const probs = payload.probabilities ?? {};
  const probHome = normalizeProbabilityValue(probs.home);
  const probDraw = normalizeProbabilityValue(probs.draw);
  const probAway = normalizeProbabilityValue(probs.away);
  if (probHome === null || probDraw === null || probAway === null) return null;

  const normalized = normalizeProbabilities({ home: probHome, draw: probDraw, away: probAway });
  const bettingAdvice = payload.betting_advice ?? {};
  const confidenceValue = normalizeProbabilityValue(bettingAdvice.confidence);

  return {
    match_id: payload.match_id ?? matchId,
    prediction: payload.prediction ?? pickPrediction(normalized, sport),
    probabilities: normalized,
    explanation: payload.explanation ?? 'Keine Erklaerung vorhanden.',
    betting_advice: {
      recommendation: bettingAdvice.recommendation ?? 'Keine klare Empfehlung',
      confidence: confidenceValue === null ? 0 : round(clamp(0, 1, confidenceValue)),
      reasoning: bettingAdvice.reasoning ?? 'Keine Begruendung vorhanden.'
    }
  };
}

function simpleRulePredict(match, features, context, externalContext) {
  const sport = match.sport ?? 'football';
  const meta = SPORT_PROMPT_META[sport] ?? SPORT_PROMPT_META.football;
  const sampleScore = getSampleScore(features);

  const formEdge = (features.home_form - features.away_form) * 0.35;
  const ppgEdge = ((features.home_points_per_game - features.away_points_per_game) / 3) * 0.25;
  const diffEdge = clamp(-1, 1, (features.home_goal_diff_avg - features.away_goal_diff_avg) / 3) * 0.25;
  const attackEdge = clamp(-1, 1, (features.home_goals_avg - features.away_goals_avg) / 3) * 0.15;
  const homeAdvantage = sport === 'basketball' ? 0.04 : 0.07;
  const apiEdge = getExternalApiEdge(externalContext, context.homeTeam, context.awayTeam) * 0.12;
  const edge = clamp(-0.85, 0.85, formEdge + ppgEdge + diffEdge + attackEdge + homeAdvantage + apiEdge);

  const drawBase = sport === 'basketball' ? 0.02 : clamp(0.12, 0.32, 0.28 - Math.abs(edge) * 0.18);
  const remaining = 1 - drawBase;
  const homeShare = clamp(0.12, 0.88, 0.5 + edge / 1.6);
  const probabilities = normalizeProbabilities({ home: remaining * homeShare, draw: drawBase, away: remaining * (1 - homeShare) });
  const prediction = pickPrediction(probabilities, sport);
  const externalQuality = externalContext?.quality?.score ?? 0;
  const confidence = getRuleConfidence(edge, sampleScore, probabilities, externalQuality);
  const recommendation = confidence < 0.58 ? 'Keine klare Wette' : prediction;

  return {
    match_id: match.match_id,
    prediction,
    probabilities,
    explanation: [
      'Regelbasiertes Modell mit lokalen Stats plus API-Zusatzdaten.',
      `Edge=${round(edge)}, Datenbasis=${features.home_games}+${features.away_games} Spiele`,
      `Form ${round(features.home_form)} vs ${round(features.away_form)}`,
      `${meta.scoringLabel} fuer ${features.home_goals_avg} vs ${features.away_goals_avg}`,
      `${meta.scoringLabel} gegen ${features.home_goals_against_avg} vs ${features.away_goals_against_avg}`,
      `H2H=${(context.headToHead ?? []).length}`,
      `Externe Daten=${externalContext?.quality?.label ?? 'schwach'} (${externalQuality}/100)`
    ].join(' | '),
    betting_advice: {
      recommendation,
      confidence,
      reasoning: confidence < 0.58
        ? 'Datenlage, Marktvergleich oder Vorteil ist zu schwach fuer eine stabile Empfehlung.'
        : `Empfehlung basiert auf Form, ${meta.scoringLabel}-Differenz, Gegenschnitt, Heimvorteil und API-Kontext.`
    },
    engine: 'rule-based'
  };
}

function addMeta(result, engine, prepared) {
  return {
    ...result,
    engine,
    data_quality: {
      local: describeDataQuality(prepared.features, prepared.context),
      external: prepared.externalContext?.quality ?? null
    }
  };
}

function getExternalApiEdge(externalContext, homeTeam, awayTeam) {
  const prediction = externalContext?.apiPrediction;
  if (!prediction?.percent) return 0;
  const home = normalizeProbabilityValue(prediction.percent.home) ?? 0;
  const away = normalizeProbabilityValue(prediction.percent.away) ?? 0;
  let edge = home - away;
  const winner = String(prediction.winner ?? '').toLowerCase();
  if (winner && String(homeTeam ?? '').toLowerCase() === winner) edge += 0.1;
  if (winner && String(awayTeam ?? '').toLowerCase() === winner) edge -= 0.1;
  return clamp(-1, 1, edge);
}

function normalizeFeatures(row, sportHint) {
  return {
    sport: row.sport ?? sportHint,
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

function createEmptyFeatures(sport = 'football') { return normalizeFeatures({ sport }, sport); }

function describeDataQuality(features, context) {
  const totalGames = (features.home_games ?? 0) + (features.away_games ?? 0);
  const h2hCount = (context.headToHead ?? []).length;
  const homeCount = (context.homeTeamRecent ?? []).length;
  const awayCount = (context.awayTeamRecent ?? []).length;
  const quality = totalGames >= 12 ? 'gut' : totalGames >= 6 ? 'mittel' : 'schwach';
  return `Qualitaet: ${quality}. Team-Samples: home=${homeCount}, away=${awayCount}, Stats-Spiele=${totalGames}, H2H=${h2hCount}.`;
}

function normalizeProbabilityValue(value) {
  const number = toNumber(value);
  if (number === null) return null;
  return number > 1 ? number / 100 : number;
}

function normalizeProbabilities(probs) {
  const total = probs.home + probs.draw + probs.away;
  if (!total || total <= 0) return { home: 0.34, draw: 0.33, away: 0.33 };
  return { home: round(probs.home / total), draw: round(probs.draw / total), away: round(probs.away / total) };
}

function pickPrediction(probabilities, sport = 'football') {
  if (sport === 'basketball') return probabilities.home >= probabilities.away ? 'Heimsieg' : 'Auswaertssieg';
  const entries = [['Heimsieg', probabilities.home], ['Unentschieden', probabilities.draw], ['Auswaertssieg', probabilities.away]];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function getSampleScore(features) {
  const total = (features.home_games ?? 0) + (features.away_games ?? 0);
  return clamp(0, 1, total / 20);
}

function getRuleConfidence(edge, sampleScore, probabilities, externalQuality = 0) {
  const sorted = [probabilities.home, probabilities.draw, probabilities.away].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  let confidence = 0.4 + Math.abs(edge) * 0.25 + margin * 0.38 + sampleScore * 0.17 + (externalQuality / 100) * 0.1;
  if (sampleScore < 0.35) confidence = Math.min(confidence, 0.55);
  if (externalQuality < 50) confidence = Math.min(confidence, 0.68);
  return round(clamp(0.35, 0.84, confidence));
}

function buildHistoryKey(sport, teamId) { return `${sport}:${teamId}`; }

function makeCandidateMatchIds(matchId) {
  const baseId = toNumber(matchId);
  if (baseId === null) return [];
  const candidates = new Set([baseId]);
  for (const offset of Object.values(SPORT_OFFSETS)) {
    if (!Number.isFinite(offset) || offset === 0) continue;
    candidates.add(baseId + offset);
    if (baseId >= offset) candidates.add(baseId - offset);
  }
  return [...candidates].filter((value) => Number.isFinite(value) && value >= 0);
}

function clamp(min, max, value) { return Math.max(min, Math.min(max, value)); }
function round(value) { return Math.round(value * 100) / 100; }
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
