import test from 'node:test';
import assert from 'node:assert/strict';
import * as o from '../js/odds.js';
import * as m from '../js/model.js';

const g = {
  id: '401', state: 'pre', date: '2026-11-17T01:15Z', period: 0, clock: 0,
  home: { id: '33', abbr: 'BAL', full: 'Baltimore Ravens', score: 0 }, away: { id: '24', abbr: 'LAC', full: 'Los Angeles Chargers', score: 0 },
  odds: { spreadHome: -4.5, total: 39.5, open: {} },
};
const players = {
  h: { name: 'Derrick Henry', pos: 'RB', teamId: '33' }, aj: { name: 'A.J. Brown', pos: 'WR', teamId: '33' },
  jr: { name: 'Marvin Harrison Jr.', pos: 'WR', teamId: '24' }, lane: { name: "Ja'Kobi Lane", pos: 'WR', teamId: '24' },
};
// Shaped exactly like the documented /events/{id}/odds response.
const response = {
  id: 'abc', sport_key: 'americanfootball_nfl', commence_time: '2026-11-17T01:15:00Z', home_team: 'Baltimore Ravens', away_team: 'Los Angeles Chargers',
  bookmakers: [
    { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_receptions', last_update: '2026-11-17T00:00:00Z', outcomes: [{ name: 'Over', description: 'Derrick Henry', price: -999, point: 0.5 }] }] },
    { key: 'draftkings', title: 'DraftKings', markets: [
      { key: 'player_receptions', last_update: '2026-11-17T01:00:00Z', outcomes: [
        { name: 'Over', description: 'Derrick Henry', price: -224, point: 0.5 }, { name: 'Under', description: 'Derrick Henry', price: 170, point: 0.5 },
        { name: 'Over', description: 'AJ Brown', price: -120, point: 5.5 }, { name: 'Under', description: 'AJ Brown', price: -110, point: 5.5 },
        { name: 'Over', description: 'Somebody Unknown', price: -110, point: 2.5 }] },
      { key: 'player_anytime_td', last_update: '2026-11-17T01:00:00Z', outcomes: [
        { name: 'Yes', description: 'Derrick Henry', price: -150 }, { name: 'Yes', description: 'Marvin Harrison', price: 210 }, { name: 'Yes', description: 'JaKobi Lane', price: 400 }] },
      { key: 'team_totals', last_update: '2026-11-17T01:00:00Z', outcomes: [
        { name: 'Over', description: 'Baltimore Ravens', price: -115, point: 21.5 }, { name: 'Under', description: 'Baltimore Ravens', price: -105, point: 21.5 }] },
      { key: 'some_future_market', last_update: '2026-11-17T01:00:00Z', outcomes: [{ name: 'Over', description: 'Derrick Henry', price: -110, point: 1.5 }] },
    ] },
  ],
};

test('names match across punctuation, initials and suffixes', () => {
  assert.equal(o.normName('A.J. Brown'), o.normName('AJ Brown'));
  assert.equal(o.normName('Marvin Harrison Jr.'), 'marvin harrison');
  assert.equal(o.normName("Ja'Kobi Lane"), 'jakobi lane');
});

test('finds the matching game', () => {
  const list = [{ id: 'x', home_team: 'Dallas Cowboys', away_team: 'New York Giants', commence_time: '2026-11-17T01:15:00Z' }, { id: 'abc', home_team: 'Baltimore Ravens', away_team: 'Los Angeles Chargers', commence_time: '2026-11-17T01:15:00Z' }];
  assert.equal(o.matchEvent(list, g).id, 'abc');
  assert.equal(o.matchEvent([{ ...list[1], commence_time: '2026-12-25T01:15:00Z' }], g), null);
});

test('parses DraftKings lines and prices only, keyed for the model', () => {
  const r = o.parseOdds(response, players, g);
  assert.deepEqual(r.types.sort(), ['14', '31', '98']);
  assert.equal(r.unmatched, 1);
  assert.equal(r.prices['401|prop|over|h|14@0.5'].p, -224);
  assert.equal(r.prices['401|prop|under|h|14@0.5'].p, 170);
  assert.equal(r.prices['401|prop|under|aj|14@5.5'].p, -110);
  assert.equal(r.prices['401|td|yes|jr|31@'].p, 210);
  assert.equal(r.prices['401|td|yes|lane|31@'].p, 400);
  assert.equal(r.prices['401|teamtotal|over||33@21.5'].p, -115);
  assert.equal(r.rows.filter((x) => x.typeId === '14').length, 2);
  assert.ok(!JSON.stringify(r).includes('-999'), 'ignores other sportsbooks');
});

test('live prices flow into graded picks with the real DraftKings price', () => {
  const r = o.parseOdds(response, players, g);
  const logs = { h: [2, 1, 0, 2, 1, 3, 1, 2].map((v) => ({ receptions: v, rushingTouchdowns: 1, receivingTouchdowns: 0 })) };
  const { picks } = m.evaluateProps(g, r.rows, players, logs, null, null, r.prices);
  const over = picks.find((p) => p.market === 'prop' && p.side === 'over' && p.athleteId === 'h');
  assert.equal(over.price, -224);
  assert.equal(over.priceSrc, 'dk');
  assert.ok(!over.needsPrice && !over.priceUser);
  assert.ok(over.ev < 0.03, 'no fake edge at the real price');
  const td = picks.find((p) => p.market === 'td' && p.athleteId === 'h');
  assert.equal(td.price, -150);
});

test('usage estimate scales with markets and speed', () => {
  assert.equal(o.SETS.core.length, 10);
  assert.equal(o.SETS.all.length, 23);
  assert.ok(o.estimate('core', 'saver').perGame < o.estimate('core', 'fastest').perGame);
  assert.equal(o.estimate('all', 'balanced').perPull, 23);
});
