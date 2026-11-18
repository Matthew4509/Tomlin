// The action log: one line for every action a model's tool took on this PC, and for every one that was refused
// (bringing a window to the front, a click, a key, a named command, a refused look or git read). A file a day in
// data/action-log, beside data/logs, 30 days kept. A line holds the kind, the window or folder, the action in words,
// how it ended and the time: never text read from a screen, a file's text, a command's output or a chat's words.
// Tested in test/toolkit.test.ts.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Action { kind: string; window: string; action: string; outcome: string }

export const ACTION_KEEP_DAYS = 30;
const MAX_DAY_BYTES = 5 * 2 ** 20;
const NAME = /^(\d{4}-\d{2}-\d{2})\.log$/;
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const one = (s: string, most: number) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, most);

/** Adds a line; a log that cannot be written never stops the app. Older files go when a new day's file starts. */
export function logAction(dir: string, a: Action, now = new Date()): void {
  try {
    const file = join(dir, `${day(now)}.log`);
    let size = -1;
    try {
      size = statSync(file).size;
    } catch {
      mkdirSync(dir, { recursive: true });
      const cutoff = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (ACTION_KEEP_DAYS - 1)));
      for (const f of readdirSync(dir)) {
        const m = NAME.exec(f);
        if (m && m[1] < cutoff) rmSync(join(dir, f), { force: true });
      }
    }
    if (size >= MAX_DAY_BYTES) return;
    appendFileSync(file, `${now.toISOString()}\t${one(a.kind, 20)}\t${one(a.window, 120)}\t${one(a.action, 160)}\t${one(a.outcome, 160)}\n`);
  } catch {
    // nothing to do
  }
}
