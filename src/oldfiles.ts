// Files left behind that nothing will finish or use: the ".part" of a model download, a model copy or move, a restore
// point or a runner download that was stopped and never carried on (10 to 200 GB each for a model), and the zips of a
// runner build no pin names any more (about 1.2 GB each). Each sweep looks only in the folders it is given, one level
// deep, at one fixed pattern of name. Run by src/diskcare.ts; tested in test/oldfiles.test.ts.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A part nothing has written to for this long is not being written, and its download or copy is not coming back. */
export const PART_AGE_MS = 7 * 24 * 3600_000;

export interface Swept {
  files: number;
  bytes: number;
  /** The paths removed, for the log. */
  names: string[];
}

/**
 * Removes parts left in `dirs`. May delete: only plain files directly in one of `dirs` (never in a folder inside one)
 * whose name ends with `ending` (".part" unless given), that were not written to for `ageMs` (7 days unless given). A
 * part still being written was written to just now, so it stays. Never throws: a folder or file it cannot read stays.
 */
export async function sweepParts(dirs: string[], o: { ageMs?: number; now?: number; ending?: string } = {}): Promise<Swept> {
  const out: Swept = { files: 0, bytes: 0, names: [] };
  const ending = (o.ending ?? '.part').toLowerCase();
  const age = o.ageMs ?? PART_AGE_MS;
  const now = o.now ?? Date.now();
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    try {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith(ending) || e.name.length <= ending.length) continue;
        const file = join(dir, e.name);
        const s = await stat(file).catch(() => null);
        if (!s?.isFile() || now - s.mtimeMs < age) continue;
        if (await rm(file, { force: true }).then(() => true, () => false)) {
          out.files++;
          out.bytes += s.size;
          out.names.push(file);
        }
      }
    } catch {
      // That folder is left as it is.
    }
  }
  return out;
}

/**
 * Removes the runner zips of builds no pin names any more (runtime/_downloads in the home: a zip is kept there while it
 * is downloaded or sent, and an older version's pins left theirs). `pinned`: the file names every current pin's parts
 * have (Runtimes.downloadNames). May delete: only plain files directly in `dir` whose name, less a ".part" ending, is
 * not one of `pinned` (a current pin's part is left to sweepParts). With no pinned names at all (the pins could not be
 * read) it deletes nothing. Never a folder. Never throws.
 */
export async function sweepUnpinned(dir: string, pinned: string[]): Promise<Swept> {
  const out: Swept = { files: 0, bytes: 0, names: [] };
  if (!pinned.length) return out;
  const keep = new Set(pinned.map(n => n.toLowerCase()));
  try {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile()) continue;
      const name = e.name.toLowerCase();
      if (keep.has(name) || keep.has(name.replace(/\.part$/, ''))) continue;
      const file = join(dir, e.name);
      const s = await stat(file).catch(() => null);
      if (!s?.isFile()) continue;
      if (await rm(file, { force: true }).then(() => true, () => false)) {
        out.files++;
        out.bytes += s.size;
        out.names.push(file);
      }
    }
  } catch {
    // Left as it is.
  }
  return out;
}
