// A pane's connection: Disconnected -> Loading -> Connected -> Unloading -> Disconnected (or Failed). Auto tries the
// graphics chip first and falls back to the CPU, saying which was used and why. Disconnect ends the worker and
// records the memory before, during and after, so the bar can show it really came back.
import { freemem, totalmem } from 'node:os';
import { Worker, type Asked, type LaunchSpec, type WorkerView } from './worker.ts';
import type { Device } from './runtimes.ts';
import { log } from './log.ts';

export interface ConnectRequest {
  model: string;
  modelName: string;
  asked: Asked;
  threads: number;
  /** Devices to try, best first, already limited to what is installed and what `asked` allows. */
  devices: Device[];
  expectedSeconds: number;
  build: (device: Device) => LaunchSpec;
  /** A second try on the same device with other settings, given the runner's last lines (null = no second try). */
  retry?: (device: Device, tail: string) => LaunchSpec | null;
  /** Plain words for why it failed, from the runner's last lines. */
  why: (tail: string) => string;
  /** Said once connected (why Auto chose what it chose). */
  note?: string;
}

const DEVICE_NAME: Record<Device, string> = { cpu: 'the CPU', vulkan: 'the graphics chip (Vulkan)', cuda: 'the NVIDIA card (CUDA)' };
const ramUsed = () => totalmem() - freemem();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Pane {
  readonly worker: Worker;
  private baseline = 0;
  private connectedRam = 0;
  /** The unload under way, if any: a connect (or a second unload) waits for it rather than racing it. */
  private ending: Promise<WorkerView> | null = null;
  /** Called on every change of state, e.g. to remember load times. */
  onChange: ((view: WorkerView) => void) | null = null;

  private readonly name: string;

  constructor(pane: 'chat' | 'image') {
    this.name = pane;
    this.worker = new Worker(pane);
    this.worker.onExit = () => {
      const v = this.worker.view;
      if (v.state === 'connected') {
        this.set({ state: 'failed', error: 'The model stopped on its own (often: the PC ran out of memory). Press Connect to load it again.', detail: this.worker.tail(), pid: null });
      }
    };
  }

  get view(): WorkerView {
    return this.worker.view;
  }

  private set(change: Partial<WorkerView>): void {
    // The runner's last lines, without any that carry a prompt (the picture runner prints what it was asked to draw):
    // the log never holds a chat's words or a prompt.
    const said = change.detail ? String(change.detail).split(/\r?\n/).filter(l => !/prompt/i.test(l)).join('\n').slice(-600) : '';
    if (change.state === 'failed') log.error(`${this.name} model`, `${this.worker.view.modelName ?? change.modelName ?? ''}: ${change.error ?? ''}${said ? ` (runner said: ${said})` : ''}`);
    this.worker.view = { ...this.worker.view, ...change };
    this.onChange?.(this.worker.view);
  }

  busy(): boolean {
    return this.view.state === 'loading' || this.view.state === 'unloading';
  }

  async connect(req: ConnectRequest): Promise<WorkerView> {
    // Drop then Connect at once: the old process is ended first, so the new one is never started beside it unseen.
    if (this.ending) await this.ending;
    if (this.view.state === 'connected' || this.view.state === 'loading') await this.disconnect();
    if (!req.devices.length) {
      this.set({ state: 'failed', error: req.asked === 'gpu' ? 'No graphics build is installed for this pane, so GPU cannot be used. Choose Auto or CPU, or install the graphics build under Models.' : 'No model runner is installed. Run "npm run fetch" in the TOMLIN folder.', detail: null });
      return this.view;
    }
    this.baseline = ramUsed();
    const lastUnload = this.view.lastUnload;
    this.worker.view = { ...Worker.empty(req.asked, req.threads), lastUnload };
    this.set({ state: 'loading', model: req.model, modelName: req.modelName, loadStartedAt: Date.now(), expectedSeconds: req.expectedSeconds });
    const notes: string[] = req.note ? [req.note] : [];
    for (let i = 0; i < req.devices.length; i++) {
      const device = req.devices[i];
      let spec: LaunchSpec | null = req.build(device);
      let result: 'ready' | 'failed' | 'cancelled' = 'failed';
      let tail = '';
      for (let attempt = 0; spec && attempt < 2; attempt++) {
        this.set({ device, stage: `Starting on ${DEVICE_NAME[device]}` });
        result = await this.worker.launch(spec);
        if (result !== 'failed') break;
        tail = this.worker.tail();
        await this.worker.end();
        spec = attempt === 0 ? req.retry?.(device, tail) ?? null : null;
      }
      if (result === 'cancelled' || this.view.state !== 'loading') return this.view;
      if (result === 'ready') {
        const seconds = Math.round((Date.now() - (this.view.loadStartedAt ?? Date.now())) / 100) / 10;
        await sleep(300);
        this.connectedRam = ramUsed();
        this.set({ state: 'connected', pid: this.worker.pid, loadSeconds: seconds, stage: null, note: notes.join(' ') || null });
        return this.view;
      }
      const why = req.why(tail);
      if (i < req.devices.length - 1) {
        notes.push(`${DEVICE_NAME[device][0].toUpperCase()}${DEVICE_NAME[device].slice(1)} could not run it (${why.replace(/^This model did not load: /, '').replace(/\.$/, '')}), so it runs on ${DEVICE_NAME[req.devices[i + 1]]}.`);
        continue;
      }
      this.set({ state: 'failed', error: why, detail: tail, stage: null, pid: null, note: notes.join(' ') || null });
      return this.view;
    }
    return this.view;
  }

  /** Ends the worker (also while it is still loading) and reports how much memory came back. */
  disconnect(): Promise<WorkerView> {
    this.ending ??= this.end().finally(() => { this.ending = null; });
    return this.ending;
  }

  private async end(): Promise<WorkerView> {
    if (this.view.state === 'disconnected') return this.view;
    const t0 = Date.now();
    const loaded = this.view.state === 'connected' ? Math.max(this.connectedRam, ramUsed()) : ramUsed();
    this.set({ state: 'unloading', stage: 'Ending the model process' });
    const gone = await this.worker.end();
    // Give Windows a moment to hand the pages back before reading the figure.
    await sleep(1200);
    const report = { seconds: Math.round((Date.now() - t0) / 100) / 10, baseline: this.baseline, loaded, after: ramUsed(), gone };
    this.worker.view = { ...Worker.empty(this.view.asked, this.view.threads), lastUnload: report };
    this.onChange?.(this.worker.view);
    return this.view;
  }
}
