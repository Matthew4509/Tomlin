// A linked PC's card in the left panel (public/home.js) right after Shut down or Update from here: it says Shutting down
// or Updating with a turning wheel, not Asleep, and the PCs are read again 12 and 25 s later.
// Run: node --test test/pcjustdid.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8');
/** pcDidWord and markPcDid with their memory, run on their own with a clock and a refresh that are counted. */
function load(now: { t: number }) {
  const start = home.indexOf('const pcJustDid = {};');
  const end = home.indexOf('function staffRow(');
  const timers: number[] = [];
  let reads = 0;
  const ctx = vm.createContext({ Date: { now: () => now.t }, setTimeout: (_f: () => void, ms: number) => timers.push(ms), refreshPcs: () => reads++, app: {} });
  vm.runInContext(`${home.slice(start, end)}; this.markPcDid = markPcDid; this.pcDidWord = pcDidWord;`, ctx);
  return { ctx: ctx as unknown as { markPcDid: (id: string, k: string) => void; pcDidWord: (p: object) => string }, timers, reads: () => reads };
}

test('Shut down: Shutting down until the PC shows as off (or 3 minutes), read again at 12 and 25 s', () => {
  const now = { t: 1_000_000 };
  const { ctx, timers, reads } = load(now);
  ctx.markPcDid('z820', 'off');
  assert.deepEqual(timers, [12_000, 25_000]);
  assert.equal(reads(), 1);
  assert.equal(ctx.pcDidWord({ id: 'z820', activity: 'available' }), 'Shutting down');
  assert.equal(ctx.pcDidWord({ id: 'hp', activity: 'available' }), '');
  assert.equal(ctx.pcDidWord({ id: 'z820', activity: 'offline' }), '');
  // Gone once shown: a PC switched on again later says what it says.
  assert.equal(ctx.pcDidWord({ id: 'z820', activity: 'available' }), '');
  ctx.markPcDid('z820', 'off');
  now.t += 3 * 60_000 + 1;
  assert.equal(ctx.pcDidWord({ id: 'z820', activity: 'available' }), '');
});

test('Update: Updating while it restarts, until it is back on and not behind (or 10 minutes)', () => {
  const now = { t: 1_000_000 };
  const { ctx } = load(now);
  ctx.markPcDid('hp', 'update');
  assert.equal(ctx.pcDidWord({ id: 'hp', activity: 'offline', outdated: { version: '2.1.17' } }), 'Updating');
  // Answering again at once, before the update went: still Updating for the first 20 s.
  assert.equal(ctx.pcDidWord({ id: 'hp', activity: 'available' }), 'Updating');
  now.t += 21_000;
  assert.equal(ctx.pcDidWord({ id: 'hp', activity: 'available', outdated: { version: '2.1.17' } }), 'Updating');
  assert.equal(ctx.pcDidWord({ id: 'hp', activity: 'available' }), '');
});

test('the card uses it, with the wheel, and both actions mark the PC once they went', () => {
  assert.match(home, /activityWord: did \|\| \(held/);
  assert.match(home, /updating: upd \|\| \(did \? `\$\{did\}: "\$\{p\.name\}"` : undefined\)/);
  assert.match(home, /api\('\/api\/network\/update'[^\n]*\n[^\n]*\n\s*markPcDid\(pc\.id, 'update'\);/);
  assert.match(home, /api\('\/api\/network\/power-off'[^\n]*\n\s*markPcDid\(pc\.id, 'off'\);/);
});
