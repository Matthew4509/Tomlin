// Audit of installing, updating and running TOMLIN (27 Nov). Each test is named after its finding. Tests marked
// { todo: 'P1' } show a lesser fault that is still open; the rest are guards that hold today, or P0 faults that fail
// until fixed. Everything is made in a scratch folder under %LOCALAPPDATA%\Temp\tomlin-audit-install and removed after.
// Nothing here runs the installer, the setup program, pack, sign or a real runner, and nothing leaves 127.0.0.1.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { entriesWhy, uploadLeftovers, uploadPlaces, zipEntries } from '../src/newcopy.ts';
import { installRefusal, latestOf, signRelease, zipCheck } from '../src/release.ts';
import { zipWhy } from '../src/update.ts';
import { copiesToRemove, pruneOldCopies } from '../src/installer.ts';
import { takeHome, LOCK_FILE } from '../src/onecopy.ts';
import { fetchChecked } from '../src/download.ts';
import { Runtimes } from '../src/runtimes.ts';
import { inspect, removeFromStick } from '../src/usbmint.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'tomlin-audit-install');
mkdirSync(BASE, { recursive: true });
const made: string[] = [];
const tmp = (tag: string) => {
  const d = mkdtempSync(join(BASE, `${tag}-`));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};

/**
 * A zip made by hand. `cdName`/`cdSize`: what its listing (central directory) says, when it differs from the entry's
 * own header; `deflate`: compressed; `link`: marked a Unix symlink.
 */
function makeZip(entries: { name: string; data?: Buffer | string; deflate?: boolean; cdName?: string; cdSize?: number; link?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const comp = e.deflate ? deflateRawSync(raw) : raw;
    const ln = Buffer.from(e.name, 'utf8');
    const cn = Buffer.from(e.cdName ?? e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(ln.length, 26);
    locals.push(lh, ln, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.link ? 0x031e : 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.cdSize ?? raw.length, 24); ch.writeUInt16LE(cn.length, 28);
    if (e.link) ch.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    cds.push(ch, cn);
    off += 30 + ln.length + comp.length;
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(entries.length, 0xffff), 8); end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- Rule 1: only a zip signed with the release key, whole and unaltered ----

test('G-01: a zip with one byte changed after signing is refused', () => {
  const k = pair();
  const zip = makeZip([{ name: 'tomlin-9.0.0/package.json', data: '{"name":"tomlin","version":"9.0.0"}' }]);
  const sig = signRelease(k.pem, '9.0.0', sha(zip));
  assert.equal(zipCheck(sig, '9.0.0', sha(zip), k.pub).code, '');
  const bent = Buffer.from(zip);
  bent[40] ^= 1;
  assert.equal(zipCheck(sig, '9.0.0', sha(bent), k.pub).code, 'changed');
  // Cut short by one byte too.
  assert.equal(zipCheck(sig, '9.0.0', sha(zip.subarray(0, zip.length - 1)), k.pub).code, 'changed');
});

test('G-02: an older signed version replayed, or the same one again, is not taken', () => {
  // Signed and whole, but older than the copy that runs: refused by the version check, whatever its signature.
  assert.match(zipWhy({ name: 'tomlin', version: '2.1.31' }, [], 'a'.repeat(16), '2.1.32', 'b'.repeat(16)), /older than the 2\.1\.32/);
  assert.match(zipWhy({ name: 'tomlin', version: '2.1.32' }, [], 'b'.repeat(16), '2.1.32', 'b'.repeat(16)), /already runs/);
  // A signature lifted onto another version's zip does not pass.
  const k = pair();
  const sig = signRelease(k.pem, '2.1.31', 'ab'.repeat(32));
  assert.equal(zipCheck({ ...sig, version: '2.1.33' }, '2.1.33', 'ab'.repeat(32), k.pub).code, 'bad');
  assert.equal(zipCheck(sig, '2.1.33', 'ab'.repeat(32), k.pub).code, 'version');
});

test('G-03: a zip with a climbing name, a drive, a backslash or a link is refused from its listing', async () => {
  const d = tmp('g03');
  for (const [what, entries] of [
    ['climbing', [{ name: 'tomlin-9/../../evil.txt', data: 'x' }]],
    ['absolute', [{ name: '/evil.txt', data: 'x' }]],
    ['drive', [{ name: 'C:evil.txt', data: 'x' }]],
    ['backslash', [{ name: 'tomlin-9\\..\\evil.txt', data: 'x' }]],
    ['link', [{ name: 'tomlin-9/src', data: 'C:/Users', link: true }]],
  ] as const) {
    const f = join(d, `${what}.zip`);
    writeFileSync(f, makeZip(entries as never));
    assert.notEqual(entriesWhy(await zipEntries(f)), '', `${what} is refused`);
  }
});

test('G-04: an unsigned zip is never installed from a download, and a picked one only with Install anyway (and the PIN when locked)', async () => {
  const pinOk = async () => ({ ok: true as const });
  const pinBad = async () => ({ status: 403, error: 'wrong' });
  assert.equal((await installRefusal({ code: 'changed', source: 'git', anyway: true, lockOn: false, pin: undefined, pinCheck: pinOk }))?.status, 409);
  assert.equal((await installRefusal({ code: 'none', source: 'file', anyway: 'true', lockOn: false, pin: undefined, pinCheck: pinOk }))?.status, 409, 'only true itself counts as Install anyway');
  assert.equal(await installRefusal({ code: 'none', source: 'file', anyway: true, lockOn: false, pin: undefined, pinCheck: pinOk }), null);
  assert.equal((await installRefusal({ code: 'bad', source: 'file', anyway: true, lockOn: true, pin: '0000', pinCheck: pinBad }))?.needPin, true);
});

test('G-05: Check for updates follows only download addresses on its own host', () => {
  const r = (url: string) => ({ tag_name: 'v9.0.0', assets: [{ name: 'tomlin-9.0.0.zip', browser_download_url: url, size: 5 }, { name: 'tomlin-9.0.0.zip.sig', browser_download_url: 'https://github.com/o/n/releases/download/v9.0.0/tomlin-9.0.0.zip.sig' }] });
  assert.equal(typeof latestOf(r('https://github.com/o/n/releases/download/v9.0.0/tomlin-9.0.0.zip')), 'object');
  for (const bad of ['https://github.com.evil.example/x.zip', 'http://github.com/x.zip', 'https://evil.example/https://github.com/x.zip']) assert.equal(typeof latestOf(r(bad)), 'string', bad);
  // A stand-in base: another port on 127.0.0.1 is not the stand-in.
  assert.equal(typeof latestOf(r('http://127.0.0.1:9/x.zip'), 'http://127.0.0.1:99/'), 'string');
});

test('Z-01: a zip whose entries hold far more than its listing says is written out in full before it is refused', async () => {
  const d = tmp('z01');
  const f = join(d, 'bomb.zip');
  // 20 MB of zeros (about 20 KB packed) whose listing says 10 bytes.
  writeFileSync(f, makeZip([{ name: 'tomlin-9/big.bin', data: Buffer.alloc(20 * 2 ** 20), deflate: true, cdSize: 10 }]));
  const listed = await zipEntries(f);
  // What Update via zip does (src/server/selfupdate.ts openZip): the listing is checked against the limit...
  const why = entriesWhy(listed, { bytes: 2 ** 20 });
  // ...then Windows' tar opens it, and only the walk afterwards counts what was written.
  const out = join(d, 'out');
  mkdirSync(out);
  try { execFileSync(TAR, ['-x', '-f', f, '-C', out], { stdio: 'pipe' }); } catch { /* tar complains after writing */ }
  const written = existsSync(join(out, 'tomlin-9', 'big.bin')) ? statSync(join(out, 'tomlin-9', 'big.bin')).size : 0;
  // Expected: refused before anything is written past the limit. Actual: the listing passes and 20 MB are written.
  assert.ok(why !== '' || written <= 2 ** 20, `the listing passed (${JSON.stringify(why)}) and tar wrote ${written} bytes`);
});

test('Z-02: a zip of 25,000 empty entries is refused quickly from its listing', async () => {
  const d = tmp('z02');
  const f = join(d, 'many.zip');
  writeFileSync(f, makeZip(Array.from({ length: 25_000 }, (_, i) => ({ name: `tomlin-9/e${i}` }))));
  const t0 = Date.now();
  assert.match(entriesWhy(await zipEntries(f)), /more files than a TOMLIN/);
  assert.ok(Date.now() - t0 < 5000);
  // Empty and garbage files are "not a zip", not a crash.
  writeFileSync(join(d, 'empty.zip'), '');
  await assert.rejects(zipEntries(join(d, 'empty.zip')), /not a zip/);
  writeFileSync(join(d, 'junk.zip'), Buffer.alloc(70_000, 0x50));
  await assert.rejects(zipEntries(join(d, 'junk.zip')), /not a zip/);
});

test('SU-01: a zip with package.json at its top, started once as a test from where it was opened, does not delete itself', () => {
  // Update via zip opens the zip into .tomlin-upload beside this copy (src/server/selfupdate.ts); with package.json at
  // its top that folder is the new copy itself, and its test start (src/newcopy.ts testStart) runs from there. Every
  // start removes the upload an earlier run left beside it: here, its own folder and the zip, as it starts.
  const parent = tmp('su01');
  const { zip, staging } = uploadPlaces(parent);
  mkdirSync(join(staging, 'src'), { recursive: true });
  writeFileSync(join(staging, 'package.json'), '{"name":"tomlin","version":"9.0.0"}');
  writeFileSync(zip, 'zip');
  // The test start (TOMLIN_TEST_START) and a copy that runs from inside the upload folder never remove it.
  assert.deepEqual(uploadLeftovers(staging, { TOMLIN_TEST_START: '1' }), []);
  assert.deepEqual(uploadLeftovers(staging, {}), []);
  assert.deepEqual(uploadLeftovers(join(staging, 'tomlin-9.0.0'), {}), []);
  // An ordinary copy beside them still clears what an earlier run left.
  assert.deepEqual(uploadLeftovers(join(parent, 'tomlin-2.1.33'), {}).sort(), [staging, zip].sort());
});

// ---- Rules 2 and 5: an update never leaves the PC without a working copy; old copies go only when safe ----

/** A copy folder: whole (package.json, src/server.ts, tools/install.ts) or half (cut off part way: package.json only). */
function copyIn(root: string, name: string, whole: boolean) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tomlin', version: name.replace(/^tomlin-/, '').replace(/ \(\d+\)$/, '') }));
  if (whole) {
    writeFileSync(join(dir, 'src', 'server.ts'), '// server\n');
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'install.ts'), '// install\n');
  }
  return dir;
}

test('U-01: after an install cut off part way and run again, the old copies kept for going back are whole ones', async () => {
  const root = tmp('u01');
  copyIn(root, 'tomlin-2.1.31', true); // the copy that ran before: whole
  copyIn(root, 'tomlin-2.1.32', false); // an install of 2.1.32 killed while copying (package.json came first)
  copyIn(root, 'tomlin-2.1.32 (2)', true); // the same install run again: newFolder gave it " (2)"
  writeFileSync(join(root, 'current.txt'), 'tomlin-2.1.32 (2)');
  // The installer's own rule (tools/install.ts) and the one every start runs (followStarted) agree on what goes:
  const goes = copiesToRemove(readdirSync(root), 'tomlin-2.1.32 (2)');
  const gone = await pruneOldCopies(root, 'tomlin-2.1.32 (2)');
  // Expected: the half copy goes (or at least the whole 2.1.31 stays). Actual: the whole 2.1.31 goes, the half one stays.
  assert.ok(!goes.includes('tomlin-2.1.31'), `the installer removes ${goes.join(', ')}`);
  assert.ok(existsSync(join(root, 'tomlin-2.1.31', 'src', 'server.ts')), `every start removed ${gone.join(', ')}, keeping a copy that cannot start`);
});

test('U-02: setup never deletes an older copy that still holds models (they are used in place)', () => {
  // The start-time sweep (src/installer.ts pruneOldCopies) keeps such a copy; tools/install.ts removes old copies by name
  // alone (inst.copiesToRemove, then rm), so models kept in an older copy's models\ folder are deleted by an update.
  const src = readFileSync(join(REPO, 'tools', 'install.ts'), 'utf8');
  const removal = /for \(const old of inst\.copiesToRemove\([^\n]*\n?[^\n]*rm\(join\(P\.root, old\)/.test(src);
  const guarded = /holdsModels|pruneOldCopies/.test(src);
  assert.ok(!removal || guarded, 'tools/install.ts removes old copies without asking holdsModels (or using pruneOldCopies)');
});

test('U-02b: the start-time sweep keeps an older copy with models (the guard the installer lacks)', async () => {
  const root = tmp('u02');
  for (const n of ['tomlin-2.1.30', 'tomlin-2.1.31', 'tomlin-2.1.32']) copyIn(root, n, true);
  mkdirSync(join(root, 'tomlin-2.1.30', 'models', 'chat'), { recursive: true });
  writeFileSync(join(root, 'tomlin-2.1.30', 'models', 'chat', 'mine.gguf'), 'GGUF');
  writeFileSync(join(root, 'current.txt'), 'tomlin-2.1.32');
  await pruneOldCopies(root, 'tomlin-2.1.32');
  assert.ok(existsSync(join(root, 'tomlin-2.1.30', 'models', 'chat', 'mine.gguf')));
  // The installer's rule names that copy for removal all the same.
  assert.deepEqual(copiesToRemove(['tomlin-2.1.30', 'tomlin-2.1.31', 'tomlin-2.1.32'], 'tomlin-2.1.32'), ['tomlin-2.1.30']);
});

test('U-03: setup writes current.txt in one step (beside it, then swapped in), so a kill never leaves it empty', () => {
  const src = readFileSync(join(REPO, 'tools', 'install.ts'), 'utf8');
  assert.doesNotMatch(src, /writeFile\(join\(P\.root, inst\.CURRENT\), name\)/, 'tools/install.ts writes current.txt in place');
});

test('U-04: the tray moves current.txt onto a new copy only once it has answered', () => {
  // tools/tray.cs Ended(): code 76 writes current.txt for the new copy, then starts it; the way back (previousDir) lives
  // only in memory. Killed (or the PC turned off) before the new copy answers, the next start runs the untried copy
  // with no copy to go back to.
  const cs = readFileSync(join(REPO, 'tools', 'tray.cs'), 'utf8');
  const at76 = cs.slice(cs.indexOf('if (code == 76)'), cs.indexOf('Say("TOMLIN was updated, but'));
  assert.ok(at76.indexOf('WriteCurrent(next)') < 0 || at76.indexOf('WriteCurrent(next)') > at76.indexOf('Start(false)'), 'current.txt is moved before the new copy has started');
});

// ---- Rule 4: one TOMLIN per data folder ----

test('L-01: two starts repairing the same stale lock at once never both take the home', () => {
  const home = tmp('l01');
  writeFileSync(join(home, LOCK_FILE), '4242'); // left by a copy that was killed; Windows gave 4242 to another program
  const alive = (pid: number) => pid === 4242 || pid === 1001 || pid === 1002;
  let second: ReturnType<typeof takeHome> | null = null;
  // Each start asks Windows what process 4242 is (PowerShell, about a second): the second start runs inside the first's wait.
  const first = takeHome(home, 1001, alive, h => {
    if (h.pid === 4242 && !second) second = takeHome(home, 1002, alive, x => (x.pid === 4242 ? 'stale' : 'running'));
    return h.pid === 4242 ? 'stale' : 'running';
  });
  const both = 'ok' in first && second !== null && 'ok' in (second as object);
  assert.equal(both, false, `both starts took the home: first ${JSON.stringify(first)}, second ${JSON.stringify(second)}; the lock names ${readFileSync(join(home, LOCK_FILE), 'utf8')}`);
});

test('L-02: a lock left by a copy that ended is taken over; a running copy keeps the home', () => {
  const home = tmp('l02');
  writeFileSync(join(home, LOCK_FILE), '999999');
  assert.deepEqual(takeHome(home, 1001, () => false), { ok: true });
  assert.deepEqual(takeHome(home, 1002, pid => pid === 1001, () => 'running'), { other: 1001 });
  // A damaged lock (not a number) is taken over, not a crash.
  writeFileSync(join(home, LOCK_FILE), 'garbage');
  assert.deepEqual(takeHome(home, 1003, () => false), { ok: true });
});

// ---- Rule 6: runtime builds checked before use; a broken one never stops TOMLIN starting ----

/** A stand-in download server on 127.0.0.1 that sends `bytes` of zeros for any address. */
async function standIn(bytes: number) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        const n = Math.min(chunk.length, bytes - sent);
        sent += n;
        if (!res.write(chunk.subarray(0, n))) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/runner.zip`, close: () => new Promise(r => srv.close(r)) };
}

test('R-01: a runner download stops at its pinned size; a server that sends more never fills the disk', async () => {
  const d = tmp('r01');
  const s = await standIn(8 * 2 ** 20);
  let most = 0;
  try {
    await assert.rejects(fetchChecked(s.url, join(d, 'runner.zip'), 1024, 'ab'.repeat(32), p => { most = Math.max(most, p.got); }));
  } finally {
    await s.close();
  }
  assert.ok(most <= 1024, `${most} bytes were written for a file pinned at 1024`);
});

test('R-02: a runner download that does not match its SHA-256 leaves nothing under its real name', async () => {
  const d = tmp('r02');
  const s = await standIn(4096);
  try {
    await assert.rejects(fetchChecked(s.url, join(d, 'runner.zip'), 4096, 'ab'.repeat(32)), /SHA-256/);
  } finally {
    await s.close();
  }
  assert.equal(existsSync(join(d, 'runner.zip')), false);
  assert.equal(existsSync(join(d, 'runner.zip.part')), false);
});

test('R-03: a runner zip that climbs out is unpacked into its own folder only, and a build without its program is not used', async () => {
  const d = tmp('r03');
  const kept = join(d, 'home-runtime');
  const pins = join(d, 'runtimes.json');
  writeFileSync(pins, JSON.stringify({ runtimes: { 'llama-cuda': { engine: 'llama', device: 'cuda', name: 'test', licence: 'MIT', parts: [{ url: 'http://127.0.0.1:9/a.zip', bytes: 1, sha256: 'ab'.repeat(32) }] } } }));
  const rt = new Runtimes(join(d, 'app-runtime'), pins, kept);
  const zip = join(d, 'a.zip');
  writeFileSync(zip, makeZip([{ name: '../../escaped.txt', data: 'x' }, { name: 'readme.txt', data: 'x' }]));
  await assert.rejects(rt.unpackPin('llama-cuda', [zip]));
  assert.equal(existsSync(join(d, 'escaped.txt')), false);
  assert.equal(existsSync(join(BASE, 'escaped.txt')), false);
  assert.equal(rt.installedPin('llama-cuda'), false, 'a build that did not unpack whole is not used');
});

test('R-04: Start TOMLIN.cmd starts TOMLIN when a model runner is missing and cannot be downloaded', () => {
  // A virus scanner taking llama-server.exe, on a PC offline: "npm run fetch" fails and the launcher ends (exit /b 1)
  // instead of starting TOMLIN without that runner. The installed program (tools/tray.cs) has no such step.
  const cmd = readFileSync(join(REPO, 'Start TOMLIN.cmd'), 'utf8');
  const runnerLines = cmd.split(/\r?\n/).filter(l => /server\.exe/.test(l) && /npm run fetch/.test(l));
  assert.ok(runnerLines.length > 0);
  for (const l of runnerLines) assert.doesNotMatch(l, /exit \/b 1/, l.trim().slice(0, 80));
});

// ---- Rule 7: the USB maker writes only to the chosen Debian live stick ----

test('S-01: Remove and Mint refuse a drive that is not a minted Debian live stick', () => {
  const d = tmp('s01');
  // A folder of someone's own named tomlin, on a drive that is not a live stick: never removed.
  mkdirSync(join(d, 'tomlin'), { recursive: true });
  writeFileSync(join(d, 'tomlin', 'mine.txt'), 'keep');
  assert.throws(() => removeFromStick(`${d}\\`), /not a Debian live stick/);
  assert.ok(existsSync(join(d, 'tomlin', 'mine.txt')));
  assert.match(inspect(`${d}\\`).why, /not a Debian live stick/);
  // A live stick that was never minted: nothing removed either.
  mkdirSync(join(d, 'live'), { recursive: true });
  writeFileSync(join(d, 'live', 'filesystem.squashfs'), '');
  assert.throws(() => removeFromStick(`${d}\\`), /was not minted/);
  assert.ok(existsSync(join(d, 'tomlin', 'mine.txt')));
});
