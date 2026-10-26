// Max mode on a node: lending this PC's card memory (or its RAM, with no card) to one linked PC at a time. The linked
// PC's chat runner uses it through llama.cpp's RPC server (ggml-rpc-server), which listens on 127.0.0.1 only and is
// reached only through the sealed stream (src/linkstream.ts). It lends only on a PC started with TOMLIN_MAX (maxShown),
// with "Lend card memory to linked PCs (Max mode)" ticked, and only while nobody is using this PC: Windows locked, or no key press or mouse move for the
// minutes its owner chose (5 unless changed). Someone coming back to it, "I need to use the pc", the tick taken off or
// sharing turned off ends the loan within a second or two: the RPC server is stopped and the linked PC's answer ends
// there (it is asked again on what is left). Plain rules and the parts that run it; tested in test/maxlend.test.ts.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, statfs } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Allow } from './carry.ts';
import { alive } from './hardware.ts';
import * as leftovers from './leftovers.ts';

/**
 * Max mode is hidden until its screens ship: only a PC started with TOMLIN_MAX set (the same switch that names the PCs
 * to borrow from, src/jobrun/maxhost.ts) shows the Lend tick and lends. Elsewhere a tick saved before (Allow all once
 * ticked it) counts for nothing.
 */
export const maxShown = (env: NodeJS.ProcessEnv = process.env) => !!(env.TOMLIN_MAX ?? '').trim();

/** The RPC servers and presence readers running now: ended with TOMLIN (its window closed, Quit), never left lending. */
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of running) if (c.exitCode === null) c.kill();
});
function keepTrack(child: ChildProcess): void {
  running.add(child);
  child.on('exit', () => running.delete(child));
}

/** Minutes with no key press or mouse move before this PC lends (its owner picks one). */
export const LEND_IDLE_CHOICES = [2, 5, 10, 15, 30, 60] as const;
export const DEFAULT_LEND_IDLE = 5;
export const cleanLendIdle = (v: unknown): number => ((LEND_IDLE_CHOICES as readonly number[]).includes(Number(v)) ? Number(v) : DEFAULT_LEND_IDLE);

/** A key press or mouse move this recent, with Windows not locked, means someone is at the PC again. */
export const OWNER_BACK_MS = 5_000;
/** The RPC server waits this long for a stream after the last one closed (a model loading again), then it stops. */
export const SPARE_MS = 60_000;
/** The weight cache is used only with this much disk free (it keeps a copy of the lent part of each model). */
export const CACHE_DISK = 20 * 2 ** 30;

/** Whether someone is at this PC: milliseconds since the last key press or mouse move, and Windows locked. */
export interface Presence {
  idleMs: number;
  locked: boolean;
}

export const presenceWords = (p: Presence) => (p.locked ? 'Windows is locked' : `last used ${Math.round(p.idleMs / 60_000)} min ago`);

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
export function lendWhy(o: { pc: string; on: boolean; shown: boolean; allow: Allow; away: boolean; presence: Presence | null; idleMinutes: number; lease: Lease | null; by: { hash: string } }): string {
  if (!o.on) return `"${o.pc}" is not lending to other PCs now (it is not a node).`;
  if (!o.shown) return `"${o.pc}" does not lend its card memory: Max mode is not switched on there.`;
  if (!o.allow.lend) return `"${o.pc}" does not lend its card memory: its owner ticks "Lend card memory to linked PCs (Max mode)" under Network there.`;
  if (o.away) return `someone is using "${o.pc}" (they pressed "I need to use the pc"), so it lends nothing for now.`;
  if (o.lease && o.lease.hash !== o.by.hash) return `"${o.pc}" is lending its card memory to "${o.lease.name}" now. One PC borrows it at a time.`;
  if (!o.presence) return `"${o.pc}" could not tell whether someone is using it, so it lends nothing.`;
  if (!nobodyThere(o.presence, o.idleMinutes)) return `someone is using "${o.pc}" (${presenceWords(o.presence)}). It lends once Windows is locked there, or after ${o.idleMinutes} minutes with nobody using it.`;
  return '';
}

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

/** The PowerShell lines: Windows' last-input time (GetLastInputInfo) and whether the lock screen is up, every second. */
const PRESENCE_SCRIPT = `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class TomlinIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint Ms() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); if (!GetLastInputInfo(ref l)) return 0; return unchecked((uint)Environment.TickCount - l.dwTime); }
}
"@
while ($true) { $l = [bool](Get-Process LogonUI -ErrorAction SilentlyContinue); [Console]::Out.WriteLine("$([TomlinIdle]::Ms()) $([int]$l)"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1000 }`;

/** One line the reader prints: "idleMs locked(0|1)". */
export function presenceOf(line: string): Presence | null {
  const m = /^(\d+) ([01])$/.exec(line.trim());
  return m ? { idleMs: Number(m[1]), locked: m[2] === '1' } : null;
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
  async first(ms = 8_000): Promise<Presence | null> {
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
}

export function rpcArgs(port: number, p: RpcProgram, cache: boolean): string[] {
  return ['-H', '127.0.0.1', '-p', String(port), ...(cache ? ['-c'] : []), ...(p.device === 'cpu' && p.threads > 0 ? ['-t', String(p.threads)] : [])];
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

/** How the last loan ended, for this PC's Network page. */
export interface LoanEnd {
  to: string;
  why: string;
  at: string;
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
  private check: () => string;

  constructor(cacheDir: string, check: () => string) {
    this.cacheDir = cacheDir;
    this.check = check;
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
    return spawn(program.exe, rpcArgs(port, program, cache), { windowsHide: true, stdio: 'ignore', env: { ...process.env, LLAMA_CACHE: this.cacheDir, ...(program.device === 'cuda' ? { CUDA_CACHE_MAXSIZE: process.env.CUDA_CACHE_MAXSIZE || String(4 * 2 ** 30) } : {}) } });
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
    const room = await statfs(this.cacheDir).then(s => s.bavail * s.bsize, () => 0);
    // Ended while the port and the disk were read (sharing turned off, someone came back): nothing is started.
    if (this.ends !== ends) throw new Error('the loan ended as it started');
    const child = this.spawnRpc(program, port, room >= CACHE_DISK);
    keepTrack(child);
    leftovers.started(child.pid, program.exe);
    this.child = child;
    child.on('error', () => undefined);
    child.on('exit', () => {
      leftovers.ended(child.pid);
      if (this.child === child) void this.end('its RPC server stopped');
    });
    for (let t = 0; t < 75; t++) {
      if (this.child !== child) throw new Error('its RPC server stopped as it started');
      if (await answers(port)) {
        this.port = port;
        this.idleSince = Date.now();
        this.watch ??= setInterval(() => this.tick(), 1000);
        return port;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    await this.end('its RPC server did not start');
    throw new Error('its RPC server did not start in 15 seconds');
  }

  /** A stream to the RPC server is open (its socket on the network side). */
  track(s: Duplex): void {
    this.streams.add(s);
  }

  untrack(s: Duplex): void {
    this.streams.delete(s);
    if (!this.streams.size) this.idleSince = Date.now();
  }

  private tick(): void {
    if (!this.lease) return;
    const why = this.check();
    if (why) return void this.end(why);
    if (!this.streams.size && Date.now() - this.idleSince > SPARE_MS) void this.end('the PC that borrowed it stopped using it');
  }

  /** Ends the loan now: the streams are cut and the RPC server is ended (and waited for). */
  async end(why: string): Promise<void> {
    this.ends++;
    if (this.lease) this.ended = { to: this.lease.name, why, at: new Date().toISOString() };
    this.lease = null;
    this.port = 0;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    const c = this.child;
    this.child = null;
    if (!c?.pid || c.exitCode !== null) return;
    c.kill();
    for (let i = 0; i < 25 && alive(c.pid); i++) await new Promise(r => setTimeout(r, 200));
    if (alive(c.pid) && process.platform === 'win32') await new Promise(r => execFile('taskkill.exe', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }, () => r(null)));
  }
}

/** The weight cache's folder in TOMLIN's data (the RPC server adds "rpc" inside it). */
export const cacheDirOf = (dataDir: string) => join(dataDir, 'max-cache');
