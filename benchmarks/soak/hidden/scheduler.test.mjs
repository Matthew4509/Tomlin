import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const mod = await load('scheduler.js');
const Scheduler = mod.Scheduler ?? mod.default;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('add gives back a promise of the job\'s result', async () => {
  const s = new Scheduler({ concurrency: 2 });
  assert.equal(await s.add(async () => 42), 42);
  assert.equal(await s.add(() => 'sync value'), 'sync value');
});
test('no more than `concurrency` jobs run at once, and all of them run', async () => {
  const s = new Scheduler({ concurrency: 3 });
  let running = 0, peak = 0, done = 0;
  const job = async () => { running++; peak = Math.max(peak, running); await sleep(10); running--; done++; };
  await Promise.all(Array.from({ length: 20 }, () => s.add(job)));
  assert.equal(done, 20);
  assert.equal(peak, 3);
});
test('with one slot, waiting jobs run by priority (higher first) and then in the order added', async () => {
  const s = new Scheduler({ concurrency: 1 });
  const order = [];
  const mk = name => async () => { order.push(name); await sleep(5); };
  const first = s.add(mk('first'));
  const rest = [
    s.add(mk('low'), { priority: 0 }),
    s.add(mk('high'), { priority: 5 }),
    s.add(mk('mid1'), { priority: 2 }),
    s.add(mk('mid2'), { priority: 2 }),
    s.add(mk('top'), { priority: 9 }),
  ];
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, ['first', 'top', 'high', 'mid1', 'mid2', 'low']);
});
test('a job that fails is tried again up to `retries` times', async () => {
  const s = new Scheduler({ concurrency: 1 });
  let tries = 0;
  const v = await s.add(async () => { tries++; if (tries < 3) throw new Error('flaky'); return 'ok'; }, { retries: 2 });
  assert.equal(v, 'ok');
  assert.equal(tries, 3);
});
test('when the retries run out the last error comes back, and other jobs still run', async () => {
  const s = new Scheduler({ concurrency: 1 });
  let tries = 0;
  const bad = s.add(async () => { tries++; throw new Error(`fail ${tries}`); }, { retries: 1 });
  const good = s.add(async () => 'fine');
  await assert.rejects(bad, /fail 2/);
  assert.equal(await good, 'fine');
  assert.equal(tries, 2);
});
test('a job that throws at once (not async) is a rejection, not a crash', async () => {
  const s = new Scheduler({ concurrency: 1 });
  await assert.rejects(s.add(() => { throw new Error('sync boom'); }), /sync boom/);
});
test('a retry does not jump the queue past the slots, and waits its turn', async () => {
  const s = new Scheduler({ concurrency: 1 });
  const order = [];
  let n = 0;
  const flaky = s.add(async () => { order.push('flaky'); if (++n === 1) throw new Error('once'); }, { retries: 1 });
  const other = s.add(async () => { order.push('other'); });
  await Promise.all([flaky, other]);
  assert.equal(order.filter(x => x === 'flaky').length, 2);
  assert.equal(order.length, 3);
});
test('onIdle resolves when everything is finished, also when nothing was added', async () => {
  const s = new Scheduler({ concurrency: 2 });
  await s.onIdle();
  let finished = 0;
  for (let i = 0; i < 5; i++) s.add(async () => { await sleep(10); finished++; }).catch(() => undefined);
  await s.onIdle();
  assert.equal(finished, 5);
});
test('a thousand quick jobs finish', async () => {
  const s = new Scheduler({ concurrency: 8 });
  let sum = 0;
  await Promise.all(Array.from({ length: 1000 }, (_, i) => s.add(async () => { sum += i; })));
  assert.equal(sum, 499500);
});
test('the numbers asked for are checked', () => {
  assert.throws(() => new Scheduler({ concurrency: 0 }), Error);
  assert.throws(() => new Scheduler({ concurrency: 1.5 }), Error);
});
