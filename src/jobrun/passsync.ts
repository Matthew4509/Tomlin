// This PC as a host: its guest passes copied to every node it is linked to, a backup node too, over the sealed link
// (src/guestpass.ts syncSet; the node takes them with mergeFrom at /worker/passes-put). Sent when a pass is made or
// removed, and again after any hello from a node that does not hold the latest generation yet, so a removal reaches a
// node that was off once it is back. Only the key a code is proven with crosses, never the code. The Network page is
// told which nodes hold the latest, which are behind, and why.
import * as guestpass from '../guestpass.ts';
import type { Remote } from '../store.ts';
import type { Hello } from '../jobrun.ts';
import { helloHooks, seen, workerPost } from './links.ts';
import { passHooks, saveShare, shareState } from './node.ts';
import { d } from './shared.ts';

type Sync = 'latest' | 'behind' | 'off' | 'old' | 'refused';
/** How each node stood at the last try (by its id), for the page. */
const standing = new Map<string, { sync: Sync; said: string; at: number }>();
/** A send on its way to a node: a second one waits for it. */
const sending = new Map<string, Promise<void>>();

const holdsLatest = (id: string) => (shareState.passGen ?? 0) === 0 || shareState.passAcks?.[id] === shareState.passGen;

/** Sends node `r` this PC's passes for it, unless it holds the latest already (or runs a TOMLIN without passes). */
export function sendPasses(r: Remote, h?: Hello): Promise<void> {
  const busy = sending.get(r.id);
  if (busy) return busy;
  const p = sendNow(r, h).finally(() => sending.delete(r.id));
  sending.set(r.id, p);
  return p;
}

async function sendNow(r: Remote, h?: Hello): Promise<void> {
  // This PC is a guest there (L7): it makes no passes for that PC, and does not ask again.
  if (r.role === 'guest' || h?.guest) return void standing.delete(r.id);
  if (holdsLatest(r.id)) return void standing.set(r.id, { sync: 'latest', said: '', at: Date.now() });
  const hello = h ?? seen.get(r.id);
  if (hello && !hello.can.includes('passes')) return void standing.set(r.id, { sync: 'old', said: `runs an older TOMLIN (${hello.version}): update it there to hold guest passes`, at: Date.now() });
  const gen = shareState.passGen!;
  try {
    const res = await workerPost(r, '/worker/passes-put', { gen, passes: guestpass.syncSet(shareState.passes, r.id) }, AbortSignal.timeout(8000));
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return void standing.set(r.id, { sync: 'refused', said: `said: ${String(data.error ?? `no (${res.status})`)}`, at: Date.now() });
    if (data.stale === true) return void standing.set(r.id, { sync: 'refused', said: 'holds newer passes from this PC than this PC has (was this PC put back from a backup?)', at: Date.now() });
    if (Number(data.gen) !== gen) return void standing.set(r.id, { sync: 'behind', said: 'did not say it took them; sent again at its next hello', at: Date.now() });
    shareState.passAcks = { ...shareState.passAcks, [r.id]: gen };
    await saveShare();
    // Changed again while this was on its way: the newer set goes now (each round acknowledges a newer generation).
    if (!holdsLatest(r.id)) return sendNow(r, h);
    standing.set(r.id, { sync: 'latest', said: '', at: Date.now() });
  } catch {
    standing.set(r.id, { sync: 'off', said: 'is not answering; it gets the passes when it is back', at: Date.now() });
  }
}

/** Sends every linked node its passes now (a pass was made or removed here). */
export async function sendAll(): Promise<void> {
  const remotes = (await d.store.settings()).remotes.filter(r => r.role !== 'guest');
  await Promise.all(remotes.map(r => sendPasses(r)));
}

/**
 * Each PC a pass can be for, for the page: this PC when it is a node, then each linked node, with its models (as it
 * last said) and whether it holds the latest passes.
 */
export function passNodes() {
  // A PC this one is a guest on is not one it makes passes for.
  const remotes = (d.store.peek()?.remotes ?? []).filter(r => r.role !== 'guest');
  const self = shareState.on ? [{ id: shareState.id, name: shareState.name, self: true, sync: 'latest' as Sync, said: '', models: null }] : [];
  return [...self, ...remotes.map(r => {
    const s = holdsLatest(r.id) ? { sync: 'latest' as Sync, said: '' } : standing.get(r.id) ?? { sync: 'behind' as Sync, said: 'not sent yet; it gets them at its next hello' };
    return { id: r.id, name: r.name, self: false, sync: s.sync, said: s.said, models: (r.models ?? []).map(m => ({ id: m.id, name: m.name, kind: m.kind })) };
  })];
}

/** Requests from guests on passes made here, as each node's last hello listed them (by node id). */
const asksFrom = new Map<string, NonNullable<Hello['passAsks']>>();

/** The requests waiting for this PC's answer, for its Network page. */
export function passAsks() {
  const remotes = d.store.peek()?.remotes ?? [];
  return [...asksFrom].flatMap(([pc, list]) => list.map(a => ({ pc, pcName: remotes.find(r => r.id === pc)?.name ?? 'a PC no longer linked', ...a, defaultLength: shareState.passLastLength ?? 'week' })));
}

/** This PC's answer to a request on node `pc`, sent to that node (it renews the same link, denies or blocks it). */
async function answerOn(pc: string, a: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = (await d.store.settings()).remotes.find(x => x.id === pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  try {
    const res = await workerPost(r, '/worker/pass-answer', { id: a.id, answer: a.answer, length: a.length, reason: a.reason }, AbortSignal.timeout(8000));
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { status: res.status === 404 ? 404 : 409, body: { error: `"${r.name}" said: ${String(data.error ?? `no (${res.status})`)}` } };
    asksFrom.set(pc, (asksFrom.get(pc) ?? []).filter(x => x.id !== a.id));
    return { status: 200, body: { passId: data.passId, name: data.name, until: data.until ?? null, pcName: r.name } };
  } catch {
    return { status: 502, body: { error: `"${r.name}" is not answering now, so the request was not answered. It waits there: answer it when that PC is on.` } };
  }
}

export function startPassSync(): void {
  passHooks.changed = () => void sendAll().catch(() => undefined);
  passHooks.nodes = passNodes;
  passHooks.asks = passAsks;
  passHooks.answer = answerOn;
  helloHooks.push((r, h) => {
    // Requests waiting there for this PC: kept for the page, and each new one told once.
    const was = asksFrom.get(r.id) ?? [];
    const now = h.passAsks ?? [];
    for (const a of now) if (!was.some(x => x.id === a.id)) d.onPassAsk?.(r.name, a.name);
    if (now.length) asksFrom.set(r.id, now);
    else asksFrom.delete(r.id);
    if (!holdsLatest(r.id)) void sendPasses(r, h).catch(() => undefined);
  });
}
