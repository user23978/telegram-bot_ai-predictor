import axios from 'axios';
import dotenv from 'dotenv';

import { getDb } from '../data/db.js';
import { cached, getCacheStats } from './cache.js';

dotenv.config();

const FIXTURES_URL = 'https://v3.football.api-sports.io/fixtures';
const PREDICTIONS_URL = 'https://v3.football.api-sports.io/predictions';
const ODDS_URL = 'https://v3.football.api-sports.io/odds';
const INJURIES_URL = 'https://v3.football.api-sports.io/injuries';
const STANDINGS_URL = 'https://v3.football.api-sports.io/standings';

const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS) || 15000;
const DEFAULT_TIMEZONE = process.env.API_TIMEZONE ?? 'Europe/Berlin';
const BASKETBALL_OFFSET = 5_000_000_000;

const TTL = {
  fixture: 20 * 60 * 1000,
  prediction: 30 * 60 * 1000,
  odds: 15 * 60 * 1000,
  injuries: 60 * 60 * 1000,
  standings: 6 * 60 * 60 * 1000
};

export async function buildFootballContext(matchOrId) {
  const match = typeof matchOrId === 'object' ? matchOrId : getMatchFromDb(matchOrId);
  if (!match) return createContext(false, 'Match nicht in der lokalen DB gefunden.');

  const sport = match.sport ?? 'football';
  if (sport !== 'football') return createContext(false, 'Zusatzdaten aktuell nur fuer Fussball verfuegbar.');

  const fixtureId = getRawFootballFixtureId(match.match_id);
  if (!fixtureId) return createContext(false, 'Fixture-ID konnte nicht bestimmt werden.');

  const fixture = await fetchFixture(fixtureId);
  const fixtureMeta = mergeFixtureMeta(match, fixture);

  const [apiPrediction, odds, injuries, standings] = await Promise.all([
    fetchPrediction(fixtureId),
    fetchOdds(fixtureId),
    fetchInjuries(fixtureId),
    fixtureMeta.league_id && fixtureMeta.season
      ? fetchStandings(fixtureMeta.league_id, fixtureMeta.season)
      : Promise.resolve(null)
  ]);

  const quality = getQuality({ fixtureMeta, apiPrediction, odds, injuries, standings });

  return {
    available: true,
    reason: null,
    fixture: fixtureMeta,
    apiPrediction,
    odds,
    injuries,
    standings,
    quality
  };
}

export function formatFootballContextForPrompt(context, homeTeam, awayTeam) {
  if (!context?.available) {
    return `Externe API-Zusatzdaten: nicht verfuegbar (${context?.reason ?? 'unbekannt'}).`;
  }

  return [
    'Externe API-Zusatzdaten:',
    formatFixtureMeta(context.fixture),
    formatApiPrediction(context.apiPrediction),
    formatOdds(context.odds),
    formatInjuries(context.injuries, homeTeam, awayTeam),
    formatStandings(context.standings, homeTeam, awayTeam),
    `Zusatzdaten-Qualitaet: ${context.quality.label} (${context.quality.score}/100) - ${context.quality.reason}`
  ].join('\n');
}

export function getFootballContextDebug(context) {
  if (!context) return { available: false, reason: 'Kein Context-Objekt.' };
  return {
    available: Boolean(context.available),
    reason: context.reason ?? null,
    fixture: context.fixture ?? null,
    hasApiPrediction: Boolean(context.apiPrediction),
    hasOdds: Boolean(context.odds),
    injuriesCount: Array.isArray(context.injuries) ? context.injuries.length : 0,
    hasStandings: Boolean(context.standings),
    quality: context.quality ?? null,
    cache: getCacheStats()
  };
}

async function fetchFixture(fixtureId) {
  return cached(`football:fixture:${fixtureId}`, TTL.fixture, async () => {
    const payload = await requestFootball(FIXTURES_URL, new URLSearchParams({
      id: String(fixtureId),
      timezone: DEFAULT_TIMEZONE
    }), `fixture-${fixtureId}`);
    return Array.isArray(payload.response) ? payload.response[0] ?? null : null;
  });
}

async function fetchPrediction(fixtureId) {
  return cached(`football:prediction:${fixtureId}`, TTL.prediction, async () => {
    const payload = await safeRequest(() => requestFootball(PREDICTIONS_URL, new URLSearchParams({ fixture: String(fixtureId) }), `prediction-${fixtureId}`));
    const item = Array.isArray(payload?.response) ? payload.response[0] ?? null : null;
    return normalizePrediction(item);
  });
}

async function fetchOdds(fixtureId) {
  return cached(`football:odds:${fixtureId}`, TTL.odds, async () => {
    const payload = await safeRequest(() => requestFootball(ODDS_URL, new URLSearchParams({ fixture: String(fixtureId) }), `odds-${fixtureId}`));
    const item = Array.isArray(payload?.response) ? payload.response[0] ?? null : null;
    return normalizeOdds(item);
  });
}

async function fetchInjuries(fixtureId) {
  return cached(`football:injuries:${fixtureId}`, TTL.injuries, async () => {
    const payload = await safeRequest(() => requestFootball(INJURIES_URL, new URLSearchParams({ fixture: String(fixtureId) }), `injuries-${fixtureId}`));
    const items = Array.isArray(payload?.response) ? payload.response : [];
    return items.map(normalizeInjury).filter(Boolean).slice(0, 30);
  });
}

async function fetchStandings(leagueId, season) {
  return cached(`football:standings:${leagueId}:${season}`, TTL.standings, async () => {
    const payload = await safeRequest(() => requestFootball(STANDINGS_URL, new URLSearchParams({
      league: String(leagueId),
      season: String(season)
    }), `standings-${leagueId}-${season}`));
    const item = Array.isArray(payload?.response) ? payload.response[0] ?? null : null;
    return normalizeStandings(item);
  });
}

async function requestFootball(url, params, label) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error('API_FOOTBALL_KEY not set in environment (.env)');

  const response = await axios.get(`${url}?${params.toString()}`, {
    headers: {
      'x-apisports-key': apiKey,
      'x-rapidapi-host': 'v3.football.api-sports.io'
    },
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}`);

  const payload = response.data ?? {};
  const apiError = getApiErrorMessage(payload.errors);
  if (apiError) throw new Error(`${label}: API-Fehler: ${apiError}`);
  return payload;
}

async function safeRequest(fn) {
  try {
    return await fn();
  } catch (error) {
    console.warn(error?.message ?? error);
    return null;
  }
}

function getMatchFromDb(matchId) {
  const numericId = Number(matchId);
  if (!Number.isFinite(numericId)) return null;
  const db = getDb();
  const stmt = db.prepare(`
    SELECT match_id, COALESCE(sport, 'football') AS sport, date, status,
           home_team, away_team, home_team_id, away_team_id,
           league_id, league_name, league_country, season, round
    FROM matches
    WHERE match_id = @matchId
  `);
  return stmt.get({ matchId: numericId }) ?? null;
}

function mergeFixtureMeta(localMatch, fixture) {
  const league = fixture?.league ?? {};
  const teams = fixture?.teams ?? {};
  const status = fixture?.fixture?.status ?? {};
  return {
    match_id: localMatch.match_id,
    fixture_id: getRawFootballFixtureId(localMatch.match_id),
    date: fixture?.fixture?.date ?? localMatch.date ?? null,
    status: status.short ?? status.long ?? localMatch.status ?? null,
    league_id: league.id ?? localMatch.league_id ?? null,
    league_name: league.name ?? localMatch.league_name ?? null,
    league_country: league.country ?? localMatch.league_country ?? null,
    season: league.season ?? localMatch.season ?? null,
    round: league.round ?? localMatch.round ?? null,
    home_team: teams.home?.name ?? localMatch.home_team ?? null,
    away_team: teams.away?.name ?? localMatch.away_team ?? null,
    home_team_id: teams.home?.id ?? localMatch.home_team_id ?? null,
    away_team_id: teams.away?.id ?? localMatch.away_team_id ?? null
  };
}

function normalizePrediction(item) {
  if (!item) return null;
  const prediction = item.predictions ?? {};
  const percent = prediction.percent ?? {};
  const teams = item.teams ?? {};
  return {
    winner: prediction.winner?.name ?? null,
    winnerId: prediction.winner?.id ?? null,
    winOrDraw: prediction.win_or_draw ?? null,
    underOver: prediction.under_over ?? null,
    advice: prediction.advice ?? null,
    percent: {
      home: parsePercent(percent.home),
      draw: parsePercent(percent.draw),
      away: parsePercent(percent.away)
    },
    home: teams.home?.name ?? null,
    away: teams.away?.name ?? null,
    comparison: item.comparison ?? null
  };
}

function normalizeOdds(item) {
  if (!item?.bookmakers?.length) return null;
  const bookmaker = item.bookmakers[0];
  const matchWinnerBet = bookmaker.bets?.find((bet) => /match winner|winner|1x2/i.test(bet.name ?? '')) ?? bookmaker.bets?.[0];
  if (!matchWinnerBet?.values?.length) return null;
  return {
    bookmaker: bookmaker.name ?? null,
    market: matchWinnerBet.name ?? null,
    values: matchWinnerBet.values.map((value) => ({
      label: value.value ?? null,
      odd: Number(value.odd) || null,
      impliedProbability: Number(value.odd) ? round(1 / Number(value.odd)) : null
    }))
  };
}

function normalizeInjury(item) {
  if (!item) return null;
  return {
    team: item.team?.name ?? null,
    teamId: item.team?.id ?? null,
    player: item.player?.name ?? null,
    type: item.player?.type ?? null,
    reason: item.player?.reason ?? null
  };
}

function normalizeStandings(item) {
  const league = item?.league ?? {};
  const groups = league.standings ?? [];
  const flatRows = groups.flat().filter(Boolean);
  if (!flatRows.length) return null;
  return {
    league: league.name ?? null,
    country: league.country ?? null,
    season: league.season ?? null,
    rows: flatRows.map((row) => ({
      rank: row.rank ?? null,
      teamId: row.team?.id ?? null,
      team: row.team?.name ?? null,
      points: row.points ?? null,
      goalsDiff: row.goalsDiff ?? null,
      form: row.form ?? null,
      played: row.all?.played ?? null,
      win: row.all?.win ?? null,
      draw: row.all?.draw ?? null,
      lose: row.all?.lose ?? null,
      goalsFor: row.all?.goals?.for ?? null,
      goalsAgainst: row.all?.goals?.against ?? null
    }))
  };
}

function formatFixtureMeta(fixture) {
  return [
    `Liga: ${fixture.league_name ?? 'unbekannt'} (${fixture.league_country ?? 'unbekannt'}), Saison ${fixture.season ?? 'unbekannt'}`,
    `Runde: ${fixture.round ?? 'unbekannt'}`,
    `Status: ${fixture.status ?? 'unbekannt'}, Anstoss: ${fixture.date ?? 'unbekannt'}`
  ].join('\n');
}

function formatApiPrediction(prediction) {
  if (!prediction) return 'API-Prediction: nicht verfuegbar.';
  return [
    'API-Prediction:',
    `Winner: ${prediction.winner ?? 'unbekannt'}, Advice: ${prediction.advice ?? 'keine Angabe'}`,
    `Prozent: Home ${formatProb(prediction.percent.home)}, Draw ${formatProb(prediction.percent.draw)}, Away ${formatProb(prediction.percent.away)}`,
    prediction.underOver ? `Under/Over: ${prediction.underOver}` : null
  ].filter(Boolean).join('\n');
}

function formatOdds(odds) {
  if (!odds) return 'Odds: nicht verfuegbar.';
  const values = odds.values
    .map((value) => `${value.label}: ${value.odd ?? 'n/a'} (${formatProb(value.impliedProbability)})`)
    .join(', ');
  return `Odds (${odds.bookmaker ?? 'Bookmaker unbekannt'}, ${odds.market ?? 'Markt unbekannt'}): ${values}`;
}

function formatInjuries(injuries, homeTeam, awayTeam) {
  if (!Array.isArray(injuries) || injuries.length === 0) return 'Injuries/Sperren: keine Daten verfuegbar.';
  const home = injuries.filter((item) => normalizeName(item.team) === normalizeName(homeTeam));
  const away = injuries.filter((item) => normalizeName(item.team) === normalizeName(awayTeam));
  const other = injuries.filter((item) => !home.includes(item) && !away.includes(item));
  return [
    'Injuries/Sperren:',
    `Home (${homeTeam ?? 'Heimteam'}): ${formatInjuryList(home)}`,
    `Away (${awayTeam ?? 'Auswaertsteam'}): ${formatInjuryList(away)}`,
    other.length ? `Sonstige: ${formatInjuryList(other.slice(0, 5))}` : null
  ].filter(Boolean).join('\n');
}

function formatStandings(standings, homeTeam, awayTeam) {
  if (!standings?.rows?.length) return 'Standings: nicht verfuegbar.';
  const home = findStandingRow(standings.rows, homeTeam);
  const away = findStandingRow(standings.rows, awayTeam);
  return [
    `Standings (${standings.league ?? 'Liga unbekannt'}):`,
    home ? `Home: #${home.rank} ${home.team}, ${home.points} Punkte, Diff ${home.goalsDiff}, Form ${home.form ?? 'n/a'}` : `Home: ${homeTeam ?? 'unbekannt'} nicht gefunden`,
    away ? `Away: #${away.rank} ${away.team}, ${away.points} Punkte, Diff ${away.goalsDiff}, Form ${away.form ?? 'n/a'}` : `Away: ${awayTeam ?? 'unbekannt'} nicht gefunden`
  ].join('\n');
}

function getQuality({ fixtureMeta, apiPrediction, odds, injuries, standings }) {
  let score = 25;
  const reasons = [];
  if (fixtureMeta?.league_id && fixtureMeta?.season) { score += 15; reasons.push('Liga/Saison vorhanden'); }
  if (apiPrediction) { score += 20; reasons.push('API-Prediction vorhanden'); }
  if (odds) { score += 20; reasons.push('Odds vorhanden'); }
  if (Array.isArray(injuries) && injuries.length > 0) { score += 10; reasons.push('Injuries vorhanden'); }
  if (standings) { score += 20; reasons.push('Standings vorhanden'); }
  score = Math.min(100, score);
  return {
    score,
    label: score >= 75 ? 'gut' : score >= 50 ? 'mittel' : 'schwach',
    reason: reasons.length ? reasons.join(', ') : 'nur Basisdaten vorhanden'
  };
}

function createContext(available, reason) {
  return {
    available,
    reason,
    fixture: null,
    apiPrediction: null,
    odds: null,
    injuries: [],
    standings: null,
    quality: { score: 0, label: 'schwach', reason }
  };
}

function findStandingRow(rows, teamName) {
  const normalized = normalizeName(teamName);
  return rows.find((row) => normalizeName(row.team) === normalized) ?? null;
}

function formatInjuryList(items) {
  if (!items.length) return 'keine Daten';
  return items.map((item) => `${item.player ?? 'Spieler'} (${item.reason ?? item.type ?? 'Grund unbekannt'})`).join(', ');
}

function getRawFootballFixtureId(matchId) {
  const numeric = Number(matchId);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric >= BASKETBALL_OFFSET) return null;
  return numeric;
}

function parsePercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value > 1 ? round(value / 100) : round(value);
  const cleaned = String(value).replace('%', '').trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return round(parsed / 100);
}

function formatProb(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
  return `${Math.round(Number(value) * 100)}%`;
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function round(value) {
  return Math.round(value * 100) / 100;
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
