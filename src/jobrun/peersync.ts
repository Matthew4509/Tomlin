// This PC as a host: it introduces two PCs linked to it, so they may talk to each other directly (src/peerlink.ts), and
// sends each its half over the sealed link (the node takes it at /worker/peer-put). Sent when an introduction is made
// or ended, and again after any hello from a PC that does not hold the latest generation yet, so an ending reaches a PC
// that was off once it is back. The host keeps only live introductions: one it no longer sends ends on each PC. A PC
// whose owner removed a peer there says so in its answer, and the host ends that pair for both. The Network page is
// told which PCs hold the latest, which are behind, and why.
import * as guestpass from '../guestpass.ts';
import * as peerlink from '../peerlink.ts';
import type { Remote } from '../store.ts';
import type { Hello } from '../jobrun.ts';
import { helloHooks, seen, workerPost } from './links.ts';
import { peerHooks, saveShare, shareState } from './node.ts';
import { d } from './shared.ts';

type Sync = 'latest' | 'behind' | 'off' | 'old' | 'refused';
type Done = { status: number; body: Record<string, unknown> };
/** How each PC stood at the last try (by its id), for the page. */
const standing = new Map<string, { sync: Sync; said: string; at: number }>();
/** A send on its way to a PC: a second one waits for it. */
const sending = new Map<string, Promise<void>>();

/** Pairs of PCs introduced at most. */
export const MAX_PAIRS = 200;

const intros = () => shareState.intros ?? [];
const holdsLatest = (id: string) => (shareState.introGen ?? 0) === 0 || shareState.introAcks?.[id] === shareState.introGen;
const pairOf = (x: peerlink.Intro, a: string, b: string) => (x.from.id === a && x.to.id === b) || (x.from.id === b && x.to.id === a);

/** The list changed: a new generation, saved, and sent to every PC. */
async function changed(list: peerlink.Intro[]): Promise<void> {
  shareState.intros = list;
  shareState.introGen = guestpass.nextGen(shareState.introGen);
  await saveShare();
  void sendAll().catch(() => undefined);
}

/** A linked PC as one end of an introduction: its home addresses as it last said them, then the one this PC reaches it on. */
function endOf(r: Remote, h?: Hello): peerlink.PeerEnd {
  let host = '';
  let port: number | undefined;
  try {
    const u = new URL(r.url);
    host = u.hostname;
    port = Number(u.port) || undefined;
  } catch { /* an address that is not one: only what it said */ }
  return { id: r.id, name: r.name, addrs: [...(h?.addrs ?? []), host], port };
}

/** Sends PC `r` its half of every introduction, unless it holds the latest already (or runs a TOMLIN without peers). */
export function sendPeers(r: Remote, h?: Hello): Promise<void> {
  const busy = sending.get(r.id);
  if (busy) return busy;
  const p = sendNow(r, h).finally(() => sending.delete(r.id));
  sending.set(r.id, p);
  return p;
}

async function sendNow(r: Remote, h?: Hello): Promise<void> {
  // This PC is a guest there: it introduces nobody to that PC.
  if (r.role === 'guest' || h?.guest) return void standing.delete(r.id);
  if (holdsLatest(r.id)) return void standing.set(r.id, { sync: 'latest', said: '', at: Date.now() });
  const hello = h ?? seen.get(r.id);
  if (hello && !hello.can.includes('peers')) return void standing.set(r.id, { sync: 'old', said: `runs an older TOMLIN (${hello.version}): update it there so it can talk to other PCs directly`, at: Date.now() });
  const gen = shareState.introGen!;
  try {
    const res = await workerPost(r, '/worker/peer-put', { gen, peers: peerlink.peerSet(intros(), r.id) }, AbortSignal.timeout(8000));
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return void standing.set(r.id, { sync: 'refused', said: `said: ${String(data.error ?? `no (${res.status})`)}`, at: Date.now() });
    if (data.stale === true) return void standing.set(r.id, { sync: 'refused', said: 'holds newer introductions from this PC than this PC has (was this PC put back from a backup?)', at: Date.now() });
    if (Number(data.gen) !== gen) return void standing.set(r.id, { sync: 'behind', said: 'did not say it took them; sent again at its next hello', at: Date.now() });
    shareState.introAcks = { ...shareState.introAcks, [r.id]: gen };
    // Its owner removed a peer there: that pair ends here, so the other PC is told too.
    const cut = new Set((Array.isArray(data.removedHere) ? data.removedHere : []).map(String));
    const hit = intros().filter(x => cut.has(x.id));
    if (hit.length) {
      return void (await changed(intros().filter(x => !hit.some(y => pairOf(x, y.from.id, y.to.id)))));
    }
    await saveShare();
    // Changed again while this was on its way: the newer set goes now.
    if (!holdsLatest(r.id)) return sendNow(r, h);
    standing.set(r.id, { sync: 'latest', said: '', at: Date.now() });
  } catch {
    standing.set(r.id, { sync: 'off', said: 'is not answering; it is told when it is back', at: Date.now() });
  }
}

const admins = async () => (await d.store.settings()).remotes.filter(r => r.role !== 'guest');

/** Sends every linked PC its half now. */
export async function sendAll(): Promise<void> {
  await Promise.all((await admins()).map(r => sendPeers(r)));
}

/** "Let these PCs talk to each other": `a` and `b` (linked PCs, by id) may call each other for `scopes`. */
async function introduce(b: Record<string, unknown>): Promise<Done> {
  const remotes = await admins();
  const ends: peerlink.PeerEnd[] = [];
  for (const id of [b.a, b.b]) {
    const r = remotes.find(x => x.id === id);
    if (!r) return { status: 404, body: { error: 'Pick two PCs linked to this one (not one this PC is only a guest on).' } };
    const h = seen.get(r.id);
    if (!h) return { status: 409, body: { error: `"${r.name}" is not answering now. Introduce it when it is on.` } };
    if (!h.can.includes('peers')) return { status: 409, body: { error: `"${r.name}" runs an older TOMLIN (${h.version}) that cannot talk to other PCs directly: update it first.` } };
    if (h.allow?.peer !== true) return { status: 409, body: { error: `The owner of "${r.name}" has not ticked "Let PCs my host introduces connect to this PC directly" there (Network, sharing permissions).` } };
    ends.push(endOf(r, h));
  }
  // The same two again: the old pair goes, the new one (new keys) takes its place.
  const rest = intros().filter(x => !pairOf(x, ends[0].id, ends[1].id));
  if (new Set(rest.map(x => [x.from.id, x.to.id].sort().join())).size >= MAX_PAIRS) return { status: 409, body: { error: `${MAX_PAIRS} pairs of PCs are introduced already. End one first.` } };
  const made = [peerlink.makeIntro(ends[0], ends[1], { scopes: b.scopes }), peerlink.makeIntro(ends[1], ends[0], { scopes: b.scopes })];
  const bad = made.find((x): x is { error: string } => 'error' in x);
  if (bad) return { status: 400, body: bad };
  await changed([...rest, ...(made as peerlink.Intro[])]);
  return { status: 200, body: {} };
}

/** Ends the pair `a` and `b`: both are told at once, or when each is back. */
async function remove(b: Record<string, unknown>): Promise<Done> {
  const rest = intros().filter(x => !pairOf(x, String(b.a), String(b.b)));
  if (rest.length === intros().length) return { status: 404, body: { error: 'Those two PCs are not introduced to each other.' } };
  await changed(rest);
  return { status: 200, body: {} };
}

/** Asks each of the pair `a` and `b` whether it reaches the other directly now: one line a direction. */
async function check(b: Record<string, unknown>): Promise<Done> {
  const remotes = await admins();
  const one = remotes.find(x => x.id === b.a);
  const two = remotes.find(x => x.id === b.b);
  if (!one || !two || !intros().some(x => pairOf(x, one.id, two.id))) return { status: 404, body: { error: 'Those two PCs are not introduced to each other.' } };
  const ask = async (from: Remote, to: Remote) => {
    const line = { from: from.name, to: to.name };
    try {
      const res = await workerPost(from, '/worker/peer-ping', { pc: to.id }, AbortSignal.timeout(30_000));
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { ...line, ok: false, said: `"${from.name}" said: ${String(data.error ?? `no (${res.status})`)}` };
      return { ...line, ok: data.ok === true, address: typeof data.address === 'string' ? data.address : '', ms: Number(data.ms) || 0, said: typeof data.said === 'string' ? data.said : '' };
    } catch {
      return { ...line, ok: false, said: `"${from.name}" is not answering now.` };
    }
  };
  return { status: 200, body: { peerCheck: await Promise.all([ask(one, two), ask(two, one)]) } };
}

/**
 * "Copy this model from `from` to `to` directly": `to` pulls it from `from` over the home network, with this PC only giving the
 * order and following it. `action` is start (the default), state or stop. Needs the pair introduced for "copy", both
 * PCs able to (an older TOMLIN is named), and a model `from` shares.
 */
async function copyOrder(b: Record<string, unknown>): Promise<Done> {
  const remotes = await admins();
  const from = remotes.find(x => x.id === b.from);
  const to = remotes.find(x => x.id === b.to);
  if (!from || !to) return { status: 404, body: { error: 'Pick two PCs linked to this one.' } };
  // `to` calls `from`: the introduction that lets it is the one made from `to`.
  if (!intros().some(x => x.from.id === to.id && x.to.id === from.id && x.scopes.includes('copy'))) return { status: 409, body: { error: `"${to.name}" and "${from.name}" are not introduced to each other for copying models. Introduce them, with "copy".` } };
  const action = b.action === 'state' || b.action === 'stop' ? b.action : 'start';
  const kind = b.kind === 'image' ? 'image' : 'chat';
  const model = String(b.model ?? '');
  let name = model;
  if (action === 'start') {
    const hello = seen.get(to.id);
    if (!hello) return { status: 409, body: { error: `"${to.name}" is not answering now.` } };
    if (!hello.can.includes('peer-copy')) return { status: 409, body: { error: `"${to.name}" runs an older TOMLIN (${hello.version}) that cannot copy a model directly: update it first.` } };
    const shared = (from.models ?? []).find(m => m.id === model && m.kind === kind);
    if (!shared) return { status: 404, body: { error: `"${from.name}" does not share that model (as far as this PC last heard).` } };
    name = shared.name;
  }
  try {
    const res = await workerPost(to, '/worker/peer-copy', { action, pc: from.id, kind, model, name }, AbortSignal.timeout(20_000));
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { status: res.status === 404 || res.status === 403 || res.status === 503 ? res.status : 409, body: { error: `"${to.name}" said: ${String(data.error ?? `no (${res.status})`)}` } };
    return { status: 200, body: { peerCopy: { from: from.name, to: to.name, ...data } } };
  } catch {
    return { status: 502, body: { error: `"${to.name}" is not answering now.` } };
  }
}

/** For the Network page: each pair with what it may do, and whether each of the two holds the latest. Nothing secret. */
export function peerView() {
  const remotes = (d.store.peek()?.remotes ?? []).filter(r => r.role !== 'guest');
  const syncOf = (id: string) => {
    const s = holdsLatest(id) ? { sync: 'latest' as Sync, said: '' } : standing.get(id) ?? { sync: 'behind' as Sync, said: 'not sent yet; it is told at its next hello' };
    return { id, name: remotes.find(r => r.id === id)?.name ?? 'a PC no longer linked', sync: s.sync, said: s.said };
  };
  const pairs = new Map<string, { a: ReturnType<typeof syncOf>; b: ReturnType<typeof syncOf>; scopes: peerlink.PeerScope[]; created: string }>();
  for (const x of intros()) {
    const [a, b] = [x.from.id, x.to.id].sort();
    if (!pairs.has(`${a}|${b}`)) pairs.set(`${a}|${b}`, { a: syncOf(a), b: syncOf(b), scopes: x.scopes, created: x.created });
  }
  return { pairs: [...pairs.values()], pcs: remotes.map(r => ({ id: r.id, name: r.name, can: seen.get(r.id)?.can.includes('peers') ?? null, allowed: seen.get(r.id)?.allow?.peer === true, copies: seen.get(r.id)?.can.includes('peer-copy') ?? false, models: (r.models ?? []).map(m => ({ id: m.id, name: m.name, kind: m.kind })) })), scopes: peerlink.PEER_SCOPES };
}

export function startPeerSync(): void {
  peerHooks.introduce = introduce;
  peerHooks.remove = remove;
  peerHooks.check = check;
  peerHooks.copy = copyOrder;
  peerHooks.view = peerView;
  helloHooks.push((r, h) => {
    // With no pair left a PC that was off must still be told its last one ended, so this never stops on an empty list.
    if (r.role === 'guest' || h.guest || (!intros().length && holdsLatest(r.id))) return;
    void (async () => {
      // A PC no longer linked here as an admin: its pairs end.
      const linked = new Set((d.store.peek()?.remotes ?? []).filter(x => x.role !== 'guest').map(x => x.id));
      const live = intros().filter(x => linked.has(x.from.id) && linked.has(x.to.id));
      // Its addresses as it says them now: the PCs that call it are sent them when they changed.
      const moved = peerlink.moveEnd(live, endOf(r, h));
      if (moved.changed || live.length !== intros().length) return changed(moved.intros);
      if (!holdsLatest(r.id)) await sendPeers(r, h);
    })().catch(() => undefined);
  });
}
