// Guest passes on a real node (a test copy on an empty home, its link door held to 127.0.0.1): a pass made on its
// Network page links a PC as a guest, and that guest is tried at every door a linked PC can call. Also: an expired and
// a removed pass, an old link with no role, wrong pass codes counted with the setup code's, and no clear code on disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import { hashToken } from '../src/share.ts';
import { GUEST_DOORS, HOST_ONLY_DOORS } from '../src/guestpass.ts';
import { MAX_DOOR, MAX_UPGRADE } from '../src/jobrun/maxnode.ts';
import { CLUSTER_TEST_DOOR, CLUSTER_TEST_UPGRADE } from '../src/cluster/testdoor.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'tomlin-guest-'));
const NODE_ID = 'a1b2c3d4';
const EXPIRED_CODE = 'HJKM-NPQR';
let server: ChildProcess;
let said = '';
let port = 0;
let door = 0;
let cookie = '';

interface Answer { status: number; text: string; json: any; setCookie: string }
function ask(method: string, path: string, o: { body?: unknown; raw?: string; headers?: Record<string, string>; toPort?: number } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = o.raw ?? (o.body === undefined ? '' : JSON.stringify(o.body));
    const req = request({ host: '127.0.0.1', port: o.toPort ?? port, path, method, agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(cookie && !o.toPort ? { cookie } : {}), ...o.headers } }, res => {
      const got: Buffer[] = [];
      res.on('data', d => got.push(d));
      res.on('end', () => {
        const s = Buffer.concat(got).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(s); } catch { /* a stream, or nothing */ }
        resolve({ status: res.statusCode ?? 0, text: s, json, setCookie: String(res.headers['set-cookie'] ?? '') });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

interface Made { token: string; keys: Buffer }
const PUT_DOORS = new Set(['/worker/carry-put', '/worker/backup-put', '/worker/update-put', '/worker/git-put', '/worker/runner-put']);
/** One sealed request on a link: its status and the answer opened (null when it was not a sealed answer). */
async function knock(m: Made, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; answer: any }> {
  const sealed = link.sealRequest(m.keys, path, body);
  const headers = { authorization: `Link ${hashToken(m.token)}`, ...(PUT_DOORS.has(path) ? { 'x-link': sealed.box } : {}) };
  const r = await ask('POST', path, { toPort: door, headers, ...(PUT_DOORS.has(path) ? { raw: '' } : { body: sealed }) });
  let answer: any = null;
  if (r.json?.box) answer = link.openAnswer(m.keys, link.requestId(sealed.box), 0, r.json.box);
  else if (r.json) answer = r.json;
  return { status: r.status, answer };
}

/** An Upgrade door (Max mode, the cluster test): the status it answered with, or 101 when it opened. */
function upgrade(m: Made, path: string, kind: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sealed = link.sealRequest(m.keys, path, body);
    const req = request({ host: '127.0.0.1', port: door, path, method: 'GET', agent: false, headers: { connection: 'Upgrade', upgrade: kind, authorization: `Link ${hashToken(m.token)}`, 'x-link': sealed.box } });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve({ status: 101, text: '' }); });
    req.on('response', res => {
      let t = '';
      res.on('data', d => (t += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Links as a PC would with `code` (and `pin`): the link's token and keys, or the refusal. */
async function pair(code: string, pin = '', from = randomBytes(4).toString('hex')): Promise<{ made: Made } | { status: number; json: any }> {
  const key = await link.pairKey(code, pin);
  const asked = link.hostAsk(key, from, 'Made-up laptop', !!pin);
  const r = await ask('POST', '/worker/pair', { toPort: door, body: asked.ask });
  if (r.status !== 200) return { status: r.status, json: r.json };
  const f = link.hostFinish(key, asked.ask, asked.priv, r.json);
  return { made: { token: f.token, keys: f.keys } };
}

const shareFile = () => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));
const madeLink = (): Made & { record: Record<string, unknown> } => {
  const token = randomBytes(32).toString('hex');
  const keys = randomBytes(64);
  return { token, keys, record: { hash: hashToken(token), key: link.keysText(keys) } };
};
/** Every file under the home, as text. */
function allText(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allText(p));
    else out.push(readFileSync(p).toString('latin1'));
  }
  return out;
}

const OLD = madeLink();
const EXPIRED = madeLink();
const REMOVED = madeLink();
let oldRecord: Record<string, unknown>;

before(async () => {
  door = await freePort();
  port = await freePort();
  const data = join(home, 'data');
  mkdirSync(join(home, 'startup'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  const { scryptSync } = await import('node:crypto');
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  const day = 86_400_000;
  const past = new Date(Date.now() - 2 * day).toISOString();
  oldRecord = { name: 'Old main PC', at: past, ...OLD.record };
  writeFileSync(join(data, 'share.json'), JSON.stringify({
    on: true, port: door, name: 'Made-up node', id: NODE_ID, code: NODE_CODE, pinOn: false, pin: '', models: [],
    allow: { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true },
    passes: [
      { id: 'e1e1e1e1', label: 'Ended pass', key: (await link.pairKey(EXPIRED_CODE, '')).toString('base64url'), length: 'day', created: new Date(Date.now() - 3 * day).toISOString(), expires: past, nodes: [NODE_ID], models: [], uses: 1, lastSeen: null },
      { id: 'r1r1r1r1', label: 'Removed pass', key: '', length: 'week', created: past, expires: new Date(Date.now() + 5 * day).toISOString(), nodes: [NODE_ID], models: [], uses: 1, lastSeen: null, revoked: true },
    ],
    paired: [
      oldRecord,
      { name: 'Ended guest', at: past, ...EXPIRED.record, role: 'guest', passId: 'e1e1e1e1', expires: past },
      { name: 'Removed guest', at: past, ...REMOVED.record, role: 'guest', passId: 'r1r1r1r1', expires: new Date(Date.now() + 5 * day).toISOString() },
    ],
  }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '' });
  server = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, join(SRC, 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', d => (said += d));
  server.stderr!.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
  assert.match(said, /is running at/, said);
  const opened = await ask('POST', '/api/applock', { body: { action: 'unlock', pin: NODE_PIN } });
  assert.equal(opened.status, 200, opened.text);
  cookie = `sm_app=${/sm_app=([^;]*)/.exec(opened.setCookie)?.[1] ?? ''}`;
  // The link door opens a moment after the page.
  for (let i = 0; i < 50 && (await ask('GET', '/worker/whoami', { toPort: door }).catch(() => ({ status: 0 }))).status !== 200; i++) await sleep(300);
});

after(async () => {
  server?.kill();
  await sleep(400);
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

/** Every door named in the source: the test lists must hold each one, so a door added later must be put in one. */
function doorsInSource(): string[] {
  const found = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) for (const m of readFileSync(p, 'utf8').matchAll(/\/worker\/[a-z][a-z0-9-]*[a-z0-9]/g)) found.add(m[0]);
    }
  };
  walk(SRC);
  return [...found];
}

let guestCode = '';
let guestPassId = '';
let guestLink: Made;

test('a pass is made on the node\'s page with the app lock PIN; its code is shown once and kept nowhere', async () => {
  const refused = await ask('POST', '/api/share', { body: { passMake: { label: 'Made-up laptop', length: 'week', models: [] } } });
  assert.equal(refused.status, 403, 'a node needs its app lock PIN for a change');
  const r = await ask('POST', '/api/share', { body: { appPin: NODE_PIN, passMake: { label: 'Made-up laptop', length: 'week', models: [] } } });
  assert.equal(r.status, 200, r.text);
  guestCode = r.json.madePass.code;
  guestPassId = r.json.madePass.id;
  assert.match(guestCode, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  const line = r.json.passes.find((x: { id: string }) => x.id === guestPassId);
  assert.equal(line.label, 'Made-up laptop');
  assert.equal(line.expired, false);
  assert.ok(Math.abs(Date.parse(line.expires) - Date.now() - 7 * 86_400_000) < 60_000);
  // The ended pass is listed (greyed on the page), the removed one is not.
  assert.equal(r.json.passes.find((x: { id: string }) => x.id === 'e1e1e1e1')?.expired, true);
  assert.equal(r.json.passes.some((x: { id: string }) => x.id === 'r1r1r1r1'), false);
  // Read again, the page never sees the code or the key.
  const again = await ask('POST', '/api/share', { body: { appPin: NODE_PIN } });
  assert.equal(again.status, 200, again.text);
  for (const t of [again.text, JSON.stringify(r.json.passes)]) {
    assert.ok(!t.includes(guestCode) && !t.includes(guestCode.replace('-', '')), 'no code in what the page reads after');
    assert.doesNotMatch(t, /"key"/);
  }
  const files = allText(home).join('\n');
  assert.ok(!files.includes(guestCode) && !files.includes(guestCode.replace('-', '')), 'no clear code anywhere under the home');
  assert.ok(!said.includes(guestCode.replace('-', '')), 'none in what it printed');
});

test('the pass code links a guest: the setup code is not used up, the old link is untouched', async () => {
  const before = shareFile().code;
  const r = await pair(guestCode);
  assert.ok('made' in r, JSON.stringify(r));
  guestLink = (r as { made: Made }).made;
  const s = shareFile();
  assert.equal(s.code, before, 'the setup code stays (it was not typed)');
  const g = s.paired.find((x: { hash: string }) => x.hash === hashToken(guestLink.token));
  assert.equal(g.role, 'guest');
  assert.equal(g.passId, guestPassId);
  assert.equal(g.expires, s.passes.find((x: { id: string }) => x.id === guestPassId).expires);
  assert.equal(s.passes.find((x: { id: string }) => x.id === guestPassId).uses, 1);
  assert.deepEqual(s.paired.find((x: { hash: string }) => x.hash === OLD.record.hash), oldRecord, 'the old link as it was');
  const view = await ask('POST', '/api/share', { body: { appPin: NODE_PIN } });
  assert.equal(view.json.paired.find((x: { name: string }) => x.name === 'Made-up laptop')?.guest, true);
});

test('the guest at every door: only its models, its own answers and pulling updates; every other door, Max mode and the cluster test refused', async () => {
  const listed = new Set([...GUEST_DOORS, ...HOST_ONLY_DOORS, '/worker/pair', '/worker/whoami', MAX_DOOR, CLUSTER_TEST_DOOR]);
  // tune-, carry- and the like are prefixes in the source: the doors under them are in the lists by full name.
  const missing = doorsInSource().filter(d => !listed.has(d) && !/-$/.test(d) && !['/worker/tune', '/worker/carry', '/worker/backup', '/worker/update', '/worker/git', '/worker/runner'].includes(d));
  assert.deepEqual(missing, [], 'a door in the source that no list names');
  for (const d of GUEST_DOORS) {
    const r = await knock(guestLink, d, d === '/worker/draw' ? {} : { rid: 'x' });
    assert.notEqual(r.answer?.guest, 'refused', `${d}: ${JSON.stringify(r)}`);
    assert.notEqual(r.status, 401, d);
  }
  for (const d of [...HOST_ONLY_DOORS, '/worker/tune-start', '/worker/tune-state', '/worker/made-up-new-door']) {
    const r = await knock(guestLink, d);
    assert.equal(r.status, 403, `${d}: ${JSON.stringify(r)}`);
    assert.equal(r.answer?.guest, 'refused', d);
  }
  const max = await upgrade(guestLink, MAX_DOOR, MAX_UPGRADE, { nonce: randomBytes(16).toString('base64url') });
  assert.equal(max.status, 403, max.text);
  assert.match(max.text, /guest/);
  const cluster = await upgrade(guestLink, CLUSTER_TEST_DOOR, CLUSTER_TEST_UPGRADE, { target: 'rpc' });
  assert.equal(cluster.status, 403, cluster.text);
  assert.match(cluster.text, /guest/);
  // Hello tells it what it may do: no ticks but pulling, no other links, no drives.
  const hello = await knock(guestLink, '/worker/hello');
  assert.equal(hello.status, 200, JSON.stringify(hello));
  assert.deepEqual(hello.answer.allow, { pull: false, backup: false, update: false, tune: false, lend: false, receive: false, give: true, off: false });
  assert.equal(hello.answer.lentTo, null);
  assert.deepEqual(hello.answer.drives, []);
  assert.equal(hello.answer.guest.label, 'Made-up laptop');
  for (const c of ['carry', 'update', 'runner', 'tune', 'max', 'receive', 'model-remove', 'ctx-set', 'fetch', 'git']) assert.ok(!hello.answer.can.includes(c), c);
  // A guest can pull, and never push.
  assert.notEqual((await knock(guestLink, '/worker/update-list')).answer?.guest, 'refused');
  assert.equal((await knock(guestLink, '/worker/update-offer', { version: '9.9.9' })).answer?.guest, 'refused');
});

test('an old link with no role is as it was at every door', async () => {
  for (const d of [...GUEST_DOORS, ...HOST_ONLY_DOORS]) {
    const r = await knock(OLD, d);
    assert.equal(r.answer?.guest, undefined, `${d}: ${JSON.stringify(r)}`);
    assert.notEqual(r.status, 401, d);
  }
  const hello = await knock(OLD, '/worker/hello');
  assert.equal(hello.answer.allow.update, true);
  assert.equal(hello.answer.guest, undefined);
  assert.ok(hello.answer.can.includes('carry'));
});

test('an ended pass\'s link gets nothing, hello too; a removed pass\'s link is not known', async () => {
  for (const d of ['/worker/hello', '/worker/run', '/worker/update-list']) {
    const r = await knock(EXPIRED, d);
    assert.equal(r.status, 403, d);
    assert.equal(r.answer?.guest, 'expired', d);
    assert.ok(r.answer.expired, d);
  }
  assert.equal((await knock(REMOVED, '/worker/hello')).status, 401);
  // Still kept: an ended pass's link is not removed (Phase 3 asks the host from it).
  assert.ok(shareFile().paired.some((x: { name: string }) => x.name === 'Ended guest'));
});

test('a host still links with the setup code (and the PIN) beside passes, as a full link', async () => {
  const on = await ask('POST', '/api/share', { body: { appPin: NODE_PIN, pinOn: true } });
  assert.equal(on.status, 200, on.text);
  const r = await pair(on.json.code, on.json.pin);
  assert.ok('made' in r, JSON.stringify(r));
  const rec = shareFile().paired.find((x: { hash: string }) => x.hash === hashToken((r as { made: Made }).made.token));
  assert.equal(rec.role, undefined);
  assert.equal(rec.passId, undefined);
  // A pass needs no PIN, even while this PC asks for one.
  const g = await pair(guestCode);
  assert.ok('made' in g, JSON.stringify(g));
});

test('Remove: the guest is cut off and the code links nothing; wrong pass codes count with the setup code\'s, so the right one waits too', async () => {
  const second = await ask('POST', '/api/share', { body: { appPin: NODE_PIN, passMake: { label: 'Second laptop', length: 'day', models: [] } } });
  assert.equal(second.status, 200, second.text);
  const rm = await ask('POST', '/api/share', { body: { appPin: NODE_PIN, passRemove: guestPassId } });
  assert.equal(rm.status, 200, rm.text);
  assert.equal(rm.json.passes.some((x: { id: string }) => x.id === guestPassId), false);
  assert.equal((await knock(guestLink, '/worker/hello')).status, 401);
  // Its links are kept, stamped, only for the window to collect work already done (src/guestpass.ts COLLECT_MS).
  assert.ok(shareFile().paired.filter((x: { passId?: string }) => x.passId === guestPassId).every((x: { endedAt?: string }) => !!x.endedAt), 'its links ended with it');
  // Wrong tries: the removed code, the ended code, three made up (5 from this address).
  for (const code of [guestCode, EXPIRED_CODE, 'AAAA-2222', 'BBBB-3333', 'CCCC-4444']) {
    const r = await pair(code);
    assert.ok(!('made' in r));
    assert.equal((r as { status: number }).status, 403, code);
  }
  const waits = await pair(second.json.madePass.code);
  assert.ok(!('made' in waits));
  assert.equal((waits as { status: number }).status, 429);
});
