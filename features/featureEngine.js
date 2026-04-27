import { getDb } from '../data/db.js';

const DEFAULT_WINDOW_SIZE = 10;
const LOOKBACK_DAYS = 730;

export function calculateFeatures(options = {}) {
  const db = getDb();
  const targetMatchId = resolveTargetMatchId(options);

  const matches = db
    .prepare(`
      SELECT
        match_id,
        COALESCE(sport, 'football') AS sport,
        date,
        home_team,
        away_team,
        home_goals,
        away_goals
      FROM matches
      ORDER BY datetime(date) ASC
    `)
    .all();

  if (!matches.length) return [];

  const insert = db.prepare(`
    INSERT OR REPLACE INTO stats
      (
        match_id,
        sport,
        home_form,
        away_form,
        home_goals_avg,
        away_goals_avg,
        home_games,
        away_games,
        home_win_rate,
        away_win_rate,
        home_draw_rate,
        away_draw_rate,
        home_loss_rate,
        away_loss_rate,
        home_goals_against_avg,
        away_goals_against_avg,
        home_goal_diff_avg,
        away_goal_diff_avg,
        home_points_per_game,
        away_points_per_game,
        home_recent_form,
        away_recent_form
      )
    VALUES
      (
        @match_id,
        @sport,
        @home_form,
        @away_form,
        @home_goals_avg,
        @away_goals_avg,
        @home_games,
        @away_games,
        @home_win_rate,
        @away_win_rate,
        @home_draw_rate,
        @away_draw_rate,
        @home_loss_rate,
        @away_loss_rate,
        @home_goals_against_avg,
        @away_goals_against_avg,
        @home_goal_diff_avg,
        @away_goal_diff_avg,
        @home_points_per_game,
        @away_points_per_game,
        @home_recent_form,
        @away_recent_form
      )
  `);

  const matchesBySport = matches.reduce((acc, match) => {
    const sport = match.sport ?? 'football';
    if (!acc[sport]) acc[sport] = [];
    acc[sport].push(match);
    return acc;
  }, {});

  const rows = [];

  for (const [sport, sportMatches] of Object.entries(matchesBySport)) {
    const targetMatches = targetMatchId === null
      ? sportMatches
      : sportMatches.filter((match) => match.match_id === targetMatchId);

    for (const match of targetMatches) {
      const homeStats = calcTeamStats(sportMatches, match, match.home_team);
      const awayStats = calcTeamStats(sportMatches, match, match.away_team);

      rows.push({
        match_id: match.match_id,
        sport,
        home_form: homeStats.form,
        away_form: awayStats.form,
        home_goals_avg: homeStats.avgGoalsFor,
        away_goals_avg: awayStats.avgGoalsFor,
        home_games: homeStats.games,
        away_games: awayStats.games,
        home_win_rate: homeStats.winRate,
        away_win_rate: awayStats.winRate,
        home_draw_rate: homeStats.drawRate,
        away_draw_rate: awayStats.drawRate,
        home_loss_rate: homeStats.lossRate,
        away_loss_rate: awayStats.lossRate,
        home_goals_against_avg: homeStats.avgGoalsAgainst,
        away_goals_against_avg: awayStats.avgGoalsAgainst,
        home_goal_diff_avg: homeStats.avgGoalDiff,
        away_goal_diff_avg: awayStats.avgGoalDiff,
        home_points_per_game: homeStats.pointsPerGame,
        away_points_per_game: awayStats.pointsPerGame,
        home_recent_form: homeStats.recentForm,
        away_recent_form: awayStats.recentForm
      });
    }
  }

  if (!rows.length) return [];

  const insertMany = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });

  insertMany(rows);
  return rows;
}

function calcTeamStats(matches, currentMatch, teamName, windowSize = DEFAULT_WINDOW_SIZE) {
  const empty = {
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    form: 0,
    winRate: 0,
    drawRate: 0,
    lossRate: 0,
    avgGoalsFor: 0,
    avgGoalsAgainst: 0,
    avgGoalDiff: 0,
    pointsPerGame: 0,
    recentForm: ''
  };

  if (!teamName) return empty;

  const currentDate = currentMatch.date ? toDate(currentMatch.date) : null;
  const cutoff = currentDate ? shiftDate(currentDate, -LOOKBACK_DAYS) : null;

  const relevant = matches
    .filter((match) => {
      if (match.match_id === currentMatch.match_id) return false;
      if (!match.date) return false;
      if (!isCompleted(match)) return false;

      const date = toDate(match.date);
      if (!date) return false;

      const isTeam = match.home_team === teamName || match.away_team === teamName;
      const beforeCurrent = currentDate ? date < currentDate : true;
      const afterCutoff = cutoff ? date >= cutoff : true;
      return isTeam && beforeCurrent && afterCutoff;
    })
    .sort((a, b) => (toDate(b.date)?.getTime() ?? 0) - (toDate(a.date)?.getTime() ?? 0))
    .slice(0, windowSize);

  if (!relevant.length) return empty;

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsForTotal = 0;
  let goalsAgainstTotal = 0;
  let pointsTotal = 0;
  let weightedPoints = 0;
  let maxWeightedPoints = 0;
  const formMarkers = [];

  relevant.forEach((match, index) => {
    const isHome = match.home_team === teamName;
    const goalsFor = toNumber(isHome ? match.home_goals : match.away_goals);
    const goalsAgainst = toNumber(isHome ? match.away_goals : match.home_goals);
    if (goalsFor === null || goalsAgainst === null) return;

    let marker = 'D';
    let points = 1;
    if (goalsFor > goalsAgainst) {
      wins += 1;
      points = 3;
      marker = 'W';
    } else if (goalsFor < goalsAgainst) {
      losses += 1;
      points = 0;
      marker = 'L';
    } else {
      draws += 1;
    }

    goalsForTotal += goalsFor;
    goalsAgainstTotal += goalsAgainst;
    pointsTotal += points;
    formMarkers.push(marker);

    const weight = relevant.length - index;
    weightedPoints += points * weight;
    maxWeightedPoints += 3 * weight;
  });

  const games = wins + draws + losses;
  if (!games) return empty;

  const pointsPerGame = pointsTotal / games;
  const form = maxWeightedPoints > 0 ? weightedPoints / maxWeightedPoints : pointsPerGame / 3;

  return {
    games,
    wins,
    draws,
    losses,
    form: round(clamp(0, 1, form)),
    winRate: round(wins / games),
    drawRate: round(draws / games),
    lossRate: round(losses / games),
    avgGoalsFor: round(goalsForTotal / games),
    avgGoalsAgainst: round(goalsAgainstTotal / games),
    avgGoalDiff: round((goalsForTotal - goalsAgainstTotal) / games),
    pointsPerGame: round(pointsPerGame),
    recentForm: formMarkers.join('')
  };
}

function resolveTargetMatchId(options) {
  if (typeof options === 'number' || typeof options === 'string') return toNumber(options);
  if (!options || typeof options !== 'object') return null;
  return toNumber(options.matchId ?? options.targetMatchId ?? null);
}

function isCompleted(match) {
  return toNumber(match.home_goals) !== null && toNumber(match.away_goals) !== null;
}

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shiftDate(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
