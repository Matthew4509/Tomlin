// S1, the picture half: sd-server takes no key, so a picture model of this PC's own is unloaded while TOMLIN is locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED_IDLE_MS, PICTURE_DROP_MS, unloadWhileLocked } from '../src/picturelock.ts';

const idle = { locked: true, state: 'connected', forLinked: false, busy: false, idleMs: LOCKED_IDLE_MS + 1 };

test('locked, connected, this PC\'s own, idle: unloaded', () => {
  assert.equal(unloadWhileLocked(idle), true);
});

test('kept: open, drawing, loading, just used, or loaded for a linked PC (its own 10-minute rule drops it)', () => {
  assert.equal(unloadWhileLocked({ ...idle, locked: false }), false);
  assert.equal(unloadWhileLocked({ ...idle, busy: true }), false);
  assert.equal(unloadWhileLocked({ ...idle, state: 'loading' }), false);
  assert.equal(unloadWhileLocked({ ...idle, state: 'disconnected' }), false);
  assert.equal(unloadWhileLocked({ ...idle, idleMs: LOCKED_IDLE_MS - 1 }), false, 'a queue of pictures running while locked is not cut between pictures');
  assert.equal(unloadWhileLocked({ ...idle, forLinked: true }), false);
});

test('a picture model loaded for a linked PC stays 10 minutes after its last picture (back-to-back drawing)', () => {
  assert.equal(PICTURE_DROP_MS, 10 * 60_000);
});
