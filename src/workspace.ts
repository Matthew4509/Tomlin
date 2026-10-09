// Files: open, edit and save plain text files in one workspace folder the person chooses. Nothing outside the folder is
// touched, nothing is run, nothing is deleted. The plain functions are tested in test/workspace.test.ts.
import { copyFile, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeAtomic } from './atomic.ts';

/** Text files only. */
// Code in more languages (an answer's code block saved from the chat): source files only, nothing Windows runs on a
// double-click (.bat and .cmd are left out; a .ps1 opens in Notepad).
export const TEXT_EXT = new Set(['.md', '.txt', '.html', '.htm', '.css', '.js', '.json', '.csv', '.xml', '.yml', '.yaml', '.ts', '.tsx', '.jsx', '.mjs', '.py', '.php', '.sql', '.toml',
  '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.kt', '.swift', '.vue', '.scss', '.ini', '.sh', '.ps1']);
export const MAX_BYTES = 1 << 20;
const MAX_LISTED = 500;
// A project three folders deep keeps its specialists' work two deeper (src/folders.ts): clients/acme/site/specialists/writer.
const MAX_DEPTH = 5;

export interface Entry {
  /** Relative to the workspace, with forward slashes. */
  path: string;
  bytes: number;
  at: string;
}

/** A relative path inside the workspace, or null when it is not one (absolute, "..", hidden, odd characters, not a text file). */
export function cleanPath(input: unknown, mustBeText = true): string | null {
  const raw = String(input ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!raw || raw.length > 200 || /[\0<>:"|?*]/.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[ .]$/.test(p))) return null;
  if (parts.length > MAX_DEPTH + 1) return null;
  if (mustBeText && !TEXT_EXT.has(extname(raw).toLowerCase())) return null;
  return parts.join('/');
}

/**
 * A workspace folder the person typed: '' for the default one, the path when it may be used (absolute, not a drive root,
 * not Windows' own folders), null when not. The quotes Windows' "Copy as path" puts round a path are taken off.
 */
export function cleanFolder(input: unknown): string | null {
  const path = String(input ?? '').trim().replace(/^["“”'](.*)["“”']$/, '$1').trim();
  if (!path) return '';
  const p = path.replace(/\//g, '\\');
  const ok = isAbsolute(path) && p.split('\\').filter(Boolean).length >= 2 && !/^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/i.test(p) && !/[\0<>"|?*]/.test(path);
  return ok ? path : null;
}

/**
 * Whether `folder` is, holds, or sits inside one of `kept` (TOMLIN's own app folder and home folder): Files and
 * job steps must never read the data (your chats) or write over the app's own code there.
 */
export function overlaps(folder: string, kept: string[]): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const f = norm(folder);
  return kept.map(norm).some(k => f === k || f.startsWith(k + sep) || k.startsWith(f + sep));
}

/** The full path of a workspace file, checked to stay inside the folder (also through links). Null when it would not. */
export async function inside(root: string, rel: unknown, mustBeText = true): Promise<string | null> {
  const clean = cleanPath(rel, mustBeText);
  if (!clean) return null;
  const base = await realpath(root).catch(() => null);
  if (!base) return null;
  const full = resolve(base, ...clean.split('/'));
  if (relative(base, full).startsWith('..')) return null;
  const isIn = (real: string) => real === base || real.startsWith(base + sep);
  // The file itself, when it is there: a link to a file outside the workspace is not followed.
  const realFile = await realpath(full).catch(() => null);
  if (realFile && !isIn(realFile)) return null;
  // The nearest folder that exists must itself be inside (a link could point out of the workspace).
  let probe = dirname(full);
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real) return real === base || real.startsWith(base + sep) ? full : null;
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
}

/** The text files in the workspace, newest first. */
export async function list(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (out.length >= MAX_LISTED || d.name.startsWith('.') || d.name === 'node_modules') continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (d.isFile() && TEXT_EXT.has(extname(d.name).toLowerCase())) {
        const s = await stat(full).catch(() => null);
        if (s) out.push({ path: relative(root, full).split(sep).join('/'), bytes: s.size, at: s.mtime.toISOString() });
      }
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export async function read(root: string, rel: unknown): Promise<{ path: string; text: string } | { error: string }> {
  const full = await inside(root, rel);
  if (!full) return { error: 'That is not a text file in the workspace.' };
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) return { error: 'There is no such file.' };
  if (s.size > MAX_BYTES) return { error: 'That file is over 1 MB, too big to edit here.' };
  return { path: cleanPath(rel)!, text: await readFile(full, 'utf8') };
}

/** Saves a file (new or changed). The file as it was is kept once as "name.ext.bak" next to it. */
export async function save(root: string, rel: unknown, text: unknown, mayCreate = true): Promise<{ path: string; created: boolean } | { error: string }> {
  const full = await inside(root, rel);
  if (!full) return { error: 'Use a plain file name with a text or code ending (.md, .txt, .html, .css, .js, .ts, .py, .php, .sql, .json, .java, .cs, .go and the like), inside the workspace.' };
  if (typeof text !== 'string') return { error: 'There is no text to save.' };
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'That is over 1 MB, too big to save here.' };
  const exists = await stat(full).then(s => s.isFile(), () => false);
  if (!exists && !mayCreate) return { error: 'There is no such file.' };
  await mkdir(dirname(full), { recursive: true });
  if (exists) await copyFile(full, `${full}.bak`);
  await writeAtomic(full, text);
  return { path: cleanPath(rel)!, created: !exists };
}
