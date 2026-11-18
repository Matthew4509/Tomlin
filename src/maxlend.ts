// Max mode on a node: lending this PC's card memory (or its RAM, with no card) to one linked PC at a time. The linked
// PC's chat runner uses it through llama.cpp's RPC server (ggml-rpc-server), which listens on 127.0.0.1 only and is
// reached only through the sealed stream (src/linkstream.ts). It lends on any PC,
// with "Allow to be used as part of a cluster" (Max mode) ticked, and only while nobody is using this PC: Windows locked, or no key press or mouse move for the
// minutes its owner chose (5 unless changed). Someone coming back to it, "I need to use the pc", the tick taken off or
// sharing turned off ends the loan within a second or two: the RPC server is stopped and the linked PC's answer ends
// there (it is asked again on what is left). Plain rules and the parts that run it; tested in test/maxlend.test.ts.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Allow } from './carry.ts';
import { alive } from './hardware.ts';
import * as leftovers from './leftovers.ts';
import { LEND_AIM_KEEP } from './maxplace.ts';
import { cleanedTail } from './runnerexit.ts';

/** The RPC servers and presence readers running now: ended with TOMLIN (its window closed, Quit), never left lending. */
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of running) if (c.exitCode === null) c.kill();
});
function keepTrack(child: ChildProcess): void {
  running.add(child);
  child.on('exit', () => running.delete(child));
}

/**
 * Keeps the last `n` lines a child process wrote to stderr (each cut to 300 characters), so the log can say what an RPC
 * server said before it stopped. Reading the pipe also keeps it drained. A child with no stderr pipe gives no lines.
 */
export function keepTail(child: Pick<ChildProcess, 'stderr'>, n = 20): () => string[] {
  const lines: string[] = [];
  let part = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (s: string) => {
    part += s;
    const all = part.split(/\r\n|\r|\n/);
    part = all.pop() ?? '';
    // Text with no line end (a bar of dots, or a runner gone wrong) is not held without end: past 4000 characters it is a line
    // of its own, so the next real line is not glued to it.
    if (part.length > 4000) {
      all.push(part.slice(-600));
      part = '';
    }
    for (const l of all) {
      if (!l.trim()) continue;
      lines.push(l.slice(0, 300));
      if (lines.length > n) lines.shift();
    }
  });
  return () => (part.trim() ? [...lines, part.slice(0, 300)].slice(-n) : [...lines]);
}

/**
 * The plain words for an RPC server that stopped on its own: its exit code (in hex too, as Windows writes crash codes) or
 * the signal, this PC's free RAM at that moment, and its last lines. For the log, so a crash can be read afterwards.
 */
export function stoppedWords(code: number | null, signal: string | null, mem: { total: number; free: number }, tail: string[]): string {
  const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
  const how = code !== null ? `exit code ${code} (0x${(code >>> 0).toString(16).toUpperCase()})` : signal ? `ended by ${signal}` : 'no exit code';
  const said = tail.length ? `; its last lines: ${tail.join(' | ')}` : '; it wrote nothing to its error output';
  return `its RPC server stopped: ${how}; this PC had ${gb(mem.free)} free of ${gb(mem.total)}${said}`;
}

/** Minutes with no key press or mouse move before this PC lends (its owner picks one). */
export const LEND_IDLE_CHOICES = [2, 5, 10, 15, 30, 60] as const;
export const DEFAULT_LEND_IDLE = 5;
export const cleanLendIdle = (v: unknown): number => ((LEND_IDLE_CHOICES as readonly number[]).includes(Number(v)) ? Number(v) : DEFAULT_LEND_IDLE);

/** A key press or mouse move this recent, with Windows not locked, means someone is at the PC again. */
export const OWNER_BACK_MS = 5_000;
/** The RPC server waits this long for a stream after the last one closed (a model loading again), then it stops. */
export const SPARE_MS = 60_000;
/** The longest the lending PC waits for its first reading of whether someone is at it. */
export const PRESENCE_FIRST_MS = 8_000;
/** The longest its RPC server may take to start (a card's first start is slow). */
export const RPC_START_MS = 15_000;
/** The longest it tries to reach its RPC server once started (busy with the last connection for a moment). */
export const RPC_REACH_MS = 5_000;
/** The weight cache is used only with this much disk free (it keeps a copy of the lent part of each model). */
export const CACHE_DISK = 20 * 2 ** 30;
/** The most the weight cache keeps once a loan is over (it grew to 122.6 GB in 689 files on a 256 GB drive, 17 Nov 2026). */
export const CACHE_LIMIT = 24 * 2 ** 30;
/** A loan ends when the disk has less than this free: a full drive stops everything on the PC, not only the loan. */
export const DISK_FLOOR = 6 * 2 ** 30;
/**
 * After the disk floor ended a loan, the next loans run without the cache until this much is free: with 20 to 36 GB free
 * the cache was used, grew to the floor, the loan ended, the next one pruned and grew it again, and no loan could finish.
 */
export const CACHE_AGAIN = CACHE_DISK + CACHE_LIMIT;
/** After a loan ended by force, the cache files it wrote this recently go: one cut short by the stop would load as wrong weights. */
export const CUT_SHORT_MS = 5 * 60_000;
/** Why a loan ends when the borrower is done (an end that cuts nothing short). */
export const IDLE_END = 'the PC that borrowed it stopped using it';

/**
 * Deletes the cache files written since `since` (ms): those a loan ended by force may have cut short. May delete: only
 * plain files under `dir` (the RPC server's "rpc" folder, read four folders deep as pruneCache reads it) whose modified
 * time is at or after `since`. Never a folder, never anything outside `dir`. Never throws.
 */
export async function dropCutShort(dir: string, since: number): Promise<{ files: number; bytes: number }> {
  try {
    let files = 0;
    let bytes = 0;
    for (const f of await cacheFiles(dir)) {
      if (f.at < since) continue;
      if (await rm(f.path, { force: true }).then(() => true, () => false)) {
        files++;
        bytes += f.size;
      }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

/** One file of the weight cache. */
export interface CacheFile { path: string; size: number; at: number }

/**
 * The cache files to delete, oldest first: the cache may keep `limit` bytes, and never so much that less than `spare`
 * would be left free on the disk (the cache is not used at all when that much is not free). `free` is what the disk has
 * free now, with these files on it.
 */
export function cacheToDelete(files: CacheFile[], free: number, limit = CACHE_LIMIT, spare = CACHE_DISK): string[] {
  let total = files.reduce((n, f) => n + f.size, 0);
  const allowed = Math.min(limit, Math.max(0, free + total - spare));
  const out: string[] = [];
  for (const f of [...files].sort((a, b) => a.at - b.at)) {
    if (total <= allowed) break;
    out.push(f.path);
    total -= f.size;
  }
  return out;
}

async function cacheFiles(dir: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await walk(p, depth + 1);
      } else if (e.isFile()) {
        const s = await stat(p).catch(() => null);
        if (s) out.push({ path: p, size: s.size, at: s.mtimeMs });
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Deletes the cache files that `cacheToDelete` names. Returns how many went and how many bytes. Never throws. */
export async function pruneCache(dir: string, free?: number, limit = CACHE_LIMIT, spare = CACHE_DISK): Promise<{ files: number; bytes: number }> {
  try {
    const files = await cacheFiles(dir);
    if (!files.length) return { files: 0, bytes: 0 };
    // Free space that cannot be read is not taken as none (that emptied a small cache): only the size limit then applies.
    const room = free ?? (await statfs(dir).then(s => s.bavail * s.bsize, () => Infinity));
    const doomed = new Set(cacheToDelete(files, room, limit, spare));
    let n = 0;
    let bytes = 0;
    for (const f of files) {
      if (!doomed.has(f.path)) continue;
      if (await rm(f.path, { force: true }).then(() => true, () => false)) {
        n++;
        bytes += f.size;
      }
    }
    return { files: n, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

/** Whether someone is at this PC: milliseconds since the last key press or mouse move, and Windows locked. */
export interface Presence {
  idleMs: number;
  /** The lock screen is up, or a screen saver runs that locks Windows when it ends. */
  locked: boolean;
  /** A screen saver runs (unset: read by a reader from before 3 Nov). */
  saver?: boolean;
  /**
   * What Windows' own session list showed (unset: it could not be read, or a reader from before 14 Nov): someone may be
   * at its screen ('console') or in a Remote Desktop window ('remote'), every signed-in session is locked ('locked'),
   * the signed-in session is disconnected (Remote Desktop closed, or switched away from) ('disconnected'), or nobody is
   * signed in ('nobody'). The last three set `locked`.
   */
  seen?: 'console' | 'remote' | 'locked' | 'disconnected' | 'nobody';
}

/** How long ago, exact to the second under 10 minutes ("2 min" beside "after 2 minutes" read as if it should lend). */
function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s >= 600) return `${Math.floor(s / 60)} min`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

export function presenceWords(p: Presence): string {
  if (p.locked) {
    if (p.saver) return 'its screen saver is on and locks Windows';
    if (p.seen === 'disconnected') return 'its Windows session is disconnected (Remote Desktop closed), nobody is at its screen';
    if (p.seen === 'nobody') return 'nobody is signed in to Windows there';
    return 'Windows is locked';
  }
  // 14 Nov: Windows+L pressed in a Remote Desktop window locks the PC in front of you, never the one in the window.
  if (p.seen === 'remote') return `last used ${ago(p.idleMs)} ago over Remote Desktop, not locked: Windows+L in a Remote Desktop window locks the PC in front of you. Lock it from its own Start menu, or close the Remote Desktop window`;
  return `last used ${ago(p.idleMs)} ago${p.saver ? '; its screen saver is on but does not lock Windows' : ''}`;
}

/** Someone is at the PC (and Windows is not locked). */
export const ownerBack = (p: Presence) => !p.locked && p.idleMs < OWNER_BACK_MS;

/** Free to lend now: Windows locked, or nobody has used it for `idleMinutes`. */
export const nobodyThere = (p: Presence, idleMinutes: number) => p.locked || p.idleMs >= idleMinutes * 60_000;

/** Who borrows it now. */
export interface Lease {
  /** The link's token fingerprint (src/share.ts paired hash). */
  hash: string;
  name: string;
  since: string;
}

/**
 * Why this PC will not lend to `by` now, in plain words for the linked PC; '' when it will. `presence` null: not read
 * yet (or it cannot be read on this PC): it does not lend then.
 */
export function lendWhy(o: { pc: string; on: boolean; allow: Allow; away: boolean; presence: Presence | null; idleMinutes: number; lease: Lease | null; by: { hash: string } }): string {
  if (!o.on) return `"${o.pc}" is not lending to other PCs now (it is not a node).`;
  if (!o.allow.lend) return `"${o.pc}" does not lend its card memory: its owner ticks "Allow to be used as part of a cluster" there (Network, Sharing and cluster permissions).`;
  if (o.away) return `someone is using "${o.pc}" (they pressed "I need to use the pc"), so it lends nothing for now.`;
  if (o.lease && o.lease.hash !== o.by.hash) return `"${o.pc}" is lending its card memory to "${o.lease.name}" now. One PC borrows it at a time.`;
  if (!o.presence) return `"${o.pc}" could not tell whether someone is using it, so it lends nothing.`;
  if (!nobodyThere(o.presence, o.idleMinutes)) return `someone is using "${o.pc}" (${presenceWords(o.presence)}). It lends once Windows is locked there, or after ${o.idleMinutes} minutes with nobody using it.`;
  return '';
}

/** Why an update must wait while this PC lends its card (it restarts TOMLIN, which cuts the loan mid-load); null when it lends to nobody. */
export const loanBusy = (lease: Lease | null) => (lease ? `lending its card memory to "${lease.name}" (Max mode)` : null);

/** Why a loan already running must end now ('' while it may go on). `paired`: the links this PC still has. */
export function loanEnds(o: { on: boolean; allow: Allow; away: boolean; presence: Presence | null; lease: Lease | null; paired: { hash: string }[] }): string {
  if (!o.on) return 'sharing was turned off there';
  if (o.lease && !o.paired.some(p => p.hash === o.lease!.hash)) return `the link to "${o.lease.name}" was removed`;
  if (!o.allow.lend) return 'its owner took the Max mode tick off';
  if (o.away) return 'someone there pressed "I need to use the pc"';
  if (o.presence && ownerBack(o.presence)) return 'someone started using it';
  return '';
}

// ---- Reading whether someone is at this PC ----

/**
 * The PowerShell lines, every second: Windows' last-input time (GetLastInputInfo), whether the lock screen is up, whether
 * a screen saver runs, and whether it locks Windows when it ends ("On resume, display logon screen", or the same set by
 * policy). Behind such a screen saver Windows is as good as locked, but the lock screen (LogonUI) starts only when
 * someone wakes it: 2 Nov, a node behind one was read as in use.
 *
 * Locked or not is read per Windows session from Windows' own session list (WTSSessionInfoEx's lock flag, and
 * whether the session is connected), whatever session TOMLIN runs in. 14 Nov: "any LogonUI running" was wrong both
 * ways: Windows runs one in the empty console session while someone works over Remote Desktop, and it said nothing of
 * which session was locked. A session that is not TOMLIN's own gives its idle time from the same list (0, in use, when
 * Windows keeps none). LogonUI is used only when Windows gives no lock flag, or the list cannot be read.
 */
const PRESENCE_SCRIPT = `Add-Type -TypeDefinition @"
using System; using System.Diagnostics; using System.Runtime.InteropServices;
public static class TomlinIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint a, uint b, ref bool c, uint d);
  [StructLayout(LayoutKind.Sequential)] struct SI { public int Id; public IntPtr Name; public int State; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct L1 {
    public int Id; public int State; public int Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string Station;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string User;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string Domain;
    public long Logon, Connect, Disconnect, LastInput, Now;
  }
  [DllImport("wtsapi32.dll")] static extern bool WTSEnumerateSessionsW(IntPtr h, int r, int v, out IntPtr p, out int n);
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformationW(IntPtr h, int id, int c, out IntPtr p, out int n);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  public static uint Ms() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); if (!GetLastInputInfo(ref l)) return 0; return unchecked((uint)Environment.TickCount - l.dwTime); }
  public static int Saver() { bool on = false; SystemParametersInfo(0x0072, 0, ref on, 0); return on ? 1 : 0; }
  // "idleMs locked(0|1) how ownSession(0|1)"; how: C console, R Remote Desktop, L locked, D disconnected, N nobody signed in, O old way (LogonUI only).
  public static string Read() {
    int own = Process.GetCurrentProcess().SessionId;
    var logonUI = new System.Collections.Generic.HashSet<int>();
    foreach (var p in Process.GetProcessesByName("LogonUI")) { logonUI.Add(p.SessionId); p.Dispose(); }
    string old = Ms() + " " + (logonUI.Count > 0 ? 1 : 0) + " O 1";
    IntPtr list; int n;
    if (!WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out list, out n)) return old;
    int read = 0; bool locked = false, away = false, remote = false, mine = false; long best = -1;
    try {
      for (int i = 0; i < n; i++) {
        var s = (SI)Marshal.PtrToStructure(new IntPtr(list.ToInt64() + i * Marshal.SizeOf(typeof(SI))), typeof(SI));
        IntPtr b; int bytes; L1 x;
        if (!WTSQuerySessionInformationW(IntPtr.Zero, s.Id, 25, out b, out bytes)) continue;
        try { if (Marshal.ReadInt32(b) != 1) continue; x = (L1)Marshal.PtrToStructure(new IntPtr(b.ToInt64() + 8), typeof(L1)); } finally { WTSFreeMemory(b); }
        read++;
        if (string.IsNullOrEmpty(x.User)) continue;
        if (x.State == 4) { away = true; continue; }
        if (x.State != 0) continue;
        if (x.Flags == 0 || (x.Flags != 1 && logonUI.Contains(x.Id))) { locked = true; continue; }
        long idle = x.Id == own ? Ms() : (x.LastInput > 0 && x.Now >= x.LastInput ? (x.Now - x.LastInput) / 10000 : 0);
        if (best < 0 || idle < best) { best = idle; remote = !string.Equals(x.Station, "Console", StringComparison.OrdinalIgnoreCase); mine = x.Id == own; }
      }
    } finally { WTSFreeMemory(list); }
    if (read == 0) return old;
    if (best >= 0) return best + " 0 " + (remote ? "R" : "C") + " " + (mine ? 1 : 0);
    return Ms() + " 1 " + (locked ? "L" : away ? "D" : "N") + " 0";
  }
}
"@
function Locks { foreach ($k in 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop', 'HKCU:\\Control Panel\\Desktop') { $v = (Get-ItemProperty -Path $k -Name ScreenSaverIsSecure -ErrorAction SilentlyContinue).ScreenSaverIsSecure; if ($null -ne $v) { return [int]("$v" -eq '1') } }; return 0 }
while ($true) { $r = [TomlinIdle]::Read().Split(' '); $s = if ($r[3] -eq '1') { [TomlinIdle]::Saver() } else { 0 }; $k = if ($s) { Locks } else { 0 }; $h = if ($r[2] -eq 'O') { '' } else { ' ' + $r[2] }; [Console]::Out.WriteLine("$($r[0]) $($r[1]) $s $k$h"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1000 }`;

const SEEN = { C: 'console', R: 'remote', L: 'locked', D: 'disconnected', N: 'nobody' } as const;

/**
 * One line the reader prints: "idleMs locked(0|1) saverRuns(0|1) saverLocks(0|1) how(C|R|L|D|N)" (saver since 3 Nov,
 * how since 14 Nov and left off when Windows' session list could not be read; a test file may hold the first two only).
 */
export function presenceOf(line: string): Presence | null {
  const m = /^(\d+) ([01])(?: ([01]) ([01])(?: ([CRLDN]))?)?$/.exec(line.trim());
  if (!m) return null;
  if (m[3] === undefined) return { idleMs: Number(m[1]), locked: m[2] === '1' };
  const saver = m[3] === '1';
  const p: Presence = { idleMs: Number(m[1]), locked: m[2] === '1' || (saver && m[4] === '1'), saver };
  if (m[5]) p.seen = SEEN[m[5] as keyof typeof SEEN];
  return p;
}

/**
 * Reads presence once a second while it is wanted: one small PowerShell process, started at the first ask and ended
 * a few minutes after the last. TOMLIN_TEST_PRESENCE_FILE (tests only): read that file's "idleMs locked" line instead.
 */
export class PresenceReader {
  private child: ChildProcess | null = null;
  private last: { p: Presence; at: number } | null = null;
  private wantedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private testFile = process.env.TOMLIN_TEST_PRESENCE_FILE ?? '';

  /** The newest reading (none older than 5 s), starting the reader when it is not running; null while there is none. */
  now(): Presence | null {
    this.wantedAt = Date.now();
    if (this.testFile) {
      try {
        return presenceOf(readFileSync(this.testFile, 'utf8'));
      } catch {
        return null;
      }
    }
    if (process.platform !== 'win32') return null;
    if (!this.child) this.start();
    return this.last && Date.now() - this.last.at < 5_000 ? this.last.p : null;
  }

  /** Waits up to `ms` for a first reading. */
  async first(ms = PRESENCE_FIRST_MS): Promise<Presence | null> {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 200))) {
      const p = this.now();
      if (p) return p;
    }
    return null;
  }

  private start(): void {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PRESENCE_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    keepTrack(child);
    leftovers.started(child.pid, 'powershell.exe');
    let buf = '';
    child.stdout?.on('data', (b: Buffer) => {
      buf += b.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const p = presenceOf(l);
        if (p) this.last = { p, at: Date.now() };
      }
    });
    child.on('error', () => undefined);
    child.on('exit', () => {
      leftovers.ended(child.pid);
      if (this.child === child) this.child = null;
    });
    // Ended a few minutes after nobody asked: it costs a little memory and a look at the process list each second.
    this.timer ??= setInterval(() => {
      if (this.child && Date.now() - this.wantedAt > 180_000) this.stop();
    }, 30_000);
    this.timer.unref();
  }

  /** The reader's process, while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    this.last = null;
    if (c && c.exitCode === null) c.kill();
  }
}

// ---- The loan: the RPC server and the streams to it ----

/** The RPC server program beside a chat runner, and what it lends: a card, or this PC's RAM and cores with none. */
export interface RpcProgram {
  exe: string;
  /** 'cpu': no card (or only one built into the processor): RAM is lent. */
  device: 'cpu' | 'vulkan' | 'cuda';
  threads: number;
  /** The llama.cpp build this program is from ("b12250"), or '' when unknown. A borrower's runner must be the same build. */
  build?: string;
  /** Lend the card AND this PC's RAM and cores together ("all"): one RPC server with both devices (-d CUDA0,CPU). */
  all?: boolean;
}

/**
 * The program to lend with when a borrower asks for llama.cpp build `want`: the first of that build, never another (b11284
 * and b12250 failed at the handshake). With no build asked (an older TOMLIN): the first one this PC would use.
 */
export const programFor = (all: RpcProgram[], want: string): RpcProgram | null => (want ? all.find(p => p.build === want) ?? null : all[0] ?? null);

/** The threads a lending CPU device uses when the PC has no chat threads setting: half the logical cores, at least 2. */
export const lendThreads = (logical: number): number => Math.max(2, Math.floor(logical / 2));

/** The device names llama.cpp's RPC server takes in -d for a card runner ("CUDA0", "Vulkan0"); '' for the CPU runner. */
const cardDevice = (d: RpcProgram['device']): string => (d === 'cuda' ? 'CUDA0' : d === 'vulkan' ? 'Vulkan0' : '');

export function rpcArgs(port: number, p: RpcProgram, cache: boolean, logicalCores = availableParallelism()): string[] {
  // "all": the card and the CPU (RAM and cores) as one lender. With no card the CPU is the only device already.
  const both = p.all === true && p.device !== 'cpu';
  const threads = p.threads > 0 ? p.threads : lendThreads(logicalCores);
  return ['-H', '127.0.0.1', '-p', String(port), ...(cache ? ['-c'] : []), ...(both ? ['-d', `${cardDevice(p.device)},CPU`, '-t', String(threads)] : p.device === 'cpu' && p.threads > 0 ? ['-t', String(p.threads)] : [])];
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

const answers = (port: number) => new Promise<boolean>(resolve => {
  const s = connect(port, '127.0.0.1');
  s.once('connect', () => {
    s.destroy();
    resolve(true);
  });
  s.once('error', () => resolve(false));
});

/**
 * A connection to the RPC server, or null. A server busy with the last connection can refuse the next one for a moment,
 * which a loaded PC showed as "did not answer" with the server running: tried for about 5 s, until `gone` says nobody waits.
 */
export async function reachRpc(port: number, gone: () => boolean = () => false, gapMs = 200): Promise<Socket | null> {
  for (let t = 0; t < RPC_REACH_MS / 200 && !gone(); t++) {
    const s = connect(port, '127.0.0.1');
    const ok = await new Promise<boolean>(r => {
      s.once('connect', () => r(true));
      s.once('error', () => r(false));
    });
    if (ok) return s;
    s.destroy();
    await new Promise(r => setTimeout(r, gapMs));
  }
  return null;
}

/** How the last loan ended, for this PC's Network page. */
export interface LoanEnd {
  to: string;
  why: string;
  at: string;
}

/**
 * Watches this PC's free RAM while it lends and only says so (a design rule: ending a loan because one PC
 * is low would load the other lenders with its share and they would run short too). A line about free RAM at the start
 * of the loan, when it has moved by `moveBytes` or more since the last line (a minute apart at least), and every
 * `everyMs` otherwise, so a crash can be read from the log afterwards without a line a minute burying the rest; one line
 * when free RAM falls under `soft`, and `low` is true until it recovers (the hello carries it, memory.low, for the host
 * to read at its next load).
 */
export class MemoryWatch {
  low = false;
  private last = -Infinity;
  private lastFree = 0;
  private soft: number;
  private everyMs: number;
  private moveBytes: number;
  constructor(soft: number = LEND_AIM_KEEP, everyMs = 10 * 60_000, moveBytes = 2 * 2 ** 30) {
    this.soft = soft;
    this.everyMs = everyMs;
    this.moveBytes = moveBytes;
  }

  /** The log lines for a reading taken at `now` (ms): `start` forces the loan's first line. */
  step(now: number, total: number, free: number, start = false): string[] {
    const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
    const lines: string[] = [];
    const moved = Math.abs(free - this.lastFree) >= this.moveBytes && now - this.last >= 60_000;
    if (start || moved || now - this.last >= this.everyMs) {
      this.last = now;
      this.lastFree = free;
      lines.push(`Lending: this PC has ${gb(free)} of its ${gb(total)} of RAM free.`);
    }
    if (free < this.soft && !this.low) {
      this.low = true;
      lines.push(`This PC's free memory is ${gb(free)}, under the ${gb(this.soft)} it aims to keep free. It keeps lending; the other PC places less here at its next load.`);
    } else if (this.low && free >= this.soft + 2 ** 29) this.low = false;
    return lines;
  }

  reset(): void {
    this.low = false;
    this.last = -Infinity;
  }
}

/**
 * One loan at a time: the RPC server is started for the first stream of a borrower and ended once no stream has been
 * open for SPARE_MS, or at once when the loan must end. `check` is asked every second while it runs.
 */
export class Lender {
  lease: Lease | null = null;
  ended: LoanEnd | null = null;
  private child: ChildProcess | null = null;
  private port = 0;
  private streams = new Set<Duplex>();
  private idleSince = 0;
  private watch: NodeJS.Timeout | null = null;
  private starting: Promise<number> | null = null;
  /** One more for every end(): a start that sees it change stops before it lends anything. */
  private ends = 0;
  private cacheDir: string;
  /** The disk floor ended a loan: the next ones run without the cache until CACHE_AGAIN is free. */
  private noCache = false;
  /** The loan running now uses the cache, and since when (ms): what an end by force may have cut short. */
  private cacheSince: number | null = null;
  private check: () => string;
  /** Told each time a loan ends, and why (for the log). */
  private onEnd: (e: LoanEnd) => void;

  /** Warn-only memory watch: how to read this PC's RAM and where to say it. */
  readonly memory = new MemoryWatch();
  private mem: { read: () => { total: number; free: number }; say: (line: string) => void } | null;

  constructor(cacheDir: string, check: () => string, onEnd: (e: LoanEnd) => void = () => undefined, mem: { read: () => { total: number; free: number }; say: (line: string) => void } | null = null) {
    this.mem = mem;
    this.cacheDir = cacheDir;
    this.check = check;
    this.onEnd = onEnd;
  }

  view() {
    return { lease: this.lease, streams: this.streams.size, ended: this.ended };
  }

  /** The RPC server's process, while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Starts the RPC server program on `port` (a test puts a stand-in here). */
  protected spawnRpc(program: RpcProgram, port: number, cache: boolean): ChildProcess {
    return spawn(program.exe, rpcArgs(port, program, cache), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LLAMA_CACHE: this.cacheDir, ...(program.device === 'cuda' ? { CUDA_CACHE_MAXSIZE: process.env.CUDA_CACHE_MAXSIZE || String(4 * 2 ** 30) } : {}) } });
  }

  /** The RPC server's port for `by` (started when it is not running). Throws in plain words when it cannot start. */
  async open(by: { hash: string; name: string }, program: RpcProgram | null): Promise<number> {
    if (this.lease && this.lease.hash !== by.hash) throw new Error(`it is lending to "${this.lease.name}" now`);
    if (this.child && this.port) return this.port;
    if (this.starting) return this.starting;
    if (!program) throw new Error('it has no model runner that can lend (its RPC server is missing). Update TOMLIN there.');
    this.lease = { hash: by.hash, name: by.name, since: new Date().toISOString() };
    this.starting = this.start(program).finally(() => (this.starting = null));
    try {
      return await this.starting;
    } catch (e) {
      this.lease = null;
      throw e;
    }
  }

  private async start(program: RpcProgram): Promise<number> {
    const ends = this.ends;
    const port = await freePort();
    await mkdir(this.cacheDir, { recursive: true }).catch(() => undefined);
    // Old cache files go first, so a cache left by earlier loans never fills the drive (17 Nov: 122.6 GB, 3.2 GB free).
    await this.prune();
    const room = await this.cacheRoom();
    // Ended while the port and the disk were read (sharing turned off, someone came back): nothing is started.
    if (this.ends !== ends) throw new Error('the loan ended as it started');
    if (this.noCache && room >= CACHE_AGAIN) this.noCache = false;
    const cache = room >= CACHE_DISK && !this.noCache;
    if (this.noCache) this.mem?.say(`Weight cache: not used for this loan, as the last one ended with the disk nearly full. It is used again once ${(CACHE_AGAIN / 2 ** 30).toFixed(0)} GB is free (${(room / 2 ** 30).toFixed(1)} GB now).`);
    this.cacheSince = cache ? Date.now() : null;
    const child = this.spawnRpc(program, port, cache);
    keepTrack(child);
    leftovers.started(child.pid, program.exe);
    this.child = child;
    // Its last error lines, trimmed and with anything like a key taken out (src/runnerexit.ts), for the log.
    const tail = cleanedTail(keepTail(child));
    child.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      leftovers.ended(child.pid);
      // Stopped on its own (not by end()): the exit code, the free RAM then and its last lines go in the log.
      if (this.child === child) void this.end(stoppedWords(code, signal, this.mem?.read() ?? { total: totalmem(), free: freemem() }, tail()));
    });
    for (let t = 0; t < RPC_START_MS / 200; t++) {
      if (this.child !== child) throw new Error('its RPC server stopped as it started');
      if (await answers(port)) {
        this.port = port;
        this.idleSince = Date.now();
        this.watchMemory(true);
        this.watch ??= setInterval(() => this.tick(), 1000);
        return port;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    await this.end('its RPC server did not start');
    throw new Error(`its RPC server did not start in ${RPC_START_MS / 1000} seconds`);
  }

  /** A stream to the RPC server is open (its socket on the network side). */
  track(s: Duplex): void {
    this.streams.add(s);
  }

  untrack(s: Duplex): void {
    this.streams.delete(s);
    if (!this.streams.size) this.idleSince = Date.now();
  }

  private watchMemory(start = false): void {
    if (!this.mem) return;
    const r = this.mem.read();
    for (const line of this.memory.step(Date.now(), r.total, r.free, start)) this.mem.say(line);
  }

  /** The cache folder brought down to its limit; what went is said in the log. A test puts a stand-in here. */
  protected async prune(): Promise<void> {
    // Only the "rpc" folder the RPC server makes inside the cache folder: nothing else there is touched.
    const r = await pruneCache(join(this.cacheDir, 'rpc'));
    if (r.files) this.mem?.say(`Weight cache: removed ${r.files} old file${r.files > 1 ? 's' : ''} (${(r.bytes / 2 ** 30).toFixed(1)} GB) to keep it under ${Math.round(CACHE_LIMIT / 2 ** 30)} GB.`);
  }

  /** What the disk the cache is on has free (a test puts a stand-in here). */
  protected async diskFree(): Promise<number> {
    return statfs(this.cacheDir).then(s => s.bavail * s.bsize, () => Infinity);
  }

  /** The same, read as a loan starts to choose whether it uses the cache: not known counts as no room (a test puts a stand-in here). */
  protected async cacheRoom(): Promise<number> {
    return statfs(this.cacheDir).then(s => s.bavail * s.bsize, () => 0);
  }

  /**
   * After a loan ended by force: the cache files it wrote in its last CUT_SHORT_MS go (only under the "rpc" folder, see
   * dropCutShort), what went said in the log.
   */
  private async dropCutShort(since: number): Promise<void> {
    const r = await dropCutShort(join(this.cacheDir, 'rpc'), since);
    if (r.files) this.mem?.say(`Weight cache: removed ${r.files} file${r.files > 1 ? 's' : ''} (${(r.bytes / 2 ** 30).toFixed(1)} GB) written in the last minutes of a loan that was stopped, as one cut short would load as wrong weights. They are sent again when needed.`);
  }

  private diskTicks = 0;
  private diskLow = false;

  private tick(): void {
    if (!this.lease) return;
    this.watchMemory();
    // Every 5 seconds, and every second once less than twice the floor is free: the cache grows while a loan runs (a
    // lent part of a model is written once, up to its size), as fast as the link carries it. At 30 seconds apart a
    // fast link could take the disk from above the floor to full between two looks.
    if (this.diskLow || ++this.diskTicks % 5 === 0) {
      void this.diskFree().then(free => {
        this.diskLow = free < 2 * DISK_FLOOR;
        if (this.lease && free < DISK_FLOOR) void this.end(`this PC's disk is nearly full (${(free / 2 ** 30).toFixed(1)} GB free): lending stops so it does not fill`, 'floor');
      });
    }
    const why = this.check();
    if (why) return void this.end(why);
    if (!this.streams.size && Date.now() - this.idleSince > SPARE_MS) void this.end(IDLE_END, 'idle');
  }

  /**
   * Ends the loan now: the streams are cut and the RPC server is ended (and waited for). `how`: 'idle' when the
   * borrower was done (nothing was being written), 'floor' when the disk floor ended it (the next loans run without the
   * cache until CACHE_AGAIN is free), else by force. After any end but 'idle', the cache files of the loan's last
   * minutes go (dropCutShort).
   */
  async end(why: string, how: 'idle' | 'floor' | 'force' = 'force'): Promise<void> {
    this.ends++;
    if (how === 'floor') this.noCache = true;
    const since = this.cacheSince === null ? null : Math.max(this.cacheSince, Date.now() - CUT_SHORT_MS);
    this.cacheSince = null;
    // Run once the RPC server is gone (its files closed), before the cache is brought down to its limit.
    const tidy = async () => {
      if (since !== null && how !== 'idle') await this.dropCutShort(since).catch(() => undefined);
      await this.prune();
    };
    if (this.lease) {
      this.ended = { to: this.lease.name, why, at: new Date().toISOString() };
      this.onEnd(this.ended);
    }
    this.lease = null;
    this.port = 0;
    this.memory.reset();
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    const c = this.child;
    this.child = null;
    if (!c?.pid || c.exitCode !== null) return void tidy().catch(() => undefined);
    c.kill();
    for (let i = 0; i < 25 && alive(c.pid); i++) await new Promise(r => setTimeout(r, 200));
    if (alive(c.pid) && process.platform === 'win32') await new Promise(r => execFile('taskkill.exe', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }, () => r(null)));
    // The loan is over: the cache it grew is brought down to the limit now, not at the next loan.
    void tidy().catch(() => undefined);
  }
}

/** The weight cache's folder in TOMLIN's data (the RPC server adds "rpc" inside it). */
export const cacheDirOf = (dataDir: string) => join(dataDir, 'max-cache');
