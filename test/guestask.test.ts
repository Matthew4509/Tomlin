// Phase 3 on real test copies (each its own home, link doors held to 127.0.0.1): a host that is not a node, a node,
// and a guest laptop. The laptop links with a pass code and is told it is a guest; its pass expires; it sends one request
// while the host is off; the request waits on the node; the host, back, sees it and approves; the same link works again
// and the laptop typed nothing. Then, on the node's own pass with test clients: Deny with a reason, Block, Remove (no
// request, but finished work can still be collected for a while), and the limits on a request.
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
import { hashToken } from '../src/share.ts';
import { freePort, NODE_CODE, NODE_PIN, sleep, startLine, until } from './pcs.ts';

const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const top = mkdtempSync(join(tmpdir(), 'tomlin-guestask-'));
const NODE = { id: 'aaaa1111', home: join(top, 'node'), door: 0 };
const HOST_HOME = join(top, 'host');
const GUEST_HOME = join(top, 'laptop');
const OWN_CODE = 'HJKM-NPQR';

interface Copy { proc: ChildProcess; port: number; cookie: string }
const running: Copy[] = [];
async function start(home: string): Promise<Copy> {
  mkdirSync(join(home, 'startup'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '' });
  const proc = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  proc.stdout!.on('data', d => (said += d));
  proc.stderr!.on('data', d => (said += d));
  assert.equal(await startLine(proc, () => said), 'up', said);
  const c: Copy = { proc, port, cookie: '' };
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
async function knock(m: Made, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; answer: any }> {
  const sealed = link.sealRequest(m.keys, path, body);
  const r = await ask(NODE.door, 'POST', path, { body: sealed, headers: { authorization: `Link ${hashToken(m.token)}` } });
  let answer: any = r.json;
  if (r.json?.box) answer = link.openAnswer(m.keys, link.requestId(sealed.box), 0, r.json.box);
  return { status: r.status, answer };
}
async function pair(code: string): Promise<Made> {
  const key = await link.pairKey(code, '');
  const asked = link.hostAsk(key, randomBytes(4).toString('hex'), 'Made-up test guest', false);
  const r = await ask(NODE.door, 'POST', '/worker/pair', { body: asked.ask });
  assert.equal(r.status, 200, r.text);
  const f = link.hostFinish(key, asked.ask, asked.priv, r.json);
  return { token: f.token, keys: f.keys };
}
const shareOf = (home: string) => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));
const remoteOf = async (c: Copy, id: string) => (await page(c, 'GET', '/api/remotes')).json.remotes.find((r: { id: string }) => r.id === id);
const savedRemote = (home: string, id: string) => JSON.parse(readFileSync(join(home, 'data', 'settings.json'), 'utf8')).remotes.find((r: { id: string }) => r.id === id);

let node: Copy;
let host: Copy;
let laptop: Copy;
/**
 * When the node's own pass (made by hand before it starts) ends. Long at first, so the test clients can link on it however
 * slowly the three copies start (it was 45 s from the start, and a busy PC used that up before they linked); made short
 * by hand while the node is off in the second test, as the laptop's pass is, so it has ended by the last test.
 */
let ownEnds = 0;
/** How long, once a pass is made short by hand, until it ends. */
const SHORT_MS = 4000;

before(async () => {
  NODE.door = await freePort();
  const data = join(NODE.home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync(NODE_PIN, 'feed', 32).toString('hex'), idleMinutes: 0 }));
  ownEnds = Date.now() + 60 * 60_000;
  writeFileSync(join(data, 'share.json'), JSON.stringify({
    on: true, port: NODE.door, name: 'Office node', id: NODE.id, code: NODE_CODE, pinOn: false, pin: '', models: [], paired: [],
    allow: { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true },
    passes: [{ id: 'own00001', label: 'Own pass', key: (await link.pairKey(OWN_CODE, '')).toString('base64url'), length: 'day', created: new Date().toISOString(), expires: new Date(ownEnds).toISOString(), nodes: [NODE.id], models: [], uses: 0, lastSeen: null, rev: 1 }],
  }));
  [node, host, laptop] = await Promise.all([start(NODE.home), start(HOST_HOME), start(GUEST_HOME)]);
  const opened = await page(node, 'POST', '/api/applock', { action: 'unlock', pin: NODE_PIN });
  node.cookie = `sm_app=${/sm_app=([^;]*)/.exec(opened.setCookie)?.[1] ?? ''}`;
  await until('the node\'s link door', async () => (await ask(NODE.door, 'GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 120_000, 300);
  const linked = await page(host, 'POST', '/api/remotes', { action: 'add', url: `127.0.0.1:${NODE.door}`, code: NODE_CODE });
  assert.equal(linked.status, 200, linked.text);
});

after(async () => {
  for (const c of running) await stop(c);
  rmSync(top, { recursive: true, force: true, maxRetries: 5 });
});

let code = '';
let passId = '';
let clientA: Made;
let clientB: Made;

test('the laptop links with a pass code and is told it is a guest; it records that, and cannot make passes for that node', async () => {
  // Test clients on the node's own pass, while it is live (used further down).
  clientA = await pair(OWN_CODE);
  clientB = await pair(OWN_CODE);
  const made = await page(host, 'POST', '/api/share', { passMake: { label: 'Visiting laptop', length: 'week', nodes: [{ id: NODE.id, models: [] }] } });
  assert.equal(made.status, 200, made.text);
  code = made.json.madePass.code;
  passId = made.json.madePass.id;
  await until('the pass on the node', async () => (shareOf(NODE.home).passes ?? []).some((x: { id: string }) => x.id === passId), 120_000, 300);
  const r = await page(laptop, 'POST', '/api/remotes', { action: 'add', url: `127.0.0.1:${NODE.door}`, code });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.linked.role, 'guest', 'the node told which it was');
  const seen = await remoteOf(laptop, NODE.id);
  assert.equal(seen.ok, true);
  assert.equal(seen.role, 'guest');
  assert.ok(Math.abs(Date.parse(seen.expires) - Date.now() - 7 * 86_400_000) < 120_000);
  assert.equal(savedRemote(GUEST_HOME, NODE.id).role, 'guest');
  // A guest network is not one this PC makes passes for.
  const view = await page(laptop, 'POST', '/api/share', {});
  assert.deepEqual(view.json.passNodes, []);
  assert.equal((await page(laptop, 'POST', '/api/share', { passMake: { label: 'x', length: 'day', nodes: [{ id: NODE.id, models: [] }] } })).status, 400);
  // The host's own link is as it was: an admin link with every tick.
  const h = await remoteOf(host, NODE.id);
  assert.equal(h.role, undefined);
  assert.equal(h.allow.update, true);
});

test('expired while the host is off: the laptop sends one request (markup stripped, 200 characters); it waits on the node; a second is refused', async () => {
  await stop(host);
  await stop(node);
  const s = shareOf(NODE.home);
  ownEnds = Date.now() + SHORT_MS;
  for (const p of s.passes) if (p.id === passId || p.id === 'own00001') p.expires = new Date(ownEnds).toISOString();
  writeFileSync(join(NODE.home, 'data', 'share.json'), JSON.stringify(s));
  node = await start(NODE.home);
  const opened = await page(node, 'POST', '/api/applock', { action: 'unlock', pin: NODE_PIN });
  node.cookie = `sm_app=${/sm_app=([^;]*)/.exec(opened.setCookie)?.[1] ?? ''}`;
  await until('the node\'s link door', async () => (await ask(NODE.door, 'GET', '/worker/whoami').catch(() => ({ status: 0 }))).status === 200, 120_000, 300);
  const expired = await until('the laptop to see its pass expired', async () => {
    const r = await remoteOf(laptop, NODE.id);
    return r && !r.ok && r.passEnd?.state === 'expired' ? r : null;
  }, 120_000, 1000);
  assert.equal(expired.canAsk, true);
  const sent = await page(laptop, 'POST', '/api/remotes', { action: 'pass-ask', id: NODE.id, text: `<b>Hi</b>, it is me ${'again '.repeat(80)}` });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.state, 'waiting');
  const again = await page(laptop, 'POST', '/api/remotes', { action: 'pass-ask', id: NODE.id, text: 'me again' });
  assert.equal(again.status, 409, again.text);
  assert.match(again.json.error, /already waiting/);
  const kept = shareOf(NODE.home).passAsks;
  assert.equal(kept.length, 1);
  assert.ok(kept[0].text.length <= 200);
  assert.doesNotMatch(kept[0].text, /[<>]/);
  assert.match(kept[0].text, /^Hi, it is me again/);
  assert.equal((await remoteOf(laptop, NODE.id)).ask.state, 'waiting', 'the laptop says: sent, waiting');
});

test('the host, back, sees the request as a question and approves: the same link works again and the laptop typed nothing', async () => {
  const tokenBefore = savedRemote(GUEST_HOME, NODE.id).token;
  host = await start(HOST_HOME);
  const q = await until('the request on the host', async () => {
    await page(host, 'GET', '/api/remotes');
    return (await page(host, 'POST', '/api/share', {})).json.passAsks?.[0];
  }, 120_000, 1000);
  assert.equal(q.pc, NODE.id);
  assert.equal(q.name, 'TOMLIN');
  assert.match(q.text, /^Hi, it is me again/);
  assert.equal(q.defaultLength, 'week', 'the last length used');
  const yes = await page(host, 'POST', '/api/share', { passAnswer: { pc: NODE.id, id: q.id, answer: 'renew', length: '2weeks' } });
  assert.equal(yes.status, 200, yes.text);
  const back = await until('the laptop linked again', async () => {
    const r = await remoteOf(laptop, NODE.id);
    return r?.ok ? r : null;
  }, 120_000, 1000);
  assert.equal(back.role, 'guest');
  assert.ok(Math.abs(Date.parse(back.expires) - Date.now() - 14 * 86_400_000) < 120_000);
  assert.equal(savedRemote(GUEST_HOME, NODE.id).token, tokenBefore, 'the same link');
  const after = (await page(host, 'POST', '/api/share', {})).json;
  assert.equal(after.passAsks.length, 0);
  // The host's list says that guest's link was renewed, and until when (its pass itself still ended).
  const line = after.passes.find((x: { id: string }) => x.id === passId);
  assert.equal(line.renewals.length, 1);
  assert.equal(line.renewals[0].name, 'TOMLIN');
  assert.equal(line.renewals[0].pcName, 'Office node');
  assert.ok(Math.abs(Date.parse(line.renewals[0].until) - Date.now() - 14 * 86_400_000) < 120_000);
  assert.equal(after.passLastLength, '2weeks', 'offered first next time');
});

test('on the node\'s own pass: Deny shows its reason, Block silences the link, and Remove leaves no way to ask, only the work to collect for a while', async () => {
  await sleep(Math.max(0, ownEnds - Date.now()) + 500);
  const ended = await knock(clientA, '/worker/hello');
  assert.equal(ended.status, 403);
  assert.equal(ended.answer.guest, 'expired');
  assert.equal(ended.answer.canAsk, true);
  assert.equal((await knock(clientA, '/worker/pass-ask', { text: 'please' })).status, 200);
  assert.equal((await knock(clientB, '/worker/pass-ask', { text: 'me too' })).status, 200);
  const view = await page(node, 'POST', '/api/share', { appPin: NODE_PIN });
  const asks = view.json.passAsks;
  assert.equal(asks.length, 2, 'the node\'s own pass: asked on its own page');
  const a = asks.find((x: { text: string }) => x.text === 'please');
  const b = asks.find((x: { text: string }) => x.text === 'me too');
  assert.equal((await page(node, 'POST', '/api/share', { appPin: NODE_PIN, passAnswer: { id: a.id, answer: 'deny', reason: 'Not this <b>week</b>' } })).status, 200);
  const denied = await knock(clientA, '/worker/hello');
  assert.equal(denied.answer.ask.state, 'denied');
  assert.equal(denied.answer.ask.reason, 'Not this week');
  assert.equal((await page(node, 'POST', '/api/share', { appPin: NODE_PIN, passAnswer: { id: b.id, answer: 'block' } })).status, 200);
  const blocked = await knock(clientB, '/worker/pass-ask', { text: 'again' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.answer.guest, 'blocked');
  assert.equal((await knock(clientB, '/worker/hello')).answer.canAsk, false);
  assert.equal((shareOf(NODE.home).passAsks ?? []).filter((x: { answer?: string }) => !x.answer).length, 0, 'nothing new for the owner');
  // Remove: nothing to ask, but work already done can be collected for 2 hours.
  assert.equal((await page(node, 'POST', '/api/share', { appPin: NODE_PIN, passRemove: 'own00001' })).status, 200);
  assert.equal((await knock(clientA, '/worker/hello')).status, 401);
  assert.equal((await knock(clientA, '/worker/pass-ask', { text: 'why' })).status, 401);
  const collect = await knock(clientA, '/worker/result', { rid: 'abcdefghijklmnop' });
  assert.notEqual(collect.status, 401, JSON.stringify(collect));
  assert.notEqual(collect.answer?.guest, 'removed');
  // An admin link is as before.
  assert.equal((await remoteOf(host, NODE.id)).ok, true);
});
