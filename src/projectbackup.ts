// Projects from the Bridge's list backed up to linked PCs, beside the workspace (src/jobrun/copies.ts sends them; the
// node keeps one git repository per PC, src/gitstore.ts). A project is in when it is ticked in its git window ("Copy to
// my nodes"), kept in data/bridge-backups.json. In the backup each one is a folder under "Bridge projects/".
// What is taken from a project: in a git repository, what git itself would keep (the saved files and new files its
// .gitignore does not leave out: no node_modules, builds or models listed there), read with `git ls-files`; anywhere
// else, every file but .git and node_modules. A file over 256 MB is left out and named, and nothing is ever written
// into the project.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import * as git from './gitstore.ts';

/** In the backup, every Bridge project sits in a folder under this one; the workspace stays at the top as before. */
export const PREFIX = 'Bridge projects';
/** A file larger than this is left out of a project's backup (and named): a model, a video, a release zip. */
export const MAX_FILE = 256 * 2 ** 20;
/** Files in one project's backup at most (the whole backup holds at most 100,000, src/gitstore.ts workFiles). */
const MAX_FILES = 50_000;

/** The list as saved: full folder paths. */
export interface Chosen { dirs: string[] }
export const CHOSEN_FILE = 'bridge-backups.json';

export const keyOf = (dir: string) => resolve(dir).toLowerCase();

export function cleanChosen(raw: unknown): Chosen {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const v of Array.isArray(o.dirs) ? o.dirs : []) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const dir = resolve(v.trim());
    if (seen.has(keyOf(dir))) continue;
    seen.add(keyOf(dir));
    dirs.push(dir);
  }
  return { dirs };
}

/**
 * Each project's folder name in the backup: its own folder name in characters a backup can use, or, when two ticked
 * projects come out the same that way ("Client @" and "Client #"), the name with a short mark of its full path (the same
 * project always gets the same name).
 */
export function namesOf(dirs: string[]): Map<string, string> {
  const plain = (d: string) => basename(d).replace(/[^\w .()+-]+/g, '-').replace(/^[ .]+|[ .]+$/g, '') || 'project';
  const count = new Map<string, number>();
  for (const d of dirs) count.set(plain(d).toLowerCase(), (count.get(plain(d).toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const d of dirs) {
    const name = plain(d);
    const twice = (count.get(name.toLowerCase()) ?? 0) > 1;
    out.set(keyOf(d), twice ? `${name} ${createHash('sha1').update(keyOf(d)).digest('hex').slice(0, 6)}` : name);
  }
  return out;
}

export interface ProjectFiles {
  files: git.WorkFile[];
  /** Files left out for their size. */
  left: { path: string; bytes: number }[];
  /** How the files were chosen: what git keeps, or the whole folder. */
  how: 'git' | 'folder';
  /** Why git's list was not used, when it was a git repository; or what it listed that was reached through a link. */
  note?: string;
  more: boolean;
}

const require = createRequire(import.meta.url);
const gitstate = require('./bridge/gitstate.js') as {
  gitConfigRisky(dir: string): boolean;
  fenced(dir: string): { args: string[]; env: Record<string, string> };
};

/** `git ls-files`: what git keeps of a repository (saved, and new but not ignored). null when git cannot say. */
function gitList(dir: string): Promise<{ paths: string[] } | { error: string }> {
  // Kept inside the project folder, as the Bridge's git calls are: git never takes the folder itself as a bare
  // repository, nor a repository above it (neither had their settings checked).
  const fence = gitstate.fenced(dir);
  return new Promise(done => {
    execFile('git', ['-c', 'core.fsmonitor=false', ...fence.args, '-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      timeout: 60_000, windowsHide: true, maxBuffer: 256 * 2 ** 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...fence.env },
    }, (err, stdout) => {
      if (err) return done({ error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed on this PC' : 'git could not list its files' });
      done({ paths: [...new Set(String(stdout).split('\0').filter(Boolean))] });
    });
  });
}

/** The files a project's backup takes (paths inside the project, with forward slashes). Reads only. */
export async function projectFiles(dir: string): Promise<ProjectFiles> {
  const left: ProjectFiles['left'] = [];
  const take = (f: git.WorkFile, out: git.WorkFile[]) => {
    if (f.bytes > MAX_FILE) left.push({ path: f.path, bytes: f.bytes });
    else out.push(f);
  };
  let note: string | undefined;
  if (existsSync(join(dir, '.git'))) {
    // A repository whose own settings could run a program is not read with git (the Bridge refuses it the same way).
    const listed = gitstate.gitConfigRisky(dir) ? { error: 'its git settings could run a program, so git was not used on it' } : await gitList(dir);
    if ('paths' in listed) {
      const files: git.WorkFile[] = [];
      let more = false;
      // Git lists what it was told about: a folder since replaced by a link would be read through it, out of the project.
      const links: string[] = [];
      const base = await realpath(dir);
      const stays = new Map<string, boolean>();
      const staysIn = async (folder: string) => {
        if (!stays.has(folder)) {
          const real = await realpath(folder);
          stays.set(folder, real === base || real.startsWith(base.endsWith(sep) ? base : base + sep));
        }
        return stays.get(folder)!;
      };
      for (const p of listed.paths) {
        if (files.length >= MAX_FILES) { more = true; break; }
        if (!git.safePath(p) || p.split('/').some(part => part.toLowerCase() === '.git')) continue;
        const full = join(dir, ...p.split('/'));
        try {
          const s = await lstat(full);
          if (s.isSymbolicLink() || !(await staysIn(dirname(full)))) links.push(p);
          else if (s.isFile()) take({ path: p, full, bytes: s.size, mtime: s.mtimeMs }, files);
        } catch {
          // listed by git but deleted since (a removed file not saved yet): nothing to copy
        }
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const linkNote = links.length ? `Left out what is reached through a link, as links are not followed: ${links.slice(0, 3).join(', ')}${links.length > 3 ? ` and ${links.length - 3} more` : ''}.` : undefined;
      return { files, left, how: 'git', note: linkNote, more };
    }
    note = listed.error;
  }
  const all = await git.workFiles(dir, MAX_FILES);
  const files: git.WorkFile[] = [];
  for (const f of all.files) take(f, files);
  return { files, left, how: 'folder', note, more: all.more };
}

/** One project's files, by path, size and time: the same when nothing in it changed since. */
export const signatureOf = (files: git.WorkFile[]) => git.signature(files);

/** A file's git id as kept from last time, while its size and time stay the same. */
export interface HashKept { bytes: number; mtime: number; id: string }

/**
 * The files with their git ids (those unchanged since last time from `kept`, and `now` to keep for next time). A file
 * deleted since it was listed is simply gone. One that cannot be read (open in another program, access refused) is named
 * in `unread`: its last good copy stays in the backup when there is one, and it is read again next time.
 */
export async function hashFiles(files: git.WorkFile[], kept: Record<string, HashKept>, idOf: (file: string) => Promise<{ id: string }> = git.blobIdOfFile, signal?: AbortSignal) {
  const now: Record<string, HashKept> = {};
  const out: (git.WorkFile & { id: string })[] = [];
  const unread: string[] = [];
  for (const f of files) {
    if (signal?.aborted) throw new Error('Stopped.');
    const k = kept[f.path];
    let id = k && k.bytes === f.bytes && k.mtime === f.mtime ? k.id : '';
    if (!id) {
      try {
        id = (await idOf(f.full)).id;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        unread.push(f.path);
        if (k) {
          now[f.path] = k;
          out.push({ ...f, id: k.id });
        }
        continue;
      }
    }
    now[f.path] = { bytes: f.bytes, mtime: f.mtime, id };
    out.push({ ...f, id });
  }
  return { out, now, unread };
}

/**
 * What a finished backup records as "the same as now". With a file it could not read, it is not: the next round tries
 * again, and the project that file is in does not show as up to date.
 */
export function doneSignatures<P extends { name: string; sig: string }>(set: { sig: string; parts: Record<string, P> }, unread: string[]): { sig: string; parts: Record<string, P> } {
  if (!unread.length) return set;
  const missed = (name: string) => unread.some(path => path.startsWith(`${PREFIX}/${name}/`));
  return {
    sig: `${set.sig}+unread`,
    parts: Object.fromEntries(Object.entries(set.parts).map(([k, p]) => [k, missed(p.name) ? { ...p, sig: `${p.sig}+unread` } : p])),
  };
}

/** The line a backup ends with when it could not read some files ('' when it read them all). */
export function unreadWords(unread: string[]): string {
  if (!unread.length) return '';
  const named = unread.slice(0, 3).join(', ');
  const rest = unread.length > 3 ? ` and ${unread.length - 3} more` : '';
  return ` ${unread.length} file${unread.length === 1 ? '' : 's'} could not be read, perhaps open in another program, so the newest version is not in this backup: ${named}${rest}. They are tried again at the next backup.`;
}
