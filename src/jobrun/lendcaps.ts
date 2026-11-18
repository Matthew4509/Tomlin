// Max mode: a lower RAM cap remembered for a lending PC that stopped answering while it held layers in its RAM.
// On 14 Nov 2026 the HP 800 (24 GB) worked once with about 14.4 GB of DeepSeek's layers and stalled with the same load
// the next time, then its TOMLIN stopped answering. A fixed rule cannot know every PC, so a stall teaches it: the next
// split gives that PC at most LEARN_SHARE of what it held, for LEARN_DAYS. A later stall lowers it again; it never rises
// by itself before then. Pure parts first (tested in test/speedsplit.test.ts), then the glue (saved in lend-caps.json).
import { log } from '../log.ts';
import { d } from './shared.ts';

/** What a stall leaves: the cap, when it was learned, and why (plain words, for the log). */
export interface Learned {
  bytes: number;
  at: string;
  why: string;
}
/** Learned caps by linked PC id. */
export type Caps = Record<string, Learned>;

/** The share of what a PC held when it stalled that it is given next time. */
export const LEARN_SHARE = 0.75;
/** How long a learned cap holds (days): a PC may get more RAM, or the cause may have been something else. */
export const LEARN_DAYS = 30;
export const CAPS_FILE = 'lend-caps.json';

const GB = 2 ** 30;
const fresh = (l: Learned | undefined, now: number) => !!l && l.bytes > 0 && now - Date.parse(l.at) <= LEARN_DAYS * 864e5;

/** The cap learned for linked PC `id` (bytes), or null when none is in force. */
export function capOf(caps: Caps, id: string, now = Date.now()): number | null {
  const l = caps[id];
  return fresh(l, now) ? l!.bytes : null;
}

/** `caps` with what linked PC `id` held in its RAM (`held`, bytes) when it stalled: the lower of the cap in force and LEARN_SHARE of `held`. */
export function learn(caps: Caps, id: string, held: number, why: string, now = Date.now()): Caps {
  if (!(held > 0)) return caps;
  const had = capOf(caps, id, now);
  const bytes = Math.floor(Math.min(had ?? Infinity, held * LEARN_SHARE));
  return { ...caps, [id]: { bytes, at: new Date(now).toISOString(), why: why.slice(0, 200) } };
}

/** Kept only when it reads as one: a damaged file is no caps. */
export function cleanCaps(x: unknown): Caps {
  const out: Caps = {};
  if (!x || typeof x !== 'object') return out;
  for (const [id, v] of Object.entries(x as Record<string, unknown>)) {
    const l = v as Partial<Learned> | null;
    if (l && Number(l.bytes) > 0 && typeof l.at === 'string' && !Number.isNaN(Date.parse(l.at))) out[id] = { bytes: Number(l.bytes), at: l.at, why: String(l.why ?? '') };
  }
  return out;
}

// ---- The glue ----

let caps: Caps | null = null;
/** What each lender holds in its RAM from the last split here, by linked PC id (bytes). */
const holding = new Map<string, number>();

/** The caps in force, read once from the data folder. */
export async function lendCaps(): Promise<Caps> {
  if (!caps) caps = cleanCaps(await d.store.readJson<unknown>(CAPS_FILE, {}).catch(() => ({})));
  return caps;
}

/** A split was made: what each lender (by linked PC id) holds in its RAM now. */
export function nowHolding(byId: Record<string, number>): void {
  holding.clear();
  for (const [id, bytes] of Object.entries(byId)) if (bytes > 0) holding.set(id, bytes);
}

/** A lender's stream ended with a fault: when it held layers in its RAM, it is given less from now on. */
export async function lenderLost(id: string, name: string, why: string): Promise<void> {
  const held = holding.get(id) ?? 0;
  if (!(held > 0)) return;
  holding.delete(id);
  const next = learn(await lendCaps(), id, held, why);
  caps = next;
  await d.store.writeJson(CAPS_FILE, next).catch(() => undefined);
  log.warn('max', `"${name}" stopped answering while it held ${(held / GB).toFixed(1)} GB of layers in its RAM (${why}). From now on it is given at most ${(next[id].bytes / GB).toFixed(1)} GB for ${LEARN_DAYS} days.`);
}
