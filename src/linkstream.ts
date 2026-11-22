// Max mode's sealed stream: one long connection between a host and a node, for llama.cpp's RPC (the host's
// llama-server uses the node's card as one of its own). The link (src/link.ts) seals one request at a time; RPC is a
// stream of bytes both ways, so it gets a stream of its own. It is opened by a sealed request on the node's worker door
// (an HTTP Upgrade), each side adds a fresh nonce, and from the link's keys and both nonces come two keys for this
// stream only (one each way). Every frame is sealed with AES-256-GCM under a counter, so a frame changed, dropped,
// replayed or reordered on the way ends the stream. A frame with nothing in it is a heartbeat: a stream that hears
// nothing for a while is ended, so a PC that drops off the network never leaves an answer hanging. Plain parts, tested
// in test/linkstream.test.ts.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

/** The most bytes in one frame (RPC sends a model's weights in big writes: they are cut into frames of this size). */
export const FRAME = 256 * 1024;
/** A heartbeat this often, both ways. */
export const BEAT_MS = 5_000;
/** A stream that hears nothing (not even a heartbeat) for this long is ended. */
export const SILENT_MS = 20_000;

export type Side = 'host' | 'node';

/** A stream's own keys, from the link's keys and the nonces both PCs sent: `send` for this side, `read` for the other. */
export function streamKeys(linkKeys: Buffer, hostNonce: Buffer, nodeNonce: Buffer, side: Side): { send: Buffer; read: Buffer } {
  if (hostNonce.length !== 16 || nodeNonce.length !== 16) throw new Error('a stream nonce is not 16 bytes.');
  const k = Buffer.from(hkdfSync('sha256', linkKeys, Buffer.concat([hostNonce, nodeNonce]), 'tomlin max stream v1', 64));
  const toNode = k.subarray(0, 32);
  const toHost = k.subarray(32, 64);
  return side === 'host' ? { send: toNode, read: toHost } : { send: toHost, read: toNode };
}

export const newNonce = () => randomBytes(16);

const ivOf = (n: bigint) => {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(n, 4);
  return iv;
};

/** Seals frames in order: 4 bytes of length, then the sealed bytes and their 16-byte check. */
export class Sealer {
  private n = 0n;
  private key: Buffer;
  private aad: string;
  constructor(key: Buffer, aad: string) {
    this.key = key;
    this.aad = aad;
  }
  /** `plain` in frames of FRAME bytes at most; an empty one is a heartbeat. */
  frames(plain: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let at = 0;
    do {
      const piece = plain.subarray(at, at + FRAME);
      at += piece.length;
      const c = createCipheriv('aes-256-gcm', this.key, ivOf(this.n++));
      c.setAAD(Buffer.from(this.aad));
      const body = Buffer.concat([c.update(piece), c.final(), c.getAuthTag()]);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      out.push(len, body);
    } while (at < plain.length);
    return out;
  }
}

/** Opens frames as bytes arrive, in order; throws on the first one that does not open (the stream must then end). */
export class Opener {
  private n = 0n;
  private buf: Buffer = Buffer.alloc(0);
  private key: Buffer;
  private aad: string;
  constructor(key: Buffer, aad: string) {
    this.key = key;
    this.aad = aad;
  }
  /** What `chunk` completes: each frame's plain bytes (empty for a heartbeat). */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 16 || len > FRAME + 16) throw new Error('a frame on the stream is not one TOMLIN sends.');
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const d = createDecipheriv('aes-256-gcm', this.key, ivOf(this.n++));
      d.setAAD(Buffer.from(this.aad));
      d.setAuthTag(body.subarray(len - 16));
      try {
        out.push(Buffer.concat([d.update(body.subarray(0, len - 16)), d.final()]));
      } catch {
        throw new Error('a frame on the stream could not be opened (changed, dropped or out of order on the way).');
      }
    }
    return out;
  }
}

/**
 * Joins `plain` (the runner's own connection on this PC) and `wire` (the connection to the other PC): what the runner
 * writes is sealed onto the wire, what comes off the wire is opened for the runner. Either one ending, a frame that
 * does not open, or silence for `silentMs` ends both. `head`: bytes already read off the wire. Resolves with why it
 * ended ('' when one side simply closed).
 */
export function sealedPipe(plain: Duplex, wire: Duplex, keys: { send: Buffer; read: Buffer }, side: Side, o: { head?: Buffer; beatMs?: number; silentMs?: number } = {}): Promise<string> {
  const sealer = new Sealer(keys.send, `max|${side}`);
  const opener = new Opener(keys.read, `max|${side === 'host' ? 'node' : 'host'}`);
  // Small writes go at once. RPC is many small asks and answers each word, and with Nagle's delay on (the default)
  // Windows held each one back for its acknowledgement: 3 Nov, each word cost about 50 ms more through the relay.
  for (const s of [plain, wire]) (s as Duplex & { setNoDelay?: (on?: boolean) => unknown }).setNoDelay?.(true);
  let heard = Date.now();
  // This side stopped reading the wire because `plain` is full (the RPC server copying weights to the card): what the
  // other PC sends waits unread, so the silence is this side's own and does not count (3 Nov: a lending PC dropped an
  // 80B model's load as "went quiet" while its RPC server was busy for over 20 s).
  let holding = false;
  let why = '';
  let done!: (why: string) => void;
  const ended = new Promise<string>(r => (done = r));
  const end = (reason = '') => {
    if (why) return;
    why = reason || 'closed';
    clearInterval(beat);
    plain.destroy();
    wire.destroy();
    done(reason);
  };
  // A frame's length and body, and every frame of one turn, go out in ONE write: llama.cpp's RPC sends each message in
  // several small writes (a command byte, an 8-byte size, the data), and a write each cost a Node turn and a packet each
  // way (14 Nov 2026: a 10 KB frame there and back took 0.9 to 1.4 ms through the two sealed relays, 0.34 ms through
  // two bare ones). The bytes on the wire are the same frames as before, so an older PC on the other end reads them.
  const toWire = (frames: Buffer[]) => wire.write(frames.length === 1 ? frames[0] : Buffer.concat(frames));
  const fromWire = (chunk: Buffer) => {
    heard = Date.now();
    let parts: Buffer[];
    try {
      parts = opener.push(chunk);
    } catch (e) {
      return end((e as Error).message);
    }
    const opened = parts.filter(p => p.length);
    if (opened.length && !plain.write(opened.length === 1 ? opened[0] : Buffer.concat(opened))) {
      holding = true;
      wire.pause();
    }
  };
  const beat = setInterval(() => {
    if (holding) heard = Date.now();
    if (Date.now() - heard > (o.silentMs ?? SILENT_MS)) return end('the other PC went quiet (off the network, or stopped).');
    toWire(sealer.frames(Buffer.alloc(0)));
  }, o.beatMs ?? BEAT_MS);
  // What the runner writes in one go arrives as several reads: they are gathered until the end of this turn of the
  // event loop and sealed as one frame (cut at FRAME as before).
  let gathered: Buffer[] = [];
  const seal = () => {
    const all = gathered.length === 1 ? gathered[0] : Buffer.concat(gathered);
    gathered = [];
    if (why || !all.length) return;
    if (!toWire(sealer.frames(all))) plain.pause();
  };
  plain.on('data', (c: Buffer) => {
    if (!gathered.length) setImmediate(seal);
    gathered.push(c);
  });
  wire.on('drain', () => plain.resume());
  plain.on('drain', () => {
    holding = false;
    heard = Date.now();
    wire.resume();
  });
  wire.on('data', fromWire);
  for (const s of [plain, wire]) {
    s.on('close', () => end());
    s.on('end', () => end());
    s.on('error', () => end());
  }
  if (o.head?.length) fromWire(o.head);
  return ended;
}

/**
 * The runner's own connection (`plain`, held paused) joined to a sealed stream once `open` has made it. Opening can take
 * up to 30 s, and a paused socket still hears its other end go: a runner that closed its side meanwhile (it stopped, or
 * gave up) gets the new stream closed at once, never held open by its heartbeats (the other PC would go on lending to
 * nobody). Resolves with why it ended, as sealedPipe; rejects when the stream could not be opened (`plain` is closed).
 */
/**
 * The runner's connection and the wire joined as they are, NOT sealed: only when both PCs chose it ("Unencrypted cluster
 * link" on the borrowing PC, "Allow unencrypted cluster links" on the lending one), after a sealed opening. Anything on the
 * home network can then read and change the bytes, the RPC commands included. About half the time a step takes on the
 * network (22 Nov 2026: a layer there and back 1.33 ms against 2.82 sealed). Either side ending ends both. Resolves ''
 * when one side simply closed.
 */
export function plainPipe(plain: Duplex, wire: Duplex, head?: Buffer): Promise<string> {
  for (const s of [plain, wire]) (s as Duplex & { setNoDelay?: (on?: boolean) => unknown }).setNoDelay?.(true);
  return new Promise(resolve => {
    let over = false;
    const end = (why = '') => {
      if (over) return;
      over = true;
      plain.destroy();
      wire.destroy();
      resolve(why);
    };
    for (const s of [plain, wire]) {
      s.on('close', () => end());
      s.on('end', () => end());
      s.on('error', () => end());
    }
    if (head?.length) plain.write(head);
    wire.pipe(plain);
    plain.pipe(wire);
  });
}

export async function joinWhenOpen(plain: Duplex, open: () => Promise<{ socket: Duplex; keys: { send: Buffer; read: Buffer }; head?: Buffer; plain?: boolean }>, side: Side = 'host'): Promise<string> {
  plain.pause();
  let gone = false;
  const goneNow = () => void (gone = true);
  // A reset arrives as an error: heard here, or it would end TOMLIN.
  for (const ev of ['close', 'end', 'error']) plain.on(ev, goneNow);
  let wire: Awaited<ReturnType<typeof open>>;
  try {
    wire = await open();
  } catch (e) {
    plain.destroy();
    throw e;
  } finally {
    for (const ev of ['close', 'end', 'error']) plain.off(ev, goneNow);
  }
  if (gone || plain.destroyed) {
    wire.socket.destroy();
    plain.destroy();
    return 'the runner closed its side before the stream opened';
  }
  plain.resume();
  if (wire.plain === true) return plainPipe(plain, wire.socket, wire.head);
  return sealedPipe(plain, wire.socket, wire.keys, side, { head: wire.head });
}
