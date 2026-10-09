// One safe way to replace a file: write a copy with its own name, flush it to the disk, then swap it in.
// Writes to the same file wait their turn, so two saves at once never share a copy or leave half a file.
// On Windows a virus scanner or the search indexer can hold a file for a moment: the swap tries again before it gives up.
// Reading is as careful: only a file that is not there reads as empty. A file that is there but cannot be read as JSON
// (a power cut, a disk fault) is set aside under a new name and reported, never written over by an empty one.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';

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

/** Writes `data` to `file` whole or not at all. */
export function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  return inTurn(file, () => writeNow(file, data));
}

export interface Damaged {
  /** The file as it was named. */
  file: string;
  /** The name it was set aside under, beside it. */
  keptAs: string;
  at: string;
}

const damagedNow: Damaged[] = [];

/** The files found damaged since the start (or since `clearDamaged`), for the page to say once. */
export const damaged = (): Damaged[] => [...damagedNow];
export const clearDamaged = (): void => void damagedNow.splice(0);

/** Sets a damaged file aside (renamed beside itself), so nothing is ever saved over it. */
async function setAside(file: string): Promise<void> {
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

async function readNow<T>(file: string, fallback: T, leave = false): Promise<T> {
  let text: string;
  for (let i = 1; ; i++) {
    try {
      text = await readFile(file, 'utf8');
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return fallback;
      // Held by a scanner for a moment: try again; still held, the read fails (and nothing is saved over it).
      if (i >= 15 || !BUSY.has(code)) throw e;
      await wait(40 * i);
    }
  }
  try {
    return JSON.parse(text) as T;
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
 */
export function updateData<T>(file: string, fallback: T, change: (now: T) => T | undefined | Promise<T | undefined>, space = 1): Promise<T> {
  return inTurn(file, async () => {
    const now = await readNow(file, fallback);
    const next = await change(now);
    if (next === undefined) return now;
    await writeNow(file, JSON.stringify(next, null, space));
    return next;
  });
}
