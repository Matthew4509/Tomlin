// Bootable USB: the admin key, the stick's config laid over share.json, the hardware kinds, the boot menus and Mint.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as adminkey from '../src/adminkey.ts';
import * as usbnode from '../src/usbnode.ts';
import * as usbadmin from '../src/usbadmin.ts';
import { inspect, mintStick, removeFromStick, readPins, wanted, leftOff, stickConfig, fetchPin, unpackNpm } from '../src/usbmint.ts';
import { DEFAULT_SHARE } from '../src/share.ts';
import { HOOK_URL, patchGrub, patched } from '../src/usbmenu.ts';
import * as link from '../src/link.ts';

const ADMIN = adminkey.newAdminKey();
const ONE = adminkey.newStick();
const NODE = { id: '0badf00d', name: 'USB node' };
const TOKEN = 'ab'.repeat(32);
/** A request or an answer through JSON, as it crosses the network. */
const wire = <T>(x: T): Record<string, unknown> => JSON.parse(JSON.stringify(x));

test('an admin key is an Ed25519 pair; every stick gets an identity of its own; the tag names the admin, never a secret', () => {
  assert.match(ADMIN.pub, /^[\w-]{43}$/);
  assert.deepEqual(adminkey.cleanPair(ADMIN), ADMIN);
  assert.equal(adminkey.cleanPair({ pub: ADMIN.pub, priv: adminkey.newAdminKey().priv }), null, 'halves that do not belong together');
  assert.equal(adminkey.cleanPair('ABCD-EFGH-JKMN-PQRS'), null, 'a shared key from before is not one');
  const two = adminkey.newStick();
  assert.notEqual(ONE.id, two.id);
  assert.notEqual(ONE.pub, two.pub);
  assert.match(ONE.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(adminkey.cleanIdentity(ONE), ONE);
  assert.match(adminkey.keyTag(ADMIN.pub), /^[0-9a-f]{8}$/);
  assert.notEqual(adminkey.keyTag(ADMIN.pub), adminkey.keyTag(adminkey.newAdminKey().pub));
  const sig = adminkey.signWith(ADMIN.priv, 'words');
  assert.equal(adminkey.signedBy(ADMIN.pub, 'words', sig), true);
  assert.equal(adminkey.signedBy(ADMIN.pub, 'other words', sig), false);
  assert.equal(adminkey.signedBy(two.pub, 'words', sig), false);
});

test('a stick node links only to its admin, and the admin only to a stick on its list', () => {
  const { ask, priv } = link.adminHostAsk(ADMIN, 'abcd1234', 'Admin PC');
  const got = link.adminNodeAnswer(ADMIN.pub, ONE, wire(ask), NODE, TOKEN);
  assert.ok(got, 'the node answers its own admin');
  const done = link.adminHostFinish(ADMIN.pub, id => (id === ONE.id ? ONE.pub : ''), ask, priv, wire(got!.answer));
  assert.equal(done.id, NODE.id);
  assert.equal(done.stick, ONE.id);
  assert.equal(done.token, TOKEN);
  assert.deepEqual(done.keys, got!.keys, 'both ends hold the same link keys');

  // Another admin (someone holding the stick, or a copy of it, has no admin private key): refused.
  const thief = adminkey.newAdminKey();
  assert.equal(link.adminNodeAnswer(ADMIN.pub, ONE, wire(link.adminHostAsk(thief, 'abcd1234', 'Admin PC').ask), NODE, TOKEN), null);
  // A request changed on the way, or recorded and sent too late: refused.
  assert.equal(link.adminNodeAnswer(ADMIN.pub, ONE, { ...wire(ask), name: 'Someone else' }, NODE, TOKEN), null);
  assert.equal(link.adminNodeAnswer(ADMIN.pub, ONE, wire(ask), NODE, TOKEN, Date.now() + link.LINK_WINDOW_MS + 60_000), null);

  // The admin refuses a stick not on its list (or marked lost), and one that cannot sign as the stick it names.
  assert.throws(() => link.adminHostFinish(ADMIN.pub, () => '', ask, priv, wire(got!.answer)), /not a stick on this PC's list/);
  const pretender = adminkey.newStick();
  const fake = link.adminNodeAnswer(ADMIN.pub, { id: ONE.id, priv: pretender.priv }, wire(ask), NODE, TOKEN)!;
  assert.throws(() => link.adminHostFinish(ADMIN.pub, id => (id === ONE.id ? ONE.pub : ''), ask, priv, wire(fake.answer)), /not signed by the stick it names/);
});

test('the admin\'s list: a lost stick may not link, a found one may again; a record that is not whole is dropped', () => {
  const r = usbadmin.cleanRecords({ key: ADMIN, made: 'x', sticks: [{ id: ONE.id, pub: ONE.pub, at: 'a', drive: 'E:\\', name: 'Box' }, { id: 'nope', pub: ONE.pub }], kinds: [] });
  assert.equal(r.sticks.length, 1);
  assert.equal(usbadmin.stickPubOf(r, ONE.id), ONE.pub);
  const lost = usbadmin.withStick(r, ONE.id, { lost: true });
  assert.equal(usbadmin.stickPubOf(lost, ONE.id), '');
  assert.equal(usbadmin.stickPubOf(usbadmin.withStick(lost, ONE.id, { lost: false }), ONE.id), ONE.pub);
  assert.equal(usbadmin.cleanRecords({ key: 'ABCD-EFGH-JKMN-PQRS' }).key, null, 'a shared key from 2.1.18 is not kept');
});

const STICK = { v: 2, adminPub: ADMIN.pub, stick: ONE, admin: 'Desk PC', name: 'USB node', allow: usbnode.STICK_ALLOW, plainLinks: true, port: 8741, minted: '2026-11-24T00:00:00.000Z', version: '2.1.18' };

test('a stick config is read safely: a wrong format, a shared key from before, or a broken identity is refused; odd text is cleaned', () => {
  assert.equal(usbnode.cleanStick({ ...STICK, v: 1 }), null);
  assert.equal(usbnode.cleanStick({ v: 1, adminKey: 'ABCD-EFGH-JKMN-PQRS', admin: 'Desk PC' }), null);
  assert.equal(usbnode.cleanStick({ ...STICK, adminPub: 'short' }), null);
  assert.equal(usbnode.cleanStick({ ...STICK, stick: { ...ONE, pub: adminkey.newStick().pub } }), null);
  const c = usbnode.cleanStick({ ...STICK, name: 'Box <script>', port: 80, allow: 'x' })!;
  assert.equal(c.adminPub, ADMIN.pub);
  assert.deepEqual(c.stick, ONE);
  assert.equal(c.name, 'Box script');
  assert.equal(c.port, 8741, 'a port under 1024 is not taken');
  assert.deepEqual(c.allow, usbnode.STICK_ALLOW);
});

test('readStick reads the file TOMLIN_USB_NODE names, and nothing without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usbcfg-'));
  const f = join(dir, 'tomlin-node.json');
  writeFileSync(f, `\uFEFF${JSON.stringify(STICK)}`);
  assert.equal(usbnode.readStick({}), null);
  assert.equal(usbnode.readStick({ TOMLIN_USB_NODE: f })?.admin, 'Desk PC');
  assert.equal(usbnode.readStick({ TOMLIN_USB_NODE: join(dir, 'none.json') }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('the stick turns node mode on with its admin; its name and ticks are set only the first time; a new admin drops the old one\'s links', () => {
  const stick = usbnode.cleanStick(STICK)!;
  const fresh = usbnode.applyStick({ ...DEFAULT_SHARE }, stick, true);
  assert.equal(fresh.on, true);
  assert.equal(fresh.usbNode, true);
  assert.equal(fresh.adminPub, ADMIN.pub);
  assert.equal(JSON.stringify(fresh).includes(ONE.priv), false, 'the stick\'s own private key is not copied into share.json');
  assert.equal(fresh.name, 'USB node');
  assert.equal(fresh.plainLinks, true);
  assert.equal(fresh.allow?.lend, true);
  // Later starts: what was changed since stays; node mode is turned back on; the admin's link stays.
  const links = [{ name: 'Admin PC', hash: 'h', at: 'now', byKey: true }, { name: 'Other host', hash: 'h2', at: 'now' }];
  const later = usbnode.applyStick({ ...fresh, on: false, name: 'Big box', plainLinks: false, paired: links }, stick, false);
  assert.equal(later.on, true);
  assert.equal(later.name, 'Big box');
  assert.equal(later.plainLinks, false);
  assert.equal(later.paired.length, 2);
  // Minted again by another admin: one admin per stick, so the old admin's link goes; a setup-code link stays.
  const other = usbnode.cleanStick({ ...STICK, adminPub: adminkey.newAdminKey().pub })!;
  const moved = usbnode.applyStick(later, other, false);
  assert.equal(moved.adminPub, other.adminPub);
  assert.deepEqual(moved.paired.map(x => x.name), ['Other host']);
  // A share.json from 2.1.18 with the old shared keys loses them.
  assert.equal('adminKeys' in usbnode.applyStick({ ...DEFAULT_SHARE, adminKeys: ['ABCDEFGHJKMNPQRS'] } as typeof DEFAULT_SHARE, stick, false), false);
});

test('hardware kinds: twins share a kind, the RAM is read to 4 GB, a better speed replaces the best, a slow twin is flagged', () => {
  const bigBox = { cpu: { name: 'Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz', sockets: 2 }, ramBytes: 255.9 * 2 ** 30, cards: [{ name: 'NVIDIA GeForce RTX 3060', vram: 12 * 2 ** 30 }] };
  const twin = { ...bigBox, ramBytes: 256.2 * 2 ** 30 };
  const k = usbadmin.hardwareKind(bigBox);
  assert.equal(k.label, 'Intel Xeon E5-2670 0 x2 · 256 GB · GeForce RTX 3060 12 GB');
  assert.equal(usbadmin.hardwareKind(twin).kind, k.kind);
  assert.notEqual(usbadmin.hardwareKind({ ...bigBox, cards: [] }).kind, k.kind);
  let r = usbadmin.cleanRecords({});
  r = usbadmin.noteBest(r, bigBox, 'qwen.gguf', { pc: 'aaaa1111', at: 't1', tps: 10, settings: { gpuLayers: 20 } }).records;
  const slower = usbadmin.noteBest(r, bigBox, 'qwen.gguf', { pc: 'aaaa1111', at: 't2', tps: 8, settings: { gpuLayers: 30 } });
  assert.equal(slower.better, false);
  const faster = usbadmin.noteBest(slower.records, twin, 'qwen.gguf', { pc: 'bbbb2222', at: 't3', tps: 12, settings: { gpuLayers: 40 } });
  assert.equal(faster.better, true);
  r = usbadmin.notePc(faster.records, 'cccc3333', twin);
  assert.deepEqual(r.kinds[0].pcs.sort(), ['aaaa1111', 'bbbb2222', 'cccc3333']);
  const b = usbadmin.bestFor(r, twin, 'qwen.gguf', 'cccc3333')!;
  assert.equal(b.twin, true);
  assert.equal(b.best.settings.gpuLayers, 40);
  assert.equal(usbadmin.twinSlow(12, 10), true);
  assert.equal(usbadmin.twinSlow(12, 11), false);
  // Kept and read back.
  assert.deepEqual(usbadmin.cleanRecords(JSON.parse(JSON.stringify(r))), r);
  // A PC whose hardware changed moves to its new kind.
  const moved = usbadmin.notePc(r, 'cccc3333', { ...bigBox, cards: [] });
  assert.ok(!moved.kinds.find(x => x.kind === k.kind)!.pcs.includes('cccc3333'));
});

const FIX = resolve(import.meta.dirname, 'fixtures', 'usb-debian-13.8.0');

/** A pretend Rufus stick: the live image's menus and a squashfs file. */
function fakeStick(): string {
  const root = mkdtempSync(join(tmpdir(), 'usbstick-'));
  cpSync(FIX, root, { recursive: true });
  mkdirSync(join(root, 'live'), { recursive: true });
  writeFileSync(join(root, 'live', 'filesystem.squashfs'), 'x');
  return root;
}

test('the GRUB menu gets a TOMLIN node entry first, with the hook and persistence on the USB only', () => {
  const grub = readFileSync(join(FIX, 'boot', 'grub', 'grub.cfg'), 'utf8');
  const once = patchGrub(grub);
  assert.ok(patched(once));
  assert.equal(patchGrub(once), once, 'minting again does not add a second block');
  assert.match(once, new RegExp(`live-config\\.hooks=${HOOK_URL.replace(/[/.]/g, '\\$&')}`));
  assert.match(once, /persistence-media=removable-usb/);
  assert.match(once, /tomlin\.node=1/);
});

test('inspect says plainly when a drive is not a Debian live stick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notstick-'));
  const look = inspect(dir);
  assert.equal(look.live, false);
  assert.match(look.why, /not a Debian live stick/);
  rmSync(dir, { recursive: true, force: true });
});

test('Mint writes TOMLIN, the scripts in Linux line ends, the key and the menus; Remove puts the stick back', async () => {
  const root = fakeStick();
  const cache = mkdtempSync(join(tmpdir(), 'usbcache-'));
  const app = mkdtempSync(join(tmpdir(), 'usbapp-'));
  // A small app folder: src with a file, a Windows-only file that must stay off, the usbnode scripts and pins.
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'src', 'server.ts'), 'console.log(1)');
  mkdirSync(join(app, 'node_modules', '@img', 'sharp-win32-x64'), { recursive: true });
  writeFileSync(join(app, 'node_modules', '@img', 'sharp-win32-x64', 'x.node'), 'win');
  mkdirSync(join(app, 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'typescript', 'big.js'), 'tsc');
  writeFileSync(join(app, 'package.json'), '{"type":"module"}');
  cpSync(resolve(import.meta.dirname, '..', 'tools', 'usbnode'), join(app, 'tools', 'usbnode'), { recursive: true });
  writeFileSync(join(app, 'tools', 'usbnode', 'start.sh'), '#!/bin/sh\r\necho hi\r\n');
  for (const p of wanted(readPins(join(app, 'tools', 'usbnode')), false)) writeFileSync(join(cache, p.file), 'part');
  // Sizes are checked against the pins only when a part is already on the stick: a fresh stick copies all.
  const said: string[] = [];
  const stick = adminkey.newStick();
  await assert.rejects(mintStick(root, { adminPub: 'nope', stick, admin: 'Desk PC', version: '2.1.18', cache, app, trust: true }), /no admin key/);
  const unpacked: string[] = [];
  const unpack = async (tgz: string, dest: string) => {
    unpacked.push(tgz);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{}');
  };
  const lines = await mintStick(root, { adminPub: ADMIN.pub, stick, admin: 'Desk PC', version: '2.1.18', cache, app, trust: true, say: l => said.push(l), unpack });
  assert.deepEqual(lines, said);
  const t = join(root, 'tomlin');
  assert.ok(existsSync(join(t, 'app', 'src', 'server.ts')));
  // sharp's Linux build goes into node_modules, not into downloads.
  assert.equal(unpacked.length, 2);
  assert.ok(existsSync(join(t, 'app', 'node_modules', '@img', 'sharp-linux-x64', 'package.json')));
  assert.ok(existsSync(join(t, 'app', 'node_modules', '@img', 'sharp-libvips-linux-x64', 'package.json')));
  assert.ok(!existsSync(join(t, 'downloads', 'sharp-linux-x64-0.35.5.tgz')));
  assert.ok(existsSync(join(t, 'downloads', 'node-v24.22.3-linux-x64.tar.xz')));
  assert.ok(!existsSync(join(t, 'app', 'node_modules', '@img', 'sharp-win32-x64')), 'Windows picture parts stay off');
  assert.ok(!existsSync(join(t, 'app', 'node_modules', 'typescript')), 'the type check stays off');
  assert.equal(readFileSync(join(t, 'stick', 'start.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  const cfg = usbnode.cleanStick(JSON.parse(readFileSync(join(t, 'tomlin-node.json'), 'utf8')))!;
  assert.equal(cfg.adminPub, ADMIN.pub);
  assert.deepEqual(cfg.stick, stick);
  assert.equal(readFileSync(join(t, 'tomlin-node.json'), 'utf8').includes(ADMIN.priv), false, 'the admin\'s private key is never on a stick');
  assert.equal(cfg.admin, 'Desk PC');
  assert.ok(existsSync(join(t, 'hook.sh')));
  assert.ok(patched(readFileSync(join(root, 'boot', 'grub', 'grub.cfg'), 'utf8')));
  assert.ok(existsSync(join(root, 'boot', 'grub', 'grub.cfg.tomlin-orig')));
  const look = inspect(root);
  assert.equal(look.minted, true);
  assert.equal(look.tag, adminkey.keyTag(ADMIN.pub));
  // Remove: the menus as they were, the folder gone.
  const orig = readFileSync(join(FIX, 'boot', 'grub', 'grub.cfg'), 'utf8');
  removeFromStick(root);
  assert.equal(readFileSync(join(root, 'boot', 'grub', 'grub.cfg'), 'utf8'), orig);
  assert.ok(!existsSync(t));
  assert.throws(() => removeFromStick(root), /was not minted/);
  for (const d of [root, cache, app]) rmSync(d, { recursive: true, force: true });
});

test('Mint refuses before writing: parts not downloaded, a model over 4 GB', async () => {
  const root = fakeStick();
  const cache = mkdtempSync(join(tmpdir(), 'usbcache-'));
  await assert.rejects(mintStick(root, { adminPub: ADMIN.pub, stick: adminkey.newStick(), admin: 'Desk PC', version: '2.1.18', cache, trust: true }), /Not downloaded yet/);
  assert.ok(!existsSync(join(root, 'tomlin')));
  for (const d of [root, cache]) rmSync(d, { recursive: true, force: true });
});

test('the stick leaves off Windows-only and build-only parts, and keeps the Linux ones', () => {
  for (const p of ['\\node_modules\\@img\\sharp-win32-x64\\lib\\a.node', '\\node_modules\\typescript\\lib\\tsc.js', '\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\a.dll', '\\src\\partner.ts', '\\build.zip']) assert.ok(leftOff(p), p);
  // Every part of the build id goes whole, so the node's build is this PC's.
  for (const p of ['\\node_modules\\@img\\sharp-linux-x64\\lib\\a.node', '\\node_modules\\onnxruntime-node\\bin\\napi-v6\\linux\\x64\\a.so', '\\src\\server.ts', '\\tools\\usbnode\\start.sh', '\\tools\\tray.cs', '\\package-lock.json']) assert.ok(!leftOff(p), p);
});

test('the stick config names the admin; Mint without a key refuses', () => {
  const c = stickConfig({ adminPub: ADMIN.pub, stick: ONE, admin: 'Desk PC', version: '2.1.18', cache: '' });
  assert.equal(c.v, 2);
  assert.throws(() => stickConfig({ adminPub: '', stick: ONE, admin: 'Desk PC', version: '2.1.18', cache: '' }), /no admin key/);
});

test('a download is checked by SHA-256: a wrong file is deleted, a right one kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usbfetch-'));
  const body = Buffer.from('hello stick');
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(body).digest('hex');
  const fetcher = (async () => new Response(body)) as unknown as typeof fetch;
  const pin = { file: 'a.bin', url: 'https://example.invalid/a.bin', bytes: body.length, sha256: sha };
  const got = await fetchPin(pin, dir, { fetcher });
  assert.equal(readFileSync(got, 'utf8'), 'hello stick');
  await assert.rejects(fetchPin({ ...pin, file: 'b.bin', sha256: '0'.repeat(64) }, dir, { fetcher }), /not the pinned one/);
  assert.ok(!existsSync(join(dir, 'b.bin')) && !existsSync(join(dir, 'b.bin.part')));
  // Already there and right: not downloaded again.
  const never = (async () => { throw new Error('fetched again'); }) as unknown as typeof fetch;
  await fetchPin(pin, dir, { fetcher: never });
  rmSync(dir, { recursive: true, force: true });
});

test('an npm part is unpacked with its package folder laid flat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usbnpm-'));
  mkdirSync(join(dir, 'src', 'package', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'src', 'package', 'package.json'), '{"name":"x"}');
  writeFileSync(join(dir, 'src', 'package', 'lib', 'a.node'), 'bin');
  const { execFileSync } = await import('node:child_process');
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-czf', join(dir, 'x.tgz'), '-C', join(dir, 'src'), 'package']);
  await unpackNpm(join(dir, 'x.tgz'), join(dir, 'out', '@img', 'x'));
  assert.equal(readFileSync(join(dir, 'out', '@img', 'x', 'lib', 'a.node'), 'utf8'), 'bin');
  rmSync(dir, { recursive: true, force: true });
});

test('Linux: the real cores and sockets from /proc/cpuinfo, the cards from /sys/class/drm', async () => {
  const { linuxCpu, linuxCim, gpusFrom } = await import('../src/hardware.ts');
  // Two sockets of 2 cores with hyper-threading: 8 threads, 4 cores, 2 sockets.
  const block = (phys: number, core: number) => `processor\t: x\nmodel name\t: Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz\nphysical id\t: ${phys}\ncore id\t\t: ${core}\n`;
  const info = [block(0, 0), block(0, 1), block(1, 0), block(1, 1), block(0, 0), block(0, 1), block(1, 0), block(1, 1)].join('\n');
  assert.deepEqual(linuxCpu(info), { cores: 4, sockets: 2 });
  assert.equal(linuxCpu('processor : 0\n'), null, 'a virtual machine without ids: the guess stands');
  const cim = linuxCim([{ vendor: '0x1002', vram: 8 * 2 ** 30 }, { vendor: '0x8086', vram: null }, { vendor: '0x10de', vram: null }]);
  const cards = gpusFrom(cim, [{ name: 'NVIDIA GeForce RTX 3060', total: 12 * 2 ** 30, used: 0, driver: '550.163.01' } as never], [86]);
  assert.deepEqual(cards.map(c => [c.vendor, c.total, c.integrated]), [['amd', 8 * 2 ** 30, false], ['intel', null, true], ['nvidia', 12 * 2 ** 30, false]]);
});

test('Linux: someone is there only when a console or SSH terminal was used lately; tty1 (the node screen) never counts', async () => {
  const { linuxPresence } = await import('../src/maxlend.ts');
  const now = Date.parse('2026-11-24T12:00:00Z');
  assert.equal(linuxPresence(() => [], () => 0, now).idleMs, 24 * 3_600_000);
  const p = linuxPresence(() => ['/dev/tty2', '/dev/pts/0'], f => (f === '/dev/pts/0' ? now - 60_000 : now - 3_600_000), now);
  assert.equal(p.idleMs, 60_000);
  assert.equal(p.locked, false);
  assert.equal(linuxPresence(() => ['/dev/tty3'], () => { throw new Error('gone'); }, now).idleMs, 24 * 3_600_000);
});

test('Linux: a runner finds its .so files in its own folder; Windows is left as it was', async () => {
  const { libDirEnv } = await import('../src/libdir.ts');
  assert.equal(libDirEnv('C:\r\llama-server.exe', undefined, 'win32'), undefined);
  assert.equal(libDirEnv('/opt/tomlin/app/runtime/llama-cpu/llama-server', { A: '1' }, 'linux')?.LD_LIBRARY_PATH, '/opt/tomlin/app/runtime/llama-cpu');
  assert.equal(libDirEnv('/r/llama-server', { LD_LIBRARY_PATH: '/x' }, 'linux')?.LD_LIBRARY_PATH, '/r:/x');
});

test('the node screen says where to reach it, whose it is and what to do next, in lines that fit 80 columns', async () => {
  const { screenText } = await import('../src/usbscreen.ts');
  const t = screenText({ name: 'Big box', version: '2.1.18', addresses: ['192.168.1.30:8741'], admin: 'Desk PC', tag: 'abcd1234', linked: [], models: [], lending: '', hardware: 'Intel Xeon E5-2670 x2 · 256 GB', fault: '', now: new Date() });
  assert.match(t, /192\.168\.1\.30:8741/);
  assert.match(t, /Admin:\s+Desk PC \(admin key tag abcd1234\)/);
  assert.match(t, /On Desk PC: Network, Add another PC/);
  for (const l of t.split('\n')) assert.ok(l.length <= 78, l);
  assert.match(screenText({ name: 'Big box', version: 'x', addresses: [], admin: 'Desk PC', tag: '', linked: ['Desk PC'], models: ['Qwen3'], lending: '', hardware: '', fault: 'Could not open port 8741', now: new Date() }), /Problem:\s+Could not open port/);
});

test('a hello\'s processor keeps the sockets a Linux node reads', async () => {
  const { cleanCpu } = await import('../src/nodecpu.ts');
  assert.deepEqual(cleanCpu({ name: 'Xeon', cores: 16, threads: 32, sockets: 2 }), { name: 'Xeon', cores: 16, threads: 32, sockets: 2 });
  assert.deepEqual(cleanCpu({ name: 'Xeon', cores: 16, threads: 32, sockets: 99 }), { name: 'Xeon', cores: 16, threads: 32 });
});

test('the stick\'s scripts and pins ship inside tools/, a folder every older TOMLIN takes in an update', async () => {
  const update = await import('../src/update.ts');
  assert.ok(!update.PARTS.includes('usbnode'), 'a new top folder would make a 2.1.17 node refuse the Fast update');
  assert.ok(update.PARTS.includes('tools'));
  for (const f of ['start.sh', 'hook.sh', 'tomlin-node.service', 'pins.json']) assert.ok(existsSync(resolve(import.meta.dirname, '..', 'tools', 'usbnode', f)), f);
  for (const f of ['tools/usbnode/start.sh', 'tools/usbnode/pins.json']) assert.ok(!update.SKIP.test(f), `${f} is sent with an update`);
});
