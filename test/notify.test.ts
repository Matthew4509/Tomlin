// Notifications: words, settings, the page's list (src/notify.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatTold, clean, DEFAULTS, isTestHire, jobTold, Notifier, toastScript, toastXml } from '../src/notify.ts';

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
  const s = toastXml(`Sam's step <1> & "2"`, 'http://127.0.0.1:8740/?room=20261004-1000-aaaa');
  assert.match(s, /<audio silent="true"\/>/);
  assert.match(s, /activationType="protocol" launch="http:\/\/127\.0\.0\.1:8740\/\?room=20261004-1000-aaaa"/);
  assert.ok(s.includes('Sam&apos;s step &lt;1&gt; &amp; &quot;2&quot;'), 'XML escaped');
});

test('the words of a notification never stand in the PowerShell script: a curly quote cannot end its string', () => {
  // PowerShell ends a single-quoted string at ’ as well as at ': a name holding one ran the rest as a command.
  const name = 'Bob’); Start-Process calc; #';
  const script = toastScript(`${name} answered.\r\nsecond line`, 'http://127.0.0.1:8740/');
  assert.doesNotMatch(script, /Start-Process|’|Bob/);
  assert.match(script, /^[\x20-\x7e\n]+$/, 'plain characters only');
  const sent = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)![1];
  const doc = Buffer.from(sent, 'base64').toString('utf8');
  assert.equal(doc, toastXml(`${name} answered.\r\nsecond line`, 'http://127.0.0.1:8740/'));
  assert.ok(doc.includes('Bob’); Start-Process calc; # answered. second line'), 'the words are whole, on one line');
  assert.ok(toastXml('x'.repeat(5000), 'http://127.0.0.1:8740/').length < 600);
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

test('a Speed Test or Crash Test hire answering makes no sound or pop-up; a real person does', () => {
  assert.equal(isTestHire('Speed Test'), true);
  assert.equal(isTestHire(' crash test '), true);
  assert.equal(isTestHire('Rosa'), false);
  assert.equal(isTestHire('Speed Tester Sam'), false);
});

// Every text told was kept (to tell the same words once in 5 seconds) for as long as TOMLIN ran.
test('the words told stay only for the 5 seconds they are checked against, over 100,000 notifications', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notify-many-'));
  try {
    const n = new Notifier(dir);
    const t0 = Date.now();
    for (let i = 0; i < 100_000; i++) await n.tell('finished', `Answer ${i} is ready.`, 'chat:x', t0 + i * 100);
    const kept = (n as unknown as { lastText: Map<string, number> }).lastText.size;
    assert.ok(kept <= 51, `kept ${kept}`);
    // The same words within 5 seconds are still told once.
    assert.equal(await n.tell('finished', 'Answer 99999 is ready.', 'chat:x', t0 + 99_999 * 100 + 1000), null);
    assert.equal(n.recent().told.length, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});