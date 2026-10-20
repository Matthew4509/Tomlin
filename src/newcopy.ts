// The checks a new copy of TOMLIN passes before it takes over this one (Update this install, src/server/selfupdate.ts):
// the zip's own listing read before anything is opened (no links, no name that climbs out, not more files or bytes
// than a TOMLIN could be), what Windows' tar then opened walked again (the listing can lie), and the new copy started
// once as a test, on a free port over a home of its own, which must answer as the version it says it is. A copy that
// fails any of them never takes over, and nothing of this one changes. Tested in test/newcopy.test.ts.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTomlinStatus } from './installer.ts';

/** A TOMLIN zip holds about 1,400 files that unpack to about 460 MB (more with the graphics builds): far under these. */
export const MAX_ENTRIES = 20_000;
export const MAX_UNPACKED = 4 * 1024 ** 3;
export interface Limits { entries?: number; bytes?: number }

export interface ZipEntry { name: string; size: number; link: boolean }

/** The entries a zip file lists in its central directory (read from its end; the file is never opened whole). */
export async function zipEntries(file: string): Promise<ZipEntry[]> {
  const f = await open(file, 'r');
  try {
    const { size } = await f.stat();
    const read = async (at: number, n: number) => {
      const b = Buffer.alloc(Math.max(0, Math.min(n, size - at)));
      await f.read(b, 0, b.length, at);
      return b;
    };
    const tailAt = Math.max(0, size - 65_557);
    const tail = await read(tailAt, size - tailAt);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('not a zip');
    let count = tail.readUInt16LE(end + 10);
    let cdSize = tail.readUInt32LE(end + 12);
    let cd = tail.readUInt32LE(end + 16);
    // Zip64: the real count, size and place are in the zip64 end record.
    if ((count === 0xffff || cd === 0xffffffff || cdSize === 0xffffffff) && end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
      const z = await read(Number(tail.readBigUInt64LE(end - 12)), 56);
      if (z.length === 56 && z.readUInt32LE(0) === 0x06064b50) {
        count = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cd = Number(z.readBigUInt64LE(48));
      }
    }
    if (cd + cdSize > size || cdSize > 64 * 1024 ** 2) throw new Error('not a zip (its listing is not where it says)');
    const b = await read(cd, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    // The count it gives is not trusted past the listing itself, nor past one more than any limit.
    for (let n = 0; n < count && n <= MAX_ENTRIES && p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50; n++) {
      const flags = b.readUInt16LE(p + 8);
      let entrySize = b.readUInt32LE(p + 24);
      const nl = b.readUInt16LE(p + 28);
      const xl = b.readUInt16LE(p + 30);
      const cl = b.readUInt16LE(p + 32);
      const host = b.readUInt8(p + 5);
      const attrs = b.readUInt32LE(p + 38);
      const name = b.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl);
      for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) {
        const id = b.readUInt16LE(x);
        const len = b.readUInt16LE(x + 2);
        if (id === 1 && entrySize === 0xffffffff && x + 12 <= b.length) entrySize = Number(b.readBigUInt64LE(x + 4));
        x += 4 + len;
      }
      // A Unix zip tool marks a symlink in the high half of the attributes; Windows tools leave it empty.
      out.push({ name, size: entrySize, link: host === 3 && ((attrs >>> 16) & 0o170000) === 0o120000 });
      p += 46 + nl + xl + cl;
    }
    return out;
  } finally {
    await f.close();
  }
}

/** A name in a zip that could land outside the folder it is opened into. */
const climbs = (name: string) => /^[\\/]|^[A-Za-z]:|\\/.test(name) || name.split('/').some(s => s === '..');

/** Why a zip's listing is not a TOMLIN that may be opened ('' when it may). */
export function entriesWhy(entries: ZipEntry[], limits: Limits = {}): string {
  const maxEntries = limits.entries ?? MAX_ENTRIES;
  const maxBytes = limits.bytes ?? MAX_UNPACKED;
  if (entries.length > maxEntries) return 'That zip holds more files than a TOMLIN does, so it was not opened. Pick the tomlin-<version>.zip file.';
  const climbing = entries.find(e => climbs(e.name));
  if (climbing) return `That zip holds a file whose name could land outside its folder (${JSON.stringify(climbing.name.slice(0, 80))}), so it was not opened. It is not a zip TOMLIN's maker makes.`;
  const link = entries.find(e => e.link);
  if (link) return `That zip holds a link (${JSON.stringify(link.name.slice(0, 80))}), which could point anywhere on this PC, so it was not opened. A TOMLIN zip holds none.`;
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > maxBytes) return `That zip would unpack to ${Math.round(total / 1024 ** 2).toLocaleString('en-GB')} MB, far more than a TOMLIN, so it was not opened.`;
  return '';
}

/**
 * What was opened at `dir` walked again ('' when it is fine): no link or junction anywhere in it, not more files or
 * bytes than the listing allowed, and no data folder of its own in the app folder `app` (it would be offered as
 * chats to import; null for what is not an app, such as a data backup).
 */
export async function unpackedWhy(dir: string, app: string | null, limits: Limits = {}): Promise<string> {
  const maxEntries = limits.entries ?? MAX_ENTRIES;
  const maxBytes = limits.bytes ?? MAX_UNPACKED;
  if (app && existsSync(join(app, 'data'))) return 'That zip carries a data folder of its own, and TOMLIN never takes chats or settings from a zip, so it was not used. Pick the tomlin-<version>.zip file.';
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<string> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const s = await lstat(p);
      // Node reads a Windows junction as a symbolic link too.
      if (s.isSymbolicLink()) return `That zip opened a link (${e.name}), which could point anywhere on this PC, so it was not used. A TOMLIN zip holds none.`;
      if (s.isDirectory()) {
        const why = await walk(p);
        if (why) return why;
        continue;
      }
      files += 1;
      bytes += s.size;
      if (files > maxEntries) return 'That zip opened more files than a TOMLIN has, so it was not used.';
      if (bytes > maxBytes) return 'That zip unpacked to more than it said it holds, so it was not used. It is not a zip TOMLIN\'s maker makes.';
    }
    return '';
  };
  return walk(dir);
}

/** A port no program is listening on now. */
const freePort = () => new Promise<number>((done, fail) => {
  const s = createServer();
  s.on('error', fail);
  s.listen(0, '127.0.0.1', () => {
    const a = s.address();
    s.close(() => done(typeof a === 'object' && a ? a.port : 0));
  });
});
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The new copy in `dir` started once as a test (TOMLIN_TEST_START): on a free port, over an empty home of its own, with
 * its own Node.js when it carries one (as Start TOMLIN.cmd starts it). '' when it answered GET /api/status as TOMLIN
 * `version`; else what went wrong. It is ended either way, with anything it started, and its home removed.
 */
export async function testStart(dir: string, version: string, o: { ms?: number } = {}): Promise<string> {
  const ms = o.ms ?? 90_000;
  const home = await mkdtemp(join(tmpdir(), 'tomlin-test-start-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_TEST_START: '1' };
  // Nothing of the running copy's own: its launcher loop, its window, its data and models, its Bridge part's settings.
  for (const k of Object.keys(env)) if (/^(TOMLIN|SHELBY)_(DATA|LOOP|OPEN|TRAY|PREV|FAILED|MODELS_FILE)$|^BRIDGE_/.test(k)) delete env[k];
  const own = join(dir, 'runtime', 'node', 'node.exe');
  let out = '';
  let ended = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(existsSync(own) ? own : process.execPath, ['src/server.ts'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Windows refuses a file that is not a program at once (spawn UNKNOWN), before any 'error' event.
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    return `${existsSync(own) ? 'its Node.js (runtime\\node\\node.exe) would not run' : 'it could not be started'} (${(e as Error).message})`;
  }
  const keep = (d: Buffer) => { if (out.length < 4000) out += d; };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const gone = new Promise<void>(r => {
    child.on('exit', () => { ended = true; r(); });
    child.on('error', e => { ended = true; out += e.message; r(); });
  });
  let why = `it did not answer within ${Math.round(ms / 1000)} seconds`;
  try {
    for (const end = Date.now() + ms; Date.now() < end && !ended;) {
      await pause(400);
      const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!r) continue;
      const text = await r.text().catch(() => '');
      if (!isTomlinStatus(r.status, text)) continue;
      const said = String(JSON.parse(text).version ?? '');
      why = said === version ? '' : `it says it is ${said.slice(0, 20) || 'no version'}, not ${version}`;
      break;
    }
    if (ended && why.startsWith('it did not answer')) why = `it stopped as soon as it started${out.trim() ? ` (${out.trim().split(/\r?\n/).pop()!.slice(0, 200)})` : ''}`;
  } finally {
    if (!ended && child.pid) {
      // With anything it started (a hardware reader, a model runner): the whole tree.
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      else child.kill('SIGKILL');
    }
    await Promise.race([gone, pause(10_000)]);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
  return why;
}
