import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';

dotenv.config();

const FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io/fixtures';
const BASKETBALL_BASE_URL = 'https://v1.basketball.api-sports.io/games';
const DEFAULT_TIMEZONE = process.env.API_TIMEZONE ?? 'Europe/Berlin';

const MATCH_ID_OFFSETS = {
  football: 0,
  basketball: 5_000_000_000
};

const LIVE_STATUS_CODES = {
  football: ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'],
  basketball: ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'LIVE']
};

const UPCOMING_STATUS_CODES = {
  football: ['NS', 'TBD', 'TBA', 'PST', 'SUSP', 'CANC', 'INT', 'POST'],
  basketball: ['NS', 'Not Started', 'Scheduled', 'TBD', 'PST', 'SUSP']
};

export async function fetchMatches(options = {}) {
  const { sport = 'football', mode = 'live', limit = 20, range } = options;
  if (sport === 'basketball') {
    return fetchBasketballMatches({ mode, limit, range });
  }
  return fetchFootballMatches({ mode, limit, range });
}

export function loadMatchesFromDb(mode, limit = 20, range, sport = 'football') {
  const db = getDb();
  const currentSport = sport ?? 'football';

  if (mode === 'live') {
    const statuses = LIVE_STATUS_CODES[currentSport] ?? LIVE_STATUS_CODES.football;
    const placeholders = statuses
      .map((_, index) => `@status${index}`)
      .join(', ');
    const stmt = db.prepare(`
      SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals
      FROM matches
      WHERE sport = @sport
        AND status IN (${placeholders})
      ORDER BY datetime(COALESCE(date, CURRENT_TIMESTAMP)) DESC
      LIMIT @limit
    `);
    const params = { sport: currentSport, limit };
    statuses.forEach((value, index) => {
      params[`status${index}`] = value;
    });
    return stmt.all(params);
  }

  const statuses = UPCOMING_STATUS_CODES[currentSport] ?? UPCOMING_STATUS_CODES.football;
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const placeholders = statuses
    .map((_, index) => `@status${index}`)
    .join(', ');

  if (range === 'today') {
    const stmt = db.prepare(`
      SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals
      FROM matches
      WHERE sport = @sport
        AND date IS NOT NULL
        AND date(date) = date(@today)
      ORDER BY datetime(date) ASC
      LIMIT @limit
    `);
    return stmt.all({ sport: currentSport, today, limit });
  }

  const stmt = db.prepare(`
    SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals
    FROM matches
    WHERE sport = @sport
      AND (
        status IN (${placeholders}) OR
        (date IS NOT NULL AND datetime(date) >= datetime(@nowIso))
      )
    ORDER BY datetime(date) ASC
    LIMIT @limit
  `);
  const params = { sport: currentSport, limit, nowIso };
  statuses.forEach((value, index) => {
    params[`status${index}`] = value;
  });
  return stmt.all(params);
}

export async function fetchTeamHistory(teamId, last = 5, sport = 'football') {
  if (!teamId) return [];
  if (sport === 'basketball') {
    return fetchBasketballTeamHistory(teamId, last);
  }
  return fetchFootballTeamHistory(teamId, last);
}

export async function fetchHeadToHeadHistory(teamAId, teamBId, last = 10, sport = 'football') {
  if (!teamAId || !teamBId) return [];
  if (sport === 'basketball') {
    return fetchBasketballHeadToHead(teamAId, teamBId, last);
  }
  return fetchFootballHeadToHead(teamAId, teamBId, last);
}

async function fetchFootballMatches({ mode, limit, range }) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error('API_FOOTBALL_KEY not set in environment (.env)');
  }

  const url = buildFootballEndpoint(mode, limit, range);
  try {
    const response = await axios.get(url, {
      headers: {
        'x-apisports-key': apiKey,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      },
      timeout: 15000
    });

    if (response.status !== 200) {
      throw new Error(`Fehler beim Abrufen der Daten: HTTP ${response.status}`);
    }

    const payload = response.data ?? {};
    let matches = Array.isArray(payload.response) ? payload.response : [];

    if (!matches.length && mode === 'upcoming') {
      matches = await fetchFootballUpcomingFallback(apiKey, limit, range);
    }

    saveMatches(matches, 'football');
    return matches;
  } catch (error) {
    const message = error?.message ?? String(error);
    console.error(`API Abruf fehlgeschlagen (football/${mode}):`, message);
    return [];
  }
}

async function fetchBasketballMatches({ mode, limit, range }) {
  const apiKey = process.env.API_BASKETBALL_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error('API_BASKETBALL_KEY not set in environment (.env)');
  }

  const url = buildBasketballEndpoint(mode, limit, range);
  try {
    const response = await axios.get(url, {
      headers: {
        'x-apisports-key': apiKey,
        'x-rapidapi-host': 'v1.basketball.api-sports.io'
      },
      timeout: 15000
    });

    if (response.status !== 200) {
      throw new Error(`Fehler beim Abrufen der Daten: HTTP ${response.status}`);
    }

    const payload = response.data ?? {};
    const matches = Array.isArray(payload.response) ? payload.response : [];
    saveMatches(matches, 'basketball');
    return matches;
  } catch (error) {
    const message = error?.message ?? String(error);
    console.error(`API Abruf fehlgeschlagen (basketball/${mode}):`, message);
    return [];
  }
}

async function fetchFootballTeamHistory(teamId, last) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error('API_FOOTBALL_KEY not set in environment (.env)');
  }

  const params = new URLSearchParams({
    team: String(teamId),
    last: String(last),
    timezone: DEFAULT_TIMEZONE
  });

  try {
    const response = await axios.get(`${FOOTBALL_BASE_URL}?${params.toString()}`, {
      headers: { 'x-apisports-key': apiKey },
      timeout: 15000
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = response.data ?? {};
    const matches = Array.isArray(payload.response) ? payload.response : [];
    saveMatches(matches, 'football');
    return matches;
  } catch (error) {
    const message = error?.message ?? String(error);
    console.warn(`Historie fuer Fussball-Team ${teamId} fehlgeschlagen:`, message);
    return [];
  }
}

async function fetchBasketballTeamHistory(teamId, last) {
  const apiKey = process.env.API_BASKETBALL_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error('API_BASKETBALL_KEY not set in environment (.env)');
  }

  const params = new URLSearchParams({
    team: String(teamId),
    last: String(last),
    timezone: DEFAULT_TIMEZONE
  });

  const season = resolveBasketballSeason();
  if (season) {
    params.set('season', season);
  }

  try {
    const response = await axios.get(`${BASKETBALL_BASE_URL}?${params.toString()}`, {
      headers: { 'x-apisports-key': apiKey },
      timeout: 15000
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = response.data ?? {};
    const matches = Array.isArray(payload.response) ? payload.response : [];
    saveMatches(matches, 'basketball');
    return matches;
  } catch (error) {
    const message = error?.message ?? String(error);
    console.warn(`Historie fuer Basketball-Team ${teamId} fehlgeschlagen:`, message);
    return [];
  }
}

async function fetchFootballHeadToHead(teamAId, teamBId, last) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error('API_FOOTBALL_KEY not set in environment (.env)');
  }

  const params = new URLSearchParams({
    h2h: `${teamAId}-${teamBId}`,
    last: String(last),
    timezone: DEFAULT_TIMEZONE
  });

  try {
    const response = await axios.get(`${FOOTBALL_BASE_URL}/headtohead?${params.toString()}`, {
      headers: {
        'x-apisports-key': apiKey,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      },
      timeout: 15000
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = response.data ?? {};
    const matches = Array.isArray(payload.response) ? payload.response : [];
    saveMatches(matches, 'football');
    return matches;
  } catch (error) {
    const message = error?.message ?? String(error);
    console.warn(`Head-to-head Fussball ${teamAId} vs ${teamBId} fehlgeschlagen:`, message);
    return [];
  }
}

async function fetchBasketballHeadToHead(teamAId, teamBId, last) {
  const apiKey = process.env.API_BASKETBALL_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error('API_BASKETBALL_KEY not set in environment (.env)');
  }

  const params = new URLSearchParams({
    h2h: `${teamAId}-${teamBId}`,
    last: String(last),
    timezone: DEFAULT_TIMEZONE
  });

  const season = resolveBasketballSeason();
  if (season) {
    params.set('season', season);
  }

  try {
    const response = await axios.get(`${BASKETBALL_BASE_URL}?${params.toString()}`, {
      headers: {
        'x-apisports-key': apiKey,
        'x-rapidapi-host': 'v1.basketball.api-sports.io'
      },
      timeout: 15000
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = response.data ?? {};
    const matches = Array.isArray(payload.response) ? payload.response : [];
    saveMatches(matches, 'basketball');
    return matches;
  } catch (error) {
    const message = error?.message ?? String(error);
    console.warn(`Head-to-head Basketball ${teamAId} vs ${teamBId} fehlgeschlagen:`, message);
    return [];
  }
}

function buildFootballEndpoint(mode, limit, range) {
  const params = new URLSearchParams({
    timezone: DEFAULT_TIMEZONE
  });

  if (mode === 'upcoming') {
    if (range === 'today') {
      params.set('date', formatDateOffset(0));
    } else {
      params.set('next', String(limit));
    }
  } else if (mode === 'live') {
    params.set('live', 'all');
  } else if (mode.startsWith('http')) {
    return mode;
  } else {
    const customParams = new URLSearchParams(mode);
    customParams.set('timezone', DEFAULT_TIMEZONE);
    return `${FOOTBALL_BASE_URL}?${customParams.toString()}`;
  }

  return `${FOOTBALL_BASE_URL}?${params.toString()}`;
}

function buildBasketballEndpoint(mode, limit, range) {
  const params = new URLSearchParams({
    timezone: DEFAULT_TIMEZONE
  });

  const season = resolveBasketballSeason();
  if (season) {
    params.set('season', season);
  }

  if (mode === 'upcoming') {
    if (range === 'today') {
      params.set('date', formatDateOffset(0));
    } else {
      params.set('next', String(limit));
    }
  } else if (mode === 'live') {
    params.set('live', 'all');
  }

  return `${BASKETBALL_BASE_URL}?${params.toString()}`;
}

async function fetchFootballUpcomingFallback(apiKey, limit, range) {
  const results = [];
  if (range === 'today') {
    const params = new URLSearchParams({
      timezone: DEFAULT_TIMEZONE,
      date: formatDateOffset(0)
    });
    try {
      const response = await axios.get(`${FOOTBALL_BASE_URL}?${params.toString()}`, {
        headers: { 'x-apisports-key': apiKey },
        timeout: 15000
      });
      if (response.status !== 200) return results;
      const payload = response.data ?? {};
      const matches = Array.isArray(payload.response) ? payload.response : [];
      results.push(...matches.slice(0, limit));
    } catch (error) {
      const message = error?.message ?? String(error);
      console.warn(`Upcoming-Fallback (today) fehlgeschlagen:`, message);
    }
    return results;
  }

  const daysToCheck = Math.min(Math.max(limit, 1), 7);

  for (let offset = 0; offset < daysToCheck && results.length < limit; offset += 1) {
    const date = formatDateOffset(offset);
    const params = new URLSearchParams({
      timezone: DEFAULT_TIMEZONE,
      date
    });

    try {
      const response = await axios.get(`${FOOTBALL_BASE_URL}?${params.toString()}`, {
        headers: { 'x-apisports-key': apiKey },
        timeout: 15000
      });

      if (response.status !== 200) continue;
      const payload = response.data ?? {};
      const matches = Array.isArray(payload.response) ? payload.response : [];
      for (const match of matches) {
        results.push(match);
        if (results.length >= limit) break;
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      console.warn(`Upcoming-Fallback (${date}) fehlgeschlagen:`, message);
    }
  }

  return results;
}

function saveMatches(matches, sport) {
  if (!Array.isArray(matches) || !matches.length) return;

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO matches
      (match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals)
    VALUES
      (@match_id, @sport, @date, @status, @home_team_id, @away_team_id, @home_team, @away_team, @home_goals, @away_goals)
  `);

  const mapRow =
    sport === 'basketball'
      ? mapBasketballMatch
      : mapFootballMatch;

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      if (!row.match_id) continue;
      insert.run({ ...row, sport });
    }
  });

  insertMany(matches.map(mapRow));
}

function mapFootballMatch(match) {
  const fixture = match?.fixture ?? {};
  const teams = match?.teams ?? {};
  const goals = match?.goals ?? {};
  const homeTeam = teams.home ?? {};
  const awayTeam = teams.away ?? {};
  const status = fixture.status ?? {};
  const matchId = composeMatchId(fixture.id ?? match?.id ?? match?.match_id, 'football');

  const isoDate = extractIsoDateFootball(fixture, match);

  return {
    match_id: matchId,
    date: isoDate,
    status: status.short ?? status.long ?? null,
    home_team_id: homeTeam.id ?? null,
    away_team_id: awayTeam.id ?? null,
    home_team: homeTeam.name ?? null,
    away_team: awayTeam.name ?? null,
    home_goals: isNumber(goals.home) ? goals.home : null,
    away_goals: isNumber(goals.away) ? goals.away : null
  };
}

function mapBasketballMatch(match) {
  const teams = match?.teams ?? {};
  const homeTeam = teams.home ?? {};
  const awayTeam = teams.away ?? {};
  const rawStatus = match?.status ?? {};
  const status =
    typeof rawStatus === 'object'
      ? rawStatus
      : { short: rawStatus, long: rawStatus };
  const scores = match?.scores ?? {};
  const homeScore = scores?.home?.total ?? scores?.home?.points ?? null;
  const awayScore = scores?.away?.total ?? scores?.away?.points ?? null;
  const matchId = composeMatchId(match?.id ?? match?.game_id ?? match?.match_id, 'basketball');

  const isoDate = extractIsoDateBasketball(match);

  return {
    match_id: matchId,
    date: isoDate,
    status: status.short ?? status.long ?? null,
    home_team_id: homeTeam.id ?? null,
    away_team_id: awayTeam.id ?? null,
    home_team: homeTeam.name ?? null,
    away_team: awayTeam.name ?? null,
    home_goals: isNumber(homeScore) ? homeScore : null,
    away_goals: isNumber(awayScore) ? awayScore : null
  };
}

function extractIsoDateFootball(fixture, fallback) {
  if (fixture?.date) return fixture.date;
  if (typeof fixture?.timestamp === 'number') {
    return new Date(fixture.timestamp * 1000).toISOString();
  }
  if (fallback?.date) return fallback.date;
  return null;
}

function extractIsoDateBasketball(game) {
  if (!game) return null;
  if (game.date) {
    if (typeof game.date === 'string' && game.date.includes('T')) {
      return game.date;
    }
    if (typeof game.date === 'string' && game.time) {
      return `${game.date}T${game.time}+00:00`;
    }
    if (typeof game.date === 'string') {
      return new Date(`${game.date} ${game.time ?? '00:00'}`).toISOString();
    }
  }

  if (typeof game.timestamp === 'number') {
    return new Date(game.timestamp * 1000).toISOString();
  }

  if (game.time?.datetime) {
    return game.time.datetime;
  }

  return null;
}

function resolveBasketballSeason() {
  if (process.env.API_BASKETBALL_SEASON) {
    return process.env.API_BASKETBALL_SEASON;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (month >= 7) {
    return `${year}-${year + 1}`;
  }
  return `${year - 1}-${year}`;
}

function formatDateOffset(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function composeMatchId(rawId, sport) {
  const numeric = Number(rawId);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const offset = MATCH_ID_OFFSETS[sport] ?? 0;
  return offset + numeric;
}

function isNumber(value) {
  return typeof value === 'number' && !Number.isNaN(value);
}
