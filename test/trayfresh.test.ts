// An installed copy builds its program (TOMLIN.exe) again when its update brought a changed tools/tray.cs (src/trayfresh.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followAppsEntry, refreshTray, STAMP, traySum, type Build, type Reg } from '../src/trayfresh.ts';
const OLD_EXE = 'TOMLIN.old.exe';
import { CURRENT, EXE } from '../src/installer.ts';

/** An install folder with one copy in it, its tray.cs saying `source`. */
function installed(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'sm-tray-'));
  const app = join(root, 'tomlin-9.9.9');
  mkdirSync(join(app, 'tools'), { recursive: true });
  writeFileSync(join(app, 'tools', 'tray.cs'), source);
  writeFileSync(join(root, CURRENT), 'tomlin-9.9.9');
  writeFileSync(join(root, EXE), 'the program built before');
  return { root, app };
}
const builds: string[] = [];
const fake: Build = async o => {
  builds.push(o.source);
  writeFileSync(o.out, 'the program built now');
};

test('a copy that is not installed (unzipped, or the source tree) is left alone', async () => {
  const t = mkdtempSync(join(tmpdir(), 'sm-tray-'));
  mkdirSync(join(t, 'app', 'tools'), { recursive: true });
  writeFileSync(join(t, 'app', 'tools', 'tray.cs'), 'x');
  assert.equal(await refreshTray(join(t, 'app'), fake), 'not-installed');
  rmSync(t, { recursive: true, force: true });
});

test('a changed tray.cs builds the program again: the old one is renamed, the new one takes its name, then nothing until it changes', async () => {
  const { root, app } = installed('class A {}\r\n');
  builds.length = 0;
  assert.equal(await refreshTray(app, fake), 'built');
  assert.equal(readFileSync(join(root, EXE), 'utf8'), 'the program built now');
  assert.equal(readFileSync(join(root, OLD_EXE), 'utf8'), 'the program built before');
  assert.equal(readFileSync(join(root, STAMP), 'utf8'), await traySum(app));
  // Started again: the old one goes, and the same tray.cs (with either line ending) builds nothing.
  writeFileSync(join(app, 'tools', 'tray.cs'), 'class A {}\n');
  assert.equal(await refreshTray(app, fake), 'same');
  assert.equal(existsSync(join(root, OLD_EXE)), false);
  assert.equal(builds.length, 1);
  writeFileSync(join(app, 'tools', 'tray.cs'), 'class B {}\n');
  assert.equal(await refreshTray(app, fake), 'built');
  assert.equal(builds.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test('Settings > Apps follows the version that runs after an update made inside the app, and nothing else is touched', async () => {
  const { root, app } = installed('class A {}');
  const key = 'HKCU\\Software\\TomlinTestOnly';
  const env = { TOMLIN_INSTALL_ROOT: root, TOMLIN_UNINSTALL_KEY: key };
  let listed: string | null = '2.0.81';
  const calls: string[][] = [];
  const reg: Reg = async args => {
    calls.push(args);
    if (args[0] === 'add') { listed = args[args.indexOf('/d') + 1]; return ''; }
    if (listed === null) throw new Error('not there');
    return `\r\n${key}\r\n    DisplayVersion    REG_SZ    ${listed}\r\n\r\n`;
  };
  assert.equal(await followAppsEntry(app, '2.0.99', env, reg), 'set');
  assert.equal(listed, '2.0.99');
  assert.deepEqual(calls.at(-1), ['add', key, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', '2.0.99', '/f']);
  assert.equal(await followAppsEntry(app, '2.0.99', env, reg), 'same');
  // No entry: not made here (Repair makes it).
  listed = null;
  calls.length = 0;
  assert.equal(await followAppsEntry(app, '2.0.99', env, reg), 'none');
  assert.equal(calls.filter(c => c[0] === 'add').length, 0);
  // An older copy kept beside it, a copy outside the install folder, a test copy, no key: never asked at all.
  listed = '2.0.81';
  calls.length = 0;
  mkdirSync(join(root, 'tomlin-2.0.81'));
  assert.equal(await followAppsEntry(join(root, 'tomlin-2.0.81'), '2.0.81', env, reg), 'none');
  assert.equal(await followAppsEntry(app, '2.0.99', { ...env, TOMLIN_INSTALL_ROOT: join(root, 'elsewhere') }, reg), 'none');
  assert.equal(await followAppsEntry(app, '2.0.99', { ...env, TOMLIN_DATA: join(root, 'data') }, reg), 'none');
  assert.equal(await followAppsEntry(app, '2.0.99', { ...env, TOMLIN_UNINSTALL_KEY: 'none' }, reg), 'none');
  assert.equal(calls.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('a failed build changes nothing: the program in use stays, no stamp is written', async () => {
  const { root, app } = installed('class A {}');
  await assert.rejects(refreshTray(app, async () => { throw new Error('no compiler'); }), /no compiler/);
  assert.equal(readFileSync(join(root, EXE), 'utf8'), 'the program built before');
  assert.equal(existsSync(join(root, STAMP)), false);
  rmSync(root, { recursive: true, force: true });
});

test('Windows lets the RUNNING program be renamed and replaced', { skip: process.platform !== 'win32' }, async () => {
  const { root, app } = installed('class A {}');
  copyFileSync(process.execPath, join(root, EXE));
  const running = spawn(join(root, EXE), ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  try {
    assert.equal(await refreshTray(app, fake), 'built');
    assert.equal(readFileSync(join(root, EXE), 'utf8'), 'the program built now');
    assert.ok(existsSync(join(root, OLD_EXE)), 'the running one carries on as the old one');
    // While it still runs the old one cannot be deleted, so a second change waits for the next start.
    writeFileSync(join(app, 'tools', 'tray.cs'), 'class B {}');
    await assert.rejects(refreshTray(app, fake), /still in use/);
    assert.equal(readFileSync(join(root, EXE), 'utf8'), 'the program built now');
  } finally {
    running.kill();
    await new Promise(r => running.once('exit', r));
    rmSync(root, { recursive: true, force: true });
  }
});
