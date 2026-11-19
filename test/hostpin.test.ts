// The host PIN (src/hostpin.ts): wrong tries kept on disk with waits that grow, the host PIN a PC holds for one link only,
// the doors that give and take it, and the main PC's own copy (a hash only).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readData, writeAtomic } from '../src/atomic.ts';
import { hashSecret } from '../src/lock.ts';
import * as hp from '../src/hostpin.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-hostpin-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A clock the test moves by hand. */
function clock(start = Date.parse('2026-11-18T10:00:00Z')) {
  const c = { t: start, now: () => c.t, go: (min: number) => void (c.t += min * 60_000) };
  return c;
}

/** A guard kept in a real file (written whole or not at all), read again as after a restart. */
async function guardIn(dir: string, now: () => number) {
  const file = join(dir, hp.TRIES_FILE);
  return new hp.TryGuard(await readData<unknown>(file, {}), f => writeAtomic(file, JSON.stringify(f)), now);
}

const LINK_A = 'a'.repeat(64);
const LINK_B = 'b'.repeat(64);

test('a host PIN is 6 to 12 digits, or a password of 6 characters or more', () => {
  assert.equal(hp.cleanHostSecret('pin', '1234'), null, 'the app lock allows 4 digits; one PIN for every PC needs more');
  assert.equal(hp.cleanHostSecret('pin', '12345'), null);
  assert.equal(hp.cleanHostSecret('pin', '123 456'), '123456');
  assert.equal(hp.cleanHostSecret('pin', '123456789012'), '123456789012');
  assert.equal(hp.cleanHostSecret('pin', '1234567890123'), null);
  assert.equal(hp.cleanHostSecret('pin', 'abcdef'), null);
  assert.equal(hp.cleanHostSecret('password', 'short'), null);
  assert.equal(hp.cleanHostSecret('password', 'six ch'), 'six ch');
  assert.equal(hp.cleanHostSecret('password', 'x'.repeat(257)), null, 'the app lock\'s longest');
  assert.equal(hp.waitWords(1), '1 minute');
  assert.equal(hp.waitWords(10), '10 minutes');
  assert.equal(hp.waitWords(60), '1 hour');
  assert.equal(hp.waitWords(61), '2 hours');
  assert.equal(hp.waitWords(1440), '24 hours');
});

test('wrong tries survive a restart, and each stop of the same link waits longer until a right PIN', async () => {
  const dir = tmp();
  const c = clock();
  let g = await guardIn(dir, c.now);
  for (let k = 0; k < 4; k++) await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 0, 'four are not enough');
  // TOMLIN closes and starts again: the four are still counted.
  g = await guardIn(dir, c.now);
  await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 10, 'the first stop: 10 minutes');
  assert.equal(g.lockedFor('laptop'), 0, 'another link is not stopped');
  g = await guardIn(dir, c.now);
  assert.equal(g.lockedFor('desk'), 10, 'a restart does not end the wait');
  c.go(10);
  assert.equal(g.lockedFor('desk'), 0);
  for (let k = 0; k < 5; k++) await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 60, 'the second stop: 1 hour');
  c.go(60);
  for (let k = 0; k < 5; k++) await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 360, 'the third: 6 hours');
  c.go(360);
  for (let k = 0; k < 5; k++) await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 1440, 'the fourth: 24 hours');
  c.go(1440);
  for (let k = 0; k < 5; k++) await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 1440, 'and 24 hours from then on');
  g = await guardIn(dir, c.now);
  assert.equal(g.level('desk'), 5, 'the count of stops is kept over a restart too');
  c.go(1440);
  // A right PIN: the next stop is back to 10 minutes.
  await g.wrong('desk');
  await g.right('desk');
  g = await guardIn(dir, c.now);
  assert.equal(g.level('desk'), 0);
  for (let k = 0; k < 5; k++) await g.wrong('desk');
  assert.equal(g.lockedFor('desk'), 10);
});

test('tries more than 10 minutes apart do not add up, and 20 from all links stop every link for 10 minutes', async () => {
  const c = clock();
  // Kept in memory here: the file is tested above.
  const g = new hp.TryGuard({}, async () => undefined, c.now);
  for (let k = 0; k < 8; k++) {
    await g.wrong('slow');
    c.go(3);
  }
  assert.equal(g.lockedFor('slow'), 0, 'never 5 within 10 minutes');
  const all = new hp.TryGuard({}, async () => undefined, c.now);
  for (let k = 0; k < 20; k++) await all.wrong(`pc${k}`);
  assert.equal(all.pausedFor(), 10);
  assert.equal(all.lockedFor('pc0'), 0, 'no one link was stopped');
  c.go(10);
  assert.equal(all.pausedFor(), 0);
});

test('a wait kept while the clock was ahead ends no later than the longest wait once the clock is put back', async () => {
  const dir = tmp();
  // The clock a year ahead (a wrong date), a link stopped then, and the stops of every link too.
  const ahead = clock(Date.parse('2027-11-18T10:00:00Z'));
  let g = await guardIn(dir, ahead.now);
  for (let k = 0; k < 5; k++) await g.wrong('desk');
  for (let k = 0; k < 20; k++) await g.wrong(`pc${k}`);
  assert.equal(g.lockedFor('desk'), 10);
  // Put right, and TOMLIN started again: the file still holds the times of a year ahead.
  const right = clock();
  g = await guardIn(dir, right.now);
  assert.ok(g.lockedFor('desk') <= 24 * 60, `stopped for ${g.lockedFor('desk')} minutes, not a year`);
  assert.ok(g.pausedFor() <= 10, `every link stopped for ${g.pausedFor()} minutes`);
  right.go(24 * 60);
  assert.equal(g.lockedFor('desk'), 0, 'free a day later at the most');
  assert.equal(g.pausedFor(), 0);
  // Tries kept from then count as made now, and run out 10 minutes later like any other.
  const dir2 = tmp();
  g = await guardIn(dir2, ahead.now);
  for (let k = 0; k < 4; k++) await g.wrong('laptop');
  g = await guardIn(dir2, right.now);
  right.go(11);
  await g.wrong('laptop');
  assert.equal(g.lockedFor('laptop'), 0, 'the four from the clock ahead no longer count');
});

test('a damaged or odd file starts the count afresh, never with anything it cannot read', () => {
  assert.deepEqual(hp.cleanTries(null), { links: {}, all: [], allUntil: 0 });
  assert.deepEqual(hp.cleanTries({ links: { x: { tries: ['no', 5], level: -2, until: 'soon' } }, all: 'x' }), { links: { x: { tries: [5], level: 0, until: 0 } }, all: [], allUntil: 0 });
});

test('a wait or a try from the future (the clock was set back, or the file came from elsewhere) never stops a link longer than the longest wait', async () => {
  const c = clock();
  const years = 5 * 365 * 24 * 60 * 60_000;
  const g = new hp.TryGuard({ links: { desk: { tries: [], level: 1, until: c.t + years } }, all: [], allUntil: c.t + years }, async () => undefined, c.now);
  assert.ok(g.lockedFor('desk') <= 1440, `stopped for ${g.lockedFor('desk')} minutes`);
  assert.ok(g.pausedFor() <= 10, `every link stopped for ${g.pausedFor()} minutes`);
  c.go(1440);
  assert.equal(g.lockedFor('desk'), 0, 'the wait runs out');
  assert.equal(g.pausedFor(), 0);
  // Tries written while the clock was ahead count as made now (at most one stop), then age out like any other: they
  // never stay "recent" so that each later try stops the link again.
  const f = new hp.TryGuard({ links: { lap: { tries: [1, 2, 3, 4].map(k => c.t + years + k), level: 0, until: 0 } }, all: [], allUntil: 0 }, async () => undefined, c.now);
  await f.wrong('lap');
  assert.equal(f.lockedFor('lap'), 10);
  c.go(30);
  await f.wrong('lap');
  assert.equal(f.lockedFor('lap'), 0, 'one try after the wait does not stop it again');
});

/** A PC with app lock PIN 4711, its guard and host PINs in `dir`. */
async function aPc(dir: string, now: () => number, lock: { kind?: 'pin' | 'password'; salt: string; hash: string; cost?: number } | null) {
  const heldFile = join(dir, hp.HELD_FILE);
  const pins = new hp.HostPins(await readData<unknown>(heldFile, {}), f => writeAtomic(heldFile, JSON.stringify(f)));
  const guard = await guardIn(dir, now);
  const gate: hp.GateDeps = { lock: () => lock, damaged: () => null, guard, pins };
  const check = (v: unknown, who: string, doing: hp.Doing = false, host?: { pin: unknown; link: string | undefined }) => hp.pinGate(gate, v, who, doing, host);
  const door = (p: string, b: Record<string, unknown>, link = LINK_A, guest = false) => hp.hostPinDoor(p, b, { key: `keep-${link.slice(0, 4)}`, link, name: 'Main PC', guest }, { pcName: () => 'Desk PC', check, pins });
  return { pins, guard, check, door, heldFile };
}

test('a PC takes a host PIN only with its own PIN, keeps only a hash, and takes it from that link alone', async () => {
  const dir = tmp();
  const c = clock();
  const lock = { kind: 'pin' as const, ...(await hashSecret('4711')) };
  const pc = await aPc(dir, c.now, lock);
  // Not with a wrong own PIN, nor without one; a too short host PIN is refused before anything is checked.
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: '1234', appPin: '4711' })).status, 400);
  const wrong = await pc.door(hp.SET_DOOR, { newPin: '246810', appPin: '0000' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.needPin, true);
  assert.match(String(wrong.json.error), /^"Desk PC" says that PIN is wrong/);
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: '246810' })).status, 403);
  assert.equal(pc.pins.get(LINK_A), null);
  // A guest never holds one (it never reaches the door either: src/guestpass.ts).
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: '246810', appPin: '4711' }, LINK_A, true)).status, 403);
  const ok = await pc.door(hp.SET_DOOR, { newPin: '246810', appPin: '4711' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  const file = readFileSync(pc.heldFile, 'utf8');
  assert.doesNotMatch(file, /246810/, 'only a hash is written');
  assert.match(file, /"salt"/);
  assert.deepEqual(pc.pins.list().map(x => [x.id, x.name]), [[LINK_A.slice(0, 12), 'Main PC']]);

  // The host PIN opens an update, a turn-off and a delete from that link; the PC's own PIN still works.
  for (const doing of [false, true, 'power'] as const) assert.deepEqual(await pc.check(undefined, 'keep-aaaa', doing, { pin: '246810', link: LINK_A }), { ok: true });
  assert.deepEqual(await pc.check('4711', 'keep-aaaa'), { ok: true });
  // From another link it opens nothing, and that is not a wrong try (nothing was checked).
  const other = await pc.check(undefined, 'keep-bbbb', false, { pin: '246810', link: LINK_B });
  assert.equal('error' in other && other.status, 403);
  assert.match('error' in other ? other.error : '', /holds no host PIN from this PC: type its own app lock PIN instead/);
  assert.equal(pc.guard.level('keep-bbbb'), 0);
  // Read again after a restart: still there, still that link's only.
  const again = await aPc(dir, c.now, lock);
  assert.ok(again.pins.get(LINK_A));
  assert.equal(again.pins.get(LINK_B), null);
});

test('wrong host PINs count with wrong PINs of the PC itself: five of either stop that link for both', async () => {
  const c = clock();
  const lock = { kind: 'pin' as const, ...(await hashSecret('4711')) };
  const pc = await aPc(tmp(), c.now, lock);
  await pc.pins.set(LINK_A, 'Main PC', 'pin', '246810');
  for (let k = 0; k < 3; k++) {
    const r = await pc.check(undefined, 'keep-aaaa', false, { pin: '999999', link: LINK_A });
    assert.match('error' in r ? r.error : '', /says that host PIN is wrong/);
  }
  for (let k = 0; k < 2; k++) await pc.check('0000', 'keep-aaaa');
  const stopped = await pc.check('4711', 'keep-aaaa');
  assert.equal('error' in stopped && stopped.status, 429);
  assert.match('error' in stopped ? stopped.error : '', /had too many wrong PINs typed for it: wait 10 minutes, then update it again/);
  const host = await pc.check(undefined, 'keep-aaaa', 'power', { pin: '246810', link: LINK_A });
  assert.equal('error' in host && host.status, 429, 'the right host PIN waits too');
  c.go(10);
  assert.deepEqual(await pc.check(undefined, 'keep-aaaa', 'power', { pin: '246810', link: LINK_A }), { ok: true });
  assert.equal(pc.guard.level('keep-aaaa'), 0, 'a right one starts the waits again');
});

test('the words when there is no app lock, and a host PIN changed with the old one or taken away', async () => {
  const c = clock();
  const none = await aPc(tmp(), c.now, null);
  const r = await none.check('4711', 'k', 'host');
  assert.match('error' in r ? r.error : '', /has no app lock, so it takes no host PIN/);
  const r2 = await none.check('4711', 'k', 'power');
  assert.match('error' in r2 ? r2.error : '', /another PC cannot turn it off/);

  const lock = { kind: 'password' as const, ...(await hashSecret('long words here')) };
  const pc = await aPc(tmp(), c.now, lock);
  assert.match(JSON.stringify(await pc.door(hp.SET_DOOR, { newPin: 'first secret', kind: 'password' })), /asks for its app lock password/);
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: 'first secret', kind: 'password', appPin: 'long words here' })).status, 200);
  // Changed with the host PIN it holds now (the main PC changes it for every PC with one PIN).
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: '13579135', kind: 'pin', hostPin: 'wrong secret' })).status, 403);
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: '13579135', kind: 'pin', hostPin: 'first secret' })).status, 200);
  assert.deepEqual(await pc.check(undefined, 'keep-aaaa', true, { pin: '13579135', link: LINK_A }), { ok: true });
  const old = await pc.check(undefined, 'keep-aaaa', true, { pin: 'first secret', link: LINK_A });
  assert.equal('error' in old && old.status, 403);
  // The host takes it away (nothing asked); the owner can too, by the id the page shows.
  assert.deepEqual((await pc.door(hp.DROP_DOOR, {})).json, { ok: true, dropped: true });
  assert.equal(pc.pins.get(LINK_A), null);
  await pc.pins.set(LINK_B, 'Other host', 'pin', '24682468');
  assert.equal(await pc.pins.drop(LINK_B.slice(0, 12)), true);
  assert.equal(await pc.pins.drop(LINK_B.slice(0, 12)), false);
  assert.equal(await pc.pins.drop('b'), false, 'never by a few characters');
});

test('the main PC keeps a hash of its own host PIN, and five wrong ones in a row stop the check for a while', async () => {
  const c = clock();
  let saved: unknown = null;
  const own = new hp.OwnHostPin(null, async f => void (saved = f), c.now);
  assert.equal(own.on, false);
  await own.set('pin', '246810');
  assert.equal(own.on, true);
  assert.doesNotMatch(JSON.stringify(saved), /246810/);
  assert.equal(await own.check('246810'), '246810');
  for (let k = 0; k < 5; k++) assert.equal(await own.check('111111'), null);
  assert.equal(own.lockedFor(), 10);
  assert.equal(await own.check('246810'), null, 'not even the right one while stopped');
  c.go(10);
  const back = new hp.OwnHostPin(saved, async () => undefined, c.now);
  assert.equal(await back.check('246 810'), '246810');
  await own.off();
  assert.equal(saved, null);
});

test("the host PIN typed in one linked PC's own PIN window is known as the host PIN; a PC's own PIN is not, and never stops the host PIN", async () => {
  const c = clock();
  const own = new hp.OwnHostPin(null, async () => undefined, c.now);
  assert.equal(await own.either('246810'), null, 'none set');
  await own.set('pin', '246810');
  assert.equal(await own.either('246 810'), '246810');
  assert.equal(await own.either('1234'), null, "too short to be a host PIN: a PC's own");
  for (let k = 0; k < 4; k++) assert.equal(await own.either('111111'), null);
  own.eitherTaken();
  for (let k = 0; k < 5; k++) assert.equal(await own.either('111111'), null);
  assert.equal(await own.either('246810'), null, 'five wrong in a row: sent on as a PC\'s own for a while');
  assert.equal(own.lockedFor(), 0);
  assert.equal(await own.check('246810'), '246810', 'the host PIN window still works');
  c.go(10);
  assert.equal(await own.either('246810'), '246810');
});

// ---- The host key: no typed host PIN; unlocking the host is the admin step ----

test('the host key is random, kept whole, never made or used while the host is locked, and can be reset or turned off', async () => {
  let saved: unknown = undefined;
  let open = false;
  const k = new hp.HostKey(null, async f => void (saved = f), () => open);
  assert.equal(k.made, false);
  assert.equal(await k.use(), null, 'a shut lock makes and gives nothing');
  assert.equal(saved, undefined, 'nothing was written either');
  open = true;
  const a = await k.use();
  assert.ok(a);
  assert.match(a.secret, /^[A-Za-z0-9_-]{43}$/, '32 random bytes');
  assert.equal(a.id, hp.keyIdOf(a.secret));
  assert.match(a.id, /^[0-9a-f]{12}$/);
  assert.notEqual(a.secret.slice(0, 12), a.id, 'the id gives nothing of the key');
  assert.equal(hp.cleanHostSecret('password', a.secret), a.secret, 'a PC takes it as a host secret');
  assert.equal((await k.use())?.secret, a.secret, 'the same key until reset');
  open = false;
  assert.equal(k.peek(), null, 'locked again: not used');
  open = true;
  // Read again after a restart.
  const back = new hp.HostKey(saved, async () => undefined, () => true);
  assert.equal(back.peek()?.secret, a.secret);
  await k.reset();
  assert.notEqual(k.peek()?.secret, a.secret);
  await k.turnOff();
  assert.equal(k.enabled, false);
  assert.equal(await k.use(), null);
  assert.deepEqual(saved, { off: true });
  assert.equal(new hp.HostKey(saved, async () => undefined).enabled, false, 'off survives a restart');
  await k.turnOn();
  assert.equal(k.enabled, true);
  assert.ok(await k.use());
  assert.equal(hp.cleanKeyFile({ key: 'short' }), null, 'a damaged file holds no key');
});

test('a PC takes a host key with its own PIN, lists it as a key, and then opens an update, a delete and a turn-off for that link alone', async () => {
  const dir = tmp();
  const c = clock();
  const lock = { kind: 'pin' as const, ...(await hashSecret('4711')) };
  const pc = await aPc(dir, c.now, lock);
  const k = new hp.HostKey(null, async () => undefined);
  const key = (await k.use())!;
  // Not without the PC's own PIN, nor with a wrong one.
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: key.secret, kind: 'password', keyId: key.id })).status, 403);
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: key.secret, kind: 'password', keyId: key.id, appPin: '0000' })).status, 403);
  assert.equal(pc.pins.get(LINK_A), null);
  const ok = await pc.door(hp.SET_DOOR, { newPin: key.secret, kind: 'password', keyId: key.id, appPin: '4711' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.match(String(ok.json.said), /host key/);
  assert.equal(pc.pins.keyIdOf(LINK_A), key.id);
  assert.equal(pc.pins.keyIdOf(LINK_B), '');
  assert.doesNotMatch(readFileSync(pc.heldFile, 'utf8'), new RegExp(key.secret), 'only a hash is written');
  assert.deepEqual(pc.pins.list().map(x => [x.name, x.key]), [['Main PC', true]]);
  for (const doing of [false, true, 'power'] as const) assert.deepEqual(await pc.check(undefined, 'keep-aaaa', doing, { pin: key.secret, link: LINK_A }), { ok: true });
  // Another link, a wrong key, or the PC's own PIN sent as the key: nothing opens.
  const other = await pc.check(undefined, 'keep-bbbb', false, { pin: key.secret, link: LINK_B });
  assert.equal('error' in other && other.status, 403);
  const bad = await pc.check(undefined, 'keep-aaaa', false, { pin: (await new hp.HostKey(null, async () => undefined).use())!.secret, link: LINK_A });
  assert.equal('error' in bad && bad.status, 403);
  const own = await pc.check(undefined, 'keep-aaaa', false, { pin: '4711', link: LINK_A });
  assert.equal('error' in own && own.status, 403, "the 4-digit app lock PIN is not a host secret and never opens through the host door");
  // A guest never holds one; the id is only kept for a password-kind key and only as 12 hex.
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: key.secret, kind: 'password', keyId: key.id, appPin: '4711' }, LINK_B, true)).status, 403);
  await pc.door(hp.SET_DOOR, { newPin: '246810', kind: 'pin', keyId: key.id, appPin: '4711' }, LINK_B);
  assert.equal(pc.pins.keyIdOf(LINK_B), '', 'a typed PIN is never marked a key');
  await pc.door(hp.SET_DOOR, { newPin: key.secret, kind: 'password', keyId: 'not hex', appPin: '4711' }, LINK_B);
  assert.equal(pc.pins.keyIdOf(LINK_B), '');
  // After a restart it is still there; its owner takes it away and the link asks the PC's own PIN again.
  const again = await aPc(dir, c.now, lock);
  assert.equal(again.pins.keyIdOf(LINK_A), key.id);
  assert.equal(await again.pins.drop(LINK_A), true);
  const gone = await again.check(undefined, 'keep-aaaa', false, { pin: key.secret, link: LINK_A });
  assert.equal('error' in gone && gone.status, 403);
});

test('wrong host keys are counted and stop the link like wrong PINs; a typed host PIN already held still works (migration)', async () => {
  const dir = tmp();
  const c = clock();
  const lock = { kind: 'pin' as const, ...(await hashSecret('4711')) };
  const pc = await aPc(dir, c.now, lock);
  // A PC set up with a typed host PIN before keys existed: no key id, still opens.
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: '246810', appPin: '4711' })).status, 200);
  assert.equal(pc.pins.keyIdOf(LINK_A), '');
  assert.deepEqual(pc.pins.list().map(x => x.key), [false]);
  assert.deepEqual(await pc.check(undefined, 'keep-aaaa', false, { pin: '246810', link: LINK_A }), { ok: true });
  // The host then gives the key over it with the PC's own PIN, and the typed one stops opening.
  const key = (await new hp.HostKey(null, async () => undefined).use())!;
  assert.equal((await pc.door(hp.SET_DOOR, { newPin: key.secret, kind: 'password', keyId: key.id, appPin: '4711' })).status, 200);
  assert.deepEqual(await pc.check(undefined, 'keep-aaaa', false, { pin: key.secret, link: LINK_A }), { ok: true });
  const old = await pc.check(undefined, 'keep-aaaa', false, { pin: '246810', link: LINK_A });
  assert.equal('error' in old && old.status, 403);
  // Five wrong ones stop that link for 10 minutes, key or not.
  for (let k = 0; k < 4; k++) await pc.check(undefined, 'keep-aaaa', false, { pin: 'x'.repeat(43), link: LINK_A });
  const stopped = await pc.check(undefined, 'keep-aaaa', false, { pin: key.secret, link: LINK_A });
  assert.equal('error' in stopped && stopped.status, 429, 'the wrong ones from before the right one count; this is the sixth try inside the stop');
});
