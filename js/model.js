// Pure betting math. No DOM, no network — runs in the browser and under `node --test`.

export const SD_MARGIN = 13.2; // std dev of NFL final margin around the spread
export const SD_TOTAL = 13.4; // std dev of final total around the O/U
export const SD_TEAM = 9.6; // std dev of one team's points
export const HFA = 1.6; // home field, points
export const EST_PROP_PRICE = -114; // typical DraftKings price on a yardage-style over/under
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
  const id = [g.id, o.market, o.side, o.athleteId || '', o.typeId || ''].join('|');
  const ev = evPerUnit(o.prob, o.price);
  return {
    gameId: g.id, live: g.state === 'in', matchup: `${g.away.abbr} @ ${g.home.abbr}`, ...o, id, key: id,
    breakeven: impliedProb(o.price), ev, grade: grade(ev), units: units(o.prob, o.price),
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
  9: { stats: ['completions'], short: 'Completions', cv: 0.22, count: true },
  10: { stats: ['passingTouchdowns'], short: 'Pass TDs', dist: 'p' },
  15: { stats: ['interceptions'], short: 'INTs', dist: 'p', cat: 'passing' },
  16: { stats: ['passingAttempts'], short: 'Pass Att', cv: 0.2, count: true },
  17: { stats: ['longPassing'], short: 'Longest Completion', cv: 0.4, dist: 'max' },
  18: { stats: ['passingYards', 'rushingYards'], short: 'Pass+Rush Yds', cv: 0.27 },
  11: { stats: ['rushingAttempts'], short: 'Carries', cv: 0.35, count: true },
  12: { stats: ['rushingYards'], short: 'Rush Yds', cv: 0.55 },
  13: { stats: ['receivingYards'], short: 'Rec Yds', cv: 0.62 },
  14: { stats: ['receptions'], short: 'Receptions', cv: 0.48, count: true },
  19: { stats: ['longReception'], short: 'Longest Reception', cv: 0.55, dist: 'max' },
  20: { stats: ['rushingYards', 'receivingYards'], short: 'Rush+Rec Yds', cv: 0.5 },
  21: { stats: ['longRushing'], short: 'Longest Rush', cv: 0.6, dist: 'max' },
  22: { stats: ['totalKickingPoints'], short: 'Kicking Pts', cv: 0.5 },
  23: { stats: ['extraPointsMade'], short: 'XPs Made', dist: 'p' },
  24: { stats: ['fieldGoalsMade'], short: 'FGs Made', dist: 'p' },
  25: { stats: ['assistTackles'], short: 'Assists', cv: 0.6, count: true },
  26: { stats: ['soloTackles'], short: 'Solo Tackles', cv: 0.5, count: true },
  27: { stats: ['totalTackles'], short: 'Tackles+Ast', cv: 0.42, count: true },
  28: { stats: ['sacks'], short: 'Sacks', dist: 'p' },
};
export const MILESTONE_TYPES = {
  194: { stats: ['passingYards'], short: 'Pass Yds', cv: 0.28 },
  195: { stats: ['receivingYards'], short: 'Rec Yds', cv: 0.62 },
  196: { stats: ['rushingYards'], short: 'Rush Yds', cv: 0.55 },
  197: { stats: ['rushingYards', 'receivingYards'], short: 'Rush+Rec Yds', cv: 0.5 },
  201: { stats: ['rushingAttempts'], short: 'Carries', cv: 0.35, count: true },
  202: { stats: ['receptions'], short: 'Receptions', cv: 0.48, count: true },
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
  let mu = pj.mean, sd = pj.sd, cur = 0;
  if (liveCtx) {
    if (def.dist === 'max') return null;
    const { f, cur: c } = liveCtx;
    cur = c;
    const elapsed = 1 - f;
    let rate = pj.mean;
    if (elapsed > 0.25) rate = 0.5 * pj.mean + 0.5 * (cur / elapsed);
    mu = rate * f;
    sd = pj.sd * Math.sqrt(Math.max(f, 0.004));
  }
  const target = line - cur;
  // Small whole-number markets (0.5 receptions, 1.5 sacks) are lumpy, so count them out exactly.
  const discrete = def.dist === 'p' || (def.count && target < 7);
  const p = discrete ? 1 - poissonCdf(Math.floor(target), Math.max(mu, 0.01)) : 1 - normCdf((target - mu) / sd);
  return { p: clamp(p, 0.03, 0.97), proj: cur + mu };
}

// ---------- props: pricing ----------
// The feed carries DraftKings' prop LINES but not their PRICES. A prop is therefore never graded
// on an invented price. It gets a "bet at X or better" threshold, and a real grade only once the
// actual DraftKings price is known (entered by the user).
const K_TWO_WAY = 0.95, K_ONE_WAY = 0.9; // rough share of a price that is probability rather than vig
const MIN_EV = 0.03;
const marketProb = (price, k) => Math.min(0.98, impliedProb(price) * k);
// Highest implied probability (the worst price) at which the bet still clears MIN_EV once the
// model's probability has been pulled toward the market's.
const beatImplied = (m, k) => (W_PROP * m) / (1 + MIN_EV - k * (1 - W_PROP));
// Yes-only markets (touchdown scorers, milestones) carry heavy vig and are mostly plus-money, where
// a few points of probability turn into a huge paper edge. So they get a bigger vig allowance, less
// trust in the model, and disagreement measured in relative (log-odds) terms rather than points.
const K_YES = 0.86, W_YES = 0.25, YES_CAP = 0.8;
const logit = (p) => Math.log(p / (1 - p)), expit = (x) => 1 / (1 + Math.exp(-x));
function yesProb(model, price) {
  const lq = logit(clamp(impliedProb(price) * K_YES, 0.005, 0.98));
  return expit(lq + W_YES * clamp(logit(clamp(model, 0.005, 0.98)) - lq, -YES_CAP, YES_CAP));
}
// Worst implied probability at which a yes-market still clears MIN_EV (null if none does).
function beatYes(model) {
  const ev = (i) => yesProb(model, probToAmerican(i)) / i - 1;
  let lo = 0.02, hi = 0.97;
  if (ev(lo) < MIN_EV) return null;
  for (let n = 0; n < 30; n++) { const mid = (lo + hi) / 2; if (ev(mid) >= MIN_EV) lo = mid; else hi = mid; }
  return lo;
}
export const propKey = (p) => `${p.id}@${p.line ?? ''}`;

// What a prop is worth at a given real price: the model's probability pulled toward the market's.
export function gradeAt(pk, price) {
  const k = pk.side === 'yes' ? K_ONE_WAY : K_TWO_WAY;
  const q = marketProb(price, k);
  // A model that is wildly off the market is more likely wrong than right, so cap the disagreement.
  const prob = pk.side === 'yes' ? yesProb(pk.model, price) : q + W_PROP * (clamp(pk.model, q - 0.15, q + 0.15) - q);
  const ev = evPerUnit(prob, price);
  // When a yes-market model is far beyond the cap from DraftKings' number, trust DraftKings: no grade.
  const wild = pk.side === 'yes' && Math.abs(logit(clamp(pk.model, 0.005, 0.98)) - logit(clamp(impliedProb(price) * K_YES, 0.005, 0.98))) > YES_CAP + 0.3;
  const gr = pk.suspect || wild ? null : grade(ev);
  return { prob, breakeven: impliedProb(price), ev, grade: gr, units: gr ? units(prob, price) : 0 };
}

function mkProp(g, o, prices) {
  const k = o.side === 'yes' ? K_ONE_WAY : K_TWO_WAY;
  const by = o.side === 'yes' ? beatYes(o.prob) : null;
  const bi = o.side === 'yes' ? by ?? 0 : clamp(beatImplied(o.prob, k), 0.02, 0.98);
  const pk = {
    gameId: g.id, live: g.state === 'in', matchup: `${g.away.abbr} @ ${g.home.abbr}`, ...o,
    id: [g.id, o.market, o.side, o.athleteId || '', o.typeId || ''].join('|'),
    model: o.prob, fair: probToAmerican(o.prob), beat: bi > 0 ? probToAmerican(bi) : null,
    price: null, needsPrice: true, breakeven: null, ev: null, grade: null, units: 0,
    // Worth flagging unpriced only where a near-even price is the norm and would clear the bar.
    lead: !!o.balanced && !o.suspect && !o.stale && bi >= impliedProb(EST_PROP_PRICE),
  };
  pk.key = propKey(pk);
  // A price is either one the user typed (a number) or a live DraftKings one ({p, src: 'dk'}).
  const hit = prices?.[pk.key];
  if (hit != null) {
    const price = typeof hit === 'object' ? hit.p : hit, src = typeof hit === 'object' ? hit.src : 'you';
    Object.assign(pk, { price, priceSrc: src, priceUser: src === 'you', needsPrice: false, lead: false }, gradeAt(pk, price));
    // A live DraftKings market that hasn't updated in 10 minutes is probably suspended.
    if (src === 'dk' && o.stale) { pk.grade = null; pk.units = 0; }
  }
  return pk;
}

/**
 * props:   [{athleteId, typeId, line, openLine, lastUpdated}] deduped DraftKings lines
 * players: {athleteId: {name, pos, teamId}}
 * logs:    {athleteId: [{statName: number}]} most recent game first
 * box:     {athleteId: {statName: number}} live box score
 * prices:  {propKey: american} real DraftKings prices the user has entered
 * Returns picks with market 'prop' (over/under), 'td' (touchdown scorer) or 'ms' (milestone).
 */
export function evaluateProps(g, props, players, logs, box, proj, prices) {
  const picks = [];
  if (g.state === 'post') return { picks };
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
    const who = { athleteId: pr.athleteId, typeId: pr.typeId, player: pl.name, pos: pl.pos };
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
        ...who, market: 'prop', line: pr.line, projection: r.proj, stat: def.short, current: liveCtx?.cur,
        // DraftKings prices yardage-style lines near even money; low lines (0.5 receptions) are lopsided.
        balanced: def.dist !== 'p' && pr.line >= 15,
        // Live, only trust a prop line the feed has refreshed in the last 10 minutes.
        stale: live && !(pr.lastUpdated && Date.now() - Date.parse(pr.lastUpdated) < 10 * 6e4),
        // Miles from the line pregame means the player's role has probably changed.
        suspect: def.dist !== 'p' && !live && pr.line >= 15 && Math.abs(pj.mean - pr.line) > 0.25 * pr.line,
        volume: !def.dist, // yards, attempts, catches: the stats that reveal a changed role
        reason: live
          ? `Has ${liveCtx.cur}, on pace for ${r.proj.toFixed(1)} · line ${pr.line}`
          : `Projects ${r.proj.toFixed(1)} · last 4 avg ${pj.recent.toFixed(1)}, season ${pj.season.toFixed(1)} · over in ${hits} of ${pj.n}`,
      };
      picks.push(mkProp(g, { ...base, side: 'over', label: `${pl.name} Over ${pr.line} ${def.short}`, prob: r.p }, prices));
      picks.push(mkProp(g, { ...base, side: 'under', label: `${pl.name} Under ${pr.line} ${def.short}`, prob: 1 - r.p }, prices));
    } else if (ms && pr.line != null && !live) {
      const vals = seriesFor(log, ms.stats);
      const pj = projectStat(vals, ms.cv);
      if (!pj) continue;
      const raw = ms.count ? 1 - poissonCdf(pr.line - 1, Math.max(pj.mean, 0.01)) : 1 - normCdf((pr.line - 0.5 - pj.mean) / pj.sd);
      picks.push(mkProp(g, {
        ...who, market: 'ms', side: 'yes', line: pr.line, stat: ms.short, prob: clamp(raw, 0.02, 0.97), projection: pj.mean,
        label: `${pl.name} ${pr.line}+ ${ms.short}`,
        reason: `Projects ${pj.mean.toFixed(1)} · reached ${pr.line} in ${vals.filter((v) => v >= pr.line).length} of ${pj.n}`,
      }, prices));
    } else if (TD_TYPES[pr.typeId]) {
      const tdStats = pl.pos === 'QB' ? ['rushingTouchdowns'] : TD_STATS;
      const vals = log.map((r) => tdStats.reduce((t, s) => t + (r[s] || 0), 0));
      if (vals.length < 3) continue;
      const have = cur ? tdStats.reduce((t, s) => t + (cur[s] || 0), 0) : 0;
      const need = (pr.typeId === '32' ? 2 : 1) - have;
      if (need <= 0) continue;
      const rate = vals.reduce((a, b) => a + b, 0) / vals.length;
      const lam = Math.max(0.01, rate * (vals.length / (vals.length + 2)) * (implied(pl.teamId) / 22) * f);
      picks.push(mkProp(g, {
        ...who, market: 'td', side: 'yes', line: null, stat: TD_TYPES[pr.typeId], prob: Math.min(0.9, 1 - poissonCdf(need - 1, lam)),
        label: `${pl.name} ${TD_TYPES[pr.typeId]}`,
        reason: `Scored in ${vals.filter((v) => v > 0).length} of ${vals.length} games · ${rate.toFixed(2)} TDs a game${have ? ` · has ${have} tonight` : ''}`,
      }, prices));
    }
  }
  // If one of a player's lines is far from his form, his role has changed — distrust all of them.
  const shaky = new Set(picks.filter((p) => p.suspect && p.volume).map((p) => p.athleteId));
  for (const p of picks) if (shaky.has(p.athleteId)) Object.assign(p, { suspect: true, lead: false, grade: null, units: 0 });
  return { picks };
}
const TD_STATS = ['rushingTouchdowns', 'receivingTouchdowns'];

// Team total points. DraftKings lists a ladder of lines; the main one sits at the market's implied
// team total, so that is the rung we evaluate.
export function evaluateTeamTotals(g, rows, proj, prices) {
  const o = g.odds;
  if (!proj || g.state === 'post' || o?.total == null || o?.spreadHome == null) return [];
  const picks = [];
  for (const side of ['home', 'away']) {
    const team = g[side], sign = side === 'home' ? 1 : -1;
    const lines = rows.filter((r) => r.teamId === team.id).map((r) => r.line);
    if (!lines.length) continue;
    const mkt = (o.total - sign * o.spreadHome) / 2;
    const line = lines.reduce((b, l) => (Math.abs(l - mkt) < Math.abs(b - mkt) ? l : b));
    if (Math.abs(line - mkt) > 1.5 || (proj.live && team.score > line)) continue;
    const exp = (proj.total + sign * proj.margin) / 2;
    const p = clamp(1 - normCdf((line - exp) / (SD_TEAM * Math.sqrt(Math.max(proj.f, 0.004)))), 0.05, 0.95);
    const base = { market: 'teamtotal', line, typeId: team.id, balanced: true, stat: 'Team Total', projection: exp,
      reason: `Projects ${team.abbr} for ${exp.toFixed(1)} points vs line ${line}` };
    picks.push(mkProp(g, { ...base, side: 'over', label: `${team.abbr} Team Total Over ${line}`, prob: p }, prices));
    picks.push(mkProp(g, { ...base, side: 'under', label: `${team.abbr} Team Total Under ${line}`, prob: 1 - p }, prices));
  }
  return picks;
}

const bestPerMarket = (picks, keep, score) => {
  const best = new Map();
  for (const p of picks) {
    if (!keep(p)) continue;
    const k = [p.gameId, p.market, p.athleteId || '', p.typeId || ''].join('|');
    if (!best.has(k) || score(best.get(k)) < score(p)) best.set(k, p);
  }
  return [...best.values()].sort((a, b) => score(b) - score(a));
};
// Bets with a real price that clear the bar, best first.
// Touchdown and milestone bets are capped at two so they can't crowd out everything else.
export function rankPicks(picks) {
  let yes = 0;
  return bestPerMarket(picks, (p) => p.grade, (p) => p.ev).filter((p) => p.side !== 'yes' || ++yes <= 2);
}
// Unpriced props the model leans on hardest — candidates for a price check.
export const rankLeads = (picks) => bestPerMarket(picks, (p) => p.lead, (p) => p.model);

// ---------- settling tracked bets ----------
export function settle(bet, g, box) {
  if (!g) return { status: 'open' };
  const done = g.state === 'post';
  const hs = g.home.score, as = g.away.score;
  let cur, target = bet.line, over = bet.side !== 'under';
  if (bet.market === 'spread' || bet.market === 'ml') {
    const m = (bet.side === 'home' ? hs - as : as - hs) + (bet.market === 'spread' ? bet.line : 0);
    return { status: !done ? 'open' : m > 0 ? 'won' : m < 0 ? 'lost' : 'push', note: `${g.away.abbr} ${as} – ${g.home.abbr} ${hs}`, winning: m > 0 };
  }
  if (bet.market === 'total') cur = hs + as;
  else if (bet.market === 'teamtotal') cur = bet.typeId === g.home.id ? hs : as;
  else {
    const stats = bet.market === 'td' ? TD_STATS : (PROP_TYPES[bet.typeId] || MILESTONE_TYPES[bet.typeId])?.stats;
    const row = box?.[bet.athleteId];
    if (!stats || (!row && g.state !== 'pre' && !box)) return { status: 'open' };
    cur = row ? stats.reduce((t, s) => t + (row[s] || 0), 0) : 0;
    // "Yes" markets win on reaching the number; express that as beating number - 0.5.
    if (bet.market === 'td') target = (bet.typeId === '32' ? 2 : 1) - 0.5;
    if (bet.market === 'ms') target = bet.line - 0.5;
  }
  let status = 'open';
  if (over && cur > target) status = 'won';
  else if (done) status = cur === target ? 'push' : over ? 'lost' : cur < target ? 'won' : 'lost';
  else if (!over && cur > target) status = 'lost';
  const shown = bet.market === 'td' || bet.market === 'ms' ? target + 0.5 : target;
  return { status, cur, target: shown, winning: over ? cur > target : cur < target };
}
