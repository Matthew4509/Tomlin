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
// Its owner ticks them under Nodes and memory ("Models other PCs may use"): chat models and picture models. A linked PC
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
}

/** The ticks as saved: model ids that are on this PC, no repeats, at most 40. */
export function cleanTicks(raw: unknown, onPc: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && onPc.includes(x)))].slice(0, 40);
}

/** What a node tells linked PCs: each ticked model still on it, chat models first, each list in its own order. */
export function sharedList(ticked: string[], o: { models: { id: string; name: string; bytes: number; kind?: 'chat' | 'image' }[]; ctxOf: (id: string) => number; loaded: (id: string) => boolean; busy: (id: string) => boolean; hidden?: (id: string) => boolean }): SharedModel[] {
  const kindOf = (m: { kind?: 'chat' | 'image' }) => m.kind ?? 'chat';
  return [...o.models.filter(m => kindOf(m) === 'chat'), ...o.models.filter(m => kindOf(m) === 'image')].filter(m => ticked.includes(m.id)).map(m => {
    const loaded = o.loaded(m.id);
    const kind = kindOf(m);
    return { id: m.id, name: m.name, kind, bytes: m.bytes, ctx: kind === 'image' ? 0 : o.ctxOf(m.id), loaded, busy: loaded && o.busy(m.id), ...(o.hidden?.(m.id) ? { hidden: true } : {}) };
  });
}

/** What a node sent as its shared models, made safe to keep and show: at most 40, names capped, numbers only. */
export function cleanShared(raw: unknown): SharedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedModel[] = [];
  for (const r of raw.slice(0, 40)) {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const id = typeof x.id === 'string' && x.id.length <= 300 && !/[\u0000-\u001f\u007f]/.test(x.id) ? x.id : '';
    if (!id || out.some(m => m.id === id)) continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const kind = x.kind === 'image' ? 'image' : 'chat';
    out.push({ id, name: text(x.name, 80) || id, kind, bytes: n(x.bytes), ctx: kind === 'image' ? 0 : n(x.ctx) || 8192, loaded: x.loaded === true, busy: x.busy === true, ...(x.hidden === true ? { hidden: true } : {}) });
  }
  return out;
}

/**
 * Whether a linked PC may run a model here: ticked, still on this PC, and not answering something else. Null when it
 * may; else the refusal (said on that PC) and whether it is only busy (that PC waits and asks again).
 */
export function modelRefusal(id: string, o: { ticked: string[]; onPc: (id: string) => string | null; busy: boolean; pcName: string }): { error: string; busy?: true } | null {
  const name = o.onPc(id);
  if (!name) return { error: `that model is not on "${o.pcName}" any more.` };
  if (!o.ticked.includes(id)) return { error: `"${o.pcName}" does not let other PCs use ${name} now (its owner ticks the models others may use under Nodes and memory).` };
  if (o.busy) return { error: `${name} is answering something else on "${o.pcName}" now.`, busy: true };
  return null;
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
