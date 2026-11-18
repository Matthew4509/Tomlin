// Talking to linked PCs over the encrypted link: hellos, their models as brains, pictures drawn there, their meters.
import * as share from '../share.ts';
import { cleanUse, type ToolUse } from '../webtools.ts';
import * as link from '../link.ts';
import * as guestpass from '../guestpass.ts';
import { cleanReading, type AskOpts, type ToolBox } from '../engine.ts';
import { GUEST_SIDE_TOOLS, hostHandler, onlyTools, toWire } from './tooltalk.ts';
import * as brains from '../brains.ts';
import * as nodestaff from '../nodestaff.ts';
import * as carry from '../carry.ts';
import * as update from '../update.ts';
import * as runnerpush from '../runnerpush.ts';
import * as speedKeys from '../speed.ts';
import { cleanRid, ridOf } from '../outbox.ts';
import { cleanTally, cleanUsed, scope } from '../meter.ts';
import type { Remote } from '../store.ts';
import { cleanLogFind, logAnswer } from '../log.ts';
import { cleanCpu } from '../nodecpu.ts';
import { collectPicture, saidOf, type Drawn } from './pictureback.ts';
import * as wake from '../wake.ts';
import { heldFor, heldWhy, isMember } from '../cluster/members.ts';
import { cleanClusterHello } from '../cluster/loader.ts';
import { cardFix } from '../pccards.ts';
import { cleanSpeed } from '../speedtest.ts';
import { d, sleep } from './shared.ts';
import type { Brain, Hello } from '../jobrun.ts';

/** A node's "running since" and how long that PC has been on, as it said (2.0.39 on). */
function upOf(raw: unknown): Hello['up'] {
  const u = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return u && typeof u.since === 'string' && !Number.isNaN(Date.parse(u.since)) ? { since: u.since, pc: Math.max(0, Math.round(Number(u.pc) || 0)) } : null;
}
function meterOf(raw: unknown): Hello['meter'] {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return m && typeof m.since === 'string' && !Number.isNaN(Date.parse(m.since)) ? { since: m.since, total: cleanTally(m.total) } : null;
}
/** What each linked PC last said about its uptime and its work, kept while it is off (the PC window shows it). */
export const lastSaid = new Map<string, { up: Hello['up']; meter: Hello['meter']; at: number }>();

/** What each paired PC said last (Home and the team read it without asking again). */
export const seen = new Map<string, Hello & { at: number }>();
/** When each linked PC last said "I need to log off for now" (told once per press). */
const awayTold = new Map<string, string>();
/** The request from each linked PC's lock screen already told (by when it was sent), so it is told once. */
const askTold = new Map<string, string>();
/** The chat model each linked PC had loaded when it last answered (kept while it is off, to name a hire's own model). */
export const lastModel = new Map<string, string>();

/** A linked PC's address given as a name must still point inside the home network (S6): checked before each request. */
export async function onHomeNetwork(r: Pick<Remote, 'name' | 'url'>): Promise<void> {
  const why = await share.homeNetworkWhy(r.url);
  if (why) throw new Error(`"${r.name}": ${why}`);
}

/**
 * One call to a linked PC over the encrypted link (src/link.ts): the request is sealed, and the answer comes back
 * opened, as a plain Response, so the readers stay as they are. Only a refusal may come back unsealed (one made
 * before the link was checked: it carries no work); any other answer that is not sealed is refused.
 */
async function linkFetch(r: Remote, path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  // The last lock for a "Backups only" PC: nothing that is work for it, whatever asked (read now, not from `r`).
  if (WORK_PATHS.has(path) && backupsOnly(r.id)) throw new Error(backupsOnlyWhy(r.name));
  if (WORK_PATHS.has(path) && clusterHeld(r.id)) throw new Error(heldWhy(r.name));
  const keys = link.keysOf(r.key);
  if (!keys) throw Object.assign(new Error(`"${r.name}" was linked before links were encrypted. Link it again: Network, Find PCs on my network, then its setup code.`), { relink: true });
  const req = link.sealRequest(keys, path, payload);
  const id = link.requestId(req.box);
  await onHomeNetwork(r);
  const res = await fetch(`${r.url}${path}`, { method: 'POST', headers: { authorization: `Link ${share.hashToken(r.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(req), signal });
  if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    if (!res.body) throw new Error(`"${r.name}" sent nothing back.`);
    return new Response(link.openStream(keys, id, res.body), { status: res.status, headers: { 'content-type': 'text/event-stream' } });
  }
  let cut = false;
  const data = (await res.json().catch(() => ((cut = true), {}))) as Record<string, unknown>;
  if (typeof data.box === 'string') return Response.json(link.openAnswer(keys, id, 0, data.box), { status: res.status });
  // An answer that stopped part way (the network dropped, the PC went to sleep) is not one without the link.
  if (res.ok && cut) throw new Error(`"${r.name}" stopped part way through its answer (the connection was cut or went quiet). Try again.`);
  if (res.ok) throw new Error(`"${r.name}" answered without the encrypted link, so the answer was not used. Update TOMLIN there, then link it again.`);
  return Response.json(data, { status: res.status });
}
/** What is work for a linked PC: answering, drawing, loading a model, and taking a copy of a model. */
const WORK_PATHS = new Set(['/worker/run', '/worker/draw', '/worker/switch', '/worker/carry-offer', '/worker/carry-put']);
/** Set to "Backups only" on this PC (as saved now). */
export const backupsOnly = (id: string) => d.store.peek()?.remotes.find(x => x.id === id)?.backupsOnly === true;
/** In the cluster while it is switched on (src/cluster/members.ts): held for borrowing, no work of this PC's own goes there. */
export const clusterHeld = (id: string) => heldFor(d.store.peek()?.cluster, id);
export const backupsOnlyWhy = (name: string) => `"${name}" is set to Backups only: it keeps backups and does no other work. To use it for staff again, untick Backups only on its card (Network, Linked PCs).`;

/** PCs whose network card address was looked up this run, and when (once each: it is kept with the link). */
const macTried = new Map<string, number>();
/** A PC whose address the ARP table did not hold (one behind a router, or this PC itself) is looked up again after this
 * long, not at every hello: each look starts arp.exe, once a minute for each such PC. */
export const MAC_RETRY_MS = 3600_000;
/** A PC that has just answered is in this PC's ARP table: its MAC is kept with the link so it can be woken when it sleeps. */
function learnMac(r: Remote): void {
  const ip = wake.ipOf(r.url);
  const had = d.store.peek()?.remotes.find(x => x.id === r.id)?.mac;
  if (!ip || had || Date.now() - (macTried.get(r.id) ?? -Infinity) < MAC_RETRY_MS) return;
  macTried.set(r.id, Date.now());
  void wake.lookupMac(ip).then(async mac => {
    if (!mac) return;
    const s = await d.store.settings();
    await d.store.saveSettings({ remotes: s.remotes.map(x => (x.id === r.id ? { ...x, mac } : x)) });
  }).catch(() => undefined);
}

/** A PC that does not answer is sent the wake-on-LAN packet (when its address is known) and waited for. Throws plain words if it does not come back. */
async function wakeUp(r: Remote, stage?: (text: string) => void): Promise<boolean> {
  const mac = wake.cleanMac(d.store.peek()?.remotes.find(x => x.id === r.id)?.mac);
  if (!mac) return false;
  stage?.(`"${r.name}" is not answering. Waking it (wake-on-LAN) and waiting up to ${wake.WAKE_WAIT_MS / 1000} seconds…`);
  const back = await wake.wakeNode({ mac, send: wake.sendMagic, reached: () => hello(r, 3000).then(() => true), waitMs: wake.WAKE_WAIT_MS, stepMs: 5000, sleep: async ms => void (await sleep(ms)), now: Date.now });
  if (!back) throw Object.assign(new Error(wake.wakeFailed(r.name, wake.WAKE_WAIT_MS / 1000, true)), { unreached: true });
  return true;
}
/** The request did not get through (as against a refusal, a stop or a missing key): the PC may be asleep. */
const notAnswering = (e: unknown) => /fetch failed|ECONN|ENETUNREACH|EHOSTUNREACH|UND_ERR|timed? ?out|timeout/i.test(`${(e as Error).message} ${(e as { cause?: { code?: string } }).cause?.code ?? ''}`);

/** A link from before the encryption: said as it is, not as "could not be reached". */
const relink = (e: unknown) => (e as { relink?: boolean }).relink === true;

/** A request from a linked PC's lock screen, as its hello says it (anything else is none). */
export function askOf(v: unknown): Hello['ask'] {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const hours = share.cleanAskHours(x.hours);
  return hours && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) ? { hours, at: x.at } : null;
}

/** Every linked PC that asked to be logged out and is waiting for an answer (as it said in its last hello). */
export function pcAsks(): { pc: string; name: string; hours: number; at: string }[] {
  return [...seen.entries()].filter(([, h]) => h.ask && !h.away).map(([pc, h]) => ({ pc, name: h.name, hours: h.ask!.hours, at: h.ask!.at }));
}

/** Called after each hello a linked PC answered (src/jobrun/passsync.ts: its guest passes go when it is behind). */
export const helloHooks: ((r: Remote, h: Hello) => void)[] = [];

export async function hello(r: Remote, ms = 4000): Promise<Hello> {
  let res: Response;
  try {
    res = await linkFetch(r, '/worker/hello', {}, AbortSignal.timeout(ms));
  } catch (e) {
    // Not answering: what it said before no longer counts as "on" (its staff show as off).
    seen.delete(r.id);
    throw e;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Unlinked there, or refusing: it no longer counts as on. It did answer, so what it said is shown (not "not answering").
    seen.delete(r.id);
    // A guest pass there that ended (expired: its host may be asked) or was removed: kept, for Search and its staff.
    await notePassEnd(r, res.status, data).catch(() => undefined);
    throw Object.assign(new Error(String(data.error ?? `it answered ${res.status}`)), { answered: true });
  }
  learnMac(r);
  const img = data.image && typeof data.image === 'object' ? (data.image as Record<string, unknown>) : null;
  // An older worker sends no memory, no "can" and no picture part: the manager says so instead of guessing.
  const h: Hello = {
    name: String(data.name ?? r.name),
    model: data.model ? String(data.model) : null,
    ctx: Number(data.ctx) || 8192,
    version: String(data.version ?? ''),
    // An older TOMLIN sends no build id: it is then judged by its version alone (src/update.ts standing).
    build: update.isBuild(data.build) ? data.build : '',
    // Its card as TOMLIN would use it: an older TOMLIN named the first card Windows listed (src/pccards.ts).
    memory: data.memory && typeof data.memory === 'object' ? cardFix(data.memory, runnerpush.cleanRunner(data.runner)) : null,
    can: Array.isArray(data.can) ? data.can.map(String) : [],
    image: img
      ? {
        model: img.model ? String(img.model) : null,
        name: img.name ? String(img.name) : null,
        styles: Array.isArray(img.styles) ? img.styles.map(String) : [],
        swaps: img.swaps === true,
        coverage: Array.isArray(img.coverage) ? (img.coverage as ReturnType<typeof brains.styleCoverage>) : [],
      }
      : null,
    models: nodestaff.cleanShared(data.models),
    away: typeof data.away === 'string' && !Number.isNaN(Date.parse(data.away)) ? data.away : null,
    ask: askOf(data.ask),
    allow: data.allow && typeof data.allow === 'object' ? carry.cleanAllow(data.allow) : null,
    restarts: data.restarts === true,
    up: upOf(data.up),
    meter: meterOf(data.meter),
    installed: typeof data.installed === 'string' && !Number.isNaN(Date.parse(data.installed)) ? data.installed : null,
    disk: carry.cleanDisk(data.disk),
    drives: carry.cleanDrives(data.drives),
    modelsDrive: carry.cleanDriveLetter(data.modelsDrive),
    // Its processor: null from an older TOMLIN, which the Cluster page shows as "not known".
    cpu: cleanCpu(data.cpu),
    runner: runnerpush.cleanRunner(data.runner),
    // An older TOMLIN sends no speed field (undefined); a newer one null until its speed test has run.
    ...('speed' in data ? { speed: cleanSpeed(data.speed) } : {}),
    guest: guestOf(data.guest),
    passAsks: passAsksOf(data.passAsks),
    cluster: cleanClusterHello(data.cluster),
    hostPin: data.hostPin === true,
    line: data.line && typeof data.line === 'object' ? { running: Math.max(0, Math.floor(Number((data.line as Record<string, unknown>).running) || 0)), waiting: Math.max(0, Math.floor(Number((data.line as Record<string, unknown>).waiting) || 0)) } : null,
  };
  // A "Backups only" PC lends nothing here: no model of it is offered for a hire, a chat, a job or a picture.
  if (backupsOnly(r.id) || clusterHeld(r.id)) Object.assign(h, { held: h.models, models: [], image: null });
  // "I need to log off for now": told once each time someone at that PC presses it.
  if (h.away && awayTold.get(r.id) !== h.away) d.onNodeAway?.(r.name);
  if (h.away) awayTold.set(r.id, h.away);
  else awayTold.delete(r.id);
  // "I need to use the pc, please log out for N hours": told once for each request sent there.
  if (h.ask && askTold.get(r.id) !== h.ask.at) d.onNodeAsk?.(h.name, h.ask.hours);
  if (h.ask) askTold.set(r.id, h.ask.at);
  else askTold.delete(r.id);
  seen.set(r.id, { ...h, at: Date.now() });
  if (h.up || h.meter) lastSaid.set(r.id, { up: h.up, meter: h.meter, at: Date.now() });
  if (h.model) lastModel.set(r.id, h.model);
  // The PC answered: a note that cannot be saved must not make it look switched off.
  await remember(r, h).catch(() => undefined);
  for (const f of helloHooks) f(r, h);
  return h;
}

/** This PC's guest pass there, as its hello says it (null: an admin link). */
function guestOf(v: unknown): Hello['guest'] {
  if (!v || typeof v !== 'object') return null;
  const g = v as Record<string, unknown>;
  const caps = g.caps && typeof g.caps === 'object' ? (g.caps as Record<string, unknown>) : null;
  return { label: String(g.label ?? '').replace(/[^\w .'-]/g, '').slice(0, 40), expires: typeof g.expires === 'string' && !Number.isNaN(Date.parse(g.expires)) ? g.expires : null, ...(caps ? { caps: { answer: Math.max(0, Math.floor(Number(caps.answer) || 0)), prompt: Math.max(0, Math.floor(Number(caps.prompt) || 0)) } } : {}) };
}

/** Requests from guests on passes this PC made, as that node's hello lists them (each cleaned again here). */
function passAsksOf(v: unknown): NonNullable<Hello['passAsks']> {
  return (Array.isArray(v) ? v.slice(0, 200) : []).flatMap(x => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !/^[0-9a-f]{8}$/.test(o.id) || typeof o.at !== 'string' || typeof o.expired !== 'string') return [];
    return [{ id: o.id, name: String(o.name ?? '').replace(/[^\w .'-]/g, '').slice(0, 40) || 'A guest PC', expired: o.expired, text: guestpass.cleanAskText(o.text), at: o.at }];
  });
}

/** Saves a few fields of one linked PC (read again first, so a change made meanwhile stays). */
async function saveRemote(id: string, patch: Partial<Remote>): Promise<void> {
  const s = await d.store.settings();
  if (!s.remotes.some(x => x.id === id)) return;
  await d.store.saveSettings({ remotes: s.remotes.map(x => (x.id === id ? { ...x, ...patch } : x)) });
}

/** A refusal from a PC this one is a guest on: its pass expired (with what became of a request) or was removed. */
async function notePassEnd(r: Remote, status: number, data: Record<string, unknown>): Promise<void> {
  let end: Remote['passEnd'] | undefined;
  if (data.guest === 'expired' || data.guest === 'blocked') {
    const a = data.ask && typeof data.ask === 'object' ? (data.ask as Record<string, unknown>) : null;
    end = { state: 'expired', at: typeof data.expired === 'string' ? data.expired : r.passEnd?.at ?? new Date().toISOString(), canAsk: data.canAsk === true, ask: a ? { state: String(a.state ?? ''), at: String(a.at ?? ''), reason: guestpass.cleanAskText(a.reason) } : null };
  } else if ((status === 401 || data.guest === 'removed') && r.role === 'guest') end = { state: 'removed', at: r.passEnd?.state === 'removed' ? r.passEnd.at : new Date().toISOString() };
  if (!end) return;
  r.passEnd = end;
  await saveRemote(r.id, { passEnd: end });
}

/**
 * A request to the host of a guest pass that ended, from this PC: sent now, or, when that PC does not answer, kept here
 * and sent at its next hello ("sent, waiting" either way).
 */
export async function sendPassAsk(r: Remote, text: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const at = new Date().toISOString();
  let res: Response;
  try {
    res = await workerPost(r, guestpass.ASK_DOOR, { text }, AbortSignal.timeout(8000));
  } catch {
    r.askOut = { text, at };
    await saveRemote(r.id, { askOut: r.askOut });
    return { status: 200, body: { state: 'waiting', held: true, said: `"${r.name}" is not answering now: your request is kept here and sent when it is back.` } };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  r.askOut = null;
  if (!res.ok) {
    await saveRemote(r.id, { askOut: null });
    return { status: res.status === 403 || res.status === 409 ? res.status : 400, body: { error: `"${r.name}" said: ${String(data.error ?? `no (${res.status})`)}`, blocked: data.guest === 'blocked' } };
  }
  r.passEnd = { state: 'expired', at: r.passEnd?.at ?? at, canAsk: false, ask: { state: 'waiting', at, reason: '' } };
  await saveRemote(r.id, { askOut: null, passEnd: r.passEnd });
  return { status: 200, body: { state: 'waiting' } };
}

/**
 * Keeps what a linked PC said about itself: its own name (the host cannot rename a node) and the models it lets this PC
 * use, so hires on them keep their model names while it is off. Written only when something changed.
 */
async function remember(r: Remote, h: Hello): Promise<void> {
  const name = h.name.replace(/[^\w .'-]/g, '').trim().slice(0, 40) || r.name;
  // An older PC says nothing about shared models: what was kept stays.
  const models = h.can.includes('models') ? h.models.map(x => ({ ...x, loaded: false, busy: false })) : r.models ?? [];
  // The computer's own name (in its memory part from 2.0.89): kept, so two PCs with one name stay told apart while off.
  const computer = brains.cleanComputer((h.memory as { computer?: unknown } | null)?.computer) || r.computer || '';
  // A guest there (its hello says so), with its pass's end; an answer means a pass that had ended works again.
  const role = h.guest ? 'guest' as const : undefined;
  const expires = h.guest ? h.guest.expires : undefined;
  const sameRole = role === r.role && (expires ?? null) === (r.expires ?? null) && !r.passEnd && !r.askOut;
  if (name === r.name && computer === (r.computer ?? '') && JSON.stringify(models) === JSON.stringify(r.models ?? []) && sameRole) return;
  const s = await d.store.settings();
  if (!s.remotes.some(x => x.id === r.id)) return;
  r.name = name;
  r.models = models;
  r.role = role;
  r.expires = expires;
  r.passEnd = null;
  r.askOut = null;
  if (computer) r.computer = computer;
  await d.store.saveSettings({ remotes: s.remotes.map(x => (x.id === r.id ? { ...x, name, models, ...(computer ? { computer } : {}), role, expires, passEnd: null, askOut: null } : x)) });
}

/**
 * A linked PC's model as a brain: what it has loaded, or (`shared`) one of the models it lets linked PCs use, which it
 * loads first when it is not loaded. While that model answers someone else there, this waits and asks again (told
 * through `stage`), up to 10 minutes or until Stop.
 */
/** How long an answer cut part-way is asked for again before the chat (or the step) is told and offered Reconnect. */
export const RECONNECT_MS = 2 * 60_000;

/** The error when the connection to a linked PC was lost part-way and did not come back: the answer is still owed. */
export type Lost = Error & { lost: { pc: string; name: string; rid: string } };
export const lostOf = (e: unknown): Lost['lost'] | null => (e as Partial<Lost>)?.lost ?? null;

export function remoteBrain(r: Remote, h: Hello, shared?: nodestaff.SharedModel, stage?: (text: string) => void): Brain {
  /** One ask, waiting while the model there answers someone else (up to 10 minutes, or Stop). */
  const once = async (body: Record<string, unknown>, signal: AbortSignal): Promise<Response> => {
    const until = Date.now() + 10 * 60_000;
    let told = false;
    let woken = false;
    const began = Date.now();
    for (;;) {
      let res: Response;
      try {
        res = await linkFetch(r, '/worker/run', body, signal);
      } catch (e) {
        if (signal.aborted) throw new Error('Stopped.');
        if (relink(e)) throw e;
        // Asleep, perhaps: woken by the wake-on-LAN packet once, then asked again.
        if (!woken && notAnswering(e)) {
          woken = true;
          if (await wakeUp(r, stage)) continue;
        }
        // Nothing came back for a minute or more before the link closed (undici gives up after 5 minutes with "fetch failed"): said as silence.
        if (notAnswering(e) && Date.now() - began >= wake.SILENT_WARN_MS) throw Object.assign(new Error(`${wake.silentWords(r.name, Date.now() - began)} The link then closed. Press Send again once it is awake.`), { unreached: true });
        throw Object.assign(new Error(`The linked PC "${r.name}" could not be reached at ${r.url} (${(e as Error).message}). Is TOMLIN running there with "Enable this PC as a node" ticked?`), { unreached: true });
      }
      if (res.ok || res.status !== 409 || !shared) return res;
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (data.busy !== true || Date.now() > until) throw new Error(`"${r.name}": ${String(data.error ?? 'busy')}`);
      if (!told) stage?.(`${shared.name} on "${r.name}" is answering something else. This answer starts when it is free (or press Stop).`);
      told = true;
      await sleep(3000);
      if (signal.aborted) throw new Error('Stopped.');
    }
  };
  const run = async (payload: Record<string, unknown>, onText: (t: string) => void, signal: AbortSignal, onThought?: AskOpts['onThought'], askedRid?: string, onReading?: AskOpts['onReading'], allTools?: ToolBox) => {
    // This PC is only a guest there: that PC's owner is not this one's, so its model gets none of this PC's file tools.
    const tools = allTools && h.guest ? onlyTools(allTools, GUEST_SIDE_TOOLS) ?? undefined : allTools;
    // `line`: this PC waits its turn in that node's line on the open answer, told its place (src/nodeline.ts); an older node ignores it.
    const body: Record<string, unknown> = shared ? { ...payload, model: shared.id, line: true } : { ...payload, line: true };
    // This PC's tools for the model there to call (2.0.82 on): the calls come back on the answer and are run here.
    if (tools && h.can.includes('tooltalk')) body.tools = toWire(tools);
    // The project this is for, so that PC logs its work under it (its log is the final tally: src/meter.ts).
    const project = scope.getStore()?.project;
    if (project) body.project = project;
    // Work from the queue: that PC may unload a model it loaded for linked PCs to make room (src/jobrun/node.ts).
    if (scope.getStore()?.queue) body.queue = true;
    // A PC that keeps answers (2.0.38 on) is asked with a request id: if the connection is lost part-way, it finishes
    // the answer and keeps it, and asking again with the same id follows it or gets it (src/outbox.ts).
    const rid = h.can.includes('outbox') ? cleanRid(askedRid) ?? ridOf(body) : null;
    if (rid) body.rid = rid;
    // Stop here stops it there too (a closed connection alone no longer does).
    const stop = () => void workerPost(r, '/worker/stop', { rid }, AbortSignal.timeout(5000)).catch(() => undefined);
    if (rid) signal.addEventListener('abort', stop, { once: true });
    // Each call the model there makes is run here once, whichever connection brings it, and its result posted back.
    const onTool = tools && body.tools && rid ? hostHandler(tools, signal, (id, result) => workerPost(r, '/worker/tool-result', { rid, id, result }, AbortSignal.timeout(60_000))) : null;
    // How long that PC has said nothing: told in the chat after a minute, and named when the link then closes.
    let lastWord = Date.now();
    const quiet = () => Date.now() - lastWord;
    const watch = setInterval(() => quiet() >= wake.SILENT_WARN_MS && stage?.(wake.silentWords(r.name, quiet())), 15_000);
    const cutBy = (e: unknown) => (quiet() >= wake.SILENT_WARN_MS && nodestaff.cutWords(r.name, (e as Error).message) !== (e as Error).message ? new Error(`${wake.silentWords(r.name, quiet())} The link then closed. Press Send again once it is awake.`) : e);
    try {
      let res = await once(body, signal);
      if (!res.ok) throw new Error(`"${r.name}": ${String(((await res.json().catch(() => ({}))) as Record<string, unknown>).error ?? `answered ${res.status}`)}${res.status === 401 ? '. Link it again under Network, Find other PCs.' : ''}`);
      let lostAt = 0;
      for (;;) {
        try {
          brain.last = null;
          brain.thought = null;
          brain.cut = false;
          brain.tools = null;
          brain.toolsOff = undefined;
          lastWord = Date.now();
          // A linked PC's speed comes back on its done line (an older PC sends none), and is kept here for that PC; so
          // does its working when it thought first (Think), which streams while it thinks.
          const text = await share.readStream(res, t => { lastWord = Date.now(); onText(t); }, (ev, data) => {
            // A heartbeat is not a word from that PC: it would reset the clock the silence warning reads.
            if (ev !== 'quiet') lastWord = Date.now();
            if (ev === 'status') stage?.(`"${r.name}": ${String(data.text ?? '')}`);
            // Only heartbeats for a minute or more: said plainly, not left as a silent chat.
            if (ev === 'quiet') stage?.(`"${r.name}" has sent nothing for ${Number(data.seconds) || 60} s: it is loading the model, reading a long prompt, or not answering. Still waiting (or press Stop).`);
            if (ev === 'tool') onTool?.(data);
            if (ev === 'thinking') onThought?.(String(data.text ?? ''), Number(data.seconds) || 0);
            // How far that PC's model is through reading the chat (2.0.49 on).
            if (ev === 'reading') {
              const r = cleanReading(data);
              if (r) onReading?.(r);
            }
            if (ev === 'done') {
              brain.last = keepRemoteSpeed(r, String(data.model ?? shared?.name ?? h.model ?? ''), data.speed);
              // Stopped at its length limit there (2.0.43 on): Continue is offered here.
              brain.cut = data.cut === true;
              // That PC's model cannot call tools: the answer was written without them.
              if (typeof data.toolsOff === 'string') brain.toolsOff = data.toolsOff.slice(0, 200);
              // What it searched for and read on the web there (Web on, 2.0.58 on).
              const tools = (Array.isArray(data.tools) ? data.tools : []).slice(0, 40).map(cleanUse).filter((u): u is ToolUse => !!u);
              if (tools.length) brain.tools = tools;
              // What that PC used for it (2.0.39 on), counted for that PC under the project this is for.
              const used = cleanUsed(data.usage);
              if (used) d.usage(r.id, used, String(data.model ?? shared?.name ?? ''));
              const t = data.thought as { text?: unknown; seconds?: unknown; stopped?: unknown } | null | undefined;
              const stopped = (['loop', 'long', 'hurry'] as const).find(x => x === t?.stopped);
              if (t && typeof t.text === 'string' && t.text) brain.thought = { text: t.text.slice(-40_000), seconds: Math.max(0, Math.round(Number(t.seconds) || 0)), ...(stopped ? { stopped } : {}) };
            }
          });
          // It came in whole: that PC need not keep it any longer.
          if (rid) void workerPost(r, '/worker/taken', { rids: [rid] }, AbortSignal.timeout(5000)).catch(() => undefined);
          return text;
        } catch (cut) {
          const e = cutBy(cut);
          if (signal.aborted) throw new Error('Stopped.');
          // What that PC said went wrong (a fault there) is not a lost connection. It has been read, so that PC need
          // not keep it: kept, asking again with the same id (the same step, run again) would get the old fault back.
          const said = /^The worker said/.test((e as Error).message);
          if (rid && said) void workerPost(r, '/worker/taken', { rids: [rid] }, AbortSignal.timeout(5000)).catch(() => undefined);
          if (!rid || said) throw e;
          if (!lostAt && quiet() >= wake.SILENT_WARN_MS) stage?.(wake.silentWords(r.name, quiet()));
          lostAt ||= Date.now();
        }
        // The connection was lost part-way: that PC carries on. It is asked again with the same id every 5 s, which
        // follows the answer there (or gets it, once done); after two minutes the chat is told, with Reconnect.
        for (;;) {
          if (Date.now() - lostAt > RECONNECT_MS) throw Object.assign(new Error(`Lost the connection to "${r.name}" part-way: it is still working on it.`), { lost: { pc: r.id, name: r.name, rid } });
          stage?.(`Lost the connection to "${r.name}": it is still working on it. Reconnecting…`);
          await sleep(5000);
          if (signal.aborted) throw new Error('Stopped.');
          try {
            res = await once(body, signal);
          } catch (e) {
            if (signal.aborted || !(e as { unreached?: boolean }).unreached) throw e;
            continue;
          }
          if (res.ok) break;
          throw new Error(`"${r.name}": ${String(((await res.json().catch(() => ({}))) as Record<string, unknown>).error ?? `answered ${res.status}`)}`);
        }
      }
    } finally {
      clearInterval(watch);
      signal.removeEventListener('abort', stop);
    }
  };
  const brain: Brain = {
    label: `${shared?.name ?? h.model} on ${r.name}`,
    ctx: shared?.ctx ?? h.ctx,
    ask: (system, user, maxTokens, onText, signal, opts) => run({ system, user, maxTokens, ...(opts?.web && h.can.includes('web') ? { web: opts.web } : {}) }, onText, signal),
    // An older worker takes one message: the conversation is written into it.
    // `plain` and `think` go with it; an older PC does not read them and asks with its own settings.
    chat: (turns, maxTokens, onText, signal, opts) => run(h.can.includes('turns') ? { turns, maxTokens, ...(opts?.plain ? { plain: true } : {}), ...(opts?.think ? { think: true } : {}), ...(opts?.web && h.can.includes('web') ? { web: opts.web } : {}) } : { ...brains.flatten(turns), maxTokens }, onText, signal, opts?.onThought, opts?.rid, opts?.onReading, opts?.tools),
    last: null,
  };
  return brain;
}

/**
 * Where an answer owed by a linked PC is now (src/outbox.ts): still being written (its words so far), finished, or not
 * there any more; null when that PC does not answer.
 */
export async function owedNow(r: Remote, rid: string): Promise<{ state: 'working'; text: string } | { state: 'done' | 'error'; text: string; done?: Record<string, unknown>; error?: string; at: string } | { state: 'gone'; why: string } | null> {
  let res: Response;
  try {
    res = await linkFetch(r, '/worker/result', { rid }, AbortSignal.timeout(6000));
  } catch {
    return null;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 404 && data.gone === true) return { state: 'gone', why: String(data.error ?? `"${r.name}" does not have that answer any more. Send your message again.`) };
  if (!res.ok) return null;
  if (data.state === 'working') return { state: 'working', text: String(data.text ?? '') };
  if (data.state === 'done' || data.state === 'error') return { state: data.state, text: String(data.text ?? ''), done: data.done && typeof data.done === 'object' ? (data.done as Record<string, unknown>) : undefined, error: data.error ? String(data.error) : undefined, at: String(data.at ?? '') };
  return null;
}

/** That PC has the owed answers now: it need not keep them. */
export const owedTaken = (r: Remote, rids: string[]) => workerPost(r, '/worker/taken', { rids }, AbortSignal.timeout(5000)).then(() => undefined, () => undefined);

/** A linked PC's figures for one answer: kept for that PC and model (src/speed.ts), and handed back for the speed line. */
function keepRemoteSpeed(r: Remote, model: string, raw: unknown): Brain['last'] {
  const s = raw && typeof raw === 'object' ? (raw as { write?: unknown; tokens?: unknown; read?: unknown; readTokens?: unknown }) : null;
  const write = Number(s?.write);
  if (!s || !(write > 0)) return null;
  // readTokens: how much it read this turn (a node from 2.0.58 says; an older one does not, and its read speed is then
  // never used to size a chat's layers).
  const readTokens = Math.round(Number(s.readTokens) || 0);
  const speed = { write, tokens: Math.round(Number(s.tokens) || 0), ...(Number(s.read) > 0 ? { read: Number(s.read) } : {}), ...(readTokens > 0 ? { readTokens } : {}) };
  if (model) d.speeds.add(speedKeys.pcKey(r.id, model), model, r.name, speed, 'answer');
  return speed;
}

export async function workerPost(r: Remote, path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await linkFetch(r, path, payload, signal);
  } catch (e) {
    if (signal?.aborted) throw new Error('Stopped.');
    if (relink(e)) throw e;
    throw new Error(`"${r.name}" could not be reached at ${r.url} (${(e as Error).message}). Is TOMLIN running there with sharing on?`);
  }
}

/** Why one of a linked PC's shared models cannot answer for this PC now ('' when it can: loaded there or loadable). */
export function sharedWhy(r: Remote, h: Hello, model: string): string {
  const name = sharedName(r.id, model);
  if (backupsOnly(r.id)) return backupsOnlyWhy(r.name);
  if (clusterHeld(r.id)) return heldWhy(r.name);
  if (h.away) return `"${r.name}" is being used by its owner for now (they pressed "I need to use the pc")`;
  if (!h.can.includes('models')) return `"${r.name}" runs an older TOMLIN that cannot lend its models by name: update it there`;
  if (!h.models.some(x => x.id === model && x.kind === 'chat')) return `${name} is no longer on "${r.name}"`;
  return '';
}

/** Whether a linked PC that answered no longer has the model (not: off, busy with its owner, older, or Backups only). */
export function sharedGone(r: Remote, h: Hello, model: string): boolean {
  return !backupsOnly(r.id) && !clusterHeld(r.id) && !h.away && h.can.includes('models') && !h.models.some(x => x.id === model && x.kind === 'chat');
}

/** A linked PC's shared model by name: as it last said, else as kept, else from its file name. */
export function sharedName(pc: string, model: string): string {
  return seen.get(pc)?.models.find(x => x.id === model)?.name
    ?? d.store.peek()?.remotes.find(x => x.id === pc)?.models?.find(x => x.id === model)?.name
    ?? model.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');
}

// ---- Pictures on a paired PC ----

/**
 * A linked PC that can draw now. A ref naming one of its shared picture models (`remote:<pc>:<model>`): that PC, when it
 * still lets this one use it (it loads there when asked). A ref naming only the PC, or (anyPc) any linked PC: one with a
 * picture model loaded. `why`: what was found wrong with the named ones, for the message when none can draw.
 */
export async function pictureDrawer(refs: string[], anyPc: boolean, why: string[] = []): Promise<{ r: Remote; h: Hello; model?: string } | null> {
  const s = await d.store.settings();
  const named = refs.map(brains.parseRef).flatMap(b => (b.kind === 'remote' ? s.remotes.filter(r => r.id === b.pc).map(r => ({ r, model: b.model })) : []));
  for (const { r, model } of named.length ? named : anyPc ? s.remotes.map(r => ({ r, model: undefined })) : []) {
    if (r.backupsOnly) {
      if (model || named.length) why.push(backupsOnlyWhy(r.name));
      continue;
    }
    const h = await hello(r, 3000).catch(() => null);
    if (!h) {
      why.push(`"${r.name}" is off or not answering`);
      continue;
    }
    if (model) {
      const no = h.away ? `"${r.name}" is being used by its owner for now`
        : !h.can.includes('draw-models') ? `"${r.name}" runs an older TOMLIN that cannot lend its picture models: update it there`
        : !h.models.some(x => x.id === model && x.kind === 'image') ? `${sharedName(r.id, model)} is no longer on "${r.name}"` : '';
      if (!no) return { r, h, model };
      why.push(no);
    } else if (h.can.includes('draw') && h.image?.model) return { r, h };
  }
  return null;
}

/**
 * Asks a linked PC to draw: a prompt and a style in, the picture back. With `model` (one it lets this PC use) it draws on
 * that, loading it first, and while it draws for someone else this waits and asks again every 3 s (up to 10 minutes or
 * Stop); without, it uses its own loaded model (or another of its own for the style).
 * With `rid` and a PC that keeps pictures (2.0.89 on), a connection lost part-way is collected again with the same id
 * (src/jobrun/pictureback.ts); `taken` then tells that PC it may forget the picture: call it once the picture is saved here.
 */
export async function drawOn(r: Remote, ask: { prompt: string; style: string | null; width?: number; height?: number; quality?: string; seed?: number; negative?: string; model?: string; queue?: boolean; rid?: string }, progress: (p: Record<string, unknown>) => void, signal: AbortSignal): Promise<Drawn & { taken: () => Promise<void> }> {
  const { rid: askedRid, ...rest } = ask;
  const rid = askedRid && cleanRid(askedRid) && seen.get(r.id)?.can.includes('draw-outbox') ? askedRid : null;
  const body = rid ? { ...rest, rid } : rest;
  // `line`: waits its turn in that node's line (src/nodeline.ts); an older node ignores it.
  Object.assign(body, { line: true });
  const once = async (): Promise<Response> => {
    const until = Date.now() + 10 * 60_000;
    let told = false;
    for (;;) {
      let res: Response;
      try {
        res = await linkFetch(r, '/worker/draw', body, signal);
      } catch (e) {
        if (signal.aborted) throw new Error('Stopped.');
        if (relink(e)) throw e;
        throw new Error(`"${r.name}" could not be reached at ${r.url} (${(e as Error).message}).`);
      }
      if (res.ok || res.status !== 409 || !ask.model) return res;
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (data.busy !== true || Date.now() > until) throw new Error(`"${r.name}": ${String(data.error ?? 'busy')}`);
      if (!told) progress({ text: `${sharedName(r.id, ask.model)} is drawing something else there. This picture starts when it is free (or press Stop)` });
      told = true;
      await sleep(3000);
      if (signal.aborted) throw new Error('Stopped.');
    }
  };
  // Stop here stops it there too (a closed connection alone no longer does, once it is kept).
  const stop = () => void workerPost(r, '/worker/stop', { rid }, AbortSignal.timeout(5000)).catch(() => undefined);
  if (rid) signal.addEventListener('abort', stop, { once: true });
  const taken = () => (rid ? workerPost(r, '/worker/taken', { rids: [rid] }, AbortSignal.timeout(5000)).then(() => undefined, () => undefined) : Promise.resolve());
  try {
    const got = await collectPicture({ name: r.name, rid, ask: once, progress, signal, cutWords: m => nodestaff.cutWords(r.name, m) });
    return { ...got, taken };
  } catch (e) {
    // A fault that PC said has been read: it need not keep it (asking again would only bring the old fault back).
    if (saidOf(e)) void taken();
    throw e;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/**
 * Reads a linked PC's own log of the work it did for this PC, per project, and takes it as the final tally for that PC
 * (src/meter.ts). False when it did not answer, or keeps no log (before 2.0.40).
 */
export async function syncUsage(r: Remote, ms = 4000): Promise<boolean> {
  try {
    const res = await linkFetch(r, '/worker/usage', {}, AbortSignal.timeout(ms));
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { rows?: unknown };
    const rows = (Array.isArray(data.rows) ? data.rows : []).flatMap((x: Record<string, unknown>) => (typeof x?.project === 'string' && /^[\w-]{0,40}$/.test(x.project) ? [{ project: x.project, tally: cleanTally(x.tally), last: String(x.last ?? '') }] : []));
    d.usageTake(r.id, rows);
    return true;
  } catch {
    return false;
  }
}

/** Each paired worker PC, asked whether it is there and what model it has loaded. */
/** Linked PCs whose saved link can work, and those linked before links were encrypted (they need linking again). */
export async function linkCount(): Promise<{ working: number; broken: string[] }> {
  const s = await d.store.settings();
  return { working: s.remotes.filter(r => link.keysOf(r.key)).length, broken: s.remotes.filter(r => !link.keysOf(r.key)).map(r => r.name) };
}

/**
 * A linked PC ahead of this one (a newer version, or the same with other files): whether Update this PC from it can take
 * its TOMLIN here (why '' ), or why not; null when it is not ahead. other: the same version with other files.
 */
export function pullOf(h: Pick<Hello, 'name' | 'version' | 'build' | 'away' | 'can' | 'allow'>, name = h.name) {
  const why = update.pullWhy({ name, ok: true, version: h.version, build: h.build, away: h.away, can: h.can ?? [], allowGive: h.allow?.give === true }, d.version, d.build(), d.update.restarts);
  return why === null ? null : { why, mine: d.version, build: update.shortBuild(d.build()), other: !update.newer(h.version, d.version) };
}

/** A hello answered within this long counts as what the PC says now, for a list drawn without asking (`known`). */
export const KNOWN_MS = 5 * 60_000;
/** The hellos on their way now, by PC: two lists asked at once (Hire staff's PCs and its models) share one asking. */
const asking = new Map<string, Promise<Hello>>();
/** When each PC last failed to answer a hello asked here (it is off, or not answering). */
const missed = new Map<string, number>();
function helloShared(r: Remote): Promise<Hello> {
  const now = asking.get(r.id);
  if (now) return now;
  const p = hello(r, 3000).then(h => {
    missed.delete(r.id);
    return h;
  }, (e: unknown) => {
    missed.set(r.id, Date.now());
    throw e;
  }).finally(() => asking.delete(r.id));
  asking.set(r.id, p);
  return p;
}

/**
 * Each linked PC as it is now: asked (a hello each, 3 s at most for one that is off). `known`: from what each said last
 * instead, at once, for a page drawn first and again once they are asked: a PC that did not answer last time is off,
 * one not heard from lately is "asking" (and is asked now, in the background).
 */
export async function remoteStatus(o: { known?: boolean } = {}) {
  const s = await d.store.settings();
  return Promise.all(s.remotes.map(async r => {
    try {
      const was = o.known ? seen.get(r.id) : undefined;
      if (o.known && (!was || Date.now() - was.at > KNOWN_MS)) {
        void helloShared(r).catch(() => undefined);
        const off = (missed.get(r.id) ?? 0) > (was?.at ?? 0);
        throw Object.assign(new Error(off ? `"${r.name}" did not answer` : `"${r.name}" has not answered yet`), { asking: !off });
      }
      const h = was ?? await helloShared(r);
      const behind = update.updateWhy({ name: r.name, ok: true, version: h.version, build: h.build, away: h.away, can: h.can, restarts: h.restarts, allowUpdate: h.allow?.update === true }, d.version, d.build());
      // build: the 7 characters shown beside its version ('' from an older TOMLIN); update.other: the same version with
      // different files, and update.build this PC's, for "Runs 2.0.48 but different files from this PC (build x there, y here)".
      return { id: r.id, name: r.name, url: r.url, ok: true, role: r.role, expires: h.guest?.expires ?? r.expires ?? null, caps: h.guest?.caps ?? null, line: h.line ?? null, model: h.model, ctx: h.ctx, version: h.version, build: update.shortBuild(h.build), memory: h.memory, can: h.can, image: h.image, away: h.away, models: h.models, allow: h.allow, disk: h.disk, drives: h.drives, modelsDrive: h.modelsDrive, cpu: h.cpu ?? null, runner: h.runner, held: h.held, backupsOnly: r.backupsOnly === true, noBorrow: r.noBorrow === true, inCluster: isMember(d.store.peek()?.cluster, r.id), heldByCluster: clusterHeld(r.id), update: behind === null ? null : { why: behind, mine: d.version, build: update.shortBuild(d.build()), other: update.standing(h, d.version, d.build()) === 'other' }, pull: pullOf(h, r.name) };
    } catch (e) {
      return { id: r.id, name: r.name, url: r.url, ok: false, role: r.role, expires: r.expires ?? null, passEnd: r.passEnd ?? null, canAsk: r.passEnd?.canAsk === true && !r.askOut, ask: r.askOut ? { state: 'waiting', at: r.askOut.at, reason: '', held: true } : r.passEnd?.ask ?? null, backupsOnly: r.backupsOnly === true, noBorrow: r.noBorrow === true, inCluster: isMember(d.store.peek()?.cluster, r.id), heldByCluster: clusterHeld(r.id), error: (e as Error).message, relink: relink(e), answered: (e as { answered?: boolean }).answered === true, asking: (e as { asking?: boolean }).asking === true };
    }
  }));
}

/** What a paired PC said last, without asking again (null when it has not been asked yet). */
export const lastHello = (id: string) => seen.get(id) ?? null;

/**
 * A paired PC's meters now, for the top bar while a chat with someone on it is open: 'on' with the figures, 'old' when
 * its TOMLIN is from before meters were shared, 'off' when it does not answer in 2.5 s, 'gone' when it is not linked.
 * `model`: the chat model loaded there, as its last hello said (about once a minute), or null. `chatModel`: the model
 * the open chat uses there (its id on that PC, '' for none): the only one the asking keeps loaded there.
 */
export async function nodeStats(pc: string, chatModel = ''): Promise<{ state: 'on'; stats: nodestaff.NodeStats; name: string; model: string | null } | { state: 'old' | 'off' | 'gone'; name: string; model: string | null }> {
  const r = (await d.store.settings()).remotes.find(x => x.id === pc);
  if (!r) return { state: 'gone', name: '', model: null };
  const model = seen.get(pc)?.model ?? null;
  try {
    const res = await linkFetch(r, '/worker/stats', { model: chatModel }, AbortSignal.timeout(2500));
    if (res.status === 404) return { state: 'old', name: r.name, model };
    const stats = res.ok ? nodestaff.cleanStats(await res.json().catch(() => null)) : null;
    return stats ? { state: 'on', stats, name: r.name, model } : { state: 'off', name: r.name, model };
  } catch {
    return { state: 'off', name: r.name, model };
  }
}

/**
 * A linked PC's log, its last `lines` lines: today's, or `ask.day` (one of the 7 days it keeps), only the lines holding
 * `ask.find` when given. 'on' with them, 'old' when its TOMLIN is from before the door, 'off' when it does not answer in
 * 10 s, 'gone' when it is not linked. Its lines are its own words: kept as text, trimmed. A TOMLIN from before days and
 * search sends today's lines whatever was asked: `todayOnly` says so, and the search is then done here on what came.
 */
export async function nodeLog(pc: string, lines = 300, ask: { day?: string; find?: string } = {}): Promise<{ state: 'on'; name: string; day: string; lines: string[]; days: string[]; todayOnly?: true } | { state: 'old' | 'off' | 'gone'; name: string; error?: string }> {
  const r = (await d.store.settings()).remotes.find(x => x.id === pc || x.name.toLowerCase() === pc.toLowerCase());
  if (!r) return { state: 'gone', name: '' };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(ask.day ?? '') ? ask.day! : '';
  const find = cleanLogFind(ask.find);
  try {
    const res = await linkFetch(r, '/worker/log', { lines, ...(day ? { day } : {}), ...(find ? { find } : {}) }, AbortSignal.timeout(10_000));
    if (res.status === 404) return { state: 'old', name: r.name };
    return { name: r.name, ...logAnswer(res.status, await res.json().catch(() => null), { day, find }) };
  } catch (e) {
    return { state: 'off', name: r.name, error: (e as Error).message };
  }
}

/** A hire's linked PC keeps an answer when the connection is lost (src/outbox.ts): it said so in its last hello (2.0.38 on). */
export const canKeep = (ref: string) => {
  const x = brains.parseRef(ref);
  return x.kind === 'remote' && !!seen.get(x.pc)?.can.includes('outbox');
};

/** A hire's linked PC can run the web tools for an answer (Web on): it said so in its last hello (2.0.58 on). */
export const canWeb = (ref: string) => {
  const x = brains.parseRef(ref);
  return x.kind === 'remote' && !!seen.get(x.pc)?.can.includes('web');
};

/** A hire's linked PC can call this PC's tools for an answer (files, web, research ...): it said so in its last hello (2.0.82 on). */
export const canTools = (ref: string) => {
  const x = brains.parseRef(ref);
  return x.kind === 'remote' && !!seen.get(x.pc)?.can.includes('tooltalk');
};

/** A hire's linked PC can think first when asked (Think): it said so in its last hello (2.0.31 on). */
export const canThink = (ref: string) => {
  const x = brains.parseRef(ref);
  return x.kind === 'remote' && !!seen.get(x.pc)?.can.includes('think');
};

export function startLinks(): void {
  // The main PC asks each linked PC once a minute, so "I need to log off for now" is told even with no page open.
  // Each answer (or not) is that PC's uptime check (src/meter.ts Uptime).
  // Each answer (or not) is that PC's uptime check; one that keeps a log of its work for this PC is read too.
  setInterval(() => void d.store.settings().then(s => Promise.all(s.remotes.map(r => hello(r, 3000).then(h => {
    d.uptimeMark(r.id, true);
    if (h.can.includes('usage')) return syncUsage(r);
  }, () => {
    d.uptimeMark(r.id, false);
    if (r.askOut && r.passEnd?.state === 'expired') void sendPassAsk(r, r.askOut.text).catch(() => undefined);
  })))).catch(() => undefined), 60_000).unref();
}
