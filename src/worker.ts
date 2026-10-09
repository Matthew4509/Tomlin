// One loaded model = one worker process (llama-server for chat, sd-server for images). Connect starts it and waits
// until it answers; Disconnect ends the process and waits until Windows says it is gone, so its memory is really
// back. Nothing starts on its own.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { alive } from './hardware.ts';
import type { Device } from './runtimes.ts';
import * as leftovers from './leftovers.ts';
import { dllLine, dllNotFound } from './vcrt.ts';

export type PaneState = 'disconnected' | 'loading' | 'connected' | 'unloading' | 'failed';
export type Asked = 'auto' | 'gpu' | 'cpu';

export interface UnloadReport {
  seconds: number;
  /** RAM in use: before Connect, while connected, and after the process ended (bytes). */
  baseline: number;
  loaded: number;
  after: number;
  /** The process is gone (checked with the system, not assumed). */
  gone: boolean;
}

export interface WorkerView {
  state: PaneState;
  model: string | null;
  modelName: string | null;
  device: Device | null;
  asked: Asked;
  threads: number;
  pid: number | null;
  /** What went wrong, in plain words; detail = the runner's own last lines. */
  error: string | null;
  detail: string | null;
  /** Something worth saying that is not a fault, e.g. "The graphics chip ran out of memory, so this runs on the CPU". */
  note: string | null;
  loadStartedAt: number | null;
  /** Expected load time, for the progress bar (an estimate: the last load of this model, or its size). */
  expectedSeconds: number;
  loadSeconds: number | null;
  /** What the runner is doing while it loads, from its own output ("reading the model file"). */
  stage: string | null;
  lastUnload: UnloadReport | null;
}

export interface LaunchSpec {
  exe: string;
  args: (port: number) => string[];
  /** Resolves true once the runner answers on `port`. */
  ready: (port: number) => Promise<boolean>;
  device: Device;
  /** Most seconds to wait; a big model read from a hard disk can take minutes. */
  timeoutSeconds: number;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Loading stages from what llama-server and sd-server print, so the bar can say what it is doing. */
function stageOf(line: string): string | null {
  if (/load_tensors|loading tensors|loading model|load_model|llama_model_load|model_loader/i.test(line)) return 'Reading the model file';
  if (/text encoder|clip|t5|llm.*load|conditioner/i.test(line)) return 'Reading the text encoder';
  if (/vae|taesd/i.test(line)) return 'Reading the image decoder';
  if (/warming up|warmup/i.test(line)) return 'Warming up';
  if (/kv.?cache|context/i.test(line)) return 'Setting aside memory for the conversation';
  if (/listening|server is listening|HTTP server/i.test(line)) return 'Starting to listen';
  return null;
}

export class Worker {
  readonly pane: 'chat' | 'image';
  view: WorkerView;
  port: number | null = null;
  private child: ChildProcess | null = null;
  private log: string[] = [];
  private errors: string[] = [];
  /** Lines from the runner, for listeners (image progress reads them). */
  onLine: ((line: string) => void) | null = null;
  onExit: (() => void) | null = null;

  constructor(pane: 'chat' | 'image') {
    this.pane = pane;
    this.view = Worker.empty('auto', 0);
    process.on('exit', () => this.killNow());
  }

  static empty(asked: Asked, threads: number): WorkerView {
    return { state: 'disconnected', model: null, modelName: null, device: null, asked, threads, pid: null, error: null, detail: null, note: null, loadStartedAt: null, expectedSeconds: 0, loadSeconds: null, stage: null, lastUnload: null };
  }

  get base(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The runner's last lines, error lines first. */
  tail(n = 8): string {
    const last = this.log.slice(-n);
    return [...this.errors.filter(e => !last.includes(e)), ...last].join('\n');
  }

  /**
   * Starts the runner and waits until it answers. Returns 'ready', 'failed' (it stopped or never answered: the
   * caller may try another device) or 'cancelled' (Disconnect was pressed while it loaded).
   */
  async launch(spec: LaunchSpec): Promise<'ready' | 'failed' | 'cancelled'> {
    const port = await freePort();
    this.log = [];
    this.errors = [];
    const child = spawn(spec.exe, spec.args(port), { windowsHide: true });
    leftovers.started(child.pid, spec.exe);
    this.child = child;
    this.port = port;
    this.view = { ...this.view, device: spec.device, pid: child.pid ?? null, stage: 'Starting the runner' };
    const keep = (b: Buffer) => {
      // Progress bars redraw with a carriage return, so it ends a line too.
      const lines = b.toString().split(/\r\n|\r|\n/).filter(Boolean);
      this.log = [...this.log, ...lines].slice(-60);
      this.errors = [...this.errors, ...lines.filter(l => /\b(error|failed|out of memory)\b|^\S+\s+E\s|FilterExpression|unknown (test|filter)/i.test(l))].slice(-8);
      for (const l of lines) {
        if (this.view.state === 'loading') {
          const s = stageOf(l);
          if (s) this.view.stage = s;
        }
        this.onLine?.(l);
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let exited = false;
    child.on('exit', code => {
      exited = true;
      // Ended before it said a word, for want of a DLL: on a clean Windows, the Visual C++ Runtime (src/vcrt.ts).
      if (dllNotFound(code)) this.errors = [...this.errors, dllLine()];
      leftovers.ended(child.pid);
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.onExit?.();
      }
    });
    child.on('error', () => {
      exited = true;
    });
    const until = Date.now() + spec.timeoutSeconds * 1000;
    while (Date.now() < until) {
      // Ended from outside (Disconnect while loading).
      if (this.child !== child && !exited) return 'cancelled';
      if (this.child !== child) return this.view.state === 'unloading' ? 'cancelled' : 'failed';
      if (exited) return 'failed';
      try {
        if (await spec.ready(port)) return 'ready';
      } catch {
        // not listening yet
      }
      await sleep(400);
    }
    await this.end();
    return 'failed';
  }

  /** Ends the runner and waits until the system no longer lists it. True when it is gone. */
  async end(): Promise<boolean> {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (!child?.pid) return true;
    const pid = child.pid;
    const exited = new Promise<void>(r => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    if (alive(pid) && process.platform === 'win32') {
      // It did not end when asked: force it, with anything it started.
      await new Promise(r => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r(null)));
    }
    for (let i = 0; i < 25 && alive(pid); i++) await sleep(200);
    return !alive(pid);
  }

  private killNow(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}
