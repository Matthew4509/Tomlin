// When a model runner (llama-server, rpc-server, sd-server) ends on its own, the log says which, how it ended (exit code
// or signal), how long it ran and the last lines it wrote to its error output, so a dropped link ("terminated", "fetch
// failed") on the PC that used it can be explained afterwards from the log. The lines are trimmed and anything that
// looks like a key, an address or a user's folder is taken out (src/report.ts scrub). Tested in test/runnerexit.test.ts.
import type { ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { log } from './log.ts';
import { scrub } from './report.ts';

/** The most lines of a runner's error output kept for the log. */
export const TAIL_LINES = 20;
/** The most characters of one of those lines. */
const LINE_MAX = 300;

/** The lines as they go in the log: trimmed, empty ones left out, scrubbed, cut to LINE_MAX, the last TAIL_LINES only. */
export const cleanTail = (lines: string[], n = TAIL_LINES): string[] => lines.map(l => scrub(String(l).trim()).slice(0, LINE_MAX)).filter(Boolean).slice(-n);

/** A tail reader (src/maxlend.ts keepTail) whose lines come out cleaned (cleanTail). */
export const cleanedTail = (tail: () => string[]): (() => string[]) => () => cleanTail(tail());

/** How long, in plain words: "40 s", "12 min", "3 h 5 min". */
export function ranFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The log line for a loan of this PC's card or RAM that ended (src/jobrun/maxnode.ts): to whom, after how long (its RPC
 * server ran as long) and why; when the RPC server stopped on its own, `why` holds its exit code and last lines.
 */
export function loanEndWords(e: { to: string; why: string; at: string }, since: string | null | undefined): string {
  const ms = since ? Date.parse(e.at) - Date.parse(since) : NaN;
  return `Stopped lending to "${e.to}"${Number.isFinite(ms) && ms >= 0 ? ` after ${ranFor(ms)}` : ''}: ${e.why}.`;
}

/** The runner's program name without its folder ("llama-server.exe"): a path can hold the user's name. */
export const runnerName = (exe: string): string => basename(String(exe)) || 'a model runner';

/** The log line for a runner that ended on its own. */
export function exitWords(name: string, code: number | null, signal: string | null, ms: number, tail: string[]): string {
  const how = code !== null ? `exit code ${code} (0x${(code >>> 0).toString(16).toUpperCase()})` : signal ? `ended by ${signal}` : 'no exit code';
  const said = tail.length ? `. Its last lines: ${tail.join(' | ')}` : '. It wrote nothing to its error output';
  return `The model runner ${name} stopped on its own after ${ranFor(ms)}: ${how}${said}.`;
}

/**
 * Keeps the last lines `child` writes to its error output, and when it ends without being asked (`asked()` false then),
 * writes one line to the log. `feed`: for a caller that reads the output itself (src/worker.ts splits it into lines for
 * its own use): each whole line is passed in, and nothing here reads the pipe. Without `feed`, the pipe is read here.
 */
export function watchRunner(child: Pick<ChildProcess, 'stderr' | 'once'>, exe: string, asked: () => boolean, o: { feed?: boolean; say?: (line: string) => void } = {}): { line: (l: string) => void } {
  const started = Date.now();
  const lines: string[] = [];
  const line = (l: string) => {
    if (!l.trim()) return;
    lines.push(l.slice(0, LINE_MAX * 2));
    if (lines.length > TAIL_LINES) lines.shift();
  };
  if (!o.feed && child.stderr) {
    let part = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s: string) => {
      const all = (part + s).split(/\r\n|\r|\n/);
      // A line that never ends (a runner printing dots, or one gone wrong) keeps only its end: the log takes no more.
      part = (all.pop() ?? '').slice(-LINE_MAX * 2);
      for (const l of all) line(l);
    });
    child.stderr.on('end', () => line(part));
  }
  let ended: { code: number | null; signal: string | null; ms: number } | null = null;
  child.once('exit', (code: number | null, signal: string | null) => {
    // Asked at the moment it ends: an end that was asked for (Disconnect, a loan that ended) is not a fault.
    if (!asked()) ended = { code, signal, ms: Date.now() - started };
  });
  // Its last lines arrive as its pipes close, just after it ends.
  child.once('close', () => {
    if (ended) (o.say ?? (w => log.warn('runner', w)))(exitWords(runnerName(exe), ended.code, ended.signal, ended.ms, cleanTail(lines)));
  });
  return { line };
}
