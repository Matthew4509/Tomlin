// Projects from the Bridge's list backed up to linked PCs, beside the workspace (src/jobrun/copies.ts sends them; the
// node keeps one git repository per PC, src/gitstore.ts). A project is in when it is ticked in its git window ("Copy to
// my nodes"), kept in data/bridge-backups.json. In the backup each one is a folder under "Bridge projects/".
// What is taken from a project: in a git repository, what git itself would keep (the saved files and new files its
// .gitignore does not leave out: no node_modules, builds or models listed there), read with `git ls-files`; anywhere
// else, every file but .git and node_modules. A file over 256 MB is left out and named, and nothing is ever written
// into the project.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
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
 * Each project's folder name in the backup: its own folder name, or, when two ticked projects have the same one, the
 * name with a short mark of its full path (the same project always gets the same name).
 */
export function namesOf(dirs: string[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const d of dirs) count.set(basename(d).toLowerCase(), (count.get(basename(d).toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const d of dirs) {
    const name = basename(d).replace(/[^\w .()+-]+/g, '-').replace(/^[ .]+|[ .]+$/g, '') || 'project';
    const twice = (count.get(basename(d).toLowerCase()) ?? 0) > 1;
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
  /** Why git's list was not used, when it was a git repository. */
  note?: string;
  more: boolean;
}

const require = createRequire(import.meta.url);
const gitstate = require('./bridge/gitstate.js') as { gitConfigRisky(dir: string): boolean };

/** `git ls-files`: what git keeps of a repository (saved, and new but not ignored). null when git cannot say. */
function gitList(dir: string): Promise<{ paths: string[] } | { error: string }> {
  return new Promise(done => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      timeout: 60_000, windowsHide: true, maxBuffer: 256 * 2 ** 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
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
      for (const p of listed.paths) {
        if (files.length >= MAX_FILES) { more = true; break; }
        if (!git.safePath(p) || p.split('/').some(part => part.toLowerCase() === '.git')) continue;
        const full = join(dir, ...p.split('/'));
        try {
          const s = await stat(full);
          if (s.isFile()) take({ path: p, full, bytes: s.size, mtime: s.mtimeMs }, files);
        } catch {
          // listed by git but deleted since (a removed file not saved yet): nothing to copy
        }
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files, left, how: 'git', more };
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
