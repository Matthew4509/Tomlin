// Max mode with expert parallel (cluster part 2, phase 6): a mixture-of-experts model about to load over lending PCs runs
// on the patched runner (docs/cluster-native/patches 0001 to 0003) with each PC working through its own run of every
// layer's experts at the same time. The layout comes from src/cluster/eplayout.ts; this file finds the runner, lists
// the devices with every lender connected, and reads the model's parts and the PCs' speeds. Null (the layer split stays,
// with the reason in the log) when the patched runner is not here, the lenders run another build, or the plan cannot
// hold the model.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { quantFamily, tensorParts } from '../gguf.ts';
import { findServer, type ChatRun } from '../llama.ts';
import { listWith, parseListed, type Listed } from '../maxplace.ts';
import { planEp, type EpLayout, type EpLender } from '../cluster/eplayout.ts';
import { forHello, speedFor, speedNow } from '../speedtest.ts';
import { lendCaps } from './lendcaps.ts';
import { lendersOf } from './maxplaced.ts';
import { log } from '../log.ts';

/** The build the expert patches are made for: the lenders' stock RPC servers must run the same one. */
export const EXPERT_BUILD = 'b11284';
/** The patched runner's folder inside TOMLIN's runtime folder. */
export const EXPERT_RUNNER_DIR = 'llama-cuda-experts';
/** The width of the hidden state crossing the network when the file does not say (4096 values: 16 KB a layer, under 0.2 ms on gigabit). */
const HIDDEN = 4096;

const seen = new Map<string, boolean>();

/** Whether a runner folder's llama.dll has the expert patches (it reads LLAMA_EXPERT_SPLIT); checked once per file and time. */
export function hasExpertSplit(dir: string): boolean {
  const dll = join(dir, 'llama.dll');
  if (!existsSync(dll)) return false;
  const key = `${dll}|${statSync(dll).mtimeMs}`;
  const was = seen.get(key);
  if (was !== undefined) return was;
  const got = readFileSync(dll).includes('LLAMA_EXPERT_SPLIT');
  seen.set(key, got);
  return got;
}

/**
 * The patched runner's llama-server, or null: the folder TOMLIN_EXPERT_RUNNER names, else runtime/llama-cuda-experts
 * (a folder in it is looked in too, as a release zip unpacks), and only when its llama.dll has the expert patches.
 */
export function expertRunner(runtimeDir: string | string[], said = process.env.TOMLIN_EXPERT_RUNNER ?? ''): string | null {
  // The home's runtime folder (where runners are put by hand or downloaded) and the app folder's own.
  for (const dir of [said.trim(), ...[runtimeDir].flat().map(r => join(r, EXPERT_RUNNER_DIR))].filter(Boolean)) {
    const exe = findServer(dir);
    if (exe && hasExpertSplit(join(exe, '..'))) return exe;
  }
  return null;
}

/**
 * Each lender's RAM device in the runner's list: a lender lists its card first and its RAM last; one device from a lender
 * not known to have a card counts as its RAM (the same rule as src/layersplit.ts). Null for a lender whose RAM is not seen.
 */
export function lenderRam(listed: Listed[], endpoint: string, hasCard: boolean | null): Listed | null {
  const devs = listed.filter(x => /^RPC\d+$/.test(x.name) && x.what === endpoint);
  if (devs.length >= 2) return devs[devs.length - 1];
  if (devs.length === 1 && hasCard !== true) return devs[0];
  return null;
}

export interface EpLoad {
  exe: string;
  /** The run fields this load sets: the lenders, the devices and layers, the batch, and the runner's environment. */
  run: Pick<ChatRun, 'rpc' | 'maxPlace' | 'env' | 'batch'>;
  note: string;
  layout: EpLayout;
}

/**
 * `runtimeDir`: TOMLIN's runtime folder or folders (the home's, then the app's); `max`: what maxLoad said (the lenders' --rpc addresses and names, and the build
 * they all run); `cards`: this PC's cards it is set to use. Only for the CUDA runner.
 */
export async function maxExperts(o: { runtimeDir: string | string[]; path: string; name: string; experts: number; used: number; cache: number; cards?: string[]; max: { endpoints: string[]; lent: string[]; ids?: string[]; build?: string } | null }): Promise<EpLoad | null> {
  const skip = (why: string) => {
    log.info('max', `${o.name}: expert parallel not used: ${why}.`);
    return null;
  };
  if (!o.max?.endpoints.length) return null;
  if (!(o.experts > 1)) return null;
  const exe = expertRunner(o.runtimeDir);
  if (!exe) return skip(`no runner with the expert patches is installed (${EXPERT_RUNNER_DIR})`);
  if (o.max.build && o.max.build !== EXPERT_BUILD) return skip(`the lending PCs run ${o.max.build}, and the expert runner is ${EXPERT_BUILD}`);
  const parts = await tensorParts(o.path);
  if (!parts) return skip('the model\'s tensor list could not be read');
  const listed = parseListed(await listWith(exe, o.max.endpoints).catch(() => ''));
  const cards = listed.filter(x => !/^(RPC\d+|CPU)$/.test(x.name));
  const card = (o.cards?.length ? cards.find(x => o.cards!.includes(x.name)) : cards[0]) ?? null;
  const kind = await quantFamily(o.path);
  const here = speedFor(forHello(speedNow()), kind);
  const caps = await lendCaps().catch(() => ({}));
  const lenders: EpLender[] = [];
  const given = lendersOf(o.max, caps, kind);
  for (const l of given) {
    const ram = lenderRam(listed, l.endpoint, l.hasCard);
    if (!ram) return skip(`"${l.name}"'s RAM is not in the runner's device list`);
    lenders.push({ name: l.name, endpoint: l.endpoint, ram, ramFree: ram.free, ramTotal: ram.total, ramSpeed: l.speed?.ram ?? 0, ...(l.capRam ? { capRam: l.capRam } : {}) });
  }
  const layout = planEp(
    { name: o.name, parts, experts: o.experts, used: o.used, hidden: HIDDEN, kv: o.cache },
    { name: 'this PC', ramFree: freemem(), ramTotal: totalmem(), ramSpeed: here?.ram ?? 0, card, cardSpeed: here?.card ?? 0 },
    lenders,
  );
  if ('why' in layout) return skip(layout.why);
  const est = layout.msPerWord ? ` About ${(1000 / layout.msPerWord).toFixed(1)} tok/s by the speed tests (an estimate).` : '';
  log.info('max', `${o.name}: ${layout.words}; LLAMA_EXPERT_SPLIT=${layout.env.LLAMA_EXPERT_SPLIT} -dev ${layout.dev.join(',')} -ts ${layout.split.join(',')} -ngl ${layout.ngl} -b ${layout.batch} -ub ${layout.batch}${layout.override.length ? ` -ot ${layout.override.join(',')}` : ''}.${est}`);
  return {
    exe,
    run: { rpc: o.max.endpoints, maxPlace: { device: 'cuda', dev: layout.dev, split: layout.split, override: layout.override, ngl: layout.ngl }, env: layout.env, batch: layout.batch },
    note: `Max mode, ${layout.words} (the PCs work on every layer at the same time).${layout.notes.length ? ` ${layout.notes.join(' ')}` : ''}`,
    layout,
  };
}
