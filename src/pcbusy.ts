// Whether this PC is in use by a person, not only by TOMLIN's own work (N1 of the 27 Nov agents plan): an agent's
// timed run waits while a game or another full-screen program is in front, while another program keeps the graphics
// card busy, or while someone pressed a key or moved the mouse in the last few minutes. Chats and pictures he starts
// himself are never held by it: only the queue's agent items ask (src/server/queue.ts).
//
// Three looks, each cheap and read-only, taken at most once every 30 seconds and only while an agent run is waiting:
// - Windows' own "is a full-screen program in front" (SHQueryUserNotificationState: a Direct3D full-screen game, a
//   full-screen app, or presentation mode);
// - the graphics card's use, from nvidia-smi (skipped quietly when there is no NVIDIA card), read only while TOMLIN
//   itself is not drawing or answering on this PC, so what it sees is another program;
// - when the last key or mouse press was (GetLastInputInfo).
// No window title, program name or process id is read into a log, a report or a reason: the reasons are fixed words.
// The plain parts are tested in test/pcbusy.test.ts; the looks themselves need Windows and are not run by tests
// (TOMLIN_NO_PCLOOK turns them off).
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readData, updateData } from './atomic.ts';
import { NVIDIA_SMI } from './hardware.ts';

/** What the looks found; null for a look that could not be taken (not Windows, no NVIDIA card). */
export interface Looks {
  /** SHQueryUserNotificationState's answer (1-7), or null. */
  screen: number | null;
  /** The graphics card's use in percent (the busiest card), or null. */
  gpu: number | null;
  /** Milliseconds since the last key or mouse press, or null. */
  idleMs: number | null;
}

export interface InUseSettings {
  /** "Agents may run while I use this PC": on, none of the looks holds a run. Unset: on for a node, off otherwise. */
  whileInUse?: boolean;
  /** "Count me as using it for … minutes after a key press" (1-120; default 10). */
  keyMinutes: number;
}

export const KEY_MINUTES = 10;
/** The card counts as used by another program at this much use or more. */
export const GPU_BUSY = 30;
/** A look is taken again after this long, never sooner. */
export const LOOK_EVERY_MS = 30_000;

// SHQueryUserNotificationState: 2 QUNS_BUSY (a full-screen app), 3 QUNS_RUNNING_D3D_FULL_SCREEN, 4 QUNS_PRESENTATION_MODE.
const FULL_SCREEN = new Set([2, 3, 4]);

/** The words a held run says (fixed: no program's name ever goes in). */
export const WHY = {
  screen: 'a full-screen game or program was in front',
  gpu: 'another program was using the graphics card',
  keys: 'someone was using this PC',
} as const;

/**
 * Whether the looks say the PC is in use, and why in words. `ownGpu`: TOMLIN itself is using the card here now (its
 * reading then says nothing about other programs).
 */
export function busyWhy(l: Looks, s: InUseSettings, o: { node: boolean; ownGpu?: boolean }): { busy: boolean; why: string } {
  const allowed = s.whileInUse ?? o.node;
  if (allowed) return { busy: false, why: '' };
  if (l.screen !== null && FULL_SCREEN.has(l.screen)) return { busy: true, why: WHY.screen };
  if (!o.ownGpu && l.gpu !== null && l.gpu >= GPU_BUSY) return { busy: true, why: WHY.gpu };
  const minutes = cleanMinutes(s.keyMinutes);
  if (l.idleMs !== null && l.idleMs < minutes * 60_000) return { busy: true, why: `${WHY.keys} (a key or mouse press in the last ${minutes} minutes)` };
  return { busy: false, why: '' };
}

const cleanMinutes = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(120, n) : KEY_MINUTES;
};

export function cleanInUse(raw: unknown): InUseSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { ...(typeof o.whileInUse === 'boolean' ? { whileInUse: o.whileInUse } : {}), keyMinutes: cleanMinutes(o.keyMinutes ?? KEY_MINUTES) };
}

/** nvidia-smi's "utilization.gpu" lines ("37\n4\n") as the busiest card's use, or null. */
export function gpuOf(out: string): number | null {
  const n = out.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d{1,3}$/.test(l)).map(Number).filter(x => x <= 100);
  return n.length ? Math.max(...n) : null;
}

/** The PowerShell look's one line, "<state> <idle ms>", read; either part null when it is not a number. */
export function screenOf(out: string): { screen: number | null; idleMs: number | null } {
  const m = /^\s*(-?\d+)\s+(-?\d+)\s*$/m.exec(out);
  if (!m) return { screen: null, idleMs: null };
  const st = Number(m[1]);
  const idle = Number(m[2]);
  return { screen: st >= 1 && st <= 7 ? st : null, idleMs: idle >= 0 ? idle : null };
}

// One short PowerShell call: the notification state and the milliseconds since the last input, on one line.
const SCRIPT = [
  'Add-Type -TypeDefinition @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class TomlinLook {',
  '  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);',
  '  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);',
  '}',
  '"@',
  '$s = 0; [void][TomlinLook]::SHQueryUserNotificationState([ref]$s)',
  '$l = New-Object TomlinLook+LII; $l.cbSize = 8; $i = -1',
  'if ([TomlinLook]::GetLastInputInfo([ref]$l)) { $i = ([uint32][Environment]::TickCount - $l.dwTime) }',
  'Write-Output "$s $i"',
].join('\n');

const runOut = (file: string, args: string[], ms: number): Promise<string> => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, timeout: ms }, (err, out) => resolve(err ? '' : String(out)));
});

/** Takes the three looks now (Windows only; anything that fails is null). */
export async function lookNow(o: { ownGpu: boolean }): Promise<Looks> {
  if (process.platform !== 'win32' || process.env.TOMLIN_NO_PCLOOK) return { screen: null, gpu: null, idleMs: null };
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const [screen, gpu] = await Promise.all([
    runOut(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 20_000).then(screenOf),
    o.ownGpu ? Promise.resolve(null) : smiUse(),
  ]);
  return { ...screen, gpu };
}

let smiAt: string | null | undefined;
async function smiUse(): Promise<number | null> {
  const places = smiAt === undefined ? NVIDIA_SMI : smiAt ? [smiAt] : [];
  for (const p of places) {
    const out = await runOut(p, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], 10_000);
    const n = gpuOf(out);
    if (n !== null) {
      smiAt = p;
      return n;
    }
  }
  if (smiAt === undefined) smiAt = null;
  return null;
}

// ---- The saved switch, and the cached answer ----

let file = '';
let cache: { at: number; ownGpu: boolean; answer: { busy: boolean; why: string } } | null = null;

export function settingsFile(dataDir: string): string {
  file = join(dataDir, 'agent-inuse.json');
  return file;
}

export async function readInUse(): Promise<InUseSettings> {
  return cleanInUse(file ? await readData(file, {}, { leave: true }).catch(() => ({})) : {});
}

/**
 * Read, changed and written in one turn of the file: one another program holds fails the save, never reset to the
 * defaults; a damaged one is set aside under a new name first (src/atomic.ts).
 */
export async function saveInUse(change: Partial<InUseSettings>): Promise<InUseSettings> {
  const next = file ? await updateData<InUseSettings>(file, { keyMinutes: KEY_MINUTES }, now => cleanInUse({ ...cleanInUse(now), ...change })) : cleanInUse(change);
  cache = null;
  return next;
}

/**
 * Whether this PC is in use now, from looks at most LOOK_EVERY_MS old. `ownGpu`: TOMLIN itself is using the card here.
 */
export async function inUse(o: { node: boolean; ownGpu?: boolean }, now = Date.now()): Promise<{ busy: boolean; why: string }> {
  const ownGpu = !!o.ownGpu;
  if (cache && now - cache.at < LOOK_EVERY_MS && cache.ownGpu === ownGpu) return cache.answer;
  const s = await readInUse();
  const answer = (s.whileInUse ?? o.node) ? { busy: false, why: '' } : busyWhy(await lookNow({ ownGpu }), s, { node: o.node, ownGpu });
  cache = { at: now, ownGpu, answer };
  return answer;
}

/** The last answer (for the Agents page and a run's waiting line), or null when no look was taken lately. */
export const lastInUse = (now = Date.now()): { busy: boolean; why: string } | null => (cache && now - cache.at < 3 * LOOK_EVERY_MS ? cache.answer : null);
