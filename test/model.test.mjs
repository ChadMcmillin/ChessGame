import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../js/model.js';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const game = (over = {}) => ({
  id: '1', state: 'pre', date: '2026-11-17T01:15Z', period: 0, clock: 0,
  home: { id: 'H', abbr: 'HOM', score: 0 }, away: { id: 'A', abbr: 'AWY', score: 0 },
  odds: { spreadHome: -3, spreadHomePrice: -110, spreadAwayPrice: -110, total: 44, overPrice: -110, underPrice: -110, mlHome: -160, mlAway: 135, open: {} },
  ...over,
});
// H is ~10 points better than A on a neutral field.
const season = () => {
  const g = [];
  for (let i = 0; i < 6; i++) g.push({ home: 'H', away: 'X' + i, hs: 31, as: 17 }, { home: 'X' + i, away: 'A', hs: 27, as: 17 }, { home: 'X' + i, away: 'X' + ((i + 1) % 6), hs: 23, as: 21 }, { home: 'X' + ((i + 2) % 6), away: 'X' + i, hs: 23, as: 21 });
  return m.buildRatings(g);
};

test('odds math', () => {
  near(m.impliedProb(-110), 0.5238, 0.001);
  near(m.impliedProb(150), 0.4);
  near(m.evPerUnit(0.55, -110), 0.05, 0.001);
  assert.equal(m.probToAmerican(0.6), -150);
  assert.equal(m.probToAmerican(0.4), 150);
  near(m.normCdf(0), 0.5); near(m.normCdf(1.96), 0.975, 0.001);
  near(m.poissonCdf(0, 1), Math.exp(-1));
});

test('ratings rank the stronger team higher and project a sensible score', () => {
  const r = season();
  const p = m.ratingProjection(r, 'H', 'A');
  assert.ok(p.margin > 8 && p.margin < 30, `margin ${p.margin}`);
  assert.ok(p.total > 30 && p.total < 60);
  assert.equal(m.ratingProjection(r, 'H', 'nobody'), null);
});

test('pregame: backs the side the model likes, never both sides', () => {
  const g = game();
  const { picks } = m.evaluateGame(g, season(), g.odds, null);
  const ranked = m.rankPicks(picks);
  const spread = ranked.filter((p) => p.market === 'spread');
  assert.equal(spread.length, 1);
  assert.equal(spread[0].side, 'home');
  assert.ok(spread[0].ev > 0 && spread[0].prob > spread[0].breakeven);
});

test('no ratings means no manufactured edge', () => {
  const g = game();
  assert.equal(m.rankPicks(m.evaluateGame(g, null, g.odds, null).picks).length, 0);
});

test('live: a stale line far from the scoreboard is ignored', () => {
  const g = game({ state: 'in', period: 4, clock: 120, home: { id: 'H', abbr: 'HOM', score: 35 }, away: { id: 'A', abbr: 'AWY', score: 7 } });
  const { picks, proj } = m.evaluateGame(g, null, { spreadHome: -3, total: 44 }, null);
  assert.ok(proj.pWin > 0.99);
  assert.equal(picks.filter((p) => p.market === 'spread').length, 0);
});

test('live: projection follows score and clock', () => {
  const g = game({ state: 'in', period: 3, clock: 900, home: { id: 'H', abbr: 'HOM', score: 17 }, away: { id: 'A', abbr: 'AWY', score: 10 },
    odds: { spreadHome: -8.5, spreadHomePrice: -110, spreadAwayPrice: -110, total: 49.5, overPrice: -110, underPrice: -110, mlHome: -450, mlAway: 340, open: {} } });
  const { proj, picks } = m.evaluateGame(g, null, { spreadHome: -3, total: 44 }, null);
  near(proj.margin, 7 + 1.5, 0.01);
  assert.ok(proj.total > 27 && proj.total < 60);
  assert.ok(picks.every((p) => p.live));
});

const wr = () => ({
  logs: { p1: [90, 85, 110, 95, 70, 88].map((v) => ({ receivingYards: v, receptions: 6, rushingTouchdowns: 0, receivingTouchdowns: 1 })) },
  players: { p1: { name: 'Test Player', pos: 'WR', teamId: 'H' } },
});

test('props: no price in the feed means no grade and no invented odds', () => {
  const g = game(), { logs, players } = wr();
  const props = [{ athleteId: 'p1', typeId: '13', line: 78.5 }, { athleteId: 'p1', typeId: '31', line: null }, { athleteId: 'p1', typeId: '195', line: 100 }];
  const { picks } = m.evaluateProps(g, props, players, logs, null, m.projectGame(g, null, g.odds, null));
  assert.ok(picks.every((p) => p.price === null && p.grade === null && p.needsPrice));
  assert.equal(m.rankPicks(picks).length, 0);
  const lead = m.rankLeads(picks)[0];
  assert.equal(lead.side, 'over');
  assert.ok(lead.beat < 0, 'gives a price to beat');
  const td = picks.find((p) => p.market === 'td'), ms = picks.find((p) => p.market === 'ms');
  assert.ok(td.model > 0.3 && td.model < 0.8 && !td.lead);
  assert.ok(ms.model < 0.5 && !ms.lead);
});

test('props: a lopsided low line is never flagged without its real price', () => {
  // The reported case: over 0.5 receptions shown at -114 when DraftKings had -224.
  const g = game();
  const logs = { rb: [2, 1, 0, 2, 1, 3, 1, 2].map((v) => ({ receptions: v })) };
  const players = { rb: { name: 'Power Back', pos: 'RB', teamId: 'H' } };
  const props = [{ athleteId: 'rb', typeId: '14', line: 0.5 }];
  const run = (prices) => m.evaluateProps(g, props, players, logs, null, null, prices).picks.find((p) => p.side === 'over');
  const bare = run();
  assert.ok(!bare.lead && bare.grade === null && bare.price === null);
  assert.ok(bare.model > 0.6 && bare.model < 0.9, `model ${bare.model}`);
  const real = run({ [bare.key]: -224 });
  assert.equal(real.price, -224);
  near(real.breakeven, 0.691, 0.001);
  assert.ok(real.prob < bare.model, 'pulled toward the market');
  assert.ok(real.ev < 0.06, `no big edge at the real price (${real.ev})`);
  const gift = run({ [bare.key]: 110 });
  assert.equal(gift.grade, 'A');
  // The price to beat is exactly where the edge reaches +3%.
  near(run({ [bare.key]: bare.beat }).ev, 0.03, 0.01);
});

test('live props count what the player already has', () => {
  const g = game({ state: 'in', period: 3, clock: 900 });
  const logs = { p1: [60, 60, 60, 60].map((v) => ({ receivingYards: v })) };
  const players = { p1: { name: 'P', pos: 'WR', teamId: 'H' } };
  const props = [{ athleteId: 'p1', typeId: '13', line: 60.5 }];
  const over = (have) => m.evaluateProps(g, props, players, logs, { p1: { receivingYards: have } }, null).picks.find((p) => p.side === 'over');
  assert.ok(over(55).model > 0.7 && over(5).model < 0.3);
  assert.equal(over(80), undefined);
});

test('settle grades bets', () => {
  const fin = game({ state: 'post', home: { id: 'H', abbr: 'HOM', score: 24 }, away: { id: 'A', abbr: 'AWY', score: 20 } });
  assert.equal(m.settle({ market: 'spread', side: 'home', line: -3 }, fin).status, 'won');
  assert.equal(m.settle({ market: 'spread', side: 'home', line: -4 }, fin).status, 'push');
  assert.equal(m.settle({ market: 'total', side: 'under', line: 43.5 }, fin).status, 'lost');
  assert.equal(m.settle({ market: 'ml', side: 'away' }, fin).status, 'lost');
  assert.equal(m.settle({ market: 'prop', side: 'over', line: 60.5, typeId: '13', athleteId: 'p' }, fin, { p: { receivingYards: 61 } }).status, 'won');
  assert.equal(m.settle({ market: 'td', side: 'yes', typeId: '31', athleteId: 'p' }, fin, { p: { rushingTouchdowns: 1 } }).status, 'won');
  assert.equal(m.settle({ market: 'td', side: 'yes', typeId: '31', athleteId: 'p' }, fin, { p: { receivingYards: 61 } }).status, 'lost');
  assert.equal(m.settle({ market: 'ms', side: 'yes', typeId: '195', line: 60, athleteId: 'p' }, fin, { p: { receivingYards: 60 } }).status, 'won');
  assert.equal(m.settle({ market: 'total', side: 'over', line: 43.5 }, game({ state: 'in', home: { id: 'H', abbr: 'H', score: 30 }, away: { id: 'A', abbr: 'A', score: 14 } })).status, 'won');
});
