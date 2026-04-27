import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';

dotenv.config();

const FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io/fixtures';
const BASKETBALL_BASE_URL = 'https://v1.basketball.api-sports.io/games';
const DEFAULT_TIMEZONE = process.env.API_TIMEZONE ?? 'Europe/Berlin';
const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS) || 15000;

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
  if (sport === 'basketball') return fetchBasketballMatches({ mode, limit, range });
  return fetchFootballMatches({ mode, limit, range });
}

export function loadMatchesFromDb(mode, limit = 20, range, sport = 'football') {
  const db = getDb();
  const currentSport = sport ?? 'football';

  if (mode === 'live') {
    const statuses = LIVE_STATUS_CODES[currentSport] ?? LIVE_STATUS_CODES.football;
    const placeholders = statuses.map((_, index) => `@status${index}`).join(', ');
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
  const today = formatDateOffset(0);
  const placeholders = statuses.map((_, index) => `@status${index}`).join(', ');

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
        (date IS NOT NULL AND date(date) > date(@today)) OR
        (date IS NULL AND status IN (${placeholders}))
      )
    ORDER BY datetime(COALESCE(date, CURRENT_TIMESTAMP)) ASC
    LIMIT @limit
  `);
  const params = { sport: currentSport, limit, today };
  statuses.forEach((value, index) => {
    params[`status${index}`] = value;
  });
  return stmt.all(params);
}

export async function fetchMatchById(matchId, sportHint = 'football') {
  const { sport, rawId } = splitStoredMatchId(matchId, sportHint);
  if (!rawId) return null;

  if (sport === 'basketball') {
    const apiKey = getBasketballApiKey();
    const params = new URLSearchParams({ id: String(rawId), timezone: DEFAULT_TIMEZONE });
    const matches = await safeRequest(
      () => requestBasketballGames(params, apiKey, `basketball/id-${rawId}`),
      `Basketball-Spiel ${rawId}`
    );
    if (matches.length) saveMatches(matches, 'basketball');
    return matches[0] ?? null;
  }

  const apiKey = getFootballApiKey();
  const params = new URLSearchParams({ id: String(rawId), timezone: DEFAULT_TIMEZONE });
  const matches = await safeRequest(
    () => requestFootballFixtures(params, apiKey, `football/id-${rawId}`),
    `Fussball-Spiel ${rawId}`
  );
  if (matches.length) saveMatches(matches, 'football');
  return matches[0] ?? null;
}

export async function fetchTeamHistory(teamId, last = 12, sport = 'football') {
  if (!teamId) return [];
  if (sport === 'basketball') return fetchBasketballTeamHistory(teamId, last);
  return fetchFootballTeamHistory(teamId, last);
}

export async function fetchHeadToHeadHistory(teamAId, teamBId, last = 10, sport = 'football') {
  if (!teamAId || !teamBId) return [];
  if (sport === 'basketball') return fetchBasketballHeadToHead(teamAId, teamBId, last);
  return fetchFootballHeadToHead(teamAId, teamBId, last);
}

async function fetchFootballMatches({ mode, limit, range }) {
  const apiKey = getFootballApiKey();
  const pageSize = Math.max(Number(limit) || 20, 1);
  const params = buildFootballParams(mode, pageSize, range);

  const matches = await safeRequest(
    () => requestFootballFixtures(params, apiKey, `football/${mode}${range ? `/${range}` : ''}`),
    `Fussball-${mode}`
  );

  let filtered = filterFootballMatches(matches, mode, range).slice(0, pageSize);
  if (!filtered.length && mode === 'upcoming') {
    filtered = await fetchFootballUpcomingFallback(apiKey, pageSize, range);
  }

  if (filtered.length) saveMatches(filtered, 'football');
  return filtered;
}

async function fetchBasketballMatches({ mode, limit, range }) {
  const apiKey = getBasketballApiKey();
  const leagues = parseBasketballLeagues();
  const leagueList = leagues.length ? leagues : [null];
  const pageSize = Math.max(Number(limit) || 10, 10);
  const targetSize = Math.max(pageSize + 5, 20);
  const collected = new Map();

  const addMatches = (matches) => {
    for (const match of matches) {
      const rawId = match?.id ?? match?.game_id ?? match?.match_id;
      const composedId = composeMatchId(rawId, 'basketball');
      if (!composedId || collected.has(composedId)) continue;
      collected.set(composedId, match);
      if (collected.size >= targetSize) break;
    }
  };

  const fetchGames = async (params, label) => {
    const matches = await safeRequest(() => requestBasketballGames(params, apiKey, label), label);
    addMatches(matches);
    return matches.length > 0;
  };

  if (mode === 'live') {
    for (const league of leagueList) {
      const params = new URLSearchParams({ timezone: DEFAULT_TIMEZONE, live: 'all' });
      if (league !== null) params.set('league', String(league));
      await fetchGames(params, `basketball/live${league ? `/league-${league}` : ''}`);
      if (collected.size >= targetSize) break;
    }
  } else {
    const dayOffsets = range === 'today' ? [0] : [1, 2, 3, 4, 5, 6, 7];
    outer: for (const offset of dayOffsets) {
      const date = formatDateOffset(offset);
      for (const league of leagueList) {
        const params = new URLSearchParams({ timezone: DEFAULT_TIMEZONE, date });
        if (league !== null) params.set('league', String(league));
        await fetchGames(params, `basketball/date-${date}${league ? `/league-${league}` : ''}`);
        if (collected.size >= targetSize) break outer;
      }
    }
  }

  if (!collected.size) return [];

  const ordered = [...collected.values()].sort((a, b) => {
    const timeA = parseTime(extractIsoDateBasketball(a));
    const timeB = parseTime(extractIsoDateBasketball(b));
    return timeA - timeB;
  });

  let filtered = ordered;
  if (mode === 'upcoming' && range !== 'today') {
    const today = formatDateOffset(0);
    filtered = ordered.filter((match) => {
      const iso = extractIsoDateBasketball(match);
      if (!iso) return true;
      return iso.slice(0, 10) > today;
    });
  }

  const limited = filtered.slice(0, pageSize);
  if (limited.length) saveMatches(limited, 'basketball');
  return limited;
}

async function fetchFootballTeamHistory(teamId, last) {
  const apiKey = getFootballApiKey();
  const params = new URLSearchParams({ team: String(teamId), last: String(last), timezone: DEFAULT_TIMEZONE });

  const matches = await safeRequest(
    () => requestFootballFixtures(params, apiKey, `football/team-${teamId}`),
    `Historie Fussball-Team ${teamId}`
  );

  const finished = matches.filter(hasFinalScore).slice(0, last);
  if (finished.length) saveMatches(finished, 'football');
  return finished;
}

async function fetchBasketballTeamHistory(teamId, last) {
  const apiKey = getBasketballApiKey();
  const baseParams = { team: String(teamId), last: String(last), timezone: DEFAULT_TIMEZONE };
  const season = resolveBasketballSeason();
  const requests = season
    ? [new URLSearchParams({ ...baseParams, season }), new URLSearchParams(baseParams)]
    : [new URLSearchParams(baseParams)];

  for (const params of requests) {
    const matches = await safeRequest(
      () => requestBasketballGames(params, apiKey, `basketball/team-${teamId}`),
      `Historie Basketball-Team ${teamId}`
    );
    const finished = matches.filter(hasFinalScore).slice(0, last);
    if (finished.length) {
      saveMatches(finished, 'basketball');
      return finished;
    }
  }

  return [];
}

async function fetchFootballHeadToHead(teamAId, teamBId, last) {
  const apiKey = getFootballApiKey();
  const params = new URLSearchParams({ h2h: `${teamAId}-${teamBId}`, last: String(last), timezone: DEFAULT_TIMEZONE });

  const matches = await safeRequest(
    () => requestFootballFixtures(params, apiKey, `football/h2h-${teamAId}-${teamBId}`),
    `Head-to-head Fussball ${teamAId} vs ${teamBId}`
  );

  const finished = matches.filter(hasFinalScore).slice(0, last);
  if (finished.length) saveMatches(finished, 'football');
  return finished;
}

async function fetchBasketballHeadToHead(teamAId, teamBId, last) {
  const apiKey = getBasketballApiKey();
  const baseParams = { h2h: `${teamAId}-${teamBId}`, last: String(last), timezone: DEFAULT_TIMEZONE };
  const season = resolveBasketballSeason();
  const requests = season
    ? [new URLSearchParams({ ...baseParams, season }), new URLSearchParams(baseParams)]
    : [new URLSearchParams(baseParams)];

  for (const params of requests) {
    const matches = await safeRequest(
      () => requestBasketballGames(params, apiKey, `basketball/h2h-${teamAId}-${teamBId}`),
      `Head-to-head Basketball ${teamAId} vs ${teamBId}`
    );
    const finished = matches.filter(hasFinalScore).slice(0, last);
    if (finished.length) {
      saveMatches(finished, 'basketball');
      return finished;
    }
  }

  return [];
}

function buildFootballParams(mode, limit, range) {
  if (mode?.startsWith?.('http')) return mode;

  const params = new URLSearchParams({ timezone: DEFAULT_TIMEZONE });

  if (mode === 'upcoming') {
    if (range === 'today') params.set('date', formatDateOffset(0));
    else params.set('next', String(limit));
  } else if (mode === 'live') {
    params.set('live', 'all');
  } else if (typeof mode === 'string' && mode.includes('=')) {
    const customParams = new URLSearchParams(mode);
    customParams.set('timezone', DEFAULT_TIMEZONE);
    return customParams;
  }

  return params;
}

function filterFootballMatches(matches, mode, range) {
  if (!Array.isArray(matches)) return [];
  if (mode !== 'upcoming' || range === 'today') return matches;

  const today = formatDateOffset(0);
  return matches.filter((match) => {
    const iso = extractIsoDateFootball(match?.fixture, match);
    if (!iso) return true;
    return iso.slice(0, 10) > today;
  });
}

async function fetchFootballUpcomingFallback(apiKey, limit, range) {
  const results = [];
  const offsets = range === 'today' ? [0] : [1, 2, 3, 4, 5, 6, 7];

  for (const offset of offsets) {
    if (results.length >= limit) break;
    const date = formatDateOffset(offset);
    const params = new URLSearchParams({ timezone: DEFAULT_TIMEZONE, date });
    const matches = await safeRequest(
      () => requestFootballFixtures(params, apiKey, `football/upcoming-fallback-${date}`),
      `Upcoming-Fallback Fussball ${date}`
    );
    for (const match of matches) {
      results.push(match);
      if (results.length >= limit) break;
    }
  }

  return results;
}

async function requestFootballFixtures(params, apiKey, label) {
  const url = typeof params === 'string' && params.startsWith('http')
    ? params
    : `${FOOTBALL_BASE_URL}?${params.toString()}`;

  const payload = await requestApi(url, {
    headers: { 'x-apisports-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    label
  });

  return Array.isArray(payload.response) ? payload.response : [];
}

async function requestBasketballGames(params, apiKey, label) {
  const payload = await requestApi(`${BASKETBALL_BASE_URL}?${params.toString()}`, {
    headers: { 'x-apisports-key': apiKey, 'x-rapidapi-host': 'v1.basketball.api-sports.io' },
    label
  });

  return Array.isArray(payload.response) ? payload.response : [];
}

async function requestApi(url, { headers, label }) {
  const response = await axios.get(url, {
    headers,
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  if (response.status !== 200) {
    throw new Error(`${label}: HTTP ${response.status} ${response.statusText ?? ''}`.trim());
  }

  const payload = response.data ?? {};
  const apiError = getApiErrorMessage(payload.errors);
  if (apiError) throw new Error(`${label}: API-Fehler: ${apiError}`);

  return payload;
}

async function safeRequest(fn, label) {
  try {
    const matches = await fn();
    return Array.isArray(matches) ? matches : [];
  } catch (error) {
    const message = error?.message ?? String(error);
    console.warn(`${label} fehlgeschlagen: ${message}`);
    return [];
  }
}

function saveMatches(matches, sport) {
  if (!Array.isArray(matches) || !matches.length) return 0;

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO matches
      (match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals)
    VALUES
      (@match_id, @sport, @date, @status, @home_team_id, @away_team_id, @home_team, @away_team, @home_goals, @away_goals)
  `);

  const mapRow = sport === 'basketball' ? mapBasketballMatch : mapFootballMatch;
  const rows = matches.map(mapRow).filter((row) => row.match_id);

  const insertMany = db.transaction((items) => {
    for (const row of items) insert.run({ ...row, sport });
  });

  insertMany(rows);
  return rows.length;
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
    status: status.short ?? status.long ?? match?.status ?? null,
    home_team_id: homeTeam.id ?? null,
    away_team_id: awayTeam.id ?? null,
    home_team: homeTeam.name ?? match?.home_team ?? null,
    away_team: awayTeam.name ?? match?.away_team ?? null,
    home_goals: isNumber(goals.home) ? goals.home : null,
    away_goals: isNumber(goals.away) ? goals.away : null
  };
}

function mapBasketballMatch(match) {
  const teams = match?.teams ?? {};
  const homeTeam = teams.home ?? {};
  const awayTeam = teams.away ?? {};
  const rawStatus = match?.status ?? {};
  const status = typeof rawStatus === 'object' ? rawStatus : { short: rawStatus, long: rawStatus };
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
    home_team: homeTeam.name ?? match?.home_team ?? null,
    away_team: awayTeam.name ?? match?.away_team ?? null,
    home_goals: isNumber(homeScore) ? homeScore : null,
    away_goals: isNumber(awayScore) ? awayScore : null
  };
}

function extractIsoDateFootball(fixture, fallback) {
  if (fixture?.date) return fixture.date;
  if (typeof fixture?.timestamp === 'number') return new Date(fixture.timestamp * 1000).toISOString();
  if (fallback?.date) return fallback.date;
  return null;
}

function extractIsoDateBasketball(game) {
  if (!game) return null;
  if (game.date) {
    if (typeof game.date === 'string' && game.date.includes('T')) return game.date;
    if (typeof game.date === 'string' && game.time) return `${game.date}T${game.time}+00:00`;
    if (typeof game.date === 'string') return new Date(`${game.date} ${game.time ?? '00:00'}`).toISOString();
  }
  if (typeof game.timestamp === 'number') return new Date(game.timestamp * 1000).toISOString();
  if (game.time?.datetime) return game.time.datetime;
  return null;
}

function resolveBasketballSeason() {
  if (process.env.API_BASKETBALL_SEASON) return process.env.API_BASKETBALL_SEASON;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return month >= 7 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function parseBasketballLeagues() {
  const raw = process.env.API_BASKETBALL_LEAGUES ?? process.env.API_BASKETBALL_LEAGUE ?? '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*') return [];
  return trimmed
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function getFootballApiKey() {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error('API_FOOTBALL_KEY not set in environment (.env)');
  return apiKey;
}

function getBasketballApiKey() {
  const apiKey = process.env.API_BASKETBALL_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error('API_BASKETBALL_KEY not set in environment (.env)');
  return apiKey;
}

function getApiErrorMessage(errors) {
  if (!errors) return null;
  if (Array.isArray(errors)) {
    const items = errors.filter(Boolean).map(String);
    return items.length ? items.join('; ') : null;
  }
  if (typeof errors === 'string') return errors.trim() || null;
  if (typeof errors === 'object') {
    const items = Object.entries(errors)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
      .map(([key, value]) => `${key}: ${String(value)}`);
    return items.length ? items.join('; ') : null;
  }
  return String(errors);
}

function hasFinalScore(match) {
  const footballGoals = match?.goals;
  if (footballGoals && isNumber(footballGoals.home) && isNumber(footballGoals.away)) return true;

  const scores = match?.scores;
  const homeScore = scores?.home?.total ?? scores?.home?.points;
  const awayScore = scores?.away?.total ?? scores?.away?.points;
  return isNumber(homeScore) && isNumber(awayScore);
}

function formatDateOffset(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function composeMatchId(rawId, sport) {
  const numeric = Number(rawId);
  if (!Number.isFinite(numeric)) return null;
  const offset = MATCH_ID_OFFSETS[sport] ?? 0;
  return offset + numeric;
}

function splitStoredMatchId(matchId, sportHint = 'football') {
  const numeric = Number(matchId);
  if (!Number.isFinite(numeric)) return { sport: sportHint, rawId: null };
  if (numeric >= MATCH_ID_OFFSETS.basketball) {
    return { sport: 'basketball', rawId: numeric - MATCH_ID_OFFSETS.basketball };
  }
  return { sport: sportHint ?? 'football', rawId: numeric };
}

function parseTime(iso) {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
