// The line at a real node door (src/nodeline.ts, src/jobrun/node.ts): this copy is a node, its chat model a stand-in
// for llama-server that takes a while to answer, and test clients ask through sealed links, as a host and as guests.
// A request that cannot start now waits in the line on its open answer and is told its place; the host's own link goes
// before guests; one request per guest; an older TOMLIN gets the old busy reply; a request whose PC goes leaves the
// line; and a guest's answer and prompt are capped. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import net from 'node:net';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as link from '../src/link.ts';
import { hashToken } from '../src/share.ts';
import { useTestEnv } from './env.ts';

// The node's link door listens on every address; held here to this PC's own.
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...a: unknown[]) {
  if (a[1] === '0.0.0.0') a[1] = '127.0.0.1';
  return (listen as (...x: unknown[]) => net.Server).apply(this, a);
} as typeof listen;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>((ok, no) => {
  const s = net.createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});

/** Waits until `check` is true, looking every 20 ms (the line changes on events here, not on a clock); fails with `what` after a minute. */
async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  for (const t0 = Date.now(); !(await check()); await sleep(20)) if (Date.now() - t0 > ms) throw new Error(`Waited ${ms / 1000} s for ${what}`);
}

/** What the stand-in runner was asked, in order: the last message's words, and the answer length asked for. */
const asked: { text: string; max: number }[] = [];
let answerMs = 1200;
/**
 * While set, the stand-in runner holds every answer until the test lets it go (`letGo`), so a request is still being
 * answered for as long as the test needs, however slow the PC is. Unset: it answers after `answerMs`.
 */
let held: Promise<void> | null = null;
let letGo = () => {};
const hold = () => { held = new Promise<void>(r => (letGo = () => { held = null; r(); })); };

const HOME = mkdtempSync(join(tmpdir(), 'tomlin-nodeline-'));
const PORT = await freePort();
const RUNNER = await freePort();
const DOOR = await freePort();
useTestEnv({ TOMLIN_HOME: HOME, TOMLIN_PORT: String(PORT), TOMLIN_NO_TOAST: '1', TOMLIN_OPEN: '', TOMLIN_STARTUP_DIR: join(HOME, 'startup'), TOMLIN_MODELS_FILE: join(HOME, 'models-folder.txt') });
mkdirSync(join(HOME, 'startup'), { recursive: true });
mkdirSync(join(HOME, 'models', 'chat'), { recursive: true });
mkdirSync(join(HOME, 'data'), { recursive: true });
writeFileSync(join(HOME, 'models-folder.txt'), '');
writeFileSync(join(HOME, 'models', 'chat', 'fake-1B.gguf'), 'GGUF-not-really');
writeFileSync(join(HOME, 'data', 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync('2468', 'feed', 32).toString('hex'), idleMinutes: 0 }));
writeFileSync(join(HOME, 'data', 'share.json'), JSON.stringify({ on: true, port: DOOR, name: 'Line node', id: 'aaaa1111', code: 'TEST-NQDE', pinOn: false, pin: '', paired: [], models: [], allow: {} }));

const runner = httpServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', async () => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const b = JSON.parse(raw || '{}') as { messages: { content: string }[]; max_tokens?: number; n_predict?: number };
    asked.push({ text: String(b.messages.at(-1)?.content ?? ''), max: Number(b.max_tokens ?? b.n_predict ?? 0) });
    if (held) await held;
    else await sleep(answerMs);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 5, predicted_per_second: 50, prompt_n: 5, prompt_per_second: 50 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>(r => runner.listen(RUNNER, '127.0.0.1', r));

await import('../src/server.ts');
const panes = await import('../src/server/panes.ts');
const node = await import('../src/jobrun/node.ts');
const modelId = panes.chatList()[0].id;
const pane = panes.main() as unknown as { worker: { port: number; view: Record<string, unknown> } };
pane.worker.port = RUNNER;
pane.worker.view = { ...pane.worker.view, state: 'connected', model: modelId, modelName: 'fake-1B', device: 'cpu', pid: 1 };
await waitFor('the node\'s link door', () => fetch(`http://127.0.0.1:${DOOR}/worker/whoami`).then(r => r.ok, () => false));

// Links written as this node's owner would have them: one host (admin) and three guests on one live pass.
interface Made { token: string; keys: Buffer; name: string }
const made = (name: string, guest: boolean): Made => {
  const m = { token: randomBytes(32).toString('hex'), keys: randomBytes(64), name };
  node.shareState.paired.push({ name, hash: hashToken(m.token), key: link.keysText(m.keys), at: new Date().toISOString(), keep: randomBytes(8).toString('hex'), ...(guest ? { role: 'guest' as const, passId: 'line0001', expires: null } : {}) });
  return m;
};
node.shareState.passes = [{ id: 'line0001', label: 'Line pass', key: Buffer.alloc(32, 9).toString('base64url'), length: 'none', created: new Date().toISOString(), expires: null, nodes: ['aaaa1111'], models: [modelId], uses: 0, lastSeen: null, rev: 1 }];
const HOST = made('Main PC', false);
const G1 = made('Guest one', true);
const G2 = made('Guest two', true);
const G3 = made('Guest three', true);

after(async () => {
  runner.close();
  setTimeout(() => process.exit(0), 300);
});

/** One /worker/run on a link: its status, and every event of its answer as opened (or the refusal). */
async function run(m: Made, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; events: { event: string; data: any }[]; json: any }> {
  const sealed = link.sealRequest(m.keys, '/worker/run', body);
  const res = await fetch(`http://127.0.0.1:${DOOR}/worker/run`, { method: 'POST', headers: { authorization: `Link ${hashToken(m.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(sealed), signal });
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    const raw = (await res.json()) as { box?: string };
    return { status: res.status, events: [], json: raw.box ? link.openAnswer(m.keys, link.requestId(sealed.box), 0, raw.box) : raw };
  }
  const text = await new Response(link.openStream(m.keys, link.requestId(sealed.box), res.body!)).text();
  const events = [...text.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(x => ({ event: x[1], data: JSON.parse(x[2]) }));
  return { status: res.status, events, json: null };
}
const ask = (words: string, extra: Record<string, unknown> = {}) => ({ user: words, maxTokens: 100, line: true, ...extra });
/** Who waits in the line now, by name, and how many are being answered. */
const waiting = () => node.shareView().line.waiting.map((x: { name: string }) => x.name).join(', ');
const running = () => node.shareView().line.running.length;

test('the line: the first starts, the rest wait on their open answer told their place; the host\'s own link goes before a guest who came earlier', async () => {
  asked.length = 0;
  hold();
  const g1 = run(G1, ask('from guest one'));
  await waitFor('guest one to be answered', () => running() === 1 && asked.length === 1);
  const g2 = run(G2, ask('from guest two'));
  await waitFor('guest two in the line', () => waiting() === 'Guest two');
  const host = run(HOST, ask('from the host'));
  await waitFor('the host before guest two', () => waiting() === 'Main PC, Guest two');
  // While they wait: one request per guest, and an older TOMLIN (no line) is told busy as before.
  const twice = await run(G2, ask('guest two again'));
  assert.equal(twice.status, 409);
  assert.equal(twice.json.busy, true);
  assert.match(twice.json.error, /one request/);
  const old = await run(HOST, { user: 'an older TOMLIN', maxTokens: 50 });
  assert.equal(old.status, 409);
  assert.equal(old.json.busy, true);
  const view = node.shareView().line;
  assert.equal(view.running.length, 1);
  assert.deepEqual(view.waiting.map((x: { name: string }) => x.name), ['Main PC', 'Guest two']);
  letGo();
  const [r1, r2, r3] = await Promise.all([g1, g2, host]);
  for (const r of [r1, r2, r3]) assert.ok(r.events.some(e => e.event === 'done'), JSON.stringify(r.events));
  assert.deepEqual(asked.map(x => x.text), ['from guest one', 'from the host', 'from guest two']);
  const placed = r2.events.filter(e => e.event === 'status').map(e => String(e.data.text));
  assert.ok(placed.some(t => /^2nd in line/.test(t)), placed.join(' | '));
  assert.ok(placed.some(t => /^1st in line/.test(t)), 'told again as it moved up');
  assert.deepEqual(node.shareView().line, { running: [], waiting: [] });
});

test('a request whose PC goes away (or presses Stop) leaves the line; the next one goes on', async () => {
  asked.length = 0;
  hold();
  const first = run(HOST, ask('first'));
  await waitFor('the first to be answered', () => running() === 1 && asked.length === 1);
  const ac = new AbortController();
  const gone = run(G3, ask('never asked'), ac.signal).catch(() => null);
  await waitFor('guest three in the line', () => waiting() === 'Guest three');
  assert.deepEqual(node.shareView().line.waiting.map((x: { name: string }) => x.name), ['Guest three']);
  ac.abort();
  await gone;
  await waitFor('guest three to leave the line', () => waiting() === '');
  assert.deepEqual(node.shareView().line.waiting, []);
  // The next one waits behind the first (still held), then goes on when the first is done.
  const nextAsked = run(G1, ask('next'));
  await waitFor('the next one in the line', () => waiting() === 'Guest one');
  letGo();
  const next = await nextAsked;
  await first;
  assert.ok(next.events.some(e => e.event === 'done'));
  assert.deepEqual(asked.map(x => x.text), ['first', 'next']);
});

test('a guest\'s answer length is capped and a prompt over the cap is refused, said plainly; the host\'s own link is not capped', async () => {
  node.shareState.guestCaps = { answer: 300, prompt: 1000 };
  asked.length = 0;
  answerMs = 50;
  const long = await run(G1, ask('x'.repeat(1500)));
  const said = long.status === 200 ? long.events.find(e => e.event === 'error')?.data.text : long.json.error;
  assert.match(String(said), /1000 characters/);
  await run(G1, ask('short', { maxTokens: 5000 }));
  await run(HOST, ask('host asks', { maxTokens: 5000 }));
  assert.equal(asked.find(x => x.text === 'short')!.max <= 300, true, JSON.stringify(asked));
  assert.ok(asked.find(x => x.text === 'host asks')!.max > 300, JSON.stringify(asked));
  const hello = node.shareView();
  assert.deepEqual(hello.guestCaps, { answer: 300, prompt: 1000, web: true, tools: true });
});

/** One sealed request on a link at any door: its status and the answer opened. */
async function knock(m: Made, path: string, body: Record<string, unknown>): Promise<{ status: number; json: any; text: string }> {
  const sealed = link.sealRequest(m.keys, path, body);
  const res = await fetch(`http://127.0.0.1:${DOOR}${path}`, { method: 'POST', headers: { authorization: `Link ${hashToken(m.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(sealed) });
  const raw = (await res.json()) as { box?: string };
  const json = raw.box ? link.openAnswer(m.keys, link.requestId(sealed.box), 0, raw.box) : raw;
  return { status: res.status, json, text: JSON.stringify(json) };
}

test('a guest that says it does not know the line still waits in it (only the line holds the owner\'s 5 minutes)', async () => {
  node.shareState.guestCaps = undefined;
  asked.length = 0;
  answerMs = 50;
  hold();
  const host = run(HOST, ask('host first'));
  await waitFor('the host to be answered', () => running() === 1 && asked.length === 1);
  // An older TOMLIN's request, as a guest: it is not told "busy" (the old path), it waits its turn in the line.
  const asking = run(G1, { user: 'guest, no line', maxTokens: 50, line: false });
  await waitFor('the guest in the line', () => waiting() === 'Guest one');
  letGo();
  const g = await asking;
  await host;
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.ok(g.events.some(e => e.event === 'status' && /in line/.test(String(e.data.text))), JSON.stringify(g.events));
  assert.ok(g.events.some(e => e.event === 'done'), JSON.stringify(g.events));
  assert.deepEqual(asked.map(x => x.text), ['host first', 'guest, no line']);
});

test('a model not on the guest\'s pass is refused at /worker/run and /worker/draw, before it joins the line', async () => {
  answerMs = 50;
  const chat = await run(G2, ask('hello', { model: 'not-on-the-pass' }));
  assert.equal(chat.status, 403, JSON.stringify(chat));
  assert.equal(chat.json.guest, 'scope');
  const old = await run(G2, { user: 'hello', maxTokens: 50, model: 'not-on-the-pass' });
  assert.equal(old.status, 403, JSON.stringify(old));
  const draw = await knock(G2, '/worker/draw', { prompt: 'a red boat', model: 'not-on-the-pass', line: true });
  assert.equal(draw.status, 403, draw.text);
  assert.equal(draw.json.guest, 'scope');
  // With reference pictures (about 1 MB each, as base64): taken in and checked like any draw, not refused as too large.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(1 << 20)]).toString('base64');
  const withRefs = await knock(G2, '/worker/draw', { prompt: 'Ember on a red boat', model: 'not-on-the-pass', line: true, refImages: [png, png] });
  assert.equal(withRefs.status, 403, withRefs.text);
  assert.equal(withRefs.json.guest, 'scope');
  assert.deepEqual(node.shareView().line, { running: [], waiting: [] });
});

test('a node says it takes reference pictures with a picture (draw-refs), to a guest too', async () => {
  const hello = await knock(G2, '/worker/hello', {});
  assert.equal(hello.status, 200, hello.text);
  assert.ok(hello.json.can.includes('draw-refs'), hello.text);
});

test('one guest cannot read or stop another link\'s kept answer', async () => {
  answerMs = 50;
  const rid = randomBytes(12).toString('hex');
  const mine = await run(G1, ask('kept for guest one', { rid }));
  assert.ok(mine.events.some(e => e.event === 'done'));
  const other = await knock(G2, '/worker/result', { rid });
  assert.equal(other.status, 404, other.text);
  assert.doesNotMatch(other.text, /ok/);
  const host = await knock(HOST, '/worker/result', { rid });
  assert.equal(host.status, 404, 'not the host\'s either');
  await knock(G2, '/worker/stop', { rid });
  const own = await knock(G1, '/worker/result', { rid });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.state, 'done');
});

test('a guest\'s hello says only what it may use: no computer name, no loaded models\' names, no meter, no owner times', async () => {
  const { hostname } = await import('node:os');
  const h = await knock(G1, '/worker/hello', {});
  assert.equal(h.status, 200, h.text);
  assert.equal(h.json.memory, null);
  assert.equal(h.json.meter, null);
  assert.equal(h.json.away, null);
  assert.equal(h.json.up, null);
  assert.equal(h.json.runner, null);
  assert.equal(typeof h.json.busy, 'boolean');
  assert.ok(!h.text.toLowerCase().includes(hostname().toLowerCase()), 'no Windows computer name');
  assert.doesNotMatch(h.text, /"held"/);
  assert.ok(h.json.models.every((m: { id: string }) => m.id === modelId), 'only the pass\'s models');
  // The host's own link is told all of it, as before.
  const full = await knock(HOST, '/worker/hello', {});
  assert.ok(full.json.memory && full.json.memory.computer, full.text.slice(0, 300));
  assert.ok(full.json.meter !== undefined);
});
