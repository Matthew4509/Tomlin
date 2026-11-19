// A host introduces two PCs linked to it (src/jobrun/peersync.ts), on three real test copies, each with its own home,
// their link doors held to 127.0.0.1: a host that is not a node, an office node and a backup node. Each node gets its
// half over its sealed link: the two halves match (one token, one key), with the other PC's address and port. Ending
// the pair reaches the node that is on at once and the one that was off when it comes back. The same two introduced
// again get new keys. What is refused: a PC with itself, a PC that is not linked, no scope, and a PC whose owner has
// not ticked "Let PCs my host introduces connect to this PC directly". Then the call itself: each node pings the other
// directly on the host's order, and at a node's door a peer gets its ping and nothing a linked PC gets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import { PEER_HELLO } from '../src/peerlink.ts';
import { hashToken } from '../src/share.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep, until } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const top = mkdtempSync(join(tmpdir(), 'tomlin-peersync-'));
const OFFICE = { id: 'aaaa1111', home: join(top, 'office'), door: 0 };
const BACKUP = { id: 'bbbb2222', home: join(top, 'backup'), door: 0 };
const HOST_HOME = join(top, 'host');

interface Copy { proc: ChildProcess; port: number }
const running: Copy[] = [];

/** Starts the app on `home` (link door held to 127.0.0.1): its page's port. */
async function start(home: string): Promise<Copy> {
  mkdirSync(join(home, 'startup'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install') });
  const proc = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  proc.stdout!.on('data', d => (said += d));
  proc.stderr!.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
  assert.match(said, /is running at/, said);
  const c: Copy = { proc, port };
  running.push(c);
  return c;
}
async function stop(c: Copy): Promise<void> {
  if (c.proc.exitCode === null && c.proc.signalCode === null) {
    const gone = new Promise(r => c.proc.once('exit', r));
    c.proc.kill();
    await gone;
  }
}

function ask(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, res => {
      const got: Buffer[] = [];
      res.on('data', d => got.push(d));
      res.on('end', () => {
        const s = Buffer.concat(got).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(s); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, text: s, json });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/** One sealed request at a node's door as the peer that holds `out` (its token and keys) would send it. */
async function asPeer(door: number, out: { token: string; key: string }, path: string): Promise<{ status: number; answer: any }> {
  const keys = link.keysOf(out.key)!;
  const sealed = link.sealRequest(keys, path, {});
  const r = await ask(door, 'POST', path, sealed, { authorization: `Link ${hashToken(out.token)}` });
  let answer: any = r.json;
  if (r.json?.box) {
    try { answer = link.openAnswer(keys, link.requestId(sealed.box), 0, r.json.box); } catch { answer = null; }
  }
  return { status: r.status, answer };
}

const shareOf =(home: string) => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));
const live = (list: any[] | undefined): any[] => (list ?? []).filter(x => !x.revoked);
const doorUp = (n: { door: number }) => until('the node\'s link door', async () => (await ask(n.door, 'GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 30_000, 300);

/** A node's home: app lock, sharing on, its setup code, every tick on. */
function nodeHome(n: { id: string; home: string; door: number }, name: string, peer = true): void {
  const data = join(n.home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  writeFileSync(join(data, 'share.json'), JSON.stringify({ on: true, port: n.door, name, id: n.id, code: NODE_CODE, pinOn: false, pin: '', models: [], paired: [], allow: { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true, ...(peer ? { peer: true } : {}) } }));
}

let backup: Copy;
let host: Copy;
const share = (body: unknown = {}) => ask(host.port, 'POST', '/api/share', body);
const pairNow = async () => (await share()).json.peerLinks.pairs[0];
/** Asks each node's hello now, as the Network page does, so a node that is behind is sent again. */
const poke = () => ask(host.port, 'GET', '/api/remotes');

before(async () => {
  OFFICE.door = await freePort();
  BACKUP.door = await freePort();
  nodeHome(OFFICE, 'Office node');
  // The backup node's owner has not ticked the direct-link switch yet.
  nodeHome(BACKUP, 'Backup node', false);
  mkdirSync(join(HOST_HOME, 'data'), { recursive: true });
  [, backup, host] = await Promise.all([start(OFFICE.home), start(BACKUP.home), start(HOST_HOME)]);
  for (const n of [OFFICE, BACKUP]) {
    await doorUp(n);
    const r = await ask(host.port, 'POST', '/api/remotes', { action: 'add', url: `127.0.0.1:${n.door}`, code: NODE_CODE });
    assert.equal(r.status, 200, r.text);
  }
  // The host has heard each node's hello (it must know each can hold peers).
  await until('both nodes heard', async () => {
    await poke();
    const pcs = (await share()).json.peerLinks.pcs;
    return pcs.length === 2 && pcs.every((p: { can: boolean | null }) => p.can === true);
  }, 30_000, 500);
  // The backup node's owner has not ticked the switch: it is not introduced. Then ticked there (written as saved, and
  // the node started again), and the host hears it.
  const no = await share({ peerIntroduce: { a: OFFICE.id, b: BACKUP.id, scopes: ['copy'] } });
  assert.equal(no.status, 409, no.text);
  assert.match(no.json.error, /Backup node.*has not ticked/);
  assert.equal(shareOf(BACKUP.home).peers?.in?.length ?? 0, 0);
  await stop(backup);
  const saved = shareOf(BACKUP.home);
  writeFileSync(join(BACKUP.home, 'data', 'share.json'), JSON.stringify({ ...saved, allow: { ...saved.allow, peer: true } }));
  backup = await start(BACKUP.home);
  await doorUp(BACKUP);
  await until('the host to hear the tick', async () => {
    await poke();
    return (await share()).json.peerLinks.pcs.every((p: { allowed: boolean }) => p.allowed === true);
  }, 30_000, 500);
});

after(async () => {
  for (const c of running) await stop(c);
  rmSync(top, { recursive: true, force: true, maxRetries: 5 });
});

test('what is refused: a PC with itself, a PC that is not linked, and no scope', async () => {
  assert.equal((await share({ peerIntroduce: { a: OFFICE.id, b: OFFICE.id, scopes: ['copy'] } })).status, 400);
  assert.equal((await share({ peerIntroduce: { a: OFFICE.id, b: 'cccc3333', scopes: ['copy'] } })).status, 404);
  assert.equal((await share({ peerIntroduce: { a: OFFICE.id, b: BACKUP.id, scopes: [] } })).status, 400);
  assert.equal((await share({ peerRemove: { a: OFFICE.id, b: BACKUP.id } })).status, 404, 'nothing to end yet');
  assert.deepEqual((await share()).json.peerLinks.pairs, []);
  assert.equal(shareOf(OFFICE.home).peers?.in?.length ?? 0, 0);
});

let firstToken = '';

test('the host introduces two linked nodes: each gets its half, the halves match, and neither becomes a linked PC of the other', async () => {
  const r = await share({ peerIntroduce: { a: OFFICE.id, b: BACKUP.id, scopes: ['copy', 'cluster'] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.peerLinks.pairs.length, 1);
  assert.deepEqual(r.json.peerLinks.pairs[0].scopes, ['copy', 'cluster']);
  assert.ok(!/"token"|"key"/.test(JSON.stringify(r.json.peerLinks)), 'the page is told nothing secret');
  await until('both nodes hold the latest', async () => {
    const p = await pairNow();
    return p.a.sync === 'latest' && p.b.sync === 'latest';
  }, 20_000, 300);
  const office = shareOf(OFFICE.home);
  const back = shareOf(BACKUP.home);
  for (const [me, other, n] of [[office, back, BACKUP], [back, office, OFFICE]] as const) {
    assert.equal(me.peers.out.length, 1);
    assert.equal(me.peers.in.length, 1);
    const out = me.peers.out[0];
    const inn = other.peers.in[0];
    assert.equal(out.pc, n.id);
    assert.equal(out.port, n.door, 'the other PC\'s link door');
    assert.ok(out.addrs.includes('127.0.0.1'), JSON.stringify(out.addrs));
    assert.equal(hashToken(out.token), inn.hash, 'one token: the caller holds it, the answerer its hash');
    assert.equal(out.key, inn.key);
    assert.deepEqual(inn.scopes, ['copy', 'cluster']);
    // The peer is in no list of links: only the host is linked there.
    assert.equal(me.paired.length, 1);
    assert.ok(!JSON.stringify(me.paired).includes(inn.hash));
  }
  assert.notEqual(office.peers.out[0].token, back.peers.out[0].token, 'each direction has its own token');
  assert.equal(shareOf(HOST_HOME).intros.length, 2);
  firstToken = office.peers.out[0].token;
});

test('each node reaches the other directly, on the host\'s order, with no host in the middle', async () => {
  const r = await share({ peerCheck: { a: OFFICE.id, b: BACKUP.id } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.peerCheck.length, 2);
  for (const line of r.json.peerCheck) {
    assert.equal(line.ok, true, JSON.stringify(line));
    assert.equal(line.address, '127.0.0.1');
  }
  assert.deepEqual(r.json.peerCheck.map((l: { from: string; to: string }) => `${l.from}>${l.to}`), ['Office node>Backup node', 'Backup node>Office node']);
  assert.equal(typeof shareOf(BACKUP.home).peers.in[0].lastUsed, 'string', 'the answering node noted the use');
});

test('at a node\'s door a peer gets its ping; a door outside its scopes, and every door a linked PC has, is refused', async () => {
  const out = shareOf(OFFICE.home).peers.out[0];
  const hello = await asPeer(BACKUP.door, out, PEER_HELLO);
  assert.equal(hello.status, 200, JSON.stringify(hello));
  assert.equal(hello.answer.name, 'Backup node');
  assert.deepEqual(hello.answer.scopes, ['copy', 'cluster']);
  for (const path of ['/worker/hello', '/worker/run', '/worker/runner-offer', '/worker/update-put', '/worker/peer-put', '/worker/peer-ping', '/worker/power-off', '/worker/passes-put']) {
    const r = await asPeer(BACKUP.door, out, path);
    assert.equal(r.status, 403, `${path}: ${JSON.stringify(r)}`);
    assert.equal(r.answer?.peer, 'refused', path);
  }
  // In its scope, so it reaches the model doors (read only): no model named, so it is told that model is not there. The
  // sending side stays unserved for a peer (test/peercopy.test.ts).
  const files = await asPeer(BACKUP.door, out, '/worker/carry-files');
  assert.equal(files.status, 403);
  assert.match(files.answer.error, /not on "Backup node"/);
  assert.equal((await asPeer(BACKUP.door, out, '/worker/carry-put')).status, 501);
  // The right token with the wrong keys opens nothing.
  assert.equal((await asPeer(BACKUP.door, { token: out.token, key: link.keysText(Buffer.alloc(64, 9)) }, PEER_HELLO)).status, 400);
  // A node never calls a PC it was not introduced to, even on its host's order: only a host can ask, and only for a peer.
  assert.equal(shareOf(OFFICE.home).paired.length, 1);
});

test('the same two introduced again get new keys; the old ones end on both', async () => {
  const r = await share({ peerIntroduce: { a: BACKUP.id, b: OFFICE.id, scopes: ['copy'] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.peerLinks.pairs.length, 1);
  await until('both nodes hold the latest', async () => {
    const p = await pairNow();
    return p.a.sync === 'latest' && p.b.sync === 'latest';
  }, 20_000, 300);
  for (const home of [OFFICE.home, BACKUP.home]) {
    const s = shareOf(home);
    assert.equal(live(s.peers.out).length, 1);
    assert.equal(live(s.peers.in).length, 1);
    assert.deepEqual(live(s.peers.in)[0].scopes, ['copy']);
    assert.ok(!readFileSync(join(home, 'data', 'share.json'), 'utf8').includes(firstToken), 'the old token is off the disk');
  }
  assert.notEqual(live(shareOf(OFFICE.home).peers.out)[0].token, firstToken);
});

test('ended while the backup node is off: the office node is told at once, the backup node when it is back', async () => {
  await stop(backup);
  const r = await share({ peerRemove: { a: OFFICE.id, b: BACKUP.id } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.peerLinks.pairs, []);
  await until('the office node to end its peer', async () => live(shareOf(OFFICE.home).peers.in).length === 0 && live(shareOf(OFFICE.home).peers.out).length === 0, 20_000, 300);
  assert.equal(live(shareOf(BACKUP.home).peers.in).length, 1, 'the node that is off still holds it');
  assert.deepEqual(shareOf(HOST_HOME).intros, []);
  backup = await start(BACKUP.home);
  await doorUp(BACKUP);
  await until('the backup node to end its peer', async () => {
    await poke();
    const s = shareOf(BACKUP.home);
    return live(s.peers.in).length === 0 && live(s.peers.out).length === 0;
  }, 30_000, 1000);
  const s = shareOf(BACKUP.home);
  assert.equal(s.peers.in.every((x: { hash: string; key: string }) => x.hash === '' && x.key === ''), true, 'nothing secret is kept');
  assert.equal((await share({ peerCheck: { a: OFFICE.id, b: BACKUP.id } })).status, 404);
});

test('a node\'s owner sees its direct link and removes it there: the other PC is refused at once, and the host cannot put it back', async () => {
  const r = await share({ peerIntroduce: { a: OFFICE.id, b: BACKUP.id, scopes: ['copy'] } });
  assert.equal(r.status, 200, r.text);
  await until('both nodes hold the latest', async () => {
    const p = await pairNow();
    return p.a.sync === 'latest' && p.b.sync === 'latest';
  }, 20_000, 300);
  // Its page is behind the app lock: opened with the PIN, as its owner would.
  const opened = await fetch(`http://127.0.0.1:${backup.port}/api/applock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unlock', pin: NODE_PIN }) });
  assert.equal(opened.status, 200);
  const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];
  const page = (body: unknown) => ask(backup.port, 'POST', '/api/share', body, { cookie });
  const view = (await ask(backup.port, 'GET', '/api/nodes', undefined, { cookie })).json.share.peersHere;
  assert.equal(view.length, 1, 'one line for the PC, both directions together');
  assert.equal(view[0].name, 'Office node');
  assert.deepEqual(view[0].scopes, ['copy']);
  assert.ok(!JSON.stringify(view).match(/token|"key"|hash/), 'nothing secret on the page');
  const out = live(shareOf(OFFICE.home).peers.out)[0];
  assert.equal((await asPeer(BACKUP.door, out, PEER_HELLO)).status, 200);
  // The app lock is on there: the PIN is asked, as for any change to the links.
  const locked = await page({ peerRemoveHere: view[0].id });
  assert.equal(locked.json?.needAppPin, true, locked.text);
  const gone = await page({ peerRemoveHere: view[0].id, appPin: NODE_PIN });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(gone.json.peersHere, []);
  assert.equal((await asPeer(BACKUP.door, out, PEER_HELLO)).status, 401);
  // The host sends its set again (nothing changed there): the link stays removed on the backup node.
  await poke();
  await sleep(1500);
  assert.equal(live(shareOf(BACKUP.home).peers.in).length, 0);
  assert.equal((await page({ peerRemoveHere: view[0].id, appPin: NODE_PIN })).status, 404);
});
