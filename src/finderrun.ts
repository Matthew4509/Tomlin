// The speed finder's run (src/speedfinder.ts has its rules): each try is loaded with its setup in memory only (nothing
// is saved), warmed, timed with the same prompts, and at the end, after Stop or after a fault, the PC is put back as
// it was. The loading, asking and measuring are passed in (src/server/finder.ts on a real PC; a stand-in in
// test/finderrun.test.ts).
import { recommend, sameWords, TOKENS, type Result, type Setup } from './speedfinder.ts';
import type { RunOptions } from './store.ts';

const GB = 2 ** 30;

export interface FinderDeps {
  /** Loads the model with this setup (not saved). Seconds to load, or the runner's own words why not. */
  load: (run: RunOptions) => Promise<{ seconds: number } | { error: string }>;
  /** One answer to a fixed prompt, with llama-server's own timings. */
  ask: (kind: 'warm' | 'write' | 'read') => Promise<{ text: string; write: number; read: number; firstWord: number; accepted: number | null }>;
  /** What the runner holds now; cardFree null without a card. */
  memory: () => Promise<{ cardBytes: number; ramBytes: number; borrowed: number; cardFree: number | null }>;
  ramFit: (run: RunOptions) => 'ok' | 'tight' | 'no';
  /** The model as it was before the test: loaded again with its saved setup if it was loaded, else let go. */
  putBack: () => Promise<void>;
}

export interface RowRun extends Setup {
  state: 'waiting' | 'running' | 'done' | 'failed' | 'not tried';
  why: string;
  write: number | null;
  read: number | null;
  copy: number | null;
  firstWord: number | null;
  loadSeconds: number | null;
  cardBytes: number | null;
  ramBytes: number | null;
  borrowed: number | null;
  cardFree: number | null;
  accepted: number | null;
  sameWords: boolean | null;
  spilled: boolean;
  ramFit: 'ok' | 'tight' | 'no';
  /** Loaded much slower than row a: read from disk, so its figure may be low. */
  slowLoad: boolean;
}

export interface FinderRun {
  state: 'running' | 'done' | 'stopped' | 'failed';
  said: string;
  now: string;
  rows: RowRun[];
  best: string | null;
  keep: boolean;
  why: Record<string, string>;
  /** Full: row a measured again at the end moved more than 10% (something else was running?). */
  drift: boolean;
}

export const LIMIT_MS = 45 * 60_000;

/** The write prompt: new text (src/speed.ts TEST_PROMPT is the same kind; this one is fixed here so rows compare). */
export const WRITE_PROMPT = 'Write about 150 words on why people bake their own bread at home. Plain sentences, no lists, no headings.';

/** The read prompt: a passage TOMLIN wrote itself (about 800 tokens), then a copy with one word changed. */
export const READ_PROMPT = `Read this passage, then do what the last line asks.

Marsh Lane Hardware has been the shop at the corner of Marsh Lane and Station Road for forty-one years. The shop opens at half past seven on weekdays, because the builders who work on the new houses past the river like to collect nails, screws and sandpaper before their day starts. On Saturdays the shop opens at eight and closes at one, and the owner says the morning rush on a Saturday is the busiest three hours of the week. Inside, the shop is long and narrow, with a counter at the back and shelves on both walls that reach almost to the ceiling. A ladder on wheels runs along the left wall, and only the staff are allowed to climb it.

The shop sells more than tools. There are paint tins in every colour the supplier makes, garden hoses, light bulbs, mouse traps, extension leads, bird seed and a small rack of seeds for vegetables that sells out every spring. Customers often say that if the shop does not stock something, it probably does not exist. That is not quite true, but the owner keeps a notebook behind the counter where people can write down what they could not find, and every month she reads it and orders the things that appear more than twice.

Three people work in the shop. The owner, Ruth, started as a Saturday helper when she was fifteen and bought the business from the man who trained her. Her nephew Daniel works the mornings and handles deliveries in a white van that has the name of the shop painted on both doors. The third member of staff, a retired carpenter called Owen, comes in three afternoons a week. He cuts timber to size on an old saw in the yard behind the shop, and he gives free advice to anyone who asks how to hang a door or fix a dripping tap. Some customers come in only to talk to him.

The shop has changed in small ways over the years. A card machine sits beside the old till, which still works and is kept for the days when the network fails. The shop has a website with its opening hours and a telephone number, but nothing can be ordered online, and Ruth says that is on purpose: people should see a hinge before they buy it. In winter the shop sells firewood and grit for icy paths, and in summer it sells deck chairs and barbecue charcoal. Each change of season means a weekend of moving shelves.

Other shops on the street have closed. The bakery became a phone repair counter, and the bank became a coffee house. Ruth thinks the hardware shop survives because it does something a warehouse cannot: it sells one screw if one screw is all you need, and someone will tell you which one. The council gave the shop a small award last year for serving the town, and the certificate hangs above the counter beside a photograph of the shop on its first day, with its first owner standing in the doorway in a brown coat.

Next year the lease comes up for renewal. The landlord has said he wants to keep the shop, and Ruth has plans to repaint the front in dark green and to fix the sign, which has been missing a letter since a storm two winters ago. Daniel wants to add a shelf of small electrical parts for people who repair their own radios and lamps. Owen says he will keep coming in as long as his knees allow, and that the saw in the yard will outlast all of them.

Copy the first paragraph back with every "shop" changed to "store". Write nothing else.`;

/** The body every row is sent: the same prompt, temperature 0 and a fixed seed, thinking off, the prompt read again each time. */
export function request(kind: 'warm' | 'write' | 'read') {
  return {
    messages: [{ role: 'user', content: kind === 'read' ? READ_PROMPT : WRITE_PROMPT }],
    max_tokens: kind === 'warm' ? TOKENS.warm : kind === 'write' ? TOKENS.write : TOKENS.copy,
    temperature: 0,
    seed: 42,
    cache_prompt: false,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

/** llama-server's answer and timings: the text, writing and reading speed, seconds to the first word, guesses kept. */
export function timingsOf(json: unknown): { text: string; write: number; read: number; firstWord: number; accepted: number | null } {
  const j = (json && typeof json === 'object' ? json : {}) as { choices?: { message?: { content?: unknown } }[]; timings?: Record<string, unknown> };
  const t = j.timings ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const drafted = n(t.draft_n);
  return {
    text: String(j.choices?.[0]?.message?.content ?? ''),
    write: Math.round(n(t.predicted_per_second) * 10) / 10,
    read: Math.round(n(t.prompt_per_second) * 10) / 10,
    firstWord: Math.round(n(t.prompt_ms) / 100) / 10,
    accepted: drafted ? Math.round((n(t.draft_n_accepted) / drafted) * 100) / 100 : null,
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** How many settings differ from row a's. */
const changes = (a: RunOptions, b: RunOptions) => new Set([...Object.keys(a), ...Object.keys(b)].filter(k => k !== 'found' && JSON.stringify((a as unknown as Record<string, unknown>)[k]) !== JSON.stringify((b as unknown as Record<string, unknown>)[k]))).size;
const trick = (r: RunOptions) => !!r.draft || r.spec === 'ngram';

/**
 * Runs the rows (row a first). `plan`, when given, picks the rows again once the model is loaded as it is now (its
 * start read: what it holds on the card), in place of `rows`. `stopped` is asked between steps; `again` (Full) measures row a once more at the end;
 * `onChange` is told after each step. Never throws: a fault ends the run as failed, with the PC put back.
 */
export async function runFinder(o: { rows: Setup[]; plan?: (mem: { cardBytes: number; ramBytes: number; borrowed: number; cardFree: number | null }) => Setup[]; deps: FinderDeps; stopped?: () => boolean; again?: boolean; clock?: () => number; onChange?: (run: FinderRun) => void }): Promise<FinderRun> {
  const clock = o.clock ?? Date.now;
  const start = clock();
  const d = o.deps;
  const blank = { why: '', write: null, read: null, copy: null, firstWord: null, loadSeconds: null, cardBytes: null, ramBytes: null, borrowed: null, cardFree: null, accepted: null, sameWords: null, spilled: false, ramFit: 'ok' as const, slowLoad: false };
  const run: FinderRun = { state: 'running', said: '', now: 'Loading the model once, to read its file into memory…', rows: o.rows.map(s => ({ ...s, ...blank, why: '', state: 'waiting' })), best: null, keep: false, why: {}, drift: false };
  const tell = () => o.onChange?.(run);
  const stopped = () => o.stopped?.() === true;
  let a = run.rows[0];
  let aText = '';

  const measure = async (row: RowRun): Promise<void> => {
    row.state = 'running';
    run.now = `Loading: ${row.name}…`;
    tell();
    const l = await d.load(row.run);
    if ('error' in l) {
      row.state = 'failed';
      row.why = l.error;
      return;
    }
    row.loadSeconds = l.seconds;
    if (row !== a && a.loadSeconds && l.seconds > a.loadSeconds * 2) row.slowLoad = true;
    run.now = `Measuring: ${row.name}…`;
    tell();
    await d.ask('warm');
    const first = await d.ask('write');
    const second = await d.ask('write');
    const writes = [first.write, second.write];
    if (Math.abs(first.write - second.write) > 0.1 * Math.max(first.write, second.write)) writes.push((await d.ask('write')).write);
    const read = await d.ask('read');
    const mem = await d.memory();
    Object.assign(row, { write: median(writes), read: read.read, copy: read.write, firstWord: first.firstWord, accepted: first.accepted ?? read.accepted, cardBytes: mem.cardBytes, ramBytes: mem.ramBytes, borrowed: mem.borrowed, cardFree: mem.cardFree, ramFit: d.ramFit(row.run) });
    if (row === a) aText = first.text;
    else {
      if (trick(row.run) && aText) row.sameWords = sameWords(aText, first.text);
      if (a.borrowed !== null && mem.borrowed > a.borrowed + 0.3 * GB) row.spilled = true;
    }
    row.state = 'done';
  };

  try {
    // The file read into memory once, so no row pays for reading it from disk.
    const warm = await d.load(a.run);
    if ('error' in warm) throw new Error(warm.error);
    await d.ask('warm');
    if (o.plan) {
      const planned = o.plan(await d.memory());
      run.rows = planned.map(s => ({ ...s, ...blank, why: '', state: 'waiting' }));
      tell();
    }
    a = run.rows[0];
    for (const row of run.rows) {
      if (stopped()) {
        row.state = 'not tried';
        row.why = 'Stopped before this one.';
        continue;
      }
      if (clock() - start >= LIMIT_MS) {
        row.state = 'not tried';
        row.why = 'Not tried (time limit: 45 minutes).';
        continue;
      }
      // A sweep step after one that failed (or left the card too full) would only fail harder.
      if (row.sweep !== undefined && row.sweep > 0) {
        const before = run.rows.find(r => r.sweep === row.sweep! - 1);
        if (before && (before.state !== 'done' || (before.cardFree !== null && before.cardFree < 0.5 * GB))) {
          row.state = 'not tried';
          row.why = 'Not tried: the step before did not fit on the card.';
          continue;
        }
      }
      // A row that follows the sweep takes the best step's N (fastest that loaded), plus its own.
      if (row.follows === 'sweep') {
        const best = run.rows.filter(r => r.sweep !== undefined && r.state === 'done' && r.write).sort((x, y) => y.write! - x.write!)[0];
        if (best?.run.moeCpu) row.run = { ...row.run, moeCpu: best.run.moeCpu + (row.plus ?? 0) };
      }
      await measure(row);
      tell();
    }
    if (o.again && !stopped() && a.state === 'done' && clock() - start < LIMIT_MS) {
      run.now = 'Measuring what you have once more…';
      tell();
      const again: RowRun = { ...a, ...blank, state: 'waiting' };
      const l = await d.load(a.run);
      if (!('error' in l)) {
        await d.ask('warm');
        const w = median([(await d.ask('write')).write, (await d.ask('write')).write]);
        again.write = w;
        if (a.write && Math.abs(w - a.write) > 0.1 * a.write) run.drift = true;
      }
    }
    run.state = stopped() ? 'stopped' : 'done';
  } catch (e) {
    // Stop cuts off the answer being timed: that is a stop, not a fault.
    run.state = stopped() ? 'stopped' : 'failed';
    if (run.state === 'failed') run.said = `The test stopped: ${(e as Error).message}`;
    for (const r of run.rows) if (r.state === 'waiting' || r.state === 'running') {
      r.state = 'not tried';
      r.why = run.state === 'stopped' ? 'Stopped before this one finished.' : 'Not tried: the test stopped.';
    }
  }
  run.now = 'Putting it back as it was…';
  tell();
  try {
    await d.putBack();
  } catch (e) {
    run.said = `${run.said ? `${run.said} ` : ''}It could not be loaded again as it was: ${(e as Error).message}`;
  }
  const results: Result[] = run.rows.map(r => ({ id: r.id, ok: r.state === 'done', write: r.write, read: r.read, cardFree: r.cardFree, spilled: r.spilled, ramFit: r.ramFit, sameWords: r.sameWords, cache: r.run.cache, changes: changes(a.run, r.run) }));
  const rec = recommend(results);
  // Row a not measured (the test stopped before it): nothing to compare with, so nothing is recommended.
  const measured = run.rows[0]?.state === 'done';
  Object.assign(run, { best: measured ? rec.best : null, keep: measured && rec.keep, why: rec.why, now: '' });
  tell();
  return run;
}
