// This PC calls a PC its host introduced it to (src/peerlink.ts), directly, with no host in the middle: a sealed request
// to that PC's own link door, named by the peer token's fingerprint and sealed with the peer keys (this PC plays the
// part the host plays on a link). The other PC's addresses came from the host; each is tried, home-network ones only,
// and the one that answered is tried first the next time. Only the ping is carried so far.
import * as link from '../link.ts';
import { PEER_HELLO, type PeerOut } from '../peerlink.ts';
import * as share from '../share.ts';

/** The address that last answered for each peer (by the peer record's id). */
export const lastGood = new Map<string, string>();

export interface PeerAnswer {
  status: number;
  data: Record<string, unknown>;
  /** The address that answered. */
  address: string;
  ms: number;
}
export interface PeerMiss {
  /** Each address tried, and what happened there. */
  tried: { address: string; said: string }[];
}

/** One sealed request to peer `peer`: the first of its addresses that answers, or what each said. */
export async function peerFetch(peer: PeerOut, path: string, payload: unknown, ms = 4000): Promise<PeerAnswer | PeerMiss> {
  const keys = link.keysOf(peer.key);
  if (peer.revoked || !keys || !peer.token) return { tried: [{ address: '', said: 'this PC is no longer introduced to that PC' }] };
  const first = lastGood.get(peer.id);
  const addrs = [...new Set([...(first && peer.addrs.includes(first) ? [first] : []), ...peer.addrs])];
  if (!addrs.length) return { tried: [{ address: '', said: 'the host gave no home-network address for that PC' }] };
  const tried: PeerMiss['tried'] = [];
  for (const address of addrs) {
    // Never outside the home network, whatever the list says.
    if (!share.isPrivateAddress(address)) {
      tried.push({ address, said: 'not an address on the home network' });
      continue;
    }
    // Sealed anew for each address: a request is taken once only.
    const where = `http://${address.includes(':') ? `[${address}]` : address}:${peer.port}`;
    const req = link.sealRequest(keys, path, payload, link.nodeNow(where));
    const id = link.requestId(req.box);
    const began = Date.now();
    try {
      const res = await fetch(`${where}${path}`, { method: 'POST', headers: { authorization: `Link ${share.hashToken(peer.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(req), signal: AbortSignal.timeout(ms) });
      link.noteClock(where, res.headers.get('date'));
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      let data = raw;
      if (typeof raw.box === 'string') data = link.openAnswer(keys, id, 0, raw.box) as Record<string, unknown>;
      // Only a refusal may come back unsealed (made before the peer was checked): any other such answer is not used.
      else if (res.ok) {
        tried.push({ address, said: 'answered without the encrypted link, so the answer was not used' });
        continue;
      }
      lastGood.set(peer.id, address);
      return { status: res.status, data: data && typeof data === 'object' ? data : {}, address, ms: Date.now() - began };
    } catch (e) {
      tried.push({ address, said: (e as Error)?.name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached' });
    }
  }
  return { tried };
}

/** Whether this PC reaches peer `peer` now: on which address and how fast, or why not. */
export async function peerPing(peer: PeerOut): Promise<{ ok: boolean; name: string; address?: string; ms?: number; said?: string; tried?: PeerMiss['tried'] }> {
  const r = await peerFetch(peer, PEER_HELLO, {});
  if ('tried' in r) return { ok: false, name: peer.name, said: `cannot reach "${peer.name}" on any address: tried ${r.tried.map(t => t.address || 'none').join(' and ')}`, tried: r.tried };
  if (r.status !== 200) return { ok: false, name: peer.name, address: r.address, said: `"${peer.name}" said: ${String(r.data.error ?? `no (${r.status})`)}` };
  return { ok: true, name: String(r.data.name ?? peer.name), address: r.address, ms: r.ms };
}
