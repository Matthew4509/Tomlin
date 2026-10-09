// What this PC has and how busy it is, for the top bar: CPU %, RAM, graphics chips and their memory, and how much
// each loaded model's process holds. Sampled once a second while TOMLIN runs.
//
// Graphics memory on Windows comes from the system's own counters (typeperf, kept running, one line a second), which
// work for every make of chip; an NVIDIA card is read with nvidia-smi as well, which knows its true total.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Gpu {
  name: string;
  /** 'nvidia' cards can use the CUDA builds; every other chip uses Vulkan. */
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  /** Its own memory in bytes, when it has some (an Intel chip built into the processor shares the RAM instead). */
  total: number | null;
  integrated: boolean;
}

export interface HardwareInfo {
  cpuName: string;
  cores: number;
  threads: number;
  ram: number;
  gpus: Gpu[];
}

export interface ProcessUse {
  pid: number;
  /** Memory the process holds in RAM (its working set), bytes. */
  ram: number;
  /** Graphics memory: on the card itself, and borrowed from RAM. */
  gpuDedicated: number;
  gpuShared: number;
}

export interface Snapshot {
  at: number;
  cpu: { percent: number; cores: number; threads: number; name: string };
  ram: { used: number; total: number };
  /** busy: how hard the chip is working, 0-100, null when unknown; models: the part of that the loaded models use. */
  gpu: { name: string; used: number; total: number | null; shared: boolean; busy: number | null; models: number | null } | null;
  processes: Record<number, ProcessUse>;
}

/** The chip a counter instance belongs to, e.g. luid_0x00000000_0x0000bd43 (the same in the memory and engine counters). */
export const chipOf = (instance: string) => /luid_0x[0-9a-f]+_0x[0-9a-f]+/i.exec(instance)?.[0].toLowerCase() ?? null;

/**
 * How busy each graphics chip is, from Windows' per-engine counters, counted the way Task Manager does: each kind of
 * engine (3D, Compute, Copy…) added up over every program, and the busiest kind is the chip's figure. `models` is the
 * same sum over the watched processes only.
 */
export function engineBusy(values: Map<string, number>, pids: number[] = []): Map<string, { all: number; models: number }> {
  const sums = new Map<string, { all: number; models: number }>();
  for (const [col, value] of values) {
    const m = /GPU Engine\(pid_(\d+)_(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_\d+_engtype_([^)]*)\)\\Utilization Percentage/i.exec(col);
    if (!m || !Number.isFinite(value)) continue;
    const key = `${m[2].toLowerCase()}|${m[3]}`;
    const s = sums.get(key) ?? { all: 0, models: 0 };
    s.all += value;
    if (pids.includes(Number(m[1]))) s.models += value;
    sums.set(key, s);
  }
  const chips = new Map<string, { all: number; models: number }>();
  for (const [key, s] of sums) {
    const chip = key.slice(0, key.indexOf('|'));
    const c = chips.get(chip) ?? { all: 0, models: 0 };
    chips.set(chip, { all: Math.max(c.all, s.all), models: Math.max(c.models, s.models) });
  }
  for (const [chip, c] of chips) chips.set(chip, { all: Math.min(100, Math.round(c.all)), models: Math.min(100, Math.round(c.models)) });
  return chips;
}

/** typeperf, one line a second: calls back with each line's values by column name. */
function perf(counters: string[], onValues: (values: Map<string, number>) => void): ChildProcess {
  const tp = spawn('typeperf.exe', [...counters, '-si', '1'], { windowsHide: true });
  let columns: string[] = [];
  let buffer = '';
  tp.stdout.on('data', (b: Buffer) => {
    buffer += b.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const cols = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
      if (cols[0] === '(PDH-CSV 4.0)') columns = cols;
      else if (cols.length === columns.length && cols.length > 1) {
        const values = new Map<string, number>();
        for (let i = 1; i < cols.length; i++) values.set(columns[i], Number(cols[i]) || 0);
        onValues(values);
      }
    }
  });
  tp.on('error', () => undefined);
  return tp;
}

function vendorOf(name: string): Gpu['vendor'] {
  if (/nvidia|quadro|geforce|rtx|gtx|tesla/i.test(name)) return 'nvidia';
  if (/amd|radeon/i.test(name)) return 'amd';
  if (/intel/i.test(name)) return 'intel';
  return 'other';
}

/** Read once at start: the processor, RAM and graphics chips. */
export async function readHardware(): Promise<HardwareInfo> {
  const list = cpus();
  const info: HardwareInfo = { cpuName: list[0]?.model.trim() ?? 'Processor', cores: Math.max(1, Math.round(list.length / 2)), threads: list.length, ram: totalmem(), gpus: [] };
  if (process.platform !== 'win32') return info;
  try {
    const ps = 'Get-CimInstance Win32_Processor | % { "CPU|$($_.NumberOfCores)" }; Get-CimInstance Win32_VideoController | % { "GPU|$($_.Name)|$($_.AdapterRAM)" }';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 });
    let cores = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const [kind, a, b] = line.trim().split('|');
      if (kind === 'CPU') cores += Number(a) || 0;
      if (kind === 'GPU' && a && !/basic display|basic render|remote display|virtual/i.test(a)) {
        const vendor = vendorOf(a);
        info.gpus.push({ name: a, vendor, total: Number(b) > 0 ? Number(b) : null, integrated: vendor === 'intel' && !/arc/i.test(a) });
      }
    }
    if (cores) info.cores = cores;
  } catch {
    // keep the guesses from os.cpus()
  }
  // AdapterRAM stops at 4 GB, so an NVIDIA card's real total comes from nvidia-smi.
  // Each card once: two cards of the same make have the same name, so a card already matched is not matched again.
  const matched = new Set<Gpu>();
  for (const g of await nvidiaCards()) {
    const known = info.gpus.find(x => x.vendor === 'nvidia' && !matched.has(x) && (x.name.includes(g.name) || g.name.includes(x.name)));
    if (known) matched.add(known);
    if (known) known.total = g.total;
    else info.gpus.push({ name: g.name, vendor: 'nvidia', total: g.total, integrated: false });
  }
  for (const g of info.gpus) if (g.integrated) g.total = null;
  return info;
}

/** The NVIDIA cards as one: how many, their memory added up. Null when nvidia-smi gave nothing. */
export function cardsTogether(cards: Array<{ total: number; used: number }>): { count: number; total: number; used: number } | null {
  if (!cards.length) return null;
  return { count: cards.length, total: cards.reduce((a, c) => a + c.total, 0), used: cards.reduce((a, c) => a + c.used, 0) };
}

async function nvidiaCards(): Promise<Array<{ name: string; total: number; used: number }>> {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 10_000 });
    return stdout.split(/\r?\n/).filter(Boolean).map(l => {
      const [name, total, used] = l.split(',').map(s => s.trim());
      return { name, total: Number(total) * 2 ** 20, used: Number(used) * 2 ** 20 };
    });
  } catch {
    return [];
  }
}

/** The last good reading per process: on a busy PC tasklist can time out, and a loaded model then read as 0 MB. */
const lastRam = new Map<number, number>();

/** Working-set memory of each process in `pids`, from tasklist (bytes). A process missing from a slow or failed
 * sample keeps its last good reading. */
async function processRam(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length || process.platform !== 'win32') return out;
  for (const pid of [...lastRam.keys()]) if (!pids.includes(pid)) lastRam.delete(pid);
  try {
    const { stdout } = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000, maxBuffer: 4 << 20 });
    const want = new Set(pids);
    for (const line of stdout.split(/\r?\n/)) {
      const cols = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
      const pid = Number(cols[1]);
      if (want.has(pid)) out.set(pid, Number(cols[4].replace(/[^\d]/g, '')) * 1024);
    }
  } catch {
    // the last good readings below stand in
  }
  for (const pid of pids) {
    const v = out.get(pid);
    if (v) lastRam.set(pid, v);
    else if (lastRam.has(pid)) out.set(pid, lastRam.get(pid)!);
  }
  return out;
}

/** True while a process with this id is still running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Samples once a second. `watch(pids)` names the model processes whose memory the bar shows; the graphics counters
 * are restarted when that list changes (the system's counters only list processes that existed when they started).
 */
export class Sampler {
  info: HardwareInfo;
  latest: Snapshot;
  private lastCpu = cpus().map(c => c.times);
  private pids: number[] = [];
  private typeperf: ChildProcess | null = null;
  private gpuValues = new Map<string, number>();
  private enginePerf: ChildProcess | null = null;
  private engineValues = new Map<string, number>();
  private engineStarted = 0;
  private pidsChanged = 0;
  private timer: NodeJS.Timeout | null = null;
  private nvidia = false;

  constructor(info: HardwareInfo) {
    this.info = info;
    this.nvidia = info.gpus.some(g => g.vendor === 'nvidia');
    this.latest = { at: Date.now(), cpu: { percent: 0, cores: info.cores, threads: info.threads, name: info.cpuName }, ram: { used: totalmem() - freemem(), total: totalmem() }, gpu: null, processes: {} };
  }

  start(): void {
    this.restartCounters();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    process.on('exit', () => {
      this.typeperf?.kill();
      this.enginePerf?.kill();
    });
  }

  watch(pids: number[]): void {
    const next = [...new Set(pids)].sort();
    if (next.join() === this.pids.join()) return;
    this.pids = next;
    this.pidsChanged = Date.now();
    this.restartCounters();
  }

  private restartCounters(): void {
    if (process.platform !== 'win32') return;
    this.typeperf?.kill();
    this.gpuValues.clear();
    const counters = ['\\GPU Adapter Memory(*)\\Dedicated Usage', '\\GPU Adapter Memory(*)\\Shared Usage'];
    for (const pid of this.pids) counters.push(`\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage`, `\\GPU Process Memory(pid_${pid}_*)\\Shared Usage`);
    this.typeperf = perf(counters, values => { this.gpuValues = values; });
    this.restartEngines();
  }

  /**
   * The engine counters list one entry per program that has used the chip, fixed when typeperf starts, so they are
   * started again every 30 s (and a few seconds after a model starts, once it has opened the chip). The last reading
   * stays until the new one arrives.
   */
  private restartEngines(): void {
    if (process.platform !== 'win32') return;
    this.enginePerf?.kill();
    this.engineStarted = Date.now();
    this.enginePerf = perf(['\\GPU Engine(*)\\Utilization Percentage'], values => { this.engineValues = values; });
  }

  private async tick(): Promise<void> {
    const now = cpus().map(c => c.times);
    let busy = 0;
    let all = 0;
    now.forEach((t, i) => {
      const p = this.lastCpu[i] ?? t;
      const idle = t.idle - p.idle;
      const total = t.user - p.user + t.nice - p.nice + t.sys - p.sys + t.irq - p.irq + idle;
      busy += total - idle;
      all += total;
    });
    this.lastCpu = now;

    const since = Date.now() - this.engineStarted;
    if (this.enginePerf && (since > 30_000 || (this.engineStarted - this.pidsChanged < 12_000 && since > 5_000))) this.restartEngines();

    // Graphics: per adapter (the busiest one is the one in use), per watched process.
    const adapters = new Map<string, { dedicated: number; shared: number }>();
    const perPid = new Map<number, { dedicated: number; shared: number }>();
    for (const [col, value] of this.gpuValues) {
      const adapter = /GPU Adapter Memory\((luid_[^)]+)\)\\(Dedicated|Shared) Usage/.exec(col);
      const chip = adapter && chipOf(adapter[1]);
      if (adapter && chip) {
        const a = adapters.get(chip) ?? { dedicated: 0, shared: 0 };
        a[adapter[2] === 'Dedicated' ? 'dedicated' : 'shared'] += value;
        adapters.set(chip, a);
      }
      const proc = /GPU Process Memory\(pid_(\d+)_[^)]*\)\\(Dedicated|Shared) Usage/.exec(col);
      if (proc) {
        const p = perPid.get(Number(proc[1])) ?? { dedicated: 0, shared: 0 };
        p[proc[2] === 'Dedicated' ? 'dedicated' : 'shared'] += value;
        perPid.set(Number(proc[1]), p);
      }
    }
    let gpu: Snapshot['gpu'] = null;
    const card = this.info.gpus.find(g => !g.integrated) ?? this.info.gpus[0];
    if (card) {
      // The chip shown: a card is the one with the most memory of its own; a chip in the processor, the most borrowed.
      const [chip, best] = [...adapters].sort(([, a], [, b]) => (card.integrated ? b.shared - a.shared : b.dedicated - a.dedicated))[0] ?? [];
      const busy = chip && this.engineValues.size ? (engineBusy(this.engineValues, this.pids).get(chip) ?? { all: 0, models: 0 }) : null;
      const work = { busy: busy?.all ?? null, models: busy?.models ?? null };
      if (this.nvidia && card.vendor === 'nvidia') {
        // Every NVIDIA card together: a model is split across them, so what fits is what all of them hold.
        const all = cardsTogether(await nvidiaCards());
        gpu = { name: all ? (all.count > 1 ? `${all.count} × ${card.name}` : card.name) : card.name, used: all?.used ?? 0, total: all?.total ?? card.total, shared: false, ...work };
      } else {
        gpu = card.integrated
          // A chip inside the processor borrows from RAM: Windows lets it take up to half.
          ? { name: card.name, used: best?.shared ?? 0, total: Math.round(totalmem() / 2), shared: true, ...work }
          : { name: card.name, used: best?.dedicated ?? 0, total: card.total, shared: false, ...work };
      }
    }

    const ram = await processRam(this.pids);
    const processes: Record<number, ProcessUse> = {};
    for (const pid of this.pids) {
      const g = perPid.get(pid) ?? { dedicated: 0, shared: 0 };
      processes[pid] = { pid, ram: ram.get(pid) ?? 0, gpuDedicated: g.dedicated, gpuShared: g.shared };
    }
    this.latest = {
      at: Date.now(),
      cpu: { percent: all ? Math.round((busy / all) * 100) : 0, cores: this.info.cores, threads: this.info.threads, name: this.info.cpuName },
      ram: { used: totalmem() - freemem(), total: totalmem() },
      gpu,
      processes,
    };
  }
}
