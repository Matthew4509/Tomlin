// How this PC talks to a peer for a copy: the same shape as a link's (src/jobrun/copies.ts wireFor), so the same carry
// code runs over it. Sealed requests with the peer keys; a piece comes back as sealed bytes. Each try goes down the
// peer's addresses (the one that answered last first); the network dropping for a moment is tried again twice. Only
// reading is carried: a piece is never sent to a peer.
import * as carry from '../carry.ts';
import * as link from '../link.ts';
import type { PeerOut } from '../peerlink.ts';
import * as share from '../share.ts';
import { lastGood } from './peercall.ts';
import { sleep } from './shared.ts';

export function peerWire(peer: PeerOut): carry.Wire {
  const keys = link.keysOf(peer.key);
  if (peer.revoked || !keys || !peer.token) throw new Error(`this PC is no longer introduced to "${peer.name}".`);
  const call = async (path: string, body: Record<string, unknown>) => {
    const stop = carry.transferStop.getStore();
    let tries = 0;
    for (;;) {
      if (stop?.aborted) throw new Error('Stopped.');
      const first = lastGood.get(peer.id);
      const addrs = [...new Set([...(first && peer.addrs.includes(first) ? [first] : []), ...peer.addrs])].filter(a => share.isPrivateAddress(a));
      if (!addrs.length) throw new Error(`the host gave no home-network address for "${peer.name}".`);
      for (const address of addrs) {
        // Sealed afresh for each try: a node takes each sealed request once, so a resend of the same one is refused.
        const where = `http://${address.includes(':') ? `[${address}]` : address}:${peer.port}`;
        const req = link.sealRequest(keys, path, body, link.nodeNow(where));
        const id = link.requestId(req.box);
        try {
          const res = await fetch(`${where}${path}`, { method: 'POST', headers: { authorization: `Link ${share.hashToken(peer.token)}`, 'content-type': 'application/json' }, body: JSON.stringify(req), signal: stop ? AbortSignal.any([stop, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) });
          link.noteClock(where, res.headers.get('date'));
          lastGood.set(peer.id, address);
          return { res, id };
        } catch {
          if (stop?.aborted) throw new Error('Stopped.');
        }
      }
      if (++tries > 2) throw new Error(`"${peer.name}" could not be reached directly on ${addrs.join(' or ')}. Press it again to carry on from where it stopped.`);
      await sleep(3000);
    }
  };
  const said = async (res: Response, id: string): Promise<Record<string, unknown>> => {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Only a refusal may come back unsealed (made before the peer was checked): any other such answer is not used.
    if (typeof data.box !== 'string' && res.ok) throw new Error(`"${peer.name}" answered without the encrypted link, so the answer was not used.`);
    const v = (typeof data.box === 'string' ? link.openAnswer(keys, id, 0, data.box) : data) as Record<string, unknown>;
    return v && typeof v === 'object' ? v : {};
  };
  const fault = (v: Record<string, unknown>, status: number) => Object.assign(new Error(`"${peer.name}": ${String(v.error ?? `it answered ${status}`)}`), { status, said: String(v.error ?? ''), data: v });
  return {
    async ask(path, body) {
      const { res, id } = await call(path, body);
      const v = await said(res, id);
      if (!res.ok) throw fault(v, res.status);
      return v;
    },
    async getPiece(path, body) {
      const { res, id } = await call(path, body);
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('application/octet-stream')) throw fault(await said(res, id), res.status);
      const piece = link.openBytes(link.toHost(keys), Buffer.from(await res.arrayBuffer()), `piece|${id}`);
      if (!piece) throw new Error(`a piece from "${peer.name}" could not be opened (changed on the way), so it was refused. Press it again to carry on.`);
      return piece;
    },
    async putPiece() {
      throw new Error('a peer is only read from: nothing is sent to it.');
    },
  };
}
