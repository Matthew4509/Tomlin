// The image and helper models TOMLIN knows (registry/*.json, one file per model): what each needs, where its files go,
// whether they are here, and downloading them. Every file is pinned to one Hugging Face revision (or one release
// asset) and checked by SHA-256 before it is kept; downloads carry on from where they stopped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchChecked, hfUrl } from './download.ts';
import { SPARE } from './modelhome.ts';

export interface RegistryFile {
  role: 'model' | 'diffusion' | 'llm' | 'vae' | 'taesd' | 'lora' | 'onnx' | 'upscaler';
  repo?: string;
  rev?: string;
  path?: string;
  url?: string;
  /** File name on disk, when not the last part of `path`. */
  saveAs?: string;
  /** LoRA name, as the image runner knows it (its file name without the ending). */
  name?: string;
  bytes: number;
  sha256: string;
}

export interface RegistryModel {
  id: string;
  kind: 'image' | 'helper';
  name: string;
  about: string;
  family?: string;
  licence: string;
  nonCommercial?: boolean;
  quant: string;
  minRamGB: number;
  minVramGB: number;
  recommendedModes?: string[];
  native?: number;
  /** The side drawn for Draft, Mid and High (src/quality.ts); left out: from `native`. */
  quality?: { draft?: number; mid?: number; high?: number };
  files: RegistryFile[];
  args?: string[];
  defaults?: { steps: number; cfg: number; sampler: string; scheduler: string; negative: string };
  final?: { steps: number };
  transparent?: boolean;
  transparentPrompt?: string;
}

export interface DownloadState {
  id: string;
  got: number;
  bytes: number;
  checking: boolean;
  error: string | null;
  done: boolean;
}

const GB = 2 ** 30;

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export class Registry {
  readonly models: RegistryModel[];
  /** Where model files go; changed when another folder is chosen (Where models are kept). */
  dir: string;
  /** Added to "not enough free disk space" when another drive has room for `need` bytes (src/modelhome.ts); '' when none. */
  elsewhere: (need: number) => Promise<string> = async () => '';
  /** Why nothing can be downloaded now (the chosen models folder's drive is not there), or ''. */
  noHome: () => string = () => '';
  private downloads = new Map<string, { state: DownloadState; ac: AbortController }>();
  /** models/ folders of other copies of TOMLIN beside this one: a whole file there is used where it is. */
  copies: () => string[] = () => [];

  /** `dir`: where model files go (models/image and models/helpers inside it). */
  constructor(registryDir: string, dir: string) {
    this.dir = dir;
    this.models = readdirSync(registryDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(registryDir, f), 'utf8')) as RegistryModel)
      .sort((a, b) => a.files.reduce((n, f) => n + f.bytes, 0) - b.files.reduce((n, f) => n + f.bytes, 0));
  }

  get(id: string): RegistryModel | undefined {
    return this.models.find(m => m.id === id);
  }

  fileName(f: RegistryFile): string {
    return f.saveAs ?? (f.path ?? f.url ?? '').split('/').pop()!;
  }

  /** Where a file of `model` goes in this copy's own models folder (a download, or a copy from a linked PC). */
  ownPath(model: RegistryModel, f: RegistryFile): string {
    return join(this.dir, ...(f.role === 'lora' ? ['image', 'loras', this.fileName(f)] : [model.kind === 'helper' ? 'helpers' : 'image', this.fileName(f)]));
  }

  /** Where a file of `model` is (or will be). Files shared between models (TAESD) are kept once. */
  filePath(model: RegistryModel, f: RegistryFile): string {
    const rel = f.role === 'lora' ? ['image', 'loras', this.fileName(f)] : [model.kind === 'helper' ? 'helpers' : 'image', this.fileName(f)];
    const own = this.ownPath(model, f);
    if (sizeOf(own) === f.bytes) return own;
    // Only a whole file (the exact size) from another copy; anything else downloads here.
    for (const dir of this.copies()) {
      // A copy keeps TOMLIN's layout (image/...); a folder of loose files has them at the top.
      for (const there of [join(dir, ...rel), join(dir, this.fileName(f))]) if (sizeOf(there) === f.bytes) return there;
    }
    return own;
  }

  bytes(model: RegistryModel): number {
    return model.files.reduce((n, f) => n + f.bytes, 0);
  }

  /** All files here at their full size (their SHA-256 was checked when they were downloaded). */
  installed(model: RegistryModel): boolean {
    return model.files.every(f => {
      try {
        return statSync(this.filePath(model, f)).size === f.bytes;
      } catch {
        return false;
      }
    });
  }

  /** Bytes still to download. */
  missing(model: RegistryModel): number {
    return model.files.reduce((n, f) => {
      const p = this.filePath(model, f);
      if (existsSync(p) && statSync(p).size === f.bytes) return n;
      let part = 0;
      try {
        part = statSync(`${p}.part`).size;
      } catch {
        part = 0;
      }
      return n + f.bytes - part;
    }, 0);
  }

  download(id: string): DownloadState | undefined {
    return this.downloads.get(id)?.state;
  }

  allDownloads(): DownloadState[] {
    return [...this.downloads.values()].map(d => d.state);
  }

  /** Starts downloading every missing file of `id` (checks free disk space first). Progress via download(id). */
  async start(id: string): Promise<DownloadState> {
    const model = this.get(id);
    if (!model) throw new Error(`There is no model ${id}.`);
    const running = this.downloads.get(id);
    if (running && !running.state.done && !running.state.error) return running.state;
    const gone = this.noHome();
    if (gone) throw new Error(gone);
    const need = this.missing(model);
    const fs = await statfs(this.dir).catch(() => null);
    const free = fs ? fs.bavail * fs.bsize : Infinity;
    // `room`: the page offers Free up space with these numbers.
    // SPARE (2 GB) is left free on the drive after it, as every other writer keeps.
    if (need + SPARE > free) throw Object.assign(new Error(`Not enough free disk space: ${model.name} needs ${(need / GB).toFixed(1)} GB more, and the drive has ${(free / GB).toFixed(1)} GB free. Free some space (or delete a model you no longer use), then try again.${await this.elsewhere(need).catch(() => '')}`), { room: { name: model.name, bytes: need, free } });
    const state: DownloadState = { id, got: 0, bytes: this.bytes(model), checking: false, error: null, done: false };
    const ac = new AbortController();
    this.downloads.set(id, { state, ac });
    void (async () => {
      let before = 0;
      try {
        for (const f of model.files) {
          const url = f.url ?? hfUrl(f.repo!, f.rev!, f.path!);
          await fetchChecked(url, this.filePath(model, f), f.bytes, f.sha256, p => {
            state.got = before + p.got;
            state.checking = p.checking;
          }, ac.signal);
          before += f.bytes;
          state.got = before;
        }
        state.done = true;
      } catch (error) {
        state.error = ac.signal.aborted ? 'Stopped. Press Download to carry on from where it stopped.' : (error as Error).message;
      }
    })();
    return state;
  }

  stop(id: string): void {
    this.downloads.get(id)?.ac.abort();
  }
}
