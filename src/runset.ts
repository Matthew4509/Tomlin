// Run settings a linked PC may change on a node (2.0.56): the Guessing model of one of the node's chat models. The
// node's owner ticks "Allow host to test and change model run settings" there first (off until ticked). The host sends
// model ids from the node's own list, never flags or file paths; the node checks them against its own models and keeps
// the setting in its own settings, as if set at its own screen. The doors are in src/jobrun/node.ts (/worker/run-set)
// and src/jobrun/copies.ts (runSetOn); tested in test/runset.test.ts and test/runseton.test.ts.

import type { RunOptions } from './store.ts';
import { cleanCardIds } from './devices.ts';
import { isHeldRunner, pinOfRunner, type HeldRunner, type RuntimePin } from './runtimes.ts';

export const TUNE_TICK ='Allow host to test and change model run settings';

export interface Listed {
  id: string;
  name: string;
  bytes: number;
  /** Its file has its own guesser (an MTP head, src/gguf.ts); unset when not known. */
  mtp?: boolean;
  /** Its words list, as src/gguf.ts reads it (ModelShape.vocab); unset when not known. */
  vocab?: string;
}

const OLLAMA = 'ollama:';
/** A model's family from its name ("Qwen3.5-35B-A3B-Q4_K_M" is qwen3.5): what is used when a words list is not known. */
const family = (name: string) => name.toLowerCase().split('-')[0];

/**
 * Two words lists as llama.cpp compares a guesser with its model: the same tokenizer kind and start and end words, at
 * most 128 words apart in size, and the same words in the window hashed (src/gguf.ts).
 */
export function sameWordsList(a: string, b: string): boolean {
  const [ka, na, sa, ea, ha] = a.split('|');
  const [kb, nb, sb, eb, hb] = b.split('|');
  return !!ha && ka === kb && sa === sb && ea === eb && ha === hb && Math.abs(Number(na) - Number(nb)) <= 128;
}

/** Whether `x` can guess for `m`: their words lists match when both are known, else their families by name. */
const canGuessFor = (x: Listed, m: Listed) => (x.vocab && m.vocab ? sameWordsList(x.vocab, m.vocab) : family(x.name) === family(m.name));

/**
 * The models that may guess for `m`: another chat model on that PC with the same words list (by name, the same
 * family, when the lists are not known), at most half its size, in the list's order. Ollama's models are run by
 * Ollama, not by this PC's runner: they neither guess nor have a guesser.
 */
export function guessersFor(m: Listed, list: Listed[]): string[] {
  if (m.id.startsWith(OLLAMA)) return [];
  return list.filter(x => x.id !== m.id && !x.id.startsWith(OLLAMA) && canGuessFor(x, m) && x.bytes < m.bytes / 2).map(x => x.id);
}

const DEFAULT = { ctx: 8192, cache: 'f16', place: 'auto' } as const;

/**
 * The context a model starts with when nobody chose one: the largest of 32,768 and 16,384 that the model was trained for
 * and that `fitsAt` says fits with room to spare, else 8,192. At 8,192 an answer stops at 2,048 word-pieces, mid-file.
 */
export function pickRoomyCtx(trained: number, fitsAt: (ctx: number) => boolean): number {
  for (const n of [32768, 16384]) if (n <= trained && fitsAt(n)) return n;
  return DEFAULT.ctx;
}

/**
 * The run of a model loaded with the linked PCs' memory (Max mode, a cluster): when nobody chose a context and the model
 * does not fit this PC alone, the roomy context is worked out counting what they lend. Anything else is left as it is.
 */
export function withLendersRoomy<R extends { ctx: number }>(run: R, saved: unknown, o: { lentBytes: number; fitsAlone: () => boolean; roomy: () => number }): R {
  if ((saved as { ctx?: unknown } | null | undefined)?.ctx !== undefined || run.ctx !== DEFAULT.ctx || o.lentBytes <= 0 || o.fitsAlone()) return run;
  return { ...run, ctx: o.roomy() };
}

/**
 * A model's run settings as saved or sent, kept only as known values (src/store.ts RunOptions): anything else is
 * dropped, never kept as raw flags. `id` is the model they are for, `list` this PC's chat models, `contexts` the sizes
 * offered. Saved before F8, cpuMoe: true is the experts in RAM.
 */
export function cleanRunWith(raw: unknown, id: string, list: Listed[], contexts: number[]): RunOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const whole = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : 0);
  const ctx = contexts.includes(Number(r.ctx)) ? Number(r.ctx) : DEFAULT.ctx;
  const cache = r.cache === 'q8_0' || r.cache === 'q4_0' ? r.cache : 'f16';
  const moeCpu = whole(r.moeCpu, 1, 999);
  let place: RunOptions['place'] = r.place === 'card' || r.place === 'ram' || r.place === 'auto' ? r.place : r.place === 'layers' && moeCpu ? 'layers' : r.cpuMoe === true ? 'ram' : 'auto';
  if (place === 'layers' && !moeCpu) place = 'auto';
  const model = list.find(m => m.id === id);
  const draft = typeof r.draft === 'string' && r.draft && model && guessersFor(model, list).includes(r.draft) ? r.draft : '';
  const threads = whole(r.threads, 1, 256);
  const builtIn = r.spec === 'mtp' && !!model?.mtp && !draft;
  // Longer guesses only where something guesses (a guessing model or the built-in guesser).
  const draftMax = draft || builtIn ? whole(r.draftMax, 2, 16) : 0;
  const cards = cleanCardIds(r.cards);
  const draftCard = draft && r.draftOn !== 'ram' ? cleanCardIds(r.draftCard) : [];
  const f = (r.found && typeof r.found === 'object' ? r.found : null) as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
  const str = (v: unknown, n: number) => (typeof v === 'string' && v.length <= n && !/[\u0000-\u001f<>]/.test(v) ? v : null);
  const found = f && str(f.at, 40) && !Number.isNaN(Date.parse(String(f.at))) && str(f.build, 40) !== null && str(f.runner, 20) !== null && str(f.card, 120) !== null && num(f.write) !== null && num(f.read) !== null
    ? { at: String(f.at), build: String(f.build), runner: String(f.runner), card: String(f.card), write: num(f.write)!, read: num(f.read)! }
    : null;
  return {
    ctx,
    cache,
    place,
    ...(place === 'layers' ? { moeCpu } : {}),
    ...(r.fitMargin === 256 || r.fitMargin === 512 ? { fitMargin: r.fitMargin } : {}),
    ...(r.fa === 'on' || (r.fa === 'off' && cache === 'f16') ? { fa: r.fa } : {}),
    ...(threads ? { threads } : {}),
    // One guessing method at a time: the built-in guesser only for a file with one, and never beside a guessing model.
    ...(r.spec === 'ngram' ? { spec: 'ngram' as const } : builtIn ? { spec: 'mtp' as const } : {}),
    ...(draftMax ? { draftMax } : {}),
    ...(draft ? { draft, ...(r.draftOn === 'ram' ? { draftOn: 'ram' as const } : {}), ...(r.draftCache === 'q8_0' ? { draftCache: 'q8_0' as const } : {}) } : {}),
    ...(isHeldRunner(r.runner) ? { runner: r.runner } : {}),
    ...(cards.length ? { cards } : {}),
    ...(draftCard.length ? { draftCard } : {}),
    // Automatic fallback after a crash: only ever true, set by a yes in the crash notice.
    ...(r.fallback === true ? { fallback: true as const } : {}),
    ...(found ? { found } : {}),
  };
}

/**
 * The devices a model starts on, best first: only its own card runner when it has one saved and that runner is in the
 * list (installed, and the PC not set to CPU); otherwise the PC's own list (Auto), so a removed runner never fails a start.
 */
export function devicesForRun<D extends string>(devices: D[], runner: string | undefined): D[] {
  return runner && devices.includes(runner as D) ? [runner as D] : devices;
}

/** The guessing model a host may ask for that means the model's own built-in guesser (an MTP head). */
export const BUILT_IN = 'mtp';

/**
 * What a host asked, checked against this PC's chat models: the model and its guessing model ('' = none, BUILT_IN = its
 * own built-in guesser, only for a file that has one), or why not.
 */
export function runSetAsk(b: Record<string, unknown>, list: Listed[]): { model: Listed; draft: string } | { status: number; error: string } {
  if (typeof b.model !== 'string' || !b.model || typeof b.draft !== 'string') return { status: 400, error: 'Say which model and which guessing model (or none).' };
  const model = list.find(m => m.id === b.model);
  if (!model) return { status: 404, error: `${b.model.slice(0, 120)} is not on this PC (deleted or moved?).` };
  if (model.id.startsWith(OLLAMA)) return { status: 400, error: `${model.name} is run by Ollama here, so it cannot have a guessing model.` };
  if (b.draft === BUILT_IN) return model.mtp ? { model, draft: BUILT_IN } : { status: 400, error: `${model.name}'s file has no built-in guesser here (an MTP version of the model may).` };
  if (b.draft && !guessersFor(model, list).includes(b.draft)) return { status: 400, error: `A guessing model for ${model.name} must be a smaller model of the same family on this PC (at most half its size).` };
  return { model, draft: b.draft };
}

/**
 * A host's ask to hold one of this PC's models to a runner (the crash notice's "Use this runner"), checked against this
 * PC's own models and pins: '' is Auto; otherwise a chat card runner this PC pins, has unpacked and can use (`why` says
 * why not, '' when it can). Only ids cross: never a path or a flag.
 */
export function runnerSetAsk(b: Record<string, unknown>, list: Listed[], pins: Record<string, RuntimePin>, installed: (id: string) => boolean, why: (id: string) => string): { model: Listed; runner: HeldRunner | '' | null; fallback?: boolean } | { status: number; error: string } {
  // `fallback` (true or false) alone turns the automatic fallback on or off and leaves the runner as it is (null).
  const fallback = typeof b.fallback === 'boolean' ? { fallback: b.fallback } : {};
  if (typeof b.model === 'string' && b.model && b.runner === undefined && 'fallback' in fallback) {
    const m = list.find(x => x.id === b.model);
    if (!m) return { status: 404, error: `${b.model.slice(0, 120)} is not on this PC (deleted or moved?).` };
    return { model: m, runner: null, ...fallback };
  }
  if (typeof b.model !== 'string' || !b.model || typeof b.runner !== 'string') return { status: 400, error: 'Say which model and which runner (or Auto).' };
  const model = list.find(m => m.id === b.model);
  if (!model) return { status: 404, error: `${b.model.slice(0, 120)} is not on this PC (deleted or moved?).` };
  if (model.id.startsWith(OLLAMA)) return { status: 400, error: `${model.name} is run by Ollama here, so TOMLIN's runners do not run it.` };
  if (!b.runner) return { model, runner: '', ...fallback };
  const pin = isHeldRunner(b.runner) ? pinOfRunner(b.runner) : '';
  const p = pins[pin];
  if (!pin || !p || p.engine !== 'llama' || p.device === 'cpu') return { status: 400, error: `${b.runner.slice(0, 40)} is not a card runner this PC pins: update TOMLIN there to get it.` };
  if (!installed(pin)) return { status: 409, error: `${p.name} is not installed on this PC yet. Install it first (Models, Model runners), then choose it.` };
  const no = why(pin);
  if (no) return { status: 409, error: no };
  return { model, runner: pin as HeldRunner, ...fallback };
}

/** The node's answer when its owner has not ticked it: where to tick it. */
export const tuneRefused = (pcName: string) => `"${pcName}" does not let linked PCs change how its models run. Its owner can tick "${TUNE_TICK}" there, under Network, Sharing permissions.`;

/**
 * Why this PC cannot ask that linked PC now ('' when it can). The tick is not checked here: the node checks its own and
 * says why in its own words.
 */
export function tuneWhy(pc: { name: string; ok: boolean; away: string | null; can: string[] }): string {
  if (!pc.ok) return `"${pc.name}" is off or not answering now`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.can.includes('tune')) return `"${pc.name}" runs an older TOMLIN that cannot change how its models run from here: update it there first`;
  return '';
}
