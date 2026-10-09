// How fast each model answers, where it runs: the speed of every real answer (tokens written a second, and how fast the
// prompt was read), and speed tests run on purpose (Test speed: one fixed example prompt). A person, a linked PC and a
// model on this PC show their expected speed from these: the average of recent real answers once there are a few, else
// the last test. Kept in data/speed.json, a few dozen figures per model; never a word of what was asked or answered.
import { join } from 'node:path';
import { readData, writeAtomic } from './atomic.ts';

/** One measured answer or test. */
export interface Sample {
  at: string;
  /** Tokens written a second (the answer). */
  write: number;
  /** Tokens written in all: a short answer's speed says little (start-up costs swamp it). */
  tokens: number;
  /** Tokens of the prompt read a second, when the model said. */
  read?: number;
  /** Seconds to the first word, when it was timed (tests are). */
  first?: number;
}

export interface Track {
  /** The model's name, as shown. */
  name: string;
  /** Where it ran, in words ("this PC", or the linked PC's name). */
  where: string;
  answers: Sample[];
  tests: Sample[];
}

/** What a row shows: the expected speed and where the figure comes from, plus the last answers for the chart. */
export interface Summary {
  name: string;
  where: string;
  /** Expected tokens written a second (null: not measured yet). */
  expect: number | null;
  /** 'answers' = the average of recent real answers; 'test' = the last speed test. */
  basis: 'answers' | 'test' | null;
  /** The average of the recent real answers, and how many. */
  average: { write: number; read: number | null; n: number } | null;
  /** The last speed test: the baseline. */
  test: Sample | null;
  /** Up to 20 recent real answers, oldest first, for the chart. */
  recent: Sample[];
}

/** The fixed example prompt of a speed test (about 150 words: long enough to measure, short enough to wait for). */
export const TEST_PROMPT = 'Write about 150 words on why people bake their own bread. Plain sentences, no headings.';
export const TEST_TOKENS = 220;

const KEEP_ANSWERS = 40;
const KEEP_TESTS = 10;
/** Answers this short are not counted: the start-up cost swamps their speed. */
export const MIN_TOKENS = 24;
/** Real answers needed before their average is trusted over a test. */
export const MIN_ANSWERS = 3;
/** Real answers older than this no longer count (a driver, a setting or the card may have changed). */
const FRESH_MS = 30 * 86_400_000;

/** The key of a model where it runs: on this PC by its file id, on a linked PC by that PC's id and the model's name. */
export const hereKey = (modelId: string) => `here|${modelId}`;
export const pcKey = (pcId: string, model: string) => `pc:${pcId}|${model}`;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A figure that can be kept: a real speed, enough tokens for it to mean something. */
export function cleanSample(s: Partial<Sample> | null | undefined, at = new Date().toISOString()): Sample | null {
  const write = Number(s?.write);
  const tokens = Math.round(Number(s?.tokens) || 0);
  if (!(write > 0 && write < 10_000) || tokens < MIN_TOKENS) return null;
  const read = Number(s?.read);
  const first = Number(s?.first);
  return { at: typeof s?.at === 'string' ? s.at : at, write: round1(write), tokens, ...(read > 0 && read < 1_000_000 ? { read: round1(read) } : {}), ...(first >= 0 && first < 3600 ? { first: round1(first) } : {}) };
}

/** The summary of one track at `now`: expected = the average of fresh real answers once there are a few, else the last test. */
export function summarise(t: Track | undefined, now = Date.now()): Summary | null {
  if (!t) return null;
  const fresh = t.answers.filter(a => now - Date.parse(a.at) < FRESH_MS).slice(-20);
  const reads = fresh.map(a => a.read).filter((x): x is number => typeof x === 'number');
  const average = fresh.length ? { write: round1(mean(fresh.map(a => a.write))), read: reads.length ? Math.round(mean(reads)) : null, n: fresh.length } : null;
  const test = t.tests.at(-1) ?? null;
  const fromAnswers = average && average.n >= MIN_ANSWERS;
  return {
    name: t.name,
    where: t.where,
    expect: fromAnswers ? average!.write : test ? test.write : average ? average.write : null,
    basis: fromAnswers ? 'answers' : test ? 'test' : average ? 'answers' : null,
    average,
    test,
    recent: t.answers.slice(-20),
  };
}

export class Speeds {
  private all: Record<string, Track> = {};
  private file: string;
  private saving: Promise<void> = Promise.resolve();
  /** Keys (or 'pc:<id>|' starts) being speed-tested now: their answers count as the test, not as real answers. */
  testing = new Set<string>();

  private constructor(dir: string) {
    this.file = join(dir, 'speed.json');
  }

  static async load(dir: string): Promise<Speeds> {
    const s = new Speeds(dir);
    {
      const got = await readData<Record<string, Track> | null>(s.file, null);
      if (got && typeof got === 'object' && !Array.isArray(got)) {
        for (const [k, t] of Object.entries(got)) {
          if (!t || typeof t !== 'object') continue;
          const clean = (xs: unknown) => (Array.isArray(xs) ? xs.map(x => cleanSample(x as Sample)).filter((x): x is Sample => !!x) : []);
          s.all[k] = { name: String(t.name ?? ''), where: String(t.where ?? ''), answers: clean(t.answers).slice(-KEEP_ANSWERS), tests: clean(t.tests).slice(-KEEP_TESTS) };
        }
      }
    }
    return s;
  }

  /** Keeps one figure (a real answer, or a test) for a model where it ran. Returns false when it was too small to count. */
  add(key: string, name: string, where: string, sample: Partial<Sample>, kind: 'answer' | 'test'): boolean {
    const s = cleanSample(sample);
    if (!s || !key) return false;
    if (kind === 'answer' && [...this.testing].some(k => key.startsWith(k))) return false;
    const t = (this.all[key] ??= { name, where, answers: [], tests: [] });
    t.name = name || t.name;
    t.where = where || t.where;
    if (kind === 'test') t.tests = [...t.tests, s].slice(-KEEP_TESTS);
    else t.answers = [...t.answers, s].slice(-KEEP_ANSWERS);
    this.saving = this.saving.then(() => writeAtomic(this.file, JSON.stringify(this.all))).catch(() => undefined);
    return true;
  }

  get(key: string): Summary | null {
    return summarise(this.all[key]);
  }

  /** The expected speed only (a row's "about 12 tokens a second"). */
  expect(key: string): number | null {
    return this.get(key)?.expect ?? null;
  }

  /** Waits for the last write (tests). */
  flush(): Promise<void> {
    return this.saving;
  }
}
