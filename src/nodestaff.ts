// What a node and a linked PC tell each other. A node lends nothing but its models: its owner ticks the ones linked PCs
// may use, and a linked PC hires its OWN staff on them (who they are, their notebooks and chats stay on that PC). Staff
// hired on a node and lent out (before 2.0.31) are retired: an old chat with one is kept to read, and says so. The
// plain parts, tested in test/nodestaff.test.ts.

const PC_ID = /^[0-9a-f]{8}$/;

/** The "who" of an old chat with a hire who lived on a linked PC (retired in 2.0.31): "node:<PC id>:<hire id>". */
export function parseNodeWho(who: unknown): { pc: string; id: string } | null {
  const m = typeof who === 'string' ? /^node:([0-9a-f]{8}):([a-z0-9][a-z0-9-]{0,39})$/.exec(who) : null;
  return m ? { pc: m[1], id: m[2] } : null;
}

/** Said when an old chat with a hire who lived on a linked PC is used: what changed and the way on. */
export const RETIRED_NODE_HIRE = 'Linked PCs no longer lend their own staff: a node now only lets other PCs use its models. This chat is kept to read. To carry on, hire someone here on one of its models (Hire staff: pick that PC, then the model).';

const text = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- Models a node lets linked PCs use ----
// Its owner ticks them under Network ("Models other PCs may use"): chat models and picture models. A linked PC
// then hires its OWN staff on them; the node only loads the model and answers (or draws). Nothing is shared until a
// model is ticked.

/** One of a node's models that linked PCs may use, as its hello tells them. */
export interface SharedModel {
  id: string;
  name: string;
  /** A chat model (answers) or a picture model (draws). An older node sends chat models only. */
  kind: 'chat' | 'image';
  bytes: number;
  /** The context it is started with there (how much one answer can read). */
  ctx: number;
  /** Loaded there now (answers at once); else it loads when asked. */
  loaded: boolean;
  /** Answering (or drawing) something there now: a linked PC waits for it. */
  busy: boolean;
  /** Hidden by that PC's owner (Models on this PC, Hide): still usable, left out of the pick lists until "Show hidden". */
  hidden?: boolean;
  /** When it last answered or drew there (ms); absent when that PC has no record (or runs an older TOMLIN). */
  usedAt?: number;
  /** A chat model: its Guessing model there ('' = none), and the ones that PC could use (src/runset.ts). An older node sends neither. */
  draft?: string;
  guessers?: string[];
  /** The hires on that PC who work on it, and as what (first choice, backup), so a linked PC's delete can say so. An older node sends none. */
  assigned?: { name: string; as: string[]; spare: boolean }[];
}

/** What a node tells linked PCs: every model on it (nothing to tick), chat models first, each list in its own order. */
export function sharedList(o: { models: { id: string; name: string; bytes: number; kind?: 'chat' | 'image' }[]; ctxOf: (id: string) => number; loaded: (id: string) => boolean; busy: (id: string) => boolean; hidden?: (id: string) => boolean; usedAt?: (id: string) => number | null; assigned?: (id: string) => { name: string; as: string[]; spare: boolean }[]; runOf?: (id: string) => { draft: string; guessers: string[] } }): SharedModel[] {
  const kindOf = (m: { kind?: 'chat' | 'image' }) => m.kind ?? 'chat';
  return [...o.models.filter(m => kindOf(m) === 'chat'), ...o.models.filter(m => kindOf(m) === 'image')].map(m => {
    const loaded = o.loaded(m.id);
    const kind = kindOf(m);
    const run = kind === 'chat' ? o.runOf?.(m.id) : undefined;
    const assigned = o.assigned?.(m.id) ?? [];
    return { id: m.id, name: m.name, kind, bytes: m.bytes, ctx: kind === 'image' ? 0 : o.ctxOf(m.id), loaded, busy: loaded && o.busy(m.id), ...(o.hidden?.(m.id) ? { hidden: true } : {}), ...(o.usedAt?.(m.id) ? { usedAt: o.usedAt(m.id)! } : {}), ...(run ? { draft: run.draft, guessers: run.guessers } : {}), ...(o.assigned ? { assigned } : {}) };
  });
}

/** A model id as a node sent it: a short string with no control characters, else ''. */
const modelId = (v: unknown) => (typeof v === 'string' && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v) ? v : '');

/** The hires a node says work on a model: at most 20, names capped, only the known ways of working on it. */
function cleanAssigned(raw: unknown[]): { name: string; as: string[]; spare: boolean }[] {
  const ways = ['first choice', 'backup', 'on it now'];
  return raw.slice(0, 20).map(r => (r && typeof r === 'object' ? r : {}) as Record<string, unknown>)
    .map(x => ({ name: text(x.name, 40), as: (Array.isArray(x.as) ? x.as : []).filter((a): a is string => typeof a === 'string' && ways.includes(a)), spare: x.spare === true }))
    .filter(x => x.name && x.as.length);
}

/** What a node sent as its shared models, made safe to keep and show: at most 40, names capped, numbers only. */
export function cleanShared(raw: unknown): SharedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedModel[] = [];
  for (const r of raw.slice(0, 40)) {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const id = modelId(x.id);
    if (!id || out.some(m => m.id === id)) continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const kind = x.kind === 'image' ? 'image' : 'chat';
    const run = kind === 'chat' && Array.isArray(x.guessers) ? { draft: modelId(x.draft), guessers: x.guessers.map(modelId).filter(Boolean).slice(0, 40) } : {};
    out.push({ id, name: text(x.name, 80) || id, kind, bytes: n(x.bytes), ctx: kind === 'image' ? 0 : n(x.ctx) || 8192, loaded: x.loaded === true, busy: x.busy === true, ...(x.hidden === true ? { hidden: true } : {}), ...(n(x.usedAt) ? { usedAt: n(x.usedAt) } : {}), ...run, ...(Array.isArray(x.assigned) ? { assigned: cleanAssigned(x.assigned) } : {}) });
  }
  return out;
}

/**
 * Whether a linked PC may run a model here: still on this PC (every model on a node is lent), and not answering
 * something else. Null when it may; else the refusal (said on that PC) and whether it is only busy (that PC waits and
 * asks again).
 */
export function modelRefusal(id: string, o: { onPc: (id: string) => string | null; busy: boolean; pcName: string }): { error: string; busy?: true } | null {
  const name = o.onPc(id);
  if (!name) return { error: `that model is not on "${o.pcName}" any more.` };
  if (o.busy) return { error: `${name} is answering something else on "${o.pcName}" now.`, busy: true };
  return null;
}

/** A chat model loaded on a node for a linked PC stays this long unused, so a reply minutes later does not reload it. */
export const CHAT_DROP_MS = 10 * 60_000;

/**
 * What becomes of a chat model a node loaded for linked PCs, at each look: kept, gone (unloaded), theirs (someone at
 * this PC answers on it), dropped (unused too long), or waiting. One the speed finder is testing is kept even while it is
 * unloaded between tries: the finder loads it again at the end, and it must still drop after (2 Nov: a node kept three
 * models loaded, 14 to 15 GB, long after the tests).
 */
export function chatVerdict(o: { state: string; lending: boolean; busyHere: boolean; testing: boolean; idleMs: number }): 'keep' | 'gone' | 'theirs' | 'drop' | 'wait' {
  if (o.testing) return 'keep';
  if (o.state !== 'connected' && o.state !== 'loading') return 'gone';
  if (o.lending || o.state === 'loading') return 'keep';
  if (o.busyHere) return 'theirs';
  return o.idleMs > CHAT_DROP_MS ? 'drop' : 'wait';
}

/**
 * The same for the picture model loaded for linked PCs. While it draws for one it is kept, even when it is started
 * again part-way (moved to the CPU, or with its weights in RAM): it stays theirs, and drops after.
 */
export function pictureVerdict(o: { id: string; model: string | null; state: string; drawing: boolean; busyHere: boolean; idleMs: number; dropMs: number }): 'keep' | 'gone' | 'theirs' | 'drop' | 'wait' {
  if (o.drawing) return 'keep';
  if (o.model !== o.id || (o.state !== 'connected' && o.state !== 'loading')) return 'gone';
  if (o.state === 'loading') return 'keep';
  if (o.busyHere) return 'theirs';
  return o.idleMs > o.dropMs ? 'drop' : 'wait';
}

/** Whether a picture model fits on the card beside what other models hold there now. No card known: yes. */
export function pictureRoom(o: { cardTotal: number | null; heldByOthers: number; need: number }): boolean {
  return o.cardTotal === null || o.cardTotal - o.heldByOthers >= o.need;
}

/** A linked PC's stream cut part-way, in plain words: "terminated" and "fetch failed" are fetch's own. Other words pass through. */
export function cutWords(pcName: string, message: string): string {
  return /^(terminated|fetch failed|other side closed|socket hang up)$/i.test(message.trim()) || /ECONNRESET|UND_ERR_SOCKET/.test(message)
    ? `"${pcName}" stopped sending part-way: the link closed (it may have restarted, slept or lost the network). Try again.`
    : message;
}

/** The chat models a node loaded for linked PCs: the PCs using each (names, links) and when one last did. */
export type LoadedFor = Map<string, { by: Set<string>; links: Set<string>; at: number }>;

/**
 * The chat models that make way, oldest first, when a model the link `link` asked for (`keep`) does not fit: every one
 * loaded only for that link and not answering (`idle`). Never one its owner loaded, nor one another link uses too (P1-4,
 * 3 Nov: one was unloaded, then Gemma 4 was refused with three test models idle). Gone by the link's own id, never its
 * name: a guest picks its own name, and could take another PC's.
 */
export function makeWayOrder(loaded: LoadedFor, link: string, keep: string, idle: (id: string) => boolean): string[] {
  return [...loaded].filter(([id, v]) => id !== keep && v.links.size === 1 && v.links.has(link) && idle(id)).sort((a, b) => a[1].at - b[1].at).map(([id]) => id);
}

/** An answer for a linked PC: every chat model loaded for it stays. */
export function keepAll(loaded: LoadedFor, link: string, now: number): void {
  for (const v of loaded.values()) if (v.links.has(link)) v.at = now;
}

/**
 * A chat open on a linked PC (its meters every few seconds): only the model that chat uses stays, so the other models
 * loaded for that PC still drop after 10 minutes. No model named: none is kept.
 */
export function keepChat(loaded: LoadedFor, link: string, model: string, now: number): void {
  const v = model ? loaded.get(model) : undefined;
  if (v?.links.has(link)) v.at = now;
}

/** After a run for a linked PC: an answer keeps every model loaded for it; a refused or failed run keeps none. */
export function afterRun(loaded: LoadedFor, link: string, answered: boolean, now: number): void {
  if (answered) keepAll(loaded, link, now);
}

/** The model a chat's meters name to a linked PC: the hire's brain when it is one of that PC's models, else ''. */
export function statsModel(ref: string | null | undefined, pc: string): string {
  const m = /^remote:([0-9a-f]{8}):(.+)$/.exec(ref ?? '');
  return m && m[1] === pc ? m[2] : '';
}

/** Initials for a card or row. */
export const initialsOf = (name: string) => name.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

export const isPcId = (v: unknown): v is string => typeof v === 'string' && PC_ID.test(v);

/** A PC's meters at one moment: CPU and graphics chip busy (0-100, null when unknown), RAM and the chip's memory in bytes. */
export interface NodeStats {
  at: number;
  cpu: number;
  ram: { used: number; total: number };
  gpu: { name: string; busy: number | null; used: number; total: number | null; shared: boolean } | null;
}

/** What a paired PC sent as its meters, kept only as numbers and a short name (it is shown on this PC's page). */
export function cleanStats(x: unknown): NodeStats | null {
  const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null);
  if (!o || num(o.cpu, 100) === null) return null;
  const ram = (o.ram && typeof o.ram === 'object' ? o.ram : {}) as Record<string, unknown>;
  const g = (o.gpu && typeof o.gpu === 'object' ? o.gpu : null) as Record<string, unknown> | null;
  return {
    at: num(o.at) ?? Date.now(),
    cpu: Math.round(num(o.cpu, 100)!),
    ram: { used: num(ram.used) ?? 0, total: num(ram.total) ?? 0 },
    gpu: g ? { name: String(g.name ?? '').replace(/[^\w .()+×-]/g, '').slice(0, 60), busy: num(g.busy, 100), used: num(g.used) ?? 0, total: num(g.total), shared: g.shared === true } : null,
  };
}

/**
 * Draft, Mid or High, the seed and the words to leave out, as a picture asked of a linked PC gives them: what is not
 * good is left to that PC. The words to leave out go with the PC's own for the style (src/images.ts adds them first).
 */
export function drawChoices(b: Record<string, unknown>): { quality?: string; seed?: number; negative?: string } {
  const negative = typeof b.negative === 'string' ? b.negative.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  return {
    ...(b.quality === 'draft' || b.quality === 'mid' || b.quality === 'high' ? { quality: b.quality } : {}),
    ...(Number.isInteger(b.seed) && (b.seed as number) >= 0 && (b.seed as number) < 2 ** 31 ? { seed: b.seed as number } : {}),
    ...(negative ? { negative } : {}),
  };
}
