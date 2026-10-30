// Who can do what, tried with requests against a test copy started on an empty home: the app lock's doors, the checks on
// where a request comes from, the paths and ids a request can name, and a node's link door with its setup code and PIN.
// The link door normally listens on the home network: here a small preload holds it to 127.0.0.1, so nothing else can reach it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import { cleanFolder, overlaps } from '../src/workspace.ts';
import { hashToken } from '../src/share.ts';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

// Holds any listener asked for on every address to this PC's own address.
const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;

const PIN = '482605';
let recovery = '';
const home = mkdtempSync(join(tmpdir(), 'sm-access-'));
let server: ChildProcess;
let said = '';
let port = 0;
let cookie = '';

interface Answer { status: number; text: string; json: any; setCookie: string }

/** One request, with any Host, Origin or address spelling: node:http sends the path as it is written. */
function ask(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; toPort?: number; cookie?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    const req = request({ host: '127.0.0.1', port: o.toPort ?? port, path, method, agent: false, headers: { connection: 'close', ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } }, res => {
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
const open = (method: string, path: string, body?: unknown) => ask(method, path, { body, cookie });
const cookieOf = (a: Answer) => /sm_app=([^;]*)/.exec(a.setCookie)?.[1] ?? '';

before(async () => {
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(TOMLIN|SHELBY)_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '' });
  server = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, fileURLToPath(new URL('../src/server.ts', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', d => (said += d));
  server.stderr!.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
  assert.match(said, /is running at/, said);
});

after(async () => {
  server.kill();
  await new Promise(r => setTimeout(r, 400));
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

test('a request by another name, or from another site\'s page, is refused', async () => {
  for (const host of ['tomlin.test', `tomlin.test:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1.tomlin.test:${port}`, `[::1]:${port}`, `127.0.0.1:${port}@tomlin.test`]) {
    const r = await ask('GET', '/api/chats', { headers: { host } });
    assert.equal(r.status, 403, `Host ${host}: ${r.text.slice(0, 200)}`);
  }
  for (const origin of ['http://tomlin.test', 'null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}.tomlin.test`]) {
    const r = await ask('POST', '/api/todo/set', { body: {}, headers: { origin } });
    assert.equal(r.status, 403, `Origin ${origin}: ${r.text.slice(0, 200)}`);
  }
});

test('a path or id in a request stays in its folder', async () => {
  // Something to find if a path did get out: made-up files beside the workspace and in the data folder.
  writeFileSync(join(home, 'outside.txt'), 'made-up outside words');
  const ws = join(home, 'data', 'workspace');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'inside.txt'), 'made-up inside words');
  const out = join(home, 'outside-folder');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'beyond.txt'), 'made-up beyond words');
  writeFileSync(join(out, 'beyond.png'), 'made-up beyond words');
  symlinkSync(out, join(ws, 'linked'), 'junction');
  assert.equal((await ask('GET', '/api/files/read?path=inside.txt')).status, 200);
  const q = encodeURIComponent;
  const bad = [
    '../outside.txt', '..\\outside.txt', '../../outside.txt', 'x/../../../outside.txt', join(home, 'outside.txt'), `\\\\?\\${join(home, 'outside.txt')}`, `\\\\.\\${join(home, 'outside.txt')}`,
    'C:outside.txt', 'inside.txt::$DATA', 'inside.txt:made-up', 'inside.txt.', '.hidden.txt', 'linked/beyond.txt', 'linked\\beyond.txt',
  ];
  for (const p of bad) {
    const r = await ask('GET', `/api/files/read?path=${q(p)}`);
    assert.equal(r.status, 404, `${p}: ${r.text.slice(0, 200)}`);
    assert.doesNotMatch(r.text, /made-up (outside|beyond)/, p);
    const w = await ask('POST', '/api/files/save', { body: { path: p, text: 'made-up written words' } });
    assert.equal(w.status, 400, `save ${p}: ${w.text.slice(0, 200)}`);
  }
  assert.equal((await ask('GET', `/api/files/picture?path=${q('linked/beyond.png')}`)).status, 404);
  assert.equal((await ask('GET', `/api/files/picture?path=${q('../outside-folder/beyond.png')}`)).status, 404);

  const key = (await ask('GET', '/api/preview')).json.key as string;
  assert.equal((await ask('GET', `/preview/${key}/inside.txt`)).status, 200);
  for (const p of ['..%2Foutside.txt', '..%5Coutside.txt', '%2e%2e%2foutside.txt', 'linked/beyond.txt', 'linked%5Cbeyond.txt']) {
    const r = await ask('GET', `/preview/${key}/${p}`);
    assert.equal(r.status, 404, `preview ${p}: ${r.text.slice(0, 200)}`);
  }
  assert.equal((await ask('GET', `/preview/${'0'.repeat(32)}/inside.txt`)).status, 404);

  for (const p of [
    '/api/images/file/..%2F..%2Fapp-lock.json', '/api/images/file/2026-01%2F..%2F..%2Fsettings.json', '/api/images/file/2026-01/..%5C..%5Csettings.json', '/api/images/file/C%3A%5CWindows%5Cwin.ini',
    '/api/faces/file/..%2F..%2Fsettings', '/api/faces/file/staff%3A..%5C..%5Csettings', '/api/pc/photo/..%2F..%2Fsettings', '/api/pc/photo/..%5C..%5Csettings',
  ]) {
    const r = await ask('GET', p);
    assert.equal(r.status, 404, `${p}: ${r.text.slice(0, 200)}`);
  }
  for (const id of ['../settings', '..\\settings', '../../outside', 'a'.repeat(12) + '/../../settings']) {
    const r = await ask('GET', `/api/chat?id=${q(id)}`);
    assert.ok(r.status < 500, `chat ${id}: ${r.text.slice(0, 200)}`);
    assert.deepEqual(r.json.lines, [], id);
    assert.equal((await ask('POST', '/api/chats/delete', { body: { id } })).status, 404, id);
    assert.equal((await ask('GET', `/api/jobs/get?id=${q(id)}`)).status, 404, id);
    assert.equal((await ask('GET', `/api/projects/get?id=${q(id)}`)).status, 404, id);
    assert.equal((await ask('GET', `/api/previews/picture?project=${q(id)}`)).status, 404, id);
  }
});

test('a broken %-escape in a gallery file\'s name is nobody\'s file: not found, not a fault', async () => {
  const r = await ask('GET', '/api/images/file/%E0%A4%A');
  assert.equal(r.status, 404, r.text.slice(0, 200));
});

test('the workspace folder cannot be spelled so that it gets round the checks on it', async () => {
  const data = join(home, 'data');
  const q = { made: join(home, 'made-up-link') };
  symlinkSync(data, q.made, 'junction');
  for (const path of [
    // TOMLIN's own home by its device name: the same folder as C:\..., which the check on its own folders did not see.
    `\\\\.\\${data}`, `\\\\.\\${home}`,
    // A link that leads into it.
    q.made,
    // ".." that ends up in Windows' folders or a drive root after the check.
    'C:\\made-up-tomlin\\..\\Windows', 'C:\\made-up-tomlin\\..', 'C:\\Windows\\..\\Windows\\Temp',
  ]) {
    const r = await ask('POST', '/api/files/folder', { body: { path } });
    assert.equal(r.status, 400, `${path}: ${r.text.slice(0, 200)}`);
  }
  assert.equal(existsSync('C:\\made-up-tomlin'), false);
  assert.equal(cleanFolder('C:\\made-up-tomlin\\..\\Windows'), null);
  assert.equal(overlaps(q.made, [home]), true);
});

test('with the app locked, every way of spelling a route stays shut', async () => {
  const set = await ask('POST', '/api/applock', { body: { action: 'set', kind: 'pin', pin: PIN, pin2: PIN, agree: true } });
  assert.equal(set.status, 200, set.text);
  assert.ok(Array.isArray(set.json.recoveryCodes));
  recovery = set.json.recoveryCodes[0];
  assert.equal(set.json.open, false);
  assert.equal(cookieOf(set), '');

  const shut = [
    '/api/chats', '/api/chat', '/api/files', '/api/files/read?path=inside.txt', '/api/preview', '/api/network', '/api/share/reach', '/api/images/gallery', '/api/settings', '/api/faces', '/api/jobs', '/api/pc',
    '/api/../api/chats', '/x/../api/chats', '/api/./chats', '/%2e%2e/api/chats', '/./api/chats', '/api\\chats', '/preview/../api/chats', '/preview/%2e%2e/api/chats', '/x.js/../api/chats',
    '/bridge/api/projects', '/bridge/api/../api/projects', '/bridge/x/../api/settings', `http://127.0.0.1:${port}/api/chats`, `http://tomlin.test/api/chats`,
  ];
  for (const p of shut) {
    const r = await ask('GET', p).catch(e => { throw new Error(`${p}: ${e.message}`); });
    assert.equal(r.status, 423, `${p}: ${r.text.slice(0, 200)}`);
    const bad = await ask('GET', p, { cookie: 'sm_app=' + '0'.repeat(48) });
    assert.equal(bad.status, 423, `${p} with a made-up cookie: ${bad.text.slice(0, 200)}`);
  }
  for (const p of ['/api/todo/set', '/api/files/save', '/api/files/folder', '/api/share', '/api/install/zip', '/api/chat/doc', '/bridge/api/settings', '/api/models/made-up/load', '/api/panes/chat/unload', '/api/applock/../settings']) {
    const r = await ask('POST', p, { body: { path: 'made-up.txt', text: 'x' } }).catch(e => { throw new Error(`POST ${p}: ${e.message}`); });
    assert.equal(r.status, 423, `POST ${p}: ${r.text.slice(0, 200)}`);
  }
  for (const [m, p] of [['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/images/generations']]) {
    const r = await ask(m, p, m === 'POST' ? { body: {} } : {});
    assert.equal(r.status, 423, `${m} ${p}: ${r.text.slice(0, 200)}`);
  }
  // The Bridge's page goes to the lock screen; nothing of it answers.
  for (const p of ['/bridge', '/bridge/', '/bridge/index.html']) {
    const r = await ask('GET', p);
    assert.equal(r.status, 302, p);
    assert.doesNotMatch(r.text, /bridge-key/, p);
  }
  // What the lock's own door says while locked has no secret in it.
  const view = await ask('GET', '/api/applock');
  assert.equal(view.status, 200);
  assert.doesNotMatch(view.text, /salt|hash|"code":|"pin":/);

  // What changes the lock needs it open; a second first lock is refused.
  assert.equal((await ask('POST', '/api/applock', { body: { action: 'codes-new', current: PIN } })).status, 423);
  assert.equal((await ask('POST', '/api/applock', { body: { action: 'off', current: PIN } })).status, 423);
  assert.equal((await ask('POST', '/api/applock', { body: { action: 'idle', idleMinutes: 5 } })).status, 423);
  assert.equal((await ask('POST', '/api/applock', { body: { action: 'set', kind: 'pin', pin: '111111', pin2: '111111', agree: true } })).status, 409);
});

test('a node\'s link door: a used setup code, a replayed message and a removed link get nothing, and wrong tries sent side by side still count', async () => {
  const opened = await ask('POST', '/api/applock', { body: { action: 'unlock', pin: PIN } });
  assert.equal(opened.status, 200, opened.text);
  cookie = `sm_app=${cookieOf(opened)}`;
  const door = await freePort();
  const on = await open('POST', '/api/share', { on: true, port: door, pinOn: true, name: 'Made-up node' });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.listening, true, on.text);
  const { code, pin } = on.json as { code: string; pin: string };
  assert.match(pin, /^\d{6}$/);
  const pair = (body: unknown) => ask('POST', '/worker/pair', { toPort: door, body });

  // A web page cannot use it, and it answers nothing without a link.
  assert.equal((await ask('POST', '/worker/pair', { toPort: door, body: {}, headers: { origin: 'http://tomlin.test' } })).status, 403);
  for (const p of ['/worker/hello', '/worker/run', '/worker/update-list', '/worker/carry-list', '/worker/stats']) {
    assert.equal((await ask('POST', p, { toPort: door, body: {} })).status, 401, p);
    assert.equal((await ask('POST', p, { toPort: door, body: {}, headers: { authorization: `Link ${'0'.repeat(64)}` } })).status, 401, p);
  }
  // No PIN given while it asks for one: said, not counted, and nothing links.
  const key = await link.pairKey(code, pin);
  assert.equal((await pair(link.hostAsk(key, 'a1b2c3d4', 'Made-up host', false).ask)).status, 403);

  // The right code and PIN link, once.
  const asked = link.hostAsk(key, 'a1b2c3d4', 'Made-up host', true);
  const linked = await pair(asked.ask);
  assert.equal(linked.status, 200, linked.text);
  const made = link.hostFinish(key, asked.ask, asked.priv, linked.json);
  const named = { authorization: `Link ${hashToken(made.token)}` };
  const sealed = link.sealRequest(made.keys, '/worker/stats', {});
  assert.equal((await ask('POST', '/worker/stats', { toPort: door, body: sealed, headers: named })).status, 200);
  // The same sealed message sent again, or sent to another door, is refused.
  assert.notEqual((await ask('POST', '/worker/stats', { toPort: door, body: sealed, headers: named })).status, 200);
  assert.notEqual((await ask('POST', '/worker/hello', { toPort: door, body: link.sealRequest(made.keys, '/worker/stats', {}), headers: named })).status, 200);
  // The code was used up: a new link with it is a wrong try (1 of the 5).
  assert.equal((await pair(link.hostAsk(key, 'a1b2c3d4', 'Made-up host', true).ask)).status, 403);

  // A link removed here answers nothing more.
  const now = await open('POST', '/api/share', { appPin: PIN, unpairAll: true });
  assert.equal(now.status, 200, now.text);
  assert.equal((await ask('POST', '/worker/stats', { toPort: door, body: link.sealRequest(made.keys, '/worker/stats', {}), headers: named })).status, 401);

  // Wrong tries whose bodies all arrive after the door has looked at the count: only 4 more are heard, not all 12.
  const wrong = JSON.stringify(link.hostAsk(await link.pairKey(now.json.code, '000000'), 'a1b2c3d4', 'Made-up host', true).ask);
  const codes = await Promise.all(Array.from({ length: 12 }, () => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: door, path: '/worker/pair', method: 'POST', agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(wrong) } }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.flushHeaders();
    setTimeout(() => req.end(wrong), 800);
  })));
  assert.equal(codes.filter(c => c === 403).length, 4, codes.join());
  assert.equal(codes.filter(c => c === 429).length, 8, codes.join());
  // Past the limit the right code and PIN wait too, and nothing was linked.
  const stopped = await pair(link.hostAsk(await link.pairKey(now.json.code, pin), 'a1b2c3d4', 'Made-up host', true).ask);
  assert.equal(stopped.status, 429, stopped.text);
  const off = await open('POST', '/api/share', { appPin: PIN, on: false });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.json.paired, []);
});

test('an address that cannot be read is the asker\'s mistake, and the wrong-try limit holds on the lock screen', async () => {
  assert.equal((await ask('GET', '//')).status, 400);
  assert.equal((await ask('POST', '/api/applock', { body: { action: 'lock' } })).status, 200);
  // Tries sent side by side count one by one: the 5 first are heard, the others told to wait, the right PIN too.
  const tries = await Promise.all(Array.from({ length: 12 }, (_, i) => ask('POST', '/api/applock', { body: { action: 'unlock', pin: String(100000 + i) } })));
  assert.equal(tries.filter(t => t.status === 403).length, 5, tries.map(t => t.status).join());
  assert.equal(tries.filter(t => t.status === 429).length, 7, tries.map(t => t.status).join());
  const right = await ask('POST', '/api/applock', { body: { action: 'unlock', pin: PIN } });
  assert.equal(right.status, 429, right.text);
  assert.equal(cookieOf(right), '');
  const code = await ask('POST', '/api/applock', { body: { action: 'recover', code: recovery, kind: 'pin', pin: '222222', pin2: '222222' } });
  assert.equal(code.status, 429, code.text);
  assert.equal(cookieOf(code), '');
});
