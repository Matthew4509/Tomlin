// Finds .gguf models already on this PC: where model apps keep them (LM Studio, also a moved LM Studio folder; Jan;
// GPT4All), then the drives, for a limited time. Used by the Model menu and by tools/find-models.ts.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { listModels } from './llama.ts';

/** Where model apps keep their files by default, plus LM Studio's own setting if its folder was moved. */
export async function knownPlaces(): Promise<string[]> {
  const home = homedir();
  const app = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const places = [
    join(home, '.lmstudio', 'models'),
    join(home, '.cache', 'lm-studio', 'models'),
    join(app, 'Jan', 'data', 'models'),
    join(local, 'nomic.ai', 'GPT4All'),
    join(home, 'models'),
    join(home, 'Downloads'),
  ];
  for (const f of [join(home, '.lmstudio', 'settings.json'), join(home, '.cache', 'lm-studio', 'settings.json')]) {
    try {
      const text = await readFile(f, 'utf8');
      for (const [, v] of text.matchAll(/"[^"]*(?:[Ff]older|[Dd]ir|[Pp]ath)[^"]*"\s*:\s*"([^"]+)"/g)) places.push(JSON.parse(`"${v}"`));
    } catch {
      // no LM Studio, or no setting
    }
  }
  return places;
}

const SKIP = /^(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information|node_modules|\.git|appdata|recovery|perflogs|msocache)$/i;

/** Folders under `dir` (to `depth` levels) that hold a .gguf, until `until`. */
async function scan(dir: string, depth: number, until: number, hits: Set<string>): Promise<void> {
  if (Date.now() > until) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && /\.gguf$/i.test(e.name)) {
      hits.add(dir);
      continue;
    }
    if (!e.isDirectory() || depth <= 0 || SKIP.test(e.name) || (e.name.startsWith('.') && e.name !== '.lmstudio' && e.name !== '.cache')) continue;
    await scan(join(dir, e.name), depth - 1, until, hits);
  }
}

/** The folder to name for a model found in `dir`: a "models" folder up to 3 levels up (LM Studio keeps publisher/model/file.gguf), else `dir`. */
function rootOf(dir: string): string {
  let d = dir;
  for (let i = 0; i <= 3; i++) {
    if (/^models$/i.test(basename(d)) || basename(d) === 'GPT4All') return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return dir;
}

function drives(): string[] {
  if (process.platform !== 'win32') return [homedir()];
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`).filter(d => existsSync(d));
}

export interface FoundFolder {
  dir: string;
  models: Array<{ file: string; bytes: number }>;
}

/** Folders on this PC holding .gguf models, other than `ownDir`, each once. `timedOut`: the drive search stopped early. */
export async function searchModels(ownDir: string, seconds = 60): Promise<{ folders: FoundFolder[]; timedOut: boolean }> {
  const hits = new Set<string>();
  for (const p of await knownPlaces()) if (existsSync(p)) await scan(p, 4, Date.now() + 15_000, hits);
  const until = Date.now() + seconds * 1000;
  for (const d of drives()) await scan(d, 5, until, hits);
  const roots = [...new Set([...hits].map(rootOf))].sort((a, b) => a.length - b.length);
  const inside = (r: string, o: string) => r.toLowerCase().startsWith(o.toLowerCase().replace(/[\\/]$/, '') + (r.includes('\\') ? '\\' : '/'));
  const folders = roots
    .filter((r, i) => !roots.slice(0, i).some(o => inside(r, o)))
    .filter(r => resolve(r).toLowerCase() !== resolve(ownDir).toLowerCase())
    .map(r => ({ dir: r, models: listModels(r) }))
    .filter(f => f.models.length);
  return { folders, timedOut: Date.now() > until };
}
