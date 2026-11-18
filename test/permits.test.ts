import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, KINDS, TIER_KINDS, TIER_NAME, cleanPermissions, cleanPermit, DEFAULT_PERMISSIONS, deniedWords, isKind, isTierKind, tierOf, withRole, type Kind, type Permit } from '../src/permits.ts';
import { Pacer } from '../src/webtools.ts';

test('permissions: only known values are kept, anything else falls back to Manual with the wait on', () => {
  assert.deepEqual(cleanPermissions(undefined), DEFAULT_PERMISSIONS);
  // The newer kinds (tiers, lists, roles) ride along at their safe defaults: the three first fields are as they were.
  assert.deepEqual(cleanPermissions({ files: 'auto', web: 'yes', webDelay: 'no' }), { ...DEFAULT_PERMISSIONS, files: 'auto', web: 'ask', webDelay: true });
  assert.deepEqual(cleanPermissions({ webDelay: false }, { ...DEFAULT_PERMISSIONS, files: 'auto', web: 'auto', webDelay: true }), { ...DEFAULT_PERMISSIONS, files: 'auto', web: 'auto', webDelay: false }, 'a change keeps what it does not name');
  assert.equal(cleanPermit('always'), 'always');
  assert.equal(cleanPermit('forever'), null);
  assert.match(deniedWords('web'), /web access/);
  for (const k of ['web', 'files'] as const) {
    const w = deniedWords(k);
    assert.match(w, /NOT (read|done)|NOT allowed/);
    assert.match(w, /not read the page|did not read|nothing was read/i);
    assert.match(w, /already know/i);
    assert.match(w, /not from (the page|a live|a file)|from what you already know/i);
    assert.match(w, /do not (state|say|claim)/i);
  }
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

// ---- The tier model (the newer kinds) ----

test('an older settings file loads as before: files, web and the wait unchanged, every newer kind at its safe default', () => {
  const old = { files: 'auto', web: 'ask', webDelay: false };
  const got = cleanPermissions(old);
  assert.deepEqual([got.files, got.web, got.webDelay], ['auto', 'ask', false]);
  assert.deepEqual(got.tiers, { screen: 'look', machine: 'look', git: 'look', notes: 'look', subagent: 'look', focus: 'never', input: 'never', run: 'never', edit: 'never', download: 'never' });
  assert.deepEqual([got.windows, got.folders, got.commands, got.research, got.coding], [[], [], [], false, false]);
  assert.deepEqual(cleanPermissions(cleanPermissions(old)), got, 'cleaning twice changes nothing');
  for (const k of TIER_KINDS) assert.equal(k.acts ? k.safe === 'never' : k.safe === 'look', true, `${k.kind}: a kind that acts starts at Never, one that reads at Look only`);
  assert.deepEqual(KINDS.map(k => k.kind), ['files', 'web'], 'the two first kinds are as they were');
});

test('an unknown tier falls to Never for a kind that acts; a tier a kind does not have is not kept', () => {
  const got = cleanPermissions({ tiers: { input: 'always', run: 'yes', focus: 7, download: 'allowed', edit: 'look', screen: 'everything', machine: null, git: 'never', notes: 'allowed', madeup: 'allowed' } });
  assert.deepEqual(got.tiers, { screen: 'look', machine: 'look', git: 'never', notes: 'allowed', subagent: 'look', focus: 'never', input: 'never', run: 'never', edit: 'never', download: 'never' });
  assert.equal('madeup' in got.tiers, false);
  // Allowed never covers clicks, bringing a window forward or downloads: they stay Ask each time at most.
  for (const k of ['input', 'focus', 'download'] as const) {
    assert.equal(cleanPermissions({ tiers: { [k]: 'allowed' } }).tiers[k], 'never', k);
    assert.equal(cleanPermissions({ tiers: { [k]: 'each' } }).tiers[k], 'each', k);
    assert.equal(cleanPermissions({ tiers: { [k]: 'allowed' } }, cleanPermissions({ tiers: { [k]: 'each' } })).tiers[k], 'never', `${k}: a bad value does not keep what it was either`);
  }
  assert.equal(cleanPermissions({ tiers: { run: 'allowed' } }).tiers.run, 'allowed');
  const was = cleanPermissions({ tiers: { input: 'each', screen: 'allowed' }, windows: ['mstsc.exe|192.168.1.20 - *'] });
  assert.deepEqual(cleanPermissions({ webDelay: false }, was).tiers, was.tiers, 'a change keeps the tiers it does not name');
  assert.deepEqual(cleanPermissions({ tiers: { input: 'never' } }, was).tiers.screen, 'allowed');
  assert.equal(tierOf(undefined, 'input'), 'never');
  assert.equal(tierOf({ tiers: {} as never }, 'screen'), 'look');
  assert.equal(isKind('input') && isKind('files') && isTierKind('screen') && !isTierKind('files') && !isKind('shell'), true);
  assert.deepEqual(Object.values(TIER_NAME), ['Never', 'Look only', 'Ask each time', 'Allowed']);
});

test('the window, folder and command lists are kept as plain short lines; the roles only switch on and off', () => {
  const got = cleanPermissions({ windows: [' mstsc.exe|192.168.1.20 - * ', '', 5, 'a\nb', 'x'.repeat(201), 'mstsc.exe|192.168.1.20 - *'], folders: ['C:\\code\\app', null], commands: ['docs=npm run docs'], research: 'yes', coding: true });
  assert.deepEqual(got.windows, ['mstsc.exe|192.168.1.20 - *', 'a b']);
  assert.deepEqual([got.folders, got.commands, got.research, got.coding], [['C:\\code\\app'], ['docs=npm run docs'], false, true]);
  assert.equal(cleanPermissions({ windows: Array.from({ length: 50 }, (_, i) => `w${i}`) }).windows.length, 20);
  const role = withRole(got, 'research', true);
  assert.equal(role.research, true);
  assert.deepEqual(role.tiers, got.tiers, 'a role never raises a tier');
});

test('Ask each time: a card for every call, only Once is a yes, nothing is kept, one card at a time', async () => {
  const asked: Array<[Kind, string, boolean | undefined, unknown]> = [];
  const kept: string[] = [];
  let answer: Permit = 'once';
  let open = 0;
  let most = 0;
  const gate = new Gate({
    allowed: () => { throw new Error('a kind at Ask each time is never looked up as Auto'); },
    ask: async (k, what, each, extra) => {
      asked.push([k, what, each, extra]);
      most = Math.max(most, ++open);
      await new Promise(r => setTimeout(r, 5));
      open--;
      return answer;
    },
    keep: async (k, p) => void kept.push(`${k}:${p}`),
  });
  assert.equal(await gate.each('input', 'click at 1, 2', { mark: { x: 1, y: 2, w: 9, h: 9 } }), true);
  assert.equal(await gate.each('input', 'press Enter'), true);
  assert.equal(asked.length, 2, 'the first yes does not cover the second call');
  assert.deepEqual(asked[0], ['input', 'click at 1, 2', true, { mark: { x: 1, y: 2, w: 9, h: 9 } }]);
  answer = 'no';
  assert.equal(await gate.each('input', 'press Tab'), false);
  answer = 'once';
  assert.equal(await gate.each('input', 'press Tab'), true, 'a no is for that call only: the next one is asked again');
  for (const a of ['thread', 'always'] as const) {
    answer = a;
    assert.equal(await gate.each('input', 'x'), false, `${a} is not an answer an Ask each time card takes`);
  }
  assert.deepEqual(kept, [], 'nothing is ever kept');
  answer = 'once';
  await Promise.all([gate.each('input', 'a'), gate.each('run', 'b'), gate.each('focus', 'c')]);
  assert.equal(most, 1, 'one card at a time');
  const broken = new Gate({ allowed: () => false, ask: async () => { throw new Error('page gone'); } });
  assert.equal(await broken.each('input', 'x'), false, 'no way to ask is a no');
});

test('by tier: Never is a no without a card, Allowed a yes without one, Look only asks once an answer', async () => {
  const asked: string[] = [];
  const gate = new Gate({ allowed: () => false, ask: async (k, _w, each) => (asked.push(`${k}${each ? ':each' : ''}`), 'once') });
  assert.equal(await gate.byTier('never', 'input', 'x'), false);
  assert.equal(await gate.byTier('allowed', 'git', 'x'), true);
  assert.deepEqual(asked, []);
  assert.equal(await gate.byTier('look', 'screen', 'look 1'), true);
  assert.equal(await gate.byTier('look', 'screen', 'look 2'), true);
  assert.equal(await gate.byTier('each', 'run', 'run 1'), true);
  assert.equal(await gate.byTier('each', 'run', 'run 2'), true);
  assert.deepEqual(asked, ['screen', 'run:each', 'run:each']);
  const no = new Gate({ allowed: () => false, ask: async () => 'no' });
  assert.equal(await no.byTier('look', 'screen', 'a'), false);
  assert.equal(await no.byTier('look', 'screen', 'b'), false, 'a no holds for the answer');
});

test('a no is told plainly for every kind, so the model cannot say it was done', () => {
  for (const k of TIER_KINDS.map(t => t.kind)) {
    const w = deniedWords(k);
    assert.match(w, /NOT allowed/, k);
    assert.match(w, /nothing was done/, k);
    assert.match(w, /must not state or describe/, k);
    assert.match(w, /already know/, k);
  }
  assert.match(deniedWords('input'), /clicking or typing/);
  assert.match(deniedWords('files'), /file access/, 'the two first kinds say what they always said');
});
