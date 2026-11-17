import * as api from './espn.js?v=13';
import * as odds from './odds.js?v=13';
import {
  buildRatings, evaluateGame, evaluateProps, evaluateTeamTotals, rankPicks, rankLeads, settle, gradeAt, buildParlay, impliedProb,
  fmtOdds, fmtLine, PROP_TYPES, MILESTONE_TYPES, TD_TYPES,
} from './model.js?v=13';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  games: [], week: null, ratings: null, ratingsAt: 0,
  data: {}, // gameId -> { sum, props, players }
  logs: {}, // athleteId -> game log rows
  ev: {}, // gameId -> { picks, proj, tds, ladders }
  picks: [], leads: [], scanned: 0, prices: ls.get('prices', {}),
  // Live DraftKings prop prices (optional, needs the user's Odds API key).
  cfg: { key: '', set: 'core', speed: 'balanced', scope: 'all', ...ls.get('cfg', {}) },
  dk: ls.get('dk', {}), dkMeta: ls.get('dkMeta', {}), dkStop: false, opened: new Set(), known: new Set(), armed: false,
  tab: 'picks', filter: 'all', open: null, sub: 'props', pf: 'all',
  parlay: { n: 3, mode: 'safe', skip: new Set() },
  bets: ls.get('bets', []), pre: ls.get('pre', {}), hist: ls.get('hist', {}),
  updated: 0, error: null, loading: new Set(),
};

// ---------- data loop ----------
const hoursTo = (g) => (Date.parse(g.date) - Date.now()) / 36e5;
const wantsDeep = (g) => g.state === 'in' || (g.state === 'pre' && hoursTo(g) < 36) || g.id === S.open;

async function tick() {
  let sb;
  try { sb = await api.scoreboard(); } catch (e) {
    // Only a failed download is a feed problem; keep showing the last good data and try again.
    console.error(e);
    S.error = navigator.onLine === false ? 'You are offline' : 'Can’t reach the data feed — retrying';
    render();
    clearTimeout(tick.t);
    if (!document.hidden) tick.t = setTimeout(tick, 8e3);
    return;
  }
  try {
    S.games = sb.games.sort((a, b) => order(a) - order(b) || Date.parse(a.date) - Date.parse(b.date));
    S.week = sb.week; S.error = null; S.updated = Date.now();
    // Live games: pull DraftKings' in-game lines (the scoreboard stops carrying odds at kickoff).
    await Promise.allSettled(S.games.filter((g) => g.state === 'in').map(async (g) => {
      const lo = await api.liveOdds(g.id);
      if (!lo) return;
      g.odds = lo;
      if (lo.open.spreadHome != null) S.pre[g.id] ??= { spreadHome: lo.open.spreadHome, total: lo.open.total };
    }));
    for (const g of S.games) {
      // Remember the closing pregame line; it anchors the live projection after kickoff.
      if (g.state === 'pre' && g.odds?.spreadHome != null) S.pre[g.id] = { spreadHome: g.odds.spreadHome, total: g.odds.total };
    }
    // Log every line change so money movement can be followed over time.
    for (const g of S.games) {
      const o = g.odds;
      if (g.state === 'post' || o?.mlHome == null || o?.mlAway == null) continue;
      const h = (S.hist[g.id] ??= []), last = h[h.length - 1];
      if (!last || last.s !== o.spreadHome || last.tot !== o.total || last.mh !== o.mlHome || last.ma !== o.mlAway) {
        h.push({ t: Date.now(), s: o.spreadHome, tot: o.total, mh: o.mlHome, ma: o.mlAway });
        if (h.length > 80) h.splice(1, h.length - 80); // keep the first reading and the latest 79
      }
    }
    for (const k of Object.keys(S.hist)) if (S.games.length && !S.games.some((g) => g.id === k && g.state !== 'post')) delete S.hist[k];
    ls.set('hist', S.hist);
    ls.set('pre', Object.fromEntries(Object.entries(S.pre).slice(-40)));
    // Entered prices only make sense while their game is still on the board.
    const onBoard = new Set(S.games.filter((g) => g.state !== 'post').map((g) => g.id));
    if (S.games.length) {
      for (const k of Object.keys(S.prices)) if (!onBoard.has(k.split('|')[0])) delete S.prices[k];
      for (const k of Object.keys(S.dk)) if (!onBoard.has(k)) delete S.dk[k];
    }
    if (Date.now() - S.ratingsAt > 15 * 6e4) {
      S.ratingsAt = Date.now();
      api.seasonResults(sb.season, sb.seasonType, sb.week).then((res) => { S.ratings = buildRatings(res); refresh(); }).catch(() => {});
    }
    refresh();
    const tracked = new Set(S.bets.filter((b) => !b.final).map((b) => b.gameId));
    for (const g of S.games) if (wantsDeep(g) || (tracked.has(g.id) && g.state !== 'pre')) loadDeep(g);
  } catch (e) {
    console.error(e);
    S.error = `App error: ${String(e?.message || e).slice(0, 80)}`;
    try { render(); } catch {}
  }
  clearTimeout(tick.t);
  if (!document.hidden) tick.t = setTimeout(tick, S.games.some((g) => g.state === 'in') ? 10e3 : 30e3);
}
const order = (g) => ({ in: 0, pre: 1, post: 2 }[g.state]);

async function loadDeep(g) {
  if (S.loading.has(g.id)) return;
  S.loading.add(g.id);
  const d = (S.data[g.id] ??= { players: {} });
  try {
    const live = g.state === 'in';
    const jobs = [api.summary(g.id, live).then((s) => { d.sum = s; })];
    if (g.state !== 'post') {
      jobs.push(api.props(g.id, live).then((p) => { d.props = p; }));
      jobs.push(...[g.home.id, g.away.id].map((t) => api.roster(t).then((r) => Object.assign(d.players, r))));
    }
    await Promise.allSettled(jobs);
    for (const [id, n] of Object.entries(d.sum?.names || {})) d.players[id] ??= { ...n, pos: '' };
    refresh();
    if (g.state !== 'post') await pullDk(g, d);
    const lines = [...(d.props || []), ...(S.dk[g.id]?.rows || [])];
    if (lines.length) {
      const need = [...new Set(lines.filter((p) => p.athleteId && (PROP_TYPES[p.typeId] || MILESTONE_TYPES[p.typeId] || TD_TYPES[p.typeId])).map((p) => p.athleteId))]
        .filter((id) => !S.logs[id]);
      let done = 0;
      await api.pool(need, 6, async (id) => {
        S.logs[id] = await api.gamelog(id);
        if (++done % 12 === 0) refresh();
      });
      d.ready = true;
      refresh();
    }
  } finally {
    S.loading.delete(g.id);
    if (!S.loading.size && S.ratings) S.armed = true;
  }
}

// ---------- live DraftKings prop prices ----------
const dkInterval = (g) => odds.SPEEDS[S.cfg.speed][g.state === 'in' ? 0 : hoursTo(g) < 6 ? 1 : 2];
const wantsDk = (g) => !!S.cfg.key && !S.dkStop && g.state !== 'post' && (S.cfg.scope === 'all' || (S.cfg.scope === 'open' && S.opened.has(g.id)));
// Prices are only used while fresh; an old price is worse than no price.
function dkFresh(g) {
  const x = S.dk[g.id];
  return S.cfg.key && x?.rows && Date.now() - x.at < Math.max(3 * dkInterval(g), 10) * 6e4 ? x : null;
}
async function pullDk(g, d, force) {
  if (!wantsDk(g) && !(force && S.cfg.key)) return;
  const prev = S.dk[g.id], mins = dkInterval(g);
  if (!force && prev && Date.now() - prev.at < mins * 6e4) return;
  try {
    const ev = odds.matchEvent((await odds.events(S.cfg.key)).data, g);
    if (!ev) { S.dk[g.id] = { at: Date.now(), rows: null, note: 'not listed yet' }; return; }
    const r = await odds.eventOdds(S.cfg.key, ev.id, S.cfg.set);
    S.dk[g.id] = { at: Date.now(), ...odds.parseOdds(r.data, d.players, g) };
    S.dkMeta = { remaining: r.remaining, last: r.last, at: Date.now(), error: null };
    S.dkStop = r.remaining != null && r.remaining < odds.SETS[S.cfg.set].length; // not enough left for another pull
    if (S.dkStop) S.dkMeta.error = 'Out of credits for this period';
  } catch (e) {
    S.dkMeta = { ...S.dkMeta, error: e.message, at: Date.now() };
    if (e.status === 401 || e.status === 403) S.dkStop = true; // bad key or no credits: wait for the user
    else S.dk[g.id] = { ...(prev || {}), at: Date.now() - Math.max(mins - 1, 0) * 6e4 }; // try again in a minute
  }
  ls.set('dk', S.dk); ls.set('dkMeta', S.dkMeta);
}

function refresh() {
  const all = [];
  let scanned = 0;
  for (const g of S.games) {
   try {
    const d = S.data[g.id] || {};
    const wp = g.situation?.wpHome ?? (g.state === 'in' && d.sum?.wp?.length ? d.sum.wp[d.sum.wp.length - 1] : null);
    const pre = g.state === 'pre' ? g.odds : S.pre[g.id];
    const { picks, proj } = evaluateGame(g, S.ratings, pre, wp);
    const e = { picks: [...picks], proj, wp };
    const dk = dkFresh(g);
    if (d.props || dk) {
      // Where DraftKings' live feed covers a market, its lines and prices replace the ESPN lines.
      const lines = dk ? (d.props || []).filter((p) => !dk.types.includes(p.typeId)).concat(dk.rows) : d.props;
      const prices = dk ? { ...S.prices, ...dk.prices } : S.prices;
      e.dk = dk ? dk.at : 0;
      e.picks.push(...evaluateProps(g, lines, d.players, S.logs, d.sum?.box, proj, prices).picks,
        ...evaluateTeamTotals(g, lines.filter((p) => p.typeId === '98' && p.line != null), proj, prices));
    }
    scanned += e.picks.filter((p) => p.side === 'over' || p.side === 'home' || p.side === 'yes').length;
    S.ev[g.id] = e;
    all.push(...e.picks);
   } catch (err) {
    // One game with odd data must not take the whole board down.
    console.error(err); S.bug = `${g.away?.abbr} @ ${g.home?.abbr}: ${String(err?.message || err).slice(0, 70)}`;
    S.ev[g.id] = { picks: [], proj: null };
   }
  }
  S.scanned = Math.round(scanned);
  S.picks = rankPicks(all);
  S.leads = rankLeads(all);
  // Tell the user when a new top-grade opportunity appears — but not during the initial research pass.
  const top = S.picks.filter((p) => p.grade === 'A');
  if (S.armed && !S.loading.size) {
    const fresh = top.find((p) => !S.known.has(p.id + p.line));
    if (fresh) toast(`New A-grade bet: ${fresh.label}`, fresh.gameId);
  }
  for (const p of top) S.known.add(p.id + p.line);
  try { gradeBets(); } catch (err) { console.error(err); }
  render();
}

function gradeBets() {
  let changed = false;
  for (const b of S.bets) {
    if (b.final) continue;
    const g = S.games.find((x) => x.id === b.gameId);
    const r = settle(b, g, S.data[b.gameId]?.sum?.box);
    b.live = r;
    if (g?.state === 'post' && r.status !== 'open' && (b.market !== 'prop' || S.data[b.gameId]?.sum)) { b.final = r.status; changed = true; }
  }
  if (changed) saveBets();
}
const saveBets = () => ls.set('bets', S.bets.map(({ live, ...b }) => b));

// ---------- rendering ----------
const gameTime = (g) => new Date(g.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const statusTxt = (g) => (g.state === 'pre' ? gameTime(g) : g.state === 'in' ? (g.statusName === 'STATUS_HALFTIME' ? 'Halftime' : `Q${g.period > 4 ? 'OT' : g.period} ${g.displayClock}`).replace('QOT', 'OT') : 'Final');
const pct = (p) => `${(p * 100).toFixed(0)}%`;
const logo = (t, cls = '') => `<img class="logo ${cls}" src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;

const isProp = (p) => p.market === 'prop' || p.market === 'td' || p.market === 'ms' || p.market === 'teamtotal';
const allPicks = () => Object.values(S.ev).flatMap((e) => e.picks);
const findPick = (key) => allPicks().find((p) => p.key === key);
const isTracked = (p) => S.bets.some((b) => (b.pick || b.id) === p.key && !b.final);
// Link to the game in DraftKings. Game-line bets (spread, total, moneyline) are added to the slip
// automatically; the feed has no slip ids for props, so those have to be added by hand.
const slipId = (g, p) => g?.odds?.slip?.[`${p.market}|${p.side}`] || null;
function dkLink(g, legs = [], label) {
  if (!g?.odds?.link) return '';
  const ids = legs.map((p) => slipId(g, p)).filter(Boolean);
  const href = g.odds.link + (ids.length ? `?outcomes=${ids.join('+')}` : '');
  return `<a class="btn ghost" href="${esc(href)}" target="_blank" rel="noopener" data-act="ext">${label || (ids.length ? 'Add to DraftKings slip ↗' : 'Open in DraftKings ↗')}</a>`;
}

function pickCard(p, compact) {
  const g = S.games.find((x) => x.id === p.gameId);
  const head = (badge, price) => `<div class="row">${badge}
      <div class="grow">
        <div class="title">${esc(p.label)}</div>
        <div class="sub">${p.live ? '<span class="live">LIVE</span> ' : ''}${compact ? '' : esc(p.matchup) + ' · '}${g ? esc(statusTxt(g)) : ''}</div>
      </div>${price}</div>`;
  if (p.needsPrice) {
    // The feed has this line but not DraftKings' price, so no odds are shown until the user supplies them.
    return `<article class="card pick" data-act="open" data-id="${p.gameId}">
      ${head('<span class="grade gQ">?</span>', '<div class="price"><b>—</b><small>price needed</small></div>')}
      <div class="stats three">
        <div><small>Model chance</small><b>${pct(p.model)}</b></div>
        <div><small>Fair price</small><b>${fmtOdds(p.fair)}</b></div>
        <div><small>Bet at</small><b>${fmtOdds(p.beat)} or better</b></div>
      </div>
      <p class="reason">${esc(p.reason)}</p>
      <div class="actions"><button class="btn" data-act="price" data-key="${esc(p.key)}">Enter DraftKings price</button>${dkLink(g)}</div>
    </article>`;
  }
  const tracked = isTracked(p);
  const price = p.priceUser
    ? `<button class="price edit" data-act="price" data-key="${esc(p.key)}"><b>${fmtOdds(p.price)}</b><small>your price ✎</small></button>`
    : `<div class="price"><b>${fmtOdds(p.price)}</b><small>DraftKings</small></div>`;
  return `<article class="card pick" data-act="open" data-id="${p.gameId}">
    ${head(`<span class="grade g${p.grade || 'N'}">${p.grade || '–'}</span>`, price)}
    <div class="stats">
      <div><small>Win chance</small><b>${pct(p.prob)}</b></div>
      <div><small>Need</small><b>${pct(p.breakeven)}</b></div>
      <div><small>Edge</small><b class="${p.ev > 0 ? 'pos' : 'neg'}">${p.ev > 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</b></div>
      <div><small>Stake</small><b>${p.units ? p.units + 'u' : '—'}</b></div>
    </div>
    <p class="reason">${esc(p.reason)}</p>
    <div class="actions">
      <button class="btn ${tracked ? 'on' : ''}" data-act="track" data-key="${esc(p.key)}">${tracked ? '✓ Tracking' : '＋ Track bet'}</button>${dkLink(g, [p])}
    </div>
  </article>`;
}

const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`; };
function dkChip() {
  const m = S.dkMeta;
  const txt = !S.cfg.key ? '<b>Prop prices are manual.</b> Turn on live DraftKings prices ›'
    : m.error ? `<b class="neg">Live prop prices paused:</b> ${esc(m.error)} ›`
      : `<i class="dot"></i> <b>DraftKings prop prices live</b>${m.remaining != null ? ` · ${Math.round(m.remaining).toLocaleString()} credits left` : ''} ›`;
  return `<button class="dkchip" data-act="settings">${txt}</button>`;
}
const LEADS_NOTE = '<h2>Props to price-check</h2><p class="fine">These props have a DraftKings line but no price yet, so no odds are shown. They are the model’s strongest leans. Enter the price DraftKings is showing to see the real edge.</p>';

function viewPicks() {
  const f = S.filter;
  const match = (p) => f === 'all' || (f === 'live' && p.live) || (f === 'pre' && !p.live) || (f === 'props' && isProp(p)) || (f === 'lines' && !isProp(p));
  const list = S.picks.filter(match), leads = S.leads.filter(match);
  const chips = [['all', 'All'], ['live', 'Live'], ['pre', 'Pregame'], ['lines', 'Game lines'], ['props', 'Player props']]
    .map(([k, t]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="filter" data-f="${k}">${t}${k === 'live' && S.picks.some((p) => p.live) ? ' <i class="dot"></i>' : ''}</button>`).join('');
  const loading = S.loading.size || !S.ratings;
  let body;
  if (!S.updated) body = skeleton();
  else {
    body = list.length ? list.slice(0, 60).map((p) => pickCard(p)).join('')
      : `<div class="empty ${leads.length ? 'slim' : ''}"><b>${loading ? 'Researching the slate…' : 'No graded bets right now'}</b><p>${loading
        ? 'Pulling DraftKings lines, team results and player game logs.'
        : S.games.some((g) => g.state !== 'post') ? `Checked ${S.scanned} markets and nothing with a confirmed price clears the bar. This list updates on its own as lines and games move.`
          : 'No upcoming or live games on the board this week.'}</p></div>`;
    if (leads.length) body += `<p class="fine">${leads.length} more prop lean${leads.length > 1 ? 's' : ''} without a DraftKings price yet. Open a game to see its props.</p>`;
  }
  return `<div class="chips">${chips}</div>
    <div class="scanline">${loading ? '<i class="spin"></i>' : '<i class="dot"></i>'} ${S.scanned} markets checked · ${S.games.filter((g) => g.state === 'in').length} live, ${S.games.filter((g) => g.state === 'pre').length} upcoming</div>
    ${dkChip()}${S.bug ? `<p class="fine neg">Skipped a game with unexpected data — ${esc(S.bug)}</p>` : ''}
    ${body}
    <p class="fine">Edges are model estimates, not guarantees. Game-line prices come from the DraftKings feed; prop prices are only ever the ones you enter. 1u = 1% of bankroll. 21+. Problem gambling help: 1-800-GAMBLER.</p>`;
}
const skeleton = () => '<div class="card sk"></div><div class="card sk"></div><div class="card sk"></div>';

function gameCard(g) {
  const o = g.odds, s = g.situation, e = S.ev[g.id];
  const best = S.picks.find((p) => p.gameId === g.id);
  const row = (t, side) => `<div class="team ${g.state === 'post' && t.score < (side === 'home' ? g.away : g.home).score ? 'lost' : ''}">
      ${logo(t)}<span class="tname">${esc(t.name)} <small>${esc(t.record)}</small>${s?.possession === t.id ? ' <i class="ball">🏈</i>' : ''}</span>
      <b class="score">${g.state === 'pre' ? '' : t.score}</b></div>`;
  const wp = g.state === 'in' && e?.proj?.pWin != null ? e.proj.pWin : null;
  return `<article class="card game" data-act="open" data-id="${g.id}">
    <div class="ghead"><span class="${g.state === 'in' ? 'live' : 'muted'}">${g.state === 'in' ? '● ' : ''}${esc(statusTxt(g))}</span><span class="muted">${esc(g.tv)}</span></div>
    ${row(g.away, 'away')}${row(g.home, 'home')}
    ${g.state === 'in' && s?.text ? `<div class="sit">${esc(s.text)}</div>` : ''}
    ${wp != null ? `<div class="wpbar"><i style="width:${(1 - wp) * 100}%;background:${g.away.color}"></i><i style="width:${wp * 100}%;background:${g.home.color}"></i></div>` : ''}
    <div class="gfoot">
      ${o && o.spreadHome != null ? `<span>${esc(g.home.abbr)} ${fmtLine(o.spreadHome)}</span><span>O/U ${o.total ?? '—'}</span><span>${fmtOdds(o.mlAway)} / ${fmtOdds(o.mlHome)}</span>` : `<span class="muted">${g.state === 'post' ? 'Final' : 'Lines not posted'}</span>`}
      ${best ? `<span class="tag g${best.grade}">${best.grade} · ${esc(best.label.length > 22 ? best.label.slice(0, 21) + '…' : best.label)}</span>` : ''}
    </div>
  </article>`;
}
function viewGames() {
  if (!S.updated) return skeleton();
  if (!S.games.length) return '<div class="empty"><b>No games this week</b><p>The board fills in when the NFL schedule does.</p></div>';
  const sec = (title, list) => (list.length ? `<h2>${title}</h2>${list.map(gameCard).join('')}` : '');
  return sec('Live now', S.games.filter((g) => g.state === 'in')) + sec('Upcoming', S.games.filter((g) => g.state === 'pre')) + sec('Final', S.games.filter((g) => g.state === 'post'));
}

function viewBets() {
  if (!S.bets.length) return '<div class="empty"><b>No tracked bets yet</b><p>Tap “Track bet” on any suggestion and it will be followed here live, then graded when the game ends.</p></div>';
  const rec = { won: 0, lost: 0, push: 0 };
  let net = 0;
  for (const b of S.bets) if (b.final) { rec[b.final]++; net += b.final === 'won' ? (b.units || 1) * (b.price > 0 ? b.price / 100 : 100 / -b.price) : b.final === 'lost' ? -(b.units || 1) : 0; }
  const card = (b) => {
    const r = b.final ? { status: b.final } : b.live || { status: 'open' };
    const g = S.games.find((x) => x.id === b.gameId);
    const prog = r.cur != null ? `<div class="prog"><i class="${r.winning ? 'ok' : ''}" style="width:${Math.min(100, (r.cur / Math.max(r.target, 1)) * 100)}%"></i></div><div class="sub">${r.cur} of ${r.target}${b.side === 'under' ? ' (needs to stay under)' : ''}</div>` : r.note ? `<div class="sub">${esc(r.note)}</div>` : '';
    const st = r.status === 'open' ? (g?.state === 'in' ? (r.winning ? 'Winning' : 'Trailing') : 'Pending') : r.status[0].toUpperCase() + r.status.slice(1);
    return `<article class="card bet">
      <div class="row"><div class="grow"><div class="title">${esc(b.label)}</div>
        <div class="sub">${esc(b.matchup)} · ${fmtOdds(b.price)} · ${b.units || 1}u${g ? ' · ' + esc(statusTxt(g)) : ''}</div></div>
        <span class="status s-${r.status} ${r.status === 'open' && g?.state === 'in' ? (r.winning ? 'up' : 'down') : ''}">${st}</span></div>
      ${prog}
      <div class="actions"><button class="btn ghost" data-act="untrack" data-bet="${esc(b.key)}">Remove</button>${g ? `<button class="btn ghost" data-act="open" data-id="${g.id}">Game tracker</button>` : ''}</div>
    </article>`;
  };
  const open = S.bets.filter((b) => !b.final), done = S.bets.filter((b) => b.final);
  return `<div class="record"><div><small>Record</small><b>${rec.won}-${rec.lost}${rec.push ? '-' + rec.push : ''}</b></div><div><small>Net</small><b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${net.toFixed(2)}u</b></div><div><small>Open</small><b>${open.length}</b></div></div>
    ${open.length ? '<h2>Open</h2>' + open.map(card).join('') : ''}${done.length ? '<h2>Settled</h2>' + done.map(card).join('') : ''}`;
}

// ---------- game detail ----------
function field(g) {
  const s = g.situation;
  if (!s || s.yardLine == null) return '';
  const x = 10 + s.yardLine;
  const dir = s.possession === g.home.id ? 1 : -1;
  const fd = s.distance && s.down ? Math.max(10, Math.min(110, x + dir * s.distance)) : null;
  const lines = Array.from({ length: 9 }, (_, i) => `<line x1="${20 + i * 10}" y1="0" x2="${20 + i * 10}" y2="44" stroke="rgba(255,255,255,.22)" stroke-width=".4"/><text x="${20 + i * 10}" y="40" class="yd">${50 - Math.abs(40 - i * 10)}</text>`).join('');
  return `<svg class="field" viewBox="0 0 120 44" role="img" aria-label="${esc(s.text)}">
    <rect width="120" height="44" rx="2" fill="#1d6b3a"/>
    <rect width="10" height="44" fill="${g.home.color}"/><rect x="110" width="10" height="44" fill="${g.away.color}"/>
    <text x="5" y="22" class="ez" transform="rotate(-90 5 22)">${esc(g.home.abbr)}</text><text x="115" y="22" class="ez" transform="rotate(90 115 22)">${esc(g.away.abbr)}</text>
    ${lines}
    ${fd != null ? `<line x1="${fd}" y1="0" x2="${fd}" y2="44" stroke="#ffd166" stroke-width=".8"/>` : ''}
    <line x1="${x}" y1="0" x2="${x}" y2="44" stroke="#6ab0ff" stroke-width=".8"/>
    <path d="M${x} 22 l${-dir * 5} -4 v8z" fill="#fff" opacity=".85"/>
    <ellipse cx="${x}" cy="22" rx="2.6" ry="1.7" fill="#8a4b20" stroke="#fff" stroke-width=".4"/>
  </svg>`;
}
function spark(wp, g) {
  if (!wp || wp.length < 3) return '';
  const pts = wp.map((v, i) => `${((i / (wp.length - 1)) * 100).toFixed(1)},${(30 - v * 30).toFixed(1)}`).join(' ');
  return `<div class="sparkwrap"><small>${esc(g.home.abbr)} win probability</small><svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><line x1="0" y1="15" x2="100" y2="15" stroke="rgba(255,255,255,.18)" stroke-width=".4" stroke-dasharray="1.5"/><polyline points="${pts}" fill="none" stroke="#3ddc84" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg></div>`;
}

// Sportsbooks don't publish dollars wagered, but money leaves a footprint: books move the line toward
// the side taking the money. This reads that footprint from the opening line and every change since.
const noVig = (mh, ma) => { const a = impliedProb(mh), b = impliedProb(ma); return a / (a + b); };
function moneyFlow(g) {
  const o = g.odds;
  if (g.state === 'post' || !o || o.mlHome == null || o.mlAway == null) return '';
  const H = g.home, A = g.away, now = noVig(o.mlHome, o.mlAway);
  const h = S.hist[g.id] || [];
  const open = o.open?.mlHome != null && o.open?.mlAway != null ? noVig(o.open.mlHome, o.open.mlAway) : h.length ? noVig(h[0].mh, h[0].ma) : now;
  const shift = (now - open) * 100; // points of win probability the market has moved toward the home team
  const side = Math.abs(shift) < 1 ? null : shift > 0 ? H : A;
  const strength = Math.abs(shift) >= 8 ? 'Heavy' : Math.abs(shift) >= 4 ? 'Steady' : 'Light';
  const rows = [];
  if (o.open?.mlHome != null) rows.push(['Moneyline', `${H.abbr} ${fmtOdds(o.open.mlHome)} → ${fmtOdds(o.mlHome)}`, `${A.abbr} ${fmtOdds(o.open.mlAway)} → ${fmtOdds(o.mlAway)}`]);
  if (o.open?.spreadHome != null && o.spreadHome != null) rows.push(['Spread', `${H.abbr} ${fmtLine(o.open.spreadHome)} → ${fmtLine(o.spreadHome)}`, o.spreadHome === o.open.spreadHome ? 'no move' : `toward ${o.spreadHome < o.open.spreadHome ? H.abbr : A.abbr}`]);
  if (o.open?.total != null && o.total != null) rows.push(['Total', `${o.open.total} → ${o.total}`, o.total === o.open.total ? 'no move' : `${o.total > o.open.total ? 'Over' : 'Under'} money`]);
  // Recent direction: the last change logged while the app has been watching.
  let recent = '';
  if (h.length > 1) {
    const a = h[h.length - 2], b = h[h.length - 1], d = (noVig(b.mh, b.ma) - noVig(a.mh, a.ma)) * 100;
    const what = Math.abs(d) >= 0.3 ? `toward ${d > 0 ? H.abbr : A.abbr}` : b.tot !== a.tot ? `total ${b.tot > a.tot ? 'up' : 'down'} to ${b.tot}` : 'small price change';
    recent = `<p class="reason">Latest move ${ago(b.t)}: ${what}. ${h.length - 1} line change${h.length > 2 ? 's' : ''} logged since ${new Date(h[0].t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>`;
  }
  const pts = h.length > 2 ? h.map((x, i) => `${((i / (h.length - 1)) * 100).toFixed(1)},${(30 - noVig(x.mh, x.ma) * 30).toFixed(1)}`).join(' ') : '';
  const pos = Math.max(4, Math.min(96, 50 + shift * 3)); // marker: centre = no movement
  return `<div class="card flow">
    <div class="row"><b class="grow">${g.state === 'in' ? 'How the live line has moved' : 'Where the money is going'}</b><span class="tag ${side ? 'gB' : ''}">${side ? `${strength} · ${esc(side.abbr)}` : 'Balanced'}</span></div>
    <div class="flowbar"><span>${esc(A.abbr)}</span><div class="track"><i style="left:${pos}%"></i></div><span>${esc(H.abbr)}</span></div>
    <p class="reason">${side ? `${g.state === 'in' ? 'Since kickoff' : 'Since the line opened'}, the market has moved <b>${Math.abs(shift).toFixed(1)} points of win chance toward ${esc(side.name)}</b> (${esc(H.abbr)} ${pct(open)} → ${pct(now)}).` : `The market has barely moved since ${g.state === 'in' ? 'kickoff' : 'the line opened'} (${esc(H.abbr)} ${pct(open)} → ${pct(now)}).`}</p>
    ${rows.map(([k, a, b]) => `<div class="prow"><span class="muted" style="width:76px">${k}</span><span class="grow">${esc(a)}</span><span class="muted">${esc(b)}</span></div>`).join('')}
    ${pts ? `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#6ab0ff" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>` : ''}
    ${recent}
    <p class="fine">${g.state === 'in' ? 'During a game the line mostly follows the score and clock, so read this as the market’s live view of the game rather than as betting money. Before kickoff it tracks where the money went.' : 'DraftKings doesn’t publish the dollars bet on each side, so this tracks line movement instead: books shift the line toward the side taking the money. Updates with every line change while the app is open.'}</p>
  </div>`;
}

function viewDetail(g) {
  const e = S.ev[g.id] || {}, d = S.data[g.id] || {}, o = g.odds, s = g.situation;
  const wpHome = g.state === 'in' ? e.proj?.pWin : d.sum?.predictor?.home != null ? d.sum.predictor.home / 100 : null;
  const head = `<div class="board">
      <div class="bt">${logo(g.away, 'big')}<span>${esc(g.away.abbr)}</span><small>${esc(g.away.record)}</small></div>
      <div class="bs">${g.state === 'pre' ? `<b class="vs">@</b>` : `<b>${g.away.score}</b><i>–</i><b>${g.home.score}</b>`}<span class="${g.state === 'in' ? 'live' : 'muted'}">${esc(statusTxt(g))}</span></div>
      <div class="bt">${logo(g.home, 'big')}<span>${esc(g.home.abbr)}</span><small>${esc(g.home.record)}</small></div>
    </div>
    ${g.state === 'in' && s ? `${field(g)}<div class="sit big">${s.redZone ? '<span class="live">RED ZONE</span> ' : ''}${esc(s.text || '')}</div>${s.lastPlay ? `<p class="lastplay">${esc(s.lastPlay)}</p>` : ''}` : ''}
    ${wpHome != null ? `<div class="wplabel"><span>${esc(g.away.abbr)} ${pct(1 - wpHome)}</span><small>${g.state === 'in' ? 'live win probability' : 'ESPN matchup predictor'}</small><span>${esc(g.home.abbr)} ${pct(wpHome)}</span></div>
      <div class="wpbar tall"><i style="width:${(1 - wpHome) * 100}%;background:${g.away.color}"></i><i style="width:${wpHome * 100}%;background:${g.home.color}"></i></div>` : ''}
    ${g.state !== 'pre' ? spark(d.sum?.wp, g) : ''}
    ${o && o.spreadHome != null ? `<table class="lines"><tr><th>DraftKings</th><th>Spread</th><th>Total</th><th>Money</th></tr>
      <tr><td>${esc(g.away.abbr)}</td><td>${fmtLine(-o.spreadHome)} <small>${fmtOdds(o.spreadAwayPrice)}</small></td><td>O ${o.total} <small>${fmtOdds(o.overPrice)}</small></td><td>${fmtOdds(o.mlAway)}</td></tr>
      <tr><td>${esc(g.home.abbr)}</td><td>${fmtLine(o.spreadHome)} <small>${fmtOdds(o.spreadHomePrice)}</small></td><td>U ${o.total} <small>${fmtOdds(o.underPrice)}</small></td><td>${fmtOdds(o.mlHome)}</td></tr></table>` : ''}
    ${moneyFlow(g)}`;

  const tabs = [['props', 'Props'], ['parlay', 'Parlay'], ['bets', 'Bets'], ['drives', 'Drives'], ['intel', 'Intel']]
    .map(([k, t]) => `<button class="seg ${S.sub === k ? 'on' : ''}" data-act="sub" data-s="${k}">${t}</button>`).join('');
  let body = '';
  if (S.sub === 'bets') {
    const mine = S.picks.filter((p) => p.gameId === g.id), leads = S.leads.filter((p) => p.gameId === g.id);
    body = g.state === 'post' ? '<div class="empty"><p>This game is final.</p></div>'
      : (mine.length ? mine.map((p) => pickCard(p, true)).join('')
        : `<div class="empty ${leads.length ? 'slim' : ''}"><b>${S.loading.has(g.id) || !S.ratings ? 'Researching…' : 'No graded bet on this game right now'}</b><p>${!o ? 'DraftKings has not posted lines yet.' : 'The spread, total and moneyline are priced within the model’s margin of error. They are re-checked on every update.'}</p></div>`)
        + (leads.length ? LEADS_NOTE + leads.slice(0, 8).map((p) => pickCard(p, true)).join('') : '');
  } else if (S.sub === 'props') body = viewProps(g, e, d);
  else if (S.sub === 'parlay') body = viewParlay(g, e, d);
  else if (S.sub === 'drives') {
    const dr = (d.sum?.drives || []).slice().reverse();
    body = dr.length ? dr.map((x) => `<div class="drive"><div class="row"><b>${esc(x.team)}</b><span class="grow muted">${esc(x.desc)}</span><span class="tag ${x.score ? 'gB' : ''}">${esc(x.result)}</span></div>
      ${x.plays.reverse().map((p) => `<p class="${p.score ? 'pos' : ''}"><small>Q${p.q} ${esc(p.clock)}</small> ${esc(p.text)}</p>`).join('')}</div>`).join('')
      : '<div class="empty"><p>Drive-by-drive tracking starts at kickoff.</p></div>';
  } else body = viewIntel(g, e, d);
  return `<div class="sheet-head"><button class="back" data-act="close" aria-label="Back">‹</button><b>${esc(g.away.full)} at ${esc(g.home.full)}</b></div>
    <div class="sheet-body">${head}<div class="segs">${tabs}</div>${body}</div>`;
}

// One prop line. Tapping it opens the price box; the chip shows the price to beat, or the real edge once priced.
function propRow(p, left) {
  const chip = p.suspect ? '<span class="lean">Role changed?</span>'
    : p.price != null ? `<span class="lean ${p.grade ? 'g' + p.grade : ''}">${fmtOdds(p.price)} · ${p.ev > 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</span>`
      : `<span class="lean dash">${p.beat == null ? 'no value' : fmtOdds(p.beat) + ' or better'}</span>`;
  const tap = !p.suspect && p.priceSrc !== 'dk'; // live DraftKings prices need no typing
  return `<div class="prow ${tap ? 'tap' : ''}" ${tap ? `data-act="price" data-key="${esc(p.key)}"` : ''}><span class="grow">${left}</span>${chip}</div>`;
}
const groupBy = (list, fn) => {
  const m = new Map();
  for (const x of list) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
};

const CATS = { pass: ['8', '9', '10', '15', '16', '17', '18', '194'], rush: ['11', '12', '20', '21', '196', '197', '201'], rec: ['13', '14', '19', '195', '202'] };
const catOf = (p) => (p.market === 'td' ? 'td' : p.market === 'teamtotal' ? 'other' : Object.keys(CATS).find((c) => CATS[c].includes(p.typeId)) || 'other');

function viewParlay(g, e, d) {
  if (g.state === 'post') return '<div class="empty"><p>This game is final.</p></div>';
  const P = S.parlay, r = buildParlay(e.picks || [], P.n, P.mode, P.skip);
  const controls = `<div class="card pctl">
      <div class="row"><span class="grow"><b>Legs</b></span><button class="step" data-act="legs" data-d="-1" aria-label="Fewer legs">−</button><b class="stepn">${P.n}</b><button class="step" data-act="legs" data-d="1" aria-label="More legs">+</button></div>
      <div class="opts"><button class="${P.mode === 'safe' ? 'on' : ''}" data-act="pmode" data-m="safe">Safer · likeliest legs</button><button class="${P.mode === 'value' ? 'on' : ''}" data-act="pmode" data-m="value">Value · biggest edges</button></div>
    </div>`;
  if (!r.legs.length) return `${controls}<div class="empty"><b>${!d.ready && !e.picks?.length ? 'Researching this game…' : 'Nothing solid enough to parlay yet'}</b><p>${P.mode === 'value' ? 'Value mode needs real prices or near-even lines. Try Safer, or enter DraftKings prices on the Props tab.' : 'Legs appear once lines are posted and the model has a lean of 55% or better.'}</p></div>`;
  const legs = r.legs.map((l, i) => `<div class="prow leg">
      <b class="legn">${i + 1}</b>
      <span class="grow">${esc(l.label)}<small class="blk">${pct(l.legProb)} to hit · ${l.price != null ? `DraftKings ${fmtOdds(l.price)}` : `<button class="link" data-act="price" data-key="${esc(l.key)}">add DraftKings price</button>`}</small></span>
      <button class="swapb" data-act="swap" data-key="${esc(l.key)}" aria-label="Swap this leg">Swap</button></div>`).join('');
  const sum = `<div class="card psum">
      <div class="stats ${r.priced ? '' : 'three'}">
        <div><small>Chance to hit</small><b>${(r.prob * 100).toFixed(r.prob < 0.1 ? 1 : 0)}%</b></div>
        <div><small>Fair price</small><b>${fmtOdds(r.fair)}</b></div>
        ${r.priced ? `<div><small>Legs multiply to</small><b>${fmtOdds(r.payout)}</b></div><div><small>Edge</small><b class="${r.ev > 0 ? 'pos' : 'neg'}">${r.ev > 0 ? '+' : ''}${(r.ev * 100).toFixed(0)}%</b></div>`
          : `<div><small>Bet it if DraftKings pays</small><b>more than ${fmtOdds(r.fair)}</b></div>`}
      </div>
      <p class="reason">Compare DraftKings’ Same Game Parlay price with the fair price above. DraftKings prices a same-game parlay as a bundle, usually below what the legs multiply to${r.priced ? '' : '; add leg prices for a closer estimate'}.</p>
      ${(() => {
        const auto = r.legs.filter((l) => slipId(g, l)), manual = r.legs.filter((l) => !slipId(g, l));
        return `<div class="ticket"><b>To build this in DraftKings</b>
          ${auto.length ? `<p>① Tap the button below. It opens the game with ${auto.map((l) => esc(l.label)).join(' and ')} already on your slip.</p>` : '<p>① Tap the button below to open the game.</p>'}
          ${manual.length ? `<p>② Add ${manual.length > 1 ? 'these' : 'this'} yourself — DraftKings gives no shortcut for player props:</p><ul>${manual.map((l) => `<li>${esc(l.label)}</li>`).join('')}</ul>` : ''}
          </div>
          <div class="actions">${dkLink(g, auto, auto.length ? `Open DraftKings with ${auto.length} leg${auto.length > 1 ? 's' : ''} ↗` : 'Open game in DraftKings ↗')}<button class="btn ghost" data-act="copylegs" data-t="${esc(r.legs.map((l) => l.label).join('\n'))}">Copy legs</button></div>
          ${P.skip.size ? '<div class="actions"><button class="btn ghost" data-act="preset">Undo swaps</button></div>' : ''}`;
      })()}
    </div>`;
  return `${controls}${r.short ? `<p class="fine">Only ${r.legs.length} leg${r.legs.length > 1 ? 's' : ''} clear the bar right now, so this is shorter than ${P.n}.</p>` : ''}
    <div class="card">${legs}</div>${sum}
    <p class="fine">One leg per player, and never both the spread and the moneyline. The chance to hit treats legs as independent; legs from one game move together, so the true chance can be somewhat higher or lower. More legs means a bigger payout and a much smaller chance.</p>`;
}

function viewProps(g, e, d) {
  if (g.state === 'post') return '<div class="empty"><p>Props are closed for this game.</p></div>';
  if (!d.props) return `<div class="empty"><i class="spin"></i><p>Loading DraftKings props…</p></div>`;
  // Per market show one side: the one the user priced, otherwise the one the model leans to.
  const rank = (p) => (p.price != null ? 10 + p.ev : p.model);
  const sides = [...groupBy(e.picks.filter((p) => p.market === 'prop' || p.market === 'teamtotal'), (p) => [p.market, p.athleteId, p.typeId, p.line].join('|')).values()]
    .map((pair) => pair.reduce((a, b) => (rank(b) > rank(a) ? b : a)));
  const ouRow = (p) => propRow(p, `${esc(p.stat)} <b>${p.line}</b>${p.current != null ? ` <small>has ${p.current}</small>` : ''}
    <small class="blk">${p.side === 'over' ? 'Over' : 'Under'} ${pct(p.model)} · projects ${p.projection.toFixed(1)}${p.stale ? ' · pregame line' : ''}</small>`);
  const order = (rows) => rows.sort((a, b) => !!b.grade - !!a.grade || b.lead - a.lead || b.model - a.model);
  const f = S.pf, inCat = (p) => f === 'all' || catOf(p) === f;
  const players = [...groupBy(order(sides.filter((p) => p.market === 'prop' && inCat(p))), (p) => p.athleteId).values()];
  const ou = players.map((rows) => `<div class="card pl"><div class="title">${esc(rows[0].player)} <small>${esc(rows[0].pos)}</small></div>${rows.map(ouRow).join('')}</div>`).join('');
  const tt = sides.filter((p) => p.market === 'teamtotal' && inCat(p));
  const tds = e.picks.filter((p) => p.market === 'td' && p.typeId === '31' && inCat(p)).sort((a, b) => b.model - a.model).slice(0, 16);
  const yes = (p, name) => propRow(p, `${name}<small class="blk">${pct(p.model)} chance · fair ${fmtOdds(p.fair)}</small>`);
  const lad = [...groupBy(e.picks.filter((p) => p.market === 'ms' && f !== 'all' && inCat(p)), (p) => `${p.player} · ${p.stat}`).entries()].slice(0, 40);
  const note = e.dk
    ? `<div class="dkbar"><span><i class="dot"></i> <b>Live DraftKings lines and prices</b> · updated ${ago(e.dk)}</span><button class="btn ghost" data-act="dkpull" data-id="${g.id}">Refresh</button></div>
       <p class="fine">Each row shows DraftKings’ price and the edge at that price. Rows without a price can be tapped to enter one.</p>`
    : S.cfg.key && !S.dkStop ? `<div class="dkbar"><span>Lines are from the free feed. Prices not loaded.</span><button class="btn" data-act="dkpull" data-id="${g.id}">Get DraftKings prices · ${odds.SETS[S.cfg.set].length} credits</button></div>
       <p class="fine">Or tap any row to type a price in yourself.</p>`
    : `<p class="fine">These are DraftKings’ lines, but the free feed doesn’t carry its prop prices. Each row shows the worst price still worth betting. <b>Tap a row to enter the price DraftKings is showing</b>, or <button class="link" data-act="settings">turn on live prices</button>.</p>`;
  const pchips = [['all', 'All'], ['pass', 'Passing'], ['rush', 'Rushing'], ['rec', 'Receiving'], ['td', 'Touchdowns'], ['other', 'Defense & kicking']]
    .map(([k, t]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="pf" data-f="${k}">${t}</button>`).join('');
  return `<div class="chips">${pchips}</div>${note}
    ${!d.ready ? '<div class="scanline"><i class="spin"></i> Reading player game logs…</div>' : ''}
    ${ou ? `<h2>Over / under</h2>${ou}` : d.ready && f !== 'td' ? '<div class="empty"><p>No over/under props here yet.</p></div>' : ''}
    ${tt.length ? `<h2>Team totals</h2><div class="card">${tt.map((p) => propRow(p, `${esc(p.label.replace(/ (Over|Under) .*/, ''))} <b>${p.line}</b><small class="blk">${p.side === 'over' ? 'Over' : 'Under'} ${pct(p.model)} · projects ${p.projection.toFixed(1)}</small>`)).join('')}</div>` : ''}
    ${tds.length ? `<h2>Anytime touchdown</h2><div class="card">${tds.map((p) => yes(p, `${esc(p.player)} <small>${esc(p.pos)}</small>`)).join('')}</div>` : ''}
    ${f === 'all' && d.ready ? '<p class="fine">Pick Passing, Rushing or Receiving above to also see milestone ladders.</p>' : ''}
    ${lad.length ? `<h2>Milestones</h2><div class="card">${lad.map(([k, rows]) => `<details><summary>${esc(k)}</summary>${rows.sort((a, b) => a.line - b.line).map((p) => yes(p, `<b>${p.line}+</b>`)).join('')}</details>`).join('')}</div>` : ''}`;
}

function viewIntel(g, e, d) {
  const o = g.odds, pj = e.proj, rp = pj?.rp;
  const rows = [];
  if (rp) rows.push(['Model score', `${g.away.abbr} ${rp.ap.toFixed(1)} – ${g.home.abbr} ${rp.hp.toFixed(1)}`]);
  if (pj?.live) rows.push(['Projected final', `${g.home.abbr} ${fmtLine(+pj.margin.toFixed(1))}, total ${pj.total.toFixed(1)}`]);
  if (o?.open?.spreadHome != null) rows.push(['Spread move', `${g.home.abbr} ${fmtLine(o.open.spreadHome)} → ${fmtLine(o.spreadHome)}`]);
  if (o?.open?.total != null) rows.push(['Total move', `${o.open.total} → ${o.total}`]);
  if (o?.open?.mlHome != null) rows.push(['Moneyline move', `${g.home.abbr} ${fmtOdds(o.open.mlHome)} → ${fmtOdds(o.mlHome)}`]);
  if (g.weather) rows.push(['Weather', g.weather]);
  if (g.venue) rows.push(['Venue', g.venue]);
  const ts = d.sum?.teamStats || [];
  const stat = ts.length === 2 ? Object.keys(ts[0].stats).slice(0, 10).map((k) => `<tr><td>${esc(ts[0].stats[k])}</td><th>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</th><td>${esc(ts[1].stats[k] ?? '')}</td></tr>`).join('') : '';
  const key = /^(QB|RB|WR|TE|K|PK)$/;
  const inj = (d.sum?.injuries || []).map((t) => {
    const l = t.list.filter((i) => !/reserve/i.test(i.status)).sort((a, b) => key.test(b.pos) - key.test(a.pos)).slice(0, 12);
    return l.length ? `<h3>${esc(t.team)}</h3>${l.map((i) => `<div class="prow"><span class="grow">${esc(i.name)} <small>${esc(i.pos)}</small></span><span class="muted">${esc(i.what)}</span><span class="lean ${/out|doubt/i.test(i.status) ? 'neg' : ''}">${esc(i.status)}</span></div>`).join('')}` : '';
  }).join('');
  return `<div class="card">${rows.map(([k, v]) => `<div class="prow"><span class="grow muted">${k}</span><b>${esc(v)}</b></div>`).join('') || '<p class="muted">Model numbers appear once three weeks of results exist.</p>'}</div>
    ${stat ? `<h2>Team stats</h2><table class="cmp"><tr><td><b>${esc(ts[0].abbr)}</b></td><th></th><td><b>${esc(ts[1].abbr)}</b></td></tr>${stat}</table>` : ''}
    ${inj ? `<h2>Injury report</h2><div class="card">${inj}</div>` : ''}
    <p class="fine">How it works: team strength comes from every result this season (offense and defense rated separately, adjusted for opponent and home field). Player projections weight recent games more. Every number is then pulled partway toward DraftKings’ own, and a bet is only graded when the remaining gap beats a real price — the feed’s for game lines, the one you enter for props. Live, the projection re-runs from the score, clock, possession and field position on each update.</p>`;
}

let lastHtml = {};
function put(sel, html) {
  if (lastHtml[sel] === html) return;
  lastHtml[sel] = html;
  $(sel).innerHTML = html;
}
function render() {
  const safe = (fn) => { try { return fn(); } catch (err) { console.error(err); return `<div class="empty"><b>This screen hit a problem</b><p>${esc(String(err?.message || err).slice(0, 120))}</p></div>`; } };
  put('#view', safe(() => (S.tab === 'picks' ? viewPicks() : S.tab === 'games' ? viewGames() : viewBets())));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const liveN = S.games.filter((g) => g.state === 'in').length;
  $('#badge-live').textContent = liveN || '';
  $('#badge-bets').textContent = S.bets.filter((b) => !b.final).length || '';
  const g = S.open && S.games.find((x) => x.id === S.open);
  $('#sheet').classList.toggle('show', !!g);
  document.body.classList.toggle('locked', !!g);
  if (g) put('#sheet', safe(() => viewDetail(g)) || '');
  stamp();
}
function stamp() {
  const el = $('#status');
  if (S.error) { el.className = 'status err'; el.textContent = S.error; return; }
  if (!S.updated) { el.className = 'status'; el.textContent = 'Connecting…'; return; }
  const s = Math.round((Date.now() - S.updated) / 1000);
  el.className = 'status ok';
  el.innerHTML = `<i class="dot"></i> ${S.games.some((x) => x.state === 'in') ? 'Live' : 'Scanning'} · ${s < 3 ? 'just now' : s + 's ago'}`;
}
function toast(msg, gameId) {
  const t = $('#toast');
  t.textContent = msg; t.dataset.id = gameId || ''; t.classList.add('show');
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 6000);
}

// ---------- events ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act],[data-tab]');
  if (!el) return;
  if (el.dataset.tab) { S.tab = el.dataset.tab; window.scrollTo(0, 0); return render(); }
  const act = el.dataset.act;
  if (act === 'ext') return ev.stopPropagation();
  if (act === 'settings') { ev.stopPropagation(); return openSettings(); }
  if (act === 'dkpull') {
    const g = S.games.find((x) => x.id === el.dataset.id);
    if (!g) return;
    el.textContent = 'Refreshing…'; el.disabled = true;
    return pullDk(g, S.data[g.id] || { players: {} }, true).then(() => { lastHtml = {}; refresh(); });
  }
  if (act === 'price') { ev.stopPropagation(); return openPricer(el.dataset.key); }
  if (act === 'track') {
    ev.stopPropagation();
    const key = el.dataset.key, p = findPick(key);
    const i = S.bets.findIndex((b) => (b.pick || b.id) === key && !b.final);
    if (i >= 0) S.bets.splice(i, 1);
    else if (p && p.price != null) {
      const { id, gameId, market, side, athleteId, typeId, label, line, price, matchup, units } = p;
      S.bets.unshift({ key: key + ':' + Date.now(), pick: key, id, gameId, market, side, athleteId, typeId, label, line, price, matchup, units: units || 1 });
    }
    saveBets(); lastHtml = {}; return refresh();
  }
  if (act === 'untrack') { ev.stopPropagation(); S.bets = S.bets.filter((b) => b.key !== el.dataset.bet); saveBets(); return render(); }
  if (act === 'filter') { S.filter = el.dataset.f; return render(); }
  if (act === 'sub') { S.sub = el.dataset.s; return render(); }
  if (act === 'pf') { S.pf = el.dataset.f; return render(); }
  if (act === 'legs') { S.parlay.n = Math.max(2, Math.min(8, S.parlay.n + Number(el.dataset.d))); return render(); }
  if (act === 'pmode') { S.parlay.mode = el.dataset.m; S.parlay.skip = new Set(); return render(); }
  if (act === 'swap') { ev.stopPropagation(); S.parlay.skip.add(el.dataset.key); return render(); }
  if (act === 'copylegs') { navigator.clipboard?.writeText(el.dataset.t).then(() => { el.textContent = 'Copied ✓'; }, () => { el.textContent = 'Copy failed'; }); return; }
  if (act === 'preset') { S.parlay.skip = new Set(); return render(); }
  if (act === 'close') { S.open = null; history.state?.sheet && history.back(); return render(); }
  if (act === 'open' || act === 'toast') {
    const id = el.dataset.id;
    if (!id) return;
    if (S.open !== id) S.parlay.skip = new Set();
    S.open = id; S.opened.add(id); S.sub = 'props'; S.pf = 'all'; history.pushState({ sheet: 1 }, '');
    render(); $('#sheet').scrollTop = 0;
    const g = S.games.find((x) => x.id === id);
    if (g) loadDeep(g);
  }
});
// ---------- entering a real DraftKings price for a prop ----------
const P = { key: null, sign: -1 };
function pricerPreview() {
  const p = findPick(P.key), n = parseInt($('#pr-val').value, 10), out = $('#pr-out');
  $('#pr-sign').textContent = P.sign < 0 ? '−' : '+';
  $('#pr-save').disabled = !(p && n >= 100);
  if (!p || !$('#pr-val').value) { out.textContent = ''; return null; }
  if (!(n >= 100)) { out.textContent = 'American odds are 100 or more, like −224 or +150.'; return null; }
  const price = P.sign * n, r = gradeAt(p, price);
  out.innerHTML = `At ${fmtOdds(price)} you need ${pct(r.breakeven)}; the model, after weighing DraftKings’ own view, says ${pct(r.prob)}.<br><b class="${r.ev > 0 ? 'pos' : 'neg'}">Edge ${r.ev > 0 ? '+' : ''}${(r.ev * 100).toFixed(1)}%</b> — ${r.grade ? `${r.grade}-grade bet, stake ${r.units}u` : p.suspect ? 'not graded: this line is far from the player’s form' : 'not a bet at this price'}.`;
  return price;
}
function openPricer(key) {
  const p = findPick(key);
  if (!p) return;
  P.key = key; P.sign = p.price > 0 ? 1 : -1;
  $('#pr-label').textContent = p.label;
  $('#pr-sub').textContent = `Model ${pct(p.model)} · fair price ${fmtOdds(p.fair)} · ${p.beat == null ? 'not worth betting at any realistic price' : `worth betting at ${fmtOdds(p.beat)} or better`}. Type the price DraftKings shows for this exact bet.`;
  $('#pr-val').value = p.price != null ? Math.abs(p.price) : '';
  $('#pr-clear').hidden = p.price == null;
  $('#pricer').classList.add('show');
  pricerPreview();
  $('#pr-val').focus();
}
function closePricer(price) {
  if (price !== undefined) {
    if (price === null) delete S.prices[P.key]; else S.prices[P.key] = price;
    ls.set('prices', S.prices);
    lastHtml = {}; refresh();
  }
  $('#pricer').classList.remove('show');
  $('#pr-val').blur();
}
$('#pr-val').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5); pricerPreview(); });
$('#pr-val').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pr-save').click(); });
$('#pr-sign').addEventListener('click', () => { P.sign = -P.sign; pricerPreview(); });
$('#pr-save').addEventListener('click', () => { const price = pricerPreview(); if (price != null) closePricer(price); });
$('#pr-clear').addEventListener('click', () => closePricer(null));
$('#pr-cancel').addEventListener('click', () => closePricer());
$('#pricer').addEventListener('click', (e) => { if (e.target.id === 'pricer') closePricer(); });

// ---------- settings: live DraftKings prices ----------
let draft = null;
function settingsPaint() {
  document.querySelectorAll('#settings [data-cfg]').forEach((b) => b.classList.toggle('on', draft[b.dataset.cfg] === b.dataset.v));
  const e = odds.estimate(draft.set, draft.speed);
  $('#st-est').innerHTML = `Each price check uses up to <b>${e.perPull} credits</b> per game: about <b>${e.perGame.toLocaleString()}</b> for one live game${draft.scope === 'all' ? `, and roughly <b>${e.sunday.toLocaleString()}</b> for a full Sunday with the app left open` : ''}. Checks only run while the app is on screen.${draft.scope === 'tap' ? ' <b>With “Only when I tap”, nothing is spent until you press the button on a game’s Props tab</b> — the free key’s 500 monthly credits cover about ' + Math.floor(500 / e.perPull) + ' checks.' : ''}`;
  $('#st-clear').hidden = !S.cfg.key;
}
function settingsStatus() {
  const m = S.dkMeta, el = $('#st-status');
  el.innerHTML = !S.cfg.key ? '' : m.error ? `<b class="neg">${esc(m.error)}</b>` : `<b class="pos">Connected.</b>${m.remaining != null ? ` ${Math.round(m.remaining).toLocaleString()} credits left this period.` : ''}`;
}
function openSettings() {
  draft = { ...S.cfg };
  $('#st-key').value = S.cfg.key;
  settingsPaint(); settingsStatus();
  $('#settings').classList.add('show');
}
async function saveSettings() {
  const key = $('#st-key').value.trim();
  S.cfg = { ...draft, key };
  ls.set('cfg', S.cfg);
  S.dkStop = false; S.dkMeta = {}; ls.set('dkMeta', S.dkMeta);
  settingsPaint();
  if (!key) { S.dk = {}; ls.set('dk', S.dk); settingsStatus(); lastHtml = {}; return refresh(); }
  const el = $('#st-status');
  el.textContent = 'Checking the key…';
  try {
    const r = await odds.events(key, true); // listing games is free, so it makes a safe key check
    S.dkMeta = { remaining: r.remaining, at: Date.now(), error: null };
    el.innerHTML = `<b class="pos">Key works.</b>${r.remaining != null ? ` ${Math.round(r.remaining).toLocaleString()} credits left this period.` : ''} Pulling DraftKings prices now…`;
    S.dk = {}; // settings changed: pull fresh
    await Promise.allSettled(S.games.filter(wantsDk).filter(wantsDeep).map((g) => pullDk(g, S.data[g.id] || { players: {} }, true)));
    settingsStatus();
  } catch (e) {
    S.dkMeta = { error: e.message, at: Date.now() };
    if (e.status === 401 || e.status === 403) S.dkStop = true;
    settingsStatus();
  }
  ls.set('dkMeta', S.dkMeta);
  lastHtml = {}; refresh(); tick();
}
$('#settings').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cfg]');
  if (b) { draft[b.dataset.cfg] = b.dataset.v; return settingsPaint(); }
  if (e.target.id === 'settings' || e.target.id === 'st-close') $('#settings').classList.remove('show');
});
$('#st-save').addEventListener('click', saveSettings);
$('#st-clear').addEventListener('click', () => { $('#st-key').value = ''; saveSettings(); });

window.addEventListener('popstate', () => { S.open = null; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(stamp, 1000);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
tick();
