// The installer's plain parts (2.0.34; the steps are in tools/install.ts, started by "Install TOMLIN.cmd").
// An installed TOMLIN lives in one folder per Windows user, no administrator needed:
//   %LOCALAPPDATA%\Programs\TOMLIN\
//     TOMLIN.exe          the program (tools/tray.cs, built on the PC by the C# compiler that comes with Windows)
//     icon.ico
//     current.txt         the copy to run: "tomlin-2.0.44" (an update pushed from a linked PC adds tomlin-2.0.45
//                         beside it and TOMLIN.exe moves current.txt on)
//     tomlin-2.0.44\      the app, with its own Node.js in runtime\node
// The home folder (chats, staff, pictures, models, backups) stays where it always was, so installing, updating and
// uninstalling never touch it unless asked. Shortcuts (Start menu, desktop, Start with Windows) and the entry in
// Settings > Apps all point at TOMLIN.exe, which never moves, so they keep working after every update.
// An install made before the TOMLIN name (Programs\Smart Manager, Smart Manager.exe) keeps its names: see FORMER.
// Tested in test/installer.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The program in an install folder made with the TOMLIN name. */
export const EXE = 'TOMLIN.exe';
/**
 * The names an install made before the TOMLIN name has (in Programs\Smart Manager). It keeps them all, through updates
 * and repairs: its shortcuts, Start with Windows and the entry in Settings > Apps point at them, so nothing is moved
 * under it. A new install gets the TOMLIN names.
 */
export const FORMER = { folder: 'Smart Manager', exe: 'Smart Manager.exe', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SmartManager' };
/** The program in an install folder: TOMLIN.exe, or Smart Manager.exe in an install made before the TOMLIN name. */
export function exeIn(root: string): string {
  return !existsSync(join(root, EXE)) && existsSync(join(root, FORMER.exe)) ? join(root, FORMER.exe) : join(root, EXE);
}
/** The program under another name beside it while it is replaced: "TOMLIN.old.exe", "Smart Manager.new.exe". */
export const sideExe = (exe: string, tag: 'old' | 'new'): string => exe.replace(/\.exe$/i, `.${tag}.exe`);
export const CURRENT = 'current.txt';
/** The name people see for the app: the Start menu, the desktop shortcut, Settings > Apps, the tray. */
export const NAME = 'TOMLIN';
export const LINK = `${NAME}.lnk`;
/** Shortcuts made under the app's earlier name: replaced by LINK, and removed on uninstall, when they open this app. */
export const OLD_LINKS = ['Smart Manager.lnk'];
export const DEFAULT_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TOMLIN';
/** Copies kept in the install folder: the one in use and the one before it (for going back). */
export const KEEP_COPIES = 2;

export interface Places {
  /** The install folder. */
  root: string;
  /** Start menu programs folder. */
  startMenu: string;
  /** The desktop, or null to ask Windows (it may be in OneDrive). */
  desktop: string | null;
  /** The registry key of the entry in Settings > Apps; null = none (tests). */
  uninstallKey: string | null;
  /** The C# compiler that comes with Windows (.NET Framework 4). */
  csc: string[];
}

/** The install folder: Programs\TOMLIN, or Programs\Smart Manager when only that one holds an install. */
export function installRoot(local: string): string {
  const now = join(local, 'Programs', 'TOMLIN');
  const old = join(local, 'Programs', FORMER.folder);
  return !existsSync(join(now, CURRENT)) && existsSync(join(old, CURRENT)) ? old : now;
}

/** Where everything goes, for this Windows user. Tests move each one with a TOMLIN_* setting. */
export function places(env: NodeJS.ProcessEnv = process.env): Places {
  const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Local');
  const roaming = env.APPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Roaming');
  const windir = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const root = env.TOMLIN_INSTALL_ROOT ?? installRoot(local);
  // An install made before the TOMLIN name keeps its entry in Settings > Apps.
  const key = basename(exeIn(root)) === FORMER.exe ? FORMER.key : DEFAULT_UNINSTALL_KEY;
  return {
    root,
    startMenu: env.TOMLIN_START_MENU_DIR ?? join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    desktop: env.TOMLIN_DESKTOP_DIR ?? null,
    uninstallKey: env.TOMLIN_UNINSTALL_KEY === 'none' ? null : env.TOMLIN_UNINSTALL_KEY ?? key,
    csc: [join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')],
  };
}

/** True when version a is later than b, number by number. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The files a copy cannot start (or load a model) without: one missing means the copy is damaged. */
export const KEY_FILES = ['package.json', 'src/server.ts', 'tools/tray.cs', 'tools/install.ts', 'runtime/node/node.exe', 'runtime/llama-cpu/llama-server.exe', 'runtime/sd-cpu/sd-server.exe', 'node_modules/sharp/package.json'];

/** The key files a copy lacks (none = whole). */
export const missingFiles = (dir: string): string[] => KEY_FILES.filter(f => !existsSync(join(dir, ...f.split('/'))));

/** A copy's version from its package.json, or null. */
export function versionOf(dir: string): string | null {
  try {
    return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version);
  } catch {
    return null;
  }
}

/** The copy current.txt names in an install folder (its name as written, folder and version); null when it names none. */
export function currentCopy(root: string): { name: string; dir: string; version: string } | null {
  try {
    const name = readFileSync(join(root, CURRENT), 'utf8').trim();
    if (!name) return null;
    const dir = /^[A-Za-z]:\\/.test(name) ? name : join(root, name);
    const version = versionOf(dir);
    return version ? { name, dir, version } : null;
  } catch {
    return null;
  }
}

/**
 * The program of this user's install (TOMLIN.exe, or Smart Manager.exe in an older one), when there is one whose copy
 * is whole and not older than `version`: then
 * "Start with Windows" and the desktop shortcut start it, even when asked from an unzipped copy (else a copy started
 * from a folder would point them at itself, and the install would never run again).
 */
export function installExe(version: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = places(env).root;
  const exe = exeIn(root);
  if (!existsSync(exe)) return null;
  const c = currentCopy(root);
  if (!c || missingFiles(c.dir).length) return null;
  return version && newer(version, c.version) ? null : exe;
}

/** What to ask first, from what is installed (null = nothing) and this version. `go: false` means stop after saying it. */
export function firstQuestion(installed: string | null, mine: string): { text: string; yesDefault: boolean; go: boolean } {
  if (!installed) return { text: `Install ${NAME} ${mine} for this Windows user?`, yesDefault: true, go: true };
  if (newer(installed, mine)) return { text: `${NAME} ${installed} is installed, which is newer than this one (${mine}). Nothing was changed.`, yesDefault: false, go: false };
  if (installed === mine) return { text: `${NAME} ${mine} is already installed. Install it again (repair)?`, yesDefault: false, go: true };
  return { text: `${NAME} ${installed} is already installed. Update to ${mine}?`, yesDefault: true, go: true };
}

/** A yes/no answer: Enter takes the default; y/yes or n/no; anything else asks again (null). */
export function answer(typed: string, yesDefault: boolean): boolean | null {
  const t = typed.trim().toLowerCase();
  if (!t) return yesDefault;
  if (t === 'y' || t === 'yes') return true;
  if (t === 'n' || t === 'no') return false;
  return null;
}

/** PowerShell quoting: inside '...' a ' is written twice. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The PowerShell that makes one shortcut (.lnk) with the program's own icon. */
export function shortcutScript(lnk: string, target: string, args = '', icon = `${target},0`): string {
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)})`,
    `$s.TargetPath = ${q(target)}`,
    `$s.Arguments = ${q(args)}`,
    `$s.WorkingDirectory = ${q(target.replace(/\\[^\\]*$/, ''))}`,
    `$s.IconLocation = ${q(icon)}`,
    `$s.Description = '${NAME}'`,
    '$s.Save()',
  ].join('; ');
}

/**
 * The PowerShell that finds (or, `stop`, ends) the program of THIS install folder only: another install (a
 * test one, or his real one while a test runs) is never touched. Ending it ends TOMLIN with it (a job object).
 * After the program rebuilt itself (src/trayfresh.ts) the one running is "TOMLIN.old.exe" until the next start:
 * it is found too.
 */
export function trayScript(exe: string, stop: boolean): string {
  const old = sideExe(exe, 'old');
  const name = basename(exe).replace(/\.exe$/i, '');
  const find = `Get-Process -Name ${q(name)},${q(`${name}.old`)} -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(exe)} -or $_.Path -eq ${q(old)} }`;
  return stop ? `${find} | Stop-Process -Force` : `@(${find}).Count`;
}

/** The PowerShell that says where a shortcut points ('' when it is not a shortcut). */
export const shortcutTargetScript = (lnk: string) => `(New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)}).TargetPath`;

/** reg.exe lines for the entry in Settings > Apps (this user only); its Uninstall runs the program with --uninstall. */
export function registryArgs(key: string, o: { root: string; version: string; kb: number }): string[][] {
  const exe = exeIn(o.root);
  const values: [string, string, string][] = [
    ['DisplayName', 'REG_SZ', NAME],
    ['DisplayVersion', 'REG_SZ', o.version],
    ['Publisher', 'REG_SZ', NAME],
    ['DisplayIcon', 'REG_SZ', `${exe},0`],
    ['InstallLocation', 'REG_SZ', o.root],
    ['UninstallString', 'REG_SZ', `"${exe}" --uninstall`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(Math.max(1, Math.round(o.kb)))],
  ];
  return values.map(([name, type, data]) => ['add', key, '/v', name, '/t', type, '/d', data, '/f']);
}

/** The compiler's arguments that build the program from tools/tray.cs with the icon. */
export function cscArgs(o: { out: string; source: string; icon: string }): string[] {
  return ['-nologo', '-target:winexe', '-optimize+', `-win32icon:${o.icon}`, `-out:${o.out}`, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', o.source];
}

/** The firewall rule for a node, as PowerShell run once as administrator (Windows asks first); none when one is there (under any of its names). */
export function firewallScript(port: number, ruleName: string, oldNames: string[] = []): string {
  return `if (-not (Get-NetFirewallRule -DisplayName ${[ruleName, ...oldNames].map(q).join(',')} -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName ${q(ruleName)} -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Domain | Out-Null }`;
}

/** How many firewall rules have one of those names, as PowerShell (reading them needs no administrator): "0" when none. */
export const firewallRuleCountScript = (...names: string[]) => `@(Get-NetFirewallRule -DisplayName ${names.map(q).join(',')} -ErrorAction SilentlyContinue).Count`;

/** The firewall rule (under any of its names) taken away again (uninstall), as PowerShell run once as administrator. */
export function removeFirewallScript(...names: string[]): string {
  return `Get-NetFirewallRule -DisplayName ${names.map(q).join(',')} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`;
}

/** PowerShell that runs `script` in a hidden PowerShell as administrator (Windows asks first) and waits for it. */
export function elevatedPowerShell(script: string): string {
  return `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${Buffer.from(script, 'utf16le').toString('base64')}'`;
}

/**
 * Whether what answered GET /api/status on TOMLIN's port is TOMLIN (any version, earlier names too): it says its
 * version and its panes, or (its app lock on) that it is locked. Anything else is another program using the port.
 */
export function isTomlinStatus(code: number, text: string): boolean {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return false;
  }
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (code === 200 && typeof o.version === 'string' && !!o.panes && typeof o.panes === 'object') || (code === 423 && o.locked === true);
}

/** What the installer says when TOMLIN's port answers: another TOMLIN to close, or another program in the way. */
export function portTakenLine(port: number | string, tomlin: boolean): string {
  return tomlin
    ? `Another TOMLIN is running on port ${port} (started with Start TOMLIN.cmd). Close its window.`
    : `Another program is using port ${port}, which TOMLIN needs. Close that program, then carry on. To see which program it is, run this in PowerShell: Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`;
}

/** The copies in the install folder that go: all but the one in use and the newest others, KEEP_COPIES in all. */
export function copiesToRemove(names: string[], current: string): string[] {
  const copies = names.filter(n => /^(tomlin|shelby)-\d+(\.\d+)+( \(\d+\))?$/.test(n) && n !== current);
  const ver = (n: string) => n.replace(/^(tomlin|shelby)-/, '').replace(/ \(\d+\)$/, '');
  copies.sort((a, b) => (newer(ver(a), ver(b)) ? -1 : newer(ver(b), ver(a)) ? 1 : b.localeCompare(a)));
  return copies.slice(KEEP_COPIES - 1);
}

/** The Start with Windows file's text when TOMLIN is installed: the program, with no window at the start. */
export function startupScriptFor(exe: string): string {
  return [
    '@echo off',
    'rem Made by TOMLIN (Nodes and memory: "Start TOMLIN when this PC starts"). Untick it there to remove this file.',
    `start "" "${exe.replace(/%/g, '%%')}" --quiet`,
    '',
  ].join('\r\n');
}

/** The PowerShell that says a file's file version ('' when it has none). */
export const fileVersionScript = (file: string) => `$v = (Get-Item -LiteralPath ${q(file)}).VersionInfo.FileVersionRaw; if ($v) { $v.ToString() }`;

/** The PowerShell that says whether a file is signed, and by whom: "Valid|Microsoft Corporation". */
export const signatureScript = (file: string) => `$s = Get-AuthenticodeSignature -LiteralPath ${q(file)}; "$($s.Status)|$(if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) })"`;

/** True when signatureScript's answer is a good signature by Microsoft. */
export const signedByMicrosoft = (said: string) => said.trim() === 'Valid|Microsoft Corporation';

/** The PowerShell that runs a program as administrator (Windows asks first), waits, and says its exit code. */
export function elevatedRunScript(file: string, args: string[]): string {
  return `$p = Start-Process -FilePath ${q(file)} -ArgumentList ${args.map(q).join(',')} -Verb RunAs -Wait -PassThru; $p.ExitCode`;
}

/** The Visual C++ Runtime installer's exit code in plain words; null = it worked. 3010 = worked, restart later. */
export function redistResult(code: number): string | null {
  if (code === 0 || code === 3010 || code === 1638) return null;
  if (code === 1602) return 'it was cancelled';
  if (code === 1618) return 'another installation was running on this PC; try again when it has finished';
  return `Microsoft's installer ended with code ${code}`;
}
