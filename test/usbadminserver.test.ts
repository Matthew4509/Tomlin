// The admin PC and a stick node, both TOMLIN on this PC: the admin makes its key on the Bootable USB page, the node is
// started as a stick minted with it, and the admin links it with "Add" (its admin key, no code), sees it as a stick PC,
// lists the hardware kinds with it, and is refused by a node minted with another key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as adminkey from '../src/adminkey.ts';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});
const HOLD_TO_THIS_PC = `data:text/javascript,import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return l.apply(this,a);};`;

interface Pc { home: string; port: number; door: number; server?: ChildProcess; said: string }
const made: Pc[] = [];

function ask(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { connection: 'close', ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) } }, res => {
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

async function startPc(stick: Record<string, unknown> | null): Promise<Pc> {
  const pc: Pc = { home: mkdtempSync(join(tmpdir(), 'tomlin-usbadmin-')), port: await freePort(), door: await freePort(), said: '' };
  made.push(pc);
  mkdirSync(join(pc.home, 'startup'));
  writeFileSync(join(pc.home, 'models-folder.txt'), '');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, { TOMLIN_HOME: pc.home, TOMLIN_PORT: String(pc.port), TOMLIN_MODELS_FILE: join(pc.home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(pc.home, 'startup'), TOMLIN_DESKTOP_DIR: join(pc.home, 'desktop'), TOMLIN_START_MENU_DIR: join(pc.home, 'start-menu'), TOMLIN_INSTALL_ROOT: join(pc.home, 'install'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_OPEN: '' });
  if (stick) {
    const f = join(pc.home, 'tomlin-node.json');
    writeFileSync(f, JSON.stringify({ v: 2, admin: 'Made-up admin', name: 'Made-up stick', port: pc.door, minted: new Date().toISOString(), version: 'test', ...stick }));
    env.TOMLIN_USB_NODE = f;
  }
  pc.server = spawn(process.execPath, ['--import', HOLD_TO_THIS_PC, fileURLToPath(new URL('../src/server.ts', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  pc.server.stdout!.on('data', d => (pc.said += d));
  pc.server.stderr!.on('data', d => (pc.said += d));
  for (let i = 0; i < 200 && !pc.said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
  assert.match(pc.said, /is running at/, pc.said);
  if (stick) {
    for (let i = 0; i < 50; i++) {
      if ((await ask(pc.door, 'GET', '/worker/whoami').catch(() => null))?.status === 200) return pc;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.fail(`no node door: ${pc.said}`);
  }
  return pc;
}

let admin: Pc;
let key: adminkey.KeyPair;
/** A stick as Mint would record it on the admin PC (Mint itself needs a real removable drive). */
function listStick(s: adminkey.StickIdentity): void {
  const f = join(admin.home, 'data', 'usb.json');
  const r = JSON.parse(readFileSync(f, 'utf8'));
  r.sticks = [...(r.sticks ?? []), { id: s.id, pub: s.pub, at: new Date().toISOString(), drive: 'E:', name: 'Made-up stick' }];
  writeFileSync(f, JSON.stringify(r));
}

before(async () => {
  admin = await startPc(null);
});

after(async () => {
  for (const pc of made) {
    const gone = new Promise(r => pc.server?.once('exit', r));
    pc.server?.kill();
    await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]);
    rmSync(pc.home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the Bootable USB page: no key at first, Make the admin key (never shown), a second Make refused', async () => {
  const v = await ask(admin.port, 'GET', '/api/usb');
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.key, false);
  assert.deepEqual(v.json.sticks, []);
  assert.equal(v.json.pcsPerKey, 1000);
  assert.equal(v.json.parts.length, 5, 'Node.js, llama.cpp CPU and Vulkan, sharp and its libvips');
  assert.ok(v.json.parts.every((p: { here: boolean }) => p.here === false));
  assert.equal(v.json.iso.file, 'debian-live-13.8.0-amd64-standard.iso');
  const m = await ask(admin.port, 'POST', '/api/usb', { action: 'key-make' });
  assert.equal(m.status, 200, m.text);
  assert.equal(m.json.key, true);
  key = adminkey.cleanPair(JSON.parse(readFileSync(join(admin.home, 'data', 'usb.json'), 'utf8')).key)!;
  assert.ok(key);
  assert.equal(m.json.tag, adminkey.keyTag(key.pub));
  assert.ok(!m.text.includes(key.priv), 'the private key never reaches the page');
  assert.equal((await ask(admin.port, 'POST', '/api/usb', { action: 'key-make' })).status, 409);
  assert.equal((await ask(admin.port, 'POST', '/api/usb', { action: 'key-set', key: 'ABCD-EFGH-JKMN-PQRS' })).status, 400, 'no shared key can be typed in');
  // Mint refuses a drive Windows does not list as removable (a typed path is never written to).
  const mint = await ask(admin.port, 'POST', '/api/usb', { action: 'mint', drive: admin.home });
  assert.equal(mint.status, 400, mint.text);
});

test('Add links only a stick on this PC\'s list, with no code; the list says which PC and when last seen; a lost stick is cut off', async () => {
  const one = adminkey.newStick();
  // Not on the list yet (minted elsewhere, or a copy given a new identity): refused before anything is sent.
  const node = await startPc({ adminPub: key.pub, stick: one });
  const early = await ask(admin.port, 'POST', '/api/remotes', { action: 'add', url: `http://127.0.0.1:${node.door}`, adminKey: true });
  assert.equal(early.status, 400, early.text);
  assert.match(early.json.error, /not started from a stick minted by this PC/);
  listStick(one);
  const add = await ask(admin.port, 'POST', '/api/remotes', { action: 'add', url: `http://127.0.0.1:${node.door}`, adminKey: true });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.json.linked.role, 'admin');
  assert.equal(add.json.linked.name, 'Made-up stick');
  const pcs = await ask(admin.port, 'GET', '/api/nodes/others');
  const it = pcs.json.pcs.find((p: { name: string }) => p.name === 'Made-up stick');
  assert.ok(it?.ok, JSON.stringify(pcs.json).slice(0, 400));
  assert.equal(it.usb, true);
  // The list: the stick, the PC it is, answering now, seen now.
  const v = await ask(admin.port, 'GET', '/api/usb');
  const row = v.json.sticks.find((s: { id: string }) => s.id === one.id);
  assert.equal(row.pc, it.id);
  assert.equal(row.on, true);
  assert.ok(Date.now() - Date.parse(row.lastSeen) < 60_000, JSON.stringify(row));
  // The hardware kinds: this PC and the stick node, read now.
  const kinds = await ask(admin.port, 'GET', '/api/usb/kinds');
  assert.equal(kinds.status, 200, kinds.text);
  const all = kinds.json.kinds.flatMap((k: { pcs: { id: string }[] }) => k.pcs.map(p => p.id));
  assert.ok(all.includes('here'));
  assert.ok(all.includes(it.id));
  // Both run on this one PC, so they are twins: one kind.
  assert.equal(kinds.json.kinds.length, 1, JSON.stringify(kinds.json.kinds));

  // A stick of another admin: refused.
  const other = await startPc({ adminPub: adminkey.newAdminKey().pub, stick: adminkey.newStick() });
  const refused = await ask(admin.port, 'POST', '/api/remotes', { action: 'add', url: `http://127.0.0.1:${other.door}`, adminKey: true });
  assert.equal(refused.status, 400, refused.text);
  // A pretender that names a listed stick but holds another key: refused, as it cannot sign as that stick.
  const two = adminkey.newStick();
  listStick(two);
  const pretender = await startPc({ adminPub: key.pub, stick: { ...adminkey.newStick(), id: two.id } });
  const fake = await ask(admin.port, 'POST', '/api/remotes', { action: 'add', url: `http://127.0.0.1:${pretender.door}`, adminKey: true });
  assert.equal(fake.status, 502, fake.text);
  assert.match(fake.json.error, /not signed by the stick it names/);

  // Marked lost: its link here goes, and it cannot be added again until found.
  const lost = await ask(admin.port, 'POST', '/api/usb', { action: 'stick-lost', id: one.id });
  assert.equal(lost.status, 200, lost.text);
  assert.equal(lost.json.sticks.find((s: { id: string }) => s.id === one.id).lost, true);
  const after = await ask(admin.port, 'GET', '/api/nodes/others');
  assert.ok(!after.json.pcs.some((p: { id: string }) => p.id === it.id), 'its link is removed');
  const back = await ask(admin.port, 'POST', '/api/remotes', { action: 'add', url: `http://127.0.0.1:${node.door}`, adminKey: true });
  assert.equal(back.status, 400, back.text);
  assert.match(back.json.error, /marked lost/);
  assert.equal((await ask(admin.port, 'POST', '/api/usb', { action: 'stick-found', id: one.id })).status, 200);
  assert.equal((await ask(admin.port, 'POST', '/api/remotes', { action: 'add', url: `http://127.0.0.1:${node.door}`, adminKey: true })).status, 200);
});
