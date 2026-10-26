// Max mode, this PC's side as a node (src/maxlend.ts says what lending is): the door a linked PC opens a sealed
// stream on (an HTTP Upgrade on the worker port, POST-free: the sealed request rides in a header), and the loan.
import type { IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as carry from '../carry.ts';
import * as maxlend from '../maxlend.ts';
import { newNonce, sealedPipe, streamKeys } from '../linkstream.ts';
import { log } from '../log.ts';
import { d } from './shared.ts';
import { shareState, taken } from './node.ts';

export const MAX_DOOR = '/worker/max-open';
export const MAX_UPGRADE = 'tomlin-max';

const presence = new maxlend.PresenceReader();
let lender: maxlend.Lender | null = null;

const idleMinutes = () => maxlend.cleanLendIdle(shareState.lendIdle);
const facts = () => ({ on: shareState.on, allow: carry.cleanAllow(shareState.allow, maxlend.maxShown()), away: !!shareState.away });

function theLender(): maxlend.Lender {
  lender ??= new maxlend.Lender(maxlend.cacheDirOf(d.store.dir), () => maxlend.loanEnds({ ...facts(), presence: presence.now(), lease: lender?.lease ?? null, paired: shareState.paired }));
  return lender;
}

/** For this PC's Network page: who borrows it now, how the last loan ended, and whether Max mode is shown at all. */
export function lendView() {
  const v = lender?.view() ?? { lease: null, streams: 0, ended: null };
  return { shown: maxlend.maxShown(), idle: idleMinutes(), to: v.lease?.name ?? null, since: v.lease?.since ?? null, streams: v.streams, ended: v.ended };
}

/** For a linked PC's hello: lent to whom now (null: to nobody). */
export const lentTo = () => lender?.lease?.name ?? null;

/** Whether the link with token fingerprint `hash` is the one borrowing this PC's card now. */
export const lendingTo = (hash: string) => lender?.lease?.hash === hash;

/** Ends a loan now (sharing turned off, the worker door closed). */
export const endLoan = (why: string) => lender?.end(why) ?? Promise.resolve();

/** A refusal written on the raw socket (the Upgrade was not taken), as JSON like every other refusal on this door. */
function refuse(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/**
 * A linked PC opens a stream to lend this PC's card: the same checks as every worker request (home network, no web
 * page, a known link, a sealed request on this door, in time, not seen before), then the loan's own (src/maxlend.ts
 * lendWhy). The answer carries this side's nonce, sealed; from then on the socket is the sealed stream.
 */
export async function maxUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  try {
    const ip = req.socket.remoteAddress ?? '';
    if (!share.isPrivateAddress(ip)) return refuse(socket, 403, 'This worker only answers PCs on its own home network.');
    if (req.headers.origin) return refuse(socket, 403, 'Web pages cannot use this worker.');
    if (new URL(req.url ?? '/', 'http://worker').pathname !== MAX_DOOR || String(req.headers.upgrade).toLowerCase() !== MAX_UPGRADE) return refuse(socket, 404, 'There is no such door here.');
    const named = /^Link ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const who = share.pairedByHash(shareState, named);
    if (!who) return refuse(socket, 401, 'that PC no longer knows this one (it was removed there, or set up again)');
    const keys = link.keysOf(who.key);
    if (!keys) return refuse(socket, 401, 'this link was made before links were encrypted. Link this PC again from the main PC.');
    const opened = link.openRequest(keys, { box: String(req.headers['x-link'] ?? '') }, MAX_DOOR, taken);
    if ('error' in opened) return refuse(socket, 400, opened.error);
    const hostNonce = Buffer.from(String(opened.body.nonce ?? ''), 'base64url');
    if (hostNonce.length !== 16) return refuse(socket, 400, 'a Max mode request was not in the expected form.');
    const l = theLender();
    // The reader starts at the first ask: a second or two for its first reading.
    const p = presence.now() ?? (await presence.first());
    const why = maxlend.lendWhy({ pc: shareState.name, ...facts(), shown: maxlend.maxShown(), presence: p, idleMinutes: idleMinutes(), lease: l.lease, by: who });
    if (why) return refuse(socket, 409, why);
    let port: number;
    try {
      port = await l.open({ hash: who.hash, name: who.name }, d.rpcProgram?.() ?? null);
    } catch (e) {
      return refuse(socket, 409, `"${shareState.name}" cannot lend now: ${(e as Error).message}.`);
    }
    const rpc: Socket = connect(port, '127.0.0.1');
    const ok = await new Promise<boolean>(r => {
      rpc.once('connect', () => r(true));
      rpc.once('error', () => r(false));
    });
    if (!ok || socket.destroyed) {
      rpc.destroy();
      return refuse(socket, 503, `"${shareState.name}" started lending, but its RPC server did not answer.`);
    }
    const nodeNonce = newNonce();
    const answer = link.sealAnswer(keys, opened.id, 0, { nonce: nodeNonce.toString('base64url') });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${MAX_UPGRADE}\r\nconnection: Upgrade\r\nx-link: ${answer}\r\n\r\n`);
    l.track(socket);
    void sealedPipe(rpc, socket, streamKeys(keys, hostNonce, nodeNonce, 'node'), 'node', { head }).then(ended => {
      l.untrack(socket);
      if (ended) log.info('max', `A stream from "${who.name}" ended: ${ended}`);
    });
  } catch (e) {
    refuse(socket, 500, `Max mode failed here: ${(e as Error).message}`);
  }
}
