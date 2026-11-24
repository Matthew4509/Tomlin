// The admin key (Bootable USB, Settings): an Ed25519 key pair made once on the admin PC. Its private half never leaves
// that PC: it is kept in usb.json (never in a restore point sent to another PC, src/keep.ts) and is never written onto a
// stick. Each stick Mint writes gets an identity of its own instead: a fresh Ed25519 key pair and an id, with the
// admin's PUBLIC key beside them. So no two sticks are the same, and a stick carries nothing that lets anyone link to
// it or to the other sticks:
// - A stick node links only to a PC that signs the link request with the admin's private key (src/link.ts adminNodeAnswer).
// - The admin PC links only to a stick on its own list (usb.json `sticks`), proven by that stick's own key, and never to
//   one marked lost.
// Lose the admin PC: make a new admin key on another PC and mint every stick again (one admin per stick; a new mint
// replaces the old admin). The tag in a node's whoami is a hash of the admin's public key: it names the admin, nothing more.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

/** A key pair as kept: the public half (32 bytes) and the private half (PKCS#8), both base64url. */
export interface KeyPair {
  pub: string;
  priv: string;
}

/** A stick's identity: its id (16 hex), and its own key pair. */
export interface StickIdentity extends KeyPair {
  id: string;
}

const PUB = /^[\w-]{43}$/;
const PRIV = /^[\w-]{40,120}$/;
const STICK_ID = /^[0-9a-f]{16}$/;

/** How many sticks one admin keeps on its list: the page says so, and the scan's Add all stops there. */
export const KEY_PCS = 1000;

/** A fresh Ed25519 key pair. */
export function newPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: String(publicKey.export({ format: 'jwk' }).x), priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') };
}

/** A new admin key. */
export const newAdminKey = newPair;

/** A new stick's identity: an id and a key pair of its own. */
export function newStick(): StickIdentity {
  return { id: randomBytes(8).toString('hex'), ...newPair() };
}

export const cleanPub = (x: unknown): string => (typeof x === 'string' && PUB.test(x) ? x : '');
export const cleanStickId = (x: unknown): string => (typeof x === 'string' && STICK_ID.test(x) ? x : '');

/** A kept key pair made safe: null when either half is not one (or the halves do not belong together). */
export function cleanPair(raw: unknown): KeyPair | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pub = cleanPub(o.pub);
  if (!pub || typeof o.priv !== 'string' || !PRIV.test(o.priv)) return null;
  try {
    const back = createPublicKey(createPrivateKey({ key: Buffer.from(o.priv, 'base64url'), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
    return back === pub ? { pub, priv: o.priv } : null;
  } catch {
    return null;
  }
}

/** A stick identity made safe, or null. */
export function cleanIdentity(raw: unknown): StickIdentity | null {
  const id = cleanStickId((raw as { id?: unknown } | null)?.id);
  const pair = cleanPair(raw);
  return id && pair ? { id, ...pair } : null;
}

/** Signs `words` with a private key (base64url signature). */
export function signWith(priv: string, words: string): string {
  return sign(null, Buffer.from(words), createPrivateKey({ key: Buffer.from(priv, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
}

/** Whether `sig` is the signature of `words` by the key whose public half is `pub`. Never throws. */
export function signedBy(pub: string, words: string, sig: unknown): boolean {
  if (!cleanPub(pub) || typeof sig !== 'string' || !/^[\w-]{86}$/.test(sig)) return false;
  try {
    return verify(null, Buffer.from(words), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

/** The public tag: 8 hex characters from the admin's public key, the same on every node minted by that admin. */
export function keyTag(pub: string): string {
  const p = cleanPub(pub);
  return p ? createHash('sha256').update(`tomlin admin tag v2|${p}`).digest('hex').slice(0, 8) : '';
}

/** A stick's id for people: 4-4-4-4. */
export const showId = (id: string) => id.match(/.{1,4}/g)?.join('-') ?? id;
