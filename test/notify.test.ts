// Notifications: words, settings, the page's list (src/notify.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatTold, clean, DEFAULTS, jobTold, Notifier, toastScript } from '../src/notify.ts';

const at = '2026-10-04T12:00:00Z';
const who = (role: string | null) => (role === 'coder' ? 'Sam' : role === 'planner' ? 'the planner' : 'the reviewer');

test('job events: person and event only, never the goal or what was written', () => {
  assert.deepEqual(jobTold({ type: 'result', at, n: 1, role: 'coder', files: ['secret-plan.html'], flags: 0, tries: 1 } as never, who), { event: 'finished', text: 'Sam finished step 2. Please review.', role: 'coder' });
  assert.equal(jobTold({ type: 'plan', at, steps: 3, worker: 'x' } as never, who)?.text, 'The planner made a plan. Read it before it runs.');
  assert.equal(jobTold({ type: 'plan', at, steps: 3, worker: 'x' } as never, who)?.event, 'question');
  assert.equal(jobTold({ type: 'failed', at, n: 0, role: 'coder', error: 'The answer was cut off.' } as never, who)?.text, "Sam's step 1 stopped. It needs you.");
  assert.equal(jobTold({ type: 'failed', at, n: 0, role: 'coder', error: 'Stopped.' } as never, who), null, 'his own Stop tells nothing');
  assert.equal(jobTold({ type: 'tests', at, ok: false, label: 'npm test' } as never, who)?.event, 'stuck');
  assert.equal(jobTold({ type: 'tests', at, ok: true, label: 'npm test' } as never, who), null);
  assert.equal(jobTold({ type: 'saved', at, n: 0, files: [], left: 2 } as never, who), null);
  assert.equal(jobTold({ type: 'saved', at, n: 0, files: [], left: 0 } as never, who)?.event, 'finished');
  assert.equal(jobTold({ type: 'note', at, id: 'a1b2c3d4', text: 'hi', to: [] } as never, who), null);
});

test('chat answers: the name', () => {
  assert.equal(chatTold('Rosa'), 'Rosa answered.');
});

test('settings: defaults, volume kept 0-100', () => {
  assert.deepEqual(clean(undefined), DEFAULTS);
  assert.equal(clean({ volume: 400 }).volume, 100);
  assert.equal(clean({ volume: -3 }).volume, 0);
  assert.equal(clean({ windows: false }).windows, false);
});

test('the notification is silent, its words are escaped, a click opens the address', () => {
  const s = toastScript(`Sam's step <1> & "2"`, 'http://127.0.0.1:8740/?room=20261004-1000-aaaa');
  assert.match(s, /<audio silent="true"\/>/);
  assert.match(s, /activationType="protocol" launch="http:\/\/127\.0\.0\.1:8740\/\?room=20261004-1000-aaaa"/);
  assert.ok(s.includes('Sam&apos;s step &lt;1&gt; &amp; &quot;2&quot;'), 'XML escaped: no bare quote reaches the PowerShell string');
});

test('the page list: numbered, last 20, the same words within 5 s told once; settings survive a fresh read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-notify-'));
  try {
    const n = new Notifier(dir);
    n.seen(true);
    assert.ok(n.inFront());
    const t0 = Date.now();
    assert.ok(await n.tell('finished', 'Rosa answered.', 'chat:565a83941eba', t0));
    assert.equal(await n.tell('finished', 'Rosa answered.', 'chat:565a83941eba', t0 + 1000), null);
    assert.ok(await n.tell('finished', 'Rosa answered.', 'chat:565a83941eba', t0 + 6000));
    for (let i = 0; i < 25; i++) await n.tell('stuck', `Step ${i}`, 'room:x', t0 + 7000);
    assert.equal(n.recent().told.length, 20);
    assert.equal(n.recent().seq, 27);
    await n.save({ volume: 30 });
    const again = new Notifier(dir);
    assert.equal((await again.settings()).volume, 30);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
