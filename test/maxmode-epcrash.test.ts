// An expert-parallel runner crash (25 Nov 2026: build b11284 stopped with 0xC0000409 three times, at load and part-way)
// is kept per model and runner build (src/maxmode.ts MaxSpeeds.epCrashed): expert parallel is not used for that model
// again until Max is switched on again or a newer expert runner is installed, and no load of it starts by itself after
// a crash once loaded. The runner's install is told apart by src/runtimes.ts expertStamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MaxSpeeds, epCrashWords, epHeldWords, maxEngine, maxRoute, maxGate, reloadWhy, type GatePc } from '../src/maxmode.ts';
import { Runtimes } from '../src/runtimes.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const opt = { build: 'b11284', device: 'cuda' as const, pin: 'p', have: true, tested: true };
const gate = maxGate({ pcs: [{ id: 'z820', name: 'Z820', hello: { can: ['max'], allow: { lend: true } }, options: [opt] } as GatePc], linked: 1, host: [opt] });

function speeds(dir: string) {
  const writes: Promise<void>[] = [];
  const s = new MaxSpeeds(() => join(dir, 'max-speeds.json'), (f, text) => {
    const p = (writes.at(-1) ?? Promise.resolve()).then(() => writeFile(f, text));
    writes.push(p);
    return p;
  });
  return { s, done: () => Promise.all(writes) };
}

test('a crash once loaded: expert parallel is not used for that model, said in plain words, and nothing loads by itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-epcrash-'));
  try {
    const { s, done } = speeds(dir);
    assert.equal(s.epCrash('qwen3-next'), null);
    const c = s.epCrashed('qwen3-next', { name: 'Qwen3-Next-80B', build: 'b11284', stamp: '100:1', when: 'loaded' });
    assert.equal(c.held, true);
    // Max mode's engine says so and goes the automatic way (this PC alone for a model that fits).
    const measured = s.get('qwen3-next', ['z820']);
    assert.equal(measured.crashed?.build, 'b11284');
    const e = maxEngine({ model: 'Qwen3-Next-80B', moe: true, cuda: true, measured });
    assert.equal(e.use, 'alone');
    assert.match(e.words, /^Max mode: expert parallel is not used for Qwen3-Next-80B: the expert-parallel runner \(llama\.cpp b11284\) crashed while it was loaded \(\d{1,2} [A-Z][a-z]{2},? \d{2}:\d{2}\)\. It is used again for this model once Max is switched off and on again in the chat, or a newer expert-parallel runner is installed$/);
    assert.equal(maxRoute({ asked: true, fits: true, gate, engine: e }), 'auto');
    assert.match(reloadWhy({ fitsAlone: true, gate, engine: e, loanBusy: '' }), /^expert parallel is not used for Qwen3-Next-80B/, 'Reload with linked PCs says why and unloads nothing');
    // Even a faster Max measured before does not bring it back.
    assert.equal(maxEngine({ model: 'm', moe: true, cuda: true, measured: { alone: 1, max: 9, crashed: c } }).use, 'alone');
    // Another model is not touched.
    assert.equal(s.get('other', ['z820']).crashed, undefined);
    // Held: the words for a load nobody asked for, and the person's own load lets it go.
    assert.match(epHeldWords(c), /^Qwen3-Next-80B was not loaded again by itself: the expert-parallel runner \(llama\.cpp b11284\) crashed with it .*Load it yourself \(Connect, or send a message in the chat\): it then loads without expert parallel\.$/);
    s.epLetGo('qwen3-next');
    assert.equal(s.epCrash('qwen3-next')?.held, false);
    assert.ok(s.epCrash('qwen3-next'), 'letting it load again keeps expert parallel off');
    // Kept in the file: a restart remembers.
    await done();
    const again = new MaxSpeeds(() => join(dir, 'max-speeds.json'), async () => undefined);
    assert.deepEqual([again.epCrash('qwen3-next')?.build, again.epCrash('qwen3-next')?.held], ['b11284', false]);
    assert.ok(JSON.parse(readFileSync(join(dir, 'max-crashes.json'), 'utf8'))['qwen3-next']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash while loading is kept too, but holds nothing (that load starts again without expert parallel)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-epcrash-'));
  try {
    const { s } = speeds(dir);
    const c = s.epCrashed('flash', { name: 'Qwen3.8-Flash-Next', build: 'b11284', stamp: 's', when: 'loading' });
    assert.equal(c.held, false);
    assert.match(epCrashWords(c), /crashed while loading it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Max switched on again, or a newer expert runner installed: the crash is forgotten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-epcrash-'));
  try {
    const { s } = speeds(dir);
    s.epCrashed('a', { name: 'A', build: 'b11284', stamp: '100:1', when: 'loaded' });
    s.epCrashed('b', { name: 'B', build: 'b11284', stamp: '100:1', when: 'loaded' });
    // The same build still installed (or its stamp not known): kept.
    assert.ok(s.epCrash('a', '100:1'));
    assert.ok(s.epCrash('a', ''));
    // Another build installed: forgotten for that model.
    assert.equal(s.epCrash('a', '200:2'), null);
    assert.equal(s.epCrash('a'), null);
    assert.ok(s.epCrash('b'));
    // Max switched on again in a chat: every crash forgotten, the names given for the log.
    assert.deepEqual(s.epForgive(), ['B']);
    assert.equal(s.epCrash('b'), null);
    assert.deepEqual(s.epForgive(), []);
    assert.equal(maxEngine({ model: 'B', moe: true, cuda: true, measured: s.get('b', ['z820']) }).use, 'experts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the expert runner installed now is told apart by its llama.dll (another build is a new stamp)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-epstamp-'));
  try {
    const pins = join(dir, 'runtimes.json');
    writeFileSync(pins, JSON.stringify({ runtimes: {} }));
    const app = join(dir, 'app');
    const home = join(dir, 'home');
    const rt = new Runtimes(app, pins, home);
    assert.equal(rt.expertStamp(''), '', 'none installed');
    const folder = join(home, 'llama-cuda-experts', 'llama-b11284-bin-win-cuda');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), 'x');
    assert.equal(rt.expertStamp(''), '', 'a runner without its llama.dll is not the patched one');
    writeFileSync(join(folder, 'llama.dll'), 'LLAMA_EXPERT_SPLIT');
    utimesSync(join(folder, 'llama.dll'), new Date('2026-11-15T10:00:00Z'), new Date('2026-11-15T10:00:00Z'));
    const first = rt.expertStamp('');
    assert.match(first, /^\d+:\d+$/);
    writeFileSync(join(folder, 'llama.dll'), 'LLAMA_EXPERT_SPLIT, a newer build');
    utimesSync(join(folder, 'llama.dll'), new Date('2026-12-01T10:00:00Z'), new Date('2026-12-01T10:00:00Z'));
    assert.notEqual(rt.expertStamp(''), first);
    // The folder TOMLIN_EXPERT_RUNNER names is looked in first.
    const said = join(dir, 'mine');
    mkdirSync(said);
    writeFileSync(join(said, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), 'x');
    writeFileSync(join(said, 'llama.dll'), 'y');
    assert.match(rt.expertStamp(said), /^1:\d+$/, 'its one-byte llama.dll, not the home folder\'s');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the load and the crash notice are wired: kept on a crash, not tried again, nothing loaded by itself', () => {
  const panes = src('src/server/panes.ts');
  const place = panes.slice(panes.indexOf('async function placeChat('), panes.indexOf('const loading = runner.connect('));
  assert.match(place, /const epCrash = maxSpeeds\.epCrash\(id, runtimes\.expertStamp\(\)\);/);
  assert.match(place, /if \(main \|\| o\.max\) maxSpeeds\.epLetGo\(id\);\s*else if \(!tryRun && !forced\) \{[\s\S]*?return \{ error: said \};/, 'a load the person did not ask for is refused while held');
  assert.match(place, /const ep = !epCrash && started\.moe/, 'expert parallel is not tried again after a crash');
  // A start that fails on the vision add-on is tried again without it first (src/askpics.ts); then the expert parallel case.
  assert.match(panes, /retry: \(device, tail\) => \([\s\S]*?\(ep \? \(log\.info\([\s\S]*?epFailed\(tail\)\)/, 'a failed expert-parallel start is kept');
  const faults = src('src/server/faults.ts');
  assert.match(faults, /const ep = p\.kind === 'crash' && !f\.gone \? epCrashKept\(p, f\.modelName\) : '';/);
  assert.match(faults, /maxRunOf\(pane\)\?\.engine !== 'experts'/, 'only a runner that held its model by expert parallel');
});
