// The app lock (a PIN for the whole app).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { cleanPin, hashPin, needsRehash, pinMatches } from '../lock.ts';
import { PinGuard } from '../share.ts';
import { AppLock, APP_COOKIE, APP_IDLE_CHOICES, APP_LOCK_FILE, DEFAULT_APP_IDLE, cleanAppIdle, cookieValue, type AppLockFile } from '../applock.ts';
import { DamagedFile } from '../atomic.ts';
import { json, store } from './core.ts';
import { jobRoutes } from './jobs.ts';

/**
 * A lock's file: the PIN's hash, null when there is none, or 'damaged' when the file is there but cannot be read.
 * A damaged lock stays shut (it is never read as "no PIN"); deleting the file by hand is the way back.
 */
async function readLock<T>(name: string, clean: (f: Partial<T>) => T | null): Promise<T | null | 'damaged'> {
  // Only a missing file is "no PIN": a file that holds `null` (or anything else that is not a PIN) is damaged.
  const missing = {};
  try {
    const f = await store.readJson<Partial<T> | null | typeof missing>(name, missing, { leave: true });
    if (f === missing) return null;
    return (f && typeof f === 'object' && clean(f as Partial<T>)) || 'damaged';
  } catch (e) {
    if (e instanceof DamagedFile) return 'damaged';
    throw e;
  }
}
const damagedLock = (name: string) => `The PIN file ${name} is damaged, so this lock stays shut. Someone at this PC can delete it from ${store.dir}, start TOMLIN again, and choose a new PIN.`;

// ---- The app lock: an optional PIN for the whole app (src/applock.ts). Off until a PIN is set ----

export const appLock = new AppLock();
const appGuard = new PinGuard();
/** The PIN's hash, read once at start and kept in memory: deleting the file while running changes nothing until a restart. */
const appRead = await readLock<AppLockFile>(APP_LOCK_FILE, f => (typeof f.salt === 'string' && typeof f.hash === 'string' ? { salt: f.salt, hash: f.hash, ...(typeof f.cost === 'number' ? { cost: f.cost } : {}), idleMinutes: cleanAppIdle(f.idleMinutes) } : null));
/** The app lock's file was there but damaged: the app stays locked (no PIN opens it) until the file is deleted by hand. */
const appDamaged = appRead === 'damaged';
export let appFile: AppLockFile | null = appRead === 'damaged' ? null : appRead;
appLock.idleMinutes = appFile?.idleMinutes ?? appLock.idleMinutes;
/** The app lock is on: a PIN is set, or its file is damaged (which keeps every door shut, never open). */
export const appLockOn = () => !!appFile || appDamaged;
const appCookie = (res: ServerResponse, token: string | null) => res.setHeader('set-cookie', `${APP_COOKIE}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/${token ? '' : '; Max-Age=0'}`);
/** This request's browser has the app open (or there is no PIN). */
export const appOk = (req: IncomingMessage, touch = false) => !appDamaged && (!appFile || appLock.check(cookieValue(req.headers.cookie, APP_COOKIE), touch));

export function appLockView(req: IncomingMessage, open = appOk(req)) {
  return { on: !!appFile || appDamaged, damaged: appDamaged ? damagedLock(APP_LOCK_FILE) : null, open, idleMinutes: appLock.idleMinutes, idleChoices: APP_IDLE_CHOICES, secondsLeft: appFile && open ? appLock.secondsLeft() : 0, waitMinutes: appGuard.lockedFor('local'), node: jobRoutes.nodeView() };
}

/**
 * Checks a PIN against the file. The try is counted before the check (about half a second, src/lock.ts), so tries sent
 * side by side cannot all slip under the wrong-try limit; a right one clears the count.
 */
async function tryPin(pin: string | null): Promise<boolean> {
  appGuard.wrong('local');
  if (!appFile || !pin || !(await pinMatches(pin, appFile))) return false;
  appGuard.right('local');
  await upgrade(pin);
  return true;
}

/**
 * A PIN file made at the old scrypt cost is made again at the new one (src/lock.ts) once the right PIN has been typed.
 * When it cannot be written, the old file stays and still opens with the same PIN.
 */
async function upgrade(pin: string): Promise<void> {
  if (!appFile || !needsRehash(appFile)) return;
  const next = { ...(await hashPin(pin)), idleMinutes: appLock.idleMinutes };
  try {
    await store.writeJson(APP_LOCK_FILE, next);
    appFile = next;
  } catch (e) {
    console.log(`The app lock's PIN file could not be made again at the new cost (${(e as Error).message}); the old one still works.`);
  }
}

/**
 * The app lock PIN typed again for a change to this node (F7 E3: while it is a node, every change needs it). Wrong
 * tries count with the lock screen's. An empty answer only asks for it.
 */
export async function appPinCheck(v: unknown): Promise<{ ok: true } | { status: number; error: string }> {
  if (appDamaged) return { status: 409, error: damagedLock(APP_LOCK_FILE) };
  if (!appFile) return { status: 409, error: 'There is no app lock PIN. Set one with the padlock (top right) first.' };
  const wait = appGuard.lockedFor('local');
  if (wait) return { status: 429, error: `Too many wrong PINs. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` };
  const pin = cleanPin(v);
  if (!pin) return { status: 403, error: 'Type the app lock PIN (the one that opens TOMLIN) to change this node.' };
  if (!(await tryPin(pin))) {
    const w = appGuard.lockedFor('local');
    return { status: 403, error: w ? `Wrong PIN. Too many tries: wait ${w} minute${w > 1 ? 's' : ''}, then try again.` : 'Wrong PIN. Type the app lock PIN again.' };
  }
  return { ok: true };
}

export async function appLockAction(req: IncomingMessage, res: ServerResponse, b: Record<string, unknown>): Promise<void> {
  const wait = appGuard.lockedFor('local');
  const tooMany = () => json(res, 429, { error: `Too many wrong PINs. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` });
  // The try was counted by tryPin.
  const wrongPin = () => {
    const w = appGuard.lockedFor('local');
    return json(res, 403, { error: w ? `Wrong PIN. Too many tries: wait ${w} minute${w > 1 ? 's' : ''}, then try again.` : 'Wrong PIN. Try again.' });
  };
  /** The current PIN, for anything that changes the lock once it is set. */
  const currentOk = (v: unknown) => tryPin(cleanPin(v));
  const newPin = (): string | null => {
    const pin = cleanPin(b.pin);
    if (!pin) return json(res, 400, { error: 'Use 4 to 12 digits for the PIN (numbers only).' }), null;
    if (String(b.pin2 ?? '').replace(/\s+/g, '') !== pin) return json(res, 400, { error: 'The two PINs are not the same. Type the new PIN in both boxes.' }), null;
    return pin;
  };
  // The file first: when it cannot be written, the lock in memory stays as it was (and as it will be after a restart).
  const save = async (pin: string) => {
    const next = { ...(await hashPin(pin)), idleMinutes: appLock.idleMinutes };
    await store.writeJson(APP_LOCK_FILE, next);
    appFile = next;
  };
  if (appDamaged && b.action !== 'ask' && b.action !== 'lock') return json(res, 423, { error: damagedLock(APP_LOCK_FILE), locked: true });
  if (b.action === 'set') {
    // The first PIN: his window (Create a new pin, Confirm pin, the tick), then it locks at once.
    if (appFile) return json(res, 409, { error: 'A PIN is already set. Change it in Settings (top bar), App lock.' });
    if (b.agree !== true) return json(res, 400, { error: 'Tick "I confirm if I lose my pin I will be locked out" first: without the PIN the app does not open.' });
    const pin = newPin();
    if (!pin) return;
    // The auto-lock minutes picked in the new-PIN window are kept with the PIN.
    if (b.idleMinutes !== undefined) appLock.idleMinutes = cleanAppIdle(b.idleMinutes);
    await save(pin);
    appLock.close();
    appCookie(res, null);
    // A node that stopped listening for want of a PIN (F7 E3) starts again.
    await jobRoutes.applyShare();
    return json(res, 200, appLockView(req, false));
  }
  if (b.action === 'ask') {
    // "Send host" on a node's lock screen, PIN or not: "I need to use the pc, please log out for N hours" goes to the
    // main PC, which decides (Home, Waiting for you). Nothing on a node logs it out at once with no say from the main PC.
    const r = await jobRoutes.askHost(b.hours);
    if ('error' in r) return json(res, 409, r);
    return json(res, 200, appLockView(req));
  }
  if (b.action === 'unlock') {
    if (!appFile) return json(res, 409, { error: 'There is no PIN, so the app is not locked. Reload the page.' });
    if (wait) return tooMany();
    if (!(await currentOk(b.pin))) return wrongPin();
    appCookie(res, appLock.open());
    return json(res, 200, appLockView(req, true));
  }
  if (b.action === 'lock') {
    appLock.close();
    appCookie(res, null);
    return json(res, 200, appLockView(req, false));
  }
  // Everything below needs the app open in this browser.
  if (!appOk(req)) return json(res, 423, { error: 'TOMLIN is locked. Type the PIN to open it.', locked: true });
  if (b.action === 'touch') {
    appOk(req, true);
    return json(res, 200, appLockView(req));
  }
  if (b.action === 'idle') {
    if (!appFile) return json(res, 409, { error: 'Set a PIN first.' });
    appLock.idleMinutes = cleanAppIdle(b.idleMinutes);
    appOk(req, true);
    const next = { ...appFile, idleMinutes: appLock.idleMinutes };
    await store.writeJson(APP_LOCK_FILE, next);
    appFile = next;
    return json(res, 200, appLockView(req));
  }
  if (b.action === 'change' || b.action === 'off') {
    if (!appFile) return json(res, 409, { error: 'There is no PIN to change. Use the padlock to set one.' });
    if (wait) return tooMany();
    if (!(await currentOk(b.current))) return wrongPin();
    if (b.action === 'off') {
      if (jobRoutes.shareOn()) return json(res, 409, { error: 'This PC is a node, and a node must have the app lock. Turn the node off first (Network: connect PCs), then turn the lock off.' });
      await rm(join(store.dir, APP_LOCK_FILE), { force: true });
      appFile = null;
      appLock.close();
      appLock.idleMinutes = DEFAULT_APP_IDLE;
      appCookie(res, null);
      return json(res, 200, appLockView(req, true));
    }
    const pin = newPin();
    if (!pin) return;
    await save(pin);
    // Every other browser locks; this one stays open with a fresh token.
    appLock.close();
    appCookie(res, appLock.open());
    return json(res, 200, appLockView(req, true));
  }
  return json(res, 400, { error: 'Unknown action.' });
}
