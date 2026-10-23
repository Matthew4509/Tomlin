// A3 + A4: who a linked PC's backups belong to, kept on the backup PC, and getting them back on a new PC.
//
// A3: the person's PC sends its backup name (2-40 characters, unique on the backup PC) and backup PIN once over the
// encrypted link. The PIN is hashed on the person's PC (scrypt, src/lock.ts), so the backup PC never has it in
// clear; the recovery codes go as their hashes (src/recovery.ts). The backup PC keeps them as owner.json in that PC's
// folder of restore points (src/carry.ts keptFolder).
//
// A4: a new PC, linked to the backup PC (a new, empty folder), asks for the backups by name with the backup PIN or a
// recovery code. A wrong name gets the same answer as a wrong PIN. A right one waits for the backup PC's owner
// (Allow / Don't allow, 7 days); Allow points the new link at the old folder and removes the old link.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.ts';
import { cleanPin, hashSecret, secretMatches } from './lock.ts';
import { RecoveryCodes, hashCodes, makeCodes, type CodeHash } from './recovery.ts';

export const OWNER_FILE = 'owner.json';
/** How long a claim waits for the backup PC's owner. */
export const CLAIM_DAYS = 7;
/** A backup PIN checked against the screen PIN (the "same as your screen PIN" nudge): this many times in 10 minutes (share.PinGuard's limit). */
export const NUDGE_CHECKS = 5;
const DAY = 86_400_000;

/** 2 to 40 characters of free text (spaces tidied), no control characters; anything else is null. */
export function cleanBackupName(v: unknown): string | null {
  if (typeof v !== 'string' || /[\u0000-\u001f\u007f]/.test(v)) return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return [...s].length >= 2 && [...s].length <= 40 ? s : null;
}

/** A name as it is compared: "Kid 1" and "kid  1" are the same name. */
export const nameKey = (name: string) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export interface PinHash {
  salt: string;
  hash: string;
  cost: number;
}
export interface OwnerFile {
  name: string;
  /** The backup PIN, hashed on the person's PC. */
  pin: PinHash;
  /** The person's recovery codes, as their hashes (each crossed off once used, on either PC). */
  codes: CodeHash[];
  at: string;
}

const hex = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max && /^[0-9a-f]+$/.test(v);
const costOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 2 ** 14 && (v as number) <= 2 ** 20;

export function cleanPinHash(v: unknown): PinHash | null {
  const o = v as Partial<PinHash> | null;
  return o && typeof o === 'object' && hex(o.salt, 8, 64) && hex(o.hash, 64, 64) && costOk(o.cost) ? { salt: o.salt!, hash: o.hash!, cost: o.cost! } : null;
}

/** Up to 20 code hashes; anything else is null. */
export function cleanCodeHashes(v: unknown): CodeHash[] | null {
  if (!Array.isArray(v) || v.length > 20) return null;
  const out: CodeHash[] = [];
  for (const c of v as Partial<CodeHash>[]) {
    if (!c || !hex(c.salt, 8, 64) || !hex(c.hash, 64, 64) || !costOk(c.cost)) return null;
    out.push({ salt: c.salt!, hash: c.hash!, cost: c.cost!, used: typeof c.used === 'string' ? c.used.slice(0, 40) : null });
  }
  return out;
}

export function cleanOwnerFile(v: unknown): OwnerFile | null {
  const o = v as Partial<OwnerFile> | null;
  if (!o || typeof o !== 'object') return null;
  const name = cleanBackupName(o.name);
  const pin = cleanPinHash(o.pin);
  const codes = cleanCodeHashes(o.codes ?? []);
  return name && pin && codes ? { name, pin, codes, at: typeof o.at === 'string' ? o.at : '' } : null;
}

/** The same set sent again: a code used on either PC stays crossed off. Another set takes its place whole. */
export function mergeCodes(old: CodeHash[], next: CodeHash[]): CodeHash[] {
  const used = new Map(old.filter(c => c.used).map(c => [`${c.salt}|${c.hash}`, c.used]));
  return next.map(c => (c.used ? c : used.has(`${c.salt}|${c.hash}`) ? { ...c, used: used.get(`${c.salt}|${c.hash}`)! } : c));
}

/** Every folder under `root` with an owner.json that reads as one. */
export async function readOwners(root: string): Promise<{ keep: string; file: OwnerFile }[]> {
  const out: { keep: string; file: OwnerFile }[] = [];
  for (const keep of await readdir(root).catch(() => [] as string[])) {
    try {
      const file = cleanOwnerFile(JSON.parse(await readFile(join(root, keep, OWNER_FILE), 'utf8')));
      if (file) out.push({ keep, file });
    } catch {
      // none, or damaged: that folder has no owner
    }
  }
  return out;
}

export async function writeOwnerFile(dir: string, file: OwnerFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, OWNER_FILE), JSON.stringify(file, null, 1));
}

/** The name is another folder's on this backup PC (its own folder may keep it). */
export const nameTaken = (owners: { keep: string; file: OwnerFile }[], name: string, keep: string) => owners.some(o => o.keep !== keep && nameKey(o.file.name) === nameKey(name));

/** Made once: checked against when the name is not here, so a wrong name takes as long as a wrong PIN or code. */
let dummy: Promise<PinHash> | null = null;
let dummyCodes: Promise<CodeHash[]> | null = null;

/**
 * A claim's name with its backup PIN or one recovery code. The folder and its name when right; null for a wrong name,
 * a wrong PIN or a used code alike. A code that is right is crossed off (saved through `save`) before this answers.
 */
export async function checkClaim(owners: { keep: string; file: OwnerFile }[], nameIn: unknown, secret: { pin?: unknown; code?: unknown }, save: (keep: string, file: OwnerFile) => Promise<void>): Promise<{ keep: string; name: string } | null> {
  const name = cleanBackupName(nameIn);
  const found = name ? owners.find(o => nameKey(o.file.name) === nameKey(name)) : undefined;
  if (secret.code !== undefined && secret.code !== '') {
    const codes = found?.file.codes ?? (await (dummyCodes ??= hashCodes(makeCodes()).then(f => f.codes)));
    const set = new RecoveryCodes({ made: '', codes }, f => (found ? save(found.keep, { ...found.file, codes: f.codes }) : Promise.resolve()));
    return (await set.use(secret.code)) && found ? { keep: found.keep, name: found.file.name } : null;
  }
  const pin = cleanPin(secret.pin);
  if (!pin) return null;
  const ok = await secretMatches(pin, found?.file.pin ?? (await (dummy ??= hashSecret('0000'))));
  return ok && found ? { keep: found.keep, name: found.file.name } : null;
}

// ---- Claims waiting for the backup PC's owner ----

export interface Claim {
  id: string;
  /** The backup name it was made with. */
  name: string;
  /** The folder of restore points it asks for. */
  oldKeep: string;
  /** The new PC's link (its token's fingerprint). */
  newHash: string;
  /** The new PC's name, as it linked. */
  pc: string;
  /** When the new PC linked. */
  linkedAt: string;
  /** Its address (Don't allow counts as a wrong try from there). */
  ip: string;
  at: string;
  state: 'waiting' | 'allowed' | 'denied';
  answeredAt?: string;
}

export function claimState(c: Claim, now = Date.now()): Claim['state'] | 'expired' {
  return c.state === 'waiting' && now - Date.parse(c.at) > CLAIM_DAYS * DAY ? 'expired' : c.state;
}

export function cleanClaims(v: unknown): Claim[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is Claim => !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.oldKeep === 'string' && typeof c.newHash === 'string' && typeof c.name === 'string' && ['waiting', 'allowed', 'denied'].includes(c.state));
}

/**
 * Allow: the new link keeps its restore points in the old folder; every other link to that folder (the lost PC) is
 * removed, so it can no longer reach them.
 */
export function allowClaim<T extends { hash: string; keep?: string }>(paired: T[], c: Claim, keepOf: (x: T) => string): T[] | { error: string } {
  const next = paired.find(x => x.hash === c.newHash);
  if (!next) return { error: `"${c.pc}" is no longer linked to this PC, so there is nothing to allow. It can link again and ask again.` };
  return paired.filter(x => x === next || keepOf(x) !== c.oldKeep).map(x => (x === next ? { ...x, keep: c.oldKeep } : x));
}
