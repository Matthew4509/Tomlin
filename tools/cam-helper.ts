// The laptop helper's program (src/camhelper.ts): run it ON THE LAPTOP that has AlphaCAM, not on the main PC.
//
//   node tools/cam-helper.ts                 start it (port 8742); it prints the setup code to type on the main PC
//   node tools/cam-helper.ts --program acam  the program to read, as part of its process name or window title
//   node tools/cam-helper.ts --port 8750
//
// It needs Node 22.18 or newer and four files, kept in the same places: tools/cam-helper.ts, src/camhelper.ts,
// src/link.ts and src/share.ts (docs/CAM-HELPER.md). It keeps cam-helper.json beside itself (its name, its setup code, the PCs linked to it).
//
// What it does for a linked PC, and nothing else: reads the program's menus and its window state as text, with a
// fixed PowerShell script (Win32 menu calls first, Windows UI Automation when the program has no classic menu). It
// never clicks, types, opens a menu on screen or runs a menu item. It answers only on the home network.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Helper, HELPER_PORT, cleanHelperState, newHelperState, type HelperState, type HelperTool } from '../src/camhelper.ts';

export const CAM_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ask = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TomlinCam {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int pos);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint id, StringBuilder s, int n, uint flags);
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, p) => { if (IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero); return l; }
  // The classic menu of a window, read from Windows' own tables: nothing opens on screen.
  public static void Walk(IntPtr m, int depth, List<string> o, string only) {
    int n = GetMenuItemCount(m);
    for (int i = 0; i < n && o.Count < 4000; i++) {
      uint st = GetMenuState(m, (uint)i, 0x400);
      if (st == 0xFFFFFFFF) continue;
      var s = new StringBuilder(256); GetMenuString(m, (uint)i, s, 256, 0x400);
      string raw = s.ToString();
      if ((st & 0x800) != 0 && raw.Length == 0) { if (depth > 0) o.Add(new string(' ', depth * 2) + "----"); continue; }
      string[] parts = raw.Split('\t');
      string name = parts[0].Replace("&", "");
      if (depth == 0 && only != null && only.Length > 0 && !string.Equals(name, only, StringComparison.OrdinalIgnoreCase)) continue;
      string line = new string(' ', depth * 2) + name;
      if (parts.Length > 1) line += "  [" + parts[1] + "]";
      if ((st & 0x3) != 0) line += "  (greyed)";
      if ((st & 0x8) != 0) line += "  (ticked)";
      o.Add(line);
      IntPtr sub = GetSubMenu(m, i);
      if (sub != IntPtr.Zero && depth < 6) Walk(sub, depth + 1, o, null);
    }
  }
}
'@

$want = [string]$ask.program
$mine = @()
foreach ($h in [TomlinCam]::All()) {
  $procId = [uint32]0
  [void][TomlinCam]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId).ProcessName } catch { }
  $title = [TomlinCam]::Title($h)
  if ($title -and ($name -like ('*' + $want + '*') -or $title -like ('*' + $want + '*'))) { $mine += @{ h = $h; title = $title; proc = $name; pid = $procId; cls = [TomlinCam]::Class($h) } }
}
if (-not $mine.Count) { [Console]::Out.Write((@{ error = 'notrunning' } | ConvertTo-Json -Compress)); exit 0 }
# The main window: the first of the program's windows that is not a dialog.
$main = @($mine | Where-Object { $_.cls -ne '#32770' })[0]
if ($null -eq $main) { $main = $mine[0] }
$lines = New-Object 'System.Collections.Generic.List[string]'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Named($el, $depth, $types, $most) {
  # Walks what is already on screen (the control view), top down. Nothing is opened, pressed or changed.
  if ($lines.Count -ge $most -or $depth -gt 7) { return }
  $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $c = $w.GetFirstChild($el)
  while ($null -ne $c -and $lines.Count -lt $most) {
    try {
      $t = $c.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $n = [string]$c.Current.Name
      if ($types -contains $t -and $n) {
        $line = ('  ' * $depth) + $t + ': ' + $n
        if ($c.Current.AcceleratorKey) { $line += '  [' + $c.Current.AcceleratorKey + ']' }
        if (-not $c.Current.IsEnabled) { $line += '  (greyed)' }
        if ($t -eq 'Edit' -or $t -eq 'ComboBox') {
          if ($c.Current.IsPassword) { $line += ' = (hidden)' }
          else {
            $vp = $null
            if ($c.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $line += ' = ' + ([string]$vp.Current.Value).Substring(0, [Math]::Min(120, ([string]$vp.Current.Value).Length)) }
          }
        }
        $lines.Add($line)
      }
      Named $c ($depth + 1) $types $most
    } catch { }
    $c = $w.GetNextSibling($c)
  }
}

if ($ask.tool -eq 'cam_menus') {
  $lines.Add('Menus of ' + $main.title + ':')
  $m = [TomlinCam]::GetMenu($main.h)
  if ($m -ne [IntPtr]::Zero -and [TomlinCam]::GetMenuItemCount($m) -gt 0) {
    $found = New-Object 'System.Collections.Generic.List[string]'
    [TomlinCam]::Walk($m, 0, $found, [string]$ask.menu)
    $lines.AddRange($found)
    $how = 'menu'
  } else {
    # No classic menu (a ribbon or drawn toolbars): what Windows UI Automation shows of it, as it stands on screen.
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($main.h)
    Named $root 0 @('MenuBar', 'MenuItem', 'Menu', 'ToolBar', 'Tab', 'TabItem', 'Button', 'SplitButton', 'Group') 1500
    $how = 'uia'
  }
  [Console]::Out.Write((@{ how = $how; text = ($lines -join [char]10) } | ConvertTo-Json -Compress))
  exit 0
}

if ($ask.tool -eq 'cam_window_state') {
  $lines.Add('Window: ' + $main.title)
  $dialogs = @($mine | Where-Object { $_.h -ne $main.h })
  if (-not $dialogs.Count) { $lines.Add('No dialog is open.') }
  foreach ($d in $dialogs | Select-Object -First 3) {
    $lines.Add('Dialog: ' + $d.title)
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($d.h)
    Named $root 1 @('Text', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'Button', 'Group', 'TabItem', 'ListItem') 300
  }
  [Console]::Out.Write((@{ how = 'uia'; text = ($lines -join [char]10) } | ConvertTo-Json -Compress))
  exit 0
}
[Console]::Out.Write((@{ error = 'unknown' } | ConvertTo-Json -Compress))
`;

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

let scriptFile: string | null = null;
function scriptPath(): string {
  if (!scriptFile) {
    scriptFile = join(mkdtempSync(join(tmpdir(), 'tomlin-cam-')), 'cam.ps1');
    writeFileSync(scriptFile, `\ufeff${CAM_PS1}`, 'utf8');
  }
  return scriptFile;
}

/** Reads the program with the fixed script: the tool's name and a menu name go in as JSON, never on a command line. */
export function readProgram(program: string, tool: HelperTool, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()], { windowsHide: true, shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on('data', (d: Buffer) => { if (out.length < 2 ** 20) out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out.replace(/^\ufeff/, '')) as { text?: string; error?: string; how?: string };
        if (r.error === 'notrunning') return reject(new Error(`"${program}" is not running on the laptop (no window of that program was found).`));
        if (r.error || typeof r.text !== 'string') return reject(new Error('the helper could not read the program.'));
        resolve(r.how === 'uia' && tool === 'cam_menus' ? `${r.text}\n(This program has no classic menu, so this is what Windows shows of its bars and buttons as they stand now; closed drop-downs are not listed.)` : r.text);
      } catch {
        reject(new Error(`Windows did not answer on the laptop (${err.split('\n')[0].trim().slice(0, 160) || 'no output'}).`));
      }
    });
    child.stdin.end(JSON.stringify({ tool, program, menu: typeof args.menu === 'string' ? args.menu.slice(0, 80) : '' }));
  });
}

function main(): void {
  if (process.platform !== 'win32') {
    console.error('The laptop helper runs on Windows only.');
    process.exit(1);
  }
  const file = join(dirname(fileURLToPath(import.meta.url)), 'cam-helper.json');
  let state: HelperState | null = null;
  try {
    state = existsSync(file) ? cleanHelperState(JSON.parse(readFileSync(file, 'utf8'))) : null;
  } catch {
    state = null;
  }
  if (!state) {
    state = newHelperState();
    writeFileSync(file, JSON.stringify(state, null, 1));
  }
  const program = arg('program', 'acam').replace(/[^\w .-]/g, '').slice(0, 40) || 'acam';
  const port = Math.min(65535, Math.max(1024, Number(arg('port', String(HELPER_PORT))) || HELPER_PORT));
  const helper = new Helper(state, { read: (tool, args) => readProgram(program, tool, args), save: async s => writeFileSync(file, JSON.stringify(s, null, 1)) });
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
      helper.handle({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], body, address: req.socket.remoteAddress })
        .then(a => {
          res.writeHead(a.status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
          res.end(JSON.stringify(a.body));
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'The helper had a fault.' }));
        });
    });
  }).listen(port, '0.0.0.0', () => {
    console.log(`TOMLIN laptop helper: reading "${program}", listening on port ${port} (home network only).`);
    console.log(`Setup code: ${state!.code.replace(/(.{4})(?=.)/g, '$1-')}`);
    console.log('On the main PC: Settings, Permissions, Laptop helper: type this PC\'s address and the code.');
    console.log(`Linked PCs: ${helper.state.links.length ? helper.state.links.map(l => l.name || l.from).join(', ') : 'none yet'}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
