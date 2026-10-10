// F7 E5, on a node: it gives way to its owner at a button, never by itself. "I need to use the pc" (or the main PC's
// yes to it) stops new work and unloads the models once the work running finishes; started again, they load again.
import * as share from '../share.ts';
import { d, sleep } from './shared.ts';
import { drawing, saveShare, serving, shareLoaded, shareState } from './node.ts';

/**
 * Someone at this PC pressed "I need to use the pc" (the lock screen's button) (the lock screen, no PIN):
 * no new work from now; a step already running finishes; then every model here is unloaded. The main PC reads it
 * in the next hello ("I need to log off for now") and sends the work elsewhere.
 */
export async function goAway(until?: string): Promise<{ ok: true } | { error: string }> {
  await shareLoaded;
  if (!shareState.on) return { error: 'This PC is not a node, so there is nothing to stop.' };
  if (!shareState.away) {
    const image = d.imagePane.view;
    shareState.away = { since: new Date().toISOString(), held: { chat: d.loadedChats(), image: image.state === 'connected' ? image.model : null }, ...(until ? { until } : {}) };
    await saveShare();
  } else if (until) {
    shareState.away.until = until;
    await saveShare();
  }
  void dropWhenFree();
  return { ok: true };
}

/** The main PC answered the request sent from the lock screen. Only the request still waiting is answered (named by when it was sent). */
export async function askAnswered(b: Record<string, unknown>, by: string): Promise<{ status: number; body: unknown }> {
  const a = shareState.ask;
  if (!a || a.at !== b.at) return { status: 409, body: { error: `that request is no longer waiting on ${shareState.name} (a newer one was sent, or it was answered).` } };
  if (a.answer) return { status: 409, body: { error: `that request was answered already (${a.answer === 'yes' ? 'logged out' : 'not now'}, by ${a.by ?? 'a linked PC'}).` } };
  const yes = b.yes === true;
  shareState.ask = { ...a, answer: yes ? 'yes' : 'no', by: String(by).slice(0, 40), answeredAt: new Date().toISOString() };
  if (!yes) {
    await saveShare();
    return { status: 200, body: { text: `"${shareState.name}" was told: not now.` } };
  }
  const until = share.askUntil(a.hours);
  const r = await goAway(until);
  if ('error' in r) return { status: 409, body: r };
  return { status: 200, body: { text: `"${shareState.name}" is logged out until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: no new work goes there, and its models are unloaded once the work running there finishes. It starts again by itself then.` } };
}

/** The unload under way after "I need to use the pc": "start it again" waits for it before loading anything. */
let dropping: Promise<void> | null = null;
function dropWhenFree(): Promise<void> {
  dropping ??= (async () => {
    // The step already running finishes first (a chat answer, a job step, a picture).
    while (shareState.away && (d.busy() || drawing || serving.size)) await sleep(2000);
    // Started again part-way: what is still loaded stays loaded.
    if (shareState.away) await d.unloadAll(() => !!shareState.away);
  })().finally(() => { dropping = null; });
  return dropping;
}

/**
 * The main PC (or this PC's owner, with the PIN) starts it again. Within an hour of the press the main PC asks first
 * ("Confirm"); after an hour it just starts. The models that were loaded at the press load again.
 */
export async function comeBack(confirm: boolean, by: string): Promise<{ status: number; body: unknown }> {
  const a = shareState.away;
  if (!a) return { status: 200, body: { text: `${shareState.name} is working already.` } };
  const minutes = Math.floor((Date.now() - Date.parse(a.since)) / 60_000);
  if (minutes < 60 && !confirm) return { status: 409, body: { needConfirm: true, error: `someone at ${shareState.name} pressed "I need to use the pc" ${minutes < 1 ? 'less than a minute' : `${minutes} minute${minutes > 1 ? 's' : ''}`} ago. Start it again anyway? (After an hour it starts without asking.)` } };
  shareState.away = null;
  // The request that logged it out is done with: the lock screen no longer shows its answer.
  if (shareState.ask?.answer) shareState.ask = null;
  await saveShare();
  void loadAgain(a.held);
  const what = [...a.held.chat, ...(a.held.image ? [a.held.image] : [])].length;
  return { status: 200, body: { text: `${shareState.name} is working again${what ? ', loading its models' : ''} (started by ${by}).` } };
}

async function loadAgain(held: { chat: string[]; image: string | null }): Promise<void> {
  // An unload still running (pressed a moment ago) ends first, so what it already took out loads again here.
  if (dropping) await dropping.catch(() => undefined);
  const s = await d.store.settings();
  for (const id of held.chat) {
    if (shareState.away || !d.chatList().some(m => m.id === id) || d.runnerFor(id)) continue;
    const got = await d.connectChat(id, s.chat.asked, s.chat.threads).catch(() => null);
    // One at a time: the next waits until this one has loaded (or failed), so they do not fight for memory.
    if (got && 'runner' in got) for (let i = 0; i < 1500 && got.runner.view.state === 'loading'; i++) await sleep(400);
  }
  if (held.image && !shareState.away && d.imagePane.view.state !== 'connected') await d.connectImage(held.image).catch(() => false);
}
