import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import * as keep from '../src/keep.ts';

// A restore point kept on another PC (Back up to a linked PC): that PC never holds this PC's keys to the other linked
// PCs, its sharing code or its PIN; what comes back is checked against what was sent; and no restore opens a zip with
// a link or a name that climbs out.

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

async function put(file: string, text: string) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}
const SETTINGS = { managerName: 'Ann', webSearch: { provider: 'brave', key: 'BSA-paid-key-1234' }, remotes: [{ id: 'p1', name: 'Laptop', url: 'http://192.168.1.20:8741', token: 't'.repeat(64), key: 'K1' }, { id: 'p2', name: 'Box', url: 'http://192.168.1.30:8741', token: 'u'.repeat(64) }] };
async function home() {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-elsewhere-'));
  made.push(top);
  const h = keep.resolveHome({ TOMLIN_HOME: join(top, 'TOMLIN') });
  await put(join(h.data, 'settings.json'), JSON.stringify(SETTINGS));
  await put(join(h.data, 'share.json'), '{"code":"SECRET-CODE","pin":"hash","paired":["x"]}');
  await put(join(h.data, 'app-lock.json'), '{"hash":"PIN-HASH"}');
  await put(join(h.data, 'chats', 'c1.json'), '["hello"]');
  await put(join(h.data, 'bridge', 'settings.json'), '{"workingFolders":["C:\\\\w"]}');
  await put(join(h.data, 'bridge', 'hosting', 'connections.json'), '{"secret":1}');
  await put(join(h.data, 'runners.json'), '[]');
  return h;
}
const listing = (zip: string) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-t', '-f', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map(n => n.replace(/^\.\//, ''));
const inZip = (zip: string, name: string) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-x', '-O', '-f', zip, name], { encoding: 'utf8' });

test('a restore point for another PC leaves out the link keys, the sharing code and the PIN; one kept here has them', async () => {
  const h = await home();
  const away = await keep.backup(h, 'kept on Laptop', { forOtherPc: true });
  const names = listing(join(h.backups, away));
  for (const want of ['chats/c1.json', 'bridge/settings.json', 'settings.json', keep.ELSEWHERE_MARK]) assert.ok(names.includes(want), `${want} in ${names.join(', ')}`);
  for (const never of ['share.json', 'app-lock.json', 'runners.json', 'bridge/hosting/connections.json']) assert.ok(!names.includes(never), never);
  const s = JSON.parse(inZip(join(h.backups, away), 'settings.json'));
  assert.equal(s.managerName, 'Ann');
  assert.deepEqual(s.remotes.map((r: Record<string, unknown>) => [r.id, r.token, 'key' in r]), [['p1', '', false], ['p2', '', false]]);
  // The web search key (a paid Brave key) stays here too; the choice of engine goes.
  assert.deepEqual(s.webSearch, { provider: 'brave' });
  assert.ok(!inZip(join(h.backups, away), 'settings.json').includes('BSA-paid-key'));
  // The data itself is not touched.
  assert.equal(JSON.parse(await readFile(join(h.data, 'settings.json'), 'utf8')).remotes[0].token, 't'.repeat(64));
  await new Promise(r => setTimeout(r, 1100));
  const here = await keep.backup(h, 'by hand');
  assert.ok(listing(join(h.backups, here)).includes('share.json'));
});

test('putting one back keeps this PC\'s own keys, sharing and PIN, and brings back the rest', async () => {
  const h = await home();
  const away = await keep.backup(h, 'kept on Laptop', { forOtherPc: true });
  // Later: a chat changed, the PIN changed, a link key changed.
  await put(join(h.data, 'chats', 'c1.json'), '["changed"]');
  await put(join(h.data, 'app-lock.json'), '{"hash":"NEW-PIN"}');
  await put(join(h.data, 'settings.json'), JSON.stringify({ ...SETTINGS, webSearch: { provider: 'brave', key: 'BSA-new-key-5678' }, remotes: [{ ...SETTINGS.remotes[0], token: 'n'.repeat(64), key: 'K2' }] }));
  const note = await keep.restore(h, away, '2.0.55');
  assert.match(note, /Restored the backup/);
  assert.match(note, /kept on another PC/);
  assert.equal(await readFile(join(h.data, 'chats', 'c1.json'), 'utf8'), '["hello"]');
  assert.equal(await readFile(join(h.data, 'app-lock.json'), 'utf8'), '{"hash":"NEW-PIN"}');
  assert.match(await readFile(join(h.data, 'share.json'), 'utf8'), /SECRET-CODE/);
  const s = JSON.parse(await readFile(join(h.data, 'settings.json'), 'utf8'));
  // p1 takes this PC's key as it is now; p2 is no longer linked here, so it comes back without one (link it again).
  assert.deepEqual(s.remotes.map((r: Record<string, unknown>) => [r.id, r.token, r.key ?? null]), [['p1', 'n'.repeat(64), 'K2'], ['p2', '', null]]);
  assert.ok(!(await readFile(join(h.data, 'settings.json'), 'utf8')).includes('u'.repeat(64)));
  // This PC's web search key as it is now.
  assert.deepEqual(s.webSearch, { provider: 'brave', key: 'BSA-new-key-5678' });
  await assert.rejects(readFile(join(h.data, keep.ELSEWHERE_MARK)));
});

test('what comes back is checked against what was sent', async () => {
  const h = await home();
  const name = await keep.backup(h, 'kept on Laptop', { forOtherPc: true });
  const zip = join(h.backups, name);
  await keep.recordSent(h.backups, name, zip);
  assert.equal(await keep.broughtBackWhy(h.backups, name, zip), '');
  await writeFile(zip, Buffer.concat([await readFile(zip), Buffer.from('x')]));
  assert.match(await keep.broughtBackWhy(h.backups, name, zip), /not the one this PC sent/);
  // Sent before this check existed, or the record went with the PC's data: said, not refused.
  assert.equal(await keep.broughtBackWhy(h.backups, 'never sent.zip', zip), 'unchecked');
});

/** A zip made by hand with one entry (`link`: marked a symlink, as a Unix zip tool writes it). */
function oneEntryZip(name: string, link = false): Buffer {
  const data = Buffer.from('x');
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(1, 18);
  local.writeUInt32LE(1, 22);
  local.writeUInt16LE(n.length, 26);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(0x031e, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt32LE(crc32(data), 16);
  c.writeUInt32LE(1, 20);
  c.writeUInt32LE(1, 24);
  c.writeUInt16LE(n.length, 28);
  c.writeUInt32LE(((link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + 1, 16);
  return Buffer.concat([local, n, data, c, n, end]);
}

test('no restore opens a zip with a link or a name that climbs out; the data stays as it was', async () => {
  const h = await home();
  for (const [name, link] of [['../../evil.cmd', false], ['chats/out', true]] as const) {
    await put(join(h.backups, 'bad.zip'), '');
    await writeFile(join(h.backups, 'bad.zip'), oneEntryZip(name, link));
    assert.match(await keep.restore(h, 'bad.zip', '2.0.55'), /^Nothing was restored: /);
    assert.equal(await readFile(join(h.data, 'chats', 'c1.json'), 'utf8'), '["hello"]');
  }
  await rm(join(h.backups, 'bad.zip'), { force: true });
});
