// The PIN helpers the app lock (src/applock.ts) uses. The PIN is kept only as a salted scrypt hash.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 4 to 12 digits, spaces taken out; anything else is null. */
export function cleanPin(v: unknown): string | null {
  const s = String(v ?? '').replace(/\s+/g, '');
  return /^\d{4,12}$/.test(s) ? s : null;
}

export function hashPin(pin: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  return { salt, hash: scryptSync(pin, salt, 32).toString('hex') };
}

export function pinMatches(pin: string, file: { salt: string; hash: string }): boolean {
  const a = Buffer.from(hashPin(pin, file.salt).hash, 'hex');
  const b = Buffer.from(file.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
