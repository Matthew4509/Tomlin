// A long unattended speed retest on THIS PC, with no TOMLIN page, no link and no PIN: for each run in a plan
// (tools/retest-z820.json) it starts llama-server itself with TOMLIN's own arguments (src/llama.ts chatArgs),
// answers once to warm up (not counted), writes back to back for --seconds, stops it, and goes on to the next.
// Close TOMLIN's chat model first (or quit TOMLIN), so the model is not held in memory twice.
//
// While it runs it keeps a log of the machine:
//   - the PC's make-up at the start: each CPU (name, cores, threads, stepping), each memory module (slot, size, speed)
//     and the total Windows sees, the card (name, driver, power limit);
//   - every 15 s: the card's heat, power, clock and memory (nvidia-smi), and each CPU's heat when LibreHardwareMonitor
//     runs as administrator with its web server on (Options > Remote Web Server, port 8085); Windows gives CPU heat to
//     nothing else;
//   - between runs (so the check costs no speed): hardware faults Windows logged since the start: WHEA-Logger (memory
//     ECC corrections, CPU machine checks, PCIe errors), a sudden restart (Kernel-Power 41) and a blue screen (1001).
//     At the start, the last 30 days of those are listed too.
//   A module the BIOS turned off at start-up is not seen by Windows at all: the RAM count shows it, the fault log does not.
//
//   node tools/retest.ts [--plan tools/retest-z820.json] [--models <folder>[,<folder>]] [--seconds 300]
//        [--only 1,4,7] [--later] [--runner-cuda <llama-server.exe>] [--runner-cpu <llama-server.exe>] [--list]
//   (an installed copy: "<install folder>\tomlin-<version>\runtime\node\node.exe" tools\retest.ts ...)
// --list shows which model files were found and the runs it would make, and runs nothing. --later runs the plan's
// "later" list instead. Everything goes in retest-<time>\ in the folder it is run from: spec.json, runs.jsonl,
// sensors.jsonl, faults.jsonl, one runner log per run, and rows.csv in benchmarks/results.csv's columns.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import { basename, join, resolve } from 'node:path';
import { chatArgs } from '../src/llama.ts';
import { WRITE_PROMPT } from '../src/finderrun.ts';
import { resolveHome } from '../src/keep.ts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

export interface Variant { threads: number; numa?: 'distribute' | 'isolate' }
export interface Run { name: string; file: string; kind: 'gpu' | 'ram' | 'cpu'; ctx: number; think?: boolean; old?: number; oldNote?: string; variants?: Variant[] }

/** Threads 0 = llama.cpp's own choice. Two sockets: NUMA placement and the thread count matter most where RAM is read. */
export const VARIANTS: Record<Run['kind'], Variant[]> = {
  gpu: [{ threads: 0 }],
  ram: [{ threads: 0 }, { threads: 16, numa: 'distribute' }],
  cpu: [{ threads: 0 }, { threads: 16 }, { threads: 32 }, { threads: 16, numa: 'distribute' }, { threads: 32, numa: 'distribute' }],
};

export const variantWords = (v: Variant) => `${v.threads ? `${v.threads} threads` : 'default threads'}${v.numa ? `, --numa ${v.numa}` : ', no NUMA setting'}`;

/** A model file by name in any of the folders (searched two levels down); a split model by its first part. */
export function findModel(file: string, folders: string[]): string {
  const want = file.toLowerCase();
  const stem = want.replace(/\.gguf$/, '');
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let dirLike = false;
      try { dirLike = statSync(p).isDirectory(); } catch { continue; }
      if (dirLike) { if (depth < 2) walk(p, depth + 1); continue; }
      const l = n.toLowerCase();
      if (l === want || l === `${stem}-00001-of-${l.match(/-of-(\d+)\.gguf$/)?.[1] ?? 'x'}.gguf`) hits.unshift(p);
      else if (l.endsWith('.gguf') && l.startsWith(stem)) hits.push(p);
    }
  };
  for (const f of folders) walk(f, 0);
  return hits[0] ?? '';
}

/** Every llama-server.exe under these runtime folders for the card (CUDA builds, newest number first, special builds
 *  such as -experts last) or the CPU. A card build that cannot run on this card is passed over for the next. */
function findRunners(kind: 'cuda' | 'cpu', roots: string[]): string[] {
  const found: string[] = [];
  const rank = (d: string) => (/^llama-cuda\d*$/.test(d) ? Number(d.slice(10) || '1') : -1);
  for (const root of roots) {
    let dirs: string[] = [];
    try { dirs = readdirSync(root).filter(d => d.startsWith(kind === 'cuda' ? 'llama-cuda' : 'llama-cpu')).sort((a, b) => rank(b) - rank(a)); } catch { continue; }
    for (const d of dirs) if (existsSync(join(root, d, 'llama-server.exe'))) found.push(join(root, d, 'llama-server.exe'));
  }
  return [...new Set(found)];
}

/** One PowerShell line's JSON (or null): reading the PC's make-up and the fault log. */
function ps(script: string): unknown {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${script} | ConvertTo-Json -Depth 4 -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  try { return r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { return null; }
}
const list = <T>(x: unknown): T[] => (x == null ? [] : Array.isArray(x) ? x as T[] : [x as T]);

function smi(query: string): string[][] {
  const r = spawnSync('nvidia-smi', [`--query-gpu=${query}`, '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/).map(l => l.split(',').map(s => s.trim())) : [];
}

function spec() {
  const cpus = list<Record<string, unknown>>(ps('Get-CimInstance Win32_Processor | Select-Object SocketDesignation,Name,Description,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,ProcessorId,Status'));
  const dimms = list<Record<string, unknown>>(ps('Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel,DeviceLocator,Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber'));
  const totalGB = dimms.reduce((a, d) => a + Number(d.Capacity ?? 0), 0) / 2 ** 30;
  const seenGB = Number((ps('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory') as number | null) ?? 0) / 2 ** 30;
  const gpus = smi('name,driver_version,power.limit,power.default_limit,memory.total').map(([name, driver, limit, deflimit, mem]) => ({ name, driver, powerLimitW: Number(limit), defaultLimitW: Number(deflimit), memoryMiB: Number(mem) }));
  return { at: new Date().toISOString(), cpus, dimms, modules: dimms.length, modulesGB: Math.round(totalGB), windowsSeesGB: Math.round(seenGB * 10) / 10, gpus };
}

const FAULT_FILTER = `@{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger','Microsoft-Windows-Kernel-Power','Microsoft-Windows-WER-SystemErrorReporting'; StartTime=[datetime]'%T'}`;
export interface Fault { at: string; id: number; source: string; text: string }
/** Hardware faults Windows logged since `since`: all WHEA ones, Kernel-Power 41 (a restart without a shut-down) and 1001 (a blue screen). */
function faultsSince(since: Date): Fault[] {
  const rows = list<{ TimeCreated: string; Id: number; ProviderName: string; Message: string }>(ps(`Get-WinEvent -FilterHashtable ${FAULT_FILTER.replace('%T', since.toISOString())} -ErrorAction SilentlyContinue | Select-Object @{n='TimeCreated';e={$_.TimeCreated.ToString('o')}},Id,ProviderName,Message`));
  return rows.filter(r => /WHEA/.test(r.ProviderName) || (/Kernel-Power/.test(r.ProviderName) && r.Id === 41) || r.Id === 1001)
    .map(r => ({ at: r.TimeCreated, id: r.Id, source: r.ProviderName.replace('Microsoft-Windows-', ''), text: String(r.Message ?? '').replace(/\s+/g, ' ').slice(0, 400) }));
}

// ---- CPU heat from LibreHardwareMonitor: every CPU, not only the first (two sockets) ----
function parseTemp(v: unknown): number | null {
  const m = String(v ?? '').match(/(-?\d+(?:[.,]\d+)?)\s*°\s*([CF])/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return m[2] === 'F' ? (n - 32) * 5 / 9 : n;
}
interface LhmNode { Text?: string; Value?: string; ImageURL?: string; HardwareId?: string; Children?: LhmNode[] }
/** Each CPU's package heat and hottest core, never "Distance to TjMax" (degrees below the limit). */
export function cpuTemps(root: LhmNode): { cpu: string; package: number | null; coreMax: number | null }[] {
  const cpus: LhmNode[] = [];
  (function walk(n: LhmNode) {
    if (/cpu\.png$/i.test(n.ImageURL ?? '') || /^\/(intel|amd)cpu\//i.test(n.HardwareId ?? '')) cpus.push(n);
    else for (const c of n.Children ?? []) walk(c);
  })(root);
  return cpus.map(cpu => {
    let pkg: number | null = null, core: number | null = null;
    (function walk(n: LhmNode) {
      for (const c of n.Children ?? []) {
        if ((c.Children ?? []).length) { walk(c); continue; }
        const t = parseTemp(c.Value), label = (c.Text ?? '').trim();
        if (t == null || /distance|tjmax/i.test(label) || t < 1 || t > 150) continue;
        if (/^CPU Package$/i.test(label)) pkg = t;
        else if (/^(CPU )?Core/i.test(label) && !/average/i.test(label)) core = Math.max(core ?? 0, t);
      }
    })(cpu);
    return { cpu: (cpu.Text ?? '').trim(), package: pkg, coreMax: core };
  });
}
function readLhm(): Promise<ReturnType<typeof cpuTemps> | null> {
  return new Promise(ok => {
    const req = http.get({ host: '127.0.0.1', port: 8085, path: '/data.json', timeout: 1500 }, res => {
      if (res.statusCode !== 200) { res.resume(); return ok(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => (body += d));
      res.on('end', () => { try { ok(cpuTemps(JSON.parse(body))); } catch { ok(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => ok(null));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>(ok => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Answer { n: number; atS: number; firstWordS: number; tps: number; tokens: number }
async function answer(base: string, n: number, think: boolean, maxTokens: number, t0run: number): Promise<Answer | null> {
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20 * 60000),
    body: JSON.stringify({ messages: [{ role: 'user', content: `Run ${n}. ${WRITE_PROMPT}` }], max_tokens: maxTokens, temperature: 0, seed: 42, stream: true, cache_prompt: false, ...(think ? {} : { chat_template_kwargs: { enable_thinking: false } }) }),
  });
  if (!res.ok || !res.body) throw new Error(`llama-server answered ${res.status}`);
  let first = 0, last = 0, pieces = 0, buf = '';
  let timings: { predicted_n?: number; predicted_per_second?: number } = {};
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const j = JSON.parse(line.slice(5));
      const d = j.choices?.[0]?.delta ?? {};
      if ((d.content ?? '') + (d.reasoning_content ?? '')) {
        if (!first) first = performance.now();
        last = performance.now();
        pieces++;
      }
      if (j.timings) timings = j.timings;
    }
  }
  const tokens = timings.predicted_n ?? pieces;
  // The runner's own figure (its decode time only); else first word to last word.
  const tps = timings.predicted_per_second ?? (last > first && tokens > 1 ? (tokens - 1) / ((last - first) / 1000) : 0);
  if (!first || tps <= 0) return null;
  return { n, atS: (t0 - t0run) / 1000, firstWordS: (first - t0) / 1000, tps, tokens };
}

/** Starts llama-server; resolves once /health answers, with its address, a way to stop it, and the log so far. */
async function startServer(runner: string, args: string[], logFile: string) {
  const port = await freePort();
  const i = args.indexOf('--port');
  args[i + 1] = String(port);
  writeFileSync(logFile, `${runner} ${args.join(' ')}\n\n`);
  const proc = spawn(runner, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const keep = (d: Buffer) => { const s = d.toString(); appendFileSync(logFile, s); text = (text + s).slice(-200000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const base = `http://127.0.0.1:${port}`;
  const t0 = performance.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`llama-server stopped while loading (code ${proc.exitCode}). Last lines: ${text.slice(-600).replace(/\s+/g, ' ')}`);
    if (await fetch(`${base}/health`).then(r => r.ok, () => false)) break;
    if (performance.now() - t0 > 30 * 60000) { proc.kill(); throw new Error('not loaded after 30 minutes'); }
    await sleep(1000);
  }
  return {
    base, loadS: (performance.now() - t0) / 1000, log: () => text,
    stop: () => new Promise<void>(ok => { if (proc.exitCode !== null) return ok(); proc.once('exit', () => ok()); proc.kill(); }),
  };
}

/** What the runner said about where the model went: layers on the card, buffer sizes, its build. */
export function placement(log: string): string {
  const off = log.match(/offloaded (\d+)\/(\d+) layers to GPU/);
  const gb = (re: RegExp) => { let t = 0; for (const m of log.matchAll(re)) t += Number(m[1]); return t ? `${(t / 1024).toFixed(1)} GB` : ''; };
  const card = gb(/CUDA\d+ model buffer size\s*=\s*([\d.]+) MiB/g);
  const ram = gb(/CPU(?:_Mapped|_REPACK)? model buffer size\s*=\s*([\d.]+) MiB/g);
  const build = log.match(/\bbuild:?\s+(\d+)/)?.[1];
  return [build ? `b${build}` : '', off ? `${off[1]}/${off[2]} layers offloaded` : '', card ? `${card} on the card` : '', ram ? `${ram} in RAM` : ''].filter(Boolean).join(', ');
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const planFile = resolve(opt('plan', join(import.meta.dirname, 'retest-z820.json')));
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { runs: Run[]; later?: { runs: Run[] } };
  let runs = has('later') ? plan.later?.runs ?? [] : plan.runs;
  const only = opt('only', '').split(',').map(Number).filter(n => n > 0);
  if (only.length) runs = runs.filter((_, i) => only.includes(i + 1));
  const home = resolveHome();
  // TOMLIN's own models folder, its "other folder" (models-folder.txt: LM Studio's, say) and any named here.
  const other = (() => { try { return readFileSync(home.modelsFile, 'utf8').trim(); } catch { return ''; } })();
  const folders = [...opt('models', '').split(',').filter(Boolean), home.models, ...(other ? [other] : []), join(process.cwd(), 'models')];
  const roots = [home.runtime, join(import.meta.dirname, '..', 'runtime'), join(process.cwd(), 'runtime')];
  const runners = { cuda: opt('runner-cuda', '') ? [opt('runner-cuda', '')] : findRunners('cuda', roots), cpu: opt('runner-cpu', '') ? [opt('runner-cpu', '')] : findRunners('cpu', roots) };
  const seconds = Math.max(30, Number(opt('seconds', '300')));
  const maxTokens = 256;

  const found = runs.map(r => ({ ...r, path: findModel(r.file, folders) }));
  console.log(`Plan: ${planFile}\nRunners: card ${runners.cuda || '(none found)'}; CPU ${runners.cpu || '(none found)'}\nModels looked for in: ${folders.join('; ')}\n`);
  let total = 0;
  found.forEach((r, i) => {
    const vs = r.variants ?? VARIANTS[r.kind];
    if (r.path) total += vs.length;
    console.log(`${i + 1}. ${r.name} (${r.kind}, ctx ${r.ctx}): ${r.path ? basename(r.path) : `NOT FOUND (${r.file})`}; ${vs.length} run(s): ${vs.map(variantWords).join(' | ')}`);
  });
  console.log(`\n${total} timed runs of ${seconds} s, plus loading: about ${Math.round(total * (seconds + 150) / 60)} minutes.`);
  if (has('list')) return;

  const dir = join(process.cwd(), `retest-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const started = new Date();
  const machine = spec();
  const past = faultsSince(new Date(Date.now() - 30 * 86400000));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...machine, faultsLast30Days: past }, null, 2));
  console.log(`\nCPUs: ${machine.cpus.map(c => `${c.SocketDesignation}: ${c.Name} (${c.NumberOfCores} cores, ${c.NumberOfLogicalProcessors} threads, ${String(c.Description ?? '').replace(/^.*?(Model \d+ Stepping \d+)$/, '$1')})`).join('; ')}`);
  console.log(`RAM: ${machine.modules} modules, ${machine.modulesGB} GB; Windows sees ${machine.windowsSeesGB} GB`);
  console.log(`Card: ${machine.gpus.map(g => `${g.name}, driver ${g.driver}, power limit ${g.powerLimitW} W of ${g.defaultLimitW} W`).join('; ') || 'none read'}`);
  console.log(`Hardware faults Windows logged in the last 30 days: ${past.length}${past.length ? '' : ' (none)'}`);
  for (const f of past.slice(0, 10)) console.log(`  ${f.at} ${f.source} ${f.id}: ${f.text.slice(0, 160)}`);
  const lhm = await readLhm();
  console.log(lhm?.length ? `CPU heat: ${lhm.map(c => `${c.cpu} ${c.package ?? c.coreMax ?? '?'} °C`).join(', ')}` : 'CPU heat: not read (start LibreHardwareMonitor as administrator with its web server on port 8085 to log it).');

  // The heat log, every 15 s for the whole retest; the run's label goes with each line.
  let now = 'starting';
  const hot = { cpu: 0, gpu: 0 };
  const sensorTimer = setInterval(async () => {
    const g = smi('temperature.gpu,power.draw,clocks.sm,memory.used,clocks_throttle_reasons.active').map(([t, p, c, m, thr]) => ({ c: Number(t), w: Number(p), mhz: Number(c), memMiB: Number(m), throttle: thr }));
    const c = await readLhm();
    for (const x of c ?? []) hot.cpu = Math.max(hot.cpu, x.package ?? x.coreMax ?? 0);
    for (const x of g) hot.gpu = Math.max(hot.gpu, x.c || 0);
    appendFileSync(join(dir, 'sensors.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), run: now, gpu: g, cpu: c })}\n`);
  }, 15000);

  const header = 'chart,series,pc,model,file_gb,device,setup,tokens_per_s,min,max,answers,date,tomlin,notes';
  writeFileSync(join(dir, 'rows.csv'), `${header}\n`);
  const version = (() => { try { return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string; } catch { return ''; } })();
  const cpuName = String(machine.cpus[0]?.Name ?? 'CPU').replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim();
  const make = String(ps('(Get-CimInstance Win32_ComputerSystem).Model') ?? 'PC').replace(/\s+Workstation$/i, '').trim();
  const pcLabel = `${make} (${machine.cpus.length} x ${cpuName}, ${Math.round(machine.windowsSeesGB)} GB)`;
  const short = `${make.replace(/^HP\s+/i, '')} ${machine.cpus.length} x CPU`;
  const card = String(machine.gpus[0]?.name ?? 'card').replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
  let faultMark = started;
  let k = 0;

  try {
    for (const r of found) {
      if (!r.path) continue;
      const choices = r.kind === 'cpu' ? runners.cpu : runners.cuda;
      for (const v of r.variants ?? VARIANTS[r.kind]) {
        k++;
        now = `${k}/${total} ${r.name} ${r.kind} ${variantWords(v)}`;
        console.log(`\n[${new Date().toLocaleTimeString()}] ${now}`);
        if (!choices.length) { console.log('  skipped: no runner for this kind'); continue; }
        hot.cpu = 0; hot.gpu = 0;
        const device = r.kind === 'cpu' ? 'cpu' : 'cuda';
        const args = chatArgs(r.path, 0, device, v.threads, false, { ctx: r.ctx, cache: 'f16', place: 'auto' }, device !== 'cpu');
        if (v.numa) args.push('--numa', v.numa);
        const logFile = join(dir, 'logs', `${String(k).padStart(2, '0')}-${basename(r.path, '.gguf')}-${r.kind}-t${v.threads || 'def'}${v.numa ? `-numa-${v.numa}` : ''}.log`);
        let runner = choices[0];
        const rec: Record<string, unknown> = { k, name: r.name, file: basename(r.path), kind: r.kind, ctx: r.ctx, think: !!r.think, ...v, seconds };
        let server: Awaited<ReturnType<typeof startServer>> | null = null;
        try {
          for (let c = 0; ; c++) {
            runner = choices[c];
            try { server = await startServer(runner, [...args], logFile); break; } catch (e) {
              // "no kernel image is available": this CUDA build has nothing for this card; the next build may.
              if (c + 1 < choices.length && /CUDA error|no kernel image/i.test((e as Error).message)) { console.log(`  ${runner} cannot run on this card; trying ${choices[c + 1]}`); continue; }
              throw e;
            }
          }
          rec.runner = runner;
          rec.loadS = Math.round(server.loadS);
          const t0 = performance.now();
          const warm = await answer(server.base, 0, !!r.think, maxTokens, t0);
          console.log(`  loaded in ${rec.loadS} s; warm-up ${warm ? `${warm.tps.toFixed(2)} tok/s` : 'gave no words'} (not counted)`);
          const got: Answer[] = [];
          const t1 = performance.now();
          for (let n = 1; (performance.now() - t1) / 1000 < seconds; n++) {
            const a = await answer(server.base, n, !!r.think, maxTokens, t1).catch(e => { console.log(`  #${n} failed: ${(e as Error).message}`); return null; });
            if (!a) continue;
            got.push(a);
            console.log(`  #${n} at ${a.atS.toFixed(0)} s: ${a.tps.toFixed(2)} tok/s, first word ${a.firstWordS.toFixed(1)} s`);
          }
          const tps = got.map(a => a.tps);
          const half = Math.max(1, Math.floor(tps.length / 2));
          Object.assign(rec, { answers: got.length, median: r2(median(tps)), min: r2(Math.min(...tps)), max: r2(Math.max(...tps)), firstHalf: r2(median(tps.slice(0, half))), secondHalf: r2(median(tps.slice(half))), placed: placement(server.log()), hotCpuC: hot.cpu || null, hotGpuC: hot.gpu || null, rows: got });
          console.log(`  median ${rec.median} tok/s over ${got.length} answers (old Z820: ${r.old ?? 'not run'}); ${rec.placed}; hottest CPU ${hot.cpu ? `${hot.cpu} °C` : 'not read'}, card ${hot.gpu ? `${hot.gpu} °C` : 'not read'}`);
        } catch (e) {
          rec.error = (e as Error).message;
          console.log(`  failed: ${rec.error}`);
        } finally {
          await server?.stop();
        }
        await sleep(5000);
        const faults = faultsSince(faultMark);
        faultMark = new Date();
        rec.faults = faults.length;
        for (const f of faults) {
          appendFileSync(join(dir, 'faults.jsonl'), `${JSON.stringify({ ...f, run: now })}\n`);
          console.log(`  HARDWARE FAULT logged: ${f.at} ${f.source} ${f.id}: ${f.text.slice(0, 200)}`);
        }
        appendFileSync(join(dir, 'runs.jsonl'), `${JSON.stringify(rec)}\n`);
        if (rec.median !== undefined && !rec.error) {
          const deviceWord = r.kind === 'cpu' ? 'CPU' : r.kind === 'gpu' ? 'GPU' : 'GPU + RAM';
          const series = r.kind === 'cpu' ? `${short} (CPU only)` : `${short} + ${card}`;
          const setup = `${basename(runner, '.exe')} in ${basename(resolve(runner, '..'))}, ${rec.placed || 'no placement line'}, context ${r.ctx}, ${variantWords(v)}${r.think ? ', Think on' : ''}; ${Math.round(seconds / 60)}-minute run by tools/retest.ts on that PC itself`;
          const notes = `measured; first half ${rec.firstHalf}, second half ${rec.secondHalf}; hottest CPU ${hot.cpu ? `${hot.cpu} °C` : 'not read'}, card ${hot.gpu ? `${hot.gpu} °C` : 'not read'}; hardware faults during the run: ${faults.length}; old one-CPU Z820: ${r.old ?? 'not run'}${r.oldNote ? ` (${r.oldNote})` : ''}`;
          const fileGb = r2(statSync(r.path).size / 1e9);
          appendFileSync(join(dir, 'rows.csv'), `${['yes', series, pcLabel, r.name, fileGb, deviceWord, setup, rec.median, rec.min, rec.max, rec.answers, new Date().toISOString().slice(0, 10), version, notes].map(csvCell).join(',')}\n`);
        }
      }
    }
  } finally {
    clearInterval(sensorTimer);
  }
  console.log(`\nDone at ${new Date().toLocaleTimeString()}. Results in ${dir}`);
}

// Run only as the tool itself, not when a test imports it.
if (process.argv[1] && basename(process.argv[1]) === 'retest.ts') await main();
