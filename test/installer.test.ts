// The installer (src/installer.ts, tools/install.ts, tools/tray.cs, Install TOMLIN.cmd): where things go, the
// questions, the shortcut, registry and firewall lines, which old copies go, Start with Windows for an installed copy,
// a whole install into a test folder (no registry, no Start menu of his), and the program compiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as inst from '../src/installer.ts';
import { installedExe, startupScript } from '../src/autostart.ts';
import { PARTS } from '../src/update.ts';
import { refreshTray, STAMP, traySum } from '../src/trayfresh.ts';

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sm-inst-'));
  made.push(d);
  return d;
};
// A real install copies the whole app (about 370 MB with its Node.js): nothing is left behind.
process.on('exit', () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const ROOT = new URL('..', import.meta.url);
const rootPath = decodeURIComponent(ROOT.pathname).replace(/^\/([A-Za-z]:)/, '$1');

test('places: the install folder is per user under Programs; tests move each place', () => {
  const p = inst.places({ LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local', APPDATA: 'C:\\Users\\A\\AppData\\Roaming', SystemRoot: 'C:\\Windows' });
  assert.equal(p.root, join('C:\\Users\\A\\AppData\\Local', 'Programs', 'TOMLIN'));
  assert.equal(p.startMenu, join('C:\\Users\\A\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  assert.equal(p.uninstallKey, inst.DEFAULT_UNINSTALL_KEY);
  assert.ok(p.uninstallKey!.startsWith('HKCU\\'), 'this user only: no administrator');
  assert.equal(p.desktop, null);
  assert.equal(inst.places({ TOMLIN_UNINSTALL_KEY: 'none' }).uninstallKey, null);
  assert.equal(inst.places({ TOMLIN_INSTALL_ROOT: 'X:\\t' }).root, 'X:\\t');
});

test('an install made before the TOMLIN name keeps its folder, program and Settings > Apps entry; a new one gets TOMLIN', () => {
  const local = tmp();
  const env = { LOCALAPPDATA: local, APPDATA: join(local, 'r') };
  // Nothing installed: the TOMLIN names.
  assert.equal(inst.places(env).root, join(local, 'Programs', 'TOMLIN'));
  assert.equal(inst.places(env).uninstallKey, inst.DEFAULT_UNINSTALL_KEY);
  assert.ok(inst.DEFAULT_UNINSTALL_KEY.endsWith('\\TOMLIN'));
  // An older install in Programs\Smart Manager: found there, with its own program and entry (nothing is moved).
  const old = join(local, 'Programs', 'Smart Manager');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, inst.CURRENT), 'tomlin-2.0.47');
  writeFileSync(join(old, 'Smart Manager.exe'), '');
  const p = inst.places(env);
  assert.equal(p.root, old);
  assert.equal(inst.exeIn(old), join(old, 'Smart Manager.exe'));
  assert.equal(p.uninstallKey, inst.FORMER.key);
  assert.match(inst.registryArgs('HKCU\\X', { root: old, version: '2.0.48', kb: 1 }).find(a => a[3] === 'UninstallString')![7], /Smart Manager\.exe" --uninstall$/);
  assert.equal(inst.sideExe(inst.exeIn(old), 'old'), join(old, 'Smart Manager.old.exe'));
  // A TOMLIN install beside it wins (a new install was made since).
  const now = join(local, 'Programs', 'TOMLIN');
  mkdirSync(now, { recursive: true });
  writeFileSync(join(now, inst.CURRENT), 'tomlin-2.0.48');
  assert.equal(inst.places(env).root, now);
  assert.equal(inst.exeIn(now), join(now, 'TOMLIN.exe'));
  assert.equal(inst.sideExe(join(now, 'TOMLIN.exe'), 'new'), join(now, 'TOMLIN.new.exe'));
});

test('the first question: install, update, repair, or a newer one already there (nothing changed)', () => {
  assert.deepEqual(inst.firstQuestion(null, '2.0.34'), { text: 'Install TOMLIN 2.0.34 for this Windows user?', yesDefault: true, go: true });
  assert.match(inst.firstQuestion('2.0.33', '2.0.34').text, /2.0.33 is already installed. Update to 2.0.34\?/);
  assert.equal(inst.firstQuestion('2.0.33', '2.0.34').yesDefault, true);
  assert.match(inst.firstQuestion('2.0.34', '2.0.34').text, /repair/);
  assert.equal(inst.firstQuestion('2.0.34', '2.0.34').yesDefault, false);
  assert.equal(inst.firstQuestion('2.0.40', '2.0.34').go, false);
  assert.equal(inst.answer('', true), true);
  assert.equal(inst.answer(' Y ', false), true);
  assert.equal(inst.answer('no', true), false);
  assert.equal(inst.answer('maybe', true), null);
});

test('shortcut, registry and firewall lines: quoted, this user only, the rule asked for once', () => {
  const s = inst.shortcutScript("C:\\Users\\O'Neil\\Desktop\\Smart Manager.lnk", 'C:\\P\\TOMLIN\\Smart Manager.exe');
  assert.ok(s.includes("CreateShortcut('C:\\Users\\O''Neil\\Desktop\\Smart Manager.lnk')"));
  assert.ok(s.includes("$s.IconLocation = 'C:\\P\\TOMLIN\\Smart Manager.exe,0'"));
  assert.ok(s.includes("$s.WorkingDirectory = 'C:\\P\\TOMLIN'"));
  const reg = inst.registryArgs('HKCU\\X', { root: 'C:\\P\\TOMLIN', version: '2.0.34', kb: 380000 });
  const v = Object.fromEntries(reg.map(a => [a[3], a[7]]));
  assert.equal(v.DisplayName, 'TOMLIN');
  assert.equal(v.DisplayVersion, '2.0.34');
  assert.equal(v.UninstallString, '"C:\\P\\TOMLIN\\TOMLIN.exe" --uninstall');
  assert.ok(reg.every(a => a[0] === 'add' && a[1] === 'HKCU\\X' && a.at(-1) === '/f'));
  // Only this install's program is closed: another one (his own, while a test runs) is never touched.
  const tray = inst.trayScript('C:\\T\\Smart Manager.exe', true);
  assert.match(tray, /Where-Object \{ \$_\.Path -eq 'C:\\T\\Smart Manager.exe' -or \$_\.Path -eq 'C:\\T\\Smart Manager.old.exe' \} \| Stop-Process -Force$/);
  // After a rebuild the running program is Smart Manager.old.exe: found by name too.
  assert.match(tray, /^Get-Process -Name 'Smart Manager','Smart Manager\.old' /);
  const fw = inst.firewallScript(8741, 'Smart Manager node');
  assert.match(fw, /^if \(-not \(Get-NetFirewallRule -DisplayName 'Smart Manager node'/);
  // The rule under its earlier name counts: no second rule is added.
  assert.match(inst.firewallScript(8741, 'TOMLIN node', ['Smart Manager node']), /^if \(-not \(Get-NetFirewallRule -DisplayName 'TOMLIN node','Smart Manager node' /);
  const tray2 = inst.trayScript('C:\\T\\TOMLIN.exe', false);
  assert.match(tray2, /^@\(Get-Process -Name 'TOMLIN','TOMLIN\.old' /);
  assert.match(fw, /-LocalPort 8741 -Action Allow -Profile Private,Domain/);
});

test('uninstall: the firewall rule is found by its name and removed the same way it was added (as administrator)', () => {
  assert.equal(inst.firewallRuleCountScript("O'Neil node"), "@(Get-NetFirewallRule -DisplayName 'O''Neil node' -ErrorAction SilentlyContinue).Count");
  assert.equal(inst.removeFirewallScript('Smart Manager node'), "Get-NetFirewallRule -DisplayName 'Smart Manager node' -ErrorAction SilentlyContinue | Remove-NetFirewallRule");
  // Both names at once: the rule a PC set up before the TOMLIN name has goes too.
  assert.equal(inst.removeFirewallScript('TOMLIN node', 'Smart Manager node'), "Get-NetFirewallRule -DisplayName 'TOMLIN node','Smart Manager node' -ErrorAction SilentlyContinue | Remove-NetFirewallRule");
  assert.match(inst.firewallRuleCountScript('TOMLIN node', 'Smart Manager node'), /-DisplayName 'TOMLIN node','Smart Manager node' /);
  const up = inst.elevatedPowerShell(inst.removeFirewallScript('Smart Manager node'));
  assert.match(up, /^Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','([A-Za-z0-9+/=]+)'$/);
  const encoded = /'([A-Za-z0-9+/=]+)'$/.exec(up)![1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), inst.removeFirewallScript('Smart Manager node'));
});

test('a program on the port is called TOMLIN only when its /api/status says so; anything else is another program', () => {
  assert.equal(inst.isTomlinStatus(200, JSON.stringify({ version: '2.0.48', hardware: {}, panes: { chat: {} } })), true);
  // Its app lock on: it says it is locked.
  assert.equal(inst.isTomlinStatus(423, JSON.stringify({ error: 'TOMLIN is locked. Type the PIN to open it.', locked: true })), true);
  for (const [code, text] of [[200, '<!doctype html><title>Some other app</title>'], [404, 'Not found'], [200, JSON.stringify({ version: '1.0' })], [200, 'null'], [423, JSON.stringify({ locked: 'yes' })]] as const) {
    assert.equal(inst.isTomlinStatus(code, text), false, text);
  }
  assert.match(inst.portTakenLine(8740, true), /^Another TOMLIN is running on port 8740 .*Close its window\.$/);
  const other = inst.portTakenLine(8740, false);
  assert.match(other, /^Another program is using port 8740, which TOMLIN needs\. Close that program/);
  assert.match(other, /Get-NetTCPConnection -LocalPort 8740 -State Listen/);
  assert.doesNotMatch(other, /TOMLIN is running/);
});

test('old copies: the one in use and the one before stay; earlier ones go', () => {
  const names = ['shelby-2.0.31', 'shelby-2.0.34', 'shelby-2.0.33', 'shelby-2.0.32', 'icon.ico', 'Smart Manager.exe', 'current.txt', 'shelby-2.0.34 (2)'];
  assert.deepEqual(inst.copiesToRemove(names, 'shelby-2.0.34 (2)').sort(), ['shelby-2.0.31', 'shelby-2.0.32', 'shelby-2.0.33']);
  assert.deepEqual(inst.copiesToRemove(names, 'shelby-2.0.34').sort(), ['shelby-2.0.31', 'shelby-2.0.32', 'shelby-2.0.33']);
  assert.deepEqual(inst.copiesToRemove(['shelby-2.0.33', 'shelby-2.0.34'], 'shelby-2.0.34'), []);
});

test('old copies: copies named before TOMLIN (shelby-) and after (tomlin-) are one list, by version', () => {
  const names = ['shelby-2.0.42', 'shelby-2.0.43', 'tomlin-2.0.44', 'tomlin-2.0.45', 'tomlin-notes', 'shelby-2'];
  assert.deepEqual(inst.copiesToRemove(names, 'tomlin-2.0.45').sort(), ['shelby-2.0.42', 'shelby-2.0.43']);
  assert.deepEqual(inst.copiesToRemove(names, 'tomlin-2.0.44').sort(), ['shelby-2.0.42', 'shelby-2.0.43']);
  assert.deepEqual(inst.copiesToRemove(['shelby-2.0.44', 'tomlin-2.0.45'], 'tomlin-2.0.45'), []);
});

test('Start with Windows for an installed copy starts its program, quietly; an unzipped copy keeps Start TOMLIN.cmd', () => {
  const root = tmp();
  const copy = join(root, 'shelby-2.0.34');
  mkdirSync(copy);
  assert.equal(installedExe(copy), null);
  assert.match(startupScript(copy), /Start TOMLIN.cmd/);
  writeFileSync(join(root, inst.EXE), '');
  writeFileSync(join(root, inst.CURRENT), 'shelby-2.0.34');
  assert.equal(installedExe(copy), join(root, inst.EXE));
  assert.equal(startupScript(copy), inst.startupScriptFor(join(root, inst.EXE)));
  assert.match(startupScript(copy), /start "" ".*TOMLIN.exe" --quiet\r\n$/);
});

test('every release and every pushed update carries the installer, the program\'s source, its icon and Node.js', () => {
  for (const part of ['Install TOMLIN.cmd', 'runtime/node']) assert.ok(PARTS.includes(part), part);
  for (const f of ['tools/install.ts', 'tools/tray.cs', 'public/icon.ico', 'src/installer.ts']) assert.ok(existsSync(join(rootPath, f)), f);
  const cmd = readFileSync(join(rootPath, 'Install TOMLIN.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n'), 'Windows line ends');
  assert.match(cmd, /runtime\\node\\node\.exe/);
  assert.match(cmd, /tools\\install\.ts install %\*/);
  const start = readFileSync(join(rootPath, 'Start TOMLIN.cmd'), 'utf8');
  assert.match(start, /if exist "%~dp0runtime\\node\\node\.exe" set "PATH=%~dp0runtime\\node;%PATH%"/);
  const ico = readFileSync(join(rootPath, 'public', 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1, 'an icon file');
  assert.ok(ico.readUInt16LE(4) >= 4, 'several sizes');
});

const onWindows = process.platform === 'win32';
const run = (args: string[], env: Record<string, string>) => execFileSync(process.execPath, [join(rootPath, 'tools', 'install.ts'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });

test('a dry run says every step and changes nothing', { skip: !onWindows }, () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'Smart Manager'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'HKCU\\Software\\SmartManagerTestDry', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: '8787' };
  mkdirSync(env.TOMLIN_STARTUP_DIR);
  const out = run(['install', '--yes', '--dry-run', '--no-firewall', '--autostart'], env);
  for (const want of [/Install TOMLIN [\d.]+ for this Windows user\? Yes/, /\(would\) copy \d+ files to /, /\(would\) build .*TOMLIN.exe/, /\(would\) point current\.txt at tomlin-/,/\(would\) add TOMLIN to the Start menu/, /\(would\) add a shortcut to /, /\(would\) start TOMLIN with Windows/, /\(would\) list TOMLIN in Settings > Apps \(HKCU\\Software\\SmartManagerTestDry\)/, /\(would\) start TOMLIN/]) assert.match(out, want);
  assert.equal(existsSync(env.TOMLIN_INSTALL_ROOT), false);
  assert.deepEqual(readdirSync(env.TOMLIN_STARTUP_DIR), []);
});

test('a real install into a test folder: the app, the program built here, current.txt, shortcuts; then uninstall removes them and keeps the data', { skip: !onWindows || !inst.places().csc.some(existsSync) }, async () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'Smart Manager'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: '8787' };
  for (const d of [env.TOMLIN_START_MENU_DIR, env.TOMLIN_DESKTOP_DIR, env.TOMLIN_STARTUP_DIR, join(env.TOMLIN_HOME, 'data')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(env.TOMLIN_HOME, 'data', 'settings.json'), '{}');
  run(['install', '--yes', '--no-start', '--no-firewall', '--desktop', '--no-autostart'], env);
  const r = env.TOMLIN_INSTALL_ROOT;
  const version = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')).version;
  assert.equal(readFileSync(join(r, inst.CURRENT), 'utf8'), `tomlin-${version}`);
  assert.ok(readFileSync(join(r, inst.EXE)).subarray(0, 2).toString() === 'MZ', 'TOMLIN.exe is a Windows program');
  assert.ok(existsSync(join(r, `tomlin-${version}`, 'src', 'server.ts')));
  assert.ok(!existsSync(join(r, `tomlin-${version}`, 'data')), 'no data in the app folder');
  // The program says which tray.cs it came from, so its first start does not build it again (src/trayfresh.ts).
  assert.equal(readFileSync(join(r, STAMP), 'utf8'), await traySum(join(r, `tomlin-${version}`)));
  assert.equal(await refreshTray(join(r, `tomlin-${version}`), async () => { throw new Error('built again'); }), 'same');
  assert.deepEqual(readdirSync(env.TOMLIN_START_MENU_DIR), [inst.LINK]);
  assert.deepEqual(readdirSync(env.TOMLIN_DESKTOP_DIR), [inst.LINK]);
  assert.deepEqual(readdirSync(env.TOMLIN_STARTUP_DIR), []);
  run(['uninstall', '--yes', '--no-firewall'], env);
  assert.equal(existsSync(r), false);
  assert.deepEqual(readdirSync(env.TOMLIN_START_MENU_DIR), []);
  assert.deepEqual(readdirSync(env.TOMLIN_DESKTOP_DIR), []);
  assert.ok(existsSync(join(env.TOMLIN_HOME, 'data', 'settings.json')), 'the data is kept');
});
