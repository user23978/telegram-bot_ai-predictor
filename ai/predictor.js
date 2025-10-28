import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import { fetchTeamHistory, fetchHeadToHeadHistory } from '../api/apiHandler.js';

dotenv.config();

const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL ?? null;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? null;

const TEAM_HISTORY_SIZE = 12;
const H2H_HISTORY_SIZE = 10;

const fetchedHistoryTeams = new Set();

const SPORT_OFFSETS = {
  football: 0,
  basketball: 5_000_000_000
};

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
    drawLabel: 'Unentschieden'
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
         COALESCE(s.sport, m.sport, @defaultSport) AS sport
       FROM stats s
       LEFT JOIN matches m ON m.match_id = s.match_id
       WHERE s.match_id = ?
         AND COALESCE(s.sport, m.sport, @defaultSport) = COALESCE(m.sport, @defaultSport)`
    )
    .get(matchId, { defaultSport: sportHint });

  if (!row) return null;
  return {
    sport: row.sport ?? sportHint,
    home_form: toNumber(row.home_form) ?? 0,
    away_form: toNumber(row.away_form) ?? 0,
    home_goals_avg: toNumber(row.home_goals_avg) ?? 0,
    away_goals_avg: toNumber(row.away_goals_avg) ?? 0
  };
}

export async function predictMatch(matchId) {
  const numericId = toNumber(matchId);
  if (numericId === null) {
    return { error: 'Ungueltige Match-ID' };
  }

  const match = getMatchRecord(numericId);
  if (!match) {
    return { error: 'Match nicht gefunden' };
  }

  await hydrateMatchHistory(match);
  const features = getFeatures(match.match_id, match.sport);
  if (!features) {
    return { error: 'Keine Features gefunden' };
  }

  const context = getMatchContext(match);
  const prompt = buildPrompt(match, features, context);

  if (LLAMA_SERVER_URL) {
    const remoteRaw = await callRemoteLlama(prompt);
    const parsed = normalizeIncomingPayload(remoteRaw);
    if (parsed) {
      const validated = normalizePrediction(parsed, match.match_id);
      if (validated) {
        const source = typeof parsed.engine === 'string' ? parsed.engine : 'llama';
        return { ...validated, engine: source };
      }
      console.warn('Remote Llama lieferte ein ungueltiges Format, wechsle zum naechsten Fallback.');
    }
  }

  if (OLLAMA_MODEL) {
    const ollamaRaw = await callOllama(prompt);
    const parsed = normalizeIncomingPayload(ollamaRaw);
    if (parsed) {
      const validated = normalizePrediction(parsed, match.match_id);
      if (validated) {
        return { ...validated, engine: 'ollama' };
      }
      console.warn('Ollama lieferte ein ungueltiges Format, nutze das Regel-basierte Modell.');
    }
  }

  return simpleRulePredict(match, features);
}

export async function ensureMatchHistory(matchId) {
  const numericId = typeof matchId === 'object' ? null : toNumber(matchId);
  const match =
    typeof matchId === 'object'
      ? matchId
      : numericId === null
        ? null
        : getMatchRecord(numericId);
  if (!match) return;
  await hydrateMatchHistory(match);
}

function buildPrompt(match, features, context) {
  const sport = match.sport ?? 'football';
  const meta = SPORT_PROMPT_META[sport] ?? SPORT_PROMPT_META.football;

  const homeCount = (context.homeTeamRecent || []).length;
  const awayCount = (context.awayTeamRecent || []).length;

  const homeTitle = context.homeTeam
    ? homeCount
      ? `Letzte ${Math.min(homeCount, TEAM_HISTORY_SIZE)} Spiele ${context.homeTeam}`
      : `Letzte Spiele ${context.homeTeam}`
    : null;
  const awayTitle = context.awayTeam
    ? awayCount
      ? `Letzte ${Math.min(awayCount, TEAM_HISTORY_SIZE)} Spiele ${context.awayTeam}`
      : `Letzte Spiele ${context.awayTeam}`
    : null;

  const homeHistory = homeTitle
    ? formatTeamHistory(context.homeTeamRecent, context.homeTeam, homeTitle, sport)
    : null;
  const awayHistory = awayTitle
    ? formatTeamHistory(context.awayTeamRecent, context.awayTeam, awayTitle, sport)
    : null;
  const h2hHistory = formatHeadToHeadHistory(
    context.headToHead,
    `Direkte Duelle (${context.homeTeam ?? 'Heimteam'} vs ${context.awayTeam ?? 'Auswaertsteam'})`,
    sport
  );

  const scoringShort = meta.scoringLabel.toLowerCase();

  return [
    `Du bist ein ${meta.analystLabel}. Nutze die bereitgestellten Features und Spielvergangenheit,`,
    'um eine fundierte Prognose zu erstellen. Antworte ausschliesslich mit einem JSON-Objekt mit den Feldern',
    'match_id, prediction, probabilities (home/draw/away), explanation sowie betting_advice',
    '(recommendation, confidence, reasoning).',
    '',
    `Match ID: ${match.match_id}`,
    `Sportart: ${sport}`,
    `Heimteam: ${context.homeTeam ?? 'Unbekannt'}`,
    `Auswaertsteam: ${context.awayTeam ?? 'Unbekannt'}`,
    `home_form (0-1, 1=Top): ${features.home_form}`,
    `away_form (0-1, 1=Top): ${features.away_form}`,
    `home_${scoringShort}_avg: ${features.home_goals_avg}`,
    `away_${scoringShort}_avg: ${features.away_goals_avg}`,
    '',
    homeHistory,
    '',
    awayHistory,
    '',
    h2hHistory,
    '',
    `Beruecksichtige Formverlauf, ${meta.scoringLong}, Heim-/Auswaertsvorteile und direkte Duelle.`,
    'Antwort ausschliesslich als JSON-Objekt ohne ergaenzenden Text.'
  ]
    .filter(Boolean)
    .join('\n');
}

async function callRemoteLlama(prompt) {
  try {
    const response = await axios.post(
      LLAMA_SERVER_URL,
      {
        prompt,
        maxTokens: 256,
        temperature: 0.2,
        stop: ['\n\n']
      },
      { timeout: 20000 }
    );

    return response.data ?? null;
  } catch (error) {
    console.error('Remote Llama call failed:', error.message);
    return null;
  }
}

async function callOllama(prompt) {
  const host = OLLAMA_HOST.replace(/\/$/, '');
  try {
    const response = await axios.post(
      `${host}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: false
      },
      { timeout: 30000 }
    );

    return response.data ?? null;
  } catch (error) {
    const status = error?.response?.status;
    if (status === 404) {
      console.warn(
        `Ollama call failed: Modell "${OLLAMA_MODEL}" nicht gefunden. Bitte mit "ollama pull ${OLLAMA_MODEL}" installieren.`
      );
    } else {
      console.error('Ollama call failed:', error.message);
    }
    return null;
  }
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (error) {
    try {
      const sanitized = match[0]
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function normalizeIncomingPayload(raw) {
  if (!raw) return null;

  if (typeof raw === 'string') {
    return extractJson(raw) ?? parseJsonSafe(raw);
  }

  if (typeof raw !== 'object') {
    return null;
  }

  if (raw.prediction && raw.probabilities) {
    return raw;
  }

  const textualKeys = ['response', 'completion', 'output', 'text'];
  for (const key of textualKeys) {
    const value = raw[key];
    if (typeof value === 'string') {
      const parsed = normalizeIncomingPayload(value);
      if (parsed) return parsed;
    }
  }

  const arrayKeys = ['results', 'generations', 'choices'];
  for (const key of arrayKeys) {
    const entries = raw[key];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const parsed = normalizeIncomingPayload(entry);
        if (parsed) return parsed;
      }
    }
  }

  return raw.match_id || raw.probabilities ? raw : null;
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getMatchRecord(matchId) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT
       match_id,
       COALESCE(sport, 'football') AS sport,
       date,
       status,
       home_team,
       away_team,
       home_team_id,
       away_team_id
     FROM matches
     WHERE match_id = ?`
  );

  for (const candidate of makeCandidateMatchIds(matchId)) {
    const row = stmt.get(candidate);
    if (row) {
      return row;
    }
  }

  return null;
}

async function hydrateMatchHistory(match) {
  const sport = match.sport ?? 'football';
  const referenceDate = match.date ?? null;

  if (match.home_team_id) {
    const key = buildHistoryKey(sport, match.home_team_id);
    if (!fetchedHistoryTeams.has(key)) {
      const fetched = await fetchTeamHistory(match.home_team_id, TEAM_HISTORY_SIZE, sport);
      if (Array.isArray(fetched) && fetched.length) {
        fetchedHistoryTeams.add(key);
      }
    }
  }

  if (match.away_team_id) {
    const key = buildHistoryKey(sport, match.away_team_id);
    if (!fetchedHistoryTeams.has(key)) {
      const fetched = await fetchTeamHistory(match.away_team_id, TEAM_HISTORY_SIZE, sport);
      if (Array.isArray(fetched) && fetched.length) {
        fetchedHistoryTeams.add(key);
      }
    }
  }

  const db = getDb();

  let homeRecent = fetchRecentMatches(
    db,
    match.home_team,
    match.match_id,
    referenceDate,
    sport,
    TEAM_HISTORY_SIZE
  );
  if (homeRecent.length < 3 && match.home_team_id) {
    await fetchTeamHistory(match.home_team_id, TEAM_HISTORY_SIZE, sport);
    homeRecent = fetchRecentMatches(
      db,
      match.home_team,
      match.match_id,
      referenceDate,
      sport,
      TEAM_HISTORY_SIZE
    );
  }

  let awayRecent = fetchRecentMatches(
    db,
    match.away_team,
    match.match_id,
    referenceDate,
    sport,
    TEAM_HISTORY_SIZE
  );
  if (awayRecent.length < 3 && match.away_team_id) {
    await fetchTeamHistory(match.away_team_id, TEAM_HISTORY_SIZE, sport);
    awayRecent = fetchRecentMatches(
      db,
      match.away_team,
      match.match_id,
      referenceDate,
      sport,
      TEAM_HISTORY_SIZE
    );
  }

  let headToHead = fetchHeadToHead(
    db,
    match.home_team,
    match.away_team,
    match.match_id,
    referenceDate,
    sport,
    H2H_HISTORY_SIZE
  );
  if (headToHead.length < 3 && match.home_team_id && match.away_team_id) {
    await fetchHeadToHeadHistory(match.home_team_id, match.away_team_id, H2H_HISTORY_SIZE, sport);
    headToHead = fetchHeadToHead(
      db,
      match.home_team,
      match.away_team,
      match.match_id,
      referenceDate,
      sport,
      H2H_HISTORY_SIZE
    );
  }
}

function getMatchContext(match) {
  const db = getDb();
  const sport = match.sport ?? 'football';
  const referenceDate = match.date ?? null;

  const homeRecent = fetchRecentMatches(
    db,
    match.home_team,
    match.match_id,
    referenceDate,
    sport,
    TEAM_HISTORY_SIZE
  );
  const awayRecent = fetchRecentMatches(
    db,
    match.away_team,
    match.match_id,
    referenceDate,
    sport,
    TEAM_HISTORY_SIZE
  );
  const headToHead = fetchHeadToHead(
    db,
    match.home_team,
    match.away_team,
    match.match_id,
    referenceDate,
    sport,
    H2H_HISTORY_SIZE
  );

  return {
    sport,
    homeTeam: match.home_team ?? null,
    awayTeam: match.away_team ?? null,
    homeTeamRecent: homeRecent,
    awayTeamRecent: awayRecent,
    headToHead
  };
}

function fetchRecentMatches(db, teamName, excludeMatchId, beforeDate, sport, limit = TEAM_HISTORY_SIZE) {
  if (!teamName) return [];

  const stmt = db.prepare(
    `
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
  `
  );

  return stmt.all({
    team: teamName,
    exclude: excludeMatchId,
    beforeDate: beforeDate ?? null,
    sport,
    limit
  });
}

function fetchHeadToHead(db, homeTeam, awayTeam, excludeMatchId, beforeDate, sport, limit = H2H_HISTORY_SIZE) {
  if (!homeTeam || !awayTeam) return [];

  const stmt = db.prepare(
    `
    SELECT match_id, sport, date, home_team, away_team, home_goals, away_goals
    FROM matches
    WHERE match_id != @exclude
      AND COALESCE(sport, 'football') = @sport
      AND (
        (home_team = @home AND away_team = @away) OR
        (home_team = @away AND away_team = @home)
      )
      AND date IS NOT NULL
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      ${beforeDate ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `
  );

  return stmt.all({
    exclude: excludeMatchId,
    sport,
    home: homeTeam,
    away: awayTeam,
    beforeDate: beforeDate ?? null,
    limit
  });
}

function formatTeamHistory(rows, teamName, title, sport) {
  if (!rows || rows.length === 0) {
    return `${title}: Keine Daten verfuegbar.`;
  }

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

  return `${title} (Bilanz ${stats.wins}S-${stats.draws}U-${stats.losses}N, ${scoreLabel} ${stats.goalsFor}:${stats.goalsAgainst}):\n- ${lines.join(
    '\n- '
  )}`;
}

function formatHeadToHeadHistory(rows, title, sport) {
  if (!rows || rows.length === 0) {
    return `${title}: Keine direkten Duelle gefunden.`;
  }

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

  return `${title} (Bilanz ${stats.homeWins} Heimsiege / ${stats.awayWins} Auswaertssiege / ${stats.draws} Remis, ${scoreLabel}):\n- ${lines.join(
    '\n- '
  )}`;
}

function summarizeTeamHistory(rows, teamName) {
  const summary = {
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0
  };

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
  const summary = {
    homeWins: 0,
    awayWins: 0,
    draws: 0
  };

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

function normalizePrediction(payload, matchId) {
  if (!payload || typeof payload !== 'object') return null;

  const probs = payload.probabilities ?? {};
  const probHome = toNumber(probs.home);
  const probDraw = toNumber(probs.draw);
  const probAway = toNumber(probs.away);

  if (probHome === null || probDraw === null || probAway === null) {
    return null;
  }

  const total = probHome + probDraw + probAway;
  if (!total || total <= 0) return null;

  const normalized = {
    home: round(probHome / total),
    draw: round(probDraw / total),
    away: round(probAway / total)
  };

  const bettingAdvice = payload.betting_advice ?? {};
  const confidenceValue = toNumber(bettingAdvice.confidence);
  const safeConfidence = confidenceValue === null ? 0 : round(confidenceValue);

  return {
    match_id: payload.match_id ?? matchId,
    prediction: payload.prediction ?? 'Unentschieden',
    probabilities: normalized,
    explanation: payload.explanation ?? 'Keine Erklaerung vorhanden.',
    betting_advice: {
      recommendation: bettingAdvice.recommendation ?? 'Keine Empfehlung',
      confidence: safeConfidence,
      reasoning: bettingAdvice.reasoning ?? 'Keine Begruendung vorhanden.'
    }
  };
}

function simpleRulePredict(match, features) {
  const score =
    (features.home_form - features.away_form) +
    (features.home_goals_avg - features.away_goals_avg);

  const sport = match.sport ?? 'football';
  const meta = SPORT_PROMPT_META[sport] ?? SPORT_PROMPT_META.football;

  let prediction;
  let recommendation;
  let confidence;

  if (score > 0.3) {
    prediction = 'Heimsieg';
    recommendation = 'Heimsieg';
    confidence = Math.min(0.85, 0.5 + Math.abs(score));
  } else if (score < -0.3) {
    prediction = 'Auswaertssieg';
    recommendation = 'Auswaertssieg';
    confidence = Math.min(0.85, 0.5 + Math.abs(score));
  } else {
    prediction = meta.drawLabel;
    recommendation = sport === 'basketball' ? 'Spread meiden' : 'Unter 2.5 Tore';
    confidence = 0.6;
  }

  let probHome = clamp(0.1, 0.8, 0.5 + score + randomSpread(0.1));
  let probAway = clamp(0.1, 0.8, 0.5 - score + randomSpread(0.1));
  let probDraw = clamp(0.05, 0.6, 0.2 + randomSpread(0.1));

  const total = probHome + probAway + probDraw;
  probHome /= total;
  probAway /= total;
  probDraw /= total;

  return {
    match_id: match.match_id,
    prediction,
    probabilities: {
      home: round(probHome),
      draw: round(probDraw),
      away: round(probAway)
    },
    explanation: [
      `Regelbasiertes Modell Score=${round(score)}`,
      `Formdifferenz ${round(features.home_form - features.away_form)}`,
      `${meta.scoringLabel}-Differenz ${round(features.home_goals_avg - features.away_goals_avg)}`
    ].join(' | '),
    betting_advice: {
      recommendation,
      confidence: round(confidence),
      reasoning: `Basierend auf Form- und ${meta.scoringLabel}-Differenz der Teams.`
    },
    engine: 'rule-based'
  };
}

function buildHistoryKey(sport, teamId) {
  return `${sport}:${teamId}`;
}

function makeCandidateMatchIds(matchId) {
  const baseId = toNumber(matchId);
  if (baseId === null) return [];

  const candidates = new Set([baseId]);

  for (const offset of Object.values(SPORT_OFFSETS)) {
    if (!Number.isFinite(offset) || offset === 0) continue;
    candidates.add(baseId + offset);
    if (baseId >= offset) {
      candidates.add(baseId - offset);
    }
  }

  return [...candidates].filter((value) => Number.isFinite(value) && value >= 0);
}

function randomSpread(scale = 0.1) {
  return (Math.random() - 0.5) * scale * 2;
}

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function toNumber(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}
