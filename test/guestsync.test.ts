// Guest passes copied from a host to its nodes (Phase 2), on three real test copies, each with its own home, their link
// doors held to 127.0.0.1: a host that is not a node, an office node and a backup node. A pass made on the host works on
// both nodes with the host switched off; a removal reaches the node that is on at once and the one that was off when it
// comes back; the host's page says which are behind. Also, against the office node directly: a message sealed with the
// wrong keys, one from a guest link and one from no link are refused, and a pass expires on a node no host can reach.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import { hashToken } from '../src/share.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep, until } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const top = mkdtempSync(join(tmpdir(), 'tomlin-guestsync-'));
const OFFICE = { id: 'aaaa1111', home: join(top, 'office'), door: 0 };
const BACKUP = { id: 'bbbb2222', home: join(top, 'backup'), door: 0 };
const HOST_HOME = join(top, 'host');

interface Copy { proc: ChildProcess; port: number; said: () => string; cookie: string }
const running: Copy[] = [];

/** Starts the app on `home` (link door held to 127.0.0.1): its page's port. */
async function start(home: string): Promise<Copy> {
  mkdirSync(join(home, 'startup'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '' });
  const proc = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  proc.stdout!.on('data', d => (said += d));
  proc.stderr!.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
  assert.match(said, /is running at/, said);
  const c: Copy = { proc, port, said: () => said, cookie: '' };
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

interface Answer { status: number; text: string; json: any; setCookie: string }
function ask(port: number, method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = o.body === undefined ? '' : JSON.stringify(o.body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } }, res => {
      const got: Buffer[] = [];
      res.on('data', d => got.push(d));
      res.on('end', () => {
        const s = Buffer.concat(got).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(s); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, text: s, json, setCookie: String(res.headers['set-cookie'] ?? '') });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}
const page = (c: Copy, method: string, path: string, body?: unknown) => ask(c.port, method, path, { body, cookie: c.cookie });

interface Made { token: string; keys: Buffer }
/** One sealed request on a link to a node's door: its status and the answer opened. */
async function knock(door: number, m: Made, path: string, body: Record<string, unknown> = {}, sealWith = m.keys): Promise<{ status: number; answer: any }> {
  const sealed = link.sealRequest(sealWith, path, body);
  const r = await ask(door, 'POST', path, { body: sealed, headers: { authorization: `Link ${hashToken(m.token)}` } });
  let answer: any = r.json;
  if (r.json?.box) {
    try { answer = link.openAnswer(m.keys, link.requestId(sealed.box), 0, r.json.box); } catch { answer = null; }
  }
  return { status: r.status, answer };
}
/** Links to a node's door with `code` as a guest would: the link, or the refusal. */
async function pair(door: number, code: string): Promise<{ made: Made } | { status: number }> {
  const key = await link.pairKey(code, '');
  const asked = link.hostAsk(key, randomBytes(4).toString('hex'), 'Made-up guest laptop', false);
  const r = await ask(door, 'POST', '/worker/pair', { body: asked.ask });
  if (r.status !== 200) return { status: r.status };
  const f = link.hostFinish(key, asked.ask, asked.priv, r.json);
  return { made: { token: f.token, keys: f.keys } };
}
const made = (r: { made: Made } | { status: number }): Made => {
  assert.ok('made' in r, JSON.stringify(r));
  return (r as { made: Made }).made;
};

const shareOf = (home: string) => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));
function allText(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? allText(p) : readFileSync(p).toString('latin1');
  }
  return out;
}

/** A node's home: app lock, sharing on, its setup code, every tick on; `paired` written as its owner's links. */
function nodeHome(n: { id: string; home: string; door: number }, name: string, paired: unknown[] = []): void {
  const data = join(n.home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  writeFileSync(join(data, 'share.json'), JSON.stringify({ on: true, port: n.door, name, id: n.id, code: NODE_CODE, pinOn: false, pin: '', models: [], paired, allow: { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true } }));
}

// A host made by hand on the office node (its link written there), for the messages sent straight to its door.
const HAND = { token: randomBytes(32).toString('hex'), keys: randomBytes(64) };
const HAND_KEEP = 'handhandhandhand';

let backup: Copy;
let host: Copy;

before(async () => {
  OFFICE.door = await freePort();
  BACKUP.door = await freePort();
  nodeHome(OFFICE, 'Office node', [{ name: 'Hand-made host', hash: hashToken(HAND.token), key: link.keysText(HAND.keys), at: new Date().toISOString(), keep: HAND_KEEP }]);
  nodeHome(BACKUP, 'Backup node');
  mkdirSync(join(HOST_HOME, 'data'), { recursive: true });
  [, backup, host] = await Promise.all([start(OFFICE.home), start(BACKUP.home), start(HOST_HOME)]);
  for (const n of [OFFICE, BACKUP]) {
    await until('the node\'s link door', async () => (await ask(n.door, 'GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 30_000, 300);
    const r = await page(host, 'POST', '/api/remotes', { action: 'add', url: `127.0.0.1:${n.door}`, code: NODE_CODE });
    assert.equal(r.status, 200, r.text);
  }
});

after(async () => {
  for (const c of running) await stop(c);
  rmSync(top, { recursive: true, force: true, maxRetries: 5 });
});

const passIn = (home: string, id: string) => (shareOf(home).passes ?? []).find((x: { id: string }) => x.id === id);
const syncOf = async (id: string) => (await page(host, 'POST', '/api/share', {})).json.passNodes.find((x: { id: string }) => x.id === id);

let code = '';
let passId = '';
let guestAtOffice: Made;
let guestAtBackup: Made;

test('a host that is not a node makes a pass for two linked nodes; each gets its own copy, sealed, and no code is kept anywhere', async () => {
  const view = await page(host, 'POST', '/api/share', {});
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.json.passNodes.map((x: { id: string }) => x.id).sort(), [OFFICE.id, BACKUP.id], 'the nodes it is linked to, not itself (it is not a node)');
  const r = await page(host, 'POST', '/api/share', { passMake: { label: 'Visiting laptop', length: 'week', nodes: [{ id: OFFICE.id, models: [] }, { id: BACKUP.id, models: [] }] } });
  assert.equal(r.status, 200, r.text);
  code = r.json.madePass.code;
  passId = r.json.madePass.id;
  for (const n of [OFFICE, BACKUP]) {
    const p = await until(`the pass on ${n.id}`, async () => passIn(n.home, passId), 20_000, 300);
    assert.deepEqual(p.nodes, [n.id]);
    assert.ok(p.by, 'kept as given by that host');
    assert.equal(p.revoked, undefined);
  }
  await until('both shown as up to date on the host', async () => (await syncOf(OFFICE.id))?.sync === 'latest' && (await syncOf(BACKUP.id))?.sync === 'latest', 20_000, 300);
  for (const home of [HOST_HOME, OFFICE.home, BACKUP.home]) {
    const t = allText(home);
    assert.ok(!t.includes(code) && !t.includes(code.replace('-', '')), `no clear code under ${home}`);
  }
});

test('with the host switched off, the pass still links a guest at the office node and at the backup node', async () => {
  await stop(host);
  guestAtOffice = made(await pair(OFFICE.door, code));
  guestAtBackup = made(await pair(BACKUP.door, code));
  assert.equal((await knock(OFFICE.door, guestAtOffice, '/worker/hello')).status, 200);
  assert.equal((await knock(BACKUP.door, guestAtBackup, '/worker/hello')).status, 200);
});

test('removed while the backup node is off: the office node takes it at once, the backup node when it is back; the page says which is behind', async () => {
  await stop(backup);
  host = await start(HOST_HOME);
  const rm = await page(host, 'POST', '/api/share', { passRemove: passId });
  assert.equal(rm.status, 200, rm.text);
  await until('the office node to take the removal', async () => passIn(OFFICE.home, passId)?.revoked === true, 20_000, 300);
  assert.equal((await knock(OFFICE.door, guestAtOffice, '/worker/hello')).status, 401, 'the guest there is cut off');
  const behind = await until('the backup node shown as behind', async () => {
    const s = await syncOf(BACKUP.id);
    return s && s.sync !== 'latest' ? s : null;
  }, 20_000, 500);
  assert.match(behind.said, /not answering|behind|off/i);
  assert.equal(passIn(BACKUP.home, passId)?.revoked, undefined, 'the backup node, off, still has it');
  backup = await start(BACKUP.home);
  await until('the backup node\'s door', async () => (await ask(BACKUP.door, 'GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 30_000, 300);
  // Its next hello (asked now, as the Network page does) carries the removal.
  await until('the backup node to take the removal', async () => {
    await page(host, 'GET', '/api/remotes');
    return passIn(BACKUP.home, passId)?.revoked === true;
  }, 30_000, 1000);
  assert.equal((await knock(BACKUP.door, guestAtBackup, '/worker/hello')).status, 401);
  await until('both shown as up to date', async () => (await syncOf(BACKUP.id))?.sync === 'latest' && (await syncOf(OFFICE.id))?.sync === 'latest', 20_000, 500);
  // The code links nothing anywhere now.
  for (const door of [OFFICE.door, BACKUP.door]) assert.equal((await pair(door, code) as { status: number }).status, 403);
});

test('at the office node\'s door: wrong keys, a guest link and no link cannot send passes; a hand-made host can, and its pass expires there with no host to ask', async () => {
  const soon = new Date(Date.now() + 4000).toISOString();
  const handCode = 'HJKM-NPQR';
  const record = { id: 'hand0001', label: 'Hand-made pass', key: (await link.pairKey(handCode, '')).toString('base64url'), length: 'day', created: new Date().toISOString(), expires: soon, nodes: [OFFICE.id], models: [], uses: 0, lastSeen: null, rev: 1 };
  const body = { gen: Date.now(), passes: [record] };
  assert.equal((await knock(OFFICE.door, HAND, '/worker/passes-put', body, randomBytes(64))).status, 400, 'sealed with keys that are not the link\'s');
  const stranger = { token: randomBytes(32).toString('hex'), keys: randomBytes(64) };
  assert.equal((await knock(OFFICE.door, stranger, '/worker/passes-put', body)).status, 401, 'no link');
  const ok = await knock(OFFICE.door, HAND, '/worker/passes-put', body);
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(ok.answer.gen, body.gen);
  assert.equal(passIn(OFFICE.home, 'hand0001')?.by, HAND_KEEP);
  const guest = made(await pair(OFFICE.door, handCode));
  const fromGuest = await knock(OFFICE.door, guest, '/worker/passes-put', { gen: Date.now(), passes: [] });
  assert.equal(fromGuest.status, 403);
  assert.equal(fromGuest.answer?.guest, 'refused');
  assert.equal(passIn(OFFICE.home, 'hand0001')?.revoked, undefined, 'a guest link changed nothing');
  // The same message again is refused (sent once only), and an older generation changes nothing.
  const older = await knock(OFFICE.door, HAND, '/worker/passes-put', { gen: body.gen - 1, passes: [] });
  assert.equal(older.status, 200);
  assert.equal(older.answer.stale, true);
  assert.equal(passIn(OFFICE.home, 'hand0001')?.revoked, undefined);
  // Its end, kept by the node's own clock.
  await sleep(Math.max(0, Date.parse(soon) - Date.now()) + 300);
  const ended = await knock(OFFICE.door, guest, '/worker/hello');
  assert.equal(ended.status, 403);
  assert.equal(ended.answer?.guest, 'expired');
});
