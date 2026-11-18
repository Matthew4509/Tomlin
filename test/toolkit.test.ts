import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gate, cleanPermissions, type Kind, type Permit } from '../src/permits.ts';
import { makeKit, type KitOpts } from '../src/toolkit.ts';
import { logAction, type Action } from '../src/actionlog.ts';
import type { ScreenBackend, Win } from '../src/screentools.ts';
import type { HelperLink } from '../src/camhelper.ts';
import * as link from '../src/link.ts';

// A made-up screen, helper and runner: nothing real is looked at, touched, called or run.
const RDC: Win = { id: '100', title: '192.168.1.20 - Remote Desktop Connection', process: 'mstsc.exe', x: 0, y: 0, w: 800, h: 600, minimized: false };
function screen() {
  const did: string[] = [];
  const backend: ScreenBackend = {
    windows: async () => [RDC, { ...RDC, id: '2', title: 'Private', process: 'x.exe' }],
    look: async id => (did.push(`look ${id}`), { win: RDC, lines: [[{ t: 'File', x: 10, y: 10, w: 30, h: 12 }]], lang: 'en-GB', captureMs: 5, ocrMs: 9 }),
    focus: async id => (did.push(`focus ${id}`), { front: true }),
    click: async (id, _t, x, y) => (did.push(`click ${id} ${x},${y}`), { front: true }),
    keys: async (id, _t, s) => (did.push(`keys ${id} ${s.map(k => k.label).join(' ')}`), { front: true }),
  };
  return { backend, did };
}
const HELPER: HelperLink = { id: 'aabbccdd', name: 'Laptop', url: 'http://192.168.1.20:8742', key: link.keysText(Buffer.alloc(64, 3)), tools: ['cam_menus', 'cam_window_state'] };
const WINDOWS = ['mstsc.exe|192.168.1.20 - *'];

function kitWith(perms: unknown, o: Partial<KitOpts> = {}, answers: Partial<Record<Kind, Permit>> = {}) {
  const cards: Array<{ kind: Kind; what: string; each: boolean }> = [];
  const log: Action[] = [];
  const s = screen();
  const gate = new Gate({ allowed: () => false, ask: async (kind, what, each) => (cards.push({ kind, what, each: each === true }), answers[kind] ?? 'once') });
  const kit = makeKit({ perms: cleanPermissions(perms), gate, perCall: 2000, platform: 'win32', screen: s.backend, log: a => log.push(a), ...o });
  return { kit, cards, log, did: s.did, names: kit?.defs.map(d => d.function.name) ?? [] };
}

test('a PC where nothing was set up is offered none of the newer tools', () => {
  assert.equal(kitWith({}).kit, null, 'the defaults');
  assert.equal(kitWith({ files: 'auto', web: 'auto' }, { helpers: [], root: 'C:\\x', web: true }).kit, null, 'files and web on Auto change nothing here');
  assert.equal(kitWith({ tiers: { input: 'each', focus: 'each', run: 'each' } }).kit, null, 'turning clicks on without a window on the list offers nothing');
  assert.equal(kitWith({ windows: ['*'] }).kit, null, 'a list of stars is no list');
  assert.equal(kitWith({ windows: WINDOWS }, { platform: 'linux' }).kit, null, 'the screen tools are Windows only');
  assert.equal(kitWith({ windows: WINDOWS, tiers: { screen: 'never' } }).kit, null, 'Never: not offered at all');
});

test('look-only by default: with a window on the list the two reading tools are offered, and nothing that acts', async () => {
  const k = kitWith({ windows: WINDOWS });
  assert.deepEqual(k.names, ['window_list', 'screen_look']);
  assert.equal(k.kit!.lines.length, 1);
  assert.equal(k.kit!.has('click'), false);
  assert.match(await k.kit!.run('click', JSON.stringify({ window: RDC.title, x: 1, y: 1 })), /no tool called "click"/);
  assert.match(await k.kit!.run('press_key', JSON.stringify({ window: RDC.title, keys: 'Enter' })), /no tool called/);
  assert.deepEqual(k.did, [], 'a tool that was not offered does nothing when called anyway');
  const list = await k.kit!.run('window_list', '{}');
  assert.match(list, /192.168.1.20/);
  assert.doesNotMatch(list, /Private/);
  assert.match(await k.kit!.run('screen_look', JSON.stringify({ window: RDC.title })), /\[25,16\] File/);
  assert.deepEqual(k.cards, [{ kind: 'screen', what: 'TOMLIN is listing the windows it may look at', each: false }], 'asked once for the answer, on the first look');
  assert.match(k.kit!.note(), /^Screen: 2 steps/);
  assert.deepEqual(k.kit!.uses().map(u => [u.name, u.ok, u.captureMs]), [['window_list', true, undefined], ['screen_look', true, 5]]);
});

test('a no to looking is told to the model and nothing is looked at for the rest of the answer', async () => {
  const k = kitWith({ windows: WINDOWS }, {}, { screen: 'no' });
  assert.match(await k.kit!.run('screen_look', JSON.stringify({ window: RDC.title })), /did not allow looking at the screen.*NOT allowed/s);
  assert.match(await k.kit!.run('window_list', '{}'), /did not allow/);
  assert.equal(k.cards.length, 1);
  assert.deepEqual(k.did, []);
});

test('clicks and keys: offered only when turned on, a card for each one, looking stays one card', async () => {
  const k = kitWith({ windows: WINDOWS, tiers: { input: 'each', focus: 'each' } });
  assert.deepEqual(k.names, ['window_list', 'screen_look', 'window_focus', 'click', 'press_key']);
  await k.kit!.run('screen_look', JSON.stringify({ window: RDC.title }));
  assert.match(await k.kit!.run('click', JSON.stringify({ window: RDC.title, x: 25, y: 16 })), /^Done: click at 25, 16/);
  await k.kit!.run('screen_look', JSON.stringify({ window: RDC.title }));
  assert.match(await k.kit!.run('press_key', JSON.stringify({ window: RDC.title, keys: 'Alt+F' })), /^Done: press Alt\+F/);
  assert.match(await k.kit!.run('window_focus', JSON.stringify({ window: RDC.title })), /in front now/);
  assert.deepEqual(k.cards.map(c => `${c.kind}${c.each ? ':each' : ''}`), ['screen', 'input:each', 'input:each', 'focus:each']);
  assert.deepEqual(k.log.map(a => [a.kind, a.outcome]), [['input', 'done'], ['input', 'done'], ['focus', 'done']], 'every action is logged');
  const no = kitWith({ windows: WINDOWS, tiers: { input: 'each' } }, {}, { input: 'no' });
  await no.kit!.run('screen_look', JSON.stringify({ window: RDC.title }));
  assert.match(await no.kit!.run('click', JSON.stringify({ window: RDC.title, x: 25, y: 16 })), /did not allow clicking or typing/);
  assert.deepEqual(no.did, ['look 100'], 'no click without a yes');
  assert.match(no.log[0].outcome, /^refused: not allowed/, 'a refusal is logged too');
  // "Allowed" cannot be saved for clicks: it falls to Never, so they are not offered.
  assert.deepEqual(kitWith({ windows: WINDOWS, tiers: { input: 'allowed' } }).names, ['window_list', 'screen_look']);
});

test('a locked app looks at nothing, reads nothing and runs nothing', async () => {
  const k = kitWith({ windows: WINDOWS, tiers: { input: 'each' } }, { locked: () => true, helpers: [HELPER], me: 'me' });
  for (const [n, a] of [['window_list', {}], ['screen_look', { window: RDC.title }], ['press_key', { window: RDC.title, keys: 'Enter' }], ['cam_menus', {}]] as const) {
    assert.match(await k.kit!.run(n, JSON.stringify(a)), /TOMLIN is locked/, n);
  }
  assert.deepEqual([k.did, k.cards], [[], []]);
});

test('the laptop helper\'s tools come with a linked helper, read only, asked once an answer', async () => {
  assert.equal(kitWith({}, { helpers: [HELPER], me: '' }).kit, null);
  assert.equal(kitWith({ tiers: { machine: 'never' } }, { helpers: [HELPER], me: 'me' }).kit, null);
  assert.equal(kitWith({}, { helpers: [{ ...HELPER, tools: [] }], me: 'me' }).kit, null, 'a helper with no tools (and no models) offers nothing and breaks nothing');
  const sent: string[] = [];
  const k = kitWith({}, { helpers: [HELPER], me: 'me', fetch: async url => { sent.push(url); throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(k.names, ['cam_menus', 'cam_window_state']);
  assert.match(await k.kit!.run('cam_menus', '{}'), /Not read:.*did not answer.*do not describe its menus/s);
  assert.match(await k.kit!.run('cam_window_state', '{}'), /Not read/);
  assert.deepEqual(sent, ['http://192.168.1.20:8742/helper/tool', 'http://192.168.1.20:8742/helper/tool']);
  assert.deepEqual(k.cards, [{ kind: 'machine', what: 'read the laptop helper (cam_menus)', each: false }]);
  const no = kitWith({}, { helpers: [HELPER], me: 'me', fetch: async url => { sent.push(url); throw new Error('x'); } }, { machine: 'no' });
  assert.match(await no.kit!.run('cam_menus', '{}'), /did not allow reading the laptop helper/);
  assert.equal(sent.length, 2, 'nothing was sent after a no');
});

test('coding and research tools need their role, their place and their tier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kit-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const ran: string[] = [];
    const exec = async (exe: string, args: string[]) => (ran.push(`${exe} ${args.join(' ')}`), { code: 0, out: 'fine', timedOut: false });
    assert.equal(kitWith({ coding: true }, { root, exec }).kit, null, 'the folder is not on the list');
    assert.equal(kitWith({ folders: [root] }, { root, exec }).kit, null, 'the role is off');
    assert.equal(kitWith({ coding: true, folders: [root] }, { root, exec, dataDir: root }).kit, null, 'never TOMLIN\'s own data');
    const read = kitWith({ coding: true, folders: [root] }, { root, exec });
    assert.deepEqual(read.names, ['git_read'], 'running is Never until turned on');
    assert.equal(await read.kit!.run('git_read', '{"verb":"status"}'), 'fine');
    assert.deepEqual(read.cards.map(c => c.kind), ['git']);
    const run = kitWith({ coding: true, folders: [root], tiers: { run: 'each' } }, { root, exec });
    assert.deepEqual(run.names, ['git_read', 'run_command']);
    assert.match(await run.kit!.run('run_command', '{"name":"test"}'), /finished without a fault/);
    assert.match(await run.kit!.run('run_command', '{"name":"test"}'), /finished/);
    assert.deepEqual(run.cards.map(c => `${c.kind}${c.each ? ':each' : ''}`), ['run:each', 'run:each']);
    assert.ok(run.log.every(a => a.kind === 'run' && a.outcome === 'passed'));

    const RESEARCH = ['find_in_text', 'keep_quote', 'keep_note', 'read_notes', 'read_document', 'calculate', 'table_stats', 'check_draft'];
    assert.deepEqual(kitWith({ research: true }, { root, web: false }).names, RESEARCH, 'the saved notes go with Web on; the research tools need only the folder');
    assert.deepEqual(kitWith({ research: true }, { root: null, web: true }).names, RESEARCH.filter(n => n !== 'read_document'), 'no folder: nothing that only reads files');
    assert.equal(kitWith({ research: true }, { root: null, web: false }).kit, null, 'neither pages nor a folder');
    assert.equal(kitWith({ research: true, tiers: { notes: 'never' } }, { root, web: true }).kit, null, 'Never: not offered at all');
    assert.equal(kitWith({}, { root, web: true }).kit, null, 'and with the research role');
    const notes = kitWith({ research: true }, { root, web: true, sources: () => [{ url: 'https://a.example/', title: 'A' }] });
    assert.deepEqual(notes.names, ['save_note', 'suggest_finding', ...RESEARCH]);
    assert.match(await notes.kit!.run('save_note', JSON.stringify({ title: 'One', text: 'Body' })), /research\/one\.md, with 1 source listed/);
    assert.match(await readFile(join(root, 'research', 'one.md'), 'utf8'), /1\. A - https:\/\/a\.example\//);
    assert.match(await notes.kit!.run('suggest_finding', JSON.stringify({ text: 'A finding.' })), /NOT saved yet/);
    assert.deepEqual(notes.kit!.findings().map(f => f.text), ['A finding.']);
    assert.deepEqual((await readdir(join(root, 'research'))).sort(), ['one.md'], 'the finding is not on the drive');
    assert.deepEqual(notes.kit!.saved(), ['research/one.md']);
    assert.deepEqual(notes.cards.map(c => c.kind), ['notes'], 'asked once for the answer');

    // The research tools: a sum needs no card; a page is looked in by the notes' tier; a file in the folder is asked as
    // Files is; a no is told plainly; and the kit can fold a long answer's results.
    const page = { url: 'https://a.example/', title: 'A', text: 'The bridge opened in 1932 and carries six lanes.' };
    await writeFile(join(root, 'facts.txt'), 'The tower is 134 metres tall.');
    const rs = kitWith({ research: true }, { root, web: true, page: u => (u === page.url ? page : null) });
    assert.equal(await rs.kit!.run('calculate', '{"expression":"6 * 7"}'), '6 * 7 = 42');
    assert.equal(await rs.kit!.run('read_notes', '{}'), 'No notes or quotes are kept yet.');
    assert.equal(rs.cards.length, 0, 'no card for a sum, or for reading back what the answer kept');
    assert.match(await rs.kit!.run('keep_quote', JSON.stringify({ claim: 'Opened 1932.', quote: 'The bridge opened in 1932', source: page.url })), /^Kept as quote 1/);
    assert.match(await rs.kit!.run('keep_quote', JSON.stringify({ claim: 'Opened 1923.', quote: 'The bridge opened in 1923', source: page.url })), /^Not kept: those words are not in/);
    assert.deepEqual(rs.cards.map(c => c.kind), ['notes'], 'the notes tier, once for the answer');
    assert.match(await rs.kit!.run('find_in_text', JSON.stringify({ source: 'facts.txt', query: 'metres tall' })), /134 metres tall/);
    assert.deepEqual(rs.cards.map(c => c.kind), ['notes', 'files'], 'a file in the folder is asked as Files is');
    assert.deepEqual(rs.kit!.saved(), ['research/quotes.md']);
    assert.ok(rs.kit!.uses().some(u => u.name === 'keep_quote' && !u.ok && u.said === 'the quote is not in the source'));
    assert.equal(typeof rs.kit!.fold, 'function');
    assert.match(rs.kit!.words('keep_quote', JSON.stringify({ source: page.url })), /^Checking a quote against https:\/\/a\.example\/…$/);
    const no = kitWith({ research: true }, { root, web: true, page: () => page }, { notes: 'no', files: 'no' });
    assert.match(await no.kit!.run('keep_note', '{"text":"a note"}'), /not allowed|did not allow|said no/i);
    assert.match(await no.kit!.run('read_document', '{"path":"x.docx"}'), /not allowed|did not allow|said no/i);
    assert.equal(await no.kit!.run('calculate', '{"expression":"1+1"}'), '1+1 = 2');
    // The second model is a permission of its own: "allow a subagent?", asked on a card; Never, and none is asked or queued.
    const seconds: string[] = [];
    const second = async () => (seconds.push('ran'), { text: 'ALL SUPPORTED', by: 'B on Worker PC' });
    const DRAFT = JSON.stringify({ draft: 'The bridge opened in 1932, the page says, and carries six lanes of traffic.' });
    const QUOTE = JSON.stringify({ claim: 'Opened 1932.', quote: 'The bridge opened in 1932', source: page.url });
    const FINAL = 'The bridge opened in 1932, the page says, and carries six lanes.';
    const sub = kitWith({ research: true }, { root, web: true, page: () => page, second, canQueue: true });
    await sub.kit!.run('keep_quote', QUOTE);
    assert.match(await sub.kit!.run('check_draft', DRAFT), /A subagent \(B on Worker PC\) read the draft/);
    assert.deepEqual(sub.cards.map(c => [c.kind, c.what]), [['notes', 'keep a checked quote in the chat\'s folder'], ['subagent', 'allow a subagent? This will run on an available node, and/or queue and run on this node after the first agent is completed']]);
    const subNo = kitWith({ research: true }, { root, web: true, page: () => page, second, canQueue: true }, { subagent: 'no' });
    await subNo.kit!.run('keep_quote', QUOTE);
    assert.match(await subNo.kit!.run('check_draft', DRAFT), /A subagent was not allowed/);
    const subNever = kitWith({ research: true, tiers: { subagent: 'never' } }, { root, web: true, page: () => page, second, canQueue: true });
    await subNever.kit!.run('keep_quote', QUOTE);
    assert.match(await subNever.kit!.run('check_draft', DRAFT), /There is no second model to ask here/);
    assert.ok(!subNever.cards.some(c => c.kind === 'subagent'), 'Never: no card');
    assert.equal(subNever.kit!.after!(FINAL), null);
    assert.deepEqual(seconds, ['ran'], 'the second model ran only where it was allowed');
    const queued = kitWith({ research: true, tiers: { subagent: 'allowed' } }, { root, web: true, page: () => page, second: async () => null, canQueue: true });
    await queued.kit!.run('keep_quote', QUOTE);
    assert.match(await queued.kit!.run('check_draft', DRAFT), /A subagent is queued/);
    assert.ok(!queued.cards.some(c => c.kind === 'subagent'), 'Allowed: no card');
    assert.match(queued.kit!.after!(FINAL)!.user, /^QUOTES\n1\. "The bridge opened in 1932"/);
    assert.match(await kitWith({ research: true }, { root, web: true, locked: () => true }).kit!.run('calculate', '{"expression":"1+1"}'), /TOMLIN is locked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the action log: one line an action, a file a day, nothing with a line break, old files pruned', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'al-')), 'action-log');
  try {
    logAction(dir, { kind: 'input', window: 'Win\n\tdow', action: 'press Enter', outcome: 'done' }, new Date(2026, 9, 1, 12));
    logAction(dir, { kind: 'run', window: 'proj', action: 'test', outcome: 'passed' }, new Date(2026, 10, 10, 9));
    logAction(dir, { kind: 'input', window: 'w', action: 'x'.repeat(500), outcome: 'refused: not allowed' }, new Date(2026, 10, 10, 9, 1));
    assert.deepEqual(await readdir(dir), ['2026-11-10.log'], 'the file from 40 days before is gone');
    const lines = (await readFile(join(dir, '2026-11-10.log'), 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^2026-11-\d\dT\S+\trun\tproj\ttest\tpassed$/, 'the time is written as world time, the file is named by the local day');
    assert.ok(lines[1].length < 400);
    logAction(join(dir, 'x\0bad'), { kind: 'a', window: 'b', action: 'c', outcome: 'd' });
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});
