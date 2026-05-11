import { getDb } from '../data/db.js';
import { fetchFootballTeamHistoryV2, fetchFootballHeadToHeadHistoryV2 } from '../api/footballHistoryV2.js';
import { predictTeamMatchup as predictWithGemma } from './matchupPredictor.js';

const TEAM_HISTORY_SIZE = Number(process.env.TEAM_HISTORY_SIZE) || 24;
const H2H_HISTORY_SIZE = Number(process.env.H2H_HISTORY_SIZE) || 10;
const MIN_MANUAL_SAMPLES_FOR_AI = Number(process.env.MIN_MANUAL_SAMPLES_FOR_AI) || 6;

export async function predictTeamMatchup(homeTeam, awayTeam) {
  const home = normalizeTeam(homeTeam);
  const away = normalizeTeam(awayTeam);
  if (!home?.id || !away?.id) return { error: 'Ungueltige Teams fuer manuelles Matchup' };

  await fetchFootballTeamHistoryV2(home.id, TEAM_HISTORY_SIZE, {});
  await fetchFootballTeamHistoryV2(away.id, TEAM_HISTORY_SIZE, {});
  await fetchFootballHeadToHeadHistoryV2(home.id, away.id, H2H_HISTORY_SIZE, {});

  const context = getContext(home.id, away.id);
  const diagnostics = {
    manualMatchup: true,
    totalGames: context.homeRecent.length + context.awayRecent.length,
    h2hCount: context.h2h.length,
    homeRecentCount: context.homeRecent.length,
    awayRecentCount: context.awayRecent.length,
    hasUsableSamples: context.homeRecent.length + context.awayRecent.length >= MIN_MANUAL_SAMPLES_FOR_AI,
    localQualityLabel: context.homeRecent.length + context.awayRecent.length >= 24 ? 'gut' : context.homeRecent.length + context.awayRecent.length >= 10 ? 'mittel' : 'schwach'
  };

  if (!diagnostics.hasUsableSamples) {
    return {
      match_id: 'manual-matchup',
      prediction: 'Keine Prognose',
      probabilities: { home: 0.34, draw: 0.33, away: 0.33 },
      explanation: 'Nicht genug historische Daten vorhanden. Gemma/Ollama wurde absichtlich nicht genutzt, damit keine Fantasie-Prognose entsteht.',
      betting_advice: {
        recommendation: 'Keine Wette',
        confidence: 0,
        reasoning: `Nur ${diagnostics.totalGames} historische Spiele gefunden. Mindestwert fuer AI: ${MIN_MANUAL_SAMPLES_FOR_AI}.`
      },
      engine: 'insufficient-data-guard',
      data_quality: { diagnostics, manual_matchup: true, ai_error: 'Skipped AI because historical samples are too low' },
      manual_matchup: { home, away }
    };
  }

  return predictWithGemma(home, away);
}

function getContext(homeId, awayId) {
  const db = getDb();
  return {
    homeRecent: recentForTeam(db, homeId, TEAM_HISTORY_SIZE),
    awayRecent: recentForTeam(db, awayId, TEAM_HISTORY_SIZE),
    h2h: h2h(db, homeId, awayId, H2H_HISTORY_SIZE)
  };
}

function recentForTeam(db, teamId, limit) {
  return db.prepare(`
    SELECT match_id, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
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
    SELECT match_id, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
    FROM matches
    WHERE COALESCE(sport, 'football') = 'football'
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
      AND ((home_team_id = @homeId AND away_team_id = @awayId) OR (home_team_id = @awayId AND away_team_id = @homeId))
    ORDER BY datetime(date) DESC
    LIMIT @limit
  `).all({ homeId, awayId, limit });
}

function normalizeTeam(team) {
  return team ? { id: Number(team.id), name: team.name ?? `Team ${team.id}`, country: team.country ?? null } : null;
}
