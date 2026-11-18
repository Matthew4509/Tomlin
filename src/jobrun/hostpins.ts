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
export async function pinTyped(b: Record<string, unknown>, holds: boolean): Promise<{ hostPin: string } | { appPin: string }> {
  if (typeof b.nodePin === 'string') {
    const host = holds && b.nodePin ? await (await ownPin()).either(b.nodePin).catch(() => null) : null;
    return host ? { hostPin: host } : { appPin: b.nodePin };
  }
  return typeof b.hostPin === 'string' && b.hostPin ? { hostPin: b.hostPin } : { appPin: '' };
}

/** A linked PC took what was typed as its own PIN: it was no wrong host PIN, so it is not counted as one here. */
export async function ownPinTaken(sent: { hostPin: string } | { appPin: string }): Promise<void> {
  if ('appPin' in sent && sent.appPin) (await ownPin().catch(() => null))?.eitherTaken();
}

/** For the Network page: whether a host PIN is set here, and which linked PCs hold it (as each last said). */
export async function hostPinView() {
  const o = await ownPin();
  const pcs = (await hostedPcs()).map(r => {
    const h = lastHello(r.id);
    return { id: r.id, name: r.name, heard: !!h, can: !!h?.can.includes(hostpin.CAN), has: h?.hostPin === true };
  });
  return { on: o.on, kind: o.kind, at: o.at, pcs };
}

/** The Network page's host PIN actions: view, set, check, give (to one linked PC), off. */
export async function hostPinOn(b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const o = await ownPin();
  if (b.action === 'view') return { status: 200, body: await hostPinView() };
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
    await Promise.all((await hostedPcs()).filter(r => lastHello(r.id)?.can.includes(hostpin.CAN)).map(async r => {
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
