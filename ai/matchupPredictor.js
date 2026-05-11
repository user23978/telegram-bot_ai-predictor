import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import { fetchFootballTeamHistoryV2, fetchFootballHeadToHeadHistoryV2 } from '../api/footballHistoryV2.js';

dotenv.config();

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:27b';
const TEAM_HISTORY_SIZE = Number(process.env.TEAM_HISTORY_SIZE) || 24;
const H2H_HISTORY_SIZE = Number(process.env.H2H_HISTORY_SIZE) || 10;

export async function predictTeamMatchup(homeTeam, awayTeam) {
  const home = normalizeTeam(homeTeam);
  const away = normalizeTeam(awayTeam);
  if (!home?.id || !away?.id) return { error: 'Ungueltige Teams fuer manuelles Matchup' };

  await fetchFootballTeamHistoryV2(home.id, TEAM_HISTORY_SIZE, {});
  await fetchFootballTeamHistoryV2(away.id, TEAM_HISTORY_SIZE, {});
  await fetchFootballHeadToHeadHistoryV2(home.id, away.id, H2H_HISTORY_SIZE, {});

  const context = getManualContext(home, away);
  const features = buildManualFeatures(context);
  const diagnostics = buildDiagnostics(context, features);
  const prepared = { home, away, context, features, diagnostics };

  if (OLLAMA_MODEL) {
    const ai = await tryOllama(prepared);
    if (ai) return withMeta(ai, `ollama:${OLLAMA_MODEL}`, prepared);
  }

  return withMeta(rulePredict(prepared), 'rule-based-manual', prepared);
}

function getManualContext(home, away) {
  const db = getDb();
  return {
    homeTeamRecent: recentForTeam(db, home.id, TEAM_HISTORY_SIZE),
    awayTeamRecent: recentForTeam(db, away.id, TEAM_HISTORY_SIZE),
    headToHead: h2h(db, home.id, away.id, H2H_HISTORY_SIZE)
  };
}

function recentForTeam(db, teamId, limit) {
  return db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals, league_name, season
    FROM matches
    WHERE COALESCE(sport, 'football') = 'football'
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      AND (home_team_id = @teamId OR away_team_id = @teamId)
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `).all({ teamId, limit });
}

function h2h(db, homeId, awayId, limit) {
  return db.prepare(`
    SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals, league_name, season
    FROM matches
    WHERE COALESCE(sport, 'football') = 'football'
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      AND (
        (home_team_id = @homeId AND away_team_id = @awayId) OR
        (home_team_id = @awayId AND away_team_id = @homeId)
      )
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `).all({ homeId, awayId, limit });
}

function buildManualFeatures(context) {
  const home = summarize(context.homeTeamRecent, context.homeTeamId);
  const away = summarize(context.awayTeamRecent, context.awayTeamId);
  return {
    home_games: home.games,
    away_games: away.games,
    home_recent_form: home.form,
    away_recent_form: away.form,
    home_form: home.weightedForm,
    away_form: away.weightedForm,
    home_goals_avg: home.goalsForAvg,
    away_goals_avg: away.goalsForAvg,
    home_goals_against_avg: home.goalsAgainstAvg,
    away_goals_against_avg: away.goalsAgainstAvg,
    home_goal_diff_avg: home.goalDiffAvg,
    away_goal_diff_avg: away.goalDiffAvg,
    home_points_per_game: home.ppg,
    away_points_per_game: away.ppg,
    home_win_rate: home.winRate,
    away_win_rate: away.winRate,
    home_draw_rate: home.drawRate,
    away_draw_rate: away.drawRate,
    home_loss_rate: home.lossRate,
    away_loss_rate: away.lossRate
  };
}

function summarize(rows, fallbackTeamId) {
  const summary = { games: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0, weighted: 0, maxWeighted: 0, markers: [] };
  rows.forEach((row, index) => {
    const teamId = fallbackTeamId ?? (row.home_team_id || row.away_team_id);
    const isHome = Number(row.home_team_id) === Number(teamId);
    const gf = Number(isHome ? row.home_goals : row.away_goals);
    const ga = Number(isHome ? row.away_goals : row.home_goals);
    if (!Number.isFinite(gf) || !Number.isFinite(ga)) return;

    let points = 1;
    let marker = 'D';
    if (gf > ga) { points = 3; marker = 'W'; summary.wins += 1; }
    else if (gf < ga) { points = 0; marker = 'L'; summary.losses += 1; }
    else summary.draws += 1;

    summary.games += 1;
    summary.gf += gf;
    summary.ga += ga;
    summary.points += points;
    summary.markers.push(marker);
    const weight = rows.length - index;
    summary.weighted += points * weight;
    summary.maxWeighted += 3 * weight;
  });

  const g = summary.games || 1;
  return {
    games: summary.games,
    form: summary.markers.join(''),
    weightedForm: round(summary.maxWeighted ? summary.weighted / summary.maxWeighted : 0),
    goalsForAvg: round(summary.gf / g),
    goalsAgainstAvg: round(summary.ga / g),
    goalDiffAvg: round((summary.gf - summary.ga) / g),
    ppg: round(summary.points / g),
    winRate: round(summary.wins / g),
    drawRate: round(summary.draws / g),
    lossRate: round(summary.losses / g)
  };
}

function buildDiagnostics(context, features) {
  const totalGames = features.home_games + features.away_games;
  return {
    manualMatchup: true,
    localQualityLabel: totalGames >= 24 ? 'gut' : totalGames >= 10 ? 'mittel' : 'schwach',
    totalGames,
    h2hCount: context.headToHead.length,
    homeRecentCount: context.homeTeamRecent.length,
    awayRecentCount: context.awayTeamRecent.length,
    hasUsableSamples: totalGames >= 6,
    hasFeatureRow: totalGames > 0
  };
}

async function tryOllama(prepared) {
  try {
    const prompt = buildPrompt(prepared);
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

    const parsed = parsePayload(response.data);
    return normalizePrediction(parsed, prepared);
  } catch (error) {
    console.warn('manual-matchup ollama failed:', error?.message ?? error);
    return null;
  }
}

function buildPrompt(prepared) {
  const raw = {
    matchup: { home: prepared.home, away: prepared.away },
    features: prepared.features,
    diagnostics: prepared.diagnostics,
    history: {
      homeRecent: prepared.context.homeTeamRecent,
      awayRecent: prepared.context.awayTeamRecent,
      h2h: prepared.context.headToHead
    }
  };

  return [
    'Du bist ein vorsichtiger Fussball-Analyst. Dieses Match ist virtuell/manuell, weil keine kommende Fixture verfuegbar ist.',
    'Nutze nur die historischen Daten. Behaupte keine aktuellen Verletzungen, Quoten oder Aufstellungen.',
    'Wenn Samples schwach sind, confidence niedrig halten und keine starke Wette empfehlen.',
    'Antwort nur als JSON: match_id, prediction, probabilities {home, draw, away}, explanation, betting_advice {recommendation, confidence, reasoning}.',
    'match_id soll "manual-matchup" sein.',
    'RAW_DATA_JSON:',
    JSON.stringify(raw, null, 2)
  ].join('\n');
}

function normalizePrediction(payload, prepared) {
  if (!payload?.probabilities) return null;
  const probs = normalizeProbabilities(payload.probabilities);
  let confidence = prob(payload?.betting_advice?.confidence) ?? 0.35;
  if (!prepared.diagnostics.hasUsableSamples) confidence = Math.min(confidence, 0.45);
  if (prepared.diagnostics.localQualityLabel === 'schwach') confidence = Math.min(confidence, 0.55);
  const prediction = normalizeLabel(payload.prediction ?? pick(probs));
  return {
    match_id: 'manual-matchup',
    prediction,
    probabilities: probs,
    explanation: String(payload.explanation ?? 'Manuelle Prediction auf Basis historischer Teamdaten.').slice(0, 1200),
    betting_advice: {
      recommendation: confidence < 0.58 ? 'Keine klare Wette' : String(payload?.betting_advice?.recommendation ?? prediction),
      confidence: round(confidence),
      reasoning: String(payload?.betting_advice?.reasoning ?? 'Konservative Bewertung wegen manueller Fixture.').slice(0, 1200)
    }
  };
}

function rulePredict(prepared) {
  const f = prepared.features;
  const formEdge = (f.home_form - f.away_form) * 0.35;
  const ppgEdge = ((f.home_points_per_game - f.away_points_per_game) / 3) * 0.25;
  const diffEdge = clamp(-1, 1, (f.home_goal_diff_avg - f.away_goal_diff_avg) / 3) * 0.25;
  const attackEdge = clamp(-1, 1, (f.home_goals_avg - f.away_goals_avg) / 3) * 0.15;
  const edge = prepared.diagnostics.hasUsableSamples ? clamp(-0.85, 0.85, formEdge + ppgEdge + diffEdge + attackEdge + 0.04) : 0.02;
  const draw = clamp(0.14, 0.34, 0.28 - Math.abs(edge) * 0.18);
  const rest = 1 - draw;
  const homeShare = clamp(0.15, 0.85, 0.5 + edge / 1.65);
  const probs = normalizeProbabilities({ home: rest * homeShare, draw, away: rest * (1 - homeShare) });
  const prediction = pick(probs);
  const confidence = prepared.diagnostics.hasUsableSamples ? 0.52 : 0.4;
  return {
    match_id: 'manual-matchup',
    prediction,
    probabilities: probs,
    explanation: `Manuelles Matchup. Samples=${prepared.diagnostics.totalGames}, H2H=${prepared.diagnostics.h2hCount}, Daten=${prepared.diagnostics.localQualityLabel}.`,
    betting_advice: { recommendation: 'Keine klare Wette', confidence, reasoning: 'Manuelles Matchup ohne echte kommende Fixture, daher konservativ.' }
  };
}

function withMeta(result, engine, prepared) {
  return {
    ...result,
    engine,
    data_quality: { diagnostics: prepared.diagnostics, manual_matchup: true },
    manual_matchup: { home: prepared.home, away: prepared.away }
  };
}

function normalizeTeam(team) {
  if (!team) return null;
  return { id: Number(team.id), name: team.name ?? `Team ${team.id}`, country: team.country ?? null };
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

function extractJson(text) { const m = String(text ?? '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
function prob(v) { const n = Number(String(v ?? '').replace('%', '').trim()); return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null; }
function normalizeProbabilities(p) { const h = Math.max(0, prob(p.home) ?? 0); const d = Math.max(0, prob(p.draw) ?? 0); const a = Math.max(0, prob(p.away) ?? 0); const t = h + d + a; return t ? { home: round(h / t), draw: round(d / t), away: round(a / t) } : { home: 0.34, draw: 0.33, away: 0.33 }; }
function pick(p) { return [['Heimsieg', p.home], ['Unentschieden', p.draw], ['Auswaertssieg', p.away]].sort((a, b) => b[1] - a[1])[0][0]; }
function normalizeLabel(v) { const s = String(v ?? '').toLowerCase(); if (s.includes('heim') || s.includes('home') || s === '1') return 'Heimsieg'; if (s.includes('away') || s.includes('auswaert') || s.includes('auswärt') || s === '2') return 'Auswaertssieg'; return 'Unentschieden'; }
function clamp(min, max, v) { return Math.max(min, Math.min(max, Number(v))); }
function round(v) { return Math.round(Number(v) * 100) / 100; }
