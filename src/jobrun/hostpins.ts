// The main PC's side of the host PIN (src/hostpin.ts): set it here (kept as a hash only), give it to each linked PC
// with that PC's own PIN once, check it before Update all sends it, and take it back. The PIN itself is never written
// down here: the page holds it for one run and sends it with each request.
import * as hostpin from '../hostpin.ts';
import { cleanKind } from '../lock.ts';
import type { Remote } from '../store.ts';
import { d } from './shared.ts';
import { hello, lastHello } from './links.ts';
import { wireFor } from './copies.ts';

let own: Promise<hostpin.OwnHostPin> | null = null;
/** This PC's own host PIN (its hash), read once. */
function ownPin(): Promise<hostpin.OwnHostPin> {
  return (own ??= d.store.readJson<unknown>(hostpin.OWN_FILE, null).then(raw => new hostpin.OwnHostPin(raw, f => d.store.writeJson(hostpin.OWN_FILE, f))).catch(e => {
    own = null;
    throw e;
  }));
}

let keyP: Promise<hostpin.HostKey> | null = null;
/** This PC's host key (src/hostpin.ts HostKey): used only while this PC's app lock is open (or there is none). */
function hostKey(): Promise<hostpin.HostKey> {
  return (keyP ??= d.store.readJson<unknown>(hostpin.KEY_FILE, null).then(raw => new hostpin.HostKey(raw, f => d.store.writeJson(hostpin.KEY_FILE, f), () => !d.appLocked())).catch(e => {
    keyP = null;
    throw e;
  }));
}

/** The linked PCs this PC is the host of (a guest link can never give a host PIN). */
async function hostedPcs(): Promise<Remote[]> {
  return (await d.store.settings()).remotes.filter(r => r.role !== 'guest');
}

const tooMany = (o: hostpin.OwnHostPin) => `Too many wrong tries. Wait ${hostpin.waitWords(o.lockedFor())}, then try again.`;
const wrongOwn = (o: hostpin.OwnHostPin) => (o.lockedFor() ? tooMany(o) : 'That is not the host PIN set on this PC. Type it again.');

/**
 * The PIN typed on this page for one linked PC, as sent to it: that PC's own app lock PIN (`nodePin`), or the host PIN
 * (`hostPin`). A `nodePin` that is this PC's host PIN goes as the host PIN when that PC holds it (`holds`), so either
 * one typed in a PC's window opens it; checked here against the hash, never sent as a guess.
 */
export async function pinTyped(b: Record<string, unknown>, holds: boolean, keyId = ''): Promise<{ hostPin: string } | { appPin: string }> {
  // Nothing typed, and that PC holds this PC's host key (the id it says is the id of the key held now): the key goes in
  // place of a PIN. It is made and kept only while this PC is unlocked; with a shut lock nothing is sent.
  if (keyId && !(typeof b.nodePin === 'string' && b.nodePin) && !(typeof b.hostPin === 'string' && b.hostPin)) {
    const k = (await hostKey().catch(() => null))?.peek();
    if (k && k.id === keyId) return { hostPin: k.secret };
  }
  if (typeof b.nodePin === 'string') {
    const host = holds && b.nodePin ? await (await ownPin()).either(b.nodePin).catch(() => null) : null;
    return host ? { hostPin: host } : { appPin: b.nodePin };
  }
  return typeof b.hostPin === 'string' && b.hostPin ? { hostPin: b.hostPin } : { appPin: '' };
}

/** A linked PC took what was typed as its own PIN: it was no wrong host PIN, so it is not counted as one here. */
export async function ownPinTaken(sent: { hostPin: string } | { appPin: string }, r?: Remote): Promise<void> {
  if ('appPin' in sent && sent.appPin) {
    (await ownPin().catch(() => null))?.eitherTaken();
    // That PC's own PIN was just right: the one time it is typed, the host key goes to it (when this PC makes one).
    if (r) await giveKey(r, sent.appPin).catch(() => undefined);
  }
}

/**
 * Gives one linked PC the host key with its own PIN (proved in the same sealed request), unless it holds this one already
 * or holds a typed host PIN from this PC while one is set here (that is replaced only by `force`, the "give" button).
 * True when the PC holds the key now.
 */
export async function giveKey(r: Remote, nodePin: string, force = false): Promise<boolean> {
  const k = await (await hostKey()).use();
  if (!k || r.role === 'guest') return false;
  const h = lastHello(r.id) ?? (await hello(r, 5000));
  if (!h.can.includes(hostpin.CAN)) return false;
  if (h.hostKey === k.id) return true;
  if (!force && h.hostPin && !h.hostKey && (await ownPin()).on) return false;
  await wireFor(r).ask(hostpin.SET_DOOR, { newPin: k.secret, kind: 'password', keyId: k.id, appPin: nodePin });
  void hello(r, 3000).catch(() => undefined);
  return true;
}

/** The id of the host key that PC holds from this one as it last said ('' when it holds none, or a typed PIN). */
export const keyIdHeld = (r: Remote): string => lastHello(r.id)?.hostKey ?? '';

/** For the Network page: whether a host PIN is set here, and which linked PCs hold it (as each last said). */
export async function hostPinView() {
  const o = await ownPin();
  const pcs = (await hostedPcs()).map(r => {
    const h = lastHello(r.id);
    return { id: r.id, name: r.name, heard: !!h, can: !!h?.can.includes(hostpin.CAN), has: h?.hostPin === true, holdsKey: !!h?.hostKey };
  });
  const k = await hostKey();
  return { on: o.on, kind: o.kind, at: o.at, pcs: pcs.map(p => ({ ...p, keyHeld: !!k.id && lastHello(p.id)?.hostKey === k.id })), key: { on: k.enabled, made: k.made, id: k.id, at: k.at, unlocked: !d.appLocked() } };
}

/** The Network page's host PIN actions: view, set, check, give (to one linked PC), off. */
export async function hostPinOn(b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const o = await ownPin();
  if (b.action === 'view') return { status: 200, body: await hostPinView() };
  // The host key (src/hostpin.ts): no PIN is typed. key-give hands it to one PC with that PC's own PIN (otherwise it goes by
  // itself the first time that PIN is typed for an update, a delete or a turn-off); key-reset makes a new one; key-off stops
  // using one and takes it from the PCs that hold it; key-on allows one again.
  if (typeof b.action === 'string' && b.action.startsWith('key-')) return hostKeyOn(b);
  if (b.action === 'check') {
    if (!o.on) return { status: 409, body: { error: 'No host PIN is set on this PC.' } };
    if (o.lockedFor()) return { status: 429, body: { error: tooMany(o) } };
    return (await o.check(b.pin)) ? { status: 200, body: { ok: true } } : { status: 403, body: { error: wrongOwn(o) } };
  }
  if (b.action === 'set') {
    // A new one, or a change: a change needs the one set now (the linked PCs are then asked to take the new one with it).
    if (o.on) {
      if (o.lockedFor()) return { status: 429, body: { error: tooMany(o) } };
      if (!(await o.check(b.current))) return { status: 403, body: { error: o.lockedFor() ? tooMany(o) : 'Type the host PIN set now in "Host PIN now" to change it.' } };
    }
    const kind = cleanKind(b.kind);
    const secret = hostpin.cleanHostSecret(kind, b.pin);
    if (!secret) return { status: 400, body: { error: hostpin.RULE_WORDS } };
    if (hostpin.cleanHostSecret(kind, b.pin2) !== secret) return { status: 400, body: { error: 'The two host PINs are not the same. Type the new one in both boxes.' } };
    await o.set(kind, secret);
    return { status: 200, body: await hostPinView() };
  }
  if (b.action === 'give') {
    // One linked PC takes the host PIN: proved with that PC's own PIN (`nodePin`), or with the host PIN it holds now from
    // this PC (`oldPin`, when the host PIN is being changed).
    const r = (await hostedPcs()).find(x => x.id === b.pc);
    if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
    if (!o.on) return { status: 409, body: { error: 'Set the host PIN on this PC first.' } };
    if (o.lockedFor()) return { status: 429, body: { error: tooMany(o) } };
    const secret = await o.check(b.hostPin);
    if (!secret) return { status: 403, body: { error: wrongOwn(o) } };
    let h;
    try {
      h = await hello(r, 5000);
    } catch (e) {
      return { status: 502, body: { error: `"${r.name}" could not be reached (${(e as Error).message}).` } };
    }
    if (!h.can.includes(hostpin.CAN)) return { status: 409, body: { error: `"${r.name}" runs TOMLIN ${h.version}, which cannot hold a host PIN: update it first.` } };
    const oldPin = typeof b.oldPin === 'string' && b.oldPin && h.hostPin ? b.oldPin : '';
    const nodePin = typeof b.nodePin === 'string' ? b.nodePin : '';
    if (!oldPin && !nodePin) return { status: 409, body: { error: `Type the app lock PIN of "${r.name}" (the one that opens TOMLIN there) once, so it takes the host PIN.`, needNodePin: true } };
    try {
      const a = await wireFor(r).ask(hostpin.SET_DOOR, { newPin: secret, kind: o.kind, ...(oldPin ? { hostPin: oldPin } : { appPin: nodePin }) });
      // Its next hello says it holds it; asked now so the page shows it at once.
      void hello(r, 3000).catch(() => undefined);
      return { status: 200, body: { said: String(a.said ?? `"${r.name}" holds the host PIN now.`) } };
    } catch (e) {
      const { status, said, data } = e as { status?: number; said?: string; data?: Record<string, unknown> };
      if (data?.needPin === true) return { status: 403, body: { error: said || (e as Error).message, needNodePin: true } };
      return { status: status === 400 || status === 404 || status === 429 ? status : 409, body: { error: said || (e as Error).message } };
    }
  }
  if (b.action === 'off') {
    // Taken away here and on every linked PC that answers (nothing is asked: it only takes away). One that is off keeps
    // it until its owner takes it away there, or this PC sets a host PIN again.
    await o.off();
    const missed: string[] = [];
    // A PC that holds the host key keeps it: turning the typed host PIN off does not take that away (key-off does).
    await Promise.all((await hostedPcs()).filter(r => lastHello(r.id)?.can.includes(hostpin.CAN) && !lastHello(r.id)?.hostKey).map(async r => {
      try {
        await wireFor(r).ask(hostpin.DROP_DOOR, {});
        void hello(r, 3000).catch(() => undefined);
      } catch {
        if (lastHello(r.id)?.hostPin) missed.push(`"${r.name}"`);
      }
    }));
    return { status: 200, body: { ...(await hostPinView()), missed } };
  }
  return { status: 400, body: { error: 'Unknown action.' } };
}

/** The host key's actions: key-give, key-reset, key-off, key-on. */
async function hostKeyOn(b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const k = await hostKey();
  if (d.appLocked()) return { status: 423, body: { error: 'TOMLIN is locked. Open it with its PIN first: the host key works only while this PC is unlocked.' } };
  if (b.action === 'key-on') {
    await k.turnOn();
    return { status: 200, body: await hostPinView() };
  }
  if (b.action === 'key-reset') {
    if (!k.enabled) return { status: 409, body: { error: 'The host key is off. Turn it on first.' } };
    await k.reset();
    return { status: 200, body: await hostPinView() };
  }
  if (b.action === 'key-off') {
    // Taken away from every linked PC that holds one (nothing is asked: it only takes away), then none is made or used.
    const missed: string[] = [];
    await k.turnOff();
    await Promise.all((await hostedPcs()).filter(r => lastHello(r.id)?.hostKey).map(async r => {
      try {
        await wireFor(r).ask(hostpin.DROP_DOOR, {});
        void hello(r, 3000).catch(() => undefined);
      } catch {
        missed.push(`"${r.name}"`);
      }
    }));
    return { status: 200, body: { ...(await hostPinView()), missed } };
  }
  if (b.action === 'key-give') {
    const r = (await hostedPcs()).find(x => x.id === b.pc);
    if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
    if (!k.enabled) return { status: 409, body: { error: 'The host key is off. Turn it on first.' } };
    const nodePin = typeof b.nodePin === 'string' ? b.nodePin : '';
    if (!nodePin) return { status: 409, body: { error: `Type the app lock PIN of "${r.name}" (the one that opens TOMLIN there) once, so it takes the host key.`, needNodePin: true } };
    try {
      await giveKey(r, nodePin, true);
      return { status: 200, body: { said: `"${r.name}" holds the host key now.` } };
    } catch (e) {
      const { status, said, data } = e as { status?: number; said?: string; data?: Record<string, unknown> };
      if (data?.needPin === true) return { status: 403, body: { error: said || (e as Error).message, needNodePin: true } };
      return { status: status === 400 || status === 404 || status === 429 ? status : 409, body: { error: said || (e as Error).message } };
    }
  }
  return { status: 400, body: { error: 'Unknown action.' } };
}
