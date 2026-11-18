// The project backups a node keeps for its linked PCs ("backups from other PCs/<pc>/projects.git", src/gitstore.ts),
// kept from growing for ever. A linked PC sends its projects by itself every 10 minutes while they change, and before
// this every version of every file stayed: a 50 MB file that changes all day is about 3 GB a day. Now each PC's
// repository keeps its newest KEEP_COMMITS backups, all of them together stay under a cap (the oldest backups across
// every PC go first, never a PC's newest one), and what a stopped send or a bring-back left behind is cleared.
// Run by src/diskcare.ts at the start and once an hour. Tested in test/projectstore.test.ts.
import { readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import * as git from './gitstore.ts';

const GB = 2 ** 30;
/** The most the project backups of all linked PCs together may take on a node: 20 GB ... */
export const STORE_CAP = 20 * GB;
/** ... or a tenth of the drive they are on, when that is less (a 128 GB drive keeps 12.8 GB of them). */
export const STORE_SHARE = 0.1;
/** A file of a backup still coming in that nothing was added to for this long was left by a send that stopped. */
export const INCOMING_AGE_MS = 24 * 3600_000;
/** A file unpacked for a bring-back this long ago is made again when asked, so it goes. */
export const OUT_AGE_MS = 6 * 3600_000;

/** The cap for a drive of `total` bytes (null: not known, the 20 GB stands). */
export const capFor = (total: number | null): number => (total && total > 0 ? Math.min(STORE_CAP, Math.floor(total * STORE_SHARE)) : STORE_CAP);

/** One linked PC's repository as the cap sees it: its kept commits, newest first, and the bytes the newest k+1 of them need. */
export interface Store {
  repo: string;
  commits: { id: string; at: number }[];
  /** need[k]: the bytes of every object the newest k+1 commits reach together. */
  need: number[];
}

/**
 * Which commit is the oldest each repository keeps so that all of them together need at most `cap` bytes: the oldest
 * backup across every PC goes first, and a PC's newest backup always stays (even alone over the cap). Gives, for each
 * repository that must let some go, the id of its oldest kept commit. Pure.
 */
export function capPlan(stores: Store[], cap: number): Map<string, string> {
  const keep = stores.map(s => s.commits.length);
  const total = () => stores.reduce((n, s, i) => n + (keep[i] ? s.need[keep[i] - 1] ?? 0 : 0), 0);
  while (total() > cap) {
    let pick = -1;
    for (let i = 0; i < stores.length; i++) {
      if (keep[i] < 2) continue;
      const at = stores[i].commits[keep[i] - 1].at;
      const best = pick < 0 ? Infinity : stores[pick].commits[keep[pick] - 1].at;
      // Made in the same second: the PC keeping more backups gives one first.
      if (at < best || (at === best && keep[i] > keep[pick])) pick = i;
    }
    if (pick < 0) break;
    keep[pick]--;
  }
  const out = new Map<string, string>();
  stores.forEach((s, i) => { if (keep[i] < s.commits.length) out.set(s.repo, s.commits[keep[i] - 1].id); });
  return out;
}

/** The bytes the newest 1, 2, ... commits of `repo` need together (each object counted once). Throws when one cannot be read. */
export async function needOf(repo: string, commits: git.Commit[]): Promise<number[]> {
  const seen = new Set<string>();
  const need: number[] = [];
  let bytes = 0;
  for (const c of commits) {
    for (const id of await git.reachOf(repo, c, seen)) bytes += await git.objectBytes(repo, id);
    need.push(bytes);
  }
  return need;
}

/**
 * Deletes what a stopped send or a bring-back left in one repository. May delete: only files directly in
 * <repo>/incoming named "<40 hex digits>.part" that nothing was added to for `incomingMs`, and files directly in
 * <repo>/out named "<40 hex digits>" or "<40 hex digits>.part" made more than `outMs` ago (the door makes them again
 * when asked). Never a folder, never anything else, never through a junction or link. Never throws.
 */
export async function clearLeftovers(repo: string, o: { now?: number; incomingMs?: number; outMs?: number } = {}): Promise<{ files: number; bytes: number }> {
  const now = o.now ?? Date.now();
  let files = 0;
  let bytes = 0;
  const sweep = async (dir: string, name: RegExp, age: number) => {
    // A junction or link in its place is never followed.
    if (!(await git.realFolder(dir))) return;
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      if (!name.test(n)) continue;
      const s = await stat(join(dir, n)).catch(() => null);
      if (!s?.isFile() || now - s.mtimeMs < age) continue;
      if (await rm(join(dir, n), { force: true }).then(() => true, () => false)) {
        files++;
        bytes += s.size;
      }
    }
  };
  try {
    await sweep(join(repo, 'incoming'), /^[0-9a-f]{40}\.part$/, o.incomingMs ?? INCOMING_AGE_MS);
    await sweep(join(repo, 'out'), /^[0-9a-f]{40}(\.part)?$/, o.outMs ?? OUT_AGE_MS);
  } catch {
    // A folder that cannot be read is left as it is.
  }
  return { files, bytes };
}

export interface StoreTrim {
  repos: number;
  commits: number;
  objects: number;
  bytes: number;
  /** Left by stopped sends and bring-backs. */
  leftovers: number;
}

/**
 * The project backups under `keptRoot` (each linked PC's "<key>/projects.git") brought within bounds: leftovers cleared,
 * each repository cut to its newest `keep` commits, then the oldest commits across them all let go until they need
 * at most `cap` (capFor the drive unless given). What is deleted is only what clearLeftovers and git.trimRepo name.
 * Never throws.
 */
export async function trimProjectStores(keptRoot: string, o: { keep?: number; cap?: number; now?: number; graceMs?: number } = {}): Promise<StoreTrim> {
  const out: StoreTrim = { repos: 0, commits: 0, objects: 0, bytes: 0, leftovers: 0 };
  try {
    const repos: string[] = [];
    // Only a PC folder and a repository that are real folders here: a junction or link to somewhere else is not swept
    // (src/diskcare.ts leaves such a PC folder alone too).
    for (const k of await readdir(keptRoot, { withFileTypes: true }).catch(() => [])) {
      if (!k.isDirectory()) continue;
      const repo = join(keptRoot, k.name, 'projects.git');
      if ((await git.realFolder(repo)) && (await stat(join(repo, 'HEAD')).then(s => s.isFile(), () => false))) repos.push(repo);
    }
    const add = (t: git.Trimmed) => {
      out.commits += t.commits;
      out.objects += t.objects;
      out.bytes += t.bytes;
    };
    const keep = o.keep ?? git.KEEP_COMMITS;
    const stores: Store[] = [];
    for (const repo of repos) {
      out.repos++;
      const left = await clearLeftovers(repo, { now: o.now });
      out.leftovers += left.files;
      out.bytes += left.bytes;
      add(await git.trimRepo(repo, { keep, now: o.now, graceMs: o.graceMs }));
      try {
        const commits = await git.logOf(repo, keep);
        if (commits.length) stores.push({ repo, commits: commits.map(c => ({ id: c.id, at: c.at })), need: await needOf(repo, commits) });
      } catch {
        // One that cannot be read whole is not counted against the cap, and nothing of it goes.
      }
    }
    const cap = o.cap ?? capFor(await statfs(keptRoot).then(s => s.blocks * s.bsize, () => null));
    for (const [repo, oldest] of capPlan(stores, cap)) add(await git.trimRepo(repo, { keep, oldest, now: o.now, graceMs: o.graceMs }));
  } catch {
    // As above: nothing more this time.
  }
  return out;
}
