// A PC started from a Bootable USB stick, as far as this PC can play one: TOMLIN started with a stick's tomlin-node.json
// (TOMLIN_USB_NODE) and a home of its own. It must listen as a node with no app lock, say its admin key's tag (never the
// key), link the admin PC that proves the key with no setup code or PIN (and again: the key is not used up), refuse
// another admin's key, say it runs from a stick in its hello, let the admin key change its permissions with no PIN,
// refuse an update sent over the link, and keep its settings across a restart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as link from '../src/link.ts';
import * as adminkey from '../src/adminkey.ts';
import { hashToken } from '../src/share.ts';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

// Holds any listener asked for on every address to this PC's own address.
const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;

const ADMIN = adminkey.newAdminKey();
const ONE = adminkey.newStick();
const home = mkdtempSync(join(tmpdir(), 'tomlin-usbnode-'));
const stickFile = join(home, 'stick', 'tomlin-node.json');
let server: ChildProcess;
let said = '';
let port = 0;
let door = 0;

interface Answer { status: number; text: string; json: any }
function ask(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; toPort?: number } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = o.body === undefined ? '' : JSON.stringify(o.body);
    const req = request({ host: '127.0.0.1', port: o.toPort ?? door, path, method, agent: false, headers: { connection: 'close', ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...o.headers } }, res => {
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

async function start(): Promise<void> {
  said = '';
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '', TOMLIN_USB_NODE: stickFile });
  server = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, fileURLToPath(new URL('../src/server.ts', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', d => (said += d));
  server.stderr!.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
  assert.match(said, /is running at/, said);
  // The node's door opens a moment after the page's.
  for (let i = 0; i < 50; i++) {
    const r = await ask('GET', '/worker/whoami').catch(() => null);
    if (r?.status === 200) return;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.fail(`the node's door did not open on ${door}: ${said}`);
}

async function stop(): Promise<void> {
  const gone = new Promise(r => server.once('exit', r));
  server.kill();
  await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]);
}

before(async () => {
  mkdirSync(join(home, 'startup'));
  mkdirSync(join(home, 'stick'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  port = await freePort();
  door = await freePort();
  writeFileSync(stickFile, JSON.stringify({ v: 2, adminPub: ADMIN.pub, stick: ONE, admin: 'Made-up admin', name: 'Made-up stick', allow: { tune: true, lend: true, receive: true, off: true }, plainLinks: true, port: door, minted: new Date().toISOString(), version: 'test' }));
  await start();
});

after(async () => {
  await stop();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

const share = () => JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8'));

let made: ReturnType<typeof link.adminHostFinish>;
const ours = (id: string) => (id === ONE.id ? ONE.pub : '');

test('a stick node listens with no app lock and says its admin\'s tag and its stick id, never a key', async () => {
  const who = await ask('GET', '/worker/whoami');
  assert.equal(who.status, 200);
  assert.equal(who.json.name, 'Made-up stick');
  assert.deepEqual(who.json.admin, [adminkey.keyTag(ADMIN.pub)]);
  assert.equal(who.json.stick, ONE.id);
  assert.equal(who.json.usb, true);
  assert.ok(!who.text.includes(ONE.priv) && !who.text.includes(ADMIN.priv));
  assert.equal(readFileSync(join(home, 'data', 'share.json'), 'utf8').includes(ONE.priv), false, 'the stick\'s key stays on the stick');
  const s = share();
  assert.equal(s.on, true);
  assert.equal(s.usbNode, true);
  assert.equal(s.plainLinks, true);
  assert.equal(s.allow.lend, true);
  assert.equal(s.port, door);
});

test('only its own admin links, with no PIN; the setup code stays; a recorded request is refused', async () => {
  const codeBefore = share().code;
  // Someone holding the stick (or a copy) has no admin private key: their own key pair signs, and is refused.
  const refused = await ask('POST', '/worker/pair', { body: link.adminHostAsk(adminkey.newAdminKey(), 'aaaa1111', 'Someone else').ask });
  assert.equal(refused.status, 403, refused.text);
  assert.match(refused.json.error, /minted by another admin/);
  const asked = link.adminHostAsk(ADMIN, 'b0b0b0b0', 'Made-up admin');
  const linked = await ask('POST', '/worker/pair', { body: asked.ask });
  assert.equal(linked.status, 200, linked.text);
  made = link.adminHostFinish(ADMIN.pub, ours, asked.ask, asked.priv, linked.json);
  assert.equal(made.stick, ONE.id);
  assert.equal(share().code, codeBefore, 'the admin key is not a setup code: nothing is used up');
  assert.equal(share().paired.find((x: { from?: string }) => x.from === 'b0b0b0b0')?.byKey, true);
  // The same request sent again (a recording): refused.
  const again = await ask('POST', '/worker/pair', { body: asked.ask });
  assert.equal(again.status, 409, again.text);
  // The admin links again with a new request: fine.
  const asked2 = link.adminHostAsk(ADMIN, 'c1c1c1c1', 'Made-up admin');
  const linked2 = await ask('POST', '/worker/pair', { body: asked2.ask });
  assert.equal(linked2.status, 200, linked2.text);
});

/** One sealed request on the admin key's link: its status and the answer opened. */
async function knock(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; answer: any }> {
  const sealed = link.sealRequest(made.keys, path, body);
  const r = await ask('POST', path, { body: sealed, headers: { authorization: `Link ${hashToken(made.token)}` } });
  return { status: r.status, answer: r.json?.box ? link.openAnswer(made.keys, link.requestId(sealed.box), 0, r.json.box) : r.json };
}

test('its hello says it runs from a stick; the admin key changes its permissions with no PIN; an update is refused', async () => {
  const hello = await knock('/worker/hello');
  assert.equal(hello.status, 200, JSON.stringify(hello.answer));
  assert.equal(hello.answer.usb, true);
  assert.equal(hello.answer.name, 'Made-up stick');
  // Permissions: with no app lock PIN and no host PIN (the admin key's link stands for them on a stick node).
  const perm = await knock('/worker/perm-set', { set: { plainLinks: false } });
  assert.equal(perm.status, 200, JSON.stringify(perm.answer));
  assert.equal(share().plainLinks, false);
  // An update sent over the link is refused, in words that say why.
  const up = await knock('/worker/update-offer', { version: '99.0.0', build: 'f'.repeat(64), files: [] });
  assert.equal(up.status, 403, JSON.stringify(up.answer));
  assert.match(JSON.stringify(up.answer), /Bootable USB stick/);
});

test('after a restart the stick node keeps its links and its name, with node mode on again', async () => {
  await stop();
  const s = share();
  s.on = false;
  s.name = 'Renamed by its admin';
  writeFileSync(join(home, 'data', 'share.json'), JSON.stringify(s));
  await start();
  const who = await ask('GET', '/worker/whoami');
  assert.equal(who.json.name, 'Renamed by its admin');
  assert.equal(share().on, true);
  assert.ok(share().paired.some((x: { from?: string }) => x.from === 'b0b0b0b0'));
});

test('a guest pass the admin sends over the admin key\'s link lets a guest link to the stick node, as a guest', async () => {
  const guestpass = await import('../src/guestpass.ts');
  const nodeId = share().id;
  const made2 = await guestpass.makePass({ label: 'Made-up guest', length: 'day', scope: [{ id: nodeId, models: ['made-up-model'] }] }, 'b0b0b0b0');
  assert.ok(!('error' in made2), JSON.stringify(made2));
  const { pass, code } = made2 as { pass: Parameters<typeof guestpass.syncSet>[0] extends (infer T)[] | undefined ? T : never; code: string };
  const put = await knock('/worker/passes-put', { gen: 1, passes: guestpass.syncSet([pass], nodeId) });
  assert.equal(put.status, 200, JSON.stringify(put.answer));
  assert.equal(put.answer.held, 1);
  const key = await link.pairKey(code, '');
  const asked = link.hostAsk(key, 'd2d2d2d2', 'Made-up guest PC', false);
  const linked = await ask('POST', '/worker/pair', { body: asked.ask });
  assert.equal(linked.status, 200, linked.text);
  const guest = share().paired.find((x: { from?: string }) => x.from === 'd2d2d2d2');
  assert.equal(guest.role, 'guest');
  assert.notEqual(guest.byKey, true);
});
