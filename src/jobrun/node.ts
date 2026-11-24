// This PC as a node for other PCs: its share settings and its worker door. Linking other PCs to this one is
// linking.ts; giving way to its owner ("I need to use the pc") is giveway.ts.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { TooLarge, readBody } from '../bodyread.ts';
import { callWords, cleanWebAsk, WEB_ROUNDS, WEB_TOOLS, WebTurn } from '../webtools.ts';
import { webGuard } from '../promptscan.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { cpus, networkInterfaces, totalmem, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as jobs from '../jobs.ts';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as guestpass from '../guestpass.ts';
import * as peerlink from '../peerlink.ts';
import { peerPing } from './peercall.ts';
import { peerCopy } from './peercopy.ts';
import * as nodeline from '../nodeline.ts';
import * as slotsLib from '../slots.ts';
import { everyFew, paced, runnerFetch, type AskOpts, type ChatTurn, type ToolBox } from '../engine.ts';
import * as tooltalk from './tooltalk.ts';
import { runnerHeaders } from '../runnerkeys.ts';
import * as brains from '../brains.ts';
import { checkMessage, REFUSAL } from '../filter.ts';
import * as nodestaff from '../nodestaff.ts';
import { assignedTo } from '../assigned.ts';
import type { Place } from '../runners.ts';
import * as carry from '../carry.ts';
import { driveOf, driveReportNow } from '../modelhome.ts';
import { cleanJobList, jobRefused, jobsHere, setJobsHere } from '../drivejobs.ts';
import * as runnerpush from '../runnerpush.ts';
import * as runset from '../runset.ts';
import { CONTEXT_SIZES, planWebContext } from '../webctx.ts';
import * as owner from '../owner.ts';
import * as update from '../update.ts';
import { POWER_DOOR, USED_MINUTES, powerOffSide, shutdownArgs } from '../poweroff.ts';
import { PERM_CAN, PERM_DOOR, PERM_KEYS, permSetSide, type PermKey } from '../permset.ts';
import * as hostpin from '../hostpin.ts';
import * as adminkey from '../adminkey.ts';
import * as usbnode from '../usbnode.ts';
import * as usbadmin from '../usbadmin.ts';
import { startScreen } from '../usbscreen.ts';
import { lastStart } from '../worker.ts';
import { loads } from '../loadlog.ts';
import { cleanRid, GUEST_KEPT, HOST_KEPT, Outbox, replayOf, type Follower, type Kept, type Lock } from '../outbox.ts';
import { inScope, scope } from '../meter.ts';
import { askLog, log } from '../log.ts';
import { faultHook } from '../faults.ts';
import { PICTURE_DROP_MS, unloadWhileLocked } from '../picturelock.ts';
import { type Send, d, sleep } from './shared.ts';
import { brainForRef, localBrain } from './who.ts';
import { actionBusy } from './actions.ts';
import { askAnswered, comeBack, goAway } from './giveway.ts';
import { awake, nodeBusy } from '../keepawake.ts';
import { endLoan, lendingTo, lendView, lentTo, loanBusyNow, maxUpgrade } from './maxnode.ts';
import { maxPcs } from './maxhost.ts';
import { clusterTestUpgrade, isClusterTest } from '../cluster/testdoor.ts';
import { checkSpeed, forHello, speedNow } from '../speedtest.ts';
import { nodeTestDeps } from '../cluster/testdoornode.ts';
import { CACHE_LIMIT as maxlendLimit, PresenceReader, cacheDirOf, cleanLendIdle, nobodyThere, presenceWords, pruneCache } from '../maxlend.ts';
import { oncePerFile } from '../models.ts';
import { adapterKind } from '../linkhelp.ts';
import { startDiskLog } from '../disklog.ts';

/** A change a linked PC made here, or one made for it, that the owner may want to read later: in the window and the log. */
const noted = (line: string) => {
  console.log(line);
  log.info('node', line);
};

// ---- This PC as a worker for other PCs (off unless its owner turns it on) ----

export let shareState: share.ShareState = { ...share.DEFAULT_SHARE };
let shareServer: Server | null = null;
let shareError = '';
const guard = new share.PinGuard();
/** Bytes of sealed requests being read before their seal is checked (S4): per link and in all. */
const bodies = new share.BodyBudget();
/**
 * The most characters of a whole chat this PC takes in one request (src/brains.ts chatCharsFor): from the largest context
 * it runs a chat model with, as loaded now or as set. Said in its hello, so a host fits a chat to it before it sends.
 */
async function chatCharsHere(): Promise<number> {
  const s = await d.store.settings();
  let most = 0;
  for (const m of d.chatList()) {
    const p = d.runnerFor(m.id);
    most = Math.max(most, (p?.view.state === 'connected' ? d.runOn(p) : d.runOf(s, m.id)).ctx);
  }
  return brains.chatCharsFor(most);
}
/** The bytes of a chat request for that many characters: sealed (base64), JSON-escaped, and up to 3 bytes a character. */
const chatBytesFor = (chars: number) => Math.max(600_000, chars * 4 + 65_536);
/**
 * Link-request nonces already answered (the newest PAIR_NONCES_KEPT): a request sent twice is refused. Kept on the disk
 * too (keepPairNonces), so a guest's link request recorded on the network cannot be sent again after a restart: a guest
 * pass is not used up by a link, so that copy would otherwise still pass and push the guest's working link off.
 */
const pairNonces = new Set<string>();
export const PAIR_NONCES_KEPT = 2000;
let pairFile: string | null = null;
let pairLines = 0;
/** Keeps the nonces in `file` from now on, and takes back the ones kept there. */
export function keepPairNonces(file: string): void {
  pairFile = file;
  pairNonces.clear();
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) if (isPairNonce(line.trim())) pairNonces.add(line.trim());
  } catch {
    // No file yet: none answered before.
  }
  while (pairNonces.size > PAIR_NONCES_KEPT) pairNonces.delete(pairNonces.values().next().value!);
  writePairNonces();
}
const isPairNonce = (n: string) => /^[\w+/=-]{8,64}$/.test(n);
function writePairNonces(): void {
  if (!pairFile) return;
  try {
    writeFileSync(`${pairFile}.new`, [...pairNonces].map(n => `${n}\n`).join(''));
    renameSync(`${pairFile}.new`, pairFile);
    pairLines = pairNonces.size;
  } catch {
    // The disk refused: they are still held here while this app runs.
  }
}
export function usePairNonce(nonce: string): boolean {
  if (!isPairNonce(nonce) || pairNonces.has(nonce)) return false;
  pairNonces.add(nonce);
  if (pairNonces.size > PAIR_NONCES_KEPT) pairNonces.delete(pairNonces.values().next().value!);
  if (pairFile) {
    try {
      // Kept before the link is made, so a crash right after cannot let it be sent again.
      appendFileSync(pairFile, `${nonce}\n`);
      if (++pairLines > PAIR_NONCES_KEPT * 2) writePairNonces();
    } catch {
      // Held here while this app runs.
    }
  }
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

/**
 * For an admin's hello, the cluster part (src/cluster/loader.ts): the linked PCs this PC would borrow from now for a model
 * too big for it (its own links and its own cluster, read as its own Max mode reads them), and the name of the network
 * adapter the request came in on, so the host can tell a wired PC from one on Wi-Fi. A host that stays out of its
 * cluster needs both to pick this PC to load the model. A guest is never told.
 */
function clusterHello(local: string | undefined): { borrows: string[]; via: string } {
  const at = String(local ?? '').replace(/^::ffff:/, '');
  return { borrows: maxPcs().map(r => r.id), via: lanList().find(n => n.address === at)?.via ?? '' };
}

/** True while the node port is open for other PCs (the link helper's checklist). */
export const shareListening = () => !!shareServer;

export function shareView() {
  return { claims: claimsWaiting(), on: shareState.on, listening: !!shareServer, error: shareError, linkPaused: guard.pausedFor(), port: shareState.port, name: shareState.name, code: shareState.code, pinOn: shareState.pinOn, pin: shareState.pinOn ? shareState.pin : '', addresses: lanList().map(n => ({ address: `${n.address}:${shareState.port}`, via: n.via, kind: adapterKind(n.via) })), paired: shareState.paired.map(({ name, at, key, hash, role, passId, expires }) => ({ name, at, old: !key, id: String(hash ?? '').slice(0, 12), ...(role === 'guest' ? { guest: true, passId, expires: expires ?? null } : {}) })), passes: guestpass.passView(shareState.passes, Date.now(), shareState.paired), passNodes: passHooks.nodes(), passesMade: !!shareState.passGen, passLastLength: shareState.passLastLength ?? 'week', peerLinks: peerHooks.view(), peersHere: peersHereView(), renewLengths: guestpass.RENEW_LENGTHS, line: line.view(id => d.chatList().find(m => m.id === id)?.name ?? pictureName(d.pictureModels().find(m => m.id === id)) ?? id), guestCaps: nodeline.cleanCaps(shareState.guestCaps), hostFirst: shareState.hostFirst !== false, atOnce: slotsLib.cleanAtOnce(shareState.atOnce), slotsNow: d.chatList().filter(m => d.runnerFor(m.id)?.view.state === 'connected').map(m => ({ name: m.name, slots: d.slotsOf?.(m.id) ?? 1, note: d.slotNote?.(m.id) ?? '' })), passAsks: [...ownAsks(), ...(passHooks.asks() as object[])], away: shareState.away?.since ?? null, autostart, appLock: d.appLockOn(), allow: carry.cleanAllow(shareState.allow), kept: keptNow, projects: projectsNow.map(({ key, name, at, files, backups, folder }) => ({ key, name, at, files, backups, folder })), restarts: d.update.restarts, updated: shareState.updated?.version === d.version ? shareState.updated : null, lastLinked: shareState.lastLinked ?? null, inUse: linkedUse(), runChanges, permChanges, lend: lendView(), plainLinks: shareState.plainLinks === true, shareable: [...oncePerFile(d.chatList()).map(m => ({ id: m.id, name: m.name, bytes: m.bytes, kind: 'chat' })), ...d.pictureModels().filter(m => m.installed).map(m => ({ id: m.id, name: pictureName(m), bytes: m.bytes ?? 0, kind: 'image' }))] };
}

/** Requests for more time from guests on passes made here (the node's own), for this PC's page. */
function ownAsks() {
  return (shareState.passAsks ?? []).filter(a => !a.answer && !a.by).map(a => ({ pc: null, pcName: shareState.name, id: a.id, name: a.name, expired: a.expired, text: a.text, at: a.at, defaultLength: shareState.passLastLength ?? 'week' }));
}

/** Restore points kept here for linked PCs (whose, how many), read again after one comes in and once a minute. */
let keptNow: Awaited<ReturnType<typeof carry.keptHere>> = [];
/** Run settings linked PCs changed here since TOMLIN started, newest first (shown on this PC's Network page). */
const runChanges: { model: string; name: string; draft: string; draftName: string; by: string; at: string }[] = [];
/** Permissions a linked host changed here since TOMLIN started (src/permset.ts), newest first: on this PC's Network page. */
const permChanges: { said: string; at: string }[] = [];
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

/**
 * What a minted node adds to its whoami (Bootable USB): the tags of its admin keys (never the keys), that it runs from a
 * stick, and its hardware in one line, so the admin's scan lists its own nodes and can say which kind each is.
 */
export function whoamiExtra(): Record<string, unknown> {
  // The stick's id is not a secret: it names the stick on its admin's list, and only the stick's own key proves it.
  if (!usbStick && !shareState.usbNode) return {};
  return { admin: usbStick ? [adminkey.keyTag(usbStick.adminPub)] : [], ...(usbStick ? { stick: usbStick.stick.id } : {}), usb: true, os: process.platform };
}

/**
 * Copying this PC's passes to the nodes it is linked to (src/jobrun/passsync.ts sets these when it starts): `changed`
 * sends them now; `nodes` is each PC a pass can be for, with its models and whether it holds the latest.
 */
/** Set by src/jobrun/peersync.ts (this PC as a host): introducing two linked PCs to each other, ending it, and the page's list. */
export const peerHooks: { introduce: (b: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>; remove: (b: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>; check: (b: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>; copy: (b: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>; view: () => unknown } = {
  copy: async () => ({ status: 409, body: { error: 'This PC is not ready to introduce PCs yet.' } }),
  check: async () => ({ status: 409, body: { error: 'This PC is not ready to introduce PCs yet.' } }),
  introduce: async () => ({ status: 409, body: { error: 'This PC is not ready to introduce PCs yet.' } }),
  remove: async () => ({ status: 409, body: { error: 'This PC is not ready to introduce PCs yet.' } }),
  view: () => ({ pairs: [], pcs: [], scopes: [] }),
};

export const passHooks: { changed: () => void; nodes: () => unknown[]; asks: () => unknown[]; answer: (pc: string, b: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }> } = {
  changed: () => undefined,
  nodes: () => [],
  asks: () => [],
  answer: async () => ({ status: 409, body: { error: 'This PC is not ready to answer requests yet.' } }),
};

/** What a guest's hello says this PC can do (src/guestpass.ts GUEST_DOORS): using its pass's models and pulling updates. */
const GUEST_CAN = ['turns', 'draw', 'draw-outbox', 'stats', 'models', 'draw-models', 'think', 'outbox', 'usage', 'web', 'give', 'tooltalk'];
/** A guest asking for a model its pass does not name. */
const notOnPass = () => ({ error: `your guest pass on "${shareState.name}" does not include that model. Its owner can make a pass that does.`, guest: 'scope' });

// ---- The line (src/nodeline.ts): every request for an answer or a picture from a linked PC waits its turn ----

/**
 * Answers on chat model `id` that may run together here (At once, src/slots.ts): the node's setting, but no more than
 * its runner was started with (1 until it loads again after the setting is turned up). 1: the line, one at a time.
 */
const atOnceFor = (id: string) => Math.min(slotsLib.cleanAtOnce(shareState.atOnce), d.slotsOf?.(id) ?? 1);
const line = new nodeline.NodeLine({ hostFirst: () => shareState.hostFirst !== false, slots: atOnceFor });
/** How long each model's work took here lately: the estimate a waiting PC is told. */
const answerTimes = new nodeline.AnswerTimes();
/** A turn's end, by its request: called once its work ends (or it never started). */
const lineEnds = new Map<ServerResponse, () => void>();
/** Requests whose work started (runFor or drawFor): their end comes from there. */
const lineStarted = new WeakSet<ServerResponse>();
/** Woken when the line moves (a turn ended, one left). */
let lineWaiters: (() => void)[] = [];
function lineKick(): void {
  const w = lineWaiters;
  lineWaiters = [];
  for (const f of w) f();
}
function lineEnd(res: ServerResponse): void {
  const end = lineEnds.get(res);
  lineEnds.delete(res);
  end?.();
}
const lineNap = (ms: number) => new Promise<void>(r => {
  const t = setTimeout(r, ms);
  lineWaiters.push(() => { clearTimeout(t); r(); });
});

/** What a request at the head of the line is waiting for, if anything ('go': its turn has come). */
async function lineReady(what: 'chat' | 'picture', b: Record<string, unknown>, guest: boolean, forPc: string, forLink: string): Promise<'go' | { wait: string } | { refuse: string }> {
  const tuning = d.tuneBusy?.() ?? '';
  if (tuning) return { wait: `a speed test is running there (${tuning}).` };
  const want = typeof b.model === 'string' && b.model ? b.model : '';
  const recent = (id: string) => d.usedAt?.(id) ?? null;
  if (what === 'picture') {
    const v = d.imagePane.view;
    if (drawing || d.imageBusy() || (v.state === 'loading' && v.model !== want)) return { wait: 'the picture model there is drawing something else.' };
    // A guest's picture never takes the place of the owner's picture model in use (L3).
    const swap = want && v.state === 'connected' && v.model && v.model !== want && pictureFor?.id !== v.model ? v.model : '';
    if (guest && swap && (recent(swap) ?? 0) > Date.now() - nodeline.OWNER_IDLE_MS) return { wait: `the picture model there waits until its owner has not used theirs for ${nodeline.OWNER_IDLE_MS / 60_000} minutes.` };
    return 'go';
  }
  if (!want) return d.busy() || line.running().length > 0 ? { wait: 'its model is answering someone else there.' } : 'go';
  const runner = d.runnerFor(want);
  let at = runner ? null : d.place(want);
  if (at && 'error' in at && d.chatList().some(m => m.id === want)) at = await chatsMakeRoomFor(want, forPc, forLink, at);
  const swapped = at && !('error' in at) && !at.already && at.replaces ? d.runnerFor(at.replaces) : null;
  const replaces = at && !('error' in at) && !at.already && at.replaces ? { forLinked: loadedForPc.has(at.replaces), busy: !!swapped && d.busy(swapped), usedAt: recent(at.replaces) } : null;
  // At once: a runner with a slot free takes another answer beside the ones it writes.
  const slots = runner ? atOnceFor(want) : 1;
  const busy = slots > 1 ? lending.count(want) >= slots : lending.has(want) || (!!runner && d.busy(runner)) || (!!swapped && (d.busy(swapped) || lending.has(swapped.view.model ?? '')));
  const loadedOrBusy = d.chatList().some(m => d.runnerFor(m.id)?.view.state === 'connected' || d.runnerFor(m.id)?.view.state === 'loading') || serving.size > 0 || drawing || d.imagePane.view.state === 'connected';
  const name = d.chatList().find(m => m.id === want)?.name ?? want;
  return nodeline.chatTurn({ placeError: at && 'error' in at ? at.error : null, busy, loadedOrBusy, guest, replaces, name, pc: shareState.name }, Date.now());
}

/**
 * A request from a linked PC that knows the line: it joins, its answer is opened at once and it is told its place
 * (and again as it moves up); its work starts here when its turn comes. Gone (closed, Stopped) or waiting too long: it
 * leaves. Null: answered already (refused or gone); else its turn came.
 */
async function lineTurn(res: ServerResponse, who: share.ShareState['paired'][number], b: Record<string, unknown>, what: 'chat' | 'picture'): Promise<boolean> {
  const model = typeof b.model === 'string' && b.model ? b.model : what === 'chat' ? d.chat.view.model ?? '' : d.imagePane.view.model ?? '';
  const guest = who.role === 'guest';
  const entry = line.join({ link: keepOf(who), name: who.name, guest, what, model });
  if ('error' in entry) return workerJson(res, 409, { error: `${entry.error} (${nodeline.ordinal(entry.place)} in line).`, busy: true }), false;
  let gone = false;
  res.on('close', () => {
    if (lineStarted.has(res) || lineEnds.has(res)) return;
    gone = true;
    line.leave(entry.id);
    lineKick();
  });
  const send = streamTo(res);
  const beat = setInterval(() => { if (!res.destroyed) res.write(': still waiting\n\n'); }, 20_000);
  let said = '';
  const say = (text: string) => {
    if (text === said) return;
    said = text;
    if (what === 'chat') send('status', { text });
    else send('progress', { state: 'queued', text });
  };
  try {
    for (;;) {
      if (gone || res.destroyed) return false;
      if (Date.now() - entry.at > nodeline.LINE_WAIT_MS) {
        line.leave(entry.id);
        lineKick();
        send('error', { text: nodeline.STUCK_WORDS });
        res.end();
        return false;
      }
      if (line.mayStart(entry.id)) {
        const v = await lineReady(what, b, guest, who.name, keepOf(who));
        if (gone || res.destroyed) return false;
        if (v === 'go') {
          line.start(entry.id);
          const began = Date.now();
          lineEnds.set(res, () => {
            line.leave(entry.id);
            answerTimes.note(model, Date.now() - began);
            lineKick();
          });
          return true;
        }
        if ('refuse' in v) {
          line.leave(entry.id);
          lineKick();
          send('error', { text: v.refuse });
          res.end();
          return false;
        }
        say(`1st in line: ${v.wait} It starts when that is done (or press Stop).`);
      } else say(nodeline.lineWords(line.place(entry.id), line.running().length, answerTimes.average(model)));
      await lineNap(1000);
    }
  } finally {
    clearInterval(beat);
  }
}

/**
 * A linked PC from before the line: told busy, as before, while anyone is in it (it asks again by itself); else its
 * work counts in the line as running now.
 */
function lineOld(res: ServerResponse, who: share.ShareState['paired'][number], b: Record<string, unknown>, what: 'chat' | 'picture'): boolean {
  if (line.busyForOld()) return workerJson(res, 409, { error: what === 'chat' ? 'that PC is busy answering something else. Try again in a moment.' : 'that PC is drawing or answering something else. Try again in a minute.', busy: true }), false;
  const entry = line.join({ link: keepOf(who), name: who.name, guest: who.role === 'guest', what, model: typeof b.model === 'string' ? b.model : '' });
  if ('error' in entry) return workerJson(res, 409, { error: `${entry.error}.`, busy: true }), false;
  line.start(entry.id);
  lineEnds.set(res, () => {
    line.leave(entry.id);
    lineKick();
  });
  return true;
}

/** A turn whose work never started (refused on the way): it leaves the line. */
function lineNotStarted(res: ServerResponse): void {
  if (!lineStarted.has(res)) lineEnd(res);
}

// A request that waited too long is let go even when nothing wakes the line.
setInterval(() => { if (line.stuck().length) lineKick(); }, 30_000).unref();

/** Where a link's restore points and pushed update are kept here (see share.ts `keep`). */
const keepOf = (who: share.ShareState['paired'][number]) => who.keep ?? who.from ?? who.hash.slice(0, 16);

/**
 * A PC started from a Bootable USB stick has no app lock (nobody sits at it; its screen is not TOMLIN's). There, a link
 * made with the admin key stands for the app lock PIN: the admin PC that holds the key may update its permissions, take
 * a host PIN and turn it off. Any other link, and every PC with an app lock, is asked as before.
 */
function usbAdminCheck(check: (pin: unknown, who: string, host?: { pin: unknown; link: string | undefined }) => Promise<{ ok: true } | { status: number; error: string }>) {
  return (pin: unknown, who: string, host?: { pin: unknown; link: string | undefined }) => {
    if (usbStick && !d.appLockOn() && shareState.paired.some(x => x.byKey === true && keepOf(x) === who)) return Promise.resolve({ ok: true as const });
    return check(pin, who, host);
  };
}

// ---- A3 + A4 (src/owner.ts): whose backups a folder here holds, and a new PC asking for them ----

/** Wrong backup PINs and codes, as wrong setup codes are counted: 5 from one address, 20 from all, in 10 minutes. */
const claimGuard = new share.PinGuard();
const CLAIMS_FILE = 'claims.json';
/** Claims made here (the newest 50), read at start. */
let claims: owner.Claim[] = [];
const saveClaims = () => d.store.writeJson(CLAIMS_FILE, claims);

/** Claims waiting for this PC's owner (none older than 7 days), for the Network page and the pop-up. */
export function claimsWaiting() {
  return claims.filter(c => owner.claimState(c) === 'waiting').map(({ id, name, pc, linkedAt, at }) => ({ id, name, pc, linkedAt, at }));
}

/** What the new PC is told about its claim. */
function claimView(c: owner.Claim) {
  const state = owner.claimState(c);
  const here = `"${shareState.name}"`;
  const said = state === 'waiting' ? `Waiting for the owner of ${shareState.name} to allow it. They see it on that PC (a pop-up, and on its Network page) for ${owner.CLAIM_DAYS} days.`
    : state === 'allowed' ? `Allowed. The restore points and projects of "${c.name}" on ${here} are this PC's now: bring the newest one back below.`
    : state === 'denied' ? `The owner of ${here} did not allow it.`
    : `Nobody on ${here} answered within ${owner.CLAIM_DAYS} days. Ask again.`;
  return { id: c.id, state, name: c.name, said };
}

/** A3: a linked PC's backup name, backup PIN (a hash) and recovery codes (hashes), kept beside its restore points. */
async function ownerSet(b: Record<string, unknown>, who: share.ShareState['paired'][number]): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!carry.cleanAllow(shareState.allow).backup) return { status: 403, json: { error: `"${shareState.name}" does not keep backups for other PCs now (its owner ticks "Enable backups" under Network).` } };
  const keep = keepOf(who);
  const owners = await owner.readOwners(d.carry.keptRoot);
  const mine = owners.find(o => o.keep === keep);
  const codes = owner.cleanCodeHashes(b.codes ?? []);
  if (!codes) return { status: 400, json: { error: 'the recovery codes were not sent in the expected form.' } };
  const dir = carry.keptFolder(d.carry.keptRoot, keep);
  // The codes alone (a new set made, or one used, on that PC): only once a name is kept here.
  if (b.codesOnly === true) {
    if (!mine) return { status: 404, json: { error: 'no backup name is kept here for that PC yet.' } };
    await owner.writeOwnerFile(dir, { ...mine.file, codes: owner.mergeCodes(mine.file.codes, codes) });
    return { status: 200, json: { ok: true, name: mine.file.name } };
  }
  const name = owner.cleanBackupName(b.name);
  const pin = owner.cleanPinHash(b.pin);
  if (!name || !pin) return { status: 400, json: { error: 'the backup name or PIN was not sent in the expected form.' } };
  if (owner.nameTaken(owners, name, keep)) return { status: 409, json: { error: `the backup name "${name}" is taken on "${shareState.name}". Pick another one.`, taken: true } };
  await owner.writeOwnerFile(dir, { name, pin, codes: mine ? owner.mergeCodes(mine.file.codes, codes) : codes, at: new Date().toISOString() });
  return { status: 200, json: { ok: true, name } };
}

/**
 * A4: a new PC asks for the backups kept under a name, with the backup PIN or a recovery code. The try is counted
 * before the slow check, and a wrong name gets the same answer as a wrong PIN. A right one waits for this PC's owner.
 */
async function claimAsk(b: Record<string, unknown>, who: share.ShareState['paired'][number], ip: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const wait = claimGuard.lockedFor(ip) || claimGuard.pausedFor();
  if (wait) return { status: 429, json: { error: `too many wrong backup names, PINs or codes. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` } };
  const had = claims.find(c => c.newHash === who.hash && owner.claimState(c) === 'waiting');
  if (had) return { status: 200, json: claimView(had) };
  claimGuard.wrong(ip);
  const got = await owner.checkClaim(await owner.readOwners(d.carry.keptRoot), b.name, { pin: b.pin, code: b.code }, (keep, f) => owner.writeOwnerFile(carry.keptFolder(d.carry.keptRoot, keep), f));
  if (!got) return { status: 403, json: { error: `that backup name and PIN (or recovery code) do not match any backups on "${shareState.name}".` } };
  claimGuard.right(ip);
  if (got.keep === keepOf(who)) return { status: 409, json: { error: 'these backups are this PC\'s already.' } };
  const c: owner.Claim = { id: randomBytes(8).toString('hex'), name: got.name, oldKeep: got.keep, newHash: who.hash, pc: who.name, linkedAt: who.at, ip, at: new Date().toISOString(), state: 'waiting' };
  claims = [...claims.filter(x => x.newHash !== who.hash), c].slice(-50);
  await saveClaims();
  d.onClaim?.(c.name, c.pc);
  return { status: 200, json: claimView(c) };
}

/** This PC's owner answers a claim (Network page or the pop-up; the app lock PIN was checked). Don't allow counts as a wrong try. */
async function answerClaim(id: unknown, allow: boolean): Promise<{ ok: true } | { error: string }> {
  const c = claims.find(x => x.id === id);
  if (!c || owner.claimState(c) !== 'waiting') return { error: 'That request is not waiting any more (answered already, or older than 7 days).' };
  if (allow) {
    const next = owner.allowClaim(shareState.paired, c, keepOf);
    if ('error' in next) return next;
    shareState.paired = next;
    await saveShare();
    void readKept();
  } else claimGuard.wrong(c.ip);
  claims = claims.map(x => (x === c ? { ...x, state: allow ? 'allowed' : 'denied', answeredAt: new Date().toISOString() } : x));
  await saveClaims();
  return { ok: true };
}

/** The doors for copies between linked PCs (src/carry.ts): what this PC's owner lets them do is read at each request. Made by startNode. */
let carryNode: ReturnType<typeof carry.nodeSide>;
/** The doors for a runner a linked PC sends here (src/runnerpush.ts). */
let runnerNode: ReturnType<typeof runnerpush.runnerSide>;

/**
 * What this PC says about its runners in its hello: its NVIDIA card and driver, each CUDA build of the chat runner (how
 * it is here, why it cannot take it, the one that suits its card), its last chat start.
 */
function runnerHello(): runnerpush.RunnerHello {
  const s = runnerNode?.state('llama-cuda') ?? { state: 'none' as const, said: '' };
  const rt = d.runner.runtimes;
  const pins = Object.fromEntries(rt.idsOf('llama', 'cuda').map(id => [id, { state: runnerNode?.state(id).state ?? 'none', why: d.runner.why(id, shareState.name) }]));
  const best = rt.order('llama', 'cuda')[0];
  const said = Object.keys(pins).map(id => runnerNode?.state(id).said ?? '').find(Boolean) ?? s.said;
  return { nvidia: d.runner.nvidia(), driver: d.runner.driver(), why: d.runner.why('llama-cuda', shareState.name), cuda: s.state, pins, ...(best ? { best } : {}), ...(d.rpcBuilds ? { rpc: d.rpcBuilds() } : {}), ...(d.runner.options ? { can: d.runner.options() } : {}), ...(d.runner.check ? { check: d.runner.check() } : {}), said, last: lastStart ? { ...lastStart, lines: [...lastStart.lines] } : null, loads: loads.recent(5) };
}

/** The doors for updates pushed by a linked PC (src/update.ts). Made by startNode. */
let updateNode: ReturnType<typeof update.updateSide>;
/** A host turning this PC off (src/poweroff.ts). */
let powerOffNode: ReturnType<typeof powerOffSide>;
let permNode: ReturnType<typeof permSetSide>;
/** The doors a linked PC pulls this PC's TOMLIN through, behind "Let linked PCs pull TOMLIN updates from here". Made by startNode. */
let giveNode: ReturnType<typeof update.giveSide>;
/** An update this PC pulls from the linked PC `from` (src/jobrun/copies.ts pullFrom): the same steps as one pushed here. */
export const pullHere: (from: string) => update.Here = from => (p, b, piece) => updateNode.here(p, b, from, piece);

/** A request's body as bytes (a piece of a file), refused past `limit`. */
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  try {
    return await readBody(req, limit);
  } catch (e) {
    if (e instanceof TooLarge) throw new Error('a piece of a file was larger than a piece may be.');
    throw e;
  }
}

/** Each answer to a linked PC is sealed with that link's keys (src/link.ts); set per request once its token and seal are checked. */
const sealers = new WeakMap<ServerResponse, { keys: Buffer; id: string; n: number }>();
export const taken = new link.Seen();

/**
 * The direct links on this PC, for its owner (Network, Direct links between PCs): one line a PC, nothing secret. A link in
 * both directions with one PC is one line; ended ones and the ones the owner removed are not listed.
 */
function peersHereView() {
  const hostName = (by: string) => shareState.paired.find(l => l.role === undefined && keepOf(l) === by)?.name ?? 'a host no longer linked';
  const out = new Map<string, { id: string; pc: string; name: string; host: string; scopes: string[]; expires: string | null; lastUsed: string | null }>();
  for (const p of [...(shareState.peers?.in ?? []), ...(shareState.peers?.out ?? [])]) {
    if (p.revoked || p.removedHere) continue;
    const had = out.get(p.pc);
    if (had) {
      for (const s of p.scopes) if (!had.scopes.includes(s)) had.scopes.push(s);
      if ('lastUsed' in p && p.lastUsed && (!had.lastUsed || p.lastUsed > had.lastUsed)) had.lastUsed = p.lastUsed;
      continue;
    }
    out.set(p.pc, { id: p.pc, pc: p.pc, name: p.name, host: hostName(p.by), scopes: [...p.scopes], expires: p.expires, lastUsed: 'lastUsed' in p ? p.lastUsed : null });
  }
  return [...out.values()];
}

/**
 * A request from a peer (src/peerlink.ts): a PC a host linked here introduced, found by its token's fingerprint. Sealed
 * with the peer keys both ways; one that does not open is refused. Then THE peer check, before anything is read or done:
 * the record, its host still linked here, the owner's tick, the home network, its end, and the door against its scopes.
 * Only the ping is answered so far: a door its scope allows but this TOMLIN does not carry for a peer yet says so.
 */
async function peerDoor(req: IncomingMessage, res: ServerResponse, p: string, peer: peerlink.PeerIn): Promise<void> {
  const keys = link.keysOf(peer.key);
  if (!keys) return workerJson(res, 401, { error: 'that PC no longer knows this one (it was removed there, or its host is no longer linked there)' });
  if (req.method !== 'POST') return workerJson(res, 405, { error: 'this PC only takes sealed messages.' });
  if (Number(req.headers['content-length']) > 16_384) return workerJson(res, 400, { error: 'that request is too large for this PC to take at once, so it was refused.' });
  const opened = link.openRequest(keys, await d.body(req, 16_384), p, taken);
  if ('error' in opened) return workerJson(res, 400, { error: opened.error });
  sealers.set(res, { keys, id: opened.id, n: 0 });
  const no = peerlink.peerRefusal({ id: shareState.id, name: shareState.name, allowPeers: carry.cleanAllow(shareState.allow).peer === true, paired: shareState.paired, passes: shareState.passes }, peer, p, req.socket.remoteAddress);
  if (no) return workerJson(res, no.status, no);
  if (peerlink.touchPeer(peer)) void saveShare().catch(() => undefined);
  if (p === peerlink.PEER_HELLO) return workerJson(res, 200, { name: shareState.name, id: shareState.id, version: d.version, scopes: peer.scopes, expires: peer.expires });
  // The read side of a copy (a model this PC shares: its "Sharing of models" tick is asked inside, as for a linked PC):
  // what the model's files are, a piece of one, and the sum of a range of one so the PC that pulled it can check the copy.
  // Never the sending side: nothing is ever written here by a peer.
  if (p === '/worker/carry-files' || p === '/worker/carry-get' || p === '/worker/carry-sum') {
    if (shareState.away) return workerJson(res, 503, { error: `I need to log off for now: someone is using ${shareState.name}. Try again when it is started again.` });
    const a = await carryNode(p, p === '/worker/carry-sum' ? { ...opened.body, source: true } : opened.body, { key: `peer-${peer.pc}`, name: peer.name });
    if ('piece' in a) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return void res.end(link.sealBytes(link.toHost(keys), a.piece, `piece|${opened.id}`));
    }
    return workerJson(res, a.status, a.json);
  }
  return workerJson(res, 501, { error: `"${shareState.name}" cannot do that for a PC linked directly yet.` });
}

function workerJson(res: ServerResponse, status: number, value: unknown) {
  const s = sealers.get(res);
  // Its answer was opened already (it waited its turn in the line on it): a refusal now is that answer's error event.
  if (res.headersSent) {
    if (s && !res.writableEnded) {
      res.write(link.sealedEvent(s.keys, s.id, ++s.n, 'error', { text: String((value as { error?: unknown })?.error ?? `refused (${status})`) }));
      res.end();
    }
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(s ? { v: link.LINK_VERSION, box: link.sealAnswer(s.keys, s.id, 0, value) } : value));
}

/** Starts a stream of events to a linked PC: every event is sealed, its name too. Never sent unsealed. */
function streamTo(res: ServerResponse): Send {
  const s = sealers.get(res);
  if (!s) throw new Error('no sealed link for this answer.');
  // Opened already when it waited in the line: the same answer goes on.
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
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

/** A finished answer or picture from the outbox, sent again as if it were being made (its words, then its last line or the fault). */
function replay(res: ServerResponse, k: Kept) {
  const send = streamTo(res);
  for (const [event, data] of replayOf(k)) send(event, data);
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
  lineStarted.add(res);
  const served0 = servingFor(label);
  const served = () => {
    served0();
    lineEnd(res);
  };
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
/** Models answering for linked PCs now, each with how many answers (more than one with At once). */
class Counts implements Iterable<string> {
  private m = new Map<string, number>();
  add(k: string): this {
    this.m.set(k, (this.m.get(k) ?? 0) + 1);
    return this;
  }
  delete(k: string): boolean {
    const n = (this.m.get(k) ?? 0) - 1;
    if (n > 0) this.m.set(k, n);
    else this.m.delete(k);
    return true;
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  count(k: string): number {
    return this.m.get(k) ?? 0;
  }
  /** Answers in all. */
  get size(): number {
    let t = 0;
    for (const n of this.m.values()) t += n;
    return t;
  }
  [Symbol.iterator](): Iterator<string> {
    return this.m.keys();
  }
}
const lending = new Counts();
/** Tool calls this PC's model made for an asking PC, waiting for that PC to run them (src/jobrun/tooltalk.ts). */
const toolWaits = new tooltalk.ToolWaits();

/**
 * Models this PC loaded because a linked PC asked for them (not loaded here by its owner), with the PCs using each and
 * when one last did: an answer, or the 3-second meters of a chat with it open there. After 10 minutes of neither, the
 * model is dropped by itself. Someone at this PC chatting on it makes it theirs: it then stays, as their models do.
 * Each PC is known by its link (keepOf), not its name: two PCs both called "TOMLIN" never keep each other's
 * models. `by` holds the names, for the Nodes page.
 */
const loadedForPc: nodestaff.LoadedFor = new Map();
const UNUSED_DROP_MS = nodestaff.CHAT_DROP_MS;
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
// Which loaded models stay (src/nodestaff.ts): an answer keeps every chat model loaded for that PC; the meters of an
// open chat keep only the model that chat uses, never the picture model; a refused or failed run keeps none.

/**
 * The models linked PCs are using on this PC now: loaded for them (dropped by itself after 10 minutes unused, the same for a picture model) or answering
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

/** Every model on this PC: linked PCs may use any of them (share.json's old list of ticked models is no longer read). */
const onThisPc = () => [...d.chatList().map(m => m.id), ...d.pictureModels().filter(m => m.installed).map(m => m.id)];

/**
 * The backup disk's size and room as last read. A hello has 3 s and a hard disk that has spun down can take longer than
 * that to wake, which made an on PC look off: so a hello never waits for it. Read again in the background, at most
 * every 30 s (null until the first read is in: "not known").
 */
let keptDisk: { total: number; free: number } | null = null;
let keptDiskAt = 0;
let keptDiskReading: Promise<void> | null = null;
function keptDiskNow(): { total: number; free: number } | null {
  if (!keptDiskReading && Date.now() - keptDiskAt > 30_000) {
    keptDiskReading = carry.diskOf(d.carry.keptRoot).then(x => {
      keptDisk = x;
      keptDiskAt = Date.now();
    }, () => undefined).finally(() => {
      keptDiskReading = null;
    });
  }
  return keptDisk;
}

/** The models linked PCs may use (all of them), as they stand now (asked fresh each hello). */
async function sharedNow(): Promise<nodestaff.SharedModel[]> {
  const s = await d.store.settings();
  const pictures = d.pictureModels().filter(m => m.installed);
  const isPicture = (id: string) => pictures.some(m => m.id === id);
  const v = d.imagePane.view;
  const chats = d.chatList();
  return nodestaff.sharedList({
    models: [...chats.map(m => ({ ...m, kind: 'chat' as const })), ...pictures.map(m => ({ id: m.id, name: pictureName(m)!, bytes: m.bytes ?? 0, kind: 'image' as const }))],
    ctxOf: id => {
      const p = d.runnerFor(id);
      return (p?.view.state === 'connected' ? d.runOn(p) : d.runOf(s, id)).ctx;
    },
    loaded: id => (isPicture(id) ? v.model === id && v.state === 'connected' : d.runnerFor(id)?.view.state === 'connected'),
    hidden: id => d.isHidden?.(id) === true,
    usedAt: id => d.usedAt?.(id) ?? null,
    assigned: id => assignedTo(d.staff.list(), id),
    runOf: id => {
      const m = chats.find(x => x.id === id);
      const run = d.runOf(s, id);
      return { draft: run.draft ?? '', guessers: m ? runset.guessersFor(m, chats) : [], cache: run.cache, kvRam: run.kvRam === true };
    },
    // A model not loaded is not busy (busy() with no runner would mean "anything, anywhere").
    busy: id => {
      if (isPicture(id)) return drawing || d.imageBusy();
      const p = d.runnerFor(id);
      return lending.has(id) || (!!p && d.busy(p));
    },
  });
}

/**
 * Sets a model's Guessing model here for a linked PC, in this PC's own settings (the rest of its setup is kept). A
 * model loaded here and not answering is let go, so its next answer starts it with the new setting; one answering keeps
 * going and uses it from its next load.
 */
async function runSetHere(b: Record<string, unknown>, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  if (typeof b.runner === 'string' || typeof b.fallback === 'boolean') return runnerSetHere(b, by);
  if (b.cache !== undefined || b.kvRam !== undefined) return cacheSetHere(b, by);
  const chats = d.chatList();
  const ask = runset.runSetAsk(b, chats);
  if ('error' in ask) return { status: ask.status, json: { error: ask.error } };
  const { model, draft } = ask;
  const s = await d.store.settings();
  const { draft: _was, spec: wasSpec, ...rest } = d.runOf(s, model.id);
  const builtIn = draft === runset.BUILT_IN;
  const spec = builtIn ? 'mtp' : wasSpec === 'mtp' ? undefined : wasSpec;
  await d.store.saveSettings({ run: { [model.id]: { ...rest, ...(spec ? { spec } : {}), ...(draft && !builtIn ? { draft } : {}) } } });
  const draftName = builtIn ? 'its own built-in guesser (MTP)' : chats.find(m => m.id === draft)?.name ?? '';
  runChanges.unshift({ model: model.id, name: model.name, draft, draftName, by, at: new Date().toISOString() });
  runChanges.length = Math.min(runChanges.length, 5);
  noted(`"${by}" set the guessing model for ${model.name} on this PC to ${draftName || 'none'}.`);
  const p = d.runnerFor(model.id);
  const letGo = !!p && p.view.state === 'connected' && !d.busy(p);
  if (letGo) await p!.disconnect();
  const when = letGo ? 'It was loaded there and not answering, so it was let go: its next answer starts it with this.' : p ? 'It is answering there now: it uses this from its next load.' : 'It uses this from its next load.';
  return { status: 200, json: { said: `${model.name} on "${shareState.name}": guessing model ${draftName || 'none'}. ${when}`, letGo } };
}

/**
 * Holds one of this PC's models to a runner (or back to Auto) for a linked PC: the crash notice's "Use this runner",
 * after the person said yes there. Only a runner this PC pins, has unpacked and can use (src/runset.ts runnerSetAsk). A
 * model loaded here and not answering is let go, so its next answer starts on the new runner.
 */
async function runnerSetHere(b: Record<string, unknown>, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const rt = d.runner.runtimes;
  const ask = runset.runnerSetAsk(b, d.chatList(), rt.pins, id => rt.installedPin(id), id => d.runner.why(id, shareState.name));
  if ('error' in ask) return { status: ask.status, json: { error: ask.error } };
  const s = await d.store.settings();
  const { runner: was, fallback: wasFallback, ...rest } = d.runOf(s, ask.model.id);
  const runner = ask.runner === null ? was : ask.runner || undefined;
  const fallback = ask.fallback ?? wasFallback;
  await d.store.saveSettings({ run: { [ask.model.id]: { ...rest, ...(runner ? { runner } : {}), ...(fallback ? { fallback: true } : {}) } } });
  if (ask.runner === null) {
    noted(`"${by}" turned the automatic runner fallback for ${ask.model.name} on this PC ${fallback ? 'on' : 'off'}.`);
    return { status: 200, json: { said: `${ask.model.name} on "${shareState.name}": ${fallback ? 'after a crash it moves to the next runner on its own, and says so' : 'after a crash the notice asks again'}.` } };
  }
  const name = ask.runner ? rt.pins[ask.runner]?.name ?? ask.runner : 'Auto';
  noted(`"${by}" set the runner for ${ask.model.name} on this PC to ${name}.`);
  const p = d.runnerFor(ask.model.id);
  const letGo = !!p && p.view.state === 'connected' && !d.busy(p);
  if (letGo) await p!.disconnect();
  const when = letGo ? 'It was loaded there and not answering, so it was let go: its next answer starts it on this runner.' : p ? 'It is answering there now: it uses this runner from its next load.' : 'It uses this runner from its next load.';
  return { status: 200, json: { said: `${ask.model.name} on "${shareState.name}": runner ${name}. ${when}`, letGo } };
}

/**
 * How long the cache door watches a load of the model it set: a load already under way read the old settings. `graceMs`:
 * a load that read them just before the save may not show as loading for a moment, so it is watched that long anyway.
 */
export const cacheWatch = { stepMs: 500, graceMs: 5_000, watchMs: 20 * 60_000 };

/** A load of `id` under way here: loading, or held by the speed finder (a test, or the reload after Go with this config or Undo). */
const loadingNow = (id: string) => d.runnerFor(id)?.view.state === 'loading' || d.finderTesting?.() === id;

/**
 * After the cache door saved, a load of `id` that started before the save carries the old cache. Once that load is done,
 * the model loaded, not answering and not keeping its context as saved, it is let go, so its next answer starts with the
 * saved setting. True when it was let go. A model answering is left as it is (it uses the setting from its next load).
 */
export async function cacheAfterLoad(id: string): Promise<boolean> {
  const t0 = Date.now();
  let saw = false;
  for (;;) {
    if (loadingNow(id)) saw = true;
    else {
      const p = d.runnerFor(id);
      if (p && p.view.state === 'connected') {
        if (d.busy(p) || lending.has(id)) return false;
        const want = d.runOf(await d.store.settings(), id);
        const on = d.runOn(p);
        // q8_0 loaded where f16 is saved is the load's own pick when f16 crowds the card (src/runset.ts autoCache): kept.
        if ((on.cache === want.cache || (want.cache === 'f16' && on.cache === 'q8_0' && !want.kvRam)) && !!on.kvRam === !!want.kvRam) return false;
        await p.disconnect();
        noted(`${p.view.modelName ?? id} was loading with its old context setting when it was changed, so it was let go: its next answer starts it with a ${runset.cacheWords(want.cache, want.kvRam === true)}.`);
        return true;
      }
      // The load ended with nothing loaded (it failed, or was let go): the next load reads the saved setting.
      if (saw || Date.now() - t0 >= cacheWatch.graceMs) return false;
    }
    if (Date.now() - t0 >= cacheWatch.watchMs) return false;
    await sleep(cacheWatch.stepMs);
  }
}

/**
 * How one of this PC's models keeps its context, for a linked PC: the cache type (f16, q8_0, q4_0) and whether it is in
 * RAM or on the card (src/runset.ts cacheSetAsk). Kept in this PC's own settings, as if set at its own Model settings;
 * a model loaded here and not answering is let go, so its next answer starts with it. A model loading now (the speed
 * finder's reload, say) read the old setting: it is let go once loaded, so the setting is not lost (cacheAfterLoad).
 */
export async function cacheSetHere(b: Record<string, unknown>, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const ask = runset.cacheSetAsk(b, d.chatList());
  if ('error' in ask) return { status: ask.status, json: { error: ask.error } };
  const s = await d.store.settings();
  const { kvRam: wasRam, ...rest } = d.runOf(s, ask.model.id);
  const cache = ask.cache ?? rest.cache;
  const kvRam = ask.kvRam ?? wasRam === true;
  // A smaller cache needs flash attention, which the runner then turns on itself; "off" is kept only with f16.
  const fa = cache === 'f16' ? rest.fa : rest.fa === 'on' ? 'on' : undefined;
  const { fa: _fa, ...kept } = rest;
  await d.store.saveSettings({ run: { [ask.model.id]: { ...kept, cache, ...(fa ? { fa } : {}), ...(kvRam ? { kvRam: true } : {}) } } });
  const words = runset.cacheWords(cache, kvRam);
  noted(`"${by}" set the context of ${ask.model.name} on this PC to a ${words}.`);
  const p = d.runnerFor(ask.model.id);
  const loading = loadingNow(ask.model.id);
  const letGo = !loading && !!p && p.view.state === 'connected' && !d.busy(p);
  if (letGo) await p!.disconnect();
  else void cacheAfterLoad(ask.model.id).catch(e => log.info('node', `The context setting of ${ask.model.name} could not be checked after its load: ${(e as Error).message}`));
  const when = letGo ? 'It was loaded there and not answering, so it was let go: its next answer starts it with this.' : loading ? 'It is loading there now with the setting it had: once that load is done, and it is not answering, it is let go, so its next answer starts with this.' : p ? 'It is answering there now: it uses this from its next load.' : 'It uses this from its next load.';
  return { status: 200, json: { said: `${ask.model.name} on "${shareState.name}": ${words}. ${when}`, cache, kvRam, letGo, ...(loading ? { loading: true } : {}) } };
}

/**
 * A larger context for one of this PC's chat models, asked for by a linked PC for the web. The size is worked out here
 * (src/webctx.ts) from this PC's own list, memory and the model's training, not taken as sent: the most that fits, up to
 * what was asked.
 */
async function ctxSetHere(b: Record<string, unknown>, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const id = typeof b.model === 'string' ? b.model : '';
  const model = d.chatList().find(m => m.id === id);
  if (!model) return { status: 404, json: { error: `${shareState.name} has no such model.` } };
  const asked = Number(b.ctx);
  if (!CONTEXT_SIZES.includes(asked)) return { status: 400, json: { error: 'That is not a context size TOMLIN offers.' } };
  const s = await d.store.settings();
  const run = d.runOf(s, id);
  const plan = planWebContext({ current: run.ctx, contexts: CONTEXT_SIZES, trained: model.trained ?? null, fits: ctx => d.fit(id, { ...run, ctx }).level === 'ok', want: asked });
  if (!plan.change) return { status: 200, json: { changed: false, ctx: run.ctx, said: plan.limit || `${model.name} on "${shareState.name}" already runs with ${run.ctx.toLocaleString('en-GB')} tokens.` } };
  await d.store.saveSettings({ run: { [id]: { ...run, ctx: plan.ctx } } });
  noted(`"${by}" set the context for ${model.name} on this PC to ${plan.ctx} (it was ${run.ctx}), for the web.`);
  const p = d.runnerFor(id);
  const letGo = !!p && p.view.state === 'connected' && !d.busy(p);
  if (letGo) await p!.disconnect();
  return { status: 200, json: { changed: true, ctx: plan.ctx, was: run.ctx, letGo, said: `${model.name} on "${shareState.name}": context ${plan.ctx.toLocaleString('en-GB')} tokens (it was ${run.ctx.toLocaleString('en-GB')}). ${plan.limit} ${letGo ? 'It was loaded and not answering, so it was let go: its next answer starts it with this.' : p ? 'It is answering there now: it uses this from its next load.' : 'It uses this from its next load.'}`.replace(/\s+/g, ' ').trim() } };
}

/**
 * A linked PC asks this PC to let go of the models it loaded for linked PCs, now (not after the idle minutes), so another
 * model can load. A model answering or drawing is left to finish and named; a model this PC's own owner loaded is never
 * let go, only named.
 */
async function freeHere(by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const freed: string[] = [];
  const busy: string[] = [];
  const v = d.imagePane.view;
  if (pictureFor && v.model === pictureFor.id && v.state === 'connected') {
    const name = pictureName(d.pictureModels().find(m => m.id === pictureFor!.id)) ?? pictureFor.id;
    if (drawing || d.imageBusy()) busy.push(name);
    else {
      pictureFor = null;
      await d.imagePane.disconnect();
      freed.push(name);
    }
  }
  for (const [id] of [...loadedForPc]) {
    const r = d.runnerFor(id);
    if (!r || r.view.state === 'disconnected') {
      loadedForPc.delete(id);
      continue;
    }
    const name = d.chatList().find(m => m.id === id)?.name ?? id;
    if (lending.has(id) || d.busy(r)) {
      busy.push(name);
      continue;
    }
    loadedForPc.delete(id);
    await r.disconnect();
    freed.push(name);
  }
  if (freed.length) await sleep(1500);
  // Still loaded and not let go: this PC's own owner loaded it (or it is the one being used).
  const own: string[] = [];
  if (d.imagePane.view.state === 'connected' && !busy.length && !freed.length) own.push(d.imagePane.view.modelName ?? d.imagePane.view.model ?? 'a picture model');
  for (const m of d.chatList()) {
    const r = d.runnerFor(m.id);
    if (r && r.view.state === 'connected' && !loadedForPc.has(m.id) && !busy.includes(m.name)) own.push(m.name);
  }
  if (freed.length) noted(`"${by}" asked this PC to let go of ${freed.join(' and ')}: done.`);
  const parts = [
    freed.length ? `Let go on "${shareState.name}": ${freed.join(', ')}.` : `Nothing to let go on "${shareState.name}" that a linked PC loaded.`,
    busy.length ? `Left to finish (answering or drawing): ${busy.join(', ')}.` : '',
    own.length ? `Loaded by its own owner, left alone: ${own.join(', ')}.` : '',
  ].filter(Boolean);
  return { status: 200, json: { said: parts.join(' '), freed, busy, own } };
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
 * The web tools for an answer a linked PC asked with Web on: run here, with this PC's own search engine (Settings, Web
 * search) and its own home network kept out; what they did goes back with the answer. Null when it was not asked.
 */
/**
 * The tools the asking PC offered for this answer (it said `tools`, 2.0.82 on): this PC's model calls them, the asking PC
 * runs them and gives the results back (src/jobrun/tooltalk.ts). Null when none were offered, or the answer has no
 * request id (the results are matched by it).
 */
function hostToolsFor(b: Record<string, unknown>, send: Send, link: string, rid: string | undefined): ToolBox | null {
  const wire = tooltalk.cleanWire(b.tools);
  return wire && rid ? tooltalk.nodeBox(wire, send, toolWaits, `${link}|${rid}|`) : null;
}

/** Whether the model loaded at `base` can call tools (its chat format says so): the same question the asking PC puts to its own. */
async function callsTools(base: string | null | undefined): Promise<boolean> {
  if (!base) return false;
  try {
    const r = await runnerFetch(`${base}/props`, { headers: runnerHeaders(base), signal: AbortSignal.timeout(5000) });
    return r.ok && ((await r.json()) as { chat_template_caps?: { supports_tools?: boolean } }).chat_template_caps?.supports_tools === true;
  } catch {
    return false;
  }
}

async function webFor(b: Record<string, unknown>, send: Send): Promise<{ turn: WebTurn; box: ToolBox } | null> {
  const ask = cleanWebAsk(b.web);
  if (!ask) return null;
  const search = (await d.store.settings()).webSearch ?? { provider: 'duckduckgo' as const };
  const turn = new WebTurn(ask.seed, { search, perCall: ask.perCall, total: ask.total, onStatus: text => send('status', { text }) });
  // Each page read through the prompt scan (src/promptscan.ts): a flagged one is fenced as data and the web stops there,
  // since nobody here can be asked on a card.
  const run = webGuard((n: string, a: string, s: AbortSignal, r: number) => turn.run(n, a, s, r), why => send('status', { text: `A web page looked like it held orders for an AI (${why}): it was marked as data and no more pages are read for this answer.` }));
  return { turn, box: { defs: WEB_TOOLS, run, rounds: WEB_ROUNDS, onCall: (n, a) => send('status', { text: callWords(n, a) }) } };
}

/**
 * Work from a linked PC's queue (it said `queue`): the picture model this PC loaded for linked PCs makes way when a chat
 * model does not fit beside it (the queue sends one thing at a time to each PC, so the other model waits idle). Never one its owner loaded,
 * nor one drawing. True when it was unloaded.
 */
async function pictureMakesWay(): Promise<boolean> {
  const v = d.imagePane.view;
  if (!pictureFor || v.model !== pictureFor.id || v.state !== 'connected' || drawing || d.imageBusy()) return false;
  noted(`Unloading ${pictureName(d.pictureModels().find(m => m.id === pictureFor!.id)) ?? pictureFor.id} to make room for a chat model a linked PC's queue asked for.`);
  pictureFor = null;
  await d.imagePane.disconnect();
  await sleep(1500);
  return true;
}

/**
 * A chat model linked PC `pc` asked for does not fit: the chat models loaded only for that PC and not answering are
 * unloaded one at a time, oldest first, until it fits (P1-4, 3 Nov: one was unloaded, then Gemma 4 was refused with three
 * test models idle). Returns where it goes now, or `refused` when it still does not fit with all of them gone.
 */
async function chatsMakeRoomFor(id: string, pc: string, link: string, refused: Place): Promise<Place> {
  const out: string[] = [];
  let at = refused;
  for (const other of nodestaff.makeWayOrder(loadedForPc, link, id, x => { const r = d.runnerFor(x); return !!r && r.view.state === 'connected' && !d.busy(r) && !lending.has(x); })) {
    const r = d.runnerFor(other);
    if (!r) continue;
    out.push(d.chatList().find(m => m.id === other)?.name ?? other);
    loadedForPc.delete(other);
    await r.disconnect();
    await sleep(1500);
    at = d.place(id);
    if (!('error' in at)) break;
  }
  if (out.length) noted(`Unloaded ${out.join(' and ')} (loaded for "${pc}", not answering) to make room for a chat model it asked for.`);
  return at;
}

/** The other way round: chat models this PC loaded for linked PCs, not answering, make way for a picture model that does not fit. */
async function chatsMakeWay(model: string): Promise<string[]> {
  const out: string[] = [];
  for (const [id] of [...loadedForPc].sort((a, b) => a[1].at - b[1].at)) {
    // Room in RAM, and room on the card: chat models left on the card sent pictures to the CPU with no word (2 Nov).
    if (d.pictureFit(model) !== 'no' && d.pictureRoom(model)) break;
    const r = d.runnerFor(id);
    if (!r || lending.has(id) || d.busy(r) || r.view.state !== 'connected') continue;
    out.push(d.chatList().find(m => m.id === id)?.name ?? id);
    loadedForPc.delete(id);
    await r.disconnect();
    await sleep(1500);
  }
  if (out.length) noted(`Unloaded ${out.join(' and ')} to make room for a picture model a linked PC asked for.`);
  return out;
}

/** A guest's tools (src/nodeline.ts guestBox): fewer rounds, and their results count against its prompt cap. Others: as given. */
function boxFor(box: ToolBox | undefined, guestRoom: number | null): ToolBox | undefined {
  return box && guestRoom !== null ? nodeline.guestBox(box, guestRoom) : box;
}

async function modelChat(b: Record<string, unknown>, turns: ChatTurn[] | null, ask: { system: string; user: string }, maxTokens: number, res: ServerResponse, forPc: string, keep: KeepAt | null, link: string, guestRoom: number | null = null) {
  const id = String(b.model ?? '');
  const runner = d.runnerFor(id);
  let at = runner ? null : d.place(id);
  if (at && 'error' in at && b.queue === true && (await pictureMakesWay())) at = d.place(id);
  if (at && 'error' in at && d.chatList().some(m => m.id === id)) at = await chatsMakeRoomFor(id, forPc, link, at);
  const swapped = at && !('error' in at) && !at.already && at.replaces ? d.runnerFor(at.replaces) : null;
  // At once: a runner with a slot free takes another answer beside the ones it writes (the line let it in).
  const slots = runner ? atOnceFor(id) : 1;
  const busy = slots > 1 ? lending.count(id) >= slots : lending.has(id) || (!!runner && d.busy(runner)) || (!!swapped && (d.busy(swapped) || lending.has(swapped.view.model ?? '')));
  const why = nodestaff.modelRefusal(id, { onPc: x => d.chatList().find(m => m.id === x)?.name ?? null, busy, pcName: shareState.name });
  if (why) return workerJson(res, why.busy ? 409 : 403, why);
  // The asking PC names this one before it ("Worker PC": ...): said once, not twice.
  if (at && 'error' in at) return workerJson(res, 409, { error: at.error });
  const verdict = checkMessage(turns ? turns.at(-1)!.content : ask.user, { recent: [] });
  if (!verdict.ok) return workerJson(res, 400, { error: REFUSAL[verdict.reason] });
  const name = d.chatList().find(m => m.id === id)!.name;
  const fresh = runner?.view.state !== 'connected';
  lending.add(id);
  let answered = false;
  const asked = Date.now();
  await runFor(res, keep, `Answering for ${forPc}`, { pc: forPc, link, project: projectOf(b) }, async (send, signal) => {
    // The answer so far is sealed and sent as it grows, not at every word-piece (src/engine.ts paced).
    const words = paced(text => send('text', { text }));
    try {
      const got = await brainForRef(id, forPc, 'on that PC', text => send('status', { text }), signal);
      loadedFor(id, forPc, link, fresh);
      // Someone at this PC started a chat on it while it loaded: theirs finishes first (it is never cut for a linked PC).
      for (let told = false; slots <= 1 && !!got.pane && d.busy(got.pane) && !signal.aborted; await sleep(1000)) {
        if (!told) send('status', { text: `${name} is answering someone at that PC first.` });
        told = true;
      }
      const web = got.here ? await webFor(b, send) : null;
      // The asking PC's own tools (files, web, research ...): this model calls them, that PC runs them.
      const offered = got.here ? hostToolsFor(b, send, link, keep?.rid) : null;
      const hostTools = offered && (await callsTools(got.pane?.worker.base ?? d.runnerFor(id)?.worker.base ?? d.chat.worker.base)) ? offered : null;
      const box = boxFor(hostTools ?? web?.box, guestRoom);
      if (turns) await got.brain.chat(turns, maxTokens, words.push, signal, { ...askOpts(b, send), ...(box ? { tools: box } : {}) });
      else await got.brain.ask(ask.system, ask.user, maxTokens, words.push, signal, box ? { tools: box } : undefined);
      words.flush();
      send('done', { model: name, speed: got.brain.last ?? null, thought: got.brain.thought ?? null, usage: usedHere(), ...(got.brain.cut ? { cut: true } : {}), ...(web?.turn.uses.length ? { tools: web.turn.uses } : {}), ...(offered && !hostTools ? { toolsOff: `${name} cannot call tools` } : {}) });
      answered = true;
    } catch (e) {
      words.flush();
      // The runner crashed here: the fault goes with the error, so the asking PC's notice names it (src/faults.ts).
      const fault = signal.aborted ? null : await faultHook.find?.(id, asked).catch(() => null);
      send('error', { text: (e as Error).message, ...(fault ? { fault } : {}) });
    } finally {
      lending.delete(id);
      // Stopped (or failed) after it had loaded but before it was counted: still loaded for that PC, so it drops too.
      if (fresh && !loadedForPc.has(id) && d.runnerFor(id)?.view.state === 'connected') loadedFor(id, forPc, link, true);
      nodestaff.afterRun(loadedForPc, link, answered, Date.now());
      if (answered && pictureFor?.links.has(link)) pictureFor.at = Date.now();
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
async function workerDraw(b: Record<string, unknown>, res: ServerResponse, forPc: string, link: string, keep: KeepAt | null = null, may: (id: string) => boolean = () => true) {
  const prompt = String(b.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!prompt) return workerJson(res, 400, { error: 'no prompt was sent.' });
  if (b.staff !== undefined) return workerJson(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
  const style = brains.isStyle(b.style) ? b.style : null;
  const size = (n: unknown) => (Number.isInteger(n) && (n as number) >= 64 && (n as number) <= 2048 ? (n as number) : undefined);
  const choices = nodestaff.drawChoices(b);
  const models = d.pictureModels();
  const want = typeof b.model === 'string' && b.model ? b.model : null;
  if (want && !may(want)) return workerJson(res, 403, notOnPass());
  if (want) {
    const v = d.imagePane.view;
    const busy = drawing || d.imageBusy() || (v.state === 'loading' && v.model !== want);
    const why = nodestaff.modelRefusal(want, { onPc: x => pictureName(models.find(m => m.id === x && m.installed)), busy, pcName: shareState.name });
    if (why) return workerJson(res, why.busy ? 409 : 403, why.busy ? { ...why, error: why.error.replace('is answering something else', 'is drawing something else') } : why);
    return drawShared(models.find(m => m.id === want)!, { prompt, style, width: size(b.width), height: size(b.height), ...choices }, res, forPc, link, keep);
  }
  const v = d.imagePane.view;
  if (v.state !== 'connected') return workerJson(res, 409, { error: 'no picture model is connected on that PC. Its owner connects one in an artist\'s chat there; nothing loads by itself.' });
  if (drawing) return workerJson(res, 409, { error: 'that PC is already drawing a picture for another PC. Try again in a minute.' });
  const loaded = models.find(m => m.id === v.model);
  if (!loaded) return workerJson(res, 409, { error: 'its connected picture model is not one TOMLIN knows.' });
  if (!may(loaded.id)) return workerJson(res, 403, notOnPass());
  // The connected picture model draws for them; a swap for the style goes to another installed one.
  const notLent = nodestaff.modelRefusal(loaded.id, { onPc: x => pictureName(models.find(m => m.id === x && m.installed)), busy: false, pcName: shareState.name });
  if (notLent) return workerJson(res, 403, notLent);
  drawFor(res, keep, `Drawing for ${forPc}`, async (send, signal) => {
    try {
      // A guest's style swap goes only to a picture model its pass names.
      const plan = brains.modelForStyle(style, loaded, models.filter(m => m.installed && may(m.id)), true);
      if (plan.swap) {
        send('progress', { state: 'starting', text: `Switching to ${plan.use.name.replace(/\s*\(.*\)$/, '')} for the style` });
        if (!(await d.swapImage(plan.use.id))) throw new Error(`${plan.use.name} did not load there. Its owner can connect it in an artist's chat there.`);
      }
      const r = await d.draw({ prompt, mode: style ? brains.modeOfStyle(style) : 'custom', width: size(b.width), height: size(b.height), forPc, ...choices }, p => send('progress', p), signal);
      if ('error' in r) throw new Error(r.error);
      send('picture', { png: r.png.toString('base64'), modelName: r.modelName, modelPrompt: r.modelPrompt, mode: r.mode, seconds: r.seconds, made: r.made, note: [plan.note, r.note ? `says: ${r.note}` : ''].filter(Boolean).join('; ') });
    } catch (e) {
      send('error', { text: (e as Error).message });
    }
  });
}

/**
 * A drawing for a linked PC, one at a time. Asked with a request id (`keep`, 2.0.89 on) it runs to its end when that PC
 * goes away, and the picture waits in the outbox until that PC collects it (src/outbox.ts); without (an older PC),
 * closing the connection stops it, as before. `after` runs once it has ended either way.
 */
function drawFor(res: ServerResponse, keep: KeepAt | null, label: string, work: (send: Send, signal: AbortSignal) => Promise<void>, after?: () => void): void {
  drawing = true;
  lineStarted.add(res);
  const served = servingFor(label);
  const end = () => {
    drawing = false;
    served();
    lineEnd(res);
    after?.();
  };
  if (keep) {
    box.start(keep.owner, keep.rid, keep.lock, followerOf(res), (send, signal) => work(send, signal).finally(end));
    return;
  }
  // The follower writes a line every 20 s while the model works, so the manager PC does not give up on a long silence.
  const f = followerOf(res);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  void work(f.send, ac.signal).finally(() => {
    end();
    f.end();
  });
}

/** A picture model's name as people read it ("DreamShaper 8", not its file details), or null when it is not here. */
const pictureName = (m: brains.PictureModel | undefined) => (m ? m.name.replace(/\s*\(.*\)$/, '') : null);

/**
 * A picture on one of the picture models this PC lets linked PCs use: loaded first when it is not (the picture model
 * loaded here makes way, it is not drawing: checked before), then drawn as the linked PC asked (its artist's words are
 * already in the prompt). A picture model loaded for a linked PC is dropped by itself 10 minutes after its last picture
 * (src/picturelock.ts PICTURE_DROP_MS): long enough for pictures one after another, short while the PC is locked.
 */
async function drawShared(model: brains.PictureModel, ask: { prompt: string; style: brains.Style | null; width?: number; height?: number; quality?: string; seed?: number; negative?: string }, res: ServerResponse, forPc: string, link: string, keep: KeepAt | null) {
  const name = pictureName(model)!;
  drawFor(res, keep, `Drawing for ${forPc}`, async (send, signal) => {
    try {
      const v = d.imagePane.view;
      const fresh = !(v.model === model.id && v.state === 'connected');
      if (fresh) {
        // Chat models loaded here for linked PCs make way when it does not fit, in RAM or on the card.
        const made = await chatsMakeWay(model.id);
        send('progress', { state: 'starting', text: `${made.length ? `Unloaded ${made.join(' and ')} there to make room. ` : ''}${v.state === 'connected' && v.model ? `Switching to ${name} there` : `Loading ${name} there`}` });
        if (!(await d.loadImage(model.id))) throw new Error(`${name} did not load on "${shareState.name}" (its owner may have started a picture there, or it is too big for that PC's memory now).`);
        pictureFor = { id: model.id, by: new Set([forPc]), links: new Set([link]), at: Date.now() };
      } else if (pictureFor?.id === model.id) {
        pictureFor.by.add(forPc);
        pictureFor.links.add(link);
      }
      const r = await d.draw({ prompt: ask.prompt, mode: ask.style ? brains.modeOfStyle(ask.style) : 'custom', width: ask.width, height: ask.height, forPc, quality: ask.quality, seed: ask.seed, negative: ask.negative }, p => send('progress', p), signal);
      if ('error' in r) throw new Error(r.error);
      send('picture', { png: r.png.toString('base64'), modelName: r.modelName || name, modelPrompt: r.modelPrompt, mode: r.mode, seconds: r.seconds, made: r.made, note: r.note ? `says: ${r.note}` : '' });
    } catch (e) {
      send('error', { text: (e as Error).message });
    }
  }, () => {
    if (pictureFor?.id === model.id) pictureFor.at = Date.now();
  });
}

/** The worker side: pair, hello, run, draw. Home network only, no browser pages (no Origin), a paired token for all but pair. */
async function workerRoute(req: IncomingMessage, res: ServerResponse) {
  try {
    const ip = req.socket.remoteAddress ?? '';
    if (!share.isPrivateAddress(ip)) return workerJson(res, 403, { error: 'This worker only answers PCs on its own home network.' });
    if (req.headers.origin) return workerJson(res, 403, { error: 'Web pages cannot use this worker.' });
    const p = new URL(req.url ?? '/', 'http://worker').pathname;
    if (req.method === 'POST' && p === '/worker/pair') {
      const tooMany = () => {
        const locked = guard.lockedFor(ip);
        if (locked) return workerJson(res, 429, { error: `Too many wrong PINs from this PC. Try again in ${locked} minute${locked > 1 ? 's' : ''}.` }), true;
        const paused = guard.pausedFor();
        if (paused) return workerJson(res, 429, { error: `linking to this PC is paused for ${paused} minute${paused > 1 ? 's' : ''}: too many wrong setup codes were typed from your home network. Wait, then link again; if nobody here typed them, make a new setup code on that PC (Network).` }), true;
        return false;
      };
      if (tooMany()) return;
      const b = await d.body(req, 4096);
      // F7 E1: only the encrypted link. A main PC from before it is told to update.
      if (Number(b.v) !== link.LINK_VERSION || typeof b.pub !== 'string') return workerJson(res, 426, { error: 'this PC now uses an encrypted link. Update TOMLIN on this main PC, then link again.' });
      // A guest pass (src/guestpass.ts) needs no PIN: while a live pass is here, a PC that typed none may be a guest, so
      // its code is tried (and a wrong one counted) before it is told about the PIN. With no pass here, as before.
      const passHere = () => (shareState.passes ?? []).filter(x => guestpass.passUsable(shareState, x));
      // A request signed with an admin key (Bootable USB): checked only against the admin this stick was minted by.
      const adminAsk = typeof b.adminSig === 'string';
      if (!adminAsk && shareState.pinOn && b.pinGiven !== true && !passHere().length) return workerJson(res, 403, { error: 'this PC also asks for its 6-digit link PIN, shown under Network there. Type it and link again.', needPin: true });
      // A PIN typed when this PC asks for none (often its app lock PIN) would change the key and read as a wrong setup
      // code: said plainly, and not counted as a wrong try.
      if (!adminAsk && !shareState.pinOn && b.pinGiven === true) return workerJson(res, 400, { error: 'this PC does not ask for a link PIN: leave the PIN box empty and link again. (Its app lock PIN is never typed here.)', noPin: true });
      // Looked at again now the body is here, and the try counted before the check, so tries sent side by side (each
      // holding its body back until all are in) cannot all slip under the wrong-try limit; a right one clears the count.
      if (tooMany()) return;
      guard.wrong(ip);
      const token = share.newToken();
      const me = { id: shareState.id, name: shareState.name };
      // The setup code (with the PIN when this PC asks for one), then each live guest pass (no PIN): each a cheap check
      // of the key already made, so trying them all costs no more than one.
      let got: { keys: Buffer; answer: unknown } | null = null;
      let pass: guestpass.GuestPass | undefined;
      // The admin this stick was minted by (Bootable USB): its PC links with no setup code or PIN, proven by a signature
      // only its private key can make. Nothing on the stick can make it, so a copied stick links to nobody.
      let byAdminKey = false;
      if (adminAsk) {
        got = usbStick ? link.adminNodeAnswer(usbStick.adminPub, usbStick.stick, b, me, token) : null;
        if (!got) return workerJson(res, 403, { error: usbStick ? 'this PC was minted by another admin PC (or the request is too old: check both clocks). Only that admin can link it; mint the stick again to make it yours.' : 'this PC was not started from a Bootable USB stick, so an admin key does not link it. Use its setup code.' });
        byAdminKey = true;
      } else {
        got = shareState.pinOn && b.pinGiven !== true ? null : link.nodeAnswer(await nodePairKey(), b, me, token);
      }
      if (!got && b.pinGiven !== true) {
        for (const x of passHere()) {
          got = link.nodeAnswer(Buffer.from(x.key, 'base64url'), b, me, token);
          if (got) {
            pass = x;
            break;
          }
        }
      }
      if (!got) {
        if (shareState.pinOn && b.pinGiven !== true) return workerJson(res, 403, { error: 'that is not a guest pass of this PC, and it also asks for its 6-digit link PIN, shown under Network there. Type the setup code and the PIN and link again.', needPin: true });
        return workerJson(res, 403, { error: shareState.pinOn ? 'wrong setup code or PIN. Type the code and the PIN shown on that PC under Network.' : 'wrong setup code. Type the code shown on that PC under Network (8 letters and numbers).' });
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
      // A guest takes over only a guest link of its own: never a full one.
      const old = from ? shareState.paired.find(x => {
        const k = x.from === from && (!pass || x.role === 'guest') ? link.keysOf(x.key) : null;
        return !!k && [b.proof, ...(Array.isArray(b.proofs) ? b.proofs.slice(0, 16) : [])].some(pr => link.takeOverProven(k, String(b.pub), pr));
      }) : undefined;
      const proven = !!old;
      const kept = proven ? shareState.paired.filter(x => x !== old) : shareState.paired;
      const keep = proven ? keepOf(old!) : randomBytes(8).toString('hex');
      const name = String(b.name ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'A manager PC';
      // Ten links at most: the oldest goes, and the owner is told which. A guest's link never pushes one out (three per
      // pass at most, its own oldest goes: src/guestpass.ts addLink).
      const added = guestpass.addLink(kept, { ...(from ? { from } : {}), keep, name, hash: share.hashToken(token), key: link.keysText(got.keys), at: new Date().toISOString(), ...(pass ? { role: 'guest' as const, passId: pass.id, expires: pass.expires } : {}), ...(byAdminKey ? { byKey: true } : {}) });
      const dropped = added.dropped;
      shareState.paired = added.paired;
      if (byAdminKey) {
        // The admin key is not used up: the setup code shown here stays as it was.
        shareState.lastLinked = { name, at: new Date().toISOString(), ...(dropped ? { dropped } : {}) };
      } else if (pass) {
        // A pass is not used up: its owner made it for this PC, and its end date (or Remove) ends it.
        pass.uses += 1;
        pass.lastSeen = new Date().toISOString();
      } else {
        // The code is used up (audit X4): someone who once saw it cannot link later, unseen. The owner sees who linked.
        shareState.code = share.newCode();
        shareState.lastLinked = { name, at: new Date().toISOString(), ...(dropped ? { dropped } : {}) };
      }
      await saveShare();
      log.info('link', `"${name}" linked to this PC${pass ? ` with the guest pass "${pass.label}"` : byAdminKey ? ' with its admin key' : ''}.${dropped ? ` The oldest link, "${dropped}", was removed.` : ''}`);
      d.onLinked?.(name, dropped, pass?.label);
      return workerJson(res, 200, got.answer);
    }
    // Only enough to be found on the home network: that this is TOMLIN, its name, whether it asks for a PIN.
    if (req.method === 'GET' && p === '/worker/whoami') return workerJson(res, 200, { app: 'smart-manager', name: shareState.name, version: d.version, pin: shareState.pinOn, link: link.LINK_VERSION, ...whoamiExtra() });
    // The link is named by its token's fingerprint: the token itself never crosses the network after linking.
    const named = /^Link ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const who = share.pairedByHash(shareState, named);
    if (!who) {
      // Not a link: a PC a host introduced to this one (src/peerlink.ts) has its own, much shorter, set of doors.
      const peer = peerlink.peerByHash(shareState.peers ?? peerlink.NO_PEERS, named);
      if (peer) return peerDoor(req, res, p, peer);
      return workerJson(res, 401, { error: 'that PC no longer knows this one (it was removed there, or set up again)' });
    }
    // Every message from here on is sealed both ways (F7 E1): one that does not open is refused.
    const keys = link.keysOf(who.key);
    if (!keys) return workerJson(res, 401, { error: 'this link was made before links were encrypted. Link this PC again from the main PC (Network, Find PCs on my network, then the setup code).' });
    if (req.method !== 'POST') return workerJson(res, 405, { error: 'this PC only takes sealed messages. Update TOMLIN on the main PC.' });
    // A piece of a file (a model or a restore point sent here): the request rides in a header, the piece is the body.
    const putDoor = p === '/worker/carry-put' || p === '/worker/backup-put' || p === '/worker/update-put' || p === '/worker/git-put' || p === '/worker/runner-put';
    // A project backup's file list and the ids asked about are long (up to 100,000 files).
    const limit = p === '/worker/run' || p === '/worker/tool-result' ? chatBytesFor(await chatCharsHere()) : p === '/worker/update-offer' ? 4 << 20 : p === '/worker/git-commit' ? 32 << 20 : p === '/worker/git-have' || p === '/worker/passes-put' || p === '/worker/peer-put' ? 1 << 20 : 16_384;
    // Read whole before the seal can be checked: refused at once when it says it is larger than this door takes, or when
    // this link (or all of them) already has that much being read (S4). A piece is read only after its header opens.
    const declared = Number(req.headers['content-length']);
    if (!putDoor && declared > limit) return workerJson(res, 400, { error: 'that request is too large for this PC to take at once, so it was refused.' });
    const giveBack = putDoor || limit <= 16_384 ? () => undefined : bodies.take(who.hash, declared >= 0 && declared <= limit ? declared : limit);
    if (!giveBack) return workerJson(res, 429, { error: 'this PC is taking in other large requests from linked PCs now. Try again in a minute.' });
    let sent: Record<string, unknown> | { box: string };
    try {
      sent = putDoor ? { box: String(req.headers['x-link'] ?? '') } : await d.body(req, limit);
    } finally {
      giveBack();
    }
    const opened = link.openRequest(keys, sent, p, taken);
    if ('error' in opened) return workerJson(res, 400, { error: opened.error });
    // Guests (src/guestpass.ts): THE check of role and end date, for every door, before anything here is read or done.
    const refusedHere = guestpass.doorRefusal(shareState, who, p);
    if (refusedHere) {
      sealers.set(res, { keys, id: opened.id, n: 0 });
      // An expired (or blocked) guest is told whether it may ask its host, and what became of its last request.
      const told = refusedHere.guest === 'expired' || refusedHere.guest === 'blocked' ? { ...refusedHere, ...guestpass.askState(shareState.passAsks ?? [], who) } : refusedHere;
      return workerJson(res, refusedHere.status, told);
    }
    const guest = who.role === 'guest';
    if (guest) {
      const used = guestpass.passOf(shareState, who);
      if (used && guestpass.touchSeen(used)) void saveShare().catch(() => undefined);
    }
    /** Whether this link may use model `id` here (a guest: only its pass's). */
    const may = (id: string | null | undefined) => guestpass.modelAllowed(shareState, who, id);
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
      const models = (await sharedNow()).filter(m => may(m.id));
      const allow = carry.cleanAllow(shareState.allow);
      // A guest is told only what it may use: its pass's models, no tick but pulling updates, nothing about other links,
      // drives or backups, and what it may not do left out of "can" (the doors refuse it anyway). Nor this PC's memory
      // (it holds the Windows computer name and every loaded model's name), its total meter, its runner, speed, how
      // long it has been up, or when its owner is at it: only whether it is busy. Its own tally is at /worker/usage.
      const asGuest = <T extends Record<string, unknown>>(h: T) => {
        // A host's link may give this PC a host PIN (src/hostpin.ts): it is told so, and whether it holds one here now.
        if (!guest) return { ...h, can: [...(h.can as string[]), hostpin.CAN], hostPin: d.hostPinHeld(who.hash), hostKey: d.hostKeyHeld(who.hash), ...(usbStick ? { usb: true } : {}) };
        const pass = guestpass.passOf(shareState, who);
        const busy = !!away || line.running().length > 0 || line.waiting().length > 0;
        return { ...h, state: h.state === 'away' ? 'busy' : h.state, busy, away: null, memory: null, meter: null, up: null, installed: null, restarts: false, runner: null, speed: null, can: (h.can as string[]).filter(c => GUEST_CAN.includes(c)), allow: { ...carry.NO_ALLOW, give: allow.give, off: false }, plainLinks: false, ask: null, lentTo: null, cluster: null, disk: null, drives: [], modelsDrive: '', cpu: null, passAsks: [], guest: { label: pass?.label ?? '', expires: pass ? guestpass.linkEnds(who, pass) : who.expires ?? null, caps: nodeline.cleanCaps(shareState.guestCaps) } };
      };
      const up = { since: d.startedAt, pc: Math.round(uptime()) };
      const installed = installedAt();
      // Requests from guests whose pass this host made: its own to answer (on its screen).
      const giver = keepOf(who);
      const passAsks = (shareState.passAsks ?? []).filter(a => !a.answer && a.by === giver).map(a => ({ id: a.id, name: a.name, expired: a.expired, text: a.text, at: a.at }));
      // The disk that keeps other PCs' backups here, so they see the room left: as last read, never waited for.
      const disk = keptDiskNow();
      // As last read, never waited for (src/modelhome.ts driveReportNow): this answer has 3 s.
      const driveJobs = jobsHere();
      const drives = driveReportNow().map(x => ({ ...x, jobs: driveJobs[x.drive] ?? [] }));
      // The drive a model sent here is written to (its models folder): the Move window's free space is that drive's.
      const modelsDrive = driveOf(d.carry.chatDir);
      // Its processor: name, cores and threads, for the host's Cluster page (not told to a guest: asGuest).
      const cpu = d.cpu?.() ?? null;
      // build: what code this copy is (src/update.ts buildId), so the main PC tells one version with other files apart.
      if (away) return workerJson(res, 200, asGuest({ name: shareState.name, version: d.version, build: d.build(), model: null, ctx: d.runNow().ctx, state: 'away', away: away.since, ask: null, memory: d.memory(), can: ['models', 'draw-models', 'carry', 'update', 'outbox', 'usage', 'git', 'fetch', 'runner', 'tune', 'max', 'receive', 'model-remove', 'ctx-set', 'update-pin', 'give', 'tooltalk', 'carry-sum', 'model-staff', 'passes', 'power-off', PERM_CAN, 'peers', 'peer-copy', 'drive-jobs', 'dl-queue', 'models-where', 'cache-set', 'hardware-rescan'], image: null, models: models.map(x => ({ ...x, loaded: false, busy: false })), allow, plainLinks: shareState.plainLinks === true, chatChars: await chatCharsHere(), restarts: d.update.restarts, up, meter: d.meter(), installed, disk, drives, modelsDrive, runner: runnerHello(), cpu, lentTo: lentTo(), speed: forHello(speedNow()), passAsks, line: { running: line.running().length, waiting: line.waiting().length } }));
      // The connected models are named (every model here is lent; to a guest, only its pass's).
      const lent = (id: string | null | undefined) => !!id && onThisPc().includes(id) && may(id);
      const img = imageHello();
      return workerJson(res, 200, asGuest({ name: shareState.name, version: d.version, build: d.build(), ask: share.askPending(shareState.ask), model: v.state === 'connected' && lent(v.model) ? v.modelName : null, ctx: d.runNow().ctx, state: v.state, memory: d.memory(), can: ['turns', 'draw', 'draw-outbox', 'stats', 'models', 'draw-models', 'think', 'carry', 'update', 'outbox', 'usage', 'git', 'fetch', 'runner', 'tune', 'max', 'web', 'receive', 'model-remove', 'ctx-set', 'update-pin', 'give', 'tooltalk', 'carry-sum', 'model-staff', 'passes', 'power-off', PERM_CAN, 'peers', 'peer-copy', 'drive-jobs', 'dl-queue', 'models-where', 'cache-set', 'hardware-rescan'], image: lent(img.model) ? img : { ...img, model: null, name: null, styles: [] }, models, away: null, allow, plainLinks: shareState.plainLinks === true, chatChars: await chatCharsHere(), restarts: d.update.restarts, up, meter: d.meter(), installed, disk, drives, modelsDrive, runner: runnerHello(), cpu, lentTo: lentTo(), speed: forHello(speedNow()), passAsks, line: { running: line.running().length, waiting: line.waiting().length }, cluster: guest ? null : clusterHello(req.socket.localAddress), addrs: guest ? [] : lanList().map(n => n.address) }));
    }
    // An expired guest asks its host for more (src/guestpass.ts): only a guest link whose pass expired gets here (the
    // check above), one request waiting at a time, 10 minutes apart, 5 a day, plain text of 200 characters at most.
    if (p === guestpass.ASK_DOOR) {
      const pass = guest ? guestpass.passOf(shareState, who) : undefined;
      if (!pass) return workerJson(res, 403, { error: 'only a guest whose pass ended can ask for more time.' });
      const text = guestpass.cleanAskText(body.text);
      if (!text) return workerJson(res, 400, { error: 'write a few words for the owner first.' });
      const why = guestpass.askWhy(shareState.passAsks ?? [], who.hash);
      if (why) return workerJson(res, 409, { error: `${why}.` });
      const asked: guestpass.PassAsk = { id: randomBytes(4).toString('hex'), link: who.hash, name: who.name, passId: pass.id, ...(pass.by ? { by: pass.by } : {}), expired: guestpass.linkEnds(who, pass) ?? new Date().toISOString(), text, at: new Date().toISOString() };
      shareState.passAsks = guestpass.keepAsks([...(shareState.passAsks ?? []), asked]);
      await saveShare();
      if (!pass.by) d.onPassAsk?.('', who.name);
      return workerJson(res, 200, { ok: true, state: 'waiting' });
    }
    // The host that made a guest's pass answers its request: renew the same link, deny with a reason, or block it.
    if (p === '/worker/pass-answer') {
      if (who.role !== undefined) return workerJson(res, 403, { error: 'only the host that made the pass can answer.' });
      const q = (shareState.passAsks ?? []).find(a => a.id === body.id);
      if (!q || q.by !== keepOf(who)) return workerJson(res, 404, { error: 'that request is not here, or is not yours to answer.' });
      const done = guestpass.answerAsk(shareState.passAsks ?? [], shareState.paired, body.id, { answer: body.answer, length: body.length, reason: body.reason });
      if ('error' in done) return workerJson(res, 409, { error: done.error });
      shareState.passAsks = done.asks;
      shareState.paired = done.paired;
      await saveShare();
      // The host notes the renewed link's new end on its own pass (its list shows it).
      const renewed = done.paired.find(x => x.role === 'guest' && x.hash === done.ask.link);
      return workerJson(res, 200, { ok: true, answer: done.ask.answer, passId: done.ask.passId, name: done.ask.name, until: done.ask.answer === 'renewed' ? renewed?.expires ?? null : undefined });
    }
    // A host's guest passes for this PC (src/guestpass.ts mergeFrom): only from a link with no role (an admin link; a guest
    // was refused above), kept as given by that link, an older set or revision never taken over a newer one. A pass it
    // ended takes the links made with it. Taken while someone here uses the PC too: it is a list, not work.
    if (p === '/worker/passes-put') {
      if (who.role !== undefined) return workerJson(res, 403, { error: 'only a host linked here can send guest passes.' });
      const gen = Number(body.gen);
      if (!Number.isSafeInteger(gen) || gen <= 0) return workerJson(res, 400, { error: 'the guest passes sent were not in the expected form.' });
      const by = keepOf(who);
      const was = shareState.passes ?? [];
      const linked = new Set(shareState.paired.filter(l => l.role === undefined).map(l => keepOf(l)));
      const got = guestpass.mergeFrom(was, body.passes, { by, gen, lastGen: shareState.passGens?.[by], nodeId: shareState.id, gone: k => !linked.has(k) });
      if (!got.stale) {
        const ended = new Set(got.passes.filter(x => x.revoked && was.some(w => w.id === x.id && !w.revoked)).map(x => x.id));
        shareState.passes = got.passes;
        shareState.paired = guestpass.dropEnded(guestpass.stampEnded(shareState.paired, ended));
        shareState.passGens = { ...shareState.passGens, [by]: gen };
        await saveShare();
        if (got.taken) noted(`"${who.name}" sent its guest passes for this PC (${got.taken} changed).`);
      }
      return workerJson(res, 200, { ok: true, gen: got.stale ? shareState.passGens?.[by] ?? gen : gen, stale: got.stale, held: (shareState.passes ?? []).filter(x => x.by === by && !x.revoked).length });
    }
    // A host's introductions for this PC (src/peerlink.ts mergePeers): which PCs may call it directly, and which it may
    // call. Only from a link with no role (a guest was refused above), kept as given by that link in a list of their own,
    // never among this PC's links. An older set or revision is never taken over a newer one, and a peer removed on this
    // PC is not brought back. Taking the list starts nothing: each use is checked again when it happens.
    if (p === '/worker/peer-put') {
      if (who.role !== undefined) return workerJson(res, 403, { error: 'only a host linked here can introduce PCs to this one.' });
      const gen = Number(body.gen);
      if (!Number.isSafeInteger(gen) || gen <= 0 || !body.peers || typeof body.peers !== 'object') return workerJson(res, 400, { error: 'the introductions sent were not in the expected form.' });
      const by = keepOf(who);
      const linked = new Set(shareState.paired.filter(l => l.role === undefined).map(l => keepOf(l)));
      const got = peerlink.mergePeers(shareState.peers ?? peerlink.NO_PEERS, body.peers, { by, gen, lastGen: shareState.peerGens?.[by], nodeId: shareState.id, gone: k => !linked.has(k) });
      if (!got.stale) {
        shareState.peers = got.peers;
        shareState.peerGens = { ...shareState.peerGens, [by]: gen };
        await saveShare();
        if (got.taken) noted(`"${who.name}" sent the PCs this one may talk to directly (${got.taken} changed).`);
      }
      const mine = [...(shareState.peers?.in ?? []), ...(shareState.peers?.out ?? [])].filter(x => x.by === by);
      return workerJson(res, 200, { ok: true, gen: got.stale ? shareState.peerGens?.[by] ?? gen : gen, stale: got.stale, held: mine.filter(x => !x.revoked).length, removedHere: [...new Set(mine.filter(x => x.removedHere).map(x => x.id))] });
    }
    // The host asks whether this PC reaches a PC it was introduced to, directly (src/jobrun/peercall.ts): on which
    // address and how fast, or why not. Only a ping goes out, and only to a peer this PC holds.
    if (p === '/worker/peer-ping') {
      if (who.role !== undefined) return workerJson(res, 403, { error: 'only a host linked here can ask that.' });
      const out = (shareState.peers?.out ?? []).find(x => x.pc === body.pc && !x.revoked);
      if (!out) return workerJson(res, 404, { error: 'this PC has not been introduced to that PC.' });
      return workerJson(res, 200, await peerPing(out));
    }
    // The host orders a model copied straight from a PC it introduced this one to (src/jobrun/peercopy.ts): this PC pulls
    // it, and the host asks how far it got. Only a host (an admin link) may order it, and only from a peer this PC holds.
    if (p === '/worker/peer-copy') {
      if (who.role !== undefined) return workerJson(res, 403, { error: 'only a host linked here can order that.' });
      const a = await peerCopy(body, !!away);
      return workerJson(res, a.status, a.body);
    }
    // This PC's meters for the head of a paired PC's chat with someone here: read from what the sampler measured in
    // the last second for this PC's own top bar, so asking every few seconds adds no measuring here.
    // The admin's "Scan for hardware changes" (Network): this PC reads its processor, RAM and cards again and says what
    // changed; the next hello carries the new figures. A host's door only (src/guestpass.ts HOST_ONLY_DOORS).
    if (p === '/worker/hardware-rescan') {
      const changes = d.rescanHardware ? await d.rescanHardware() : [];
      return workerJson(res, 200, { changes, memory: d.memory() });
    }
    if (p === '/worker/stats') {
      // A guest keeps loaded only a model its pass names.
      if (!guest || (typeof body.model === 'string' && may(body.model))) nodestaff.keepChat(loadedForPc, keepOf(who), typeof body.model === 'string' ? body.model : '', Date.now());
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
    // A3 + A4: a backup name and PIN kept here; a new PC asking for the backups kept under one.
    if (p === '/worker/owner-set') {
      const a = await ownerSet(body, who);
      return workerJson(res, a.status, a.json);
    }
    if (p === '/worker/claim') {
      const a = await claimAsk(body, who, ip);
      return workerJson(res, a.status, a.json);
    }
    if (p === '/worker/claim-state') {
      const c = claims.findLast(x => x.newHash === who.hash);
      return c ? workerJson(res, 200, claimView(c)) : workerJson(res, 404, { error: 'no request from this PC was made there.' });
    }
    const carryDoor = p.startsWith('/worker/carry-') || p.startsWith('/worker/backup-') || p.startsWith('/worker/update-') || p.startsWith('/worker/git-');
    // Work asked before with a request id is handed back first: followed while it still runs, or given at once when it
    // is kept (src/outbox.ts). Also while this PC's owner uses it, or a speed test runs: it is done (or being done)
    // already, so a host that was away gets what it is owed whatever this PC is doing now.
    const askedRid = p === '/worker/run' || p === '/worker/draw' ? cleanRid(body.rid) : null;
    if (askedRid && (await box.collect(keepOf(who), askedRid, lockOf(keys), () => followerOf(res), k => replay(res, k)))) return;
    // A guest is told only that this PC is busy, not when its owner came to it.
    if (away && guest && (p === '/worker/draw' || p === '/worker/run')) return workerJson(res, 503, { error: `"${shareState.name}" is busy for now. Try again later.` });
    if (away && (carryDoor || ['/worker/switch', '/worker/draw', '/worker/run'].includes(p))) return workerJson(res, 503, { error: `I need to log off for now: someone is using ${shareState.name} (since ${new Date(away.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}). Its work goes to other PCs until it is started again.`, away: away.since });
    // Download to this PC, asked by a linked main PC (no tick needed, as for a model it sends), not while someone here
    // is using it.
    // Its downloads list too (read, Cancel, Download again, Clear): this PC works through it alone, one at a time.
    if (p === '/worker/fetch-start' || p === '/worker/fetch-state' || p === '/worker/fetch-stop' || ['/worker/dl-queue', '/worker/dl-cancel', '/worker/dl-again', '/worker/dl-clear'].includes(p)) {
      if (away && (p === '/worker/fetch-start' || p === '/worker/dl-again')) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      const a = await d.fetch(p, body, who.name);
      return workerJson(res, a.status, a.json);
    }
    // A runner a linked PC sends here (only the build this PC pins, checked before it is unpacked), not while someone
    // here is using it.
    if (p.startsWith('/worker/runner-')) {
      if (away && (p === '/worker/runner-offer' || p === '/worker/runner-put')) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      const a = await runnerNode.handle(p, body, { key: keepOf(who), name: who.name }, piece ?? undefined);
      return workerJson(res, a.status, 'json' in a ? a.json : { error: 'a runner door sent a piece.' });
    }
    // A linked PC sets how one of this PC's models runs (its Guessing model), only with this PC's owner's tick and by
    // ids checked against this PC's own models (src/runset.ts); not while someone here is using it.
    // The speed finder, asked by a linked PC: only with this PC's owner's tick, not while someone here is using it; the
    // node picks and runs its own tries on its own models (src/server/finder.ts), only ids and sizes cross.
    if (p.startsWith('/worker/tune-')) {
      const action = p.slice('/worker/tune-'.length);
      if (!carry.cleanAllow(shareState.allow).tune) return workerJson(res, 403, { error: runset.tuneRefused(shareState.name) });
      if (away && (action === 'start' || action === 'apply' || action === 'undo' || action === 'smaller' || action === 'runner-check-start' || action === 'runner-test-start')) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      if (!d.tune) return workerJson(res, 404, { error: `${shareState.name} cannot test setups.` });
      const a = await d.tune(action, body, who.name);
      return workerJson(res, a.status, a.json);
    }
    // A linked PC gives one of this PC's drives a job (Model store, Backups: src/drivejobs.ts), or takes it away: only a
    // drive this PC has, and each job only with this PC owner's tick for it. Taking a job away needs no tick.
    if (p === '/worker/drive-jobs') {
      const drive = String(body.drive ?? '').toUpperCase();
      const jobs = cleanJobList(body.jobs);
      if (!driveReportNow().some(x => x.drive === drive)) return workerJson(res, 404, { error: `${shareState.name} has no drive ${drive || 'by that name'} now.` });
      const had = jobsHere()[drive] ?? [];
      const why = jobRefused(jobs.filter(j => !had.includes(j)), carry.cleanAllow(shareState.allow), shareState.name);
      if (why) return workerJson(res, 403, { error: `${why}.` });
      const all = setJobsHere(drive, jobs);
      noted(`"${who.name}" set the jobs of drive ${drive}: ${jobs.length ? jobs.map(j => (j === 'store' ? 'Main model storage' : 'Backup storage')).join(' and ') : 'none'}.`);
      return workerJson(res, 200, { drive, jobs: all[drive] ?? [] });
    }
    // A linked admin PC picks which of this PC's drives new models go to (Storage, Keep new models here), so a node with
    // no screen is managed from the admin: the owner's "Accept models from linked PCs" tick, as for the copies themselves.
    // Only a drive letter crosses; the folder is that drive's "TOMLIN models" (or the usual one on its own drive).
    if (p === '/worker/models-where') {
      if (away) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      if (!carry.cleanAllow(shareState.allow).receive) return workerJson(res, 403, { error: `${carry.receiveRefused(shareState.name)}.` });
      const drive = String(body.drive ?? '').toUpperCase();
      if (!/^[A-Z]:$/.test(drive) || !driveReportNow().some(x => x.drive === drive)) return workerJson(res, 404, { error: `${shareState.name} has no drive ${drive || 'by that name'} now.` });
      if (!d.modelsDrive) return workerJson(res, 400, { error: `${shareState.name} cannot change where its models are kept for another PC.` });
      const a = await d.modelsDrive(drive);
      if (a.status !== 200) return workerJson(res, a.status, { error: String(a.body.error ?? 'It was refused.') });
      noted(`"${who.name}" chose where new models are kept here: ${String(a.body.dir ?? drive)}.`);
      return workerJson(res, 200, { drive: String(a.body.drive ?? drive), dir: String(a.body.dir ?? ''), said: String(a.body.said ?? '') });
    }
    if (p === '/worker/run-set') {
      if (away) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      if (!carry.cleanAllow(shareState.allow).tune) return workerJson(res, 403, { error: runset.tuneRefused(shareState.name) });
      const a = await runSetHere(body, who.name);
      return workerJson(res, a.status, a.json);
    }
    // A linked PC deletes a model from this PC's disk: only with the owner's "Accept models from linked PCs" tick (the one
    // that lets it send models here), only a model on this PC's own list by id, and the same refusals as its own Delete
    // (hidden, loaded, kept by Ollama). Nothing but a kind and an id crosses.
    if (p === '/worker/model-remove') {
      if (away) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      if (!carry.cleanAllow(shareState.allow).receive) return workerJson(res, 403, { error: `${carry.receiveRefused(shareState.name)}.` });
      const kind = body.kind === 'image' ? 'image' : 'chat';
      const id = typeof body.id === 'string' ? body.id.slice(0, 300) : '';
      if (!id || !d.removeModel) return workerJson(res, 400, { error: `${shareState.name} cannot delete a model for another PC.` });
      // The app lock PIN (or password) of this PC, typed on the linked PC, like an update (audit X2): the tick alone is not enough to delete.
      const pin = await d.updatePinCheck(body.appPin, keepOf(who), true, body.hostPin !== undefined ? { pin: body.hostPin, link: who.hash } : undefined);
      if ('error' in pin) return workerJson(res, pin.status, { error: `"${shareState.name}" ${pin.error}.`, needPin: pin.status === 403 });
      const a = await d.removeModel(kind, id);
      if (a.status === 200) noted(`"${who.name}" deleted ${id} from this PC.`);
      return workerJson(res, a.status, a.body);
    }
    // A linked PC asks for a larger context for one of this PC's chat models, for the web (src/webctx.ts): the same owner's
    // tick as the run settings, only a size from the list that fits the memory and the model's training, kept as that
    // model's context setting (the owner sees it under Models), and the model let go when it is not answering.
    if (p === '/worker/ctx-set') {
      if (away) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      if (!carry.cleanAllow(shareState.allow).tune) return workerJson(res, 403, { error: runset.tuneRefused(shareState.name) });
      const a = await ctxSetHere(body, who.name);
      return workerJson(res, a.status, a.json);
    }
    // A linked PC lets go of the models it loaded here, now: the same owner's tick as the run settings.
    if (p === '/worker/free') {
      if (away) return workerJson(res, 503, { error: `${shareState.name} is being used by its owner for now. Try again later.` });
      if (!carry.cleanAllow(shareState.allow).tune) return workerJson(res, 403, { error: runset.tuneRefused(shareState.name) });
      const a = await freeHere(who.name);
      return workerJson(res, a.status, a.json);
    }
    // This PC's own app files, read-only, for a linked PC that pulls its TOMLIN (only with its owner's tick).
    if (p === '/worker/update-list' || p === '/worker/update-get') {
      const a = await giveNode(p, body);
      if ('piece' in a) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return void res.end(link.sealBytes(link.toHost(keys), a.piece, `piece|${opened.id}`));
      }
      return workerJson(res, a.status, a.json);
    }
    // A linked PC turns this PC off: only with its owner's tick (on unless unticked), nobody using it, and this PC's app lock
    // PIN typed there. A guest never gets here (doorRefusal above allows only GUEST_DOORS).
    if (p === POWER_DOOR) {
      const a = await powerOffNode(body, { key: keepOf(who), name: who.name, link: who.hash });
      return workerJson(res, a.status, a.json);
    }
    // A linked PC changes this PC's permissions: only with its owner's tick "Allow host to test and change model run
    // settings", and this PC's app lock PIN (or the host PIN) typed there. Never that tick itself; never a guest.
    if (p === PERM_DOOR) {
      const a = await permNode(body, { key: keepOf(who), name: who.name, link: who.hash });
      return workerJson(res, a.status, a.json);
    }
    if (p.startsWith('/worker/update-')) {
      const a = await updateNode(p, body, { key: keepOf(who), name: who.name, link: who.hash }, piece ?? undefined);
      return workerJson(res, a.status, a.json);
    }
    // A host gives this PC its host PIN (with this PC's own PIN, in this one sealed request) or takes it away (src/hostpin.ts).
    if (p === hostpin.SET_DOOR || p === hostpin.DROP_DOOR) {
      const a = await d.hostPinDoor(p, body, { key: keepOf(who), link: who.hash, name: who.name, guest: who.role !== undefined }, () => shareState.name);
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
    // A speed test running here: work from linked PCs waits for it (they ask again).
    const lined = p === '/worker/run' || p === '/worker/draw';
    // A guest's prompt over the cap here is refused before it joins the line (src/nodeline.ts).
    if (p === '/worker/run' && guest) {
      const no = nodeline.promptRefusal(body, nodeline.cleanCaps(shareState.guestCaps));
      if (no) return workerJson(res, 400, { error: no });
    }
    // A guest asking for a model its pass does not name is refused before it joins the line, so it never makes room.
    if (lined && guest && typeof body.model === 'string' && body.model && !may(body.model)) return workerJson(res, 403, notOnPass());
    // A guest always goes through the line, whatever it says: only the line holds the rule that it waits while the
    // owner used the model it would take the place of (a guest that said "no line" skipped it).
    const viaLine = body.line === true || guest;
    if (lined) {
      const what = p === '/worker/draw' ? 'picture' : 'chat';
      const turn = viaLine ? await lineTurn(res, who, body, what) : lineOld(res, who, body, what);
      if (!turn) return;
    }
    try {
    // A linked PC from before the line: told busy during a speed test, as before (one in the line waited for it).
    const tuning = viaLine ? '' : d.tuneBusy?.() ?? '';
    if (tuning && (p === '/worker/draw' || p === '/worker/run')) return workerJson(res, 409, { error: `Busy: ${tuning}.`, busy: true });
    if (p === '/worker/draw') return await workerDraw(body, res, who.name, keepOf(who), askedRid ? { owner: keepOf(who), rid: askedRid, lock: lockOf(keys) } : null, may);
    if (p === '/worker/run') {
      const b = body;
      // Asked with a request id (2.0.38 on): the answer finishes here even if that PC goes away, and asking again with
      // the same id follows it, or gets it at once when it is done (src/outbox.ts). Never run twice.
      // Already running or kept for this id: handed back above.
      const keep = askedRid ? { owner: keepOf(who), rid: askedRid, lock: lockOf(keys) } : null;
      const system = String(b.system ?? '').slice(0, 30_000);
      const user = String(b.user ?? '').slice(0, 200_000);
      // A whole chat (a manager PC's hire talking here), or one prompt (a job step).
      const turns = b.turns === undefined ? null : brains.cleanTurns(b.turns, await chatCharsHere());
      if (b.turns !== undefined && !turns) return workerJson(res, 400, { error: brains.cleanTurns(b.turns, Number.MAX_SAFE_INTEGER) ? `the chat sent is longer than this PC takes at once (${(await chatCharsHere()).toLocaleString('en-GB')} characters at the largest context it runs). Start a new chat, or set a bigger context for this model on this PC.` : 'the conversation sent was not in the expected form.' });
      const asked = Math.max(64, Math.min(jobs.STEP_CEILING, Math.floor(Number(b.maxTokens) || 1000)));
      // A guest's answer is capped here (the cap is in its hello).
      const maxTokens = guest ? nodeline.capAnswer(asked, nodeline.cleanCaps(shareState.guestCaps)) : asked;
      // What a guest's tools may give back: the room left under its prompt cap.
      const guestRoom = guest ? nodeline.cleanCaps(shareState.guestCaps).prompt - nodeline.promptSize(b) : null;
      if (b.staff !== undefined) return workerJson(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
      if (typeof b.model === 'string' && b.model && !may(b.model)) return workerJson(res, 403, notOnPass());
      if (typeof b.model === 'string' && b.model) return await modelChat(b, turns, { system, user }, maxTokens, res, who.name, keep, keepOf(who), guestRoom);
      if (d.chat.view.state !== 'connected' || !d.chat.worker.base) return workerJson(res, 409, { error: 'no chat model is connected on the worker PC. Press Connect there.' });
      if (!may(d.chat.view.model)) return workerJson(res, 403, notOnPass());
      // The model connected here answers for linked PCs (every model on this PC is lent).
      const notLent = nodestaff.modelRefusal(d.chat.view.model ?? '', { onPc: x => d.chatList().find(m => m.id === x)?.name ?? null, busy: false, pcName: shareState.name });
      if (notLent) return workerJson(res, 403, notLent);
      if (d.busy()) return workerJson(res, 409, { error: 'that PC is busy answering something else. Try again in a moment.' });
      const verdict = checkMessage(turns ? turns.at(-1)!.content : user, { recent: [] });
      if (!verdict.ok) return workerJson(res, 400, { error: REFUSAL[verdict.reason] });
      return await runFor(res, keep, `Working on a step for ${who.name}`, { pc: who.name, link: keepOf(who), project: projectOf(b) }, async (send, signal) => {
        const words = paced(text => send('text', { text }));
        const asked = Date.now();
        try {
          const brain = localBrain('');
          const web = await webFor(b, send);
          const offered = hostToolsFor(b, send, keepOf(who), keep?.rid);
          const hostTools = offered && (await callsTools(d.chat.worker.base)) ? offered : null;
          const box = boxFor(hostTools ?? web?.box, guestRoom);
          if (turns) await brain.chat(turns, maxTokens, words.push, signal, { ...askOpts(b, send), ...(box ? { tools: box } : {}) });
          else await brain.ask(system, user, maxTokens, words.push, signal, box ? { tools: box } : undefined);
          words.flush();
          send('done', { model: d.chat.view.modelName ?? '', speed: brain.last ?? null, thought: brain.thought ?? null, usage: usedHere(), ...(brain.cut ? { cut: true } : {}), ...(web?.turn.uses.length ? { tools: web.turn.uses } : {}), ...(offered && !hostTools ? { toolsOff: `${d.chat.view.modelName ?? 'This model'} cannot call tools` } : {}) });
        } catch (e) {
          words.flush();
          const fault = signal.aborted ? null : await faultHook.find?.(d.chat.view.model, asked).catch(() => null);
          send('error', { text: (e as Error).message, ...(fault ? { fault } : {}) });
        }
      });
    }
    } finally {
      if (lined) lineNotStarted(res);
    }
    // A tool the asking PC ran for this PC's model (src/jobrun/tooltalk.ts): the model's loop goes on with the result.
    if (p === '/worker/tool-result') {
      const rid = cleanRid(body.rid);
      const id = typeof body.id === 'string' ? body.id.slice(0, 40) : '';
      if (!rid || !id) return workerJson(res, 400, { error: 'no request id or call id was sent.' });
      return toolWaits.give(`${keepOf(who)}|${rid}|${id}`, typeof body.result === 'string' ? body.result : '')
        ? workerJson(res, 200, { ok: true })
        : workerJson(res, 404, { error: 'No call is waiting for that result any more.' });
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
    // This PC's log, its last lines: today's, or one of the days kept (day), only those with a word in them (find). A test
    // across PCs is checked from the main PC (3 Nov: Max mode's refusals were only on this PC). The log holds no chat's
    // words, prompts or file text (src/log.ts).
    if (p === '/worker/log') {
      const got = askLog({ lines: body.lines, day: body.day, find: body.find });
      return workerJson(res, 'error' in got ? 400 : 200, got);
    }
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
    // A system fault (a full disk, a file held) is said plainly over the link; its detail, with this PC's folders, stays in this log.
    if (typeof (e as NodeJS.ErrnoException).code === 'string') console.error(`A linked PC's request (${String(req.url ?? '').split('?')[0]}) failed here:`, e);
    if (!res.headersSent) workerJson(res, 400, { error: carry.doorFault(e) });
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
    await endLoan(shareState.on ? 'its link part started again' : 'sharing was turned off there');
    // A step still streaming would hold the port open: sharing off means off now.
    await new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); });
  }
  shareError = '';
  if (!shareState.on) return;
  // A node must have the app lock (F7 E3): other PCs reach it, so it is never open without one. Without its PIN (the file deleted), the node does not listen.
  // A Bootable USB node has none: nobody sits at it, its screen is not TOMLIN's, and the admin key guards its link.
  if (!d.appLockOn() && !usbStick) {
    shareError = 'a node must have the app lock. Set a PIN with the padlock (top right) and the node starts again.';
    return;
  }
  const srv = createServer(workerRoute);
  // Max mode's sealed stream (src/jobrun/maxnode.ts) opens as an Upgrade on the same port, and so does the cluster test
  // door (src/cluster/testdoor.ts: timing the network and this PC's RPC server for the cluster engine).
  srv.on('upgrade', (req, socket, head) => void (isClusterTest(req) ? clusterTestUpgrade(req, socket, head, nodeTestDeps()) : maxUpgrade(req, socket, head)));
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
    const saved = await d.store.readJson<Partial<share.ShareState> | null>('share.json', null);
    shareState = { ...share.DEFAULT_SHARE, ...(saved ?? {}) };
    // Started from a Bootable USB stick: node mode on and the admin key from the stick (src/usbnode.ts).
    const stick = usbnode.readStick();
    if (stick) {
      shareState = usbnode.applyStick(shareState, stick, !saved);
      usbStick = stick;
    }
    // Guest passes as kept (src/guestpass.ts): one that is not whole is dropped.
    shareState.passes = guestpass.cleanPasses(shareState.passes);
    shareState.passAsks = guestpass.keepAsks(guestpass.cleanAsks(shareState.passAsks));
    shareState.paired = guestpass.dropEnded(shareState.paired ?? []);
    const last = guestpass.cleanRenew(shareState.passLastLength);
    if (last) shareState.passLastLength = last;
    else delete shareState.passLastLength;
    const counts = (v: unknown) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([k, n]) => /^[\w-]{1,64}$/.test(k) && Number.isSafeInteger(n) && (n as number) > 0)) as Record<string, number>;
    shareState.passAcks = counts(shareState.passAcks);
    shareState.passGens = counts(shareState.passGens);
    // Peers as kept (src/peerlink.ts): one that is not whole is dropped.
    shareState.peers = peerlink.cleanPeers(shareState.peers);
    shareState.peerGens = counts(shareState.peerGens);
    shareState.intros = peerlink.cleanIntros(shareState.intros);
    shareState.introAcks = counts(shareState.introAcks);
    if (!Number.isSafeInteger(shareState.introGen)) delete shareState.introGen;
    if (!Number.isSafeInteger(shareState.passGen)) delete shareState.passGen;
  } finally {
    shareRead();
  }
  claims = owner.cleanClaims(await d.store.readJson<unknown>(CLAIMS_FILE, []).catch(() => []));
  // Each PC has its own setup code, made the first time and kept.
  if (!shareState.code || !/^[0-9a-f]{8}$/.test(shareState.id) || usbStick) {
    shareState.code ||= share.newCode();
    if (!/^[0-9a-f]{8}$/.test(shareState.id)) shareState.id = randomBytes(4).toString('hex');
    await saveShare();
  }
  autostart = await d.autostart.on().catch(() => false);
  if (shareState.on) await applyShare();
  // A Bootable USB node: its own screen on tty1 (src/usbscreen.ts), since the PC has no desktop.
  if (usbStick && process.env.TOMLIN_SCREEN) {
    const stick = usbStick;
    const hw = usbadmin.hardwareKind({ cpu: { name: cpus()[0]?.model ?? '' }, ramBytes: totalmem() }).label;
    startScreen(process.env.TOMLIN_SCREEN, () => {
      const lent = lendView() as { to?: string } | null;
      return {
        name: shareState.name, version: d.version, admin: stick.admin, tag: adminkey.keyTag(stick.adminPub), hardware: hw, now: new Date(),
        addresses: lanList().map(n => `${n.address}:${shareState.port}`),
        linked: shareState.paired.filter(x => !x.role).map(x => x.name),
        models: d.chatList().filter(m => d.runnerFor(m.id)?.view.state === 'connected').map(m => m.name),
        lending: lent?.to ? `card and memory lent to "${lent.to}"` : '',
        fault: shareError,
      };
    });
  }
  // A node in use (a model loaded for a linked PC, or a request running) asks Windows to stay awake; idle, it may sleep and be woken (src/keepawake.ts).
  setInterval(() => awake.set(shareState.on && nodeBusy({ linkedModels: loadedForPc.size + (pictureFor ? 1 : 0), requests: serving.size + lending.size + (drawing ? 1 : 0) })), 15_000).unref();
}

/** The stick this PC started from (Bootable USB), or null. */
export let usbStick: usbnode.StickConfig | null = null;

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

/**
 * The PCs a new pass is for, each with its models, as asked (`nodes`: [{ id, models }]) and checked: this PC only when it
 * is a node, a linked node by its id, a model only one that PC has. An older page sends `models` alone: this PC.
 */
async function passScope(ask: Record<string, unknown>): Promise<{ scope: { id: string; models: string[] }[] } | { error: string }> {
  const remotes = (await d.store.settings()).remotes;
  // A PC this one is a guest on is not one it makes passes for.
  const admin = remotes.filter(r => r.role !== 'guest');
  const modelsOf = (id: string): string[] | null => (id === shareState.id ? (shareState.on ? onThisPc() : null) : admin.find(r => r.id === id)?.models?.map(m => m.id) ?? (admin.some(r => r.id === id) ? [] : null));
  const asked = Array.isArray(ask.nodes) ? ask.nodes.slice(0, 50) : [{ id: shareState.id, models: ask.models }];
  const scope: { id: string; models: string[] }[] = [];
  for (const x of asked) {
    const id = String((x as { id?: unknown })?.id ?? '');
    const has = modelsOf(id);
    if (!has) return { error: id === shareState.id ? 'Turn on sharing first: this PC is not a node, so a pass cannot be for it.' : 'One of the PCs picked is not linked to this one any more. Open the page again.' };
    if (scope.some(s => s.id === id)) continue;
    const want = (x as { models?: unknown })?.models;
    scope.push({ id, models: (Array.isArray(want) ? want : []).filter((m): m is string => typeof m === 'string' && has.includes(m)) });
  }
  if (!scope.length) return { error: 'Pick at least one PC the pass is for.' };
  return { scope };
}

export async function setShare(b: Record<string, unknown>) {
  // A node must have the app lock (F7 E3): other PCs reach it, so it is never open without one. Turning it on needs a PIN
  // set AND typed (it opens this PC to the network: once it went on with no PIN asked while turning it off asked for
  // one); while it is a node, every change here (turning it off too) needs that PIN typed again.
  const turningOn = b.on === true && !shareState.on;
  // What the link part listens with, before this change: it restarts only when one of them changes (below).
  const was = { on: shareState.on, port: shareState.port };
  await shareLoaded;
  if (turningOn && !d.appLockOn()) return { status: 409, body: { error: 'A node must have a pin code to lock the app.', needAppLock: true } };
  // Checked before anything is changed, so a refused port never leaves half of the other changes made.
  const port = 'port' in b ? Math.floor(Number(b.port)) : shareState.port;
  if ('port' in b && (!(port >= 1024 && port <= 65535) || port === Number(process.env.TOMLIN_PORT ?? 8740))) return { status: 400, body: { error: 'Use a port number from 1024 to 65535, not TOMLIN\'s own.' } };
  const pinChecked = shareState.on || turningOn;
  // What the file holds now: a change the disk refuses to save (a full disk) is undone here too, so it never shows as
  // made, and is never saved later by another change.
  const asSaved = structuredClone(shareState);
  if (pinChecked) {
    const ok = await d.appPinCheck(b.appPin);
    if ('error' in ok) return { status: ok.status, body: { error: ok.error, needAppPin: true } };
  }
  // A guest pass (src/guestpass.ts) lets another PC in: made or removed only with the app lock PIN when there is one,
  // whether or not this PC is a node itself (a host makes passes for the nodes it is linked to).
  // Whether two introduced PCs reach each other now (each is asked to ping the other): nothing changes.
  if (b.peerCopy && typeof b.peerCopy === 'object') {
    const r = await peerHooks.copy(b.peerCopy as Record<string, unknown>);
    return r.status === 200 ? { status: 200, body: { ...shareView(), ...r.body } } : r;
  }
  if (b.peerCheck && typeof b.peerCheck === 'object') {
    const r = await peerHooks.check(b.peerCheck as Record<string, unknown>);
    return r.status === 200 ? { status: 200, body: { ...shareView(), ...r.body } } : r;
  }
  const removeHere = typeof b.peerRemoveHere === 'string' && !!b.peerRemoveHere;
  const peerChange = (!!b.peerIntroduce && typeof b.peerIntroduce === 'object') || (!!b.peerRemove && typeof b.peerRemove === 'object') || removeHere;
  const passChange = peerChange || (b.passMake && typeof b.passMake === 'object') || (typeof b.passRemove === 'string' && !!b.passRemove) || (!!b.passAnswer && typeof b.passAnswer === 'object');
  if (passChange && !pinChecked && d.appLockOn()) {
    const ok = await d.appPinCheck(b.appPin);
    if ('error' in ok) return { status: ok.status, body: { error: ok.error, needAppPin: true } };
  }
  // Two linked PCs introduced to each other, or that ended (src/jobrun/peersync.ts): with the app lock PIN, as for a
  // guest pass, and nothing else changes in the same request.
  // The owner of this PC ends its direct links with one PC (named by that PC's id) here, at once: both directions go, their
  // keys too, and the host cannot put them back.
  if (removeHere) {
    const ids = [...(shareState.peers?.in ?? []), ...(shareState.peers?.out ?? [])].filter(p => p.pc === b.peerRemoveHere && !p.revoked && !p.removedHere).map(p => p.id);
    if (!ids.length) return { status: 404, body: { error: 'That direct link is not on this PC (it ended already).' } };
    shareState.peers = ids.reduce((t, id) => peerlink.removeHere(t, id), shareState.peers ?? peerlink.NO_PEERS);
    await saveShare();
    return { status: 200, body: shareView() };
  }
  if (peerChange) {
    const r = b.peerIntroduce ? await peerHooks.introduce(b.peerIntroduce as Record<string, unknown>) : await peerHooks.remove(b.peerRemove as Record<string, unknown>);
    return r.status === 200 ? { status: 200, body: shareView() } : r;
  }
  // Made here, for this PC (when it is a node) and the nodes it is linked to, each with the models picked for it;
  // checked before anything changes. Its code is in this answer only: kept nowhere, shown once.
  let made: { pass: guestpass.GuestPass; code: string } | null = null;
  let ownChanged = false;
  if (b.passMake && typeof b.passMake === 'object') {
    const live = (shareState.passes ?? []).filter(x => guestpass.passLive(x) && !x.by);
    if (live.length >= guestpass.MAX_PASSES) return { status: 409, body: { error: `There are ${guestpass.MAX_PASSES} guest passes already. Remove one first.` } };
    const ask = b.passMake as Record<string, unknown>;
    const scope = await passScope(ask);
    if ('error' in scope) return { status: 400, body: scope };
    const m = await guestpass.makePass({ label: ask.label, length: ask.length, scope: scope.scope }, shareState.id, Date.now(), { codes: [shareState.code], keys: live.map(x => x.key) });
    if ('error' in m) return { status: 400, body: m };
    made = m;
  }
  if (made) {
    shareState.passes = [...(shareState.passes ?? []), made.pass];
    ownChanged = true;
  }
  // Remove: the pass ends now and the links made with it go (a guest is not told why). One this PC made is removed on
  // its nodes too (sent at once, and again until each says it has it); one a host gave ends here only.
  if (typeof b.passRemove === 'string' && b.passRemove) {
    const gone = (shareState.passes ?? []).find(x => x.id === b.passRemove);
    const r = guestpass.revokePass(shareState.passes ?? [], shareState.paired, b.passRemove);
    shareState.passes = r.passes;
    shareState.paired = r.paired;
    if (gone && !gone.by) ownChanged = true;
  }
  if (ownChanged) shareState.passGen = guestpass.nextGen(shareState.passGen);
  // A guest's request answered: on a pass made here, here; on a pass this PC made for a node, on that node (sent now).
  if (b.passAnswer && typeof b.passAnswer === 'object') {
    const a = b.passAnswer as Record<string, unknown>;
    const length = guestpass.cleanRenew(a.length);
    if (a.answer === 'renew' && length) shareState.passLastLength = length;
    if (typeof a.pc === 'string' && a.pc) {
      const r = await passHooks.answer(a.pc, a);
      if (r.status !== 200) return r;
      // Renewed there: noted on this PC's pass, so its list shows that guest's new end (not only the ended pass).
      if (a.answer === 'renew' && typeof r.body.passId === 'string') shareState.passes = guestpass.noteRenewal(shareState.passes ?? [], r.body.passId, { pc: a.pc, pcName: String(r.body.pcName ?? ''), name: String(r.body.name ?? ''), until: typeof r.body.until === 'string' ? r.body.until : null });
    } else {
      const q = (shareState.passAsks ?? []).find(x => x.id === a.id && !x.by);
      if (!q) return { status: 404, body: { error: 'That request is not here any more.' } };
      const done = guestpass.answerAsk(shareState.passAsks ?? [], shareState.paired, a.id, { answer: a.answer, length: a.length, reason: a.reason });
      if ('error' in done) return { status: 409, body: done };
      shareState.passAsks = done.asks;
      shareState.paired = done.paired;
      if (done.ask.answer === 'renewed') shareState.passes = guestpass.noteRenewal(shareState.passes ?? [], done.ask.passId, { pc: null, pcName: shareState.name, name: done.ask.name, until: done.paired.find(x => x.role === 'guest' && x.hash === done.ask.link)?.expires ?? null });
    }
  }
  // A4: Allow / Don't allow a new PC's request for a linked PC's backups.
  if (typeof b.claimId === 'string') {
    const r = await answerClaim(b.claimId, b.claimAllow === true);
    if ('error' in r) return { status: 409, body: r };
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
  if ('allow' in b) {
    const was = carry.cleanAllow(shareState.allow).lend === true;
    shareState.allow = carry.cleanAllow(b.allow);
    // Ticked into the cluster: its speed test runs now when its figures are missing or stale (src/speedtest.ts).
    if (!was && shareState.allow.lend === true) void checkSpeed('ticked');
  }
  if ('lendIdle' in b) shareState.lendIdle = cleanLendIdle(b.lendIdle);
  if ('plainLinks' in b) shareState.plainLinks = b.plainLinks === true;
  if ('guestCaps' in b) shareState.guestCaps = nodeline.cleanCaps(b.guestCaps);
  if ('hostFirst' in b) shareState.hostFirst = b.hostFirst !== false;
  if ('atOnce' in b) shareState.atOnce = slotsLib.cleanAtOnce(b.atOnce);
  if (b.newPin === true || (shareState.pinOn && !shareState.pin)) shareState.pin = share.newPin();
  if (b.newCode === true) shareState.code = share.newCode();
  // This PC's owner takes a linked host's host PIN away (src/hostpin.ts), by the link's id: that host asks this PC's own PIN again.
  if (typeof b.hostPinDrop === 'string' && b.hostPinDrop) await d.hostPinDrop(b.hostPinDrop);
  // By the link's own id (its token's fingerprint): the list can change while the page shows it (a PC links meanwhile).
  const before = shareState.paired;
  if (typeof b.unpairId === 'string' && b.unpairId) shareState.paired = shareState.paired.filter(x => String(x.hash ?? '').slice(0, 12) !== b.unpairId);
  else if ('unpair' in b) shareState.paired = shareState.paired.filter((_, k) => k !== Number(b.unpair));
  if (b.unpairAll === true) shareState.paired = [];
  // A host's link removed: the guest passes it gave end here now (their guests may collect work for a while).
  for (const gone of before.filter(x => x.role === undefined && !shareState.paired.includes(x))) {
    const r = guestpass.endGiver(shareState.passes ?? [], shareState.paired, keepOf(gone));
    shareState.passes = r.passes;
    shareState.paired = r.paired;
    // The peers it introduced end with it too.
    shareState.peers = peerlink.endPeerGiver(shareState.peers ?? peerlink.NO_PEERS, keepOf(gone));
    // Its host PIN goes with it (it could never be used again: it was good only from that link).
    if (gone.hash) await d.hostPinDrop(gone.hash).catch(() => false);
  }
  shareState.paired = guestpass.dropEnded(shareState.paired);
  if ('on' in b) shareState.on = b.on === true;
  try {
    await saveShare();
  } catch (e) {
    shareState = asSaved;
    throw e;
  }
  const unlinked = before.filter(x => !shareState.paired.includes(x)).map(x => `"${x.name}"`);
  if (unlinked.length) log.info('link', `The link${unlinked.length > 1 ? 's' : ''} to ${unlinked.join(', ')} ended on this PC (removed under Network, or a guest pass ran out).`);
  // A PC borrowing this one's card whose link was just removed: its loan ends now, not at the next check.
  const borrower = lentTo();
  if (borrower && !shareState.paired.some(p => lendingTo(String(p.hash ?? '')))) await endLoan(`the link to "${borrower}" was removed`);
  // The link part restarts only when it has to (turned on or off, a new port, or not listening): a restart cuts every
  // answer, step and picture the host is waiting for, and a name, a code or "Start when this PC starts" is read live.
  if (shareState.on !== was.on || shareState.port !== was.port || (shareState.on && !shareServer)) await applyShare();
  if (ownChanged) passHooks.changed();
  return { status: 200, body: made ? { ...shareView(), madePass: { id: made.pass.id, code: made.code, label: made.pass.label, expires: made.pass.expires } } : shareView() };
}

/** What creating the jobs started: the restore points read once a minute, the copy and update doors, the drop of unused models. */
export function startNode(): void {
  // A chat model loads with as many slots as At once asks (src/slots.ts), when this PC is a node.
  slotsLib.slotWant.want = () => (shareState.on ? slotsLib.cleanAtOnce(shareState.atOnce) : 1);
  // The requests taken on the link are kept on the disk too, so none can be sent again after a restart (src/link.ts).
  taken.keepIn(join(d.store.dir, 'link-seen.txt'));
  keepPairNonces(join(d.store.dir, 'link-asks-seen.txt'));
  // A guest's link may keep only a few answers here; a host's own many (src/outbox.ts).
  box = new Outbox(join(d.store.dir, 'outbox'), owner => (shareState.paired.some(l => l.role === 'guest' && keepOf(l) === owner) ? GUEST_KEPT : HOST_KEPT));
  // The weight cache is brought down to its limit at every start and once an hour, even on a PC that never lends again
  // (122.6 GB on one node, 17 Nov 2026). Not while a loan runs: the RPC server has its files open then.
  const tidyCache = () => {
    if (lentTo()) return;
    void pruneCache(join(cacheDirOf(d.store.dir), 'rpc')).then(r => { if (r.files) log.info('max', `Weight cache: removed ${r.files} old file${r.files > 1 ? 's' : ''} (${(r.bytes / 2 ** 30).toFixed(1)} GB) to keep it under ${Math.round(maxlendLimit / 2 ** 30)} GB.`); });
  };
  setTimeout(tidyCache, 20_000).unref();
  setInterval(tidyCache, 3600_000).unref();
  // A line about drive space and the weight cache in the log, soon after the start and every 6 hours (src/disklog.ts).
  startDiskLog({ dataDir: d.store.dir, modelsDir: () => d.carry.chatDir, cacheDir: cacheDirOf(d.store.dir), say: line => log.info('disk', line), firstMs: 30_000 });
  // Answers no linked PC came back for in three days are removed (at the start, then once an hour).
  void box.sweep();
  setInterval(() => void box.sweep(), 3600_000).unref();
  void readKept();
  setInterval(readKept, 60_000).unref();
  carryNode = carry.nodeSide({
    allow: () => shareState.allow ?? carry.NO_ALLOW,
    shared: onThisPc,
    pcName: () => shareState.name,
    chatFiles: d.carry.chatFiles,
    pictureFiles: d.carry.pictureFiles,
    // Read each time: the folder models are kept in can be changed while TOMLIN runs.
    get chatDir() { return d.carry.chatDir; },
    chatHas: d.carry.chatHas,
    pictureDest: d.carry.pictureDest,
    // Read each time: the folder other PCs' backups are kept in can be changed while TOMLIN runs (src/server/backuphome.ts).
    get keptRoot() { return d.carry.keptRoot; },
    onProjects: () => void readKept(),
    onInstalled: (name, model) => {
      noted(`A linked PC installed ${name} on this PC.`);
      d.carry.onInstalled();
    },
  });

  runnerNode = runnerpush.runnerSide({
    runtimes: d.runner.runtimes,
    pcName: () => shareState.name,
    why: id => d.runner.why(id, shareState.name),
    inUse: device => d.runner.inUse(device),
    onChange: () => noted(`The CUDA runner on this PC changed (a linked PC sent it, or took it away).`),
  });

  // Logged out for the hours the main PC agreed to: it starts again by itself when they are up.
  setInterval(() => {
    const until = shareState.away?.until;
    if (until && Date.now() >= Date.parse(until)) void comeBack(true, 'the end of the time asked for').catch(() => undefined);
  }, 30_000).unref();
  /** Why this PC cannot restart or go off now (someone at it, or work for a linked PC), or null. */
  const nodeBusyNow = () => loanBusyNow() ?? [...serving.values()][0] ?? (lending.size || drawing ? 'answering for a linked PC' : d.busy() ? 'someone at that PC is getting an answer' : d.imageBusy() ? 'someone at that PC is drawing a picture' : actionBusy() ? 'a job is running on that PC' : d.chat.view.state === 'loading' || d.imagePane.view.state === 'loading' ? 'a model is loading on that PC' : null);
  updateNode = update.updateSide({
    root: d.update.root,
    version: d.version,
    build: d.build,
    allowed: () => shareState.allow?.update === true,
    pcName: () => shareState.name,
    restarts: d.update.restarts,
    pinCheck: (pin, who, host) => d.updatePinCheck(pin, who, false, host),
    // A Bootable USB node runs the TOMLIN on its stick (Linux): a Windows copy sent here could not start.
    blocked: () => (usbStick ? `"${shareState.name}" runs TOMLIN from a Bootable USB stick, so it is updated by minting the stick again (Settings, Bootable USB, Mint) and starting it from the stick again.` : null),
    // A restart cuts what is running: someone at this PC, or work for a linked PC, finishes first.
    busy: nodeBusyNow,
    done: async (dir, version, by, pulled) => {
      shareState.updated = { version, by: String(by).slice(0, 40), at: new Date().toISOString(), ...(pulled ? { pulled: true } : {}) };
      await saveShare();
      noted(pulled ? `TOMLIN ${version} was pulled here from "${by}": starting it from ${dir}.` : `"${by}" updated TOMLIN here to ${version}: starting it from ${dir}.`);
      await d.update.switchTo(dir);
    },
  });
  // Whether someone is at this PC (keys, mouse, Windows locked), read only when a turn-off is asked for.
  const offPresence = new PresenceReader();
  powerOffNode = powerOffSide({
    allowed: () => carry.cleanAllow(shareState.allow).off,
    pcName: () => shareState.name,
    away: () => !!shareState.away,
    busy: nodeBusyNow,
    inUse: async () => {
      const p = offPresence.now() ?? (await offPresence.first(4000));
      return p && !nobodyThere(p, USED_MINUTES) ? presenceWords(p) : null;
    },
    pinCheck: usbAdminCheck((pin, who, host) => d.updatePinCheck(pin, who, 'power', host)),
    // A stick node (Linux) turns off with systemd; the service is let do it by polkit's rule for its user (start.sh).
    supported: process.platform === 'win32' || !!usbStick,
    run: (seconds, by) => {
      noted(`"${by}" turned this PC off: it shuts down in ${seconds} seconds.`);
      if (process.platform === 'win32') execFile('shutdown.exe', shutdownArgs(seconds, by), { windowsHide: true }, () => undefined);
      else setTimeout(() => execFile('systemctl', ['poweroff'], () => undefined), seconds * 1000).unref();
    },
  });
  permNode = permSetSide({
    allowed: () => carry.cleanAllow(shareState.allow).tune,
    pcName: () => shareState.name,
    pinCheck: usbAdminCheck((pin, who, host) => d.updatePinCheck(pin, who, 'perms', host)),
    current: () => {
      const a = carry.cleanAllow(shareState.allow);
      return Object.fromEntries(PERM_KEYS.map(k => [k, k === 'plainLinks' ? shareState.plainLinks === true : a[k] === true])) as Record<PermKey, boolean>;
    },
    apply: async (set, said) => {
      const asSaved = shareState;
      const was = carry.cleanAllow(shareState.allow);
      const { plainLinks, ...allow } = set;
      shareState = { ...shareState, allow: carry.cleanAllow({ ...was, ...allow }), ...(plainLinks === undefined ? {} : { plainLinks }) };
      try {
        await saveShare();
      } catch (e) {
        shareState = asSaved;
        throw e;
      }
      if (!said) return;
      noted(said);
      permChanges.unshift({ said, at: new Date().toISOString() });
      permChanges.length = Math.min(permChanges.length, 5);
      // Ticked into the cluster from the host: its speed test runs now when its figures are missing or stale, as at this PC.
      if (!was.lend && carry.cleanAllow(shareState.allow).lend) void checkSpeed('ticked');
    },
  });
  giveNode = update.giveSide({
    root: d.update.root,
    version: d.version,
    build: d.build,
    allowed: () => carry.cleanAllow(shareState.allow).give,
    pcName: () => shareState.name,
  });
  // When the picture model last drew, or was loaded (src/picturelock.ts: unloaded while locked after a while with nothing drawn).
  let pictureUsedAt = Date.now();
  setInterval(() => {
    const v = d.imagePane.view;
    if (v.state !== 'connected' || drawing || d.imageBusy()) pictureUsedAt = Date.now();
    let dropped = false;
    // Drawing, but not for a linked PC: someone at this PC uses it now, so it is theirs (src/nodestaff.ts pictureVerdict).
    const picture = pictureFor ? nodestaff.pictureVerdict({ id: pictureFor.id, model: v.model, state: v.state, drawing, busyHere: d.imageBusy(), idleMs: Date.now() - pictureFor.at, dropMs: PICTURE_DROP_MS }) : null;
    if (pictureFor && picture === 'keep') pictureFor.at = Date.now();
    else if (picture === 'gone' || picture === 'theirs') pictureFor = null;
    else if (pictureFor && picture === 'drop') {
      noted(`Dropping ${v.modelName ?? pictureFor.id}: loaded for a linked PC, and no linked PC used it for ${PICTURE_DROP_MS / 60_000} minutes.`);
      pictureFor = null;
      dropped = true;
      void d.imagePane.disconnect().catch(() => undefined);
    }
    // sd-server takes no key: while TOMLIN is locked, a picture model of this PC's own does not stay loaded with nothing to do.
    if (!dropped && unloadWhileLocked({ locked: d.appLocked(), state: v.state, forLinked: !!pictureFor, busy: drawing || d.imageBusy(), idleMs: Date.now() - pictureUsedAt })) {
      noted(`Unloading ${v.modelName ?? v.model}: TOMLIN is locked, and the picture runner takes no key. It loads again for the next picture.`);
      void d.imagePane.disconnect().catch(() => undefined);
    }
    for (const [id, v] of loadedForPc) {
      const r = d.runnerFor(id);
      // Answering, but not for a linked PC: someone at this PC uses it now, so it is theirs (src/nodestaff.ts chatVerdict).
      const verdict = nodestaff.chatVerdict({ state: r?.view.state ?? 'disconnected', lending: lending.has(id), busyHere: !!r && d.busy(r), testing: d.finderTesting?.() === id, idleMs: Date.now() - v.at });
      if (verdict === 'keep') v.at = Date.now();
      else if (verdict === 'gone' || verdict === 'theirs') loadedForPc.delete(id);
      else if (verdict === 'drop' && r) {
        loadedForPc.delete(id);
        noted(`Dropping ${r.view.modelName ?? id}: loaded for a linked PC, and no linked PC used it for ${UNUSED_DROP_MS / 60_000} minutes.`);
        void r.disconnect().catch(() => undefined);
      }
    }
  }, 5000).unref();
}
