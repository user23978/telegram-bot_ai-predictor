import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import {
  searchTeams,
  loadMatchesFromDb as loadMatchesFromDbOriginal
} from './apiHandler.js';

dotenv.config();

const FOOTBALL_FIXTURES_URL = 'https://v3.football.api-sports.io/fixtures';
const DEFAULT_TIMEZONE = process.env.API_TIMEZONE ?? 'Europe/Berlin';
const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS) || 15000;
const DEFAULT_WINDOW = process.env.API_FOOTBALL_ALLOWED_DATE_WINDOW ?? '-1,0,1';

export { searchTeams };

export async function fetchMatches(options = {}) {
  const { sport = 'football', mode = 'live', limit = 20, range } = options;
  if (sport !== 'football') return loadMatchesFromDbOriginal(mode, limit, range, sport);

  if (mode === 'live') return fetchFootballLive(limit);
  return fetchFootballAllowedWindow({ limit, range });
}

export async function fetchUpcomingMatchesForTeam(teamId, options = {}) {
  const { sport = 'football', limit = 10 } = options;
  const numericTeamId = Number(teamId);
  if (sport !== 'football' || !Number.isFinite(numericTeamId)) return [];

  const rows = await fetchFootballAllowedWindow({ limit, teamId: numericTeamId });
  if (rows.length) return rows.slice(0, limit);
  return loadTeamMatchesFromDb(numericTeamId, limit);
}

export function loadMatchesFromDb(mode, limit = 20, range, sport = 'football') {
  return loadMatchesFromDbOriginal(mode, limit, range, sport);
}

async function fetchFootballLive(limit) {
  const apiKey = getApiKey();
  const params = new URLSearchParams({ live: 'all', timezone: DEFAULT_TIMEZONE });
  const rows = await safeRequest(() => requestFixtures(params, apiKey, 'browser-v2/live'), 'Live-Spiele');
  if (rows.length) saveFootballMatches(rows);
  return rows.slice(0, limit);
}

async function fetchFootballAllowedWindow({ limit = 20, range, teamId = null }) {
  const apiKey = getApiKey();
  const collected = new Map();

  const windows = buildDateWindows(range);
  for (const window of windows) {
    if (collected.size >= limit) break;

    const params = new URLSearchParams({ timezone: DEFAULT_TIMEZONE });
    if (window.date) params.set('date', window.date);
    else {
      params.set('from', window.from);
      params.set('to', window.to);
    }
    if (teamId) params.set('team', String(teamId));

    const label = teamId
      ? `browser-v2/team-${teamId}-${window.label}`
      : `browser-v2/upcoming-${window.label}`;

    const rows = await safeRequest(() => requestFixtures(params, apiKey, label), label);
    for (const row of rows) {
      const id = Number(row?.fixture?.id ?? row?.id ?? row?.match_id);
      if (Number.isFinite(id)) collected.set(id, row);
    }
  }

  const result = [...collected.values()].sort((a, b) => parseTime(getDate(a)) - parseTime(getDate(b))).slice(0, limit);
  if (result.length) saveFootballMatches(result);
  return result;
}

function buildDateWindows(range) {
  const offsets = parseOffsets(DEFAULT_WINDOW);
  if (range === 'today') return [{ label: 'today', date: dateOffset(0) }];

  const dates = offsets.map((offset) => dateOffset(offset)).sort();
  const from = dates[0] ?? dateOffset(-1);
  const to = dates[dates.length - 1] ?? dateOffset(1);

  return [
    { label: `from-${from}-to-${to}`, from, to },
    ...offsets.map((offset) => ({ label: `date-${dateOffset(offset)}`, date: dateOffset(offset) }))
  ];
}

async function requestFixtures(params, apiKey, label) {
  const url = `${FOOTBALL_FIXTURES_URL}?${params.toString()}`;
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

function saveFootballMatches(matches) {
  const rows = matches.map(mapFootballMatch).filter((row) => row.match_id);
  if (!rows.length) return 0;

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO matches
      (match_id, sport, date, status, home_team_id, away_team_id, home_team, away_team, home_goals, away_goals, league_id, league_name, league_country, season, round, raw_json)
    VALUES
      (@match_id, 'football', @date, @status, @home_team_id, @away_team_id, @home_team, @away_team, @home_goals, @away_goals, @league_id, @league_name, @league_country, @season, @round, @raw_json)
  `);
  const tx = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });
  tx(rows);
  return rows.length;
}

function mapFootballMatch(match) {
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

function loadTeamMatchesFromDb(teamId, limit) {
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
}

function parseOffsets(raw) {
  const items = String(raw ?? '').split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
  return items.length ? [...new Set(items)] : [-1, 0, 1];
}

function dateOffset(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function getDate(match) {
  const fixture = match?.fixture ?? match;
  if (fixture?.date) return fixture.date;
  if (typeof fixture?.timestamp === 'number') return new Date(fixture.timestamp * 1000).toISOString();
  if (match?.date) return match.date;
  return null;
}

function getApiKey() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY not set');
  return key;
}

function getApiErrorMessage(errors) {
  if (!errors) return null;
  if (typeof errors === 'string') return errors.trim() || null;
  if (Array.isArray(errors)) return errors.filter(Boolean).join('; ') || null;
  if (typeof errors === 'object') {
    const items = Object.entries(errors).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
    return items.length ? items.join('; ') : null;
  }
  return String(errors);
}

function recordFetch({ label, ok, status = null, count = 0, error = null, url = null }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_fetch_log (label, ok, status, response_count, error, url)
      VALUES (@label, @ok, @status, @count, @error, @url)
    `).run({ label, ok: ok ? 1 : 0, status, count, error, url: sanitizeUrl(url) });
  } catch {}
}

function sanitizeUrl(url) { try { return new URL(url).toString(); } catch { return String(url ?? '').slice(0, 500); } }
function parseTime(value) { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; }
function toNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
function safeJson(value) { try { return JSON.stringify(value); } catch { return null; } }
