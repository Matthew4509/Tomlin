// One line in the log about drive space, at start and every 6 hours: the free and total space of the drive TOMLIN's data
// is on, of the drive the models are on when that is another one, and the size of the weight cache folder (Max mode,
// src/maxlend.ts). A PC that filled its drive (17 Nov 2026) left no line about it, so the host could not tell why. Only
// this line: the low-disk warning is another part. Tested in test/disklog.test.ts.
import { readdir, stat, statfs } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

/** How often the line is written after the first. */
export const DISK_LOG_MS = 6 * 3600_000;
/** The most files counted in the cache folder (it holds a few hundred at most; this stops a runaway count). */
const MAX_FILES = 200_000;

export interface DriveSpace {
  drive: string;
  free: number;
  total: number;
}

/** The drive a folder is on, as Windows writes it ("C:"), or its root otherwise. */
export function driveOf(dir: string): string {
  const root = parse(resolve(dir)).root.replace(/[\\/]+$/, '');
  return /^[A-Za-z]:$/.test(root) ? root.toUpperCase() : root || '/';
}

/** GB in plain words: whole above 10 GB, one decimal under. */
const gb = (n: number) => {
  const g = n / 2 ** 30;
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
};

/** The line: "Disk: C: has 113 GB free of 238 GB; D: (models) has 500 GB free of 931 GB; weight cache 24 GB." */
export function diskWords(o: { data: DriveSpace | null; models?: DriveSpace | null; cache: number | null }): string {
  const one = (x: DriveSpace, label = '') => `${x.drive}${label} has ${gb(x.free)} free of ${gb(x.total)}`;
  const parts = [o.data ? one(o.data) : 'the data drive could not be read'];
  if (o.models && o.models.drive !== o.data?.drive) parts.push(one(o.models, ' (models)'));
  parts.push(o.cache === null ? 'no weight cache' : `weight cache ${gb(o.cache)}`);
  return `Disk: ${parts.join('; ')}.`;
}

/** Free and total space of the drive `dir` is on, or null when it cannot be read. */
export async function spaceOf(dir: string): Promise<DriveSpace | null> {
  try {
    const s = await statfs(dir);
    return { drive: driveOf(dir), free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** The bytes of every file in `dir` and the folders under it; null when the folder is not there. */
export async function folderSize(dir: string): Promise<number | null> {
  let list;
  try {
    list = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  let bytes = 0;
  for (const e of list.slice(0, MAX_FILES)) {
    if (!e.isFile()) continue;
    bytes += await stat(join(e.parentPath, e.name)).then(s => s.size, () => 0);
  }
  return bytes;
}

/** Reads the drives and the cache folder and gives the line. `modelsDir` is asked each time: it can be moved. */
export async function diskLine(o: { dataDir: string; modelsDir: () => string; cacheDir: string }): Promise<string> {
  const data = await spaceOf(o.dataDir);
  const where = o.modelsDir();
  const models = where && driveOf(where) !== driveOf(o.dataDir) ? await spaceOf(where) : null;
  return diskWords({ data, models, cache: await folderSize(o.cacheDir) });
}

/** Writes the line now and every DISK_LOG_MS; the timer does not keep TOMLIN running. Returns a stop. */
export function startDiskLog(o: { dataDir: string; modelsDir: () => string; cacheDir: string; say: (line: string) => void; everyMs?: number; firstMs?: number }): () => void {
  let stopped = false;
  // A reading still under way when it is stopped is not said.
  const once = () => void diskLine(o).then(line => { if (!stopped) o.say(line); }, () => undefined);
  const first = setTimeout(once, o.firstMs ?? 0);
  const every = setInterval(once, o.everyMs ?? DISK_LOG_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
}
