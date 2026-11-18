// The Windows side of the screen tools (src/screentools.ts): one fixed PowerShell script, run without a shell, that
// lists top-level windows, takes a picture of ONE window's own rectangle and reads it with Windows' built-in text
// reader (Windows.Media.Ocr, nothing downloaded), brings a window to the front, and sends one click or a few keys to
// it. What to do goes in as JSON on its input, never on the command line; what it found comes back as JSON. The
// script acts only on the window handle it is given, and only while that window's title is still the one given.
// The rules about WHICH window and WHEN are not here: they are in src/screentools.ts, which is tested with a made-up
// screen. This file cannot be tested without a real desktop; test/screentools.test.ts only checks that the script
// parses.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Looked, ScreenBackend, Stroke, Win } from './screentools.ts';

/** The longest edge of the picture kept for a click's card. */
export const CARD_EDGE = 1600;

export const SCREEN_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ask = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TomlinWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint how);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  public static string Title(IntPtr h) { var s = new StringBuilder(GetWindowTextLength(h) + 2); GetWindowText(h, s, s.Capacity); return s.ToString(); }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, p) => { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) l.Add(h); return true; }, IntPtr.Zero); return l; }
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint how);
  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  static bool OwnedBy(IntPtr w, IntPtr h) { for (int i = 0; i < 8 && w != IntPtr.Zero; i++) { w = GetWindow(w, 4); if (w == h) return true; } return false; }
  // The same program's pop-ups lying over the window (an open menu, a drop-down list), topmost first: windows it owns,
  // and its windows with no title. Another program's window is never one of them, nor a second titled window of this one.
  public static List<IntPtr> Over(IntPtr h) {
    var l = new List<IntPtr>(); uint pid = Pid(h); bool below = false;
    EnumWindows((w, p) => {
      if (w == h) { below = true; return false; }
      if (!below && IsWindowVisible(w) && !IsIconic(w) && Pid(w) == pid && (OwnedBy(w, h) || GetWindowTextLength(w) == 0)) l.Add(w);
      return true;
    }, IntPtr.Zero);
    return l;
  }
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(uint flags) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; Send(i); }
  public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0); i.u.ki.dwFlags = up ? 2u : 0u; Send(i); }
  public static void Char(char c, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wScan = c; i.u.ki.dwFlags = 4u | (up ? 2u : 0u); Send(i); }
  public static bool Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    uint pid; uint mine = GetCurrentThreadId(); uint theirs = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (theirs != mine) AttachThreadInput(mine, theirs, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (theirs != mine) AttachThreadInput(mine, theirs, false);
    System.Threading.Thread.Sleep(250);
    return GetForegroundWindow() == h;
  }
}
'@
[void][TomlinWin]::SetProcessDPIAware()

function Describe($h) {
  $r = New-Object TomlinWin+RECT
  [void][TomlinWin]::GetWindowRect($h, [ref]$r)
  [uint32]$procId = 0
  [void][TomlinWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId).ProcessName + '.exe' } catch { }
  @{ id = [string][int64]$h; title = [TomlinWin]::Title($h); process = $name; x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top; minimized = [TomlinWin]::IsIconic($h) }
}

function Reply($o) { [Console]::Out.Write(($o | ConvertTo-Json -Depth 8 -Compress)) }

if ($ask.op -eq 'list') {
  $all = @([TomlinWin]::All() | ForEach-Object { Describe $_ })
  Reply @{ windows = $all }
  exit 0
}

$h = [IntPtr][int64]$ask.id
if (-not [TomlinWin]::IsWindow($h) -or [TomlinWin]::Title($h) -cne $ask.title) { Reply @{ error = 'gone' }; exit 0 }

if ($ask.op -eq 'look') {
  if ([TomlinWin]::IsIconic($h)) { Reply @{ error = 'minimised' }; exit 0 }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $win = Describe $h
  if ($win.w -lt 8 -or $win.h -lt 8 -or $win.w -gt 10000 -or $win.h -gt 10000) { Reply @{ error = 'size' }; exit 0 }
  $bmp = New-Object System.Drawing.Bitmap($win.w, $win.h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  # 2: the whole window as it is drawn, also when another window covers part of it.
  $drawn = [TomlinWin]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc)
  if (-not $drawn) { $g.CopyFromScreen($win.x, $win.y, 0, 0, (New-Object System.Drawing.Size($win.w, $win.h))) }
  # An open menu or drop-down list is a window of its own, so it is not in that picture: each of the program's own
  # pop-ups over the window is drawn onto it, the lowest first. What hangs outside the window's edge is cut off.
  $over = @([TomlinWin]::Over($h))
  [array]::Reverse($over)
  foreach ($p in $over) {
    $pr = New-Object TomlinWin+RECT
    [void][TomlinWin]::GetWindowRect($p, [ref]$pr)
    $pw = $pr.Right - $pr.Left; $ph = $pr.Bottom - $pr.Top
    if ($pw -lt 4 -or $ph -lt 4 -or $pw -gt 10000 -or $ph -gt 10000) { continue }
    if ($pr.Right -le $win.x -or $pr.Bottom -le $win.y -or $pr.Left -ge ($win.x + $win.w) -or $pr.Top -ge ($win.y + $win.h)) { continue }
    $pb = New-Object System.Drawing.Bitmap($pw, $ph, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $pg = [System.Drawing.Graphics]::FromImage($pb)
    $pdc = $pg.GetHdc()
    $ok = [TomlinWin]::PrintWindow($p, $pdc, 2)
    $pg.ReleaseHdc($pdc)
    $pg.Dispose()
    if ($ok) { $g.DrawImage($pb, ($pr.Left - $win.x), ($pr.Top - $win.y), $pw, $ph) }
    $pb.Dispose()
  }
  $g.Dispose()
  $captureMs = $clock.ElapsedMilliseconds

  # Small menu text reads better at twice the size; the reader takes at most 10,000 pixels a side.
  $scale = 1
  if ($win.w -le 2600 -and $win.h -le 2600) { $scale = 2 }
  $big = New-Object System.Drawing.Bitmap(($win.w * $scale), ($win.h * $scale))
  $bg = [System.Drawing.Graphics]::FromImage($big)
  $bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $bg.DrawImage($bmp, 0, 0, $big.Width, $big.Height)
  $bg.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $big.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose()
  $ms.Position = 0

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(60000); $t.Result }
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { Reply @{ error = 'noreader' }; exit 0 }
  $read = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($read.Lines | ForEach-Object { , @($_.Words | ForEach-Object { @{ t = $_.Text; x = [int]($_.BoundingRect.X / $scale); y = [int]($_.BoundingRect.Y / $scale); w = [int]($_.BoundingRect.Width / $scale); h = [int]($_.BoundingRect.Height / $scale) } }) })
  $ocrMs = $clock.ElapsedMilliseconds - $captureMs

  # The picture for a click's card: the window, its longest edge at most what was asked.
  $edge = [Math]::Max($win.w, $win.h)
  $k = [Math]::Min(1.0, [double]$ask.edge / $edge)
  $small = New-Object System.Drawing.Bitmap([int][Math]::Max(1, $win.w * $k), [int][Math]::Max(1, $win.h * $k))
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
  $sg.Dispose()
  $out = New-Object System.IO.MemoryStream
  $small.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose(); $bmp.Dispose()
  # The title is read again now the picture is taken.
  $win.title = [TomlinWin]::Title($h)
  Reply @{ win = $win; lines = $lines; lang = $engine.RecognizerLanguage.LanguageTag; captureMs = $captureMs; ocrMs = $ocrMs; image = [Convert]::ToBase64String($out.ToArray()) }
  exit 0
}

# The three that act: the window is brought to the front first, and nothing is sent unless it then IS in front with
# the same title.
$front = [TomlinWin]::Front($h)
if ($front -and [TomlinWin]::Title($h) -cne $ask.title) { $front = $false }
if ($ask.op -eq 'focus' -or -not $front) { Reply @{ front = $front }; exit 0 }

if ($ask.op -eq 'click') {
  $r = New-Object TomlinWin+RECT
  [void][TomlinWin]::GetWindowRect($h, [ref]$r)
  if ($r.Left -ne $ask.wx -or $r.Top -ne $ask.wy -or ($r.Right - $r.Left) -ne $ask.ww -or ($r.Bottom - $r.Top) -ne $ask.wh) { Reply @{ front = $false; moved = $true }; exit 0 }
  [void][TomlinWin]::SetCursorPos($r.Left + [int]$ask.x, $r.Top + [int]$ask.y)
  Start-Sleep -Milliseconds 80
  $down = 2; $up = 4
  if ($ask.button -eq 'right') { $down = 8; $up = 16 }
  $times = 1
  if ($ask.double) { $times = 2 }
  for ($i = 0; $i -lt $times; $i++) { [TomlinWin]::Mouse($down); [TomlinWin]::Mouse($up); Start-Sleep -Milliseconds 60 }
  Reply @{ front = $true }
  exit 0
}

if ($ask.op -eq 'keys') {
  foreach ($s in @($ask.strokes)) {
    if ([TomlinWin]::GetForegroundWindow() -ne $h) { Reply @{ front = $false }; exit 0 }
    if ($s.ctrl) { [TomlinWin]::Key(0x11, $false) }
    if ($s.alt) { [TomlinWin]::Key(0x12, $false) }
    if ($s.shift) { [TomlinWin]::Key(0x10, $false) }
    [TomlinWin]::Key([uint16]$s.vk, $false)
    Start-Sleep -Milliseconds 30
    [TomlinWin]::Key([uint16]$s.vk, $true)
    if ($s.shift) { [TomlinWin]::Key(0x10, $true) }
    if ($s.alt) { [TomlinWin]::Key(0x12, $true) }
    if ($s.ctrl) { [TomlinWin]::Key(0x11, $true) }
    Start-Sleep -Milliseconds 120
  }
  foreach ($c in ([string]$ask.text).ToCharArray()) {
    if ([TomlinWin]::GetForegroundWindow() -ne $h) { Reply @{ front = $false }; exit 0 }
    [TomlinWin]::Char($c, $false); [TomlinWin]::Char($c, $true)
    Start-Sleep -Milliseconds 20
  }
  Reply @{ front = $true }
  exit 0
}
Reply @{ error = 'unknown' }
`;

let scriptFile: string | null = null;
/** The script as a file in a temporary folder of its own, written once a run (PowerShell takes a long script only so). */
function scriptPath(): string {
  if (!scriptFile) {
    scriptFile = join(mkdtempSync(join(tmpdir(), 'tomlin-screen-')), 'screen.ps1');
    // With a byte-order mark: Windows PowerShell 5.1 reads a file without one in the PC's old code page.
    writeFileSync(scriptFile, `\ufeff${SCREEN_PS1}`, 'utf8');
  }
  return scriptFile;
}

/** Runs the script with one request; its answer as JSON. Fixed arguments, no shell, a time limit, output capped. */
function ask(body: Record<string, unknown>, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()], { windowsHide: true, shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (out.length < 40 * 2 ** 20) out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.replace(/^\ufeff/, '')) as Record<string, unknown>);
      } catch {
        reject(new Error(`Windows did not answer (${err.split('\n')[0].trim().slice(0, 200) || 'no output'}).`));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const winOf = (o: unknown): Win => {
  const w = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return { id: String(w.id ?? ''), title: String(w.title ?? ''), process: String(w.process ?? ''), x: num(w.x), y: num(w.y), w: num(w.w), h: num(w.h), minimized: w.minimized === true };
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const WHY: Record<string, string> = {
  gone: 'the window closed or its title changed',
  minimised: 'the window is minimised',
  size: 'the window is too small or too large to read',
  noreader: 'Windows has no text reader for this PC\'s language (Settings, Time and language, Language, add the "Optical character recognition" feature)',
};

/** The real screen. Only on Windows. */
export const winScreen: ScreenBackend = {
  async windows() {
    return list((await ask({ op: 'list' }, 30_000)).windows).map(winOf).filter(w => w.id && w.title);
  },
  async look(id, title): Promise<Looked> {
    const r = await ask({ op: 'look', id, title, edge: CARD_EDGE });
    if (typeof r.error === 'string') throw new Error(WHY[r.error] ?? r.error);
    const lines = list(r.lines).map(l => list(l).map(w => {
      const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
      return { t: String(o.t ?? ''), x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h) };
    }).filter(w => w.t));
    return { win: winOf(r.win), lines: lines.filter(l => l.length), lang: String(r.lang ?? ''), captureMs: num(r.captureMs), ocrMs: num(r.ocrMs), ...(typeof r.image === 'string' ? { image: r.image } : {}) };
  },
  async focus(id, title) {
    return { front: (await ask({ op: 'focus', id, title }, 30_000)).front === true };
  },
  async click(id, title, x, y, o) {
    // Where the window is now goes with the click: the script will not click when it has moved from there.
    const now = (await this.windows()).find(w => w.id === id);
    if (!now) return { front: false };
    return { front: (await ask({ op: 'click', id, title, x, y, button: o.button, double: o.double, wx: now.x, wy: now.y, ww: now.w, wh: now.h }, 30_000)).front === true };
  },
  async keys(id, title, strokes: Stroke[], text) {
    return { front: (await ask({ op: 'keys', id, title, strokes: strokes.map(s => ({ ctrl: s.ctrl, alt: s.alt, shift: s.shift, vk: s.vk })), text }, 30_000)).front === true };
  },
};
