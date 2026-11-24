// Max mode's "is Max faster than this PC alone?" (src/maxmode.ts MaxSpeeds, maxEngine) compares like with like: the
// speeds of the same model at the same context and about as full a chat. On 25 Nov 2026 a full 64k chat's 3.5 tok/s was
// set against an empty 32k Max run (2.8 tok/s), so Max was judged worth it while this PC alone writes about 8 there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MaxSpeeds, atKey, fullBand, maxEngine, maxRoute, maxGate, type GatePc } from '../src/maxmode.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function speeds(dir: string) {
  const writes: Promise<void>[] = [];
  const s = new MaxSpeeds(() => join(dir, 'max-speeds.json'), (f, text) => {
    const p = (writes.at(-1) ?? Promise.resolve()).then(() => writeFile(f, text));
    writes.push(p);
    return p;
  });
  return { s, done: () => Promise.all(writes) };
}

const LENDERS = ['hp800', 'z820'];
const EMPTY_32K = { ctx: 32768, full: 0 };

test('the 25 Nov case: a full 64k chat is not this PC alone at 32k, so Max is not judged faster by it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxat-'));
  try {
    const { s } = speeds(dir);
    // Earlier, this PC alone in an empty 32k chat, then tonight a full 64k chat (the last speed kept).
    s.record('qwen3-next', [], 8, 400, { ctx: 32768, full: 0.05 });
    s.record('qwen3-next', [], 3.5, 400, { ctx: 65536, full: 0.95 });
    // The Max run, an empty 32k chat.
    s.record('qwen3-next', LENDERS, 2.8, 400, { ctx: 32768, full: 0.02 });
    // Without a context (an older caller), every answer's figure, whatever its context: 8 and 3.5 mixed.
    assert.deepEqual(s.get('qwen3-next', LENDERS), { alone: 5.8, max: 2.8 });
    // A load starting at 32k (an empty chat): the empty 32k speeds only.
    const at32 = s.get('qwen3-next', LENDERS, EMPTY_32K);
    assert.deepEqual(at32, { alone: 8, max: 2.8 });
    const engine = maxEngine({ model: 'Qwen3-Next-80B', moe: true, cuda: true, measured: at32 });
    assert.equal(engine.use, 'alone');
    assert.equal(engine.words, 'Max mode: not used for this model, it was faster alone (8 against 2.8 tok/s)');
    const gate = maxGate({ pcs: [{ id: 'z820', name: 'Z820', hello: { can: ['max'], allow: { lend: true } }, options: [{ build: 'b11284', device: 'cuda', pin: 'p', have: true, tested: true }] } as GatePc], linked: 1, host: [{ build: 'b11284', device: 'cuda', pin: 'p', have: true, tested: true }] });
    assert.equal(maxRoute({ asked: true, fits: true, gate, engine }), 'auto', 'Max on loads it as with Max off');
    // At 64k, empty: nothing comparable for this PC alone (only a full chat was measured there): unknown, not 3.5.
    assert.deepEqual(s.get('qwen3-next', LENDERS, { ctx: 65536, full: 0 }), {});
    assert.deepEqual(s.get('qwen3-next', LENDERS, { ctx: 65536, full: 0.9 }), { alone: 3.5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no comparable reading for this PC alone: unknown, so the Max speed is said without a mismatched one beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxat-'));
  try {
    const { s } = speeds(dir);
    s.record('m', [], 3.5, 400, { ctx: 65536, full: 1 });
    s.record('m', LENDERS, 2.8, 400, { ctx: 32768, full: 0 });
    const measured = s.get('m', LENDERS, EMPTY_32K);
    assert.deepEqual(measured, { max: 2.8 });
    const e = maxEngine({ model: 'm', moe: true, cuda: true, measured });
    assert.deepEqual([e.use, e.trial], ['experts', false]);
    assert.equal(e.words, 'Max mode: expert parallel, last measured 2.8 tok/s (this PC alone: not measured yet)');
    // Nothing at all at that context: the first Max load there is the measurement.
    assert.equal(maxEngine({ model: 'm', moe: true, cuda: true, measured: s.get('m', LENDERS, { ctx: 8192, full: 0 }) }).trial, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fill bands, the key, and a context that cannot be compared', () => {
  assert.deepEqual([0, 0.25, 0.26, 0.75, 0.76, 1].map(full => fullBand({ ctx: 32768, full })), ['short', 'short', 'half', 'half', 'full', 'full']);
  assert.equal(atKey({ ctx: 32768, full: 0.1 }), '32768|short');
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxat-'));
  try {
    const { s } = speeds(dir);
    // An answer whose context is not known counts only in every answer's figure.
    s.record('m', [], 8, 400);
    s.record('m', [], 9, 400, { ctx: 0, full: 0 });
    assert.deepEqual(s.get('m', [], EMPTY_32K), {}, 'no reading kept for a context');
    assert.deepEqual(s.get('m', [], { ctx: Number.NaN, full: 0 }), {}, 'an unknown context is unknown, never another one');
    assert.equal(s.get('m', []).alone, 8.5);
    // Two answers in one band at one context: their middle, as every answer's figure is.
    s.record('m', [], 7, 400, { ctx: 32768, full: 0.1 });
    s.record('m', [], 8, 400, { ctx: 32768, full: 0.2 });
    s.record('m', [], 2, 400, { ctx: 32768, full: 0.9 });
    assert.equal(s.get('m', [], EMPTY_32K).alone, 7.5);
    assert.equal(s.get('m', [], { ctx: 32768, full: 0.8 }).alone, 2);
    assert.equal(s.get('m', [], { ctx: 32768, full: 0.5 }).alone, undefined, 'a half-full chat was never measured');
    // Short answers do not count anywhere.
    s.record('m', [], 50, 20, { ctx: 32768, full: 0 });
    assert.equal(s.get('m', [], EMPTY_32K).alone, 7.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the speeds at each context are kept in the file and read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxat-'));
  try {
    const { s, done } = speeds(dir);
    s.record('m', [], 8, 400, { ctx: 32768, full: 0 });
    s.record('m', ['z'], 2.8, 400, { ctx: 32768, full: 0 });
    s.record('m', [], 3.5, 400, { ctx: 65536, full: 1 });
    await done();
    const kept = JSON.parse(readFileSync(join(dir, 'max-speeds.json'), 'utf8'));
    assert.deepEqual(Object.keys(kept['m|'].by).sort(), ['32768|short', '65536|full']);
    const again = new MaxSpeeds(() => join(dir, 'max-speeds.json'), async () => undefined);
    assert.deepEqual(again.get('m', ['z'], EMPTY_32K), { alone: 8, max: 2.8 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Max load decides with the speeds of its own context in an empty chat', () => {
  const panes = readFileSync(join(ROOT, 'src/server/panes.ts'), 'utf8');
  const place = panes.slice(panes.indexOf('async function placeChat('), panes.indexOf('const maxPath = maxRoute('));
  assert.match(place, /measured: maxSpeeds\.get\(id, gate\.ids, \{ ctx: run\.ctx, full: 0 \}\)/);
});
