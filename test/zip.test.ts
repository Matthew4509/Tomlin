// The zip writer and its read-back check (src/zip.ts): every file kept whatever its name, Windows' tar reads what it
// writes, zip64 past 65,535 entries, and the check catches a changed byte, a zip cut short, a header that disagrees
// (its CRC, its name, its zip64 sizes) and a file that unpacks to more than it lists; a write fault leaves no file open.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import zlib from 'node:zlib';
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

test('the check compares the name in each entry\'s own header with the zip\'s list (Windows tar unpacks by that name), folders too', async () => {
  const top = tmp();
  put(join(top, 'Theta', 'report.txt'), 'hello\n');
  const z = join(top, 'theta.zip');
  const made = await writeZip(z, [{ name: 'Theta/', dir: true }, { name: 'Theta/report.txt', abs: join(top, 'Theta', 'report.txt'), size: 6 }]);
  for (const e of await listZip(z)) {
    const bad = readFileSync(z);
    bad[e.offset + 30 + Buffer.byteLength(e.name) - 2] ^= 0x01; // a letter near the end of its name
    writeFileSync(join(top, 'theta-bad.zip'), bad);
    const r = await checkZip(join(top, 'theta-bad.zip'), made.entries);
    assert.equal(r.ok, false, e.name);
    assert.match(r.ok ? '' : r.fault, /its own header in the zip disagrees with the zip's list/, e.name);
  }
});

/** A zip that says its one file is `claims` bytes but unpacks to `real` zeros (not one TOMLIN wrote). */
function craftedZip(file: string, claims: number, real: number) {
  const zeros = Buffer.alloc(1 << 20);
  const parts: Buffer[] = [];
  for (let n = 0; n < real; n += zeros.length) parts.push(zeros);
  const body = zlib.deflateRawSync(Buffer.concat(parts));
  const nm = Buffer.from('bomb.bin');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(claims, 22); lh.writeUInt16LE(nm.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(claims, 24); ch.writeUInt16LE(nm.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(30 + nm.length + body.length, 16);
  writeFileSync(file, Buffer.concat([lh, nm, body, ch, nm, end]));
}

test('a zip whose file unpacks to far more than it lists is stopped at the listed size, not unpacked into memory', async () => {
  const top = tmp();
  // Read whole (a small listed size), then streamed (a listed size of 16 MB and over).
  for (const [claims, real] of [[1024, 256 << 20], [17 << 20, 64 << 20]]) {
    const z = join(top, `bomb-${claims}.zip`);
    craftedZip(z, claims, real);
    const before = process.memoryUsage().rss;
    const r = await checkZip(z);
    const grew = process.memoryUsage().rss - before;
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.fault, new RegExp(`bomb\\.bin unpacks to more than the ${claims} bytes the zip lists`));
    assert.ok(grew < 128 << 20, `memory grew ${Math.round(grew / 1048576)} MB`);
  }
});

test('zip64 sizes in an entry\'s own header (files of 4 GB and over) are compared with the list too', async () => {
  // Listed at 4 GB, so it gets a zip64 header; the file itself is small, so the test stays quick.
  const top = tmp();
  const f = join(top, 'z64.bin');
  put(f, 'zip64 header\n'.repeat(200));
  const z = join(top, 'iota.zip');
  const made = await writeZip(z, [{ name: 'z64.bin', abs: f, size: 0xFFFF0000 }]);
  const ok = await checkZip(z, made.entries);
  assert.equal(ok.ok, true, ok.ok ? '' : ok.fault);
  const out = join(top, 'out');
  mkdirSync(out);
  execFileSync(tar, ['-x', '-f', z, '-C', out]);
  assert.ok(readFileSync(join(out, 'z64.bin')).equals(readFileSync(f)), 'Windows tar unpacks it whole');
  const e = (await listZip(z))[0];
  for (const at of [4, 12]) { // its size, then its compressed size, in the zip64 extra
    const bad = readFileSync(z);
    bad[e.offset + 30 + Buffer.byteLength(e.name) + at] ^= 0x01;
    writeFileSync(join(top, 'iota-bad.zip'), bad);
    const r = await checkZip(join(top, 'iota-bad.zip'), made.entries);
    assert.equal(r.ok, false, `byte ${at}`);
    assert.match(r.ok ? '' : r.fault, /its own header in the zip disagrees with the zip's list/);
  }
});

test('a fault writing a big file\'s header to the zip does not leave the file being zipped open', async () => {
  const top = tmp();
  const pad = join(top, 'pad.zip'); // stored; leaves just under 1 MB gathered, so the big file's header flushes it
  const big = join(top, 'big.bin');
  put(pad, randomBytes((1 << 20) - 50));
  put(big, randomBytes(5 << 20));
  const z = join(top, 'kappa.zip');
  const realOpen = fsp.open;
  const realRead = fs.createReadStream;
  let src: fs.ReadStream | null = null;
  fs.createReadStream = ((p: fs.PathLike, o?: object) => { const s = realRead(p, o as never); if (p === big) src = s; return s; }) as typeof fs.createReadStream;
  fsp.open = (async (f: fs.PathLike, ...a: unknown[]) => {
    const fh = await (realOpen as (...x: unknown[]) => Promise<fsp.FileHandle>)(f, ...a);
    if (f === z) fh.write = (() => Promise.reject(Object.assign(new Error('the drive went away'), { code: 'EIO' }))) as never;
    return fh;
  }) as typeof fsp.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeZip(z, [pad, big].map(p => ({ name: basename(p), abs: p, size: statSync(p).size }))), { code: 'EIO' });
  } finally {
    fsp.open = realOpen; fs.createReadStream = realRead;
    syncBuiltinESMExports();
  }
  assert.ok(src, 'the big file was opened');
  assert.ok((src as fs.ReadStream).destroyed, 'and closed again');
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
