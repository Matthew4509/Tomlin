// The log file (PLAN F10 G8): errors and warnings, one plain-text file a day in data/logs ("2026-10-05.log"), the
// last 7 days kept. It holds what went wrong and where (a request, a model that would not load, a chat or job step that
// stopped), never a chat's words, a prompt or a file's text, so it can be sent to someone who helps. Everything written
// to console.error and console.warn lands here too. Help has "Open the log". Tested in test/log.test.ts.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { onExit } from './exithook.ts';

export const KEEP_DAYS = 7;
const NAME = /^(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_LINE = 2000;
/** One day's file stops growing here (a fault repeating every second would otherwise fill the disk and every backup). */
export const MAX_DAY_BYTES = 20 * 2 ** 20;

let dir: string | null = null;

/** Where the log goes from now on; files older than a week are deleted. `repeat`: see REPEAT_MS (shorter in tests). */
export function openLog(logDir: string, now = new Date(), repeat = REPEAT_MS): void {
  // A count still waiting belongs to the old place.
  flushLog();
  last = { key: '', at: 0, more: 0, lastAt: new Date(0) };
  repeatMs = repeat;
  dir = logDir;
  lastDay = '';
  if (!flushOnExit) {
    flushOnExit = true;
    onExit(flushLog);
  }
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

/** The most lines a linked PC can ask for at once. */
export const MAX_TAIL = 1000;

/**
 * Today's last `n` lines (at most MAX_TAIL), for the PC this one is linked to (src/jobrun/node.ts /worker/log): only
 * the end of the file is read, as a day's file can be 20 MB. None when there is no log yet.
 */
export function lastLines(n = 300, now = new Date()): { day: string; lines: string[] } {
  const want = Math.max(1, Math.min(MAX_TAIL, Math.floor(n) || 300));
  return { day: day(now), lines: tailOf(day(now), want) };
}

/** The days a linked PC may ask for: today and the KEEP_DAYS - 1 before it (local dates), newest first. */
export const keptDays = (now = new Date()): string[] => Array.from({ length: KEEP_DAYS }, (_, i) => day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));

/**
 * A day as asked for ("2026-11-17"): only a real date within the days kept, never anything else (it names a file, so a
 * path or a pattern is refused). Undefined or '' means today. Null: refused.
 */
export function cleanLogDay(v: unknown, now = new Date()): string | null {
  if (v === undefined || v === null || v === '') return day(now);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return keptDays(now).includes(v) ? v : null;
}

/** A word to look for in a day's lines: plain text, up to 100 characters, no line breaks. '' means every line. */
export const cleanLogFind = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '');

/**
 * What a linked PC asked of this PC's log (src/jobrun/node.ts /worker/log): the last `lines` lines of `day` (today when
 * not given), only those holding `find` (any case) when it is given, and the days that have a file. A whole day is read
 * only for a search (20 MB at most); otherwise only its end.
 */
export function askLog(ask: { lines?: unknown; day?: unknown; find?: unknown }, now = new Date()): { day: string; lines: string[]; days: string[]; find: string } | { error: string } {
  const want = Math.max(1, Math.min(MAX_TAIL, Math.floor(Number(ask.lines)) || 300));
  const asked = cleanLogDay(ask.day, now);
  if (!asked) return { error: `that day is not kept here: ask for one of the last ${KEEP_DAYS} days, written as 2026-11-17.` };
  const find = cleanLogFind(ask.find);
  const days = dir ? keptDays(now).filter(x => existsSync(join(dir!, `${x}.log`))) : [];
  if (!find) return { day: asked, lines: tailOf(asked, want), days, find };
  const lower = find.toLowerCase();
  let lines: string[] = [];
  try {
    if (dir) lines = readFileSync(join(dir, `${asked}.log`), 'utf8').split('\n').filter(l => l && l.toLowerCase().includes(lower));
  } catch {
    // No file that day: no lines.
  }
  return { day: asked, lines: lines.slice(-want), days, find };
}

const isDay = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);

/**
 * A linked PC's answer to askLog, read on the PC that asked (src/jobrun/links.ts nodeLog): its lines kept as text and
 * trimmed. A TOMLIN from before days and search has no `days` in its answer and sends today's lines whatever was asked:
 * `todayOnly` says so, and the search is then done here on what came. A refusal keeps its own words.
 */
export function logAnswer(status: number, got: unknown, ask: { day?: string; find?: string } = {}): { state: 'on'; day: string; lines: string[]; days: string[]; todayOnly?: true } | { state: 'off'; error?: string } {
  const x = got && typeof got === 'object' ? (got as { day?: unknown; lines?: unknown; days?: unknown; error?: unknown }) : null;
  // A day it does not keep, or a door it refuses this link: its own words.
  if ((status < 200 || status > 299) && typeof x?.error === 'string') return { state: 'off', error: x.error.slice(0, 300) };
  if (status < 200 || status > 299 || !x || !Array.isArray(x.lines)) return { state: 'off' };
  let lines = x.lines.filter((l): l is string => typeof l === 'string').slice(-MAX_TAIL).map(l => l.slice(0, 4000));
  const older = !Array.isArray(x.days);
  const find = cleanLogFind(ask.find).toLowerCase();
  if (older && find) lines = lines.filter(l => l.toLowerCase().includes(find));
  const days = older ? [] : (x.days as unknown[]).filter(isDay).slice(0, 14);
  return { state: 'on', day: isDay(x.day) ? x.day : '', lines, days, ...(older && (ask.day || find) ? { todayOnly: true as const } : {}) };
}

/** The last `want` lines of one day's file: only its end is read. */
function tailOf(name: string, want: number): string[] {
  if (!dir) return [];
  try {
    const fd = openSync(join(dir, `${name}.log`), 'r');
    try {
      const size = fstatSync(fd).size;
      const bytes = Math.min(size, want * (MAX_LINE + 40));
      const buf = Buffer.alloc(bytes);
      readSync(fd, buf, 0, bytes, size - bytes);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      // A read that starts mid-file starts mid-line: that part line is left out.
      if (bytes < size) lines.shift();
      return lines.slice(-want);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

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
/** The same entry again within this long is counted, not written (a fault repeating every second fills a day's file). */
export const REPEAT_MS = 60_000;
let repeatMs = REPEAT_MS;
let last = { key: '', at: 0, more: 0, lastAt: new Date(0) };
let repeatTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Writes how many times the last entry came again, if it did: when something else is written, when its minute is up,
 * when the log moves and when the app closes. It is timed at the last repeat, so it lands in that day's file.
 */
export function flushLog(): void {
  clearTimeout(repeatTimer);
  repeatTimer = undefined;
  if (!last.more) return;
  const n = last.more;
  last.more = 0;
  append(logLine('info', 'log', `The entry above came ${n} more time${n === 1 ? '' : 's'} (not written one by one).`, last.lastAt), last.lastAt);
}

let flushOnExit = false;

function write(level: 'error' | 'warn' | 'info', where: string, what: string): void {
  if (!dir) return;
  const now = new Date();
  try {
    const key = `${level}|${where}|${what}`;
    if (key === last.key && now.getTime() - last.at < repeatMs) {
      last.more++;
      last.lastAt = now;
      if (!repeatTimer) {
        repeatTimer = setTimeout(flushLog, Math.max(0, last.at + repeatMs - now.getTime()));
        repeatTimer.unref?.();
      }
      return;
    }
    flushLog();
    last = { key, at: now.getTime(), more: 0, lastAt: now };
    append(logLine(level, where, what, now), now);
  } catch {
    // As above: never let the log stop the app.
  }
}

/** One line into today's file, within the day's cap. */
function append(text: string, now: Date): void {
  if (!dir) return;
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
    let line = text;
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
