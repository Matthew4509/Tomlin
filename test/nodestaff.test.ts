import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED_NODE_HIRE, cleanShared, cleanStats, cleanTicks, modelRefusal, parseNodeWho, sharedList } from '../src/nodestaff.ts';
import { modelsOf, nowModel } from '../src/staff.ts';

test('an old chat with a hire who lived on a linked PC is still recognised, and the retirement says the way on', () => {
  assert.deepEqual(parseNodeWho('node:0a1b2c3d:clara'), { pc: '0a1b2c3d', id: 'clara' });
  assert.equal(parseNodeWho('node:xyz:clara'), null);
  assert.equal(parseNodeWho('staff:clara'), null);
  assert.match(RETIRED_NODE_HIRE, /no longer lend their own staff/);
  assert.match(RETIRED_NODE_HIRE, /Hire staff/);
});

test('a hire\'s models: default first, no repeats, no other PCs; a stale switch falls back to the default', () => {
  assert.deepEqual(modelsOf({ model: 'a', group: ['b', 'a', 'remote:0a1b2c3d', ''] }), ['a', 'b']);
  assert.equal(nowModel({ model: 'a', group: ['b'], active: 'b' }), 'b');
  assert.equal(nowModel({ model: 'a', group: [], active: 'b' }), 'a');
  assert.equal(nowModel({ model: 'remote:0a1b2c3d' }), null);
});

test("a linked PC's meters are kept only as numbers and a short name", () => {
  const s = cleanStats({ at: 5, cpu: 34.4, ram: { used: 8e9, total: 16e9 }, gpu: { name: 'Intel <b>HD</b> 520', busy: 82, used: 1e9, total: null, shared: true }, extra: 'x' });
  assert.deepEqual(s, { at: 5, cpu: 34, ram: { used: 8e9, total: 16e9 }, gpu: { name: 'Intel bHDb 520', busy: 82, used: 1e9, total: null, shared: true } });
  assert.equal(cleanStats({ cpu: 250, ram: {} })!.cpu, 100);
  assert.equal(cleanStats({ cpu: 'lots' }), null);
  assert.equal(cleanStats(null), null);
  assert.equal(cleanStats({ cpu: 3, gpu: { busy: -1 } })!.gpu!.busy, null);
});

test('a node shares only the models its owner ticked that are still on it', () => {
  const onPc = ['a.gguf', 'b.gguf', 'sub/c.gguf'];
  assert.deepEqual(cleanTicks(['b.gguf', 'gone.gguf', 'b.gguf', 7, 'sub/c.gguf'], onPc), ['b.gguf', 'sub/c.gguf']);
  assert.deepEqual(cleanTicks('a.gguf', onPc), []);
  const models = [{ id: 'a.gguf', name: 'A-9B', bytes: 5e9 }, { id: 'b.gguf', name: 'B-2B', bytes: 1e9 }, { id: 'sub/c.gguf', name: 'C', bytes: 2e9 }];
  const list = sharedList(['sub/c.gguf', 'a.gguf', 'deleted.gguf'], { models, ctxOf: id => (id === 'a.gguf' ? 16384 : 8192), loaded: id => id === 'a.gguf', busy: () => true });
  // In the PC's own order; a ticked model deleted since is left out; only a loaded model can be busy.
  assert.deepEqual(list, [
    { id: 'a.gguf', name: 'A-9B', kind: 'chat', bytes: 5e9, ctx: 16384, loaded: true, busy: true },
    { id: 'sub/c.gguf', name: 'C', kind: 'chat', bytes: 2e9, ctx: 8192, loaded: false, busy: false },
  ]);
  assert.deepEqual(sharedList([], { models, ctxOf: () => 8192, loaded: () => true, busy: () => false }), []);
});

test('picture models can be shared too: listed after the chat models, with no context size', () => {
  const models = [{ id: 'dream', name: 'DreamShaper 8', bytes: 2e9, kind: 'image' as const }, { id: 'a.gguf', name: 'A-9B', bytes: 5e9, kind: 'chat' as const }];
  const list = sharedList(['dream', 'a.gguf'], { models, ctxOf: () => 8192, loaded: id => id === 'dream', busy: id => id === 'dream' });
  assert.deepEqual(list.map(m => [m.id, m.kind, m.ctx, m.busy]), [['a.gguf', 'chat', 8192, false], ['dream', 'image', 0, true]]);
  assert.deepEqual(cleanTicks(['dream', 'a.gguf'], ['a.gguf', 'dream']), ['dream', 'a.gguf']);
});

test("the host keeps only safe shapes of a node's shared models", () => {
  const got = cleanShared([
    { id: 'a.gguf', name: 'A <b>9B</b>', bytes: 5e9, ctx: 16384, loaded: true, busy: 'yes', extra: 1 },
    { id: 'a.gguf', name: 'again' },
    { id: 'bad\u0007id', name: 'x' },
    { id: '', name: 'none' },
    { id: 'c.gguf', bytes: -4, ctx: 'big' },
    { id: 'dream', name: 'DreamShaper 8', kind: 'image', ctx: 8192 },
    { id: 'odd', kind: 'video' },
    'junk',
  ]);
  // An older node sends no kind: its models are chat models.
  assert.deepEqual(got, [
    { id: 'a.gguf', name: 'A b9B/b', kind: 'chat', bytes: 5e9, ctx: 16384, loaded: true, busy: false },
    { id: 'c.gguf', name: 'c.gguf', kind: 'chat', bytes: 0, ctx: 8192, loaded: false, busy: false },
    { id: 'dream', name: 'DreamShaper 8', kind: 'image', bytes: 0, ctx: 0, loaded: false, busy: false },
    { id: 'odd', name: 'odd', kind: 'chat', bytes: 0, ctx: 8192, loaded: false, busy: false },
  ]);
  assert.deepEqual(cleanShared(null), []);
  assert.equal(cleanShared(Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` }))).length, 40);
});

test('a linked PC may run a model only when it is ticked and still there; busy is said as busy (it waits and asks again)', () => {
  const o = { ticked: ['a.gguf'], onPc: (id: string) => ({ 'a.gguf': 'A-9B', 'b.gguf': 'B-2B' } as Record<string, string>)[id] ?? null, busy: false, pcName: 'Worker PC' };
  assert.equal(modelRefusal('a.gguf', o), null);
  assert.match(modelRefusal('b.gguf', o)!.error, /does not let other PCs use B-2B/);
  assert.equal(modelRefusal('b.gguf', o)!.busy, undefined);
  assert.match(modelRefusal('gone.gguf', { ...o, ticked: ['gone.gguf'] })!.error, /not on "Worker PC" any more/);
  assert.deepEqual(modelRefusal('a.gguf', { ...o, busy: true }), { error: 'A-9B is answering something else on "Worker PC" now.', busy: true });
});
