// Repair install (src/repair.ts): an install left behind while a copy started from a folder ran and took the updates;
// a whole install has nothing to repair; the source tree is never copied in; Start with Windows from a folder copy
// starts the install's program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planRepair, runRepair, desktopShortcut, makeDesktopShortcut, type RepairDeps } from '../src/repair.ts';
import { CURRENT, EXE, KEY_FILES, LINK, OLD_LINKS, startupScriptFor } from '../src/installer.ts';
import { autostart, STARTUP_FILE } from '../src/autostart.ts';
import { STAMP } from '../src/trayfresh.ts';
import { VCRT_DLLS } from '../src/vcrt.ts';

/** A copy of `version` in `dir` with every key file (missing ones left out). */
function copy(dir: string, version: string, without: string[] = []) {
  for (const f of KEY_FILES) {
    if (without.includes(f)) continue;
    const p = join(dir, ...f.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f === 'package.json' ? JSON.stringify({ version }) : f === 'tools/tray.cs' ? `class Tray { /* ${version} */ }` : 'x');
  }
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'public', 'icon.ico'), 'icon');
}

/** Places for one test, and stand-ins for PowerShell, the compiler and reg.exe that keep what they were told. */
function world() {
  const t = mkdtempSync(join(tmpdir(), 'sm-repair-'));
  const env = {
    TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'Smart Manager'),
    TOMLIN_START_MENU_DIR: join(t, 'menu'),
    TOMLIN_STARTUP_DIR: join(t, 'startup'),
    TOMLIN_DESKTOP_DIR: join(t, 'desk'),
    TOMLIN_UNINSTALL_KEY: 'HKCU\\Software\\SmartManagerTestRepair',
    TOMLIN_VCRT_DIR: join(t, 'system32'),
  };
  for (const d of [env.TOMLIN_START_MENU_DIR, env.TOMLIN_STARTUP_DIR, env.TOMLIN_DESKTOP_DIR, env.TOMLIN_VCRT_DIR]) mkdirSync(d, { recursive: true });
  for (const f of VCRT_DLLS) writeFileSync(join(env.TOMLIN_VCRT_DIR, f), 'dll');
  const links = new Map<string, string>();
  const reg = { version: '' };
  const lnkOf = (s: string) => /CreateShortcut\('((?:[^']|'')+)'\)/.exec(s)![1].replace(/''/g, "'");
  const d: RepairDeps = {
    ps: async s => {
      if (s.includes('$s.Save()')) {
        const lnk = lnkOf(s);
        links.set(lnk, /\$s\.TargetPath = '((?:[^']|'')+)'/.exec(s)![1].replace(/''/g, "'"));
        writeFileSync(lnk, 'shortcut');
        return '';
      }
      if (s.includes('.TargetPath')) return links.get(lnkOf(s)) ?? '';
      if (s.includes('DisplayVersion')) return reg.version;
      throw new Error(`unexpected PowerShell: ${s}`);
    },
    build: async o => writeFileSync(o.out, `built from ${o.source}`),
    reg: async a => {
      if (a.includes('DisplayVersion')) reg.version = a[a.indexOf('/d') + 1];
    },
    desktop: async () => env.TOMLIN_DESKTOP_DIR,
  };
  const root = env.TOMLIN_INSTALL_ROOT;
  return { t, env, d, links, reg, root, exe: join(root, EXE), done: () => rmSync(t, { recursive: true, force: true }) };
}

test('an install left on 2.0.34 while a folder copy ran 2.0.44: the copy goes in, and everything points at TOMLIN.exe', async () => {
  const w = world();
  copy(join(w.root, 'shelby-2.0.34'), '2.0.34');
  writeFileSync(join(w.root, CURRENT), 'shelby-2.0.34');
  writeFileSync(w.exe, 'old program');
  writeFileSync(join(w.root, 'icon.ico'), 'icon');
  writeFileSync(join(w.root, STAMP), 'an older tray.cs');
  const unzipped = join(w.t, 'Downloads', 'shelby-2.0.36');
  copy(unzipped, '2.0.44');
  // The Start with Windows entry the folder copy made: its own Start Shelby.cmd.
  writeFileSync(join(w.env.TOMLIN_STARTUP_DIR, STARTUP_FILE), `@echo off\r\nstart "TOMLIN" /min "${unzipped}\\Start Shelby.cmd"\r\n`);
  w.reg.version = '2.0.34';

  const plan = await planRepair({ here: unzipped, version: '2.0.44', env: w.env }, w.d);
  assert.equal(plan.outside, true);
  const said = plan.steps.map(s => s.say).join('\n');
  assert.match(said, /Copy this TOMLIN \(2\.0\.44\) into the install folder: the installed copy is 2\.0\.34/);
  assert.match(said, /Build TOMLIN.exe again/);
  assert.match(said, /Point current\.txt at the new copy/);
  assert.match(said, /Add TOMLIN to the Start menu/);
  assert.match(said, /Make "Start with Windows" start TOMLIN.exe \(it started .*Start Shelby\.cmd\)/);
  assert.match(said, /Show 2\.0\.44 in Settings > Apps \(it says 2\.0\.34\)/);
  assert.deepEqual(plan.left, []);

  const r = await runRepair(plan);
  assert.deepEqual(r.failed, []);
  assert.equal(readFileSync(join(w.root, CURRENT), 'utf8'), 'tomlin-2.0.44');
  for (const f of KEY_FILES) assert.ok(existsSync(join(w.root, 'tomlin-2.0.44', ...f.split('/'))), f);
  assert.match(readFileSync(w.exe, 'utf8'), /tomlin-2\.0\.44[\\/]tools[\\/]tray\.cs$/);
  assert.equal(readFileSync(join(w.root, 'TOMLIN.old.exe'), 'utf8'), 'old program');
  assert.equal(readFileSync(join(w.env.TOMLIN_STARTUP_DIR, STARTUP_FILE), 'utf8'), startupScriptFor(w.exe));
  assert.equal(w.links.get(join(w.env.TOMLIN_START_MENU_DIR, LINK)), w.exe);
  assert.equal(w.reg.version, '2.0.44');
  // The folder copy is only read.
  assert.ok(existsSync(join(unzipped, 'src', 'server.ts')));

  // Asked again, from either copy: nothing left to do (the old program goes at the next start, as src/trayfresh.ts does).
  assert.deepEqual((await planRepair({ here: unzipped, version: '2.0.44', env: w.env }, w.d)).steps.map(s => s.say), []);
  assert.deepEqual((await planRepair({ here: join(w.root, 'tomlin-2.0.44'), version: '2.0.44', env: w.env }, w.d)).steps.map(s => s.say), []);
  // Start with Windows, asked from the folder copy, now means the install's program (it is whole and as new).
  assert.equal(await autostart(unzipped, w.env).on(), true);
  w.done();
});

test('shortcuts under the earlier name that open this app are replaced by TOMLIN ones', async () => {
  const w = world();
  const app = join(w.root, 'shelby-2.0.44');
  copy(app, '2.0.44');
  const oldDesk = join(w.env.TOMLIN_DESKTOP_DIR, OLD_LINKS[0]!);
  const oldMenu = join(w.env.TOMLIN_START_MENU_DIR, OLD_LINKS[0]!);
  for (const l of [oldDesk, oldMenu]) {
    writeFileSync(l, 'shortcut');
    w.links.set(l, w.exe);
  }
  const plan = await planRepair({ here: app, version: '2.0.44', env: w.env }, w.d);
  const said = plan.steps.map(s => s.say).join('\n');
  assert.match(said, /Add the TOMLIN shortcut to the desktop/);
  assert.match(said, /Remove the old shortcut/);
  const r = await runRepair(plan);
  assert.deepEqual(r.failed, []);
  assert.equal(w.links.get(join(w.env.TOMLIN_DESKTOP_DIR, LINK)), w.exe);
  assert.equal(w.links.get(join(w.env.TOMLIN_START_MENU_DIR, LINK)), w.exe);
  assert.ok(!existsSync(oldDesk) && !existsSync(oldMenu));
  w.done();
});

test('the installed copy itself: a missing desktop target and current.txt are put back; missing files are said, not faked', async () => {
  const w = world();
  const app = join(w.root, 'shelby-2.0.44');
  copy(app, '2.0.44', ['runtime/llama-cpu/llama-server.exe']);
  writeFileSync(join(w.env.TOMLIN_DESKTOP_DIR, LINK), 'shortcut');
  w.links.set(join(w.env.TOMLIN_DESKTOP_DIR, LINK), 'D:\\old\\Start Shelby.cmd');
  const plan = await planRepair({ here: app, version: '2.0.44', env: w.env }, w.d);
  const said = plan.steps.map(s => s.say).join('\n');
  assert.match(said, /Build TOMLIN.exe: it is missing/);
  assert.match(said, /Point current\.txt at shelby-2\.0\.44/);
  assert.match(said, /Point the desktop shortcut at TOMLIN.exe \(it opened D:\\old\\Start Shelby\.cmd\)/);
  assert.match(plan.left.join(' '), /Files are missing from .*runtime\/llama-cpu\/llama-server\.exe/);
  const r = await runRepair(plan);
  assert.deepEqual(r.failed, []);
  assert.equal(readFileSync(join(w.root, CURRENT), 'utf8'), 'shelby-2.0.44');
  assert.equal(w.links.get(join(w.env.TOMLIN_DESKTOP_DIR, LINK)), w.exe);
  w.done();
});

test('the source folder is never copied in, and a missing Visual C++ Runtime is said', async () => {
  const w = world();
  const src = join(w.t, 'shelby-2');
  copy(src, '2.0.44');
  mkdirSync(join(src, '.git'));
  rmSync(join(w.env.TOMLIN_VCRT_DIR, 'msvcp140.dll'));
  const plan = await planRepair({ here: src, version: '2.0.44', env: w.env }, w.d);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.installed, false);
  assert.match(plan.left[0], /not installed on this PC: this copy runs from its source folder/);
  assert.match(plan.left[1], /Visual C\+\+ Runtime \(msvcp140\.dll missing\)/);
  assert.equal(existsSync(w.root), false);
  w.done();
});

test('Shortcut to desktop: the install\'s program when there is one, else the copy\'s Start TOMLIN.cmd', async () => {
  const w = world();
  const unzipped = join(w.t, 'shelby-2.0.44');
  copy(unzipped, '2.0.44');
  const o = { here: unzipped, version: '2.0.44', env: w.env };
  assert.equal((await desktopShortcut(o, w.d)).there, false);
  await makeDesktopShortcut(o, w.d);
  assert.equal(w.links.get(join(w.env.TOMLIN_DESKTOP_DIR, LINK)), join(unzipped, 'Start TOMLIN.cmd'));
  await runRepair(await planRepair(o, w.d));
  await makeDesktopShortcut(o, w.d);
  assert.equal(w.links.get(join(w.env.TOMLIN_DESKTOP_DIR, LINK)), w.exe);
  assert.equal((await desktopShortcut(o, w.d)).there, true);
  w.done();
});
