// One safe way to replace a file: write a copy with its own name, flush it to the disk, then swap it in.
// Writes to the same file wait their turn, so two saves at once never share a copy or leave half a file.
// On Windows a virus scanner or the search indexer can hold a file for a moment: the swap tries again before it gives up.
// Reading is as careful: only a file that is not there reads as empty. A file that is there but cannot be read as JSON
// (a power cut, a disk fault) is set aside under a new name and reported, never written over by an empty one.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const queues = new Map<string, Promise<void>>();
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function swapIn(tmp: string, file: string, tries = 15): Promise<void> {
  // 40 ms, 80 ms, ... about 5 s in all before it gives up.
  for (let i = 1; ; i++) {
    try {
      return await rename(tmp, file);
    } catch (e) {
      if (i >= tries || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await wait(40 * i);
    }
  }
}

async function writeNow(file: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    // flush: the copy is on the disk before the swap, so a power cut never leaves the new name on empty space.
    await writeFile(tmp, data, { flush: true });
    await swapIn(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Runs `job` in `file`'s turn: after every write (or update) of it asked for before, before any asked for after. */
function inTurn<T>(file: string, job: () => Promise<T>): Promise<T> {
  const before = queues.get(file) ?? Promise.resolve();
  const turn = before.then(job);
  // The next one waits for this one, whether it worked or not.
  const settled = turn.then(() => undefined, () => undefined);
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return turn;
}

/**
 * Runs `job` in the turn of `key` (any name, not a file's own path, which writeAtomic takes for itself): for a change
 * that reads and writes more than one file and must never interleave with another of the same kind.
 */
export const inFileTurn = <T>(key: string, job: () => Promise<T>): Promise<T> => inTurn(`turn:${key}`, job);

/** Writes `data` to `file` whole or not at all. */
export function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  return inTurn(file, () => writeNow(file, data));
}

/**
 * The same for a small file written from code that cannot wait (a note made as a runner starts, a mark written as the
 * app ends): a copy written and flushed, then swapped in, so a full disk or a power cut leaves the old file whole, never
 * an empty one. A swap a scanner holds up is tried for about a second. Throws when it could not be written (the copy goes).
 */
export function writeAtomicSync(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { flush: true });
    for (let i = 1; ; i++) {
      try {
        renameSync(tmp, file);
        break;
      } catch (e) {
        if (i >= 8 || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * i);
      }
    }
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing more to do.
    }
    throw e;
  }
}

/** The name of a copy a save writes before it swaps it in: "<file>.<process>-<8 hex>.tmp". */
const HALF_SAVE = /\.(\d+)-[0-9a-f]{8}\.tmp$/;

/**
 * Removes the copies saves left half way under `root` (TOMLIN was ended hard, or the PC lost power, between writing the
 * copy and swapping it in): every one written by another process than this one, in `root` and the folders under it, down
 * to `depth` folders, leaving out `skip` (by folder name) and links. Only one TOMLIN runs per home (src/onecopy.ts), so
 * a copy named with another process is never a save still going on. The file it was for is untouched. Gives how many went.
 */
export async function sweepHalfSaves(root: string, o: { depth?: number; skip?: string[]; pid?: number } = {}): Promise<number> {
  const pid = o.pid ?? process.pid;
  const skip = new Set((o.skip ?? []).map(s => s.toLowerCase()));
  let gone = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of items) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && !skip.has(e.name.toLowerCase())) await walk(full, depth - 1);
        continue;
      }
      const m = e.isFile() ? HALF_SAVE.exec(e.name) : null;
      if (m && Number(m[1]) !== pid && (await rm(full, { force: true }).then(() => true, () => false))) gone++;
    }
  };
  await walk(root, o.depth ?? 4);
  return gone;
}

/** Deletes `file` in its turn: after every write of it asked for before, so a save still being written never puts it back. */
export function removeAtomic(file: string): Promise<void> {
  return inTurn(file, () => rm(file, { force: true }));
}

export interface Damaged {
  /** The file as it was named. */
  file: string;
  /** The name it was set aside under, beside it. */
  keptAs: string;
  at: string;
  /** A good copy has taken its place, so nothing was started without (see `markMended`). */
  mended?: boolean;
}

const damagedNow: Damaged[] = [];

/** The files found damaged since the start (or since `clearDamaged`), for the page to say once. */
export const damaged = (): Damaged[] => [...damagedNow];
export const clearDamaged = (): void => void damagedNow.splice(0);
/** A good copy of `file` has been put back in its place: the page says so, not that it is gone. */
export const markMended = (file: string): void => { for (const d of damagedNow) if (d.file === file) d.mended = true; };

/**
 * Sets a damaged file aside (renamed beside itself, and reported), so nothing is ever saved over it. Also for a file
 * that reads as JSON but is not the shape its reader knows (from another version): call it in the file's turn (inside
 * `updateData`).
 */
export async function setAside(file: string): Promise<void> {
  const keptAs = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(file, keptAs);
  damagedNow.push({ file, keptAs: basename(keptAs), at: new Date().toISOString() });
  console.error(`${file} could not be read and was set aside as ${basename(keptAs)}.`);
}

/** Thrown by `readData(..., { leave: true })` for a file that is there but damaged. */
export class DamagedFile extends Error {
  readonly file: string;
  constructor(file: string) {
    super(`${basename(file)} is damaged and could not be read.`);
    this.file = file;
  }
}

/** How long a read waits for a file another program holds (a backup tool, a scanner, a sync app) before it fails. */
export const HELD_FOR_MS = 30_000;

/**
 * The text of `file`, or null when it is not there. A file held by another program is tried again, 40 ms, 80 ms, ... at
 * most a second apart, for HELD_FOR_MS; still held, the read fails (and nothing is saved over it).
 */
export async function readHeld(file: string): Promise<string | null> {
  const until = Date.now() + HELD_FOR_MS;
  for (let i = 1; ; i++) {
    try {
      return await readFile(file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return null;
      if (!BUSY.has(code) || Date.now() >= until) throw e;
      await wait(Math.min(40 * i, 1000));
    }
  }
}

async function readNow<T>(file: string, fallback: T, leave = false): Promise<T> {
  const text = await readHeld(file);
  if (text === null) return fallback;
  try {
    // A file saved by hand in Notepad or PowerShell can start with a byte-order mark, which JSON.parse refuses: it is skipped.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
  } catch {
    if (leave) throw new DamagedFile(file);
    await setAside(file);
    return fallback;
  }
}

/**
 * Reads a JSON file: `fallback` when it is not there; when it is there but damaged, it is set aside (see `damaged`) and
 * `fallback` comes back. It waits for any write of the file already asked for, so it never reads half a change.
 * `leave`: a damaged file stays where it is and DamagedFile is thrown (a lock must stay shut, not reset to none).
 */
export function readData<T>(file: string, fallback: T, o: { leave?: boolean } = {}): Promise<T> {
  return inTurn(file, () => readNow(file, fallback, o.leave === true));
}

/**
 * Reads, changes and writes a JSON file in one turn, so a change made meanwhile by another caller is never lost.
 * `change` gets what is there now (or `fallback`) and gives back what to save; undefined saves nothing.
 * `leave`: a damaged file stays where it is and DamagedFile is thrown, with `change` not run (the caller has a good copy to mend it from).
 */
export function updateData<T>(file: string, fallback: T, change: (now: T) => T | undefined | Promise<T | undefined>, space = 1, o: { leave?: boolean } = {}): Promise<T> {
  return inTurn(file, async () => {
    const now = await readNow(file, fallback, o.leave === true);
    const next = await change(now);
    if (next === undefined) return now;
    await writeNow(file, JSON.stringify(next, null, space));
    return next;
  });
}
