// The zip writer and its read-back check (src/zip.ts): every file kept whatever its name, Windows' tar reads what it
// writes, zip64 past 65,535 entries, and the check catches a changed byte, a zip cut short and a header that disagrees.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkZip, listFolder, listZip, writeZip, type ZipItem } from '../src/zip.ts';
import { zipEntries } from '../src/newcopy.ts';

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tomlin-zip-'));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const put = (file: string, body: string | Buffer) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
};
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** A made-up folder: names with é, ü and 日本, an empty folder, a big file (streamed) and an already-compressed one. */
function tree() {
  const top = tmp();
  const src = join(top, 'src');
  put(join(src, 'Résumé.pdf'), 'not really a pdf');
  put(join(src, 'naïve ü', '日本 é.txt'), 'konnichiwa');
  put(join(src, 'plain.txt'), 'plain words '.repeat(200));
  put(join(src, 'big.dat'), Buffer.alloc(5 * 1024 * 1024, 7));
  put(join(src, 'photo.png'), Buffer.alloc(3000, 1));
  mkdirSync(join(src, 'empty'), { recursive: true });
  return { top, src };
}

test('every file is kept, names with é, ü and 日本 too; its own reader, the update listing and Windows tar all see them', async () => {
  const { top, src } = tree();
  const { items, links } = await listFolder(src);
  assert.deepEqual(links, []);
  const z = join(top, 'a.zip');
  const made = await writeZip(z, items);
  assert.deepEqual(made.skipped, []);
  const names = (await listZip(z)).map(e => e.name).sort();
  assert.deepEqual(names, ['Résumé.pdf', 'big.dat', 'empty/', 'naïve ü/', 'naïve ü/日本 é.txt', 'photo.png', 'plain.txt'].sort());
  assert.deepEqual((await zipEntries(z)).map(e => e.name).sort(), names, 'the restore listing reads the same names');
  const r = await checkZip(z, made.entries);
  assert.equal(r.ok, true, r.ok ? '' : r.fault);
  assert.equal(r.ok && r.files, 5);
  // Unpacked by Windows' own tar (as Put back does), byte for byte.
  const out = join(top, 'out');
  mkdirSync(out);
  execFileSync(tar, ['-x', '-f', z, '-C', out]);
  assert.equal(readFileSync(join(out, 'naïve ü', '日本 é.txt'), 'utf8'), 'konnichiwa');
  assert.equal(readFileSync(join(out, 'Résumé.pdf'), 'utf8'), 'not really a pdf');
  assert.equal(readFileSync(join(out, 'big.dat')).length, 5 * 1024 * 1024);
  assert.deepEqual(readdirSync(join(out, 'empty')), []);
});

test('the check needs no list of its own: without one it checks every file against the zip\'s own list', async () => {
  const { top, src } = tree();
  const z = join(top, 'b.zip');
  await writeZip(z, (await listFolder(src)).items);
  const r = await checkZip(z);
  assert.equal(r.ok, true, r.ok ? '' : r.fault);
});

test('files given as bytes go in as they are, beside files read from the disk', async () => {
  const top = tmp();
  put(join(top, 'a.txt'), 'from the disk');
  const items: ZipItem[] = [
    { name: 'a.txt', abs: join(top, 'a.txt'), size: 13 },
    { name: 'settings.json', data: Buffer.from('{"made":"here"}') },
  ];
  const z = join(top, 'c.zip');
  const made = await writeZip(z, items);
  assert.equal((await checkZip(z, made.entries)).ok, true);
  const out = join(top, 'out');
  mkdirSync(out);
  execFileSync(tar, ['-x', '-f', z, '-C', out]);
  assert.equal(readFileSync(join(out, 'settings.json'), 'utf8'), '{"made":"here"}');
});

test('a file gone before it was read is listed as left out, not fatal', async () => {
  const top = tmp();
  put(join(top, 'here.txt'), 'here');
  const z = join(top, 'd.zip');
  const made = await writeZip(z, [
    { name: 'here.txt', abs: join(top, 'here.txt'), size: 4 },
    { name: 'gone.txt', abs: join(top, 'gone.txt'), size: 4 },
  ]);
  assert.deepEqual(made.skipped.map(s => s.name), ['gone.txt']);
  assert.match(made.skipped[0].why, /gone before it could be read/);
  assert.deepEqual((await listZip(z)).map(e => e.name), ['here.txt']);
});

test('zip64: more entries than plain zip holds (70,000) still lists and checks', async () => {
  const top = tmp();
  const items: ZipItem[] = [];
  for (let i = 0; i < 70_000; i++) items.push({ name: `d/${i}/`, dir: true });
  items.push({ name: 'last.txt', data: Buffer.from('end') });
  const z = join(top, 'many.zip');
  const made = await writeZip(z, items);
  assert.equal((await listZip(z)).length, 70_001);
  assert.equal((await zipEntries(z)).length >= 20_000, true, 'the restore listing reads past 65,535 too (it stops at its own limit)');
  assert.equal((await checkZip(z, made.entries)).ok, true);
});

test('the check catches one changed byte, a zip cut short, and a file header that disagrees with the zip\'s list', async () => {
  const { top, src } = tree();
  const z = join(top, 'e.zip');
  const made = await writeZip(z, (await listFolder(src)).items);
  const buf = readFileSync(z);
  const e = (await listZip(z)).find(x => x.name === 'plain.txt');
  assert.ok(e);
  const dataAt = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);

  const flipped = Buffer.from(buf);
  flipped[dataAt + Math.floor(e.csize / 2)] ^= 0xff;
  writeFileSync(join(top, 'flipped.zip'), flipped);
  const r1 = await checkZip(join(top, 'flipped.zip'), made.entries);
  assert.equal(r1.ok, false);
  assert.match(r1.ok ? '' : r1.fault, /plain\.txt/);

  writeFileSync(join(top, 'short.zip'), buf.subarray(0, Math.floor(buf.length * 0.6)));
  const r2 = await checkZip(join(top, 'short.zip'), made.entries);
  assert.equal(r2.ok, false);
  assert.match(r2.ok ? '' : r2.fault, /could not be read back/);

  // The CRC in the file's own header (what a streaming unzipper reads) changed, the zip's list left as it was.
  const header = Buffer.from(buf);
  header.writeUInt32LE(header.readUInt32LE(e.offset + 14) ^ 1, e.offset + 14);
  writeFileSync(join(top, 'header.zip'), header);
  const r3 = await checkZip(join(top, 'header.zip'), made.entries);
  assert.equal(r3.ok, false);
  assert.match(r3.ok ? '' : r3.fault, /plain\.txt.*own header/);
});

test('a zip Windows tar made (every data backup before this) passes the check: its file headers carry no sizes, by design', async () => {
  const top = tmp();
  put(join(top, 'src', 'a.txt'), 'hello');
  put(join(top, 'src', 'sub', 'z.bin'), Buffer.alloc(300_000));
  const z = join(top, 'tar.zip');
  execFileSync(tar, ['-a', '-c', '-f', z, '-C', join(top, 'src'), '.']);
  const r = await checkZip(z);
  assert.equal(r.ok, true, r.ok ? '' : r.fault);
  assert.equal(r.ok && r.files, 2);
});

test('listFolder leaves out what it is told to, and says which links it did not follow', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async () => {
  const top = tmp();
  put(join(top, 'keep', 'a.txt'), 'a');
  put(join(top, 'skip', 'b.txt'), 'b');
  put(join(top, 'x.tmp'), 'tmp');
  mkdirSync(join(top, 'target'));
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'mklink', '/J', join(top, 'jn'), join(top, 'target')], { stdio: 'ignore' });
  const { items, links } = await listFolder(top, (rel, dir) => (dir && rel === 'skip') || rel.endsWith('.tmp'));
  assert.deepEqual(items.map(i => i.name).sort(), ['keep/', 'keep/a.txt', 'target/']);
  assert.deepEqual(links, ['jn']);
});
