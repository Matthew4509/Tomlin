// Project backups kept on a node as a local git repository (Network, "Enable backups"). The node keeps one bare
// repository for each host that backs up to it ("backups from other PCs/<pc>/projects.git"): every backup is a commit
// of the host's whole workspace (its projects), so older versions stay, and only files the node does not have yet
// cross the network. It is a normal git repository (loose objects, refs/heads/main): git, GitHub Desktop or VS Code can
// open or clone it, so the projects can be taken out on the node even if the host PC is gone.
// Written here with Node's own zlib and SHA-1, no git program or package: blobs, trees, commits and one branch.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflate, createInflate, deflateSync, inflateSync } from 'node:zlib';
import { writeAtomic } from './atomic.ts';

/** The branch every backup is a commit on. */
export const BRANCH = 'refs/heads/main';
/** Who the commits are by: never a person's name or address. */
const BY = 'TOMLIN <backup@tomlin.invalid>';
/** Folders a backup leaves out (a project's own git, and downloaded packages that can be fetched again). */
export const SKIP_DIRS = new Set(['.git', 'node_modules']);

export const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

/** The git id of a file's contents (a blob): SHA-1 of "blob <size>\0" and the bytes. */
export function blobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** The git id of a file on disk, read as a stream (files can be gigabytes). */
export async function blobIdOfFile(file: string): Promise<{ id: string; bytes: number }> {
  const bytes = (await stat(file)).size;
  const h = createHash('sha1').update(`blob ${bytes}\0`);
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return { id: h.digest('hex'), bytes };
}

/** A path inside the workspace as a backup names it: forward slashes, no empty, "." or ".." parts, no .git folder. */
export function safePath(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 1000 || /[\u0000-\u001f\\:*?"<>|]/.test(v)) return null;
  const parts = v.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || p.length > 255 || / $|\.$/.test(p))) return null;
  return v;
}

// ---- The repository ----

const objPath = (repo: string, id: string) => join(repo, 'objects', id.slice(0, 2), id.slice(2));

/** Makes an empty bare repository at `repo` (nothing is changed when there is one). */
export async function initRepo(repo: string): Promise<void> {
  await mkdir(join(repo, 'objects'), { recursive: true });
  await mkdir(join(repo, 'refs', 'heads'), { recursive: true });
  await mkdir(join(repo, 'refs', 'tags'), { recursive: true });
  const head = join(repo, 'HEAD');
  if (!(await exists(head))) await writeFile(head, `ref: ${BRANCH}\n`);
  const config = join(repo, 'config');
  if (!(await exists(config))) await writeFile(config, '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export const hasObject = (repo: string, id: string) => exists(objPath(repo, id));

/** Writes one object (small: a tree or a commit) when it is not there yet. Gives its id. */
export async function writeObject(repo: string, type: 'blob' | 'tree' | 'commit', content: Buffer): Promise<string> {
  const head = Buffer.from(`${type} ${content.length}\0`);
  const id = createHash('sha1').update(head).update(content).digest('hex');
  const file = objPath(repo, id);
  if (await exists(file)) return id;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, deflateSync(Buffer.concat([head, content])));
  await rename(tmp, file).catch(async e => {
    await rm(tmp, { force: true });
    if (!(await exists(file))) throw e;
  });
  return id;
}

/**
 * Stores a file as a blob, read as a stream, only when its contents have the id `want` (a file that came over the
 * network is checked before it is kept). False when the contents did not match: nothing is kept.
 */
export async function storeBlobFile(repo: string, file: string, want: string): Promise<boolean> {
  const dest = objPath(repo, want);
  if (await exists(dest)) return true;
  const bytes = (await stat(file)).size;
  const h = createHash('sha1');
  const head = Buffer.from(`blob ${bytes}\0`);
  h.update(head);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const deflate = createDeflate();
  deflate.write(head);
  const hashing = new Transform({
    transform(chunk: Buffer, _enc, done) {
      h.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(file), hashing, deflate, createWriteStream(tmp));
  if (h.digest('hex') !== want) {
    await rm(tmp, { force: true });
    return false;
  }
  await rename(tmp, dest).catch(async e => {
    await rm(tmp, { force: true });
    if (!(await exists(dest))) throw e;
  });
  return true;
}

/** Reads one object whole (a tree or a commit; a blob only when small). */
export async function readObject(repo: string, id: string): Promise<{ type: string; content: Buffer }> {
  const raw = inflateSync(await readFile(objPath(repo, id)));
  const nul = raw.indexOf(0);
  const [type] = raw.subarray(0, nul).toString().split(' ');
  return { type, content: raw.subarray(nul + 1) };
}

/** Streams a blob's contents out of the repository into `dest`. Gives its size. */
export async function blobToFile(repo: string, id: string, dest: string): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  let seen = false;
  let bytes = 0;
  const strip = new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (seen) {
        bytes += chunk.length;
        return done(null, chunk);
      }
      const nul = chunk.indexOf(0);
      if (nul < 0) return done();
      seen = true;
      const rest = chunk.subarray(nul + 1);
      bytes += rest.length;
      done(null, rest);
    },
  });
  const tmp = `${dest}.part`;
  await pipeline(createReadStream(objPath(repo, id)), createInflate(), strip, createWriteStream(tmp));
  await rm(dest, { force: true });
  await rename(tmp, dest);
  return bytes;
}

/** A blob's size, read from the start of its object (the rest is not unpacked). */
export async function blobSize(repo: string, id: string): Promise<number> {
  const stream = createReadStream(objPath(repo, id), { highWaterMark: 4096 });
  const inflate = createInflate();
  let got = Buffer.alloc(0);
  try {
    for await (const chunk of stream.pipe(inflate)) {
      got = Buffer.concat([got, chunk as Buffer]);
      const nul = got.indexOf(0);
      if (nul >= 0) return Number(got.subarray(0, nul).toString().split(' ')[1]) || 0;
      if (got.length > 64) break;
    }
  } finally {
    stream.destroy();
    inflate.destroy();
  }
  return 0;
}

// ---- Trees and commits ----

export interface Entry {
  /** Inside the workspace, with forward slashes. */
  path: string;
  id: string;
}

/** Writes the trees for a flat list of files (folders made from the paths). Gives the top tree's id. */
export async function writeTree(repo: string, files: Entry[]): Promise<string> {
  interface Dir { files: Map<string, string>; dirs: Map<string, Dir> }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    for (const p of parts.slice(0, -1)) {
      let next = at.dirs.get(p);
      if (!next) at.dirs.set(p, (next = { files: new Map(), dirs: new Map() }));
      at = next;
    }
    at.files.set(parts[parts.length - 1], f.id);
  }
  const write = async (dir: Dir): Promise<string> => {
    const rows: { name: string; sort: string; mode: string; id: string }[] = [];
    for (const [name, sub] of dir.dirs) rows.push({ name, sort: `${name}/`, mode: '40000', id: await write(sub) });
    for (const [name, id] of dir.files) if (!dir.dirs.has(name)) rows.push({ name, sort: name, mode: '100644', id });
    // Git orders a tree's entries by their bytes, a folder as if its name ended in "/".
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    return writeObject(repo, 'tree', Buffer.concat(rows.flatMap(r => [Buffer.from(`${r.mode} ${r.name}\0`), Buffer.from(r.id, 'hex')])));
  };
  return write(root);
}

/** The rows of a tree object: each one's mode, name and id. */
function treeRows(content: Buffer): { mode: string; name: string; id: string }[] {
  const rows: { mode: string; name: string; id: string }[] = [];
  for (let at = 0; at < content.length;) {
    const sp = content.indexOf(0x20, at);
    const nul = content.indexOf(0, sp);
    rows.push({ mode: content.subarray(at, sp).toString(), name: content.subarray(sp + 1, nul).toString(), id: content.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return rows;
}

/** Every file a tree holds, with its path. */
export async function listTree(repo: string, tree: string, prefix = ''): Promise<Entry[]> {
  const { content } = await readObject(repo, tree);
  const out: Entry[] = [];
  for (const { mode, name, id } of treeRows(content)) {
    if (mode === '40000') out.push(...(await listTree(repo, id, `${prefix}${name}/`)));
    else out.push({ path: `${prefix}${name}`, id });
  }
  return out;
}

export interface Commit {
  id: string;
  tree: string;
  parent: string | null;
  /** When it was made (ms). */
  at: number;
  message: string;
}

/** The newest commit on the branch, or null for an empty repository. */
export async function headOf(repo: string): Promise<string | null> {
  try {
    const id = (await readFile(join(repo, ...BRANCH.split('/')), 'utf8')).trim();
    return isId(id) ? id : null;
  } catch {
    return null;
  }
}

export async function readCommit(repo: string, id: string): Promise<Commit> {
  const { type, content } = await readObject(repo, id);
  if (type !== 'commit') throw new Error('that is not a commit');
  const text = content.toString();
  const [head, ...rest] = text.split('\n\n');
  const line = (k: string) => head.split('\n').find(l => l.startsWith(`${k} `))?.slice(k.length + 1) ?? '';
  const when = /\s(\d+)\s[+-]\d{4}$/.exec(line('committer'));
  return { id, tree: line('tree'), parent: line('parent') || null, at: when ? Number(when[1]) * 1000 : 0, message: rest.join('\n\n').trim() };
}

/**
 * Makes a commit of `files` on the branch (its parent the newest one), unless the files are the same as the newest
 * commit's. Every file must be stored already. Gives the commit (the newest one when nothing changed). Runs in the
 * repository's turn, so a trim (trimRepo) never sweeps a file between the check that it is here and the commit.
 */
export function commitFiles(repo: string, files: Entry[], message: string, now = Date.now()): Promise<{ id: string; same: boolean }> {
  return inRepoTurn(repo, () => commitNow(repo, files, message, now));
}

async function commitNow(repo: string, files: Entry[], message: string, now: number): Promise<{ id: string; same: boolean }> {
  await initRepo(repo);
  for (const f of files) if (!(await hasObject(repo, f.id))) throw new Error(`a file of the backup is missing here (${f.path})`);
  const tree = await writeTree(repo, files);
  const parent = await headOf(repo);
  if (parent && (await readCommit(repo, parent)).tree === tree) return { id: parent, same: true };
  const when = `${Math.floor(now / 1000)} +0000`;
  const text = `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${BY} ${when}\ncommitter ${BY} ${when}\n\n${message.replace(/\r/g, '').trim()}\n`;
  const id = await writeObject(repo, 'commit', Buffer.from(text));
  const ref = join(repo, ...BRANCH.split('/'));
  await mkdir(dirname(ref), { recursive: true });
  await writeFile(`${ref}.tmp`, `${id}\n`);
  await rename(`${ref}.tmp`, ref);
  return { id, same: false };
}

/**
 * The newest commits, newest first (at most `max`). The history stops at a commit whose older history was let go
 * (trimRepo), and at a parent that is not here any more.
 */
export async function logOf(repo: string, max = 30): Promise<Commit[]> {
  const cut = await shallowOf(repo);
  const out: Commit[] = [];
  for (let id = await headOf(repo); id && out.length < max;) {
    let c: Commit;
    try {
      c = await readCommit(repo, id);
    } catch (e) {
      // An older commit swept away: the history ends here. The newest one unreadable is a fault, said as before.
      if (out.length && !(await hasObject(repo, id))) break;
      throw e;
    }
    out.push(c);
    id = cut.has(c.id) ? null : c.parent;
  }
  return out;
}

// ---- Keeping the repository from growing for ever ----

/**
 * Commits kept in each repository: the newest ones. The host lists the newest 30 (/worker/git-log), so every backup it
 * shows can still be brought back. With a backup every 10 minutes while files change, that is at least 5 hours of them.
 */
export const KEEP_COMMITS = 30;
/**
 * An object written this recently is never swept: a backup sends its files first and names them in its commit only at
 * the end, which on a slow link can be hours later. It also keeps the last day's versions a while after they are let go.
 */
export const SWEEP_GRACE_MS = 24 * 3600_000;
/** Git's own file naming the commits whose older history is not here: git and this module both stop there. */
const SHALLOW = 'shallow';

const turns = new Map<string, Promise<unknown>>();
/** Runs `job` in `repo`'s turn: a commit and a trim of one repository never run at the same time. */
export function inRepoTurn<T>(repo: string, job: () => Promise<T>): Promise<T> {
  const key = resolve(repo).toLowerCase();
  const turn = (turns.get(key) ?? Promise.resolve()).then(job);
  const settled = turn.then(() => undefined, () => undefined);
  turns.set(key, settled);
  void settled.then(() => { if (turns.get(key) === settled) turns.delete(key); });
  return turn;
}

/** The commits whose parents were let go (the "shallow" file); none when there is no such file. */
export async function shallowOf(repo: string): Promise<Set<string>> {
  try {
    return new Set((await readFile(join(repo, SHALLOW), 'utf8')).split(/\r?\n/).map(l => l.trim()).filter(isId));
  } catch {
    return new Set();
  }
}

/**
 * Adds to `seen` every object commit `c` reaches (the commit, its trees, its files) that is not in it yet, and gives
 * those new ids. A tree already seen is not read again (all it holds was counted with it). Throws when a tree cannot
 * be read: what it holds is not known, so nothing may be swept on that count.
 */
export async function reachOf(repo: string, c: Commit, seen: Set<string>): Promise<string[]> {
  const fresh: string[] = [];
  const add = (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    fresh.push(id);
    return true;
  };
  const walk = async (tree: string): Promise<void> => {
    if (!add(tree)) return;
    const { type, content } = await readObject(repo, tree);
    if (type !== 'tree') throw new Error(`${tree} is not a folder of the backup`);
    for (const r of treeRows(content)) {
      if (r.mode === '40000') await walk(r.id);
      else add(r.id);
    }
  };
  add(c.id);
  await walk(c.tree);
  return fresh;
}

/** A folder that is a folder itself, not a junction or link to one somewhere else. */
export const realFolder = (dir: string): Promise<boolean> => lstat(dir).then(s => s.isDirectory() && !s.isSymbolicLink(), () => false);

/** The bytes one object takes on the disk (0 when it is not here). */
export const objectBytes = (repo: string, id: string): Promise<number> => stat(objPath(repo, id)).then(s => s.size, () => 0);

export interface Trimmed {
  /** Older commits let go this time. */
  commits: number;
  /** Object files swept away, and their bytes. */
  objects: number;
  bytes: number;
}

/**
 * Keeps the newest `keep` commits of `repo` (fewer with `oldest`: none older than that commit) and lets the older
 * history go, then sweeps away what no kept commit needs.
 * In this order, so a stop at any point (a crash, a power cut) never loses what a kept commit needs: first the cut is
 * written to git's own "shallow" file (whole or not at all), so neither git nor TOMLIN reads past it; then every object
 * the kept commits reach is read; only then are the others deleted. A tree that cannot be read stops it before anything
 * is deleted.
 * May delete: only files directly in <repo>/objects/<two hex digits>/ named as a git object (38 hex digits) or as the
 * temporary copy writeObject or storeBlobFile makes (38 hex digits, ".<number>.tmp"), that no kept commit reaches and
 * that were not written in the last `graceMs`. Never a folder, never the branch, never anything else, and never
 * through a junction or link (an objects folder that is one is not swept at all).
 * Runs in the repository's turn (a backup's commit waits for it). Never throws: a repository it cannot read is left as it is.
 */
export async function trimRepo(repo: string, o: { keep?: number; oldest?: string; graceMs?: number; now?: number } = {}): Promise<Trimmed> {
  const none: Trimmed = { commits: 0, objects: 0, bytes: 0 };
  try {
    return await inRepoTurn(repo, async () => {
      const log = await logOf(repo, Math.max(1, o.keep ?? KEEP_COMMITS));
      // No branch (an empty repository, or its branch file unreadable): nothing is known to be kept, so nothing goes.
      if (!log.length) return none;
      const at = o.oldest ? log.findIndex(c => c.id === o.oldest) : -1;
      const kept = at >= 0 ? log.slice(0, at + 1) : log;
      const last = kept[kept.length - 1];
      let commits = 0;
      const cut = await shallowOf(repo);
      if (last.parent && !cut.has(last.id)) {
        // Counted before the cut (the commits let go, as far as they are still here).
        for (let id: string | null = last.parent; id && commits < 100_000;) {
          const c: Commit | null = await readCommit(repo, id).catch(() => null);
          if (!c) break;
          commits++;
          id = cut.has(c.id) ? null : c.parent;
        }
        await writeAtomic(join(repo, SHALLOW), `${last.id}\n`);
      }
      const seen = new Set<string>();
      for (const c of kept) await reachOf(repo, c, seen);
      const now = o.now ?? Date.now();
      const grace = o.graceMs ?? SWEEP_GRACE_MS;
      let objects = 0;
      let bytes = 0;
      const top = join(repo, 'objects');
      // A junction or link (the objects folder, or one of its folders) is never followed: what it leads to is not this
      // repository's to sweep.
      if (!(await realFolder(top))) return { commits, objects: 0, bytes: 0 };
      for (const e of await readdir(top, { withFileTypes: true }).catch(() => [])) {
        const d = e.name;
        if (!e.isDirectory() || !/^[0-9a-f]{2}$/.test(d)) continue;
        for (const n of await readdir(join(top, d)).catch(() => [] as string[])) {
          const obj = /^[0-9a-f]{38}$/.test(n);
          if (!obj && !/^[0-9a-f]{38}\.\d+\.tmp$/.test(n)) continue;
          if (obj && seen.has(d + n)) continue;
          const file = join(top, d, n);
          const s = await stat(file).catch(() => null);
          if (!s?.isFile() || now - s.mtimeMs < grace) continue;
          if (await rm(file, { force: true }).then(() => true, () => false)) {
            objects++;
            bytes += s.size;
          }
        }
      }
      return { commits, objects, bytes };
    });
  } catch {
    return none;
  }
}

// ---- The host's workspace ----

export interface WorkFile {
  path: string;
  full: string;
  bytes: number;
  mtime: number;
}

/** Every file of the workspace a backup takes (not .git or node_modules folders, not links), at most `max`. */
export async function workFiles(root: string, max = 100_000): Promise<{ files: WorkFile[]; more: boolean }> {
  const files: WorkFile[] = [];
  let more = false;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      if (files.length >= max) {
        more = true;
        return;
      }
      const path = rel ? `${rel}/${n.name}` : n.name;
      const full = join(dir, n.name);
      if (n.isDirectory()) {
        if (!SKIP_DIRS.has(n.name.toLowerCase())) await walk(full, path);
      } else if (n.isFile() && safePath(path) && !n.name.endsWith('.part')) {
        try {
          const s = await stat(full);
          files.push({ path, full, bytes: s.size, mtime: s.mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  await walk(root, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, more };
}

/** One line per file (path, size, time): the same when nothing in the workspace changed since. */
export function signature(files: WorkFile[]): string {
  const h = createHash('sha1');
  for (const f of files) h.update(`${f.path}|${f.bytes}|${Math.round(f.mtime)}\n`);
  return h.digest('hex');
}
