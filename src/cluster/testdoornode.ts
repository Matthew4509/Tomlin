// The cluster test door's links to the running app (src/cluster/testdoor.ts takes them as deps, so its tests stand in
// for them): this PC's sharing state, the presence reader, whether Max mode lends now, the runner's RPC server program,
// and a short-lived RPC server for one test stream (started on 127.0.0.1 only, stopped when the stream ends).
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { libDirEnv } from '../libdir.ts';
import { fileURLToPath } from 'node:url';
import * as maxlend from '../maxlend.ts';
import * as leftovers from '../leftovers.ts';
import { log } from '../log.ts';
import { d } from '../jobrun/shared.ts';
import { shareState, taken } from '../jobrun/node.ts';
import { lentTo } from '../jobrun/maxnode.ts';
import { dllamaFile, type DoorDeps } from './testdoor.ts';
import { coresRead } from '../hardware.ts';

const presence = new maxlend.PresenceReader();

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
 * The PowerShell that keeps process PID on CPU socket NODE (NUMA node): its threads run only on that socket's cores, so
 * the memory it fills (the weights sent to it) is that socket's own. Windows only; prints "pinned <mask>" or throws.
 */
export const pinScript = (pid: number, node: number): string => [
  'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public static class TomlinNuma{[DllImport("kernel32.dll")]public static extern bool GetNumaHighestNodeNumber(out uint n);[DllImport("kernel32.dll")]public static extern bool GetNumaNodeProcessorMask(byte n,out ulong m);}\'',
  '$hi = [uint32]0; [void][TomlinNuma]::GetNumaHighestNodeNumber([ref]$hi)',
  `if (${node} -gt $hi) { throw "this PC has CPU sockets 0 to $hi only" }`,
  '$m = [uint64]0',
  `if (-not [TomlinNuma]::GetNumaNodeProcessorMask(${node}, [ref]$m) -or $m -eq 0) { throw "CPU socket ${node} has no cores here" }`,
  `(Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr][int64]$m`,
  '"pinned $m"',
].join('; ');

const pin = (pid: number, node: number) => new Promise<void>((resolve, reject) => {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(pinScript(pid, node), 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  ps.stdout.on('data', b => (out += b));
  ps.stderr.on('data', b => (out += b));
  ps.on('error', reject);
  ps.on('exit', code => (code === 0 && /pinned \d+/.test(out) ? resolve() : reject(new Error(`it could not be kept on CPU socket ${node}: ${out.trim().split(/\r?\n/)[0] || `exit ${code}`}`))));
});

/** One RPC server of this PC's runner for one test stream, with no weight cache (a test uses no model). */
async function startRpc(p: maxlend.RpcProgram, node = -1): Promise<{ port: number; stop: () => void }> {
  const port = await freePort();
  const child = spawn(p.exe, maxlend.rpcArgs(port, p, false), { windowsHide: true, cwd: dirname(p.exe), stdio: ['ignore', 'ignore', 'pipe'], env: libDirEnv(p.exe, undefined) });
  leftovers.started(child.pid, p.exe);
  const tail = maxlend.keepTail(child);
  let gone = false;
  let stopping = false;
  child.on('error', () => undefined);
  child.on('exit', (code, signal) => {
    gone = true;
    leftovers.ended(child.pid);
    // Gone: its exit listener goes too (one was added for every stream, and each kept its process).
    process.off('exit', stop);
    // Stopped on its own, not at the stream's end: say how, with the free RAM then and its last lines (a crash is
    // otherwise invisible here: the asking PC only sees its connection drop).
    if (!stopping) log.warn('cluster', `Cluster test: ${maxlend.stoppedWords(code, signal, { total: totalmem(), free: freemem() }, tail())}.`);
  });
  const stop = () => {
    stopping = true;
    if (!gone) child.kill();
  };
  process.once('exit', stop);
  // Pinned before it answers: no weights have reached it yet, so all of them land in that socket's memory.
  if (node >= 0 && child.pid) {
    try {
      await pin(child.pid, node);
    } catch (e) {
      stop();
      throw e;
    }
  }
  for (let t = 0; t < maxlend.RPC_START_MS / 200; t++) {
    if (gone) throw new Error('it stopped as it started');
    if (await answers(port)) return { port, stop };
    await new Promise(r => setTimeout(r, 200));
  }
  stop();
  throw new Error(`it did not start in ${maxlend.RPC_START_MS / 1000} seconds`);
}

/** The app folder (src/cluster is two below it). */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** This copy's distributed-llama program for this CPU, or null when the copy has none. */
function dllamaExe(root = APP, cpu = cpus()[0]?.model ?? ''): string | null {
  const exe = join(root, ...dllamaFile(cpu).split('/'));
  return existsSync(exe) ? exe : null;
}

/** One distributed-llama worker for one test stream, on 127.0.0.1 only (no new firewall rule: the stream comes in on
 * the worker port). It ends when the stream ends, or by itself when its root goes. Null: this copy has none. */
function startDllama(threads: number): Promise<{ port: number; stop: () => void }> | null {
  const exe = dllamaExe();
  if (!exe) return null;
  return (async () => {
    const port = await freePort();
    // Its threads: the ones asked for, else one per core as Windows counts them (a processor without hyper-threading has
    // one thread a core, so half the threads would leave half its cores idle); half the threads when not read.
    const n = threads || coresRead() || Math.max(1, Math.floor(cpus().length / 2));
    const child = spawn(exe, ['worker', '--host', '127.0.0.1', '--port', String(port), '--nthreads', String(n)], { windowsHide: true, cwd: dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] });
    leftovers.started(child.pid, exe);
    let tail = '';
    const keep = (b: Buffer) => (tail = (tail + b.toString()).slice(-600));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let gone = false;
    let stopping = false;
    child.on('error', () => undefined);
    child.on('exit', code => {
      gone = true;
      leftovers.ended(child.pid);
      process.off('exit', stop);
      if (!stopping) log.info('cluster', `distributed-llama worker ended (exit ${code}): ${tail.trim().split(/\r?\n/).slice(-2).join(' / ')}`);
    });
    const stop = () => {
      stopping = true;
      if (!gone) child.kill();
    };
    process.once('exit', stop);
    // Ready when it says it listens (a test connection would be taken as its root, so none is made before).
    for (let t = 0; t < 50; t++) {
      if (gone) throw new Error(`it stopped as it started: ${tail.trim().split(/\r?\n/).pop() ?? ''}`);
      if (/Listening on/.test(tail)) return { port, stop };
      await new Promise(r => setTimeout(r, 200));
    }
    stop();
    throw new Error('it did not start in 10 seconds');
  })();
}

export function nodeTestDeps(): DoorDeps {
  return {
    state: () => shareState,
    taken,
    presence: async () => presence.now() ?? (await presence.first()),
    presenceNow: () => presence.now(),
    lending: () => lentTo(),
    program: build => d.rpcProgram?.(build) ?? null,
    builds: () => d.rpcBuilds?.() ?? [],
    startRpc,
    startDllama,
    say: line => log.info('cluster', line),
  };
}
