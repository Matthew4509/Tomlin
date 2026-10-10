// Sealing secrets with Windows' own protection (DPAPI, "CurrentUser"): a sealed value opens only for the same Windows
// account on the same PC. Nothing is downloaded: PowerShell 5.1 and .NET's ProtectedData ship with Windows.
// Everything secret the hosting part keeps (a site's Live and Local values, a cPanel token, an FTP password, an SFTP
// key) goes through here; the files on disk hold only sealed text ("dpapi:<base64>").
// Tests (and a PC without PowerShell) can set BRIDGE_TEST_VAULT=plain: values are then only base64-wrapped
// ("test:<base64>"), which is said in every place that reads them, and never used outside the tests.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ENTROPY = 'TOMLIN hosting v1';
const TEST = () => process.env.BRIDGE_TEST_VAULT === 'plain';

// One PowerShell for a whole list: starting it costs about half a second, so callers seal and open in batches.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$e = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$out = @()
foreach ($x in @($in.items)) {
  $b = [Convert]::FromBase64String([string]$x)
  if ($in.op -eq 'seal') { $r = [Security.Cryptography.ProtectedData]::Protect($b, $e, 'CurrentUser') }
  else { $r = [Security.Cryptography.ProtectedData]::Unprotect($b, $e, 'CurrentUser') }
  $out += [Convert]::ToBase64String($r)
}
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($out)))
`;

function powershell() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPs(op, items) {
  return new Promise((resolve, reject) => {
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const ps = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch {} reject(new Error('Windows took too long to ' + (op === 'seal' ? 'lock' : 'open') + ' the saved secrets (over 30 s).')); }, 30000);
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', e => { clearTimeout(timer); reject(new Error('PowerShell could not be started to ' + (op === 'seal' ? 'lock' : 'open') + ' the secrets: ' + e.message)); });
    ps.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = /Unprotect|key not valid|CryptographicException/i.test(err) ? ' They were locked by another Windows account or on another PC, so this account cannot open them: type them again.' : '';
        return reject(new Error('Windows could not ' + (op === 'seal' ? 'lock' : 'open') + ' the saved secrets.' + why));
      }
      try { const v = JSON.parse(out.trim() || '[]'); resolve(Array.isArray(v) ? v : [v]); }
      catch { reject(new Error('Windows gave an unreadable answer while ' + (op === 'seal' ? 'locking' : 'opening') + ' the secrets.')); }
    });
    ps.stdin.end(JSON.stringify({ op, items }));
  });
}

/** Seal a list of strings: ['dpapi:...', ...] (same order). Empty strings stay empty. */
async function sealAll(values) {
  const list = values.map(v => String(v == null ? '' : v));
  const todo = list.map((v, i) => [v, i]).filter(([v]) => v !== '');
  const out = list.map(() => '');
  if (!todo.length) return out;
  if (TEST()) { for (const [v, i] of todo) out[i] = 'test:' + Buffer.from(v, 'utf8').toString('base64'); return out; }
  const sealed = await runPs('seal', todo.map(([v]) => Buffer.from(v, 'utf8').toString('base64')));
  todo.forEach(([, i], k) => { out[i] = 'dpapi:' + sealed[k]; });
  return out;
}

/** Open a list of sealed strings (same order). '' stays ''. */
async function openAll(sealedList) {
  const list = sealedList.map(v => String(v || ''));
  const out = list.map(() => '');
  const dp = [];
  list.forEach((v, i) => {
    if (!v) return;
    if (v.startsWith('test:')) {
      if (!TEST()) throw new Error('A saved secret was written by a test copy and cannot be used here: type it again.');
      out[i] = Buffer.from(v.slice(5), 'base64').toString('utf8');
    } else if (v.startsWith('dpapi:')) dp.push([v.slice(6), i]);
    else throw new Error('A saved secret is not in a form TOMLIN reads: type it again.');
  });
  if (dp.length) {
    const opened = await runPs('open', dp.map(([v]) => v));
    dp.forEach(([, i], k) => { out[i] = Buffer.from(opened[k], 'base64').toString('utf8'); });
  }
  return out;
}

const seal = async v => (await sealAll([v]))[0];
const open = async v => (await openAll([v]))[0];

module.exports = { seal, open, sealAll, openAll };
