// The model runners (runtimes.json): which builds are unpacked, where their server program is, and installing one.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  /** Downloads every part (checked), unpacks them into runtime/<id>/, deletes the zips. */
  async install(engine: Engine, device: Device, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
    const id = this.id(engine, device);
    const pin = this.pins[id];
    if (!pin) throw new Error(`There is no pinned ${id} build.`);
    const target = join(this.kept, id);
    const zips = join(this.kept, '_downloads');
    const total = pin.parts.reduce((n, p) => n + p.bytes, 0);
    let before = 0;
    await mkdir(target, { recursive: true });
    for (const part of pin.parts) {
      const file = join(zips, part.url.split('/').pop()!);
      await fetchChecked(part.url, file, part.bytes, part.sha256, p => onProgress?.({ got: before + p.got, bytes: total, checking: p.checking }), signal);
      // Windows' own tar unpacks zips; named by full path because Git's tar reads "C:\..." as a remote machine.
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      await run(tar, ['-x', '-f', file, '-C', target], { windowsHide: true });
      await rm(file, { force: true });
      before += part.bytes;
    }
    await writeFile(join(target, PIN_FILE), pinKey(pin));
    if (!this.installed(engine, device)) throw new Error(`The ${pin.name} download unpacked, but its server program was not inside. The release may have changed shape.`);
  }
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
