// The scratch pad and the snippet library in the chat's right panel: one free note, and a list of saved prompts or notes
// to put into the message box again (the same in every chat: "Snippets (global)"; each may carry a subject to sort by). Kept in data/notes.json. Only the page reads them: no model sees a note or a
// snippet unless he puts it into the message box himself.
// Plain functions, tested in test/notes.test.ts; the server keeps the file, the page draws it (public/notes.js).
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readData, writeAtomic } from './atomic.ts';

export interface Snippet {
  id: string;
  text: string;
  /** What it is for, typed when it was saved ("blog"); '' for none. Only for sorting and finding it again. */
  subject: string;
  /** When it was saved (ISO). */
  at: string;
}

export interface Notes {
  scratch: string;
  /** Newest first. */
  snippets: Snippet[];
}

export const SCRATCH_MAX = 20_000;
export const SNIPPET_MAX = 4_000;
export const SNIPPETS_MAX = 200;
export const SUBJECT_MAX = 80;

const ID = /^[a-z0-9]{6,24}$/;
const text = (x: unknown) => (typeof x === 'string' ? x.replace(/\r\n?/g, '\n') : '');
const subjectOf = (x: unknown) => text(x).replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX);

/** Whatever was read from the file, made safe to use: unknown fields dropped, sizes kept to their limits. */
export function clean(raw: unknown): Notes {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Notes>;
  const seen = new Set<string>();
  const snippets = (Array.isArray(r.snippets) ? r.snippets : [])
    .map(s => ({ id: String(s?.id ?? ''), text: text(s?.text).trim().slice(0, SNIPPET_MAX), subject: subjectOf(s?.subject), at: String(s?.at ?? '') }))
    .filter(s => ID.test(s.id) && s.text && !seen.has(s.id) && (seen.add(s.id), true))
    .slice(0, SNIPPETS_MAX);
  return { scratch: text(r.scratch).slice(0, SCRATCH_MAX), snippets };
}

export type Change = { ok: true; notes: Notes; id?: string } | { ok: false; error: string };

/** The scratch pad's new words (written whole each time). */
export function setScratch(n: Notes, words: unknown): Change {
  const t = text(words);
  if (t.length > SCRATCH_MAX) return { ok: false, error: `The scratch pad holds up to ${SCRATCH_MAX.toLocaleString('en-GB')} characters, and this is ${t.length.toLocaleString('en-GB')}. Move the rest into a snippet or a file (Files and blog writer), then it saves again.` };
  return { ok: true, notes: { ...n, scratch: t } };
}

/**
 * A new snippet on top. The same words saved again move to the top instead of being kept twice (taking the subject typed
 * this time, when one was).
 */
export function addSnippet(n: Notes, words: unknown, now = new Date(), subject: unknown = ''): Change {
  const t = text(words).trim();
  const sub = subjectOf(subject);
  if (!t) return { ok: false, error: 'Nothing to save: type the prompt or note first, then press Save.' };
  if (t.length > SNIPPET_MAX) return { ok: false, error: `A snippet holds up to ${SNIPPET_MAX.toLocaleString('en-GB')} characters, and this is ${t.length.toLocaleString('en-GB')}. Keep the part you need (the scratch pad holds more), then save again.` };
  const same = n.snippets.find(s => s.text === t);
  const snip = same ? { ...same, subject: sub || same.subject, at: now.toISOString() } : { id: randomBytes(6).toString('hex'), text: t, subject: sub, at: now.toISOString() };
  const rest = n.snippets.filter(s => s.id !== snip.id);
  if (!same && rest.length >= SNIPPETS_MAX) return { ok: false, error: `The library is full (${SNIPPETS_MAX} snippets). Delete one you no longer use, then save again.` };
  return { ok: true, notes: { ...n, snippets: [snip, ...rest] }, id: snip.id };
}

/** Takes a snippet out. Gone already counts as done (two windows open on the same library). */
export function removeSnippet(n: Notes, id: unknown): Change {
  return { ok: true, notes: { ...n, snippets: n.snippets.filter(s => s.id !== id) } };
}

/** Undo of a delete: the snippet back where it was (by its place in the list when it was deleted). */
export function restoreSnippet(n: Notes, raw: unknown, at: unknown): Change {
  const s = clean({ snippets: [raw] }).snippets[0];
  if (!s) return { ok: false, error: 'That snippet cannot be put back: save it again from the scratch pad or the message box.' };
  if (n.snippets.some(x => x.id === s.id)) return { ok: true, notes: n, id: s.id };
  if (n.snippets.length >= SNIPPETS_MAX) return { ok: false, error: `The library is full (${SNIPPETS_MAX} snippets). Delete one you no longer use, then press Undo again.` };
  const place = Math.min(Math.max(0, Number.isInteger(at) ? (at as number) : 0), n.snippets.length);
  const snippets = [...n.snippets];
  snippets.splice(place, 0, s);
  return { ok: true, notes: { ...n, snippets }, id: s.id };
}

/** The file, read once and written whole through a temporary file. */
export class NotesStore {
  private cache: Notes | null = null;
  private file: string;
  constructor(dir: string) {
    this.file = join(dir, 'notes.json');
  }

  async get(): Promise<Notes> {
    if (!this.cache) {
      // Not there: empty. Damaged: set aside and reported (src/atomic.ts), never saved over.
      this.cache = clean(await readData<unknown>(this.file, { scratch: '', snippets: [] }));
    }
    return this.cache;
  }

  async save(n: Notes): Promise<Notes> {
    this.cache = clean(n);
    await writeAtomic(this.file, JSON.stringify(this.cache, null, 1));
    return this.cache;
  }
}
