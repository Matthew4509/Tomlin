// The encrypted link between a host and a node (PLAN F7 E1). At linking, each PC makes a fresh X25519 key pair and they
// swap the public halves; both prove they know the node's setup code (and its PIN, when it asks for one) with a key made
// from it, so a device in the middle that does not know the code cannot swap in keys of its own. The code itself never
// crosses the network. From the swap come two keys (one each way); every message after that, the work, the answers and
// the pictures, is sealed with AES-256-GCM, and a message changed on the way, replayed, or sent to another door is
// refused. Built on node:crypto only. Plain functions, tested in test/link.test.ts.
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scrypt, timingSafeEqual, type KeyObject } from 'node:crypto';

/** What a node says in whoami when it speaks this link; an older one says nothing. */
export const LINK_VERSION = 2;
/** A request older or newer than this (the two PCs' clocks) is refused: a copy sent again later is no use. */
export const LINK_WINDOW_MS = 15 * 60_000;

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: unknown) => (typeof s === 'string' && /^[\w-]*$/.test(s) ? Buffer.from(s, 'base64url') : Buffer.alloc(0));

/** The key both PCs make from the setup code (and the PIN): slow on purpose, so guessing codes from a recording is slow too. */
// "smart-manager ..." in the words below are the link's fixed salts from before the TOMLIN name: changing them would
// stop new copies linking with PCs that run an older one.
export function pairKey(code: string, pin: string): Promise<Buffer> {
  const words = `${String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')}:${String(pin).replace(/\D/g, '')}`;
  return new Promise((resolve, reject) => scrypt(words, 'smart-manager link v2', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 2 ** 20 }, (e, k) => (e ? reject(e) : resolve(k))));
}

/** A fresh key pair for one linking; the public half as 43 letters. */
export function keyPair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { pub: String(publicKey.export({ format: 'jwk' }).x), priv: privateKey };
}

function shared(priv: KeyObject, pub: string): Buffer {
  if (!/^[\w-]{43}$/.test(pub)) throw new Error('the other PC sent a key that is not one.');
  return diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub }, format: 'jwk' }) });
}

const mac = (key: Buffer, words: string) => b64(createHmac('sha256', key).update(words).digest());
const sameMac = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What the host sends to link (everything in it may be read on the way; none of it gives the code away quickly). */
export interface PairAsk {
  v: number;
  pub: string;
  nonce: string;
  from: string;
  name: string;
  /** The host typed a PIN too (the PIN itself is not sent). */
  pinGiven: boolean;
  mac: string;
}

export interface PairAnswer {
  v: number;
  pub: string;
  id: string;
  name: string;
  mac: string;
  /** The link's token, sealed with the new key. */
  box: string;
}

const askWords = (a: Pick<PairAsk, 'pub' | 'nonce' | 'from' | 'name'>) => `smart-manager pair v2|${a.pub}|${a.nonce}|${a.from}|${a.name}`;
const answerWords = (a: PairAsk, n: Pick<PairAnswer, 'pub' | 'id' | 'name'>) => `${askWords(a)}|${n.pub}|${n.id}|${n.name}`;

/** Both keys of a link, 64 bytes: host to node, then node to host. Kept by both PCs. */
function linkKeys(secret: Buffer, key: Buffer, hostPub: string, nodePub: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, key, `smart-manager link v2|${hostPub}|${nodePub}`, 64));
}
export const toNode = (keys: Buffer) => keys.subarray(0, 32);
export const toHost = (keys: Buffer) => keys.subarray(32, 64);

/** The host's first message. Keep `priv` for reading the answer. */
export function hostAsk(key: Buffer, from: string, name: string, pinGiven: boolean): { ask: PairAsk; priv: KeyObject } {
  const { pub, priv } = keyPair();
  const base = { pub, nonce: b64(randomBytes(16)), from, name };
  return { ask: { v: LINK_VERSION, ...base, pinGiven, mac: mac(key, `host|${askWords(base)}`) }, priv };
}

/** The node checks the host's message with the key from its own code. Null: the code (or PIN) was wrong. */
export function nodeAnswer(key: Buffer, raw: Record<string, unknown>, me: { id: string; name: string }, token: string): { answer: PairAnswer; keys: Buffer } | null {
  const ask: PairAsk = { v: Number(raw.v), pub: String(raw.pub ?? ''), nonce: String(raw.nonce ?? ''), from: String(raw.from ?? ''), name: String(raw.name ?? ''), pinGiven: raw.pinGiven === true, mac: String(raw.mac ?? '') };
  if (!sameMac(ask.mac, mac(key, `host|${askWords(ask)}`))) return null;
  const { pub, priv } = keyPair();
  const keys = linkKeys(shared(priv, ask.pub), key, ask.pub, pub);
  const base = { pub, id: me.id, name: me.name };
  return { answer: { v: LINK_VERSION, ...base, mac: mac(key, `node|${answerWords(ask, base)}`), box: seal(toHost(keys), Buffer.from(token), 'pair') }, keys };
}

/** The host checks the node's answer: it must prove the same code. Gives the token and the link's keys. */
export function hostFinish(key: Buffer, ask: PairAsk, priv: KeyObject, raw: Record<string, unknown>): { token: string; keys: Buffer; id: string; name: string } {
  const n = { pub: String(raw.pub ?? ''), id: String(raw.id ?? ''), name: String(raw.name ?? '') };
  if (!sameMac(raw.mac, mac(key, `node|${answerWords(ask, n)}`))) throw new Error('its answer did not prove it knows the setup code, so something on the network may be in the middle. Not linked.');
  const keys = linkKeys(shared(priv, n.pub), key, ask.pub, n.pub);
  const token = open(toHost(keys), String(raw.box ?? ''), 'pair')?.toString() ?? '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('its answer could not be opened. Not linked.');
  return { token, keys, ...n };
}

// ---- Sealing ----

/** AES-256-GCM: a fresh 12-byte nonce, the text, the 16-byte check. `aad` ties it to where it belongs. */
export function seal(key: Buffer, plain: Buffer, aad: string): string {
  return b64(sealBytes(key, plain, aad));
}

/** As seal, as bytes: a piece of a file crosses the link this way (no letters, so a third smaller). */
export function sealBytes(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}

/** The text, or null when it was changed on the way, sealed with another key, or meant for somewhere else. */
export function open(key: Buffer, box: string, aad: string): Buffer | null {
  return openBytes(key, unb64(box), aad);
}

/** As open, from bytes. */
export function openBytes(key: Buffer, raw: Buffer, aad: string): Buffer | null {
  if (raw.length < 28) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

/** A request's id: its nonce, which the answer is tied to. */
export const requestId = (box: string) => box.slice(0, 16);

/** The host's request: the door, the time and the body, sealed. */
export function sealRequest(keys: Buffer, path: string, body: unknown, now = Date.now()): { v: number; box: string } {
  return { v: LINK_VERSION, box: seal(toNode(keys), Buffer.from(JSON.stringify({ path, t: now, body: body ?? {} })), 'request') };
}

/** Requests already taken, by id, so the same one sent again is refused. */
export class Seen {
  private ids = new Map<string, number>();
  take(id: string, now = Date.now()): boolean {
    for (const [k, t] of this.ids) if (now - t > LINK_WINDOW_MS * 2) this.ids.delete(k);
    if (this.ids.has(id)) return false;
    this.ids.set(id, now);
    return true;
  }
}

/** The node opens a request: right key, right door, in time, not seen before. */
export function openRequest(keys: Buffer, raw: Record<string, unknown>, path: string, seen: Seen, now = Date.now()): { body: Record<string, unknown>; id: string } | { error: string } {
  const box = typeof raw.box === 'string' ? raw.box : '';
  const plain = box ? open(toNode(keys), box, 'request') : null;
  if (!plain) return { error: 'a message on the link could not be opened (changed on the way, or from a PC linked before). Link this PC again from the main PC.' };
  let x: { path?: unknown; t?: unknown; body?: unknown };
  try {
    x = JSON.parse(plain.toString());
  } catch {
    return { error: 'a message on the link was not in the expected form.' };
  }
  if (x.path !== path) return { error: 'a message on the link was sent to the wrong door, so it was refused.' };
  const t = Number(x.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > LINK_WINDOW_MS) return { error: 'the clocks on the two PCs differ by more than 15 minutes, or the message is an old copy. Set both clocks to the right time (Windows: Settings > Time > Sync now).' };
  const id = requestId(box);
  if (!seen.take(id, now)) return { error: 'that message was already taken once, so the copy was refused.' };
  return { body: x.body && typeof x.body === 'object' ? (x.body as Record<string, unknown>) : {}, id };
}

/** An answer (JSON) or one event of a stream, tied to its request and its place in the stream. */
export const sealAnswer = (keys: Buffer, id: string, n: number, value: unknown) => seal(toHost(keys), Buffer.from(JSON.stringify(value)), `answer|${id}|${n}`);
export function openAnswer(keys: Buffer, id: string, n: number, box: unknown): unknown {
  const plain = typeof box === 'string' ? open(toHost(keys), box, `answer|${id}|${n}`) : null;
  if (!plain) throw new Error('an answer on the link could not be opened (changed on the way, or out of order), so it was refused.');
  return JSON.parse(plain.toString());
}

/** One sealed event of a stream, as written on the wire: its name and data are inside the box. */
export const sealedEvent = (keys: Buffer, id: string, n: number, event: string, data: unknown) => `event: e\ndata: ${JSON.stringify({ box: sealAnswer(keys, id, n, { event, data }) })}\n\n`;

/**
 * The host's side of a stream: the sealed events are opened in order and passed on as plain ones, so the readers
 * (share.readStream, the picture reader) stay as they are. Anything that does not open ends the stream with an error.
 */
export function openStream(keys: Buffer, id: string, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';
  let n = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        // A comment line ("still working") carries nothing: passed on so the reader's clock starts again.
        if (block.startsWith(':')) {
          out.enqueue(enc.encode(`${block}\n\n`));
          continue;
        }
        let ev: { event?: unknown; data?: unknown };
        try {
          const raw = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as { box?: unknown };
          ev = openAnswer(keys, id, ++n, raw.box) as typeof ev;
        } catch (e) {
          out.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ text: (e as Error).message })}\n\n`));
          return out.terminate();
        }
        out.enqueue(enc.encode(`event: ${String(ev.event).replace(/\W/g, '')}\ndata: ${JSON.stringify(ev.data ?? {})}\n\n`));
      }
    },
  }));
}

/** Link keys as kept in a settings file, and back (null when missing or not 64 bytes). */
export const keysText = (keys: Buffer) => b64(keys);

/**
 * Linking again from a PC already linked: it proves it holds the old link's keys by sealing the new ask's public key
 * with them. Only then does the new link take over the old one (and its restore points); a PC that only knows the
 * setup code and the old PC's id gets a link of its own, beside it.
 */
export const takeOverProof = (oldKeys: Buffer, pub: string) => seal(toNode(oldKeys), Buffer.from(`take-over|${pub}`), 'take-over');
export function takeOverProven(oldKeys: Buffer, pub: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false;
  return open(toNode(oldKeys), proof, 'take-over')?.toString() === `take-over|${pub}`;
}
export function keysOf(text: unknown): Buffer | null {
  const k = unb64(text);
  return k.length === 64 ? k : null;
}
