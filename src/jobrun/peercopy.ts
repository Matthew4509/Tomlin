// A model copied straight from one PC to another (src/peerlink.ts, scope "copy"), with no host in the middle: the host
// only orders it, and follows it. This PC (the target) pulls the model from its peer (the source) with the same carry
// code a copy from a linked PC uses (src/carry.ts pull), over a peer's wire (src/jobrun/peerwire.ts): in pieces, each
// sealed, written to a .part file here, carried on from where it stopped. The source answers the read doors only, and
// only for a model it shares (its "Sharing of models" tick). When the last byte is in, both PCs hash the file in ranges
// and it is used only when every range matches. The copy lives here: if the host goes away, it goes on.
import * as carry from '../carry.ts';
import { destFor } from './copies.ts';
import { peerWire } from './peerwire.ts';
import { shareState } from './node.ts';
import { d } from './shared.ts';

const transfers = new carry.Transfers();
const GBs = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

type Done = { status: number; body: Record<string, unknown> };

/** The copy asked for this peer, running or the last: for the host's page. */
const latest = (pc: string) => transfers.view().find(t => t.pc === pc) ?? null;

/** The host's order at /worker/peer-copy: `start` a copy of model `model` from the peer `pc`, or ask its `state`, or `stop` it. */
export async function peerCopy(b: Record<string, unknown>, away: boolean): Promise<Done> {
  const pc = String(b.pc ?? '');
  const out = (shareState.peers?.out ?? []).find(x => x.pc === pc && !x.revoked);
  if (b.action === 'state') return { status: 200, body: { transfer: latest(pc) } };
  if (b.action === 'stop') {
    const t = latest(pc);
    return { status: 200, body: { stopped: !!t && t.state === 'working' && transfers.stop(t.id) } };
  }
  if (b.action !== undefined && b.action !== 'start') return { status: 400, body: { error: 'that order is not one this PC knows.' } };
  if (!out) return { status: 404, body: { error: 'this PC has not been introduced to that PC.' } };
  if (!out.scopes.includes('copy')) return { status: 403, body: { error: `this PC is not allowed to copy models from "${out.name}" directly (the host did not give that pair "copy").` } };
  if (!carry.cleanAllow(shareState.allow).receive) return { status: 403, body: { error: `${carry.receiveRefused(shareState.name)}.` } };
  if (away) return { status: 503, body: { error: `${shareState.name} is being used by its owner for now. Try again later.` } };
  const kind = b.kind === 'image' ? 'image' : 'chat';
  const model = typeof b.model === 'string' ? b.model.slice(0, 300) : '';
  if (!model) return { status: 400, body: { error: 'no model was named.' } };
  const what = String(b.name ?? model).replace(/[^\w .()'-]/g, '').trim().slice(0, 120) || 'a model';
  const w = peerWire(out);
  const t = transfers.start({ kind: 'copy', what, pc: out.pc, pcName: out.name }, async (progress, signal) => {
    const got = await carry.pull(w, { kind, model, dest: destFor(kind, model, out.name), progress, signal });
    // Proved against the source's own file before it is used: both PCs hash the same ranges.
    const why = await carry.verifyPulled(w, { kind, model, paths: got.files, progress, signal });
    if (why) throw new Error(`the copy from "${out.name}" did not check out (${why}). Delete it here and copy it again.`);
    d.carry.onInstalled();
    const bytes = (await Promise.all(got.files.map(f => carry.sizeOf(f)))).reduce((n, x) => n + x, 0);
    return `${what} is on this PC now (${GBs(bytes)}), copied straight from "${out.name}" and checked against its file.`;
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}
