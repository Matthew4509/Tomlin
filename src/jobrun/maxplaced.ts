// Max mode "all", a mixture-of-experts model about to load: asks src/maxplace.ts for the placement (experts in the lenders'
// RAM, attention and cache on cards) and says in plain words what it did. Null when it does not apply (a dense model, a
// card-only loan, or TOMLIN_MAX_PLACE not set to on: 12 Nov 2026 the placement wrote 0.65 tok/s on the 80B against 3.7 for the layer split), so the load keeps llama.cpp's own layer split.
import { freemem } from 'node:os';
import { expertWeights, quantFamily, wordBytes, type QuantFamily } from '../gguf.ts';
import { speedFor, forHello, speedNow } from '../speedtest.ts';
import { capOf, lendCaps, nowHolding, type Caps } from './lendcaps.ts';
import { listWith, parseListed, placement, type Lender } from '../maxplace.ts';
import { planLayers } from '../layersplit.ts';
import type { ChatRun } from '../llama.ts';
import { log } from '../log.ts';
import { lastHello } from './links.ts';
import { labelOf, maxPcs, shareAll } from './maxhost.ts';

export interface Placed {
  /** Set when the placement is used; otherwise only the note says why the layer split stays. */
  rpc?: string[];
  maxPlace?: NonNullable<ChatRun['maxPlace']>;
  note: string;
  /** Set when the model cannot be placed without leaving a PC under 2 GB free: the load must not start (plain words). */
  refuse?: string;
}

/** The expert placement is OFF unless TOMLIN_MAX_PLACE is on (or 1, yes, true, experts): over RPC the card and the CPU of a lender are two remote devices, and every hop between them crosses the network (0.65 tok/s measured). */
export const placeOff = (said = process.env.TOMLIN_MAX_PLACE ?? ''): boolean => !/^(on|1|yes|true|experts)$/i.test(said.trim());

/** The lenders as maxLoad gave them (endpoints and names in the same order), with whether each one's hello says it has a card. */
export function lendersOf(max: { endpoints: string[]; lent: string[]; ids?: string[] }, caps: Caps = {}, kind: QuantFamily | null = null): Lender[] {
  // The ids the load gave are used when it gave them; the names are looked up only for a load that did not.
  const pcs = max.ids?.length === max.endpoints.length ? [] : maxPcs();
  return max.endpoints.map((endpoint, i) => {
    const name = max.lent[i] ?? '';
    const id = max.ids?.[i] ?? pcs.find(r => labelOf(r) === name)?.id ?? '';
    const hello = lastHello(id);
    const memory = hello?.memory as { cards?: { count?: unknown } } | null | undefined;
    const cards = Number(memory?.cards?.count);
    // Its speed test's figures for this model's kind of quantisation (src/speedtest.ts): undefined from a TOMLIN that sends
    // none, null when it has none for this kind. Either way the model is placed by room.
    const speed = hello?.speed === undefined ? undefined : speedFor(hello.speed, kind);
    // A lower cap learned when it stopped answering before (src/jobrun/lendcaps.ts).
    const capRam = id ? capOf(caps, id) : null;
    return { name, endpoint, hasCard: Number.isFinite(cards) ? cards > 0 : null, speed, ...(capRam ? { capRam } : {}) };
  });
}

/**
 * Max mode, any model: the layers dealt out by each device's room while every PC keeps its free RAM (src/layersplit.ts),
 * instead of llama.cpp's fit (13 Nov 2026: it filled the HP 800 first and crashed it). Null when it does not apply (no
 * lender, no layer count); `note` only when the fit stays; `refuse` when the PCs cannot hold the model.
 */
export async function maxSplit(o: { name: string; layers: number; bytes: number; cache: number; exe: string; device: 'cuda' | 'vulkan' | 'cpu'; cards?: string[]; max: { endpoints: string[]; lent: string[]; ids?: string[] } | null; path?: string | null; experts?: { count: number; used: number } | null }): Promise<Placed | null> {
  if (!o.max?.endpoints.length || !(o.layers > 0)) return null;
  const listed = parseListed(await listWith(o.exe, o.max.endpoints));
  const read = await readPerLayer(o);
  const caps = await lendCaps().catch(() => ({}));
  // Speeds are per kind of quantisation: a processor that unpacks i-quants slowly can be fast on others (14 Nov 2026).
  const kind = o.path ? await quantFamily(o.path) : null;
  const got = planLayers({ layers: o.layers, bytes: o.bytes, kv: o.cache, ...(read ? { read } : {}), ...(kind ? { kind } : {}) }, listed, lendersOf(o.max, caps, kind), { free: freemem(), ...(o.cards?.length ? { cards: o.cards } : {}), speed: speedFor(forHello(speedNow()), kind) });
  if ('why' in got) {
    if (got.refuse) {
      log.info('max', `${o.name}: load refused before it started: ${got.why}.`);
      return { note: '', refuse: `Max mode cannot load ${o.name}: ${got.why}.` };
    }
    log.info('max', `${o.name}: no layer split by room (${got.why}), so it loads without the lenders: llama.cpp's own fit ignores their RAM limits.`);
    return { note: '' };
  }
  // What each lender holds in its RAM now: a stall while it holds it lowers its cap next time.
  const pcs = maxPcs();
  const idOf = (name: string) => o.max?.ids?.[o.max.lent.indexOf(name)] ?? pcs.find(r => labelOf(r) === name)?.id ?? '';
  nowHolding(Object.fromEntries(Object.entries(got.ramHeld).map(([name, bytes]) => [idOf(name), bytes]).filter(([id]) => id)));
  log.info('max', `${o.name}: ${got.how === 'speed' ? got.words : `layers dealt by room (${got.words})`}; -dev ${got.dev.join(',')} -ts ${got.split.join(',')} -ngl ${got.ngl}.${got.notes.length ? ` ${got.notes.join(' ')}` : ''}`);
  return { maxPlace: { device: o.device, dev: got.dev, split: got.split, override: [], ngl: got.ngl }, note: `Max mode: ${got.words}.${got.notes.length ? ` ${got.notes.join(' ')}` : ''}` };
}

/**
 * `exe`: the host's runner for `device`; `max`: what maxLoad said (the lenders' --rpc addresses and names, same order);
 * `layers`, `cache`: the model's block count and context cache bytes.
 */
export async function maxPlaced(o: { path: string; name: string; layers: number; cache: number; exe: string; device: 'cuda' | 'vulkan'; cards?: string[]; max: { endpoints: string[]; lent: string[]; ids?: string[] } | null }): Promise<Placed | null> {
  if (!shareAll() || placeOff() || !o.max?.endpoints.length) return null;
  const ew = await expertWeights(o.path);
  if (!ew || !ew.perLayer) return null;
  const lenders = lendersOf(o.max);
  const got = await placement(o.exe, lenders, {
    list: listWith,
    model: async () => ({ layers: o.layers, expertLayer: ew.perLayer, rest: ew.rest, kv: o.cache }),
    host: { free: freemem(), ...(o.cards?.length ? { cards: o.cards } : {}) },
  });
  if ('why' in got) {
    if (got.refuse) {
      log.info('max', `${o.name}: load refused before it started: ${got.why}.`);
      return { note: '', refuse: `Max mode cannot place ${o.name}: ${got.why}.` };
    }
    log.info('max', `${o.name}: layer split kept, not the expert placement: ${got.why}.`);
    return { note: `Max mode: the usual layer split is used for this model (${got.why}).` };
  }
  log.info('max', `${o.name}: experts placed (${got.words}); -dev ${got.dev.join(',')} -ts ${got.split.join(',')}.`);
  return { rpc: got.rpc, maxPlace: { device: o.device, dev: got.dev, split: got.split, override: got.override }, note: `Max mode: attention on the cards and the experts in RAM, ${got.words}.${got.notes.length ? ` ${got.notes.join(' ')}` : ''}` };
}

/**
 * Bytes one layer reads for each word: the tensors a word reads (only the chosen experts of a mixture-of-experts model,
 * one row of the token table; src/gguf.ts wordBytes) shared over the layers. DeepSeek-V4-Flash reads about 113 MB a
 * layer of its 2 GB. 0 (its share of the file) when the file cannot be read.
 */
export async function readPerLayer(o: { layers: number; path?: string | null; experts?: { count: number; used: number } | null }): Promise<number> {
  if (!o.path) return 0;
  if (o.experts && o.experts.count > 0 && !(o.experts.used > 0)) return 0;
  const read = await wordBytes(o.path, o.experts ? { experts: o.experts.count, used: o.experts.used } : null);
  return read ? read / (o.layers + 1) : 0;
}
