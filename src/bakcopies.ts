// The time-stamped ".bak" copies a model's saves leave in the workspace (src/workspace.ts save, keepOlder): one a save,
// up to 1 MB each, and none was ever removed. Only the newest few of each file are kept. Tested in test/bakcopies.test.ts.
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Time-stamped .bak copies kept for each file: the newest ones. */
export const KEEP_BAKS = 5;

/**
 * Keeps the newest KEEP_BAKS time-stamped copies of `full`. May delete: only files beside it named exactly as save()
 * names them, "<its name>.<14 digits>.bak", the oldest by that time stamp first. Never the file itself, never its plain
 * "<name>.bak", never anything else. Never throws. Gives how many went.
 */
export async function trimBaks(full: string, keep = KEEP_BAKS): Promise<number> {
  try {
    const name = basename(full).toLowerCase();
    const stamped = (await readdir(dirname(full))).filter(n => {
      const l = n.toLowerCase();
      return l.startsWith(`${name}.`) && /^\.\d{14}\.bak$/.test(l.slice(name.length));
    });
    let gone = 0;
    // Newest first: the names differ only in their time stamp (capitals aside).
    stamped.sort((a, b) => b.toLowerCase().localeCompare(a.toLowerCase()));
    for (const n of stamped.slice(keep)) if (await rm(join(dirname(full), n), { force: true }).then(() => true, () => false)) gone++;
    return gone;
  } catch {
    return 0;
  }
}
