// One TOMLIN per home folder. A second copy started on the same home (the installed one runs, and Start
// TOMLIN.cmd is double-clicked in an unzipped folder) stops before it touches anything: no backup, no data rewritten,
// and no "left over" model runners ended under the copy that is running. Tested in test/stability.test.ts.
//
// A lock left behind repairs itself. After a crash or a power cut the lock names a process that has ended; Windows can
// give that number to another program later, so "a process with that number runs" is not enough. The lock file's time
// says when it was written (it holds the number alone, as every version reads it), and Windows says what the process is
// and when it started: one that is not Node, or started after the
// lock was written, is not TOMLIN, and the lock is taken over. When Windows cannot say (no PowerShell), the
// start leaves a note (start-attempt.json); a second start that finds the note, and nothing answering on Smart
// Manager's port, takes the lock over. A start that gets the lock removes the note.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'running.lock';
export const ATTEMPT_FILE = 'start-attempt.json';

/** Whether a process with this id is running now. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it is there, owned by someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process a lock names, and when the lock was written (the file's own time; null when it cannot be read). */
export interface Holder {
  pid: number;
  at: string | null;
}

export function readHolder(file: string): Holder {
  const pid = Number(readFileSync(file, 'utf8').trim());
  let at: string | null = null;
  try {
    at = statSync(file).mtime.toISOString();
  } catch {
    // Gone meanwhile.
  }
  return { pid, at };
}

/** What Windows says about a running process: its program's name and when it started (null when it cannot say). */
export function processInfo(pid: number): { name: string; started: string } | null {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.Name; $p.CreationDate.ToUniversalTime().ToString('o') }`], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const [name, started] = out.trim().split(/\r?\n/).map(s => s.trim());
    return name && started && !Number.isNaN(Date.parse(started)) ? { name, started } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the process a lock names is TOMLIN still running: 'stale' when it is another program (not Node), or
 * started after the lock was written (Windows gave the number to it later); 'running' when it is Node and was there
 * when the lock was written; 'unsure' when Windows could not say.
 */
export function judge(h: Holder, info: { name: string; started: string } | null): 'stale' | 'running' | 'unsure' {
  if (!info) return 'unsure';
  if (!/^node(\.exe)?$/i.test(info.name)) return 'stale';
  // A few seconds' room: the lock is written just after the process starts.
  if (h.at && Date.parse(info.started) > Date.parse(h.at) + 5000) return 'stale';
  return 'running';
}

export type Taken = { ok: true; repaired?: string } | { other: number; unsure?: boolean };

/**
 * Takes the home folder for this process: { ok } when it is free (or its lock was left by a copy that has ended),
 * { other: pid } when a running copy holds it (unsure: Windows could not say what that process is). The lock goes when
 * this process ends. `check` says what the holding process is (src/onecopy.ts judge with processInfo).
 */
export function takeHome(home: string, pid = process.pid, alive = isAlive, check: (h: Holder) => ReturnType<typeof judge> = h => judge(h, processInfo(h.pid))): Taken {
  mkdirSync(home, { recursive: true });
  const file = join(home, LOCK_FILE);
  let repaired: string | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' });
      return repaired ? { ok: true, repaired } : { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readHolder(file);
      if (held.pid !== pid && alive(held.pid)) {
        const said = check(held);
        if (said === 'running') return { other: held.pid };
        if (said === 'unsure') return { other: held.pid, unsure: true };
        repaired = `the lock named process ${held.pid}, which is now another program (TOMLIN had ended without removing it)`;
      }
      // Left by a copy that has ended (closed hard, or the PC turned off), or its number now belongs to another program.
      unlinkSync(file);
    }
  }
  return { other: -1 };
}

/**
 * At the start: takes the home folder, repairing a lock left behind (see the top of this file). `answers` says whether
 * something answers on TOMLIN's own port now. A start that gets the lock removes the attempt note.
 */
export async function takeHomeOrRepair(home: string, answers: () => Promise<boolean>, o: { pid?: number; alive?: typeof isAlive; check?: (h: Holder) => ReturnType<typeof judge>; now?: number } = {}): Promise<Taken> {
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now();
  const note = join(home, ATTEMPT_FILE);
  let took = takeHome(home, pid, o.alive, o.check);
  if ('other' in took && took.unsure) {
    let before: { at?: unknown; pid?: unknown } | null = null;
    try {
      before = JSON.parse(readFileSync(note, 'utf8'));
    } catch {
      before = null;
    }
    const age = before && typeof before.at === 'string' ? now - Date.parse(before.at) : NaN;
    // The second start (a first one was refused the same way, 20 s to an hour ago) with nothing on the port: repaired.
    if (Number(before?.pid) === took.other && age >= 20_000 && age < 3_600_000 && !(await answers())) {
      try {
        unlinkSync(join(home, LOCK_FILE));
      } catch {
        // Gone meanwhile.
      }
      const again = takeHome(home, pid, o.alive, o.check);
      if ('ok' in again) took = { ok: true, repaired: `a second start found the lock still naming process ${took.other} and nothing answering on TOMLIN's port` };
    } else writeFileSync(note, JSON.stringify({ at: new Date(now).toISOString(), pid: took.other }));
  }
  if ('ok' in took) {
    try {
      unlinkSync(note);
    } catch {
      // There was none.
    }
  }
  return took;
}

/** Gives the home folder back (at the end of this process), only when this process still holds it. */
export function releaseHome(home: string, pid = process.pid): void {
  const file = join(home, LOCK_FILE);
  try {
    if (Number(readFileSync(file, 'utf8').trim()) === pid) unlinkSync(file);
  } catch {
    // Already gone.
  }
}
