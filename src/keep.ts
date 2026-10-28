// Updates that keep everything (PLAN P0). What a person keeps lives in ONE home folder outside the app folder:
// data/ (chats, staff, pictures, notebooks, settings, node links, the app lock), models/ (downloaded models),
// runtime/ (downloaded runners such as CUDA) and backups/. The app folder holds code and the runners the zip ships,
// so an update is: unzip the new version anywhere and start it; it finds the same home.
// The first start of a version whose home is empty offers to import an older copy's data (copied) and models and
// runners (moved, so nothing is downloaded again). Before a new version first uses the data, data/ is zipped into
// backups/ (the newest 5 are kept, and older ones thin out by age: keptByAge). Import and restore run at the NEXT
// start, before anything opens a file.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeAtomic } from './atomic.ts';
import { entriesWhy, unpackedWhy, zipEntries } from './newcopy.ts';
import { checkZip, listFolder, writeZip } from './zip.ts';
import { PIN_FILE, pinKey, type RuntimePin } from './runtimes.ts';
import { CODES_FILE } from './recovery.ts';

const run = promisify(execFile);

/** Raised when the data changes shape; an older copy refuses data newer than it knows. */
export const DATA_VERSION = 1;
/** Exit code that Start TOMLIN.cmd reads as "start me again". */
export const RESTART_CODE = 75;
/** Kept whatever their age: the newest backups. */
const KEEP_NEWEST = 5;
const VERSION_FILE = 'version.json';
const NEXT_FILE = 'next-start.json';

export interface Home {
  home: string;
  data: string;
  models: string;
  runtime: string;
  backups: string;
  /** The chat models' "other folder" setting (was models-folder.txt in the app folder). */
  modelsFile: string;
}

/** The home folder's name before the TOMLIN name: a PC that has data there keeps using it (nothing is moved). */
export const OLD_HOME_NAME = 'Smart Manager';
/**
 * The home in the user's own folder (not Documents, which OneDrive may sync: models are gigabytes): "TOMLIN", unless
 * only "Smart Manager" holds data (a PC set up before the TOMLIN name). tools/tray.cs and tools/bridge use the same rule.
 */
export function defaultHome(user: string): string {
  const now = join(user, 'TOMLIN');
  const old = join(user, OLD_HOME_NAME);
  return !existsSync(join(now, 'data')) && existsSync(join(old, 'data')) ? old : now;
}

/**
 * Where the home is: TOMLIN_HOME; else, when only TOMLIN_DATA is given (a test copy), the folder around it; else
 * defaultHome.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): Home {
  const home = resolve(env.TOMLIN_HOME ?? (env.TOMLIN_DATA ? dirname(resolve(env.TOMLIN_DATA)) : defaultHome(homedir())));
  return {
    home,
    data: resolve(env.TOMLIN_DATA ?? join(home, 'data')),
    models: join(home, 'models'),
    runtime: join(home, 'runtime'),
    backups: join(home, 'backups'),
    modelsFile: env.TOMLIN_MODELS_FILE ?? join(home, 'models-folder.txt'),
  };
}

export interface VersionFile {
  data: number;
  /** The app version that last used this data. */
  app: string;
  /** True while the "Import" question is unanswered. */
  offer?: boolean;
  /** What the last import, restore or backup did, in plain words, until the page has shown it. */
  note?: string;
  /** The note's heading on the page; without one it is "Your data". */
  noteTitle?: string;
}

export interface Source {
  /** The app folder of the copy. */
  dir: string;
  version: string;
  /** When its data last changed (settings.json). */
  at: number;
  chats: number;
  /** Bytes of models and runners that would be moved. */
  modelBytes: number;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** Bytes of every file under `dir` (0 when it is missing). */
function bytesUnder(dir: string): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const s = statSync(p);
      n += s.isDirectory() ? bytesUnder(p) : s.size;
    } catch {
      // gone or locked
    }
  }
  return n;
}

/**
 * Copies of TOMLIN whose own data/ could be imported: this copy's folder (versions before this change kept
 * data inside it) and the copies beside it (each version unzips into its own folder), newest data first.
 */
export function findSources(root: string, home: Home): Source[] {
  const here = resolve(root);
  const parent = dirname(here);
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    // no folder listing: this copy only
  }
  const dirs = [here, ...names.map(n => join(parent, n)).filter(d => resolve(d).toLowerCase() !== here.toLowerCase())];
  const found: Source[] = [];
  for (const dir of dirs) {
    const pkg = readJson<{ name?: string; version?: string }>(join(dir, 'package.json'));
    if (pkg?.name !== 'tomlin' && pkg?.name !== 'shelby') continue; // shelby: copies made before the TOMLIN name
    const data = join(dir, 'data');
    if (resolve(data).toLowerCase() === resolve(home.data).toLowerCase()) continue;
    let at = 0;
    try {
      at = statSync(join(data, 'settings.json')).mtimeMs;
    } catch {
      continue;
    }
    let chats = 0;
    try {
      chats = readdirSync(join(data, 'chats')).filter(f => f.endsWith('.json') && f !== 'index.json').length;
    } catch {
      // older copy without chats/
    }
    const modelBytes = bytesUnder(join(dir, 'models', 'chat')) + bytesUnder(join(dir, 'models', 'image')) + extraRunners(dir, root).reduce((n, r) => n + bytesUnder(join(dir, 'runtime', r)), 0);
    found.push({ dir, version: pkg.version ?? '?', at, chats, modelBytes });
  }
  return found.sort((a, b) => b.at - a.at);
}

/** Runner folders in `dir`'s runtime/ that this copy does not ship and that are pinned the same as here. */
function extraRunners(dir: string, root: string): string[] {
  const mine = readJson<{ runtimes: Record<string, unknown> }>(join(root, 'runtimes.json'))?.runtimes ?? {};
  const theirs = readJson<{ runtimes: Record<string, unknown> }>(join(dir, 'runtimes.json'))?.runtimes ?? {};
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, 'runtime'));
  } catch {
    return [];
  }
  return names.filter(id => !SHIPPED.has(id) && id in mine && JSON.stringify(mine[id]) === JSON.stringify(theirs[id]));
}

/** The runners every zip carries (tools/pack.ts); the rest are downloaded and belong in the home. */
export const SHIPPED = new Set(['llama-cpu', 'llama-vulkan', 'sd-cpu', 'sd-vulkan']);

export function readVersion(home: Home): VersionFile | null {
  const v = readJson<VersionFile>(join(home.data, VERSION_FILE));
  return v && typeof v.data === 'number' ? v : null;
}

export async function writeVersion(home: Home, v: VersionFile): Promise<void> {
  await writeAtomic(join(home.data, VERSION_FILE), JSON.stringify(v, null, 2));
}

const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
/** Left out of every data backup: the Bridge's snapshot browser profile, as the zip names it from the data folder. */
export const SNAP_PROFILE = 'bridge/snaps/profile';
/** Also left out: Push live's connections, secrets and push records (sealed for this Windows account, and they stay in place). */
export const HOSTING = 'bridge/hosting';
/** Never in a restore point sent from here (since 2.0.5x): a brought-back one that carries them was made elsewhere. */
const NEVER_SENT = ['share.json', 'app-lock.json'];
/**
 * Left out of a restore point kept on another PC (Back up to a linked PC), with the keys to the linked PCs in
 * settings.json: this PC's sharing code and paired links, its PIN and recovery codes, and the backup claims waiting on
 * it. That PC keeps the chats, never the keys; putting one back keeps this PC's own (carryKept).
 */
const NOT_ELSEWHERE = [...NEVER_SENT, CODES_FILE, 'claims.json'];
/** In a restore point kept on another PC: says what was left out, so putting it back keeps this PC's own. */
export const ELSEWHERE_MARK = 'kept-elsewhere.json';
const tar = () => (process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

export interface Backup {
  name: string;
  at: number;
  bytes: number;
}

/** The backups, newest first. A name reads "2026-10-04 101500 before 2.0.27.zip". */
export async function listBackups(home: Home): Promise<Backup[]> {
  const names = await readdir(home.backups).catch(() => [] as string[]);
  const out: Backup[] = [];
  for (const name of names.filter(n => n.endsWith('.zip'))) {
    try {
      const s = await stat(join(home.backups, name));
      out.push({ name, at: s.mtimeMs, bytes: s.size });
    } catch {
      // gone
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** When a backup was made: the date and time its name starts with ("2026-10-04 101500 ..."), else its file time. */
function madeAt(b: Backup): Date {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)(\d\d)(\d\d) /.exec(b.name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(b.at);
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
/** A week is named by its Monday. */
const weekKey = (d: Date) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));
const quarterOf = (d: Date) => d.getFullYear() * 4 + Math.floor(d.getMonth() / 3);

/**
 * Older backups thin out by age, as a web host keeps its own: the newest of each day for the last 7 days, of each week
 * for the last 4 weeks, and of each quarter (3 months) for the last 4 quarters. Each period is counted back from `now`,
 * the current one included.
 */
const TIERS: { periods: (now: Date) => string[]; key: (d: Date) => string }[] = [
  { periods: now => [0, 1, 2, 3, 4, 5, 6].map(i => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))), key: dayKey },
  { periods: now => [0, 1, 2, 3].map(i => weekKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * i))), key: weekKey },
  { periods: now => [0, 1, 2, 3].map(i => String(quarterOf(now) - i)), key: d => String(quarterOf(d)) },
];

/** The backups to keep (by name): the newest 5, and the newest of each day, week and quarter TIERS names. */
export function keptByAge(backups: Backup[], now = new Date()): Set<string> {
  const newest = [...backups].sort((a, b) => b.name.localeCompare(a.name));
  const kept = new Set(newest.slice(0, KEEP_NEWEST).map(b => b.name));
  for (const tier of TIERS) {
    const open = new Set(tier.periods(now));
    for (const b of newest) {
      const k = tier.key(madeAt(b));
      if (!open.delete(k)) continue;
      kept.add(b.name);
    }
  }
  return kept;
}

/** settings.json without the keys to the linked PCs (each keeps its name and address; its token is empty). */
function withoutKeys(text: string): string {
  const s = JSON.parse(text) as { remotes?: unknown; webSearch?: unknown };
  const remotes = Array.isArray(s.remotes) ? s.remotes.map(r => {
    const { token: _token, key: _key, ...rest } = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return { ...rest, token: '' };
  }) : s.remotes;
  // The web search key (Brave's, paid for) stays here too; which engine is used goes with the rest.
  const { key: _webKey, ...webSearch } = (s.webSearch && typeof s.webSearch === 'object' ? s.webSearch : {}) as Record<string, unknown>;
  return JSON.stringify({ ...s, remotes, ...(s.webSearch !== undefined ? { webSearch } : {}) });
}

/**
 * Zips data/ into backups/ ("<date> <label>.zip"); the older ones thin out (keptByAge). Returns the file name. The zip is made in a
 * folder of its own and moved in when it is whole, so a backup that failed or was cut off is never listed as one. Whole
 * means written and then read back and checked (every file inflated again, its size and CRC-32 compared: src/zip.ts),
 * with every file in it: one that could not be read fails the backup and is named.
 * forOtherPc: a restore point to keep on another PC, without this PC's keys to its linked PCs, sharing code and PIN.
 */
export async function backup(home: Home, label: string, o: { forOtherPc?: boolean } = {}): Promise<string> {
  await mkdir(home.backups, { recursive: true });
  const name = `${stamp()} ${label.replace(/[^\w .()-]+/g, '-')}.zip`;
  const making = join(home.backups, MAKING);
  await mkdir(making, { recursive: true });
  const part = join(making, name);
  try {
    // TOMLIN writes the zip itself (Windows' tar garbled or left out names such as "Résumé.pdf"). The runner list is
    // about live processes, and a save's half-written copy (*.tmp) is not data. The Bridge's throwaway browser profile
    // for page snapshots (src/bridge/snaps.js) is not data either, and Windows can refuse to let it be read (a locked
    // browser file): with it in, every backup failed ("Permission denied" on its Affiliation Database). A link or
    // junction is not followed (data/ holds none of its own).
    const top = new Set(o.forOtherPc ? ['settings.json', 'runners.json', ELSEWHERE_MARK, ...NOT_ELSEWHERE] : []);
    const { items } = await listFolder(home.data, (rel, dir) => {
      const last = rel.slice(rel.lastIndexOf('/') + 1);
      return (!dir && last === 'runners.json') || last.endsWith('.tmp') || rel === SNAP_PROFILE || rel === HOSTING || (!rel.includes('/') && top.has(rel));
    });
    if (o.forOtherPc) {
      // settings.json goes in without the keys, and a mark says what was left out.
      const settings = await readFile(join(home.data, 'settings.json'), 'utf8').catch(() => null);
      if (settings !== null) {
        let without: string;
        try {
          without = withoutKeys(settings);
        } catch {
          throw new Error('your settings file could not be read, so no restore point was made to send (it would have carried the keys to your linked PCs)');
        }
        items.push({ name: 'settings.json', data: Buffer.from(without) });
      }
      items.push({ name: ELSEWHERE_MARK, data: Buffer.from(JSON.stringify({ left: ['the keys to the linked PCs (settings.json)', ...NOT_ELSEWHERE] }, null, 1)) });
    }
    const made = await writeZip(part, items);
    if (made.skipped.length) {
      const s = made.skipped;
      throw new Error(`${s.length === 1 ? '1 file' : `${s.length} files`} could not be read: ${s.slice(0, 3).map(x => `${x.name} (${x.why})`).join(', ')}${s.length > 3 ? '…' : ''}`);
    }
    const checked = await checkZip(part, made.entries);
    if (!checked.ok) throw new Error(`it did not pass its check when read back: ${checked.fault}`);
    await rename(part, join(home.backups, name));
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  } finally {
    // Gone once empty (another backup still being made keeps it).
    await rmdir(making).catch(() => undefined);
  }
  const all = await listBackups(home);
  const kept = keptByAge(all);
  for (const old of all) if (!kept.has(old.name)) await rm(join(home.backups, old.name), { force: true });
  return name;
}

export type Next = { do: 'bring-in'; from: string } | { do: 'restore'; name: string };

/** Where a backup is made until it is whole (inside backups/, so the move in is a rename). */
const MAKING = '.making';

/** Why a backup could not be made, in plain words for the note. */
const backupFault = (e: unknown) => `the backup of your data could not be made (${((e as Error).message || String(e)).split('\n')[0].slice(0, 200)}). Check there is free space on the drive, then try again`;

/**
 * Puts `fresh` (a whole new data folder beside it) in place of data/ by renames only: data/ becomes data.old, fresh
 * becomes data/, then data.old goes. Cut off at any point (Quit, a power cut), the next start finishes or undoes it
 * (settleSwap), so data/ is never left half deleted.
 */
async function swapData(home: Home, fresh: string): Promise<void> {
  const old = `${home.data}.old`;
  await rm(old, { recursive: true, force: true });
  if (existsSync(home.data)) await rename(home.data, old);
  await rename(fresh, home.data);
  await carryKept(old, home.data);
  await rm(old, { recursive: true, force: true });
}

/**
 * What a backup leaves out on purpose and keeps in place (Push live's connections, secrets and push records; and, from a
 * restore point kept on another PC, this PC's sharing code and PIN): moved from the old data into the new before the
 * old goes, unless the new data brought its own.
 */
async function carryKept(old: string, data: string): Promise<void> {
  for (const rel of [HOSTING.split('/'), ...NOT_ELSEWHERE.map(f => [f])]) {
    const from = join(old, ...rel);
    const to = join(data, ...rel);
    if (!existsSync(from) || existsSync(to)) continue;
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }
}

/**
 * A restore point kept on another PC, unpacked at `fresh`: each linked PC takes this PC's key to it as it is now, and
 * a linked PC this PC does not know now comes back with no key (one sent from here carries none; one that does was
 * written elsewhere: audit X1).
 */
async function keysFromHere(fresh: string, data: string): Promise<void> {
  type Settings = { remotes?: Record<string, unknown>[]; webSearch?: Record<string, unknown> };
  const read = async (f: string) => JSON.parse(await readFile(f, 'utf8')) as Settings;
  const back = await read(join(fresh, 'settings.json')).catch(() => null);
  if (!back || typeof back !== 'object') return;
  const now: Settings = await read(join(data, 'settings.json')).catch(() => ({ remotes: [] }));
  if (Array.isArray(back.remotes)) {
    const mine = new Map((Array.isArray(now.remotes) ? now.remotes : []).map(r => [r.id, r]));
    back.remotes = back.remotes.map(r => {
      const m = mine.get(r.id);
      const { key: _key, ...rest } = r;
      return m ? { ...rest, token: m.token, ...(m.key ? { key: m.key } : {}) } : { ...rest, token: '' };
    });
  }
  // This PC's web search key as it is now (a restore point for another PC carries none).
  const key = now.webSearch && typeof now.webSearch === 'object' ? now.webSearch.key : undefined;
  if (typeof key === 'string' && key) back.webSearch = { ...(back.webSearch && typeof back.webSearch === 'object' ? back.webSearch : {}), key };
  await writeAtomic(join(fresh, 'settings.json'), JSON.stringify(back));
}

// ---- Restore points kept on another PC: what was sent is recorded here, and what comes back is checked ----

/** In backups/: the SHA-256 of each restore point sent to another PC, by name (the newest 50). */
const SENT_FILE = '.sent.json';
async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
const readSent = async (dir: string) => JSON.parse(await readFile(join(dir, SENT_FILE), 'utf8').catch(() => '{}')) as Record<string, string>;

/** Notes the restore point `file` (named `name`) as sent to another PC. */
export async function recordSent(dir: string, name: string, file: string): Promise<void> {
  const sent = { ...(await readSent(dir).catch(() => ({}))), [name]: await sha256Of(file) };
  await writeAtomic(join(dir, SENT_FILE), JSON.stringify(Object.fromEntries(Object.entries(sent).slice(-50)), null, 1));
}

/**
 * Whether `file`, brought back as `name`, is what was sent: '' when it is; 'unchecked' when there is no record of it
 * (sent before the record was kept, or the record went with this PC's data); else why it is refused.
 */
export async function broughtBackWhy(dir: string, name: string, file: string): Promise<string> {
  const want = (await readSent(dir).catch(() => ({} as Record<string, string>)))[name];
  if (!want) return 'unchecked';
  return (await sha256Of(file)) === want ? '' : 'the restore point that came back is not the one this PC sent (it was changed on that PC, or cut short), so it was not kept';
}

/** In backups/: the restore points that came back from another PC, by name (the newest 200). */
const BROUGHT_FILE = '.brought.json';
const readBrought = async (dir: string) => JSON.parse(await readFile(join(dir, BROUGHT_FILE), 'utf8').catch(() => '[]')) as string[];

/** Notes that the restore point `name` came back from another PC: putting it back then keeps this PC's keys and PIN. */
export async function recordBrought(dir: string, name: string): Promise<void> {
  const list = (await readBrought(dir).catch(() => [] as string[])).filter(n => n !== name);
  await writeAtomic(join(dir, BROUGHT_FILE), JSON.stringify([...list, name].slice(-200)));
}

/** A swap cut off last time: finished (the new data is in place) or undone (data.old goes back). */
async function settleSwap(home: Home): Promise<void> {
  const old = `${home.data}.old`;
  if (existsSync(old)) {
    if (existsSync(home.data)) {
      await carryKept(old, home.data);
      await rm(old, { recursive: true, force: true });
    } else await rename(old, home.data);
  }
  for (const half of [`${home.data}.restoring`, `${home.data}.importing`]) await rm(half, { recursive: true, force: true });
  await rm(join(home.backups, MAKING), { recursive: true, force: true });
}

/** Asks for an import or a restore at the next start (nothing has a file open then). */
export async function planNext(home: Home, next: Next): Promise<void> {
  await writeAtomic(join(home.home, NEXT_FILE), JSON.stringify(next));
}

/** Moves every file under `from` into the same place under `to` when nothing is there yet. Counts what moved. */
async function moveFiles(from: string, to: string, tally: { files: number; bytes: number; left: number }): Promise<void> {
  let names: string[];
  try {
    names = await readdir(from);
  } catch {
    return;
  }
  for (const name of names) {
    const a = join(from, name);
    const b = join(to, name);
    let s;
    try {
      s = await stat(a);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await moveFiles(a, b, tally);
      continue;
    }
    if (name.endsWith('.part') || existsSync(b)) continue;
    try {
      await mkdir(dirname(b), { recursive: true });
      await rename(a, b);
      tally.files++;
      tally.bytes += s.size;
    } catch {
      // Another drive (a move would be a copy of gigabytes) or a file in use: it stays, and is still lent from there.
      tally.left++;
    }
  }
}

const gbText = (n: number) => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;

/**
 * Imports `from`'s data (copied; its own folder is left as it was) and moves its models and downloaded runners into
 * the home. The home's data/ is replaced. Returns the plain-words note.
 */
export async function bringIn(home: Home, root: string, from: string, appVersion: string, startup?: { repoint: (fromRoot: string) => Promise<boolean> }): Promise<string> {
  const src = findSources(root, home).find(s => resolve(s.dir).toLowerCase() === resolve(from).toLowerCase());
  if (!src) return `Nothing was imported: ${from} no longer holds a copy of TOMLIN with data.`;
  // The data here is kept first; without that copy nothing is replaced.
  let kept = '';
  if (existsSync(home.data)) {
    try {
      kept = await backup(home, 'before an import');
    } catch (e) {
      return `Nothing was imported: ${backupFault(e)}. Your data here is as it was.`;
    }
  }
  const fresh = `${home.data}.importing`;
  await rm(fresh, { recursive: true, force: true });
  await cp(join(src.dir, 'data'), fresh, { recursive: true, filter: p => basename(p) !== 'runners.json' });
  await swapData(home, fresh);
  const tally = { files: 0, bytes: 0, left: 0 };
  for (const part of ['chat', 'image']) await moveFiles(join(src.dir, 'models', part), join(home.models, part), tally);
  let runners = 0;
  for (const id of extraRunners(src.dir, root)) {
    const to = join(home.runtime, id);
    if (existsSync(to)) continue;
    try {
      await mkdir(home.runtime, { recursive: true });
      await rename(join(src.dir, 'runtime', id), to);
      // The same pinned files as this version names (checked by extraRunners), so it counts as downloaded here.
      const pins = readJson<{ runtimes: Record<string, RuntimePin> }>(join(root, 'runtimes.json'))?.runtimes ?? {};
      await writeAtomic(join(to, PIN_FILE), pinKey(pins[id]));
      runners++;
    } catch {
      tally.left++;
    }
  }
  if (!existsSync(home.modelsFile) && existsSync(join(src.dir, 'models-folder.txt'))) await cp(join(src.dir, 'models-folder.txt'), home.modelsFile);
  const repointed = startup ? await startup.repoint(src.dir).catch(() => false) : false;
  const same = resolve(src.dir).toLowerCase() === resolve(root).toLowerCase();
  const what = same ? 'this folder' : `TOMLIN ${src.version} (${src.dir})`;
  const note = [
    `Imported your chats, staff, pictures, memory, settings and PC links from ${what}. Its own data folder was left as it was.`,
    kept ? `The data that was here before is kept as the backup "${kept.replace(/\.zip$/, '')}" (Settings, Your data).` : '',
    tally.files || runners ? `Moved ${tally.files} model file${tally.files === 1 ? '' : 's'} (${gbText(tally.bytes)})${runners ? ` and ${runners} graphics-card runner${runners === 1 ? '' : 's'}` : ''} into ${home.home}, so nothing is downloaded again.` : '',
    tally.left ? `${tally.left} file${tally.left === 1 ? '' : 's'} stayed where ${tally.left === 1 ? 'it was' : 'they were'} (another drive, or in use): TOMLIN still uses ${tally.left === 1 ? 'it' : 'them'} from there while that folder is kept.` : '',
    repointed ? 'Starting with Windows now starts this copy.' : '',
  ].filter(Boolean).join(' ');
  await writeVersion(home, { data: DATA_VERSION, app: appVersion, note });
  return note;
}

/** Puts a backup back (the data as it is now is backed up first). */
export async function restore(home: Home, name: string, appVersion: string): Promise<string> {
  const zip = join(home.backups, basename(name));
  if (!existsSync(zip)) return `Nothing was restored: the backup "${name}" is no longer in ${home.backups}.`;
  const no = (why: string) => `Nothing was restored: ${why.charAt(0).toLowerCase()}${why.slice(1).replace(/\.$/, '')}. Your data is as it was.`;
  // Its own listing first (a restore point can come back from another PC): no link, no name that climbs out. Data can
  // be any size, so no count or size limit here.
  const any = { entries: Infinity, bytes: Infinity };
  const listed = await zipEntries(zip).then(e => entriesWhy(e, any), () => 'that backup could not be read as a zip');
  if (listed) return no(listed);
  // Then every file in it read back and checked, so a damaged backup is said to be one before anything is unpacked.
  const checked = await checkZip(zip);
  if (!checked.ok) return no(`that backup is damaged (${checked.fault.replace(/\.$/, '')})`);
  // Unpacked first: the backup of the data as it is now could push the oldest backup (maybe this one) out of the 5.
  const fresh = `${home.data}.restoring`;
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh, { recursive: true });
  try {
    await run(tar(), ['-x', '-f', zip, '-C', fresh], { windowsHide: true, maxBuffer: 1 << 20 });
  } catch (e) {
    await rm(fresh, { recursive: true, force: true });
    return no(`that backup could not be opened (${((e as Error).message || '').split('\n').pop()?.trim().slice(0, 160) || 'tar refused it'})`);
  }
  const opened = await unpackedWhy(fresh, null, any);
  if (opened) {
    await rm(fresh, { recursive: true, force: true });
    return no(opened);
  }
  // Kept on another PC: it holds no keys to the linked PCs, no sharing code and no PIN, so this PC's own stay. Whether it
  // came back from one is this PC's own record, not the mark inside the zip (that PC could take the mark out).
  const brought = (await readBrought(home.backups).catch(() => [] as string[])).includes(basename(name));
  if (brought && NEVER_SENT.some(f => existsSync(join(fresh, f)))) {
    await rm(fresh, { recursive: true, force: true });
    return no('that restore point came back from another PC carrying a PIN or sharing settings, which one sent from here never holds, so it was made or changed there');
  }
  const elsewhere = brought || existsSync(join(fresh, ELSEWHERE_MARK));
  if (elsewhere) {
    for (const f of NOT_ELSEWHERE) await rm(join(fresh, f), { force: true });
    await keysFromHere(fresh, home.data);
    await rm(join(fresh, ELSEWHERE_MARK), { force: true });
  }
  // The data as it is now is kept first; without that copy nothing is replaced.
  let kept: string;
  try {
    kept = await backup(home, 'before restoring');
  } catch (e) {
    await rm(fresh, { recursive: true, force: true });
    return `Nothing was restored: ${backupFault(e)}. Your data is as it was.`;
  }
  await swapData(home, fresh);
  const v = readVersion(home);
  const note = `Restored the backup "${name.replace(/\.zip$/, '')}". The data as it was just before is kept as the backup "${kept.replace(/\.zip$/, '')}".${elsewhere ? ' It was a restore point kept on another PC, so it held no keys to your linked PCs, no web search key, no sharing code and no PIN: this PC\'s own stayed as they were. A linked PC this PC holds no key for any more needs linking again (Network).' : ''}`;
  await writeVersion(home, { data: v?.data ?? DATA_VERSION, app: appVersion, note });
  return note;
}

export type Ready =
  | { state: 'ready'; note?: string; noteTitle?: string }
  /** The home is new and an older copy has data: the page asks [Import] [Start empty]. */
  | { state: 'offer'; sources: Source[] }
  /** The data was last used by a newer TOMLIN that changed its shape. */
  | { state: 'too-new'; app: string };

/**
 * Runs before anything reads the data: a planned import or restore, then the version check and the update backup.
 */
export async function prepare(home: Home, root: string, appVersion: string, startup?: { repoint: (fromRoot: string) => Promise<boolean> }): Promise<Ready> {
  await mkdir(home.home, { recursive: true });
  await mkdir(home.models, { recursive: true });
  await settleSwap(home);
  const nextFile = join(home.home, NEXT_FILE);
  const next = readJson<Next>(nextFile);
  if (next) {
    // The plan goes once the work is done (cut off, it runs again at the next start); a fault is said in the note,
    // so a plan that cannot work never stops every start.
    let said = '';
    try {
      said = next.do === 'bring-in' ? await bringIn(home, root, next.from, appVersion, startup) : next.do === 'restore' ? await restore(home, next.name, appVersion) : '';
    } catch (e) {
      said = `The ${next.do === 'restore' ? 'restore' : 'import'} did not finish: ${(e as Error).message}. Your data is as it was before it began.`;
      await settleSwap(home).catch(() => undefined);
    }
    await unlink(nextFile).catch(() => undefined);
    if (/^(Nothing was|The (restore|import) did not)/.test(said)) {
      const was = readVersion(home);
      if (was) await writeVersion(home, { ...was, note: said, noteTitle: 'Your data' });
    }
  }
  const v = readVersion(home);
  if (!v) {
    const hasData = existsSync(join(home.data, 'settings.json'));
    const sources = hasData ? [] : findSources(root, home);
    // Data already here with no version file (a test copy, a home made by hand, or the file lost) is adopted, after a
    // backup of it; an empty home with an older copy beside it asks once.
    if (hasData) await backup(home, `before ${appVersion}`).catch(e => console.error(`A backup before using this data could not be made: ${(e as Error).message}`));
    await writeVersion(home, { data: DATA_VERSION, app: appVersion, offer: sources.length > 0 || undefined });
    return sources.length ? { state: 'offer', sources } : { state: 'ready' };
  }
  if (v.data > DATA_VERSION) return { state: 'too-new', app: v.app };
  if (v.offer) {
    // "Later" was pressed and this home has since got chats or staff of its own: an import would replace them, so the
    // question is not asked again (an import is still there under Settings, Your data, from a backup).
    const sources = hasOwnData(home) ? [] : findSources(root, home);
    if (sources.length) return { state: 'offer', sources };
    await writeVersion(home, { ...v, offer: undefined });
  }
  if (v.app !== appVersion) {
    // A new version (or an older one started again) uses this data for the first time: keep a copy first.
    let fault = '';
    const name = await backup(home, `before ${appVersion}`).catch(e => ((fault = backupFault(e)), ''));
    if (!name) {
      // Not marked as done: the backup is tried again at the next start.
      const note = `TOMLIN ${appVersion} could not keep a copy of your data first: ${fault}.`;
      await writeVersion(home, { ...v, note, noteTitle: 'Your data' });
      return { state: 'ready', note, noteTitle: 'Your data' };
    }
    const kept = name.replace(/\.zip$/, '');
    // Going back to an older version is not an update, so it is not called one.
    const up = newer(appVersion, v.app);
    const note = !name ? v.note
      : up ? `You have successfully updated to TOMLIN ${appVersion}.\nYour former account data was backed up as: ${kept}`
        : `TOMLIN ${appVersion} is using your data for the first time; the data as ${v.app} left it is kept as the backup "${kept}".`;
    const noteTitle = !name ? v.noteTitle : up ? 'Update Successful!' : undefined;
    await writeVersion(home, { data: DATA_VERSION, app: appVersion, note, noteTitle });
    return { state: 'ready', note, noteTitle };
  }
  return { state: 'ready', note: v.note, noteTitle: v.noteTitle };
}

/** The home has chats or staff of its own (made here since it started empty). */
function hasOwnData(home: Home): boolean {
  if (existsSync(join(home.data, 'staff.json'))) return true;
  const index = readJson<unknown[]>(join(home.data, 'chats', 'index.json'));
  return Array.isArray(index) && index.length > 0;
}

/** True when version a ("2.0.29") is later than b, compared number by number. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The page's answer to the question: start with an empty home. */
export async function startEmpty(home: Home, appVersion: string): Promise<void> {
  const v = readVersion(home);
  await writeVersion(home, { data: v?.data ?? DATA_VERSION, app: appVersion });
}

/** The page has shown the note. */
export async function noteShown(home: Home): Promise<void> {
  const v = readVersion(home);
  if (v?.note) await writeVersion(home, { ...v, note: undefined, noteTitle: undefined });
}

/** Bytes of a folder, for the page. */
export const folderBytes = (dir: string): number => bytesUnder(dir);
