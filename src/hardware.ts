// What this PC has and how busy it is, for the top bar: CPU %, RAM, graphics chips and their memory, and how much
// each loaded model's process holds. Sampled once a second while TOMLIN runs.
//
// Graphics memory on Windows comes from the system's own counters (typeperf, kept running, one line a second), which
// work for every make of chip; an NVIDIA card is read with nvidia-smi as well, which knows its true total.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { builtIn } from './devices.ts';
import { ccFromName, ccNumber } from './runtimes.ts';

const run = promisify(execFile);

/** Where nvidia-smi is: on PATH, then System32 (newer drivers put it there), then the NVSMI folder older drivers use. */
export const NVIDIA_SMI = [
  'nvidia-smi',
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\nvidia-smi.exe`,
  `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`,
];

/**
 * A card's memory when nvidia-smi cannot be run: Windows' AdapterRAM is 32-bit, so a bigger card reads 4 GB (or just
 * under); a size in its name ("GTX 1060 6GB") is believed over that. Under 4 GB, or no size in the name: as read.
 */
export function totalFromName(name: string, total: number | null): number | null {
  if (total === null || total < 4 * 2 ** 30 - 2 ** 20) return total;
  const m = /(\d+(?:\.\d+)?)\s*GB\b/i.exec(name);
  const named = m ? Number(m[1]) * 2 ** 30 : 0;
  return named > total ? named : total;
}

export interface Gpu {
  name: string;
  /** 'nvidia' cards can use the CUDA builds; every other chip uses Vulkan. */
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  /** Its own memory in bytes, when it has some (an Intel chip built into the processor shares the RAM instead). */
  total: number | null;
  integrated: boolean;
  /**
   * An NVIDIA card's sm level (compute capability 8.6 is 86): from nvidia-smi, else from its name; null when neither
   * says. Which CUDA build suits the card comes from it (src/runtimes.ts cudaOrder).
   */
  cc?: number | null;
  /**
   * An NVIDIA card in compute-only mode (TCC: data-centre cards often are on Windows): CUDA uses it, the Vulkan runner
   * and Windows' graphics readings cannot see it. `smiIndex`: its place in nvidia-smi's list (for nvidia-smi -i).
   */
  tcc?: boolean;
  smiIndex?: number;
}

export interface HardwareInfo {
  cpuName: string;
  cores: number;
  threads: number;
  ram: number;
  gpus: Gpu[];
  /** The NVIDIA driver's version (e.g. "581.57"), from nvidia-smi; null with no NVIDIA card, or when it could not be read. */
  nvidiaDriver?: string | null;
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
  /**
   * busy: how hard the chip is working, 0-100, null when unknown; models: the part of that the loaded models use.
   * unread: Windows gives no readings for the chip (see unreadOf): 'all', or 'busy' when nvidia-smi still gives its memory.
   */
  gpu: { name: string; used: number; total: number | null; shared: boolean; busy: number | null; models: number | null; unread?: 'all' | 'busy' } | null;
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

/**
 * The graphics chips, from readHardware's PowerShell lines ("GPU|name|AdapterRAM|qwMemorySize") and nvidia-smi.
 * AdapterRAM is 32-bit: every card of 4 GB or more reads 4 GB (or 0, when the size wraps). The registry's
 * HardwareInformation.qwMemorySize, read from each present device's own driver key (so a card taken out, whose key stays,
 * never counts), holds the true size for every make; it is believed when larger. An NVIDIA card then takes nvidia-smi's
 * figure, else the size in its name. A chip built into the processor (devices.ts builtIn) has no memory of its own.
 */
export function gpusFrom(cim: string, smi: SmiRow[], caps: (number | null)[], modes: string[] = []): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of cim.split(/\r?\n/)) {
    const [kind, name, adapterRam, registry] = line.trim().split('|');
    if (kind !== 'GPU' || !name || /basic display|basic render|remote display|virtual/i.test(name)) continue;
    const adapter = Number(adapterRam) > 0 ? Number(adapterRam) : null;
    const reg = Number(registry) > 0 ? Number(registry) : null;
    gpus.push({ name, vendor: vendorOf(name), total: reg !== null && reg > (adapter ?? 0) ? reg : adapter, integrated: builtIn(name) });
  }
  // Each card once: two cards of the same make have the same name, so a card already matched is not matched again.
  const matched = new Set<Gpu>();
  const windowsListed = new Set(gpus);
  for (const [k, g] of smi.entries()) {
    const known = gpus.find(x => x.vendor === 'nvidia' && !matched.has(x) && (x.name.includes(g.name) || g.name.includes(x.name)));
    if (known) matched.add(known);
    const cc = caps.length === smi.length ? caps[k] : null;
    const mode = modes.length === smi.length ? { smiIndex: k, ...(modes[k] === 'TCC' ? { tcc: true } : {}) } : {};
    if (known) {
      // "[N/A]" (a TCC or MIG card): what Windows said stands.
      known.total = g.total ?? known.total;
      known.cc = cc;
      Object.assign(known, mode);
    } else gpus.push({ name: g.name, vendor: 'nvidia', total: g.total, integrated: false, cc, ...mode });
  }
  // nvidia-smi answered but did not list a card Windows lists (Code 43, a card the driver gave up on): the runners
  // cannot use it either, so it is not a card here (audit C11).
  if (smi.length) for (const g of [...gpus]) if (g.vendor === 'nvidia' && windowsListed.has(g) && !matched.has(g)) gpus.splice(gpus.indexOf(g), 1);
  // No nvidia-smi answered: a 4 GB-capped report is checked against the size in its name.
  for (const g of gpus) if (g.vendor === 'nvidia' && !matched.has(g)) g.total = totalFromName(g.name, g.total);
  for (const g of gpus) if (g.vendor === 'nvidia') g.cc = g.cc ?? ccFromName(g.name);
  for (const g of gpus) if (g.integrated) g.total = null;
  return gpus;
}

/** The processor's cores, and each graphics chip with its registry memory size from its own driver key (see gpusFrom). */
const VIDEO_PS = [
  'Get-CimInstance Win32_Processor | % { "CPU|$($_.NumberOfCores)" }',
  'Get-CimInstance Win32_VideoController | % { $m = ""; try { $d = (Get-ItemProperty -LiteralPath "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$($_.PNPDeviceID)" -Name Driver -ErrorAction Stop).Driver; '
    + 'if ($d) { $p = Get-ItemProperty -LiteralPath "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\$d" -ErrorAction Stop; $m = $p."HardwareInformation.qwMemorySize"; '
    + 'if (-not $m) { $b = $p."HardwareInformation.MemorySize"; if ($b -is [byte[]]) { $m = [BitConverter]::ToUInt32($b, 0) } else { $m = $b } } } } catch {}; "GPU|$($_.Name)|$($_.AdapterRAM)|$m" }',
].join('; ');

/** What Windows listed at start, kept to read the cards again when nvidia-smi answers late (SmiReader.takeBack). */
let lastCim = '';

/** Read once at start: the processor, RAM and graphics chips. */
export async function readHardware(): Promise<HardwareInfo> {
  const list = cpus();
  const info: HardwareInfo = { cpuName: list[0]?.model.trim() ?? 'Processor', cores: Math.max(1, Math.round(list.length / 2)), threads: list.length, ram: totalmem(), gpus: [] };
  if (process.platform !== 'win32') return info;
  let cim = '';
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', VIDEO_PS], { windowsHide: true, timeout: 20_000 });
    cim = stdout;
    let cores = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const [kind, a] = line.trim().split('|');
      if (kind === 'CPU') cores += Number(a) || 0;
    }
    if (cores) info.cores = cores;
  } catch {
    // keep the guesses from os.cpus()
  }
  lastCim = cim;
  const rows = await smi.rows();
  const caps = rows.length ? await smi.caps() : [];
  const modes = rows.length ? await smi.modes() : [];
  info.nvidiaDriver = rows.find(g => g.driver)?.driver ?? null;
  info.gpus = gpusFrom(cim, rows, caps, modes);
  return info;
}

/** The NVIDIA cards as one: how many, their memory added up. Null when nvidia-smi gave nothing (or only "[N/A]"). */
export function cardsTogether(cards: Array<{ total: number | null; used: number | null }>): { count: number; total: number; used: number } | null {
  const read = cards.filter((c): c is { total: number; used: number | null } => c.total !== null);
  if (!read.length) return null;
  return { count: read.length, total: read.reduce((a, c) => a + c.total, 0), used: read.reduce((a, c) => a + (c.used ?? 0), 0) };
}

/**
 * `fn`, never running twice at once: a call while one is still running is skipped. The once-a-second reading waits on
 * nvidia-smi and tasklist (10 s each at worst), so overlapping ticks would pile up processes.
 */
export function oneAtATime(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

/** The NVIDIA cards' name as one: "RTX 3060", "2 × RTX 3060", or each by name when they differ ("RTX 3090 + GTX 1060"). */
export function cardsName(cards: Array<{ name: string }>): string {
  const count = new Map<string, number>();
  for (const c of cards) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  return [...count].map(([name, n]) => (n > 1 ? `${n} × ${name}` : name)).join(' + ');
}


/** One card as nvidia-smi gives it: memory in bytes, null when it says "[N/A]" (a TCC or MIG card). */
export interface SmiRow {
  name: string;
  total: number | null;
  used: number | null;
  driver: string | null;
}

/** nvidia-smi's answer to the query below: each card's name, memory (MB there, bytes here) and the driver's version. */
export function smiRows(stdout: string): SmiRow[] {
  const mb = (s: string | undefined) => (/^\d+(\.\d+)?$/.test(s ?? '') ? Number(s) * 2 ** 20 : null);
  return stdout.split(/\r?\n/).filter(Boolean).map(l => {
    const [name, total, used, driver] = l.split(',').map(s => s.trim());
    return { name, total: mb(total), used: mb(used), driver: /^\d+(\.\d+)+$/.test(driver ?? '') ? driver : null };
  });
}

/** How long nvidia-smi is left alone after no place answered (an Optimus card asleep, an antivirus holding it). */
export const SMI_RETRY = 60_000;

/**
 * nvidia-smi: found once (one of `places`), then asked every second. When no place answers it is asked again once a
 * minute rather than never (audit C5: one slow answer at start meant no NVIDIA readings all session), and takeBack()
 * says once that it answered after not answering, so the cards are read again.
 */
export class SmiReader {
  /** The place that answered; null while none has. */
  at: string | null = null;
  private failedAt: number | null = null;
  private back = false;
  private ask: (exe: string, args: string[]) => Promise<string>;
  private now: () => number;
  private places: string[];
  constructor(
    ask: (exe: string, args: string[]) => Promise<string> = async (exe, args) => (await run(exe, args, { windowsHide: true, timeout: 10_000 })).stdout,
    now: () => number = Date.now,
    places: string[] = NVIDIA_SMI,
  ) {
    this.ask = ask;
    this.now = now;
    this.places = places;
  }

  async rows(): Promise<SmiRow[]> {
    if (this.at === null && this.failedAt !== null && this.now() - this.failedAt < SMI_RETRY) return [];
    for (const exe of this.at ? [this.at] : this.places) {
      try {
        const out = await this.ask(exe, ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits']);
        if (this.at === null && this.failedAt !== null) this.back = true;
        this.at = exe;
        this.failedAt = null;
        return smiRows(out);
      } catch {
        // the next place, if any
      }
    }
    // No place answered: no NVIDIA card, no driver tool, or one too slow now. One that worked before may answer again.
    if (this.at === null) this.failedAt = this.now();
    return [];
  }

  /** True once after nvidia-smi answers having not answered before. */
  takeBack(): boolean {
    const was = this.back;
    this.back = false;
    return was;
  }

  /**
   * Each NVIDIA card's sm level, in nvidia-smi's order, asked on its own: a driver too old to know compute_cap refuses
   * the whole question, and the memory reading must not go with it. [] when it cannot say.
   */
  /** Each NVIDIA card's driver mode ('WDDM', 'TCC'), in nvidia-smi's order, asked on its own as caps(); [] when it cannot say. */
  async modes(): Promise<string[]> {
    if (!this.at) return [];
    try {
      return (await this.ask(this.at, ['--query-gpu=driver_model.current', '--format=csv,noheader'])).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async caps(): Promise<(number | null)[]> {
    if (!this.at) return [];
    try {
      return (await this.ask(this.at, ['--query-gpu=compute_cap', '--format=csv,noheader'])).split(/\r?\n/).filter(l => l.trim()).map(ccNumber);
    } catch {
      return [];
    }
  }
}
const smi = new SmiReader();

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

/** How long the graphics counters may take to give a first reading before the chip counts as not read at all. */
export const COUNTER_GRACE = 15_000;

/**
 * What Windows cannot read for the chip shown. Nothing while it reports any chip's memory (Task Manager's GPU graph
 * reads the same counters), or while the counters are still starting; else 'all', or 'busy' when nvidia-smi gives the
 * memory. A driver with no counters (an old one, or none) is the usual cause: Task Manager then shows no GPU at all.
 */
export function unreadOf(adapters: number, sinceStart: number, smi: boolean): 'all' | 'busy' | undefined {
  if (adapters > 0 || sinceStart < COUNTER_GRACE) return undefined;
  return smi ? 'busy' : 'all';
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
  private countersStarted = 0;
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
    const tick = oneAtATime(() => this.tick());
    this.timer = setInterval(() => void tick(), 1000);
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
    this.countersStarted = Date.now();
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
      const since = Date.now() - this.countersStarted;
      if (this.nvidia && card.vendor === 'nvidia') {
        // Every NVIDIA card together: a model is split across them, so what fits is what all of them hold.
        const rows = await smi.rows();
        if (smi.takeBack()) {
          // nvidia-smi answered late: the cards' true memory, sm level and the driver, read again in place.
          this.info.gpus.splice(0, Infinity, ...gpusFrom(lastCim, rows, await smi.caps(), await smi.modes()));
          this.info.nvidiaDriver = rows.find(g => g.driver)?.driver ?? null;
        }
        const all = cardsTogether(rows);
        const unread = unreadOf(adapters.size, since, !!all);
        gpu = { name: all ? cardsName(rows) || card.name : card.name, used: all?.used ?? 0, total: all?.total ?? card.total, shared: false, ...work, ...(unread ? { unread } : {}) };
      } else {
        const unread = unreadOf(adapters.size, since, false);
        gpu = card.integrated
          // A chip inside the processor borrows from RAM: Windows lets it take up to half.
          ? { name: card.name, used: best?.shared ?? 0, total: Math.round(totalmem() / 2), shared: true, ...work, ...(unread ? { unread } : {}) }
          : { name: card.name, used: best?.dedicated ?? 0, total: card.total, shared: false, ...work, ...(unread ? { unread } : {}) };
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
