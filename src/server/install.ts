// This PC's install, in My PC (the PC window): Repair install (src/repair.ts), Shortcut to desktop, and starting the
// installed program (TOMLIN.exe) in place of a copy started from a folder. Start with Windows goes through /api/share, as
// the tick in Nodes and memory does.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { startupDir, startupFileIn } from '../autostart.ts';
import * as inst from '../installer.ts';
import { desktopShortcut, makeDesktopShortcut, planRepair, runRepair, windowsDeps } from '../repair.ts';
import { PORT, ROOT, type Routes, VERSION, json, startupOf } from './core.ts';

/** The exit code that tells Start TOMLIN.cmd its window may close: the installed program takes over. */
export const HANDED_OVER = 78;

const me = () => ({ here: ROOT, version: VERSION });

/** True when the Start with Windows file starts this program. */
async function startupStarts(exe: string): Promise<boolean> {
  const dir = startupDir();
  return !!dir && (await readFile(startupFileIn(dir), 'utf8').catch(() => '')) === inst.startupScriptFor(exe);
}
const windows = process.platform === 'win32' || process.env.TOMLIN_INSTALL_ROOT !== undefined;

async function view() {
  if (!windows) return { windows: false };
  const d = windowsDeps();
  const plan = await planRepair(me(), d);
  const desk = await desktopShortcut(me(), d).catch(() => null);
  return {
    windows: true,
    root: plan.root,
    here: ROOT,
    version: VERSION,
    installed: plan.installed,
    outside: plan.outside,
    // The copy the install runs now (current.txt), and its version.
    current: inst.currentCopy(plan.root),
    steps: plan.steps.map(s => s.say),
    left: plan.left,
    desktop: desk ? { there: desk.there, target: desk.target, opens: desk.opens } : null,
    // On when Start with Windows starts this copy, or the install's program (after Repair install, from a folder copy).
    autostart: (await startupOf.on().catch(() => false)) || (await startupStarts(plan.exe)),
    // Started from a folder while a whole install of this version (or newer) is there: the installed program can take over.
    canSwitch: plan.outside && process.env.TOMLIN_TRAY !== '1' && !!inst.installExe(VERSION),
  };
}

export const installGet: Routes = {
  '/api/install': async ({ res }) => json(res, 200, await view()),
};

export const installPost: Routes = {
  '/api/install/repair': async ({ res }) => {
    if (!windows) return json(res, 400, { error: 'Repair install works on Windows only.' });
    const result = await runRepair(await planRepair(me(), windowsDeps()));
    return json(res, 200, { result, state: await view() });
  },
  '/api/install/desktop': async ({ res }) => {
    if (!windows) return json(res, 400, { error: 'The desktop shortcut works on Windows only.' });
    try {
      const lnk = await makeDesktopShortcut(me(), windowsDeps());
      return json(res, 200, { lnk, state: await view() });
    } catch (e) {
      return json(res, 500, { error: `The shortcut was not made: ${(e as Error).message.replace(/\.$/, '')}. Try again, or right-click TOMLIN in the Start menu and pin it.` });
    }
  },
  '/api/install/switch': async ({ res }) => {
    // This copy (started from a folder) ends; the installed program starts the installed copy once the port is free.
    const exe = inst.installExe(VERSION);
    if (!windows || !exe || process.env.TOMLIN_TRAY === '1') return json(res, 409, { error: 'There is no whole installed TOMLIN of this version to start. Press Repair install first.' });
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = `$t = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $t -and (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }; Start-Process -FilePath ${q(exe)}`;
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    json(res, 200, { ok: true });
    console.log('The installed TOMLIN takes over now (its program runs it, by the clock). This window closes.');
    setTimeout(() => process.exit(HANDED_OVER), 800).unref();
  },
};
