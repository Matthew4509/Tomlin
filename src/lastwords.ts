// Last words: every way this server ends leaves a line in the log (src/log.ts) saying why, so a TOMLIN found stopped
// explains itself. An end the server sees (a code it chose, a signal, a fault that ends it) is written as it ends. An
// end it cannot see (the TOMLIN program by the clock closed, which ends it with it; Task Manager; the PC turned off;
// a crash inside Node) leaves the running mark behind, and the next start writes what it can tell from it: when this
// run was last seen alive, and whether Windows has started again since. Tested in test/lastwords.test.ts.
import { readFileSync, rmSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { writeAtomicSync } from './atomic.ts';
import { log } from './log.ts';

/** The running mark in the log folder: this run's process, when it started and when it was last seen alive. */
export const MARK = 'running-now.json';
/** How often the mark says "still alive" (so a silent end is placed within this much). */
export const ALIVE_MS = 60_000;

export interface Mark {
  pid: number;
  version: string;
  started: number;
  alive: number;
}

/** What an exit code means (src/keep.ts, src/update.ts, src/server/core.ts, src/server/install.ts). */
export function codeMeans(code: number): string {
  switch (code) {
    case 0: return 'closed';
    case 1: return 'a fault ended it (see the lines above)';
    case 75: return 'restarting to apply what was changed';
    case 76: return 'restarting into the new version';
    case 77: return 'another TOMLIN already runs for this home';
    case 78: return 'handed over to the installed program';
    default: return 'ended by its own code';
  }
}

/** The line written as the server ends. */
export function exitLine(code: number, why: string | null): string {
  return `TOMLIN stopped (code ${code}): ${why ?? codeMeans(code)}.`;
}

const hm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The line the next start writes for a run that ended without last words. `bootAt`: when Windows last started. */
export function silentEndLine(m: Mark, bootAt: number): string {
  const head = `The last run (TOMLIN ${m.version}, process ${m.pid}, started ${hm(m.started)}) ended without saying why; it was last seen alive at ${hm(m.alive)}.`;
  return bootAt > m.alive
    ? `${head} Windows started again at ${hm(bootAt)}, so the PC was turned off, restarted or lost power while TOMLIN ran (Windows does not start TOMLIN by itself unless "Start TOMLIN when this PC starts" is on).`
    : `${head} Windows kept running (up since ${hm(bootAt)}), so it was ended from outside: the TOMLIN program by the clock closed or was ended (it ends TOMLIN with it), Task Manager or a command ended node.exe, or Node itself crashed (out of memory). A line from the program by the clock, if it saw it, is above.`;
}

const readMark = (file: string): Mark | null => {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Mark;
    return Number.isFinite(m.pid) && Number.isFinite(m.started) && Number.isFinite(m.alive) ? m : null;
  } catch {
    return null;
  }
};

let why: string | null = null;
/** Says why the server is about to end (before process.exit), for its last line. The first reason given is kept. */
export function endingBecause(reason: string): void {
  why ??= reason;
}

/** Ends the server with its reason written: a signal (Ctrl+C, the window closed) or a deliberate stop. */
export function endBecause(reason: string, code = 0): never {
  endingBecause(reason);
  process.exit(code);
}

let started = false;
/**
 * Starts the last words for this run in `logDir` (after openLog): a silent end of the run before is written now, the
 * mark is set, kept alive, and removed with the last line when the server ends.
 */
export function startLastWords(logDir: string, version: string, o: { now?: () => number; bootAt?: number } = {}): void {
  if (started) return;
  started = true;
  const now = o.now ?? Date.now;
  const file = join(logDir, MARK);
  const before = readMark(file);
  if (before && before.pid !== process.pid) log.warn('stopped', silentEndLine(before, o.bootAt ?? now() - uptime() * 1000));
  const mark: Mark = { pid: process.pid, version, started: now(), alive: now() };
  const keep = () => {
    mark.alive = now();
    try {
      // Whole or not at all: a mark cut short by a full disk would place the next silent end wrongly.
      writeAtomicSync(file, JSON.stringify(mark));
    } catch {
      // A mark that cannot be written must never stop the app.
    }
  };
  keep();
  log.info('started', `TOMLIN ${version} started (process ${process.pid}).`);
  setInterval(keep, ALIVE_MS).unref();
  process.on('exit', code => {
    const c = typeof code === 'number' ? code : 0;
    (c === 0 || c === 75 || c === 76 || c === 78 ? log.info : log.warn)('stopped', exitLine(c, why));
    try {
      rmSync(file, { force: true });
    } catch {
      // As above.
    }
  });
}
