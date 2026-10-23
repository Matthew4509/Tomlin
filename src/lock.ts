// The PIN and password helpers the app lock (src/applock.ts) uses. Either is kept only as a salted scrypt hash, with the cost it was
// made at kept beside it (a file from before 2.0.56 has none: scrypt's default then, made again at the next right PIN).
// Async: at this cost a check takes about half a second, which must not hold up the server (a node streams answers).
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { WORDS } from './words.ts';

export { WORDS };

/** scrypt's N for a new PIN hash: 8 times its default, so each guess made from a copied file costs that much more. */
export const PIN_COST = 2 ** 17;
const OLD_COST = 2 ** 14;

/** 4 to 12 digits, spaces taken out; anything else is null. */
export function cleanPin(v: unknown): string | null {
  const s = String(v ?? '').replace(/\s+/g, '');
  return /^\d{4,12}$/.test(s) ? s : null;
}

/** What opens the app lock, chosen by the person (A1): a PIN (a number pad) or a password (a text box). */
export type LockKind = 'pin' | 'password';
/** A file from before A1 has no kind: it is a PIN. */
export const cleanKind = (v: unknown): LockKind => (v === 'password' ? 'password' : 'pin');
/** Longer than any password anyone types; the request body is small anyway. */
const PASSWORD_MAX = 256;

/** A PIN by its rules (cleanPin); a password of any length from 1 (kept as typed, spaces too); anything else is null. */
export function cleanSecret(kind: LockKind, v: unknown): string | null {
  if (kind === 'pin') return cleanPin(v);
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  return s.length >= 1 && s.length <= PASSWORD_MAX ? s : null;
}

const COMMON = new Set(['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'abc123', 'football', 'baseball', 'sunshine', 'princess', 'tomlin', 'shelby']);

/**
 * The strength line under a new password: a rough guess of how many tries it takes (its length times the kinds of
 * characters in it), with well-known ones and ones of 3 different characters or fewer always weak. Nothing is refused.
 */
export function strength(pw: string): 'weak' | 'OK' | 'strong' {
  if (COMMON.has(pw.toLowerCase()) || (/^\d+$/.test(pw) && pw.length < 12) || new Set(pw).size <= 3) return 'weak';
  const pool = (/[a-z]/.test(pw) ? 26 : 0) + (/[A-Z]/.test(pw) ? 26 : 0) + (/\d/.test(pw) ? 10 : 0) + (/[^a-zA-Z\d]/.test(pw) ? 33 : 0);
  const bits = [...pw].length * Math.log2(pool);
  return bits < 40 ? 'weak' : bits < 75 ? 'OK' : 'strong';
}

/** Generate: `n` plain words picked at random, with spaces (4 for a password; 5 for a backup passphrase, A5). */
export const generateWords = (n = 4) => Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]).join(' ');

/** Only a power of two from scrypt's default to 2^20 is used as a cost; anything else in a file is not. */
const sane = (n: number) => Number.isInteger(n) && n >= OLD_COST && n <= 2 ** 20 && (n & (n - 1)) === 0;

const derive = (pin: string, salt: string, cost: number) => new Promise<Buffer>((resolve, reject) =>
  scrypt(pin, salt, 32, { N: cost, r: 8, p: 1, maxmem: 256 * 2 ** 20 }, (e, key) => (e ? reject(e) : resolve(key))));

export async function hashPin(pin: string, salt = randomBytes(16).toString('hex')): Promise<{ salt: string; hash: string; cost: number }> {
  return { salt, hash: (await derive(pin, salt, PIN_COST)).toString('hex'), cost: PIN_COST };
}

export async function pinMatches(pin: string, file: { salt: string; hash: string; cost?: number }): Promise<boolean> {
  const cost = file.cost ?? OLD_COST;
  if (!sane(cost)) return false;
  const a = await derive(pin, file.salt, cost);
  const b = Buffer.from(file.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The same helpers under the names A1 uses: a PIN and a password are hashed and checked alike. */
export const hashSecret = hashPin;
export const secretMatches = pinMatches;

/** Made at a lower cost than new ones: made again once the right PIN is typed. */
export const needsRehash = (file: { salt: string; hash: string; cost?: number }) => (file.cost ?? OLD_COST) < PIN_COST;
