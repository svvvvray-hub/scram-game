'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../public/gps.js');
const at = (lat, lng, t) => ({ lat, lng, t });
const north = (p, m) => ({ lat: p.lat + m / 111320, lng: p.lng });
const P0 = { lat: 37.77, lng: -122.42 };

test('gps throttle: first fix and forced (need_fix) always send', () => {
  assert.equal(G.decide({ now: 0, loc: P0, last: null }).send, true);
  assert.equal(G.decide({ now: 100, loc: P0, last: at(P0.lat, P0.lng, 50), force: true }).send, true);
  assert.equal(G.decide({ now: 0, loc: null, last: null }).send, false);
});
test('gps throttle: stationary (<5 m) and no enemy within 150 m -> saver, at most every 15 s', () => {
  const last = at(P0.lat, P0.lng, 0), loc = north(P0, 3);
  let d = G.decide({ now: 14000, loc, last }); assert.equal(d.saver, true); assert.equal(d.send, false); assert.equal(d.interval, 15000);
  d = G.decide({ now: 15000, loc, last }); assert.equal(d.send, true);
  d = G.decide({ now: 14000, loc, last, enemies: [north(P0, 400)] }); assert.equal(d.saver, true, 'far enemy does not wake it');
});
test('gps throttle: moving or enemy/drop nearby or urgent -> every 3-5 s', () => {
  const last = at(P0.lat, P0.lng, 0);
  let d = G.decide({ now: 3000, loc: north(P0, 8), last }); assert.equal(d.saver, false); assert.equal(d.send, true); assert.ok(d.interval >= 3000 && d.interval <= 5000);
  d = G.decide({ now: 2000, loc: north(P0, 8), last }); assert.equal(d.send, false, 'never faster than 3 s');
  d = G.decide({ now: 4000, loc: north(P0, 1), last, enemies: [north(P0, 120)] }); assert.equal(d.saver, false); assert.equal(d.send, true);
  d = G.decide({ now: 4000, loc: north(P0, 1), last, hot: [north(P0, 100)] }); assert.equal(d.send, true, 'drop/bounty within 150 m keeps it fast');
  d = G.decide({ now: 4000, loc: P0, last, urgent: true }); assert.equal(d.send, true, 'compass phase / pickup is urgent');
  d = G.decide({ now: 3500, loc: P0, last, urgent: true }); assert.equal(d.send, false);
});
