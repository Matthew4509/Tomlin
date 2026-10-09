// The program (TOMLIN.exe; Smart Manager.exe in an install made before the TOMLIN name) is built on the PC by the
// installer, once. An update pushed from a linked PC brings a new tools/tray.cs but never a new program, so a fix to the program would need the installer run by hand on every PC.
// Instead an installed copy, once it is running, builds the program again when tools/tray.cs is not the one it was
// built from (tray.sha256 in the install folder says which). Windows lets a running program be renamed but not
// replaced: the running one becomes "TOMLIN.old.exe" and the new one takes its name, used from the next start
// (the next sign-in, or Quit and start it again). Plain functions, tested in test/trayfresh.test.ts.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CURRENT, cscArgs, exeIn, places, sideExe } from './installer.ts';

/** Beside the program: the SHA-256 of the tools/tray.cs it was built from. */
export const STAMP = 'tray.sha256';
/** The program renamed while it runs, so a new one can take its name ("TOMLIN.old.exe"). */
export const oldExe = (exe: string): string => sideExe(exe, 'old');

/** The SHA-256 of a copy's tools/tray.cs, the same with either line ending. */
export async function traySum(appRoot: string): Promise<string> {
  const text = (await readFile(join(appRoot, 'tools', 'tray.cs'), 'utf8')).replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

export type Build = (o: { out: string; source: string; icon: string }) => Promise<void>;

/** The C# compiler that comes with Windows, as the installer runs it. */
export const cscBuild = (csc: string[] = places().csc): Build => async o => {
  const exe = csc.find(c => existsSync(c));
  if (!exe) throw new Error('the C# compiler that comes with Windows (.NET Framework 4) is not on this PC');
  await promisify(execFile)(exe, cscArgs(o), { windowsHide: true, maxBuffer: 1 << 20 }).catch(e => {
    throw new Error(String((e as { stdout?: string }).stdout || (e as Error).message).trim().slice(0, 400));
  });
};

/**
 * An installed copy's program, made the one its tools/tray.cs describes. 'not-installed': this copy is not in an
 * install folder (an unzipped copy, the source tree); 'same': nothing to do; 'built': the new program is in place.
 */
/** A rename that tries again for a few seconds while a virus scanner holds a freshly built program. */
export async function renameSoon(from: string, to: string): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise(r => setTimeout(r, 300 * i));
    }
  }
}

export async function refreshTray(appRoot: string, build: Build = cscBuild()): Promise<'not-installed' | 'same' | 'built'> {
  const dir = dirname(resolve(appRoot));
  const exe = exeIn(dir);
  const old = oldExe(exe);
  if (!existsSync(exe) || !existsSync(join(dir, CURRENT)) || !existsSync(join(appRoot, 'tools', 'tray.cs'))) return 'not-installed';
  // Only the copy current.txt names builds it: an older copy kept beside it (for going back) never puts its own back.
  const named = (await readFile(join(dir, CURRENT), 'utf8').catch(() => '')).trim();
  if (named && resolve(dir, named).toLowerCase() !== resolve(appRoot).toLowerCase()) return 'same';
  // The one renamed last time is not running any more once the PC (or TOMLIN) has started again.
  await rm(old, { force: true }).catch(() => undefined);
  const sum = await traySum(appRoot);
  if ((await readFile(join(dir, STAMP), 'utf8').catch(() => '')).trim() === sum) return 'same';
  const fresh = sideExe(exe, 'new');
  const icon = existsSync(join(dir, 'icon.ico')) ? join(dir, 'icon.ico') : join(appRoot, 'public', 'icon.ico');
  await rm(fresh, { force: true });
  await build({ out: fresh, source: join(appRoot, 'tools', 'tray.cs'), icon });
  if (existsSync(old)) {
    // The one renamed last time is still running (nothing has started again since): try again at the next start.
    await rm(fresh, { force: true });
    throw new Error(`${basename(old)} is still in use; the program is built again at the next start`);
  }
  await renameSoon(exe, old);
  try {
    await renameSoon(fresh, exe);
  } catch (error) {
    await rename(old, exe).catch(() => undefined);
    throw error;
  }
  await writeFile(join(dir, STAMP), sum);
  return 'built';
}
