// The installer (src/installer.ts, tools/install.ts, tools/tray.cs, Install TOMLIN.cmd): where things go, the
// questions, the shortcut, registry and firewall lines, which old copies go, Start with Windows for an installed copy,
// a whole install into a test folder (no registry, no Start menu of his), and the program compiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as inst from '../src/installer.ts';
import { buildSetupExe, setupCscArgs } from '../tools/setupexe.ts';
import { installedExe, startupScript } from '../src/autostart.ts';
import { PARTS } from '../src/update.ts';
import { refreshTray, STAMP, traySum } from '../src/trayfresh.ts';
import { testEnv } from './env.ts';

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

test('with a keyboard, setup names the copy it found and offers Repair | Update | Uninstall by name', () => {
  const older = inst.actionMenu('2.0.33', '2.0.34', 'C:\\x\\tomlin-2.0.33');
  assert.match(older.intro, /2\.0\.33 is installed in C:\\x\\tomlin-2\.0\.33/);
  assert.deepEqual(older.options.map(o => o.key), ['update', 'repair', 'uninstall', 'quit']);
  assert.equal(older.defaultKey, 'update');
  const same = inst.actionMenu('2.0.34', '2.0.34', 'C:\\x');
  assert.equal(same.defaultKey, 'quit');
  assert.deepEqual(same.options.map(o => o.key), ['repair', 'update', 'uninstall', 'quit']);
  const newer = inst.actionMenu('2.0.40', '2.0.34', 'C:\\x');
  assert.equal(newer.defaultKey, 'repair');
  assert.ok(!newer.options.some(o => o.key === 'update'), 'a newer copy is never replaced by an older setup');
  assert.equal(inst.pickAction('', older), 'update');
  assert.equal(inst.pickAction('3', older), 'uninstall');
  assert.equal(inst.pickAction('Re', older), 'repair');
  assert.equal(inst.pickAction('un', older), 'uninstall');
  assert.equal(inst.pickAction('u', older), null, 'one letter is ambiguous');
  assert.equal(inst.pickAction('9', older), null);
  assert.equal(inst.pickAction('update', newer), null, 'not offered');
});

test('the setup window names the copy it found and offers Repair | Update | Uninstall to click; Cancel is its own button', () => {
  const older = inst.windowMenu('2.0.87', '2.0.88', 'C:\\P\\TOMLIN\\tomlin-2.0.87', 'C:\\P\\TOMLIN', 'C:\\Users\\sam\\TOMLIN');
  assert.match(older.intro, /TOMLIN 2\.0\.87 is installed in C:\\P\\TOMLIN\\tomlin-2\.0\.87\./, 'the folder and version found');
  assert.equal(older.intro, 'TOMLIN 2.0.87 is installed in C:\\P\\TOMLIN\\tomlin-2.0.87.\nThis setup is a newer version, 2.0.88.\nChoose from below:', 'three lines: found, this setup, choose');
  assert.deepEqual(older.choices.map(c => c.key), ['update', 'repair', 'uninstall'], 'no Quit: Cancel is the window\'s own button');
  assert.equal(older.pick, 'update');
  assert.match(older.uninstall, /removes TOMLIN 2\.0\.87 from C:\\P\\TOMLIN/);
  assert.match(older.uninstall, /chats, staff, pictures and models in C:\\Users\\sam\\TOMLIN are kept/, 'says what is kept');
  const same = inst.windowMenu('2.0.88', '2.0.88', 'C:\\x', 'C:\\x', 'C:\\h');
  assert.deepEqual(same.choices.map(c => c.key), ['repair', 'update', 'uninstall']);
  assert.match(same.choices[1].label, /^Reinstall/);
  assert.equal(same.pick, '', 'the same version: nothing ticked, so no default decides it');
  assert.equal(same.intro.split('\n')[1], 'This setup is the same version, 2.0.88.');
  const newer = inst.windowMenu('2.0.90', '2.0.88', 'C:\\x', 'C:\\x', 'C:\\h');
  assert.deepEqual(newer.choices.map(c => c.key), ['repair', 'uninstall'], 'a newer copy is never replaced by an older setup');
  assert.equal(newer.pick, 'repair');
  assert.equal(newer.intro.split('\n')[1], 'This setup is an older version, 2.0.88, so it does not replace it.');
  // The choice is passed by name (install --action ...), never left to a yes/no default.
  assert.equal(inst.actionFlag(null, '2.0.88', '2.0.88'), null, 'no --action: the questions decide, as before');
  assert.deepEqual(inst.actionFlag('update', '2.0.88', '2.0.88'), { action: 'update' });
  assert.deepEqual(inst.actionFlag('Repair', '2.0.87', '2.0.88'), { action: 'repair' });
  assert.deepEqual(inst.actionFlag('uninstall', '2.0.90', '2.0.88'), { action: 'uninstall' });
  assert.deepEqual(inst.actionFlag('update', null, '2.0.88'), { action: 'install' }, 'nothing installed: a plain install');
  assert.ok('error' in inst.actionFlag('update', '2.0.90', '2.0.88')!, 'update over a newer copy is refused');
  assert.ok('error' in inst.actionFlag('repair', null, '2.0.88')!);
  assert.ok('error' in inst.actionFlag('uninstall', null, '2.0.88')!);
  assert.ok('error' in inst.actionFlag('', '2.0.88', '2.0.88')!);
  assert.ok('error' in inst.actionFlag('quit', '2.0.88', '2.0.88')!, 'Cancel never runs the installer');
});

test('the first question: install, update, repair, or a newer one already there (nothing changed)', () => {
  assert.deepEqual(inst.firstQuestion(null, '2.0.34'), { text: 'Install TOMLIN 2.0.34 for this Windows user?', yesDefault: true, go: true });
  assert.match(inst.firstQuestion('2.0.33', '2.0.34').text, /2.0.33 is already installed. Update to 2.0.34\?/);
  assert.equal(inst.firstQuestion('2.0.33', '2.0.34').yesDefault, true);
  assert.match(inst.firstQuestion('2.0.34', '2.0.34').text, /repair/);
  assert.equal(inst.firstQuestion('2.0.34', '2.0.34').yesDefault, false);
  // A zip older than the install: not installed over it, but Repair is offered (it keeps 2.0.40).
  const older = inst.firstQuestion('2.0.40', '2.0.34');
  assert.equal(older.repair, true);
  assert.equal(older.yesDefault, true);
  assert.match(older.text, /2\.0\.40 is installed, which is newer than this one \(2\.0\.34\), so it is not replaced\..*repair.*it stays 2\.0\.40/);
  assert.equal(inst.firstQuestion('2.0.34', '2.0.34').repair, undefined);
  assert.equal(inst.firstQuestion('2.0.33', '2.0.34').repair, undefined);
  assert.equal(inst.firstQuestion(null, '2.0.34').repair, undefined);
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
  // Only this install's program is closed: another one (the one in use on this PC, while a test runs) is never touched.
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
  const names = ['tomlin-2.0.31', 'tomlin-2.0.34', 'tomlin-2.0.33', 'tomlin-2.0.32', 'icon.ico', 'Smart Manager.exe', 'current.txt', 'tomlin-2.0.34 (2)', 'tomlin-notes', 'tomlin-2'];
  // A copy of the same version as the one in use is kept for going back only when no other version is there (it may
  // be an install cut off part way and run again: audit-install U-01): the older version stays.
  assert.deepEqual(inst.copiesToRemove(names, 'tomlin-2.0.34 (2)').sort(), ['tomlin-2.0.31', 'tomlin-2.0.32', 'tomlin-2.0.34']);
  assert.deepEqual(inst.copiesToRemove(names, 'tomlin-2.0.34').sort(), ['tomlin-2.0.31', 'tomlin-2.0.32', 'tomlin-2.0.34 (2)']);
  // A reinstall of the one version: the copy before it is the one kept.
  assert.deepEqual(inst.copiesToRemove(['tomlin-2.0.34', 'tomlin-2.0.34 (2)'], 'tomlin-2.0.34 (2)'), []);
  assert.deepEqual(inst.copiesToRemove(['tomlin-2.0.33', 'tomlin-2.0.34'], 'tomlin-2.0.34'), []);
});

test('every start from the install folder removes the earlier copies an update left (20 copies, 8.5 GB, 17 Nov)', async () => {
  const root = tmp();
  const copy = (name: string, pkg = true) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'x.txt'), 'x');
    if (pkg) writeFileSync(join(root, name, 'package.json'), JSON.stringify({ name: 'tomlin', version: name.replace(/^tomlin-/, '') }));
  };
  const old = ['2.0.79', '2.0.81', '2.0.84', '2.0.84 (2)', '2.0.84 (3)', '2.0.88', '2.0.90', '2.0.95'];
  for (const v of [...old, '2.0.97']) copy(`tomlin-${v}`);
  copy('tomlin-2.0.50', false); // a half-made copy: no package.json, left alone
  mkdirSync(join(root, 'other-tool')); // not a copy of TOMLIN
  writeFileSync(join(root, 'current.txt'), 'tomlin-2.0.97');
  const gone = await inst.pruneOldCopies(root, 'tomlin-2.0.97');
  assert.equal(gone.length, old.length - 1, 'all earlier ones but the newest');
  assert.deepEqual(readdirSync(root).sort(), ['current.txt', 'other-tool', 'tomlin-2.0.50', 'tomlin-2.0.95', 'tomlin-2.0.97']);
  assert.deepEqual(await inst.pruneOldCopies(root, 'tomlin-2.0.97'), [], 'nothing more to remove the next time');
  // current.txt names a copy that is not the running one (the installed program starts that one): it is kept as well.
  const other = tmp();
  for (const v of ['2.0.80', '2.0.85', '2.0.90', '2.0.96', '2.0.97']) copy2(other, v);
  writeFileSync(join(other, 'current.txt'), 'tomlin-2.0.85');
  await inst.pruneOldCopies(other, 'tomlin-2.0.97');
  assert.deepEqual(readdirSync(other).sort(), ['current.txt', 'tomlin-2.0.85', 'tomlin-2.0.96', 'tomlin-2.0.97']);
  function copy2(dir: string, v: string) {
    mkdirSync(join(dir, `tomlin-${v}`), { recursive: true });
    writeFileSync(join(dir, `tomlin-${v}`, 'package.json'), JSON.stringify({ name: 'tomlin', version: v }));
  }
});

test('Start with Windows for an installed copy starts its program, quietly; an unzipped copy keeps Start TOMLIN.cmd', () => {
  const root = tmp();
  const copy = join(root, 'tomlin-2.0.34');
  mkdirSync(copy);
  // The PC running this may have TOMLIN installed (it did, 27 Oct): the unzipped copy looks at an install root that is not there.
  const env = { TOMLIN_INSTALL_ROOT: join(root, 'no-install-here') };
  assert.equal(installedExe(copy), null);
  assert.match(startupScript(copy, env), /Start TOMLIN.cmd/);
  writeFileSync(join(root, inst.EXE), '');
  writeFileSync(join(root, inst.CURRENT), 'tomlin-2.0.34');
  assert.equal(installedExe(copy), join(root, inst.EXE));
  assert.equal(startupScript(copy, env), inst.startupScriptFor(join(root, inst.EXE)));
  assert.match(startupScript(copy, env), /start "" ".*TOMLIN.exe" --quiet\r\n$/);
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

test('a copy of the source from GitHub: the installer says which parts are missing and asks before it downloads them (no answer is No)', () => {
  const cmd = readFileSync(join(rootPath, 'Install TOMLIN.cmd'), 'utf8');
  for (const f of ['node_modules\\@img\\sharp-win32-x64\\lib', 'runtime\\llama-cpu\\llama-server.exe', 'runtime\\sd-cpu\\sd-server.exe']) assert.ok(cmd.includes(`if not exist "${f}"`), f);
  assert.match(cmd, /set \/p "SM_YES=[^"]*\[y\/N\] "/, 'asked, No by default');
  assert.match(cmd, /if \/i "%SM_YES%"=="y" goto get_parts\r\nif \/i "%SM_YES%"=="yes" goto get_parts\r\ngoto parts_declined/, 'only y or yes downloads');
  const declined = cmd.slice(cmd.indexOf(':parts_declined'), cmd.indexOf(':no_npm'));
  assert.match(declined, /exit \/b 1/);
  assert.doesNotMatch(declined, /call npm|%SM_NODE%|goto (get_|ready|run|console)/, 'No downloads and installs nothing');
  assert.ok(cmd.indexOf('goto parts_declined') < cmd.indexOf('tools\\setup.cs'), 'asked before the setup starts');
});

const onWindows = process.platform === 'win32';
// A port nobody listens on: the installer will not install while anything answers on TOMLIN's port (a fixed 8787 fails
// whenever another copy or program on the PC had it).
const freePort = () => new Promise<string>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(String(port)));
  });
});
// A hard limit for a hang, not a speed check: a real install copies the app and its runners (about 20 s on a quiet PC,
// over 240 s seen with the CPU loaded and other tests copying at the same time).
const run = (args: string[], env: Record<string, string>) => execFileSync(process.execPath, [join(rootPath, 'tools', 'install.ts'), ...args], { env: testEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 });

test('a dry run says every step and changes nothing', { skip: !onWindows }, async () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'Smart Manager'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'HKCU\\Software\\SmartManagerTestDry', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: await freePort() };
  mkdirSync(env.TOMLIN_STARTUP_DIR);
  const out = run(['install', '--yes', '--dry-run', '--no-firewall', '--autostart'], env);
  for (const want of [/Install TOMLIN [\d.]+ for this Windows user\? Yes/, /\(would\) copy \d+ files to /, /\(would\) build .*TOMLIN.exe/, /\(would\) point current\.txt at tomlin-/,/\(would\) add TOMLIN to the Start menu/, /\(would\) add a shortcut to /, /\(would\) start TOMLIN with Windows/, /\(would\) list TOMLIN in Settings > Apps \(HKCU\\Software\\SmartManagerTestDry\)/, /\(would\) start TOMLIN/]) assert.match(out, want);
  assert.equal(existsSync(env.TOMLIN_INSTALL_ROOT), false);
  assert.deepEqual(readdirSync(env.TOMLIN_STARTUP_DIR), []);
});

test('a real install into a test folder: the app, the program built here, current.txt, shortcuts; then uninstall removes them and keeps the data', { skip: !onWindows || !inst.places().csc.some(existsSync) }, async () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'Smart Manager'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: await freePort() };
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

test('a folder chosen in setup is remembered, found again by installRoot, and checked first', () => {
  const local = tmp();
  const apps = tmp();
  const mine = join(apps, 'My TOMLIN');
  // nothing chosen: the default
  assert.equal(inst.installRoot(local), join(local, 'Programs', 'TOMLIN'));
  // a pointer to a folder with no install in it is ignored
  mkdirSync(join(local, 'Programs'), { recursive: true });
  writeFileSync(join(local, 'Programs', inst.LOCATION_FILE), mine);
  assert.equal(inst.installRoot(local), join(local, 'Programs', 'TOMLIN'));
  // once that folder holds an install (current.txt), the app, updates and uninstall all find it there
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, inst.CURRENT), 'tomlin-9.9.9');
  assert.equal(inst.installRoot(local), mine);
  assert.equal(inst.places({ LOCALAPPDATA: local }).root, mine);
  // not a drive path: ignored
  writeFileSync(join(local, 'Programs', inst.LOCATION_FILE), 'relative\\folder');
  assert.equal(inst.installRoot(local), join(local, 'Programs', 'TOMLIN'));
});

test('chooseRoot: Enter keeps the offered folder; a typed one must be a drive path, outside setup, and empty or new', () => {
  const offered = 'C:\\Users\\A\\AppData\\Local\\Programs\\TOMLIN';
  const setup = tmp();
  const empty = tmp();
  const full = tmp();
  writeFileSync(join(full, 'a.txt'), 'x');
  assert.deepEqual(inst.chooseRoot('  ', offered, setup), { root: offered });
  assert.deepEqual(inst.chooseRoot(`"${empty}"`, offered, setup), { root: empty });
  assert.deepEqual(inst.chooseRoot(join(empty, 'new', 'TOMLIN'), offered, setup), { root: join(empty, 'new', 'TOMLIN') });
  assert.ok('error' in inst.chooseRoot('apps\\TOMLIN', offered, setup), 'needs a drive');
  assert.ok('error' in inst.chooseRoot('C:\\', offered, setup), 'not a whole drive');
  assert.ok('error' in inst.chooseRoot(setup, offered, setup), 'not the setup folder');
  assert.ok('error' in inst.chooseRoot(join(setup, 'inside'), offered, setup), 'not inside the setup folder');
  assert.ok('error' in inst.chooseRoot(full, offered, setup), 'not a folder with other things in it');
  writeFileSync(join(full, inst.CURRENT), 'tomlin-1.0.0');
  assert.deepEqual(inst.chooseRoot(full, offered, setup), { root: full }, 'a folder that already holds TOMLIN is fine');
});

test('the setup window asks the installer: status says what is there, check says ok or why not, --dir is shown and used', { skip: !onWindows }, () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'TOMLIN'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_HOME: join(t, 'home') };
  mkdirSync(env.TOMLIN_STARTUP_DIR);
  const version = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')).version;
  const s = Object.fromEntries(run(['status'], env).split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(s.version, version);
  assert.equal(s.installed, '', 'nothing installed in a new folder');
  assert.equal(s.root, env.TOMLIN_INSTALL_ROOT);
  assert.ok(s.exe.endsWith('TOMLIN.exe'));
  assert.equal(run(['check', '--dir', join(t, 'new', 'place')], env).trim(), 'ok');
  assert.match(run(['check', '--dir', 'relative\\place'], env), /full folder path/);
  assert.match(run(['check', '--dir', rootPath], env), /inside the folder this setup is running from/);
  const out = run(['install', '--yes', '--dry-run', '--no-firewall', '--dir', join(t, 'D apps', 'TOMLIN')], env);
  assert.match(out, /Install to: .*Programs.TOMLIN/, 'the offered folder is shown first');
  assert.match(out, /Install to: .*D apps.TOMLIN/, 'then the chosen one');
  assert.match(out, /\(would\) copy \d+ files to .*D apps.TOMLIN/);
});

/** status lines as a map; the choice lines as a list. */
const statusOf = (out: string) => {
  const lines = out.split(/\r?\n/).filter(l => l.includes('='));
  const s: Record<string, string> = Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { s, choices: lines.filter(l => l.startsWith('choice=')).map(l => l.slice(7).split('|')[0]) };
};

test('the setup window: status names the copy found and the choices; the choice is passed by name, so the same version is copied in again', { skip: !onWindows }, () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'TOMLIN'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: '8787' };
  mkdirSync(env.TOMLIN_STARTUP_DIR, { recursive: true });
  const version = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')).version;
  const copy = join(env.TOMLIN_INSTALL_ROOT, `tomlin-${version}`);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(env.TOMLIN_INSTALL_ROOT, inst.CURRENT), `tomlin-${version}`);
  const { s, choices } = statusOf(run(['status'], env));
  assert.equal(s.installed, version);
  assert.equal(s.found, copy, 'the folder of the copy found');
  assert.match(s.intro, new RegExp(`installed in .*tomlin-${version.replace(/\./g, '\\.')}\\.\\|This setup is the same version, ${version.replace(/\./g, '\\.')}\\.\\|Choose from below:$`), 'one status line, the breaks as |');
  assert.deepEqual(choices, ['repair', 'update', 'uninstall']);
  assert.equal(s.pick, '');
  assert.match(s.removes, /are kept/);
  // What the window used to run: with no keyboard the same-version question took its default, No, and did nothing.
  assert.match(run(['install', '--yes', '--dry-run', '--no-firewall', '--no-vcrt'], env), /Nothing was changed/);
  // The window's Reinstall, by name: copied in again, beside the copy there.
  const out = run(['install', '--yes', '--dry-run', '--no-start', '--no-firewall', '--no-vcrt', '--action', 'update'], env);
  assert.match(out, /copying it in again/);
  assert.match(out, new RegExp(`\\(would\\) copy \\d+ files to .*tomlin-${version.replace(/\./g, '\\.')} \\(2\\)`));
  assert.doesNotMatch(out, /Nothing was changed/);
  // A newer copy: Repair or Uninstall only; Update is refused, and nothing is touched.
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ version: '99.0.0' }));
  const n = statusOf(run(['status'], env));
  assert.deepEqual(n.choices, ['repair', 'uninstall']);
  assert.equal(n.s.pick, 'repair');
  assert.throws(() => run(['install', '--yes', '--dry-run', '--no-vcrt', '--action', 'update'], env), (e: { status?: number; stdout?: string }) => e.status === 1 && /newer than this setup/.test(e.stdout ?? ''));
  assert.throws(() => run(['install', '--yes', '--dry-run', '--no-vcrt', '--action', 'everything'], env), (e: { status?: number }) => e.status === 1);
  assert.deepEqual(readdirSync(env.TOMLIN_INSTALL_ROOT).sort(), [inst.CURRENT, `tomlin-${version}`].sort());
  // Nothing installed: no choices, the plain install.
  const none = statusOf(run(['status'], { ...env, TOMLIN_INSTALL_ROOT: join(t, 'empty') }));
  assert.equal(none.s.installed, '');
  assert.equal(none.s.found, undefined);
  assert.deepEqual(none.choices, []);
});

test('the setup window\'s three choices, as it runs them, in a test install folder: Update copies it in again, Repair puts back what is gone, Uninstall removes it and keeps the data', { skip: !onWindows || !inst.places().csc.some(existsSync) }, () => {
  const t = tmp();
  const env = { TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'TOMLIN'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: '8787' };
  for (const d of [env.TOMLIN_START_MENU_DIR, env.TOMLIN_DESKTOP_DIR, env.TOMLIN_STARTUP_DIR, join(env.TOMLIN_HOME, 'data')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(env.TOMLIN_HOME, 'data', 'settings.json'), '{}');
  const version = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')).version;
  const r = env.TOMLIN_INSTALL_ROOT;
  run(['install', '--yes', '--no-start', '--no-firewall', '--no-vcrt', '--desktop', '--no-autostart'], env);
  assert.equal(readFileSync(join(r, inst.CURRENT), 'utf8'), `tomlin-${version}`);
  // Update (the same version: Reinstall), with the arguments the window passes.
  run(['install', '--yes', '--no-start', '--action', 'update', '--desktop', '--no-autostart', '--no-firewall', '--no-vcrt'], env);
  assert.equal(readFileSync(join(r, inst.CURRENT), 'utf8'), `tomlin-${version} (2)`, 'a fresh copy, and current.txt points at it');
  assert.ok(existsSync(join(r, `tomlin-${version} (2)`, 'src', 'server.ts')));
  assert.ok(existsSync(join(r, `tomlin-${version}`)), 'the copy before stays for going back');
  // Repair: the Start menu shortcut is gone; Repair puts it back. A source checkout has no runtime or node_modules
  // (a release zip carries them): stand-ins, so Repair sees a whole copy and does not refuse it as damaged.
  for (const f of inst.missingFiles(join(r, `tomlin-${version} (2)`))) {
    mkdirSync(join(r, `tomlin-${version} (2)`, ...f.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(r, `tomlin-${version} (2)`, ...f.split('/')), '');
  }
  rmSync(join(env.TOMLIN_START_MENU_DIR, inst.LINK));
  assert.match(run(['repair', '--yes'], env), /Done: .*Start menu/);
  assert.deepEqual(readdirSync(env.TOMLIN_START_MENU_DIR), [inst.LINK]);
  assert.equal(readFileSync(join(r, inst.CURRENT), 'utf8'), `tomlin-${version} (2)`, 'Repair keeps the copy');
  // Uninstall, after the window's confirm page.
  run(['uninstall', '--yes', '--no-firewall'], env);
  assert.equal(existsSync(r), false);
  assert.deepEqual(readdirSync(env.TOMLIN_START_MENU_DIR), []);
  assert.deepEqual(readdirSync(env.TOMLIN_DESKTOP_DIR), []);
  assert.ok(existsSync(join(env.TOMLIN_HOME, 'data', 'settings.json')), 'the data is kept');
});

test('the setup window builds with the compiler that comes with Windows, and the .cmd falls back to the text setup', { skip: !onWindows || !inst.places().csc.some(existsSync) }, () => {
  const t = tmp();
  const csc = inst.places().csc.find(existsSync)!;
  const out = join(t, 'TOMLIN Setup.exe');
  execFileSync(csc, setupCscArgs({ out, icon: join(rootPath, 'public', 'icon.ico') }), { encoding: 'utf8', windowsHide: true });
  assert.ok(existsSync(out));
  const cmd = readFileSync(join(rootPath, 'Install TOMLIN.cmd'), 'utf8');
  assert.match(cmd, /tools\\setup\.cs/);
  assert.match(cmd, /--console/);
  assert.match(cmd, /"%SM_CODE%"=="9"\s+goto console/, 'a window that cannot start falls back to the text setup');
  const setup = readFileSync(join(rootPath, 'tools', 'setup.cs'), 'utf8');
  for (const flag of ['--yes', '--no-start', '--dir', '--desktop', '--no-desktop', '--autostart', '--no-autostart', '--firewall', '--no-firewall', '--vcrt', '--no-vcrt', '--action update', '"repair --yes"', '"uninstall --yes"']) assert.ok(setup.includes(flag), `${flag} is passed by the window`);
  assert.doesNotMatch(setup, /MessageBoxButtons\.YesNo/, 'no yes/no question: the choices are clicked by name');
});

test('the one-file installer carries the zip, checks it, unpacks it, and refuses a damaged one', { skip: !onWindows || !inst.places().csc.some(existsSync) }, async () => {
  const t = tmp();
  const stage = join(t, 'stage', 'tomlin-0.0.1');
  mkdirSync(join(stage, 'sub'), { recursive: true });
  writeFileSync(join(stage, 'a.txt'), 'one');
  writeFileSync(join(stage, 'sub', 'b.txt'), 'two');
  const zip = join(t, 'tomlin-0.0.1.zip');
  execFileSync(join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', join(t, 'stage'), 'tomlin-0.0.1']);
  const exe = join(t, 'TOMLIN-Setup-0.0.1.exe');
  const size = await buildSetupExe(zip, exe);
  assert.ok(size > statSync(zip).size + 80, 'the exe is the program, the zip and the 80-byte trailer');
  const tail = readFileSync(exe).subarray(-80);
  assert.equal(tail.subarray(72).toString('ascii'), 'TOMLPAY1');
  const ok = join(t, 'out');
  assert.doesNotThrow(() => execFileSync(exe, ['--extract', ok], { windowsHide: true }));
  assert.equal(readFileSync(join(ok, 'tomlin-0.0.1', 'a.txt'), 'utf8'), 'one');
  assert.equal(readFileSync(join(ok, 'tomlin-0.0.1', 'sub', 'b.txt'), 'utf8'), 'two');
  // one byte of the zip changed: its check number no longer matches
  const bad = Buffer.from(readFileSync(exe));
  bad[bad.length - 80 - 30] ^= 0xff;
  const damaged = join(t, 'TOMLIN-Setup-damaged.exe');
  writeFileSync(damaged, bad);
  assert.throws(() => execFileSync(damaged, ['--extract', join(t, 'out2')], { windowsHide: true }), (e: { status?: number }) => e.status === 3);
});

test('setup finds copies started from a folder (Desktop, Downloads, two levels down) and changes none of them', () => {
  const t = tmp();
  const copyAt = (dir: string, version: string, name = 'tomlin', data = false) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    writeFileSync(join(dir, 'src', 'server.ts'), '');
    if (data) mkdirSync(join(dir, 'data'), { recursive: true }), writeFileSync(join(dir, 'data', 'settings.json'), '{}');
  };
  const desk = join(t, 'Desktop'), down = join(t, 'Downloads'), root = join(t, 'Programs', 'TOMLIN');
  copyAt(join(desk, 'TOMLIN'), '2.0.60', 'tomlin', true);
  copyAt(join(down, 'tomlin-2.0.70', 'tomlin-2.0.70'), '2.0.70');
  copyAt(join(down, 'smart-manager-2.0.20'), '2.0.20', 'smart-manager');
  copyAt(join(down, 'setup-2.0.85'), '2.0.85'); // the setup's own folder: skipped
  copyAt(join(root, 'tomlin-2.0.84'), '2.0.84'); // inside the install: not loose
  copyAt(join(down, 'a', 'b', 'too-deep'), '2.0.10'); // three levels down: not looked at
  mkdirSync(join(down, 'not-tomlin'), { recursive: true });
  writeFileSync(join(down, 'not-tomlin', 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
  const before = readdirSync(down).sort();
  const found = inst.findLooseCopies(inst.lookIn({ TOMLIN_LOOK_IN: `${desk};${down};${root}` }, null), root, [join(down, 'setup-2.0.85')]);
  assert.deepEqual(found.map(c => [c.version, c.dir, c.ownData]), [
    ['2.0.70', join(down, 'tomlin-2.0.70', 'tomlin-2.0.70'), false],
    ['2.0.60', join(desk, 'TOMLIN'), true],
    ['2.0.20', join(down, 'smart-manager-2.0.20'), false],
  ]);
  assert.deepEqual(readdirSync(down).sort(), before, 'nothing is changed');
  const said = inst.looseCopyLines(found).join('\n');
  assert.match(said, /Also found 3 copies of TOMLIN started from a folder \(not installed\)/);
  assert.match(said, /2\.0\.60 in .*Desktop.TOMLIN \(it keeps its own chats inside/);
  assert.match(said, /Setup does not change them/);
  assert.deepEqual(inst.looseCopyLines([]), []);
});

test('where setup looks: Desktop, Downloads, Documents and the user folder; a test install nowhere unless told', () => {
  const places = inst.lookIn({ USERPROFILE: 'C:\\Users\\sam' }, 'D:\\Desk');
  assert.deepEqual(places.map(p => p.dir), ['D:\\Desk', join('C:\\Users\\sam', 'Desktop'), join('C:\\Users\\sam', 'OneDrive', 'Desktop'), join('C:\\Users\\sam', 'Downloads'), join('C:\\Users\\sam', 'Documents'), join('C:\\Users\\sam', 'OneDrive', 'Documents'), 'C:\\Users\\sam']);
  assert.equal(places.at(-1)?.depth, 1, 'the user folder only one level down');
  assert.deepEqual(inst.lookIn({ USERPROFILE: 'C:\\Users\\sam', TOMLIN_INSTALL_ROOT: 'C:\\t' }, null), []);
  assert.deepEqual(inst.lookIn({ TOMLIN_LOOK_IN: '' }, null), []);
});

test('an older copy that still holds models (used in place) is not removed; one with only the helper is', async () => {
  const root = tmp();
  for (const v of ['2.0.80', '2.0.85', '2.0.90', '2.0.97']) {
    mkdirSync(join(root, `tomlin-${v}`, 'models', 'helpers'), { recursive: true });
    writeFileSync(join(root, `tomlin-${v}`, 'package.json'), JSON.stringify({ name: 'tomlin', version: v }));
    writeFileSync(join(root, `tomlin-${v}`, 'models', 'helpers', 'u2netp.onnx'), 'x');
  }
  mkdirSync(join(root, 'tomlin-2.0.80', 'models', 'chat'), { recursive: true });
  writeFileSync(join(root, 'tomlin-2.0.80', 'models', 'chat', 'Qwen3-8B-Q4_K_M.gguf'), 'x');
  assert.equal(inst.holdsModels(join(root, 'tomlin-2.0.80')), true);
  assert.equal(inst.holdsModels(join(root, 'tomlin-2.0.85')), false, 'the helper that comes with every copy is not a model of his');
  const gone = await inst.pruneOldCopies(root, 'tomlin-2.0.97');
  assert.deepEqual(gone, ['tomlin-2.0.85']);
  assert.deepEqual(readdirSync(root).sort(), ['tomlin-2.0.80', 'tomlin-2.0.90', 'tomlin-2.0.97']);
});
