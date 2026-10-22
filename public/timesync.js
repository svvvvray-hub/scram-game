// v13: NTP-style clock offset over WS + the reveal timeline (shared by app.js and unit tests).
(function (root) {
  // sample: {c: client send time, s: server time, r: client receive time} -> offset = s - (c + r) / 2, rtt = r - c
  function sampleOf(c, s, r) { return { offset: s - (c + r) / 2, rtt: r - c }; }
  // best estimate: median offset of the lowest-RTT half (robust to one slow round trip)
  function bestOffset(samples) {
    if (!samples.length) return null;
    const by = samples.slice().sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(samples.length / 2)));
    const offs = by.map(x => x.offset).sort((a, b) => a - b), n = offs.length;
    return { offset: n % 2 ? offs[(n - 1) / 2] : (offs[n / 2 - 1] + offs[n / 2]) / 2, rtt: by[0].rtt };
  }
  // timeline relative to revealAt (ms). Total lead = 5500.
  const BEATS = [{ k: 'hold', at: -5500 }, { k: '3', at: -4200 }, { k: '2', at: -3000 }, { k: '1', at: -1800 }, { k: 'black', at: -700 }, { k: 'radar', at: -600 }, { k: 'reveal', at: 0 }, { k: 'card', at: 1800 }];
  const LEAD = 5500, OUTRO = 1800;
  function phaseAt(dt) { let cur = null; for (const b of BEATS) if (dt >= b.at) cur = b; return cur ? cur.k : 'before'; }
  const api = { sampleOf, bestOffset, BEATS, LEAD, OUTRO, phaseAt };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.TimeSync = api;
})(this);
