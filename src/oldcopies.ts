// Other copies of TOMLIN in the same parent folder (each version unzips into its own folder, e.g.
// tomlin-2.0.44 beside shelby-2.0.43): their models/ folders are used in place, so a new version does not download
// the same multi-gigabyte files again. Nothing is copied or moved; a copy is known by its package.json name.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The models/ folders of the other copies next to `root`, newest copy first. */
export function otherModelDirs(root: string): string[] {
  const here = resolve(root).toLowerCase();
  const parent = dirname(resolve(root));
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const found: { dir: string; at: number }[] = [];
  for (const n of names) {
    const dir = join(parent, n);
    if (resolve(dir).toLowerCase() === here) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name !== 'tomlin' && pkg.name !== 'shelby') continue; // shelby: copies made before the TOMLIN name
      const models = join(dir, 'models');
      if (statSync(models).isDirectory()) found.push({ dir: models, at: statSync(dir).mtimeMs });
    } catch {
      // Not a copy of TOMLIN.
    }
  }
  return found.sort((a, b) => b.at - a.at).map(f => f.dir);
}

/** Cached for a minute: the Models page and every Connect ask, and a folder listing costs a few disk reads. */
export function cachedOtherModelDirs(root: string): () => string[] {
  let at = 0;
  let dirs: string[] = [];
  return () => {
    if (Date.now() - at > 60_000) {
      dirs = otherModelDirs(root);
      at = Date.now();
    }
    return dirs;
  };
}
