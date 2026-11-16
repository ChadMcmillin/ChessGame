// Live DraftKings prop lines AND prices, via The Odds API (the-odds-api.com), a licensed odds
// service. It needs the user's own API key, which is kept on the device and sent nowhere else.
// The API allows browser calls (access-control-allow-origin: *) and reports quota in headers.

const BASE = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl';

// Odds API market key -> the prop type id the model already understands (ESPN's ids).
export const MARKETS = {
  player_pass_yds: '8', player_pass_tds: '10', player_pass_completions: '9', player_pass_attempts: '16',
  player_rush_yds: '12', player_rush_attempts: '11', player_reception_yds: '13', player_receptions: '14',
  player_rush_reception_yds: '20', player_anytime_td: '31',
  player_pass_interceptions: '15', player_pass_longest_completion: '17', player_pass_rush_yds: '18',
  player_reception_longest: '19', player_rush_longest: '21', player_kicking_points: '22', player_pats: '23',
  player_field_goals: '24', player_assists: '25', player_solo_tackles: '26', player_tackles_assists: '27',
  player_sacks: '28', team_totals: '98',
};
// Each market returned costs one credit per pull, so the default set is the ten most-bet markets.
export const SETS = { core: Object.keys(MARKETS).slice(0, 10), all: Object.keys(MARKETS) };
// Minutes between pulls for a game: [live, within 6 hours of kickoff, earlier than that].
export const SPEEDS = { saver: [5, 30, 120], balanced: [2, 10, 60], fastest: [1, 5, 30] };

// Rough credit use, for the settings screen.
export function estimate(set, speed) {
  const n = SETS[set].length, [live, near] = SPEEDS[speed];
  const perGame = n * Math.ceil(195 / live);
  return { perPull: n, perGame, sunday: Math.round((14 * (perGame + n * (360 / near))) / 1000) * 1000 };
}

export const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

async function call(path, key, params = {}) {
  const qs = new URLSearchParams({ apiKey: key, ...params });
  let res;
  try { res = await fetch(`${BASE}${path}?${qs}`, { cache: 'no-store' }); } catch { throw Object.assign(new Error('Could not reach the odds service.'), { status: 0 }); }
  const num = (h) => { const v = parseFloat(res.headers.get(h)); return isNaN(v) ? null : v; };
  const meta = { remaining: num('x-requests-remaining'), used: num('x-requests-used'), last: num('x-requests-last') };
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.message || `The odds service returned an error (${res.status}).`), { status: res.status, code: j.error_code, ...meta });
  }
  return { data: await res.json(), ...meta };
}

// The list of games is free to fetch, so it doubles as the key check.
let evCache = null;
export async function events(key, fresh) {
  if (!fresh && evCache && evCache.key === key && Date.now() - evCache.at < 30 * 6e4) return evCache.r;
  const r = await call('/events', key, { dateFormat: 'iso' });
  evCache = { key, at: Date.now(), r };
  return r;
}

// Find the odds service's event for one of our games, by team names and kickoff time.
export function matchEvent(list, g) {
  const last = (s) => normName(s).split(' ').pop();
  const near = (e) => Math.abs(Date.parse(e.commence_time) - Date.parse(g.date)) < 36 * 36e5;
  return (list || []).find((e) => near(e) && normName(e.home_team) === normName(g.home.full) && normName(e.away_team) === normName(g.away.full))
    || (list || []).find((e) => near(e) && last(e.home_team) === last(g.home.full) && last(e.away_team) === last(g.away.full)) || null;
}

export function eventOdds(key, eventId, set) {
  return call(`/events/${eventId}/odds`, key, { regions: 'us', bookmakers: 'draftkings', markets: SETS[set].join(','), oddsFormat: 'american', dateFormat: 'iso' });
}

/**
 * Turn an event-odds response into the model's inputs.
 * players: {athleteId: {name, teamId}} for both rosters.
 * Returns { rows, prices, types, unmatched }:
 *   rows   – prop lines shaped like the ESPN ones ({athleteId|teamId, typeId, line, lastUpdated})
 *   prices – {pickKey: {p, src: 'dk', t}} keyed exactly as the model keys its picks
 *   types  – which prop type ids DraftKings returned, so those ESPN lines can be replaced
 */
export function parseOdds(json, players, g) {
  const out = { rows: [], prices: {}, types: [], unmatched: 0 };
  const book = (json?.bookmakers || []).find((b) => b.key === 'draftkings');
  if (!book) return out;
  const byName = new Map(), loose = new Map();
  for (const [id, pl] of Object.entries(players || {})) {
    const n = normName(pl.name);
    if (!n) continue;
    byName.set(n, id);
    const parts = n.split(' '), k = `${parts[0][0]} ${parts[parts.length - 1]}`; // "d henry"
    loose.set(k, loose.has(k) ? null : id); // null marks an ambiguous initial + surname
  }
  const who = (name) => {
    const n = normName(name), parts = n.split(' ');
    return byName.get(n) || (parts.length > 1 && loose.get(`${parts[0][0]} ${parts[parts.length - 1]}`)) || null;
  };
  const team = (name) => {
    const n = normName(name);
    return [g.home, g.away].find((t) => normName(t.full) === n || normName(t.full).endsWith(' ' + n.split(' ').pop()))?.id || null;
  };
  const seen = new Set();
  const price = (key, o, t) => { if (typeof o.price === 'number') out.prices[key] = { p: o.price, src: 'dk', t }; };
  for (const m of book.markets || []) {
    const typeId = MARKETS[m.key];
    if (!typeId) continue;
    out.types.push(typeId);
    for (const o of m.outcomes || []) {
      const side = String(o.name || '').toLowerCase();
      if (m.key === 'team_totals') {
        const teamId = team(o.description);
        if (!teamId || o.point == null || (side !== 'over' && side !== 'under')) continue;
        if (!seen.has(`${teamId}|98|${o.point}`)) { seen.add(`${teamId}|98|${o.point}`); out.rows.push({ teamId, athleteId: null, typeId, line: o.point, lastUpdated: m.last_update }); }
        price(`${g.id}|teamtotal|${side}||${teamId}@${o.point}`, o, m.last_update);
        continue;
      }
      const athleteId = who(o.description);
      if (!athleteId) { out.unmatched++; continue; }
      if (m.key === 'player_anytime_td') {
        if (side !== 'yes' && side !== 'over') continue;
        if (!seen.has(`${athleteId}|31`)) { seen.add(`${athleteId}|31`); out.rows.push({ athleteId, teamId: null, typeId, line: null, lastUpdated: m.last_update }); }
        price(`${g.id}|td|yes|${athleteId}|31@`, o, m.last_update);
      } else if (o.point != null && (side === 'over' || side === 'under')) {
        const k = `${athleteId}|${typeId}|${o.point}`;
        if (!seen.has(k)) { seen.add(k); out.rows.push({ athleteId, teamId: null, typeId, line: o.point, lastUpdated: m.last_update }); }
        price(`${g.id}|prop|${side}|${athleteId}|${typeId}@${o.point}`, o, m.last_update);
      }
    }
  }
  return out;
}
