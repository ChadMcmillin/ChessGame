// Pure betting math. No DOM, no network — runs in the browser and under `node --test`.

export const SD_MARGIN = 13.2; // std dev of NFL final margin around the spread
export const SD_TOTAL = 13.4; // std dev of final total around the O/U
export const SD_TEAM = 9.6; // std dev of one team's points
export const HFA = 1.6; // home field, points
export const EST_PROP_PRICE = -114; // typical DraftKings O/U prop juice when the feed has no price
const W_PRE = 0.3; // how far we move off the market toward our own number, pregame
const W_LIVE = 0.4; // live
const W_PROP = 0.5;

// ---------- odds helpers ----------
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
export function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= Math.floor(k); i++) { term *= lambda / i; sum += term; }
  return Math.min(1, sum);
}
export const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const impliedProb = (a) => 1 / toDecimal(a);
export const evPerUnit = (p, a) => p * (toDecimal(a) - 1) - (1 - p);
export function probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
export const fmtOdds = (a) => (a == null || isNaN(a) ? '—' : a > 0 ? `+${Math.round(a)}` : `${Math.round(a)}`);
export const fmtLine = (n) => (n > 0 ? `+${n}` : `${n}`);
// Quarter-Kelly, in units where 1u = 1% of bankroll, clamped to something sane.
export function units(p, a) {
  const b = toDecimal(a) - 1;
  const k = (p * b - (1 - p)) / b;
  if (k <= 0) return 0;
  return Math.max(0.25, Math.min(2, Math.round(k * 25 * 4) / 4));
}
export function grade(ev) {
  return ev >= 0.06 ? 'A' : ev >= 0.03 ? 'B' : ev >= 0.01 ? 'C' : null;
}

// ---------- team ratings from this season's results ----------
// games: [{home, away, hs, as}] (team ids, final scores)
export function buildRatings(games) {
  const teams = {};
  let pts = 0;
  for (const g of games) {
    pts += g.hs + g.as;
    for (const t of [g.home, g.away]) teams[t] ??= { off: 0, def: 0, n: 0 };
  }
  if (!games.length) return { teams, avg: 22, n: 0 };
  const avg = pts / (games.length * 2);
  for (let it = 0; it < 40; it++) {
    const acc = {};
    for (const t in teams) acc[t] = { o: 0, d: 0, n: 0 };
    for (const g of games) {
      const h = teams[g.home], a = teams[g.away];
      acc[g.home].o += g.hs - avg - a.def - HFA / 2;
      acc[g.home].d += g.as - avg - a.off + HFA / 2;
      acc[g.away].o += g.as - avg - h.def + HFA / 2;
      acc[g.away].d += g.hs - avg - h.off - HFA / 2;
      acc[g.home].n++; acc[g.away].n++;
    }
    for (const t in teams) {
      const { o, d, n } = acc[t];
      const shrink = n / (n + 3); // regress small samples to league average
      teams[t] = { off: (o / n) * shrink, def: (d / n) * shrink, n };
    }
  }
  return { teams, avg, n: games.length };
}
export function ratingProjection(r, homeId, awayId) {
  const h = r?.teams?.[homeId], a = r?.teams?.[awayId];
  if (!h || !a || h.n < 3 || a.n < 3) return null;
  const hp = r.avg + h.off + a.def + HFA / 2;
  const ap = r.avg + a.off + h.def - HFA / 2;
  return { margin: hp - ap, total: hp + ap, hp, ap };
}

// ---------- game state ----------
export function secondsRemaining(g) {
  if (g.state === 'post') return 0;
  if (g.state === 'pre') return 3600;
  if (g.period > 4) return Math.min(g.clock ?? 0, 600);
  return (4 - g.period) * 900 + (g.clock ?? 0);
}
// Expected points for the offense given yards to the end zone and down.
function possessionValue(g) {
  const s = g.situation;
  if (!s || !s.possession || s.yardsToEndzone == null) return 0;
  let ep = 5.8 - 0.066 * s.yardsToEndzone;
  if (s.down > 1) ep -= 0.45 * (s.down - 1);
  return s.possession === g.home.id ? ep : -ep;
}

function mkPick(g, o) {
  const breakeven = impliedProb(o.price);
  const ev = evPerUnit(o.prob, o.price);
  return {
    gameId: g.id, live: g.state === 'in', matchup: `${g.away.abbr} @ ${g.home.abbr}`,
    priceEst: false, ...o, breakeven, ev, grade: grade(ev), units: units(o.prob, o.price),
    id: [g.id, o.market, o.side, o.athleteId || '', o.typeId || ''].join('|'),
  };
}

// Central projection for a game: expected final margin (home) and total, pregame or live.
export function projectGame(g, ratings, pre, espnWp) {
  const o = g.odds;
  const rp = ratingProjection(ratings, g.home.id, g.away.id);
  const live = g.state === 'in';
  const sec = secondsRemaining(g);
  const f = sec / 3600;
  // Baseline full-game expectation: pregame market number nudged toward our ratings.
  const mktM0 = pre?.spreadHome != null ? -pre.spreadHome : o?.open?.spreadHome != null ? -o.open.spreadHome : null;
  const mktT0 = pre?.total ?? o?.open?.total ?? null;
  let m0 = mktM0, t0 = mktT0;
  if (rp) {
    m0 = m0 == null ? rp.margin : m0 + W_PRE * (rp.margin - m0);
    t0 = t0 == null ? rp.total : t0 + W_PRE * (rp.total - t0);
  }
  if (m0 == null || t0 == null) return null;
  if (!live) return { live, f: 1, margin: m0, total: t0, sdM: SD_MARGIN, sdT: SD_TOTAL, rp, m0, t0 };
  const diff = g.home.score - g.away.score, pts = g.home.score + g.away.score;
  const pv = possessionValue(g);
  const elapsed = 1 - f;
  // Remaining scoring: pregame pace, blended with how this game is actually playing.
  let rate = t0;
  if (elapsed > 0.2) rate = 0.6 * t0 + 0.4 * (pts / elapsed);
  const sq = Math.sqrt(Math.max(f, 0.004));
  let pWin = null;
  const margin = diff + m0 * f + pv;
  const sdM = SD_MARGIN * sq;
  pWin = 1 - normCdf((0 - margin) / sdM);
  if (espnWp != null) pWin = (pWin + espnWp) / 2;
  return { live, f, sec, margin, total: pts + rate * f + Math.abs(pv) * 0.5, sdM, sdT: SD_TOTAL * sq, rp, m0, t0, pWin, diff, pts };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clockTxt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} left`;

// Spread / total / moneyline picks against the current DraftKings line.
export function evaluateGame(g, ratings, pre, espnWp) {
  const o = g.odds;
  if (!o || g.state === 'post') return { picks: [], proj: null };
  const proj = projectGame(g, ratings, pre, espnWp);
  if (!proj) return { picks: [], proj };
  const w = proj.live ? W_LIVE : W_PRE;
  const picks = [];
  const H = g.home.abbr, A = g.away.abbr;
  const liveNote = proj.live ? ` · ${clockTxt(proj.sec)}` : '';
  const fav = (m) => (Math.abs(m) < 0.25 ? 'pick’em' : `${m > 0 ? H : A} -${Math.abs(m).toFixed(1)}`);

  if (o.spreadHome != null && o.spreadHomePrice != null && o.spreadAwayPrice != null) {
    const mkt = -o.spreadHome;
    // Pregame, a big disagreement with the market is mostly model error, so cap it.
    const mine = proj.live ? proj.margin : proj.rp ? clamp(proj.rp.margin, mkt - 6, mkt + 6) : mkt;
    // Live, a huge gap between the feed's line and the scoreboard means the line is stale, not a gift.
    if (Math.abs(mine - mkt) <= 7) {
      const fair = mkt + w * (mine - mkt);
      const pHome = 1 - normCdf((mkt - fair) / proj.sdM);
      const moved = !proj.live && o.open?.spreadHome != null && o.open.spreadHome !== o.spreadHome
        ? ` · opened ${H} ${fmtLine(o.open.spreadHome)}` : '';
      const reason = `${proj.live ? 'Projected finish' : 'Model'} ${fav(mine)} vs DK ${fav(mkt)}${moved}${liveNote}`;
      picks.push(mkPick(g, { market: 'spread', side: 'home', label: `${H} ${fmtLine(o.spreadHome)}`, line: o.spreadHome, price: o.spreadHomePrice, prob: pHome, reason }));
      picks.push(mkPick(g, { market: 'spread', side: 'away', label: `${A} ${fmtLine(-o.spreadHome)}`, line: -o.spreadHome, price: o.spreadAwayPrice, prob: 1 - pHome, reason }));
    }
  }
  if (o.total != null && o.overPrice != null && o.underPrice != null) {
    const mkt = o.total;
    const mine = proj.live ? proj.total : proj.rp ? clamp(proj.rp.total, mkt - 7, mkt + 7) : mkt;
    if (Math.abs(mine - mkt) <= 9 && (!proj.live || mkt > proj.pts)) {
      const fair = mkt + w * (mine - mkt);
      const pOver = 1 - normCdf((mkt - fair) / proj.sdT);
      const moved = !proj.live && o.open?.total != null && o.open.total !== o.total ? ` · opened ${o.open.total}` : '';
      const reason = `${proj.live ? 'Projected final total' : 'Model total'} ${mine.toFixed(1)} vs DK ${mkt}${moved}${liveNote}`;
      picks.push(mkPick(g, { market: 'total', side: 'over', label: `Over ${mkt}`, line: mkt, price: o.overPrice, prob: pOver, reason }));
      picks.push(mkPick(g, { market: 'total', side: 'under', label: `Under ${mkt}`, line: mkt, price: o.underPrice, prob: 1 - pOver, reason }));
    }
  }
  if (o.mlHome != null && o.mlAway != null) {
    const ih = impliedProb(o.mlHome), ia = impliedProb(o.mlAway);
    const mktP = ih / (ih + ia); // no-vig market probability
    const rawP = proj.live ? proj.pWin : 1 - normCdf((0 - (proj.rp ? proj.rp.margin : proj.m0)) / SD_MARGIN);
    const mineP = proj.live ? rawP : clamp(rawP, mktP - 0.15, mktP + 0.15);
    if (Math.abs(mineP - mktP) <= 0.2) {
      const pHome = mktP + w * (mineP - mktP);
      const reason = `Model ${H} ${(mineP * 100).toFixed(0)}% to win vs DK no-vig ${(mktP * 100).toFixed(0)}%${liveNote}`;
      picks.push(mkPick(g, { market: 'ml', side: 'home', label: `${H} ML`, price: o.mlHome, prob: pHome, reason }));
      picks.push(mkPick(g, { market: 'ml', side: 'away', label: `${A} ML`, price: o.mlAway, prob: 1 - pHome, reason }));
    }
  }
  return { picks, proj };
}

// ---------- player props ----------
// typeId -> how to read the stat. dist: 'n' normal, 'p' poisson, 'max' longest-play (pregame only)
export const PROP_TYPES = {
  8: { stats: ['passingYards'], short: 'Pass Yds', cv: 0.28 },
  9: { stats: ['completions'], short: 'Completions', cv: 0.22 },
  10: { stats: ['passingTouchdowns'], short: 'Pass TDs', dist: 'p' },
  15: { stats: ['interceptions'], short: 'INTs', dist: 'p', cat: 'passing' },
  16: { stats: ['passingAttempts'], short: 'Pass Att', cv: 0.2 },
  17: { stats: ['longPassing'], short: 'Longest Completion', cv: 0.4, dist: 'max' },
  18: { stats: ['passingYards', 'rushingYards'], short: 'Pass+Rush Yds', cv: 0.27 },
  11: { stats: ['rushingAttempts'], short: 'Carries', cv: 0.35 },
  12: { stats: ['rushingYards'], short: 'Rush Yds', cv: 0.55 },
  13: { stats: ['receivingYards'], short: 'Rec Yds', cv: 0.62 },
  14: { stats: ['receptions'], short: 'Receptions', cv: 0.48 },
  19: { stats: ['longReception'], short: 'Longest Reception', cv: 0.55, dist: 'max' },
  20: { stats: ['rushingYards', 'receivingYards'], short: 'Rush+Rec Yds', cv: 0.5 },
  21: { stats: ['longRushing'], short: 'Longest Rush', cv: 0.6, dist: 'max' },
  22: { stats: ['totalKickingPoints'], short: 'Kicking Pts', cv: 0.5 },
  23: { stats: ['extraPointsMade'], short: 'XPs Made', dist: 'p' },
  24: { stats: ['fieldGoalsMade'], short: 'FGs Made', dist: 'p' },
  25: { stats: ['assistTackles'], short: 'Assists', cv: 0.6 },
  26: { stats: ['soloTackles'], short: 'Solo Tackles', cv: 0.5 },
  27: { stats: ['totalTackles'], short: 'Tackles+Ast', cv: 0.42 },
  28: { stats: ['sacks'], short: 'Sacks', dist: 'p' },
};
export const MILESTONE_TYPES = {
  194: { stats: ['passingYards'], short: 'Pass Yds', cv: 0.28 },
  195: { stats: ['receivingYards'], short: 'Rec Yds', cv: 0.62 },
  196: { stats: ['rushingYards'], short: 'Rush Yds', cv: 0.55 },
  197: { stats: ['rushingYards', 'receivingYards'], short: 'Rush+Rec Yds', cv: 0.5 },
};
export const TD_TYPES = { 31: 'Anytime TD', 32: '2+ TDs' };

// values: per-game numbers, most recent first
export function projectStat(values, cv = 0.5) {
  const n = values.length;
  if (n < 3) return null;
  let sw = 0, sx = 0;
  values.forEach((v, i) => { const w = 0.88 ** i; sw += w; sx += w * v; });
  const mean = sx / sw;
  let sv = 0;
  values.forEach((v, i) => { sv += 0.88 ** i * (v - mean) ** 2; });
  const prior = (cv * mean) ** 2;
  const sd = Math.sqrt((n * (sv / sw) + 3 * prior) / (n + 3)) || 1;
  const recent = values.slice(0, 4).reduce((a, b) => a + b, 0) / Math.min(4, n);
  const season = values.reduce((a, b) => a + b, 0) / n;
  return { mean, sd: Math.max(sd, 0.5), n, recent, season };
}

const sumStats = (row, stats) => {
  let t = 0;
  for (const s of stats) { if (row[s] == null) return null; t += row[s]; }
  return t;
};
export function seriesFor(log, stats) {
  return (log || []).map((r) => sumStats(r, stats)).filter((v) => v != null);
}

// P(final > line) given a pregame projection and, when live, what the player already has.
function probOver(def, pj, line, liveCtx) {
  const dist = def.dist || 'n';
  let mu = pj.mean, sd = pj.sd, cur = 0;
  if (liveCtx) {
    if (dist === 'max') return null;
    const { f, cur: c } = liveCtx;
    cur = c;
    const elapsed = 1 - f;
    let rate = pj.mean;
    if (elapsed > 0.25) rate = 0.5 * pj.mean + 0.5 * (cur / elapsed);
    mu = rate * f;
    sd = pj.sd * Math.sqrt(Math.max(f, 0.004));
  }
  // Shrink our number halfway toward what the line implies; the market is sharp.
  const target = line - cur;
  const muAdj = Math.max(0.01, target + W_PROP * (mu - target));
  const p = dist === 'p' ? 1 - poissonCdf(Math.floor(target), muAdj) : 1 - normCdf((target - muAdj) / sd);
  return { p: Math.min(0.97, Math.max(0.03, p)), proj: cur + mu };
}

/**
 * props:   [{athleteId, typeId, line, openLine}] deduped DraftKings lines
 * players: {athleteId: {name, pos, teamId}}
 * logs:    {athleteId: [{statName: number}]} most recent game first
 * box:     {athleteId: {statName: number}} live box score
 * Returns { picks, tds, ladders } — picks are O/U bets, tds/ladders are fair-price tables.
 */
export function evaluateProps(g, props, players, logs, box, proj) {
  const out = { picks: [], tds: [], ladders: [] };
  if (g.state === 'post') return out;
  const live = g.state === 'in';
  const f = live ? secondsRemaining(g) / 3600 : 1;
  const implied = (teamId) => {
    if (!proj) return 22;
    const sign = teamId === g.home.id ? 1 : -1;
    return Math.max(6, (proj.t0 + sign * proj.m0) / 2);
  };
  for (const pr of props) {
    const pl = players[pr.athleteId];
    const log = logs[pr.athleteId];
    if (!pl || !log) continue;
    const cur = box?.[pr.athleteId];
    const def = PROP_TYPES[pr.typeId];
    const ms = MILESTONE_TYPES[pr.typeId];
    if (def && pr.line != null) {
      const vals = seriesFor(log, def.stats);
      const pj = projectStat(vals, def.cv);
      if (!pj) continue;
      let liveCtx = null;
      if (live) {
        const c = cur ? sumStats(cur, def.stats) ?? 0 : 0;
        if (c > pr.line) continue; // already cashed
        liveCtx = { f, cur: c };
      }
      const r = probOver(def, pj, pr.line, liveCtx);
      if (!r) continue;
      const hits = vals.filter((v) => v > pr.line).length;
      const base = {
        market: 'prop', athleteId: pr.athleteId, typeId: pr.typeId, player: pl.name, pos: pl.pos, line: pr.line,
        price: EST_PROP_PRICE, priceEst: true, projection: r.proj, stat: def.short, current: liveCtx?.cur,
        // Live, only trust a prop line the feed has refreshed in the last 10 minutes.
        stale: live && !(pr.lastUpdated && Date.now() - Date.parse(pr.lastUpdated) < 10 * 6e4),
      };
      const reason = live
        ? `Has ${liveCtx.cur}, on pace for ${r.proj.toFixed(1)} · line ${pr.line}`
        : `Projects ${r.proj.toFixed(1)} · last 4 avg ${pj.recent.toFixed(1)}, season ${pj.season.toFixed(1)} · over in ${hits} of ${pj.n}`;
      // Count markets (sacks, TDs, FGs) are never priced near -114, so they get a fair price, not a grade.
      // And when we are miles from the line, the player's role has probably changed — don't bet our stale number.
      const flags = {
        fairOnly: def.dist === 'p',
        suspect: def.dist !== 'p' && !live && Math.abs(pj.mean - pr.line) > Math.max(0.25 * pr.line, 1.5),
      };
      for (const [side, prob] of [['over', r.p], ['under', 1 - r.p]]) {
        const pk = mkPick(g, { ...base, ...flags, side, label: `${pl.name} ${side === 'over' ? 'Over' : 'Under'} ${pr.line} ${def.short}`, prob, reason });
        // A live line that hasn't moved since kickoff is not a price you can actually get.
        if (flags.fairOnly || flags.suspect || base.stale) { pk.grade = null; pk.units = 0; pk.fair = probToAmerican(prob); }
        out.picks.push(pk);
      }
    } else if (ms && pr.line != null && !live) {
      const pj = projectStat(seriesFor(log, ms.stats), ms.cv);
      if (!pj) continue;
      const p = Math.min(0.97, Math.max(0.02, 1 - normCdf((pr.line - 0.5 - pj.mean) / pj.sd)));
      out.ladders.push({ athleteId: pr.athleteId, player: pl.name, pos: pl.pos, stat: ms.short, line: pr.line, prob: p, fair: probToAmerican(p) });
    } else if (TD_TYPES[pr.typeId]) {
      const tdStats = pl.pos === 'QB' ? ['rushingTouchdowns'] : ['rushingTouchdowns', 'receivingTouchdowns'];
      const vals = (log || []).map((r) => tdStats.reduce((t, s) => t + (r[s] || 0), 0));
      if (vals.length < 3) continue;
      const have = cur ? tdStats.reduce((t, s) => t + (cur[s] || 0), 0) : 0;
      const need = (pr.typeId === '32' ? 2 : 1) - have;
      if (need <= 0) continue;
      const raw = vals.reduce((a, b) => a + b, 0) / vals.length;
      const lam = Math.max(0.01, raw * (vals.length / (vals.length + 2)) * (implied(pl.teamId) / 22) * f);
      const p = Math.min(0.9, 1 - poissonCdf(need - 1, lam));
      out.tds.push({ athleteId: pr.athleteId, player: pl.name, pos: pl.pos, kind: TD_TYPES[pr.typeId], prob: p, fair: probToAmerican(p), rate: raw });
    }
  }
  return out;
}

// Team total points (DK alt ladder; we grade the rung nearest the implied team total).
export function evaluateTeamTotals(g, rows, proj) {
  if (!proj || g.state === 'post') return [];
  const picks = [];
  for (const side of ['home', 'away']) {
    const team = g[side];
    const lines = rows.filter((r) => r.teamId === team.id).map((r) => r.line);
    if (!lines.length) continue;
    const exp = (proj.total + (side === 'home' ? 1 : -1) * proj.margin) / 2;
    const line = lines.reduce((b, l) => (Math.abs(l - exp) < Math.abs(b - exp) ? l : b));
    if (proj.live && team.score > line) continue;
    const sd = SD_TEAM * Math.sqrt(Math.max(proj.f, 0.004));
    const fair = line + 0.4 * (exp - line);
    const p = Math.min(0.95, Math.max(0.05, 1 - normCdf((line - fair) / sd)));
    const base = { market: 'teamtotal', line, price: EST_PROP_PRICE, priceEst: true, typeId: team.id,
      reason: `Projects ${team.abbr} for ${exp.toFixed(1)} points vs line ${line}` };
    picks.push(mkPick(g, { ...base, side: 'over', label: `${team.abbr} Team Total Over ${line}`, prob: p }));
    picks.push(mkPick(g, { ...base, side: 'under', label: `${team.abbr} Team Total Under ${line}`, prob: 1 - p }));
  }
  return picks;
}

// Keep the better side of each market, ranked by expected value.
export function rankPicks(picks) {
  const best = new Map();
  for (const p of picks) {
    if (!p.grade) continue;
    const k = [p.gameId, p.market, p.athleteId || '', p.typeId || ''].join('|');
    if (!best.has(k) || best.get(k).ev < p.ev) best.set(k, p);
  }
  // Estimated-price props rank below real-price bets at the same EV.
  const score = (p) => p.ev - (p.priceEst ? 0.01 : 0) - (p.stale ? 0.02 : 0);
  return [...best.values()].sort((a, b) => score(b) - score(a));
}

// ---------- settling tracked bets ----------
export function settle(bet, g, box) {
  if (!g) return { status: 'open' };
  const done = g.state === 'post';
  const hs = g.home.score, as = g.away.score;
  let cur, target = bet.line, over = bet.side === 'over';
  if (bet.market === 'spread') {
    const m = (bet.side === 'home' ? hs - as : as - hs) + bet.line;
    return { status: !done ? 'open' : m > 0 ? 'won' : m < 0 ? 'lost' : 'push', note: `${g.away.abbr} ${as} – ${g.home.abbr} ${hs}`, winning: m > 0 };
  }
  if (bet.market === 'ml') {
    const m = bet.side === 'home' ? hs - as : as - hs;
    return { status: !done ? 'open' : m > 0 ? 'won' : m < 0 ? 'lost' : 'push', note: `${g.away.abbr} ${as} – ${g.home.abbr} ${hs}`, winning: m > 0 };
  }
  if (bet.market === 'total') cur = hs + as;
  else if (bet.market === 'teamtotal') cur = bet.typeId === g.home.id ? hs : as;
  else if (bet.market === 'prop') {
    const def = PROP_TYPES[bet.typeId];
    const row = box?.[bet.athleteId];
    cur = row && def ? sumStats(row, def.stats) ?? 0 : g.state === 'pre' ? 0 : null;
    if (cur == null) return { status: 'open' };
  }
  let status = 'open';
  if (over && cur > target) status = 'won';
  else if (done) status = cur === target ? 'push' : over ? 'lost' : cur < target ? 'won' : 'lost';
  else if (!over && cur > target) status = 'lost';
  return { status, cur, target, winning: over ? cur > target : cur < target };
}
