// The cluster test door (src/cluster/testdoor.ts, the node's side; src/cluster/testwire.ts, the asking PC's side;
// tools/cluster-test.ts): a linked PC times the network and this PC's RPC server with nobody here, under Max mode's
// rules, sealed or (when asked) not encrypted, and never longer than allowed. Everything runs on 127.0.0.1 with a
// made-up link; no real PC, no runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import * as share from '../src/share.ts';
import * as link from '../src/link.ts';
import { NO_ALLOW } from '../src/carry.ts';
import type { Presence, RpcProgram } from '../src/maxlend.ts';
import { CLUSTER_TEST_DOOR, clusterTestUpgrade, readAsk, testEnds, TEST_MAX_MINUTES, TEST_MINUTES, type DoorDeps } from '../src/cluster/testdoor.ts';
import { openTestWire, testBridge, type StreamNews } from '../src/cluster/testwire.ts';
import { probe } from '../src/cluster/harness.ts';
import { findPc, testSummary } from '../tools/cluster-test.ts';
import type { Remote } from '../src/store.ts';

const keysText = link.keysText(randomBytes(64));
const token = randomBytes(32).toString('hex');
const NOBODY: Presence = { idleMs: 30 * 60_000, locked: false };
const SOMEONE: Presence = { idleMs: 1_000, locked: false };

interface Rig {
  state: share.ShareState;
  presence: Presence | null;
  lending: string | null;
  program: RpcProgram | null;
  said: string[];
  stops: number;
  rpcServer: Server | null;
  url: string;
  close: () => Promise<void>;
}

/** `old`: the door answers the "why" request as TOMLIN 2.0.89 does (it does not know it, so it refuses it). */
async function rig(o: { old?: boolean } = {}): Promise<Rig> {
  const r: Rig = {
    state: { ...share.DEFAULT_SHARE, on: true, name: 'Big PC', paired: [{ name: 'Main PC', hash: share.hashToken(token), at: '', key: keysText }], allow: { ...NO_ALLOW, lend: true }, lendIdle: 5 },
    presence: NOBODY,
    lending: null,
    program: { exe: 'ggml-rpc-server.exe', device: 'cuda', threads: 4, build: 'b11284' },
    said: [],
    stops: 0,
    rpcServer: null,
    url: '',
    close: async () => undefined,
  };
  const taken = new link.Seen();
  const deps: DoorDeps = {
    state: () => r.state,
    taken,
    presence: async () => r.presence,
    presenceNow: () => r.presence,
    lending: () => r.lending,
    program: build => (r.program && (!build || build === r.program.build) ? r.program : null),
    builds: () => (r.program?.build ? [r.program.build] : []),
    // The stand-in RPC server: an echo on 127.0.0.1.
    startRpc: async () => {
      const s = createServer(c => c.pipe(c)).listen(0, '127.0.0.1');
      await new Promise(res => s.once('listening', res));
      r.rpcServer = s;
      return { port: (s.address() as { port: number }).port, stop: () => { r.stops++; s.close(); } };
    },
    say: line => r.said.push(line),
  };
  const http: HttpServer = httpServer((_req, res) => res.writeHead(404).end());
  http.on('upgrade', (req, socket, head) => {
    if (o.old) {
      const opened = link.openRequest(link.keysOf(keysText)!, { box: String(req.headers['x-link'] ?? '') }, CLUSTER_TEST_DOOR, new link.Seen());
      if (!('error' in opened) && opened.body.target === 'why') {
        const body = JSON.stringify({ error: 'there is no cluster test "why" here' });
        socket.end(`HTTP/1.1 400 Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        return;
      }
    }
    void clusterTestUpgrade(req, socket, head, deps);
  });
  await new Promise<void>(res => http.listen(0, '127.0.0.1', () => res()));
  r.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  r.close = () => new Promise<void>(res => {
    http.closeAllConnections();
    http.close(() => res());
  });
  return r;
}

const remote = (url: string, t = token): Pick<Remote, 'name' | 'url' | 'token' | 'key'> => ({ name: 'Big PC', url, token: t, key: keysText });

test('the ask is checked: a 16-byte nonce, echo or rpc, minutes kept between 1 and the most allowed', () => {
  const nonce = randomBytes(16).toString('base64url');
  assert.match(String(readAsk({ nonce: 'short' })), /expected form/);
  assert.match(String(readAsk({ nonce, target: 'shell' })), /no cluster test "shell"/);
  const a = readAsk({ nonce });
  assert.ok(typeof a !== 'string');
  assert.equal(a.target, 'echo');
  assert.equal(a.plain, false, 'sealed unless asked');
  assert.equal(a.minutes, TEST_MINUTES);
  const b = readAsk({ nonce, target: 'rpc', plain: true, build: 'b11284', all: true, minutes: 999 });
  assert.ok(typeof b !== 'string');
  assert.deepEqual([b.target, b.plain, b.build, b.all, b.minutes], ['rpc', true, 'b11284', true, TEST_MAX_MINUTES]);
  const c = readAsk({ nonce, build: '../x', plain: 'yes' });
  assert.ok(typeof c !== 'string');
  assert.equal(c.build, '');
  assert.equal(c.plain, false, 'only true itself turns encryption off');
});

test('an echo through the sealed path and through the unencrypted path: layer frames come back', async () => {
  const r = await rig();
  try {
    for (const plain of [false, true]) {
      const { server, port } = await testBridge(remote(r.url), { target: 'echo', plain });
      const times = await probe('127.0.0.1', port, 256, 20);
      assert.equal(times.length, 20, plain ? 'not encrypted' : 'sealed');
      server.close();
    }
    assert.ok(r.said.some(l => /an echo, sealed/.test(l)));
    assert.ok(r.said.some(l => /an echo, NOT encrypted/.test(l)));
  } finally {
    await r.close();
  }
});

test('unencrypted means what it says: raw bytes pass through as they are', async () => {
  const r = await rig();
  try {
    const w = await openTestWire(remote(r.url), { target: 'echo', plain: true });
    assert.equal(w.plain, true);
    const sent = Buffer.from('plain bytes on the wire');
    const back = await new Promise<Buffer>(res => {
      w.socket.once('data', res);
      w.socket.write(sent);
    });
    assert.deepEqual(back, sent);
    w.socket.destroy();
    const s = await openTestWire(remote(r.url), { target: 'echo', plain: false });
    assert.equal(s.plain, false, 'sealed unless asked');
    s.socket.destroy();
  } finally {
    await r.close();
  }
});

test('the door keeps Max mode\'s rules: the cluster tick, nobody at the PC, no loan running, a known link', async () => {
  const r = await rig();
  try {
    const ask = () => openTestWire(remote(r.url), { target: 'echo', plain: true });
    r.state = { ...r.state, allow: { ...NO_ALLOW, lend: false } };
    await assert.rejects(ask(), /does not lend its card memory/);
    r.state = { ...r.state, allow: { ...NO_ALLOW, lend: true } };
    r.presence = SOMEONE;
    await assert.rejects(ask(), /someone is using "Big PC"/);
    r.presence = null;
    await assert.rejects(ask(), /could not tell whether someone is using it/);
    r.presence = NOBODY;
    r.lending = 'Main PC';
    await assert.rejects(ask(), /is lending to "Main PC" now \(Max mode\)/);
    r.lending = null;
    r.state = { ...r.state, on: false };
    await assert.rejects(ask(), /not lending to other PCs now/);
    r.state = { ...r.state, on: true };
    await assert.rejects(openTestWire(remote(r.url, 'f'.repeat(64)), { target: 'echo', plain: true }), /no longer knows this one/);
    const w = await ask();
    w.socket.destroy();
  } finally {
    await r.close();
  }
});

test('the RPC target: this PC\'s runner of the build asked for, stopped when the stream ends', async () => {
  const r = await rig();
  try {
    await assert.rejects(openTestWire(remote(r.url), { target: 'rpc', plain: true, build: 'b12250' }), /does not have the llama.cpp b12250 runner unpacked \(it has b11284\)/);
    const { server, port } = await testBridge(remote(r.url), { target: 'rpc', plain: true, build: 'b11284', all: true });
    const times = await probe('127.0.0.1', port, 128, 10);
    assert.equal(times.length, 10);
    server.close();
    for (let t = 0; t < 50 && r.stops === 0; t++) await new Promise(res => setTimeout(res, 50));
    assert.equal(r.stops, 1, 'the RPC server of the test was stopped');
    assert.ok(r.said.some(l => /this PC's RPC server \(card, RAM and cores\), NOT encrypted, 15 minutes at most/.test(l)));
  } finally {
    await r.close();
  }
});

test('a running test ends when someone starts using the PC', async () => {
  const r = await rig();
  try {
    const w = await openTestWire(remote(r.url), { target: 'echo', plain: true });
    const closed = new Promise(res => w.socket.once('close', res));
    r.presence = SOMEONE;
    await closed;
    for (let t = 0; t < 20 && !r.said.some(l => /ended: someone started using this PC/.test(l)); t++) await new Promise(res => setTimeout(res, 50));
    assert.ok(r.said.some(l => /ended: someone started using this PC/.test(l)), r.said.join(' | '));
  } finally {
    await r.close();
  }
});

test('why a running test ends, in words', () => {
  const st: share.ShareState = { ...share.DEFAULT_SHARE, on: true, allow: { ...NO_ALLOW, lend: true } };
  assert.equal(testEnds(st, NOBODY), '');
  assert.match(testEnds({ ...st, on: false }, NOBODY), /sharing was turned off/);
  assert.match(testEnds({ ...st, allow: { ...NO_ALLOW } }, NOBODY), /cluster tick was taken off/);
  assert.match(testEnds(st, SOMEONE), /someone started using this PC/);
  assert.equal(testEnds(st, null), '', 'no reading yet is not a reason to end');
});

test('the tool picks a linked PC by id, or by a name only one PC has', () => {
  const pcs = [
    { id: 'a1b2c3d4', name: 'Worker PC', url: 'http://192.168.1.21:8741', token: '', key: '' },
    { id: 'e5f6a7b8', name: 'Worker PC', url: 'http://192.168.1.22:8741', token: '', key: '' },
    { id: 'aa11', name: 'Desk', url: 'http://192.168.1.23:8741', token: '', key: '' },
  ] as Remote[];
  assert.equal((findPc(pcs, 'e5f6a7b8') as Remote).url, 'http://192.168.1.22:8741');
  assert.equal((findPc(pcs, 'desk') as Remote).id, 'aa11');
  assert.match(String(findPc(pcs, 'Worker PC')), /2 linked PCs are called "Worker PC": name one by its id/);
  assert.match(String(findPc(pcs, 'Nope')), /no linked PC here is called "Nope"/);
});

/** Opens one stream through a bridge (a connection held open, as llama.cpp's), and gathers what the bridge says. */
async function heldStream(r: Rig, plain: boolean) {
  const lines: string[] = [];
  const news: StreamNews[] = [];
  const { server, port } = await testBridge(remote(r.url), { target: 'echo', plain }, 0, l => lines.push(l), n => news.push(n));
  const c = connect(port, '127.0.0.1');
  c.on('error', () => undefined);
  const until = async (f: () => boolean, ms = 8_000) => {
    for (let t = 0; t < ms / 50 && !f(); t++) await new Promise(res => setTimeout(res, 50));
    assert.ok(f(), lines.join(' | '));
  };
  await until(() => news.some(n => n.kind === 'open'));
  return { lines, news, c, server, until };
}

test('a stream the node ends tells the asking PC why, sealed and not encrypted', async () => {
  const r = await rig();
  try {
    for (const plain of [false, true]) {
      r.presence = NOBODY;
      const h = await heldStream(r, plain);
      r.presence = SOMEONE;
      await h.until(() => h.news.some(n => n.kind === 'ended'));
      assert.deepEqual(h.lines.at(-1), 'stream 1: ended: "Big PC" ended it: someone started using this PC', plain ? 'not encrypted' : 'sealed');
      const end = h.news.find(n => n.kind === 'ended')!;
      assert.equal(end.byNode, true);
      assert.match(testSummary(end), /^The test did not run to the end: "Big PC" ended it: someone started using this PC\. If llama\.cpp says "Remote RPC server crashed/);
      h.server.close();
    }
  } finally {
    await r.close();
  }
});

test('a stream this PC closes says so, and is not summed up as the linked PC ending it', async () => {
  const r = await rig();
  try {
    const h = await heldStream(r, false);
    h.c.destroy();
    await h.until(() => h.news.some(n => n.kind === 'ended'));
    assert.equal(h.lines.at(-1), 'stream 1: ended: this PC closed it (llama.cpp or the probe here hung up)');
    assert.equal(testSummary(h.news.at(-1)!), '');
    await h.until(() => r.said.some(l => /ended: the asking PC closed the stream/.test(l)));
    h.server.close();
  } finally {
    await r.close();
  }
});

test('an older node (2.0.89) that gives no reason still works, and says so', async () => {
  const r = await rig({ old: true });
  try {
    const h = await heldStream(r, true);
    const back = await new Promise<Buffer>(res => {
      h.c.once('data', res);
      h.c.write('still an echo');
    });
    assert.equal(back.toString(), 'still an echo');
    r.presence = SOMEONE;
    await h.until(() => h.news.some(n => n.kind === 'ended'));
    assert.equal(h.lines.at(-1), 'stream 1: ended (the linked PC gave no reason; it runs an older TOMLIN)');
    assert.match(testSummary(h.news.at(-1)!), /^The test did not run to the end: the linked PC closed the stream \(the linked PC gave no reason; it runs an older TOMLIN\)/);
    h.server.close();
  } finally {
    await r.close();
  }
});

test('a refusal on the first stream gives the reason and one plain summary line', async () => {
  const r = await rig();
  try {
    r.presence = SOMEONE;
    const lines: string[] = [];
    const news: StreamNews[] = [];
    const { server, port } = await testBridge(remote(r.url), { target: 'rpc', plain: false }, 0, l => lines.push(l), n => news.push(n));
    const c = connect(port, '127.0.0.1');
    c.on('error', () => undefined);
    await new Promise(res => c.once('close', res));
    for (let t = 0; t < 40 && !news.length; t++) await new Promise(res => setTimeout(res, 50));
    assert.match(lines[0], /^stream 1: refused: someone is using "Big PC"/);
    assert.match(testSummary(news[0]), /^The test did not run: someone is using "Big PC"/);
    assert.equal(testSummary({ stream: 2, kind: 'open', reason: '', byNode: false }), '');
    server.close();
  } finally {
    await r.close();
  }
});
