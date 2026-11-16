import * as api from './espn.js';
import {
  buildRatings, evaluateGame, evaluateProps, evaluateTeamTotals, rankPicks, settle,
  fmtOdds, fmtLine, PROP_TYPES, MILESTONE_TYPES, TD_TYPES,
} from './model.js';

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
  picks: [], scanned: 0, known: new Set(), armed: false,
  tab: 'picks', filter: 'all', open: null, sub: 'bets',
  bets: ls.get('bets', []), pre: ls.get('pre', {}),
  updated: 0, error: null, loading: new Set(),
};

// ---------- data loop ----------
const hoursTo = (g) => (Date.parse(g.date) - Date.now()) / 36e5;
const wantsDeep = (g) => g.state === 'in' || (g.state === 'pre' && hoursTo(g) < 36) || g.id === S.open;

async function tick() {
  try {
    const sb = await api.scoreboard();
    S.games = sb.games.sort((a, b) => order(a) - order(b) || Date.parse(a.date) - Date.parse(b.date));
    S.week = sb.week; S.error = null; S.updated = Date.now();
    for (const g of S.games) {
      // Remember the closing pregame line; it anchors the live projection after kickoff.
      if (g.state === 'pre' && g.odds?.spreadHome != null) S.pre[g.id] = { spreadHome: g.odds.spreadHome, total: g.odds.total };
    }
    ls.set('pre', Object.fromEntries(Object.entries(S.pre).slice(-40)));
    if (Date.now() - S.ratingsAt > 15 * 6e4) {
      S.ratingsAt = Date.now();
      api.seasonResults(sb.season, sb.seasonType, sb.week).then((res) => { S.ratings = buildRatings(res); refresh(); }).catch(() => {});
    }
    refresh();
    const tracked = new Set(S.bets.filter((b) => !b.final).map((b) => b.gameId));
    for (const g of S.games) if (wantsDeep(g) || (tracked.has(g.id) && g.state !== 'pre')) loadDeep(g);
  } catch (e) {
    S.error = navigator.onLine === false ? 'You are offline' : 'Can’t reach the data feed — retrying';
    render();
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
    if (d.props) {
      const need = [...new Set(d.props.filter((p) => p.athleteId && (PROP_TYPES[p.typeId] || MILESTONE_TYPES[p.typeId] || TD_TYPES[p.typeId])).map((p) => p.athleteId))]
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

function refresh() {
  const all = [];
  let scanned = 0;
  for (const g of S.games) {
    const d = S.data[g.id] || {};
    const wp = g.situation?.wpHome ?? (g.state === 'in' && d.sum?.wp?.length ? d.sum.wp[d.sum.wp.length - 1] : null);
    const pre = g.state === 'pre' ? g.odds : S.pre[g.id];
    const { picks, proj } = evaluateGame(g, S.ratings, pre, wp);
    const e = { picks: [...picks], proj, tds: [], ladders: [], wp };
    if (d.props) {
      const pp = evaluateProps(g, d.props, d.players, S.logs, d.sum?.box, proj);
      e.picks.push(...pp.picks, ...evaluateTeamTotals(g, d.props.filter((p) => p.typeId === '98' && p.line != null), proj));
      e.tds = pp.tds.sort((a, b) => b.prob - a.prob);
      e.ladders = pp.ladders;
    }
    scanned += e.picks.length / 2 + e.tds.length + e.ladders.length;
    S.ev[g.id] = e;
    all.push(...e.picks);
  }
  S.scanned = Math.round(scanned);
  S.picks = rankPicks(all);
  // Tell the user when a new top-grade opportunity appears — but not during the initial research pass.
  const top = S.picks.filter((p) => p.grade === 'A');
  if (S.armed && !S.loading.size) {
    const fresh = top.find((p) => !S.known.has(p.id + p.line));
    if (fresh) toast(`New A-grade bet: ${fresh.label}`, fresh.gameId);
  }
  for (const p of top) S.known.add(p.id + p.line);
  gradeBets();
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

function pickCard(p, compact) {
  const g = S.games.find((x) => x.id === p.gameId);
  const tracked = S.bets.some((b) => b.id === p.id && !b.final);
  return `<article class="card pick" data-act="open" data-id="${p.gameId}">
    <div class="row">
      <span class="grade g${p.grade || 'N'}">${p.grade || '–'}</span>
      <div class="grow">
        <div class="title">${esc(p.label)}</div>
        <div class="sub">${p.live ? '<span class="live">LIVE</span> ' : ''}${compact ? '' : esc(p.matchup) + ' · '}${g ? esc(statusTxt(g)) : ''}</div>
      </div>
      <div class="price"><b>${fmtOdds(p.price)}</b><small>${p.priceEst ? 'est. price' : 'DraftKings'}</small></div>
    </div>
    <div class="stats">
      <div><small>Win chance</small><b>${pct(p.prob)}</b></div>
      <div><small>Need</small><b>${pct(p.breakeven)}</b></div>
      <div><small>Edge</small><b class="${p.ev > 0 ? 'pos' : 'neg'}">${p.ev > 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</b></div>
      <div><small>Stake</small><b>${p.units ? p.units + 'u' : '—'}</b></div>
    </div>
    <p class="reason">${esc(p.reason)}${p.stale ? '' : ''}</p>
    <div class="actions">
      <button class="btn ${tracked ? 'on' : ''}" data-act="track" data-pick="${esc(p.id)}">${tracked ? '✓ Tracking' : '＋ Track bet'}</button>
      ${g?.odds?.link ? `<a class="btn ghost" href="${esc(g.odds.link)}" target="_blank" rel="noopener" data-act="ext">Open in DraftKings ↗</a>` : ''}
    </div>
  </article>`;
}

function viewPicks() {
  const f = S.filter;
  const list = S.picks.filter((p) => f === 'all' || (f === 'live' && p.live) || (f === 'pre' && !p.live) || (f === 'props' && p.market === 'prop') || (f === 'lines' && p.market !== 'prop'));
  const chips = [['all', 'All'], ['live', 'Live'], ['pre', 'Pregame'], ['lines', 'Game lines'], ['props', 'Player props']]
    .map(([k, t]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="filter" data-f="${k}">${t}${k === 'live' && S.picks.some((p) => p.live) ? ' <i class="dot"></i>' : ''}</button>`).join('');
  const loading = S.loading.size || !S.ratings;
  let body;
  if (list.length) body = list.slice(0, 60).map((p) => pickCard(p)).join('');
  else if (!S.updated) body = skeleton();
  else body = `<div class="empty"><b>${loading ? 'Researching the slate…' : 'No edges right now'}</b><p>${loading
    ? 'Pulling DraftKings lines, team results and player game logs.'
    : S.games.some((g) => g.state !== 'post') ? `Checked ${S.scanned} markets and nothing clears the bar. Passing is a position too — this list updates on its own as lines and games move.`
      : 'No upcoming or live games on the board this week.'}</p></div>`;
  return `<div class="chips">${chips}</div>
    <div class="scanline">${loading ? '<i class="spin"></i>' : '<i class="dot"></i>'} ${S.scanned} markets checked · ${S.games.filter((g) => g.state === 'in').length} live, ${S.games.filter((g) => g.state === 'pre').length} upcoming</div>
    ${body}
    <p class="fine">Edges are model estimates, not guarantees. “est. price” means the feed gave DraftKings’ line but not its price, so −114 is assumed — check the real price before betting. 1u = 1% of bankroll. 21+. Problem gambling help: 1-800-GAMBLER.</p>`;
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
    const prog = r.cur != null ? `<div class="prog"><i class="${r.winning ? 'ok' : ''}" style="width:${Math.min(100, (r.cur / Math.max(b.line, 1)) * 100)}%"></i></div><div class="sub">${r.cur} of ${b.line}${b.side === 'under' ? ' (needs to stay under)' : ''}</div>` : r.note ? `<div class="sub">${esc(r.note)}</div>` : '';
    const st = r.status === 'open' ? (g?.state === 'in' ? (r.winning ? 'Winning' : 'Trailing') : 'Pending') : r.status[0].toUpperCase() + r.status.slice(1);
    return `<article class="card bet">
      <div class="row"><div class="grow"><div class="title">${esc(b.label)}</div>
        <div class="sub">${esc(b.matchup)} · ${fmtOdds(b.price)}${b.priceEst ? ' est.' : ''} · ${b.units || 1}u${g ? ' · ' + esc(statusTxt(g)) : ''}</div></div>
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
      <tr><td>${esc(g.home.abbr)}</td><td>${fmtLine(o.spreadHome)} <small>${fmtOdds(o.spreadHomePrice)}</small></td><td>U ${o.total} <small>${fmtOdds(o.underPrice)}</small></td><td>${fmtOdds(o.mlHome)}</td></tr></table>` : ''}`;

  const tabs = [['bets', 'Best bets'], ['props', 'Props'], ['drives', 'Drives'], ['intel', 'Intel']]
    .map(([k, t]) => `<button class="seg ${S.sub === k ? 'on' : ''}" data-act="sub" data-s="${k}">${t}</button>`).join('');
  let body = '';
  if (S.sub === 'bets') {
    const mine = S.picks.filter((p) => p.gameId === g.id);
    body = g.state === 'post' ? '<div class="empty"><p>This game is final.</p></div>'
      : mine.length ? mine.map((p) => pickCard(p, true)).join('')
        : `<div class="empty"><b>${S.loading.has(g.id) || !S.ratings ? 'Researching…' : 'No edge on this game right now'}</b><p>${!o ? 'DraftKings has not posted lines yet.' : 'Every market here is priced within the model’s margin of error. It is re-checked on every update.'}</p></div>`;
  } else if (S.sub === 'props') body = viewProps(g, e, d);
  else if (S.sub === 'drives') {
    const dr = (d.sum?.drives || []).slice().reverse();
    body = dr.length ? dr.map((x) => `<div class="drive"><div class="row"><b>${esc(x.team)}</b><span class="grow muted">${esc(x.desc)}</span><span class="tag ${x.score ? 'gB' : ''}">${esc(x.result)}</span></div>
      ${x.plays.reverse().map((p) => `<p class="${p.score ? 'pos' : ''}"><small>Q${p.q} ${esc(p.clock)}</small> ${esc(p.text)}</p>`).join('')}</div>`).join('')
      : '<div class="empty"><p>Drive-by-drive tracking starts at kickoff.</p></div>';
  } else body = viewIntel(g, e, d);
  return `<div class="sheet-head"><button class="back" data-act="close" aria-label="Back">‹</button><b>${esc(g.away.full)} at ${esc(g.home.full)}</b></div>
    <div class="sheet-body">${head}<div class="segs">${tabs}</div>${body}</div>`;
}

function viewProps(g, e, d) {
  if (g.state === 'post') return '<div class="empty"><p>Props are closed for this game.</p></div>';
  if (!d.props) return `<div class="empty"><i class="spin"></i><p>Loading DraftKings props…</p></div>`;
  const props = e.picks.filter((p) => p.market === 'prop');
  const byPlayer = new Map();
  for (const p of props) {
    const k = p.athleteId + '|' + p.typeId;
    const cur = byPlayer.get(k);
    if (!cur || p.prob > cur.prob) byPlayer.set(k, p); // keep the leaning side
  }
  const players = new Map();
  for (const p of [...byPlayer.values()].sort((a, b) => !!b.grade - !!a.grade || b.ev - a.ev)) (players.get(p.athleteId) || players.set(p.athleteId, []).get(p.athleteId)).push(p);
  const ou = [...players.values()].map((rows) => `<div class="card pl"><div class="title">${esc(rows[0].player)} <small>${esc(rows[0].pos)}</small></div>
    ${rows.map((p) => `<div class="prow"><span class="grow">${esc(p.stat)} <b>${p.line}</b>${p.current != null ? ` <small>has ${p.current}</small>` : ''}</span>
      <span class="muted">proj ${p.projection.toFixed(1)}</span>
      <span class="lean ${p.grade ? 'g' + p.grade : ''}">${p.stale ? 'Pregame line' : p.suspect ? 'Role changed?' : `${p.side === 'over' ? 'Over' : 'Under'} ${pct(p.prob)}${p.fairOnly ? ` · fair ${fmtOdds(p.fair)}` : ''}`}</span></div>`).join('')}</div>`).join('');
  const tds = e.tds.filter((t) => t.kind === 'Anytime TD').slice(0, 14);
  const lad = new Map();
  for (const l of e.ladders) (lad.get(l.player + ' · ' + l.stat) || lad.set(l.player + ' · ' + l.stat, []).get(l.player + ' · ' + l.stat)).push(l);
  return `${!d.ready ? '<div class="scanline"><i class="spin"></i> Reading player game logs…</div>' : ''}
    ${ou ? `<h2>Over / under lines</h2><p class="fine">DraftKings line, the model’s projection, and which side it leans. Highlighted leans clear the assumed −114 price. “Fair” means bet only at that price or better. “Role changed?” means the line is far from the player’s season form, so the model stands down.</p>${ou}` : d.ready ? '<div class="empty"><p>No over/under props posted yet.</p></div>' : ''}
    ${tds.length ? `<h2>Anytime touchdown — fair price</h2><p class="fine">Bet only if DraftKings pays better than the fair price shown.</p><div class="card">${tds.map((t) => `<div class="prow"><span class="grow">${esc(t.player)} <small>${esc(t.pos)}</small></span><span class="muted">${pct(t.prob)}</span><span class="lean">${fmtOdds(t.fair)} or better</span></div>`).join('')}</div>` : ''}
    ${lad.size ? `<h2>Yardage milestones — fair price</h2><div class="card">${[...lad.entries()].slice(0, 30).map(([k, rows]) => `<details><summary>${esc(k)}</summary>${rows.sort((a, b) => a.line - b.line).map((r) => `<div class="prow"><span class="grow">${r.line}+</span><span class="muted">${pct(r.prob)}</span><span class="lean">${fmtOdds(r.fair)} or better</span></div>`).join('')}</details>`).join('')}</div>` : ''}`;
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
    <p class="fine">How it works: team strength comes from every result this season (offense and defense rated separately, adjusted for opponent and home field). Player projections weight recent games more. Every number is then pulled partway toward DraftKings’ line, and a bet is only suggested when the remaining gap beats the price. Live, the projection re-runs from the score, clock, possession and field position on each update.</p>`;
}

let lastHtml = {};
function put(sel, html) {
  if (lastHtml[sel] === html) return;
  lastHtml[sel] = html;
  $(sel).innerHTML = html;
}
function render() {
  put('#view', S.tab === 'picks' ? viewPicks() : S.tab === 'games' ? viewGames() : viewBets());
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const liveN = S.games.filter((g) => g.state === 'in').length;
  $('#badge-live').textContent = liveN || '';
  $('#badge-bets').textContent = S.bets.filter((b) => !b.final).length || '';
  const g = S.open && S.games.find((x) => x.id === S.open);
  $('#sheet').classList.toggle('show', !!g);
  document.body.classList.toggle('locked', !!g);
  if (g) put('#sheet', viewDetail(g));
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
  if (act === 'track') {
    ev.stopPropagation();
    const p = S.picks.find((x) => x.id === el.dataset.pick) || Object.values(S.ev).flatMap((e) => e.picks).find((x) => x.id === el.dataset.pick);
    const i = S.bets.findIndex((b) => b.id === el.dataset.pick && !b.final);
    if (i >= 0) S.bets.splice(i, 1);
    else if (p) {
      const { id, gameId, market, side, athleteId, typeId, label, line, price, priceEst, matchup, units } = p;
      S.bets.unshift({ key: id + ':' + Date.now(), id, gameId, market, side, athleteId, typeId, label, line, price, priceEst, matchup, units: units || 1 });
    }
    saveBets(); lastHtml = {}; return refresh();
  }
  if (act === 'untrack') { ev.stopPropagation(); S.bets = S.bets.filter((b) => b.key !== el.dataset.bet); saveBets(); return render(); }
  if (act === 'filter') { S.filter = el.dataset.f; return render(); }
  if (act === 'sub') { S.sub = el.dataset.s; return render(); }
  if (act === 'close') { S.open = null; history.state?.sheet && history.back(); return render(); }
  if (act === 'open' || act === 'toast') {
    const id = el.dataset.id;
    if (!id) return;
    S.open = id; S.sub = 'bets'; history.pushState({ sheet: 1 }, '');
    render(); $('#sheet').scrollTop = 0;
    const g = S.games.find((x) => x.id === id);
    if (g) loadDeep(g);
  }
});
window.addEventListener('popstate', () => { S.open = null; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(stamp, 1000);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
tick();
