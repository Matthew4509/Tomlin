// Nodes keep working while the host is away, then hand the work back (src/outbox.ts, src/jobrun/pictureback.ts): a
// picture and a project step, tried with two copies in this process, each on its own temp folder. The node is a small
// door on 127.0.0.1 that does what src/jobrun/node.ts does with a request id (collect first, then start in the outbox);
// the host is the real collectPicture. The link's sealing is not part of this test (test/link.test.ts has it).
// Run: node --test test/hostaway.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as link from '../src/link.ts';
import { KEEP_MS, Outbox, replayOf, ridOf, type Follower, type Lock } from '../src/outbox.ts';
import { collectPicture, readPicture } from '../src/jobrun/pictureback.ts';
import { forNow } from '../src/queue.ts';

const keys = randomBytes(64);
const lock: Lock = { seal: (p, l) => link.sealBytes(link.toHost(keys), p, l), open: (r, l) => link.openBytes(link.toHost(keys), r, l) };
const OWNER = 'a1b2c3d4e5f60718';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (await check()) return;
  throw new Error('timed out');
}

/** A stream of events to the host, as the node's door writes it (unsealed here). */
function sse(res: ServerResponse): Follower {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
  return {
    send: (event, data) => {
      if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end: () => {
      if (!res.writableEnded) res.end();
    },
  };
}

/** A gate the made-up work waits at, opened by the test. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>(r => (open = r));
  return { p, open };
}

/** One node: its outbox on its own folder, a door that draws pictures and writes step answers, and counts of the work done. */
async function startNode(dir: string) {
  const box = new Outbox(dir);
  const n = { box, away: false, draws: 0, steps: 0, hold: gate(), server: null as unknown as Server, url: '' };
  n.server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const rid = typeof body.rid === 'string' ? body.rid : null;
      if (req.url === '/taken') {
        await box.take(OWNER, String(body.rid));
        return void res.end('{}');
      }
      // As src/jobrun/node.ts: what is running or kept for this id is handed back before any refusal.
      if (rid && (await box.collect(OWNER, rid, lock, () => sse(res), k => {
        const f = sse(res);
        for (const [e, d] of replayOf(k)) f.send(e, d);
        f.end();
      }))) return;
      if (n.away) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'I need to log off for now: someone is using this PC.' }));
      }
      if (!rid) {
        res.writeHead(400);
        return void res.end('{}');
      }
      const hold = n.hold;
      box.start(OWNER, rid, lock, sse(res), async (send, signal) => {
        if (req.url === '/draw') {
          n.draws++;
          send('progress', { state: 'drawing', step: 1, steps: 20 });
          await Promise.race([hold.p, new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('Stopped.'))))]);
          send('picture', { png: PNG.toString('base64'), modelName: 'Made-up picture model', modelPrompt: String(body.prompt), mode: 'custom', seconds: 12 });
        } else {
          n.steps++;
          send('text', { text: '=== FILE: index.html ===' });
          await hold.p;
          send('text', { text: `=== FILE: index.html ===\n<h1>${String(body.user)}</h1>\n=== END FILE ===` });
          send('done', { model: 'Made-up chat model' });
        }
      });
    });
  });
  await new Promise<void>(r => n.server.listen(0, '127.0.0.1', () => r()));
  n.url = `http://127.0.0.1:${(n.server.address() as { port: number }).port}`;
  return n;
}
type Node = Awaited<ReturnType<typeof startNode>>;

async function stopNode(n: Node) {
  n.server.closeAllConnections();
  await new Promise(r => n.server.close(() => r(undefined)));
}

/** The host asking one node (its address may change when the node is started again). */
const asker = (at: () => string, path: string, body: unknown, signal: AbortSignal) => () => fetch(`${at()}${path}`, { method: 'POST', body: JSON.stringify(body), signal });

/** A step answer read as the host reads one: the words, until done. */
async function readStep(res: Response): Promise<string> {
  const all = await res.text();
  const texts = [...all.matchAll(/^event: text\ndata: (.*)$/gm)].map(m => (JSON.parse(m[1]) as { text: string }).text);
  assert.match(all, /^event: done$/m, all);
  return texts.at(-1) ?? '';
}

const boxes = async (dir: string) => (await readdir(dir)).filter(f => f.endsWith('.box'));

async function folders() {
  const node = await mkdtemp(join(tmpdir(), 'hostaway-node-'));
  const host = await mkdtemp(join(tmpdir(), 'hostaway-host-'));
  return { node, host, done: () => Promise.all([rm(node, { recursive: true, force: true }), rm(host, { recursive: true, force: true })]) };
}

test('host away mid-picture: the node draws to the end, keeps it, and hands it to the host started again, once', async () => {
  const f = await folders();
  const node = await startNode(f.node);
  try {
    const ask = { prompt: 'a red kite over a hill', rid: ridOf({ queue: 'q1', prompt: 'a red kite over a hill' }) };
    // The host asks, then is closed while the node draws (its connection goes; no Stop is sent).
    const hostRun = new AbortController();
    const first = collectPicture({ name: 'Node', rid: ask.rid, ask: asker(() => node.url, '/draw', ask, hostRun.signal), progress: () => undefined, signal: hostRun.signal, waitMs: 20 });
    await until(() => node.draws === 1);
    hostRun.abort();
    await assert.rejects(first, /Stopped/);
    // The node keeps drawing with nobody following, and keeps the picture sealed on its disk.
    assert.ok(node.box.isRunning(OWNER, ask.rid));
    node.hold.open();
    await until(async () => (await boxes(f.node)).length === 1);
    // The host is started again and asks with the same id: the kept picture comes at once, not drawn again.
    const again = new AbortController();
    const got = await collectPicture({ name: 'Node', rid: ask.rid, ask: asker(() => node.url, '/draw', ask, again.signal), progress: () => undefined, signal: again.signal });
    assert.deepEqual(got.png, PNG);
    assert.equal(got.modelPrompt, ask.prompt);
    assert.equal(node.draws, 1);
    // Saved on the host, then taken: the node forgets it.
    await fetch(`${node.url}/taken`, { method: 'POST', body: JSON.stringify({ rid: ask.rid }) });
    assert.equal((await boxes(f.node)).length, 0);
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('the link is lost before the picture ends: the host reconnects with the same id and follows the same drawing', async () => {
  const f = await folders();
  const node = await startNode(f.node);
  try {
    const ask = { prompt: 'a lighthouse at dusk', rid: ridOf({ queue: 'q2', prompt: 'a lighthouse at dusk' }) };
    const ac = new AbortController();
    const told: string[] = [];
    const got = collectPicture({ name: 'Node', rid: ask.rid, ask: asker(() => node.url, '/draw', ask, ac.signal), progress: p => typeof p.text === 'string' && told.push(p.text), signal: ac.signal, waitMs: 30 });
    await until(() => node.draws === 1);
    // The network drops every open connection (the node itself goes on).
    node.server.closeAllConnections();
    await until(() => told.some(t => /Reconnecting/.test(t)));
    node.hold.open();
    const pic = await got;
    assert.deepEqual(pic.png, PNG);
    assert.equal(node.draws, 1, 'drawn once, not again on the reconnect');
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('the node restarted while holding a picture still hands it back; one lost mid-draw is drawn again, once', async () => {
  const f = await folders();
  let node = await startNode(f.node);
  try {
    const kept = { prompt: 'a fox in snow', rid: ridOf({ queue: 'q3', prompt: 'a fox in snow' }) };
    const ac = new AbortController();
    const first = collectPicture({ name: 'Node', rid: kept.rid, ask: asker(() => node.url, '/draw', kept, ac.signal), progress: () => undefined, signal: ac.signal });
    await until(() => node.draws === 1);
    ac.abort();
    await assert.rejects(first, /Stopped/);
    node.hold.open();
    await until(async () => (await boxes(f.node)).length === 1);
    // The node PC is restarted: a new door and a new outbox on the same folder, on another port.
    await stopNode(node);
    node = await startNode(f.node);
    assert.equal(node.box.size, 0);
    const back = new AbortController();
    const got = await collectPicture({ name: 'Node', rid: kept.rid, ask: asker(() => node.url, '/draw', kept, back.signal), progress: () => undefined, signal: back.signal });
    assert.deepEqual(got.png, PNG);
    assert.equal(node.draws, 0, 'the restarted node did not draw it again');

    // A drawing cut by a node restart is not kept: the same id asked again draws it once, and it comes back whole.
    const lost = { prompt: 'a boat on a lake', rid: ridOf({ queue: 'q4', prompt: 'a boat on a lake' }) };
    let at = node.url;
    const ac2 = new AbortController();
    const told: string[] = [];
    const going = collectPicture({ name: 'Node', rid: lost.rid, ask: asker(() => at, '/draw', lost, ac2.signal), progress: p => typeof p.text === 'string' && told.push(p.text), signal: ac2.signal, waitMs: 30 });
    await until(() => node.draws === 1);
    await stopNode(node);
    await until(() => told.some(t => /Reconnecting/.test(t)));
    node = await startNode(f.node);
    at = node.url;
    await until(() => node.draws === 1);
    node.hold.open();
    assert.deepEqual((await going).png, PNG);
    assert.equal(node.draws, 1);
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('a node whose owner is using it still hands back what it kept, and refuses new work', async () => {
  const f = await folders();
  const node = await startNode(f.node);
  try {
    const ask = { prompt: 'a windmill', rid: ridOf({ queue: 'q5', prompt: 'a windmill' }) };
    node.hold.open();
    const ac = new AbortController();
    await collectPicture({ name: 'Node', rid: ask.rid, ask: asker(() => node.url, '/draw', ask, ac.signal), progress: () => undefined, signal: ac.signal });
    node.away = true;
    const again = await collectPicture({ name: 'Node', rid: ask.rid, ask: asker(() => node.url, '/draw', ask, ac.signal), progress: () => undefined, signal: ac.signal });
    assert.deepEqual(again.png, PNG);
    const other = { prompt: 'a different picture', rid: ridOf({ queue: 'q6', prompt: 'a different picture' }) };
    await assert.rejects(collectPicture({ name: 'Node', rid: other.rid, ask: asker(() => node.url, '/draw', other, ac.signal), progress: () => undefined, signal: ac.signal }), /log off/);
    assert.equal(node.draws, 1);
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('host returning with a newer state: a changed item asks for a new picture; the stale one is never handed over and is swept', async () => {
  const f = await folders();
  const node = await startNode(f.node);
  try {
    const was = { prompt: 'a castle', rid: ridOf({ queue: 'q7', prompt: 'a castle' }) };
    const ac = new AbortController();
    const first = collectPicture({ name: 'Node', rid: was.rid, ask: asker(() => node.url, '/draw', was, ac.signal), progress: () => undefined, signal: ac.signal });
    await until(() => node.draws === 1);
    ac.abort();
    await assert.rejects(first, /Stopped/);
    node.hold.open();
    await until(async () => (await boxes(f.node)).length === 1);
    // While the host was away its item was changed: its id changes with it, so the old picture is not what comes back.
    const now = { prompt: 'a castle at night', rid: ridOf({ queue: 'q7', prompt: 'a castle at night' }) };
    assert.notEqual(now.rid, was.rid);
    const back = new AbortController();
    const got = await collectPicture({ name: 'Node', rid: now.rid, ask: asker(() => node.url, '/draw', now, back.signal), progress: () => undefined, signal: back.signal });
    assert.equal(got.modelPrompt, 'a castle at night');
    assert.equal(node.draws, 2);
    // The one nobody comes for is removed after three days.
    for (const b of await boxes(f.node)) {
      const old = new Date(Date.now() - KEEP_MS - 60_000);
      await utimes(join(f.node, b), old, old);
    }
    assert.equal(await node.box.sweep(), 2);
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('a project step: the node finishes it while the host is away, a host started again collects it once; changed files ask anew', async () => {
  const f = await folders();
  let node = await startNode(f.node);
  try {
    // The host names a step by what it asks (src/jobrun/links.ts: ridOf of the body), so the same step asked again after
    // a restart finds the same answer.
    const body = { system: 'You write web pages.', user: 'Hello', maxTokens: 1000, project: 'job1', queue: true };
    const rid = ridOf(body);
    const ac = new AbortController();
    const res = await fetch(`${node.url}/run`, { method: 'POST', body: JSON.stringify({ ...body, rid }), signal: ac.signal });
    assert.equal(res.status, 200);
    await until(() => node.steps === 1);
    ac.abort();
    node.hold.open();
    await until(async () => (await boxes(f.node)).length === 1);
    // The node is restarted too before the host comes back.
    await stopNode(node);
    node = await startNode(f.node);
    const again = await fetch(`${node.url}/run`, { method: 'POST', body: JSON.stringify({ ...body, rid: ridOf(body) }) });
    assert.match(await readStep(again), /<h1>Hello<\/h1>/);
    assert.equal(node.steps, 0, 'collected, not written again');
    // The project's files changed while the host was away: the step's question changes, and so does its id.
    const newer = { ...body, user: 'Hello again' };
    assert.notEqual(ridOf(newer), rid);
    node.hold.open();
    const fresh = await fetch(`${node.url}/run`, { method: 'POST', body: JSON.stringify({ ...newer, rid: ridOf(newer) }) });
    assert.match(await readStep(fresh), /Hello again/);
    assert.equal(node.steps, 1);
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('a picture still not collected after the wait says "lost", which the queue tries again later', async () => {
  const f = await folders();
  const node = await startNode(f.node);
  try {
    const ask = { prompt: 'a bridge', rid: ridOf({ queue: 'q8', prompt: 'a bridge' }) };
    let at = node.url;
    const ac = new AbortController();
    const going = collectPicture({ name: 'Node', rid: ask.rid, ask: asker(() => at, '/draw', ask, ac.signal), progress: () => undefined, signal: ac.signal, waitMs: 20, giveUpMs: 200 });
    await until(() => node.draws === 1);
    at = 'http://127.0.0.1:1';
    node.server.closeAllConnections();
    const e = await going.then(() => null, (x: Error & { lost?: { rid: string } }) => x);
    assert.equal(e?.lost?.rid, ask.rid);
    assert.ok(forNow(e!.message), e!.message);
    // A project step lost the same way is tried again too (src/jobrun/links.ts, src/jobrun/steps.ts words).
    assert.ok(forNow('Lost the connection to "Node" part-way: it is still working on it. Press Run step 2 again once that PC is back: its finished work is collected, not done again.'));
    node.hold.open();
    await until(async () => (await boxes(f.node)).length === 1);
  } finally {
    await stopNode(node);
    await f.done();
  }
});

test('a fault the node said is not asked again, and an older node (no id) is read as before', async () => {
  const bad = new Response('event: error\ndata: {"text":"its picture model disconnected"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  let asks = 0;
  const ac = new AbortController();
  await assert.rejects(collectPicture({ name: 'Node', rid: 'ab'.repeat(16), ask: async () => (asks++, bad), progress: () => undefined, signal: ac.signal, waitMs: 5 }), /said: its picture model disconnected/);
  assert.equal(asks, 1);
  const cut = new Response('event: progress\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(collectPicture({ name: 'Node', rid: null, ask: async () => cut, progress: () => undefined, signal: ac.signal }), /stopped before the picture was finished/);
  const ok = new Response(`event: picture\ndata: ${JSON.stringify({ png: PNG.toString('base64'), modelName: 'M' })}\n\n`);
  assert.deepEqual((await readPicture(ok, 'Node', () => undefined)).png, PNG);
});
