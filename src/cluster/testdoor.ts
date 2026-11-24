// The cluster test door, this PC's side as a node: a linked PC opens a stream here to TIME the network and this PC's
// RPC server, so the expert-parallel engine can be measured with nobody at this PC (docs/PLAN-2026-11-14-CLUSTER-PARALLEL-ENGINE.md).
// It opens like Max mode's door (src/jobrun/maxnode.ts): an HTTP Upgrade on the worker port (so no new firewall rule
// is needed), a sealed request from a linked PC, the same lending rules (the cluster tick on, nobody using this PC, no
// Max mode loan running). Then the stream is either an echo (the network probe) or a short-lived RPC server of this
// PC's own runner, sealed like Max mode or, when the linked PC asks, UNENCRYPTED: the bytes after the opening are not
// sealed, so anyone on the home network who can reach the wire could read or change them. That is the choice a user
// may make on a private wired network; the opening itself is always sealed and checked.
// A test stream lasts at most TEST_MAX_MINUTES and ends at once when someone starts using this PC, the cluster tick is
// taken off or sharing is turned off. Why it ended is kept here for a while, and the linked PC asks for it after the
// close (a sealed "why" request on the same door, with the stream's nonce): the stream itself carries llama.cpp's bytes
// and must not be touched, and an older TOMLIN there never asks. Tested in test/clustertest.test.ts.
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as guestpass from '../guestpass.ts';
import * as carry from '../carry.ts';
import * as maxlend from '../maxlend.ts';
import { newNonce, sealedPipe, streamKeys } from '../linkstream.ts';

export const CLUSTER_TEST_DOOR = '/worker/cluster-test';
export const CLUSTER_TEST_UPGRADE = 'tomlin-cluster-test';
/** How long a test stream may last unless the linked PC asks for less, and the most it may ask for. */
export const TEST_MINUTES = 15;
export const TEST_MAX_MINUTES = 30;
/** How often a running test stream checks that it may go on (someone at the PC, the tick, sharing). */
export const TEST_CHECK_MS = 2_000;

/** What the linked PC asks for, as checked here. */
export interface TestAsk {
  /** dllama: a distributed-llama worker of this PC's own copy (tools/dllama), for the engine test of
   * docs/PLAN-2026-11-23-DISTRIBUTED-LLAMA-TEST.md; one stream is one worker, started for it and stopped with it. */
  target: 'echo' | 'rpc' | 'dllama';
  /** The bytes after the opening are not sealed. */
  plain: boolean;
  /** The llama.cpp build its runner talks to ("b11284"); '' for the first this PC has. */
  build: string;
  /** Lend the card and the RAM and cores together (as Max mode "all"). */
  all: boolean;
  minutes: number;
  nonce: Buffer;
  /** The RPC server's CPU threads (0: its default). */
  threads: number;
  /** The CPU socket (NUMA node) to keep it on, or -1 for none. */
  node: number;
  /** Lend only the RAM and cores, not the card. */
  cpu: boolean;
}

/** Whether a CPU name is one without AVX2 (Xeon E5 v1 and v2, as in the Z820 class), so the AVX build is used. */
export const noAvx2 = (cpu: string): boolean => /Xeon.*E5-\d{4}/i.test(cpu) && !/v[34]\b/i.test(cpu);
/** The distributed-llama program in an app copy for a CPU of this name (inside the app folder). In tools/, not runtime/:
 * a node before 2.1.17 refuses an update that names a folder it does not know, and tools/ it knows. */
export const dllamaFile = (cpu: string): string => `tools/dllama/${noAvx2(cpu) ? 'dllama-avx.exe' : 'dllama-avx2.exe'}`;

/** How long, in words ("2 min 14 s"). */
export const lasted = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
/** A stream the asking PC closes sooner than this is a short one: counted, not written line by line. */
export const SHORT_MS = 5_000;
/** ...and carries less than this each way (llama.cpp's check sends a few bytes; a real session sends far more). */
export const SHORT_BYTES = 1024;
/** How often the count of short streams is written (once a minute at most, and only when there were some). */
export const SHORT_SUM_MS = 60_000;
const shorts = new Map<string, { n: number; timer: ReturnType<typeof setTimeout> }>();
/** Counts one short stream for `who`; the first of a minute starts the count, written when the minute is up. */
export function shortStream(say: (line: string) => void, who: string, sumMs = SHORT_SUM_MS): void {
  const had = shorts.get(who);
  if (had) {
    had.n++;
    return;
  }
  const timer = setTimeout(() => {
    const n = shorts.get(who)?.n ?? 0;
    shorts.delete(who);
    say(`Cluster test for "${who}": ${n} short stream${n === 1 ? '' : 's'} (under ${SHORT_MS / 1000} s each, closed by that PC: llama.cpp checking the server) in the last minute, not written one by one.`);
  }, sumMs);
  timer.unref?.();
  shorts.set(who, { n: 1, timer });
}

/** How long a stream's end reason is kept for the linked PC to ask, and the most kept at once. */
export const WHY_KEEP_MS = 10 * 60_000;
const WHY_MAX = 200;
const ends = new Map<string, { reason: string; at: number }>();
const endKey = (hash: string, nonce: Buffer | string) => `${hash}|${typeof nonce === 'string' ? nonce : nonce.toString('base64url')}`;

/** Keeps why a stream ended, for the linked PC that opened it (by its link and the stream's own nonce). */
export function keepEnd(hash: string, nonce: Buffer, reason: string, now = Date.now()): void {
  for (const [k, v] of ends) if (now - v.at > WHY_KEEP_MS || ends.size >= WHY_MAX) ends.delete(k);
  ends.set(endKey(hash, nonce), { reason, at: now });
}

/** Why a stream ended ('' when it has not ended, or that was too long ago). */
export function endReason(hash: string, nonce: string, now = Date.now()): string {
  const e = ends.get(endKey(hash, nonce));
  return e && now - e.at <= WHY_KEEP_MS ? e.reason : '';
}

/** The ask from a sealed request's body, or why it is not one. */
export function readAsk(body: Record<string, unknown>): TestAsk | string {
  const nonce = Buffer.from(String(body.nonce ?? ''), 'base64url');
  if (nonce.length !== 16) return 'a cluster test request was not in the expected form';
  const target = body.target === 'rpc' || body.target === 'dllama' ? body.target : body.target === undefined || body.target === 'echo' ? 'echo' : null;
  if (!target) return `there is no cluster test "${String(body.target)}" here`;
  const build = typeof body.build === 'string' && /^b\d{3,6}$/.test(body.build) ? body.build : '';
  const asked = Number(body.minutes);
  const minutes = Number.isFinite(asked) && asked > 0 ? Math.min(TEST_MAX_MINUTES, Math.max(1, Math.round(asked))) : TEST_MINUTES;
  const t = Number(body.threads);
  const threads = Number.isInteger(t) && t >= 1 && t <= 256 ? t : 0;
  const n = Number(body.node);
  const node = body.node !== undefined && Number.isInteger(n) && n >= 0 && n <= 7 ? n : -1;
  return { target, plain: body.plain === true, build, all: body.all === true, minutes, nonce, threads, node, cpu: body.cpu === true };
}

/** Whether an Upgrade is for this door (the worker's upgrade handler sends the rest to Max mode). */
export const isClusterTest = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://worker').pathname === CLUSTER_TEST_DOOR;

/** What the door needs from the app, so tests can stand in for it (src/cluster/testdoornode.ts gives the real ones). */
export interface DoorDeps {
  state: () => share.ShareState;
  taken: link.Seen;
  /** Whether someone is at this PC (a first reading may take a few seconds). */
  presence: () => Promise<maxlend.Presence | null>;
  /** The newest reading, for the checks while a stream runs (null: not read). */
  presenceNow: () => maxlend.Presence | null;
  /** Max mode lending now: to whom (null: nobody). */
  lending: () => string | null;
  program: (build: string) => maxlend.RpcProgram | null;
  builds: () => string[];
  /** Starts an RPC server for one test stream (127.0.0.1 only) and says how to stop it. */
  /** `node`: the CPU socket to keep it on (-1: none). */
  startRpc: (p: maxlend.RpcProgram, node: number) => Promise<{ port: number; stop: () => void }>;
  /** Starts a distributed-llama worker for one test stream (127.0.0.1 only); absent or null when this copy has none. */
  startDllama?: (threads: number) => Promise<{ port: number; stop: () => void }> | null;
  say: (line: string) => void;
  /** Below this a stream the asking PC closes is counted, not written (SHORT_MS; the tests write every one with 0). */
  shortMs?: number;
}

/** An in-memory echo: what is written comes back (the probe's far end). */
export function echoStream(): Duplex {
  return new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      this.push(chunk);
      cb();
    },
    final(cb) {
      this.push(null);
      cb();
    },
  });
}

function refuse(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/** Why a running test stream must end now ('' while it may go on). */
export function testEnds(st: share.ShareState, p: maxlend.Presence | null): string {
  if (!st.on) return 'sharing was turned off here';
  if (!carry.cleanAllow(st.allow).lend) return 'the cluster tick was taken off here';
  if (st.away) return 'someone here pressed "I need to use the pc"';
  if (p && maxlend.ownerBack(p)) return 'someone started using this PC';
  return '';
}

export async function clusterTestUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: DoorDeps): Promise<void> {
  let from = req.socket.remoteAddress ?? '';
  const no = (status: number, error: string) => {
    deps.say(`Did not open a cluster test (${from}): ${error}`);
    refuse(socket, status, error);
  };
  // What a fault below must undo: a worker or RPC server already started is stopped, and once the 101 has gone out the
  // stream is closed rather than answered with an HTTP error inside it.
  let undo = (): void => undefined;
  let upgraded = false;
  try {
    if (!share.isPrivateAddress(from)) return no(403, 'This worker only answers PCs on its own home network.');
    if (req.headers.origin) return no(403, 'Web pages cannot use this worker.');
    if (!isClusterTest(req) || String(req.headers.upgrade).toLowerCase() !== CLUSTER_TEST_UPGRADE) return no(404, 'There is no such door here.');
    const st = deps.state();
    const hash = /^Link ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = share.pairedByHash(st, hash);
    if (!who) return no(401, 'that PC no longer knows this one (it was removed there, or set up again)');
    from = `"${who.name}", ${from}`;
    const keys = link.keysOf(who.key);
    if (!keys) return no(401, 'this link was made before links were encrypted. Link this PC again from the main PC.');
    const opened = link.openRequest(keys, { box: String(req.headers['x-link'] ?? '') }, CLUSTER_TEST_DOOR, deps.taken);
    if ('error' in opened) return no(400, opened.error);
    // A guest (src/guestpass.ts) never joins a cluster: the same check as every other door.
    const guestNo = guestpass.doorRefusal(st, who, CLUSTER_TEST_DOOR);
    if (guestNo) return no(guestNo.status, guestNo.error);
    // The linked PC asks why a stream ended: a status read, so the lending rules do not apply.
    if (opened.body.target === 'why') {
      const reason = endReason(hash, String(opened.body.stream ?? ''));
      const body = JSON.stringify({ box: link.sealAnswer(keys, opened.id, 0, { reason }) });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      return;
    }
    const ask = readAsk(opened.body);
    if (typeof ask === 'string') return no(400, ask);
    const p = await deps.presence();
    const why = maxlend.lendWhy({ pc: st.name, on: st.on, allow: carry.cleanAllow(st.allow), away: !!st.away, presence: p, idleMinutes: maxlend.cleanLendIdle(st.lendIdle), lease: null, by: who });
    if (why) return no(409, why);
    const busy = deps.lending();
    if (busy) return no(409, `"${st.name}" is lending to "${busy}" now (Max mode); a test waits until that ends.`);

    let inner: Duplex;
    let stopRpc: () => void = () => undefined;
    if (ask.target === 'rpc') {
      const program = deps.program(ask.build);
      if (!program) return no(409, `"${st.name}" does not have the ${ask.build ? `llama.cpp ${ask.build}` : 'llama.cpp'} runner unpacked (it has ${deps.builds().join(' or ') || 'none'}).`);
      let started: { port: number; stop: () => void };
      try {
        started = await deps.startRpc({ ...program, all: ask.all, ...(ask.threads ? { threads: ask.threads } : {}), ...(ask.cpu ? { cpuOnly: true } : {}) }, ask.node);
      } catch (e) {
        return no(409, `"${st.name}" could not start its RPC server: ${(e as Error).message}.`);
      }
      const rpc = await maxlend.reachRpc(started.port, () => socket.destroyed);
      if (!rpc || socket.destroyed) {
        rpc?.destroy();
        started.stop();
        return no(503, `"${st.name}" started its RPC server, but it did not answer.`);
      }
      inner = rpc;
      stopRpc = started.stop;
      undo = () => {
        rpc.destroy();
        started.stop();
      };
    } else if (ask.target === 'dllama') {
      let started: { port: number; stop: () => void } | null;
      try {
        started = await (deps.startDllama?.(ask.threads) ?? null);
      } catch (e) {
        return no(409, `"${st.name}" could not start its distributed-llama worker: ${(e as Error).message}.`);
      }
      if (!started) return no(409, `"${st.name}" does not have distributed-llama (it comes with TOMLIN 2.1.17 or newer).`);
      // The first connection that gets through is the stream's own: a worker takes the first one as its root.
      const w = await maxlend.reachRpc(started.port, () => socket.destroyed);
      if (!w || socket.destroyed) {
        w?.destroy();
        started.stop();
        return no(503, `"${st.name}" started its distributed-llama worker, but it did not answer.`);
      }
      inner = w;
      stopRpc = started.stop;
      undo = () => {
        w.destroy();
        started.stop();
      };
    } else inner = echoStream();

    const nodeNonce = newNonce();
    const answer = link.sealAnswer(keys, opened.id, 0, { nonce: nodeNonce.toString('base64url'), plain: ask.plain, target: ask.target, minutes: ask.minutes });
    upgraded = true;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${CLUSTER_TEST_UPGRADE}\r\nconnection: Upgrade\r\nx-link: ${answer}\r\n\r\n`);
    const opening = `Cluster test for "${who.name}": ${ask.target === 'dllama' ? `a distributed-llama worker${ask.threads ? ` (${ask.threads} threads)` : ''}` : ask.target === 'rpc' ? `this PC's RPC server (${ask.cpu ? 'RAM and cores' : ask.all ? 'card, RAM and cores' : 'card'}${ask.threads ? `, ${ask.threads} threads` : ''}${ask.node >= 0 ? `, CPU socket ${ask.node}` : ''})` : 'an echo'}, ${ask.plain ? 'NOT encrypted' : 'sealed'}, ${ask.minutes} minutes at most.`;
    // A short stream that the asking PC closes (llama.cpp opens one to check a server, many a second) is counted, not
    // written: two lines each filled the log. Its opening is written once it has lasted SHORT_MS, and every other end.
    const since = Date.now();
    // What the stream itself carries is counted from here (the opening request and its answer are left out).
    const base = { in: (socket as Socket).bytesRead ?? 0, out: (socket as Socket).bytesWritten ?? 0 };
    const short = deps.shortMs ?? SHORT_MS;
    let told = short <= 0;
    if (told) deps.say(opening);
    const tell = told ? undefined : setTimeout(() => {
      told = true;
      deps.say(opening);
    }, short);
    // A dead network (the other PC gone without a word) is noticed by the system's keep-alive, not only at the time limit.
    (socket as Socket).setKeepAlive?.(true, 15_000);

    let ended = '';
    // Which end closed first, for an end with no other reason (a sealed pipe ending destroys both at once after).
    let first = '';
    const closedBy = () => first || 'closed';
    const end = (reason: string) => {
      if (ended) return;
      ended = reason || closedBy();
      keepEnd(hash, ask.nonce, ended);
      clearTimeout(limit);
      clearInterval(check);
      clearTimeout(tell);
      const moved = { in: (socket as Socket).bytesRead ?? 0, out: (socket as Socket).bytesWritten ?? 0 };
      socket.destroy();
      inner.destroy();
      stopRpc();
      const ms = Date.now() - since;
      // Only a check carries next to nothing each way; a real session that fails fast is written in full.
      const little = moved.in - base.in < SHORT_BYTES && moved.out - base.out < SHORT_BYTES;
      if (!told && ms < short && ended === byAsker && little) return shortStream(deps.say, who.name);
      if (!told) deps.say(opening);
      deps.say(`Cluster test for "${who.name}" ended: ${ended} (after ${lasted(ms)}, ${(moved.in / 2 ** 20).toFixed(1)} MB in, ${(moved.out / 2 ** 20).toFixed(1)} MB out).`);
    };
    const limit = setTimeout(() => end(`its ${ask.minutes} minutes were up`), ask.minutes * 60_000);
    const check = setInterval(() => {
      const stop = testEnds(deps.state(), deps.presenceNow());
      if (stop) end(stop);
    }, TEST_CHECK_MS);
    const byAsker = 'the asking PC closed the stream (or the network between the PCs dropped)';
    const byInner = ask.target === 'dllama' ? "this PC's distributed-llama worker closed the connection (its run ended, or it stopped)" : ask.target === 'rpc' ?"this PC's RPC server closed the connection (it stopped, or llama.cpp there ended the session)" : 'the echo here ended';
    for (const [s, by] of [[socket, byAsker], [inner, byInner]] as const) {
      for (const ev of ['end', 'close', 'error']) s.on(ev, (e?: unknown) => {
        // An error keeps its code: "reset by the asking PC (ECONNRESET)" says more than "closed".
        const code = ev === 'error' ? (e as NodeJS.ErrnoException | undefined)?.code : '';
        first ||= code ? `${by}: ${(e as Error).message} (${code})` : by;
        if (ask.plain) end('');
      });
    }
    if (ask.plain) {
      (socket as Socket).setNoDelay?.(true);
      (inner as Socket).setNoDelay?.(true);
      if (head.length) inner.write(head);
      socket.pipe(inner);
      inner.pipe(socket);
    } else {
      void sealedPipe(inner, socket, streamKeys(keys, ask.nonce, nodeNonce, 'node'), 'node', { head }).then(why => end(why));
    }
  } catch (e) {
    undo();
    if (upgraded) {
      deps.say(`The cluster test stopped here: ${(e as Error).message}`);
      socket.destroy();
    } else no(500, `The cluster test failed here: ${(e as Error).message}`);
  }
}
