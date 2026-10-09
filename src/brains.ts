// A hire's brain: the model that answers for them, on this PC or on a paired PC, with a fallback when the preferred one
// cannot answer now. A brain is written as a short text in staff.json: a model id on this PC ("qwen3-8b-q4_k_m"),
// "remote:<paired PC id>:<model id there>" for one of the models that PC lets linked PCs use (ticked there under Nodes
// and memory; it loads there when asked), or "remote:<paired PC id>" for whatever model that PC has loaded (older PCs,
// and hires made before). Picture hires use the same form for picture models. Also: picture styles (the modes a picture
// model is made for, from the registry), so a manager PC asks a node for a style and the node picks its own model for
// it. The plain parts, tested in test/brains.test.ts.
import { paramsB } from './staff.ts';

export type BrainRef = { kind: 'none' } | { kind: 'here'; id: string } | { kind: 'remote'; pc: string; model?: string };

export function parseRef(ref: unknown): BrainRef {
  const s = typeof ref === 'string' ? ref.trim() : '';
  if (!s) return { kind: 'none' };
  if (s.startsWith('remote:')) {
    const m = /^remote:([0-9a-f]{8})(?::([^\u0000-\u001f\u007f]{1,300}))?$/.exec(s);
    return m ? { kind: 'remote', pc: m[1], ...(m[2] ? { model: m[2] } : {}) } : { kind: 'none' };
  }
  return { kind: 'here', id: s };
}

/** The ref for one of a linked PC's shared models, or (no model) for whatever that PC has loaded. */
export const remoteRef = (pc: string, model?: string | null) => (model ? `remote:${pc}:${model}` : `remote:${pc}`);

/** The refs a hire has, preferred first, without blanks or repeats. */
export function refsOf(m: { model?: string | null; fallback?: string | null }): string[] {
  return [...new Set([m.model, m.fallback].filter((x): x is string => typeof x === 'string' && parseRef(x).kind !== 'none'))];
}

/** One brain as it stands now: whether it can answer at once, or what it would take. */
export interface Candidate {
  ref: string;
  /** Answers now: the model is loaded here, or the paired PC answered with a model loaded. */
  ready: boolean;
  /** Not ready, but this PC could load it (a model on this PC that fits). */
  loadable: boolean;
  /** Why it cannot answer now, in plain words (empty when ready). */
  why: string;
}

/**
 * Which brain answers: the first that is ready now (preferred before fallback); else the first that this PC can load;
 * else none, with every reason. Nothing is loaded on a paired PC: it keeps control of what it has.
 */
export function pickBrain(cands: Candidate[]): { use: Candidate; load: boolean } | { error: string[] } {
  const ready = cands.find(c => c.ready);
  if (ready) return { use: ready, load: false };
  const load = cands.find(c => c.loadable);
  if (load) return { use: load, load: true };
  return { error: cands.map(c => c.why).filter(Boolean) };
}

// ---- A backup while a hire's PC is off (PLAN phases 4+5, "Backup when a PC is off") ----

/** A backup picked while the first choice could not answer: for one answer, or until the first choice answers again. */
export interface Cover {
  ref: string;
  once?: boolean;
}

/** The refs tried in order: the first choice, then a backup picked while it was away, then the fallback. */
export function withCover(refs: string[], cover?: Cover | null): string[] {
  if (!cover || parseRef(cover.ref).kind === 'none') return refs;
  return [...new Set([...refs.slice(0, 1), cover.ref, ...refs.slice(1)])];
}

/** A model's name without folder, file ending or quantisation: "models/Qwen3.5-9B-Q4_K_M.gguf" -> "qwen3.5-9b". */
export function modelStem(name: string): string {
  return name.split(/[\\/]/).pop()!.toLowerCase().replace(/\.gguf$/, '').replace(/[-_.](?:ud-)?(?:i?q\d[\w]*|f16|bf16|f32)$/, '').trim();
}

/** The same model, whatever the file is called on each PC or how it was cut down. */
export const sameModel = (a: string, b: string): boolean => !!a && !!b && modelStem(a) === modelStem(b);

/** A backup smaller than the hire's own model answers as an intern (drafts only). Unknown sizes are not called smaller. */
export function isIntern(own: string, other: string): boolean {
  const a = paramsB(own);
  const b = paramsB(other);
  return a !== null && b !== null && b < a;
}

/** One place a hire could answer while their own PC is off. */
export interface BackupChoice {
  ref: string;
  /** 'This PC' or the linked PC's name. */
  pc: string;
  model: string;
  /** Answers at once (loaded); else this PC loads it first. */
  ready: boolean;
  same: boolean;
  intern: boolean;
}

/** Same model first, then the ones that answer at once, then bigger before smaller. */
export function orderChoices(list: BackupChoice[]): BackupChoice[] {
  const size = (c: BackupChoice) => paramsB(c.model) ?? 0;
  return [...list].sort((a, b) => Number(b.same) - Number(a.same) || Number(a.intern) - Number(b.intern) || Number(b.ready) - Number(a.ready) || size(b) - size(a));
}

/** "Qwen3-8B-Q4_K_M" -> "8B"; a name with no size -> its short name. */
export function sizeWord(model: string): string {
  const b = paramsB(model);
  if (b !== null) return `${b}B`;
  return model.replace(/\s*[(+].*$/, '').replace(/\.(gguf|safetensors)$/i, '').replace(/[-_.](?:i?q\d\w*|f16|bf16)$/i, '').slice(0, 30);
}

/** Where an answer ran, for the chat head ("Rowan · on laptop 9B"): "on laptop 9B", "on this PC 1.7B". */
export function ranOn(pc: string, model: string): string {
  return `on ${pc} ${sizeWord(model)}`.trim();
}

/** Flattens a conversation into one message for an older worker that takes only system + user. */
export function flatten(turns: { role: string; content: string }[]): { system: string; user: string } {
  const system = turns[0]?.role === 'system' ? turns[0].content : '';
  const rest = turns.filter(t => t.role !== 'system');
  const last = rest.at(-1);
  if (rest.length <= 1) return { system, user: last?.content ?? '' };
  const before = rest.slice(0, -1).map(t => `${t.role === 'user' ? 'Them' : 'You'}: ${t.content}`).join('\n\n');
  return { system, user: `The conversation so far:\n\n${before}\n\nTheir new message:\n${last?.content ?? ''}` };
}

/** Cleans the turns a manager PC sends to a worker: roles known, lengths capped, the system line first only. */
export function cleanTurns(raw: unknown): { role: 'system' | 'user' | 'assistant'; content: string }[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) return null;
  const out: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  let total = 0;
  for (const [i, t] of raw.entries()) {
    const role = (t as Record<string, unknown>)?.role;
    const content = String((t as Record<string, unknown>)?.content ?? '');
    if (role !== 'user' && role !== 'assistant' && !(role === 'system' && i === 0)) return null;
    total += content.length;
    if (total > 230_000) return null;
    out.push({ role, content });
  }
  return out.at(-1)?.role === 'user' ? out : null;
}

// ---- Picture styles ----

/** The styles a manager PC can ask for. "photo" is the Images window's "Blog / photo" mode. */
export const STYLES = ['cartoon', 'photo', 'icon'] as const;
export type Style = (typeof STYLES)[number];
export const STYLE_NAME: Record<Style, string> = { cartoon: 'Cartoon', photo: 'Photo', icon: 'Icon' };
const MODE_OF: Record<Style, 'cartoon' | 'blog' | 'icon'> = { cartoon: 'cartoon', photo: 'blog', icon: 'icon' };
export const modeOfStyle = (s: Style) => MODE_OF[s];
export const styleOfMode = (mode: string): Style | null => (mode === 'blog' ? 'photo' : (STYLES as readonly string[]).includes(mode) ? (mode as Style) : null);
export const isStyle = (v: unknown): v is Style => (STYLES as readonly unknown[]).includes(v);

export interface PictureModel {
  id: string;
  name: string;
  /** The registry's recommendedModes. */
  modes: string[];
  installed: boolean;
  bytes: number;
}

const madeFor = (m: PictureModel, s: Style) => m.modes.includes(MODE_OF[s]);

/**
 * The model a node draws a style with: the loaded one when it is made for it; else an installed one that is (when the
 * node lets paired PCs switch its picture model); else the loaded one anyway, with a note.
 */
export function modelForStyle(style: Style | null, loaded: PictureModel, models: PictureModel[], swaps: boolean): { use: PictureModel; swap: boolean; note: string } {
  if (!style || madeFor(loaded, style)) return { use: loaded, swap: false, note: '' };
  const other = models.find(m => m.installed && m.id !== loaded.id && madeFor(m, style));
  if (other && swaps) return { use: other, swap: true, note: `switched to ${short(other.name)} for ${STYLE_NAME[style].toLowerCase()}` };
  if (other) return { use: loaded, swap: false, note: `${short(other.name)} draws ${STYLE_NAME[style].toLowerCase()} better and is on that PC, but it does not let other PCs switch its picture model` };
  return { use: loaded, swap: false, note: `no model on that PC is made for ${STYLE_NAME[style].toLowerCase()}` };
}

const short = (name: string) => name.replace(/\s*\(.*\)$/, '');

/**
 * For an artist node: each style, the installed model that draws it, or the model to download for it. The suggestion a
 * node shows ("Photo: download Realistic Vision 6, 2.0 GB").
 */
export function styleCoverage(models: PictureModel[]): { style: Style; name: string; have: string | null; get: { id: string; name: string; gb: number } | null }[] {
  return STYLES.map(s => {
    const have = models.find(m => m.installed && madeFor(m, s));
    const get = have ? null : models.filter(m => madeFor(m, s)).sort((a, b) => a.bytes - b.bytes)[0];
    return { style: s, name: STYLE_NAME[s], have: have ? short(have.name) : null, get: get ? { id: get.id, name: short(get.name), gb: Math.round((get.bytes / 2 ** 30) * 10) / 10 } : null };
  });
}
