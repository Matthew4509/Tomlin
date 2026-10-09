// The app lock: an optional PIN for the whole of TOMLIN. Off until a PIN is set (data/app-lock.json, a salted
// scrypt hash, src/lock.ts). While it is locked the SERVER refuses every /api call and the
// /v1 door, so another tab, browser or program on this PC cannot read the chats either; only the page's own files and
// the lock's own door answer. Open is a random token in a cookie, one per browser, kept only in this process's memory:
// a restart of TOMLIN, or a browser closed and opened again, starts locked. A lock, not a safe: the files on
// disk are not encrypted, and deleting data/app-lock.json while TOMLIN is closed takes the PIN away.
// Linked PCs talk to the worker door (src/jobrun/node.ts, its own port and tokens), which this lock does not touch.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const APP_COOKIE = 'sm_app';
export const APP_LOCK_FILE = 'app-lock.json';
/** Lock by itself after this many minutes with nothing done in the page; 0 = never. */
export const APP_IDLE_CHOICES = [0, 5, 10, 15, 30, 60] as const;
export const DEFAULT_APP_IDLE = 0;

export interface AppLockFile {
  salt: string;
  hash: string;
  idleMinutes: number;
}

export const cleanAppIdle = (v: unknown): number => (APP_IDLE_CHOICES as readonly number[]).includes(Number(v)) ? Number(v) : DEFAULT_APP_IDLE;

/** The named cookie's value in a request's Cookie header, if any. */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

/**
 * What may pass while the app is locked (or for a browser that has not opened it):
 * - 'open': the page's own files (no chats in them) and the lock's own door;
 * - 'door': the /v1 door for programs on this PC, which passes only while some browser has the app open;
 * - 'shut': everything else.
 */
export function gateOf(path: string): 'open' | 'door' | 'shut' {
  if (path === '/api/applock') return 'open';
  // The live preview's frame sends no cookie (it has no origin of its own): its key, given out behind the lock, is its pass.
  if (path.startsWith('/preview/')) return 'open';
  if (path === '/v1' || path.startsWith('/v1/')) return 'door';
  if (path === '/api' || path.startsWith('/api/')) return 'shut';
  return path === '/' || /^\/[\w.-]+$/.test(path) ? 'open' : 'shut';
}

export class AppLock {
  private tokens = new Set<string>();
  private lastActive = 0;
  private now: () => number;
  idleMinutes = DEFAULT_APP_IDLE;

  constructor(now = () => Date.now()) {
    this.now = now;
  }

  /** Opens it for one browser; the token goes in that browser's cookie. */
  open(): string {
    this.idleCheck();
    const token = randomBytes(24).toString('hex');
    this.tokens.add(token);
    this.lastActive = this.now();
    return token;
  }

  /** Locks every browser when nothing has been done for longer than the setting. */
  private idleCheck(): void {
    if (this.idleMinutes > 0 && this.tokens.size && this.now() - this.lastActive > this.idleMinutes * 60_000) this.tokens.clear();
  }

  /** Some browser has it open. */
  isOpen(): boolean {
    this.idleCheck();
    return this.tokens.size > 0;
  }

  /** True for a token of an open browser. Only `touch` (something done in the page) starts the idle clock again. */
  check(token: string | null, touch = false): boolean {
    if (!token || !this.isOpen()) return false;
    const a = Buffer.from(token);
    let ok = false;
    for (const t of this.tokens) {
      const b = Buffer.from(t);
      if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
    }
    if (ok && touch) this.lastActive = this.now();
    return ok;
  }

  /** Locks every browser at once (the padlock, a PIN turned off or changed). */
  close(): void {
    this.tokens.clear();
  }

  /** Seconds until it locks by itself (0 when it never does or is locked). */
  secondsLeft(): number {
    if (!this.idleMinutes || !this.isOpen()) return 0;
    return Math.max(0, Math.round((this.lastActive + this.idleMinutes * 60_000 - this.now()) / 1000));
  }
}
