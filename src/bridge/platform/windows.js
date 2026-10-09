// Windows: every call the Bridge makes to Windows itself lives here (and in the .ps1 helpers beside it), so another
// system only needs its own file with the same functions. Nothing here knows about dry runs or demos: the callers
// decide whether to act, and this file only acts.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS_DIR = path.join(__dirname, 'windows');
const NAME = 'Windows';

// Runs one of the .ps1 helpers with fixed arguments and returns what it printed. STA: the folder dialog needs it.
function powershell(script, args, { sta = false } = {}) {
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', ['-NoProfile', ...(sta ? ['-STA'] : []), '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, script), ...args], { windowsHide: true });
    let out = '', err = '';
    ps.stdout.setEncoding('utf8'); ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', e => resolve({ code: -1, out, err, spawnError: e }));
    ps.on('close', code => resolve({ code, out, err }));
  });
}
const firstLine = s => (s || '').trim().split(/\r?\n/)[0];
const detached = (exe, args, opts = {}) => spawn(exe, args, { detached: true, stdio: 'ignore', ...opts }).unref();

// The default browser.
function openUrl(url) { detached('rundll32.exe', ['url.dll,FileProtocolHandler', url]); }

// Microsoft Edge ships with every Windows 11: the Bridge's own window (app mode) and the site pictures use it.
function findBrowser() {
  const c = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean).map(b => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return c.find(p => fs.existsSync(p)) || null;
}

// The Windows 11 "Select folder" dialog. The title comes from the caller's fixed list.
async function pickFolder(title) {
  const r = await powershell('pick-folder.ps1', ['-Title', title], { sta: true });
  if (r.spawnError) return { error: 'The folder window could not be opened (' + r.spawnError.message + '). Type the folder path instead.' };
  const p = r.out.trim();
  if (p) return { path: p };
  if (r.code !== 0) return { error: 'The folder window could not be opened' + (r.err ? ': ' + firstLine(r.err) : '') + '. Type the folder path instead.' };
  return { cancelled: true };
}

function onPath(name) {
  try { return execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; }
  catch { return null; }
}

// A plain terminal in the folder. The folder is passed to `wt` as one argument, and to the cmd fallback only as the
// child's working directory (cwd) — never inside the command line, so a folder name with cmd metacharacters
// (& ^ ( ) which Windows allows) cannot break out into another command. `start ""` gives the window an empty title.
function terminalCommand(dir) { return (onPath('wt') ? 'wt' : 'start') + ' cmd.exe /k (in ' + dir + ')'; }
function openTerminal(dir) {
  if (onPath('wt')) detached('wt.exe', ['-d', dir, 'cmd.exe', '/k']);
  else detached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k'], { cwd: dir });
}

function openFolder(dir) { detached('explorer.exe', [dir]); }
function revealFile(file) { detached('explorer.exe', ['/select,', file]); }

// Which program listens on each port: [{ port, pid, name, cmd, parent }].
async function portOwners(ports) {
  if (!ports.length) return [];
  const r = await powershell('port-owner.ps1', ['-Ports', ports.join(',')]);
  let list = [];
  try { list = JSON.parse(r.out.trim() || '[]'); } catch {}
  return Array.isArray(list) ? list : [list];
}
// Windows' own processes and the Bridge's window are never offered for stopping.
const PROTECTED_NAMES = /^(system|idle|svchost|lsass|wininit|winlogon|services|csrss|smss|spoolsv|explorer|dwm|fontdrvhost|msedge|msedgewebview2)\.exe$/i;
function systemProcessWhy(o) {
  if (!o.pid || o.pid <= 4) return 'it is part of Windows';
  if (PROTECTED_NAMES.test(o.name || '')) return (o.name || 'it') + ' is part of Windows or the Bridge window';
  return null;
}
// What spawn() can start with no shell. A .cmd/.bat (npm, npx, yarn, pnpm and the like) cannot be started that way on
// Windows (EINVAL / ENOENT). npm and npx become node + their own script beside node.exe; any other script runs through
// cmd.exe, but only with plain arguments (nothing cmd would read as a command: & | < > ^ % ! " ( ) ).
const NPM_CLI = { npm: 'npm-cli.js', npx: 'npx-cli.js' };
// cwd: the folder it runs in, where a bare "serve.cmd" is looked for first (as cmd.exe would).
function runnable(exe, args, cwd) {
  let full = exe;
  const here = cwd && !/[\\/]/.test(exe) && ['', '.cmd', '.bat'].map(x => path.join(cwd, exe + x)).find(f => /\.(cmd|bat)$/i.test(f) && fs.existsSync(f));
  if (here) full = here;
  else if (!/[\\/]/.test(exe)) {
    if (/\.exe$/i.test(exe)) return { exe, args };
    full = onPath(exe);
    if (!full) return { exe, args }; // spawn reports it as not found
    // where.exe lists the extension-less shell script first for npm/npx; the .cmd beside it is the one Windows runs
    if (!/\.(cmd|bat|exe|com)$/i.test(full)) { const cmd = full + '.cmd'; full = fs.existsSync(cmd) ? cmd : full; }
  }
  if (!/\.(cmd|bat)$/i.test(full)) return { exe: full, args };
  const base = path.basename(full).replace(/\.(cmd|bat)$/i, '').toLowerCase();
  if (NPM_CLI[base]) {
    const node = path.join(path.dirname(full), 'node.exe');
    const cli = path.join(path.dirname(full), 'node_modules', 'npm', 'bin', NPM_CLI[base]);
    if (fs.existsSync(cli)) return { exe: fs.existsSync(node) ? node : process.execPath, args: [cli, ...args] };
  }
  const bad = args.find(a => /[&|<>^%!"()\r\n]/.test(a));
  if (bad !== undefined) return { error: 'it is a Windows script (' + path.basename(full) + '), and the argument "' + bad.slice(0, 40) + '" has a character the Windows command line would treat as a command.' };
  const q = a => (/[\s]/.test(a) || a === '' ? '"' + a + '"' : a);
  return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + [q(full), ...args.map(q)].join(' ') + '"'], windowsVerbatimArguments: true };
}
function killCommand(pid, name) { return 'taskkill /PID ' + pid + ' /T /F (' + name + ')'; }
function killTree(pid) {
  try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

module.exports = {
  NAME, openUrl, findBrowser, pickFolder, onPath, terminalCommand, openTerminal, openFolder, revealFile,
  portOwners, systemProcessWhy, killCommand, killTree, runnable,
};
