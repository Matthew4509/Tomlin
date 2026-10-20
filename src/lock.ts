// The PIN helpers the app lock (src/applock.ts) uses. The PIN is kept only as a salted scrypt hash, with the cost it was
// made at kept beside it (a file from before 2.0.56 has none: scrypt's default then, made again at the next right PIN).
// Async: at this cost a check takes about half a second, which must not hold up the server (a node streams answers).
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt's N for a new PIN hash: 8 times its default, so each guess made from a copied file costs that much more. */
export const PIN_COST = 2 ** 17;
const OLD_COST = 2 ** 14;

/** 4 to 12 digits, spaces taken out; anything else is null. */
export function cleanPin(v: unknown): string | null {
  const s = String(v ?? '').replace(/\s+/g, '');
  return /^\d{4,12}$/.test(s) ? s : null;
}

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

/** Made at a lower cost than new ones: made again once the right PIN is typed. */
export const needsRehash = (file: { salt: string; hash: string; cost?: number }) => (file.cost ?? OLD_COST) < PIN_COST;
