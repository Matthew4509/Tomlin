import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as carry from '../src/carry.ts';
import { GUEST_DOORS } from '../src/guestpass.ts';
import { OFF_SECONDS, POWER_DOOR, powerOffSide, shutdownArgs, type PowerOffDeps } from '../src/poweroff.ts';

const who = { key: 'abc', name: 'Main PC' };
function door(over: Partial<PowerOffDeps> = {}) {
  const ran: { seconds: number; by: string }[] = [];
  const pins: unknown[] = [];
  const side = powerOffSide({
    allowed: () => true,
    pcName: () => 'Worker PC',
    away: () => false,
    busy: () => null,
    pinCheck: async pin => (pins.push(pin), pin === '1234' ? { ok: true as const } : { status: 403, error: 'asks for its app lock PIN (the one that opens TOMLIN there) to turn it off' }),
    supported: true,
    run: (seconds, by) => ran.push({ seconds, by }),
    ...over,
  });
  return { side, ran, pins };
}

test('the permission is on by default and stays off once unticked; an older save without it is on', () => {
  assert.equal(carry.cleanAllow(undefined).off, true);
  assert.equal(carry.cleanAllow({ pull: true }).off, true);
  assert.equal(carry.cleanAllow({ off: false }).off, false);
  assert.equal(carry.cleanAllow({ off: true }).off, true);
  assert.equal(carry.NO_ALLOW.off, true);
  // The other ticks stay off until ticked.
  assert.equal(carry.cleanAllow(undefined).update, false);
});

test('a node turns itself off only with the tick, nobody using it, and its PIN; then answers first and shuts down after', async () => {
  const off = door({ allowed: () => false });
  assert.equal((await off.side({ appPin: '1234' }, who)).status, 403);
  assert.deepEqual(off.ran, []);
  assert.deepEqual(off.pins, [], 'the PIN is not even asked without the tick');

  const busy = door({ busy: () => 'someone at that PC is getting an answer' });
  const b = await busy.side({ appPin: '1234' }, who);
  assert.equal(b.status, 409);
  assert.match(String(b.json.error), /not turned off: someone at that PC is getting an answer/);
  assert.deepEqual(busy.ran, []);

  assert.equal((await door({ away: () => true }).side({ appPin: '1234' }, who)).status, 503);
  assert.equal((await door({ supported: false }).side({ appPin: '1234' }, who)).status, 501);

  const ok = door();
  const noPin = await ok.side({}, who);
  assert.equal(noPin.status, 403);
  assert.equal(noPin.json.needPin, true, 'the host is told to ask for the PIN');
  assert.equal((await ok.side({ appPin: '0000' }, who)).json.needPin, true);
  assert.deepEqual(ok.ran, [], 'nothing shuts down on a missing or wrong PIN');
  const done = await ok.side({ appPin: '1234' }, who);
  assert.equal(done.status, 200);
  assert.deepEqual(ok.ran, [{ seconds: OFF_SECONDS, by: 'Main PC' }]);
  assert.match(String(done.json.said), /Worker PC" is turning off in 15 seconds/);
});

test('a host PIN is checked with the link it came from (src/hostpin.ts), in place of the PC\'s own', async () => {
  const hosts: unknown[] = [];
  const side = powerOffSide({
    allowed: () => true, pcName: () => 'Worker PC', away: () => false, busy: () => null, supported: true, run: () => undefined,
    pinCheck: async (_pin, _who, host) => (hosts.push(host), host?.link === 'link-a' && host.pin === '246810' ? { ok: true as const } : { status: 403, error: 'holds no host PIN from this PC: type its own app lock PIN instead' }),
  });
  assert.equal((await side({ hostPin: '246810' }, { ...who, link: 'link-a' })).status, 200);
  const other = await side({ hostPin: '246810' }, { key: 'def', name: 'Other host', link: 'link-b' });
  assert.equal(other.status, 403);
  assert.equal(other.json.needPin, true, 'the host asks for the PC\'s own PIN instead');
  await side({ appPin: '1234' }, { ...who, link: 'link-a' });
  assert.deepEqual(hosts, [{ pin: '246810', link: 'link-a' }, { pin: '246810', link: 'link-b' }, undefined]);
});

test('a PC someone is working at in another program is not turned off, and the PIN is not asked', async () => {
  const used = door({ inUse: async () => 'last used 12 s ago' });
  const r = await used.side({ appPin: '1234' }, who);
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /someone is using it \(last used 12 s ago\)\. It can be turned off once Windows is locked there, or after 5 minutes/);
  assert.deepEqual(used.ran, []);
  assert.deepEqual(used.pins, []);
  // Nobody there, or it cannot be told (the reading failed): the turn-off goes on to the PIN.
  for (const inUse of [async () => null, async () => { throw new Error('no reading'); }]) {
    const free = door({ inUse });
    assert.equal((await free.side({ appPin: '1234' }, who)).status, 200);
    assert.equal(free.ran.length, 1);
  }
});

test('a guest link cannot reach the door, and the shutdown line names who asked without anything that could be run', () => {
  assert.equal(GUEST_DOORS.includes(POWER_DOOR), false);
  const args = shutdownArgs(15, 'Main PC"; calc & "');
  assert.deepEqual(args.slice(0, 3), ['/s', '/t', '15']);
  assert.equal(args[3], '/c');
  assert.doesNotMatch(args[4], /["&;]/);
  assert.match(args[4], /turned off by Main PC calc/);
  assert.deepEqual(shutdownArgs(1, 'x').slice(0, 3), ['/s', '/t', '5'], 'never under 5 seconds');
  assert.deepEqual(shutdownArgs(9999, 'x').slice(0, 3), ['/s', '/t', '120'], 'never over 2 minutes');
});

test('the host offers it only for a PC that answers, can do it and allows it', () => {
  const pc = (o: Record<string, unknown> = {}) => ({ name: 'Worker PC', ok: true, away: null, can: ['models', 'power-off'], allow: { ...carry.NO_ALLOW, off: true }, ...o }) as unknown as Parameters<typeof carry.powerOffWhy>[0];
  assert.equal(carry.powerOffWhy(pc()), '');
  assert.match(carry.powerOffWhy(pc({ ok: false })), /is off or not answering/);
  assert.match(carry.powerOffWhy(pc({ away: '2026-11-17' })), /being used by its owner/);
  assert.match(carry.powerOffWhy(pc({ can: ['models'] })), /cannot be turned off from another PC: update it there first/);
  assert.match(carry.powerOffWhy(pc({ allow: { ...carry.NO_ALLOW, off: false } })), /ticks "Allow host to turn this PC off"/);
});
