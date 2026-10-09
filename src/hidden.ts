// Models hidden on this PC (Nodes and memory, Models on this PC, Hide). A hidden model stays on the disk with its speed
// tests, cannot be deleted while hidden, and linked PCs may still use and copy it when it is ticked to share; it is only
// left out of the lists a model is picked from (hiring, a hire's model, the chat's model) until "Show hidden" is ticked.
// Kept in data/hidden-models.json as a list of model ids (chat models by their id, picture models by theirs).
import { join } from 'node:path';
import { readData, writeAtomic } from './atomic.ts';

/** Ids as saved: strings of a sane length, no repeats, at most 500. */
export function cleanHidden(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300 && !/[\u0000-\u001f\u007f]/.test(x)))].slice(0, 500);
}

export class Hidden {
  private ids = new Set<string>();
  private saving: Promise<void> = Promise.resolve();
  private file: string;
  private constructor(file: string) {
    this.file = file;
  }

  static async load(dir: string): Promise<Hidden> {
    const h = new Hidden(join(dir, 'hidden-models.json'));
    h.ids = new Set(cleanHidden(await readData<unknown>(h.file, [])));
    return h;
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.ids.has(id);
  }

  list(): string[] {
    return [...this.ids];
  }

  /** Hides or shows one model; saved before it returns. */
  async set(id: string, hidden: boolean): Promise<void> {
    if (hidden) this.ids.add(id);
    else this.ids.delete(id);
    const text = JSON.stringify([...this.ids]);
    this.saving = this.saving.then(() => writeAtomic(this.file, text)).catch(() => undefined);
    await this.saving;
  }
}
