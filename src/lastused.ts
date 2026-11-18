// When each model on this PC last answered (a chat model) or drew (a picture model), for Free up space (src/cleanup.ts).
// Kept in data/last-used.json as { model id: milliseconds }; a model with no entry has not answered since this was added.
import { join } from 'node:path';
import { readData, writeAtomic } from './atomic.ts';

/** Entries as saved: sane ids, whole positive times, at most 1000. */
export function cleanLastUsed(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, at] of Object.entries(raw as Record<string, unknown>).slice(0, 1000)) {
    if (id.length > 0 && id.length <= 300 && !/[\u0000-\u001f\u007f]/.test(id) && typeof at === 'number' && Number.isFinite(at) && at > 0) out[id] = Math.round(at);
  }
  return out;
}

/** A write is skipped when the saved time is this close: a busy chat answers many times a minute. */
const QUIET = 60_000;

export class LastUsed {
  private at: Record<string, number> = {};
  private saving: Promise<void> = Promise.resolve();
  private file: string;
  private constructor(file: string) {
    this.file = file;
  }

  static async load(dir: string): Promise<LastUsed> {
    const l = new LastUsed(join(dir, 'last-used.json'));
    l.at = cleanLastUsed(await readData<unknown>(l.file, {}));
    return l;
  }

  get(id: string | null | undefined): number | null {
    return (id && this.at[id]) || null;
  }

  /** The model answered (or drew) just now. */
  touch(id: string | null | undefined, now = Date.now()): void {
    if (!id || id.length > 300) return;
    const was = this.at[id];
    if (was && now - was < QUIET) return;
    this.at[id] = now;
    const text = JSON.stringify(this.at);
    this.saving = this.saving.then(() => writeAtomic(this.file, text)).catch(() => undefined);
  }

  /** A deleted model's entry goes with it. */
  forget(id: string): void {
    if (!(id in this.at)) return;
    delete this.at[id];
    const text = JSON.stringify(this.at);
    this.saving = this.saving.then(() => writeAtomic(this.file, text)).catch(() => undefined);
  }

  /** Waits for the last save (tests). */
  async settled(): Promise<void> {
    await this.saving;
  }
}
