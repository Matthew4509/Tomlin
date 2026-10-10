// Updates pushed to nodes (2.0.33). A host running a newer TOMLIN sends a linked PC its own app files (no data,
// no models: those live in the home folder, which the new version finds by itself) over the encrypted link, in the
// sealed pieces copies use (src/carry.ts). Only the files that differ cross: the node already has the rest in its own
// copy and copies them itself. The node builds the new version in a folder beside its copy (as an unzip by hand would),
// checks every file against the host's list, then ends with RESTART_INTO, which Start TOMLIN.cmd reads as "start the
// copy named in next-copy.txt" in the same window; the old copy stays beside it for going back. Its owner must tick
// "Allow host to update TOMLIN remotely" (code arriving from another PC), only a newer version is taken (or the same
// one with other files: its build id differs), and nothing
// starts while the node works for someone. Plain parts here, tested in test/update.test.ts; the doors are in
// src/jobrun/copies.ts (the host sending) and src/jobrun/node.ts (the node taking it).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { addPiece, freeBytes, partOf, readPiece, roomWhy, sizeOf, type Progress, type Wire } from './carry.ts';

/** Exit code Start TOMLIN.cmd reads as "start the copy named in next-copy.txt (in this folder) instead". */
export const RESTART_INTO = 76;
export const NEXT_COPY_FILE = 'next-copy.txt';

// ---- What an app copy is: the same list the release zip is made from (tools/pack.ts) ----

export const PARTS = ['src', 'public', 'tools', 'test', 'registry', 'runtime/node', 'runtime/llama-cpu', 'runtime/sd-cpu', 'runtime/llama-vulkan', 'runtime/sd-vulkan', 'node_modules', 'package.json', 'package-lock.json',
  'runtimes.json', 'README.md', 'LICENSE', 'THIRD-PARTY.md', 'Start TOMLIN.cmd', 'Install TOMLIN.cmd', 'Welcome to TOMLIN.html', 'models/helpers/u2netp.onnx'];
// Other platforms' copies of the ONNX runtime and image library are left out (Windows x64 only).
// Paths are matched with either slash ("\" on Windows, "/" elsewhere).
// PDF.js (documents in a chat) ships only its Node text reader and its font tables: its drawing add-on
// (@napi-rs/canvas), the browser builds and the source maps stay out.
// The private chat's files (partner.ts, scene.ts; taken out of the app) never ship, should an old folder still have them.
// The type check's tools (devDependencies: typescript and its program, @types/node and undici-types, the tsc
// shortcuts) stay on the PC that builds; a test holds this to every "dev" package in package-lock.json.
export const SKIP = /node_modules[\\/](typescript|@typescript|@types|undici-types)([\\/]|$)|node_modules[\\/]\.bin[\\/]tsc(\.cmd|\.ps1)?$|@napi-rs[\\/]|pdfjs-dist[\\/](build|web|image_decoders|types|wasm|iccs)[\\/]|pdfjs-dist[\\/]legacy[\\/](web|image_decoders)[\\/]|pdfjs-dist[\\/].*\.map$|pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.(sandbox|min|worker\.min)|onnxruntime-node[\\/]bin[\\/]napi-v\d+[\\/](darwin|linux|win32[\\/]arm64)|@img[\\/]sharp-(?!win32-x64|libvips-win32-x64)|src[\\/]partner\.ts$|src[\\/]scene\.ts$|test[\\/]partner\.test\.ts$|test[\\/]scene\.test\.ts$|\.(part|zip)$/i;
/** Folders a node keeps from its old copy when the update has none of them (a host without its own Node.js). */
export const KEEP_OWN_DIRS = ['runtime/node'];

export interface AppFile {
  /** Inside the app folder, with forward slashes. */
  path: string;
  bytes: number;
  /** SHA-256, hex. */
  sha: string;
  /** Read from this path here when it is sent under another name (forOlderNode); never sent itself. */
  from?: string;
}

/**
 * A copy for a PC from before the TOMLIN name (its list of app files has no "Start TOMLIN.cmd", so it refuses a copy
 * that names it): the launcher goes by the name that PC takes, "Start Shelby.cmd", holding the whole launcher (not the
 * forwarder), and "Install TOMLIN.cmd" stays out. That PC's own Start Shelby.cmd starts the new copy (exit 76); from
 * then on it takes the new names.
 */
export function forOlderNode(files: AppFile[]): AppFile[] {
  const launcher = files.find(f => f.path === 'Start TOMLIN.cmd');
  if (!launcher) return withoutNewer(files);
  return [...withoutNewer(files).filter(f => !['Start TOMLIN.cmd', 'Start Shelby.cmd', 'Install TOMLIN.cmd'].includes(f.path)), { ...launcher, path: 'Start Shelby.cmd', from: launcher.path }];
}
/**
 * Files at the top of the folder that newer copies list in PARTS and older ones do not (each older copy refuses a copy
 * that names one, before anything is kept): left out for such a PC. Its next update from a newer copy brings them.
 * "Welcome to TOMLIN.html": 2.0.50.
 */
export const NEWER_FILES = ['Welcome to TOMLIN.html'];
export const withoutNewer = (files: AppFile[]) => files.filter(f => !NEWER_FILES.includes(f.path));
/** The file name an older PC refused the copy for ("…not named as an app file (<name>)…"), or null. */
const refusedName = (e: unknown) => /not named as an app file \(([^)]+)\)/.exec(String((e as Error)?.message ?? e))?.[1] ?? null;
/** That PC refused the copy for a name it does not know from the TOMLIN name: sent again with forOlderNode. */
export const refusedNewNames = (e: unknown) => /^(Start|Install) TOMLIN\.cmd$/.test(refusedName(e) ?? '');
/** That PC refused the copy for a file newer than it (NEWER_FILES): sent again without them. */
export const refusedNewerFile = (e: unknown) => NEWER_FILES.includes(refusedName(e) ?? '');
/**
 * The same copy again for a PC that refused this one for a name it does not know, or null when the refusal was for
 * something else. Tried in turn: without the newer files (a TOMLIN-named PC before 2.0.50), then with the launcher
 * under its old name as well (a PC from before the TOMLIN name).
 */
export function retryFor(files: AppFile[], sent: AppFile[], e: unknown): AppFile[] | null {
  if (refusedNewNames(e)) return sent.some(f => f.from) ? null : forOlderNode(files);
  if (refusedNewerFile(e)) return sent.some(f => NEWER_FILES.includes(f.path)) ? withoutNewer(sent) : null;
  return null;
}

/** The launcher in a copy's folder: Start TOMLIN.cmd, or Start Shelby.cmd in a copy an older PC took under that name. */
export function launcherIn(root: string): string {
  const now = join(root, 'Start TOMLIN.cmd');
  return !existsSync(now) && existsSync(join(root, 'Start Shelby.cmd')) ? join(root, 'Start Shelby.cmd') : now;
}

/** Nothing larger is taken as an update (the app is about 300 MB unpacked). */
const MAX_TOTAL = 2 * 2 ** 30;
const MAX_FILES = 6000;

/** A path one PC names to another: inside one of the parts, plain names only, never a way out of the folder. */
export function safeAppPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length > 300 || p.includes('\\') || p.startsWith('/')) return null;
  const segs = p.split('/');
  if (segs.some(s => !s || s === '.' || s === '..' || !/^[\w@+()[\] .,=~-]+$/.test(s) || /[. ]$/.test(s))) return null;
  if (!PARTS.some(part => p === part || p.startsWith(`${part}/`))) return null;
  if (SKIP.test(p)) return null;
  return p;
}

/** The list a host sent, made safe: every path checked, sizes and hashes in form, no repeats, within the limits. */
export function cleanManifest(raw: unknown): AppFile[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'no files were named.';
  if (raw.length > MAX_FILES) return 'more files were named than an update holds.';
  const out: AppFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const r of raw) {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const path = safeAppPath(x.path);
    const bytes = Number.isSafeInteger(x.bytes) && (x.bytes as number) >= 0 ? (x.bytes as number) : -1;
    const sha = typeof x.sha === 'string' && /^[0-9a-f]{64}$/.test(x.sha) ? x.sha : '';
    if (!path || bytes < 0 || !sha) return `a file in the update was not named as an app file (${String(x.path ?? '').slice(0, 80)}), so the update was refused.`;
    if (seen.has(path.toLowerCase())) return 'a file was named twice.';
    seen.add(path.toLowerCase());
    total += bytes;
    out.push({ path, bytes, sha });
  }
  if (total > MAX_TOTAL) return 'the update is larger than an update can be.';
  for (const must of ['package.json', 'src/server.ts', 'Start TOMLIN.cmd']) if (!seen.has(must.toLowerCase())) return `the update has no ${must}, so it is not a whole copy.`;
  return out;
}

/** The version a list's package.json says, read by the node from the file once it is here. */
export async function versionIn(dir: string): Promise<string> {
  try {
    return String(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/** True when version a ("2.0.33") is later than b. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

export const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d{1,4}(\.\d{1,6}){1,3}$/.test(v);

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c as Buffer);
  return h.digest('hex');
}

/**
 * Every app file of the copy in `root`, as the release zip would hold it. Hashes are kept in `cache` by path, size and
 * time changed, so asking again costs only a folder listing.
 */
export async function appFiles(root: string, cache = new Map<string, { key: string; sha: string }>()): Promise<AppFile[]> {
  const out: AppFile[] = [];
  const add = async (rel: string) => {
    if (SKIP.test(rel)) return;
    const full = join(root, ...rel.split('/'));
    let s;
    try {
      s = await stat(full);
    } catch {
      return;
    }
    if (s.isDirectory()) {
      for (const n of (await readdir(full)).sort()) await add(`${rel}/${n}`);
      return;
    }
    if (!s.isFile()) return;
    const key = `${s.size}|${s.mtimeMs}`;
    let sha = cache.get(rel)?.key === key ? cache.get(rel)!.sha : '';
    if (!sha) {
      sha = await sha256(full);
      cache.set(rel, { key, sha });
    }
    out.push({ path: rel, bytes: s.size, sha });
  };
  for (const p of PARTS) await add(p);
  return out;
}

// ---- What code a copy is: its build id ----
// Twice one version number held two different apps (2.0.44 workers without git), so "up to date" and a linked PC's
// `can` list were believed wrongly. The build id is a short hash of the files that decide what runs, read once at start:
// the code (src, public, tools), the lists in registry, and package.json, package-lock.json and runtimes.json, which pin
// the packages and the model runners. Left out, so reading it stays well under a second: node_modules (thousands of
// files, pinned by package-lock.json), runtime/ (large programs, pinned by runtimes.json; a node keeps its own Node.js),
// models/helpers, the tests and the papers (they change nothing that runs), and the launchers (a PC from before the
// TOMLIN name takes Start TOMLIN.cmd under another name, so its copy would never match).

export const BUILD_PARTS = ['src', 'public', 'tools', 'registry', 'package.json', 'package-lock.json', 'runtimes.json'];
/** A build id as sent between PCs: 16 hex characters. */
export const isBuild = (b: unknown): b is string => typeof b === 'string' && /^[0-9a-f]{16}$/.test(b);
/** The 7 characters shown beside a version ("2.0.48, build 3f9c2a1"); '' when not known. */
export const shortBuild = (b: unknown): string => (isBuild(b) ? b.slice(0, 7) : '');
const inBuild = (path: string) => !SKIP.test(path) && BUILD_PARTS.some(p => path === p || path.startsWith(`${p}/`));

/** The build id of a list of app files (in any order; files outside BUILD_PARTS do not count). '' when none count. */
export function buildIdOf(files: readonly { path: string; sha: string }[]): string {
  const counted = files.filter(f => inBuild(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!counted.length) return '';
  const h = createHash('sha256');
  for (const f of counted) h.update(`${f.path}\0${f.sha}\n`);
  return h.digest('hex').slice(0, 16);
}

/**
 * The build id of the copy in `root`, read from its files ('' when it has none of them): the same as buildIdOf its app
 * file list, but the folders are listed and the files read 32 at a time (about 0.15 s for 220 files, against 0.6 to 1 s
 * one by one on a laptop with a virus checker).
 */
export async function buildId(root: string): Promise<string> {
  const paths: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (SKIP.test(rel)) return;
    try {
      const items = await readdir(join(root, ...rel.split('/')), { withFileTypes: true });
      await Promise.all(items.map(e => (e.isDirectory() ? walk(`${rel}/${e.name}`) : e.isFile() && !SKIP.test(`${rel}/${e.name}`) ? void paths.push(`${rel}/${e.name}`) : undefined)));
    } catch (e) {
      // A part that is one file (package.json) is not a folder; a part that is not there counts as nothing.
      if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') paths.push(rel);
    }
  };
  await Promise.all(BUILD_PARTS.map(walk));
  const files: { path: string; sha: string }[] = [];
  for (let k = 0; k < paths.length; k += 32) {
    files.push(...(await Promise.all(paths.slice(k, k + 32).map(async path => ({ path, sha: createHash('sha256').update(await readFile(join(root, ...path.split('/')))).digest('hex') })))));
  }
  return buildIdOf(files);
}

/**
 * How a linked PC's copy stands against this one: 'older' (a lower version), 'other' (the same version but other files:
 * both build ids known and different), or null (the same, newer, or not known). A PC that sends no build id (an older
 * TOMLIN) is judged by its version alone, as before.
 */
export function standing(pc: { version: string; build?: string }, mine: string, mineBuild = ''): 'older' | 'other' | null {
  if (!pc.version) return null;
  if (newer(mine, pc.version)) return 'older';
  const same = !newer(pc.version, mine);
  return same && isBuild(pc.build) && isBuild(mineBuild) && pc.build !== mineBuild ? 'other' : null;
}

/** The folder the new version goes in, beside the old copy: "tomlin-<version>", or with " (2)" when that name is taken. */
export async function newFolder(parent: string, version: string): Promise<string> {
  for (let k = 1; k < 50; k++) {
    const dir = join(parent, k === 1 ? `tomlin-${version}` : `tomlin-${version} (${k})`);
    if (!(await sizeOf(join(dir, 'package.json'))) && !(await exists(dir))) return dir;
  }
  throw new Error('there are too many copies of that version beside this one.');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---- The node's side ----

export interface UpdateNodeDeps {
  /** This copy's app folder and version. */
  root: string;
  version: string;
  /** This copy's build id ('' while it is still being read at start). */
  build?: () => string;
  /** Its owner ticked "Allow host to update TOMLIN remotely". */
  allowed: () => boolean;
  pcName: () => string;
  /** Started by Start TOMLIN.cmd, which can start the new copy (a copy started another way cannot restart itself). */
  restarts: boolean;
  /** What this PC is doing for someone now (an answer, a picture, a copy), or null when nothing. */
  busy: () => string | null;
  freeBytes?: (dir: string) => Promise<number>;
  /** The new copy is whole in `dir`: note who updated it, point "start with Windows" at it, write next-copy.txt, end. */
  done: (dir: string, version: string, by: string) => Promise<void>;
}

const no = (status: number, error: string) => ({ status, json: { error } as Record<string, unknown> });

/** An update's files while they come in, beside the app's copies (.shelby- before the TOMLIN name). */
const INCOMING = /^\.(tomlin|shelby)-\d+\.\d+\.\d+-incoming$/;
/** An update left half way stays to be carried on, but not for ever: at start, one untouched this long is removed. */
export const INCOMING_DAYS = 3;

/**
 * Removes the incoming folders in `parent` other than `keep`: all of them (an offer of another version), or only those
 * untouched for `olderMs` (at start, when no update is coming in yet). Never anything but those folders.
 */
export async function sweepIncoming(parent: string, keep: string, olderMs: number, now = Date.now()): Promise<string[]> {
  const gone: string[] = [];
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    const dir = join(parent, name);
    if (!INCOMING.test(name) || dir === keep) continue;
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory() || (olderMs > 0 && now - st.mtimeMs < olderMs)) continue;
    await rm(dir, { recursive: true, force: true }).then(() => gone.push(name), () => undefined);
  }
  return gone;
}

/** The doors of a node for updates: /worker/update-offer, -put, -finish, -drop. */
export function updateSide(d: UpdateNodeDeps) {
  const room = d.freeBytes ?? freeBytes;
  const cache = new Map<string, { key: string; sha: string }>();
  /** The update coming in now: one at a time, from one PC. */
  let current: { version: string; build: string; files: AppFile[]; staging: string; from: string; fromName: string; at: number } | null = null;
  /** The new copy is whole and this one is ending so it starts: said on this PC's own screen until it ends. */
  let starting: { version: string; fromName: string } | null = null;
  // Updates left half way days ago (the sending PC never came back) are cleared once, at start.
  const swept = sweepIncoming(dirname(d.root), '', INCOMING_DAYS * 24 * 3600_000).catch(() => [] as string[]);

  // The same version is taken too when it is other files (both build ids known and different): the build id says what
  // code each copy is, so one number held by two apps no longer stops the update.
  const why = (version: unknown, build?: unknown): string | null => {
    if (!d.allowed()) return `"${d.pcName()}" does not let other PCs update TOMLIN there now (its owner ticks "Allow host to update TOMLIN remotely" under Nodes and memory).`;
    if (!d.restarts) return `TOMLIN on "${d.pcName()}" was not started by its installed program or Start TOMLIN.cmd, so it cannot start the new version by itself. Install it there with Install TOMLIN.cmd (or start it with Start TOMLIN.cmd), then update it again.`;
    if (!isVersion(version)) return 'the update did not say its version.';
    if (newer(version, d.version)) return null;
    const own = d.build?.() ?? '';
    if (!d.build || newer(d.version, version) || !isBuild(build)) return `"${d.pcName()}" already runs TOMLIN ${d.version}: only a newer version is taken (or the same one with different files).`;
    if (!isBuild(own)) return `"${d.pcName()}" is still reading its own files after starting, so it cannot yet tell whether they differ. Press Update it again in a minute.`;
    if (own === build) return `"${d.pcName()}" already runs TOMLIN ${d.version} with the same files (build ${shortBuild(own)}): there is nothing to update.`;
    return null;
  };
  const mine = (b: Record<string, unknown>, who: string) => {
    if (!current || current.version !== b.version || current.from !== who) return null;
    current.at = Date.now();
    return current;
  };

  const handle = async function handle(p: string, b: Record<string, unknown>, who: { key: string; name: string }, piece?: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
    switch (p) {
      case '/worker/update-offer': {
        const refused = why(b.version, b.build);
        if (refused) return no(403, refused);
        if (current && current.from !== who.key && Date.now() - current.at < 10 * 60_000) return no(409, `another PC is updating "${d.pcName()}" now.`);
        const files = cleanManifest(b.files);
        if (typeof files === 'string') return no(400, files);
        // The build named must be the files listed: else the new copy would be another build than the one sent.
        const build = isBuild(b.build) ? b.build : '';
        if (build && buildIdOf(files) !== build) return no(400, `the list of files is not build ${shortBuild(build)} as sent, so the update was refused. Close TOMLIN on the sending PC, start it again, then update again.`);
        const version = b.version as string;
        const staging = join(dirname(d.root), `.tomlin-${version}-incoming`);
        // Only this version's half-come files are carried on: any other version's (this run's or an earlier one's) go.
        await swept;
        await sweepIncoming(dirname(d.root), staging, 0);
        // What this copy has already (the same file, byte for byte) is copied here at the end; only the rest crosses.
        const own = new Map((await appFiles(d.root, cache)).map(f => [f.path, f.sha]));
        const need: number[] = [];
        const at: number[] = [];
        for (const [k, f] of files.entries()) {
          if (own.get(f.path) === f.sha) continue;
          const there = join(staging, ...f.path.split('/'));
          if ((await sizeOf(there)) === f.bytes && (await exists(there))) continue;
          need.push(k);
          at.push(Math.min(await sizeOf(partOf(there)), f.bytes));
        }
        const total = files.reduce((n, f) => n + f.bytes, 0);
        const full = roomWhy(total, await room(dirname(d.root)), `"${d.pcName()}"`);
        if (full) return no(507, full);
        current = { version, build, files, staging, from: who.key, fromName: who.name, at: Date.now() };
        return { status: 200, json: { need, at, bytes: need.reduce((n, k) => n + files[k].bytes, 0) } };
      }
      case '/worker/update-put': {
        const c = mine(b, who.key);
        if (!c) return no(409, 'that update is not the one coming in here now: start it again.');
        if (!d.allowed()) return no(403, why(b.version, c.build)!);
        const f = c.files[Number(b.file)];
        if (!f || !piece) return no(400, 'that piece is not part of the update.');
        const dest = join(c.staging, ...f.path.split('/'));
        const r = await addPiece(partOf(dest), Number(b.from), piece);
        if ('error' in r) return { status: 409, json: r };
        if (r.at > f.bytes) {
          await rm(partOf(dest), { force: true });
          return no(400, 'more came than the file holds, so it was thrown away. Start the update again.');
        }
        if (r.at === f.bytes) {
          if ((await sha256(partOf(dest))) !== f.sha) {
            await rm(partOf(dest), { force: true });
            return no(400, `${f.path} did not arrive as it was sent, so it was thrown away. Start the update again.`);
          }
          await rename(partOf(dest), dest);
        }
        return { status: 200, json: { at: r.at } };
      }
      case '/worker/update-finish': {
        const c = mine(b, who.key);
        if (!c) return no(409, 'that update is not the one coming in here now: start it again.');
        const refused = why(b.version, c.build);
        if (refused) return no(403, refused);
        const busy = d.busy();
        if (busy) return { status: 200, json: { busy } };
        const own = new Map((await appFiles(d.root, cache)).map(f => [f.path, f]));
        for (const f of c.files) {
          const dest = join(c.staging, ...f.path.split('/'));
          if ((await sizeOf(dest)) === f.bytes && (await exists(dest))) continue;
          await mkdir(dirname(dest), { recursive: true });
          if (own.get(f.path)?.sha === f.sha) await copyFile(join(d.root, ...f.path.split('/')), dest);
          // An empty file never crosses as a piece: it is made here.
          else if (f.bytes === 0) await writeFile(dest, '');
          else return no(409, `${f.path} has not come in yet: start the update again.`);
        }
        // The new copy must be exactly the list: every file, its size, its hash (the copied ones are read again too).
        for (const f of c.files) {
          const dest = join(c.staging, ...f.path.split('/'));
          if ((await sizeOf(dest)) !== f.bytes || (f.bytes > 0 && (await sha256(dest)) !== f.sha)) {
            // Thrown away, so the next try sends it again (else its size would pass for whole).
            await rm(dest, { force: true });
            return no(409, `${f.path} is not as it was sent: start the update again.`);
          }
        }
        const said = await versionIn(c.staging);
        if (said !== c.version) return no(400, `the files that came in say TOMLIN ${said || '(no version)'}, not ${c.version} as sent, so they were not used. The sending PC's folder changed after its TOMLIN started: close TOMLIN there, start it again, then update again.`);
        // Its own Node.js, when the update brings none: the new copy must still start without one installed.
        for (const k of KEEP_OWN_DIRS) {
          if (c.files.some(f => f.path.startsWith(`${k}/`))) continue;
          for (const f of [...own.values()].filter(f => f.path.startsWith(`${k}/`))) {
            const to = join(c.staging, ...f.path.split('/'));
            await mkdir(dirname(to), { recursive: true });
            await copyFile(join(d.root, ...f.path.split('/')), to);
          }
        }
        for (const dir of ['models/chat', 'models/image/loras']) await mkdir(join(c.staging, ...dir.split('/')), { recursive: true });
        // Checked again after the long check of every file: something started meanwhile finishes before the restart.
        const busyNow = d.busy();
        if (busyNow) return { status: 200, json: { busy: busyNow } };
        const final = await newFolder(dirname(d.root), c.version);
        await rename(c.staging, final);
        const version = c.version;
        current = null;
        starting = { version, fromName: who.name };
        await d.done(final, version, who.name);
        return { status: 200, json: { done: true, folder: basename(final) } };
      }
      case '/worker/update-drop': {
        const c = mine(b, who.key);
        if (c) {
          await rm(c.staging, { recursive: true, force: true });
          current = null;
        }
        return { status: 200, json: { ok: true } };
      }
      default:
        return no(404, 'this PC does not know that door.');
    }
  };
  /**
   * For this PC's own screen ("Keep this window open"): an update coming in now (heard from in the last 2 minutes; a PC
   * that went quiet longer is not updating it any more), or the new version starting.
   */
  const incoming = (now = Date.now()): { version: string; from: string; starting: boolean } | null =>
    starting ? { version: starting.version, from: starting.fromName, starting: true }
      : current && now - current.at < 2 * 60_000 ? { version: current.version, from: current.fromName, starting: false } : null;
  return Object.assign(handle, { incoming, swept });
}

// ---- The host's side ----

/**
 * Why a linked PC cannot be updated from here now ('' when it can; null when it is not behind this PC). Behind: a lower
 * version, or the same version with other files (see standing; a PC that sends no build id goes by its version).
 */
export function updateWhy(pc: { name: string; ok: boolean; version: string; build?: string; away: string | null; can: string[]; restarts: boolean; allowUpdate: boolean }, mine: string, mineBuild = ''): string | null {
  if (!pc.ok) return standing(pc, mine, mineBuild) ? `"${pc.name}" is off or not answering now` : null;
  if (!standing(pc, mine, mineBuild)) return null;
  if (!pc.can.includes('update')) return `"${pc.name}" runs ${pc.version}, which cannot be updated from another PC: install ${mine} there by hand this once (Install TOMLIN.cmd; from then on it can be updated from here)`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.restarts) return `TOMLIN on "${pc.name}" was not started by its installed program or Start TOMLIN.cmd, so it cannot start the new version by itself`;
  if (!pc.allowUpdate) return `"${pc.name}" does not let other PCs update TOMLIN there (its owner can tick "Allow host to update TOMLIN remotely" there)`;
  return '';
}

/**
 * Sends this copy to a linked PC: the list, then only the files it does not have, then "finish". While that PC works
 * for someone it is asked again every 10 seconds (up to 15 minutes). Gives the new folder's name there.
 */
export async function pushUpdate(w: Wire, o: { version: string; root: string; files: AppFile[]; progress: (p: Partial<Progress> & { stage?: 'compare' | 'send' | 'start' }) => void; signal: AbortSignal; waiting?: (busy: string) => void; wait?: (ms: number) => Promise<void> }): Promise<string> {
  const wait = o.wait ?? (ms => new Promise(r => setTimeout(r, ms)));
  o.progress({ stage: 'compare' });
  // The build id of exactly these files: a node at the same version takes them when its own build differs (an older
  // node ignores it and goes by the version, as before).
  const build = buildIdOf(o.files);
  const offer = await w.ask('/worker/update-offer', { version: o.version, build, files: o.files.map(({ path, bytes, sha }) => ({ path, bytes, sha })) });
  const need = (Array.isArray(offer.need) ? offer.need : []).map(Number);
  const at0 = (Array.isArray(offer.at) ? offer.at : []).map(Number);
  const bytes = need.reduce((n, k) => n + (o.files[k]?.bytes ?? 0), 0);
  let before = 0;
  o.progress({ stage: 'send', done: 0, bytes });
  const stop = async () => {
    await w.ask('/worker/update-drop', { version: o.version }).catch(() => undefined);
    throw new Error('Stopped.');
  };
  for (const [j, k] of need.entries()) {
    const f = o.files[k];
    if (!f) throw new Error('that PC asked for a file that is not in the update.');
    for (let at = Math.max(0, Math.min(at0[j] || 0, f.bytes)); at < f.bytes;) {
      if (o.signal.aborted) await stop();
      o.progress({ done: before + at, bytes });
      const r = await w.putPiece('/worker/update-put', { version: o.version, file: k, from: at }, await readPiece(join(o.root, ...(f.from ?? f.path).split('/')), at));
      at = Number(r.at);
      if (!Number.isSafeInteger(at) || at < 0) throw new Error('that PC did not say how much it has.');
    }
    before += f.bytes;
  }
  o.progress({ done: bytes, bytes, stage: 'start' });
  for (let t0 = Date.now(); ;) {
    if (o.signal.aborted) await stop();
    const r = await w.ask('/worker/update-finish', { version: o.version });
    if (r.done === true) return String(r.folder ?? '');
    if (typeof r.busy !== 'string') throw new Error('that PC did not finish the update.');
    if (Date.now() - t0 > 15 * 60_000) throw new Error(`that PC was still busy after 15 minutes (${r.busy}). Press Update it again later: what came over is kept.`);
    o.waiting?.(r.busy);
    await wait(10_000);
  }
}

// ---- A TOMLIN zip uploaded on this PC ----

/**
 * Why a TOMLIN zip uploaded under Nodes and memory (src/server/selfupdate.ts) cannot be this PC's next copy ('' when
 * it can): its package.json, the key files missing from it, its build id; then this copy's version and build.
 */
export function zipWhy(pkg: { name?: unknown; version?: unknown }, missing: string[], build: string, mine: string, mineBuild: string): string {
  if (pkg.name !== 'tomlin' || !isVersion(pkg.version)) return 'That zip is not a TOMLIN release: its package.json is not TOMLIN\'s. Pick the tomlin-<version>.zip file.';
  if (missing.length) return `That zip is not a whole TOMLIN: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from it. Download the zip again, then upload it here.`;
  const version = pkg.version;
  if (newer(mine, version)) return `That zip holds TOMLIN ${version}, older than the ${mine} this PC runs, so it was not used. Only a newer version is taken here (or the same one with other files).`;
  if (!newer(version, mine) && (!isBuild(build) || !isBuild(mineBuild) || build === mineBuild)) return `This PC already runs TOMLIN ${mine}${isBuild(build) && build === mineBuild ? ' with the same files' : ''}: there is nothing to update.`;
  return '';
}
