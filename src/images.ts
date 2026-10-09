// The image pane: one stable-diffusion.cpp worker (sd-server) per loaded model, kept loaded between pictures, and the
// picture pipeline around it: size from the prompt, mode presets, drafts with the fast decoder (TAESD) and finals
// with the full one, resizing, background removal, WebP, .ico, the gallery, and help from the chat model.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Pane, type ConnectRequest } from './pane.ts';
import type { Asked } from './worker.ts';
import type { Store } from './store.ts';
import { missingCardRunner, type Runtimes, type Device } from './runtimes.ts';
import type { HardwareInfo, Sampler } from './hardware.ts';
import { Registry, type RegistryModel } from './registry.ts';
import { Gallery, type Picture, type Shelf } from './gallery.ts';
import { generationSize, parseSize, sizeText, type Size } from './sizes.ts';
import { boosted, detectMode, MODES, PORTRAIT_NEGATIVE, PORTRAIT_SIZE, portraitAsk, PRESETS, slug, type Mode } from './modes.ts';
import { centreIcon, fitTo, hasTransparency, iconSet, webp, withAlpha, type Fit } from './imaging.ts';
import sharp from 'sharp';
import { subjectMask } from './rembg.ts';
import { checkMessage, REFUSAL } from './filter.ts';
import { RUNNER_FILE_HELP, RUNNER_FILE_LINE, VCRT_HELP, vcrtFault } from './vcrt.ts';

type Decoder = 'fast' | 'full';
const GB = 2 ** 30;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface GenerateOptions {
  prompt: string;
  negative?: string;
  mode?: Mode | 'auto';
  width?: number;
  height?: number;
  fit?: Fit;
  seed?: number | null;
  steps?: number;
  cfg?: number;
  sampler?: string;
  drafts?: number;
  ico?: boolean;
  /** Make a final from this draft: same prompt and seed, more steps, full decoder. */
  finalOf?: string;
  /** Draw this picture again with the same seed and settings. */
  again?: string;
  /** Drawn whole, as a final is (the full decoder, not a draft): a picture from the queue, which nobody waits to see. */
  full?: boolean;
  source: 'page' | 'api' | 'chat';
  /** A picture specialist (staff id): their recipe shapes the picture. */
  as?: string;
  /** The chat the picture belongs to (src/chats.ts). Pictures from the page take the chat open at the time. */
  chat?: string;
  /**
   * Drawn for a linked PC (F7 E2): its name. The picture is made in memory and handed over (takeAway): it never enters
   * the gallery or its folder, and this pane shows only "Drawing for <that PC>".
   */
  forPc?: string;
}

interface Job {
  id: string;
  state: 'queued' | 'starting' | 'drawing' | 'decoding' | 'finishing' | 'done' | 'failed' | 'cancelled';
  opts: GenerateOptions;
  mode: Mode;
  modeWhy: string;
  target: Size;
  generated: Size;
  count: number;
  steps: number;
  step: number;
  image: number;
  perStep: number | null;
  startedAt: number;
  stepAt: number;
  etaSeconds: number | null;
  results: Picture[];
  error: string | null;
  note: string | null;
  done: Promise<void>;
}

export interface ImagesDeps {
  root: string;
  /** Where picture models are downloaded (the home's models/). */
  models: string;
  /** The home's data/ (pictures are in data/images). */
  data: string;
  store: Store;
  runtimes: Runtimes;
  hardware: HardwareInfo;
  sampler: Sampler;
  /** The main chat runner (only whether it is connected is read). */
  chatPane: Pick<Pane, 'view'>;
  devicesFor: (engine: 'llama' | 'sd', asked: Asked) => Device[];
  fit: (bytes: number, pane: 'chat' | 'image') => { level: 'ok' | 'tight' | 'no'; need: number; free: number; otherOn: boolean };
}

const DEVICE_WORDS: Record<Device, string> = { cpu: 'CPU', vulkan: 'graphics chip', cuda: 'NVIDIA card' };

/** Plain words for why the image runner stopped, from its last lines. */
function whyImage(tail: string): string {
  if (vcrtFault(tail)) return VCRT_HELP.replace('model runner', 'image runner');
  if (tail.includes(RUNNER_FILE_LINE)) return RUNNER_FILE_HELP.replace('model runner', 'image runner');
  const t = tail.toLowerCase();
  if (/out of memory|outofdevicememory|failed to allocate|alloc.*fail|bad_alloc|not enough memory/.test(t)) return 'The picture model did not fit in memory on this device. Drop the chat model (Drop in the top bar), close other programs, or choose CPU under the gear.';
  if (/device_lost|devicelost|vk::|vulkan.*error/.test(t)) return 'The graphics chip stopped responding while it ran the image model (Windows reset it). Choose CPU, or try again.';
  if (/unknown model|unsupported|get sd version failed|invalid/.test(t)) return 'The image runner could not read this model file. It may be damaged or a kind this runner does not know; download it again.';
  return 'The image runner stopped while loading the model. Try once more; if it fails again, choose CPU or another model. Its own words are under "What does this mean?".';
}

/** For a model bigger than the card: weights wait in RAM and move onto the card as each part runs. */
const OFFLOAD = ['--offload-to-cpu'];

export class Images {
  readonly pane = new Pane('image');
  readonly registry: Registry;
  readonly gallery: Gallery;
  recipe: ((id: string) => { mode?: Mode; boost: string; negative: string; drafts: number } | null) | null = null;
  askChat: ((system: string, message: string, maxTokens?: number) => Promise<string>) | null = null;
  /** Told when a picture is kept (added to the gallery): one kept in a project's chat is handed in to it (src/server/places.ts). */
  onKept: ((p: Picture, file: string | null) => Promise<void>) | null = null;
  private deps: ImagesDeps;
  private decoder: Decoder = 'fast';
  private lastConnect: { id: string; asked: Asked; threads: number } | null = null;
  private jobs: Job[] = [];
  private current: Job | null = null;
  private used = 0;
  private restarting = false;

  constructor(deps: ImagesDeps) {
    this.deps = deps;
    this.registry = new Registry(join(deps.root, 'registry'), deps.models);
    this.gallery = new Gallery(join(deps.data, 'images'));
    this.pane.worker.onLine = line => this.onRunnerLine(line);
  }

  // ---- Models ----

  has(id: string): boolean {
    return this.registry.get(id)?.kind === 'image';
  }

  list() {
    return this.registry.models.filter(m => m.kind === 'image').map(m => ({
      id: m.id,
      name: m.name,
      about: m.about,
      licence: m.licence,
      nonCommercial: !!m.nonCommercial,
      bytes: this.registry.bytes(m),
      installed: this.registry.installed(m),
      missing: this.registry.missing(m),
      minRamGB: m.minRamGB,
      minVramGB: m.minVramGB,
      download: this.registry.download(m.id) ?? null,
      fit: this.deps.fit(this.memoryNeed(m), 'image'),
      hardwareFit: this.hardwareFit(m),
      modes: m.recommendedModes ?? [],
    }));
  }

  /** When the model in use is not made for `mode` and another picture model is (registry recommendedModes), that one:
   * the Images window says "Cartoon looks best with DreamShaper 8" (here or downloadable). Null when it is fine. */
  betterFor(mode: Mode, m: RegistryModel | undefined): { id: string; name: string; installed: boolean } | null {
    if (!m || mode === 'custom' || m.recommendedModes?.includes(mode)) return null;
    const best = this.registry.models.filter(x => x.kind === 'image' && x.recommendedModes?.includes(mode))
      .sort((a, b) => Number(this.registry.installed(b)) - Number(this.registry.installed(a)))[0];
    return best ? { id: best.id, name: best.name.replace(/\s*\(.*\)$/, ''), installed: this.registry.installed(best) } : null;
  }

  helpers() {
    return this.registry.models.filter(m => m.kind === 'helper').map(m => ({ id: m.id, name: m.name, about: m.about, licence: m.licence, bytes: this.registry.bytes(m), installed: this.registry.installed(m), download: this.registry.download(m.id) ?? null }));
  }

  /** RAM a model needs while loaded: its files, or the registry's figure when it is larger. */
  private memoryNeed(m: RegistryModel): number {
    return Math.max(this.registry.bytes(m), m.minRamGB * GB * 0.8);
  }

  /** True when the model is bigger than the graphics card's own memory, so its weights must wait in RAM. */
  private overCard(m: RegistryModel): boolean {
    const card = this.deps.hardware.gpus.find(g => !g.integrated && g.total);
    return !card?.total || this.registry.bytes(m) > card.total * 0.85;
  }

  /** Will this model run on this PC at all? (The free-memory check at Connect is separate.) */
  private hardwareFit(m: RegistryModel): { level: 'ok' | 'slow' | 'no'; text: string } {
    const hw = this.deps.hardware;
    const ramGB = hw.ram / GB;
    const card = hw.gpus.find(g => !g.integrated && g.total);
    const vramGB = card?.total ? card.total / GB : 0;
    if (ramGB < m.minRamGB) return { level: 'no', text: `Needs ${m.minRamGB} GB of RAM; this PC has ${ramGB.toFixed(0)} GB.` };
    if (m.minVramGB >= 4 && vramGB < m.minVramGB) return { level: 'slow', text: `Made for a graphics card with ${m.minVramGB} GB or more; ${card ? `this one has ${vramGB.toFixed(1)} GB` : 'this PC has none'}, so it runs on the CPU and is very slow.` };
    return { level: 'ok', text: 'Fits this PC.' };
  }

  private files(m: RegistryModel) {
    const by = (role: string) => m.files.find(f => f.role === role);
    const path = (role: string) => {
      const f = by(role);
      return f ? this.registry.filePath(m, f) : null;
    };
    return { by, path };
  }

  private args(m: RegistryModel, port: number, threads: number, decoder: Decoder, device: Device = 'cpu'): string[] {
    const { path } = this.files(m);
    const args: string[] = [];
    if (path('model')) args.push('-m', path('model')!);
    if (path('diffusion')) args.push('--diffusion-model', path('diffusion')!);
    if (path('llm')) args.push('--llm', path('llm')!);
    if (path('vae')) args.push('--vae', path('vae')!);
    if (decoder === 'fast' && path('taesd')) args.push('--taesd', path('taesd')!);
    if (device !== 'cpu' && this.overCard(m)) args.push(...OFFLOAD);
    // The LoRA's own folder: a model lent by another folder or copy has its LoRA there, not in this copy's models.
    if (path('lora')) args.push('--lora-model-dir', dirname(path('lora')!));
    // Every weight is read at Connect (not on the first picture), so the memory shown is what the model really holds.
    args.push('--eager-load', ...(m.args ?? []), '--listen-ip', '127.0.0.1', '--listen-port', String(port), '-t', String(threads > 0 ? threads : -1));
    return args;
  }

  async connect(id: string, asked: Asked, threads: number, devices?: Device[], note?: string): Promise<{ ok: true } | { error: string }> {
    const m = this.registry.get(id);
    if (!m || m.kind !== 'image') return { error: `There is no image model ${id}.` };
    if (!this.registry.installed(m)) return { error: `${m.name} is not downloaded yet. Download it under Models first.` };
    this.lastConnect = { id, asked, threads };
    await this.deps.store.saveSettings({ image: { model: id, asked, threads } });
    const s = await this.deps.store.settings();
    const decoder = this.decoder;
    const req: ConnectRequest = {
      model: id,
      modelName: m.name,
      asked,
      threads,
      devices: devices ?? this.deps.devicesFor('sd', asked),
      note: note ?? ((asked !== 'cpu' ? missingCardRunner('sd', this.deps.hardware.gpus, d => this.deps.runtimes.installed('sd', d)) : '') || undefined),
      expectedSeconds: s.loadSeconds[`image:${id}`] ?? Math.round(this.registry.bytes(m) / (200 * 2 ** 20)) + 4,
      build: device => ({
        exe: this.deps.runtimes.exe('sd', device)!,
        args: port => this.args(m, port, threads, decoder, device),
        ready: async port => (await fetch(`http://127.0.0.1:${port}/sdcpp/v1/capabilities`)).ok,
        device,
        timeoutSeconds: 900,
      }),
      why: whyImage,
    };
    void this.pane.connect(req);
    return { ok: true };
  }

  /** Starts the same model again (Cancel, or switching between the fast and the full decoder). */
  private async restart(decoder: Decoder, stage: string, devices?: Device[], note?: string): Promise<boolean> {
    if (!this.lastConnect) return false;
    this.restarting = true;
    try {
      this.decoder = decoder;
      await this.pane.disconnect();
      const { id, asked, threads } = this.lastConnect;
      const r = await this.connect(id, asked, threads, devices, note);
      if ('error' in r) return false;
      this.pane.worker.view.stage = stage;
      while (this.pane.view.state === 'loading') await sleep(300);
      return this.pane.view.state === 'connected';
    } finally {
      this.restarting = false;
    }
  }

  busy(): boolean {
    return !!this.current || this.jobs.length > 0;
  }

  lastUsedAt(pane: string): number {
    return pane === 'image' ? this.used : 0;
  }

  // ---- Progress, from what sd-server prints ----

  private onRunnerLine(line: string): void {
    const job = this.current;
    if (!job) return;
    const img = /generating image: (\d+)\/(\d+)/.exec(line);
    if (img) {
      job.image = Number(img[1]);
      job.step = 0;
      job.state = 'drawing';
    }
    const steps = [...line.matchAll(/\|\s*(\d+)\/(\d+) - ([\d.]+)(s\/it|it\/s)/g)].pop();
    if (steps && job.state !== 'decoding') {
      job.step = Number(steps[1]);
      const v = Number(steps[3]);
      job.perStep = steps[4] === 's/it' ? v : 1 / v;
      job.stepAt = Date.now();
      job.state = 'drawing';
    }
    if (/decoding \d+ latents|decode_first_stage/.test(line) && !/completed/.test(line)) job.state = 'decoding';
    void this.updateEta(job);
  }

  private timingKey(): string {
    return `${this.pane.view.model}|${this.pane.view.device}|${this.decoder}`;
  }

  private async updateEta(job: Job): Promise<void> {
    const t = (await this.deps.store.settings()).timings[this.timingKey()];
    const perStep = job.perStep ?? t?.perStep;
    if (!perStep) return void (job.etaSeconds = null);
    const decode = t?.decode ?? perStep;
    // All pictures are drawn first, then all are decoded.
    const stepsLeft = (job.count - Math.max(1, job.image)) * job.steps + Math.max(0, job.steps - job.step);
    const left = job.state === 'decoding' ? (job.count * decode) / 2 : stepsLeft * perStep + job.count * decode;
    job.etaSeconds = Math.round(left);
  }

  jobView() {
    const j = this.current ?? this.jobs[0] ?? this.lastJob;
    if (!j) return null;
    // One for a linked PC shows only who it is for, never the words or the picture (F7 E2).
    const forPc = j.opts.forPc;
    return {
      id: j.id, state: j.state, mode: j.mode, modeWhy: j.modeWhy, target: j.target, generated: j.generated, count: j.count, steps: j.steps, step: j.step, image: j.image,
      perStep: j.perStep, etaSeconds: j.etaSeconds, elapsed: Math.round((Date.now() - j.startedAt) / 1000), results: j.results, error: j.error, note: j.note,
      finalOf: j.opts.finalOf ?? null, queued: this.jobs.length, prompt: j.opts.prompt,
      chat: j.opts.chat ?? null,
      ...(forPc ? { prompt: `Drawing for ${forPc}`, results: [], error: j.error ? `The picture for ${forPc} did not come out.` : null, note: null, forPc } : {}),
    };
  }

  private lastJob: Job | null = null;
  /** Pictures drawn for a linked PC, by job, held in memory only until drawForPc takes them (F7 E2). */
  private away = new Map<string, { png: Buffer; modelName: string; modelPrompt: string; mode: Mode; seconds: number }>();

  /** The picture drawn for a linked PC, handed over once and forgotten here. */
  takeAway(jobId: string) {
    const pic = this.away.get(jobId) ?? null;
    this.away.delete(jobId);
    return pic;
  }

  // ---- Making pictures ----

  /** Checks and queues a request; returns the job (its `done` settles when the pictures are saved or it fails). */
  async generate(opts: GenerateOptions): Promise<Job | { error: string; status: number }> {
    if (this.pane.view.state !== 'connected' && !this.restarting) return { error: 'The picture model is not loaded. Press Connect beside it (in an artist\'s chat) first; nothing loads by itself.', status: 409 };
    const m = this.registry.get(this.pane.view.model ?? '')!;
    let base: Picture | undefined;
    if (opts.finalOf || opts.again) {
      base = await this.gallery.get((opts.finalOf ?? opts.again)!);
      if (!base) return { error: 'That picture is not in the gallery any more.', status: 404 };
    }
    // A final or a redraw stays in the draft's chat; a new picture goes into the chat its asker names (never the server's
    // open chat: that is whichever window opened one last).
    const chatId = base ? base.chat : opts.chat;
    opts = { ...opts, chat: chatId || undefined };
    const typed = (base?.prompt ?? opts.prompt ?? '').trim();
    if (!typed) return { error: 'Type a prompt first: what should the picture show?', status: 400 };
    if (typed.length > 2000) return { error: 'That prompt is too long (over 2,000 characters). Shorten it.', status: 400 };
    const verdict = checkMessage(typed, { recent: [] });
    if (!verdict.ok) return { error: REFUSAL[verdict.reason].replace('Change the subject and carry on.', 'Change the prompt.').replace('Make someone up instead and carry on.', 'Describe a made-up person instead.'), status: 422 };

    const recipe = !base && opts.as && this.recipe ? this.recipe(opts.as) : null;
    const parsed = parseSize(typed);
    const fieldSize = opts.width && opts.height ? { width: Math.round(opts.width), height: Math.round(opts.height) } : null;
    // "profile picture of …" with no size: a square portrait.
    const target0 = base ? base.target : parsed.size ?? fieldSize ?? (portraitAsk(parsed.prompt) ? PORTRAIT_SIZE : null);
    const { mode, why } = base ? { mode: base.mode, why: 'same as the draft' } : recipe?.mode ? { mode: recipe.mode, why: 'their way of working' } : opts.mode && opts.mode !== 'auto' ? { mode: opts.mode, why: 'chosen' } : detectMode(parsed.prompt, target0);
    const preset = PRESETS[mode];
    const defaults = m.defaults ?? { steps: 20, cfg: 7, sampler: 'euler_a', scheduler: '', negative: '' };
    const generated = base ? base.generated : generationSize(target0, m.native ?? 512);
    const target = target0 ?? generated;
    let modelPrompt = base ? base.modelPrompt : boosted(parsed.prompt, preset);
    if (!base && mode === 'icon' && m.transparent && m.transparentPrompt) modelPrompt = m.transparentPrompt.replace('{prompt}', boosted(parsed.prompt, { ...preset, boost: preset.boost.replace(', plain white background', '') }));
    if (recipe?.boost && !base) modelPrompt = `${modelPrompt.replace(/[\s,.]+$/, '')}, ${recipe.boost}`;
    const negative = base ? base.negative : [opts.negative?.trim(), recipe?.negative, preset.negative, portraitAsk(parsed.prompt) ? PORTRAIT_NEGATIVE : '', defaults.negative].filter(Boolean).join(', ');
    const final = !!opts.finalOf || opts.full === true;
    // A final keeps the draft's seed and steps (with few-step models, other steps would draw a different picture);
    // what changes is the decoder (full quality) and the file.
    const steps = base ? base.steps : clampInt(opts.steps, 1, 100) ?? defaults.steps;
    const count = final || base ? 1 : clampInt(opts.drafts, 1, 4) ?? recipe?.drafts ?? preset.drafts;
    const seed = base ? base.seed : typeof opts.seed === 'number' && opts.seed >= 0 ? Math.floor(opts.seed) : randomInt(0, 2 ** 31 - 1);
    const job: Job = {
      id: randomBytes(6).toString('hex'), state: 'queued', opts: { ...opts, prompt: typed }, mode, modeWhy: why, target, generated, count, steps, step: 0, image: 0, perStep: null,
      startedAt: Date.now(), stepAt: 0, etaSeconds: null, results: [], error: null, note: null, done: Promise.resolve(),
    };
    const plan = {
      modelPrompt, negative, seed, steps, final,
      cfg: base && !final ? base.cfg : typeof opts.cfg === 'number' && opts.cfg >= 0 && opts.cfg <= 30 ? opts.cfg : defaults.cfg,
      sampler: base && !final ? base.sampler : opts.sampler && /^[\w+]+$/.test(opts.sampler) ? opts.sampler : defaults.sampler,
      scheduler: defaults.scheduler,
      fit: (base?.fit ?? opts.fit ?? 'crop') as Fit,
      ico: !!opts.ico,
      draft: !final && mode === 'blog',
    };
    job.done = new Promise<void>(resolve => {
      this.jobs.push(job);
      void this.pump(job, plan, m).finally(resolve);
    });
    return job;
  }

  /** Runs queued jobs one at a time, in order. */
  private async pump(job: Job, plan: Plan, m: RegistryModel): Promise<void> {
    while (this.current || this.jobs[0] !== job) {
      if (job.state === 'cancelled') return;
      await sleep(250);
    }
    this.jobs.shift();
    if (job.state === 'cancelled') return;
    this.current = job;
    this.lastJob = job;
    job.startedAt = Date.now();
    try {
      await this.run(job, plan, m, true);
    } finally {
      this.current = null;
      this.used = Date.now();
    }
  }

  private async run(job: Job, plan: Plan, m: RegistryModel, mayFallBack: boolean): Promise<void> {
    job.state = 'starting';
    this.used = Date.now();
    // Finals use the full decoder; drafts the fast one (TAESD), when the model has one.
    const wantDecoder: Decoder = plan.final || !m.files.some(f => f.role === 'taesd') ? 'full' : 'fast';
    if (wantDecoder !== this.decoder && m.files.some(f => f.role === 'taesd')) {
      job.note = wantDecoder === 'full' ? 'Switching to the full-quality decoder for the final (the model reloads).' : 'Switching back to the fast decoder for drafts (the model reloads).';
      if (!(await this.restart(wantDecoder, wantDecoder === 'full' ? 'Loading the full-quality decoder' : 'Loading the fast decoder'))) return this.fail(job, 'The image model did not load again after switching decoders. Press Connect to try again.');
    }
    // A Cancel just before this loads the model again: this picture waits for it (up to 15 minutes) instead of failing.
    const cancelled = () => (job.state as string) === 'cancelled';
    for (const t0 = Date.now(); (this.restarting || this.pane.view.state === 'loading') && !cancelled() && Date.now() - t0 < 15 * 60_000;) await sleep(300);
    if (cancelled()) return;
    const base = this.pane.worker.base;
    if (!base || this.pane.view.state !== 'connected') return this.fail(job, 'The picture model was unloaded before the picture started.');
    const device = this.pane.view.device!;
    const loras = m.files.filter(f => f.role === 'lora').map(f => ({ path: this.registry.fileName(f), multiplier: 1 }));
    const body = {
      prompt: plan.modelPrompt, negative_prompt: plan.negative, width: job.generated.width, height: job.generated.height, seed: plan.seed, batch_count: job.count,
      sample_params: { sample_method: plan.sampler, sample_steps: plan.steps, ...(plan.scheduler ? { scheduler: plan.scheduler } : {}), guidance: { txt_cfg: plan.cfg } },
      lora: loras, output_format: 'png', embed_image_metadata: false,
    };
    const t0 = Date.now();
    let sdJob: string;
    try {
      const r = await fetch(`${base}/sdcpp/v1/img_gen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { id?: string; error?: { message?: string } | string };
      if (!r.ok || !j.id) return this.fail(job, `The image runner refused the request: ${typeof j.error === 'string' ? j.error : j.error?.message ?? r.status}.`);
      sdJob = j.id;
    } catch (error) {
      return this.fail(job, `The image runner did not answer: ${(error as Error).message}.`);
    }
    job.state = 'drawing';
    job.image = 1;
    // Cancel (and the progress lines) change the state while this loop waits: read as it is at each look.
    const stateNow = (): string => job.state;
    let result: { images: Array<{ b64_json: string }> } | null = null;
    let decodeStart = 0;
    for (;;) {
      await sleep(400);
      if (stateNow() === 'cancelled') return;
      if (stateNow() === 'decoding' && !decodeStart) decodeStart = Date.now();
      let st: { status: string; result?: { images: Array<{ b64_json: string }> }; error?: { message?: string } };
      try {
        st = await (await fetch(`${this.pane.worker.base ?? base}/sdcpp/v1/jobs/${sdJob}`)).json();
      } catch {
        // The runner went away (it ran out of memory, or Cancel restarted it).
        if (stateNow() === 'cancelled') return;
        const tail = this.pane.worker.tail();
        if (mayFallBack && this.pane.view.asked === 'auto' && device !== 'cpu') return this.fallBack(job, plan, m, tail);
        return this.fail(job, `The image runner stopped while drawing. ${whyImage(tail)}`);
      }
      if (st.status === 'completed') {
        result = st.result ?? null;
        break;
      }
      if (st.status === 'failed' || st.status === 'cancelled') {
        const msg = st.error?.message ?? 'no reason given';
        if (mayFallBack && this.pane.view.asked === 'auto' && device !== 'cpu' && /memory|alloc/i.test(msg + this.pane.worker.tail())) return this.fallBack(job, plan, m, msg);
        return this.fail(job, `The picture failed in the image runner: ${msg}.`);
      }
    }
    const seconds = (Date.now() - t0) / 1000;
    // Remember the speed for next time's estimate.
    if (job.perStep) {
      const decode = decodeStart ? (Date.now() - decodeStart) / 1000 / job.count : job.perStep;
      // A speed note that cannot be saved is not worth losing the picture over.
      await this.deps.store.saveSettings({ timings: { [this.timingKey()]: { perStep: job.perStep, decode } } }).catch(() => undefined);
    }
    if (!result?.images?.length) return this.fail(job, 'The image runner finished but sent no picture back.');
    job.state = 'finishing';
    try {
      for (let i = 0; i < result.images.length; i++) {
        const png = Buffer.from(result.images[i].b64_json, 'base64');
        if (job.opts.forPc) {
          // For a linked PC: shaped in memory, never saved here (F7 E2). drawForPc takes it at once.
          const shaped = await this.shape(job, plan, png);
          this.away.set(job.id, { png: shaped.data, modelName: m.name, modelPrompt: plan.modelPrompt, mode: job.mode, seconds: Math.round((seconds / result.images.length) * 10) / 10 });
          continue;
        }
        job.results.push(await this.finish(job, plan, m, png, plan.seed + i, seconds / result.images.length, device));
      }
    } catch (error) {
      return this.fail(job, `The picture was drawn but could not be finished: ${(error as Error).message}`);
    }
    job.state = 'done';
    job.etaSeconds = 0;
    // Blog finals get alt text from the chat model when it is connected (nothing loads for it).
    if (plan.final && job.mode === 'blog' && this.deps.chatPane.view.state === 'connected' && this.askChat) {
      for (const p of job.results) await this.altText(p.id).catch(() => undefined);
    }
  }

  private async fallBack(job: Job, plan: Plan, m: RegistryModel, why: string): Promise<void> {
    job.note = `The ${DEVICE_WORDS[this.pane.view.device ?? 'vulkan']} ran out of memory (${why.split('\n')[0].slice(0, 120)}), so TOMLIN moved the image model to the CPU and is drawing again there.`;
    job.state = 'starting';
    job.step = 0;
    job.perStep = null;
    if (!(await this.restart(this.decoder, 'Moving to the CPU', ['cpu'], job.note))) return this.fail(job, 'The image model did not load on the CPU either. Close other programs and press Connect again.');
    return this.run(job, plan, m, false);
  }

  private fail(job: Job, error: string): void {
    if (job.state === 'cancelled') return;
    job.state = 'failed';
    job.error = error;
  }

  /** Resize and cut the background, in memory: the picture as it will be shown, and how it was fitted. */
  private async shape(job: Job, plan: Plan, png: Buffer): Promise<{ out: Buffer; data: Buffer; transparent: boolean; fit: Fit; format: 'png' | 'webp' }> {
    const preset = PRESETS[job.mode];
    let out = png;
    let transparent = false;
    if (preset.removeBackground) {
      if (!(await hasTransparency(png))) {
        const helper = this.registry.get('rembg-u2netp');
        if (!helper || !this.registry.installed(helper)) throw new Error('the background remover is not downloaded (Models, Background remover).');
        const { mask, size } = await subjectMask(this.registry.filePath(helper, helper.files[0]), png);
        out = await withAlpha(png, mask, size);
      }
      out = await centreIcon(out);
      transparent = true;
    }
    const fit = transparent ? 'pad' : plan.fit;
    if (out.length && (job.target.width !== job.generated.width || job.target.height !== job.generated.height || transparent)) out = await fitTo(out, job.target, fit);
    const format = plan.final && preset.format === 'webp' ? 'webp' : 'png';
    let data = out;
    if (format === 'webp') data = (await webp(out)).data;
    return { out, data, transparent, fit, format };
  }

  /** Resize, cut the background, save, and write the gallery line. */
  private async finish(job: Job, plan: Plan, m: RegistryModel, png: Buffer, seed: number, seconds: number, device: Device): Promise<Picture> {
    const name = slug(job.opts.prompt.replace(/\d{2,4}\s*(px|pixels?)?\s*(x|×|by|\*)\s*\d{2,4}\s*(px|pixels?)?/gi, ''));
    const id = randomBytes(6).toString('hex');
    const original = await this.gallery.save(`${name}-${seed}-original.png`, png);
    const { out, data, transparent, fit, format } = await this.shape(job, plan, png);
    const output = await this.gallery.save(`${name}-${sizeText(job.target).replace('×', 'x')}${plan.draft ? `-draft-${seed}` : ''}.${format}`, data);
    let icoFiles: string[] | undefined;
    if (plan.ico && transparent) {
      const set = await iconSet(out);
      icoFiles = [];
      for (const p of set.pngs) icoFiles.push(await this.gallery.save(`${name}-${p.size}.png`, p.data));
      icoFiles.push(await this.gallery.save(`${name}.ico`, set.ico));
    }
    const picture: Picture = {
      id, at: new Date().toISOString(), prompt: job.opts.prompt, modelPrompt: plan.modelPrompt, negative: plan.negative, mode: job.mode, model: m.id, modelName: m.name,
      seed, steps: plan.steps, cfg: plan.cfg, sampler: plan.sampler, generated: job.generated, target: job.target, fit, device, seconds: Math.round(seconds * 10) / 10,
      draft: plan.draft, finalOf: job.opts.finalOf, original, output, format, bytes: data.length, icoFiles, transparent,
      // Every new picture waits as a draft until the person adds it to the gallery.
      kept: false,
      ...(job.opts.chat ? { chat: job.opts.chat } : {}),
    };
    await this.gallery.add(picture);
    return picture;
  }

  /** A picture a paired PC drew for this one: saved in the gallery like one drawn here, as a draft in its chat. */
  async receive(o: { png: Buffer; prompt: string; modelPrompt: string; mode: string; modelName: string; pc: string; seconds: number; chat?: string }): Promise<Picture> {
    const { width = 512, height = 512 } = await sharp(o.png).metadata();
    const size = { width, height };
    const output = await this.gallery.save(`${slug(o.prompt)}-${width}x${height}.png`, o.png);
    const picture: Picture = {
      id: randomBytes(6).toString('hex'), at: new Date().toISOString(), prompt: o.prompt, modelPrompt: o.modelPrompt, negative: '',
      mode: (MODES as string[]).includes(o.mode) ? (o.mode as Mode) : 'custom', model: 'remote', modelName: `${o.modelName || 'a picture model'} on ${o.pc}`,
      seed: 0, steps: 0, cfg: 0, sampler: '', generated: size, target: size, fit: 'crop', device: `on ${o.pc}`, seconds: Math.round(o.seconds * 10) / 10,
      draft: false, original: output, output, format: 'png', bytes: o.png.length, kept: false,
      ...(o.chat ? { chat: o.chat } : {}),
    };
    await this.gallery.add(picture);
    return picture;
  }

  /** Stops the current picture. The runner cannot stop part-way, so it is ended and the model loaded again. */
  /**
   * Cancels every picture (the Cancel button), or only the one with `id` (a chat or another PC that stopped asking).
   * `restart: false` (an unload): the model is not loaded again after it, since it is being unloaded anyway.
   */
  async cancel(id?: string, o: { restart?: boolean } = {}): Promise<{ restarted: boolean }> {
    if (id !== undefined) {
      const queued = this.jobs.find(j => j.id === id);
      if (queued) {
        queued.state = 'cancelled';
        this.jobs = this.jobs.filter(j => j !== queued);
        return { restarted: false };
      }
      if (this.current?.id !== id) return { restarted: false };
    } else {
      for (const j of this.jobs) j.state = 'cancelled';
      this.jobs = [];
    }
    const job = this.current;
    if (!job) return { restarted: false };
    job.state = 'cancelled';
    job.error = null;
    if (o.restart === false) {
      job.note = 'Cancelled: the picture model was unloaded.';
      return { restarted: false };
    }
    job.note = 'Cancelled. The image runner cannot stop part-way, so it was ended and the model loaded again.';
    if (this.pane.view.state === 'connected') void this.restart(this.decoder, 'Loading again after Cancel');
    return { restarted: true };
  }

  // ---- Help from the chat model ----

  private needChat(): string | null {
    if (this.deps.chatPane.view.state !== 'connected' || !this.askChat) return 'This needs a chat model, and none is loaded (nothing loads by itself). Press Connect in the host\'s chat, then try again.';
    return null;
  }

  async enhance(prompt: string): Promise<string> {
    const system = 'You rewrite short picture requests into one detailed prompt for an image model. Keep the subject and any style the person asked for; add setting, lighting, composition and detail. Leave out sizes and pixel counts. Answer with the prompt only: one line, under 60 words, no quotes, no preface.';
    return clean(await this.askChat!(system, prompt, 160));
  }

  /** Alt text for a picture, written from its prompt (the chat model cannot see pictures). */
  async altText(id: string): Promise<Picture | undefined> {
    const p = await this.gallery.get(id);
    if (!p) return undefined;
    const system = 'Write alt text for a picture on a web page, from the description it was made from. One plain sentence, under 125 characters, describing what is shown. No "image of" or "picture of". Answer with the alt text only.';
    const alt = clean(await this.askChat!(system, p.prompt.replace(/\d{2,4}\s*(px)?\s*(x|×|by)\s*\d{2,4}\s*(px)?/gi, '').replace(/\bfor a blog( post)?\b/gi, ''), 80));
    return this.gallery.update(id, { altText: alt, altFrom: 'the prompt (the chat model cannot see pictures)' });
  }

  /** A picture prompt from a chat answer ("what's for dinner?" -> "chicken adobo ..."). */
  async promptFromChat(question: string, answer: string): Promise<string> {
    const system = 'From this chat exchange, write one prompt for an image model that shows the thing being talked about (a dish, a place, an object or a scene) as a photo. One line, under 40 words, no people\'s names, no quotes, no preface.';
    return clean(await this.askChat!(system, `They asked: ${question.slice(0, 500)}\nThe answer: ${answer.slice(0, 1500)}`, 120));
  }

  // ---- Routes ----

  async get(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === '/api/images/job') return send(res, 200, this.jobView()), true;
    if (p === '/api/images/gallery') {
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const shelf = (['gallery', 'drafts', 'all'] as const).find(x => x === url.searchParams.get('shelf')) ?? 'all';
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      // ?chat=<id>: only that chat's pictures; no chat given: every picture.
      const chat = url.searchParams.get('chat');
      return send(res, 200, await this.gallery.list(offset, Math.min(200, Number(url.searchParams.get('limit')) || 60), shelf as Shelf, q, chat === null ? undefined : chat.slice(0, 40))), true;
    }
    if (p === '/api/downloads') return send(res, 200, { image: this.list(), helpers: this.helpers() }), true;
    if (p === '/api/images/plan') {
      // What a prompt will do, for the hint under the prompt box (no model needed).
      const parsed = parseSize(url.searchParams.get('prompt') ?? '');
      const w = Number(url.searchParams.get('width'));
      const h = Number(url.searchParams.get('height'));
      const target = parsed.size ?? (w >= 16 && h >= 16 ? { width: w, height: h } : null) ?? (portraitAsk(parsed.prompt) ? PORTRAIT_SIZE : null);
      // Connected: the model in use; otherwise the one chosen in the list.
      const m = this.registry.get((this.pane.view.state === 'connected' ? this.pane.view.model : url.searchParams.get('model') || this.pane.view.model) ?? '');
      const chosen = url.searchParams.get('mode');
      const { mode, why } = MODES.includes(chosen as Mode) ? { mode: chosen as Mode, why: 'chosen' } : detectMode(parsed.prompt, target);
      return send(res, 200, { size: parsed.size, prompt: parsed.prompt, target, generated: generationSize(target, m?.native ?? 512), mode, why, drafts: PRESETS[mode].drafts, portrait: portraitAsk(parsed.prompt), better: this.betterFor(mode, m) }), true;
    }
    const file = /^\/api\/images\/file\/(.+)$/.exec(p);
    if (file) {
      const rel = decodeURIComponent(file[1]);
      const full = await this.gallery.file(rel);
      if (!full) return send(res, 404, { error: 'Not found.' }), true;
      const type = { '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' }[extname(rel).toLowerCase()] ?? 'application/octet-stream';
      const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
      if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${rel.split('/').pop()}"`;
      res.writeHead(200, headers);
      res.end(await readFile(full));
      return true;
    }
    return false;
  }

  async post(req: IncomingMessage, res: ServerResponse, url: URL, b: Record<string, unknown>): Promise<boolean> {
    switch (url.pathname) {
      case '/api/images/finalise':
      case '/api/images/again': {
        const id = String(b.id ?? '');
        const r = await this.generate({ prompt: '', source: 'page', ...(url.pathname.endsWith('finalise') ? { finalOf: id } : { again: id }), ico: b.ico === true });
        if (!('id' in r)) return send(res, r.status, { error: r.error }), true;
        return send(res, 202, { id: r.id, job: this.jobView() }), true;
      }
      case '/api/images/keep': {
        const p = await this.gallery.get(String(b.id ?? ''));
        if (!p || p.removed) return send(res, 404, { error: 'That picture is not in the gallery any more.' }), true;
        const kept = await this.gallery.update(p.id, { kept: b.kept !== false });
        if (b.kept !== false && !p.kept) void this.onKept?.(p, await this.gallery.file(p.output));
        return send(res, 200, kept), true;
      }
      case '/api/images/delete': {
        // {ids}: the pictures picked; or {chat, which: 'recent' | 'all'}: a chat's pictures from today, or all of them.
        // Deleted for good (files and entry).
        const live = (await this.gallery.all()).filter(p => !p.removed && !p.private);
        let pick: typeof live = [];
        if (Array.isArray(b.ids)) {
          const want = new Set(b.ids.filter((x): x is string => typeof x === 'string').slice(0, 500));
          pick = live.filter(p => want.has(p.id));
        } else if (typeof b.chat === 'string' && (b.which === 'recent' || b.which === 'all')) {
          const since = new Date();
          since.setHours(0, 0, 0, 0);
          pick = live.filter(p => (p.chat ?? '') === b.chat && (b.which === 'all' || new Date(p.at) >= since));
        } else return send(res, 400, { error: 'Say which pictures to delete.' }), true;
        for (const p of pick) await this.gallery.remove(p.id);
        // A deleted picture also leaves the latest results, or a reload draws it again with its files gone.
        const gone = new Set(pick.map(p => p.id));
        for (const j of [this.current, this.lastJob, ...this.jobs]) if (j) j.results = j.results.filter(p => !gone.has(p.id));
        return send(res, 200, { deleted: pick.length, ids: [...gone] }), true;
      }
      case '/api/images/cancel':
        return send(res, 200, await this.cancel()), true;
      case '/api/images/enhance': {
        const no = this.needChat();
        if (no) return send(res, 409, { error: no }), true;
        const prompt = String(b.prompt ?? '').trim();
        if (!prompt) return send(res, 400, { error: 'Type a short prompt first; the chat model makes it longer.' }), true;
        return send(res, 200, { prompt: await this.enhance(prompt) }), true;
      }
      case '/api/images/alt': {
        const no = this.needChat();
        if (no) return send(res, 409, { error: no }), true;
        const p = await this.altText(String(b.id ?? ''));
        return p ? (send(res, 200, p), true) : (send(res, 404, { error: 'That picture is not in the gallery any more.' }), true);
      }
      case '/api/images/from-chat': {
        const no = this.needChat();
        if (no) return send(res, 409, { error: no }), true;
        return send(res, 200, { prompt: await this.promptFromChat(String(b.question ?? ''), String(b.answer ?? '')) }), true;
      }
      case '/api/downloads/start': {
        try {
          return send(res, 202, await this.registry.start(String(b.id ?? ''))), true;
        } catch (error) {
          return send(res, 400, { error: (error as Error).message }), true;
        }
      }
      case '/api/downloads/stop':
        this.registry.stop(String(b.id ?? ''));
        return send(res, 200, { ok: true }), true;
      default:
        return false;
    }
  }

  /** POST /v1/images/generations (OpenAI-style): waits for the pictures and returns them. */
  async openAi(_req: IncomingMessage, res: ServerResponse, b: Record<string, unknown>): Promise<void> {
    const size = /^(\d{2,4})x(\d{2,4})$/.exec(String(b.size ?? ''));
    const n = clampInt(b.n, 1, 4) ?? 1;
    const opts = optionsFrom({ ...b, width: size ? Number(size[1]) : undefined, height: size ? Number(size[2]) : undefined, drafts: n, negative: b.negative_prompt }, 'api');
    const r = await this.generate(opts);
    if (!('id' in r)) return send(res, r.status, { error: { message: r.error, type: r.status === 409 ? 'model_not_loaded' : 'invalid_request_error', code: r.status === 409 ? 'model_not_loaded' : null } });
    await r.done;
    if (r.state !== 'done') return send(res, 500, { error: { message: r.error ?? (r.state === 'cancelled' ? 'Cancelled in TOMLIN.' : 'The picture failed.'), type: 'server_error' } });
    const asUrl = b.response_format === 'url';
    const data = await Promise.all(r.results.map(async p => ({
      ...(asUrl ? { url: `/api/images/file/${p.output}` } : { b64_json: (await readFile(join(this.gallery.dir, p.output))).toString('base64') }),
      revised_prompt: p.modelPrompt,
      seed: p.seed,
    })));
    send(res, 200, { created: Math.floor(Date.now() / 1000), data });
  }
}

interface Plan {
  modelPrompt: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  fit: Fit;
  ico: boolean;
  final: boolean;
  draft: boolean;
}

function clampInt(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** A picture asked for, from a request body (the page's Generate is src/server/pictures.ts, which names its chat). */
export function optionsFrom(b: Record<string, unknown>, source: GenerateOptions['source']): GenerateOptions {
  const mode = MODES.includes(b.mode as Mode) ? (b.mode as Mode) : 'auto';
  const fit = ['crop', 'pad', 'stretch'].includes(String(b.fit)) ? (b.fit as Fit) : 'crop';
  const num = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  return {
    prompt: String(b.prompt ?? ''), negative: typeof b.negative === 'string' ? b.negative.slice(0, 1000) : undefined, mode, fit,
    width: num(b.width), height: num(b.height), seed: num(b.seed) ?? null, steps: num(b.steps), cfg: num(b.cfg), sampler: typeof b.sampler === 'string' ? b.sampler : undefined,
    drafts: num(b.drafts), ico: b.ico === true, source, as: typeof b.as === 'string' && /^[a-z0-9-]{1,40}$/.test(b.as) ? b.as : undefined,
  };
}

/** A model's one-line answer without quotes, labels or a trailing explanation. */
function clean(text: string): string {
  return text.split('\n').map(s => s.trim()).filter(Boolean)[0]?.replace(/^(prompt|alt text|alt)\s*:\s*/i, '').replace(/^["'“]|["'”]$/g, '').trim() ?? '';
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
