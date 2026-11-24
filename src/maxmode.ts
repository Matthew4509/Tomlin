// Max mode, the chat's switch (beside Web in the chat box): for a model that FITS on this PC alone, it borrows from the
// linked PCs to try to raise the tokens a second. Cluster is for a model that will NOT fit on one PC: it borrows so the
// model can run at all, and it is not changed by this switch. src/cluster/engine.ts fitsOnePc says which of the two a
// model is; the automatic borrowing (borrowRule, switch off) also lends a card to a dense model that fits this PC's RAM but
// not its card, and Max mode never takes that away (maxRoute below: a load Max mode does not take goes that way).
//
// What was measured (docs/PLAN-2026-11-16-MAX-MODE-CHAT-OPTION.md): every layer split of a mixture-of-experts model, or of
// one that fits the PC's card, was slower than that PC alone (the PCs take turns), so Max mode never uses the layer split
// itself. (A dense 24B too big for one card ran faster with a lent card, 12.2 against 4.2: the automatic borrowing.)
// Expert parallel (the Cluster code, src/jobrun/epload.ts) is the only engine that has beaten the layer split; whether it
// beats one PC alone for a model that fits has not been measured. So the first Max load of a model on a set of PCs is the
// measurement, and from then on the speeds kept here decide: Max is used again only while its measured speed beats this
// PC alone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pickBuild, type Member as BuildMember, type Option } from './runnermatch.ts';
import type { RunnerLook } from './runners.ts';

export { fitsOnePc } from './cluster/engine.ts';

/** The switch's tooltip: the definition in one sentence, and that nothing about its speed is measured yet. */
export const MAX_TIP = 'Max mode is for a model that fits on this PC alone: it borrows from your linked PCs to try to raise the tokens a second (built, not yet measured on two PCs). Cluster is for a model too big for one PC: it lets it run at all.';

/** Said when the model picked does not fit this PC alone (the switch is greyed with it). */
export const CLUSTER_RUNS_IT = 'This model does not fit one PC: Cluster runs it';

/** A linked PC as the gate reads it: its name and its last hello (null: it is not answering). */
export interface GatePc {
  id: string;
  name: string;
  hello: { can: string[]; allow?: { lend?: boolean } | null } | null;
  /** What its hello says it can run (src/jobrun/maxhost.ts optionsOf); null when it says nothing (an older TOMLIN). */
  options: Option[] | null;
  no?: Record<string, string>;
}

export interface Gate {
  /** Why Max mode cannot run now, in plain words ('' when it can). */
  why: string;
  /** The PCs that would lend (names and ids, same order) and the build they share; empty when `why` is set. */
  names: string[];
  ids: string[];
  build: string;
}

const quoted = (names: string[]) => (names.length < 2 ? names.map(n => `"${n}"`).join('') : `${names.slice(0, -1).map(n => `"${n}"`).join(', ')} and "${names[names.length - 1]}"`);

/**
 * Whether Max mode can run now, and why not. `pcs`: the linked PCs Max mode may borrow from (src/jobrun/maxhost.ts
 * maxCandidates); `linked`: how many PCs are linked at all; `clusterOff`: a cluster is saved and switched off; `host`: the
 * runners this PC can use (src/server/panes.ts runnerOptions). In order: none to borrow from, none on, none allowing it,
 * none with Max mode, no shared llama.cpp build (the PC that blocks is named).
 */
export function maxGate(o: { pcs: GatePc[]; linked: number; clusterOff?: boolean; clusterOut?: boolean; host: Option[] }): Gate {
  const no = (why: string): Gate => ({ why, names: [], ids: [], build: '' });
  if (!o.pcs.length) {
    if (o.clusterOut) return no('This PC stays out of the cluster saved here ("This PC takes part" is off on the Cluster page), so it borrows from no PC: the PC that loads the model for the cluster does the borrowing');
    if (o.clusterOff) return no('The cluster saved here is switched off (Network), and Max mode borrows its members: switch it on first');
    if (o.linked > 0) return no('Every linked PC is set to "Don\'t borrow from it" or Backups only here (Network, Linked PCs)');
    return no('No linked PC to borrow from: link one under Network, and tick "Allow to be used as part of a cluster" on it');
  }
  const on = o.pcs.filter(p => p.hello);
  if (!on.length) return no(`No linked PC is on now (${quoted(o.pcs.map(p => p.name))} ${o.pcs.length === 1 ? 'is' : 'are'} off, asleep, or not running TOMLIN)`);
  const allow = on.filter(p => p.hello!.allow?.lend === true);
  if (!allow.length) return no(`${quoted(on.map(p => p.name))} ${on.length === 1 ? 'does' : 'do'} not allow lending: tick "Allow to be used as part of a cluster" on ${on.length === 1 ? 'it' : 'them'}`);
  const max = allow.filter(p => p.hello!.can.includes('max'));
  if (!max.length) return no(`${quoted(allow.map(p => p.name))} ${allow.length === 1 ? 'runs' : 'run'} a TOMLIN without Max mode: update ${allow.length === 1 ? 'it' : 'them'} there`);
  const members: BuildMember[] = [{ name: 'This PC', host: true, options: o.host }, ...max.map(p => ({ id: p.id, name: p.name, host: false, options: p.options, ...(p.no ? { no: p.no } : {}) }))];
  const chosen = pickBuild(members);
  if (!chosen.build) return no(chosen.line.replace(/\.$/, '') || 'This PC has no llama.cpp runner it can use safely');
  if (chosen.needs.length) return no(chosen.line.replace(/\.$/, ''));
  const kept = max.filter(p => chosen.lenderIds.includes(p.id));
  if (!kept.length) return no(chosen.line.replace(/\.$/, '') || 'No linked PC shares a llama.cpp build with this PC');
  return { why: '', names: kept.map(p => p.name), ids: kept.map(p => p.id), build: chosen.build };
}

/**
 * The tokens a second last measured for a model: on this PC alone, and with Max mode on one set of PCs. With a context
 * asked for (MaxSpeeds.get `at`), only speeds measured at that context and about as full a chat count; none is unknown.
 * `crashed`: the expert-parallel runner crashed with this model (MaxSpeeds.epCrash), so Max mode does not use it.
 */
export interface Measured {
  alone?: number;
  max?: number;
  crashed?: EpCrash;
}

/**
 * Where an answer's speed was measured: the context the model was loaded with (word-pieces) and how full the chat was as
 * it answered (0 empty, 1 full). Writing slows as a chat fills (25 Nov 2026: Qwen3-Next-80B wrote about 8 tok/s alone in an
 * empty 32k chat and 3.5 in a full 64k one), so only speeds measured alike are compared.
 */
export interface SpeedAt {
  ctx: number;
  full: number;
}

/** How full a chat was, in three bands: a quarter of its context or less (short), up to three quarters, or more. */
export const fullBand = (at: SpeedAt): 'short' | 'half' | 'full' => (at.full <= 0.25 ? 'short' : at.full <= 0.75 ? 'half' : 'full');

/** A SpeedAt that can be compared (a context over 0 and a share from 0 to 1), else null. */
const cleanAt = (at: SpeedAt | null | undefined): SpeedAt | null => (at && Number.isFinite(at.ctx) && at.ctx > 0 && Number.isFinite(at.full) && at.full >= 0 ? { ctx: Math.round(at.ctx), full: Math.min(1, at.full) } : null);

/** The key a speed measured at `at` is kept under, inside its model's (and PCs') record: "32768|short". */
export const atKey = (at: SpeedAt): string => `${Math.round(at.ctx)}|${fullBand(at)}`;

/** An expert-parallel runner that crashed with a model: kept until Max is switched on again or another build of it is installed. */
export interface EpCrash {
  /** The model's name, for the words. */
  name: string;
  /** The llama.cpp build it was ("b11284"), for the words; '' when not known. */
  build: string;
  /** The installed expert runner then (src/runtimes.ts expertStamp): a different one now is a newer build. */
  stamp: string;
  at: string;
  /** While loading it, or once it was loaded. */
  when: 'loading' | 'loaded';
  /** No load starts by itself until the person loads it (Connect, a chat's send, Reload with linked PCs). */
  held: boolean;
}

const whenSaid = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const runnerSaid = (c: EpCrash) => `the expert-parallel runner${c.build ? ` (llama.cpp ${c.build})` : ''}`;

/** What Max mode says about a model whose expert-parallel runner crashed: why it is not used, and what brings it back. */
export function epCrashWords(c: EpCrash): string {
  return `Max mode: expert parallel is not used for ${c.name}: ${runnerSaid(c)} crashed ${c.when === 'loading' ? 'while loading it' : 'while it was loaded'} (${whenSaid(c.at)}). It is used again for this model once Max is switched off and on again in the chat, or a newer expert-parallel runner is installed`;
}

/** Why a load that the person did not ask for is not started after such a crash. */
export function epHeldWords(c: EpCrash): string {
  return `${c.name} was not loaded again by itself: ${runnerSaid(c)} crashed with it (${whenSaid(c.at)}), and after such a crash TOMLIN loads it only when you ask. Load it yourself (Connect, or send a message in the chat): it then loads without expert parallel.`;
}

export interface Engine {
  /** 'experts': expert parallel with the lenders; 'alone': this PC alone (a layer split is never used for Max mode). */
  use: 'experts' | 'alone';
  /** The first Max load of this model on these PCs: it is the measurement. */
  trial: boolean;
  /** For the load note and the line under the answer. */
  words: string;
}

const tps = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString('en-GB')}`;

/**
 * What Max mode does for a model that fits this PC alone (the gate passed): expert parallel when the model is a mixture of
 * experts, this PC has a CUDA card, and nothing measured says this PC alone is faster; else this PC alone, said plainly.
 */
export function maxEngine(o: { model: string; moe: boolean; cuda: boolean; measured: Measured }): Engine {
  const alone = (words: string): Engine => ({ use: 'alone', trial: false, words });
  if (!o.moe) return alone(`Max mode: not used for ${o.model}: it is a dense model, and Max mode uses only expert parallel, which needs a mixture-of-experts model`);
  if (!o.cuda) return alone(`Max mode: not used for ${o.model}: expert parallel needs an NVIDIA graphics card (CUDA) on this PC`);
  if (o.measured.crashed) return alone(epCrashWords(o.measured.crashed));
  const { alone: a, max: m } = o.measured;
  if (m && a && m <= a) return alone(`Max mode: not used for this model, it was faster alone (${tps(a)} against ${tps(m)} tok/s)`);
  if (m) return { use: 'experts', trial: false, words: `Max mode: expert parallel, last measured ${tps(m)} tok/s${a ? ` (this PC alone: ${tps(a)} tok/s)` : ' (this PC alone: not measured yet)'}` };
  return { use: 'experts', trial: true, words: `Max mode: the first Max load of ${o.model} on these PCs, so this load is the measurement: if it is not faster than this PC alone, Max mode is not used for it next time` };
}

/**
 * The line under an answer written with lenders: who lent, tok/s now, and this PC alone as last measured (no "faster"
 * unless measured). `max`: the Max speed kept for these PCs; at or under `alone`, it says how to run alone again (a
 * loaded expert load is never reloaded by itself).
 */
export function maxNote(o: { lent: string[]; perSecond: number; alone?: number; max?: number }): string {
  const now = o.perSecond > 0 ? `${tps(o.perSecond)} tok/s` : 'tok/s not reported';
  const alone = o.alone ? `this PC alone: ${tps(o.alone)} tok/s, last measured` : 'this PC alone: not measured yet';
  const slower = o.alone && o.max && o.max <= o.alone ? ' This PC alone was faster: unload the model and load it again, and Max mode runs it alone.' : '';
  return `Max mode: ${quoted(o.lent)} lent (expert parallel), ${now}; ${alone}.${slower}`;
}

/**
 * Which way a chat load goes. 'experts': the Max switch takes it (the model fits this PC alone, the gate passed, the
 * engine is expert parallel). 'auto': everything else, the switch on or off, goes the automatic way (borrowRule), so Max
 * on is never a worse load than Max off (a dense model that spills its card still gets a lent card).
 */
export function maxRoute(o: { asked: boolean; fits: boolean; gate: Gate | null; engine: Engine | null }): 'experts' | 'auto' {
  return o.asked && o.fits && !!o.gate && !o.gate.why && o.engine?.use === 'experts' ? 'experts' : 'auto';
}

/**
 * Why "Reload with linked PCs" must not unload the model ('' when the Max load can start): checked before anything is
 * unloaded. `loanBusy`: another model here holds the lenders now (src/jobrun/maxhost.ts secondLoanWhy).
 */
export function reloadWhy(o: { fitsAlone: boolean | null; gate: Gate; engine: Engine | null; loanBusy: string }): string {
  if (o.fitsAlone === false) return CLUSTER_RUNS_IT;
  if (o.gate.why) return o.gate.why;
  if (o.engine && o.engine.use !== 'experts') return o.engine.words.replace(/^Max mode: /, '');
  return o.loanBusy;
}

/**
 * "Reload with linked PCs" (POST /api/models/<id>/load with max: true and the model loaded): every check first, and the
 * model unloaded only when the Max load can start. Null: unloaded, load it now; else the answer to send, nothing changed.
 */
export async function maxReload(o: { model: string; answering: boolean; why: () => string; impact: () => string | null; unload: () => Promise<unknown> }): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (o.answering) return { status: 409, body: { error: `${o.model} is answering now: wait for it to finish, then press Reload with linked PCs again.` } };
  const why = o.why();
  if (why) return { status: 409, body: { error: `${why.replace(/\.$/, '')}. ${o.model} stays loaded as it is.` } };
  const impact = o.impact();
  if (impact) return { status: 409, body: { error: impact, impact } };
  await o.unload();
  return null;
}

/**
 * The loaded chat model whose memory counts as free when model `self` is asked about: `self` itself when it is loaded
 * (its own memory is its), else the least recently used one not answering (the one a load swaps out).
 */
export function swapOutFor(looks: RunnerLook[], self?: string): RunnerLook | undefined {
  const own = self ? looks.find(r => r.model === self && (r.state === 'connected' || r.state === 'loading')) : undefined;
  return own ?? looks.filter(r => r.model && r.state === 'connected' && !r.busy).sort((a, b) => a.usedAt - b.usedAt)[0];
}

/** A model's name as the chat header shows it: no .gguf, no part number, no quantisation ("...-UD-Q4_K_XL" becomes "...-UD"). */
export const cardModelName = (n: string): string => n.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '').replace(/[-_.](?:i?q\d\w*|f16|bf16)$/i, '') || n;

/** The card shown under an answer when Max is on and the model is loaded on this PC alone. Nothing loads by itself. */
export function reloadCardText(o: { model: string; lenders: string[]; seconds: number | null; trial: boolean }): string {
  // The estimate when this model's own load time is known; else only what earlier loads took (never "a few minutes" next to "3 to 16").
  const time = o.seconds && o.seconds > 0 ? `about ${Math.max(1, Math.round(o.seconds / 60))} min (earlier loads over the link took 3 to 16 minutes)` : 'earlier loads over the link took 3 to 16 minutes';
  return `Max mode is on, but ${cardModelName(o.model)} is loaded on this PC alone. A Max load starts it again with ${quoted(o.lenders)} lending (expert parallel): ${time}.${o.trial ? ' It is the first Max load of this model on these PCs, so its speed is measured against this PC alone.' : ''} Nothing loads by itself.`;
}

/** How the model that answered was loaded, as src/server/panes.ts keeps it (maxRunOf). */
export interface LoadedAs {
  asked: boolean;
  lent: string[];
  engine: 'experts' | 'layers' | null;
  words: string;
  /** The reload card was shown once for this load: it is not shown again under every answer ("Not now" stays not now). */
  offered?: boolean;
}

/**
 * What goes under an answer about Max mode: a line (`note`, '' for none) and, when Max is on and the model that fits
 * this PC is loaded here alone with nothing saying alone is better, the card that offers a Max load (`card`), once per
 * load: `loaded` is the record kept for the runner, and it is marked `offered` here.
 * `away`: the linked PC the answer ran on ('' here). `gate`/`engine`: as maxGate and maxEngine say now.
 */
export function afterAnswer(o: { on: boolean; away: string; fitsAlone: boolean | null; loaded: LoadedAs | null; gate: Gate; engine: Engine | null; perSecond: number; measured: Measured; model: string; seconds: number | null }): { note: string; card?: string } {
  // Lenders worked on it with expert parallel: the honest numbers, whatever the switch says now.
  if (!o.away && o.loaded?.engine === 'experts') return { note: maxNote({ lent: o.loaded.lent, perSecond: o.perSecond, ...(o.measured.alone ? { alone: o.measured.alone } : {}), ...(o.measured.max ? { max: o.measured.max } : {}) }) };
  if (!o.on) return { note: '' };
  if (o.away) return { note: `Max mode: not used: this answer ran on "${o.away}", and Max mode borrows for a model loaded on this PC.` };
  if (o.fitsAlone === false) return { note: `Max mode: not used: ${CLUSTER_RUNS_IT}.` };
  if (o.loaded?.engine === 'layers') return { note: `Max mode: not used: this load borrows ${quoted(o.loaded.lent)} with a layer split (the borrowing that does not need the switch), not with Max mode.` };
  if (o.gate.why) return { note: `Max mode: not used: ${o.gate.why}.` };
  if (!o.engine || o.engine.use === 'alone') return { note: o.engine ? `${o.engine.words}.` : '' };
  // A Max load was asked and still runs alone (expert parallel could not start): said, not offered again and again.
  if (o.loaded?.asked && o.loaded.words) return { note: o.loaded.words };
  // Offered once for this load: after that, one short line (a new load with Max on asks for the linked PCs by itself).
  if (o.loaded?.offered) return { note: `Max mode: on, but ${o.model} runs on this PC alone for this load (unload it, then send, and it loads with the linked PCs).` };
  if (o.loaded) o.loaded.offered = true;
  return { note: '', card: reloadCardText({ model: o.model, lenders: o.gate.names, seconds: o.seconds, trial: o.engine.trial }) };
}

/** The key a Max mode speed is kept under: the model and the set of PCs that lent (by id, sorted). */
export const speedKey = (model: string, ids: string[]): string => `${model}|${[...ids].sort().join(',')}`;

/**
 * `perSecond`: the middle of the last answers kept in `runs` (one slow or fast answer does not decide by itself). `by`:
 * the same, for each context and fill band it was measured at (atKey); the figures above are every answer's, whatever
 * the context, for a caller that does not say its context.
 */
type Kept = { perSecond: number; tokens: number; at: string; runs?: number[]; by?: Record<string, Kept> };
/** Answers shorter than this are not counted (the start of an answer swamps the speed). */
export const MIN_TOKENS = 128;
/** How many answers' speeds are kept for each key; the middle one is the speed decided by. */
export const RUNS_KEPT = 5;
const middle = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The speeds Max mode decides by, kept in data/max-speeds.json: "<model>|" for this PC alone, "<model>|<ids>" with lenders. */
export class MaxSpeeds {
  /** The words for a crash kept here (epCrashWords, epHeldWords), for a caller that has the speeds and not this module. */
  static readonly crashWords = epCrashWords;
  static readonly heldWords = epHeldWords;
  private all: Record<string, Kept> | null = null;
  private file: () => string;
  private write: (file: string, text: string) => Promise<unknown>;
  constructor(file: () => string, write: (file: string, text: string) => Promise<unknown>) {
    this.file = file;
    this.write = write;
  }

  private read(): Record<string, Kept> {
    if (!this.all) {
      try {
        const got = JSON.parse(readFileSync(this.file(), 'utf8')) as unknown;
        this.all = got && typeof got === 'object' && !Array.isArray(got) ? (got as Record<string, Kept>) : {};
      } catch {
        this.all = {};
      }
    }
    return this.all;
  }

  /**
   * What was measured for `model` alone and with the PCs `ids`. `at`: the context and fill the comparison is for (a load
   * starting is an empty chat: full 0); only speeds measured at that context and in the same fill band count, and none
   * is unknown (never a speed from another context or a fuller chat). Without `at`, every answer's figures.
   */
  get(model: string, ids: string[], at?: SpeedAt | null): Measured {
    const all = this.read();
    const where = at === undefined ? undefined : cleanAt(at);
    const of = (k: Kept | undefined) => (where === undefined ? k?.perSecond : where ? k?.by?.[atKey(where)]?.perSecond : undefined);
    const a = of(all[speedKey(model, [])]);
    const m = ids.length ? of(all[speedKey(model, ids)]) : undefined;
    const crashed = this.epCrash(model);
    return { ...(a && a > 0 ? { alone: a } : {}), ...(m && m > 0 ? { max: m } : {}), ...(crashed ? { crashed } : {}) };
  }

  /** An answer's speed: `ids` empty for this PC alone; `at`: the context and fill it was written at. Short answers are not kept. */
  record(model: string, ids: string[], perSecond: number, tokens: number, at?: SpeedAt | null): void {
    if (!model || !(perSecond > 0) || !(tokens >= MIN_TOKENS)) return;
    const all = this.read();
    const key = speedKey(model, ids);
    const before = all[key];
    const now = new Date().toISOString();
    const where = cleanAt(at);
    const by = { ...(before?.by && typeof before.by === 'object' ? before.by : {}) };
    if (where) by[atKey(where)] = kept(by[atKey(where)], perSecond, tokens, now);
    all[key] = { ...kept(before, perSecond, tokens, now), ...(Object.keys(by).length ? { by } : {}) };
    void this.write(this.file(), JSON.stringify(all)).catch(() => undefined);
  }

  // ---- Expert-parallel runner crashes (data/max-crashes.json, beside the speeds) ----

  private crashes: Record<string, EpCrash> | null = null;
  private crashFile = () => join(dirname(this.file()), 'max-crashes.json');

  private readCrashes(): Record<string, EpCrash> {
    if (!this.crashes) {
      try {
        const got = JSON.parse(readFileSync(this.crashFile(), 'utf8')) as unknown;
        this.crashes = got && typeof got === 'object' && !Array.isArray(got) ? (got as Record<string, EpCrash>) : {};
      } catch {
        this.crashes = {};
      }
    }
    return this.crashes;
  }

  private saveCrashes(): void {
    void this.write(this.crashFile(), JSON.stringify(this.readCrashes())).catch(() => undefined);
  }

  /**
   * The expert-parallel runner crashed with `model` (by its id): kept. A crash once it was loaded also holds the model (no
   * load starts by itself until the person loads it); one while loading is followed by that same load's own second start
   * without expert parallel, so nothing is held. `stamp`: the expert runner installed now (src/runtimes.ts expertStamp).
   */
  epCrashed(model: string, o: { name: string; build: string; stamp: string; when: EpCrash['when'] }): EpCrash {
    const c: EpCrash = { name: o.name || model, build: o.build, stamp: o.stamp, at: new Date().toISOString(), when: o.when, held: o.when === 'loaded' };
    this.readCrashes()[model] = c;
    this.saveCrashes();
    return c;
  }

  /**
   * The crash kept for `model`, or null. `stamp`: the expert runner installed now; a different one than at the crash is
   * a newer build, so the crash is forgotten and expert parallel may be tried again.
   */
  epCrash(model: string, stamp?: string): EpCrash | null {
    const all = this.readCrashes();
    const c = all[model];
    if (!c || typeof c !== 'object') return null;
    if (stamp && c.stamp && stamp !== c.stamp) {
      delete all[model];
      this.saveCrashes();
      return null;
    }
    return c;
  }

  /** The person loaded `model` themselves: loads may start again (expert parallel stays off for it). */
  epLetGo(model: string): void {
    const c = this.readCrashes()[model];
    if (!c?.held) return;
    c.held = false;
    this.saveCrashes();
  }

  /** Max switched on again in a chat: every crash (or `model`'s only) is forgotten, so expert parallel is tried again. Gives the models' names. */
  epForgive(model?: string): string[] {
    const all = this.readCrashes();
    const ids = model ? (all[model] ? [model] : []) : Object.keys(all);
    const names = ids.map(id => all[id]?.name || id);
    for (const id of ids) delete all[id];
    if (ids.length) this.saveCrashes();
    return names;
  }
}

/** A kept speed with one more answer: the middle of the last RUNS_KEPT. */
function kept(before: Kept | undefined, perSecond: number, tokens: number, at: string): Kept {
  const runs = [...(Array.isArray(before?.runs) ? before.runs.filter(n => n > 0) : before && before.perSecond > 0 ? [before.perSecond] : []), perSecond].slice(-RUNS_KEPT);
  return { perSecond: Math.round(middle(runs) * 10) / 10, tokens, at, runs: runs.map(n => Math.round(n * 10) / 10) };
}
