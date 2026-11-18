import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS_MOST, ScreenTurn, allowedWindow, cleanTyped, isScreenTool, lookText, parseKeys, parsePattern, parseStroke, screenCallWords, screenDefs, screenKind, timingLine, withLine, type ActionEntry, type Looked, type ScreenBackend, type ScreenTurnOpts, type SeenWord, type Win } from '../src/screentools.ts';
import { SCREEN_PS1 } from '../src/winscreen.ts';

// A made-up screen: no real window is listed, looked at, focused, clicked or typed into by these tests.
const RDC: Win = { id: '100', title: '192.168.1.20 - Remote Desktop Connection', process: 'mstsc.exe', x: 10, y: 20, w: 1280, h: 800, minimized: false };
const BANK: Win = { id: '200', title: 'My Bank - Browser', process: 'chrome.exe', x: 0, y: 0, w: 900, h: 700, minimized: false };
const TRICK: Win = { id: '300', title: '192.168.1.200 - Remote Desktop Connection', process: 'mstsc.exe', x: 0, y: 0, w: 800, h: 600, minimized: false };
const LIST = ['mstsc.exe|192.168.1.20 - *'];
const word = (t: string, x: number, y: number): SeenWord => ({ t, x, y, w: t.length * 8, h: 14 });
const MENU: SeenWord[][] = [[word('File', 10, 30), word('Edit', 70, 30), word('View', 130, 30)], [word('Ready', 10, 780), word('for', 55, 780), word('input', 80, 780)]];

function fake(open: Win[] = [RDC, BANK, TRICK], lines: SeenWord[][] = MENU) {
  const did: string[] = [];
  const state = { open: open.map(w => ({ ...w })), lines, lookTitle: null as string | null, front: true };
  const backend: ScreenBackend = {
    windows: async () => state.open.map(w => ({ ...w })),
    look: async (id): Promise<Looked> => {
      did.push(`look ${id}`);
      const w = state.open.find(x => x.id === id)!;
      return { win: { ...w, title: state.lookTitle ?? w.title }, lines: state.lines, lang: 'en-GB', captureMs: 40, ocrMs: 300, image: 'UE5H' };
    },
    focus: async id => (did.push(`focus ${id}`), { front: state.front }),
    click: async (id, _t, x, y, o) => (did.push(`click ${id} ${x},${y} ${o.button}${o.double ? ' double' : ''}`), { front: state.front }),
    keys: async (id, _t, strokes, text) => (did.push(`keys ${id} ${strokes.map(s => s.label).join(' ')}${text ? ` text:${text}` : ''}`), { front: state.front }),
  };
  return { backend, did, state };
}

function turn(f: ReturnType<typeof fake>, o: Partial<ScreenTurnOpts> = {}) {
  const log: ActionEntry[] = [];
  const cards: Array<{ kind: string; what: string; extra?: unknown }> = [];
  let clock = 1000;
  const waits: number[] = [];
  const t = new ScreenTurn({
    windows: LIST, backend: f.backend, perCall: 4000, focus: 'each', input: 'each',
    confirm: async (kind, what, extra) => (cards.push({ kind, what, extra }), true),
    log: e => log.push(e), now: () => (clock += 7), wait: async ms => { waits.push(ms); clock += ms; },
    ...o,
  });
  return { t, log, cards, waits, run: (name: string, args: unknown = {}) => t.run(name, JSON.stringify(args)) };
}

test('the window list: the whole title must fit a line, a program can be named, stars alone are not a line', () => {
  assert.equal(allowedWindow(LIST, RDC), true);
  assert.equal(allowedWindow(LIST, BANK), false);
  assert.equal(allowedWindow(['192.168.1.20'], { title: '192.168.1.200', process: 'mstsc.exe' }), false, 'no match by a longer title');
  assert.equal(allowedWindow(['192.168.1.20'], { title: '192.168.1.20', process: 'x.exe' }), true);
  assert.equal(allowedWindow(LIST, TRICK), false, '192.168.1.200 is not 192.168.1.20');
  assert.equal(allowedWindow(LIST, { ...RDC, process: 'evil.exe' }), false, 'the program must be the one named');
  assert.equal(allowedWindow(['MSTSC|192.168.1.20 - *'], RDC), true, 'the program with or without .exe, in any case');
  assert.equal(allowedWindow(['192.168.1.20 - *'], { title: 'x 192.168.1.20 - y', process: 'a' }), false, 'held at the start too');
  assert.equal(allowedWindow(['a.b'], { title: 'aXb', process: 'p' }), false, 'a dot is a dot');
  for (const bad of ['', '*', ' * ', '**?', '|title', 'x'.repeat(201)]) assert.equal(parsePattern(bad), null, JSON.stringify(bad));
  assert.equal(allowedWindow(['*'], BANK), false);
  assert.equal(allowedWindow([], RDC), false);
});

test('window_list names only the windows on the list; with no list it says none is allowed', async () => {
  const f = fake();
  const out = await turn(f).run('window_list');
  assert.match(out, /192.168.1.20 - Remote Desktop Connection \(mstsc\.exe, 1280 x 800\)/);
  assert.doesNotMatch(out, /Bank|chrome|2200/, 'a window not on the list is never named');
  assert.match(await turn(f, { windows: [] }).run('window_list'), /No window is on the list/);
  assert.match(await turn(f, { windows: ['*'] }).run('window_list'), /No window is on the list/);
  assert.match(await turn(fake([BANK])).run('window_list'), /None of the windows you may look at is open/);
});

test('screen_look reads a listed window as text with places, and nothing else', async () => {
  const f = fake();
  const s = turn(f);
  const out = await s.run('screen_look', { window: RDC.title });
  assert.match(out, /read as text in en-GB/);
  assert.match(out, /\[26,37\] File\n\[86,37\] Edit\n\[146,37\] View\n\[65,787\] Ready for input/, 'words far apart come out apart, each with its middle');
  assert.match(await s.run('screen_look', { window: BANK.title }), /no window called "My Bank - Browser" that you may look at/);
  assert.match(await s.run('screen_look', { window: TRICK.title }), /no window called/);
  assert.match(await s.run('screen_look', {}), /Say which window/);
  assert.deepEqual(f.did, ['look 100'], 'only the listed window was ever looked at');
});

test('the list is checked again when the picture is taken; a minimised window and a locked app are refused', async () => {
  const f = fake();
  f.state.lookTitle = 'Passwords - Notepad';
  const s = turn(f);
  const out = await s.run('screen_look', { window: RDC.title });
  assert.match(out, /changed to one you may not look at/);
  assert.doesNotMatch(out, /File|Edit/, 'what the picture showed is not given');
  assert.match(await turn(fake([{ ...RDC, minimized: true }])).run('screen_look', { window: RDC.title }), /minimised/);
  const locked = fake();
  for (const [name, args] of [['window_list', {}], ['screen_look', { window: RDC.title }], ['click', { window: RDC.title, x: 1, y: 1 }], ['press_key', { window: RDC.title, keys: 'Enter' }]] as const) {
    assert.match(await turn(locked, { locked: () => true }).run(name, args), /TOMLIN is locked/, name);
  }
  assert.deepEqual(locked.did, []);
});

test('text that looks like a key or a password is withheld', async () => {
  const f = fake(undefined, [[word('password', 10, 10), word('=', 80, 10), word('hunter2hunter2hunter2', 95, 10)]]);
  const s = turn(f);
  const out = await s.run('screen_look', { window: RDC.title });
  assert.match(out, /looks like a password, key or token/);
  assert.doesNotMatch(out, /hunter2/);
  assert.equal(JSON.stringify(s.log).includes('hunter2'), false);
  assert.equal(JSON.stringify(s.t.uses).includes('hunter2'), false);
});

test('a look is cut to its room, and every step keeps its times in order', async () => {
  const many = Array.from({ length: 400 }, (_, i) => [word(`line${i}`, 10, i * 20)]);
  const f = fake(undefined, many);
  const s = turn(f, { perCall: 600 });
  const out = await s.run('screen_look', { window: RDC.title });
  assert.ok(out.length <= 600 + 30, `cut to the room (${out.length})`);
  assert.match(out, /\[cut here: no more room\]$/);
  await s.run('window_list');
  const [look, list] = s.t.uses;
  assert.deepEqual([look.name, look.ok, look.captureMs, look.ocrMs], ['screen_look', true, 40, 300], 'the picture and the reading are timed apart');
  assert.ok(look.start <= look.end && look.end <= list.start && list.start <= list.end, 'in order');
  assert.equal(look.ms, look.end - look.start);
  assert.equal(list.captureMs, undefined);
  assert.match(timingLine(s.t.uses), /^Screen: 2 steps, \d+\.\d s in all \(pictures 0\.0 s, reading 0\.3 s\)$/);
  assert.equal(timingLine([]), '');
  assert.equal(lookText([]), '');
});

test('the tools that act are off until turned on, and are not offered then', async () => {
  assert.deepEqual(screenDefs({ focus: false, input: false }).map(d => d.function.name), ['window_list', 'screen_look']);
  assert.deepEqual(screenDefs({ focus: true, input: true }).map(d => d.function.name), ['window_list', 'screen_look', 'window_focus', 'click', 'press_key']);
  assert.deepEqual(['window_list', 'screen_look', 'window_focus', 'click', 'press_key'].map(screenKind), ['screen', 'screen', 'focus', 'input', 'input']);
  assert.equal(isScreenTool('read_file'), false);
  const f = fake();
  const s = turn(f, { focus: 'never', input: 'never' });
  await s.run('screen_look', { window: RDC.title });
  assert.match(await s.run('window_focus', { window: RDC.title }), /turned off/);
  assert.match(await s.run('click', { window: RDC.title, x: 26, y: 37 }), /turned off/);
  assert.match(await s.run('press_key', { window: RDC.title, keys: 'Alt+F' }), /turned off/);
  assert.equal(s.cards.length, 0, 'no card when off');
  assert.deepEqual(f.did, ['look 100']);
  assert.equal(s.log.filter(e => /^refused/.test(e.outcome)).length, 3, 'each refusal is logged');
});

test('a click needs the person\'s yes on its own card every time; a no, or no way to ask, does nothing', async () => {
  const f = fake();
  const no = turn(f, { confirm: async () => false });
  await no.run('screen_look', { window: RDC.title });
  assert.match(await no.run('click', { window: RDC.title, x: 26, y: 37 }), /did not allow clicking or typing.*NOT allowed/s);
  assert.match(await no.run('press_key', { window: RDC.title, keys: 'Alt+F' }), /did not allow/);
  assert.match(await no.run('window_focus', { window: RDC.title }), /did not allow bringing a window to the front/);
  const none = turn(f, { confirm: undefined });
  await none.run('screen_look', { window: RDC.title });
  assert.match(await none.run('click', { window: RDC.title, x: 26, y: 37 }), /did not allow/);
  assert.deepEqual(f.did.filter(d => !d.startsWith('look')), [], 'nothing was clicked, typed or focused');
  assert.equal(no.log.filter(e => /^refused: not allowed/.test(e.outcome)).length, 3);

  const yes = turn(f);
  await yes.run('screen_look', { window: RDC.title });
  assert.match(await yes.run('click', { window: RDC.title, x: 26, y: 37 }), /Done: click at 26, 37/);
  assert.deepEqual(yes.cards, [{ kind: 'input', what: 'click at 26, 37 in "192.168.1.20 - Remote Desktop Connection"', extra: { image: 'UE5H', mark: { x: 26, y: 37, w: 1280, h: 800 } } }]);
  assert.match(await yes.run('click', { window: RDC.title, x: 26, y: 37 }), /look at the window first/i, 'after a click the look is stale: look again');
  await yes.run('screen_look', { window: RDC.title });
  assert.match(await yes.run('click', { window: RDC.title, x: 86, y: 37, button: 'right', double: true }), /Done: double right click/);
  assert.equal(yes.cards.length, 2, 'a card for each click');
  assert.deepEqual(f.did.filter(d => d.startsWith('click')), ['click 100 26,37 left', 'click 100 86,37 right double']);
});

test('a click aimed from a stale look is refused: no look, a moved or resized window, a place outside it', async () => {
  const f = fake();
  const s = turn(f);
  assert.match(await s.run('click', { window: RDC.title, x: 5, y: 5 }), /look at the window first/i);
  await s.run('screen_look', { window: RDC.title });
  assert.match(await s.run('click', { window: RDC.title, x: 5000, y: 5 }), /outside the window/);
  assert.match(await s.run('click', { window: RDC.title, x: 1.5, y: 5 }), /whole numbers/);
  f.state.open[0].x += 30;
  assert.match(await s.run('click', { window: RDC.title, x: 5, y: 5 }), /moved or changed size since you looked/);
  await s.run('screen_look', { window: RDC.title });
  f.state.open[0].w -= 100;
  assert.match(await s.run('click', { window: RDC.title, x: 5, y: 5 }), /moved or changed size/);
  assert.match(await s.run('click', { window: BANK.title, x: 5, y: 5 }), /no window called/);
  assert.equal(s.cards.length, 0, 'none of these reached a card');
  assert.deepEqual(f.did.filter(d => d.startsWith('click')), []);
  // Moved while the card stood open: refused after the yes.
  const g = fake();
  const moved = turn(g, { confirm: async () => { g.state.open[0].y += 5; return true; } });
  await moved.run('screen_look', { window: RDC.title });
  assert.match(await moved.run('click', { window: RDC.title, x: 5, y: 5 }), /moved or changed size while you were asked/);
  // The title left the list while the card stood open.
  const h = fake();
  const renamed = turn(h, { confirm: async () => { h.state.open[0].title = 'Other - Remote Desktop Connection'; return true; } });
  assert.match(await renamed.run('press_key', { window: RDC.title, keys: 'Enter' }), /no longer there, or no longer one you may touch/);
  // Windows could not bring it to the front: said, and nothing claimed.
  const b = fake();
  b.state.front = false;
  assert.match(await turn(b).run('press_key', { window: RDC.title, keys: 'Enter' }), /could not be brought to the front.*nothing was clicked or typed/);
  assert.deepEqual([...g.did, ...h.did].filter(d => !d.startsWith('look')), []);
});

test('the keys that may be pressed, and the ones that never are', async () => {
  const ok: Array<[string, number, string]> = [['a', 0x41, 'A'], ['Z', 0x5a, 'Z'], ['7', 0x37, '7'], ['Left', 0x25, 'Left'], ['up', 0x26, 'Up'], ['RIGHT', 0x27, 'Right'], ['Down', 0x28, 'Down'], ['Tab', 9, 'Tab'], ['Enter', 13, 'Enter'], ['Esc', 27, 'Escape'], ['Escape', 27, 'Escape'], ['F1', 0x70, 'F1'], ['f12', 0x7b, 'F12'], ['Alt+F', 0x46, 'Alt+F'], ['ctrl+s', 0x53, 'Ctrl+S'], ['Ctrl+Shift+Tab', 9, 'Ctrl+Shift+Tab'], ['Alt+F4', 0x73, 'Alt+F4']];
  for (const [raw, vk, label] of ok) {
    const s = parseStroke(raw);
    assert.ok(!('error' in s), raw);
    assert.deepEqual([s.vk, s.label], [vk, label], raw);
  }
  const bad: Array<[string, RegExp]> = [['Win', /Windows key/], ['Win+R', /Windows key/], ['Meta+L', /Windows key/], ['Ctrl+Win', /Windows key/], ['Ctrl+Alt+Del', /Ctrl\+Alt\+Del/], ['ctrl+alt+delete', /Ctrl\+Alt\+Del/], ['Ctrl+Alt+End', /Ctrl\+Alt\+Del/], ['Delete', /not a key that may/], ['F13', /not a key that may/], ['PrintScreen', /not a key that may/], ['Space', /not a key that may/], ['Hyper+A', /not Alt, Ctrl or Shift/], ['Alt+', /not a key/], ['ab', /not a key that may/], ['é', /not a key that may/]];
  for (const [raw, why] of bad) {
    const s = parseStroke(raw);
    assert.ok('error' in s && why.test(s.error), `${raw}: ${'error' in s ? s.error : 'allowed'}`);
  }
  assert.deepEqual((parseKeys('Alt+F Down, Enter') as { strokes: Array<{ label: string }> }).strokes.map(s => s.label), ['Alt+F', 'Down', 'Enter']);
  assert.ok('error' in parseKeys('a b c d e f g'), 'seven keys in one go is too many');
  assert.ok('error' in parseKeys('Alt+F Win+R'), 'one bad key refuses them all');
  assert.deepEqual(cleanTyped('M' + 'x'.repeat(39)), { text: 'M' + 'x'.repeat(39) });
  assert.match((cleanTyped('x'.repeat(41)) as { error: string }).error, /over 40 characters/);
  assert.ok('error' in cleanTyped('a\nb'));
  assert.ok('error' in cleanTyped(5));

  const f = fake();
  const s = turn(f);
  assert.match(await s.run('press_key', { window: RDC.title, keys: 'Win+R' }), /Not pressed: The Windows key/);
  assert.match(await s.run('press_key', { window: RDC.title, keys: 'Ctrl+Alt+Del' }), /Not pressed/);
  assert.match(await s.run('press_key', { window: RDC.title, text: 'x'.repeat(41) }), /over 40 characters/);
  assert.match(await s.run('press_key', { window: RDC.title }), /give the keys/);
  assert.match(await s.run('press_key', { window: RDC.title, keys: 'a', text: 'b' }), /not both/);
  assert.match(await s.run('press_key', { window: BANK.title, keys: 'Enter' }), /no window called/);
  assert.equal(s.cards.length, 0);
  assert.match(await s.run('press_key', { window: RDC.title, keys: 'Alt+F Down' }), /Done: press Alt\+F, Down/);
  assert.match(await s.run('press_key', { window: RDC.title, text: 'G0 X10' }), /Done: type "G0 X10"/);
  assert.deepEqual(f.did, ['keys 100 Alt+F Down', 'keys 100  text:G0 X10']);
  assert.equal(s.log.filter(e => e.kind === 'input' && /^refused/.test(e.outcome)).length, 6, 'a log line for each refusal');
  assert.equal(s.log.filter(e => e.outcome === 'done').length, 2, 'and for each action');
});

test('one action each 500 ms, 30 in an answer, each logged without anything read from the screen', async () => {
  const f = fake();
  const s = turn(f);
  for (let i = 0; i < ACTIONS_MOST; i++) assert.match(await s.run('press_key', { window: RDC.title, keys: 'Down' }), /^Done/, `press ${i + 1}`);
  assert.equal(s.waits.length, ACTIONS_MOST - 1, 'a wait before each but the first');
  assert.ok(s.waits.every(ms => ms > 0 && ms <= 500));
  assert.match(await s.run('press_key', { window: RDC.title, keys: 'Down' }), /30 actions is the most in one answer/);
  assert.match(await s.run('window_focus', { window: RDC.title }), /30 actions is the most/, 'bringing to the front counts too');
  assert.equal(f.did.length, ACTIONS_MOST);
  assert.equal(s.log.length, ACTIONS_MOST + 2);
  assert.deepEqual(s.log[0], { kind: 'input', window: RDC.title, action: `press Down in "${RDC.title}"`, outcome: 'done' });
  await s.run('screen_look', { window: RDC.title });
  assert.equal(JSON.stringify(s.log).includes('File'), false, 'the log never holds what a look read');
});

test('window_focus asks each time and says when Windows refused', async () => {
  const f = fake();
  const s = turn(f);
  assert.match(await s.run('window_focus', { window: RDC.title }), /is in front now/);
  assert.deepEqual(s.cards, [{ kind: 'focus', what: `bring "${RDC.title}" to the front`, extra: undefined }]);
  assert.deepEqual(f.did, ['focus 100']);
});

test('the words shown while a call runs name the window, and the system line is added once', () => {
  assert.equal(screenCallWords('screen_look', JSON.stringify({ window: 'Calc' })), 'TOMLIN is looking at Calc…');
  assert.equal(screenCallWords('screen_look', 'not json'), 'TOMLIN is looking at a window…');
  assert.match(screenCallWords('click', '{}'), /wants to click/);
  assert.deepEqual(withLine([{ role: 'user', content: 'hi' }], 'L'), [{ role: 'system', content: 'L' }, { role: 'user', content: 'hi' }]);
  assert.deepEqual(withLine([{ role: 'system', content: 'S' }], 'L'), [{ role: 'system', content: 'S\n\nL' }]);
});

test('the Windows script parses (it is not run: nothing on the real screen is listed, read or touched)', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  assert.doesNotMatch(SCREEN_PS1, /\$\{/, 'no JavaScript fill-in left in the script');
  assert.match(SCREEN_PS1, /IAsyncOperation`1/);
  // An open menu is a window of its own: the look draws the program's own pop-ups over the picture, nobody else's.
  assert.match(SCREEN_PS1, /\[TomlinWin\]::Over\(\$h\)/);
  assert.match(SCREEN_PS1, /Pid\(w\) == pid && \(OwnedBy\(w, h\) \|\| GetWindowTextLength\(w\) == 0\)/);
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-ps-'));
  try {
    writeFileSync(join(dir, 'screen.ps1'), `﻿${SCREEN_PS1}`, 'utf8');
    writeFileSync(join(dir, 'parse.ps1'), '﻿param($f)\n$e = $null; $t = $null\n[void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e)\nif ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }\n"ok"', 'utf8');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'parse.ps1'), join(dir, 'screen.ps1')], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.trim(), 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
