// The model runners this copy started, kept in its data folder (runners.json), so a copy that was ended hard
// (Task Manager, a crash, a power cut) can end the runners it left behind the next time it starts.
// A runner is ended only when its program path AND its start time match what was written: a process number Windows
// has since given to something else is never touched.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Started = { pid: number; exe: string; at: number };

let file: string | null = null;
let list: Started[] = [];

function save(): void {
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(list));
  } catch {
    // A note that cannot be written only means a clean-up after a crash is missed.
  }
}

/** Notes a runner that has just started. */
export function started(pid: number | undefined, exe: string): void {
  if (!pid) return;
  list = [...list.filter(x => x.pid !== pid), { pid, exe, at: Date.now() }];
  save();
}

/** Crosses off a runner that has ended. */
export function ended(pid: number | undefined): void {
  if (!pid) return;
  list = list.filter(x => x.pid !== pid);
  save();
}

/** The leftovers worth ending: the same program, started within 5 s of when it was noted. */
export function stale(noted: Started[], running: Array<{ pid: number; path: string; startMs: number }>): number[] {
  const same = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
  return noted.filter(n => running.some(r => r.pid === n.pid && same(r.path, n.exe) && Math.abs(r.startMs - n.at) < 5000)).map(n => n.pid);
}

const run = (exe: string, args: string[]) =>
  new Promise<string>(resolve => execFile(exe, args, { windowsHide: true, timeout: 20_000 }, (_e, out) => resolve(String(out ?? ''))));

/** At start: ends what the last run of this copy left behind, then starts a fresh list. Returns how many were ended. */
export async function cleanUp(dataDir: string): Promise<number> {
  mkdirSync(dataDir, { recursive: true });
  file = join(dataDir, 'runners.json');
  let noted: Started[] = [];
  try {
    noted = (JSON.parse(readFileSync(file, 'utf8')) as Started[]).filter(x => Number.isInteger(x?.pid) && typeof x.exe === 'string' && typeof x.at === 'number');
  } catch {
    // no list: nothing was left
  }
  list = [];
  save();
  if (!noted.length || process.platform !== 'win32') return 0;
  const ids = noted.map(n => n.pid).join(',');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)|$([DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds())" }`]);
  const running = out.split(/\r?\n/).filter(Boolean).map(l => l.split('|')).map(([pid, path, ms]) => ({ pid: Number(pid), path: path ?? '', startMs: Number(ms) }));
  const kill = stale(noted, running);
  for (const pid of kill) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  return kill.length;
}
