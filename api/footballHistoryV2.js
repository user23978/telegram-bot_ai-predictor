import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';

dotenv.config();

const FIXTURES_URL = 'https://v3.football.api-sports.io/fixtures';
const DEFAULT_TIMEZONE = process.env.API_TIMEZONE ?? 'Europe/Berlin';
const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS) || 15000;
const MAX_REQUESTS = Number(process.env.API_FOOTBALL_MAX_HISTORY_REQUESTS_PER_TEAM) || 5;
const FREE_SEASONS = parseSeasonList(process.env.API_FOOTBALL_FREE_SEASONS ?? '2024,2023,2022');
const TRY_CURRENT = String(process.env.API_FOOTBALL_TRY_CURRENT_SEASON ?? 'false').toLowerCase() === 'true';

export async function fetchFootballTeamHistoryV2(teamId, last = 12, context = {}) {
  const numericTeamId = Number(teamId);
  if (!Number.isFinite(numericTeamId) || numericTeamId <= 0) return [];

  const apiKey = getApiKey();
  const collected = new Map();
  const contexts = inferTeamContexts(numericTeamId, context);
  const candidates = buildCandidates(numericTeamId, contexts);

  let requests = 0;
  for (const candidate of candidates) {
    if (collected.size >= last || requests >= MAX_REQUESTS) break;
    requests += 1;
    const rows = await safeRequest(
      () => requestFixtures(candidate.params, apiKey, candidate.label),
      candidate.label
    );
    addFinished(collected, rows);
  }

  const result = sortFinished([...collected.values()]).slice(0, last);
  if (result.length) saveFootballMatches(result);
  return result;
}

export async function fetchFootballHeadToHeadHistoryV2(teamAId, teamBId, last = 10, context = {}) {
  const teamA = Number(teamAId);
  const teamB = Number(teamBId);
  if (!Number.isFinite(teamA) || !Number.isFinite(teamB)) return [];

  let h2h = loadHeadToHead(teamA, teamB, last);
  if (h2h.length >= Math.min(last, 2)) return h2h;

  await fetchFootballTeamHistoryV2(teamA, Math.max(last * 2, 12), context);
  await fetchFootballTeamHistoryV2(teamB, Math.max(last * 2, 12), context);

  h2h = loadHeadToHead(teamA, teamB, last);
  return h2h;
}

function inferTeamContexts(teamId, explicit) {
  const items = [];
  if (explicit?.leagueId || explicit?.league_id || explicit?.season || explicit?.matchDate) {
    items.push({
      league_id: explicit.leagueId ?? explicit.league_id ?? null,
      season: explicit.season ?? null,
      date: explicit.matchDate ?? explicit.date ?? null
    });
  }

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT league_id, season, date
      FROM matches
      WHERE COALESCE(sport, 'football') = 'football'
        AND (home_team_id = @teamId OR away_team_id = @teamId)
        AND (league_id IS NOT NULL OR season IS NOT NULL)
      ORDER BY datetime(COALESCE(date, CURRENT_TIMESTAMP)) DESC
      LIMIT 8
    `).all({ teamId });
    items.push(...rows);
  } catch {}

  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.league_id ?? 'x'}:${item.season ?? 'x'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCandidates(teamId, contexts) {
  const leagues = unique(contexts.map((item) => toNumber(item.league_id)).filter((value) => value !== null));
  const contextSeasons = unique(contexts.map((item) => toNumber(item.season)).filter((value) => value !== null));
  const seasons = buildSeasons(contextSeasons);
  const candidates = [];

  for (const league of leagues) {
    for (const season of seasons) {
      candidates.push({
        label: `history-v2/team-${teamId}/league-${league}/season-${season}`,
        params: new URLSearchParams({ team: String(teamId), league: String(league), season: String(season), timezone: DEFAULT_TIMEZONE })
      });
    }
  }

  for (const season of seasons) {
    candidates.push({
      label: `history-v2/team-${teamId}/season-${season}`,
      params: new URLSearchParams({ team: String(teamId), season: String(season), timezone: DEFAULT_TIMEZONE })
    });
  }

  return candidates;
}

function buildSeasons(contextSeasons) {
  const seasons = [];
  if (TRY_CURRENT) seasons.push(...contextSeasons);
  seasons.push(...FREE_SEASONS);
  for (const season of contextSeasons) if (season <= 2024) seasons.push(season);
  return unique(seasons.filter((value) => Number.isFinite(value) && value >= 1990 && value <= 2100));
}

function loadHeadToHead(teamAId, teamBId, limit) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT match_id, sport, date, home_team, away_team, home_team_id, away_team_id, home_goals, away_goals
      FROM matches
      WHERE COALESCE(sport, 'football') = 'football'
        AND home_goals IS NOT NULL
        AND away_goals IS NOT NULL
        AND (
          (home_team_id = @teamAId AND away_team_id = @teamBId) OR
          (home_team_id = @teamBId AND away_team_id = @teamAId)
        )
      ORDER BY datetime(date) DESC
      LIMIT @limit
    `).all({ teamAId, teamBId, limit });
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
  const error = getApiErrorMessage(payload.errors);

  if (response.status !== 200 || error) {
    const message = response.status !== 200 ? `${label}: HTTP ${response.status}` : `${label}: API-Fehler: ${error}`;
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

function addFinished(map, rows) {
  for (const row of rows ?? []) {
    if (!hasFinalScore(row)) continue;
    const id = toNumber(row?.fixture?.id ?? row?.id ?? row?.match_id);
    if (id === null) continue;
    map.set(id, row);
  }
}

function sortFinished(rows) {
  return rows.sort((a, b) => parseTime(extractDate(b)) - parseTime(extractDate(a)));
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
    date: extractDate(match),
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

function hasFinalScore(match) {
  return isNumber(match?.goals?.home) && isNumber(match?.goals?.away);
}

function extractDate(match) {
  const fixture = match?.fixture ?? match;
  if (fixture?.date) return fixture.date;
  if (typeof fixture?.timestamp === 'number') return new Date(fixture.timestamp * 1000).toISOString();
  if (match?.date) return match.date;
  return null;
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
    const items = Object.entries(errors).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    return items.length ? items.join('; ') : null;
  }
  return String(errors);
}

function parseSeasonList(value) { return String(value).split(',').map((x) => Number(x.trim())).filter(Number.isFinite); }
function unique(values) { return [...new Set(values)]; }
function toNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
function parseTime(value) { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY; }
function safeJson(value) { try { return JSON.stringify(value); } catch { return null; } }
function sanitizeUrl(url) { try { const parsed = new URL(url); return parsed.toString(); } catch { return String(url ?? '').slice(0, 500); } }
