// A2: recovery codes for the app lock. 10 codes, XXXXX-XXXXX, from 31 letters and digits that cannot be misread (no 0,
// O, 1, I or L): about 50 bits each. They are shown once; data/recovery-codes.json keeps only a salted scrypt hash of
// each, with when it was used. A code works once: on the lock screen it sets a new PIN or password. A new set voids the
// old one. Later slices (A3-A5) use the same codes for backups on a linked PC.
//
// The cost is scrypt's default (2^14), not the lock's 2^17 (src/lock.ts): a code is 50 random bits, not something a
// person chose, so a copied file is out of reach either way, and a try has to check up to 10 hashes in turn.
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_COUNT = 10;
export const CODES_FILE = 'recovery-codes.json';
const CODE_COST = 2 ** 14;

export interface CodeHash {
  salt: string;
  hash: string;
  cost: number;
  /** When it was used (ISO), or null while it still works. */
  used: string | null;
}
export interface CodesFile {
  made: string;
  codes: CodeHash[];
}

/** A fresh set of 10, each XXXXX-XXXXX, none the same. */
export function makeCodes(): string[] {
  const out = new Set<string>();
  while (out.size < CODE_COUNT) {
    const s = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    out.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...out];
}

/** A code as typed (either case, with or without its dash, spaces) as its 10 characters; anything else is null. */
export function cleanCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.toUpperCase().replace(/[\s-]+/g, '');
  return s.length === 10 && [...s].every(c => CODE_ALPHABET.includes(c)) ? s : null;
}

const derive = (code: string, salt: string, cost: number) => new Promise<Buffer>((resolve, reject) =>
  scrypt(code, salt, 32, { N: cost, r: 8, p: 1, maxmem: 64 * 2 ** 20 }, (e, key) => (e ? reject(e) : resolve(key))));

const sane = (n: number) => Number.isInteger(n) && n >= CODE_COST && n <= 2 ** 20 && (n & (n - 1)) === 0;

async function matches(code: string, h: CodeHash): Promise<boolean> {
  if (!sane(h.cost)) return false;
  const a = await derive(code, h.salt, h.cost);
  const b = Buffer.from(h.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The file for a set: each code hashed with a salt of its own. */
export async function hashCodes(codes: string[]): Promise<CodesFile> {
  const out: CodeHash[] = [];
  for (const c of codes) {
    const salt = randomBytes(16).toString('hex');
    out.push({ salt, hash: (await derive(cleanCode(c)!, salt, CODE_COST)).toString('hex'), cost: CODE_COST, used: null });
  }
  return { made: new Date().toISOString(), codes: out };
}

export const codesLeft = (f: CodesFile) => f.codes.filter(c => !c.used).length;

/** A file read from disk as a set, or null when it is not one (damaged or doctored). */
export function cleanCodesFile(f: unknown): CodesFile | null {
  const o = f as Partial<CodesFile> | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.codes) || !o.codes.length) return null;
  const codes: CodeHash[] = [];
  for (const c of o.codes as Partial<CodeHash>[]) {
    if (!c || typeof c.salt !== 'string' || typeof c.hash !== 'string' || typeof c.cost !== 'number') return null;
    codes.push({ salt: c.salt, hash: c.hash, cost: c.cost, used: typeof c.used === 'string' ? c.used : null });
  }
  return { made: typeof o.made === 'string' ? o.made : '', codes };
}

/**
 * The set in use. `use` checks one code at a time (two tries sent at once wait for each other), so a code can never
 * be used twice; the use is saved before it counts, and when it cannot be saved the code does not open anything.
 */
export class RecoveryCodes {
  private chain: Promise<unknown> = Promise.resolve();
  file: CodesFile;
  private save: (f: CodesFile) => Promise<void>;
  constructor(file: CodesFile, save: (f: CodesFile) => Promise<void>) {
    this.file = file;
    this.save = save;
  }

  left(): number {
    return codesLeft(this.file);
  }

  /** The index of the unused code this is, or -1. */
  private async find(v: unknown): Promise<number> {
    const code = cleanCode(v);
    if (!code) return -1;
    for (let i = 0; i < this.file.codes.length; i++) if (!this.file.codes[i].used && (await matches(code, this.file.codes[i]))) return i;
    return -1;
  }

  /** True for an unused code of this set, without using it. */
  check(v: unknown): Promise<boolean> {
    const next = this.chain.then(() => this.find(v)).then(i => i >= 0);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** True once for each code of this set: it is crossed off (and saved) before this answers. */
  use(v: unknown): Promise<boolean> {
    const next = this.chain.then(async () => {
      const i = await this.find(v);
      if (i < 0) return false;
      const file = { ...this.file, codes: this.file.codes.map((c, j) => (j === i ? { ...c, used: new Date().toISOString() } : c)) };
      await this.save(file);
      this.file = file;
      return true;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A new set: the old codes no longer work. */
  replace(file: CodesFile): void {
    this.file = file;
  }
}
