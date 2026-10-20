import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { entriesWhy, testStart, unpackedWhy, zipEntries } from '../src/newcopy.ts';

// Every folder made here is removed when the file ends.
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tomlin-newcopy-'));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

/**
 * A zip made by hand, entries stored as they are: `link` marks one a symlink (as a Unix zip tool writes it), `claim`
 * is the size its listing gives (a false one, as a zip bomb's).
 */
function zipOf(entries: { name: string; data?: string; link?: boolean; claim?: number }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(e.claim ?? data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.link ? 0o120777 : e.name.endsWith('/') ? 0o40755 : 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(off, 42);
    parts.push(local, name, data);
    central.push(c, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const listed = async (entries: Parameters<typeof zipOf>[0]) => {
  const f = join(tmp(), 'z.zip');
  writeFileSync(f, zipOf(entries));
  return zipEntries(f);
};

test('a zip is listed from its own directory before anything is opened: names, sizes, links', async () => {
  const l = await listed([{ name: 'tomlin-2.0.56/' }, { name: 'tomlin-2.0.56/package.json', data: '{}' }, { name: 'tomlin-2.0.56/x', data: 'a', link: true }]);
  assert.deepEqual(l.map(e => [e.name, e.size, e.link]), [['tomlin-2.0.56/', 0, false], ['tomlin-2.0.56/package.json', 2, false], ['tomlin-2.0.56/x', 1, true]]);
  const bad = join(tmp(), 'not.zip');
  writeFileSync(bad, 'this is not a zip at all');
  await assert.rejects(zipEntries(bad), /not a zip/);
  // A zip from Windows' own tar (as npm run pack makes them) reads the same way.
  if (process.platform === 'win32') {
    const d = tmp();
    mkdirSync(join(d, 'tomlin-2.0.56', 'src'), { recursive: true });
    writeFileSync(join(d, 'tomlin-2.0.56', 'src', 'a.ts'), 'x'.repeat(1000));
    const zip = join(d, 'made.zip');
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', d, 'tomlin-2.0.56']);
    const made = await zipEntries(zip);
    assert.deepEqual(made.filter(e => !e.name.endsWith('/')).map(e => [e.name, e.size, e.link]), [['tomlin-2.0.56/src/a.ts', 1000, false]]);
  }
});

test('a zip with a link, a climbing name, too many files or too much in it is refused before it is opened', async () => {
  const ok = [{ name: 'tomlin-2.0.56/package.json', data: '{}' }, { name: 'tomlin-2.0.56/src/a.ts', data: 'abc' }];
  assert.equal(entriesWhy(await listed(ok)), '');
  assert.match(entriesWhy(await listed([...ok, { name: 'tomlin-2.0.56/up', data: '../../x', link: true }])), /link/);
  assert.match(entriesWhy(await listed([...ok, { name: '../evil.cmd', data: 'x' }])), /outside its folder/);
  assert.match(entriesWhy(await listed([...ok, { name: 'C:/Windows/evil.cmd', data: 'x' }])), /outside its folder/);
  assert.match(entriesWhy(await listed([...ok, { name: '/evil.cmd', data: 'x' }])), /outside its folder/);
  assert.match(entriesWhy(await listed(ok), { entries: 1 }), /more files than a TOMLIN/);
  // The size its own listing gives is added up (a false one is caught after opening, by unpackedWhy).
  assert.match(entriesWhy(await listed([...ok, { name: 'tomlin-2.0.56/big', data: 'x', claim: 4_000_000_000 }]), { bytes: 1_000_000 }), /would unpack to/);
});

test('what was opened is walked again: a link, a data folder of its own, or more than it said is refused', async () => {
  const d = tmp();
  const app = join(d, 'tomlin-2.0.56');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'src', 'a.ts'), 'x'.repeat(100));
  assert.equal(await unpackedWhy(d, app), '');
  assert.match(await unpackedWhy(d, app, { bytes: 50 }), /unpacked to more/);
  assert.match(await unpackedWhy(d, app, { entries: 1 }), /more files/);
  // A data folder would be offered as chats to import (Import your chats?), so a zip never brings one.
  mkdirSync(join(app, 'data'));
  assert.match(await unpackedWhy(d, app), /data folder of its own/);
  rmSync(join(app, 'data'), { recursive: true });
  // A junction (Windows makes one without asking for administrator) points outside: refused. It points at a folder of
  // this test's own, so nothing outside the test is ever reached through it.
  symlinkSync(tmp(), join(app, 'src', 'out'), 'junction');
  assert.match(await unpackedWhy(d, app), /link/);
});

/** A made-up new copy: src/server.ts as given, started the way the real one is. */
function fakeCopy(server: string): string {
  const dir = join(tmp(), 'tomlin-new');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'server.ts'), server);
  return dir;
}
const answering = (version: string) => `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync('seen.json', JSON.stringify({ pid: process.pid, home: e.TOMLIN_HOME, test: e.TOMLIN_TEST_START, loop: e.TOMLIN_LOOP ?? null, open: e.TOMLIN_OPEN ?? null, bridge: Object.keys(e).filter(k => k.startsWith('BRIDGE_')) }));
createServer((req, res) => {
  res.writeHead(req.url === '/api/status' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ version: '${version}', panes: { chat: {}, image: {} } }));
}).listen(Number(e.TOMLIN_PORT), '127.0.0.1');
`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the new copy is started once as a test, in a home of its own, and ended: it must answer as the version it is', async () => {
  const before = { TOMLIN_LOOP: process.env.TOMLIN_LOOP, TOMLIN_OPEN: process.env.TOMLIN_OPEN, BRIDGE_ROOT: process.env.BRIDGE_ROOT };
  Object.assign(process.env, { TOMLIN_LOOP: '1', TOMLIN_OPEN: '1', BRIDGE_ROOT: 'C:\\somewhere' });
  try {
    const dir = fakeCopy(answering('2.0.56'));
    assert.equal(await testStart(dir, '2.0.56', { ms: 20_000 }), '');
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    // A test start: no launcher loop to restart into, no window opened, none of the running copy's Bridge settings.
    assert.equal(seen.test, '1');
    assert.equal(seen.loop, null);
    assert.equal(seen.open, null);
    assert.deepEqual(seen.bridge, []);
    assert.ok(seen.home.startsWith(tmpdir()), seen.home);
    assert.equal(existsSync(seen.home), false, 'its home is removed afterwards');
    assert.equal(alive(seen.pid), false, 'and it is ended');
    assert.match(await testStart(fakeCopy(answering('2.0.55')), '2.0.56', { ms: 20_000 }), /says it is 2\.0\.55, not 2\.0\.56/);
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('a new copy that stops at once, or never answers, fails its test start and is ended', async () => {
  assert.match(await testStart(fakeCopy("console.error('Cannot find module sharp'); process.exit(1);"), '2.0.56', { ms: 20_000 }), /stopped as soon as it started \(Cannot find module sharp\)/);
  const dir = fakeCopy("import { writeFileSync } from 'node:fs'; writeFileSync('seen.json', JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000);");
  assert.match(await testStart(dir, '2.0.56', { ms: 2000 }), /did not answer within 2 seconds/);
  assert.equal(alive(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')).pid), false);
});

test('a new copy whose own Node.js will not run fails its test start (said, not thrown) and leaves no home behind', async () => {
  const dir = fakeCopy(answering('2.0.56'));
  mkdirSync(join(dir, 'runtime', 'node'), { recursive: true });
  writeFileSync(join(dir, 'runtime', 'node', 'node.exe'), 'not a program');
  const homes = () => readdirSync(tmpdir()).filter(n => n.startsWith('tomlin-test-start-')).length;
  const before = homes();
  assert.match(await testStart(dir, '2.0.56', { ms: 5000 }), /its Node\.js \(runtime\\node\\node\.exe\) would not run|stopped as soon as it started/);
  assert.equal(homes(), before);
});
