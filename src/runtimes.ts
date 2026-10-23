// The model runners (runtimes.json): which builds are unpacked, where their server program is, and installing one.
// The chat runner has two CUDA builds (12.4 and 13.4): which one a PC uses is worked out from its NVIDIA cards and the
// code each build carries (cudaOrder); a model can also be held to one of them (RunOptions.runner).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fetchChecked, type Progress } from './download.ts';

const run = promisify(execFile);

export type Engine = 'llama' | 'sd';
export type Device = 'cpu' | 'vulkan' | 'cuda';

/**
 * The GPU code inside a CUDA build, as sm levels (compute capability 8.6 is 86, 12.0 is 120): `native` code made for
 * that level, `ptx` code the NVIDIA driver compiles at the first start, for that level and newer. `driver`: the oldest
 * driver for its native code; `jitDriver`: the oldest that can compile its PTX, when that is newer.
 */
export interface CudaCode {
  version: string;
  native: number[];
  ptx: number[];
  driver: string;
  jitDriver?: string;
}

export interface RuntimePin {
  engine: Engine;
  device: Device;
  name: string;
  licence: string;
  /** CUDA builds of the chat runner: the code inside (unset: any NVIDIA card, the CUDA 12.4 driver rule). */
  cuda?: CudaCode;
  parts: Array<{ url: string; bytes: number; sha256: string }>;
}

const EXE: Record<Engine, string> = { llama: 'llama-server', sd: 'sd-server' };

/** The engine's server program in `base` or one folder inside it. */
function exeIn(base: string, engine: Engine): string | null {
  const name = process.platform === 'win32' ? `${EXE[engine]}.exe` : EXE[engine];
  if (existsSync(join(base, name))) return join(base, name);
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) if (existsSync(join(base, d, name))) return join(base, d, name);
  return null;
}

/** What a downloaded build was unpacked from, kept beside it so a later version knows whether it is still the pinned one. */
export const PIN_FILE = 'pin.json';
export const pinKey = (pin: RuntimePin | undefined): string => JSON.stringify(pin?.parts.map(p => p.sha256) ?? []);

export class Runtimes {
  /** The runners the zip ships (in the app folder). */
  readonly dir: string;
  /** Where downloaded runners go (the home's runtime/), so a new version finds them again. */
  readonly kept: string;
  readonly pins: Record<string, RuntimePin>;
  /**
   * The builds of one kind this PC tries, best first (set once its cards are read: cudaOrder for CUDA). Unset: every
   * pin of that engine and device, in the file's order.
   */
  order: (engine: Engine, device: Device) => string[] = (engine, device) => this.idsOf(engine, device);

  constructor(dir: string, pinsFile: string, kept = dir) {
    this.dir = dir;
    this.kept = kept;
    this.pins = (JSON.parse(readFileSync(pinsFile, 'utf8')) as { runtimes: Record<string, RuntimePin> }).runtimes;
  }

  /** Every pinned build of that engine and device, in the file's order. */
  idsOf(engine: Engine, device: Device): string[] {
    return Object.keys(this.pins).filter(id => this.pins[id].engine === engine && this.pins[id].device === device);
  }

  /**
   * The build that runs `engine` on `device` here: the first of this PC's order that is unpacked, else the first of
   * its order (to name what is missing), else the first pinned of that kind.
   */
  id(engine: Engine, device: Device): string {
    const ids = this.order(engine, device);
    return ids.find(id => this.exePin(id) !== null) ?? ids[0] ?? this.idsOf(engine, device)[0] ?? `${engine}-${device}`;
  }

  /** True when a build in this PC's order for that kind is unpacked (one it cannot use is not counted). */
  usable(engine: Engine, device: Device): boolean {
    return this.order(engine, device).some(id => this.exePin(id) !== null);
  }

  /**
   * The server program of this build, in runtime/<id>/ or one folder inside it; null when it is not unpacked. A kept
   * (downloaded) build counts only when it was unpacked from the files this version pins.
   */
  exePin(id: string, engine: Engine = this.pins[id]?.engine ?? (id.startsWith('sd-') ? 'sd' : 'llama')): string | null {
    const pin = this.pins[id];
    if (!pin) return null;
    if (this.kept !== this.dir) {
      let was = '';
      try {
        was = readFileSync(join(this.kept, id, PIN_FILE), 'utf8');
      } catch {
        // not downloaded here
      }
      const found = was === pinKey(pin) ? exeIn(join(this.kept, id), engine) : null;
      if (found) return found;
    }
    return exeIn(join(this.dir, id), engine);
  }

  exe(engine: Engine, device: Device): string | null {
    return this.exePin(this.id(engine, device), engine);
  }

  installedPin(id: string): boolean {
    return this.exePin(id) !== null;
  }

  installed(engine: Engine, device: Device): boolean {
    return this.exe(engine, device) !== null;
  }

  bytesPin(id: string): number {
    return this.pins[id]?.parts.reduce((n, p) => n + p.bytes, 0) ?? 0;
  }

  bytes(engine: Engine, device: Device): number {
    return this.bytesPin(this.id(engine, device));
  }

  /** Where part k of a build's zips is kept while it is downloaded or sent here (the home's runtime/_downloads). */
  zipOfPin(id: string, k: number): string {
    const part = this.pins[id]?.parts[k];
    if (!part) throw new Error(`There is no part ${k} of the pinned ${id} build.`);
    return join(this.kept, '_downloads', basename(new URL(part.url).pathname));
  }

  zipOf(engine: Engine, device: Device, k: number): string {
    return this.zipOfPin(this.id(engine, device), k);
  }

  /** Every zip of this build is here at its pinned size (checked by SHA-256 when it was downloaded). */
  zipsHerePin(id: string): boolean {
    const pin = this.pins[id];
    if (!pin) return false;
    return pin.parts.every((p, k) => {
      try {
        return statSync(this.zipOfPin(id, k)).size === p.bytes;
      } catch {
        return false;
      }
    });
  }

  zipsHere(engine: Engine, device: Device): boolean {
    return this.zipsHerePin(this.id(engine, device));
  }

  /** Downloads every zip of this build (each checked by SHA-256) and keeps them, not unpacked: gives their paths. */
  async fetchZipsPin(id: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<string[]> {
    const pin = this.pins[id];
    if (!pin) throw new Error(`There is no pinned ${id} build.`);
    const total = pin.parts.reduce((n, p) => n + p.bytes, 0);
    let before = 0;
    const files: string[] = [];
    for (const [k, part] of pin.parts.entries()) {
      const file = this.zipOfPin(id, k);
      await fetchChecked(part.url, file, part.bytes, part.sha256, p => onProgress?.({ got: before + p.got, bytes: total, checking: p.checking }), signal);
      files.push(file);
      before += part.bytes;
    }
    return files;
  }

  fetchZips(engine: Engine, device: Device, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<string[]> {
    return this.fetchZipsPin(this.id(engine, device), onProgress, signal);
  }

  /**
   * Unpacks this build's zips into runtime/<id>/ in the home (emptied first, so nothing of an older build is left),
   * writes what it was unpacked from, then deletes the zips. The zips must already be checked against the pin.
   */
  async unpackPin(id: string, zips: string[]): Promise<void> {
    const pin = this.pins[id];
    if (!pin) throw new Error(`There is no pinned ${id} build.`);
    const target = join(this.kept, id);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    // Windows' own tar unpacks zips; named by full path because Git's tar reads "C:\..." as a remote machine.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    for (const file of zips) await run(tar, ['-x', '-f', file, '-C', target], { windowsHide: true });
    await writeFile(join(target, PIN_FILE), pinKey(pin));
    for (const file of zips) await rm(file, { force: true });
    if (!this.installedPin(id)) throw new Error(`The ${pin.name} download unpacked, but its server program was not inside. The release may have changed shape.`);
  }

  unpack(engine: Engine, device: Device, zips: string[]): Promise<void> {
    return this.unpackPin(this.id(engine, device), zips);
  }

  /** Downloads every part (checked), unpacks them into runtime/<id>/, deletes the zips. */
  async installPin(id: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
    await this.unpackPin(id, await this.fetchZipsPin(id, onProgress, signal));
  }

  install(engine: Engine, device: Device, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
    return this.installPin(this.id(engine, device), onProgress, signal);
  }

  /** Takes a downloaded build away (runtime/<id>/ in the home, and its kept zips); never a runner the app folder ships. */
  async removePin(id: string): Promise<void> {
    if (this.kept === this.dir) throw new Error('A runner in the app folder is taken away by hand, not from here.');
    const pin = this.pins[id];
    await rm(join(this.kept, id), { recursive: true, force: true });
    for (const k of pin?.parts.keys() ?? []) {
      await rm(this.zipOfPin(id, k), { force: true });
      await rm(`${this.zipOfPin(id, k)}.part`, { force: true });
    }
  }

  remove(engine: Engine, device: Device): Promise<void> {
    return this.removePin(this.id(engine, device));
  }
}

/** A chat model's own card runner (RunOptions.runner) and the build each one names. */
export const RUNNER_PINS = { cuda: 'llama-cuda', cuda13: 'llama-cuda13', vulkan: 'llama-vulkan' } as const;
export type RunnerName = keyof typeof RUNNER_PINS;
export const RUNNER_NAMES = Object.keys(RUNNER_PINS) as RunnerName[];
/** The device a runner name starts on. */
export const runnerDevice = (r: RunnerName): Device => (r === 'vulkan' ? 'vulkan' : 'cuda');
/** The runner name of a chat build ('' for one no model is held to, the CPU's). */
export const runnerOfPin = (id: string): RunnerName | '' => RUNNER_NAMES.find(r => RUNNER_PINS[r] === id) ?? '';

/** The NVIDIA driver a CUDA 12.4 build needs on Windows: an older one cannot compile its code for a Pascal card. */
export const CUDA_DRIVER_MIN = '551.61';

/** True when driver version `v` (e.g. "581.57") is `min` or newer, compared part by part as numbers. */
export function driverAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const x = a[k] || 0;
    const y = b[k] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** What the CUDA rules need to know about a graphics chip (src/hardware.ts Gpu). `cc`: its sm level, null when not known. */
export interface GpuFacts {
  name?: string;
  vendor: string;
  integrated: boolean;
  total?: number | null;
  cc?: number | null;
}

/**
 * Why a PC cannot use the `device` runner ('' when it can): a CUDA runner needs an NVIDIA card of its own and a driver
 * new enough (a driver that could not be read is not held against it). `pc` names the PC in the words.
 */
export function runnerWhy(device: Device, gpus: GpuFacts[], driver: string | null, pc = 'This PC'): string {
  if (device !== 'cuda') return '';
  if (!gpus.some(g => g.vendor === 'nvidia' && !g.integrated)) return `"${pc}" has no NVIDIA card of its own, so the CUDA runner cannot help there.`;
  if (driver && !driverAtLeast(driver, CUDA_DRIVER_MIN)) return `"${pc}" has NVIDIA driver ${driver}; the CUDA runner needs ${CUDA_DRIVER_MIN} or newer. Update the driver (from nvidia.com, or Windows Update) on that PC, then try again.`;
  return '';
}

/** A card's sm level from nvidia-smi's compute_cap ("8.6" is 86, "12.0" is 120); null when it is not one. */
export function ccNumber(text: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\.(\d)\s*$/.exec(text ?? '');
  return m ? Number(m[1]) * 10 + Number(m[2]) : null;
}

/**
 * A card's sm level from its name, for when nvidia-smi cannot say (an old driver does not know compute_cap): the common
 * GeForce, Quadro and RTX PRO names. Null when the name says nothing certain.
 */
export function ccFromName(name: string): number | null {
  const n = name.replace(/\s+/g, ' ');
  // Order matters: "RTX 5000 Ada" and "Quadro RTX 5000" are not RTX 50 cards.
  const rules: [RegExp, number][] = [
    [/\bRTX \d{4} Ada\b|\bL40S?\b|\bL4\b/i, 89],
    [/\bQuadro RTX\b|\bTITAN RTX\b/i, 75],
    [/\bRTX PRO \d{4}\b|\bRTX 50[5-9]0\b/i, 120],
    [/\bH100\b|\bH200\b|\bGH200\b/i, 90],
    [/\bRTX 40[5-9]0\b/i, 89],
    [/\bA100\b|\bA30\b/i, 80],
    [/\bRTX 30[5-9]0\b|\bRTX A\d{3,4}\b|\bA10G?\b|\bA40\b|\bA2\b/i, 86],
    [/\bRTX 20[5-8]0\b|\bGTX 16[5-6]0\b|\bQuadro T\d{3,4}\b|\bTesla T4\b|\bT\d{3,4}\b/i, 75],
    [/\bTITAN V\b|\bV100\b|\bGV100\b/i, 70],
    [/\bP100\b/i, 60],
    [/\bGTX 10\d0\b|\bTITAN Xp\b|\bQuadro P\d{3,4}\b|\bTesla P\d+\b|\bMX[1-3]\d0\b|\bGT 1030\b/i, 61],
    [/\bGTX 9\d0\b|\bGTX 7[45]0\b|\bQuadro M\d{3,4}\b|\bTesla M\d+\b|\bTITAN X\b/i, 50],
  ];
  for (const [re, cc] of rules) if (re.test(n)) return cc;
  return null;
}

/** How a CUDA build runs on a card: code made for it ('native'), PTX compiled at the first start ('jit'), no code it can use ('none'), or not known. */
export type CudaFit = 'native' | 'jit' | 'none' | 'unknown';

/**
 * How `pin` runs on a card of sm level `cc`. Code made for an sm level runs on that level and later ones of the same
 * generation (sm_86 on an RTX 40 card's 8.9); PTX runs on its level and every later one, compiled by the driver.
 */
export function codeFor(pin: RuntimePin | undefined, cc: number | null | undefined): CudaFit {
  const c = pin?.cuda;
  if (!c || !cc) return 'unknown';
  if (c.native.some(n => Math.floor(n / 10) === Math.floor(cc / 10) && n <= cc)) return 'native';
  if (c.ptx.some(p => p <= cc)) return 'jit';
  return 'none';
}

/** The card generations by their first sm level, newest first, for plain words. */
const GENERATIONS: [number, string][] = [
  [120, 'an RTX 50 series (Blackwell) card'],
  [100, 'a Blackwell data-centre card'],
  [90, 'a Hopper card'],
  [89, 'an RTX 40 series (Ada) card'],
  [80, 'an RTX 30 series (Ampere) card'],
  [75, 'an RTX 20 or GTX 16 series (Turing) card'],
  [70, 'a Volta card'],
  [60, 'a GTX 10 series (Pascal) card'],
  [50, 'a GTX 750 or GTX 900 series (Maxwell) card'],
];
const generationOf = (cc: number) => GENERATIONS.find(([from]) => cc >= from)?.[1] ?? 'a newer card';
const label = (pin: RuntimePin) => (pin.cuda ? `CUDA ${pin.cuda.version} runner` : 'CUDA runner');

/**
 * Why a PC cannot use the build `pin` ('' when it can). A CUDA build needs an NVIDIA card of its own it has code for,
 * and a driver new enough for that code: its native code's driver when every card it can use has native code, else
 * the driver that compiles its PTX. A driver that could not be read is not held against it. `others`: the other
 * pinned builds, so the words can say which one works there instead.
 */
export function pinWhy(pin: RuntimePin | undefined, gpus: GpuFacts[], driver: string | null, pc = 'This PC', others: RuntimePin[] = []): string {
  if (!pin || pin.device !== 'cuda') return '';
  const c = pin.cuda;
  if (!c) return runnerWhy('cuda', gpus, driver, pc);
  const cards = gpus.filter(g => g.vendor === 'nvidia' && !g.integrated);
  if (!cards.length) return `"${pc}" has no NVIDIA card of its own, so the CUDA runner cannot help there.`;
  const fits = cards.map(g => ({ g, fit: codeFor(pin, g.cc) }));
  const usable = fits.filter(f => f.fit !== 'none');
  if (!usable.length) {
    const lowest = Math.min(...c.native, ...c.ptx);
    const named = cards.length === 1 ? cards[0].name ?? 'its NVIDIA card' : `${cards.length} NVIDIA cards`;
    const instead = others.find(o => o !== pin && o.engine === pin.engine && o.device === 'cuda' && cards.every(g => codeFor(o, g.cc) !== 'none'));
    return `"${pc}" has ${named}, and the ${label(pin)} has no code for ${cards.length === 1 ? 'it' : 'them'}: it needs ${generationOf(lowest)} or newer.${instead ? ` The ${label(instead)} works there instead.` : ''}`;
  }
  const need = usable.every(f => f.fit === 'native') ? c.driver : c.jitDriver ?? c.driver;
  if (driver && !driverAtLeast(driver, need)) return `"${pc}" has NVIDIA driver ${driver}; the ${label(pin)} needs ${need} or newer there. Update the driver (from nvidia.com, or Windows Update) on that PC, then try again.`;
  return '';
}

/**
 * The CUDA builds of `engine` this PC can use (pinWhy says nothing against them), best first. A build with code for
 * every NVIDIA card here comes before one without (Auto spreads a model over every card, and a card with no code stops
 * the start); then code made for the biggest card beats PTX the driver compiles at start; equal, the one listed first
 * in runtimes.json (CUDA 12.4, the build every PC had before).
 */
export function cudaOrder(pins: Record<string, RuntimePin>, engine: Engine, gpus: GpuFacts[], driver: string | null): string[] {
  const ids = Object.keys(pins).filter(id => pins[id].engine === engine && pins[id].device === 'cuda');
  const cards = gpus.filter(g => g.vendor === 'nvidia' && !g.integrated);
  const big = [...cards].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
  const rank = (id: string) => (cards.some(g => codeFor(pins[id], g.cc) === 'none') ? 2 : codeFor(pins[id], big?.cc) === 'native' ? 0 : 1);
  return ids
    .filter(id => !pinWhy(pins[id], gpus, driver))
    .map((id, i) => ({ id, i, r: rank(id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.id);
}

/**
 * What to say when this PC has a graphics card of its own but no runner that can use it, so everything runs on the CPU
 * (an older zip carried only the CPU runners). Empty when a card runner is there, or the PC has no card of its own.
 */
export function missingCardRunner(engine: Engine, gpus: { name: string; integrated: boolean }[], installed: (device: Device) => boolean): string {
  const card = gpus.find(g => !g.integrated);
  if (!card || installed('vulkan') || installed('cuda')) return '';
  return `This PC has ${card.name}, but no runner for it is installed, so this runs on the CPU (much slower). To use the card: close TOMLIN, open a command window in its folder, run npm run fetch -- ${engine}-vulkan, then start it again.`;
}
