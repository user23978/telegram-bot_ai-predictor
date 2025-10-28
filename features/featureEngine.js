import { getDb } from '../data/db.js';

export function calculateFeatures() {
  const db = getDb();
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

  if (!matches.length) {
    return [];
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO stats
      (match_id, sport, home_form, away_form, home_goals_avg, away_goals_avg)
    VALUES
      (@match_id, @sport, @home_form, @away_form, @home_goals_avg, @away_goals_avg)
  `);

  const rows = [];

  const matchesBySport = matches.reduce((acc, match) => {
    const sport = match.sport ?? 'football';
    if (!acc[sport]) acc[sport] = [];
    acc[sport].push(match);
    return acc;
  }, {});

  for (const [sport, sportMatches] of Object.entries(matchesBySport)) {
    for (const match of sportMatches) {
      const homeStats = calcTeamStats(sportMatches, match.home_team, match.date);
      const awayStats = calcTeamStats(sportMatches, match.away_team, match.date);

      rows.push({
        match_id: match.match_id,
        sport,
        home_form: homeStats.form,
        away_form: awayStats.form,
        home_goals_avg: homeStats.avgGoalsFor,
        away_goals_avg: awayStats.avgGoalsFor
      });
    }
  }

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insert.run(item);
    }
  });

  insertMany(rows);
  return rows;
}

function calcTeamStats(matches, teamName, currentDateStr, windowSize = 10) {
  if (!teamName) {
    return {
      form: 0,
      avgGoalsFor: 0
    };
  }

  const currentDate = currentDateStr ? toDate(currentDateStr) : null;
  const cutoff = currentDate ? shiftDate(currentDate, -365) : null;

  const relevant = matches
    .filter((match) => {
      if (!match.date) return false;
      const date = toDate(match.date);
      if (!date) return false;
      const isTeam = match.home_team === teamName || match.away_team === teamName;
      const beforeCurrent = currentDate ? date < currentDate : true;
      const afterCutoff = cutoff ? date >= cutoff : true;
      return isTeam && beforeCurrent && afterCutoff;
    })
    .sort((a, b) => {
      const da = toDate(a.date)?.getTime() ?? 0;
      const db = toDate(b.date)?.getTime() ?? 0;
      return da - db;
    })
    .slice(-windowSize);

  if (!relevant.length) {
    return {
      form: 0,
      avgGoalsFor: 0
    };
  }

  let wins = 0;
  let gamesCount = 0;
  let goalsForTotal = 0;

  for (const match of relevant) {
    const homeGoals = toNumber(match.home_goals);
    const awayGoals = toNumber(match.away_goals);
    if (homeGoals === null || awayGoals === null) {
      continue;
    }

    gamesCount += 1;

    if (match.home_team === teamName) {
      goalsForTotal += homeGoals;
      if (homeGoals > awayGoals) wins += 1;
    } else {
      goalsForTotal += awayGoals;
      if (awayGoals > homeGoals) wins += 1;
    }
  }

  const denominator = Math.max(gamesCount, 1);
  const form = wins / denominator;
  const avgGoalsFor = gamesCount ? goalsForTotal / gamesCount : 0;

  return {
    form: Number.isFinite(form) ? form : 0,
    avgGoalsFor: Number.isFinite(avgGoalsFor) ? round(avgGoalsFor) : 0
  };
}

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value) {
  return typeof value === 'number'
    ? value
    : value === null || value === undefined
      ? null
      : Number.isNaN(Number(value)) ? null : Number(value);
}

function shiftDate(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

