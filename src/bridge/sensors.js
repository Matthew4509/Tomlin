// GPU use and CPU heat for the This PC panel. Both are read on request and cached, so the page's 5-second
// poll never waits on them: it gets the last reading and asks for a new one.
//
// GPU use: Windows' GPU Engine counters, the ones Task Manager uses, read by lib/platform/windows/gpu-sample.ps1 (one PowerShell
// kept waiting, about 0.1 s of CPU per reading; it ends when the Bridge stops). Like Task Manager, the figure is
// the busiest engine: each engine's use added up over every program, then the highest.
//
// CPU heat: Windows only hands the CPU's temperature to programs running as administrator, and the one reading it
// gives everyone else is a board zone that does not follow the CPU. So heat comes from LibreHardwareMonitor (free,
// open source, runs as admin) when its web server is on: http://127.0.0.1:8085/data.json. Without it, no number.
// HIDDEN: CPU_TEMP is false, so the Bridge never asks port 8085 and the page shows no CPU temp ring.
// Setting it true brings back both; README's This PC and safety sections would need their CPU temp lines again.
'use strict';
const CPU_TEMP = false;
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// ---- GPU ----
// Sample names look like pid_1212_luid_0x00000000_0x0000bc30_phys_0_eng_0_engtype_3d.
const ENGINE = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.*)$/i;
function gpuFromLine(line) {
  const [, count, list = ''] = line.match(/^GPU (\d+) ?(.*)$/) || [];
  if (!count) return null;
  const eng = new Map();
  for (const pair of list.split('|').filter(Boolean)) {
    const at = pair.lastIndexOf('=');
    const m = pair.slice(0, at).match(ENGINE), v = Number(pair.slice(at + 1));
    if (!m || !isFinite(v)) continue;
    const k = m[1] + '/' + m[2] + '/' + m[3];
    const e = eng.get(k) || { type: m[4].trim(), use: 0 };
    e.use += v;
    eng.set(k, e);
  }
  let top = { type: '', use: 0 };
  for (const e of eng.values()) if (e.use > top.use) top = e;
  return { pct: Math.round(Math.min(100, top.use)), engine: top.use > 0 ? top.type : '' };
}

let ps = null, pending = false, diedAt = 0, buf = '';
const gpu = { pct: null, engine: '', adapters: [], error: null, at: 0 };
function startGpu() {
  if (Date.now() - diedAt < 60000) return; // it stopped by itself a moment ago: do not spin on a broken PowerShell
  try {
    ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'platform', 'windows', 'gpu-sample.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) { ps = null; diedAt = Date.now(); gpu.error = 'PowerShell would not start: ' + e.message; return; }
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('ADAPTERS')) { gpu.adapters = line.slice(9).split('|').map(s => s.trim()).filter(Boolean); continue; }
      pending = false; gpu.at = Date.now();
      const g = gpuFromLine(line);
      if (g) Object.assign(gpu, g, { error: null });
      else gpu.error = line.startsWith('ERR ') ? line.slice(4) : 'The GPU reading came back in a shape the Bridge does not know.';
    }
  });
  ps.stdin.on('error', () => {});
  ps.on('error', e => { gpu.error = 'PowerShell would not start: ' + e.message; });
  ps.on('exit', () => { ps = null; pending = false; diedAt = Date.now(); buf = ''; if (gpu.error == null) gpu.error = 'The GPU reader stopped; it starts again within a minute.'; gpu.pct = null; });
}
function gpuStats() {
  if (process.platform !== 'win32') return { pct: null, engine: '', adapters: [], error: 'GPU use is read from Windows counters, so it shows on Windows only.' };
  if (!ps) startGpu();
  if (ps && !pending && Date.now() - gpu.at > 3000) { pending = true; ps.stdin.write('\n'); }
  return { pct: gpu.pct, engine: gpu.engine, adapters: gpu.adapters, error: gpu.error };
}
function stopGpu() { if (ps) try { ps.kill(); } catch {} }

// ---- CPU heat from LibreHardwareMonitor ----
const LHM_PORT = 8085;
// "52.0 °C", "52,0 °C" (its number format follows Windows), or °F if it is set to Fahrenheit.
function parseTemp(v) {
  const m = String(v || '').match(/(-?\d+(?:[.,]\d+)?)\s*°\s*([CF])/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return m[2] === 'F' ? (n - 32) * 5 / 9 : n;
}
// Its data.json is a tree: computer > hardware (the CPU has an ImageURL ending cpu.png and, in newer versions, a
// HardwareId like /intelcpu/0) > groups > sensors. Take the CPU's own temperature sensors, never "Distance to
// TjMax" (degrees BELOW the limit, so a cool CPU would read high), and prefer the package reading.
const PREFER = [/^CPU Package$/i, /^Core Max$/i, /^Core \(Tctl\/Tdie\)$/i, /^CPU \(Tctl\/Tdie\)$/i, /^Core Average$/i];
function cpuTempFromLhm(root) {
  const cpus = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (/cpu\.png$/i.test(String(n.ImageURL || '')) || /^\/(intel|amd)cpu\//i.test(String(n.HardwareId || ''))) cpus.push(n);
    else for (const c of n.Children || []) walk(c);
  })(root);
  for (const cpu of cpus) {
    const temps = [];
    (function walk(n) {
      for (const c of n.Children || []) {
        if ((c.Children || []).length) { walk(c); continue; }
        const t = parseTemp(c.Value), label = String(c.Text || '').trim();
        if (t == null || /distance|tjmax/i.test(label) || t < 1 || t > 150) continue;
        temps.push({ label, c: t });
      }
    })(cpu);
    if (!temps.length) continue;
    const pick = PREFER.map(re => temps.find(x => re.test(x.label))).find(Boolean) || temps.reduce((a, b) => b.c > a.c ? b : a);
    return { c: Math.round(pick.c), label: pick.label, cpu: String(cpu.Text || '').trim() };
  }
  return null;
}
function readLhm(port = LHM_PORT) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/data.json', timeout: 1500 }, res => {
      if (res.statusCode === 401) { res.resume(); return resolve({ error: 'LibreHardwareMonitor asked for a password. In LibreHardwareMonitor, open Options › Remote Web Server and turn off its sign-in, or leave the heat ring off.' }); }
      if (res.statusCode !== 200) { res.resume(); return resolve({ error: 'Something on port ' + port + ' answered ' + res.statusCode + ', not LibreHardwareMonitor.' }); }
      let body = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', d => { size += d.length; if (size > 4e6) req.destroy(); else body += d; });
      res.on('end', () => {
        let j; try { j = JSON.parse(body); } catch { return resolve({ error: 'Something on port ' + port + ' answered, but not with LibreHardwareMonitor\'s readings.' }); }
        const t = cpuTempFromLhm(j);
        resolve(t ? { ...t } : { error: 'LibreHardwareMonitor is running but shows no CPU temperature. It may need to run as administrator.' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ none: true }));
  });
}
let temp = { none: true }, tempAt = 0, tempBusy = false;
function tempStats() {
  if (!tempBusy && Date.now() - tempAt > 4000) {
    tempBusy = true;
    readLhm().then(t => { temp = t; tempAt = Date.now(); tempBusy = false; });
  }
  return temp.c != null ? { c: temp.c, label: temp.label, cpu: temp.cpu, source: 'LibreHardwareMonitor' } : { c: null, none: !!temp.none, error: temp.error || null, port: LHM_PORT };
}

module.exports = { CPU_TEMP, gpuStats, stopGpu, tempStats, gpuFromLine, cpuTempFromLhm, parseTemp, readLhm, LHM_PORT };
