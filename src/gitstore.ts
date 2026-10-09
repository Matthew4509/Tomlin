// Project backups kept on a node as a local git repository (Nodes and memory, "Enable backups"). The node keeps one bare
// repository for each host that backs up to it ("backups from other PCs/<pc>/projects.git"): every backup is a commit
// of the host's whole workspace (its projects), so older versions stay, and only files the node does not have yet
// cross the network. It is a normal git repository (loose objects, refs/heads/main): git, GitHub Desktop or VS Code can
// open or clone it, so the projects can be taken out on the node even if the host PC is gone.
// Written here with Node's own zlib and SHA-1, no git program or package: blobs, trees, commits and one branch.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflate, createInflate, deflateSync, inflateSync } from 'node:zlib';

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

/** Every file a tree holds, with its path. */
export async function listTree(repo: string, tree: string, prefix = ''): Promise<Entry[]> {
  const { content } = await readObject(repo, tree);
  const out: Entry[] = [];
  for (let at = 0; at < content.length;) {
    const sp = content.indexOf(0x20, at);
    const nul = content.indexOf(0, sp);
    const mode = content.subarray(at, sp).toString();
    const name = content.subarray(sp + 1, nul).toString();
    const id = content.subarray(nul + 1, nul + 21).toString('hex');
    at = nul + 21;
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
 * commit's. Every file must be stored already. Gives the commit (the newest one when nothing changed).
 */
export async function commitFiles(repo: string, files: Entry[], message: string, now = Date.now()): Promise<{ id: string; same: boolean }> {
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

/** The newest commits, newest first (at most `max`). */
export async function logOf(repo: string, max = 30): Promise<Commit[]> {
  const out: Commit[] = [];
  for (let id = await headOf(repo); id && out.length < max;) {
    const c = await readCommit(repo, id);
    out.push(c);
    id = c.parent;
  }
  return out;
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
