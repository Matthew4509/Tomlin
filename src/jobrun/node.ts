// This PC as a node for other PCs: its share settings and its worker door. Linking other PCs to this one is
// linking.ts; giving way to its owner ("I need to use the pc") is giveway.ts.
import { statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as jobs from '../jobs.ts';
import * as share from '../share.ts';
import * as link from '../link.ts';
import { everyFew, type AskOpts, type ChatTurn } from '../engine.ts';
import * as brains from '../brains.ts';
import { checkMessage, REFUSAL } from '../filter.ts';
import * as nodestaff from '../nodestaff.ts';
import * as carry from '../carry.ts';
import * as update from '../update.ts';
import { cleanRid, Outbox, type Follower, type Kept, type Lock } from '../outbox.ts';
import { inScope, scope } from '../meter.ts';
import { log } from '../log.ts';
import { type Send, d, sleep } from './shared.ts';
import { brainForRef, localBrain } from './who.ts';
import { actionBusy } from './actions.ts';
import { askAnswered, comeBack, goAway } from './giveway.ts';

// ---- This PC as a worker for other PCs (off unless its owner turns it on) ----

export let shareState: share.ShareState = { ...share.DEFAULT_SHARE };
let shareServer: Server | null = null;
let shareError = '';
const guard = new share.PinGuard();
/** Link-request nonces already answered while this app runs (the newest 500): a request sent twice is refused. */
const pairNonces = new Set<string>();
export function usePairNonce(nonce: string): boolean {
  if (!nonce || pairNonces.has(nonce)) return false;
  pairNonces.add(nonce);
  if (pairNonces.size > 500) pairNonces.delete(pairNonces.values().next().value!);
  return true;
}

export function lanAddresses(): string[] {
  return lanList().map(n => n.address);
}

/** This PC's home-network addresses with the connection each is on ("Wi-Fi", "Ethernet"), as Windows names them. */
export function lanList(): { address: string; via: string }[] {
  return Object.entries(networkInterfaces()).flatMap(([via, list]) => (list ?? [])
    .filter(n => n.family === 'IPv4' && !n.internal && share.isPrivateAddress(n.address))
    .map(n => ({ address: n.address, via })));
}

export function shareView() {
  return { on: shareState.on, listening: !!shareServer, error: shareError, port: shareState.port, name: shareState.name, code: shareState.code, pinOn: shareState.pinOn, pin: shareState.pinOn ? shareState.pin : '', addresses: lanList().map(n => ({ address: `${n.address}:${shareState.port}`, via: n.via })), paired: shareState.paired.map(({ name, at, key, hash }) => ({ name, at, old: !key, id: String(hash ?? '').slice(0, 12) })), away: shareState.away?.since ?? null, autostart, appLock: d.appLockOn(), models: shareState.models ?? [], allow: carry.cleanAllow(shareState.allow), kept: keptNow, projects: projectsNow.map(({ key, name, at, files, backups, folder }) => ({ key, name, at, files, backups, folder })), restarts: d.update.restarts, updated: shareState.updated?.version === d.version ? shareState.updated : null, inUse: linkedUse(), shareable: [...d.chatList().map(m => ({ id: m.id, name: m.name, bytes: m.bytes, kind: 'chat' })), ...d.pictureModels().filter(m => m.installed).map(m => ({ id: m.id, name: pictureName(m), bytes: m.bytes ?? 0, kind: 'image' }))] };
}

/** Restore points kept here for linked PCs (whose, how many), read again after one comes in and once a minute. */
let keptNow: Awaited<ReturnType<typeof carry.keptHere>> = [];
/** Linked PCs' projects backed up here (a git repository for each), for this page. */
let projectsNow: Awaited<ReturnType<typeof carry.projectsHere>> = [];
const readKept = () => Promise.all([
  carry.keptHere(d.carry.keptRoot).then(k => void (keptNow = k), () => undefined),
  carry.projectsHere(d.carry.keptRoot).then(k => void (projectsNow = k), () => undefined),
]);

/**
 * For the lock screen: whether this PC is a node, since when (and until when) it is logged out, the request sent to the
 * main PC and its answer, and an update coming in ("Keep this window open").
 */
export function nodeView() {
  const a = shareState.ask;
  return { on: shareState.on, away: shareState.away?.since ?? null, until: shareState.away?.until ?? null, name: shareState.name, ask: a ? { hours: a.hours, at: a.at, answer: a.answer ?? null, by: a.by ?? null, answeredAt: a.answeredAt ?? null } : null, updating: updateNode?.incoming() ?? null, version: d.version, build: update.shortBuild(d.build()) };
}

/**
 * "Send host" on the lock screen (no PIN): "I need to use the pc, please log out for N hours" goes to the main PC in
 * its next hello (within a minute; at once while its page is open). The main PC decides: nothing changes here until
 * it says yes. A new request takes the place of one still waiting.
 */
export async function askHost(hoursIn: unknown): Promise<{ ok: true } | { error: string }> {
  await shareLoaded;
  if (!shareState.on) return { error: 'This PC is not a node, so there is no host to ask.' };
  const hours = share.cleanAskHours(hoursIn);
  if (!hours) return { error: `Pick ${share.ASK_HOURS.join(', ')} hours.` };
  if (shareState.away) return { error: 'TOMLIN is logged out here already: the PC is yours.' };
  shareState.ask = { hours, at: new Date().toISOString() };
  await saveShare();
  return { ok: true };
}

/** When the TOMLIN running here was put here: its update from a linked PC, else when its folder was made. */
let folderMade: string | null = null;
function installedAt(): string | null {
  if (shareState.updated?.version === d.version) return shareState.updated.at;
  if (folderMade === null) {
    try {
      folderMade = statSync(d.update.root).birthtime.toISOString();
    } catch {
      folderMade = '';
    }
  }
  return folderMade || null;
}

export async function saveShare() {
  await d.store.writeJson('share.json', shareState);
}

/** Set once share.json has been read at start: a change asked for before that waits, so it never saves the defaults over it. */
let shareRead: () => void = () => undefined;
export const shareLoaded = new Promise<void>(r => (shareRead = r));

/** The setup code's key, worked out once per code and PIN (scrypt takes about 0.1 s and much memory). */
let pairKeyNow: { code: string; pin: string; key: Promise<Buffer> } | null = null;
function nodePairKey(): Promise<Buffer> {
  const pin = shareState.pinOn ? shareState.pin : '';
  if (!pairKeyNow || pairKeyNow.code !== shareState.code || pairKeyNow.pin !== pin) pairKeyNow = { code: shareState.code, pin, key: link.pairKey(shareState.code, pin) };
  return pairKeyNow.key;
}

/** Where a link's restore points and pushed update are kept here (see share.ts `keep`). */
const keepOf = (who: share.ShareState['paired'][number]) => who.keep ?? who.from ?? who.hash.slice(0, 16);

/** The doors for copies between linked PCs (src/carry.ts): what this PC's owner lets them do is read at each request. Made by startNode. */
let carryNode: ReturnType<typeof carry.nodeSide>;

/** The doors for updates pushed by a linked PC (src/update.ts). Made by startNode. */
let updateNode: ReturnType<typeof update.updateSide>;

/** A request's body as bytes (a piece of a file), refused past `limit`. */
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('a piece of a file was larger than a piece may be.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Each answer to a linked PC is sealed with that link's keys (src/link.ts); set per request once its token and seal are checked. */
const sealers = new WeakMap<ServerResponse, { keys: Buffer; id: string; n: number }>();
const taken = new link.Seen();

function workerJson(res: ServerResponse, status: number, value: unknown) {
  const s = sealers.get(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(s ? { v: link.LINK_VERSION, box: link.sealAnswer(s.keys, s.id, 0, value) } : value));
}

/** Starts a stream of events to a linked PC: every event is sealed, its name too. Never sent unsealed. */
function streamTo(res: ServerResponse): Send {
  const s = sealers.get(res);
  if (!s) throw new Error('no sealed link for this answer.');
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
  return (event, data) => {
    if (event === 'error') log.error('serving a linked PC', (data as { text?: string }).text);
    if (!res.destroyed) res.write(link.sealedEvent(s.keys, s.id, ++s.n, event, data));
  };
}

/** A linked PC following an answer here: its sealed stream, with a line every 20 s so it does not give up on a silence. */
function followerOf(res: ServerResponse): Follower {
  const send = streamTo(res);
  const beat = setInterval(() => { if (!res.destroyed) res.write(': still working\n\n'); }, 20_000);
  res.on('close', () => clearInterval(beat));
  return { send, end: () => { clearInterval(beat); if (!res.writableEnded) res.end(); } };
}

/** A finished answer from the outbox, sent again as if it were being written (its words, then done or the fault). */
function replay(res: ServerResponse, k: Kept) {
  const send = streamTo(res);
  if (k.text) send('text', { text: k.text });
  if (k.state === 'done') send('done', k.done ?? {});
  else send('error', { text: k.error ?? 'it stopped part-way.' });
  res.end();
}

/**
 * Answers a linked PC asked for with a request id finish here even when that PC goes away, and wait in this outbox
 * (data/outbox, sealed with that link's keys) until it collects them (src/outbox.ts). Made by startNode.
 */
let box: Outbox;
const lockOf = (keys: Buffer): Lock => ({ seal: (plain, label) => link.sealBytes(link.toHost(keys), plain, label), open: (raw, label) => link.openBytes(link.toHost(keys), raw, label) });
type KeepAt = { owner: string; rid: string; lock: Lock };

/**
 * Runs work for a linked PC. With a request id (`keep`) it runs to its end when that PC goes away, and what it wrote is
 * kept for it; without (an older PC) it stops when that PC's connection closes, as before. `label`: this PC's page line.
 */
/** Who work on this PC is for: the linked PC's name, its link (this PC logs the work under "for-<link>"), and the project it said. */
type ForPc = { pc: string; link: string; project: string };

/** The project a linked PC says a request is for (its job id), or '' (it said none, or an older PC). */
const projectOf = (b: Record<string, unknown>) => (typeof b.project === 'string' && /^[\w-]{1,40}$/.test(b.project) ? b.project : '');

function runFor(res: ServerResponse, keep: KeepAt | null, label: string, forPc: ForPc, work: (send: Send, signal: AbortSignal) => Promise<void>): Promise<void> {
  const served = servingFor(label);
  // Work for a linked PC: what its answers use is added up for the done line (src/meter.ts), not to a project here.
  if (keep) {
    box.start(keep.owner, keep.rid, keep.lock, followerOf(res), (send, signal) => inScope({ project: '', forPc: forPc.pc, forLink: forPc.link, forProject: forPc.project }, () => work(send, signal)).finally(served));
    return Promise.resolve();
  }
  const f = followerOf(res);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  return inScope({ project: '', forPc: forPc.pc, forLink: forPc.link, forProject: forPc.project }, () => work(f.send, ac.signal)).finally(() => {
    served();
    f.end();
  });
}

/** What the answers of the work running now used on this PC (its scope's tally), for the done line; null when nothing. */
function usedHere(): { in: number; cached: number; out: number; ms: number } | null {
  const u = scope.getStore()?.used;
  return u && (u.in || u.cached || u.out) ? { in: u.in, cached: u.cached, out: u.out, ms: u.ms } : null;
}

/**
 * What this PC's page shows while it works for a linked PC (F7 E2): only who it is for, never the words or the
 * picture. One line per piece of work running.
 */
export const serving = new Map<symbol, string>();
function servingFor(text: string): () => void {
  const k = Symbol(text);
  serving.set(k, text);
  return () => void serving.delete(k);
}

/** What this PC's Images pane has, for a manager PC's hello. */
function imageHello() {
  const v = d.imagePane.view;
  const models = d.pictureModels();
  const loaded = v.state === 'connected' ? models.find(m => m.id === v.model) : undefined;
  return { model: loaded?.id ?? null, name: loaded ? String(v.modelName ?? loaded.name).replace(/\s*\(.*\)$/, '') : null, styles: loaded ? brains.STYLES.filter(st => loaded.modes.includes(brains.modeOfStyle(st))) : [], swaps: true, coverage: brains.styleCoverage(models) };
}

/** Models answering a linked PC now: one answer per model at a time (a second PC is told "busy" and asks again). */
const lending = new Set<string>();

/**
 * Models this PC loaded because a linked PC asked for them (not loaded here by its owner), with the PCs using each and
 * when one last did: an answer, or the 3-second meters of a chat with it open there. After 60 seconds of neither, the
 * model is dropped by itself. Someone at this PC chatting on it makes it theirs: it then stays, as their models do.
 * Each PC is known by its link (keepOf), not its name: two PCs both called "TOMLIN" never keep each other's
 * models. `by` holds the names, for the Nodes page.
 */
const loadedForPc = new Map<string, { by: Set<string>; links: Set<string>; at: number }>();
const UNUSED_DROP_MS = 60_000;
function loadedFor(id: string, pc: string, link: string, fresh: boolean) {
  const had = loadedForPc.get(id);
  if (had) {
    had.by.add(pc);
    had.links.add(link);
    had.at = Date.now();
  } else if (fresh) loadedForPc.set(id, { by: new Set([pc]), links: new Set([link]), at: Date.now() });
}
/** The picture model this PC loaded because a linked PC asked to draw on it (one picture model loads at a time). */
let pictureFor: { id: string; by: Set<string>; links: Set<string>; at: number } | null = null;
/**
 * A linked PC is still there: the models loaded for it stay. An answer or a picture keeps all of them; the meters of
 * an open chat (`chatOnly`) keep its chat models only, never the picture model it drew on minutes ago.
 */
function stillThere(link: string, chatOnly = false) {
  for (const v of loadedForPc.values()) if (v.links.has(link)) v.at = Date.now();
  if (!chatOnly && pictureFor?.links.has(link)) pictureFor.at = Date.now();
}

/**
 * The models linked PCs are using on this PC now: loaded for them (dropped by itself after 60 s unused) or answering
 * (drawing) for one now. Shown on this PC's Nodes page, and checked before someone here uses one of them.
 */
export function linkedUse(): { id: string; name: string; kind: 'chat' | 'image'; pcs: string[]; busy: boolean }[] {
  const out: { id: string; name: string; kind: 'chat' | 'image'; pcs: string[]; busy: boolean }[] = [];
  for (const [id, v] of loadedForPc) out.push({ id, name: d.chatList().find(m => m.id === id)?.name ?? id, kind: 'chat', pcs: [...v.by], busy: lending.has(id) });
  for (const id of lending) if (!loadedForPc.has(id)) out.push({ id, name: d.chatList().find(m => m.id === id)?.name ?? id, kind: 'chat', pcs: [], busy: true });
  if (pictureFor) out.push({ id: pictureFor.id, name: pictureName(d.pictureModels().find(m => m.id === pictureFor!.id)) ?? pictureFor.id, kind: 'image', pcs: [...pictureFor.by], busy: drawing });
  else if (drawing && d.imagePane.view.model) out.push({ id: d.imagePane.view.model, name: pictureName(d.pictureModels().find(m => m.id === d.imagePane.view.model)) ?? '', kind: 'image', pcs: [], busy: true });
  return out;
}

/**
 * What someone at this PC would do to linked PCs by using chat model `id` (or, `image`, the picture model): its use by
 * them, or the one it would push out of memory to load. Null when it touches nobody. Said in plain words.
 */
export function impactOf(id: string | null, image = false): string | null {
  const use = linkedUse();
  const who = (u: { pcs: string[] }) => (u.pcs.length ? u.pcs.map(p => `"${p}"`).join(' and ') : 'a linked PC');
  if (image) {
    const u = use.find(x => x.kind === 'image');
    if (!u) return null;
    return u.busy ? `${who(u)} is drawing on ${u.name} on this PC now: your picture waits until theirs is done, and theirs may be slower.` : `${who(u)} is using ${u.name} on this PC: a picture here can make theirs wait, or swap their model out.`;
  }
  if (!id) return null;
  const own = use.find(x => x.kind === 'chat' && x.id === id);
  if (own) return own.busy ? `${who(own)} is getting an answer from ${own.name} on this PC now: yours makes theirs stop or wait.` : `${who(own)} is using ${own.name} on this PC: while it answers you, theirs waits.`;
  if (d.runnerFor(id)) return null;
  const at = d.place(id);
  const out = !('error' in at) && !at.already && at.replaces ? use.find(x => x.kind === 'chat' && x.id === at.replaces) : undefined;
  return out ? `Loading this model here takes ${out.name} out of memory, and ${who(out)} is using it: their next answer has to load it again.` : null;
}

/** The models this PC's owner lets linked PCs use, as they stand now (asked fresh each hello). */
async function sharedNow(): Promise<nodestaff.SharedModel[]> {
  const s = await d.store.settings();
  const pictures = d.pictureModels().filter(m => m.installed);
  const isPicture = (id: string) => pictures.some(m => m.id === id);
  const v = d.imagePane.view;
  return nodestaff.sharedList(shareState.models ?? [], {
    models: [...d.chatList().map(m => ({ ...m, kind: 'chat' as const })), ...pictures.map(m => ({ id: m.id, name: pictureName(m)!, bytes: m.bytes ?? 0, kind: 'image' as const }))],
    ctxOf: id => {
      const p = d.runnerFor(id);
      return (p?.view.state === 'connected' ? d.runOn(p) : d.runOf(s, id)).ctx;
    },
    loaded: id => (isPicture(id) ? v.model === id && v.state === 'connected' : d.runnerFor(id)?.view.state === 'connected'),
    hidden: id => d.isHidden?.(id) === true,
    // A model not loaded is not busy (busy() with no runner would mean "anything, anywhere").
    busy: id => {
      if (isPicture(id)) return drawing || d.imageBusy();
      const p = d.runnerFor(id);
      return lending.has(id) || (!!p && d.busy(p));
    },
  });
}

/**
 * A linked PC's chat (or one prompt) on one of the models this PC lets linked PCs use: who answers (their name, role and
 * notebooks) was put in by that PC; this PC only loads the model when it is not loaded (beside the kept ones when they
 * fit, else in place of the least recently used one not answering) and answers. Busy: refused with busy, so it asks again.
 */
/** How a linked PC asked for its chat: plain (a Default hire), Think; the working streams back once a second. */
function askOpts(b: Record<string, unknown>, send: Send): AskOpts {
  return { plain: b.plain === true, think: b.think === true, onThought: everyFew(1000, (text: string, seconds: number) => send('thinking', { text, seconds })), onReading: everyFew(1000, r => send('reading', r)) };
}

/**
 * Work from a linked PC's queue (it said `queue`): the picture model this PC loaded for linked PCs makes way when a chat
 * model does not fit beside it (the queue sends one thing at a time to each PC, so the other model waits idle). Never one its owner loaded,
 * nor one drawing. True when it was unloaded.
 */
async function pictureMakesWay(): Promise<boolean> {
  const v = d.imagePane.view;
  if (!pictureFor || v.model !== pictureFor.id || v.state !== 'connected' || drawing || d.imageBusy()) return false;
  console.log(`Unloading ${pictureName(d.pictureModels().find(m => m.id === pictureFor!.id)) ?? pictureFor.id} to make room for a chat model a linked PC's queue asked for.`);
  pictureFor = null;
  await d.imagePane.disconnect();
  await sleep(1500);
  return true;
}

/** The other way round: chat models this PC loaded for linked PCs, not answering, make way for a picture model that does not fit. */
async function chatsMakeWay(model: string): Promise<string[]> {
  const out: string[] = [];
  for (const [id] of [...loadedForPc].sort((a, b) => a[1].at - b[1].at)) {
    if (d.pictureFit(model) !== 'no') break;
    const r = d.runnerFor(id);
    if (!r || lending.has(id) || d.busy(r) || r.view.state !== 'connected') continue;
    out.push(d.chatList().find(m => m.id === id)?.name ?? id);
    loadedForPc.delete(id);
    await r.disconnect();
    await sleep(1500);
  }
  if (out.length) console.log(`Unloaded ${out.join(' and ')} to make room for a picture model a linked PC's queue asked for.`);
  return out;
}

async function modelChat(b: Record<string, unknown>, turns: ChatTurn[] | null, ask: { system: string; user: string }, maxTokens: number, res: ServerResponse, forPc: string, keep: KeepAt | null, link: string) {
  const id = String(b.model ?? '');
  const runner = d.runnerFor(id);
  let at = runner ? null : d.place(id);
  if (at && 'error' in at && b.queue === true && (await pictureMakesWay())) at = d.place(id);
  const swapped = at && !('error' in at) && !at.already && at.replaces ? d.runnerFor(at.replaces) : null;
  const busy = lending.has(id) || (!!runner && d.busy(runner)) || (!!swapped && (d.busy(swapped) || lending.has(swapped.view.model ?? '')));
  const why = nodestaff.modelRefusal(id, { ticked: shareState.models ?? [], onPc: x => d.chatList().find(m => m.id === x)?.name ?? null, busy, pcName: shareState.name });
  if (why) return workerJson(res, why.busy ? 409 : 403, why);
  // The asking PC names this one before it ("Worker PC": ...): said once, not twice.
  if (at && 'error' in at) return workerJson(res, 409, { error: at.error });
  const verdict = checkMessage(turns ? turns.at(-1)!.content : ask.user, { recent: [] });
  if (!verdict.ok) return workerJson(res, 400, { error: REFUSAL[verdict.reason] });
  const name = d.chatList().find(m => m.id === id)!.name;
  const fresh = runner?.view.state !== 'connected';
  lending.add(id);
  await runFor(res, keep, `Answering for ${forPc}`, { pc: forPc, link, project: projectOf(b) }, async (send, signal) => {
    try {
      const got = await brainForRef(id, forPc, 'on that PC', text => send('status', { text }), signal);
      loadedFor(id, forPc, link, fresh);
      // Someone at this PC started a chat on it while it loaded: theirs finishes first (it is never cut for a linked PC).
      for (let told = false; !!got.pane && d.busy(got.pane) && !signal.aborted; await sleep(1000)) {
        if (!told) send('status', { text: `${name} is answering someone at that PC first.` });
        told = true;
      }
      if (turns) await got.brain.chat(turns, maxTokens, text => send('text', { text }), signal, askOpts(b, send));
      else await got.brain.ask(ask.system, ask.user, maxTokens, text => send('text', { text }), signal);
      send('done', { model: name, speed: got.brain.last ?? null, thought: got.brain.thought ?? null, usage: usedHere(), ...(got.brain.cut ? { cut: true } : {}) });
    } catch (e) {
      send('error', { text: (e as Error).message });
    } finally {
      lending.delete(id);
      // Stopped (or failed) after it had loaded but before it was counted: still loaded for that PC, so it drops too.
      if (fresh && !loadedForPc.has(id) && d.runnerFor(id)?.view.state === 'connected') loadedFor(id, forPc, link, true);
      stillThere(link);
    }
  });
}

export let drawing = false;

/**
 * A picture for a linked PC. With `model`: one of the picture models this PC lets linked PCs use, loaded first when it
 * is not (in place of the picture model loaded here, when that one is not drawing), drawn as asked. Without (an older
 * PC): on the picture model connected here, or another of this PC's own for the style. One picture at a time: a second
 * PC is told busy and asks again.
 */
async function workerDraw(b: Record<string, unknown>, res: ServerResponse, forPc: string, link: string) {
  const prompt = String(b.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!prompt) return workerJson(res, 400, { error: 'no prompt was sent.' });
  if (b.staff !== undefined) return workerJson(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
  const style = brains.isStyle(b.style) ? b.style : null;
  const size = (n: unknown) => (Number.isInteger(n) && (n as number) >= 64 && (n as number) <= 2048 ? (n as number) : undefined);
  const models = d.pictureModels();
  const want = typeof b.model === 'string' && b.model ? b.model : null;
  if (want) {
    const v = d.imagePane.view;
    const busy = drawing || d.imageBusy() || (v.state === 'loading' && v.model !== want);
    const why = nodestaff.modelRefusal(want, { ticked: shareState.models ?? [], onPc: x => pictureName(models.find(m => m.id === x && m.installed)), busy, pcName: shareState.name });
    if (why) return workerJson(res, why.busy ? 409 : 403, why.busy ? { ...why, error: why.error.replace('is answering something else', 'is drawing something else') } : why);
    return drawShared(models.find(m => m.id === want)!, { prompt, style, width: size(b.width), height: size(b.height) }, res, forPc, link, b.queue === true);
  }
  const v = d.imagePane.view;
  if (v.state !== 'connected') return workerJson(res, 409, { error: 'no picture model is connected on that PC. Its owner connects one in an artist\'s chat there; nothing loads by itself.' });
  if (drawing) return workerJson(res, 409, { error: 'that PC is already drawing a picture for another PC. Try again in a minute.' });
  const loaded = models.find(m => m.id === v.model);
  if (!loaded) return workerJson(res, 409, { error: 'its connected picture model is not one TOMLIN knows.' });
  // Only a picture model its owner ticked for other PCs draws for them; a swap for the style only to another ticked one.
  const ticked = shareState.models ?? [];
  const notLent = nodestaff.modelRefusal(loaded.id, { ticked, onPc: x => pictureName(models.find(m => m.id === x && m.installed)), busy: false, pcName: shareState.name });
  if (notLent) return workerJson(res, 403, notLent);
  drawing = true;
  const send = streamTo(res);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  // A line every 20 s while the model works, so the manager PC does not give up on a long silence.
  const beat = setInterval(() => { if (!res.destroyed) res.write(': still working\n\n'); }, 20_000);
  res.on('close', () => clearInterval(beat));
  try {
    const plan = brains.modelForStyle(style, loaded, models.filter(m => ticked.includes(m.id)), true);
    if (plan.swap) {
      send('progress', { state: 'starting', text: `Switching to ${plan.use.name.replace(/\s*\(.*\)$/, '')} for the style` });
      if (!(await d.swapImage(plan.use.id))) throw new Error(`${plan.use.name} did not load there. Its owner can connect it in an artist's chat there.`);
    }
    const r = await d.draw({ prompt, mode: style ? brains.modeOfStyle(style) : 'custom', width: size(b.width), height: size(b.height), forPc }, p => send('progress', p), ac.signal);
    if ('error' in r) throw new Error(r.error);
    send('picture', { png: r.png.toString('base64'), modelName: r.modelName, modelPrompt: r.modelPrompt, mode: r.mode, seconds: r.seconds, note: plan.note });
  } catch (e) {
    send('error', { text: (e as Error).message });
  } finally {
    drawing = false;
    res.end();
  }
}

/** A picture model's name as people read it ("DreamShaper 8", not its file details), or null when it is not here. */
const pictureName = (m: brains.PictureModel | undefined) => (m ? m.name.replace(/\s*\(.*\)$/, '') : null);

/**
 * A picture on one of the picture models this PC lets linked PCs use: loaded first when it is not (the picture model
 * loaded here makes way, it is not drawing: checked before), then drawn as the linked PC asked (its artist's words are
 * already in the prompt). A model loaded for a linked PC is dropped by itself after 60 s unused, as chat models are.
 */
async function drawShared(model: brains.PictureModel, ask: { prompt: string; style: brains.Style | null; width?: number; height?: number }, res: ServerResponse, forPc: string, link: string, queue = false) {
  drawing = true;
  const send = streamTo(res);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const beat = setInterval(() => { if (!res.destroyed) res.write(': still working\n\n'); }, 20_000);
  res.on('close', () => clearInterval(beat));
  res.on('close', servingFor(`Drawing for ${forPc}`));
  const name = pictureName(model)!;
  try {
    const v = d.imagePane.view;
    const fresh = !(v.model === model.id && v.state === 'connected');
    if (fresh) {
      // From a linked PC's queue: chat models loaded here for linked PCs make way when it does not fit.
      const made = queue ? await chatsMakeWay(model.id) : [];
      send('progress', { state: 'starting', text: `${made.length ? `Unloaded ${made.join(' and ')} there to make room. ` : ''}${v.state === 'connected' && v.model ? `Switching to ${name} there` : `Loading ${name} there`}` });
      if (!(await d.loadImage(model.id))) throw new Error(`${name} did not load on "${shareState.name}" (its owner may have started a picture there, or it is too big for that PC's memory now).`);
      pictureFor = { id: model.id, by: new Set([forPc]), links: new Set([link]), at: Date.now() };
    } else if (pictureFor?.id === model.id) {
      pictureFor.by.add(forPc);
      pictureFor.links.add(link);
    }
    const r = await d.draw({ prompt: ask.prompt, mode: ask.style ? brains.modeOfStyle(ask.style) : 'custom', width: ask.width, height: ask.height, forPc }, p => send('progress', p), ac.signal);
    if ('error' in r) throw new Error(r.error);
    send('picture', { png: r.png.toString('base64'), modelName: r.modelName || name, modelPrompt: r.modelPrompt, mode: r.mode, seconds: r.seconds, note: '' });
  } catch (e) {
    send('error', { text: (e as Error).message });
  } finally {
    drawing = false;
    if (pictureFor?.id === model.id) pictureFor.at = Date.now();
    res.end();
  }
}

/** The worker side: pair, hello, run, draw. Home network only, no browser pages (no Origin), a paired token for all but pair. */
async function workerRoute(req: IncomingMessage, res: ServerResponse) {
  try {
    const ip = req.socket.remoteAddress ?? '';
    if (!share.isPrivateAddress(ip)) return workerJson(res, 403, { error: 'This worker only answers PCs on its own home network.' });
    if (req.headers.origin) return workerJson(res, 403, { error: 'Web pages cannot use this worker.' });
    const p = new URL(req.url ?? '/', 'http://worker').pathname;
    if (req.method === 'POST' && p === '/worker/pair') {
      const locked = guard.lockedFor(ip);
      if (locked) return workerJson(res, 429, { error: `Too many wrong PINs from this PC. Try again in ${locked} minute${locked > 1 ? 's' : ''}.` });
      const b = await d.body(req, 4096);
      // F7 E1: only the encrypted link. A main PC from before it is told to update.
      if (Number(b.v) !== link.LINK_VERSION || typeof b.pub !== 'string') return workerJson(res, 426, { error: 'this PC now uses an encrypted link. Update TOMLIN on this main PC, then link again.' });
      if (shareState.pinOn && b.pinGiven !== true) return workerJson(res, 403, { error: 'this PC also asks for its 6-digit link PIN, shown under Nodes and memory there. Type it and link again.', needPin: true });
      // A PIN typed when this PC asks for none (often its app lock PIN) would change the key and read as a wrong setup
      // code: said plainly, and not counted as a wrong try.
      if (!shareState.pinOn && b.pinGiven === true) return workerJson(res, 400, { error: 'this PC does not ask for a link PIN: leave the PIN box empty and link again. (Its app lock PIN is never typed here.)', noPin: true });
      const token = share.newToken();
      const got = link.nodeAnswer(await nodePairKey(), b, { id: shareState.id, name: shareState.name }, token);
      if (!got) {
        guard.wrong(ip);
        return workerJson(res, 403, { error: shareState.pinOn ? 'wrong setup code or PIN. Type the code and the PIN shown on that PC under Nodes and memory.' : 'wrong setup code. Type the code shown on that PC under Nodes and memory (8 letters and numbers).' });
      }
      // Each link request carries a fresh random nonce: one seen before is a recording sent again, which would push a
      // working link off the end of the list. A real retry from the main PC makes a new one. Checked before the wrong-try
      // count is cleared, so a recording cannot clear it either.
      if (!usePairNonce(String(b.nonce))) return workerJson(res, 409, { error: 'this link request was already used. Press Link again on the main PC.' });
      guard.right(ip);
      // Linking again from the same PC replaces its old link and keeps its restore points, only when it proves it holds
      // that link's keys. Without the proof (a PC that knows only the setup code and an id) it gets a link of its own.
      const from = typeof b.from === 'string' && /^[0-9a-f]{8}$/.test(b.from) ? b.from : undefined;
      // The link whose keys made the proof (two can claim one id: the real one and one made with only the code).
      const old = from ? shareState.paired.find(x => {
        const k = x.from === from ? link.keysOf(x.key) : null;
        return !!k && [b.proof, ...(Array.isArray(b.proofs) ? b.proofs.slice(0, 16) : [])].some(pr => link.takeOverProven(k, String(b.pub), pr));
      }) : undefined;
      const proven = !!old;
      const kept = proven ? shareState.paired.filter(x => x !== old) : shareState.paired;
      const keep = proven ? keepOf(old!) : randomBytes(8).toString('hex');
      shareState.paired = [...kept.slice(-9), { ...(from ? { from } : {}), keep, name: String(b.name ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'A manager PC', hash: share.hashToken(token), key: link.keysText(got.keys), at: new Date().toISOString() }];
      await saveShare();
      return workerJson(res, 200, got.answer);
    }
    // Only enough to be found on the home network: that this is TOMLIN, its name, whether it asks for a PIN.
    if (req.method === 'GET' && p === '/worker/whoami') return workerJson(res, 200, { app: 'smart-manager', name: shareState.name, version: d.version, pin: shareState.pinOn, link: link.LINK_VERSION });
    // The link is named by its token's fingerprint: the token itself never crosses the network after linking.
    const named = /^Link ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const who = share.pairedByHash(shareState, named);
    if (!who) return workerJson(res, 401, { error: 'that PC no longer knows this one (it was removed there, or set up again)' });
    // Every message from here on is sealed both ways (F7 E1): one that does not open is refused.
    const keys = link.keysOf(who.key);
    if (!keys) return workerJson(res, 401, { error: 'this link was made before links were encrypted. Link this PC again from the main PC (Other PCs, Find PCs on my network, then the setup code).' });
    if (req.method !== 'POST') return workerJson(res, 405, { error: 'this PC only takes sealed messages. Update TOMLIN on the main PC.' });
    // A piece of a file (a model or a restore point sent here): the request rides in a header, the piece is the body.
    const putDoor = p === '/worker/carry-put' || p === '/worker/backup-put' || p === '/worker/update-put' || p === '/worker/git-put';
    // A project backup's file list and the ids asked about are long (up to 100,000 files).
    const limit = p === '/worker/run' ? 600_000 : p === '/worker/update-offer' ? 4 << 20 : p === '/worker/git-commit' ? 32 << 20 : p === '/worker/git-have' ? 1 << 20 : 16_384;
    const opened = link.openRequest(keys, putDoor ? { box: String(req.headers['x-link'] ?? '') } : await d.body(req, limit), p, taken);
    if ('error' in opened) return workerJson(res, 400, { error: opened.error });
    // A piece (up to 16 MB) is read only once its sealed request has opened: the fingerprint alone gets nothing read.
    const raw = putDoor ? await rawBody(req, carry.PIECE + 1024) : null;
    sealers.set(res, { keys, id: opened.id, n: 0 });
    const piece = raw ? link.openBytes(link.toNode(keys), raw, `piece|${opened.id}`) : undefined;
    if (raw && !piece) return workerJson(res, 400, { error: 'a piece of a file could not be opened (changed on the way), so it was refused.' });
    const body = opened.body;
    // F7 E5: someone at this PC pressed "I need to use the pc": no new work until the main PC starts it again.
    const away = shareState.away;
    if (p === '/worker/hello') {
      const v = d.chat.view;
      const models = await sharedNow();
      const allow = carry.cleanAllow(shareState.allow);
      const up = { since: d.startedAt, pc: Math.round(uptime()) };
      const installed = installedAt();
      // The disk that keeps other PCs' backups here (read at once, no program started), so they see the room left.
      const disk = await carry.diskOf(d.carry.keptRoot);
      // build: what code this copy is (src/update.ts buildId), so the main PC tells one version with other files apart.
      if (away) return workerJson(res, 200, { name: shareState.name, version: d.version, build: d.build(), model: null, ctx: d.runNow().ctx, state: 'away', away: away.since, ask: null, memory: d.memory(), can: ['models', 'draw-models', 'carry', 'update', 'outbox', 'usage', 'git'], image: null, models: models.map(x => ({ ...x, loaded: false, busy: false })), allow, restarts: d.update.restarts, up, meter: d.meter(), installed, disk });
      // The connected models are named only when their owner ticked them for other PCs (an unticked one is not lent).
      const lent = (id: string | null | undefined) => !!id && (shareState.models ?? []).includes(id);
      const img = imageHello();
      return workerJson(res, 200, { name: shareState.name, version: d.version, build: d.build(), ask: share.askPending(shareState.ask), model: v.state === 'connected' && lent(v.model) ? v.modelName : null, ctx: d.runNow().ctx, state: v.state, memory: d.memory(), can: ['turns', 'draw', 'stats', 'models', 'draw-models', 'think', 'carry', 'update', 'outbox', 'usage', 'git'], image: lent(img.model) ? img : { ...img, model: null, name: null, styles: [] }, models, away: null, allow, restarts: d.update.restarts, up, meter: d.meter(), installed, disk });
    }
    // This PC's meters for the head of a paired PC's chat with someone here: read from what the sampler measured in
    // the last second for this PC's own top bar, so asking every few seconds adds no measuring here.
    if (p === '/worker/stats') {
      stillThere(keepOf(who), true);
      return workerJson(res, 200, d.stats());
    }
    // The main PC's answer to "I need to use the pc, please log out for N hours": yes logs out here for those hours.
    if (p === '/worker/ask-answer') {
      const r = await askAnswered(body, who.name);
      return workerJson(res, r.status, r.body);
    }
    if (p === '/worker/back') {
      const r = await comeBack(body.confirm === true, who.name);
      return workerJson(res, r.status, r.body);
    }
    const carryDoor = p.startsWith('/worker/carry-') || p.startsWith('/worker/backup-') || p.startsWith('/worker/update-') || p.startsWith('/worker/git-');
    if (away && (carryDoor || ['/worker/switch', '/worker/draw', '/worker/run'].includes(p))) return workerJson(res, 503, { error: `I need to log off for now: someone is using ${shareState.name} (since ${new Date(away.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}). Its work goes to other PCs until it is started again.`, away: away.since });
    if (p.startsWith('/worker/update-')) {
      const a = await updateNode(p, body, { key: keepOf(who), name: who.name }, piece ?? undefined);
      return workerJson(res, a.status, a.json);
    }
    if (carryDoor) {
      const a = await carryNode(p, body, { key: keepOf(who), name: who.name }, piece ?? undefined);
      if (p === '/worker/backup-put' && 'json' in a && a.json.done === true) void readKept();
      if ('piece' in a) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return void res.end(link.sealBytes(link.toHost(keys), a.piece, `piece|${opened.id}`));
      }
      return workerJson(res, a.status, a.json);
    }
    // A linked PC from before 2.0.31 asking for one of this PC's hires: they are retired (a node lends only its models).
    if (p === '/worker/switch') return workerJson(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
    // Awaited, so a fault in it is answered below (not left hanging until the linked PC gives up).
    if (p === '/worker/draw') return await workerDraw(body, res, who.name, keepOf(who));
    if (p === '/worker/run') {
      const b = body;
      // Asked with a request id (2.0.38 on): the answer finishes here even if that PC goes away, and asking again with
      // the same id follows it, or gets it at once when it is done (src/outbox.ts). Never run twice.
      const rid = cleanRid(b.rid);
      const keep = rid ? { owner: keepOf(who), rid, lock: lockOf(keys) } : null;
      if (keep && box.isRunning(keep.owner, keep.rid)) return void box.join(keep.owner, keep.rid, followerOf(res));
      const had = keep ? await box.kept(keep.owner, keep.rid, keep.lock) : null;
      if (had) return replay(res, had);
      const system = String(b.system ?? '').slice(0, 30_000);
      const user = String(b.user ?? '').slice(0, 200_000);
      // A whole chat (a manager PC's hire talking here), or one prompt (a job step).
      const turns = b.turns === undefined ? null : brains.cleanTurns(b.turns);
      if (b.turns !== undefined && !turns) return workerJson(res, 400, { error: 'the conversation sent was not in the expected form.' });
      const maxTokens = Math.max(64, Math.min(jobs.STEP_CEILING, Math.floor(Number(b.maxTokens) || 1000)));
      if (b.staff !== undefined) return workerJson(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
      if (typeof b.model === 'string' && b.model) return await modelChat(b, turns, { system, user }, maxTokens, res, who.name, keep, keepOf(who));
      if (d.chat.view.state !== 'connected' || !d.chat.worker.base) return workerJson(res, 409, { error: 'no chat model is connected on the worker PC. Press Connect there.' });
      // The model connected here answers only when its owner ticked it for other PCs (never lent unasked).
      const notLent = nodestaff.modelRefusal(d.chat.view.model ?? '', { ticked: shareState.models ?? [], onPc: x => d.chatList().find(m => m.id === x)?.name ?? null, busy: false, pcName: shareState.name });
      if (notLent) return workerJson(res, 403, notLent);
      if (d.busy()) return workerJson(res, 409, { error: 'that PC is busy answering something else. Try again in a moment.' });
      const verdict = checkMessage(turns ? turns.at(-1)!.content : user, { recent: [] });
      if (!verdict.ok) return workerJson(res, 400, { error: REFUSAL[verdict.reason] });
      return await runFor(res, keep, `Working on a step for ${who.name}`, { pc: who.name, link: keepOf(who), project: projectOf(b) }, async (send, signal) => {
        try {
          const brain = localBrain('');
          if (turns) await brain.chat(turns, maxTokens, text => send('text', { text }), signal, askOpts(b, send));
          else await brain.ask(system, user, maxTokens, text => send('text', { text }), signal);
          send('done', { model: d.chat.view.modelName ?? '', speed: brain.last ?? null, thought: brain.thought ?? null, usage: usedHere(), ...(brain.cut ? { cut: true } : {}) });
        } catch (e) {
          send('error', { text: (e as Error).message });
        }
      });
    }
    // The outbox (src/outbox.ts): where an answer asked with a request id is (still working, finished, or not here),
    // "taken" once that PC has it, and Stop pressed there. Open while this PC's owner uses it ("away"): only collecting.
    if (p === '/worker/result') {
      const rid = cleanRid(body.rid);
      if (!rid) return workerJson(res, 400, { error: 'no request id was sent.' });
      const w = await box.where(keepOf(who), rid, lockOf(keys));
      return w ? workerJson(res, 200, w) : workerJson(res, 404, { gone: true, error: `"${shareState.name}" does not have that answer: it was restarted before the answer was finished, or the answer waited more than three days.` });
    }
    // This PC's own log of the work it did for that PC, per project (2.0.40 on): that PC's final tally (src/meter.ts).
    if (p === '/worker/usage') return workerJson(res, 200, { rows: d.ledgerRows(`for-${keepOf(who)}`) });
    if (p === '/worker/taken') {
      for (const rid of (Array.isArray(body.rids) ? body.rids : []).slice(0, 100).map(cleanRid)) if (rid) await box.take(keepOf(who), rid);
      return workerJson(res, 200, { ok: true });
    }
    if (p === '/worker/stop') {
      const rid = cleanRid(body.rid);
      return workerJson(res, 200, { stopped: rid ? await box.stop(keepOf(who), rid) : false });
    }
    return workerJson(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (!res.headersSent) workerJson(res, 400, { error: (e as Error).message });
    else res.end();
  }
}

/** One change of the link part at a time (two quick port changes never leave a false "could not open"). */
let applying: Promise<void> = Promise.resolve();
export function applyShare(): Promise<void> {
  applying = applying.then(applyNow, applyNow);
  return applying;
}

async function applyNow(): Promise<void> {
  if (shareServer) {
    const s = shareServer;
    shareServer = null;
    // A step still streaming would hold the port open: sharing off means off now.
    await new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); });
  }
  shareError = '';
  if (!shareState.on) return;
  // A node must have the app lock (F7 E3): other PCs reach it, so it is never open without one. Without its PIN (the file deleted), the node does not listen.
  if (!d.appLockOn()) {
    shareError = 'a node must have the app lock. Set a PIN with the padlock (top right) and the node starts again.';
    return;
  }
  const srv = createServer(workerRoute);
  await new Promise<void>(resolve => {
    srv.once('error', e => {
      shareError = `Could not open port ${shareState.port}: ${(e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'another program is using it. Choose another port.' : (e as Error).message}`;
      resolve();
    });
    srv.listen(shareState.port, '0.0.0.0', () => {
      shareServer = srv;
      resolve();
    });
  });
}

export async function startShare() {
  try {
    shareState = { ...share.DEFAULT_SHARE, ...(await d.store.readJson<Partial<share.ShareState>>('share.json', {})) };
  } finally {
    shareRead();
  }
  // Each PC has its own setup code, made the first time and kept.
  if (!shareState.code || !/^[0-9a-f]{8}$/.test(shareState.id)) {
    shareState.code ||= share.newCode();
    if (!/^[0-9a-f]{8}$/.test(shareState.id)) shareState.id = randomBytes(4).toString('hex');
    await saveShare();
  }
  autostart = await d.autostart.on().catch(() => false);
  if (shareState.on) await applyShare();
}

/** "Start TOMLIN when this PC starts" is ticked (read at start and after each change). */
let autostart = false;

/**
 * Takes a linked PC's projects out of their backup on this PC (its newest one), into a new folder beside the Smart
 * Manager data: "projects from other PCs/<PC> <date time>". For when that PC is gone; it needs nothing from it.
 */
export async function projectsCopy(b: Record<string, unknown>) {
  const k = projectsNow.find(x => x.key === b.key);
  if (!k) return { status: 404, body: { error: 'No projects of that PC are kept here any more.' } };
  const t = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}${two(t.getMinutes())}`;
  const dest = join(dirname(d.carry.keptRoot), 'projects from other PCs', `${k.name.replace(/[^\w .()-]+/g, '-').slice(0, 40)} ${stamp}`);
  try {
    const n = await carry.projectsOut(d.carry.keptRoot, k.key, dest);
    return { status: 200, body: { said: `${n} file${n === 1 ? '' : 's'} of "${k.name}" saved in ${dest}`, folder: dest } };
  } catch (e) {
    return { status: 500, body: { error: `The projects could not be saved: ${(e as Error).message}.` } };
  }
}

export async function setShare(b: Record<string, unknown>) {
  // A node must have the app lock (F7 E3): other PCs reach it, so it is never open without one. Turning it on needs a PIN set; while it is a node, every change
  // here (turning it off too) needs that PIN typed again.
  const turningOn = b.on === true && !shareState.on;
  // What the link part listens with, before this change: it restarts only when one of them changes (below).
  const was = { on: shareState.on, port: shareState.port };
  await shareLoaded;
  if (turningOn && !d.appLockOn()) return { status: 409, body: { error: 'A node must have the app lock, so whoever sits at this PC cannot read or change it. Set a PIN first: the padlock, top right. Then tick this again.', needAppLock: true } };
  // Checked before anything is changed, so a refused port never leaves half of the other changes made.
  const port = 'port' in b ? Math.floor(Number(b.port)) : shareState.port;
  if ('port' in b && (!(port >= 1024 && port <= 65535) || port === Number(process.env.TOMLIN_PORT ?? 8740))) return { status: 400, body: { error: 'Use a port number from 1024 to 65535, not TOMLIN\'s own.' } };
  if (shareState.on && !turningOn) {
    const ok = d.appPinCheck(b.appPin);
    if ('error' in ok) return { status: ok.status, body: { error: ok.error, needAppPin: true } };
  }
  if (b.away === true) {
    const r = await goAway();
    if ('error' in r) return { status: 409, body: r };
  }
  if (b.back === true) await comeBack(true, 'this PC');
  if ('autostart' in b) {
    try {
      await d.autostart.set(b.autostart === true);
    } catch (e) {
      return { status: 500, body: { error: `Could not change "Start when this PC starts": ${(e as Error).message}` } };
    }
    autostart = await d.autostart.on().catch(() => false);
  }
  if ('on' in b && b.on !== true) shareState.away = null;
  if ('name' in b) shareState.name = String(b.name ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'Worker PC';
  shareState.port = port;
  if ('pinOn' in b) shareState.pinOn = b.pinOn === true;
  if ('allow' in b) shareState.allow = carry.cleanAllow(b.allow);
  if ('models' in b) shareState.models = nodestaff.cleanTicks(b.models, [...d.chatList().map(m => m.id), ...d.pictureModels().filter(m => m.installed).map(m => m.id)]);
  if (b.newPin === true || (shareState.pinOn && !shareState.pin)) shareState.pin = share.newPin();
  if (b.newCode === true) shareState.code = share.newCode();
  // By the link's own id (its token's fingerprint): the list can change while the page shows it (a PC links meanwhile).
  if (typeof b.unpairId === 'string' && b.unpairId) shareState.paired = shareState.paired.filter(x => String(x.hash ?? '').slice(0, 12) !== b.unpairId);
  else if ('unpair' in b) shareState.paired = shareState.paired.filter((_, k) => k !== Number(b.unpair));
  if (b.unpairAll === true) shareState.paired = [];
  if ('on' in b) shareState.on = b.on === true;
  await saveShare();
  // The link part restarts only when it has to (turned on or off, a new port, or not listening): a restart cuts every
  // answer, step and picture the host is waiting for, and a name, a code or "Start when this PC starts" is read live.
  if (shareState.on !== was.on || shareState.port !== was.port || (shareState.on && !shareServer)) await applyShare();
  return { status: 200, body: shareView() };
}

/** What creating the jobs started: the restore points read once a minute, the copy and update doors, the drop of unused models. */
export function startNode(): void {
  box = new Outbox(join(d.store.dir, 'outbox'));
  // Answers no linked PC came back for in three days are removed (at the start, then once an hour).
  void box.sweep();
  setInterval(() => void box.sweep(), 3600_000).unref();
  void readKept();
  setInterval(readKept, 60_000).unref();
  carryNode = carry.nodeSide({
    allow: () => shareState.allow ?? carry.NO_ALLOW,
    ticked: () => shareState.models ?? [],
    pcName: () => shareState.name,
    chatFiles: d.carry.chatFiles,
    pictureFiles: d.carry.pictureFiles,
    chatDir: d.carry.chatDir,
    chatHas: d.carry.chatHas,
    pictureDest: d.carry.pictureDest,
    keptRoot: d.carry.keptRoot,
    onProjects: () => void readKept(),
    onInstalled: (name, model) => {
      console.log(`A linked PC installed ${name} on this PC.`);
      d.carry.onInstalled();
      // A model sent here is shared at once (ticked under "Models to share with others"): staff moved off this PC and
      // back again find it here, with nothing to tick by hand.
      const ticked = shareState.models ?? [];
      if (!ticked.includes(model.id)) {
        shareState.models = [...ticked, model.id].slice(-40);
        void saveShare().catch(() => undefined);
      }
    },
  });

  // Logged out for the hours the main PC agreed to: it starts again by itself when they are up.
  setInterval(() => {
    const until = shareState.away?.until;
    if (until && Date.now() >= Date.parse(until)) void comeBack(true, 'the end of the time asked for').catch(() => undefined);
  }, 30_000).unref();
  updateNode = update.updateSide({
    root: d.update.root,
    version: d.version,
    build: d.build,
    allowed: () => shareState.allow?.update === true,
    pcName: () => shareState.name,
    restarts: d.update.restarts,
    // A restart cuts what is running: someone at this PC, or work for a linked PC, finishes first.
    busy: () => [...serving.values()][0] ?? (lending.size || drawing ? 'answering for a linked PC' : d.busy() ? 'someone at that PC is getting an answer' : d.imageBusy() ? 'someone at that PC is drawing a picture' : actionBusy() ? 'a job is running on that PC' : d.chat.view.state === 'loading' || d.imagePane.view.state === 'loading' ? 'a model is loading on that PC' : null),
    done: async (dir, version, by) => {
      shareState.updated = { version, by: String(by).slice(0, 40), at: new Date().toISOString() };
      await saveShare();
      console.log(`"${by}" updated TOMLIN here to ${version}: starting it from ${dir}.`);
      await d.update.switchTo(dir);
    },
  });
  setInterval(() => {
    const v = d.imagePane.view;
    if (pictureFor && (v.model !== pictureFor.id || (v.state !== 'connected' && v.state !== 'loading'))) pictureFor = null;
    else if (pictureFor && (drawing || v.state === 'loading')) pictureFor.at = Date.now();
    // Drawing, but not for a linked PC: someone at this PC uses it now, so it is theirs.
    else if (pictureFor && d.imageBusy()) pictureFor = null;
    else if (pictureFor && Date.now() - pictureFor.at > UNUSED_DROP_MS) {
      console.log(`Dropping ${v.modelName ?? pictureFor.id}: loaded for a linked PC, and no linked PC used it for ${UNUSED_DROP_MS / 1000} s.`);
      pictureFor = null;
      void d.imagePane.disconnect().catch(() => undefined);
    }
    for (const [id, v] of loadedForPc) {
      const r = d.runnerFor(id);
      if (!r || (r.view.state !== 'connected' && r.view.state !== 'loading')) loadedForPc.delete(id);
      else if (lending.has(id) || r.view.state === 'loading') v.at = Date.now();
      // Answering, but not for a linked PC: someone at this PC uses it now, so it is theirs.
      else if (d.busy(r)) loadedForPc.delete(id);
      else if (Date.now() - v.at > UNUSED_DROP_MS) {
        loadedForPc.delete(id);
        console.log(`Dropping ${r.view.modelName ?? id}: loaded for a linked PC, and no linked PC used it for ${UNUSED_DROP_MS / 1000} s.`);
        void r.disconnect().catch(() => undefined);
      }
    }
  }, 5000).unref();
}
