// Max mode, this PC's side as the borrower: llama-server's --rpc connects to a port on 127.0.0.1 here, and each
// connection becomes a sealed stream (src/linkstream.ts) to the linked PC that lends its card (src/jobrun/maxnode.ts).
// The PCs borrowed from: with a saved cluster (src/cluster/members.ts) its members while it is switched on, none while it
// is off; with none saved, every linked PC whose owner ticked "Allow to be used as part of a cluster" there (its hello says
// so), unless "Don't borrow from it" is ticked for it here (Network, Linked PCs; saved on each). Either way only for a model
// that does not fit this PC well alone (src/cluster/engine.ts borrowRule). TOMLIN_MAX, when it names PCs (their names or
// ids, comma-separated), overrides all of it.
import { request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import * as share from '../share.ts';
import * as link from '../link.ts';
import { joinWhenOpen, newNonce, streamKeys } from '../linkstream.ts';
import type { Remote } from '../store.ts';
import { log } from '../log.ts';
import { backupsOnly, backupsOnlyWhy, lastHello, onHomeNetwork } from './links.ts';
import { pickBuild, type Member, type Need, type Option } from '../runnermatch.ts';
import type { RunnerHello } from '../runnerpush.ts';
import { d } from './shared.ts';
import { MAX_DOOR, MAX_UPGRADE } from './maxnode.ts';
import { lenderRamCap } from '../maxplace.ts';
import { lenderLost } from './lendcaps.ts';
import { borrowRule, type AloneFacts } from '../cluster/engine.ts';
import { hasCluster, type ClusterSet } from '../cluster/members.ts';
import { loaderGaps, type ClusterHello, type LoaderFacts } from '../cluster/loader.ts';
import { pcLabels } from '../brains.ts';

/** TOMLIN_MAX when it only switches Max mode on ("1", "on", "true", "yes") or is empty: it names no PC. */
const namesNone = (said: string) => !said.trim() || /^(1|on|true|yes)$/i.test(said.trim());

/** What Max mode reads of a linked PC's last hello: what it can do, its memory, and its owner's ticks. */
export type HelloLook = { can: string[]; memory: unknown; allow?: { lend?: boolean } | null; away?: string | null; guest?: unknown; cluster?: ClusterHello | null } | null;
const helloNow = (id: string): HelloLook => lastHello(id);

/** Whether linked PC `r` is borrowed from with no PC named: its owner allows it (its last hello) and it is not opted out or Backups only here. */
export const lendsHere = (r: Remote, h: HelloLook): boolean => h?.allow?.lend === true && r.noBorrow !== true && r.backupsOnly !== true;

/** A cluster member lends when its owner allows it and it is not Backups only ("Don't borrow from it" is for the loose rule; the cluster replaces it). */
export const lendsInCluster = (r: Remote, h: HelloLook): boolean => h?.allow?.lend === true && r.backupsOnly !== true;

/**
 * The linked PCs to borrow from: those named in TOMLIN_MAX (by name or id); else, with a saved cluster, its members that
 * can lend while it is on (and none while it is off); else every one that allows it (lendsHere).
 */
export function maxPcs(said = process.env.TOMLIN_MAX ?? '', remotes: Remote[] = d.store.peek()?.remotes ?? [], hello: (id: string) => HelloLook = helloNow, cluster: ClusterSet | undefined = d?.store?.peek()?.cluster): Remote[] {
  if (namesNone(said)) return maxCandidates(remotes, cluster).filter(r => hello(r.id)?.allow?.lend === true);
  const names = said.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return remotes.filter(r => names.includes(r.name.toLowerCase()) || names.includes(r.id.toLowerCase()));
}

/**
 * The linked PCs this PC may borrow from before their owners' ticks are read: with a saved cluster its members while it is
 * on (none while it is off), Backups only left out; with none saved, every linked PC not set to "Don't borrow from it" or
 * Backups only here. maxPcs keeps those whose owner allows it (lendsHere, lendsInCluster); the chat's Max switch
 * (src/maxmode.ts maxGate) says which step leaves them out.
 * A cluster this PC stays out of (src/cluster/loader.ts) borrows nothing here: its loader borrows, there.
 */
export function maxCandidates(remotes: Remote[], cluster: ClusterSet | undefined): Remote[] {
  if (hasCluster(cluster)) return cluster.on && !cluster.out ? cluster.members.flatMap(id => remotes.filter(r => r.id === id && r.backupsOnly !== true)) : [];
  return remotes.filter(r => r.noBorrow !== true && r.backupsOnly !== true);
}

/** Why a member of the switched-on cluster cannot lend now, in plain words ('' when it can). */
export function memberWhy(r: Remote, h: HelloLook): string {
  if (r.backupsOnly === true) return 'it is set to Backups only here';
  if (!h) return 'it is not answering (off, asleep, or TOMLIN is not running there)';
  if (!h.can.includes('max')) return 'its TOMLIN has no Max mode: update it there';
  if (h.allow?.lend !== true) return 'its owner has not ticked "Allow to be used as part of a cluster" there';
  return '';
}

/** A member as the loader choice sees it (src/cluster/loader.ts): this PC's link to it and its last hello. */
export function loaderFacts(r: Remote, h: HelloLook): LoaderFacts {
  const m = (h?.memory ?? null) as { cards?: { total?: unknown }; gpu?: { total?: unknown } | null; ram?: { total?: unknown } } | null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return {
    id: r.id, name: labelOf(r), answering: !!h, away: !!h?.away, guest: r.role === 'guest', backupsOnly: r.backupsOnly === true,
    card: n(m?.cards?.total) || n(m?.gpu?.total), ram: n(m?.ram?.total), cluster: h?.cluster ?? null,
  };
}

/** The members of `cluster` as the loader choice sees them (a member no longer linked is left out). */
export const membersFacts = (cluster: ClusterSet, remotes: Remote[], hello: (id: string) => HelloLook = helloNow): LoaderFacts[] =>
  cluster.members.flatMap(id => { const r = remotes.find(x => x.id === id); return r ? [loaderFacts(r, hello(id))] : []; });

/**
 * One line for each member of the switched-on cluster that cannot lend now, naming it (empty with no cluster, or off).
 * With this PC out of the cluster: what stops its loader answering for the cluster now (it borrows, not this PC).
 */
export function clusterGaps(remotes: Remote[] = d?.store?.peek()?.remotes ?? [], hello: (id: string) => HelloLook = helloNow, cluster: ClusterSet | undefined = d?.store?.peek()?.cluster): string[] {
  if (!hasCluster(cluster) || !cluster.on) return [];
  if (cluster.out) {
    const facts = membersFacts(cluster, remotes, hello);
    return loaderGaps(facts.find(f => f.id === cluster.loader), facts);
  }
  const names = pcLabels(remotes);
  return cluster.members.flatMap(id => {
    const r = remotes.find(x => x.id === id);
    const why = r ? memberWhy(r, hello(id)) : 'it is no longer linked';
    return why ? [`Cluster member "${r ? names[id] ?? r.name : id}" is left out: ${why}.`] : [];
  });
}

/** A linked PC's name as lists show it: told apart from another with the same name (two "Worker PC"s) by its computer's name or address. */
export const labelOf = (r: Remote): string => {
  const linked = d?.store?.peek()?.remotes ?? [];
  return pcLabels(linked.some(x => x.id === r.id) ? linked : [r])[r.id] ?? r.name;
};

/** `remotes` with linked PC `id` borrowed from again (on) or set to "Don't borrow from it" (off); null when no such PC is linked. */
export function setBorrow(remotes: Remote[], id: string, on: boolean): Remote[] | null {
  if (!remotes.some(r => r.id === id)) return null;
  return remotes.map(r => {
    if (r.id !== id) return r;
    // The old "Borrow memory from it" tick (2.0.89 and before) goes with any change: it means nothing now.
    const { noBorrow: _was, borrowMax: _old, ...rest } = r as Remote & { borrowMax?: boolean };
    return on ? rest : { ...rest, noBorrow: true };
  });
}

/**
 * The memory Max mode's lending PCs add to a load here, from their last hellos (P1-4, 3 Nov: Qwen3-Next-80B Q4 was refused,
 * "needs 48.8 GB, 37.2 GB free", with a PC lending). A PC lends its card (free, less 0.5 GB), or with no card its RAM
 * (free, less 4.5 GB: src/maxplace.ts lendRamCap, the aim the placement spreads by), as src/server/panes.ts rpcProgram
 * picks. Nothing for a PC with no Max, no memory reading, or a card whose memory it could not read. With "all" the RAM
 * counts beside the card.
 */
export function lentBytes(hellos: ({ can: string[]; memory: unknown } | null)[], all = false): number {
  const GB = 2 ** 30;
  let sum = 0;
  for (const h of hellos) {
    if (!h?.can.includes('max') || !h.memory || typeof h.memory !== 'object') continue;
    const m = h.memory as { cards?: { count?: unknown }; ram?: { total?: unknown; used?: unknown }; gpu?: { total?: unknown; used?: unknown } | null };
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const card = n(m.cards?.count) > 0 ? (m.gpu ? n(m.gpu.total) - n(m.gpu.used) - 0.5 * GB : 0) : 0;
    // The same cap both ways (13 Nov 2026: a 24 GB PC lending free less 3 GB crashed): free, less the 4 GB it aims to keep and 0.5 GB for the runner.
    // A small PC lends at most about half its free RAM (src/maxplace.ts lenderRamCap: a 24 GB PC stalled at 14 to 17 GB).
    const ram = lenderRamCap(n(m.ram?.total) - n(m.ram?.used), n(m.ram?.total));
    // Card only (the default): the card, or the RAM when there is no card. "all": the card and the RAM together.
    const free = n(m.cards?.count) > 0 ? card + (all ? Math.max(0, ram) : 0) : ram;
    sum += Math.max(0, free);
  }
  return sum;
}

/**
 * Whether this PC asks linked PCs to lend their card, RAM and cores together. It does by default (2.0.92): a linked PC's
 * own permission to be used as part of a cluster covers its RAM and cores as well as its card, and a mixture-of-experts
 * model over lenders (expert parallel, src/jobrun/epload.ts) needs their RAM. TOMLIN_MAX_SHARE=card (or cards, off, no,
 * none; hidden, like TOMLIN_MAX) asks for the card memory only, as 2.0.91 and before did unless it said "all".
 */
export const shareAll = (said = process.env.TOMLIN_MAX_SHARE ?? ''): boolean => !/^(card|cards|off|no|none|false|0)$/.test(said.trim().toLowerCase());

/** lentBytes for the PCs borrowed from now (0 with none). */
export function maxLent(said = process.env.TOMLIN_MAX ?? '', hello: (id: string) => HelloLook = helloNow, remotes?: Remote[]): number {
  return lentBytes(maxPcs(said, remotes, hello).map(r => hello(r.id)), shareAll());
}

/**
 * How long a stream may take to open: more than the lending PC's own waits from cold (src/maxlend.ts: its presence
 * reading, its RPC server's start, reaching it), which came to nearly 30 s on 3 Nov, the old limit here.
 */
export const OPEN_MS = 60_000;

/**
 * A stream to a lending PC is checked with TCP keep-alive after this long without traffic. A lender that loses power or
 * falls off the network sends no close (13 Nov 2026: the HP 800 dropped off mid-load), so without it the stream, the
 * runner here and the loan there would wait forever; with it the stream ends within about half a minute, the runner
 * stops with a plain line, and the lender's loan ends on its own.
 */
export const WIRE_KEEPALIVE_MS = 15_000;

/** Keep-alive on a stream's socket (src/jobrun/maxnode.ts uses it on the lending side too). */
export function keepWireAlive(socket: { setKeepAlive?: (on: boolean, ms: number) => unknown }): void {
  socket.setKeepAlive?.(true, WIRE_KEEPALIVE_MS);
}

/** Opens one sealed stream to `r`: its socket, this stream's keys, and any bytes read past the answer. Throws in plain words. */
export async function openWire(r: Remote, ms = OPEN_MS, build = d.rpcProgram?.()?.build ?? ''): Promise<{ socket: Socket; keys: { send: Buffer; read: Buffer }; head: Buffer }> {
  if (backupsOnly(r.id)) throw new Error(backupsOnlyWhy(labelOf(r)));
  const linkKeys = link.keysOf(r.key);
  if (!linkKeys) throw new Error(`"${labelOf(r)}" was linked before links were encrypted. Link it again.`);
  await onHomeNetwork(r);
  const hostNonce = newNonce();
  const sealed = link.sealRequest(linkKeys, MAX_DOOR, { nonce: hostNonce.toString('base64url'), build, ...(shareAll() ? { share: 'all' } : {}) });
  const id = link.requestId(sealed.box);
  const u = new URL(r.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: MAX_DOOR, method: 'GET', headers: { connection: 'Upgrade', upgrade: MAX_UPGRADE, authorization: `Link ${share.hashToken(r.token)}`, 'x-link': sealed.box } });
    req.setTimeout(ms, () => req.destroy(new Error(`"${labelOf(r)}" did not answer in ${Math.round(ms / 1000)} seconds.`)));
    req.on('error', e => reject(new Error((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? `"${labelOf(r)}" could not be reached (TOMLIN not running there, or sharing off).` : (e as Error).message)));
    req.on('response', res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => {
        let error = '';
        try {
          error = String((JSON.parse(text) as { error?: unknown }).error ?? '');
        } catch {
          // not JSON: an older TOMLIN without the door
        }
        reject(new Error(error || `"${labelOf(r)}" runs a TOMLIN without Max mode (it answered ${res.statusCode}). Update it there.`));
      });
    });
    req.on('upgrade', (res, socket, head) => {
      try {
        const said = link.openAnswer(linkKeys, id, 0, res.headers['x-link']) as { nonce?: unknown };
        const nodeNonce = Buffer.from(String(said.nonce ?? ''), 'base64url');
        keepWireAlive(socket);
        resolve({ socket, keys: streamKeys(linkKeys, hostNonce, nodeNonce, 'host'), head });
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
    req.end();
  });
}

/**
 * Why a PC cannot lend to this one for want of the same llama.cpp build ('' when it can, or when either side does not say:
 * an older TOMLIN). b11284 here and b12250 there failed at the handshake, "RPC server version mismatch" (12 Nov 2026).
 */
export function buildClash(mine: string, name: string, theirs: string[] | undefined): string {
  if (!mine || !theirs?.length || theirs.includes(mine)) return '';
  // Said as it is: a mix of builds crashes Max mode (b11284 with b12250 did), so that PC is left out, never tried.
  return `"${name}" lends with llama.cpp ${theirs.join(' or ')} and this PC runs ${mine}: Max mode needs the same build on every PC (a mix crashes), so "${name}" was left out of this load and the model runs without it. To use it, give both the same build: send the ${mine} runner to "${name}" (Models, Model runners, Send to), or hold this model here to a ${theirs[0]} runner (its gear, Runner).`;
}

/** What a linked PC's hello says it can run (src/runnermatch.ts Option); null when it says nothing (an older TOMLIN). */
export function optionsOf(runner: RunnerHello | null | undefined, builds: (pin: string) => string): { options: Option[] | null; no: Record<string, string> } {
  if (!runner) return { options: null, no: {} };
  const no: Record<string, string> = {};
  for (const [pin, p] of Object.entries(runner.pins ?? {})) {
    const b = builds(pin);
    if (b && p.why && !no[b]) no[b] = p.why.replace(/^"[^"]*" /, '').replace(/\.$/, '');
  }
  if (runner.can) return { options: runner.can.map(o => ({ ...o })), no };
  // A TOMLIN that lists the builds it lends with but not how: what it lists, unpacked.
  if (runner.rpc?.length) return { options: runner.rpc.map(build => ({ build, device: 'cuda' as const, pin: '', have: true, tested: false })), no };
  return { options: null, no };
}

/** The last choice of build for a Max mode load, for the page: what is needed before the other PCs can lend. */
let lastMatch: { at: string; build: string | null; needs: Need[]; line: string } | null = null;
export const matchView = () => lastMatch;

/** One port here for each lending PC; llama-server may open several connections to it. */
const ports = new Map<string, { server: Server; port: number; last: string }>();

async function portFor(r: Remote): Promise<number> {
  const had = ports.get(r.id);
  if (had) return had.port;
  const entry = { server: createServer(), port: 0, last: '' };
  entry.server.on('connection', (local: Socket) => {
    const now = (d.store.peek()?.remotes ?? []).find(x => x.id === r.id) ?? r;
    const who = labelOf(now);
    streamOpened(who);
    local.once('close', () => streamClosed(who));
    joinWhenOpen(local, () => openWire(now)).then(why => {
      if (why) {
        entry.last = why;
        log.warn('max', `The stream to "${who}" ended: ${why}. If a model was loaded on it, it stops; load it again to use the PCs that lend now.`);
        // A lender that stopped answering while it held layers in its RAM is given less from now on.
        void lenderLost(now.id, who, why);
      }
    }, (e: Error) => {
      entry.last = e.message;
      log.warn('max', `"${who}" did not lend: ${e.message}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(0, '127.0.0.1', () => resolve());
  });
  entry.port = (entry.server.address() as { port: number }).port;
  ports.set(r.id, entry);
  return entry.port;
}

/**
 * One Max mode loan at a time from this PC (13 Nov 2026: a second load with the first still loaded failed with "RPC
 * server did not answer": a lender's RPC server serves the first model's connections and cannot take the next). The
 * runner's streams open now, by lender name, and the model that was given the lenders last.
 */
const liveStreams = new Map<string, number>();
let lastBorrower = '';
export function streamOpened(name: string): void {
  liveStreams.set(name, (liveStreams.get(name) ?? 0) + 1);
}
export function streamClosed(name: string): void {
  const n = (liveStreams.get(name) ?? 0) - 1;
  if (n > 0) liveStreams.set(name, n);
  else liveStreams.delete(name);
}
/** The lenders a runner here still holds streams to. */
export const lendersInUse = (): string[] => [...liveStreams.keys()];

/** Why `model` cannot borrow now ('' when it can): another model here still holds the lenders. */
export function secondLoanWhy(model: string, holder: string, inUse: string[]): string {
  if (!inUse.length || (holder && holder === model)) return '';
  const pcs = inUse.map(n => `"${n}"`).join(' and ');
  const who = holder ? `${holder} is still loaded with Max mode and uses ${pcs}` : `a model here still uses ${pcs} with Max mode`;
  return `Max mode lends the linked PCs to one model at a time, and ${who}. Unload ${holder || 'it'} first, then load ${model} again.`;
}

/** Why `model` (its name) cannot borrow now, asked before anything is unloaded ('' when it can): as maxLoad checks it. */
export const loanBusyWhy = (model: string): string => secondLoanWhy(model, lastBorrower, lendersInUse());

/** Why the last stream to linked PC `id` failed or ended ('' when none did). */
export const lastFault = (id: string) => ports.get(id)?.last ?? '';

/**
 * For a chat model about to load: the --rpc addresses of the PCs that lend now, and a line for each that does not.
 * Each is asked first (one stream opened and closed), so a PC that refuses is left out instead of failing the load.
 */
export interface MaxLoad {
  endpoints: string[];
  lent: string[];
  /** The linked PC ids of `lent`, same order: later steps find a lender by id, not by a name another PC may share or the cluster may no longer list. */
  ids?: string[];
  notes: string[];
  /** The llama.cpp build every PC in the set runs (this PC's runner must be that one); unset: nothing borrowed. */
  build?: string;
  /** Runners still to install before the other PCs can lend: asked first, never installed by this. */
  needs?: Need[];
  /** The load must not start (plain words): another model here holds the lenders now. */
  refuse?: string;
}

export async function rpcFor(pcs = maxPcs(), host: Option[] = d.runner?.options?.() ?? []): Promise<MaxLoad> {
  const endpoints: string[] = [];
  const lent: string[] = [];
  const ids: string[] = [];
  const notes: string[] = [];
  // One build for the whole set (src/runnermatch.ts): what each PC says it can run safely, this PC's own list too.
  const buildOfPin = (pin: string) => d.runner?.runtimes.buildOfPin(pin) ?? '';
  const members: Member[] = [{ name: 'This PC', host: true, options: host }, ...pcs.map(r => ({ id: r.id, name: r.name, host: false, ...optionsOf(lastHello(r.id)?.runner, buildOfPin) }))];
  const chosen = pickBuild(members);
  lastMatch = { at: new Date().toISOString(), build: chosen.build, needs: chosen.needs, line: chosen.line };
  if (chosen.line) notes.push(`Max mode: ${chosen.line}`);
  if (chosen.needs.length) return { endpoints, lent, notes, ...(chosen.build ? { build: chosen.build } : {}), needs: chosen.needs };
  const mine = chosen.build ?? '';
  for (const r of pcs.filter(x => chosen.lenderIds.includes(x.id))) {
    const clash = buildClash(mine, labelOf(r), lastHello(r.id)?.runner?.rpc);
    if (clash) {
      notes.push(`Max mode: ${clash}`);
      continue;
    }
    try {
      const { socket } = await openWire(r, OPEN_MS, mine);
      socket.destroy();
      endpoints.push(`127.0.0.1:${await portFor(r)}`);
      lent.push(labelOf(r));
      ids.push(r.id);
    } catch (e) {
      notes.push(`Max mode: ${(e as Error).message}`);
    }
  }
  return { endpoints, lent, ids, notes, ...(chosen.build && endpoints.length ? { build: chosen.build } : {}) };
}

/** Whether any of `pcs` lends a graphics card (its hello says it has one): a dense model too big for this PC's card gains from one. */
export const lendsCard = (pcs: Remote[], hello: (id: string) => HelloLook = helloNow): boolean =>
  pcs.some(r => Number((hello(r.id)?.memory as { cards?: { count?: unknown } } | null | undefined)?.cards?.count) > 0);

/**
 * Max mode for a chat model about to load (`model`, its name): null with no PC to borrow from; otherwise rpcFor those PCs, and a note when TOMLIN_MAX names none saved here. Every load writes one line to the log, borrowed or not (2 Nov: two
 * loads left no word, and a split that never happened could not be told from one refused).
 * `alone`: how the model fits this PC by itself. With it, a model that fits well alone is not split (src/cluster/engine.ts
 * borrowRule: a split of a model that fits one PC was slower, 3 and 14 Nov 2026); the log says which way it went and why.
 * TOMLIN_MAX naming PCs skips that rule (the speed tests force a split with it).
 */
export async function maxLoad(model: string, said = process.env.TOMLIN_MAX ?? '', pcs = maxPcs(said), ask: (pcs: Remote[], host?: Option[]) => Promise<MaxLoad> = rpcFor, host?: Option[], o: { alone?: AloneFacts; hello?: (id: string) => HelloLook } = {}): Promise<MaxLoad | null> {
  // "1", "on", "true" or "yes" only switches Max mode on (a lending PC): it names no PC to borrow from (3 Nov, the
  // Worker PC noted "no linked PC here is called "1"" on every load).
  // A switched-on cluster whose members cannot lend now: said by name, never a silent load on this PC alone.
  // A cluster this PC stays out of is not for loads here: its gaps are about its loader, said on the Cluster page.
  const gaps = namesNone(said) && !d?.store?.peek()?.cluster?.out ? clusterGaps(undefined, o.hello) : [];
  if (namesNone(said) && !pcs.length) {
    if (!gaps.length) return null;
    log.info('max', `${model}: the cluster is on but no member can lend, so it runs on this PC alone. ${gaps.join(' ')}`);
    return { endpoints: [], lent: [], notes: gaps };
  }
  const named = said.split(',').map(x => x.trim()).filter(Boolean).map(x => `"${x}"`).join(' or ');
  const who = pcs.map(r => `"${labelOf(r)}"`).join(' and ');
  let why = '';
  if (pcs.length && namesNone(said) && o.alone) {
    const rule = borrowRule(o.alone, lendsCard(pcs, o.hello));
    if (!rule.borrow) {
      log.info('max', `${model}: not borrowed, runs on this PC alone (${who} allow${pcs.length === 1 ? 's' : ''} it): ${rule.words}.`);
      return { endpoints: [], lent: [], notes: [`Max mode: not used for ${model}: ${rule.words}.`] };
    }
    why = ` Why: ${rule.words}.`;
  }
  const busy = pcs.length ? loanBusyWhy(model) : '';
  if (busy) {
    log.info('max', `${model}: load refused before it started: ${busy}`);
    return { endpoints: [], lent: [], notes: [], refuse: busy };
  }
  const asked: MaxLoad = pcs.length ? await ask(pcs, host) : { endpoints: [], lent: [], notes: [`Max mode: no linked PC here is called ${named} (TOMLIN_MAX names linked PCs by their name or id, with commas between).`] };
  const max: MaxLoad = gaps.length ? { ...asked, notes: [...gaps, ...asked.notes] } : asked;
  const got = max.lent.length ? `borrowing ${max.lent.map(n => `"${n}"`).join(' and ')} (--rpc ${max.endpoints.join(',')})` : 'nothing borrowed';
  log.info('max', `${model}: ${got}.${why}${max.notes.length ? ` ${max.notes.join(' ')}` : ''}`);
  if (max.endpoints.length) lastBorrower = model;
  return max;
}
