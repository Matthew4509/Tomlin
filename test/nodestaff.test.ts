import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED_NODE_HIRE, afterRun, cleanShared, cleanStats, keepAll, keepChat, modelRefusal, parseNodeWho, sharedList, statsModel, type LoadedFor } from '../src/nodestaff.ts';
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

test('a node shares every model on it, nothing to tick', () => {
  const models = [{ id: 'a.gguf', name: 'A-9B', bytes: 5e9 }, { id: 'b.gguf', name: 'B-2B', bytes: 1e9 }, { id: 'sub/c.gguf', name: 'C', bytes: 2e9 }];
  const list = sharedList({ models, ctxOf: id => (id === 'a.gguf' ? 16384 : 8192), loaded: id => id === 'a.gguf', busy: () => true, hidden: id => id === 'b.gguf' });
  // In the PC's own order; only a loaded model can be busy; a hidden one is still lent, marked hidden.
  assert.deepEqual(list, [
    { id: 'a.gguf', name: 'A-9B', kind: 'chat', bytes: 5e9, ctx: 16384, loaded: true, busy: true },
    { id: 'b.gguf', name: 'B-2B', kind: 'chat', bytes: 1e9, ctx: 8192, loaded: false, busy: false, hidden: true },
    { id: 'sub/c.gguf', name: 'C', kind: 'chat', bytes: 2e9, ctx: 8192, loaded: false, busy: false },
  ]);
  assert.deepEqual(sharedList({ models: [], ctxOf: () => 8192, loaded: () => true, busy: () => false }), []);
});

test('picture models can be shared too: listed after the chat models, with no context size', () => {
  const models = [{ id: 'dream', name: 'DreamShaper 8', bytes: 2e9, kind: 'image' as const }, { id: 'a.gguf', name: 'A-9B', bytes: 5e9, kind: 'chat' as const }];
  const list = sharedList({ models, ctxOf: () => 8192, loaded: id => id === 'dream', busy: id => id === 'dream' });
  assert.deepEqual(list.map(m => [m.id, m.kind, m.ctx, m.busy]), [['a.gguf', 'chat', 8192, false], ['dream', 'image', 0, true]]);
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

test('a linked PC may run any model still on the node; busy is said as busy (it waits and asks again)', () => {
  const o = { onPc: (id: string) => ({ 'a.gguf': 'A-9B', 'b.gguf': 'B-2B' } as Record<string, string>)[id] ?? null, busy: false, pcName: 'Worker PC' };
  assert.equal(modelRefusal('a.gguf', o), null);
  assert.equal(modelRefusal('b.gguf', o), null);
  assert.match(modelRefusal('gone.gguf', o)!.error, /not on "Worker PC" any more/);
  assert.equal(modelRefusal('gone.gguf', o)!.busy, undefined);
  assert.deepEqual(modelRefusal('a.gguf', { ...o, busy: true }), { error: 'A-9B is answering something else on "Worker PC" now.', busy: true });
});

test('a chat model loaded for a linked PC stays 10 minutes unused (not 60 seconds), and the node page says so', async () => {
  const { CHAT_DROP_MS } = await import('../src/nodestaff.ts');
  assert.equal(CHAT_DROP_MS, 10 * 60_000);
  const { readFileSync } = await import('node:fs');
  const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8');
  assert.match(home, /dropped by itself after 10 minutes unused/);
  assert.doesNotMatch(home, /after 60 seconds unused/);
});

// Four models loaded on a node for the same linked PC (as a speed test of several files leaves them), one for another PC.
const loadedAt = (t: number): LoadedFor => new Map([
  ['a.gguf', { by: new Set(['Laptop']), links: new Set(['L1']), at: t }],
  ['b.gguf', { by: new Set(['Laptop']), links: new Set(['L1']), at: t }],
  ['c.gguf', { by: new Set(['Laptop']), links: new Set(['L1']), at: t }],
  ['d.gguf', { by: new Set(['Other']), links: new Set(['L2']), at: t }],
]);
const ats = (m: LoadedFor) => Object.fromEntries([...m].map(([id, v]) => [id, v.at]));

test('an open chat\'s meters keep only the model that chat uses, never every model loaded for that PC', () => {
  const m = loadedAt(0);
  keepChat(m, 'L1', 'b.gguf', 500);
  assert.deepEqual(ats(m), { 'a.gguf': 0, 'b.gguf': 500, 'c.gguf': 0, 'd.gguf': 0 });
  // Another PC's chat cannot keep it, and a model not loaded for that PC is not kept.
  keepChat(m, 'L2', 'a.gguf', 900);
  assert.deepEqual(ats(m), { 'a.gguf': 0, 'b.gguf': 500, 'c.gguf': 0, 'd.gguf': 0 });
  // No model named (a chat whose model is not on this PC, or an older main PC): nothing is kept.
  keepChat(m, 'L1', '', 900);
  assert.deepEqual(ats(m), { 'a.gguf': 0, 'b.gguf': 500, 'c.gguf': 0, 'd.gguf': 0 });
});

test('an answer for a linked PC keeps every model loaded for it; a refused or failed run keeps nothing', () => {
  const m = loadedAt(0);
  afterRun(m, 'L1', false, 700);
  assert.deepEqual(ats(m), { 'a.gguf': 0, 'b.gguf': 0, 'c.gguf': 0, 'd.gguf': 0 });
  afterRun(m, 'L1', true, 800);
  assert.deepEqual(ats(m), { 'a.gguf': 800, 'b.gguf': 800, 'c.gguf': 800, 'd.gguf': 0 });
  keepAll(m, 'L2', 900);
  assert.equal(m.get('d.gguf')!.at, 900);
});

test('the model a chat\'s meters name: a linked PC\'s model in the hire\'s brain, only for that PC', () => {
  assert.equal(statsModel('remote:420e6432:Qwen3.5-35B-A3B-Q4_K_M.gguf', '420e6432'), 'Qwen3.5-35B-A3B-Q4_K_M.gguf');
  assert.equal(statsModel('remote:420e6432:Qwen3.5-35B-A3B-Q4_K_M.gguf', 'aaaaaaaa'), '');
  assert.equal(statsModel('remote:420e6432', '420e6432'), '');
  assert.equal(statsModel('qwen3.5-4b-q4_k_m.gguf', '420e6432'), '');
  assert.equal(statsModel(null, '420e6432'), '');
});

test('the node keeps models through these rules only: the meters name the chat\'s model, a run keeps all only after an answer', async () => {
  const { readFileSync } = await import('node:fs');
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(node, /function stillThere/);
  assert.match(node, /keepChat\(loadedForPc, keepOf\(who\), typeof body\.model === 'string' \? body\.model : '', Date\.now\(\)\)/);
  assert.match(node, /afterRun\(loadedForPc, link, answered, Date\.now\(\)\)/);
  const links = readFileSync(new URL('../src/jobrun/links.ts', import.meta.url), 'utf8');
  assert.match(links, /linkFetch\(r, '\/worker\/stats', \{ model: chatModel \}/);
  const thispc = readFileSync(new URL('../src/server/thispc.ts', import.meta.url), 'utf8');
  assert.match(thispc, /nodestaff\.statsModel\(/);
  const chats = readFileSync(new URL('../public/chats.js', import.meta.url), 'utf8');
  assert.match(chats, /\/api\/node\/stats\?pc=\$\{encodeURIComponent\(pc\)\}&who=\$\{encodeURIComponent\(meters\.who\)\}/);
});
