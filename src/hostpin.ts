// The host PIN: one PIN (or password) typed on the main PC that updates, turns off or deletes a model on every linked PC
// that holds it, so one PIN typed there updates them all. The main PC proves itself once to each PC with that PC's own
// app lock PIN, and in the same sealed request gives it the host PIN. The PC keeps only a salted scrypt hash of it
// (src/lock.ts), under the link's own id (its token's fingerprint): it opens nothing for any other link, and a guest can
// never set or use one. The PC's own PIN keeps working as before, and its owner sees and can take away each host PIN.
// Wrong PINs typed on other PCs (the PC's own or a host PIN) are counted in a file, so a restart does not forget them,
// and the wait grows each time the same link is stopped again (10 minutes, 1 hour, 6 hours, 24 hours) until a right one.
// Since 2.1.1 the host does not need a typed host PIN: it makes a random host key (HostKey, below) and gives it the same way
// (a held "host PIN" whose secret is the key; `keyId` marks it), and uses it only while its own app lock is open, so
// unlocking the host is the admin step. Since 2.1.31 the admin PC sets no typed host PIN and the key has no off switch;
// a PC still takes a typed one an older admin PC gave it, until its owner takes it away there.
// The plain parts, tested in test/hostpin.test.ts; wired in src/server/locks.ts (the PC that holds one) and
// src/jobrun/hostpins.ts (the main PC that sets one).
import { createHash, randomBytes } from 'node:crypto';
import { cleanKind, cleanSecret, hashSecret, secretMatches, type LockKind } from './lock.ts';

/** The host-only doors of a PC: take a host PIN from this link (with the PC's own PIN), and take it away. */
export const SET_DOOR = '/worker/host-pin-set';
export const DROP_DOOR = '/worker/host-pin-drop';
/** In a PC's hello "can" list: it takes a host PIN. An older PC does not say it and is asked its own PIN as before. */
export const CAN = 'host-pin';
/** On a PC: the host PINs it holds, by link. */
export const HELD_FILE = 'host-pins.json';
/** On a PC: wrong PINs typed for it on other PCs, kept over a restart. */
export const TRIES_FILE = 'pin-tries.json';
/** On the main PC: its host key (kept whole: it has to be sent). An `{ off: true }` from before 2.1.31 reads as none. */
export const KEY_FILE = 'host-key.json';

/** Shortest host PIN or password: one secret opens every PC, so it is longer than the app lock's 4 digits. */
export const MIN_LENGTH = 6;
export const RULE_WORDS = 'Use 6 to 12 digits for the host PIN (numbers only), or a password of 6 characters or more.';

/** A host PIN by the app lock's rules for its kind, but never shorter than 6 (digits or characters); else null. */
export function cleanHostSecret(kind: LockKind, v: unknown): string | null {
  const s = cleanSecret(kind, v);
  return s && [...s].length >= MIN_LENGTH ? s : null;
}

/** "10 minutes", "1 hour", "6 hours": a wait in minutes, as said on screen. */
export function waitWords(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.ceil(minutes / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

// ---- Wrong tries kept on disk ----

/** Tries this close together count toward a stop. */
export const TRY_WINDOW = 10 * 60_000;
/** Wrong tries from one link before it is stopped, and from all links before every link is. */
export const PER_LINK = 5;
export const ALL_LINKS = 20;
/** Each stop of the same link waits longer than the one before (minutes), until a right PIN starts it again at the first. */
export const WAITS = [10, 60, 6 * 60, 24 * 60];
/** Links kept in the file at most (each link that ever typed a wrong one; the newest are kept). */
const MAX_KEPT = 500;

interface LinkTries {
  /** Wrong tries since the last stop, newest last (ms). */
  tries: number[];
  /** How many times this link has been stopped since its last right PIN. */
  level: number;
  /** Stopped until then (ms); 0 when not stopped. */
  until: number;
}
export interface TriesFile {
  links: Record<string, LinkTries>;
  all: number[];
  allUntil: number;
}

const times = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isFinite(x) && x > 0).slice(-ALL_LINKS) : []);
const num = (v: unknown): number => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0);

/** The file as read, with anything that is not as written left out. */
export function cleanTries(raw: unknown): TriesFile {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const links: Record<string, LinkTries> = {};
  const list = f.links && typeof f.links === 'object' ? (f.links as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(list)) {
    if (!v || typeof v !== 'object' || k.length > 128) continue;
    const e = v as Record<string, unknown>;
    links[k] = { tries: times(e.tries), level: Math.min(WAITS.length * 4, Math.floor(num(e.level))), until: num(e.until) };
  }
  return { links, all: times(f.all), allUntil: num(f.allUntil) };
}

/**
 * Wrong PINs typed on other PCs, by link: 5 in 10 minutes stop that link (10 minutes the first time, then 1 hour, 6 hours,
 * 24 hours), 20 from all links stop every link for 10 minutes. A right PIN clears that link. Every change is written
 * before the PIN is checked, so a restart (or a crash) in the middle never gives tries back.
 */
export class TryGuard {
  private f: TriesFile;
  private save: (f: TriesFile) => Promise<void>;
  private now: () => number;
  constructor(raw: unknown, save: (f: TriesFile) => Promise<void>, now = () => Date.now()) {
    this.f = cleanTries(raw);
    this.save = save;
    this.now = now;
    this.sane(now());
  }
  private async write(): Promise<void> {
    try {
      await this.save(this.f);
    } catch (e) {
      console.log(`The count of wrong PINs could not be saved (${(e as Error).message}); it is still kept until TOMLIN closes.`);
    }
  }
  /**
   * A wait or a try dated after `t` was written while the clock was ahead (or the file came from another PC): a wait is
   * cut to the longest one from now, once, so it then runs out; such a try counts as made now. Without this a clock set
   * back by years kept a link stopped for years.
   */
  private settle(t: number): void {
    const longest = t + WAITS[WAITS.length - 1] * 60_000;
    for (const e of Object.values(this.f.links)) {
      if (e.until > longest) e.until = longest;
      e.tries = e.tries.map(x => Math.min(x, t));
    }
    if (this.f.allUntil > t + TRY_WINDOW) this.f.allUntil = t + TRY_WINDOW;
    this.f.all = this.f.all.map(x => Math.min(x, t));
  }

  /** The same step under the other name the reliability work used. */
  private sane(t: number): void {
    this.settle(t);
  }
  /** Minutes until this link may try again, or 0. */
  lockedFor(key: string): number {
    const t = this.now();
    this.settle(t);
    const until = this.f.links[key]?.until ?? 0;
    return until > t ? Math.ceil((until - t) / 60_000) : 0;
  }
  /** Minutes until any link may try again after 20 wrong tries from all of them, or 0. */
  pausedFor(): number {
    const t = this.now();
    this.settle(t);
    const until = this.f.allUntil;
    return until > t ? Math.ceil((until - t) / 60_000) : 0;
  }
  /** How many times this link has been stopped since its last right PIN. */
  level(key: string): number {
    return this.f.links[key]?.level ?? 0;
  }
  /** One try, counted before it is checked (a right one is cleared with `right`). */
  async wrong(key: string): Promise<void> {
    const t = this.now();
    this.settle(t);
    const e = this.f.links[key] ?? { tries: [], level: 0, until: 0 };
    e.tries = [...e.tries.filter(x => t - x < TRY_WINDOW && x >= e.until), t];
    if (e.tries.length >= PER_LINK) {
      e.level += 1;
      e.until = t + WAITS[Math.min(e.level, WAITS.length) - 1] * 60_000;
      e.tries = [];
    }
    this.f.links[key] = e;
    this.f.all = [...this.f.all.filter(x => t - x < TRY_WINDOW && x >= this.f.allUntil), t];
    if (this.f.all.length >= ALL_LINKS) {
      this.f.allUntil = t + TRY_WINDOW;
      this.f.all = [];
    }
    this.tidy(t);
    await this.write();
  }
  /** A right PIN from this link: its count and its longer waits start again. */
  async right(key: string): Promise<void> {
    if (!(key in this.f.links)) return;
    delete this.f.links[key];
    await this.write();
  }
  /** Links with nothing left to remember go; past MAX_KEPT, the ones heard from longest ago go. */
  private tidy(t: number): void {
    const last = (e: LinkTries) => Math.max(e.until, e.tries.at(-1) ?? 0);
    for (const [k, e] of Object.entries(this.f.links)) if (!e.level && e.until <= t && !e.tries.some(x => t - x < TRY_WINDOW)) delete this.f.links[k];
    const keys = Object.keys(this.f.links);
    if (keys.length > MAX_KEPT) for (const k of keys.sort((a, b) => last(this.f.links[a]) - last(this.f.links[b])).slice(0, keys.length - MAX_KEPT)) delete this.f.links[k];
  }
}

// ---- The host PINs a PC holds ----

export interface HeldPin {
  kind: LockKind;
  salt: string;
  hash: string;
  cost?: number;
  /** The host's name when it set it, and when. */
  name: string;
  at: string;
  /** Set when the secret is a host's random key (its short id, never secret): shown as a key, not a PIN. */
  keyId?: string;
}

const isLink = (s: string) => /^[0-9a-f]{64}$/.test(s);
export const isKeyId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{12}$/.test(v);

/** The file as read: by link (64 hex characters), each with its hash. */
export function cleanHeld(raw: unknown): Record<string, HeldPin> {
  const out: Record<string, HeldPin> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isLink(k) || !v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    if (typeof e.salt !== 'string' || typeof e.hash !== 'string') continue;
    out[k] = { kind: cleanKind(e.kind), salt: e.salt, hash: e.hash, ...(typeof e.cost === 'number' ? { cost: e.cost } : {}), name: String(e.name ?? '').slice(0, 40), at: typeof e.at === 'string' ? e.at : '', ...(isKeyId(e.keyId) ? { keyId: e.keyId } : {}) };
  }
  return out;
}

/** The host PINs this PC holds, one per link at most, kept as hashes only. */
export class HostPins {
  private held: Record<string, HeldPin>;
  private save: (f: Record<string, HeldPin>) => Promise<void>;
  constructor(raw: unknown, save: (f: Record<string, HeldPin>) => Promise<void>) {
    this.held = cleanHeld(raw);
    this.save = save;
  }
  get(link: string | undefined): HeldPin | null {
    return link && isLink(link) ? this.held[link] ?? null : null;
  }
  /** Kept for `link` in place of any it had; written before it is used. */
  async set(link: string, name: string, kind: LockKind, secret: string, at = new Date().toISOString(), keyId?: string): Promise<void> {
    if (!isLink(link)) throw new Error('that link has no id, so it cannot hold a host PIN.');
    const next = { ...this.held, [link]: { kind, ...(await hashSecret(secret)), name: name.slice(0, 40), at, ...(keyId ? { keyId } : {}) } };
    await this.save(next);
    this.held = next;
  }
  /** Taken away from one link (by its whole id, or the 12 characters the page shows); true when there was one. */
  async drop(id: string): Promise<boolean> {
    const keys = Object.keys(this.held).filter(k => (id.length === 64 ? k === id : id.length >= 12 && k.startsWith(id)));
    if (!keys.length) return false;
    const next = { ...this.held };
    for (const k of keys) delete next[k];
    await this.save(next);
    this.held = next;
    return true;
  }
  /** The id of the host key this link gave (not secret), or '' when it holds none or a typed PIN. */
  keyIdOf(link: string | undefined): string {
    return this.get(link)?.keyId ?? '';
  }
  /** Who holds one, for this PC's page: by the 12 characters of the link's id the page shows (never the hash). `key`: it is a host key, not a typed PIN. */
  list(): { id: string; name: string; at: string; kind: LockKind; key: boolean }[] {
    return Object.entries(this.held).map(([k, v]) => ({ id: k.slice(0, 12), name: v.name, at: v.at, kind: v.kind, key: !!v.keyId }));
  }
}

// ---- The check, on the PC that is asked ----

/** What the PIN is asked for: an update (false), a model delete (true), a turn-off, taking a host PIN, or a change of its permissions. */
export type Doing = boolean | 'power' | 'host' | 'perms';
export type Checked = { ok: true } | { status: number; error: string };

export interface GateDeps {
  /** The app lock's hash, or null with none. */
  lock: () => { kind?: LockKind; salt: string; hash: string; cost?: number } | null;
  /** The lock's file is damaged (the words to say), or null. */
  damaged: () => string | null;
  guard: TryGuard;
  pins: HostPins;
}

/**
 * This PC's app lock PIN, or the host PIN this link gave it (`host`: what was typed, and the link's id), typed on a linked
 * PC to update it, turn it off, delete a model or give it a host PIN. Only someone who knows one (the PC's admin, not a
 * guest, not a program on the other PC) can. Wrong tries of either kind count together, per link (`who`), on disk. The
 * words go after the PC's name ("Desk PC" says that PIN is wrong).
 */
export async function pinGate(g: GateDeps, v: unknown, who: string, doing: Doing = false, host?: { pin: unknown; link: string | undefined }): Promise<Checked> {
  const broken = g.damaged();
  if (broken) return { status: 409, error: broken };
  const lock = g.lock();
  if (!lock) {
    return { status: 409, error: doing === 'power' ? 'has no app lock, so another PC cannot turn it off: set one there (the padlock, top right), then try again'
      : doing === 'perms' ? 'has no app lock, so another PC cannot change its permissions: set one there (the padlock, top right), then try again'
      : doing === 'host' ? 'has no app lock, so it takes no host PIN: set one there (the padlock, top right), then try again'
      : doing ? 'has no app lock, so it deletes no model for another PC: set one there (the padlock, top right), then try again'
      : 'has no app lock, so it takes no update from another PC: set one there (the padlock, top right), then update it again' };
  }
  const kind = lock.kind ?? 'pin';
  const w = kind === 'password' ? 'password' : 'PIN';
  const wait = g.guard.lockedFor(who) || g.guard.pausedFor();
  if (wait) return { status: 429, error: `had too many wrong ${w}s typed for it: wait ${waitWords(wait)}, then ${doing === false ? 'update it' : 'try'} again` };
  const what = doing === 'power' ? 'turn it off' : doing === 'host' ? 'take a host PIN' : doing === 'perms' ? 'change its permissions' : doing ? 'delete a model' : 'take an update';
  if (host && host.pin !== undefined) {
    const held = g.pins.get(host.link);
    if (!held) return { status: 403, error: `holds no host PIN from this PC: type its own app lock ${w} instead (the one that opens TOMLIN there)` };
    const secret = cleanHostSecret(held.kind, host.pin);
    if (!secret) return { status: 403, error: `asks for the host PIN (or its own app lock ${w}) to ${what}` };
    await g.guard.wrong(who);
    if (!(await secretMatches(secret, held))) return { status: 403, error: `says that host PIN is wrong: type the host PIN again, or its own app lock ${w}` };
    await g.guard.right(who);
    return { ok: true };
  }
  const secret = cleanSecret(kind, v);
  if (!secret) return { status: 403, error: `asks for its app lock ${w} (the one that opens TOMLIN there) to ${what}` };
  await g.guard.wrong(who);
  if (!(await secretMatches(secret, lock))) return { status: 403, error: `says that ${w} is wrong: type the app lock ${w} that opens TOMLIN there` };
  await g.guard.right(who);
  return { ok: true };
}

/**
 * The two host-only doors of a PC. Set: the PC's own PIN (or the host PIN this link holds now, to change it) and the new
 * host PIN, in one sealed request; Drop: this link's host PIN goes (nothing is asked: it only takes away). A guest is
 * refused here too, though it never gets this far (src/guestpass.ts).
 */
export async function hostPinDoor(p: string, b: Record<string, unknown>, who: { key: string; link: string; name: string; guest: boolean }, d: { pcName: () => string; check: (v: unknown, who: string, doing: Doing, host?: { pin: unknown; link: string }) => Promise<Checked>; pins: HostPins }): Promise<{ status: number; json: Record<string, unknown> }> {
  const pc = d.pcName();
  if (who.guest) return { status: 403, json: { error: `a guest cannot hold a host PIN on "${pc}".` } };
  if (p === DROP_DOOR) {
    const dropped = await d.pins.drop(who.link);
    if (dropped) console.log(`"${who.name}" took its host PIN away from this PC.`);
    return { status: 200, json: { ok: true, dropped } };
  }
  if (p !== SET_DOOR) return { status: 404, json: { error: 'this PC does not know that door.' } };
  const kind = cleanKind(b.kind);
  const secret = cleanHostSecret(kind, b.newPin);
  if (!secret) return { status: 400, json: { error: RULE_WORDS } };
  const ok = b.hostPin !== undefined ? await d.check(undefined, who.key, 'host', { pin: b.hostPin, link: who.link }) : await d.check(b.appPin, who.key, 'host');
  if ('error' in ok) return { status: ok.status, json: { error: `"${pc}" ${ok.error}.`, needPin: ok.status === 403 } };
  // A host key says its short id (so the host knows later whether this PC holds the one it has now); a typed PIN says none.
  const keyId = isKeyId(b.keyId) && kind === 'password' ? b.keyId : undefined;
  await d.pins.set(who.link, who.name, kind, secret, undefined, keyId);
  console.log(`"${who.name}" gave this PC its ${keyId ? 'host key' : 'host PIN'}.`);
  return { status: 200, json: { ok: true, said: `"${pc}" holds the ${keyId ? 'host key' : 'host PIN'} now.` } };
}

// ---- The main PC's host key: the admin step is unlocking this PC ----

export interface KeyFile {
  /** The key, base64url of 32 random bytes. */
  key: string;
  at: string;
  /** Made where the owner had turned admin access off before 2.1.31: said once on the Admin PC row until a new key is made. */
  offBefore?: boolean;
}

/** The short id of a key (12 hex of its SHA-256): told to PCs and shown, it gives nothing of the key. */
export const keyIdOf = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 12);

export function cleanKeyFile(raw: unknown): KeyFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  // Before 2.1.31 the owner could turn the key off (`{ off: true }`): there is no switch now, so that reads as no key
  // yet, and one is made the next time a linked PC needs it.
  if (typeof f.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(f.key)) return null;
  return { key: f.key, at: typeof f.at === 'string' ? f.at : '', ...(f.offBefore === true ? { offBefore: true } : {}) };
}

/**
 * The admin PC's key (the "host key"): a random secret made here when the first linked PC needs it, given to each linked
 * PC over its sealed link, and used only while this PC's app lock is open (`open`), so unlocking this PC is the admin
 * step. There is no switch to turn it off (2.1.31): a linked PC's owner takes it away there. It is kept whole in the data
 * folder (it has to be sent): anyone who can read this PC's data folder has it, and that is the trade for typing nothing.
 * Two admin PCs each give their own key, held by link, so either one manages the PCs it is linked to.
 */
export class HostKey {
  private f: KeyFile | null;
  private save: (f: KeyFile) => Promise<void>;
  private open: () => boolean;
  /** The file said `{ off: true }` (turned off before 2.1.31, no key made since). */
  private off: boolean;
  constructor(raw: unknown, save: (f: KeyFile) => Promise<void>, open: () => boolean = () => true) {
    this.f = cleanKeyFile(raw);
    this.off = !this.f && !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).off === true;
    this.save = save;
    this.open = open;
  }
  /** Admin access had been turned off here before there was no switch: the Admin PC row says it is on now (A5). */
  get wasOff(): boolean {
    return this.off || !!this.f?.offBefore;
  }
  /** Made already. */
  get made(): boolean {
    return !!this.f;
  }
  get at(): string {
    return this.f ? this.f.at : '';
  }
  /** Its id (not secret), or '' with none. */
  get id(): string {
    return this.f ? keyIdOf(this.f.key) : '';
  }
  /** The key, made first when there is none; null while this PC's app lock is shut (or not set). */
  async use(): Promise<{ secret: string; id: string } | null> {
    if (!this.open()) return null;
    if (!this.f) await this.reset(undefined, this.off);
    const f = this.f as KeyFile;
    return { secret: f.key, id: keyIdOf(f.key) };
  }
  /** The key as it is now, never made here (null with none or a shut lock). */
  peek(): { secret: string; id: string } | null {
    if (!this.open() || !this.f) return null;
    return { secret: this.f.key, id: keyIdOf(this.f.key) };
  }
  /** A new key in place of any: written first. PCs holding the old one take the new one the next time their PIN is typed. */
  async reset(at = new Date().toISOString(), offBefore = false): Promise<void> {
    const next: KeyFile = { key: randomBytes(32).toString('base64url'), at, ...(offBefore ? { offBefore: true } : {}) };
    await this.save(next);
    this.f = next;
    this.off = false;
  }
}
