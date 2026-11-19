// A linked PC whose clock is wrong still takes requests: this PC learns its clock from the Date header of its answers and
// stamps requests in its time (src/link.ts noteClock, nodeNow); the node's own check of the stamp is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as link from '../src/link.ts';

const HOUR = 3600_000;

test('a node 11 hours behind: requests are stamped in its time and it opens them', () => {
  const keys = Buffer.alloc(64, 7);
  const url = 'http://192.168.9.9:8741';
  const here = Date.parse('2026-11-18T13:18:00Z');
  const there = here - 11 * HOUR;
  const seen = new link.Seen();
  // Before anything is learned: stamped in this PC's time, refused there for the clocks.
  const before = link.sealRequest(keys, '/worker/hello', {}, link.nodeNow(url, here));
  const no = link.openRequest(keys, before, '/worker/hello', seen, there);
  assert.ok('error' in no && link.clockRefused(no.error));
  // Its answer's Date header teaches its clock: the next request is opened there.
  link.noteClock(url, new Date(there).toUTCString(), here);
  const after = link.sealRequest(keys, '/worker/hello', {}, link.nodeNow(url, here));
  const yes = link.openRequest(keys, after, '/worker/hello', seen, there);
  assert.ok(!('error' in yes));
  // The same request sent again is still refused there.
  assert.ok('error' in link.openRequest(keys, after, '/worker/hello', seen, there));
});

test('a clock within 5 seconds is taken as the same, and a missing or bad Date header changes nothing', () => {
  const url = 'http://192.168.9.10:8741';
  const now = Date.parse('2026-11-18T13:18:00Z');
  link.noteClock(url, new Date(now - 2 * HOUR).toUTCString(), now);
  assert.equal(link.nodeNow(url, now), now - 2 * HOUR);
  link.noteClock(url, null, now);
  link.noteClock(url, 'not a date', now);
  assert.equal(link.nodeNow(url, now), now - 2 * HOUR);
  link.noteClock(url, new Date(now + 2000).toUTCString(), now);
  assert.equal(link.nodeNow(url, now), now);
});
