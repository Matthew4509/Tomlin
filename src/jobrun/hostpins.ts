// The admin PC's side of its key (src/hostpin.ts HostKey): given to each linked PC once, with that PC's own PIN, and sent
// in place of a PIN while this PC is unlocked, so an unlocked admin PC updates, turns off or deletes models on the PCs
// linked to it with no PIN typed. Since 2.1.31 there is no typed host PIN to set here and no switch to turn the key off;
// a linked PC that holds neither asks its own PIN once, and then takes the key.
import * as hostpin from '../hostpin.ts';
import type { Remote } from '../store.ts';
import { d } from './shared.ts';
import { hello, lastHello } from './links.ts';
import { wireFor } from './copies.ts';

let keyP: Promise<hostpin.HostKey> | null = null;
/**
 * This PC's admin key (src/hostpin.ts HostKey): used only while this PC's app lock is set and open. With no app lock there
 * is no unlocked state, so anyone at this PC could use it: none is used until a PIN is set.
 */
function hostKey(): Promise<hostpin.HostKey> {
  return (keyP ??= d.store.readJson<unknown>(hostpin.KEY_FILE, null).then(raw => new hostpin.HostKey(raw, f => d.store.writeJson(hostpin.KEY_FILE, f), () => d.appLockOn() && !d.appLocked())).catch(e => {
    keyP = null;
    throw e;
  }));
}

/** The linked PCs this PC is the admin of (a guest link can never take the key). */
async function hostedPcs(): Promise<Remote[]> {
  return (await d.store.settings()).remotes.filter(r => r.role !== 'guest');
}

/**
 * What goes to one linked PC for an update, a turn-off, a delete or a permission change: this PC's key when nothing was
 * typed and that PC holds this key (`keyId`, the id it says it holds), else the PIN typed on this page for that PC
 * (`nodePin`), sent as that PC's own app lock PIN. `_holds` is kept for the callers' shape (it said a typed host PIN was held).
 */
export async function pinTyped(b: Record<string, unknown>, _holds: boolean, keyId = ''): Promise<{ hostPin: string } | { appPin: string }> {
  const typed = typeof b.nodePin === 'string' && b.nodePin ? b.nodePin : '';
  // Made and kept only while this PC is unlocked; with a shut lock nothing is sent.
  if (keyId && !typed) {
    const k = (await hostKey().catch(() => null))?.peek();
    if (k && k.id === keyId) return { hostPin: k.secret };
  }
  return { appPin: typed };
}

/** A linked PC took what was typed as its own PIN: the one time it is typed, the key goes to it. */
export async function ownPinTaken(sent: { hostPin: string } | { appPin: string }, r?: Remote): Promise<void> {
  // Asked fresh: its owner may have taken the key away since its last hello, and the PIN was typed for that reason.
  if ('appPin' in sent && sent.appPin && r) await giveKey(r, sent.appPin, true).catch(() => undefined);
}

/**
 * Gives one linked PC this PC's key with its own PIN (proved in the same sealed request), unless it holds this one already.
 * It takes the place of a typed host PIN an older version of this PC gave it. True when the PC holds the key now.
 */
export async function giveKey(r: Remote, nodePin: string, fresh = false): Promise<boolean> {
  const k = await (await hostKey()).use();
  if (!k || r.role === 'guest') return false;
  // `fresh`: what that PC holds is asked now, not taken from its last hello (which may be up to 30 s old).
  const h = (fresh ? null : lastHello(r.id)) ?? (await hello(r, 5000));
  if (!h.can.includes(hostpin.CAN)) return false;
  if (h.hostKey === k.id) return true;
  await wireFor(r).ask(hostpin.SET_DOOR, { newPin: k.secret, kind: 'password', keyId: k.id, appPin: nodePin });
  void hello(r, 3000).catch(() => undefined);
  return true;
}

/** The id of the key that PC holds from this one as it last said ('' when it holds none, or an old typed PIN). */
export const keyIdHeld = (r: Remote): string => lastHello(r.id)?.hostKey ?? '';

/** For the Network page's Admin PC row: the key, and which linked PCs hold it (as each last said). */
export async function hostPinView() {
  const k = await hostKey();
  const pcs = (await hostedPcs()).map(r => {
    const h = lastHello(r.id);
    return { id: r.id, name: r.name, heard: !!h, can: !!h?.can.includes(hostpin.CAN), keyHeld: !!k.id && h?.hostKey === k.id };
  });
  return { pcs, key: { made: k.made, id: k.id, at: k.at, unlocked: !d.appLocked(), lock: d.appLockOn(), wasOff: k.wasOff } };
}

/**
 * The Network page's Admin PC actions: view; key-reset (a new key: each PC takes it the next time its own PIN is typed
 * here); key-give (to one PC with that PC's own PIN; otherwise it goes by itself the first time that PIN is typed).
 */
export async function hostPinOn(b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  if (b.action === 'view') return { status: 200, body: await hostPinView() };
  if (b.action !== 'key-reset' && b.action !== 'key-give') return { status: 400, body: { error: 'Unknown action.' } };
  const k = await hostKey();
  if (d.appLocked()) return { status: 423, body: { error: 'TOMLIN is locked. Open it with its PIN first: the admin key works only while this PC is unlocked.' } };
  if (!d.appLockOn()) return { status: 409, body: { error: 'The admin PC needs an app lock: set a PIN first (Settings, Data and lock).', needAppLock: true } };
  if (b.action === 'key-reset') {
    await k.reset();
    return { status: 200, body: await hostPinView() };
  }
  const r = (await hostedPcs()).find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  const nodePin = typeof b.nodePin === 'string' ? b.nodePin : '';
  if (!nodePin) return { status: 409, body: { error: `Type the app lock PIN of "${r.name}" (the one that opens TOMLIN there) once, so it takes this PC's admin key.`, needNodePin: true } };
  try {
    if (!(await giveKey(r, nodePin, true))) return { status: 409, body: { error: `"${r.name}" cannot hold an admin key: its TOMLIN is too old for one (update it first), or it is linked as a guest.` } };
    return { status: 200, body: { said: `"${r.name}" holds this PC's admin key now.` } };
  } catch (e) {
    const { status, said, data } = e as { status?: number; said?: string; data?: Record<string, unknown> };
    if (data?.needPin === true) return { status: 403, body: { error: said || (e as Error).message, needNodePin: true } };
    return { status: status === 400 || status === 404 || status === 429 ? status : 409, body: { error: said || (e as Error).message } };
  }
}
