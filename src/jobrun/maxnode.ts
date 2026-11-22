// Max mode, this PC's side as a node (src/maxlend.ts says what lending is): the door a linked PC opens a sealed
// stream on (an HTTP Upgrade on the worker port, POST-free: the sealed request rides in a header), and the loan.
import type { IncomingMessage } from 'node:http';
import { freemem, totalmem } from 'node:os';
import type { Duplex } from 'node:stream';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as guestpass from '../guestpass.ts';
import * as carry from '../carry.ts';
import * as maxlend from '../maxlend.ts';
import { newNonce, plainPipe, sealedPipe, streamKeys } from '../linkstream.ts';
import { log } from '../log.ts';
import { loanEndWords } from '../runnerexit.ts';
import { d } from './shared.ts';
import { shareState, taken } from './node.ts';
import { keepWireAlive } from './maxhost.ts';

export const MAX_DOOR = '/worker/max-open';
export const MAX_UPGRADE = 'tomlin-max';

const presence = new maxlend.PresenceReader();
let lender: maxlend.Lender | null = null;

const idleMinutes = () => maxlend.cleanLendIdle(shareState.lendIdle);
const facts = () => ({ on: shareState.on, allow: carry.cleanAllow(shareState.allow), away: !!shareState.away });

function theLender(): maxlend.Lender {
  // The lease is still there when onEnd is called: its start gives how long the loan (and its RPC server) ran.
  lender ??= new maxlend.Lender(maxlend.cacheDirOf(d.store.dir), () => maxlend.loanEnds({ ...facts(), presence: presence.now(), lease: lender?.lease ?? null, paired: shareState.paired }), e => log.info('max', loanEndWords(e, lender?.lease?.since)), { read: () => ({ total: totalmem(), free: freemem() }), say: line => log.info('max', line) });
  return lender;
}

/** For this PC's Network page: who borrows it now, how the last loan ended. */
export function lendView() {
  const v = lender?.view() ?? { lease: null, streams: 0, ended: null };
  return { idle: idleMinutes(), to: v.lease?.name ?? null, since: v.lease?.since ?? null, streams: v.streams, ended: v.ended };
}

/** For the update door: why it must wait while this PC lends (null when it lends to nobody). */
export const loanBusyNow = () => maxlend.loanBusy(lender?.lease ?? null);

/** For this PC's hello (memory.low): lending now with free RAM under the 4 GB it aims to keep. Never ends a loan. */
export const memoryLow = () => lender?.memory.low === true;

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
  // Each refusal goes in this PC's log too: the PC asking sees only the words, and this one is where they are checked.
  let from = '';
  const no = (status: number, error: string) => {
    log.info('max', `Did not lend (${from}): ${error}`);
    refuse(socket, status, error);
  };
  try {
    const ip = req.socket.remoteAddress ?? '';
    from = ip;
    if (!share.isPrivateAddress(ip)) return no(403, 'This worker only answers PCs on its own home network.');
    if (req.headers.origin) return no(403, 'Web pages cannot use this worker.');
    if (new URL(req.url ?? '/', 'http://worker').pathname !== MAX_DOOR || String(req.headers.upgrade).toLowerCase() !== MAX_UPGRADE) return no(404, 'There is no such door here.');
    const named = /^Link ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const who = share.pairedByHash(shareState, named);
    if (!who) return no(401, 'that PC no longer knows this one (it was removed there, or set up again)');
    from = `"${who.name}", ${ip}`;
    const keys = link.keysOf(who.key);
    if (!keys) return no(401, 'this link was made before links were encrypted. Link this PC again from the main PC.');
    const opened = link.openRequest(keys, { box: String(req.headers['x-link'] ?? '') }, MAX_DOOR, taken);
    if ('error' in opened) return no(400, opened.error);
    // A guest (src/guestpass.ts) never lends or borrows hardware: the same check as every other door.
    const guestNo = guestpass.doorRefusal(shareState, who, MAX_DOOR);
    if (guestNo) return no(guestNo.status, guestNo.error);
    const hostNonce = Buffer.from(String(opened.body.nonce ?? ''), 'base64url');
    if (hostNonce.length !== 16) return no(400, 'a Max mode request was not in the expected form.');
    // The borrower's llama.cpp build: its RPC server only talks to the same build. Unset (an older TOMLIN): the first one.
    const want = typeof opened.body.build === 'string' && /^b\d{3,6}$/.test(opened.body.build) ? opened.body.build : '';
    // What the borrower asks to have lent: its card only (the default) or the card, RAM and cores together ("all").
    const all = opened.body.share === 'all';
    const l = theLender();
    // The reader starts at the first ask: a second or two for its first reading.
    const p = presence.now() ?? (await presence.first());
    const why = maxlend.lendWhy({ pc: shareState.name, ...facts(), presence: p, idleMinutes: idleMinutes(), lease: l.lease, by: who });
    if (why) return no(409, why);
    const fresh = !l.lease;
    let port: number;
    try {
      const program = d.rpcProgram?.(want) ?? null;
      // The borrower's build, or none: another build cannot talk to it (the host picks one every PC can run, src/runnermatch.ts).
      if (want && !program) return no(409, `"${shareState.name}" does not have the llama.cpp ${want} runner unpacked (it lends with ${d.rpcBuilds?.().join(' or ') || 'none'}). Install it there (Network, Runner) and load the model again.`);
      port = await l.open({ hash: who.hash, name: who.name }, program && all ? { ...program, all: true } : program);
    } catch (e) {
      return no(409, `"${shareState.name}" cannot lend now: ${(e as Error).message}.`);
    }
    if (fresh && l.lease) log.info('max', `Lending this PC's ${all ? 'card, RAM and cores' : 'card memory'} to "${who.name}" (${p ? maxlend.presenceWords(p) : 'presence unknown'}).`);
    const rpc = await maxlend.reachRpc(port, () => socket.destroyed);
    if (!rpc || socket.destroyed) {
      rpc?.destroy();
      return no(503, `"${shareState.name}" started lending, but its RPC server did not answer.`);
    }
    const nodeNonce = newNonce();
    // Unsealed only when the borrower asks for it AND this PC's owner ticked "Allow unencrypted cluster links": the answer
    // says which, sealed, so the borrower never guesses (an older TOMLIN here sends no `plain`: sealed, as before).
    const plain = opened.body.plain === true && shareState.plainLinks === true;
    const answer = link.sealAnswer(keys, opened.id, 0, { nonce: nodeNonce.toString('base64url'), plain });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${MAX_UPGRADE}\r\nconnection: Upgrade\r\nx-link: ${answer}\r\n\r\n`);
    // A borrower that loses power sends no close: keep-alive ends the stream, and the loan ends after SPARE_MS.
    keepWireAlive(socket as Duplex & { setKeepAlive?: (on: boolean, ms: number) => unknown });
    l.track(socket);
    if (opened.body.plain === true) log.info('max', plain ? `The stream from "${who.name}" is NOT encrypted: both PCs chose an unencrypted cluster link.` : `"${who.name}" asked for an unencrypted cluster link; it is sealed, because Allow unencrypted cluster links is not ticked here.`);
    void (plain ? plainPipe(rpc, socket, head) : sealedPipe(rpc, socket, streamKeys(keys, hostNonce, nodeNonce, 'node'), 'node', { head })).then(ended => {
      l.untrack(socket);
      if (ended) log.info('max', `A stream from "${who.name}" ended: ${ended}`);
    });
  } catch (e) {
    no(500, `Max mode failed here: ${(e as Error).message}`);
  }
}
