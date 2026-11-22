// Every fault, one at a time, must end: a load, a fallback or a retry stops at a known count in a final state, and what
// is said about it is said once, however often the page asks for the status (it asks every second). Each fault is driven
// with stand-ins (a runner that writes the given lines, a linked PC or download server that stops answering, temp
// folders), never a real model, a real linked PC or a real TOMLIN.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pane, type PaneFault } from '../src/pane.ts';
import { fileFault, MAX_STOPPED, TEMPLATE_FAULT, whyItFailed } from '../src/llama.ts';
import type { Device } from '../src/runtimes.ts';
import * as Q from '../src/queue.ts';
import { KEEP_MS, OWED_GIVE_UP_MS, owedExpired, owedExpiredWhy, owedLine, settle, withOwedLine, type Owed } from '../src/outbox.ts';
import { fallbackPick, makeFault, nextTry, orderTries, RunHistory, tryOptions, type TryOption } from '../src/faults.ts';
import { peerFetch } from '../src/jobrun/peercall.ts';
import type { PeerOut } from '../src/peerlink.ts';
import { wakeNode } from '../src/wake.ts';
import { fetchChecked } from '../src/download.ts';
import * as DQ from '../src/dlqueue.ts';
import { streamChat } from '../src/engine.ts';
import * as jobs from '../src/jobs.ts';
import type { ChatLine } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'tomlin-faultloops-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- The page's fault box and chat notes, run as the page runs them (taken from public/app.js) ----

type Kid = { text?: string; kids: Kid[]; dataset: Record<string, string>; textContent: string };
const make = (_tag: string, o: { text?: string } = {}, ...kids: Kid[]): Kid => ({ text: o.text, kids, dataset: {}, get textContent() { return this.text ?? ''; }, set textContent(v: string) { this.text = v; } });
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const showFaultSrc = /function showFault\(box, text, detail, note\) \{[\s\S]*?\n\}/.exec(app)?.[0];
const sayOnceSrc = /function sayOnce\(box, text, make\) \{[\s\S]*?\n\}/.exec(app)?.[0];
assert.ok(showFaultSrc && sayOnceSrc, 'showFault and sayOnce are in public/app.js');
type Box = { hidden: boolean; dataset: Record<string, string>; kids: Kid[]; readonly lastElementChild: Kid | null; replaceChildren(...k: Kid[]): void; append(...k: Kid[]): void };
const newBox = (): Box => ({ hidden: true, dataset: {}, kids: [], get lastElementChild() { return this.kids.at(-1) ?? null; }, replaceChildren(...k) { this.kids = k; }, append(...k) { this.kids.push(...k); } });
const showFault = new Function('el', `${showFaultSrc}; return showFault;`)(make) as (b: Box, t: string | null, d?: string | null, n?: string | null) => void;
const sayOnce = new Function(`${sayOnceSrc}; return sayOnce;`)() as (b: Box, t: string, m: (t: string) => Kid) => Kid;
/** Every piece of text in the box, nested ones too. */
const texts = (b: { kids: Kid[] }): string[] => b.kids.flatMap(k => [...(k.text ? [k.text] : []), ...texts(k)]);

/** The fault box drawn from the pane's status `polls` times, as drawPane does once a second: its text, counted. */
function drawnOverPolls(v: { state: string; error?: string | null; detail?: string | null; note?: string | null }, polls = 30): string[] {
  const box = newBox();
  for (let i = 0; i < polls; i++) showFault(box, v.state === 'failed' ? v.error ?? null : null, v.detail, v.state === 'failed' ? v.note : null);
  return texts(box);
}

/** No line said twice: every text in the list is there once. */
function saidOnce(list: string[], where: string): void {
  const seen = new Map<string, number>();
  for (const t of list) seen.set(t, (seen.get(t) ?? 0) + 1);
  for (const [t, n] of seen) assert.equal(n, 1, `${where}: "${t.slice(0, 80)}" is said ${n} times`);
}

/** A note's sentences, each once ("CUDA could not run it …" never twice for one load). */
function sentencesOnce(note: string | null | undefined, where: string): void {
  saidOnce(String(note ?? '').split(/(?<=\.)\s+/).filter(Boolean), where);
}

// ---- 1. Model loads: a stand-in runner writes the lines a real one wrote for each fault ----

const runner = join(dir, 'runner.mjs');
writeFileSync(runner, [
  "const [mode, b64] = process.argv.slice(2);",
  "const lines = Buffer.from(b64, 'base64').toString();",
  "if (mode === 'fail') { process.stderr.write(lines + '\\n'); setTimeout(() => process.exit(1), 50); }",
  "else if (mode === 'crash') setTimeout(() => { process.stderr.write(lines + '\\n'); setTimeout(() => process.exit(3), 20); }, 800);",
  "else setTimeout(() => process.exit(0), 30000);",
].join('\n'));

// What llama.cpp b11284 (the shipped runner) writes for each fault, trimmed. The missing file's lines were written by the
// shipped CPU runner on 21 Nov 2026 for a file that was not there; the unknown type's on 20 Nov (test/filefault.test.ts).
const TAILS = {
  missing: "0.00.062.919 E gguf_init_from_file: failed to open GGUF file 'C:/models/gone-Q4_K_M.gguf' (No such file or directory)\n0.00.062.944 E llama_model_load: error loading model: llama_model_loader: failed to load model from C:/models/gone-Q4_K_M.gguf\n0.00.063.418 E srv  llama_server: exiting due to model loading error",
  damaged: 'gguf_init_from_file_impl: invalid magic characters: GGUX\nllama_model_load: error loading model',
  unknownType: "gguf_init_from_reader: tensor 'token_embd.weight' has invalid ggml type 45. should be in [0, 43)\ngguf_init_from_reader: failed to read tensor info\nllama_model_load: error loading model",
  outOfMemory: 'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory\nllama_model_load: error loading model: unable to allocate CUDA0 buffer',
  crashAtStart: 'ggml_abort: GGML_ASSERT(ctx->mem_buffer != NULL) failed',
  template: 'common_chat_templates_init: failed to parse chat template: Unable to generate parser for this template',
};

interface Run { started: Device[]; faults: PaneFault[] }

function ask(mode: 'fail' | 'crash' | 'hang', tail: (d: Device) => string, run: Run, o: { retry?: boolean; timeoutSeconds?: number; ready?: boolean } = {}) {
  const spec = (device: Device) => {
    run.started.push(device);
    return { exe: process.execPath, args: () => [runner, mode, Buffer.from(tail(device)).toString('base64')], ready: async () => !!o.ready, device, timeoutSeconds: o.timeoutSeconds ?? 30 };
  };
  return {
    model: 'gone-Q4_K_M.gguf', modelName: 'gone-Q4_K_M', asked: 'auto' as const, threads: 0,
    devices: ['cuda', 'vulkan', 'cpu'] as Device[], expectedSeconds: 1,
    build: spec,
    // As src/server/panes.ts: a chat format fault is tried once more on the same device with the plain formats.
    ...(o.retry ? { retry: (device: Device, t: string) => (TEMPLATE_FAULT.test(t) ? spec(device) : null) } : {}),
    why: (t: string) => whyItFailed(t, 'gone-Q4_K_M.gguf'),
    fileFault,
    note: 'Context 8,192 tokens.',
  };
}

/** One load to its end, then the status asked as the page asks it: nothing more starts, nothing more is said. */
async function loadEnds(mode: 'fail' | 'hang', tail: (d: Device) => string, o: { retry?: boolean; timeoutSeconds?: number } = {}) {
  const run: Run = { started: [], faults: [] };
  const was = Pane.onFault;
  Pane.onFault = f => run.faults.push(f);
  try {
    const pane = new Pane('chat');
    const view = await pane.connect(ask(mode, tail, run, o));
    const startedThen = run.started.length;
    const first = JSON.stringify(pane.view);
    // The page asks for the status every second: the answer stays the same, and nothing starts again by itself.
    for (let i = 0; i < 5; i++) {
      await sleep(120);
      assert.equal(JSON.stringify(pane.view), first, 'the status stays the same over repeated asks');
    }
    assert.equal(run.started.length, startedThen, 'nothing started again after the load ended');
    return { view, run };
  } finally {
    Pane.onFault = was;
  }
}

/** The bounds every failed load keeps: a final state, at most two starts a device, one fault kept, said once. */
function bounded(view: Pane['view'], run: Run, label: string): void {
  assert.equal(view.state, 'failed', `${label}: ends failed`);
  assert.ok(run.started.length <= 2 * 3, `${label}: ${run.started.length} starts, more than two a device`);
  assert.equal(run.faults.length, 1, `${label}: the fault is kept once`);
  sentencesOnce(view.note, `${label} note`);
  const drawn = drawnOverPolls(view);
  saidOnce(drawn, `${label} fault box`);
  assert.ok(drawn.includes(view.error!), `${label}: the fault is drawn`);
}

for (const [label, tail, starts] of [
  ['a missing model file', TAILS.missing, ['cuda']],
  ['a damaged model file', TAILS.damaged, ['cuda']],
  ['an unknown quant type', TAILS.unknownType, ['cuda']],
  ['out of memory on every device', TAILS.outOfMemory, ['cuda', 'vulkan', 'cpu']],
  ['a runner that crashes as it starts', TAILS.crashAtStart, ['cuda', 'vulkan', 'cpu']],
] as const) {
  test(`load fault, ${label}: ends after ${starts.length} start(s), said once over 30 polls`, async () => {
    const { view, run } = await loadEnds('fail', () => tail);
    assert.deepEqual(run.started, starts);
    bounded(view, run, label);
  });
}

test('load fault, a missing file is said as not there (not "try once more"), and stops at the first device', async () => {
  assert.equal(fileFault(TAILS.missing), true);
  assert.match(whyItFailed(TAILS.missing), /is not there any more/);
  assert.doesNotMatch(whyItFailed(TAILS.missing), /Try once more/);
});

test('load fault, a chat format the runner cannot read: tried once more with plain formats, then it stops (not on every device)', async () => {
  const { view, run } = await loadEnds('fail', () => TAILS.template, { retry: true });
  assert.deepEqual(run.started, ['cuda', 'cuda']);
  bounded(view, run, 'chat format');
  assert.match(view.error ?? '', /chat format/);
});

test('load fault, a start that runs out of time is not started again, here or on another device', async () => {
  const { view, run } = await loadEnds('hang', () => '', { timeoutSeconds: 1 });
  assert.deepEqual(run.started, ['cuda']);
  bounded(view, run, 'time up');
  assert.match(view.error ?? '', /still starting after/);
});

test('load fault, a retry that is offered every time still stops at two starts a device', async () => {
  // Not a file fault (out of memory each time), with a retry offered after every start: two a device, three devices.
  const run: Run = { started: [], faults: [] };
  const was = Pane.onFault;
  Pane.onFault = f => run.faults.push(f);
  try {
    const req = ask('fail', () => TAILS.outOfMemory, run);
    const view = await new Pane('chat').connect({ ...req, retry: (device: Device) => req.build(device) });
    assert.deepEqual(run.started, ['cuda', 'cuda', 'vulkan', 'vulkan', 'cpu', 'cpu']);
    bounded(view, run, 'retry every time');
  } finally {
    Pane.onFault = was;
  }
});

test('a runner that crashes while loaded: failed once, kept once, never loaded again by itself', async () => {
  const run: Run = { started: [], faults: [] };
  const was = Pane.onFault;
  Pane.onFault = f => run.faults.push(f);
  try {
    const pane = new Pane('chat');
    const view = await pane.connect(ask('crash', () => 'CUDA error: an illegal memory access was encountered\nggml_abort', run, { ready: true }));
    assert.equal(view.state, 'connected');
    // It crashes 0.8 s after it started; the fault is kept half a second after its exit (its last lines come late).
    // Waited for, not timed: under the whole suite the stand-in starts slower.
    for (const end = Date.now() + 15_000; Date.now() < end && !(pane.view.state === 'failed' && run.faults.length); ) await sleep(100);
    await sleep(800);
    assert.equal(pane.view.state, 'failed');
    assert.deepEqual(run.started, ['cuda'], 'not loaded again by itself');
    assert.equal(run.faults.length, 1);
    assert.equal(run.faults[0].kind, 'crash');
    const first = JSON.stringify(pane.view);
    await sleep(600);
    assert.equal(JSON.stringify(pane.view), first);
    saidOnce(drawnOverPolls(pane.view), 'crash fault box');
  } finally {
    Pane.onFault = was;
  }
});

test('a Max mode lender that left while loaded: said once', () => {
  saidOnce(drawnOverPolls({ state: 'failed', error: MAX_STOPPED, detail: 'rpc: failed to connect to 192.168.1.20:50052', note: 'Max mode: 1 PC lends its card.' }), 'Max mode stop');
});

// ---- 2. The queue: an item whose PC is busy or off is put back, up to a known count, never for ever ----

test('a queued item whose PC stays off is put back at most MAX_TRIES times, then fails; its note never grows', () => {
  const error = 'The linked PC "Worker PC" could not be reached at http://192.168.1.20:8740 (fetch failed).';
  let tries: number | undefined;
  let note = '';
  let rounds = 0;
  let out: ReturnType<typeof Q.againLater<{ state: Q.QState; error?: string }>> = { state: 'failed', error };
  for (; rounds < 1000; rounds++) {
    out = Q.againLater({ state: 'failed' as Q.QState, error }, tries, 1_000_000);
    if (out.state !== 'waiting') break;
    assert.ok('tries' in out);
    tries = out.tries;
    if (note) assert.equal(out.note, note, 'the note is the last reason, not a pile of them');
    note = out.note;
  }
  assert.equal(rounds, Q.MAX_TRIES);
  assert.equal(out.state, 'failed');
  assert.ok(Q.MAX_TRIES * Q.AGAIN_MS <= 2 * 3600_000, 'it gives up within two hours');
});

test('a model that did not load is never put back by the queue: the same file would fail the same way', () => {
  const said = [...Object.values(TAILS), '', 'TOMLIN stopped waiting for this model to start after 3 minutes.', 'rpc: failed to connect to 192.168.1.20'].map(t => whyItFailed(t, 'Qwen3.8-TQ3_0.gguf'));
  for (const why of [...said, MAX_STOPPED]) {
    // As src/jobrun/who.ts brainForRef words it, and as a linked PC sends it back.
    for (const error of [`Qwen3.8 did not load for in Team: ${why}`, `"Worker PC" said: Qwen3.8 did not load for in Team: ${why}`]) {
      assert.equal(Q.forNow(error), false, error);
      assert.equal(Q.againLater({ state: 'failed' as Q.QState, error }, 0).state, 'failed', error);
    }
  }
  // Even when the runner's own words happen to say busy or not answering.
  assert.equal(Q.forNow('Qwen3.8 did not load for in Team: the device is busy and not answering.'), false);
});

// ---- 3. Owed answers: a linked PC lost part-way is asked once a minute, but not for ever ----

test('an owed answer from a PC that never comes back is given up after its keep time, and its line is drawn once', () => {
  const at = '2026-11-01T10:00:00.000Z';
  const o: Owed = { rid: 'a'.repeat(24), pc: 'p1', name: 'Worker PC', chatId: 'b'.repeat(12), ran: 'Qwen 3 4B on Worker PC', at };
  let lines: ChatLine[] = [{ role: 'user', content: 'Hello', at }];
  // Each minute's round: the stand-in line is added once, the same words so far change nothing.
  for (let i = 0; i < 60; i++) {
    lines = withOwedLine(lines, o) ?? lines;
    lines = settle(lines, o.rid, { state: 'working', text: 'Hel' }) ?? lines;
  }
  assert.equal(lines.length, 2);
  assert.equal(lines.filter(l => l.waiting).length, 1);
  const t0 = Date.parse(at);
  assert.equal(owedExpired(o, t0 + KEEP_MS), false, 'still asked while the node may keep it');
  assert.equal(owedExpired(o, t0 + OWED_GIVE_UP_MS + 1), true);
  assert.equal(owedExpired({ at: 'not a date' }), false);
  lines = settle(lines, o.rid, { state: 'gone', why: owedExpiredWhy(o.name) })!;
  assert.equal(lines.filter(l => l.waiting).length, 0, 'not asked for again');
  assert.match(lines[1].note ?? '', /did not answer for over 4 days/);
  // Given up once: another round changes nothing (no second note).
  assert.equal(settle(lines, o.rid, { state: 'gone', why: owedExpiredWhy(o.name) }), undefined);
  assert.equal(owedLine(o).waiting?.rid, o.rid);
});

test('the server gives an owed answer up when its PC stays silent past the keep time', () => {
  const src = readFileSync(new URL('../src/server/owed.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(!said\) \{[\s\S]{0,300}owedExpired\(o\)[\s\S]{0,300}dropOwed\(o\.rid\)/);
});

// ---- 4. Crash fallback and the guided list: each runner once, then it stops ----

test('repeated crashes move a model through the card runners once each, then leave it as it is', async () => {
  const history = await new RunHistory(join(dir, 'run-history.json')).load();
  const pins: Omit<TryOption, 'kind'>[] = [
    { pin: 'llama-cuda', name: 'CUDA 12.4', device: 'cuda', build: 'b11284', installed: true, bytes: 0, why: '' },
    { pin: 'llama-cuda13', name: 'CUDA 13.4', device: 'cuda', build: 'b11284', installed: true, bytes: 0, why: '' },
    { pin: 'llama-vulkan', name: 'Vulkan', device: 'vulkan', build: 'b11284', installed: true, bytes: 0, why: '' },
    { pin: 'llama-cpu', name: 'CPU', device: 'cpu', build: 'b11284', installed: true, bytes: 0, why: '' },
  ];
  const deviceOf = (pin: string) => pins.find(p => p.pin === pin)!.device;
  let on = 'llama-cuda';
  const moved: string[] = [];
  for (let i = 0; i < 20; i++) {
    await history.failure(makeFault({ pc: 'This PC', model: 'm.gguf', modelName: 'M', runner: on, runnerName: 'llama.cpp b11284', device: deviceOf(on), kind: 'crash', tail: 'ggml_abort' }));
    const shaky = history.shaky('This PC', 'm.gguf');
    shaky.add(on);
    const next = fallbackPick(tryOptions({ runner: on, device: deviceOf(on) }, pins, shaky), shaky);
    if (!next) break;
    moved.push(next.pin);
    on = next.pin;
  }
  assert.deepEqual(moved, ['llama-cuda13', 'llama-vulkan'], 'each card runner once, never the CPU on its own');
  // The guided notice: each suggestion once, then none.
  const shaky = history.shaky('This PC', 'm.gguf');
  const list = orderTries(tryOptions({ runner: 'llama-cuda', device: 'cuda' }, pins, shaky), { shaky, worked: history.workedOn('This PC') });
  const tried = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const t = nextTry(list, tried);
    if (!t) break;
    assert.ok(!tried.has(t.pin));
    tried.add(t.pin);
  }
  assert.ok(tried.size <= pins.length);
  assert.equal(nextTry(list, tried), null);
});

// ---- 5. A linked PC not answering: each address once, within its time ----

function listen(handler: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

test('a linked PC that takes the request and never answers: each address tried once, given up in time', async () => {
  let asked = 0;
  const { server, port } = await listen(() => {
    asked++;
  });
  try {
    const peer = { id: 'peer1', pc: 'p1', name: 'Worker PC', addrs: ['127.0.0.1', '127.0.0.2'], port, token: 'tok', key: randomBytes(64).toString('base64url'), scopes: [], expires: null, by: '', rev: 0 } as unknown as PeerOut;
    const t0 = Date.now();
    const got = await peerFetch(peer, '/api/peer/hello', {}, 400);
    assert.ok('tried' in got, 'it did not answer');
    assert.deepEqual(got.tried.map(t => t.address), ['127.0.0.1', '127.0.0.2']);
    assert.equal(asked, 1, 'the silent address is asked once');
    assert.ok(Date.now() - t0 < 2 * 400 + 3000, 'given up within its time');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('waking a PC that never comes back: one wake, asked until its wait is over, then false', async () => {
  let now = 0;
  let sends = 0;
  let asks = 0;
  const woke = await wakeNode({ mac: 'aa:bb:cc:dd:ee:ff', send: async () => void sends++, reached: async () => (asks++, false), waitMs: 90_000, stepMs: 3000, sleep: async ms => void (now += ms), now: () => now });
  assert.equal(woke, false);
  assert.equal(sends, 1);
  assert.equal(asks, 30);
});

// ---- 6. A download that stops: one request (two after a 416), and it stays stopped until he asks again ----

test('a download cut off part-way fails once and keeps its part; Download again carries on from it', async () => {
  const body = randomBytes(1000);
  const hash = createHash('sha256').update(body).digest('hex');
  const ranges: string[] = [];
  const { server, port } = await listen((req, res) => {
    ranges.push(String(req.headers.range ?? ''));
    const from = Number(/bytes=(\d+)-/.exec(String(req.headers.range ?? ''))?.[1] ?? 0);
    if (ranges.length === 1) {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, 400));
      setTimeout(() => res.destroy(), 50);
      return;
    }
    res.writeHead(206, { 'content-length': String(body.length - from) });
    res.end(body.subarray(from));
  });
  try {
    const dest = join(dir, 'cut', 'model.gguf');
    await assert.rejects(fetchChecked(`http://127.0.0.1:${port}/f`, dest, body.length, hash));
    assert.equal(ranges.length, 1, 'not fetched again by itself');
    assert.equal(statSync(`${dest}.part`).size, 400);
    assert.equal(await fetchChecked(`http://127.0.0.1:${port}/f`, dest, body.length, hash), 'kept');
    assert.deepEqual(ranges, ['', 'bytes=400-']);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a server that refuses every range: the part goes, one fresh start, then it fails (no third ask)', async () => {
  let asked = 0;
  const { server, port } = await listen((_req, res) => {
    asked++;
    res.writeHead(416);
    res.end();
  });
  try {
    const dest = join(dir, 'refused', 'model.gguf');
    await fetchChecked(`http://127.0.0.1:${port}/f`, dest, 10, 'f'.repeat(64)).catch(() => undefined);
    writeFileSync(`${dest}.part`, 'abc');
    await assert.rejects(fetchChecked(`http://127.0.0.1:${port}/f`, dest, 10, 'f'.repeat(64)), /could not start/);
    assert.equal(asked, 1 + 2);
    assert.equal(existsSync(`${dest}.part`), false);
  } finally {
    server.close();
  }
});

test('a download that does not match its check is deleted and fails once', async () => {
  let asked = 0;
  const { server, port } = await listen((_req, res) => {
    asked++;
    res.writeHead(200, { 'content-length': '10' });
    res.end('0123456789');
  });
  try {
    const dest = join(dir, 'badhash', 'model.gguf');
    await assert.rejects(fetchChecked(`http://127.0.0.1:${port}/f`, dest, 10, 'f'.repeat(64)), /SHA-256/);
    assert.equal(asked, 1);
    assert.equal(existsSync(`${dest}.part`), false);
  } finally {
    server.close();
  }
});

test('a failed or stopped download is not started again by the list, nor by a restart; only Download again', () => {
  const item = (id: string, state: DQ.DlState): DQ.DlItem => ({ id, repo: 'a/b', rev: 'main', name: id, bytes: 10, files: [{ path: `${id}.gguf`, bytes: 10, sha256: 'f'.repeat(64) }], to: 'models', drive: '', state, got: 4, error: state === 'failed' ? 'The download could not start: the server answered 500. Try again later.' : '', added: '2026-11-21T00:00:00.000Z', by: 'This PC' });
  let list = [item('x', 'failed'), item('y', 'stopped')];
  for (let i = 0; i < 10; i++) {
    assert.equal(DQ.nextUp(list), undefined);
    list = DQ.afterRestart(list);
  }
  assert.deepEqual(list.map(x => x.state), ['failed', 'stopped']);
  list = DQ.again(list, 'x');
  assert.equal(DQ.nextUp(list)?.id, 'x');
  assert.equal(list.find(x => x.id === 'x')?.error, '', 'its old fault is not carried on under it');
});

// ---- 7. A chat answer cut off: asked once, marked cut, never asked again by itself ----

function runner500(streams: (res: import('node:http').ServerResponse) => void) {
  let asked = 0;
  return listen((req, res) => {
    req.resume();
    req.on('end', () => {
      asked++;
      streams(res);
    });
  }).then(s => ({ ...s, asked: () => asked }));
}
const piece = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;

test('an answer cut at its length limit: one ask, marked cut (Continue is his to press)', async () => {
  const m = await runner500(res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(piece('The start of a long') + piece(' answer', 'length') + 'data: [DONE]\n\n');
  });
  try {
    const r = await streamChat(`http://127.0.0.1:${m.port}`, 'qwen3.5-4b', [{ role: 'user', content: 'Hi' }], () => {}, new AbortController().signal, 16);
    assert.equal(r.cut, true);
    assert.equal(m.asked(), 1);
  } finally {
    m.server.close();
  }
});

test('an answer whose runner goes quiet part-way: ended as cut after the quiet time, one ask', async () => {
  const m = await runner500(res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(piece('Half of it'));
    // and then nothing more, the connection left open
  });
  try {
    const r = await streamChat(`http://127.0.0.1:${m.port}`, 'qwen3.5-4b', [{ role: 'user', content: 'Hi' }], () => {}, new AbortController().signal, 512, { stallMs: 300 });
    assert.equal(r.cut, true);
    assert.equal(m.asked(), 1);
  } finally {
    m.server.closeAllConnections();
    m.server.close();
  }
});

test('an answer whose runner drops the connection part-way: one fault, not asked again', async () => {
  const m = await runner500(res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(piece('Half of it'));
    setTimeout(() => res.destroy(), 50);
  });
  try {
    await streamChat(`http://127.0.0.1:${m.port}`, 'qwen3.5-4b', [{ role: 'user', content: 'Hi' }], () => {}, new AbortController().signal, 512).catch(() => undefined);
    assert.equal(m.asked(), 1);
  } finally {
    m.server.close();
  }
});

// ---- 8. A job step that keeps failing its checks: a known number of tries ----

test('a job step that fails its checks is tried a known, small number of times', () => {
  assert.ok(Number.isInteger(jobs.STEP_TRIES) && jobs.STEP_TRIES >= 1 && jobs.STEP_TRIES <= 3);
  const nothing = ['The answer changed nothing: every file came back exactly as it was.'];
  assert.equal(jobs.repeatsNoChange(nothing, nothing), true, 'the same "nothing changed" twice ends the step');
  const src = readFileSync(new URL('../src/jobrun/steps.ts', import.meta.url), 'utf8');
  assert.match(src, /for \(let attempt = 0; attempt < jobs\.STEP_TRIES; attempt\+\+\)/);
});

// ---- 9. The general guard on the page: the same words in the same place are one line with a count ----

test('the same note said again and again in a chat is one line with a count; other words are their own line', () => {
  const log = newBox();
  const line = (t: string) => make('div', { text: t });
  for (let i = 0; i < 17; i++) sayOnce(log, '"Worker PC" did not answer: check that PC is on and TOMLIN is open there, then press Reconnect again.', line);
  assert.equal(log.kids.length, 1);
  assert.match(log.kids[0].textContent, /\(said 17 times\)$/);
  sayOnce(log, 'The chat model is still loading: send again once it says Connected.', line);
  sayOnce(log, 'The chat model is still loading: send again once it says Connected.', line);
  assert.equal(log.kids.length, 2);
  assert.match(log.kids[1].textContent, /\(said 2 times\)$/);
  // The first words again after other words: a new line (what came between is kept in its place).
  sayOnce(log, '"Worker PC" did not answer: check that PC is on and TOMLIN is open there, then press Reconnect again.', line);
  assert.equal(log.kids.length, 3);
  const view = readFileSync(new URL('../public/chatview.js', import.meta.url), 'utf8');
  assert.match(view, /app\.chatNote = text => \{[\s\S]{0,300}sayOnce\(log, text,/);
});
