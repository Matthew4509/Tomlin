// The installer's plain parts (2.0.34; the steps are in tools/install.ts, started by "Install TOMLIN.cmd").
// An installed TOMLIN lives in one folder per Windows user, no administrator needed:
//   %LOCALAPPDATA%\Programs\TOMLIN\
//     TOMLIN.exe          the program (tools/tray.cs, built on the PC by the C# compiler that comes with Windows)
//     icon.ico
//     current.txt         the copy to run: "tomlin-2.0.44" (an update pushed from a linked PC adds tomlin-2.0.45
//                         beside it and TOMLIN.exe moves current.txt on)
//     tomlin-2.0.44\      the app, with its own Node.js in runtime\node
// The home folder (chats, staff, pictures, models, backups) stays where it always was, so installing, updating and
// uninstalling never touch it unless asked. Shortcuts (Start menu, desktop, Start TOMLIN when this PC starts) and the entry in
// Settings > Apps all point at TOMLIN.exe, which never moves, so they keep working after every update.
// An install made before the TOMLIN name (Programs\Smart Manager, Smart Manager.exe) keeps its names: see FORMER.
// Tested in test/installer.test.ts.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { psQuote } from './psquote.ts';

/** The program in an install folder made with the TOMLIN name. */
export const EXE = 'TOMLIN.exe';
/**
 * The names an install made before the TOMLIN name has (in Programs\Smart Manager). It keeps them all, through updates
 * and repairs: its shortcuts, Start TOMLIN when this PC starts and the entry in Settings > Apps point at them, so nothing is moved
 * under it. A new install gets the TOMLIN names.
 */
export const FORMER = { folder: 'Smart Manager', exe: 'Smart Manager.exe', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SmartManager' };
/** The program in an install folder: TOMLIN.exe, or Smart Manager.exe in an install made before the TOMLIN name. */
export function exeIn(root: string): string {
  return !existsSync(join(root, EXE)) && existsSync(join(root, FORMER.exe)) ? join(root, FORMER.exe) : join(root, EXE);
}
/** The program under another name beside it while it is replaced: "TOMLIN.old.exe", "Smart Manager.new.exe". */
export const sideExe = (exe: string, tag: 'old' | 'new'): string => exe.replace(/\.exe$/i, `.${tag}.exe`);
export const CURRENT = 'current.txt';
/** The name people see for the app: the Start menu, the desktop shortcut, Settings > Apps, the tray. */
export const NAME = 'TOMLIN';
export const LINK = `${NAME}.lnk`;
/** Shortcuts made under the app's earlier name: replaced by LINK, and removed on uninstall, when they open this app. */
export const OLD_LINKS = ['Smart Manager.lnk'];
export const DEFAULT_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TOMLIN';
/** Copies kept in the install folder: the one in use and the one before it (for going back). */
export const KEEP_COPIES = 2;

export interface Places {
  /** The install folder. */
  root: string;
  /** Start menu programs folder. */
  startMenu: string;
  /** The desktop, or null to ask Windows (it may be in OneDrive). */
  desktop: string | null;
  /** The registry key of the entry in Settings > Apps; null = none (tests). */
  uninstallKey: string | null;
  /** The C# compiler that comes with Windows (.NET Framework 4). */
  csc: string[];
}

/**
 * A one-line file beside the default install folder that names the folder a person chose in setup (3.0 installer, 9 Nov).
 * Absent = the default. Every part that finds the install (the app, updates, repair, uninstall) goes through installRoot,
 * so a chosen folder is found the same way as the default one.
 */
export const LOCATION_FILE = 'TOMLIN-location.txt';

/** The folder the person chose in setup, when it still holds an install; null otherwise. */
export function chosenRoot(local: string): string | null {
  try {
    const dir = readFileSync(join(local, 'Programs', LOCATION_FILE), 'utf8').trim();
    return /^[A-Za-z]:\\/.test(dir) && existsSync(join(dir, CURRENT)) ? dir : null;
  } catch {
    return null;
  }
}

/** The install folder: the one chosen in setup, else Programs\TOMLIN, or Programs\Smart Manager when only that one holds an install. */
export function installRoot(local: string): string {
  const chosen = chosenRoot(local);
  if (chosen) return chosen;
  const now = join(local, 'Programs', 'TOMLIN');
  const old = join(local, 'Programs', FORMER.folder);
  return !existsSync(join(now, CURRENT)) && existsSync(join(old, CURRENT)) ? old : now;
}

/**
 * Checks the folder typed in setup. Empty = the one offered. It must be a full path on a drive, not inside the unzipped
 * setup folder (which a person deletes afterwards), and either new, empty or already holding a TOMLIN install.
 */
export function chooseRoot(typed: string, offered: string, setupDir: string): { root: string } | { error: string } {
  const text = typed.trim().replace(/^"(.*)"$/, '$1');
  if (!text) return { root: offered };
  if (!/^[A-Za-z]:[\\/]/.test(text)) return { error: 'Type a full folder path that starts with a drive, for example D:\\Apps\\TOMLIN.' };
  const root = resolve(text);
  const low = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  if (low(root) === low(setupDir) || low(root).startsWith(`${low(setupDir)}\\`)) return { error: 'That is inside the folder this setup is running from. Pick another folder: this one is deleted when you tidy up.' };
  if (root.length < 4) return { error: 'Pick a folder, not a whole drive.' };
  if (existsSync(root) && !existsSync(join(root, CURRENT))) {
    try {
      if (readdirSync(root).length) return { error: 'That folder is not empty and holds no TOMLIN. Pick an empty folder, or a new name (it is made for you).' };
    } catch {
      return { error: 'That folder cannot be read.' };
    }
  }
  return { root };
}

/** A copy of TOMLIN started from a folder (not installed), found by setup: its folder, version, and whether it keeps its own data/ inside. */
export interface LooseCopy { dir: string; version: string; ownData: boolean }

/** The names a TOMLIN copy's package.json has had: tomlin, and smart-manager before the TOMLIN name. */
const COPY_NAMES = new Set(['tomlin', 'smart-manager']);
/** Folders never looked inside: big, hidden or never a place a person unzips to. */
const SKIP_DIR = /^(\.|node_modules$|appdata$|application data$|onedrive - |\$recycle\.bin$)/i;
/** At most this many names per folder are looked at, so a full Downloads folder never slows setup. */
const LIST_CAP = 800;

/**
 * Where setup looks for copies of TOMLIN people unzipped and started from a folder: the Desktop and Downloads (two
 * levels down: "Downloads\tomlin-2.0.70\tomlin-2.0.70" is common when Windows unzips into a folder of the same name),
 * Documents (two levels), and the user folder itself (one level). TOMLIN_LOOK_IN (folders split by ";", depth 2) replaces
 * the list; a test install (TOMLIN_INSTALL_ROOT set) looks nowhere unless TOMLIN_LOOK_IN says so.
 */
export function lookIn(env: NodeJS.ProcessEnv, desktop: string | null): { dir: string; depth: number }[] {
  if (env.TOMLIN_LOOK_IN !== undefined) return env.TOMLIN_LOOK_IN.split(';').map(d => d.trim()).filter(Boolean).map(dir => ({ dir, depth: 2 }));
  if (env.TOMLIN_INSTALL_ROOT) return [];
  const user = env.USERPROFILE;
  if (!user) return desktop ? [{ dir: desktop, depth: 2 }] : [];
  return [
    ...(desktop ? [{ dir: desktop, depth: 2 }] : []),
    { dir: join(user, 'Desktop'), depth: 2 },
    { dir: join(user, 'OneDrive', 'Desktop'), depth: 2 },
    { dir: join(user, 'Downloads'), depth: 2 },
    { dir: join(user, 'Documents'), depth: 2 },
    { dir: join(user, 'OneDrive', 'Documents'), depth: 2 },
    { dir: user, depth: 1 },
  ];
}

/**
 * The copies of TOMLIN in `places` (see lookIn), outside the install folder `root` and other than `skip` (the setup's
 * own folder): a folder counts when its package.json names TOMLIN (or an earlier name) and it has src/server.ts. Read
 * only: nothing is changed. Newest version first; never throws.
 */
export function findLooseCopies(places: { dir: string; depth: number }[], root: string, skip: string[] = []): LooseCopy[] {
  const low = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const inRoot = (p: string) => low(p) === low(root) || low(p).startsWith(`${low(root)}\\`) || low(p).startsWith(`${low(root)}/`);
  const skipped = new Set(skip.map(low));
  const seen = new Set<string>();
  const found: LooseCopy[] = [];
  const isCopy = (dir: string): string | null => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      return COPY_NAMES.has(String(pkg.name)) && existsSync(join(dir, 'src', 'server.ts')) ? String(pkg.version ?? '?') : null;
    } catch {
      return null;
    }
  };
  const visit = (dir: string, depth: number) => {
    const key = low(dir);
    if (seen.has(key) || inRoot(dir)) return;
    seen.add(key);
    const version = isCopy(dir);
    if (version) {
      if (!skipped.has(key)) found.push({ dir: resolve(dir), version, ownData: existsSync(join(dir, 'data', 'settings.json')) });
      return; // nothing to find inside a copy
    }
    if (depth <= 0) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !SKIP_DIR.test(e.name)).slice(0, LIST_CAP).map(e => e.name);
    } catch {
      return;
    }
    for (const n of names) visit(join(dir, n), depth - 1);
  };
  for (const p of places) visit(p.dir, p.depth);
  return found.sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
}

/** What setup says about the copies it found, in plain words; [] when none. */
export function looseCopyLines(copies: LooseCopy[]): string[] {
  if (!copies.length) return [];
  return [
    `Also found ${copies.length === 1 ? 'a copy' : `${copies.length} copies`} of ${NAME} started from a folder (not installed):`,
    ...copies.map(c => `  ${c.version} in ${c.dir}${c.ownData ? ' (it keeps its own chats inside: keep it until you have checked they are in the installed one)' : ''}`),
    `Setup does not change ${copies.length === 1 ? 'it' : 'them'}. Once ${NAME} is installed, start it from the Start menu, not from ${copies.length === 1 ? 'that folder' : 'those folders'}; delete ${copies.length === 1 ? 'it' : 'them'} when you no longer need ${copies.length === 1 ? 'it' : 'them'}.`,
  ];
}

/** Where everything goes, for this Windows user. Tests move each one with a TOMLIN_* setting. */
export function places(env: NodeJS.ProcessEnv = process.env): Places {
  const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Local');
  const roaming = env.APPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Roaming');
  const windir = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const root = env.TOMLIN_INSTALL_ROOT ?? installRoot(local);
  // An install made before the TOMLIN name keeps its entry in Settings > Apps.
  const key = basename(exeIn(root)) === FORMER.exe ? FORMER.key : DEFAULT_UNINSTALL_KEY;
  return {
    root,
    startMenu: env.TOMLIN_START_MENU_DIR ?? join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    desktop: env.TOMLIN_DESKTOP_DIR ?? null,
    uninstallKey: env.TOMLIN_UNINSTALL_KEY === 'none' ? null : env.TOMLIN_UNINSTALL_KEY ?? key,
    csc: [join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')],
  };
}

/** True when version a is later than b, number by number. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The files a copy cannot start (or load a model) without: one missing means the copy is damaged. */
export const KEY_FILES = ['package.json', 'src/server.ts', 'tools/tray.cs', 'tools/install.ts', 'runtime/node/node.exe', 'runtime/llama-cpu/llama-server.exe', 'runtime/sd-cpu/sd-server.exe', 'node_modules/sharp/package.json'];

/** The key files a copy lacks (none = whole). */
export const missingFiles = (dir: string): string[] => KEY_FILES.filter(f => !existsSync(join(dir, ...f.split('/'))));

/** Why a copy staged for the zip (tools/pack.ts) must not be packed: the key files it lacks, one per line; '' when whole. */
export function stagedMissing(dir: string): string {
  const miss = missingFiles(dir);
  return miss.length ? `Pack stopped: the zip would miss ${miss.length} key file(s), and a copy without them cannot start:\n  ${miss.join('\n  ')}` : '';
}

/** A copy's version from its package.json, or null. */
export function versionOf(dir: string): string | null {
  try {
    return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version);
  } catch {
    return null;
  }
}

/** The copy current.txt names in an install folder (its name as written, folder and version); null when it names none. */
export function currentCopy(root: string): { name: string; dir: string; version: string } | null {
  try {
    const name = readFileSync(join(root, CURRENT), 'utf8').trim();
    if (!name) return null;
    const dir = /^[A-Za-z]:\\/.test(name) ? name : join(root, name);
    const version = versionOf(dir);
    return version ? { name, dir, version } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a copy that started in `dir` may move the install's current.txt onto itself: only an installed one. That is a
 * copy in the install folder (an install, an in-place update) or one the installed program started (TOMLIN_TRAY=1).
 * Never a git checkout or worktree (.git beside package.json), a test copy (TOMLIN_DATA set, or started by the test
 * runner), or a copy started from any other folder: such a stray start once pointed the installed program at a
 * development folder.
 */
export function mayFollow(dir: string, root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TOMLIN_DATA || env.NODE_TEST_CONTEXT) return false;
  const full = resolve(dir);
  if (existsSync(join(full, '.git'))) return false;
  const inside = resolve(dirname(full)).toLowerCase() === resolve(root).toLowerCase();
  return inside || env.TOMLIN_TRAY === '1';
}

/**
 * current.txt follows the version that started (6 Nov slow-start plan, fix 4): once an installed copy answers (mayFollow),
 * the install's current.txt names it (its folder name when it sits in the install folder, else its full path), so the
 * installed program never starts an older one over newer data. Nothing is written when there is no install (no
 * current.txt), it already names this copy, or the copy is not an installed one. Never throws.
 */
export function followStarted(dir: string, env: NodeJS.ProcessEnv = process.env, say?: (line: string) => void): void {
  try {
    const root = places(env).root;
    const file = join(root, CURRENT);
    if (!existsSync(file) || !mayFollow(dir, root, env)) return;
    const full = resolve(dir);
    const inside = resolve(dirname(full)).toLowerCase() === resolve(root).toLowerCase();
    const value = inside ? basename(full) : full;
    // Earlier copies go at every start from the install folder, not only when current.txt moves: updates pushed from a
    // linked PC, uploaded or pulled add a folder and never took the old ones away (20 of them, 8.5 GB, on one PC).
    if (inside) void pruneOldCopies(root, basename(full)).then(gone => { if (gone.length) say?.(`Removed ${gone.length} old cop${gone.length > 1 ? 'ies' : 'y'} of TOMLIN (${gone.join(', ')}); the running one and the one before it are kept.`); }, () => undefined);
    if (readFileSync(file, 'utf8').trim() === value) return;
    writeFileSync(`${file}.new`, value);
    renameSync(`${file}.new`, file);
  } catch {
    // The start goes on; the next one tries again.
  }
}

/**
 * Removes the copies in the install folder that are not wanted any more: all but the one running and the newest other
 * (KEEP_COPIES, for going back). Only a folder named like a copy that holds TOMLIN's own package.json; the one
 * current.txt names is kept whatever its name. Returns the folders removed. Never throws.
 */
/** Whether a copy's models/ folder holds a model file (a chat model, a picture model or a LoRA). */
export function holdsModels(dir: string): boolean {
  try {
    return readdirSync(join(dir, 'models'), { recursive: true }).some(n => /\.(gguf|safetensors|ckpt)$/i.test(String(n)));
  } catch {
    return false;
  }
}

export async function pruneOldCopies(root: string, running: string): Promise<string[]> {
  const gone: string[] = [];
  try {
    const keep = new Set([running.toLowerCase()]);
    const named = currentCopy(root)?.name;
    if (named) keep.add(basename(named).toLowerCase());
    // The copy current.txt names is judged with the others (and never removed): right after an update pushed from a
    // linked PC it is the one before the running one, so it is the copy kept for going back, not one more beside it.
    for (const old of copiesToRemove([...readdirSync(root).filter(n => n !== running), running], running)) {
      if (keep.has(old.toLowerCase())) continue;
      const dir = join(root, old);
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
        if (pkg.name !== 'tomlin') continue;
      } catch {
        continue; // not a whole copy of TOMLIN: left alone
      }
      // Models kept inside an older copy are used in place (src/oldcopies.ts): that copy stays until they are moved.
      if (holdsModels(dir)) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        gone.push(old);
      } catch {
        // held by a program for now: the next start tries again
      }
    }
  } catch {
    // nothing is removed
  }
  if (gone.length) console.log(`Removed ${gone.length} old cop${gone.length > 1 ? 'ies' : 'y'} of TOMLIN (${gone.join(', ')}); the running one and the one before it are kept.`);
  return gone;
}

/**
 * The program of this user's install (TOMLIN.exe, or Smart Manager.exe in an older one), when there is one whose copy
 * is whole and not older than `version`: then
 * "Start TOMLIN when this PC starts" and the desktop shortcut start it, even when asked from an unzipped copy (else a copy started
 * from a folder would point them at itself, and the install would never run again).
 */
export function installExe(version: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = places(env).root;
  const exe = exeIn(root);
  if (!existsSync(exe)) return null;
  const c = currentCopy(root);
  if (!c || missingFiles(c.dir).length) return null;
  return version && newer(version, c.version) ? null : exe;
}

/**
 * What to ask first, from what is installed (null = nothing) and this version. `go: false` means stop after saying it.
 * `repair`: a yes runs Repair install instead of installing (6 Nov slow-start plan, fix 5: a zip older than the install
 * said "Nothing was changed" and left a broken install as it was; Repair keeps the newer copy and fixes the rest).
 */
export function firstQuestion(installed: string | null, mine: string): { text: string; yesDefault: boolean; go: boolean; repair?: true } {
  if (!installed) return { text: `Install ${NAME} ${mine} for this Windows user?`, yesDefault: true, go: true };
  if (newer(installed, mine)) return { text: `${NAME} ${installed} is installed, which is newer than this one (${mine}), so it is not replaced. Check the installed ${NAME} ${installed} and repair what is wrong (it stays ${installed})?`, yesDefault: true, go: true, repair: true };
  if (installed === mine) return { text: `${NAME} ${mine} is already installed. Install it again (repair)?`, yesDefault: false, go: true };
  return { text: `${NAME} ${installed} is already installed. Update to ${mine}?`, yesDefault: true, go: true };
}

export type SetupAction = 'update' | 'repair' | 'uninstall' | 'quit';
/**
 * What setup offers when a copy is already installed and someone is at the keyboard: it says which copy it found and
 * where, then Repair | Update | Uninstall (or Quit) by name. Enter takes the default, which is what the one yes/no
 * question (firstQuestion) would have done: update when this one is newer, Repair when the installed one is newer,
 * nothing when it is the same version. With no keyboard, firstQuestion is still the whole question.
 */
export function actionMenu(installed: string, mine: string, where: string): { intro: string; options: { key: SetupAction; label: string }[]; defaultKey: SetupAction } {
  const intro = `${NAME} ${installed} is installed in ${where}.`;
  const repair = { key: 'repair' as const, label: `Repair: check ${NAME} ${installed} and fix what is wrong (it stays ${installed})` };
  const uninstall = { key: 'uninstall' as const, label: `Uninstall: remove ${NAME} from this PC` };
  const quit = { key: 'quit' as const, label: 'Quit: change nothing' };
  if (newer(installed, mine)) return { intro: `${intro} It is newer than this setup (${mine}), so this setup does not replace it.`, options: [repair, uninstall, quit], defaultKey: 'repair' };
  if (installed === mine) return { intro: `${intro} It is the same version as this setup.`, options: [repair, { key: 'update', label: `Reinstall: copy ${mine} over it again` }, uninstall, quit], defaultKey: 'quit' };
  return { intro, options: [{ key: 'update', label: `Update: ${installed} to ${mine}` }, repair, uninstall, quit], defaultKey: 'update' };
}

/** The typed choice: its number, or the first letters of its name (two at least: Re, Up, Un, Qu); Enter = the default; else null (ask again). */
export function pickAction(typed: string, menu: { options: { key: SetupAction; label: string }[]; defaultKey: SetupAction }): SetupAction | null {
  const t = typed.trim().toLowerCase();
  if (!t) return menu.defaultKey;
  if (/^\d+$/.test(t)) return menu.options[Number(t) - 1]?.key ?? null;
  if (t.length < 2) return null;
  const words: Record<string, SetupAction> = { update: 'update', reinstall: 'update', repair: 'repair', uninstall: 'uninstall', quit: 'quit' };
  // "re" is Repair; Reinstall (the same version again) needs "rei" so the two never collide.
  const hits = menu.options.filter(o => Object.entries(words).some(([w, k]) => k === o.key && w.startsWith(t) && (w !== 'reinstall' || t.length >= 3)));
  return hits.length === 1 ? hits[0].key : null;
}

export type WindowChoice = Exclude<SetupAction, 'quit'>;
/**
 * The setup window's first page when a copy is already installed (tools/setup.cs shows it, from `status`): which copy
 * it found (folder and version), which version this setup holds, and Repair | Update | Uninstall as buttons to click.
 * The window's own Cancel button is Quit, so it is not one of the choices. `pick` is the one ticked at the start (the
 * same default as the terminal menu); '' when nothing is ticked (the same version: the window waits for a click).
 */
export function windowMenu(installed: string, mine: string, where: string, root: string, home: string): { intro: string; choices: { key: WindowChoice; label: string }[]; pick: WindowChoice | ''; uninstall: string } {
  const m = actionMenu(installed, mine, where);
  return {
    // Three lines: what is installed and where, this setup's version against it, then "Choose from below:".
    intro: [`${NAME} ${installed} is installed in ${where}.`,
      installed === mine ? `This setup is the same version, ${mine}.` : newer(installed, mine) ? `This setup is an older version, ${mine}, so it does not replace it.` : `This setup is a newer version, ${mine}.`,
      'Choose from below:'].join('\n'),
    choices: m.options.filter((o): o is { key: WindowChoice; label: string } => o.key !== 'quit'),
    pick: m.defaultKey === 'quit' ? '' : m.defaultKey,
    uninstall: `This removes ${NAME} ${installed} from ${root}: the program, its copies, its Start menu and desktop shortcuts, its start when this PC starts, and its entry in Settings > Apps.` +
      ` Your chats, staff, pictures and models in ${home} are kept. Nothing is removed until you click Uninstall.`,
  };
}

/**
 * `install --action update|repair|uninstall`: the setup window's choice, so no yes/no question decides it (with no
 * keyboard the question's default was taken, and for the same version that default is No: nothing was done).
 * null: no --action given (the questions decide). Nothing installed: update is a plain install; repair and uninstall
 * are refused. A choice the menu does not offer (update over a newer copy) is refused.
 */
export function actionFlag(flag: string | null, installed: string | null, mine: string): { action: WindowChoice | 'install' } | { error: string } | null {
  if (flag === null) return null;
  const a = flag.trim().toLowerCase();
  if (a !== 'update' && a !== 'repair' && a !== 'uninstall') return { error: `--action must be update, repair or uninstall (not "${flag}").` };
  if (!installed) return a === 'update' ? { action: 'install' } : { error: `${NAME} is not installed, so there is nothing to ${a}.` };
  if (!actionMenu(installed, mine, '').options.some(o => o.key === a)) return { error: `${NAME} ${installed} is installed, which is newer than this setup (${mine}), so it is not replaced. Use Repair or Uninstall.` };
  return { action: a };
}

/** A yes/no answer: Enter takes the default; y/yes or n/no; anything else asks again (null). */
export function answer(typed: string, yesDefault: boolean): boolean | null {
  const t = typed.trim().toLowerCase();
  if (!t) return yesDefault;
  if (t === 'y' || t === 'yes') return true;
  if (t === 'n' || t === 'no') return false;
  return null;
}

/** PowerShell quoting: inside '...' a ' (or a curly single quote) is written twice (src/psquote.ts). */
const q = psQuote;

/** The PowerShell that makes one shortcut (.lnk) with the program's own icon. */
export function shortcutScript(lnk: string, target: string, args = '', icon = `${target},0`): string {
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)})`,
    `$s.TargetPath = ${q(target)}`,
    `$s.Arguments = ${q(args)}`,
    `$s.WorkingDirectory = ${q(target.replace(/\\[^\\]*$/, ''))}`,
    `$s.IconLocation = ${q(icon)}`,
    `$s.Description = '${NAME}'`,
    '$s.Save()',
  ].join('; ');
}

/**
 * The PowerShell that finds (or, `stop`, ends) the program of THIS install folder only: another install (a
 * test one, or his real one while a test runs) is never touched. Ending it ends TOMLIN with it (a job object).
 * After the program rebuilt itself (src/trayfresh.ts) the one running is "TOMLIN.old.exe" until the next start:
 * it is found too.
 */
export function trayScript(exe: string, stop: boolean): string {
  const old = sideExe(exe, 'old');
  const name = basename(exe).replace(/\.exe$/i, '');
  const find = `Get-Process -Name ${q(name)},${q(`${name}.old`)} -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(exe)} -or $_.Path -eq ${q(old)} }`;
  return stop ? `${find} | Stop-Process -Force` : `@(${find}).Count`;
}

/** The PowerShell that says where a shortcut points ('' when it is not a shortcut). */
export const shortcutTargetScript = (lnk: string) => `(New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)}).TargetPath`;

/** reg.exe lines for the entry in Settings > Apps (this user only); its Uninstall runs the program with --uninstall. */
export function registryArgs(key: string, o: { root: string; version: string; kb: number }): string[][] {
  const exe = exeIn(o.root);
  const values: [string, string, string][] = [
    ['DisplayName', 'REG_SZ', NAME],
    ['DisplayVersion', 'REG_SZ', o.version],
    ['Publisher', 'REG_SZ', NAME],
    ['DisplayIcon', 'REG_SZ', `${exe},0`],
    ['InstallLocation', 'REG_SZ', o.root],
    ['UninstallString', 'REG_SZ', `"${exe}" --uninstall`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(Math.max(1, Math.round(o.kb)))],
  ];
  return values.map(([name, type, data]) => ['add', key, '/v', name, '/t', type, '/d', data, '/f']);
}

/** The compiler's arguments that build the program from tools/tray.cs with the icon. */
export function cscArgs(o: { out: string; source: string; icon: string }): string[] {
  return ['-nologo', '-target:winexe', '-optimize+', `-win32icon:${o.icon}`, `-out:${o.out}`, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', o.source];
}

/** The firewall rule for a node, as PowerShell run once as administrator (Windows asks first); none when one is there (under any of its names). */
export function firewallScript(port: number, ruleName: string, oldNames: string[] = []): string {
  return `if (-not (Get-NetFirewallRule -DisplayName ${[ruleName, ...oldNames].map(q).join(',')} -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName ${q(ruleName)} -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Domain | Out-Null }`;
}

/** How many firewall rules have one of those names, as PowerShell (reading them needs no administrator): "0" when none. */
export const firewallRuleCountScript = (...names: string[]) => `@(Get-NetFirewallRule -DisplayName ${names.map(q).join(',')} -ErrorAction SilentlyContinue).Count`;

/** The firewall rule (under any of its names) taken away again (uninstall), as PowerShell run once as administrator. */
export function removeFirewallScript(...names: string[]): string {
  return `Get-NetFirewallRule -DisplayName ${names.map(q).join(',')} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`;
}

/** PowerShell that runs `script` in a hidden PowerShell as administrator (Windows asks first) and waits for it. */
export function elevatedPowerShell(script: string): string {
  return `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${Buffer.from(script, 'utf16le').toString('base64')}'`;
}

/**
 * Whether what answered GET /api/status on TOMLIN's port is TOMLIN (any version, earlier names too): it says its
 * version and its panes, or (its app lock on) that it is locked. Anything else is another program using the port.
 */
export function isTomlinStatus(code: number, text: string): boolean {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return false;
  }
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (code === 200 && typeof o.version === 'string' && !!o.panes && typeof o.panes === 'object') || (code === 423 && o.locked === true);
}

/** What the installer says when TOMLIN's port answers: another TOMLIN to close, or another program in the way. */
export function portTakenLine(port: number | string, tomlin: boolean): string {
  return tomlin
    ? `Another TOMLIN is running on port ${port} (started with Start TOMLIN.cmd). Close its window.`
    : `Another program is using port ${port}, which TOMLIN needs. Close that program, then carry on. To see which program it is, run this in PowerShell: Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`;
}

/** The copies in the install folder that go: all but the one in use and the newest others, KEEP_COPIES in all. */
export function copiesToRemove(names: string[], current: string): string[] {
  const copies = names.filter(n => /^tomlin-\d+(\.\d+)+( \(\d+\))?$/.test(n) && n !== current);
  const ver = (n: string) => n.replace(/^tomlin-/, '').replace(/ \(\d+\)$/, '');
  copies.sort((a, b) => (newer(ver(a), ver(b)) ? -1 : newer(ver(b), ver(a)) ? 1 : b.localeCompare(a)));
  return copies.slice(KEEP_COPIES - 1);
}

/** The Start TOMLIN when this PC starts file's text when TOMLIN is installed: the program, with no window at the start. */
export function startupScriptFor(exe: string): string {
  return [
    '@echo off',
    'rem Made by TOMLIN (Network: "Start TOMLIN when this PC starts"). Untick it there to remove this file.',
    `start "" "${exe.replace(/%/g, '%%')}" --quiet`,
    '',
  ].join('\r\n');
}

/** The PowerShell that says a file's file version ('' when it has none). */
export const fileVersionScript = (file: string) => `$v = (Get-Item -LiteralPath ${q(file)}).VersionInfo.FileVersionRaw; if ($v) { $v.ToString() }`;

/** The PowerShell that says whether a file is signed, and by whom: "Valid|Microsoft Corporation". */
export const signatureScript = (file: string) => `$s = Get-AuthenticodeSignature -LiteralPath ${q(file)}; "$($s.Status)|$(if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) })"`;

/** True when signatureScript's answer is a good signature by Microsoft. */
export const signedByMicrosoft = (said: string) => said.trim() === 'Valid|Microsoft Corporation';

/** The PowerShell that runs a program as administrator (Windows asks first), waits, and says its exit code. */
export function elevatedRunScript(file: string, args: string[]): string {
  return `$p = Start-Process -FilePath ${q(file)} -ArgumentList ${args.map(q).join(',')} -Verb RunAs -Wait -PassThru; $p.ExitCode`;
}

/** The Visual C++ Runtime installer's exit code in plain words; null = it worked. 3010 = worked, restart later. */
export function redistResult(code: number): string | null {
  if (code === 0 || code === 3010 || code === 1638) return null;
  if (code === 1602) return 'it was cancelled';
  if (code === 1618) return 'another installation was running on this PC; try again when it has finished';
  return `Microsoft's installer ended with code ${code}`;
}
