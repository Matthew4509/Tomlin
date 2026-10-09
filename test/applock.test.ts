import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppLock, cleanAppIdle, cookieValue, gateOf } from '../src/applock.ts';

test('while locked only the page files and the lock door answer; /v1 is the door for programs', () => {
  for (const p of ['/', '/index.html', '/app.js', '/lock.js', '/style.css', '/icon.svg', '/api/applock', '/preview/0123456789abcdef0123456789abcdef/index.html']) assert.equal(gateOf(p), 'open', p);
  // The preview's frame carries no cookie: its key (given out behind the lock) is checked by the server instead.
  for (const p of ['/v1/models', '/v1/chat/completions', '/v1/images/generations', '/v1']) assert.equal(gateOf(p), 'door', p);
  for (const p of ['/api/chat', '/api/chats', '/api/status', '/api/faces/file/partner', '/api/images/file/a.png', '/api/files/read', '/api/applock/x', '/api', '/x/y', '/api/../api/chat']) assert.equal(gateOf(p), 'shut', p);
});

test('a token opens one browser; another browser (no token, or a made-up one) stays locked', () => {
  const lock = new AppLock();
  assert.equal(lock.isOpen(), false);
  const a = lock.open();
  assert.equal(lock.check(a), true);
  assert.equal(lock.check(null), false);
  assert.equal(lock.check('0'.repeat(48)), false);
  const b = lock.open();
  assert.equal(lock.check(a) && lock.check(b), true, 'two browsers can be open at once');
  lock.close();
  assert.equal(lock.check(a) || lock.check(b) || lock.isOpen(), false, 'the padlock locks every browser');
});

test('it locks by itself after the idle minutes; polling does not count as use, touch does', () => {
  let now = 0;
  const lock = new AppLock(() => now);
  lock.idleMinutes = 5;
  const t = lock.open();
  now = 4 * 60_000;
  assert.equal(lock.check(t), true); // a poll: not a touch
  now = 5 * 60_000 + 1;
  assert.equal(lock.check(t), false, 'the poll at 4 minutes did not keep it open');
  const u = lock.open();
  now += 4 * 60_000;
  assert.equal(lock.check(u, true), true); // something done in the page
  now += 4 * 60_000;
  assert.equal(lock.check(u), true, 'the touch started the clock again');
  assert.ok(lock.secondsLeft() > 0);
});

test('idle 0 never locks by itself; idle choices are cleaned', () => {
  let now = 0;
  const lock = new AppLock(() => now);
  const t = lock.open();
  now = 1e10;
  assert.equal(lock.check(t), true);
  assert.equal(lock.secondsLeft(), 0);
  assert.equal(cleanAppIdle('10'), 10);
  assert.equal(cleanAppIdle(7), 0);
  assert.equal(cleanAppIdle(undefined), 0);
});

test('the cookie is read by its own name only', () => {
  assert.equal(cookieValue('sm_private=abc; sm_app=xyz', 'sm_app'), 'xyz');
  assert.equal(cookieValue('sm_private=abc', 'sm_app'), null);
  assert.equal(cookieValue(undefined, 'sm_app'), null);
  assert.equal(cookieValue('sm_app=', 'sm_app'), null);
});
