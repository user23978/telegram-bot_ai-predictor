import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import { fetchMatchById, getRecentApiFetchLog } from '../api/apiHandler.js';
import { fetchFootballTeamHistoryV2, fetchFootballHeadToHeadHistoryV2 } from '../api/footballHistoryV2.js';
import { buildFootballContext, formatFootballContextForPrompt, getFootballContextDebug } from '../api/footballContext.js';
import { calculateFeatures } from '../features/featureEngine.js';

dotenv.config();

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:27b';
const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL ?? null;
const TEAM_HISTORY_SIZE = Number(process.env.TEAM_HISTORY_SIZE) || 16;
const H2H_HISTORY_SIZE = Number(process.env.H2H_HISTORY_SIZE) || 10;

export async function predictMatch(matchId) {
  const prepared = await prepare(matchId);
  if (prepared.error) return { error: prepared.error };

  const prompt = buildPrompt(prepared);

  if (LLAMA_SERVER_URL) {
    const result = await tryEngine('llama', () => callRemote(prompt), prepared);
    if (result) return result;
  }

  if (OLLAMA_MODEL) {
    const result = await tryEngine(`ollama:${OLLAMA_MODEL}`, () => callOllama(prompt), prepared);
    if (result) return result;
  }

  return withMeta(rulePredict(prepared), 'rule-based', prepared);
}

export async function getPredictionDebug(matchId) {
  const prepared = await prepare(matchId);
  if (prepared.error) return { error: prepared.error };

  return {
    match: prepared.match,
    features: prepared.features,
    diagnostics: prepared.diagnostics,
    localData: {
      homeRecentCount: prepared.context.homeTeamRecent.length,
      awayRecentCount: prepared.context.awayTeamRecent.length,
      h2hCount: prepared.context.headToHead.length,
      homeRecent: prepared.context.homeTeamRecent.slice(0, 5),
      awayRecent: prepared.context.awayTeamRecent.slice(0, 5),
      h2h: prepared.context.headToHead.slice(0, 5)
    },
    external: getFootballContextDebug(prepared.externalContext),
    recentApiFetches: getRecentApiFetchLog(10),
    ollama: { host: OLLAMA_HOST, model: OLLAMA_MODEL, enabled: Boolean(OLLAMA_MODEL) },
    llama: { enabled: Boolean(LLAMA_SERVER_URL) }
  };
}

async function prepare(matchId) {
  const numericId = toNumber(matchId);
  if (numericId === null) return { error: 'Ungueltige Match-ID' };

  let match = getMatch(numericId);
  if (!match) {
    await fetchMatchById(numericId);
    match = getMatch(numericId);
  }
  if (!match) return { error: 'Match nicht gefunden' };

  const hydration = await hydrateHistory(match);
  calculateFeatures({ matchId: match.match_id });

  const features = getFeatures(match.match_id, match.sport) ?? emptyFeatures(match.sport);
  const context = getContext(match);
  const diagnostics = diagnose(match, features, context, hydration);

  let externalContext;
  try {
    externalContext = match.sport === 'football'
      ? await buildFootballContext(match)
      : { available: false, reason: 'Nur Fussball-Zusatzdaten implementiert', quality: { score: 0, label: 'schwach', reason: 'unsupported_sport' } };
  } catch (error) {
    externalContext = { available: false, reason: error?.message ?? String(error), quality: { score: 0, label: 'schwach', reason: 'external_failed' } };
  }

  return { match, features, context, diagnostics, externalContext };
}

async function hydrateHistory(match) {
  const result = { teamFetches: [], h2hFetch: null };
  if (match.sport !== 'football') return result;

  const context = {
    leagueId: match.league_id,
    season: match.season,
    matchDate: match.date
  };

  if (match.home_team_id) {
    const rows = await fetchFootballTeamHistoryV2(match.home_team_id, TEAM_HISTORY_SIZE, context);
    result.teamFetches.push({ teamId: match.home_team_id, count: rows.length, type: 'home' });
  }
  if (match.away_team_id) {
    const rows = await fetchFootballTeamHistoryV2(match.away_team_id, TEAM_HISTORY_SIZE, context);
    result.teamFetches.push({ teamId: match.away_team_id, count: rows.length, type: 'away' });
  }
  if (match.home_team_id && match.away_team_id) {
    const rows = await fetchFootballHeadToHeadHistoryV2(match.home_team_id, match.away_team_id, H2H_HISTORY_SIZE, context);
    result.h2hFetch = { count: rows.length, source: 'local-from-team-history' };
  }

  return result;
}

function getMatch(matchId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT match_id, COALESCE(sport, 'football') AS sport, date, status,
           home_team, away_team, home_team_id, away_team_id,
           league_id, league_name, league_country, season, round
    FROM matches
    WHERE match_id = @id
  `);
  return stmt.get({ id: matchId }) ?? null;
}

function getFeatures(matchId, sportHint) {
  const db = getDb();
  const row = db.prepare(`
    SELECT s.*, COALESCE(s.sport, m.sport, @sportHint) AS resolved_sport
    FROM stats s
    LEFT JOIN matches m ON m.match_id = s.match_id
    WHERE s.match_id = @matchId
  `).get({ matchId, sportHint });
  return row ? normalizeFeatures(row, sportHint) : null;
}

function getContext(match) {
  const db = getDb();
  return {
    homeTeamRecent: recentForTeam(db, match, 'home'),
    awayTeamRecent: recentForTeam(db, match, 'away'),
    headToHead: h2h(db, match),
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    homeTeamId: match.home_team_id,
    awayTeamId: match.away_team_id
  };
}

function recentForTeam(db, match, side) {
  const id = side === 'home' ? match.home_team_id : match.away_team_id;
  if (!id) return [];
  return db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
    FROM matches
    WHERE COALESCE(sport, 'football') = @sport
      AND match_id != @matchId
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      AND (home_team_id = @teamId OR away_team_id = @teamId)
      ${match.date ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `).all({ sport: match.sport ?? 'football', matchId: match.match_id, teamId: id, beforeDate: match.date ?? null, limit: TEAM_HISTORY_SIZE });
}

function h2h(db, match) {
  if (!match.home_team_id || !match.away_team_id) return [];
  return db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
    FROM matches
    WHERE COALESCE(sport, 'football') = @sport
      AND match_id != @matchId
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      AND (
        (home_team_id = @homeId AND away_team_id = @awayId) OR
        (home_team_id = @awayId AND away_team_id = @homeId)
      )
      ${match.date ? 'AND datetime(date) < datetime(@beforeDate)' : ''}
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `).all({ sport: match.sport ?? 'football', matchId: match.match_id, homeId: match.home_team_id, awayId: match.away_team_id, beforeDate: match.date ?? null, limit: H2H_HISTORY_SIZE });
}

function diagnose(match, features, context, hydration) {
  const totalGames = (features.home_games ?? 0) + (features.away_games ?? 0);
  const hasUsableSamples = totalGames >= 4 || (context.homeTeamRecent.length >= 2 && context.awayTeamRecent.length >= 2);
  return {
    localQualityLabel: totalGames >= 12 ? 'gut' : totalGames >= 6 ? 'mittel' : 'schwach',
    totalGames,
    h2hCount: context.headToHead.length,
    homeRecentCount: context.homeTeamRecent.length,
    awayRecentCount: context.awayTeamRecent.length,
    hasUsableSamples,
    hasFeatureRow: totalGames > 0,
    missing: {
      homeTeamId: !match.home_team_id,
      awayTeamId: !match.away_team_id,
      league: !match.league_id,
      localSamples: !hasUsableSamples
    },
    hydration
  };
}

function buildPrompt(prepared) {
  const { match, features, context, diagnostics, externalContext } = prepared;
  const raw = {
    match,
    local_stats: { features, diagnostics },
    local_history: {
      homeRecent: context.homeTeamRecent,
      awayRecent: context.awayTeamRecent,
      h2h: context.headToHead
    },
    external: {
      available: Boolean(externalContext?.available),
      quality: externalContext?.quality ?? null,
      apiPrediction: externalContext?.apiPrediction ?? null,
      odds: externalContext?.odds ?? null,
      injuries: externalContext?.injuries ?? [],
      standings: externalContext?.standings ?? null,
      reason: externalContext?.reason ?? null
    }
  };

  return [
    'Du bist ein vorsichtiger Fussball-Analyst. Nutze nur diese Daten.',
    'Fehlende lokale Werte bedeuten NICHT, dass ein Team schlecht ist. Sie bedeuten nur fehlende Daten.',
    'Wenn local_stats.diagnostics.hasUsableSamples false ist, confidence maximal 0.45 und keine starke Wette.',
    'Antworte nur als JSON: match_id, prediction, probabilities {home, draw, away}, explanation, betting_advice {recommendation, confidence, reasoning}.',
    '',
    'RAW_DATA_JSON:',
    JSON.stringify(raw, null, 2),
    '',
    'EXTERNAL_SUMMARY:',
    formatFootballContextForPrompt(externalContext, context.homeTeam, context.awayTeam)
  ].join('\n');
}

async function tryEngine(engine, callFn, prepared) {
  try {
    const raw = await callFn();
    const parsed = parsePayload(raw);
    const normalized = normalizePrediction(parsed, prepared);
    return normalized ? withMeta(normalized, engine, prepared) : null;
  } catch (error) {
    console.warn(`${engine} fehlgeschlagen:`, error?.message ?? error);
    return null;
  }
}

async function callOllama(prompt) {
  const host = OLLAMA_HOST.replace(/\/$/, '');
  const response = await axios.post(`${host}/api/generate`, {
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
  }, { timeout: Number(process.env.OLLAMA_TIMEOUT_MS) || 90000 });
  return response.data;
}

async function callRemote(prompt) {
  const response = await axios.post(LLAMA_SERVER_URL, { prompt, maxTokens: 900, temperature: 0.08 }, { timeout: 30000 });
  return response.data;
}

function parsePayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return extractJson(raw);
  if (raw.prediction && raw.probabilities) return raw;
  for (const key of ['response', 'completion', 'output', 'text']) {
    if (typeof raw[key] === 'string') {
      const parsed = extractJson(raw[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function normalizePrediction(payload, prepared) {
  if (!payload?.probabilities) return null;
  const probs = normalizeProbabilities(payload.probabilities);
  let confidence = probability(payload?.betting_advice?.confidence) ?? 0.35;
  if (!prepared.diagnostics.hasUsableSamples) confidence = Math.min(confidence, 0.45);
  if (prepared.diagnostics.localQualityLabel === 'schwach') confidence = Math.min(confidence, 0.58);
  const prediction = normalizeLabel(payload.prediction ?? pick(probs));
  return {
    match_id: prepared.match.match_id,
    prediction,
    probabilities: probs,
    explanation: String(payload.explanation ?? 'Analyse auf Basis der verfuegbaren Daten.').slice(0, 1200),
    betting_advice: {
      recommendation: confidence < 0.58 ? 'Keine klare Wette' : String(payload?.betting_advice?.recommendation ?? prediction),
      confidence: round(confidence),
      reasoning: String(payload?.betting_advice?.reasoning ?? 'Konservative Bewertung wegen Datenlage.').slice(0, 1200)
    }
  };
}

function rulePredict(prepared) {
  const { match, features, context, diagnostics, externalContext } = prepared;
  const formEdge = (features.home_form - features.away_form) * 0.35;
  const ppgEdge = ((features.home_points_per_game - features.away_points_per_game) / 3) * 0.25;
  const diffEdge = clamp(-1, 1, (features.home_goal_diff_avg - features.away_goal_diff_avg) / 3) * 0.25;
  const homeAdv = 0.07;
  const apiEdge = apiPredictionEdge(externalContext, match.home_team, match.away_team) * 0.12;
  const edge = diagnostics.hasUsableSamples ? clamp(-0.85, 0.85, formEdge + ppgEdge + diffEdge + homeAdv + apiEdge) : homeAdv + apiEdge;
  const draw = clamp(0.14, 0.34, 0.28 - Math.abs(edge) * 0.18);
  const rest = 1 - draw;
  const homeShare = clamp(0.15, 0.85, 0.5 + edge / 1.65);
  const probs = normalizeProbabilities({ home: rest * homeShare, draw, away: rest * (1 - homeShare) });
  const prediction = pick(probs);
  const confidence = diagnostics.hasUsableSamples ? 0.55 : 0.42;
  return {
    match_id: match.match_id,
    prediction,
    probabilities: probs,
    explanation: `Regelbasiert. Samples=${diagnostics.totalGames}, H2H=${context.headToHead.length}, Daten=${diagnostics.localQualityLabel}.`,
    betting_advice: { recommendation: confidence < 0.58 ? 'Keine klare Wette' : prediction, confidence, reasoning: 'Fallback ohne valides LLM-JSON.' }
  };
}

function withMeta(result, engine, prepared) {
  return { ...result, engine, data_quality: { diagnostics: prepared.diagnostics, external: prepared.externalContext?.quality ?? null } };
}

function apiPredictionEdge(external, homeTeam, awayTeam) {
  const p = external?.apiPrediction;
  if (!p?.percent) return 0;
  let edge = (probability(p.percent.home) ?? 0) - (probability(p.percent.away) ?? 0);
  const winner = norm(p.winner);
  if (winner && winner === norm(homeTeam)) edge += 0.08;
  if (winner && winner === norm(awayTeam)) edge -= 0.08;
  return clamp(-1, 1, edge);
}

function normalizeFeatures(row, sport) {
  return {
    sport: row.resolved_sport ?? row.sport ?? sport,
    home_form: num(row.home_form), away_form: num(row.away_form),
    home_goals_avg: num(row.home_goals_avg), away_goals_avg: num(row.away_goals_avg),
    home_games: num(row.home_games), away_games: num(row.away_games),
    home_win_rate: num(row.home_win_rate), away_win_rate: num(row.away_win_rate),
    home_draw_rate: num(row.home_draw_rate), away_draw_rate: num(row.away_draw_rate),
    home_loss_rate: num(row.home_loss_rate), away_loss_rate: num(row.away_loss_rate),
    home_goals_against_avg: num(row.home_goals_against_avg), away_goals_against_avg: num(row.away_goals_against_avg),
    home_goal_diff_avg: num(row.home_goal_diff_avg), away_goal_diff_avg: num(row.away_goal_diff_avg),
    home_points_per_game: num(row.home_points_per_game), away_points_per_game: num(row.away_points_per_game),
    home_recent_form: row.home_recent_form ?? '', away_recent_form: row.away_recent_form ?? ''
  };
}

function emptyFeatures(sport) { return normalizeFeatures({ sport }, sport); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v) { return Math.round(Number(v) * 100) / 100; }
function clamp(min, max, v) { return Math.max(min, Math.min(max, Number(v))); }
function norm(v) { return String(v ?? '').trim().toLowerCase(); }
function probability(v) { const n = Number(String(v ?? '').replace('%', '').trim()); return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null; }
function normalizeProbabilities(p) { const h = Math.max(0, probability(p.home) ?? 0); const d = Math.max(0, probability(p.draw) ?? 0); const a = Math.max(0, probability(p.away) ?? 0); const t = h + d + a; return t ? { home: round(h / t), draw: round(d / t), away: round(a / t) } : { home: 0.34, draw: 0.33, away: 0.33 }; }
function pick(p) { return [['Heimsieg', p.home], ['Unentschieden', p.draw], ['Auswaertssieg', p.away]].sort((a, b) => b[1] - a[1])[0][0]; }
function normalizeLabel(v) { const s = norm(v); if (s.includes('heim') || s.includes('home') || s === '1') return 'Heimsieg'; if (s.includes('away') || s.includes('auswaert') || s.includes('auswärt') || s === '2') return 'Auswaertssieg'; return 'Unentschieden'; }
function extractJson(text) { const m = String(text ?? '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
