import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import { searchTeams as searchTeamsBase, loadMatchesFromDb as loadMatchesFromDbOriginal } from './matchBrowserV2.js';

dotenv.config();

const FIXTURES_URL = 'https://v3.football.api-sports.io/fixtures';
const DEFAULT_TIMEZONE = process.env.API_TIMEZONE ?? 'Europe/Berlin';
const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS) || 15000;
const ALLOWED_OFFSETS = process.env.API_FOOTBALL_ALLOWED_DATE_WINDOW ?? '-1,0,1';
const CURRENT_SEASONS = parseSeasonList(process.env.API_FOOTBALL_CURRENT_SEASONS ?? buildDefaultCurrentSeasons());

export async function searchTeams(query, options = {}) {
  return searchTeamsBase(query, options);
}

export function loadMatchesFromDb(mode, limit = 20, range, sport = 'football') {
  return loadMatchesFromDbOriginal(mode, limit, range, sport);
}

export async function fetchMatches(options = {}) {
  const { sport = 'football', mode = 'live', limit = 20, range } = options;
  if (sport !== 'football') return [];
  if (mode === 'live') return fetchLive(limit);

  const rows = await fetchGlobalWindow({ limit, range });
  if (rows.length) return rows;
  return loadMatchesFromDbOriginal('upcoming', limit, range, 'football');
}

export async function fetchUpcomingMatchesForTeam(teamId, options = {}) {
  const { sport = 'football', limit = 10 } = options;
  const id = Number(teamId);
  if (sport !== 'football' || !Number.isFinite(id)) return [];

  const rows = await fetchTeamWindow({ teamId: id, limit });
  if (rows.length) return rows;
  return loadTeamUpcomingFromDb(id, limit);
}

async function fetchLive(limit) {
  const apiKey = getApiKey();
  const params = new URLSearchParams({ live: 'all', timezone: DEFAULT_TIMEZONE });
  const rows = await safeRequest(() => requestFixtures(params, apiKey, 'browser-v3/live'), 'browser-v3/live');
  if (rows.length) saveMatches(rows);
  return rows.slice(0, limit);
}

async function fetchGlobalWindow({ limit, range }) {
  const apiKey = getApiKey();
  const collected = new Map();
  const dates = buildDates(range);

  for (const date of dates) {
    if (collected.size >= limit) break;
    for (const season of CURRENT_SEASONS) {
      if (collected.size >= limit) break;
      const params = new URLSearchParams({ date, season: String(season), timezone: DEFAULT_TIMEZONE });
      const label = `browser-v3/global-date-${date}-season-${season}`;
      const rows = await safeRequest(() => requestFixtures(params, apiKey, label), label);
      addRows(collected, rows);
    }
  }

  const result = sortByDate([...collected.values()]).slice(0, limit);
  if (result.length) saveMatches(result);
  return result;
}

async function fetchTeamWindow({ teamId, limit }) {
  const apiKey = getApiKey();
  const collected = new Map();
  const dates = buildDates('soon');
  const contexts = inferTeamContexts(teamId);
  const candidates = buildTeamCandidates(teamId, contexts, dates);

  for (const candidate of candidates) {
    if (collected.size >= limit) break;
    const rows = await safeRequest(() => requestFixtures(candidate.params, apiKey, candidate.label), candidate.label);
    addRows(collected, rows);
  }

  const result = sortByDate([...collected.values()]).slice(0, limit);
  if (result.length) saveMatches(result);
  return result;
}

function buildTeamCandidates(teamId, contexts, dates) {
  const leagues = unique(contexts.map((c) => toNumber(c.league_id)).filter((v) => v !== null));
  const seasons = unique([
    ...contexts.map((c) => toNumber(c.season)).filter((v) => v !== null),
    ...CURRENT_SEASONS
  ]);
  const candidates = [];

  for (const date of dates) {
    for (const league of leagues) {
      for (const season of seasons) {
        candidates.push({
          label: `browser-v3/team-${teamId}-league-${league}-season-${season}-date-${date}`,
          params: new URLSearchParams({ team: String(teamId), league: String(league), season: String(season), date, timezone: DEFAULT_TIMEZONE })
        });
      }
    }
    for (const season of seasons) {
      candidates.push({
        label: `browser-v3/team-${teamId}-season-${season}-date-${date}`,
        params: new URLSearchParams({ team: String(teamId), season: String(season), date, timezone: DEFAULT_TIMEZONE })
      });
    }
  }

  return candidates;
}

function inferTeamContexts(teamId) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT league_id, season, date
      FROM matches
      WHERE COALESCE(sport, 'football') = 'football'
        AND (home_team_id = @teamId OR away_team_id = @teamId)
        AND (league_id IS NOT NULL OR season IS NOT NULL)
      ORDER BY datetime(COALESCE(date, CURRENT_TIMESTAMP)) DESC
      LIMIT 8
    `).all({ teamId });
  } catch {
    return [];
  }
}

async function requestFixtures(params, apiKey, label) {
  const url = `${FIXTURES_URL}?${params.toString()}`;
  const response = await axios.get(url, {
    headers: { 'x-apisports-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  const payload = response.data ?? {};
  const count = Array.isArray(payload.response) ? payload.response.length : 0;
  const apiError = getApiErrorMessage(payload.errors);

  if (response.status !== 200 || apiError) {
    const message = response.status !== 200 ? `${label}: HTTP ${response.status}` : `${label}: API-Fehler: ${apiError}`;
    recordFetch({ label, ok: false, status: response.status, count, url, error: message });
    throw new Error(message);
  }

  recordFetch({ label, ok: true, status: response.status, count, url });
  return Array.isArray(payload.response) ? payload.response : [];
}

async function safeRequest(fn, label) {
  try { return await fn(); } catch (error) {
    console.warn(`${label} fehlgeschlagen: ${error?.message ?? error}`);
    return [];
  }
}

function buildDates(range) {
  if (range === 'today') return [dateOffset(0)];
  return parseOffsets(ALLOWED_OFFSETS).map(dateOffset);
}

function addRows(map, rows) {
  for (const row of rows ?? []) {
    const id = Number(row?.fixture?.id ?? row?.id ?? row?.match_id);
    if (Number.isFinite(id)) map.set(id, row);
  }
}

function saveMatches(matches) {
  const rows = matches.map(mapMatch).filter((row) => row.match_id);
  if (!rows.length) return 0;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO matches
      (match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals, league_id, league_name, league_country, season, round, raw_json)
    VALUES
      (@match_id, 'football', @date, @status, @home_team_id, @away_team_id, @home_team, @away_team, @home_goals, @away_goals, @league_id, @league_name, @league_country, @season, @round, @raw_json)
  `);
  const tx = db.transaction((items) => items.forEach((item) => insert.run(item)));
  tx(rows);
  return rows.length;
}

function mapMatch(match) {
  const fixture = match?.fixture ?? {};
  const teams = match?.teams ?? {};
  const goals = match?.goals ?? {};
  const league = match?.league ?? {};
  const status = fixture.status ?? {};
  return {
    match_id: toNumber(fixture.id ?? match?.id ?? match?.match_id),
    date: getDate(match),
    status: status.short ?? status.long ?? match?.status ?? null,
    home_team_id: teams.home?.id ?? match?.home_team_id ?? null,
    away_team_id: teams.away?.id ?? match?.away_team_id ?? null,
    home_team: teams.home?.name ?? match?.home_team ?? null,
    away_team: teams.away?.name ?? match?.away_team ?? null,
    home_goals: isNumber(goals.home) ? goals.home : null,
    away_goals: isNumber(goals.away) ? goals.away : null,
    league_id: league.id ?? match?.league_id ?? null,
    league_name: league.name ?? match?.league_name ?? null,
    league_country: league.country ?? match?.league_country ?? null,
    season: league.season ?? match?.season ?? null,
    round: league.round ?? match?.round ?? null,
    raw_json: safeJson(match)
  };
}

function loadTeamUpcomingFromDb(teamId, limit) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals, league_name
      FROM matches
      WHERE COALESCE(sport, 'football') = 'football'
        AND (home_team_id = @teamId OR away_team_id = @teamId)
        AND date IS NOT NULL
        AND datetime(date) >= datetime('now', '-1 day')
      ORDER BY datetime(date) ASC
      LIMIT @limit
    `).all({ teamId, limit });
  } catch {
    return [];
  }
}

function sortByDate(rows) { return rows.sort((a, b) => parseTime(getDate(a)) - parseTime(getDate(b))); }
function dateOffset(offset) { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
function parseOffsets(raw) { const items = String(raw).split(',').map((x) => Number(x.trim())).filter(Number.isFinite); return items.length ? unique(items) : [-1, 0, 1]; }
function buildDefaultCurrentSeasons() { const y = new Date().getUTCFullYear(); return `${y},${y - 1}`; }
function parseSeasonList(raw) { return String(raw).split(',').map((x) => Number(x.trim())).filter(Number.isFinite); }
function unique(values) { return [...new Set(values)]; }
function getDate(match) { const f = match?.fixture ?? match; if (f?.date) return f.date; if (typeof f?.timestamp === 'number') return new Date(f.timestamp * 1000).toISOString(); return match?.date ?? null; }
function getApiKey() { const key = process.env.API_FOOTBALL_KEY; if (!key) throw new Error('API_FOOTBALL_KEY not set'); return key; }
function getApiErrorMessage(errors) { if (!errors) return null; if (typeof errors === 'string') return errors.trim() || null; if (Array.isArray(errors)) return errors.filter(Boolean).join('; ') || null; if (typeof errors === 'object') { const items = Object.entries(errors).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`); return items.length ? items.join('; ') : null; } return String(errors); }
function recordFetch({ label, ok, status = null, count = 0, error = null, url = null }) { try { const db = getDb(); db.prepare(`INSERT INTO api_fetch_log (label, ok, status, response_count, error, url) VALUES (@label, @ok, @status, @count, @error, @url)`).run({ label, ok: ok ? 1 : 0, status, count, error, url: sanitizeUrl(url) }); } catch {} }
function sanitizeUrl(url) { try { return new URL(url).toString(); } catch { return String(url ?? '').slice(0, 500); } }
function parseTime(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; }
function toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function safeJson(v) { try { return JSON.stringify(v); } catch { return null; } }
