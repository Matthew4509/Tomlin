// Files: open, edit and save plain text files in one workspace folder the person chooses. Nothing outside the folder is
// touched, nothing is run, nothing is deleted. The plain functions are tested in test/workspace.test.ts.
import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeAtomic } from './atomic.ts';
import { trimBaks } from './bakcopies.ts';

/** Text files only. */
// Code in more languages (an answer's code block saved from the chat): source files only, nothing Windows runs on a
// double-click (.bat and .cmd are left out; a .ps1 opens in Notepad).
export const TEXT_EXT = new Set(['.md', '.txt', '.html', '.htm', '.css', '.js', '.json', '.csv', '.xml', '.yml', '.yaml', '.ts', '.tsx', '.jsx', '.mjs', '.py', '.php', '.sql', '.toml',
  '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.kt', '.swift', '.vue', '.scss', '.ini', '.sh', '.ps1']);
export const MAX_BYTES = 1 << 20;
const MAX_LISTED = 500;
// A project three folders deep keeps its specialists' work two deeper (src/folders.ts): clients/acme/site/specialists/writer,
// and a character's pictures three deeper: clients/acme/site/specialists/characters/Ember/card.json (seven parts).
const MAX_DEPTH = 6;
/**
 * The longest path inside the workspace: three folders of a project, its characters folder, a 40-letter card name and
 * a picture's file name fit. Node reads and writes past Windows' old 260-character limit itself.
 */
const MAX_PATH_CHARS = 280;

export interface Entry {
  /** Relative to the workspace, with forward slashes. */
  path: string;
  bytes: number;
  at: string;
}

/** A relative path inside the workspace, or null when it is not one (absolute, "..", hidden, odd characters, not a text file). */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Whether this is one of Windows' device names (CON, NUL, COM1 ...), which can never be a file or a folder. */
export const isDeviceName = (name: string): boolean => RESERVED.test(name.trim());

export function cleanPath(input: unknown, mustBeText = true): string | null {
  const raw = String(input ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!raw || raw.length > MAX_PATH_CHARS ||/[\0<>:"|?*]/.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[ .]$/.test(p))) return null;
  if (parts.length > MAX_DEPTH + 1) return null;
  // Windows' device names (CON, AUX, NUL, COM1, LPT1 ...), with or without an extension, are not files: a save made a file
  // that Explorer could not open or delete (found by the flows soak, aux.md and CON.txt).
  if (parts.some(p => RESERVED.test(p))) return null;
  if (mustBeText && !TEXT_EXT.has(extname(raw).toLowerCase())) return null;
  return parts.join('/');
}

/**
 * The folder a path really is: a link or junction followed, and a short or device spelling (\\.\C:\..., PROGRA~1) made
 * plain. The part that is not there yet is kept as typed. A network path is left as it is (asking could hold the
 * whole server up while a PC that is off does not answer).
 */
function realFolder(path: string): string {
  const full = resolve(path.replace(/^[\\/]{2}[.?][\\/]/, ''));
  if (full.startsWith('\\\\')) return full;
  for (let probe = full; ; probe = dirname(probe)) {
    try {
      return join(realpathSync.native(probe), relative(probe, full));
    } catch {
      if (dirname(probe) === probe) return full;
    }
  }
}

/** A network folder (\\server\share) or a device's spelling of one (\\?\, \\.\): never a workspace or a models folder. */
export const isNetworkPath = (path: string) => /^[\\/]{2}/.test(path.trim());
export const NETWORK_WHY = 'a network folder (\\\\server\\share) cannot be used: another PC could put files there for this one to run. Choose a folder on a drive of this PC';

/**
 * Why `path` may not be the workspace (null when it may): a network folder, or a folder Windows runs files from or keeps
 * programs in: anything under AppData (Roaming and Local, which hold the Startup folder Windows runs at sign-in),
 * ProgramData (the Startup folder for every user), the Windows folder, or Program Files. The folder as typed and the one
 * it really leads to (through links) are both looked at, by their whole paths, whatever the case of their letters.
 */
export function systemFolderWhy(path: string, env: Record<string, string | undefined> = process.env): string | null {
  if (isNetworkPath(path)) return NETWORK_WHY;
  const real = realFolder(path);
  if (isNetworkPath(real)) return NETWORK_WHY;
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const typed = [norm(path), norm(real)];
  // The Temp folder (inside Local AppData) is the one place there that Windows runs nothing from by itself.
  const temp = [env.TEMP, env.TMP].filter((t): t is string => !!t && isAbsolute(t)).map(norm);
  const inTemp = (t: string) => temp.some(x => t === x || t.startsWith(`${x}\\`) || t.startsWith(`${x}/`));
  if (typed.every(inTemp)) return null;
  const places: [string | undefined, string][] = [
    [env.APPDATA, 'AppData, where programs keep their own files (Windows runs what is in its Startup folder there at sign-in)'],
    [env.LOCALAPPDATA, 'AppData, where programs keep their own files'],
    [env.ProgramData ?? env.PROGRAMDATA, 'ProgramData, where programs keep their own files (Windows runs what is in its Startup folder there at sign-in)'],
    [env.SystemRoot ?? env.windir ?? env.WINDIR, 'the Windows folder'],
    [env.ProgramFiles ?? env.PROGRAMFILES, 'Program Files'],
    [env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'], 'Program Files'],
    [env.ProgramW6432 ?? env.PROGRAMW6432, 'Program Files'],
  ];
  for (const [base, name] of places) {
    if (!base || !isAbsolute(base)) continue;
    const b = norm(base);
    if (typed.some(t => t === b || t.startsWith(`${b}\\`) || t.startsWith(`${b}/`))) return `that folder is in ${name}. Choose a folder of your own, such as one in Documents`;
  }
  return null;
}

/**
 * A workspace folder the person typed: '' for the default one, the path when it may be used (absolute, not a drive root,
 * not Windows' own folders, not a network folder, not a folder Windows runs files from: systemFolderWhy), null when not.
 * The quotes Windows' "Copy as path" puts round a path are taken off.
 */
export function cleanFolder(input: unknown): string | null {
  const path = String(input ?? '').trim().replace(/^["“”'](.*)["“”']$/, '$1').trim();
  if (!path) return '';
  const p = path.replace(/\//g, '\\');
  const parts = p.split('\\').filter(Boolean);
  // A name ending in a dot or a space (".." among them) is another folder to Windows than it looks, and \\.\ is a device's way of naming one.
  if (p.startsWith('\\\\.\\') || parts.some(x => /[ .]$/.test(x))) return null;
  const windows = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/i;
  if (!isAbsolute(path) || parts.length < 2 || windows.test(p) || /[\0<>"|?*]/.test(path)) return null;
  if (systemFolderWhy(path)) return null;
  // The same again for where it really leads: a link can lead to the top of a drive or to Windows' own folders.
  const real = realFolder(path);
  return windows.test(real) || /^[a-z]:\\?$/i.test(real) ? null : path;
}

/**
 * Whether `folder` is, holds, or sits inside one of `kept` (TOMLIN's own app folder and home folder): Files and
 * job steps must never read the data (your chats) or write over the app's own code there.
 */
export function overlaps(folder: string, kept: string[]): boolean {
  const norm = (p: string) => realFolder(p).replace(/[\\/]+$/, '').toLowerCase();
  const f = norm(folder);
  return kept.map(norm).some(k => f === k || f.startsWith(k + sep) || k.startsWith(f + sep));
}

/**
 * The full path of a workspace file, checked to stay inside the folder (also through links). Null when it would not.
 * Nor may it lead into a folder Windows runs files from (systemFolderWhy) that the workspace itself is not in: a home
 * folder as the workspace holds AppData, and its "Start Menu" link leads to the Startup folder four names down.
 */
export async function inside(root: string, rel: unknown, mustBeText = true, env: Record<string, string | undefined> = process.env): Promise<string | null> {
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
    if (real) {
      if (real !== base && !real.startsWith(base + sep)) return null;
      return real !== base && systemFolderWhy(real, env) && !systemFolderWhy(base, env) ? null : full;
    }
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
}

/**
 * Every file in one folder of the workspace, whatever its kind, with no limit on how many (unlike `list`, which is for
 * browsing): its sub-folders, deepest last, and the links in it, which are not followed. Null when it is not a folder here.
 */
export async function filesUnder(root: string, rel: string): Promise<{ files: string[]; folders: string[]; links: string[] } | null> {
  const top = await inside(root, `${rel}/x`, false);
  if (!top) return null;
  const out = { files: [] as string[], folders: [] as string[], links: [] as string[] };
  const walk = async (dir: string, name: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const path = `${name}/${d.name}`;
      if (d.isSymbolicLink()) out.links.push(path);
      else if (d.isDirectory()) {
        out.folders.push(path);
        await walk(join(dir, d.name), path);
      } else if (d.isFile()) out.files.push(path);
    }
  };
  try {
    await walk(dirname(top), rel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !out.files.length && !out.folders.length) return null;
    throw e;
  }
  return out;
}

/** The text files in the workspace, newest first. */
export async function list(root: string): Promise<Entry[]> {
  return (await listAll(root)).files;
}

/** The text files in the workspace, newest first, at most MAX_LISTED; `more` is true when there are others past them. */
export async function listAll(root: string): Promise<{ files: Entry[]; more: boolean }> {
  const out: Entry[] = [];
  let more = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (more) return;
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (d.isFile() && TEXT_EXT.has(extname(d.name).toLowerCase())) {
        // Past the limit, one more file is enough to say there are more: none of them is looked at.
        if (out.length >= MAX_LISTED) {
          more = true;
          return;
        }
        const s = await stat(full).catch(() => null);
        if (s) out.push({ path: relative(root, full).split(sep).join('/'), bytes: s.size, at: s.mtime.toISOString() });
      }
    }
  };
  await walk(root, 0);
  return { files: out.sort((a, b) => b.at.localeCompare(a.at)), more };
}

export async function read(root: string, rel: unknown): Promise<{ path: string; text: string } | { error: string }> {
  const full = await inside(root, rel);
  if (!full) return { error: 'That is not a text file in the workspace.' };
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) return { error: 'There is no such file.' };
  if (s.size > MAX_BYTES) return { error: 'That file is over 1 MB, too big to edit here.' };
  return { path: cleanPath(rel)!, text: await readFile(full, 'utf8') };
}

/**
 * A PowerShell profile ("profile.ps1", "Microsoft.PowerShell_profile.ps1" and the like): PowerShell runs it each time it
 * opens from Documents\WindowsPowerShell or Documents\PowerShell, and Documents is a usual workspace, so a model told to
 * by a page it read could plant one. Never saved, wherever it is asked for.
 */
export const isProfileScript = (rel: string): boolean => /(^|\/)([\w.-]*_)?profile\.ps1$/i.test(rel);

/**
 * Told each file a save writes, unless the person typed it (`person`): src/modelsaved.ts remembers it, so a command run
 * in that folder later asks first. Set by the server; none in the tests unless they set one.
 */
let onSaved: ((full: string) => void) | null = null;
export const setOnSaved = (fn: ((full: string) => void) | null): void => {
  onSaved = fn;
};

/**
 * What the last save TOMLIN made of each file wrote (a hash, by lower-case full path), for as long as the app runs. A
 * person's save drops the entry. A model's save that finds other text in the file knows the person changed it since.
 */
const lastWritten = new Map<string, string>();
const hashOf = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/**
 * Before a model's save overwrites the person's own text, that text is kept as "name.ext.original.bak": the time-stamped
 * copies are trimmed to the newest few, so after many model saves the person's version would otherwise be gone. It is
 * kept when the file holds text TOMLIN did not write last (the person edited it), and on a model's first save of the
 * file since the app started when there is no such copy yet. Never trimmed; the next edit by the person replaces it.
 */
async function keepOriginal(full: string): Promise<void> {
  const k = full.toLowerCase();
  const was = lastWritten.get(k);
  const now = await readFile(full).catch(() => null);
  if (!now || (was !== undefined && hashOf(now) === was)) return;
  const copy = `${full}.original.bak`;
  if (was === undefined && (await stat(copy).then(s => s.isFile(), () => false))) return;
  await copyFile(full, copy).catch(() => undefined);
}

/** Saves a file (new or changed). The file as it was is kept once as "name.ext.bak" next to it. */
export async function save(root: string, rel: unknown, text: unknown, mayCreate = true, keepOlder = false, person = false): Promise<{ path: string; created: boolean } | { error: string }> {
  const full = await inside(root, rel);
  if (!full) return { error: 'Use a plain file name with a text or code ending (.md, .txt, .html, .css, .js, .ts, .py, .php, .sql, .json, .java, .cs, .go and the like), inside the workspace.' };
  if (isProfileScript(cleanPath(rel)!)) return { error: 'A PowerShell profile is not saved here: PowerShell runs it by itself each time it opens. Save the script under another name.' };
  if (typeof text !== 'string') return { error: 'There is no text to save.' };
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'That is over 1 MB, too big to save here.' };
  const exists = await stat(full).then(s => s.isFile(), () => false);
  if (!exists && !mayCreate) return { error: 'There is no such file.' };
  await mkdir(dirname(full), { recursive: true });
  if (exists && keepOlder && !person) await keepOriginal(full);
  // keepOlder (a model's save): the .bak the last save left is not lost to this one, it is kept under a time stamp.
  if (exists && keepOlder && (await stat(`${full}.bak`).then(s => s.isFile(), () => false))) {
    // Two saves in one second (one answer can hold both) would share a stamp and lose the older copy: the next free
    // second is taken instead, so the stamps stay 14 digits and in order.
    let at = Date.now();
    const stamped = () => `${full}.${new Date(at).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.bak`;
    while (await stat(stamped()).then(() => true, () => false)) at += 1000;
    await copyFile(`${full}.bak`, stamped(), fsConstants.COPYFILE_EXCL);
    await trimBaks(full);
  }
  if (exists) await copyFile(full, `${full}.bak`);
  await writeAtomic(full, text);
  if (person) lastWritten.delete(full.toLowerCase());
  else lastWritten.set(full.toLowerCase(), hashOf(text));
  if (!person) onSaved?.(full);
  return { path: cleanPath(rel)!, created: !exists };
}
