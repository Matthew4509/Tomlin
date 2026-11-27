// Audit of the Cluster and Max mode area: each test is named after its finding. A P0 test fails now and passes once the
// fault is fixed; a P1 test is marked todo. Everything runs on 127.0.0.1 with stand-in nodes and made-up links: no real
// PC, no runner, no model.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as share from '../src/share.ts';
import * as link from '../src/link.ts';
import { NO_ALLOW } from '../src/carry.ts';
import { openLog } from '../src/log.ts';
import type { Presence, RpcProgram } from '../src/maxlend.ts';
import { clusterTestUpgrade, type DoorDeps } from '../src/cluster/testdoor.ts';
import { openTestWire } from '../src/cluster/testwire.ts';
import { planEp } from '../src/cluster/eplayout.ts';
import { planLayers } from '../src/layersplit.ts';
import { planExperts, type Listed } from '../src/maxplace.ts';
import { lendersInUse, rpcFor } from '../src/jobrun/maxhost.ts';
import { MAX_DOOR, MAX_UPGRADE } from '../src/jobrun/maxnode.ts';
import { plainNow } from '../src/jobrun/plainlinks.ts';
import { useDeps } from '../src/jobrun/shared.ts';
import { seen } from '../src/jobrun/links.ts';
import type { JobDeps } from '../src/jobrun.ts';
import type { Remote } from '../src/store.ts';
import type { Option } from '../src/runnermatch.ts';

const GB = 2 ** 30;
const dir = mkdtempSync(join(tmpdir(), 'tomlin-audit-cluster-'));
openLog(dir);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
// rpcFor's relay ports (src/jobrun/maxhost.ts portFor) stay open while their PC may still lend, so they keep this process alive: it ends here.
after(() => void setTimeout(() => process.exit(), 200).unref());
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(50)) if (check()) return true;
  return check();
}

// ---- The host's side: a stand-in node that answers Max mode's sealed door ----

let peek: { remotes: Remote[]; cluster?: unknown } = { remotes: [] };
const opt = (build: string): Option => ({ build, device: 'cpu', pin: 'llama-cpu', have: true, tested: false });
useDeps({ runner: { runtimes: { buildOfPin: (pin: string) => (pin === 'llama-cpu' ? 'b11284' : '') }, options: () => [opt('b11284')] }, store: { peek: () => peek }, rpcProgram: () => null } as unknown as JobDeps);

/** A node on 127.0.0.1 that opens every Max mode stream it is asked for (counting them), answering `plain` as told. */
async function fakeNode(keysText: string, plain: boolean): Promise<{ url: string; opened: () => number; close: () => Promise<void> }> {
  const keys = link.keysOf(keysText)!;
  const taken = new link.Seen();
  let n = 0;
  const socks = new Set<{ destroy: () => void }>();
  const http: HttpServer = httpServer((_q, res) => res.writeHead(404).end());
  http.on('upgrade', (req, socket) => {
    if (req.url !== MAX_DOOR) return socket.destroy();
    const opened = link.openRequest(keys, { box: String(req.headers['x-link'] ?? '') }, MAX_DOOR, taken);
    if ('error' in opened) return socket.destroy();
    n++;
    socks.add(socket);
    const answer = link.sealAnswer(keys, opened.id, 0, { nonce: randomBytes(16).toString('base64url'), plain: plain && opened.body.plain === true });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${MAX_UPGRADE}\r\nconnection: Upgrade\r\nx-link: ${answer}\r\n\r\n`);
    socket.on('error', () => undefined);
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    opened: () => n,
    close: () => new Promise<void>(r => { for (const s of socks) s.destroy(); http.closeAllConnections(); http.close(() => r()); }),
  };
}

test('H-02: once a lender is unlinked (or the cluster is off), its 127.0.0.1 relay port no longer opens loans on it', async () => {
  const keysText = link.keysText(randomBytes(64));
  const node = await fakeNode(keysText, false);
  try {
    const r: Remote = { id: 'audit-n1', name: 'Audit node', url: node.url, token: randomBytes(32).toString('hex'), key: keysText } as Remote;
    peek = { remotes: [r], cluster: { on: true, members: [r.id] } };
    seen.set(r.id, { runner: { can: [opt('b11284')] }, at: Date.now() } as never);
    const got = await rpcFor([r], [opt('b11284')]);
    assert.equal(got.endpoints.length, 1, got.notes.join(' | '));
    assert.equal(node.opened(), 1, 'the probe stream');
    // The PC is unlinked here and the cluster is gone: nothing should reach it any more.
    peek = { remotes: [], cluster: { on: false, members: [] } };
    const [host, port] = got.endpoints[0].split(':');
    const s: Socket = connect(Number(port), host);
    s.on('error', () => undefined);
    await until(() => node.opened() > 1, 3000);
    s.destroy();
    assert.equal(node.opened(), 1, 'a local connection to the relay port opened a new loan on a PC that is no longer linked');
  } finally {
    await node.close();
  }
});

test('H-06: the PC list stops saying a link is unencrypted once no stream to that PC is open', async () => {
  const keysText = link.keysText(randomBytes(64));
  const node = await fakeNode(keysText, true);
  try {
    const r: Remote = { id: 'audit-n2', name: 'Audit node 2', url: node.url, token: randomBytes(32).toString('hex'), key: keysText, plainLink: true } as Remote;
    peek = { remotes: [r] };
    seen.set(r.id, { runner: { can: [opt('b11284')] }, at: Date.now() } as never);
    const got = await rpcFor([r], [opt('b11284')]);
    assert.equal(got.endpoints.length, 1, got.notes.join(' | '));
    // The probe stream was closed at once and nothing else is open to it.
    assert.ok(!lendersInUse().includes('Audit node 2'));
    assert.equal(plainNow.has(r.id), false, 'plainNow still says the link runs unencrypted now');
  } finally {
    await node.close();
  }
});

// ---- The node's side: the cluster test door, with two linked PCs ----

const NOBODY: Presence = { idleMs: 30 * 60_000, locked: false };
const pcA = { token: randomBytes(32).toString('hex'), key: link.keysText(randomBytes(64)) };
const pcB = { token: randomBytes(32).toString('hex'), key: link.keysText(randomBytes(64)) };

async function door(): Promise<{ state: share.ShareState; starts: () => number; live: () => number; url: string; close: () => Promise<void>; set: (s: share.ShareState) => void }> {
  let state: share.ShareState = {
    ...share.DEFAULT_SHARE, on: true, name: 'Big PC', allow: { ...NO_ALLOW, lend: true }, lendIdle: 5,
    paired: [{ name: 'PC A', hash: share.hashToken(pcA.token), at: '', key: pcA.key }, { name: 'PC B', hash: share.hashToken(pcB.token), at: '', key: pcB.key }],
  };
  let starts = 0;
  let live = 0;
  const servers: Server[] = [];
  const program: RpcProgram = { exe: 'rpc-server.exe', device: 'cuda', threads: 4, build: 'b11284' };
  const deps: DoorDeps = {
    state: () => state,
    taken: new link.Seen(),
    presence: async () => NOBODY,
    presenceNow: () => NOBODY,
    lending: () => null,
    program: () => program,
    builds: () => ['b11284'],
    startRpc: async () => {
      starts++;
      live++;
      const s = createServer(c => c.pipe(c)).listen(0, '127.0.0.1');
      servers.push(s);
      await new Promise(res => s.once('listening', res));
      let stopped = false;
      return { port: (s.address() as { port: number }).port, stop: () => { if (!stopped) { stopped = true; live--; s.close(); } } };
    },
    say: () => undefined,
    shortMs: 0,
  };
  const http: HttpServer = httpServer((_q, res) => res.writeHead(404).end());
  http.on('upgrade', (req, socket, head) => void clusterTestUpgrade(req, socket, head, deps));
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  return {
    state, starts: () => starts, live: () => live,
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    set: s => (state = s),
    close: () => new Promise<void>(r => { for (const s of servers) s.close(); http.closeAllConnections(); http.close(() => r()); }),
  };
}

test('H-03: while one linked PC runs a cluster test RPC server on a node, a second linked PC cannot start another there', async () => {
  const d0 = await door();
  try {
    const a = await openTestWire({ name: 'Big PC', url: d0.url, ...pcA }, { target: 'rpc', plain: true, build: 'b11284', all: true });
    a.socket.on('error', () => undefined);
    assert.equal(d0.live(), 1);
    let refused = '';
    try {
      const b = await openTestWire({ name: 'Big PC', url: d0.url, ...pcB }, { target: 'rpc', plain: true, build: 'b11284', all: true });
      b.socket.destroy();
    } catch (e) {
      refused = (e as Error).message;
    }
    a.socket.destroy();
    assert.ok(refused, `a second PC started a second RPC server (card, RAM and cores) on the same node: ${d0.starts()} started`);
  } finally {
    await d0.close();
  }
});

test('H-04: a cluster test stream ends once the asking PC\'s link is removed on the node', async () => {
  const d0 = await door();
  try {
    const a = await openTestWire({ name: 'Big PC', url: d0.url, ...pcA }, { target: 'rpc', plain: true, build: 'b11284' });
    let closed = false;
    a.socket.on('close', () => (closed = true));
    a.socket.on('error', () => undefined);
    // The owner of the node removes PC A's link.
    d0.set({ ...d0.state, paired: d0.state.paired.filter(p => p.hash !== share.hashToken(pcA.token)) });
    await until(() => closed && d0.live() === 0, 6000);
    const still = !closed || d0.live() > 0;
    a.socket.destroy();
    assert.equal(still, false, 'the removed PC kept its stream and the RPC server it started (up to 30 minutes)');
  } finally {
    await d0.close();
  }
});

// ---- Placement and sizing on odd hardware facts ----

test('H-01: expert parallel plans a full cluster without freezing the server (7 lenders in well under 2 s)', () => {
  const parts = { layerRest: Array(48).fill(0.2 * GB), expertLayer: 3 * GB, output: 0.5 * GB, tokenTable: 0.5 * GB, tables: [], other: 0.1 * GB };
  const host = { name: 'this PC', ramFree: 120 * GB, ramTotal: 128 * GB, ramSpeed: 20e9, card: { name: 'CUDA0', what: 'card', total: 12 * GB, free: 11 * GB }, cardSpeed: 300e9 };
  const lenders = Array.from({ length: 7 }, (_, i) => {
    const ep = `127.0.0.1:${5000 + i}`;
    return { name: `L${i}`, endpoint: ep, ramFree: 120 * GB, ramTotal: 128 * GB, ramSpeed: (10 + i) * 1e9, ram: { name: `RPC${i}`, what: ep, total: 128 * GB, free: 120 * GB } };
  });
  const t0 = Date.now();
  const got = planEp({ name: 'MoE', parts, experts: 256, used: 8, hidden: 4096, kv: 2 * GB }, host, lenders);
  const ms = Date.now() - t0;
  assert.ok(!('why' in got));
  assert.ok(ms < 2000, `planEp ran ${ms} ms on the event loop (every page, hello and chat waits meanwhile)`);
});

test('H-05: a host whose runner lists no card of its own still keeps every lender to the RAM policy (a plan or a refusal, never llama.cpp\'s own fit)', () => {
  const dev = (name: string, what: string, totalGb: number, freeGb: number): Listed => ({ name, what, total: totalGb * GB, free: freeGb * GB });
  const listed = [dev('RPC0', '127.0.0.1:5002', 24, 20.5), dev('CPU', 'Xeon', 64, 50)];
  const got = planLayers({ layers: 40, bytes: 30 * GB, kv: 2 * GB }, listed, [{ name: 'HP 800', endpoint: '127.0.0.1:5002', hasCard: false }], { free: 50 * GB });
  // { why } without refuse sends the load to llama.cpp's own fit with --fit 4096 MiB: the 24 GB lender may be given ~16 GB.
  assert.ok(!('why' in got) || got.refuse === true, `fit left to llama.cpp: ${'why' in got ? got.why : ''}`);
});

test('H-08: the expert placement on a model with nothing outside its experts gives numbers, not NaN', () => {
  const dev = (name: string, what: string, totalGb: number, freeGb: number): Listed => ({ name, what, total: totalGb * GB, free: freeGb * GB });
  const listed = [dev('CUDA0', 'card', 12, 1), dev('RPC0', '127.0.0.1:5001', 12, 11), dev('RPC1', '127.0.0.1:5001', 64, 56), dev('CPU', 'cpu', 64, 40)];
  const got = planExperts({ layers: 10, expertLayer: 1 * GB, rest: 0, kv: 0 }, listed, [{ name: 'Z', endpoint: '127.0.0.1:5001', hasCard: true }], { free: 40 * GB });
  if ('split' in got) for (const n of got.split) assert.ok(Number.isFinite(n), `split ${JSON.stringify(got.split)}`);
});

test('H-07: the node says truthfully who decides an unencrypted cluster link (its log line for "not ticked here" can never be written)', () => {
  const src = read('src/jobrun/maxnode.ts');
  assert.ok(!/share\.NODE_PLAIN_LINKS/.test(src) || !/is not ticked here/.test(src), 'maxnode.ts says the owner ticks it, but NODE_PLAIN_LINKS is always true');
});
