// The log file (PLAN F10 G8): errors and warnings, one plain-text file a day in data/logs ("2026-10-05.log"), the
// last 7 days kept. It holds what went wrong and where (a request, a model that would not load, a chat or job step that
// stopped), never a chat's words, a prompt or a file's text, so it can be sent to someone who helps. Everything written
// to console.error and console.warn lands here too. Help has "Open the log". Tested in test/log.test.ts.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_DAYS = 7;
const NAME = /^(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_LINE = 2000;
/** One day's file stops growing here (a fault repeating every second would otherwise fill the disk and every backup). */
export const MAX_DAY_BYTES = 20 * 2 ** 20;

let dir: string | null = null;

/** Where the log goes from now on; files older than a week are deleted. */
export function openLog(logDir: string, now = new Date()): void {
  dir = logDir;
  try {
    mkdirSync(dir, { recursive: true });
    prune(now);
  } catch {
    // A log that cannot be written must never stop the app.
  }
}

export const logDir = () => dir;

/** Today's file (local date), for "Open the log". */
export const logFile = (now = new Date()) => (dir ? join(dir, `${day(now)}.log`) : null);

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Deletes the day files older than KEEP_DAYS days (by the date in the name). */
export function prune(now = new Date()): number {
  if (!dir) return 0;
  const cutoff = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (KEEP_DAYS - 1)));
  let gone = 0;
  for (const f of readdirSync(dir)) {
    const m = NAME.exec(f);
    if (m && m[1] < cutoff) {
      rmSync(join(dir, f), { force: true });
      gone++;
    }
  }
  return gone;
}

/** One line: "14:02:31 ERROR [where] what", one line per entry (line breaks inside become " | "). */
export function logLine(level: 'error' | 'warn' | 'info', where: string, what: string, now = new Date()): string {
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const text = what.replace(/\r?\n+/g, ' | ').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
  return `${t} ${level.toUpperCase()} [${where}] ${text}\n`;
}

let lastDay = '';
/** Bytes in today's file (read from the file at the first entry of each day, so a restart counts what is there). */
let dayBytes = 0;
function write(level: 'error' | 'warn' | 'info', where: string, what: string): void {
  if (!dir) return;
  const now = new Date();
  try {
    const file = join(dir, `${day(now)}.log`);
    // The first entry of a new day prunes, so a PC left on for weeks still keeps one week.
    if (day(now) !== lastDay) {
      lastDay = day(now);
      prune(now);
      try {
        dayBytes = statSync(file).size;
      } catch {
        dayBytes = 0;
      }
    }
    if (dayBytes >= MAX_DAY_BYTES) return;
    let line = logLine(level, where, what, now);
    if (dayBytes + line.length >= MAX_DAY_BYTES) line = logLine('warn', 'log', `Today's log reached ${MAX_DAY_BYTES / 2 ** 20} MB, so what goes wrong for the rest of today is not written (the same fault is likely repeating: see the lines above).`, now);
    dayBytes += Buffer.byteLength(line);
    appendFileSync(file, line);
  } catch {
    // As above: never let the log stop the app.
  }
}

const said = (x: unknown) => (x instanceof Error ? x.stack ?? x.message : typeof x === 'string' ? x : JSON.stringify(x) ?? String(x));

export const log = {
  error: (where: string, what: unknown) => write('error', where, said(what)),
  warn: (where: string, what: unknown) => write('warn', where, said(what)),
  /** A measurement worth keeping (what a model holds once loaded), not a fault. */
  info: (where: string, what: unknown) => write('info', where, said(what)),
};

/** console.error and console.warn also go to the log (they still print in the window). */
export function logConsole(): void {
  const { error, warn } = console;
  console.error = (...args: unknown[]) => {
    error(...args);
    write('error', 'app', args.map(said).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warn(...args);
    write('warn', 'app', args.map(said).join(' '));
  };
}
