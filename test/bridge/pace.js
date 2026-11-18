// How busy this PC is right now, for the checks that time a piece of work to prove it stays quick (a pattern that does
// not backtrack without end on a file built to slow it down). Each limit is set for a PC with nothing else to do. On a PC
// busy with other work (other tests, other programs) the same work takes longer, so a limit is stretched by how much
// longer a fixed piece of work takes at that moment. A pattern that really backtracks takes seconds to minutes, many
// times any stretch allowed here, so it still fails.
'use strict';

// What the fixed piece of work takes on a PC with nothing else to do (measured on the PC these tests were written on).
// A slower PC stretches its limits by as much; a faster one keeps them as they are written.
const IDLE_MS = 40;
// The most a limit is ever stretched, so a broken check cannot pass by a PC being slow.
const MOST = 10;

const LINE = 'const total = order.items.reduce((a, b) => a + b.price, 0) || fallback; // made-up line\n';
const TEXT = LINE.repeat(4000);
function work() {
  let n = 0;
  for (let round = 0; round < 12; round++) {
    for (const line of TEXT.split('\n')) if (/\b(const|let|var)\s+(\w+)\s*=\s*[\w.]+\.reduce\(/.test(line)) n += line.length;
    n += JSON.parse(JSON.stringify(TEXT.split('\n').slice(0, 2000))).length;
  }
  return n;
}
const timed = () => { const t = process.hrtime.bigint(); work(); return Number(process.hrtime.bigint() - t) / 1e6; };

/** How many times longer the fixed work takes now than on an idle PC: 1 at least, MOST at most. */
function slowness() {
  timed(); // the first run also compiles it
  const runs = [timed(), timed(), timed()].sort((a, b) => a - b);
  return Math.min(MOST, Math.max(1, runs[1] / IDLE_MS));
}

/**
 * Throws when work that took `took` ms is over `limit` ms, the limit stretched by how busy the PC is now (measured only
 * when the plain limit was passed). The message gives both.
 */
function quick(took, limit) {
  if (took < limit) return;
  const s = slowness();
  if (took < limit * s) return;
  throw new Error(Math.round(took) + ' ms, over ' + limit + ' ms (' + Math.round(limit * s) + ' ms allowed on this PC as busy as it is now, ' + s.toFixed(1) + ' times slower than idle)');
}

module.exports = { quick, slowness };
