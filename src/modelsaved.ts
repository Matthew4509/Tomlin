// Files a model wrote into a folder, remembered until the person next allows a command there (the run_command gap,
// 27 Nov: a model could save a test file in one answer and run "test" with no card in the next, with Run Allowed; that
// file would run as the person, with the whole PC in reach). Every save TOMLIN makes in the workspace marks the file
// (src/workspace.ts save: a file tool, an agent, a job step, Save on an answer), except what the person types in Files.
// While a coding folder holds marked files, run_command there asks every time, naming them, whatever its tier; the
// person's yes clears that folder's list. Kept in the data folder, so a restart forgets nothing. Plain parts, tested in
// test/modelsaved.test.ts.
import { copyFileSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { writeAtomic } from './atomic.ts';

/** At most this many files are named on a card. */
export const MOST = 500;
/**
 * At most this many files are remembered one by one. Past it a new save marks its folder instead (one entry for all
 * its files), so a full list never lets a save go unmarked; the person's yes in a folder clears both kinds.
 */
export const KEPT = 20_000;
/** A refused write of the list is tried again after this long, until one goes through. */
const RETRY_MS = 5000;
/**
 * The last part of what pending() gives for a folder while the list could not be read at start (see `unsure`): no file
 * on Windows can be called "?", so it is never a real file's name.
 */
const UNKNOWN = '?';

/**
 * The real path: a workspace reached through a junction, a subst drive or a short (8.3) name is the same folder as its
 * real path, so a save marked one way is found when the run asks the other way.
 */
function real(p: string): string {
  const full = resolve(p);
  try {
    return realpathSync.native(full);
  } catch {
    // Not there (yet): the nearest folder that is, with the rest of the path after it.
    const up = dirname(full);
    return up === full ? full : resolve(real(up), basename(full));
  }
}
const key = (p: string) => real(p).replace(/[\\/]+$/, '').toLowerCase();
const inFolder = (file: string, folder: string) => file === folder || file.startsWith(`${folder}${sep}`) || file.startsWith(`${folder}/`);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v: unknown): v is string => typeof v === 'string') : []);

export class ModelSaved {
  private files: Set<string>;
  private file: string | null;
  private writing: Promise<void> = Promise.resolve();
  /**
   * The list was there at start but could not be read (damaged, or held by another program): what a model saved before
   * is not known, so a run in any folder asks first, until the person allows a command in that folder (`sure`).
   */
  private unsure: boolean;
  /** While `unsure`: the folders the person has allowed a command in since. */
  private sure: Set<string>;
  private readonly retryMs: number;
  private retry: ReturnType<typeof setTimeout> | null = null;
  constructor(file: string | null, start: string[] = [], o: { unsure?: boolean; sure?: string[]; retryMs?: number } = {}) {
    this.file = file;
    this.files = new Set(start.map(key));
    this.unsure = !!o.unsure;
    this.sure = new Set((o.sure ?? []).map(key));
    this.retryMs = o.retryMs ?? RETRY_MS;
  }

  /**
   * Read from its file: an empty list when there is none. A file that is there but cannot be read (damaged, or held by
   * another program past a few tries) is set aside beside it under a new name, and every folder asks first (`unsure`).
   */
  static load(file: string, o: { retryMs?: number } = {}): ModelSaved {
    let text: string | null = null;
    let missing = false;
    for (let i = 0; i < 3 && text === null && !missing; i++) {
      try {
        text = readFileSync(file, 'utf8');
      } catch (e) {
        missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        if (!missing && i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    if (missing) return new ModelSaved(file, [], o);
    try {
      const raw = JSON.parse(text ?? '') as { files?: unknown; unsure?: unknown; sure?: unknown } | null;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.files)) throw new Error('not a list');
      return new ModelSaved(file, strings(raw.files).slice(0, KEPT + MOST), { ...o, unsure: raw.unsure === true, sure: strings(raw.sure) });
    } catch {
      try {
        copyFileSync(file, `${file}.unread-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`);
      } catch {
        // Not even a copy could be made: every folder asks all the same.
      }
      const m = new ModelSaved(file, [], { ...o, unsure: true });
      m.keep();
      return m;
    }
  }

  /** A file a model's text was written to (its full path). */
  mark(full: string): void {
    const k = key(full);
    if (this.files.has(k)) return;
    // Full: its folder is marked in its place (a folder already marked covers it).
    const at = this.files.size >= KEPT ? dirname(k) : k;
    if (at !== k && [...this.files].some(x => inFolder(at, x))) return;
    this.files.add(at);
    this.keep();
  }

  /** The marked files inside `folder`, as full paths, at most `most` of them. */
  pending(folder: string, most = MOST): string[] {
    const f = key(folder);
    const unknown = this.unsure && ![...this.sure].some(s => inFolder(f, s)) ? [`${f}${sep}${UNKNOWN}`] : [];
    return [...unknown, ...[...this.files].filter(x => inFolder(x, f))].slice(0, most);
  }

  /** The person allowed a command in `folder`: what a model saved there is theirs to run now. */
  clear(folder: string): void {
    const f = key(folder);
    let gone = false;
    for (const x of [...this.files]) if (inFolder(x, f)) gone = this.files.delete(x) || gone;
    if (this.unsure && !this.sure.has(f)) {
      this.sure.add(f);
      gone = true;
    }
    if (gone) this.keep();
  }

  /**
   * Writes the whole list. A write that is refused (its folder cannot be made, the file is held) is tried again a
   * little later, until one goes through, so a mark is never kept only in memory, to be lost when the app ends.
   */
  private keep(): void {
    if (!this.file) return;
    const file = this.file;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.writing = this.writing.then(async () => {
      // Made when it is written, not when it was asked for: an older list never goes over a newer one.
      const text = `${JSON.stringify({ files: [...this.files], ...(this.unsure ? { unsure: true, sure: [...this.sure] } : {}) })}\n`;
      try {
        await writeAtomic(file, text);
      } catch {
        this.retry ??= setTimeout(() => {
          this.retry = null;
          this.keep();
        }, this.retryMs);
        this.retry.unref?.();
      }
    });
  }

  /** For tests: the last write done. */
  settled(): Promise<void> {
    return this.writing;
  }
}

/** The words for the card: how many files, and the first few by name (relative to the folder). */
export function pendingWhy(files: string[], folder: string): string {
  if (!files.length) return '';
  const f = key(folder);
  const known = files.filter(x => x !== `${f}${sep}${UNKNOWN}`);
  const lost = known.length < files.length ? 'TOMLIN\'s list of the files models saved could not be read when it started, so it cannot tell what a model saved in this folder before, and the command may run it' : '';
  if (!known.length) return lost;
  const names = known.slice(0, 4).map(x => x.slice(f.length + 1).replace(/\\/g, '/') || 'files saved straight into it');
  return `${lost ? `${lost}; ` : ''}a model saved ${known.length} file${known.length === 1 ? '' : 's'} in this folder since you last allowed a command here (${names.join(', ')}${known.length > 4 ? ', …' : ''}), and the command may run ${known.length === 1 ? 'it' : 'them'}`;
}
