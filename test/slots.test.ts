// "At once" (src/slots.ts): how many answers one model on a node may write together. 1 (the default) is the line of
// Phase 4, one at a time, and starts the runner exactly as before. More starts llama-server with that many slots, each
// keeping the model's whole context, only as many as fit in memory and only on a runner build that takes --parallel.
// Plain functions; the line letting N run at a real door is test/slots-door.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as slots from '../src/slots.ts';
import { chatArgs } from '../src/llama.ts';
import * as nl from '../src/nodeline.ts';

const GB = 2 ** 30;

test('At once is 1, 2, 3 or 4; anything else is 1', () => {
  assert.deepEqual([1, 2, 3, 4].map(slots.cleanAtOnce), [1, 2, 3, 4]);
  for (const bad of [0, 5, -1, 2.5, '3', null, undefined]) assert.equal(slots.cleanAtOnce(bad), bad === '3' ? 3 : 1, String(bad));
});

test('how many fit: each slot keeps the whole context, so each needs that much more memory; the most that fit, at least 1', () => {
  // A 10 GB model, its 8k context 1 GB per slot, 13 GB free: 3 fit, 4 do not.
  const need = (n: number) => 10 * GB + n * GB;
  assert.equal(slots.slotsThatFit(4, need, 13 * GB), 3);
  assert.equal(slots.slotsThatFit(2, need, 13 * GB), 2);
  assert.equal(slots.slotsThatFit(4, need, 5 * GB), 1, 'never fewer than one');
});

test('a runner build that takes --parallel (and --no-kv-unified, so each slot keeps its own context) is told from its help', () => {
  const help = 'usage...\n-np,   --parallel N                     number of server slots (default: -1, -1 = auto)\n-kvu,  --kv-unified, -no-kvu, --no-kv-unified\n';
  assert.deepEqual(slots.parallelSupport(help), { parallel: true, split: true });
  assert.deepEqual(slots.parallelSupport('-np,   --parallel N   number of slots'), { parallel: true, split: false });
  assert.deepEqual(slots.parallelSupport('usage: llama-server [options]'), { parallel: false, split: false });
});

test('the plan for a load: 1 asked is 1 with nothing said; more is as many as fit, said when fewer; an older runner or Max mode stays at 1, said', () => {
  const fits = (n: number) => 10 * GB + n * GB;
  const ok = { parallel: true, split: true };
  assert.deepEqual(slots.slotPlan({ want: 1, support: ok, need: fits, free: 64 * GB, plain: true }), { n: 1, note: '' });
  assert.deepEqual(slots.slotPlan({ want: 3, support: ok, need: fits, free: 64 * GB, plain: true }), { n: 3, note: '' });
  const two = slots.slotPlan({ want: 4, support: ok, need: fits, free: 12.5 * GB, plain: true });
  assert.equal(two.n, 2);
  assert.match(two.note, /2 at once.*4 asked.*memory/);
  const old = slots.slotPlan({ want: 3, support: { parallel: false, split: false }, need: fits, free: 64 * GB, plain: true });
  assert.equal(old.n, 1);
  assert.match(old.note, /runner .*one at a time/);
  const max = slots.slotPlan({ want: 3, support: ok, need: fits, free: 64 * GB, plain: false });
  assert.equal(max.n, 1);
  assert.match(max.note, /Max mode|expert parallel/);
});

test('the runner\'s start: 1 slot is exactly as before; N slots ask for N, with N times the context so each keeps its own', () => {
  const run = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const };
  const before = chatArgs('m.gguf', 9000, 'cpu', 4, false, run);
  assert.deepEqual(chatArgs('m.gguf', 9000, 'cpu', 4, false, { ...run, slots: 1 }), before, 'At once 1: nothing changes');
  assert.ok(!before.includes('-np'));
  const three = chatArgs('m.gguf', 9000, 'cpu', 4, false, { ...run, slots: 3, slotSplit: true });
  assert.equal(three[three.indexOf('-c') + 1], String(8192 * 3));
  assert.equal(three[three.indexOf('-np') + 1], '3');
  assert.ok(three.includes('--no-kv-unified'));
  const noSplit = chatArgs('m.gguf', 9000, 'cpu', 4, false, { ...run, slots: 2 });
  assert.ok(!noSplit.includes('--no-kv-unified'));
});

test('the line with slots: up to N on the same chat model together; another model or a picture waits, as do more than N', () => {
  let now = 0;
  const slotsOf: Record<string, number> = { big: 3, small: 1 };
  const line = new nl.NodeLine({ hostFirst: () => true, slots: (m: string) => slotsOf[m] ?? 1, now: () => ++now });
  const add = (model: string, what: 'chat' | 'picture' = 'chat') => line.join({ link: `l${now}`, name: model, guest: false, what, model }) as nl.LineEntry;
  const a = add('big');
  line.start(a.id);
  const b = add('big');
  assert.equal(line.mayStart(b.id), true, 'a second slot on the same model');
  line.start(b.id);
  const c = add('small');
  assert.equal(line.mayStart(c.id), false, 'another model waits while big runs');
  line.leave(c.id);
  const d = add('big', 'picture');
  assert.equal(line.mayStart(d.id), false, 'a picture is never beside an answer');
  line.leave(d.id);
  const e = add('big');
  line.start(e.id);
  const f = add('big');
  assert.equal(line.mayStart(f.id), false, 'more than 3 wait');
  line.leave(a.id);
  assert.equal(line.mayStart(f.id), true);
});
