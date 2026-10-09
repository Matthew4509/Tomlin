// Installs TOMLIN for this Windows user (2.0.34), started by "Install TOMLIN.cmd" in the unzipped folder.
// No administrator needed. Nothing is downloaded, except Microsoft's Visual C++ Runtime when this PC lacks it and the
// answer is Yes (src/vcrt.ts; Windows asks for permission to install it). See src/installer.ts for where everything goes.
//   node tools/install.ts install [--yes] [--no-start] [--desktop|--no-desktop] [--autostart|--no-autostart]
//                                 [--firewall|--no-firewall] [--vcrt|--no-vcrt] [--dry-run]
//   node tools/install.ts uninstall [--yes] [--firewall|--no-firewall] [--dry-run]   (Settings > Apps > TOMLIN > Uninstall runs it)
//   node tools/install.ts repair [--yes] [--dry-run]          (the icon's Repair install; My PC has the same, src/repair.ts)
// Tests and scratch runs move every place with TOMLIN_INSTALL_ROOT, TOMLIN_START_MENU_DIR, TOMLIN_DESKTOP_DIR,
// TOMLIN_STARTUP_DIR, TOMLIN_UNINSTALL_KEY (a throwaway key, or "none"), TOMLIN_VCRT_DIR and TOMLIN_HOME.
import '../src/envnames.ts';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as inst from '../src/installer.ts';
import { appFiles, newFolder } from '../src/update.ts';
import { OLD_STARTUP_FILES, STARTUP_FILE, startupDir, startupFileIn, writeStartup } from '../src/autostart.ts';
import { STAMP, traySum } from '../src/trayfresh.ts';
import { OLD_RULE_NAMES, RULE_NAME } from '../src/firewall.ts';
import { resolveHome } from '../src/keep.ts';
import { systemDir, VCRT_URL, vcrtMissing, vcrtTooOld } from '../src/vcrt.ts';
import { planRepair, runRepair, windowsDeps } from '../src/repair.ts';

const run = promisify(execFile);
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const YES = has('--yes');
const DRY = has('--dry-run');
const P = inst.places();
const say = (s = '') => console.log(s ? ` ${s}` : '');

const rl = process.stdin.isTTY && !YES ? createInterface({ input: process.stdin, output: process.stdout }) : null;
/** A yes/no question; --yes (or no keyboard) takes the default; a flag answers it. */
async function ask(text: string, yesDefault: boolean, flag?: string): Promise<boolean> {
  if (flag && has(`--${flag}`)) return true;
  if (flag && has(`--no-${flag}`)) return false;
  if (!rl) {
    say(`${text} ${yesDefault ? 'Yes' : 'No'}`);
    return yesDefault;
  }
  for (;;) {
    const a = inst.answer(await rl.question(` ${text} [${yesDefault ? 'Y/n' : 'y/N'}] `), yesDefault);
    if (a !== null) return a;
  }
}

/** Does it, or (dry run) says what it would do. */
async function step(what: string, fn: () => Promise<unknown>) {
  if (DRY) return say(`(would) ${what}`);
  await fn();
}

const powershell = (script: string) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1 << 20 });

async function versionOf(dir: string): Promise<string | null> {
  try {
    return String(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version);
  } catch {
    return null;
  }
}

/** The copy current.txt names in the install folder, and its version; null when nothing is installed. */
async function installed(): Promise<{ dir: string; name: string; version: string } | null> {
  try {
    const name = (await readFile(join(P.root, inst.CURRENT), 'utf8')).trim();
    const dir = /^[A-Za-z]:\\/.test(name) ? name : join(P.root, name);
    const version = await versionOf(dir);
    return version ? { dir, name, version } : null;
  } catch {
    return null;
  }
}

/** This install's program is running (another install's never counts). */
async function trayRunning(): Promise<boolean> {
  try {
    return Number((await powershell(inst.trayScript(inst.exeIn(P.root), false))).stdout.trim()) > 0;
  } catch {
    return false;
  }
}
const stopTray = () => powershell(inst.trayScript(inst.exeIn(P.root), true)).catch(() => undefined);

/** Who answers on TOMLIN's port: nobody, a TOMLIN (any version), or another program using it. */
async function answering(): Promise<'none' | 'tomlin' | 'other'> {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.TOMLIN_PORT ?? 8740}/api/status`, { signal: AbortSignal.timeout(1500) });
    return inst.isTomlinStatus(r.status, await r.text()) ? 'tomlin' : 'other';
  } catch {
    return 'none';
  }
}

/** TOMLIN must not be running while its files are replaced: the installed one is closed (after asking). */
async function closeRunning(): Promise<boolean> {
  if (await trayRunning()) {
    if (!(await ask('TOMLIN is running. Close it to carry on?', true))) return false;
    await step('close TOMLIN', stopTray);
    if (!DRY) await new Promise(r => setTimeout(r, 1500));
  }
  for (let k = 0, who; !DRY && (who = await answering()) !== 'none'; k++) {
    if (k === 0) say(inst.portTakenLine(process.env.TOMLIN_PORT ?? 8740, who === 'tomlin'));
    if (!rl || k > 60) {
      say(who === 'tomlin' ? 'It is still running, so nothing was installed. Close it, then run Install TOMLIN.cmd again.' : `Port ${process.env.TOMLIN_PORT ?? 8740} is still in use, so nothing was installed. Close the program using it, then run Install TOMLIN.cmd again.`);
      return false;
    }
    await rl.question(who === 'tomlin' ? ' Press Enter when its window is closed. ' : ' Press Enter when that program is closed. ');
  }
  return true;
}

/**
 * The Microsoft Visual C++ Runtime the model runners need (src/vcrt.ts). A clean Windows lacks it: the app then opens
 * but no model loads. Offered (Yes by default), downloaded from Microsoft, run only when Microsoft signed it, installed
 * with Windows' permission. Not installed = said plainly, and the install carries on.
 */
async function runtimeCheck() {
  const missing = vcrtMissing();
  let old = '';
  if (!missing.length && process.platform === 'win32') {
    old = (await powershell(inst.fileVersionScript(join(systemDir(), 'msvcp140.dll'))).catch(() => ({ stdout: '' }))).stdout.trim();
    if (!vcrtTooOld(old)) return;
  }
  if (!missing.length && !old) return;
  say(missing.length
    ? `This PC does not have the Microsoft Visual C++ Runtime (${missing.join(', ')} missing). TOMLIN's model runners need it: without it TOMLIN opens, but no model loads.`
    : `This PC's Microsoft Visual C++ Runtime (${old}) is older than TOMLIN's model runners need: without a newer one they may stop as they start.`);
  const later = `Install it later from Microsoft (${VCRT_URL}), then press Connect in TOMLIN.`;
  if (!(await ask('Download it from Microsoft (about 19 MB) and install it now? Windows asks for permission.', true, 'vcrt'))) {
    say(`Skipped. ${later}`);
    return;
  }
  await step(`download ${VCRT_URL} and install it`, async () => {
    const file = join(tmpdir(), `vc_redist.x64-${process.pid}.exe`);
    try {
      say('Downloading it from Microsoft …');
      const res = await fetch(VCRT_URL, { signal: AbortSignal.timeout(10 * 60_000) }).catch(() => {
        throw new Error('the download did not work (is this PC online?)');
      });
      if (!res.ok) throw new Error(`Microsoft's site answered ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      // Only a file Microsoft signed is run.
      const signed = (await powershell(inst.signatureScript(file))).stdout.trim();
      if (!inst.signedByMicrosoft(signed)) throw new Error(`the downloaded file is not signed by Microsoft (${signed || 'no signature'}), so it was not run`);
      say('Installing it: answer Yes when Windows asks …');
      const code = Number((await powershell(inst.elevatedRunScript(file, ['/install', '/passive', '/norestart']))).stdout.trim());
      const bad = inst.redistResult(code);
      if (bad) throw new Error(bad);
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }).then(
    () => {
      if (DRY) return;
      const still = vcrtMissing();
      say(still.length ? `The Visual C++ Runtime is still missing (${still.join(', ')}). ${later}` : 'The Microsoft Visual C++ Runtime is installed.');
    },
    e => say(`The Visual C++ Runtime was not installed: ${String((e as Error).message).replace(/^Command failed:[\s\S]*$/, 'permission was not given, or Windows stopped it')}. ${later}`),
  );
}

function folderKb(files: { bytes: number }[]): number {
  return files.reduce((n, f) => n + f.bytes, 0) / 1024;
}

async function install() {
  if (process.platform !== 'win32' && !DRY) {
    say('This installer is for Windows. On another system run TOMLIN with: node src/server.ts');
    return 1;
  }
  const version = (await versionOf(SRC))!;
  const was = await installed();
  say(`${inst.NAME} setup (${version})`);
  say('===========================');
  say();
  const first = inst.firstQuestion(was?.version ?? null, version);
  if (!first.go) {
    say(first.text);
    return 0;
  }
  if (!(await ask(first.text, first.yesDefault))) {
    say('Nothing was changed.');
    return 0;
  }
  if (!(await closeRunning())) return 1;
  await runtimeCheck();

  // The app: every file the release holds (src/update.ts), into its own folder beside the earlier ones.
  const files = await appFiles(SRC);
  const dest = await newFolder(P.root, version);
  say(`Copying TOMLIN ${version} to ${dest} …`);
  await step(`copy ${files.length} files to ${dest}`, async () => {
    for (const f of files) {
      const to = join(dest, ...f.path.split('/'));
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(SRC, ...f.path.split('/')), to);
    }
    for (const d of ['models/chat', 'models/image/loras']) await mkdir(join(dest, ...d.split('/')), { recursive: true });
  });
  if (!existsSync(join(SRC, 'runtime', 'node', 'node.exe'))) say('Note: this copy has no Node.js of its own (runtime\\node), so the Node.js installed on this PC runs it.');

  // The program: built here from tools/tray.cs with the compiler that comes with Windows.
  const exe = inst.exeIn(P.root);
  const icon = join(P.root, 'icon.ico');
  await step(`build ${exe}`, async () => {
    await mkdir(P.root, { recursive: true });
    await copyFile(join(SRC, 'public', 'icon.ico'), icon);
    const csc = P.csc.find(c => existsSync(c));
    if (!csc) throw new Error('the C# compiler that comes with Windows (.NET Framework 4) is not on this PC. Turn on ".NET Framework 4.8" in Windows Features, then run the installer again.');
    await run(csc, inst.cscArgs({ out: exe, source: join(dest, 'tools', 'tray.cs'), icon }), { windowsHide: true, maxBuffer: 1 << 20 }).catch(e => {
      throw new Error(`${basename(exe)} could not be built: ${String((e as { stdout?: string }).stdout || (e as Error).message).trim().slice(0, 400)}`);
    });
    // Which tools/tray.cs it was built from: an update with a changed one builds it again (src/trayfresh.ts).
    await writeFile(join(P.root, STAMP), await traySum(dest));
  });
  const name = dest.slice(P.root.length).replace(/^[\\/]+/, '');
  await step(`point current.txt at ${name}`, () => writeFile(join(P.root, inst.CURRENT), name));

  // Shortcuts: the Start menu always; the desktop if wanted.
  await step(`add ${inst.NAME} to the Start menu`, () => powershell(inst.shortcutScript(join(P.startMenu, inst.LINK), exe)));
  const desk = P.desktop ?? (DRY ? '<desktop>' : (await powershell("[Environment]::GetFolderPath('Desktop')")).stdout.trim());
  if (await ask(`Put a ${inst.NAME} shortcut on the desktop?`, true, 'desktop')) {
    await step(`add a shortcut to ${desk}`, () => powershell(inst.shortcutScript(join(desk, inst.LINK), exe)));
  }
  // Shortcuts made under the earlier name, that open this app, go (the new ones replace them).
  const exeLow = exe.toLowerCase();
  for (const old of inst.OLD_LINKS.flatMap(n => [join(P.startMenu, n), ...(DRY ? [] : [join(desk, n)])])) {
    if (existsSync(old) && (await powershell(inst.shortcutTargetScript(old)).then(r => r.stdout.trim().toLowerCase() === exeLow, () => false))) await step(`remove the old shortcut ${old}`, () => rm(old, { force: true }));
  }

  // Start with Windows: kept as it was when an earlier copy had it (now pointing at this one), else asked.
  const sdir = startupDir();
  if (sdir) {
    const had = existsSync(startupFileIn(sdir));
    const want = had ? true : await ask('Start TOMLIN when you sign in to Windows (for a PC that lends its models to others)?', false, 'autostart');
    if (had) say('Start with Windows was on for an earlier copy: it now starts this one.');
    if (want) await step('start TOMLIN with Windows', () => writeStartup(sdir, inst.startupScriptFor(exe)));
  }

  // The firewall rule for a node: asked, then Windows asks for permission (administrator) once.
  if (await ask('Will other PCs link to this one (it lends its models as a node)? Add the Windows firewall rule for that now (Windows asks you to allow it)?', false, 'firewall')) {
    let port = 8741;
    try {
      port = Number(JSON.parse(await readFile(join(resolveHome().data, 'share.json'), 'utf8')).port) || 8741;
    } catch {
      // never a node yet: the default port
    }
    const script = inst.firewallScript(port, RULE_NAME, OLD_RULE_NAMES);
    await step(`add the firewall rule for port ${port} (as administrator)`, async () => {
      const elevated = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${Buffer.from(script, 'utf16le').toString('base64')}'`;
      await powershell(elevated).catch(() => say('The firewall rule was not added (permission was not given). Nodes and memory > "Can other PCs reach this one?" shows the line to run later.'));
    });
  }

  // The entry in Settings > Apps, with Uninstall.
  if (P.uninstallKey) {
    const kb = folderKb(files);
    await step(`list TOMLIN in Settings > Apps (${P.uninstallKey})`, async () => {
      for (const a of inst.registryArgs(P.uninstallKey!, { root: P.root, version, kb })) await run('reg', a, { windowsHide: true });
    });
  }

  // Older copies: the one before stays for going back; earlier ones go.
  const names = existsSync(P.root) ? readdirSync(P.root) : [];
  for (const old of inst.copiesToRemove(names, name)) await step(`remove the old copy ${old}`, () => rm(join(P.root, old), { recursive: true, force: true }));

  say();
  say(`TOMLIN ${version} is installed in ${P.root}.`);
  say(`Your chats, staff, pictures and models stay in ${resolveHome().home}.`);
  say('Start it from the Start menu (or the desktop shortcut). It runs by the clock: its icon there opens it again or quits it.');
  if (!has('--no-start')) await step('start TOMLIN', async () => void spawn(exe, [], { detached: true, stdio: 'ignore' }).unref());
  if (DRY) say('(A dry run: nothing above was done.)');
  return 0;
}

async function uninstall() {
  const was = await installed();
  const home = resolveHome().home;
  say('Remove TOMLIN');
  say('====================');
  // --yes answers this one too (a script removing it); deleting the data always needs DELETE typed by hand, below.
  if (!(await ask(`Remove TOMLIN${was ? ` ${was.version}` : ''} from this PC (${P.root})?`, YES))) {
    say('Nothing was changed.');
    return 0;
  }
  if (await trayRunning()) await step('close TOMLIN', stopTray);
  const exe = inst.exeIn(P.root).toLowerCase();
  const points = async (lnk: string) => existsSync(lnk) && (await powershell(inst.shortcutTargetScript(lnk)).then(r => r.stdout.trim().toLowerCase() === exe, () => false));
  const desk = P.desktop ?? (DRY ? '' : (await powershell("[Environment]::GetFolderPath('Desktop')").catch(() => ({ stdout: '' }))).stdout.trim());
  for (const lnk of [inst.LINK, ...inst.OLD_LINKS].flatMap(n => [join(P.startMenu, n), desk ? join(desk, n) : ''])) if (lnk && (await points(lnk))) await step(`remove ${lnk}`, () => rm(lnk, { force: true }));
  const sdir = startupDir();
  if (sdir) {
    for (const file of [STARTUP_FILE, ...OLD_STARTUP_FILES].map(n => join(sdir, n))) {
      const text = existsSync(file) ? await readFile(file, 'utf8') : '';
      if (text.toLowerCase().includes(exe)) await step('stop starting TOMLIN with Windows', () => rm(file, { force: true }));
    }
  }
  if (P.uninstallKey) await step('remove it from Settings > Apps', () => run('reg', ['delete', P.uninstallKey!, '/f'], { windowsHide: true }).catch(() => undefined));
  await removeFirewallRule();
  await step(`remove ${P.root}`, async () => {
    if (!DRY) await new Promise(r => setTimeout(r, 1000));
    await rm(P.root, { recursive: true, force: true });
  });
  say();
  say(`Your chats, staff, pictures and models are kept in ${home}.`);
  if (existsSync(home) && rl) {
    const typed = (await rl.question(' To delete them as well, for good, type DELETE and press Enter (Enter alone keeps them): ')).trim();
    if (typed === 'DELETE') await step(`delete ${home}`, () => rm(home, { recursive: true, force: true }));
    else say('Kept.');
  }
  say('TOMLIN was removed.');
  return 0;
}

/** How many firewall rules have the node's name (0 when it cannot be read). */
/** The node's rule under its name now and its earlier one (a PC set up before the TOMLIN name). */
const RULE_NAMES = [RULE_NAME, ...OLD_RULE_NAMES];
const firewallRules = () => powershell(inst.firewallRuleCountScript(...RULE_NAMES)).then(r => Number(r.stdout.trim()) || 0, () => 0);

/**
 * Uninstall: the firewall rule install added for a node ("Will other PCs link to this one?") is offered for removal the
 * same way (Windows asks first). Optional, and never stops the uninstall; with no keyboard (--yes, a script) it is kept
 * unless --firewall says to remove it, so a script never brings up Windows' question by itself.
 */
async function removeFirewallRule() {
  if (!(await firewallRules())) return;
  if (!(await ask(`Remove the Windows firewall rule "${RULE_NAME}" that let other PCs link to this one (Windows asks you to allow it)?`, !!rl, 'firewall'))) {
    say(`The firewall rule "${RULE_NAME}" is kept.`);
    return;
  }
  await step(`remove the firewall rule "${RULE_NAME}" (as administrator)`, async () => {
    await powershell(inst.elevatedPowerShell(inst.removeFirewallScript(...RULE_NAMES))).catch(() => undefined);
    if (await firewallRules()) say(`The firewall rule "${RULE_NAME}" is still there (permission was not given). To remove it later, run this in PowerShell opened as administrator: Remove-NetFirewallRule -DisplayName '${RULE_NAME}'`);
  });
}

/** Repair install: the same steps as My PC's button (src/repair.ts), said one by one, asked first. */
async function repair() {
  const version = (await versionOf(SRC))!;
  say('Repair TOMLIN');
  say('====================');
  say('Checking …');
  const plan = await planRepair({ here: SRC, version }, windowsDeps());
  if (!plan.steps.length) say(plan.left.length ? 'Nothing here can be repaired by this tool:' : `Nothing to repair: TOMLIN ${plan.version} in ${plan.root} is in order.`);
  else {
    say('To repair:');
    for (const s of plan.steps) say(`- ${s.say}`);
  }
  for (const l of plan.left) say(`! ${l}`);
  if (!plan.steps.length) return plan.left.length ? 1 : 0;
  say();
  if (!(await ask('Repair these now?', true))) {
    say('Nothing was changed.');
    return 0;
  }
  if (DRY) {
    say('(A dry run: nothing above was done.)');
    return 0;
  }
  const r = await runRepair(plan);
  say();
  for (const d of r.done) say(`Done: ${d}.`);
  for (const f of r.failed) say(`Not done: ${f}`);
  for (const l of r.left.filter(l => !plan.left.includes(l))) say(`! ${l}`);
  if (plan.outside && !r.failed.length) say('The installed TOMLIN runs it now: close any TOMLIN started from a folder (its window says Start TOMLIN.cmd), then start TOMLIN from the Start menu.');
  else if (!r.failed.length) say(`Repaired. Start TOMLIN from the Start menu (or "Start it again" in its icon's menu).`);
  return r.failed.length ? 1 : 0;
}

let code = 1;
try {
  code = argv[0] === 'uninstall' ? await uninstall() : argv[0] === 'install' ? await install() : argv[0] === 'repair' ? await repair() : (say('Use: node tools/install.ts install | uninstall | repair'), 1);
} catch (e) {
  say();
  say(`Setup stopped: ${(e as Error).message}`);
  code = 1;
} finally {
  rl?.close();
}
process.exitCode = code;
