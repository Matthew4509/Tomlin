// The first-run runner test: when a PC is offered it, what counts as a pass, the questions it asks, the words, and what
// is kept (data/runner-check.json: for this card and driver, which runner passed or failed, or that it was skipped).
// The run itself is src/server/runnercheck.ts; it reuses the speed finder's prompts and timings (src/finderrun.ts).
// Tested in test/runnercheck.test.ts.
import { readData, updateData } from './atomic.ts';
import { READ_PROMPT, request } from './finderrun.ts';
import type { Device, GpuFacts } from './runtimes.ts';

export interface CheckResult {
  state: 'passed' | 'failed';
  at: string;
  /** Plain words: what failed ('' for a pass). */
  why: string;
  device: string;
  /** Writing speed of the pass, tokens a second. */
  write: number | null;
  /** Seconds the runner took to load the model. */
  seconds: number | null;
}

export interface CheckRecord {
  /** Which card and driver this is for (hardwareKey); another card or driver is a new record. */
  hw: string;
  /** 'partial': a test that was stopped (or is running); it is offered again. */
  state: 'done' | 'skipped' | 'partial';
  at: string;
  results: Record<string, CheckResult>;
  /** The runner kept: the first that passed. */
  keep?: string;
}

/** The cards and driver a record belongs to: another card, or a new driver, asks again. */
export function hardwareKey(gpus: GpuFacts[], driver: string | null): string {
  const cards = gpus.filter(g => !g.integrated && (g.total ?? 0) > 0).map(g => `${g.name ?? g.vendor}`).sort();
  return `${cards.join(' + ')} | ${driver ?? 'no driver'}`;
}

/**
 * Whether to offer the test: a graphics card of its own, a card runner unpacked, a chat model to try it with, and no
 * answer yet (done or skipped) for this card and driver.
 */
export function checkDue(o: { cardRunners: number; hasModel: boolean; rec: CheckRecord | null }): boolean {
  return o.cardRunners > 0 && o.hasModel && (!o.rec || o.rec.state === 'partial');
}

/** The hello's word for how this PC's test stands. */
export function checkWord(o: { due: boolean; rec: CheckRecord | null }): 'none' | 'due' | 'passed' | 'failed' | 'skipped' {
  if (o.rec?.state === 'skipped') return 'skipped';
  if (o.rec && o.rec.state !== 'partial') return Object.values(o.rec.results).some(r => r.state === 'passed') ? 'passed' : Object.values(o.rec.results).length ? 'failed' : 'none';
  return o.due ? 'due' : o.rec ? (Object.values(o.rec.results).some(r => r.state === 'passed') ? 'passed' : 'none') : 'none';
}

/** The smallest chat model that fits the card with room for its context, never a model Ollama runs. */
export function pickModel(models: { id: string; bytes: number; where?: string }[], cardBytes: number): { id: string; bytes: number } | null {
  const GB = 2 ** 30;
  const fits = models.filter(m => m.where !== 'ollama' && m.bytes > 50 * 2 ** 20 && m.bytes * 1.2 + 1.5 * GB <= cardBytes);
  return [...fits].sort((a, b) => a.bytes - b.bytes)[0] ?? null;
}

// ---- The three questions ----

/** About 3,000 tokens: the finder's reading passage four times. The old runners crashed on long web prompts, not short ones. */
export const LONG_PROMPT = Array.from({ length: 4 }, () => READ_PROMPT).join('\n\n---\n\n');

export type Question = 'warm' | 'write' | 'long';

/** The body each question is sent as: the finder's own, with shorter answers (this is a check, not a measurement). */
export function questionBody(q: Question) {
  if (q === 'warm') return request('warm');
  if (q === 'write') return { ...request('write'), max_tokens: 120 };
  return { ...request('read'), messages: [{ role: 'user', content: LONG_PROMPT }], max_tokens: 60 };
}

export interface Answer {
  text: string;
  write: number;
}

/**
 * Whether one runner passed: it is connected on the device it was asked to use (a card start that went to the CPU
 * already fails in src/server/panes.ts), every question was answered with words, and it was still running afterwards.
 * `error`: the runner's own plain reason, when it did not load.
 */
export function judge(o: { want: Device; state: string; device: string | null; error: string | null; answers: Answer[]; asked: number; alive: boolean }): { ok: boolean; why: string } {
  const named = { cuda: 'the NVIDIA card (CUDA)', vulkan: 'the graphics chip (Vulkan)', cpu: 'the CPU' }[o.want];
  if (o.state !== 'connected') return { ok: false, why: o.error ? o.error.replace(/\s+/g, ' ').slice(0, 300) : 'it did not load the model.' };
  if (o.device !== o.want) return { ok: false, why: `it ran on ${o.device === 'cpu' ? 'the CPU' : o.device ?? 'something else'} instead of ${named}.` };
  if (o.answers.length < o.asked) return { ok: false, why: `it stopped before it had answered all ${o.asked} questions.` };
  if (o.answers.some(a => !a.text.trim())) return { ok: false, why: 'it answered with nothing.' };
  if (!o.alive) return { ok: false, why: 'the runner stopped on its own after it answered.' };
  return { ok: true, why: '' };
}

// ---- Words ----

export const SKIP_WARNING = 'If you skip, TOMLIN uses the runner it expects to suit your card without trying it. A runner that does not suit your card can be slower, or can crash while you are in the middle of a chat. You can run this test any time: Models, Model runners, Test the runners on this PC.';

export const EXPLAIN = (model: string, runners: number) =>
  `TOMLIN will load "${model}" ${runners === 1 ? 'once' : `up to ${runners} times, once for each graphics runner on this PC`}, and ask it three short questions, one of them long. It checks that the runner starts on your card and not the CPU, answers, and does not crash. It keeps the first runner that passes. About 2 to 6 minutes; chats wait while it runs, and the model you had loaded is loaded again afterwards. Nothing else changes.`;

/** The line under the finished test. */
export function summary(rows: { name: string; state: string; why: string }[], kept: string | null): string {
  if (kept) return `Kept: ${kept}. TOMLIN starts models on it first from now on.`;
  if (rows.length && rows.every(r => r.state === 'failed')) return 'No graphics runner passed on this PC, so chats run on the CPU (slower). The reasons are above. A newer NVIDIA driver, or another runner under Models, Model runners, may help; then run the test again.';
  return 'The test stopped before a runner passed. Nothing was changed.';
}

/** Why a runner is out, from its failed test, for the Models page and the hello. */
export const failedWhy = (r: CheckResult): string => `it failed the test on this PC: ${r.why}`;

// ---- What is kept ----

/** data/runner-check.json: one record for each card-and-driver this PC has had. */
export class RunnerChecks {
  private data: Record<string, CheckRecord> = {};
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<this> {
    const j = await readData<Record<string, CheckRecord>>(this.file, {});
    this.data = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    return this;
  }

  rec(hw: string): CheckRecord | null {
    return this.data[hw] ?? null;
  }

  /** The runners whose test failed for this card and driver (Auto and Max mode leave them out). */
  failed(hw: string): Set<string> {
    return new Set(Object.entries(this.rec(hw)?.results ?? {}).filter(([, r]) => r.state === 'failed').map(([id]) => id));
  }

  passed(hw: string): Set<string> {
    return new Set(Object.entries(this.rec(hw)?.results ?? {}).filter(([, r]) => r.state === 'passed').map(([id]) => id));
  }

  keep(hw: string): string | undefined {
    return this.rec(hw)?.keep;
  }

  private async change(hw: string, f: (r: CheckRecord) => CheckRecord): Promise<void> {
    const now = f(this.data[hw] ?? { hw, state: 'partial', at: new Date().toISOString(), results: {} });
    this.data = { ...this.data, [hw]: now };
    await updateData<Record<string, CheckRecord>>(this.file, {}, all => ({ ...all, [hw]: now }), 2);
  }

  /** One runner's result. A pass clears an earlier failure of it, and the first pass is the one kept. */
  async result(hw: string, pin: string, r: CheckResult, keepIt: boolean): Promise<void> {
    await this.change(hw, rec => ({ ...rec, at: new Date().toISOString(), results: { ...rec.results, [pin]: r }, ...(keepIt && r.state === 'passed' ? { keep: pin } : {}) }));
  }

  /** The test ended (a pass, or all failed): nothing more is offered for this card and driver. */
  async done(hw: string): Promise<void> {
    await this.change(hw, rec => ({ ...rec, state: 'done', at: new Date().toISOString() }));
  }

  /** The person skipped it. */
  async skip(hw: string): Promise<void> {
    await this.change(hw, rec => ({ ...rec, state: 'skipped', at: new Date().toISOString() }));
  }
}
