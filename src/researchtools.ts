// The research tools that keep a small model honest and on track (Settings, Permissions, Research):
// - find_in_text: the passages of a page opened in this answer, or of a file in the chat's folder, that hold some
//   words, so a long document need not fit in the context.
// - keep_quote: a claim kept with the exact words it rests on. The CODE looks for those words in the source's text;
//   a quote that is not there is refused, so a claim cannot be kept on words the source never said.
// - keep_note / read_notes: working notes kept in a file by the code (the same note twice is kept once), and handed
//   back to the model as the answer goes on, when older tool results are dropped to make room (foldToolTurns).
// - read_document: a Word, Excel, CSV or PDF file in the folder, a part at a time, tables kept as tables.
// - calculate, table_stats: sums done here (src/sums.ts).
// - check_draft: the draft's quoted words are looked for in what was kept and read, and a second model, when there
//   is one, reads the draft against the kept quotes.
// Everything in the folder goes through src/workspace.ts, so nothing outside it is touched, and nothing is run.
// Plain parts, tested in test/researchtools.test.ts.
import { readFile, stat } from 'node:fs/promises';
import type { ToolDef } from './webtools.ts';
import * as ws from './workspace.ts';
import { checkSave } from './rules.ts';
import { pdfPages, MAX_DOC_BYTES } from './docs.ts';
import { csvTable, docxText, officeKind, xlsxSheets, type DocPiece } from './officefiles.ts';
import { calculate, csvRows, parseWhere, tableStats } from './sums.ts';
import { RESEARCH_DIR } from './notetools.ts';

const str = { type: 'string' } as const;
export const RESEARCH_TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'find_in_text', description: 'Find the passages that hold some words, in a page you opened in this answer (give its address) or in a file in the folder you work in (give its path: text, PDF, Word, Excel or CSV). Use it instead of reading a long document part by part.', parameters: { type: 'object', properties: { source: { ...str, description: 'The page\'s address exactly as you opened it, or the file\'s path.' }, query: { ...str, description: 'The words to look for: a phrase, or a few key words.' } }, required: ['source', 'query'] } } },
  { type: 'function', function: { name: 'keep_quote', description: 'Keep a claim with the exact words it rests on. The quote must be copied word for word from the source: it is looked for there, and refused when it is not found. Keep a quote for every fact you will state.', parameters: { type: 'object', properties: { claim: { ...str, description: 'The claim, in one sentence of your own.' }, quote: { ...str, description: 'The exact words from the source, copied, not reworded.' }, source: { ...str, description: 'The page\'s address exactly as you opened it, or the file\'s path.' } }, required: ['claim', 'quote', 'source'] } } },
  { type: 'function', function: { name: 'keep_note', description: 'Keep a short working note for yourself (what you found, what is left to do). Notes are kept in a file and given back to you later in a long answer, when older results have been dropped to save room.', parameters: { type: 'object', properties: { text: { ...str, description: 'The note, a sentence or two.' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'read_notes', description: 'Read your working notes and the quotes kept so far.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_document', description: 'Read a Word (.docx), Excel (.xlsx), CSV or PDF file in the folder you work in, a part at a time. Tables are kept as rows, cells parted by " | ". A PDF is read by page, an Excel file by sheet.', parameters: { type: 'object', properties: { path: { ...str, description: 'The file\'s path in the folder.' }, part: { type: 'integer', description: 'Which part to read, 1 the first.' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'calculate', description: 'Work out a sum exactly. Never do arithmetic or count days in your head: use this. Examples: (1250 * 0.2) + 40; round(17 / 3, 2); days(2026-01-05, 2026-03-01); add_days(2026-11-10, 45); weekday(2026-11-10).', parameters: { type: 'object', properties: { expression: { ...str, description: 'The sum. Dates are written 2026-11-10. No commas inside a number.' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'table_stats', description: 'Count, total and average the columns of a table: a CSV or Excel file in the folder (give its path), or CSV text you give. The first row is the headings. Never add up a column yourself: use this.', parameters: { type: 'object', properties: { path: { ...str, description: 'A CSV or Excel file in the folder.' }, text: { ...str, description: 'Or the table as CSV text.' }, sheet: { ...str, description: 'For an Excel file with more than one sheet: the sheet\'s name.' }, column: { ...str, description: 'Only this column (its heading).' }, where: { ...str, description: 'Only the rows that pass one test, like: Region = North, or: Total >= 100.' } } } } },
  { type: 'function', function: { name: 'check_draft', description: 'Before you give a researched answer, have its draft checked: the words it quotes are looked for in what you read, and a second model reads it against the quotes you kept. Mend what it finds, or say plainly what could not be supported.', parameters: { type: 'object', properties: { draft: { ...str, description: 'The whole answer you mean to give.' } }, required: ['draft'] } } },
];
const NAMES = new Set(RESEARCH_TOOLS.map(t => t.function.name));
export const isResearchTool = (name: string) => NAMES.has(name);
/** The ones that read or write in the chat's folder: not offered to a chat with no folder. */
const NEEDS_FOLDER = new Set(['read_document']);
/** The ones that need no card: they only work something out, or read back what this answer itself kept. */
export const researchFree = (name: string) => name === 'calculate' || name === 'read_notes';
/** The ones that read a file in the folder (asked as Files is), by what was asked. */
export function researchReadsFile(name: string, args: string): boolean {
  if (name === 'read_document') return true;
  const a = argsOf(args);
  if (name === 'table_stats') return typeof a.path === 'string' && !!a.path.trim();
  return (name === 'find_in_text' || name === 'keep_quote') && typeof a.source === 'string' && !/^https?:\/\//i.test(a.source.trim());
}
export const researchDefs = (o: { folder: boolean }): ToolDef[] => RESEARCH_TOOLS.filter(t => o.folder || !NEEDS_FOLDER.has(t.function.name));

export const RESEARCH_LINE = 'For research you have tools that keep you right. Keep a quote (keep_quote) for every fact you state: it is checked against the source, and a quote that is not there is refused, so copy the words exactly. Find a passage in a long page or file with find_in_text instead of reading it all. Keep short working notes (keep_note): in a long answer older results are dropped and your notes are what you are given back. Use calculate and table_stats for every sum, count of days or total. Have the draft checked (check_draft) before you answer. State nothing as fact that you have no kept quote for: say it is not checked.';

export const NOTE_CHARS = 600;
export const NOTES_MOST = 80;
export const QUOTE_MIN = 12;
export const QUOTE_MAX = 600;
export const QUOTES_MOST = 60;
export const PASSAGES_MOST = 5;
export const NOTES_FILE = `${RESEARCH_DIR}/working-notes.md`;
export const QUOTES_FILE = `${RESEARCH_DIR}/quotes.md`;

export function researchCallWords(name: string, args: string): string {
  const a = argsOf(args);
  const src = typeof a.source === 'string' ? a.source.slice(0, 80) : typeof a.path === 'string' ? a.path.slice(0, 80) : '';
  if (name === 'find_in_text') return `Looking in ${src || 'a source'}…`;
  if (name === 'keep_quote') return `Checking a quote against ${src || 'its source'}…`;
  if (name === 'keep_note') return 'Keeping a note…';
  if (name === 'read_notes') return 'Reading the notes…';
  if (name === 'read_document') return `Reading ${src || 'a document'}…`;
  if (name === 'calculate') return 'Working out a sum…';
  if (name === 'table_stats') return `Adding up ${src || 'a table'}…`;
  return 'Having the draft checked…';
}

function argsOf(raw: string): Record<string, unknown> {
  try {
    const a = JSON.parse(raw || '{}') as unknown;
    return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Text made the same for matching: lower case, curly quotes and long dashes as plain ones, soft hyphens out, a word
 * broken over a line end joined, every run of spaces one space. A quote is looked for in this form, so a copy that
 * differs only in spacing or in the kind of quote mark still counts, and a reworded one does not.
 */
export function plainText(s: string): string {
  return s.normalize('NFKC').replace(/­/g, '').replace(/[‘’‚′]/g, '\'').replace(/[“”„″]/g, '"').replace(/[‐-―−]/g, '-').replace(/(\p{L})-\n(\p{L})/gu, '$1$2').replace(/\s+/g, ' ').trim().toLowerCase();
}

const WORD = /[\p{L}\p{N}]{3,}/gu;
const wordsOf = (s: string): string[] => [...new Set(plainText(s).match(WORD) ?? [])];

export interface Passage { piece: string; at: number; text: string; exact: boolean; hits: number }

/**
 * The passages of some pieces of text that hold a query: the places the whole phrase stands first, then the windows
 * holding the most of its words. Each passage is about `size` characters, cut at spaces.
 */
export function findPassages(pieces: DocPiece[], query: string, size = 500, most = PASSAGES_MOST): Passage[] {
  const phrase = plainText(query);
  const want = wordsOf(query);
  if (!phrase) return [];
  const out: Passage[] = [];
  const taken: Array<{ piece: string; from: number; to: number }> = [];
  const add = (p: DocPiece, mid: number, exact: boolean, hits: number) => {
    let from = Math.max(0, mid - Math.floor(size / 2));
    let to = Math.min(p.text.length, from + size);
    if (taken.some(t => t.piece === p.label && from < t.to && to > t.from)) return;
    while (from > 0 && from > mid - size && /\S/.test(p.text[from - 1])) from--;
    while (to < p.text.length && to < from + size + 40 && /\S/.test(p.text[to])) to++;
    taken.push({ piece: p.label, from, to });
    out.push({ piece: p.label, at: from, text: `${from > 0 ? '…' : ''}${p.text.slice(from, to).trim()}${to < p.text.length ? '…' : ''}`, exact, hits });
  };
  // The whole phrase, where it stands (found in the same plain form a quote is checked in).
  for (const p of pieces) {
    const low = p.text.toLowerCase();
    const first = phrase.split(' ')[0];
    for (let i = low.indexOf(first); i >= 0 && out.length < most; i = low.indexOf(first, i + 1)) {
      if (plainText(p.text.slice(i, i + phrase.length + 40)).startsWith(phrase)) add(p, i + Math.floor(phrase.length / 2), true, want.length);
    }
  }
  if (out.length >= most || !want.length) return out.slice(0, most);
  // Then the windows that hold the most of its words.
  const scored: Array<{ p: DocPiece; mid: number; hits: number }> = [];
  for (const p of pieces) {
    const low = p.text.toLowerCase();
    for (let from = 0; from < low.length; from += Math.floor(size / 2)) {
      const win = low.slice(from, from + size);
      const hits = want.filter(w => win.includes(w)).length;
      if (hits) scored.push({ p, mid: from + Math.floor(size / 2), hits });
    }
  }
  scored.sort((a, b) => b.hits - a.hits);
  for (const s of scored) {
    if (out.length >= most) break;
    // A single common word of several is not a find.
    if (s.hits < Math.min(want.length, 2) && want.length > 1) break;
    add(s.p, s.mid, false, s.hits);
  }
  return out;
}

/** Where a quote stands in some pieces of text (the piece it is in), or null when its words are not there. */
export function quoteIn(pieces: DocPiece[], quote: string): { piece: string } | null {
  const q = plainText(quote);
  if (!q) return null;
  for (const p of pieces) if (plainText(p.text).includes(q)) return { piece: p.label };
  // A quote that runs over the join of two pieces (a page break) is looked for in each pair.
  for (let i = 0; i + 1 < pieces.length; i++) if (plainText(`${pieces[i].text}\n${pieces[i + 1].text}`).includes(q)) return { piece: pieces[i].label };
  return null;
}

/** The passages a draft puts in quote marks, 20 characters or more: the words it says someone wrote. */
export function quotedIn(draft: string): string[] {
  const out: string[] = [];
  for (const m of draft.matchAll(/["“]([^"“”\n]{20,600})["”]/g)) out.push(m[1].trim());
  return [...new Set(out)];
}

export interface KeptQuote { n: number; claim: string; quote: string; source: string; place: string }
export interface ResearchUse { name: string; input: string; ok: boolean; said: string }
export interface PageSeen { url: string; title: string; text: string }

export interface ResearchTurnOpts {
  /** The chat's folder, when it has one: notes and quotes are kept in its research folder, files are read from it. */
  root: string | null;
  /** Characters one call may give the model. */
  perCall: number;
  /** A page this answer opened, by its address as the model gives it. Null: not opened. */
  page?: (url: string) => PageSeen | null;
  /** A second model's reading of a draft on a node that is free now, or null when none is. */
  second?: (system: string, user: string, signal?: AbortSignal) => Promise<{ text: string; by: string } | null>;
  /** The person's answer to "allow a subagent?" (the Subagent permission). None: allowed. */
  allowSecond?: () => Promise<boolean>;
  /** With no node free, the check may be queued to run on this PC after the answer is written (afterAnswer). */
  canQueue?: boolean;
  today?: () => Date;
}

export const CHECK_SYSTEM = 'You check a draft answer against the quotes it rests on. You are given the quotes (each with its source) and the draft. List every statement of fact in the draft that the quotes do not support: write the statement, then why (not in the quotes, or the quote says something else). Judge only from the quotes given: what you know yourself does not count. Do not rewrite the draft. If every statement of fact is supported, reply with the two words ALL SUPPORTED.';

/** One answer's research tools: the quotes kept, the notes kept, the documents read. */
export class ResearchTurn {
  readonly uses: ResearchUse[] = [];
  readonly quotes: KeptQuote[] = [];
  /** The notes, oldest first: those in the folder's file from earlier answers, then this answer's. */
  notes: string[] = [];
  /** Files this answer changed (the notes and the quotes), for the line under the answer. */
  readonly saved = new Set<string>();
  private loaded = false;
  /** A subagent was allowed but no node was free: the finished answer is to be read on this PC (afterAnswer). */
  private queued = false;
  private readonly docs = new Map<string, DocPiece[] | { error: string }>();
  private readonly o: ResearchTurnOpts;

  constructor(o: ResearchTurnOpts) {
    this.o = { ...o, perCall: Math.max(600, o.perCall) };
  }

  /** The notes kept in the folder by earlier answers, read once. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.o.root) return;
    const was = await ws.read(this.o.root, NOTES_FILE);
    if (!('error' in was)) this.notes = was.text.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()).filter(Boolean).slice(-NOTES_MOST);
  }

  /** A file in the folder as pieces of text (a PDF's pages, an Excel file's sheets, anything else whole). Read once an answer. */
  private async file(path: string): Promise<DocPiece[] | { error: string }> {
    const had = this.docs.get(path);
    if (had) return had;
    const got = await this.readFile(path);
    this.docs.set(path, got);
    return got;
  }

  private async readFile(path: string): Promise<DocPiece[] | { error: string }> {
    if (!this.o.root) return { error: 'This chat has no folder to read files from. Give a page\'s address instead.' };
    const kind = officeKind(path);
    if (!kind || kind === 'csv') {
      const r = await ws.read(this.o.root, path);
      if ('error' in r) return { error: r.error };
      return [{ label: r.path, text: kind === 'csv' ? csvTable(r.text) : r.text }];
    }
    const full = await ws.inside(this.o.root, path, false);
    if (!full) return { error: `There is no file "${path.slice(0, 120)}" in the folder you work in (list_files shows them).` };
    try {
      const s = await stat(full);
      if (!s.isFile()) return { error: `"${path.slice(0, 120)}" is not a file.` };
      if (s.size > MAX_DOC_BYTES) return { error: `Not read: the file is over ${Math.round(MAX_DOC_BYTES / 2 ** 20)} MB.` };
      const bytes = new Uint8Array(await readFile(full));
      if (kind === 'pdf') return (await pdfPages(bytes, true)).map((text, i) => ({ label: `page ${i + 1}`, text }));
      if (kind === 'xlsx') return xlsxSheets(bytes);
      return [{ label: 'the document', text: docxText(bytes) }];
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file in the folder' : (e as Error).message;
      return { error: `Not read: ${why.replace(/\.$/, '')}.` };
    }
  }

  /** A source as pieces of text: a page opened in this answer, or a file in the folder. */
  private async source(raw: unknown): Promise<{ name: string; pieces: DocPiece[] } | { error: string }> {
    const given = typeof raw === 'string' ? raw.trim() : '';
    if (!given) return { error: 'Say the source: the address of a page you opened in this answer, or a file\'s path in the folder.' };
    if (/^https?:\/\//i.test(given)) {
      const page = this.o.page?.(given);
      if (!page) return { error: 'That page was not opened in this answer, so there is no text to look in. Open it first with open_page, then ask again.' };
      return { name: page.url, pieces: [{ label: 'the page', text: page.text }] };
    }
    const pieces = await this.file(given);
    return 'error' in pieces ? pieces : { name: given, pieces };
  }

  private async write(path: string, text: string): Promise<string | null> {
    if (!this.o.root) return null;
    const refused = checkSave(null, text);
    if (refused) return refused;
    const r = await ws.save(this.o.root, path, text, true, false);
    if ('error' in r) return r.error;
    this.saved.add(r.path);
    return null;
  }

  private notesFile(): string {
    return `# Working notes\n\nKept by TOMLIN as the model works. The newest is last.\n\n${this.notes.map(n => `- ${n}`).join('\n')}\n`;
  }

  private async quotesFile(): Promise<string> {
    const was = this.o.root ? await ws.read(this.o.root, QUOTES_FILE) : { error: 'none' };
    const old = 'error' in was ? '# Quotes\n\nEach quote here was found, word for word, in its source when it was kept.\n' : was.text.replace(/\s*$/, '\n');
    return old;
  }

  private checkAsk(draft: string): string {
    return `QUOTES\n${this.quotes.map(q => `${q.n}. "${q.quote}" (${q.source})`).join('\n')}\n\nDRAFT\n${draft.slice(0, 12_000)}`;
  }

  /** The queued subagent's ask, for the finished answer: once, and only when one was queued and quotes are kept. */
  afterAnswer(final: string): { system: string; user: string } | null {
    if (!this.queued || !this.quotes.length || final.trim().length < 40) return null;
    this.queued = false;
    return { system: CHECK_SYSTEM, user: this.checkAsk(final) };
  }

  /** The notes and quotes as the model is given them back. '' when there are none. */
  notesBlock(): string {
    const lines: string[] = [];
    if (this.notes.length) lines.push('Your working notes:', ...this.notes.slice(-30).map((n, i) => `${i + 1}. ${n}`));
    if (this.quotes.length) lines.push('Quotes kept (each was found in its source):', ...this.quotes.map(q => `${q.n}. ${q.claim} — "${q.quote.length > 160 ? `${q.quote.slice(0, 160)}…` : q.quote}" (${q.source})`));
    return lines.join('\n');
  }

  async run(name: string, rawArgs: string, signal?: AbortSignal): Promise<string> {
    const a = argsOf(rawArgs);
    const done = (ok: boolean, input: string, said: string, result: string) => {
      this.uses.push({ name, input: input.replace(/\s+/g, ' ').slice(0, 200), ok, said: said.slice(0, 200) });
      return result.length > this.o.perCall ? `${result.slice(0, Math.max(0, result.lastIndexOf('\n', this.o.perCall)) || this.o.perCall)}\n[cut here: no more room]` : result;
    };

    if (name === 'calculate') {
      const r = calculate(a.expression);
      return done(r.ok, String(a.expression ?? ''), r.ok ? r.text : 'not worked out', r.text);
    }

    if (name === 'table_stats') {
      let rows: string[][];
      let from = 'the table given';
      if (typeof a.path === 'string' && a.path.trim()) {
        const path = a.path.trim();
        const kind = officeKind(path);
        if (kind !== 'csv' && kind !== 'xlsx') return done(false, path, 'not a table file', 'Not worked out: give a CSV or Excel (.xlsx) file, or the table as CSV text.');
        if (kind === 'csv') {
          if (!this.o.root) return done(false, path, 'no folder', 'This chat has no folder to read files from. Give the table as CSV text instead.');
          const r = await ws.read(this.o.root, path);
          if ('error' in r) return done(false, path, 'not read', r.error);
          rows = csvRows(r.text);
        } else {
          const sheets = await this.file(path);
          if ('error' in sheets) return done(false, path, 'not read', sheets.error);
          const want = typeof a.sheet === 'string' ? a.sheet.trim().toLowerCase() : '';
          const sheet = want ? sheets.find(s => s.label.toLowerCase() === `sheet "${want}"`) : sheets.length === 1 ? sheets[0] : null;
          if (!sheet) return done(false, path, 'which sheet', `${want ? `There is no sheet called "${a.sheet}".` : 'The file has more than one sheet: say which.'} The sheets are: ${sheets.map(s => s.label.replace(/^sheet /, '')).join(', ')}.`);
          rows = sheet.text.split('\n').filter(Boolean).map(l => l.split(' | '));
          from = `${path}, ${sheet.label}`;
        }
        if (kind === 'csv') from = path;
      } else if (typeof a.text === 'string' && a.text.trim()) rows = csvRows(a.text);
      else return done(false, '', 'no table', 'Not worked out: give a file\'s path, or the table as CSV text.');
      const where = a.where === undefined || a.where === '' ? null : parseWhere(a.where);
      if (a.where !== undefined && a.where !== '' && !where) return done(false, from, 'bad test', 'Not worked out: write the test as a column, a sign and a value, like: Region = North, or: Total >= 100.');
      const r = tableStats(rows, { column: typeof a.column === 'string' && a.column.trim() ? a.column : undefined, where });
      return done(r.ok, from, r.ok ? r.text.split('\n')[0] : 'not worked out', r.ok ? `${from}:\n${r.text}` : r.text);
    }

    if (name === 'read_document') {
      const path = typeof a.path === 'string' ? a.path.trim() : '';
      if (!path) return done(false, '', 'no path', 'Say which file: its path in the folder.');
      if (!officeKind(path)) return done(false, path, 'not a document', 'read_document reads Word (.docx), Excel (.xlsx), CSV and PDF files. Read a text file with read_file.');
      const pieces = await this.file(path);
      if ('error' in pieces) return done(false, path, 'not read', pieces.error);
      // Parts of about one call's room each, cut where a piece (a page, a sheet) or a line ends.
      const size = Math.max(500, this.o.perCall - 300);
      const parts: Array<{ label: string; text: string }> = [];
      for (const p of pieces) {
        if (!p.text.trim()) continue;
        for (let at = 0, n = 1; at < p.text.length; n++) {
          let to = Math.min(p.text.length, at + size);
          if (to < p.text.length) to = Math.max(at + Math.floor(size / 2), p.text.lastIndexOf('\n', to));
          parts.push({ label: at === 0 && to === p.text.length ? p.label : `${p.label}, piece ${n}`, text: p.text.slice(at, to) });
          at = to;
        }
      }
      if (!parts.length) return done(true, path, 'no text in it', `${path} has no text to read (a scanned PDF is pictures of pages: its text cannot be read here).`);
      const n = Math.min(parts.length, Math.max(1, Number.isInteger(a.part) ? (a.part as number) : 1));
      const p = parts[n - 1];
      return done(true, path, `part ${n} of ${parts.length}, ${p.label}`, `${path}, part ${n} of ${parts.length} (${p.label})${n < parts.length ? `: ask read_document with part ${n + 1} for the next, or find_in_text to go straight to a passage` : ''}.\n\n${p.text}`);
    }

    if (name === 'find_in_text') {
      const query = typeof a.query === 'string' ? a.query.trim().slice(0, 300) : '';
      if (!query) return done(false, String(a.source ?? ''), 'no words', 'Say the words to look for.');
      const src = await this.source(a.source);
      if ('error' in src) return done(false, String(a.source ?? ''), 'no such source', src.error);
      const room = Math.max(200, Math.min(500, Math.floor((this.o.perCall - 300) / 3)));
      const found = findPassages(src.pieces, query, room, Math.max(1, Math.min(PASSAGES_MOST, Math.floor((this.o.perCall - 200) / (room + 80)))));
      const total = src.pieces.reduce((s, p) => s + p.text.length, 0);
      if (!found.length) return done(true, `${query} in ${src.name}`, 'nothing found', `Nothing in ${src.name} holds "${query}" (${total.toLocaleString('en-GB')} characters looked through). Try other words, or fewer. Do not state what it says about this.`);
      const where = (f: Passage) => `${src.pieces.length > 1 ? `${f.piece}, ` : ''}${Math.round((100 * f.at) / Math.max(1, src.pieces.find(p => p.label === f.piece)?.text.length ?? 1))}% of the way in`;
      return done(true, `${query} in ${src.name}`, `${found.length} passage${found.length === 1 ? '' : 's'}`, [`${found.length} passage${found.length === 1 ? '' : 's'} in ${src.name} for "${query}"${found[0].exact ? '' : ' (the whole phrase is not there; these hold the most of its words)'}:`, ...found.map((f, i) => `\n[${i + 1}] ${where(f)}${f.exact ? ', the phrase itself' : ''}:\n${f.text}`)].join('\n'));
    }

    if (name === 'keep_quote') {
      const claim = typeof a.claim === 'string' ? a.claim.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
      const quote = typeof a.quote === 'string' ? a.quote.replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '') : '';
      if (!claim || !quote) return done(false, claim, 'no claim or quote', 'Not kept: give the claim, and the exact words from the source that it rests on.');
      if (quote.length < QUOTE_MIN) return done(false, claim, 'quote too short', `Not kept: the quote is too short to tell anything by (${QUOTE_MIN} characters at least). Copy the sentence it comes from.`);
      if (quote.length > QUOTE_MAX) return done(false, claim, 'quote too long', `Not kept: a quote is at most ${QUOTE_MAX} characters. Keep the sentence that matters.`);
      if (this.quotes.length >= QUOTES_MOST) return done(false, claim, 'too many', `Not kept: ${QUOTES_MOST} quotes is the most in one answer.`);
      const src = await this.source(a.source);
      if ('error' in src) return done(false, claim, 'no such source', `Not kept: ${src.error}`);
      const at = quoteIn(src.pieces, quote);
      if (!at) {
        // What the source does say nearest to it, so the model can copy the real words or drop the claim.
        const near = findPassages(src.pieces, quote, 300, 1)[0];
        return done(false, claim, 'the quote is not in the source', `Not kept: those words are not in ${src.name}. A quote must be copied word for word, not reworded or put together from parts.${near ? ` The nearest passage there reads:\n${near.text}\nIf it supports the claim, keep a quote copied from it; if it does not, do not state the claim.` : ' Nothing like it was found there: do not state the claim as coming from this source.'}`);
      }
      const same = this.quotes.find(q => plainText(q.quote) === plainText(quote) && q.source === src.name);
      if (same) return done(true, claim, `already kept as quote ${same.n}`, `That quote is already kept as quote ${same.n}.`);
      const q: KeptQuote = { n: this.quotes.length + 1, claim, quote, source: src.name, place: src.pieces.length > 1 ? at.piece : '' };
      const d = (this.o.today ?? (() => new Date()))();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const why = await this.write(QUOTES_FILE, `${await this.quotesFile()}\n- ${day}: ${claim}\n  > ${quote}\n  Source: ${src.name}${q.place ? `, ${q.place}` : ''}\n`);
      if (why) return done(false, claim, 'not saved', why);
      this.quotes.push(q);
      return done(true, claim, `kept as quote ${q.n}, found in the source`, `Kept as quote ${q.n}: the words are in ${src.name}${q.place ? ` (${q.place})` : ''}.`);
    }

    if (name === 'keep_note') {
      await this.load();
      const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return done(false, '', 'no text', 'Not kept: say the note in a sentence or two.');
      if (text.length > NOTE_CHARS) return done(false, text, 'too long', `Not kept: a note is at most ${NOTE_CHARS} characters. Keep the point, not the page.`);
      const plain = plainText(text);
      const had = this.notes.findIndex(n => plainText(n) === plain);
      if (had >= 0) return done(true, text, 'already kept', `That note is already kept (note ${had + 1} of ${this.notes.length}). Do not keep it again: go on to the next step.`);
      const before = this.notes;
      this.notes = [...this.notes, text].slice(-NOTES_MOST);
      const why = await this.write(NOTES_FILE, this.notesFile());
      if (why) {
        this.notes = before;
        return done(false, text, 'not saved', why);
      }
      return done(true, text, `note ${this.notes.length} kept`, `Kept as note ${this.notes.length}.`);
    }

    if (name === 'read_notes') {
      await this.load();
      const block = this.notesBlock();
      return done(true, 'the notes', `${this.notes.length} note${this.notes.length === 1 ? '' : 's'}, ${this.quotes.length} quote${this.quotes.length === 1 ? '' : 's'}`, block || 'No notes or quotes are kept yet.');
    }

    if (name === 'check_draft') {
      const draft = typeof a.draft === 'string' ? a.draft.trim() : '';
      if (draft.length < 40) return done(false, '', 'no draft', 'Give the whole draft answer to check.');
      const out: string[] = [];
      // 1. By code: every passage the draft puts in quote marks must be words that were kept, or that a source read holds.
      const quoted = quotedIn(draft);
      const kept = this.quotes.map(q => plainText(q.quote));
      const read: DocPiece[] = [...this.docs.values()].flatMap(d => ('error' in d ? [] : d));
      const bad = quoted.filter(q => {
        const p = plainText(q);
        if (kept.some(k => k.includes(p) || p.includes(k))) return false;
        if (quoteIn(read, q)) return false;
        return !this.quotes.some(k => !!this.o.page?.(k.source) && !!quoteIn([{ label: 'the page', text: this.o.page!(k.source)!.text }], q));
      });
      if (bad.length) out.push(`Quoted in the draft but not found in anything you kept or read (${bad.length}):`, ...bad.map(q => `- "${q.length > 200 ? `${q.slice(0, 200)}…` : q}"`), 'Take these out, or keep the real words with keep_quote and use those.');
      else if (quoted.length) out.push(`The ${quoted.length} passage${quoted.length === 1 ? '' : 's'} the draft quotes ${quoted.length === 1 ? 'is' : 'are'} in what you kept or read.`);
      if (!this.quotes.length) out.push('No quote is kept for this answer, so none of its facts is checked against a source. Keep a quote (keep_quote) for each fact, or say in the answer that it is not checked.');
      // 2. By a subagent (a second model), when the person allows one: the draft read against the kept quotes. On a
      // node that is free now; with none free, queued to read the finished answer on this PC once it is written.
      let by = '';
      if (this.quotes.length && (this.o.second || this.o.canQueue)) {
        const allowed = this.o.allowSecond ? await this.o.allowSecond() : true;
        if (!allowed) out.push('A subagent was not allowed, so the draft was checked by the code only. Do not say a second model checked it.');
        else {
          let got: { text: string; by: string } | null = null;
          let why = '';
          try {
            got = this.o.second ? await this.o.second(CHECK_SYSTEM, this.checkAsk(draft), signal) : null;
          } catch (e) {
            if (signal?.aborted) throw e;
            why = (e as Error).message.replace(/\.$/, '').slice(0, 200);
          }
          if (got?.text.trim()) {
            by = got.by;
            out.push(`A subagent (${got.by}) read the draft against your ${this.quotes.length} kept quote${this.quotes.length === 1 ? '' : 's'}:`, got.text.trim().slice(0, 3000), /^\W*all supported\W*$/i.test(got.text.trim()) ? '' : 'Mend each of these, or say in the answer that it is not checked. The subagent can be wrong: go by the quotes.');
          } else if (this.o.canQueue) {
            this.queued = true;
            out.push(`${why ? `The node could not be asked (${why}).` : 'No node is free now.'} A subagent is queued: it will read your finished answer against the quotes on this PC when you have written it, and what it finds is shown to the person under the answer. Give your answer now; do not say it has been checked by a second model.`);
          } else out.push(`${why ? `The subagent could not be asked (${why})` : 'No node is free for a subagent now'}, so the draft was checked by the code only.`);
        }
      } else if (this.quotes.length) out.push('There is no second model to ask here, so the draft was checked by the code only.');
      const ok = !bad.length && this.quotes.length > 0;
      return done(ok, `a draft of ${draft.length.toLocaleString('en-GB')} characters`, `${bad.length ? `${bad.length} quoted passage${bad.length === 1 ? '' : 's'} not found` : this.quotes.length ? 'quoted passages found' : 'no quotes kept'}${by ? `, read by ${by}` : ''}`, out.filter(Boolean).join('\n'));
    }
    return `There is no tool called "${name}".`;
  }
}

export const FOLD_KEEP_ROUNDS = 2;
export const FOLD_OVER = 6000;
export const FOLD_STUB = 240;
const DROPPED_MARK = '\n[The rest of this result (';
const KEPT_MARK = '\n\n[Kept for you by TOMLIN, because older results above were dropped to save room]\n';

/**
 * A long answer's tool turns, made smaller for the next ask: the results of the last two rounds stay whole; an older
 * result is cut to its first lines, with a note that the rest was dropped; and the last result is followed by what
 * the CODE kept: the calls already made (so the model does not make them again) and the working notes and quotes.
 * Nothing is changed while the results are small (under `over` characters in all). The same turns folded twice give
 * the same thing.
 */
export function foldToolTurns(turns: Record<string, unknown>[], notes: string, over = FOLD_OVER): Record<string, unknown>[] {
  const text = (t: Record<string, unknown>) => (typeof t.content === 'string' ? t.content : '');
  const clean = turns.map(t => (t.role === 'tool' && text(t).includes(KEPT_MARK) ? { ...t, content: text(t).slice(0, text(t).indexOf(KEPT_MARK)) } : t));
  const size = clean.reduce((s, t) => s + (t.role === 'tool' ? text(t).length : 0), 0);
  // Once an answer has been folded it stays folded: the cut results are small, but the notes must still be handed back.
  const folded = turns.some(t => t.role === 'tool' && (text(t).includes(KEPT_MARK) || text(t).includes(DROPPED_MARK)));
  if (size <= over && !folded) return clean;
  const rounds = clean.map((t, i) => (t.role === 'assistant' ? i : -1)).filter(i => i >= 0);
  const keepFrom = rounds.length > FOLD_KEEP_ROUNDS ? rounds[rounds.length - FOLD_KEEP_ROUNDS] : 0;
  // Each call by its id, to name the calls already made.
  const calls = new Map<string, string>();
  for (const t of clean) {
    for (const c of (Array.isArray(t.tool_calls) ? t.tool_calls : []) as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
      if (c.id) calls.set(c.id, `${c.function?.name ?? 'a tool'} ${String(c.function?.arguments ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  const made: string[] = [];
  const out = clean.map((t, i) => {
    if (t.role !== 'tool' || i >= keepFrom) return t;
    const c = text(t);
    made.push(calls.get(String(t.tool_call_id ?? '')) ?? 'a tool');
    if (c.length <= FOLD_STUB + 120 || c.includes(DROPPED_MARK)) return t;
    const cut = c.slice(0, FOLD_STUB);
    return { ...t, content: `${cut.slice(0, Math.max(80, cut.lastIndexOf(' ')))}…${DROPPED_MARK}${(c.length - FOLD_STUB).toLocaleString('en-GB')} characters) was dropped to save room. Do not guess what it said: ask again only if you need it.]` };
  });
  let last = -1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i].role === 'tool') { last = i; break; }
  if (last < 0) return out;
  const block = [made.length ? `Calls you already made (do not make them again):\n${[...new Set(made)].slice(-40).map((m, i) => `${i + 1}. ${m}`).join('\n')}` : '', notes].filter(Boolean).join('\n\n');
  if (!block) return out;
  out[last] = { ...out[last], content: `${text(out[last])}${KEPT_MARK}${block}` };
  return out;
}
