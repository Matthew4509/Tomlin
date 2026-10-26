// The speed finder (PLAN-2026-10-21-SPEED-FINDER.md): one chat model on one PC is started several ways, each timed
// with the same prompts, and the fastest setup that passes every check is recommended. Nothing is saved while it runs;
// the setup is saved only when "Go with this config" is pressed. The plain parts are here, tested in
// test/speedfinder.test.ts: which setups are tried (setupsFor), which one is recommended (recommend), whether a speed
// trick wrote the same words (sameWords) and how long a test takes (estimateMinutes). The run itself is in
// src/server/finder.ts.
import { guessersFor, type Listed } from './runset.ts';
import type { RunnerName } from './runtimes.ts';
import type { RunOptions } from './store.ts';

const GB = 2 ** 30;
const MB = 2 ** 20;

/** What the finder needs to know about the PC it runs on. */
export interface PcFacts {
  /**
   * Graphics cards chat can use here, with memory of their own (none: the CPU only), biggest first. Bytes. `ids`: each
   * runner's name for it (src/devices.ts), for card choice; none known: no card rows. `runners`: the card runners with
   * code for it (a CUDA build may have none for an older card); not known: every one.
   */
  cards: { name: string; total: number; free: number; ids?: string[]; runners?: RunnerName[] }[];
  /** Physical cores. */
  cores: number;
  /** The PC's chat threads now (0: llama.cpp's own choice). */
  threads: number;
  /** The chat models on this PC. */
  models: Listed[];
  /**
   * The card runners installed here for chat, in the order Auto tries them (CUDA needs an NVIDIA card; CUDA 12 and
   * CUDA 13 are two builds); none known: not tried.
   */
  runners?: RunnerName[];
}

/** What it needs to know about the model (sizes from its file, src/gguf.ts). */
export interface ModelFacts extends Listed {
  moe: boolean;
  layers: number;
  /** Bytes of expert weights a layer (0: dense, or not known). */
  expertsPerLayer: number;
  /** Bytes of everything else. */
  rest: number;
  /** Its context cache at the context it is set to. */
  ctxBytes: number;
  /** The smallest model of the same family on this PC, with its own cache at this context; null: none here. */
  guesser: (Listed & { ctxBytes: number }) | null;
  /** Its file has its own built-in guesser (an MTP head, src/gguf.ts). */
  mtp?: boolean;
}

/** Row a: the setup saved now, and what its start said. */
export interface NowFacts {
  run: RunOptions;
  /** Some layers or experts stayed in RAM (a card's start line said so); false when wholly on the card, or no card. */
  spilled: boolean;
  /** Bytes it held on the card. */
  cardBytes: number;
}

/** One try. `follows: 'sweep'`: its N of experts in RAM is the best sweep row's plus `plus`, set when the sweep is done. */
export interface Setup {
  id: string;
  name: string;
  why: string;
  run: RunOptions;
  /** Leaves little on the card on purpose: shown, never recommended unless it keeps 0.5 GB free. */
  tight?: boolean;
  /** A step of the expert sweep (0, 1, 2): a failed step ends the steps after it. */
  sweep?: number;
  follows?: 'sweep';
  plus?: number;
}

const WORKING = 512 * MB;
const DRAFT_WORKING = 0.3 * GB;
/** A guessing model's cache over this is given q8_0 (its own only; the big model's cache is left alone). */
const BIG_DRAFT_CACHE = 0.25 * GB;
const family = (name: string) => name.toLowerCase().split('-')[0];
const gbText = (n: number) => `${(Math.round((n / GB) * 10) / 10).toFixed(1)} GB`;

/**
 * The first N of `--n-cpu-moe` worth trying, worked out from the sizes: the card's room for experts is what row a held
 * plus what is free, less a 512 MB margin, the rest of the model, its cache and about 0.5 GB of working memory. Rounded
 * so more stays in RAM (the safe side). 0: no sweep (no card, a dense model, or the experts do not fit at all).
 */
export function firstSweep(pc: PcFacts, m: ModelFacts, now: NowFacts): number {
  const card = biggest(pc);
  if (!card || !m.moe || !m.expertsPerLayer || !m.layers) return 0;
  const room = card.free + now.cardBytes - 512 * MB - m.rest - m.ctxBytes - WORKING;
  const n = m.layers - Math.floor(Math.max(0, room) / m.expertsPerLayer);
  return n >= m.layers ? 0 : Math.max(1, n);
}

/** The guessing model's cache as the draft rows start it (q8_0 when large). */
const draftCacheBytes = (g: { ctxBytes: number }) => (g.ctxBytes > BIG_DRAFT_CACHE ? g.ctxBytes * (34 / 32 / 2) : g.ctxBytes);

/** Expert layers that make room on the card for the guessing model (its file, its cache, about 0.3 GB working). */
export function draftLayers(m: ModelFacts): number {
  if (!m.guesser || !m.expertsPerLayer) return 0;
  return Math.ceil((m.guesser.bytes + draftCacheBytes(m.guesser) + DRAFT_WORKING) / m.expertsPerLayer);
}

/** A smaller cache needs flash attention on, so "off" is dropped with it. */
const q8Run = ({ fa, ...r }: RunOptions): RunOptions => ({ ...r, cache: 'q8_0', ...(fa === 'on' ? { fa } : {}) });
const biggest = (pc: PcFacts) => [...pc.cards].sort((a, b) => b.total - a.total)[0] ?? null;

/**
 * The cards for planning again once the model is loaded: every card, with its runner names (the card rows need them),
 * and the biggest card's room as read now. No card read now: none, as before.
 */
export function cardsNow(cards: PcFacts['cards'], now: { name: string; total: number; free: number } | null): PcFacts['cards'] {
  if (!now) return [];
  const big = biggest({ cards } as PcFacts);
  return big ? cards.map(c => (c === big ? { ...c, free: now.free } : c)) : [now];
}

/**
 * The finder's cards: the runners' own list (src/devices.ts cardsOf, biggest first), each with its runner names and the
 * runners that have code for it, and the room read now (`now`: the card the bar reads, with its free memory) on the card
 * of that name, else on the biggest. Every card comes from the one list, so a card's name, size and runner names are one
 * card's (audit C8). No runner list yet: the card read now, without names; none read now: the CPU only.
 */
export function finderCards(known: { label: string; total: number; ids: string[] }[], now: { name: string; total: number; free: number } | null, runnersFor: (c: { label: string; total: number; ids: string[] }) => RunnerName[]): PcFacts['cards'] {
  if (!now) return [];
  if (!known.length) return [now];
  const cards = known.map(c => ({ name: c.label, total: c.total, free: c.total, ids: c.ids, runners: runnersFor(c) }));
  const same = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
  const read = cards.find(c => same(c.name, now.name)) ?? cards[0];
  read.free = Math.max(0, Math.min(read.total, read.total - (now.total - now.free)));
  return cards;
}

const RUNNER_NAME: Record<RunnerName, string> = { cuda: 'CUDA 12', cuda13: 'CUDA 13', vulkan: 'Vulkan' };

/** A setup in plain words. */
export function describeRun(run: RunOptions, names: (id: string) => string = id => id, cardNames: (ids: string[]) => string = ids => ids.join(' + ')): string {
  const where = run.place === 'card' ? 'every layer on the card' : run.place === 'ram' ? 'every expert in RAM' : run.place === 'layers' ? `the experts of ${run.moeCpu} layers in RAM` : 'Auto';
  return [
    where,
    run.fitMargin ? `${run.fitMargin} MB held back on the card` : '',
    `cache ${run.cache}`,
    run.fa ? `flash attention ${run.fa}` : '',
    run.threads ? `${run.threads} threads` : '',
    run.draft ? `guessing model ${names(run.draft)}${run.draftOn === 'ram' ? ' in RAM' : ''}` : run.spec === 'ngram' ? 'copy-ahead' : run.spec === 'mtp' ? 'built-in guesser (MTP)' : '',
    run.draftMax ? `guesses of up to ${run.draftMax} words` : '',
    run.runner ? `${RUNNER_NAME[run.runner]} runner` : '',
    run.cards?.length ? `only on the ${cardNames(run.cards)}` : '',
    run.draft && run.draftCard?.length ? `guessing model on the ${cardNames(run.draftCard)}` : '',
  ].filter(Boolean).join(', ');
}

/**
 * The tries for one model on one PC: row a (the setup saved now) first, then at most 3 (Quick) or 7 (Full), the most
 * likely gain first. A try that cannot change anything on that PC is left out; one Quick has no room for, or one that
 * needs a model not on that PC, is listed in `left` with why. The context is never changed, except for the sizes the
 * user ticked to test (`contexts`), added after the rest. q4_0 is never tried.
 */
export function setupsFor(pc: PcFacts, m: ModelFacts, now: NowFacts, size: 'quick' | 'full', contexts: number[] = []): { rows: Setup[]; left: { name: string; why: string }[] } {
  const r = now.run;
  const card = biggest(pc);
  const left: { name: string; why: string }[] = [];
  const cand: (Setup & { quick: boolean })[] = [];
  const add = (quick: boolean, s: Setup) => cand.push({ ...s, quick });
  const guesser = m.guesser && guessersFor(m, pc.models).includes(m.guesser.id) ? m.guesser : null;
  if (!r.draft && !guesser) left.push({ name: 'Guessing model', why: `needs a smaller ${family(m.name)} model on this PC (the finder never downloads one): not tried` });
  const draftRun = (extra: Partial<RunOptions>): RunOptions => ({ ...r, ...extra, draft: guesser!.id, ...(r.cache === 'f16' && guesser!.ctxBytes > BIG_DRAFT_CACHE ? { draftCache: 'q8_0' as const } : {}) });
  const threadRows = (quick: boolean, second: boolean) => {
    for (const t of second ? [pc.cores - 1] : [pc.cores]) {
      if (t >= 1 && t !== pc.threads && t !== r.threads) add(quick, { id: `threads-${t}`, name: `${t} thread${t === 1 ? '' : 's'}`, why: `${card ? 'Part of the model runs' : 'The model runs'} on the CPU: the number of threads can change its speed.`, run: { ...r, threads: t } });
    }
  };
  const fa = (quick: boolean, v: 'on' | 'off') => {
    if (card && r.cache === 'f16' && r.fa !== v) add(quick, { id: `fa-${v}`, name: `Flash attention ${v}`, why: 'Some cards are faster with it, some slower: measured, not guessed.', run: { ...r, fa: v } });
  };
  const ngram = (quick: boolean) => {
    if (!r.draft && r.spec !== 'ngram') add(quick, { id: 'ngram', name: 'Copy-ahead', why: 'Guesses from words already in the chat: helps when an answer repeats them (edits, quotes). No second model.', run: { ...r, spec: 'ngram' } });
  };
  const sweepN = firstSweep(pc, m, now);
  const sweep = (step: number, quick: boolean) => {
    const n = sweepN - 2 * step;
    if (sweepN && n >= 1) add(quick, { id: `layers-${n}`, name: `The experts of ${n} layers in RAM, the rest on the card`, why: 'More of the model on the card, worked out from its sizes and the card\'s free memory.', run: { ...r, place: 'layers', moeCpu: n }, sweep: step });
  };
  const margin = (quick: boolean, mb: 512 | 256) => {
    if (card && r.place === 'auto' && now.spilled && r.fitMargin !== mb) add(quick, { id: `margin-${mb}`, name: `Auto, ${mb} MB held back on the card`, why: 'llama.cpp keeps 1 GB of each card free on purpose; less held back fits more of the model.', run: { ...r, fitMargin: mb }, ...(mb === 256 ? { tight: true } : {}) });
  };

  if (!card) {
    threadRows(true, false);
    threadRows(true, true);
    ngram(true);
    if (guesser) add(false, { id: 'draft-ram', name: `Guessing model ${guesser.name}`, why: 'A small model of the same family guesses the next few words; this model checks them. The answer is its own.', run: draftRun({ draftOn: 'ram' }) });
  } else if (now.spilled && m.moe && sweepN) {
    // A mixture-of-experts model with experts left in RAM (section 2b): the card filled first, then the guessing model
    // beside it on the card (k expert layers pushed back to RAM to make room) or in RAM.
    const k = draftLayers(m);
    margin(true, 512);
    sweep(0, true);
    if (guesser) add(true, { id: 'draft-card', name: `Guessing model ${guesser.name} on the card`, why: `It takes card room of its own: the experts of ${k} more layers go to RAM to make room.`, run: draftRun({ place: 'layers', moeCpu: Math.min(m.layers, sweepN + k) }), follows: 'sweep', plus: k });
    margin(false, 256);
    sweep(1, false);
    if (guesser) add(false, { id: 'draft-ram', name: `Guessing model ${guesser.name} in RAM`, why: 'It runs on the CPU and takes no card room.', run: draftRun({ place: 'layers', moeCpu: sweepN, draftOn: 'ram' }), follows: 'sweep', plus: 0 });
    threadRows(!guesser, false);
    sweep(2, false);
    if (r.place !== 'ram') add(false, { id: 'experts-ram', name: 'Every expert in RAM, the rest on the card', why: 'Frees the card for the rest; sometimes as fast.', run: { ...r, place: 'ram' } });
    fa(false, 'on');
    ngram(false);
    threadRows(false, true);
    fa(false, 'off');
  } else if (now.spilled) {
    if (r.place !== 'card' && !m.moe) add(true, { id: 'card', name: 'Every layer on the card', why: 'Some layers stayed in RAM: this puts them all on the card (or fails if they do not fit).', run: { ...r, place: 'card' } });
    if (r.cache === 'f16') add(true, { id: 'q8', name: 'Smaller context cache (q8_0)', why: 'Frees card memory for more layers; answers stay as good (q4_0 is never tried).', run: q8Run(r) });
    threadRows(true, false);
    fa(false, 'on');
    fa(false, 'off');
    ngram(false);
    threadRows(false, true);
    margin(false, 512);
    if (guesser) add(false, { id: 'draft-card', name: `Guessing model ${guesser.name} on the card`, why: 'A small model of the same family guesses the next few words; this model checks them. The answer is its own.', run: draftRun({}) });
    if (guesser) add(false, { id: 'draft-ram', name: `Guessing model ${guesser.name} in RAM`, why: 'It runs on the CPU and takes no card room.', run: draftRun({ draftOn: 'ram' }) });
  } else {
    if (guesser) add(true, { id: 'draft-card', name: `Guessing model ${guesser.name}`, why: 'A small model of the same family guesses the next few words; this model checks them. The answer is its own.', run: draftRun({}) });
    fa(true, 'on');
    ngram(true);
    fa(false, 'off');
  }

  // The model's own built-in guesser (an MTP head): no second model and no card room of its own, so it is the likeliest
  // gain of the guessing tricks, tried first among them. A file without one says so (the runner would refuse it).
  const { draft: _d, draftOn: _o, draftCache: _c, draftCard: _k, spec: _s, draftMax: _m, ...plain } = r;
  if (m.mtp && r.spec !== 'mtp') {
    cand.unshift({ id: 'mtp', name: 'Built-in guesser (MTP)', why: 'This file carries its own guesser: it guesses the next few words from inside the model, which checks them. The answer is its own; no second model.', run: { ...plain, spec: 'mtp' }, quick: true });
  } else if (!m.mtp) left.push({ name: 'Built-in guesser (MTP)', why: 'this file has none: an MTP version of the same model may have one' });

  // Longer guesses: up to 8 words a time (llama.cpp's own is 3). A model that is often right ahead (code, a dense model
  // wholly on its card) can gain; one that is often wrong loses. With the guess in use now, or the likeliest one. Full only.
  const guessing = r.draft || r.spec === 'mtp' ? r : m.mtp ? { ...plain, spec: 'mtp' as const } : guesser ? draftRun({}) : null;
  if (guessing && !r.draftMax) add(false, { id: 'draft-long', name: 'Longer guesses (up to 8 words at a time)', why: 'Each guess runs further ahead: more words a pass when the guesses are right, more thrown away when they are not. Measured, not guessed.', run: { ...guessing, draftMax: 8 } });

  // Two cards or more (card choice, src/devices.ts): llama.cpp's Auto splits a model over every card, and a split model
  // waits for the slower card at every word. Tried first after the runner: the biggest card alone (or every card again,
  // when the model is held to some), and the guessing model on the second card, leaving the biggest to the model.
  const idsOf = (c: PcFacts['cards'][number] | undefined) => c?.ids ?? [];
  const second = [...pc.cards].sort((x, y) => y.total - x.total)[1];
  if (card && second && idsOf(card).length) {
    if (!r.cards?.length) cand.unshift({ id: 'cards-one', name: `Only the ${card.name}`, why: `This PC has ${pc.cards.length} cards: a model split over them waits for the slower one at every word. This keeps it on the biggest (what does not fit goes to RAM).`, run: { ...r, cards: idsOf(card) }, quick: true });
    else {
      const { cards: _held, ...every } = r;
      cand.unshift({ id: 'cards-all', name: 'Every card (Auto)', why: 'This model is held to some of the cards: spread over all of them, more of it may fit on a card.', run: every, quick: true });
    }
    // Placed straight after it (Full): with a second card, this is the guessing model's likeliest home.
    if (guesser && idsOf(second).length) cand.splice(1, 0, { quick: false, id: 'draft-second', name: `Guessing model ${guesser.name} on the ${second.name}`, why: 'The second card holds the guessing model, so the biggest card keeps all its room for this model.', run: draftRun({ cards: idsOf(card), draftCard: idsOf(second), draftOn: undefined }) });
  }

  // More than one card runner here (CUDA 12, CUDA 13 and Vulkan for an NVIDIA card): each other one, tried first, as
  // the runner can change both speeds either way (measured 21 Oct, GTX 1060, Qwen3.5 4B: Vulkan wrote 34 tok/s against
  // 30, CUDA read 54 against 40). The one in use is the model's own, else the first Auto tries.
  // A CUDA build is tried only on cards it has code for (each card's `runners`): on a mixed PC (a GTX 1060 and an RTX
  // 5080) CUDA 13 is tried on the RTX 5080 alone; a build with code for none of the cards the model uses is not tried.
  const inUse = r.runner && pc.runners?.includes(r.runner) ? r.runner : pc.runners?.[0];
  if (card && inUse && pc.runners && pc.runners.length > 1) {
    const using = r.cards?.length ? pc.cards.filter(c => c.ids?.some(id => r.cards!.includes(id))) : pc.cards;
    const names = (cs: PcFacts['cards']) => cs.map(c => c.name).join(' + ');
    const rows: (Setup & { quick: boolean })[] = [];
    for (const other of pc.runners.filter(x => x !== inUse)) {
      const can = using.filter(c => !c.runners || c.runners.includes(other));
      const cannot = using.filter(c => !can.includes(c));
      const name = `${RUNNER_NAME[other]} runner (instead of ${RUNNER_NAME[inUse]})`;
      const why = other === 'vulkan' || inUse === 'vulkan' ? 'This PC has more than one runner for its card: a model can write faster on one and read faster on the other.' : 'Two CUDA builds can run this card: the newer one may have code made for it, the older one is the one measured before.';
      if (!cannot.length) rows.push({ id: `runner-${other}`, name, why, run: { ...r, runner: other }, quick: true });
      else if (can.length && can.every(c => c.ids?.length)) rows.push({ id: `runner-${other}`, name: `${name}, only on the ${names(can)}`, why: `${why} It has no code for the ${names(cannot)}, so it is tried on the rest.`, run: { ...r, runner: other, cards: can.flatMap(c => c.ids!) }, quick: true });
      else left.push({ name: `${RUNNER_NAME[other]} runner`, why: `it has no code for the ${names(cannot)}: not tried` });
    }
    cand.unshift(...rows);
  }

  const limit = size === 'quick' ? 3 : 7;
  const picked = (size === 'quick' ? cand.filter(c => c.quick) : cand).slice(0, limit);
  for (const c of cand) if (!picked.includes(c)) left.push({ name: c.name, why: size === 'quick' && !c.quick ? 'tried in Full only' : size === 'quick' ? 'Quick tries the 3 most likely: tried in Full' : 'no room in Full (8 rows at most)' });
  const cardNames = (ids: string[]) => pc.cards.filter(c => c.ids?.some(id => ids.includes(id))).map(c => c.name).join(' + ') || 'chosen cards';
  // A runner saved for the model that this PC cannot use (CUDA 13 on a Pascal card) is not what it starts on: said so.
  const off = r.runner && pc.runners && !pc.runners.includes(r.runner) ? r.runner : undefined;
  const a: Setup = { id: 'a', name: `Now: ${describeRun(off ? { ...r, runner: undefined } : r, undefined, cardNames)}${off ? ` (set to the ${RUNNER_NAME[off]} runner, which cannot run here: Auto's runner is used)` : ''}`, why: 'The setup in use now: the yardstick.', run: r };
  const rows: Setup[] = [a, ...picked.map(({ quick: _q, ...s }) => s)];
  for (const n of [...new Set(contexts)]) {
    if (n !== r.ctx) rows.push({ id: `ctx-${n}`, name: `Context ${n.toLocaleString('en')} tokens`, why: 'You ticked this size to test.', run: { ...r, ctx: n } });
  }
  return { rows, left };
}

// ---- Which row is recommended ----

/** A row's figures, as the run measured them. */
export interface Result {
  id: string;
  /** Loaded and answered every run (not failed, not stopped). */
  ok: boolean;
  /** Writing speed (median), reading speed, tokens a second. */
  write: number | null;
  read: number | null;
  /** Card memory left free after the answers (null: no card). */
  cardFree: number | null;
  /** The driver spilled the card into shared memory. */
  spilled: boolean;
  ramFit: 'ok' | 'tight' | 'no';
  /** Same words as without the trick (null: not a speed trick). */
  sameWords: boolean | null;
  cache: string;
  /** How many things differ from row a (0 for row a). */
  changes: number;
}

export const KEEP_TEXT = 'Keep what you have: nothing tried was clearly faster.';

/**
 * The recommended row: the fastest that passes every check. Within 5% is a tie (the noise between runs): the faster
 * reader wins, then the one with more card left free, then the one closest to row a. Row a stays recommended unless
 * another beats it by more than 5%. `why` says, for each row that cannot be recommended, why not.
 */
export function recommend(rows: Result[]): { best: string; keep: boolean; why: Record<string, string> } {
  const a = rows.find(r => r.id === 'a');
  const why: Record<string, string> = {};
  const fault = (r: Result): string => {
    if (!r.ok || r.write === null) return 'did not finish every answer';
    if (r.cache === 'q4_0') return 'uses a q4_0 cache (it costs answer quality)';
    if (r.cardFree !== null && r.cardFree < 0.5 * GB) return `leaves only ${gbText(r.cardFree)} of the card free: may fail when another program uses the card`;
    if (r.spilled) return 'spilled over the card into shared memory (slower, and can stall)';
    if (r.ramFit !== 'ok') return 'leaves too little RAM free for the rest of the PC';
    if (r.sameWords === false) return 'wrote different words from the same setup without the trick';
    if (a && r.id !== 'a' && a.read && r.read !== null && r.read < a.read / 2) return 'reads at under half the speed of what you have now (long documents would wait for it)';
    return '';
  };
  const valid = rows.filter(r => {
    const f = fault(r);
    if (f) why[r.id] = f;
    return !f;
  });
  if (!valid.length) return { best: 'a', keep: true, why };
  const top = Math.max(...valid.map(r => r.write!));
  const tied = valid.filter(r => r.write! >= top * 0.95).sort((x, y) => (y.read ?? 0) - (x.read ?? 0) || (y.cardFree ?? 0) - (x.cardFree ?? 0) || x.changes - y.changes);
  const winner = tied[0];
  if (a && winner.id !== 'a' && !fault(a) && winner.write! <= a.write! * 1.05) {
    why[winner.id] = 'within 5% of what you have now (the noise between runs)';
    return { best: 'a', keep: true, why };
  }
  return { best: winner.id, keep: winner.id === 'a', why };
}

// ---- Same words ----

/** At temperature 0 a speed trick should write what the same setup writes without it: the first 100 words equal, 90% overall. */
export function sameWords(a: string, b: string): boolean {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  const n = Math.min(100, x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  const most = Math.max(x.length, y.length);
  if (!most) return true;
  let same = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] === y[i]) same++;
  return same / most >= 0.9;
}

// ---- How long ----

/** The prompts' sizes (src/finderrun.ts): warm-up, the write prompt run twice, the read prompt and its copy, the code prompt. */
export const TOKENS = { warm: 32, write: 220, read: 800, copy: 150, code: 220 };

/**
 * Minutes a test of `rows` rows takes, from this PC's own figures for the model (load seconds, writing and reading
 * speed; 0 when not known yet), plus the one load from disk at the start.
 */
export function estimateMinutes(rows: number, f: { loadSeconds: number; write: number; read: number; bytes: number }): number {
  const disk = f.bytes / (150 * MB);
  const load = f.loadSeconds || disk + 4;
  const write = f.write || 10;
  const read = f.read || 50;
  const perRow = load + (TOKENS.warm + 2 * TOKENS.write + TOKENS.copy + TOKENS.code) / write + TOKENS.read / read + 10;
  return Math.max(1, Math.ceil((rows * perRow + disk) / 60));
}
