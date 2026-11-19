// The cluster test door, the asking PC's side (the node's side is src/cluster/testdoor.ts): opens a test stream to a
// linked PC, an echo for the network probe or that PC's RPC server, sealed as Max mode or unencrypted after the
// opening, and offers it on a port on 127.0.0.1 (each connection there is one stream), for the probe in
// src/cluster/harness.ts or llama.cpp's --rpc. Used by tools/cluster-test.ts. Tested in test/clustertest.test.ts.
import { request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import * as share from '../share.ts';
import * as link from '../link.ts';
import { newNonce, sealedPipe, streamKeys } from '../linkstream.ts';
import type { Remote } from '../store.ts';
import { CLUSTER_TEST_DOOR, CLUSTER_TEST_UPGRADE } from './testdoor.ts';

export interface TestWant {
  target: 'echo' | 'rpc';
  plain: boolean;
  build?: string;
  all?: boolean;
  minutes?: number;
}

export interface TestWire {
  socket: Socket;
  head: Buffer;
  /** The node agreed to leave the stream unencrypted (otherwise it is sealed, whatever was asked). */
  plain: boolean;
  keys: { send: Buffer; read: Buffer };
  /** This stream's own nonce, to ask the node afterwards why it ended. */
  nonce: string;
}

/** What `testBridge` tells about each stream, as a line and as parts (tools/cluster-test.ts sums them up). */
export interface StreamNews {
  stream: number;
  kind: 'open' | 'ended' | 'refused';
  /** Why it ended or was refused ('' for an opening). */
  reason: string;
  /** The linked PC ended or refused it (not this PC, llama.cpp here or the wire). */
  byNode: boolean;
}

/** Said when the linked PC answers the "why" request as a TOMLIN without it (2.0.89) does. */
export const NO_REASON = 'the linked PC gave no reason; it runs an older TOMLIN';

/**
 * Asks `r` why the stream with `nonce` ended: its reason, '' when it has none (it has not ended there yet), or null
 * when it runs an older TOMLIN that cannot tell. Throws when it cannot be asked (off the network).
 */
export async function askEndReason(r: Pick<Remote, 'name' | 'url' | 'token' | 'key'>, nonce: string, ms = 10_000): Promise<string | null> {
  const linkKeys = link.keysOf(r.key);
  if (!linkKeys) throw new Error(`"${r.name}" was linked before links were encrypted.`);
  // A fresh nonce too: an older TOMLIN checks it first, and then refuses the "why" it does not know.
  const sealed = link.sealRequest(linkKeys, CLUSTER_TEST_DOOR, { nonce: newNonce().toString('base64url'), target: 'why', stream: nonce }, link.nodeNow(r.url));
  const id = link.requestId(sealed.box);
  const u = new URL(r.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: CLUSTER_TEST_DOOR, method: 'GET', headers: { connection: 'Upgrade', upgrade: CLUSTER_TEST_UPGRADE, authorization: `Link ${share.hashToken(r.token)}`, 'x-link': sealed.box } });
    req.setTimeout(ms, () => req.destroy(new Error(`"${r.name}" did not answer in ${Math.round(ms / 1000)} seconds.`)));
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(null);
    });
    req.on('response', res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const said = link.openAnswer(linkKeys, id, 0, (JSON.parse(text) as { box?: unknown }).box) as { reason?: unknown };
          resolve(typeof said.reason === 'string' ? said.reason : null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.end();
  });
}

/** Opens one test stream to `r`. Throws in plain words (the node's own reason when it refuses). */
export async function openTestWire(r: Pick<Remote, 'name' | 'url' | 'token' | 'key'>, want: TestWant, ms = 60_000): Promise<TestWire> {
  // A PC whose clock is wrong refuses the first try; its answer taught this PC its clock, so once more in its time.
  return openTestWireOnce(r, want, ms).catch(async e => {
    if (!link.clockRefused((e as Error).message)) throw e;
    await link.learnClock(r.url);
    return openTestWireOnce(r, want, ms);
  });
}

async function openTestWireOnce(r: Pick<Remote, 'name' | 'url' | 'token' | 'key'>, want: TestWant, ms: number): Promise<TestWire> {
  const linkKeys = link.keysOf(r.key);
  if (!linkKeys) throw new Error(`"${r.name}" was linked before links were encrypted. Link it again.`);
  const why = await share.homeNetworkWhy(r.url);
  if (why) throw new Error(`"${r.name}": ${why}`);
  const hostNonce = newNonce();
  const sealed = link.sealRequest(linkKeys, CLUSTER_TEST_DOOR, { nonce: hostNonce.toString('base64url'), target: want.target, plain: want.plain, ...(want.build ? { build: want.build } : {}), ...(want.all ? { all: true } : {}), ...(want.minutes ? { minutes: want.minutes } : {}) }, link.nodeNow(r.url));
  const id = link.requestId(sealed.box);
  const u = new URL(r.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: CLUSTER_TEST_DOOR, method: 'GET', headers: { connection: 'Upgrade', upgrade: CLUSTER_TEST_UPGRADE, authorization: `Link ${share.hashToken(r.token)}`, 'x-link': sealed.box } });
    req.setTimeout(ms, () => req.destroy(new Error(`"${r.name}" did not answer in ${Math.round(ms / 1000)} seconds.`)));
    req.on('error', e => reject(new Error((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? `"${r.name}" could not be reached (TOMLIN not running there, or sharing off).` : (e as Error).message)));
    req.on('response', res => {
      link.noteClock(r.url, res.headers.date);
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => {
        let error = '';
        try {
          error = String((JSON.parse(text) as { error?: unknown }).error ?? '');
        } catch {
          // not JSON
        }
        reject(new Error(res.statusCode === 404 && !error ? `"${r.name}" runs a TOMLIN without the cluster test door. Update it there.` : error || `"${r.name}" answered ${res.statusCode}.`));
      });
    });
    req.on('upgrade', (res, socket, head) => {
      try {
        const said = link.openAnswer(linkKeys, id, 0, res.headers['x-link']) as { nonce?: unknown; plain?: unknown };
        const nodeNonce = Buffer.from(String(said.nonce ?? ''), 'base64url');
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 15_000);
        resolve({ socket, head, plain: said.plain === true, keys: streamKeys(linkKeys, hostNonce, nodeNonce, 'host'), nonce: hostNonce.toString('base64url') });
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
    req.end();
  });
}

/** Why a stream ended, as this PC can tell: the wire's own trouble, this side closing, or the node's reason asked. */
async function whyEnded(r: Pick<Remote, 'name' | 'url' | 'token' | 'key'>, nonce: string, why: string, localFirst: boolean): Promise<{ reason: string; byNode: boolean }> {
  if (why) return { reason: why, byNode: false };
  if (localFirst) return { reason: 'this PC closed it (llama.cpp or the probe here hung up)', byNode: false };
  try {
    const said = await askEndReason(r, nonce);
    if (said === null) return { reason: NO_REASON, byNode: true };
    return { reason: said ? `"${r.name}" ended it: ${said}` : `"${r.name}" closed it and kept no reason`, byNode: !!said };
  } catch (e) {
    return { reason: `could not ask "${r.name}" why: ${(e as Error).message}`, byNode: false };
  }
}

/** One stream's news as the line `testBridge` says. */
export function newsLine(n: StreamNews, plain?: boolean): string {
  if (n.kind === 'open') return `stream ${n.stream}: open, ${plain ? 'not encrypted' : 'sealed'}`;
  if (n.kind === 'refused') return `stream ${n.stream}: refused: ${n.reason}`;
  return n.reason === NO_REASON ? `stream ${n.stream}: ended (${NO_REASON})` : `stream ${n.stream}: ended: ${n.reason}`;
}

/**
 * A port on 127.0.0.1 where each connection becomes one test stream to `r`. `said` hears each stream's opening, end or
 * refusal (with why; an end the node made is asked of it after the close), `news` the same in parts. Close the server
 * to stop taking new ones (open streams end with their connection or the node's time limit).
 */
export async function testBridge(r: Pick<Remote, 'name' | 'url' | 'token' | 'key'>, want: TestWant, port = 0, said: (line: string) => void = () => undefined, news: (n: StreamNews) => void = () => undefined): Promise<{ server: Server; port: number }> {
  let n = 0;
  const server = createServer(local => {
    const k = ++n;
    local.pause();
    local.setNoDelay(true);
    local.on('error', () => undefined);
    // Which side closed first: this PC's connection (llama.cpp or the probe) or the wire.
    let first: 'local' | 'wire' | '' = '';
    const ended = (why: string, nonce: string) => void whyEnded(r, nonce, why, first === 'local').then(e => {
      const x: StreamNews = { stream: k, kind: 'ended', ...e };
      said(newsLine(x));
      news(x);
    });
    openTestWire(r, want).then(w => {
      const opened: StreamNews = { stream: k, kind: 'open', reason: '', byNode: false };
      said(newsLine(opened, w.plain));
      news(opened);
      if (local.destroyed) return w.socket.destroy();
      for (const ev of ['end', 'close', 'error']) {
        local.on(ev, () => void (first ||= 'local'));
        w.socket.on(ev, () => void (first ||= 'wire'));
      }
      if (w.plain) {
        if (w.head.length) local.write(w.head);
        local.pipe(w.socket);
        w.socket.pipe(local);
        local.resume();
        const end = () => {
          local.destroy();
          w.socket.destroy();
        };
        for (const s of [local, w.socket]) {
          s.on('close', end);
          s.on('error', end);
        }
        local.once('close', () => ended('', w.nonce));
      } else {
        local.resume();
        void sealedPipe(local, w.socket, w.keys, 'host', { head: w.head }).then(why => ended(why, w.nonce));
      }
    }, (e: Error) => {
      const x: StreamNews = { stream: k, kind: 'refused', reason: e.message, byNode: true };
      said(newsLine(x));
      news(x);
      local.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, port: (server.address() as { port: number }).port };
}
