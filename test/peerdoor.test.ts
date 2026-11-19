// Peers at a real node's door (a test copy on an empty home, its link door held to 127.0.0.1): a host linked there
// sends the PCs this one may talk to directly through /worker/peer-put. Tried: wrong keys, no link and a guest link are
// refused; a host's set is kept in a list of its own, never among the node's links; an older set changes nothing; a
// removal takes the secret off the disk; the node says it holds peers in its hello; a restart reads them back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import * as pl from '../src/peerlink.ts';
import { hashToken } from '../src/share.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep, until } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'tomlin-peerdoor-'));
const NODE: pl.PeerEnd = { id: 'aaaa1111', name: 'Made-up lender', addrs: ['192.168.0.21'] };
const LOADER: pl.PeerEnd = { id: 'bbbb2222', name: 'Made-up loader', addrs: ['192.168.0.20'] };
const THIRD: pl.PeerEnd = { id: 'cccc3333', name: 'Made-up third', addrs: ['192.168.0.22'] };
// Two hosts made by hand on the node (their links written there), and a guest link.
const HOST = { token: randomBytes(32).toString('hex'), keys: randomBytes(64) };
const HOST_KEEP = 'hosthosthosthost';
const OTHER = { token: randomBytes(32).toString('hex'), keys: randomBytes(64) };
const GUEST = { token: randomBytes(32).toString('hex'), keys: randomBytes(64) };
let proc: ChildProcess;
let door = 0;

async function start(): Promise<void> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install') });
  proc = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  proc.stdout!.on('data', d => (said += d));
  proc.stderr!.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
  assert.match(said, /is running at/, said);
  await until('the node\'s link door', async () => (await ask('GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 30_000, 300);
}
async function stop(): Promise<void> {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const gone = new Promise(r => proc.once('exit', r));
    proc.kill();
    await gone;
  }
}

function ask(method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const text = o.body === undefined ? '' : JSON.stringify(o.body);
    const req = request({ host: '127.0.0.1', port: door, path, method, agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...o.headers } }, res => {
      const got: Buffer[] = [];
      res.on('data', d => got.push(d));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(got).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}
interface Made { token: string; keys: Buffer }
/** One sealed request on a link to the node's door: its status and the answer opened. */
async function knock(m: Made, path: string, body: Record<string, unknown> = {}, sealWith = m.keys): Promise<{ status: number; answer: any }> {
  const sealed = link.sealRequest(sealWith, path, body);
  const r = await ask('POST', path, { body: sealed, headers: { authorization: `Link ${hashToken(m.token)}` } });
  let answer: any = r.json;
  if (r.json?.box) {
    try { answer = link.openAnswer(m.keys, link.requestId(sealed.box), 0, r.json.box); } catch { answer = null; }
  }
  return { status: r.status, answer };
}
const diskText = () => readFileSync(join(home, 'data', 'share.json'), 'utf8');
const shareOf = () => JSON.parse(diskText());
function intro(from: pl.PeerEnd, to: pl.PeerEnd, scopes: pl.PeerScope[] = ['copy']): pl.Intro {
  const made = pl.makeIntro(from, to, { scopes });
  assert.ok(!('error' in made), JSON.stringify(made));
  return made as pl.Intro;
}

before(async () => {
  door = await freePort();
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, 'startup'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  const now = new Date().toISOString();
  const linkOf = (m: Made, name: string, more: Record<string, unknown>) => ({ name, hash: hashToken(m.token), key: link.keysText(m.keys), at: now, ...more });
  const pass = { id: 'p1p1p1p1', label: 'Made-up pass', key: Buffer.alloc(32, 7).toString('base64url'), length: 'none', created: now, expires: null, nodes: [NODE.id], models: [], uses: 1, lastSeen: null, rev: 1 };
  writeFileSync(join(data, 'share.json'), JSON.stringify({
    on: true, port: door, name: NODE.name, id: NODE.id, code: NODE_CODE, pinOn: false, pin: '', models: [], passes: [pass],
    paired: [linkOf(HOST, 'Made-up host', { keep: HOST_KEEP }), linkOf(OTHER, 'Made-up other host', { keep: 'otherotherother1' }), linkOf(GUEST, 'Made-up guest laptop', { role: 'guest', passId: pass.id, expires: null })],
    allow: { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true },
  }));
  await start();
});

after(async () => {
  await stop();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

const inbound = intro(LOADER, NODE, ['copy', 'cluster']);
const outbound = intro(NODE, THIRD);
const GEN = Date.now();

test('the node says in its hello that it holds peers', async () => {
  const h = await knock(HOST, '/worker/hello');
  assert.equal(h.status, 200, JSON.stringify(h));
  assert.ok(h.answer.can.includes('peers'));
});

test('wrong keys, no link and a guest link cannot introduce a PC', async () => {
  const body = { gen: GEN, peers: pl.peerSet([inbound], NODE.id) };
  assert.equal((await knock(HOST, '/worker/peer-put', body, randomBytes(64))).status, 400, 'sealed with keys that are not the link\'s');
  assert.equal((await knock({ token: randomBytes(32).toString('hex'), keys: randomBytes(64) }, '/worker/peer-put', body)).status, 401, 'no link');
  const g = await knock(GUEST, '/worker/peer-put', body);
  assert.equal(g.status, 403, JSON.stringify(g));
  assert.equal(g.answer?.guest, 'refused');
  assert.equal((await knock(HOST, '/worker/peer-put', { gen: 0, peers: {} })).status, 400);
  assert.equal((await knock(HOST, '/worker/peer-put', { gen: GEN })).status, 400, 'no list');
  assert.deepEqual(shareOf().peers ?? { in: [], out: [] }, { in: [], out: [] }, 'nothing was kept');
});

test('a host\'s set is kept in its own list, as given by that host, and never among the node\'s links', async () => {
  const links = shareOf().paired.length;
  const ok = await knock(HOST, '/worker/peer-put', { gen: GEN, peers: pl.peerSet([inbound, outbound], NODE.id) });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.deepEqual({ gen: ok.answer.gen, stale: ok.answer.stale, held: ok.answer.held, removedHere: ok.answer.removedHere }, { gen: GEN, stale: false, held: 2, removedHere: [] });
  const s = shareOf();
  assert.equal(s.paired.length, links, 'no new link');
  assert.equal(s.peers.in.length, 1);
  assert.equal(s.peers.in[0].pc, LOADER.id);
  assert.equal(s.peers.in[0].by, HOST_KEEP);
  assert.equal(s.peers.in[0].hash, hashToken(inbound.token));
  assert.deepEqual(s.peers.in[0].scopes, ['copy', 'cluster']);
  assert.equal(s.peers.out.length, 1);
  assert.equal(s.peers.out[0].pc, THIRD.id);
  assert.equal(s.peers.out[0].token, outbound.token);
  assert.ok(!diskText().includes(inbound.token), 'the token of a PC that may call here is never on this disk');
  assert.equal(s.peerGens[HOST_KEEP], GEN);
});

test('a peer\'s token is not a link: with the owner\'s switch off here it gets nothing, not even its ping, and changes nothing', async () => {
  const asPeer = { token: inbound.token, keys: link.keysOf(inbound.key)! };
  const before = diskText();
  for (const path of [pl.PEER_HELLO, '/worker/hello', '/worker/peer-put', '/worker/carry-files', '/worker/passes-put']) {
    const r = await knock(asPeer, path, { gen: GEN + 5, peers: { in: [], out: [] } });
    assert.equal(r.status, 403, path);
    assert.equal(r.answer?.peer, 'off', path);
  }
  assert.equal(diskText(), before);
});

test('an older set changes nothing; another host cannot take over or end a peer it did not give', async () => {
  const older = await knock(HOST, '/worker/peer-put', { gen: GEN - 1, peers: { in: [], out: [] } });
  assert.equal(older.status, 200);
  assert.equal(older.answer.stale, true);
  assert.equal(older.answer.gen, GEN);
  const forged = pl.peerSet([{ ...inbound, token: randomBytes(32).toString('hex'), rev: 9 }], NODE.id);
  const other = await knock(OTHER, '/worker/peer-put', { gen: GEN, peers: forged });
  assert.equal(other.status, 200);
  assert.equal(other.answer.held, 0);
  const kept = shareOf().peers.in[0];
  assert.equal(kept.hash, hashToken(inbound.token));
  assert.equal(kept.by, HOST_KEEP);
});

test('a restart reads the peers back the same', async () => {
  const was = shareOf().peers;
  await stop();
  await start();
  const again = await knock(HOST, '/worker/peer-put', { gen: GEN, peers: pl.peerSet([inbound, outbound], NODE.id) });
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal(again.answer.held, 2);
  assert.deepEqual(shareOf().peers, was);
});

test('a removal by the host takes the secret off the node\'s disk', async () => {
  const gone = pl.revokeIntro([inbound, outbound], inbound.id);
  const r = await knock(HOST, '/worker/peer-put', { gen: GEN + 1, peers: pl.peerSet(gone, NODE.id) });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.answer.held, 1);
  const kept = shareOf().peers.in[0];
  assert.equal(kept.revoked, true);
  assert.equal(kept.hash, '');
  assert.equal(kept.key, '');
  assert.ok(!diskText().includes(inbound.key) && !diskText().includes(hashToken(inbound.token)));
  // A peer the host no longer sends at all ends too.
  const none = await knock(HOST, '/worker/peer-put', { gen: GEN + 2, peers: { in: [], out: [] } });
  assert.equal(none.answer.held, 0);
  assert.equal(shareOf().peers.out[0].token, '');
});
