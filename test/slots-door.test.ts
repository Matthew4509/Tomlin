// "At once" at a real node door (src/slots.ts, src/nodeline.ts, src/jobrun/node.ts): this copy is a node whose chat
// model is a stand-in for llama-server that counts how many answers it writes at the same moment. With At once 2 and a
// runner started with 2 slots, two answers run together and a third waits its turn, in the order asked even behind a
// long prompt; each answer carries only its own words; At once 1 is the line of Phase 4; the setting is kept.
// Nothing here measures speed: tools/slotspeed.ts is for that, on a real PC. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import net from 'node:net';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as link from '../src/link.ts';
import { hashToken } from '../src/share.ts';
import { useTestEnv } from './env.ts';

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

/** What the runner was asked, in the order the answers started, with every message's words; and the most at once. */
const asked: { last: string; all: string }[] = [];
let inFlight = 0;
let most = 0;

const HOME = mkdtempSync(join(tmpdir(), 'tomlin-slots-'));
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
writeFileSync(join(HOME, 'data', 'share.json'), JSON.stringify({ on: true, port: DOOR, name: 'Slots node', id: 'aaaa1111', code: 'TEST-NQDE', pinOn: false, pin: '', paired: [], models: [], allow: {} }));

const runner = httpServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', async () => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const b = JSON.parse(raw || '{}') as { messages: { content: string }[] };
    asked.push({ last: String(b.messages.at(-1)?.content ?? ''), all: b.messages.map(m => m.content).join('\n') });
    most = Math.max(most, ++inFlight);
    await sleep(900);
    inFlight--;
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
// As if the runner had been started with 2 slots (src/server/panes.ts records how many it was started with).
panes.runnerSlots.set(panes.main(), 2);
for (let i = 0; i < 100 && (await fetch(`http://127.0.0.1:${DOOR}/worker/whoami`).then(r => r.ok, () => false)) === false; i++) await sleep(100);

interface Made { token: string; keys: Buffer }
const made = (name: string, guest: boolean): Made => {
  const m = { token: randomBytes(32).toString('hex'), keys: randomBytes(64) };
  node.shareState.paired.push({ name, hash: hashToken(m.token), key: link.keysText(m.keys), at: new Date().toISOString(), keep: randomBytes(8).toString('hex'), ...(guest ? { role: 'guest' as const, passId: 'slot0001', expires: null } : {}) });
  return m;
};
node.shareState.passes = [{ id: 'slot0001', label: 'Slot pass', key: Buffer.alloc(32, 9).toString('base64url'), length: 'none', created: new Date().toISOString(), expires: null, nodes: ['aaaa1111'], models: [modelId], uses: 0, lastSeen: null, rev: 1 }];
const HOST = made('Main PC', false);
const G1 = made('Guest one', true);
const G2 = made('Guest two', true);

after(async () => {
  runner.close();
  setTimeout(() => process.exit(0), 300);
});

async function run(m: Made, body: Record<string, unknown>): Promise<{ status: number; events: { event: string; data: any }[] }> {
  const sealed = link.sealRequest(m.keys, '/worker/run', body);
  const res = await fetch(`http://127.0.0.1:${DOOR}/worker/run`, { method: 'POST', headers: { authorization: `Link ${hashToken(m.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(sealed) });
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return { status: res.status, events: [] };
  const text = await new Response(link.openStream(m.keys, link.requestId(sealed.box), res.body!)).text();
  return { status: res.status, events: [...text.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(x => ({ event: x[1], data: JSON.parse(x[2]) })) };
}
const ask = (words: string, extra: Record<string, unknown> = {}) => ({ model: modelId, turns: [{ role: 'user', content: words }], maxTokens: 100, line: true, ...extra });

test('At once 2 on a runner with 2 slots: two answers together, a third waits its turn, in the order asked even behind a long prompt', async () => {
  node.shareState.atOnce = 2;
  asked.length = 0;
  most = 0;
  const long = run(HOST, ask(`marker-host ${'long prompt words '.repeat(800)}`));
  await sleep(150);
  const one = run(G1, ask('marker-one'));
  await sleep(150);
  const two = run(G2, ask('marker-two'));
  const [a, b, c] = await Promise.all([long, one, two]);
  for (const r of [a, b, c]) assert.ok(r.events.some(e => e.event === 'done'), JSON.stringify(r));
  assert.equal(most, 2, 'two at once, never three');
  assert.deepEqual(asked.map(x => /marker-(\w+)/.exec(x.last)?.[1]), ['host', 'one', 'two'], 'started in the order asked');
  assert.ok(c.events.some(e => e.event === 'status' && /in line/.test(String(e.data.text))), 'the third was told its place');
  // Each answer carries only its own words: no other request's in what the runner was sent.
  for (const x of asked) {
    const mine = /marker-(\w+)/.exec(x.last)![1];
    for (const other of ['host', 'one', 'two'].filter(o => o !== mine)) assert.ok(!x.all.includes(`marker-${other}`), `${mine} saw ${other}`);
  }
});

test('At once 1: the line of Phase 4, one at a time, whatever the runner was started with', async () => {
  node.shareState.atOnce = 1;
  asked.length = 0;
  most = 0;
  await Promise.all([run(HOST, ask('marker-a')), run(G1, ask('marker-b')), run(G2, ask('marker-c'))]);
  assert.equal(most, 1);
  assert.equal(asked.length, 3);
});

test('the setting is kept (app lock PIN), shown, and a value out of range is 1', async () => {
  const r = await node.setShare({ appPin: '2468', atOnce: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.parse(readFileSync(join(HOME, 'data', 'share.json'), 'utf8')).atOnce, 3);
  assert.equal(node.shareView().atOnce, 3);
  await node.setShare({ appPin: '2468', atOnce: 9 });
  assert.equal(node.shareView().atOnce, 1);
});
