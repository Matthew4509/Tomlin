import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as link from '../src/link.ts';
import { HELPER_APP, HELPER_TOOLS, Helper, MACHINE_TOOLS, callHelper, cleanHelperState, cleanHelperUrl, cleanHelpers, helperView, linkHelper, newHelperState, type HelperAsk, type HelperLink, type HelperState } from '../src/camhelper.ts';
import { MachineTurn } from '../src/machinetools.ts';
import { CAM_PS1 } from '../tools/cam-helper.ts';

// A made-up helper, joined to TOMLIN's side in memory: no network, no laptop, no real program is read.
function setup(o: { read?: (tool: string, args: Record<string, unknown>) => Promise<string>; address?: string } = {}) {
  const state = newHelperState('Laptop');
  const reads: Array<[string, Record<string, unknown>]> = [];
  let saved: HelperState | null = null;
  const helper = new Helper(state, {
    read: async (tool, args) => (reads.push([tool, args]), o.read ? o.read(tool, args) : 'Menus of Alphacam:\nFile\n  Open  [Ctrl+O]\n  Save  (greyed)\nEdit'),
    save: async s => void (saved = s),
  });
  const sent: HelperAsk[] = [];
  const net = { address: o.address ?? '192.168.0.50' };
  const get = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const ask: HelperAsk = { method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : {}, address: net.address };
    sent.push(ask);
    const a = await helper.handle(ask);
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { helper, state, reads, sent, get, net, saved: () => saved };
}
const ME = { id: 'aabbccdd', name: 'Main PC' };
const linked = async (s: ReturnType<typeof setup>) => {
  const h = await linkHelper('192.168.1.20', s.state.code, ME, s.get);
  assert.ok(!('error' in h), 'error' in h ? h.error : '');
  return h as HelperLink;
};

test('the helper says who it is: no models, its two read tools', async () => {
  const s = setup();
  const who = await s.helper.handle({ method: 'GET', path: '/helper/whoami', body: {}, address: '192.168.0.50' });
  assert.deepEqual(who.body, { app: HELPER_APP, link: link.LINK_VERSION, id: s.state.id, name: 'Laptop', models: [], tools: ['cam_menus', 'cam_window_state'] });
  assert.deepEqual(MACHINE_TOOLS.map(t => t.function.name), [...HELPER_TOOLS]);
});

test('linking needs the code shown on the laptop; the code never crosses, and wrong codes are slowed', async () => {
  const s = setup();
  const h = await linked(s);
  assert.equal(h.url, 'http://192.168.1.20:8742');
  assert.deepEqual([h.id, h.name, h.tools], [s.state.id, 'Laptop', ['cam_menus', 'cam_window_state']]);
  assert.equal(JSON.stringify(s.sent).includes(s.state.code), false, 'the code is not in anything sent');
  assert.equal(s.saved()?.links.length, 1, 'the helper kept the link');
  assert.deepEqual(helperView(h), { id: h.id, name: 'Laptop', url: h.url, tools: h.tools, models: [], role: 'Laptop helper' });
  assert.equal('key' in helperView(h), false, 'the page is never given the key');

  const wrong = setup();
  for (let i = 0; i < 5; i++) assert.match(((await linkHelper('192.168.1.20', 'WRONGCODE123', ME, wrong.get)) as { error: string }).error, /setup code is not the one/);
  assert.match(((await linkHelper('192.168.1.20', wrong.state.code, ME, wrong.get)) as { error: string }).error, /Too many wrong codes/, 'even the right code waits after five wrong ones');
  assert.equal(wrong.saved(), null);
});

test('only a home-network address is linked to, and only by number', async () => {
  for (const bad of ['8.8.8.8', 'example.com', 'laptop.local', 'http://1.2.3.4:8742', '', 'not an address at all']) assert.ok('error' in cleanHelperUrl(bad), bad);
  assert.deepEqual(cleanHelperUrl('192.168.1.20'), { url: 'http://192.168.1.20:8742' });
  assert.deepEqual(cleanHelperUrl('10.0.0.5:9000/'), { url: 'http://10.0.0.5:9000' });
  const s = setup();
  assert.match(((await linkHelper('8.8.8.8', s.state.code, ME, s.get)) as { error: string }).error, /not an address on your home network/);
  assert.equal(s.sent.length, 0, 'nothing was sent anywhere');
});

test('a read crosses sealed both ways and gives the menu text', async () => {
  const s = setup();
  const h = await linked(s);
  const text = await callHelper(h, ME.id, 'cam_menus', { menu: 'File' }, s.get);
  assert.match(text, /File\n  Open  \[Ctrl\+O\]\n  Save  \(greyed\)/);
  assert.deepEqual(s.reads, [['cam_menus', { menu: 'File' }]]);
  const wire = JSON.stringify(s.sent.at(-1));
  assert.equal(/cam_menus|File/.test(wire), false, 'what was asked is sealed on the way');
});

test('the helper refuses a caller from outside the home network, whatever it sends', async () => {
  const s = setup();
  const h = await linked(s);
  s.net.address = '8.8.8.8';
  await assert.rejects(callHelper(h, ME.id, 'cam_menus', {}, s.get), /only on the home network/);
  for (const address of ['8.8.8.8', '2001:db8::1', undefined, '']) {
    for (const [method, path] of [['GET', '/helper/whoami'], ['POST', '/helper/pair'], ['POST', '/helper/tool']]) {
      assert.equal((await s.helper.handle({ method, path, body: {}, address })).status, 403, `${address} ${path}`);
    }
  }
  assert.equal(s.reads.length, 0);
});

test('the helper refuses a request that is not sealed, sealed with other keys, sent again, or for the wrong door', async () => {
  const s = setup();
  const h = await linked(s);
  const keys = link.keysOf(h.key)!;
  const post = (body: Record<string, unknown>) => s.helper.handle({ method: 'POST', path: '/helper/tool', body, address: '192.168.0.50' });
  assert.equal((await post({ from: ME.id, tool: 'cam_menus' })).status, 401, 'not sealed');
  assert.equal((await post({ from: 'stranger', ...link.sealRequest(keys, '/helper/tool', { tool: 'cam_menus' }) })).status, 401, 'a PC that is not linked');
  const other = link.keysOf(link.keysText(Buffer.alloc(64, 7)))!;
  assert.equal((await post({ from: ME.id, ...link.sealRequest(other, '/helper/tool', { tool: 'cam_menus' }) })).status, 401, 'sealed with other keys');
  assert.equal((await post({ from: ME.id, ...link.sealRequest(keys, '/worker/chat', { tool: 'cam_menus' }) })).status, 401, 'the wrong door');
  assert.equal((await post({ from: ME.id, ...link.sealRequest(keys, '/helper/tool', { tool: 'cam_menus' }, Date.now() - 60 * 60_000) })).status, 401, 'an old copy');
  const once = { from: ME.id, ...link.sealRequest(keys, '/helper/tool', { tool: 'cam_menus' }) };
  assert.equal((await post(once)).status, 200);
  const again = await post(once);
  assert.equal(again.status, 401, 'the same message sent again');
  assert.match(String(again.body.error), /already taken once/);
  assert.equal(s.reads.length, 1, 'only the one good request read anything');
  for (const [method, path] of [['POST', '/helper/run'], ['GET', '/'], ['POST', '/worker/pair'], ['GET', '/helper/tool']]) assert.equal((await s.helper.handle({ method, path, body: {}, address: '127.0.0.1' })).status, 404, path);
});

test('the helper runs only its own fixed tools, whatever a linked PC asks for', async () => {
  const s = setup();
  const h = await linked(s);
  for (const tool of ['cam_run_command', 'click', 'run', '__proto__', '']) {
    await assert.rejects(callHelper({ ...h, tools: [tool as 'cam_menus'] }, ME.id, tool as 'cam_menus', {}, s.get), /no such tool/, tool);
  }
  await assert.rejects(callHelper({ ...h, tools: ['cam_menus'] }, ME.id, 'cam_window_state', {}, s.get), /does not offer cam_window_state/);
  assert.equal(s.reads.length, 0);
});

test('a helper with no models and a tools list is kept clean; a damaged entry is dropped', async () => {
  const s = setup();
  const h = await linked(s);
  assert.deepEqual(cleanHelpers([h, { ...h, key: 'short' }, { ...h, id: 'nope' }, { ...h, url: 'https://evil.example/x' }, null, 'x']), [h]);
  assert.deepEqual(cleanHelpers([{ ...h, tools: ['cam_menus', 'cam_run_command', 5] }])[0].tools, ['cam_menus']);
  assert.deepEqual(cleanHelpers(undefined), []);
  assert.equal(cleanHelperState({ id: 'x' }), null);
  assert.deepEqual(cleanHelperState(JSON.parse(JSON.stringify(s.helper.state))), s.helper.state);
});

test('one answer\'s use: cut to the room, a secret withheld, a fault said plainly, each use timed', async () => {
  const s = setup();
  const h = await linked(s);
  let clock = 0;
  const turn = (perCall = 4000) => new MachineTurn({ helper: h, me: ME.id, perCall, get: s.get, now: () => (clock += 25) });
  const t = turn();
  assert.deepEqual(t.defs.map(d => d.function.name), ['cam_menus', 'cam_window_state']);
  assert.match(await t.run('cam_menus', '{"menu":"File","other":"dropped"}'), /Open  \[Ctrl\+O\]/);
  assert.deepEqual(s.reads.at(-1), ['cam_menus', { menu: 'File' }], 'only the menu name goes over');
  assert.deepEqual(t.uses, [{ name: 'cam_menus', input: 'Laptop', ok: true, said: '5 lines', ms: 25 }]);
  assert.match(await t.run('cam_run_command', '{}'), /no tool called/);

  const long = setup({ read: async () => Array.from({ length: 500 }, (_, i) => `Item ${i}`).join('\n') });
  const lt = new MachineTurn({ helper: await linked(long), me: ME.id, perCall: 600, get: long.get });
  const cut = await lt.run('cam_menus', '{}');
  assert.ok(cut.length < 700);
  assert.match(cut, /\[cut here: no more room/);

  const secret = setup({ read: async () => 'Dialog: Login\n  Edit: password = hunter2hunter2hunter2' });
  const st = new MachineTurn({ helper: await linked(secret), me: ME.id, perCall: 4000, get: secret.get });
  const withheld = await st.run('cam_window_state', '{}');
  assert.match(withheld, /withheld/);
  assert.doesNotMatch(withheld, /hunter2/);

  const off = setup({ read: async () => { throw new Error('"acam" is not running on the laptop (no window of that program was found).'); } });
  const ot = new MachineTurn({ helper: await linked(off), me: ME.id, perCall: 4000, get: off.get });
  assert.match(await ot.run('cam_menus', '{}'), /Not read: "acam" is not running.*do not describe its menus/s);
  assert.equal(ot.uses[0].ok, false);

  const down = new MachineTurn({ helper: h, me: ME.id, perCall: 4000, get: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.match(await down.run('cam_menus', '{}'), /did not answer.*Is the laptop on/s);
});

test('the laptop\'s script parses, and the helper needs only four files there', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  assert.doesNotMatch(CAM_PS1, /\$\{/);
  assert.doesNotMatch(CAM_PS1, /SendInput|SetCursorPos|keybd_event|mouse_event|InvokePattern|ExpandCollapse|\.Invoke\(\)|SetForegroundWindow|PostMessage|SendMessage/, 'the laptop\'s script has nothing that clicks, types, opens or runs');
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-cam-'));
  try {
    writeFileSync(join(dir, 'cam.ps1'), `﻿${CAM_PS1}`, 'utf8');
    writeFileSync(join(dir, 'parse.ps1'), '﻿param($f)\n$e = $null; $t = $null\n[void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e)\nif ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }\n"ok"', 'utf8');
    assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'parse.ps1'), join(dir, 'cam.ps1')], { encoding: 'utf8', windowsHide: true }).trim(), 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // What the laptop's copy loads when it runs: these files only (a type-only import is not loaded).
  const loads = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^;]*? from '(\.[^']+)';/gm)].map(m => m[1]);
  assert.deepEqual(loads('tools/cam-helper.ts'), ['../src/camhelper.ts']);
  assert.deepEqual(loads('src/camhelper.ts').sort(), ['./link.ts', './share.ts']);
  assert.deepEqual(loads('src/link.ts'), []);
  assert.deepEqual(loads('src/share.ts'), []);
});
