// The model runners (runtimes.json): which builds are unpacked, where their server program is, and installing one.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fetchChecked, type Progress } from './download.ts';

const run = promisify(execFile);

export type Engine = 'llama' | 'sd';
export type Device = 'cpu' | 'vulkan' | 'cuda';

export interface RuntimePin {
  engine: Engine;
  device: Device;
  name: string;
  licence: string;
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

  constructor(dir: string, pinsFile: string, kept = dir) {
    this.dir = dir;
    this.kept = kept;
    this.pins = (JSON.parse(readFileSync(pinsFile, 'utf8')) as { runtimes: Record<string, RuntimePin> }).runtimes;
  }

  id(engine: Engine, device: Device): string {
    return `${engine}-${device}`;
  }

  /**
   * The server program of this build, in runtime/<id>/ or one folder inside it; null when it is not unpacked. A kept
   * (downloaded) build counts only when it was unpacked from the files this version pins.
   */
  exe(engine: Engine, device: Device): string | null {
    const id = this.id(engine, device);
    if (this.kept !== this.dir) {
      let pin = '';
      try {
        pin = readFileSync(join(this.kept, id, PIN_FILE), 'utf8');
      } catch {
        // not downloaded here
      }
      const found = pin === pinKey(this.pins[id]) ? exeIn(join(this.kept, id), engine) : null;
      if (found) return found;
    }
    return exeIn(join(this.dir, id), engine);
  }

  installed(engine: Engine, device: Device): boolean {
    return this.exe(engine, device) !== null;
  }

  bytes(engine: Engine, device: Device): number {
    return this.pins[this.id(engine, device)]?.parts.reduce((n, p) => n + p.bytes, 0) ?? 0;
  }

  /** Where part k of a build's zips is kept while it is downloaded or sent here (the home's runtime/_downloads). */
  zipOf(engine: Engine, device: Device, k: number): string {
    const part = this.pins[this.id(engine, device)]?.parts[k];
    if (!part) throw new Error(`There is no part ${k} of the pinned ${this.id(engine, device)} build.`);
    return join(this.kept, '_downloads', basename(new URL(part.url).pathname));
  }

  /** Every zip of this build is here at its pinned size (checked by SHA-256 when it was downloaded). */
  zipsHere(engine: Engine, device: Device): boolean {
    const pin = this.pins[this.id(engine, device)];
    if (!pin) return false;
    return pin.parts.every((p, k) => {
      try {
        return statSync(this.zipOf(engine, device, k)).size === p.bytes;
      } catch {
        return false;
      }
    });
  }

  /** Downloads every zip of this build (each checked by SHA-256) and keeps them, not unpacked: gives their paths. */
  async fetchZips(engine: Engine, device: Device, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<string[]> {
    const id = this.id(engine, device);
    const pin = this.pins[id];
    if (!pin) throw new Error(`There is no pinned ${id} build.`);
    const total = pin.parts.reduce((n, p) => n + p.bytes, 0);
    let before = 0;
    const files: string[] = [];
    for (const [k, part] of pin.parts.entries()) {
      const file = this.zipOf(engine, device, k);
      await fetchChecked(part.url, file, part.bytes, part.sha256, p => onProgress?.({ got: before + p.got, bytes: total, checking: p.checking }), signal);
      files.push(file);
      before += part.bytes;
    }
    return files;
  }

  /**
   * Unpacks this build's zips into runtime/<id>/ in the home (emptied first, so nothing of an older build is left),
   * writes what it was unpacked from, then deletes the zips. The zips must already be checked against the pin.
   */
  async unpack(engine: Engine, device: Device, zips: string[]): Promise<void> {
    const id = this.id(engine, device);
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
    if (!this.installed(engine, device)) throw new Error(`The ${pin.name} download unpacked, but its server program was not inside. The release may have changed shape.`);
  }

  /** Downloads every part (checked), unpacks them into runtime/<id>/, deletes the zips. */
  async install(engine: Engine, device: Device, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
    await this.unpack(engine, device, await this.fetchZips(engine, device, onProgress, signal));
  }

  /** Takes a downloaded build away (runtime/<id>/ in the home, and its kept zips); never a runner the app folder ships. */
  async remove(engine: Engine, device: Device): Promise<void> {
    if (this.kept === this.dir) throw new Error('A runner in the app folder is taken away by hand, not from here.');
    const pin = this.pins[this.id(engine, device)];
    await rm(join(this.kept, this.id(engine, device)), { recursive: true, force: true });
    for (const k of pin?.parts.keys() ?? []) {
      await rm(this.zipOf(engine, device, k), { force: true });
      await rm(`${this.zipOf(engine, device, k)}.part`, { force: true });
    }
  }
}

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

/**
 * Why a PC cannot use the `device` runner ('' when it can): a CUDA runner needs an NVIDIA card of its own and a driver
 * new enough (a driver that could not be read is not held against it). `pc` names the PC in the words.
 */
export function runnerWhy(device: Device, gpus: { name?: string; vendor: string; integrated: boolean }[], driver: string | null, pc = 'This PC'): string {
  if (device !== 'cuda') return '';
  if (!gpus.some(g => g.vendor === 'nvidia' && !g.integrated)) return `"${pc}" has no NVIDIA card of its own, so the CUDA runner cannot help there.`;
  if (driver && !driverAtLeast(driver, CUDA_DRIVER_MIN)) return `"${pc}" has NVIDIA driver ${driver}; the CUDA runner needs ${CUDA_DRIVER_MIN} or newer. Update the driver (from nvidia.com, or Windows Update) on that PC, then try again.`;
  return '';
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
