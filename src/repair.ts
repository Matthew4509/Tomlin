// Repair install: puts this user's installed TOMLIN back in order without a zip. Pressed in My PC (the PC
// window), in the icon's menu by the clock, or run as `node tools/install.ts repair`; the steps are the same everywhere.
// What goes wrong on a PC, and what a pushed update cannot fix by itself (it only adds a new copy beside the one that
// is RUNNING):
//  - a copy started from an unzipped folder (Start TOMLIN.cmd, or a Start with Windows entry made from it) runs and is
//    updated, while the install keeps its old copy: the program (TOMLIN.exe) then starts that old copy, finds the
//    port taken and stops ("fails to load"). Repair copies the running copy into the install folder and points
//    everything at the program;
//  - current.txt naming a copy that is gone or damaged, the program or its icon missing or built from an older
//    tools/tray.cs, shortcuts and Start with Windows pointing somewhere else, the Settings > Apps entry on an old version.
// It only reads and writes the install folder, the shortcuts, the Startup file and the Apps entry: never the home folder
// (chats, staff, pictures, models). Plain steps with the Windows parts passed in, tested in test/repair.test.ts.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as inst from './installer.ts';
import { STARTUP_FILE, startupDir, startupFileIn, writeStartup } from './autostart.ts';
import { cscBuild, oldExe, renameSoon, STAMP, traySum, type Build } from './trayfresh.ts';
import { appFiles, launcherIn, newFolder } from './update.ts';
import { systemDir, VCRT_URL, vcrtMissing } from './vcrt.ts';

/** The Windows parts, passed in (tests use stand-ins). */
export interface RepairDeps {
  /** Runs PowerShell, gives what it printed. */
  ps: (script: string) => Promise<string>;
  /** Builds the program from a tools/tray.cs. */
  build: Build;
  /** Runs reg.exe with these arguments. */
  reg: (args: string[]) => Promise<void>;
  /** This user's desktop folder (null when Windows does not say). */
  desktop: () => Promise<string | null>;
}

export function windowsDeps(env: NodeJS.ProcessEnv = process.env): RepairDeps {
  const run = promisify(execFile);
  const ps = async (script: string) => (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1 << 20 })).stdout;
  return {
    ps,
    build: cscBuild(inst.places(env).csc),
    reg: async args => void (await run('reg', args, { windowsHide: true })),
    desktop: async () => env.TOMLIN_DESKTOP_DIR ?? ((await ps("[Environment]::GetFolderPath('Desktop')").catch(() => '')).trim() || null),
  };
}

export interface RepairStep {
  say: string;
  /** A step the rest depends on (copying the app in): when it fails, nothing after it runs. */
  first?: boolean;
  run: () => Promise<void>;
}

export interface RepairPlan {
  /** What Repair install would do, in order (none: nothing to repair). */
  steps: RepairStep[];
  /** What it cannot do, and the way out. */
  left: string[];
  /** The install folder and its program. */
  root: string;
  exe: string;
  /** The copy the program runs after the repair, and its version (null: none to run). */
  copy: string | null;
  version: string | null;
  /** This copy runs from outside the install folder: once repaired, the program should start instead of it. */
  outside: boolean;
  /** An install folder with a program and current.txt was found. */
  installed: boolean;
}

const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
/** PowerShell's path for a reg.exe key ("HKCU\..." -> "Registry::HKEY_CURRENT_USER\..."). */
const regPath = (key: string) => `Registry::${key.replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Where a shortcut points ('' when there is none, or Windows does not say). */
async function shortcutTarget(d: RepairDeps, lnk: string): Promise<string> {
  if (!existsSync(lnk)) return '';
  return (await d.ps(inst.shortcutTargetScript(lnk)).catch(() => '')).trim();
}

/** The program a Start with Windows file starts, in words. */
function startsWhat(text: string): string {
  const m = /"([^"]+\.(?:exe|cmd))"/i.exec(text);
  return m ? m[1] : 'something else';
}

/**
 * What Repair install would do on this PC. `here` is the copy asking (the running one, or the one the icon or
 * tools/install.ts runs from) and `version` its version.
 */
export async function planRepair(o: { here: string; version: string; env?: NodeJS.ProcessEnv }, d: RepairDeps): Promise<RepairPlan> {
  const env = o.env ?? process.env;
  const P = inst.places(env);
  const exe = inst.exeIn(P.root);
  const exeName = basename(exe);
  const icon = join(P.root, 'icon.ico');
  const steps: RepairStep[] = [];
  const left: string[] = [];
  const here = resolve(o.here);
  const hereIn = same(dirname(here), P.root);
  const cur = inst.currentCopy(P.root);
  const curMissing = cur ? inst.missingFiles(cur.dir) : [];
  const installed = existsSync(exe) || !!cur;
  const plan: RepairPlan = { steps, left, root: P.root, exe, copy: null, version: null, outside: !hereIn, installed };

  // The copy the program will run: `target.dir` is known only once a copy has been made.
  const target = { dir: '', version: '', copied: false };
  if (hereIn) {
    const miss = inst.missingFiles(here);
    if (miss.length) left.push(`Files are missing from ${here}: ${miss.join(', ')}. A security program may have taken them. Run "Install TOMLIN.cmd" from a TOMLIN zip to put them back.`);
    // An older copy kept beside the current one (for going back) never takes over from a whole, newer current copy.
    if (cur && !curMissing.length && !same(cur.dir, here) && inst.newer(cur.version, o.version)) Object.assign(target, { dir: cur.dir, version: cur.version });
    else Object.assign(target, { dir: here, version: o.version });
  } else if (cur && !curMissing.length && !inst.newer(o.version, cur.version)) {
    Object.assign(target, { dir: cur.dir, version: cur.version });
  } else if (existsSync(join(here, '.git'))) {
    // The source folder (a git working tree) is never copied in: an install comes from a release.
    left.push(installed
      ? `The installed TOMLIN ${cur ? `(${cur.version}) ${curMissing.length ? 'is missing files' : 'is older than this one'}` : 'has no copy to run'}, and this copy runs from its source folder (${here}), which is never copied in. Install from a TOMLIN zip with "Install TOMLIN.cmd".`
      : `TOMLIN is not installed on this PC: this copy runs from its source folder (${here}). Install it from a TOMLIN zip with "Install TOMLIN.cmd".`);
    if (cur && !curMissing.length) Object.assign(target, { dir: cur.dir, version: cur.version });
  } else {
    const miss = inst.missingFiles(here);
    if (miss.length) {
      left.push(`This copy (${here}) is missing files too (${miss.join(', ')}), so it is not copied in. Run "Install TOMLIN.cmd" from a TOMLIN zip.`);
    } else {
      Object.assign(target, { dir: here, version: o.version, copied: true });
      steps.push({
        say: !installed
          ? `Install this TOMLIN (${o.version}) in ${P.root}: it is not installed yet`
          : cur && !curMissing.length
            ? `Copy this TOMLIN (${o.version}) into the install folder: the installed copy is ${cur.version}, so updates from linked PCs reached this copy instead`
            : cur
              ? `Copy this TOMLIN (${o.version}) into the install folder: the installed copy (${cur.name}) is missing ${curMissing.join(', ')}`
              : `Copy this TOMLIN (${o.version}) into the install folder: current.txt names no copy to run`,
        first: true,
        run: async () => {
          const dest = await newFolder(P.root, o.version);
          for (const f of await appFiles(here)) {
            const to = join(dest, ...f.path.split('/'));
            await mkdir(dirname(to), { recursive: true });
            await copyFile(join(here, ...f.path.split('/')), to);
          }
          for (const sub of ['models/chat', 'models/image/loras']) await mkdir(join(dest, ...sub.split('/')), { recursive: true });
          target.dir = dest;
        },
      });
    }
  }
  const vc = vcrtMissing(systemDir(env));
  if (vc.length) left.push(`This PC does not have the Microsoft Visual C++ Runtime (${vc.join(', ')} missing), so no model will load. Install it from Microsoft (${VCRT_URL}), then press Connect.`);
  if (!target.version) return plan;
  plan.copy = target.copied ? null : target.dir;
  plan.version = target.version;
  // Every copy of one version has the same tools/tray.cs: the one asking stands in for a copy not made yet.
  const traySource = () => join(target.dir, 'tools', 'tray.cs');
  const sum = await traySum(target.copied ? here : target.dir).catch(() => '');

  // The program, and the tools/tray.cs it was built from.
  const stamp = (await readFile(join(P.root, STAMP), 'utf8').catch(() => '')).trim();
  if (!existsSync(exe) || !existsSync(icon) || stamp !== sum) {
    steps.push({
      say: !existsSync(exe) ? `Build ${exeName}: it is missing` : stamp !== sum ? `Build ${exeName} again: it was built from another version's program file` : 'Put the program icon back',
      run: async () => {
        await mkdir(P.root, { recursive: true });
        if (!existsSync(icon)) await copyFile(join(target.dir, 'public', 'icon.ico'), icon);
        if (existsSync(exe) && stamp === sum) return;
        const fresh = inst.sideExe(exe, 'new');
        await rm(fresh, { force: true });
        await d.build({ out: fresh, source: traySource(), icon });
        // A running program can be renamed, not replaced: the one running becomes TOMLIN.old.exe.
        const old = oldExe(exe);
        if (existsSync(exe)) {
          await rm(old, { force: true }).catch(() => undefined);
          if (existsSync(old)) {
            await rm(fresh, { force: true });
            throw new Error(`${basename(old)} is still running. Quit TOMLIN from its icon by the clock, start it again, then repair again`);
          }
          await renameSoon(exe, old);
        }
        try {
          await renameSoon(fresh, exe);
        } catch (error) {
          if (existsSync(old)) await rename(old, exe).catch(() => undefined);
          throw error;
        }
        await writeFile(join(P.root, STAMP), await traySum(target.dir));
      },
    });
  }

  // current.txt: the copy to run.
  if (target.copied || !cur || !same(cur.dir, target.dir)) {
    steps.push({
      say: `Point current.txt at ${target.copied ? `the new copy (tomlin-${o.version})` : target.dir.slice(P.root.length).replace(/^[\\/]+/, '') || target.dir}`,
      run: async () => {
        const name = same(dirname(target.dir), P.root) ? target.dir.slice(resolve(P.root).length).replace(/^[\\/]+/, '') : target.dir;
        const file = join(P.root, inst.CURRENT);
        await writeFile(`${file}.new`, name);
        await rename(`${file}.new`, file);
      },
    });
  }

  // Shortcuts: the Start menu always; the desktop one only when it is there.
  const menu = join(P.startMenu, inst.LINK);
  const menuTo = await shortcutTarget(d, menu);
  if (!same(menuTo || '?', exe)) {
    steps.push({ say: menuTo ? `Point the Start menu shortcut at ${exeName} (it opened ${menuTo})` : `Add ${inst.NAME} to the Start menu`, run: async () => void (await d.ps(inst.shortcutScript(menu, exe))) });
  }
  const desk = await d.desktop();
  const deskLnk = desk ? join(desk, inst.LINK) : '';
  const deskTo = deskLnk ? await shortcutTarget(d, deskLnk) : '';
  // A desktop shortcut under the earlier name that opens this app: replaced by one under the new name.
  const oldDesk = desk ? inst.OLD_LINKS.map(n => join(desk, n)).filter(l => existsSync(l)) : [];
  const oldOurs: string[] = [];
  for (const l of [...inst.OLD_LINKS.map(n => join(P.startMenu, n)).filter(x => existsSync(x)), ...oldDesk]) if (same((await shortcutTarget(d, l)) || '?', exe)) oldOurs.push(l);
  if (deskLnk && !existsSync(deskLnk) && oldOurs.some(l => oldDesk.includes(l))) {
    steps.push({ say: `Add the ${inst.NAME} shortcut to the desktop (in place of the old one)`, run: async () => void (await d.ps(inst.shortcutScript(deskLnk, exe))) });
  } else if (deskLnk && existsSync(deskLnk) && !same(deskTo || '?', exe)) {
    steps.push({ say: `Point the desktop shortcut at ${exeName} (it opened ${deskTo || 'nothing'})`, run: async () => void (await d.ps(inst.shortcutScript(deskLnk, exe))) });
  }
  for (const l of oldOurs) steps.push({ say: `Remove the old shortcut ${l}`, run: () => rm(l, { force: true }) });

  // Start with Windows, when it is on: the program, not a copy's Start TOMLIN.cmd (which never takes updates). A file
  // under the earlier name (Smart Manager.cmd) is put under TOMLIN.cmd.
  const sdir = startupDir(env);
  const sfile = sdir ? startupFileIn(sdir) : '';
  const stext = sfile ? await readFile(sfile, 'utf8').catch(() => '') : '';
  const want = inst.startupScriptFor(exe);
  if (stext && stext !== want) {
    steps.push({ say: `Make "Start with Windows" start ${exeName} (it started ${startsWhat(stext)})`, run: () => writeStartup(sdir!, want) });
  } else if (stext && basename(sfile) !== STARTUP_FILE) {
    steps.push({ say: `Name the "Start with Windows" file ${STARTUP_FILE} (it was ${basename(sfile)})`, run: () => writeStartup(sdir!, want) });
  }

  // The entry in Settings > Apps, on the version that runs.
  if (P.uninstallKey) {
    const listed = (await d.ps(`(Get-ItemProperty -LiteralPath ${q(regPath(P.uninstallKey))} -ErrorAction SilentlyContinue).DisplayVersion`).catch(() => '')).trim();
    if (listed !== target.version) {
      steps.push({
        say: listed ? `Show ${target.version} in Settings > Apps (it says ${listed})` : 'List TOMLIN in Settings > Apps',
        run: async () => {
          const kb = (await appFiles(target.dir)).reduce((n, f) => n + f.bytes, 0) / 1024;
          for (const a of inst.registryArgs(P.uninstallKey!, { root: P.root, version: target.version, kb })) await d.reg(a);
        },
      });
    }
  }

  return plan;
}

export interface RepairResult {
  done: string[];
  failed: string[];
  left: string[];
}

/** Runs the plan's steps in order; a failed first step (copying the app in) stops the rest. */
export async function runRepair(plan: RepairPlan): Promise<RepairResult> {
  const r: RepairResult = { done: [], failed: [], left: [...plan.left] };
  for (const s of plan.steps) {
    try {
      await s.run();
      r.done.push(s.say);
    } catch (e) {
      r.failed.push(`${s.say}: ${String((e as Error).message).replace(/\.$/, '')}.`);
      if (s.first) {
        r.left.push('Nothing else was changed, because the copy was not made. Free some disk space or close programs using those files, then repair again.');
        break;
      }
    }
  }
  return r;
}

/** The desktop shortcut "Shortcut to desktop" makes, and whether one is there now (TOMLIN.lnk on the desktop). */
export async function desktopShortcut(o: { here: string; version: string; env?: NodeJS.ProcessEnv }, d: RepairDeps): Promise<{ lnk: string | null; there: boolean; target: string; opens: string }> {
  const desk = await d.desktop();
  const lnk = desk ? join(desk, inst.LINK) : null;
  const opens = inst.installExe(o.version, o.env) ?? launcherIn(resolve(o.here));
  return { lnk, there: !!lnk && existsSync(lnk), target: lnk ? await shortcutTarget(d, lnk) : '', opens };
}

/** Makes (or makes again) the desktop shortcut: the install's program when installed, else this copy's Start TOMLIN.cmd. */
export async function makeDesktopShortcut(o: { here: string; version: string; env?: NodeJS.ProcessEnv }, d: RepairDeps): Promise<string> {
  const s = await desktopShortcut(o, d);
  if (!s.lnk) throw new Error('Windows did not say where the desktop is');
  const isExe = /\.exe$/i.test(s.opens);
  await d.ps(inst.shortcutScript(s.lnk, s.opens, '', isExe ? `${s.opens},0` : `${join(resolve(o.here), 'public', 'icon.ico')},0`));
  // The same shortcut under the earlier name goes, so the desktop does not show two.
  for (const old of inst.OLD_LINKS.map(n => join(dirname(s.lnk!), n))) if (existsSync(old) && same((await shortcutTarget(d, old)) || '?', s.opens)) await rm(old, { force: true });
  return s.lnk;
}
