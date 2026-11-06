import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, cleanPermissions, cleanPermit, DEFAULT_PERMISSIONS, deniedWords, type Kind, type Permit } from '../src/permits.ts';
import { Pacer } from '../src/webtools.ts';

test('permissions: only known values are kept, anything else falls back to Manual with the wait on', () => {
  assert.deepEqual(cleanPermissions(undefined), DEFAULT_PERMISSIONS);
  assert.deepEqual(cleanPermissions({ files: 'auto', web: 'yes', webDelay: 'no' }), { files: 'auto', web: 'ask', webDelay: true });
  assert.deepEqual(cleanPermissions({ webDelay: false }, { files: 'auto', web: 'auto', webDelay: true }), { files: 'auto', web: 'auto', webDelay: false }, 'a change keeps what it does not name');
  assert.equal(cleanPermit('always'), 'always');
  assert.equal(cleanPermit('forever'), null);
  assert.match(deniedWords('web'), /web access/);
});

function gateWith(answers: Partial<Record<Kind, Permit>>, auto: Kind[] = []) {
  const asked: Kind[] = [];
  const kept: string[] = [];
  const thread = new Set<Kind>();
  const gate = new Gate({
    allowed: k => auto.includes(k) || thread.has(k),
    ask: async k => (asked.push(k), answers[k] ?? 'no'),
    keep: async (k, p) => void (kept.push(`${k}:${p}`), p === 'thread' && thread.add(k)),
  });
  return { gate, asked, kept };
}

test('Auto is never asked; Manual is asked once an answer, and calls made meanwhile wait for the same answer', async () => {
  const { gate, asked } = gateWith({ files: 'once' }, ['web']);
  assert.equal(await gate.permitted('web', 'search'), true);
  const [a, b] = await Promise.all([gate.permitted('files', 'read a'), gate.permitted('files', 'read b')]);
  assert.deepEqual([a, b, asked], [true, true, ['files']]);
});

test('a no holds for the rest of the answer; thread and always are kept', async () => {
  const no = gateWith({ web: 'no' });
  assert.equal(await no.gate.permitted('web', 'x'), false);
  assert.equal(await no.gate.permitted('web', 'y'), false);
  assert.deepEqual(no.asked, ['web']);
  const keep = gateWith({ web: 'thread', files: 'always' });
  assert.equal(await keep.gate.permitted('web', 'x'), true);
  assert.equal(await keep.gate.permitted('files', 'x'), true);
  assert.deepEqual(keep.kept, ['web:thread', 'files:always']);
});

test('two kinds asked at once put up one card at a time', async () => {
  let open = 0;
  let most = 0;
  const gate = new Gate({
    allowed: () => false,
    ask: async () => {
      most = Math.max(most, ++open);
      await new Promise(r => setTimeout(r, 10));
      open--;
      return 'once';
    },
  });
  await Promise.all([gate.permitted('files', 'a'), gate.permitted('web', 'b')]);
  assert.equal(most, 1);
});

test('the wait between pages on a site is 1 to 5 s, and none when turned off', () => {
  const low = new Pacer(undefined, () => 0);
  const high = new Pacer(undefined, () => 1);
  assert.equal(low.pageGap(), 1000);
  assert.equal(high.pageGap(), 5000);
  high.delay = false;
  assert.equal(high.pageGap(), 0);
});
