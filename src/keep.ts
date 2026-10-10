// Updates that keep everything (PLAN P0). What a person keeps lives in ONE home folder outside the app folder:
// data/ (chats, staff, pictures, notebooks, settings, node links, the app lock), models/ (downloaded models),
// runtime/ (downloaded runners such as CUDA) and backups/. The app folder holds code and the runners the zip ships,
// so an update is: unzip the new version anywhere and start it; it finds the same home.
// The first start of a version whose home is empty offers to import an older copy's data (copied) and models and
// runners (moved, so nothing is downloaded again). Before a new version first uses the data, data/ is zipped into
// backups/ (the last 5 are kept). Import and restore run at the NEXT start, before anything opens a file.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeAtomic } from './atomic.ts';
import { PIN_FILE, pinKey, type RuntimePin } from './runtimes.ts';

const run = promisify(execFile);

/** Raised when the data changes shape; an older copy refuses data newer than it knows. */
export const DATA_VERSION = 1;
/** Exit code that Start TOMLIN.cmd reads as "start me again". */
export const RESTART_CODE = 75;
const KEEP_BACKUPS = 5;
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
/** Left out of every data backup: the Bridge's snapshot browser profile, as tar names it from the data folder. */
export const SNAP_PROFILE = './bridge/snaps/profile';
/** Also left out: Push live's connections, secrets and push records (sealed for this Windows account, and they stay in place). */
export const HOSTING = './bridge/hosting';
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

/**
 * Zips data/ into backups/ ("<date> <label>.zip") and keeps the last 5. Returns the file name. The zip is made in a
 * folder of its own and moved in when it is whole, so a backup that failed or was cut off is never listed as one.
 */
export async function backup(home: Home, label: string): Promise<string> {
  await mkdir(home.backups, { recursive: true });
  const name = `${stamp()} ${label.replace(/[^\w .()-]+/g, '-')}.zip`;
  const making = join(home.backups, MAKING);
  await mkdir(making, { recursive: true });
  const part = join(making, name);
  try {
    // Windows' own tar makes zip files (-a picks the format from the name); the runner list is about live processes,
    // and a save's half-written copy (*.tmp) is not data. The Bridge's throwaway browser profile for page snapshots
    // (src/bridge/snaps.js) is not data either, and Windows can refuse to let it be read (a locked browser file): with
    // it in, every backup failed ("Permission denied" on its Affiliation Database).
    await run(tar(), ['-a', '-c', '-f', part, '--exclude', 'runners.json', '--exclude', '*.tmp', '--exclude', SNAP_PROFILE, '--exclude', HOSTING, '-C', home.data, '.'], { windowsHide: true, maxBuffer: 1 << 20 });
    await rename(part, join(home.backups, name));
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  } finally {
    // Gone once empty (another backup still being made keeps it).
    await rmdir(making).catch(() => undefined);
  }
  const all = await listBackups(home);
  for (const old of all.slice(KEEP_BACKUPS)) await rm(join(home.backups, old.name), { force: true });
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
 * What every backup leaves out on purpose and keeps in place (Push live's connections, secrets and push records):
 * moved from the old data into the new before the old goes, unless the new data brought its own.
 */
async function carryKept(old: string, data: string): Promise<void> {
  const rel = HOSTING.split('/').slice(1);
  const from = join(old, ...rel);
  const to = join(data, ...rel);
  if (!existsSync(from) || existsSync(to)) return;
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
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
  // Unpacked first: the backup of the data as it is now could push the oldest backup (maybe this one) out of the 5.
  const fresh = `${home.data}.restoring`;
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh, { recursive: true });
  await run(tar(), ['-x', '-f', zip, '-C', fresh], { windowsHide: true, maxBuffer: 1 << 20 });
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
  const note = `Restored the backup "${name.replace(/\.zip$/, '')}". The data as it was just before is kept as the backup "${kept.replace(/\.zip$/, '')}".`;
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
