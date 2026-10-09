// "Start TOMLIN when this PC starts" (PLAN F7 E5): a node can run all day, every day, without anyone pressing
// Start. Ticking it writes one small file in this Windows user's Startup folder that runs Start TOMLIN.cmd in a
// minimised window at sign-in; unticking deletes that file. Nothing else on the PC is changed. Windows only.
// An installed copy (2.0.34, src/installer.ts) starts its program (TOMLIN.exe) instead, with no window: it never moves, so the
// file still works after an update pushed from a linked PC. Plain functions, tested in test/autostart.test.ts.
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeAtomic } from './atomic.ts';
import { CURRENT, exeIn, installExe, startupScriptFor, versionOf } from './installer.ts';
import { launcherIn } from './update.ts';

/** The install's program when this copy is an installed one (it sits in the install folder beside current.txt), else null. */
export function installedExe(root: string): string | null {
  const dir = dirname(resolve(root));
  const exe = exeIn(dir);
  return existsSync(exe) && existsSync(join(dir, CURRENT)) ? exe : null;
}

export const STARTUP_FILE = 'TOMLIN.cmd';
/** The Startup file under the app's earlier name: read as this one, and removed when this one is written. */
export const OLD_STARTUP_FILES = ['Smart Manager.cmd'];
/** The Startup file in the folder now: TOMLIN.cmd, else one under the earlier name, else (none yet) where TOMLIN.cmd goes. */
export function startupFileIn(dir: string): string {
  return [STARTUP_FILE, ...OLD_STARTUP_FILES].map(n => join(dir, n)).find(f => existsSync(f)) ?? join(dir, STARTUP_FILE);
}
/** Writes the Startup file under its own name, and removes any under the earlier name (so it never starts twice). */
export async function writeStartup(dir: string, text: string): Promise<void> {
  await writeAtomic(join(dir, STARTUP_FILE), text);
  for (const n of OLD_STARTUP_FILES) await rm(join(dir, n), { force: true });
}

/** This Windows user's Startup folder (a test points it elsewhere with TOMLIN_STARTUP_DIR). */
export function startupDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TOMLIN_STARTUP_DIR) return env.TOMLIN_STARTUP_DIR;
  if (process.platform !== 'win32' || !env.APPDATA) return null;
  return join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/**
 * The file's text: the install's program when this copy is installed, or when this PC has an install that is whole and not
 * older than this copy (src/installer.ts installExe); else this copy's Start TOMLIN.cmd, minimised. A % in the folder
 * name is doubled for cmd.
 */
export function startupScript(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const exe = installedExe(root) ?? installExe(versionOf(root), env);
  if (exe) return startupScriptFor(exe);
  const launcher = launcherIn(root).replace(/%/g, '%%');
  return [
    '@echo off',
    'rem Made by TOMLIN (Nodes and memory: "Start TOMLIN when this PC starts"). Untick it there to remove this file.',
    `start "TOMLIN" /min "${launcher}"`,
    '',
  ].join('\r\n');
}

export function autostart(root: string, env: NodeJS.ProcessEnv = process.env) {
  const file = () => {
    const dir = startupDir(env);
    return dir ? startupFileIn(dir) : null;
  };
  return {
    /** True when the file is there and starts this copy. */
    async on(): Promise<boolean> {
      const f = file();
      if (!f) return false;
      try {
        return (await readFile(f, 'utf8')) === startupScript(root, env);
      } catch {
        return false;
      }
    },
    async set(on: boolean): Promise<void> {
      const dir = startupDir(env);
      if (!dir) throw new Error('this works on Windows only.');
      if (on) await writeStartup(dir, startupScript(root, env));
      else for (const n of [STARTUP_FILE, ...OLD_STARTUP_FILES]) await rm(join(dir, n), { force: true });
    },
  };
}
