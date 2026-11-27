// A model copied straight from one node to another (src/jobrun/peercopy.ts), on three real test copies, each with its own
// home, their link doors held to 127.0.0.1: a host that is not a node, a source node that shares a model, and a target
// node. The host introduces the two for "copy" and only gives the order and follows it; the target pulls the model from
// its peer in pieces, carries on from a .part file it already had, and checks the whole file against the source's before
// it is used. Refused: no introduction, the target's owner not accepting models, the source's owner not sharing, the
// sending side of a peer's doors. Also the check of a pulled copy on its own, with a wire made up for it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as carry from '../src/carry.ts';
import * as link from '../src/link.ts';
import { hashToken } from '../src/share.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep, until } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const top = mkdtempSync(join(tmpdir(), 'tomlin-peercopy-'));
const SOURCE = { id: 'aaaa1111', home: join(top, 'source'), door: 0 };
const TARGET = { id: 'bbbb2222', home: join(top, 'target'), door: 0 };
const HOST_HOME = join(top, 'host');
const FILE = 'Shared-Made-Up-7B-Q4_K_M.gguf';
/** Not one byte alike twice, so a wrong piece in the wrong place can never match: 20 MB, more than one piece. */
const BYTES = randomBytes(20 * 2 ** 20);
const noOllama = join(top, 'no-ollama');

interface Copy { proc: ChildProcess; port: number }
const running: Copy[] = [];

async function start(home: string): Promise<Copy> {
  mkdirSync(join(home, 'startup'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { OLLAMA: noOllama, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install') });
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
const shareOf = (home: string) => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));
const doorUp = (n: { door: number }) => until('the node\'s link door', async () => (await ask(n.door, 'GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 30_000, 300);

/** A node's home: app lock, sharing on, its setup code, the ticks given. */
function nodeHome(n: { id: string; home: string; door: number }, name: string, allow: Record<string, boolean>): void {
  const data = join(n.home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  writeFileSync(join(data, 'share.json'), JSON.stringify({ on: true, port: n.door, name, id: n.id, code: NODE_CODE, pinOn: false, pin: '', models: [], paired: [], allow }));
}
/** The node's ticks changed as its owner would (written as saved, then started again). */
async function retick(c: Copy, n: { home: string; door: number }, change: Record<string, boolean>): Promise<Copy> {
  await stop(c);
  const saved = shareOf(n.home);
  writeFileSync(join(n.home, 'data', 'share.json'), JSON.stringify({ ...saved, allow: { ...saved.allow, ...change } }));
  const next = await start(n.home);
  await doorUp(n);
  return next;
}

let source: Copy;
let target: Copy;
let host: Copy;
const share = (body: unknown = {}) => ask(host.port, 'POST', '/api/share', body);
const poke = () => ask(host.port, 'GET', '/api/remotes');
const order = (extra: Record<string, unknown> = {}) => share({ peerCopy: { from: SOURCE.id, to: TARGET.id, kind: 'chat', model: FILE, ...extra } });
/** The copy on the target, asked as the host asks, until it is not working. */
async function ended(): Promise<any> {
  return until('the copy to end', async () => {
    const t = (await order({ action: 'state' })).json?.peerCopy?.transfer;
    return t && t.state !== 'working' ? t : null;
  }, 120_000, 500);
}

before(async () => {
  SOURCE.door = await freePort();
  TARGET.door = await freePort();
  mkdirSync(noOllama, { recursive: true });
  const ticks = { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true, peer: true };
  nodeHome(SOURCE, 'Source node', ticks);
  // The target's owner has not yet ticked "Accept models from linked PCs".
  nodeHome(TARGET, 'Target node', { ...ticks, receive: false });
  mkdirSync(join(SOURCE.home, 'models', 'chat'), { recursive: true });
  mkdirSync(join(TARGET.home, 'models', 'chat'), { recursive: true });
  writeFileSync(join(SOURCE.home, 'models', 'chat', FILE), BYTES);
  mkdirSync(join(HOST_HOME, 'data'), { recursive: true });
  [source, target, host] = await Promise.all([start(SOURCE.home), start(TARGET.home), start(HOST_HOME)]);
  for (const n of [SOURCE, TARGET]) {
    await doorUp(n);
    const r = await ask(host.port, 'POST', '/api/remotes', { action: 'add', url: `127.0.0.1:${n.door}`, code: NODE_CODE });
    assert.equal(r.status, 200, r.text);
  }
  await until('both nodes heard', async () => {
    await poke();
    const pcs = (await share()).json.peerLinks.pcs;
    return pcs.length === 2 && pcs.every((p: { can: boolean | null; allowed: boolean }) => p.can === true && p.allowed === true);
  }, 30_000, 500);
});

after(async () => {
  for (const c of running) await stop(c);
  rmSync(top, { recursive: true, force: true, maxRetries: 5 });
});

test('two linked PCs need no introducing: a copy order sets up their direct link ("copy", beside what they had)', async () => {
  const only = await share({ peerIntroduce: { a: SOURCE.id, b: TARGET.id, scopes: ['cluster'] } });
  assert.equal(only.status, 200, only.text);
  // The host has heard the source's list of shared models; then the order reaches the target over the new link, and the
  // target's owner has not ticked "Accept models" yet, so it says no there.
  const r = await until('the order to be understood', async () => {
    await poke();
    const x = await order();
    return x.status === 404 ? null : x;
  }, 30_000, 500);
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /Accept models from linked PCs/);
  const pairs = (await share()).json.peerLinks.pairs;
  assert.equal(pairs.length, 1);
  assert.deepEqual([...pairs[0].scopes].sort(), ['cluster', 'copy']);
  assert.ok(!existsSync(join(TARGET.home, 'models', 'chat', FILE)));
});

test('a copy order is not a change to this PC: it is taken before the PIN check (as Send a copy is)', () => {
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = node.slice(node.indexOf('export async function setShare'));
  assert.ok(fn.indexOf('b.peerCopy &&') > 0 && fn.indexOf('b.peerCopy &&') < fn.indexOf('appPinCheck'));
});

test('introduced for copying: the target\'s owner must accept models, and the model must be one the source shares', async () => {
  const intro = await share({ peerIntroduce: { a: SOURCE.id, b: TARGET.id, scopes: ['copy'] } });
  assert.equal(intro.status, 200, intro.text);
  await until('both nodes hold the latest', async () => {
    await poke();
    const p = (await share()).json.peerLinks.pairs[0];
    return p.a.sync === 'latest' && p.b.sync === 'latest';
  }, 30_000, 300);
  // The host has heard the source's list of shared models.
  const refused = await until('the order to be understood', async () => {
    await poke();
    const r = await order();
    return r.status === 404 ? null : r;
  }, 30_000, 500);
  assert.equal(refused.status, 403, refused.text);
  assert.match(refused.json.error, /Accept models from linked PCs/);
  assert.equal((await order({ model: 'Nope-1B.gguf' })).status, 404, 'a model the source does not share');
  assert.ok(!existsSync(join(TARGET.home, 'models', 'chat', FILE)));
});

test('the target pulls the model straight from the source, carries on from a part it had, and proves it against the source\'s file', async () => {
  target = await retick(target, TARGET, { receive: true });
  await until('the host to hear the tick', async () => {
    await poke();
    return (await share()).json.peerLinks.pcs.every((p: { allowed: boolean }) => p.allowed === true);
  }, 30_000, 500);
  // A copy cut short before: the first piece (16 MB) is there, so the pull carries on after it.
  const dest = join(TARGET.home, 'models', 'chat', FILE);
  writeFileSync(`${dest}.part`, BYTES.subarray(0, carry.PIECE));
  const r = await order();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.peerCopy.from, 'Source node');
  assert.equal(r.json.peerCopy.to, 'Target node');
  const t = await ended();
  assert.equal(t.state, 'done', JSON.stringify(t));
  assert.match(t.said, /copied straight from "Source node" and checked against its file/);
  assert.equal(t.bytes, BYTES.length);
  assert.ok(readFileSync(dest).equals(BYTES), 'the same bytes');
  assert.ok(!existsSync(`${dest}.part`));
  // The host moved none of it: it holds no copy and was never the other end of one.
  assert.ok(!existsSync(join(HOST_HOME, 'models', 'chat', FILE)));
  assert.equal(shareOf(HOST_HOME).intros.length, 2);
});

test('a model that is there already is not copied again', async () => {
  const r = await order();
  assert.equal(r.status, 200, r.text);
  const t = await ended();
  assert.equal(t.state, 'failed');
  assert.match(t.said, /already/);
});

test('with the source\'s "Sharing of models" off, its peer is told no and the target keeps nothing', async () => {
  rmSync(join(TARGET.home, 'models', 'chat', FILE), { force: true });
  source = await retick(source, SOURCE, { pull: false });
  await poke();
  const r = await order();
  assert.equal(r.status, 200, r.text);
  const t = await ended();
  assert.equal(t.state, 'failed', JSON.stringify(t));
  assert.match(t.said, /"Source node".*Sharing of models/);
  assert.ok(!existsSync(join(TARGET.home, 'models', 'chat', FILE)));
  assert.ok(!existsSync(join(TARGET.home, 'models', 'chat', `${FILE}.part`)), 'not one byte was taken');
});

test('a peer reads a model and never writes one: the sending side of a peer\'s doors is refused', async () => {
  source = await retick(source, SOURCE, { pull: true });
  const out = shareOf(TARGET.home).peers.out.find((x: { revoked?: boolean; scopes: string[] }) => !x.revoked && x.scopes.includes('copy'));
  assert.ok(out, 'a live peer for copying');
  const keys = link.keysOf(out.key)!;
  const knock = (path: string, body: Record<string, unknown>) => ask(SOURCE.door, 'POST', path, link.sealRequest(keys, path, body), { authorization: `Link ${hashToken(out.token)}` });
  for (const path of ['/worker/carry-offer', '/worker/carry-put', '/worker/carry-drop']) {
    const r = await knock(path, { kind: 'chat', model: FILE, name: FILE, files: [{ name: FILE, bytes: BYTES.length }] });
    assert.equal(r.status, 501, `${path}: ${r.text}`);
  }
  // A sum asked of a peer is of the source's own shared file, never of one "received": a model it does not share has none.
  assert.equal((await knock('/worker/carry-sum', { kind: 'chat', model: 'Nope-1B.gguf', file: 0, from: 0, length: 10 })).status, 403);
  assert.ok(readFileSync(join(SOURCE.home, 'models', 'chat', FILE)).equals(BYTES), 'the source file is as it was');
});

test('the check of a pulled copy: whole files match, a changed byte or a wrong size is named, a wire that cannot answer is not a pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-verify-'));
  try {
    const mine = Buffer.from(BYTES.subarray(0, 3 * 2 ** 20));
    const here = join(dir, 'a.gguf');
    writeFileSync(here, mine);
    /** A source that holds `theirs`, answering as the node's doors do. */
    const wire = (theirs: Buffer): carry.Wire => ({
      async ask(path, body) {
        if (path === '/worker/carry-files') return { files: [{ name: 'a.gguf', bytes: theirs.length }] };
        const from = Number(body.from);
        const len = Number(body.length);
        return { sha256: await carry.sumRange(here.replace('a.gguf', 'theirs.gguf'), from, len), bytes: theirs.length };
      },
      async getPiece() { throw new Error('not used'); },
      async putPiece() { throw new Error('not used'); },
    });
    const run = (theirs: Buffer, range = 1 * 2 ** 20) => {
      writeFileSync(join(dir, 'theirs.gguf'), theirs);
      return carry.verifyPulled(wire(theirs), { kind: 'chat', model: 'a.gguf', paths: [here], progress: () => undefined, signal: new AbortController().signal, range });
    };
    assert.equal(await run(Buffer.from(mine)), null);
    const flipped = Buffer.from(mine);
    flipped[2 * 2 ** 20 + 17] ^= 0xff;
    assert.match(String(await run(flipped)), /differs from the file it was copied from \(bytes 2097152 to 3145728\)/);
    // A file that fails is not left in place as if whole: it goes back to a part, cut where the bad range starts, so the
    // model is not listed and copying again carries on from there (26 Nov: a broken copy was listed as installed).
    assert.ok(!existsSync(here), 'the failed file is not left in place');
    assert.equal(readFileSync(`${here}.part`).length, 2 * 2 ** 20);
    assert.ok(readFileSync(`${here}.part`).equals(mine.subarray(0, 2 * 2 ** 20)));
    writeFileSync(here, mine);
    assert.match(String(await run(mine.subarray(0, mine.length - 1))), /bytes here and/);
    await assert.rejects(carry.verifyPulled({ ...wire(mine), ask: async () => { throw new Error('the PC did not answer'); } }, { kind: 'chat', model: 'a.gguf', paths: [here], progress: () => undefined, signal: new AbortController().signal }), /did not answer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
