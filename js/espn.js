// Data layer. ESPN's public NFL feed carries DraftKings as its odds provider (provider id 100),
// and every endpoint here sends `access-control-allow-origin: *`, so the phone calls it directly.

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl';
const DK = '100';

const mem = new Map();
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {
      // Storage full: drop the bulky caches and carry on in memory.
      try { Object.keys(localStorage).filter((x) => x.startsWith('c:')).forEach((x) => localStorage.removeItem(x)); } catch {}
    }
  },
};

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Cache `fn()` for ttl ms in memory, optionally persisted across reloads.
async function cached(key, ttl, fn, persist = false) {
  const now = Date.now();
  let hit = mem.get(key) || (persist ? store.get('c:' + key) : null);
  if (hit && now - hit.t < ttl) { mem.set(key, hit); return hit.v; }
  if (hit?.p) return hit.p; // request already in flight
  const p = fn().then((v) => {
    const e = { t: Date.now(), v };
    mem.set(key, e);
    if (persist) store.set('c:' + key, e);
    return v;
  }).catch((err) => {
    if (hit?.v !== undefined) { mem.set(key, { t: hit.t, v: hit.v }); return hit.v; } // serve stale on error
    mem.delete(key);
    throw err;
  });
  mem.set(key, { t: hit?.t || 0, v: hit?.v, p });
  return p;
}

const num = (x) => { const n = parseFloat(String(x ?? '').replace(/[ou,]/g, '')); return isNaN(n) ? null : n; };
const price = (x) => (String(x).toUpperCase() === 'EVEN' ? 100 : num(x));

function normTeam(c) {
  const t = c.team;
  return {
    id: t.id, abbr: t.abbreviation, name: t.shortDisplayName || t.name, full: t.displayName,
    color: '#' + (t.color || '555555'), logo: t.logo || `https://a.espncdn.com/i/teamlogos/nfl/500/${t.abbreviation.toLowerCase()}.png`,
    score: num(c.score) ?? 0, record: c.records?.find((r) => r.type === 'total')?.summary || '',
    lines: (c.linescores || []).map((l) => num(l.value ?? l.displayValue) ?? 0),
  };
}

function normOdds(list) {
  const o = (list || []).find((x) => x.provider?.id === DK) || (list || [])[0];
  if (!o) return null;
  const ps = o.pointSpread, tot = o.total, ml = o.moneyline;
  const cur = (x) => x?.close || x?.current;
  const out = {
    provider: o.provider?.name === 'Draft Kings' ? 'DraftKings' : o.provider?.name || 'DraftKings',
    spreadHome: num(cur(ps?.home)?.line) ?? (o.spread ?? null),
    spreadHomePrice: price(cur(ps?.home)?.odds) ?? o.homeTeamOdds?.spreadOdds ?? null,
    spreadAwayPrice: price(cur(ps?.away)?.odds) ?? o.awayTeamOdds?.spreadOdds ?? null,
    total: num(cur(tot?.over)?.line) ?? o.overUnder ?? null,
    overPrice: price(cur(tot?.over)?.odds) ?? o.overOdds ?? null,
    underPrice: price(cur(tot?.under)?.odds) ?? o.underOdds ?? null,
    mlHome: price(cur(ml?.home)?.odds) ?? o.homeTeamOdds?.moneyLine ?? null,
    mlAway: price(cur(ml?.away)?.odds) ?? o.awayTeamOdds?.moneyLine ?? null,
    open: { spreadHome: num(ps?.home?.open?.line), total: num(tot?.over?.open?.line), mlHome: price(ml?.home?.open?.odds), mlAway: price(ml?.away?.open?.odds) },
    link: (cur(ml?.home)?.link?.href || o.links?.[0]?.href || '').match(/preurl=([^&]+)/)?.[1],
  };
  if (out.link) out.link = decodeURIComponent(out.link).split('?')[0];
  // DraftKings' own ids for each game-line selection; adding them to the link pre-fills the bet slip.
  const oc = (x) => { try { return decodeURIComponent(cur(x)?.link?.href || '').match(/outcomes=([\w]+)/)?.[1] || null; } catch { return null; } };
  out.slip = { 'ml|home': oc(ml?.home), 'ml|away': oc(ml?.away), 'spread|home': oc(ps?.home), 'spread|away': oc(ps?.away), 'total|over': oc(tot?.over), 'total|under': oc(tot?.under) };
  return out;
}

function normSituation(s, home, away) {
  if (!s) return null;
  const poss = s.possession || null;
  const yl = s.yardLine ?? null; // yards from the HOME goal line
  let yte = s.yardsToEndzone ?? null;
  if (yte == null && yl != null && poss) yte = poss === home.id ? 100 - yl : yl;
  return {
    possession: poss, yardLine: yl, yardsToEndzone: yte, down: s.down > 0 ? s.down : null, distance: s.distance,
    text: s.downDistanceText || s.shortDownDistanceText || '', redZone: !!s.isRedZone,
    lastPlay: s.lastPlay?.text || '', homeTO: s.homeTimeouts, awayTO: s.awayTimeouts,
    wpHome: s.lastPlay?.probability?.homeWinPercentage ?? null,
  };
}

function normEvent(e) {
  const c = e.competitions[0];
  const home = normTeam(c.competitors.find((x) => x.homeAway === 'home'));
  const away = normTeam(c.competitors.find((x) => x.homeAway === 'away'));
  const st = c.status || e.status;
  return {
    id: e.id, date: e.date, state: st.type.state, detail: st.type.shortDetail, statusName: st.type.name,
    period: st.period || 0, clock: st.clock ?? 0, displayClock: st.displayClock,
    home, away, odds: normOdds(c.odds), situation: normSituation(c.situation, home, away),
    tv: c.broadcast || c.broadcasts?.[0]?.names?.[0] || '', venue: c.venue?.fullName || '',
    weather: e.weather ? `${e.weather.temperature ?? e.weather.highTemperature}° ${e.weather.displayValue || ''}`.trim() : '',
  };
}

export async function scoreboard() {
  const d = await getJson(`${SITE}/scoreboard`);
  return { season: d.season?.year, seasonType: d.season?.type, week: d.week?.number, games: (d.events || []).flatMap((e) => { try { return [normEvent(e)]; } catch (err) { console.error('skipped a game the feed sent in an unexpected shape', err); return []; } }) };
}

// Every completed regular-season game so far, for team ratings. Past weeks are cached for good.
export async function seasonResults(season, seasonType, week) {
  const lastWeek = seasonType === 2 ? week : seasonType > 2 ? 18 : 0;
  const weeks = await Promise.all(Array.from({ length: lastWeek }, (_, i) => i + 1).map((w) => {
    const final = seasonType !== 2 || w < week - 1;
    return cached(`res:${season}:${w}`, final ? 30 * 864e5 : 10 * 6e4, async () => {
      const d = await getJson(`${SITE}/scoreboard?seasontype=2&week=${w}&dates=${season}`);
      return (d.events || []).map(normEvent).filter((g) => g.state === 'post')
        .map((g) => ({ home: g.home.id, away: g.away.id, hs: g.home.score, as: g.away.score }));
    }, true).catch(() => []);
  }));
  return weeks.flat();
}

// One game's deep data: drives, box score, win probability, injuries.
export function summary(id, live) {
  return cached(`sum:${id}`, live ? 9000 : 5 * 6e4, async () => {
    const d = await getJson(`${SITE}/summary?event=${id}`);
    const box = {}, names = {};
    for (const t of d.boxscore?.players || []) {
      for (const cat of t.statistics || []) {
        for (const a of cat.athletes || []) {
          const row = (box[a.athlete.id] ??= {});
          names[a.athlete.id] = { name: a.athlete.displayName, teamId: t.team.id };
          cat.keys.forEach((k, i) => splitStat(k, a.stats[i], row, cat.name === 'passing'));
        }
      }
    }
    const drives = [...(d.drives?.previous || []), ...(d.drives?.current ? [d.drives.current] : [])];
    const seen = new Set();
    return {
      box, names,
      drives: drives.filter((x) => x && !seen.has(x.id) && seen.add(x.id)).map((x) => ({
        team: x.team?.abbreviation, result: x.displayResult || 'In progress', desc: x.description || '', score: !!x.isScore,
        plays: (x.plays || []).slice(-4).map((p) => ({ text: p.text, clock: p.clock?.displayValue, q: p.period?.number, score: p.scoringPlay })),
      })),
      wp: (d.winprobability || []).map((w) => w.homeWinPercentage),
      predictor: d.predictor ? { home: num(d.predictor.homeTeam?.gameProjection), away: num(d.predictor.awayTeam?.gameProjection) } : null,
      injuries: (d.injuries || []).map((t) => ({
        team: t.team?.abbreviation,
        list: (t.injuries || []).map((i) => ({ name: i.athlete?.displayName, pos: i.athlete?.position?.abbreviation, status: i.status, what: i.details?.type || '' })),
      })),
      scoring: (d.scoringPlays || []).map((p) => ({ text: p.text, q: p.period?.number, clock: p.clock?.displayValue, team: p.team?.abbreviation, score: `${p.awayScore}-${p.homeScore}` })),
      teamStats: (d.boxscore?.teams || []).map((t) => ({ abbr: t.team?.abbreviation, stats: Object.fromEntries((t.statistics || []).map((s) => [s.name, s.displayValue])) })),
    };
  });
}

// "completions/passingAttempts": "15/29" and "sacks-sackYardsLost": "3-25" style pairs get split.
function splitStat(key, val, row, priority) {
  const ks = key.split(/[\/]|-(?=[a-zA-Z])/), vs = String(val ?? '');
  const parts = ks.length > 1 ? vs.split(/[\/-]/) : [vs];
  ks.forEach((k, i) => {
    const n = num(parts[i]);
    if (n == null) return;
    if (row[k] == null || priority) row[k] = n;
  });
  if (row.totalTackles != null && row.soloTackles != null) row.assistTackles = row.totalTackles - row.soloTackles;
}

const refId = (o, kind) => o?.$ref?.match(new RegExp(`${kind}/(\\d+)`))?.[1] || null;

// All DraftKings prop lines for a game, deduped (the feed lists each side as its own row).
export function props(id, live) {
  return cached(`props:${id}`, live ? 45e3 : 4 * 6e4, async () => {
    const base = `${CORE}/events/${id}/competitions/${id}/odds/${DK}/propBets?limit=1000`;
    const first = await getJson(base);
    const pages = [first];
    for (let p = 2; p <= Math.min(first.pageCount || 1, 5); p++) pages.push(await getJson(`${base}&page=${p}`));
    const seen = new Set(), out = [];
    for (const it of pages.flatMap((p) => p.items || [])) {
      const row = {
        athleteId: refId(it.athlete, 'athletes'), teamId: refId(it.team, 'teams'), typeId: it.type?.id, typeName: it.type?.name,
        line: it.current?.target?.value ?? null, openLine: it.open?.target?.value ?? null, lastUpdated: it.lastUpdated,
      };
      const k = [row.athleteId, row.teamId, row.typeId, row.line].join('|');
      if (!seen.has(k)) { seen.add(k); out.push(row); }
    }
    return out;
  });
}

export function roster(teamId) {
  return cached(`roster:${teamId}`, 12 * 36e5, async () => {
    const d = await getJson(`${SITE}/teams/${teamId}/roster`);
    const out = {};
    for (const grp of d.athletes || []) {
      for (const a of grp.items || []) out[a.id] = { name: a.displayName, pos: a.position?.abbreviation || '', teamId };
    }
    return out;
  }, true);
}

// A player's game-by-game stat lines this regular season, most recent first.
export function gamelog(athleteId) {
  return cached(`log:${athleteId}`, 12 * 36e5, async () => {
    const d = await getJson(`${WEB}/athletes/${athleteId}/gamelog`);
    const names = d.names || [];
    const reg = (d.seasonTypes || []).find((s) => /regular/i.test(s.displayName)) || d.seasonTypes?.[0];
    const events = reg?.categories?.flatMap((c) => c.events || []) || [];
    return events.map((ev) => {
      const row = {};
      names.forEach((k, i) => splitStat(k, ev.stats[i], row, false));
      return row;
    });
  }, true);
}

// Run async jobs with a concurrency cap so a 13-game slate doesn't open 800 sockets at once.
export async function pool(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
