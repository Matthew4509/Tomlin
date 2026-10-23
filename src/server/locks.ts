// The app lock (a PIN or a password for the whole app, A1) and its recovery codes (A2).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { cleanKind, cleanSecret, generateWords, hashSecret, needsRehash, secretMatches, strength, type LockKind } from '../lock.ts';
import { CODES_FILE, CODE_COUNT, RecoveryCodes, cleanCodesFile, hashCodes, makeCodes, type CodesFile } from '../recovery.ts';
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

// ---- The app lock: an optional PIN or password for the whole app (src/applock.ts). Off until one is set ----

export const appLock = new AppLock();
const appGuard = new PinGuard();
/** The lock's hash, read once at start and kept in memory: deleting the file while running changes nothing until a restart. */
const appRead = await readLock<AppLockFile>(APP_LOCK_FILE, f => (typeof f.salt === 'string' && typeof f.hash === 'string' ? { kind: cleanKind(f.kind), salt: f.salt, hash: f.hash, ...(typeof f.cost === 'number' ? { cost: f.cost } : {}), idleMinutes: cleanAppIdle(f.idleMinutes) } : null));
/** The app lock's file was there but damaged: the app stays locked (no PIN opens it) until the file is deleted by hand. */
const appDamaged = appRead === 'damaged';
export let appFile: AppLockFile | null = appRead === 'damaged' ? null : appRead;
appLock.idleMinutes = appFile?.idleMinutes ?? appLock.idleMinutes;
/** The app lock is on: a PIN is set, or its file is damaged (which keeps every door shut, never open). */
export const appLockOn = () => !!appFile || appDamaged;
const appCookie = (res: ServerResponse, token: string | null) => res.setHeader('set-cookie', `${APP_COOKIE}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/${token ? '' : '; Max-Age=0'}`);
/** This request's browser has the app open (or there is no PIN). */
export const appOk = (req: IncomingMessage, touch = false) => !appDamaged && (!appFile || appLock.check(cookieValue(req.headers.cookie, APP_COOKIE), touch));
const kindOf = (): LockKind => appFile?.kind ?? 'pin';
/** "PIN" or "password", for the words on screen. */
const word = (kind = kindOf()) => (kind === 'password' ? 'password' : 'PIN');

// ---- A2: the recovery codes (src/recovery.ts), read once at start like the lock ----

const codesRead = await readLock<CodesFile>(CODES_FILE, f => cleanCodesFile(f));
/** The codes file was there but damaged: no code works until New set makes another (which needs the lock). */
let codesDamaged = codesRead === 'damaged';
const saveCodes = (f: CodesFile) => store.writeJson(CODES_FILE, f);
let codes: RecoveryCodes | null = codesRead && codesRead !== 'damaged' ? new RecoveryCodes(codesRead, saveCodes) : null;

/** Told when the set changes (a new set, a code used): sent on to the linked PCs that keep this PC's backups (A3). */
let codesChanged: () => void = () => undefined;
export const whenCodesChange = (f: () => void) => void (codesChanged = f);
/** The codes as their hashes (A3 sends them to the backup PC), or null when there is no set. */
export const recoveryHashes = () => codes?.file.codes ?? null;

/** Checks of a backup PIN against the screen PIN (owner.NUDGE_CHECKS in 10 minutes; its own count, not the unlock tries). */
const nudgeGuard = new PinGuard();

/**
 * A3's nudge: the kind of the app lock when `pin` also opens it, else null. It checks the screen PIN, so each check
 * is counted: past 5 in 10 minutes (or while the lock's own tries are paused) `{ wait }` minutes, and nothing is
 * checked, so trying every PIN here cannot find the screen PIN.
 */
export async function sameAsLock(pin: string): Promise<LockKind | null | { wait: number }> {
  if (!appFile) return null;
  const wait = Math.max(nudgeGuard.lockedFor('local'), appGuard.lockedFor('local'));
  if (wait) return { wait };
  nudgeGuard.wrong('local');
  return (await secretMatches(pin, appFile)) ? kindOf() : null;
}

/** A new set: written first, then it replaces the old one (whose codes stop working). The codes are shown once. */
async function newCodes(): Promise<string[]> {
  const plain = makeCodes();
  const file = await hashCodes(plain);
  await saveCodes(file);
  if (codes) codes.replace(file);
  else codes = new RecoveryCodes(file, saveCodes);
  codesDamaged = false;
  codesChanged();
  return plain;
}

export function appLockView(req: IncomingMessage, open = appOk(req)) {
  return {
    on: !!appFile || appDamaged, damaged: appDamaged ? damagedLock(APP_LOCK_FILE) : null, open, kind: kindOf(),
    codes: codes ? { left: codes.left(), total: CODE_COUNT } : null, codesDamaged,
    idleMinutes: appLock.idleMinutes, idleChoices: APP_IDLE_CHOICES, secondsLeft: appFile && open ? appLock.secondsLeft() : 0, waitMinutes: appGuard.lockedFor('local'), node: jobRoutes.nodeView(),
  };
}

/**
 * Checks a PIN or password against the file. The try is counted before the check (about half a second, src/lock.ts),
 * so tries sent side by side cannot all slip under the wrong-try limit; a right one clears the count.
 */
async function tryPin(v: unknown): Promise<boolean> {
  appGuard.wrong('local');
  const secret = appFile ? cleanSecret(kindOf(), v) : null;
  if (!appFile || !secret || !(await secretMatches(secret, appFile))) return false;
  appGuard.right('local');
  await upgrade(secret);
  return true;
}

/**
 * A lock file made at the old scrypt cost is made again at the new one (src/lock.ts) once the right PIN has been typed.
 * When it cannot be written, the old file stays and still opens with the same PIN.
 */
async function upgrade(secret: string): Promise<void> {
  if (!appFile || !needsRehash(appFile)) return;
  const next = { kind: kindOf(), ...(await hashSecret(secret)), idleMinutes: appLock.idleMinutes };
  try {
    await store.writeJson(APP_LOCK_FILE, next);
    appFile = next;
  } catch (e) {
    console.log(`The app lock's file could not be made again at the new cost (${(e as Error).message}); the old one still works.`);
  }
}

/**
 * The app lock PIN or password typed again for a change to this node (F7 E3: while it is a node, every change needs
 * it). Wrong tries count with the lock screen's. An empty answer only asks for it.
 */
export async function appPinCheck(v: unknown): Promise<{ ok: true } | { status: number; error: string }> {
  if (appDamaged) return { status: 409, error: damagedLock(APP_LOCK_FILE) };
  if (!appFile) return { status: 409, error: 'There is no app lock. Set one with the padlock (top right) first.' };
  const w0 = word();
  const wait = appGuard.lockedFor('local');
  if (wait) return { status: 429, error: `Too many wrong tries. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` };
  if (!cleanSecret(kindOf(), v)) return { status: 403, error: `Type the app lock ${w0} (the one that opens TOMLIN) to change this node.` };
  if (!(await tryPin(v))) {
    const w = appGuard.lockedFor('local');
    return { status: 403, error: w ? `Wrong ${w0}. Too many tries: wait ${w} minute${w > 1 ? 's' : ''}, then try again.` : `Wrong ${w0}. Type the app lock ${w0} again.` };
  }
  return { ok: true };
}

export async function appLockAction(req: IncomingMessage, res: ServerResponse, b: Record<string, unknown>): Promise<void> {
  const wait = appGuard.lockedFor('local');
  const tooMany = () => json(res, 429, { error: `Too many wrong tries. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` });
  // The try was counted by tryPin (or with the recovery code).
  const wrong = (what: string) => {
    const w = appGuard.lockedFor('local');
    return json(res, 403, { error: w ? `${what} Too many tries: wait ${w} minute${w > 1 ? 's' : ''}, then try again.` : `${what} Try again.` });
  };
  const wrongPin = () => wrong(`Wrong ${word()}.`);
  /** The current PIN or password, for anything that changes the lock once it is set. */
  const currentOk = (v: unknown) => tryPin(v);
  /** The new PIN or password of `kind`, typed twice. A PIN keeps its rules; a password is anything of 1 or more. */
  const newSecret = (kind: LockKind): string | null => {
    const s = cleanSecret(kind, b.pin);
    if (!s) return json(res, 400, { error: kind === 'pin' ? 'Use 4 to 12 digits for the PIN (numbers only).' : 'Type a password (any length of 1 or more).' }), null;
    if (cleanSecret(kind, b.pin2) !== s) return json(res, 400, { error: `The two ${word(kind)}s are not the same. Type the new ${word(kind)} in both boxes.` }), null;
    return s;
  };
  // The file first: when it cannot be written, the lock in memory stays as it was (and as it will be after a restart).
  const save = async (kind: LockKind, secret: string) => {
    const next = { kind, ...(await hashSecret(secret)), idleMinutes: appLock.idleMinutes };
    await store.writeJson(APP_LOCK_FILE, next);
    appFile = next;
  };
  // Help for a new password, asked from the new-lock window and the lock screen's "Use a recovery code" alike: nothing
  // in them is secret, so they answer while locked.
  if (b.action === 'generate') return json(res, 200, { words: generateWords(4) });
  if (b.action === 'strength') return json(res, 200, { strength: typeof b.pin === 'string' && b.pin ? strength(b.pin) : null });
  if (appDamaged && b.action !== 'ask' && b.action !== 'lock') return json(res, 423, { error: damagedLock(APP_LOCK_FILE), locked: true });
  if (b.action === 'set') {
    // The first lock: his window (Create a new pin or password, confirm it, the tick), then it locks at once.
    if (appFile) return json(res, 409, { error: `A ${word()} is already set. Change it in Settings (top bar), App lock.` });
    const kind = cleanKind(b.kind);
    if (b.agree !== true) return json(res, 400, { error: `Tick "I confirm if I lose my ${word(kind)} I will be locked out" first: without it the app does not open.` });
    const secret = newSecret(kind);
    if (!secret) return;
    // The auto-lock minutes picked in the new-lock window are kept with it.
    if (b.idleMinutes !== undefined) appLock.idleMinutes = cleanAppIdle(b.idleMinutes);
    // A2: the first lock makes the recovery codes (a set with codes left is kept: turning the lock off kept it). Made
    // before the lock is written, so a page that reloads the moment it shuts already sees them.
    const recoveryCodes = codes && codes.left() > 0 ? undefined : await newCodes();
    await save(kind, secret);
    appLock.close();
    appCookie(res, null);
    // A node that stopped listening for want of a PIN (F7 E3) starts again.
    await jobRoutes.applyShare();
    return json(res, 200, { ...appLockView(req, false), ...(recoveryCodes ? { recoveryCodes } : {}) });
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
  if (b.action === 'recover') {
    // A2, "Use a recovery code" on the lock screen: a code of the set (each works once) sets a new PIN or password and
    // opens this browser. Wrong codes count with wrong PINs. The new lock is checked first, so a typo there uses no code.
    if (!appFile) return json(res, 409, { error: 'There is no app lock, so there is nothing to recover. Reload the page.' });
    if (!codes) return json(res, 409, { error: codesDamaged ? `The recovery codes file ${CODES_FILE} is damaged, so no code works.` : 'There are no recovery codes on this PC.' });
    if (wait) return tooMany();
    const kind = cleanKind(b.kind);
    const secret = newSecret(kind);
    if (!secret) return;
    appGuard.wrong('local');
    if (!(await codes.use(b.code))) return wrong('That recovery code is not right, or it was used already.');
    appGuard.right('local');
    codesChanged();
    await save(kind, secret);
    appLock.close();
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
  if (b.action === 'codes-new') {
    // A2, New set: the current PIN or password, or one current code. The old set stops working.
    if (!appFile) return json(res, 409, { error: 'Set an app lock first: the recovery codes are for it.' });
    if (wait) return tooMany();
    appGuard.wrong('local');
    const secret = cleanSecret(kindOf(), b.current);
    const ok = (secret && (await secretMatches(secret, appFile))) || (codes && (await codes.check(b.current)));
    if (!ok) return wrong(`Wrong ${word()} or recovery code.`);
    appGuard.right('local');
    const recoveryCodes = await newCodes();
    return json(res, 200, { ...appLockView(req), recoveryCodes });
  }
  if (b.action === 'change' || b.action === 'off') {
    if (!appFile) return json(res, 409, { error: 'There is no PIN to change. Use the padlock to set one.' });
    if (wait) return tooMany();
    if (!(await currentOk(b.current))) return wrongPin();
    if (b.action === 'off') {
      if (jobRoutes.shareOn()) return json(res, 409, { error: 'This PC is a node, and a node must have the app lock. Turn the node off first (Network), then turn the lock off.' });
      await rm(join(store.dir, APP_LOCK_FILE), { force: true });
      appFile = null;
      appLock.close();
      appLock.idleMinutes = DEFAULT_APP_IDLE;
      appCookie(res, null);
      return json(res, 200, appLockView(req, true));
    }
    // The kind may change too (PIN to password or back); none given keeps it.
    const kind = b.kind === undefined ? kindOf() : cleanKind(b.kind);
    const secret = newSecret(kind);
    if (!secret) return;
    await save(kind, secret);
    // Every other browser locks; this one stays open with a fresh token.
    appLock.close();
    appCookie(res, appLock.open());
    return json(res, 200, appLockView(req, true));
  }
  return json(res, 400, { error: 'Unknown action.' });
}
