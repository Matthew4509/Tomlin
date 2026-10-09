// Documents in a chat (PLAN F10 G6): a PDF, text or code file dropped into a chat is read once into plain text, split
// into parts (never across a page), and kept beside the chat as data/docs/<chat id>/<doc id>.json; the original file is
// not kept. For each message the parts that match its words best are found by code (word match, no model needed) and
// given to the model with their page; the answer then says which pages it was given. PDF text comes from PDF.js
// (pdfjs-dist, Apache-2.0, THIRD-PARTY.md); a scanned PDF (pictures of pages, no text) has nothing to read and says so.
// The plain functions are tested in test/docs.test.ts.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { writeAtomic } from './atomic.ts';

export const MAX_DOC_BYTES = 25 * 1024 * 1024;
export const MAX_DOCS = 8;
const MAX_PAGES = 2000;
const MAX_CHARS = 4_000_000;
/** About 300 words: small enough that several fit a small model, big enough to keep a paragraph whole. */
export const PART_CHARS = 1500;

/** Text files a chat can read (the same kinds as the workspace, plus a few more plain-text ones). */
const TEXT_KINDS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.log', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.php', '.sql', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.sh', '.ps1', '.bat']);

export interface DocPart {
  /** The page (PDF), or null for a text file. */
  page: number | null;
  /** For a text file: the first and last line of the part. */
  lines?: [number, number];
  text: string;
}

export interface Doc {
  id: string;
  name: string;
  kind: 'pdf' | 'text';
  /** Pages in a PDF; lines in a text file. */
  pages: number;
  chars: number;
  at: string;
  parts: DocPart[];
}

export type DocInfo = Omit<Doc, 'parts'> & { parts: number; empty: number };

/** What kind a file is by its name: 'pdf', 'text', or null when a chat cannot read it. */
export function docKind(name: string): 'pdf' | 'text' | null {
  const ext = extname(name).toLowerCase();
  return ext === '.pdf' ? 'pdf' : TEXT_KINDS.has(ext) ? 'text' : null;
}

/** A file name safe to show and keep: no folders, no odd characters, at most 120 characters. */
export function cleanDocName(name: unknown): string {
  return String(name ?? '').split(/[\\/]/).pop()!.replace(/[\0-\x1f<>:"|?*]/g, '').trim().slice(-120) || 'document';
}

/**
 * PDF.js, loaded once. It looks for a drawing add-on (@napi-rs/canvas) that is not shipped (text needs no drawing) and
 * warns about it as it loads: those warnings are kept out of the window and the log.
 */
let pdfjsLoaded: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
function pdfjsLib() {
  if (!pdfjsLoaded) {
    const { log, warn } = console;
    const quiet = (to: (...a: unknown[]) => void) => (...a: unknown[]) => { if (!/napi-rs\/canvas|Cannot polyfill/.test(String(a[0]))) to(...a); };
    console.log = quiet(log);
    console.warn = quiet(warn);
    pdfjsLoaded = import('pdfjs-dist/legacy/build/pdf.mjs').finally(() => {
      console.log = log;
      console.warn = warn;
    });
  }
  return pdfjsLoaded;
}

/** Each page's text, in order, from a PDF's bytes (PDF.js, without drawing anything). */
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await pdfjsLib();
  // PDF.js 6 runs no code from a PDF (its old isEvalSupported switch is gone with the code it turned off).
  const task = pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const pdf = await task.promise;
  try {
    if (pdf.numPages > MAX_PAGES) throw new Error(`it has ${pdf.numPages.toLocaleString('en-GB')} pages; a chat reads at most ${MAX_PAGES.toLocaleString('en-GB')}`);
    const pages: string[] = [];
    let total = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Each item is a run of text; hasEOL marks the end of a line. Runs on one line are joined with a space when
      // the PDF left no space between them.
      let text = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        if (text && !/\s$/.test(text) && item.str && !/^\s/.test(item.str)) text += ' ';
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      page.cleanup();
      const clean = tidy(text);
      total += clean.length;
      if (total > MAX_CHARS) throw new Error(`its text is over ${MAX_CHARS.toLocaleString('en-GB')} characters, more than a chat keeps`);
      pages.push(clean);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Spaces tidied: runs of spaces become one, three or more line breaks become two. */
function tidy(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One page (or a whole text file) as parts of about PART_CHARS characters: cut at a blank line when there is one in
 * the second half of the part, else at a line end, else at a sentence end, else at a space.
 */
export function splitText(text: string, size = PART_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const half = Math.floor(size / 2);
    const at = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! ')) + 1, window.lastIndexOf(' ')].find(i => i >= half) ?? size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A PDF's pages as parts, each with its page number. */
export function pdfParts(pages: string[]): DocPart[] {
  return pages.flatMap((text, i) => splitText(text).map(t => ({ page: i + 1, text: t })));
}

/** A text file as parts, each with the lines it holds (cut at line ends, so line numbers stay true). */
export function textParts(text: string, size = PART_CHARS): DocPart[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: DocPart[] = [];
  let cur: string[] = [];
  let first = 1;
  let n = 0;
  const flush = (last: number) => {
    const t = cur.join('\n').trim();
    if (t) out.push({ page: null, lines: [first, last], text: t });
    cur = [];
    n = 0;
  };
  lines.forEach((line, i) => {
    // A very long line (minified code) is cut into pieces of its own.
    const pieces = line.length > size ? splitText(line, size) : [line];
    for (const piece of pieces) {
      if (n && n + piece.length + 1 > size) flush(i);
      if (!cur.length) first = i + 1;
      cur.push(piece);
      n += piece.length + 1;
    }
  });
  flush(lines.length);
  return out;
}

/** Reads a dropped file into a document (not saved). Throws with plain words when it cannot. */
export async function readDoc(name: string, bytes: Uint8Array, at = new Date().toISOString()): Promise<Doc> {
  const kind = docKind(name);
  if (!kind) throw new Error(`a chat reads PDF, text and code files (.pdf, .txt, .md, .csv, .html, .js, .py and the like), not ${extname(name) || 'files without an ending'}`);
  if (bytes.length > MAX_DOC_BYTES) throw new Error(`it is ${(bytes.length / 1048576).toFixed(1)} MB; a chat reads files up to ${MAX_DOC_BYTES / 1048576} MB`);
  const id = randomBytes(6).toString('hex');
  if (kind === 'pdf') {
    let pages: string[];
    try {
      pages = await pdfPages(bytes);
    } catch (e) {
      const why = (e as Error).message;
      throw new Error(/password/i.test(why) ? 'it is locked with a password: open it, save a copy without the password, and drop that' : /^it /.test(why) ? why : `it could not be read as a PDF (${why})`);
    }
    const parts = pdfParts(pages);
    return { id, name, kind, pages: pages.length, chars: pages.reduce((t, p) => t + p.length, 0), at, parts };
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.length > MAX_CHARS) throw new Error(`its text is over ${MAX_CHARS.toLocaleString('en-GB')} characters, more than a chat keeps`);
  if (/\u0000/.test(text.slice(0, 4096))) throw new Error('it is not plain text (it looks like a program or a picture)');
  return { id, name, kind, pages: text.split('\n').length, chars: text.length, at, parts: textParts(text) };
}

export function info(d: Doc): DocInfo {
  return { id: d.id, name: d.name, kind: d.kind, pages: d.pages, chars: d.chars, at: d.at, parts: d.parts.length, empty: d.kind === 'pdf' ? d.pages - new Set(d.parts.map(p => p.page)).size : 0 };
}

// ---- Finding the parts a message is about ----

const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so that the their them then there these they this to was we what when where which who why will with you your about please tell say says said show give find page pages document file pdf'.split(' '));

/** The words of a text that carry meaning: lower case, letters and digits, stop words out, plurals folded. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 1 && !STOP.has(w)).map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** Page numbers a message asks for: "page 31", "p. 31", "pages 4-6", "pp 4 and 5". */
export function pagesAsked(message: string): number[] {
  const out = new Set<number>();
  for (const m of message.matchAll(/\b(?:pages?|pp?\.?)\s*(\d{1,4})(?:\s*(?:-|–|to|and|&)\s*(\d{1,4}))?/gi)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && p - Math.min(a, b) < 20; p++) out.add(p);
  }
  return [...out];
}

export interface Found {
  doc: string;
  part: DocPart;
  score: number;
}

/**
 * The parts of the documents that best match a message, best first, until `room` characters are used: a page the
 * message names comes first (all its parts, in order), then the parts by word match (BM25: a word that is rare in the
 * document counts more than a common one). With no word in common and no page named, the start of each document.
 */
export function findParts(docs: Doc[], message: string, room: number): Found[] {
  const asked = pagesAsked(message);
  const q = [...new Set(words(message))];
  const all = docs.flatMap(d => d.parts.map(part => ({ doc: d.name, part, w: words(part.text) })));
  if (!all.length) return [];
  const df = new Map<string, number>();
  for (const x of all) for (const w of new Set(x.w)) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = all.reduce((t, x) => t + x.w.length, 0) / all.length || 1;
  const scored = all.map(x => {
    const tf = new Map<string, number>();
    for (const w of x.w) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (all.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (x.w.length / avg)));
    }
    if (x.part.page != null && asked.includes(x.part.page)) score += 1000;
    return { doc: x.doc, part: x.part, score };
  });
  let pick = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!pick.length) pick = docs.flatMap(d => d.parts.slice(0, 2).map(part => ({ doc: d.name, part, score: 0 })));
  const out: Found[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const x of pick) {
    // A part that says the same as one already picked (a running header, a page repeated with its number changed)
    // adds nothing: it is left out.
    const same = x.part.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
    if (seen.has(same)) continue;
    seen.add(same);
    const n = x.part.text.length + 60;
    if (used + n > room) {
      if (out.length) continue;
      // The best part alone is bigger than the room: it goes in cut short.
      out.push({ ...x, part: { ...x.part, text: x.part.text.slice(0, Math.max(200, room - 60)) } });
      break;
    }
    out.push(x);
    used += n;
  }
  return out;
}

/** Where a part is, in words: "manual.pdf, page 31" or "notes.md, lines 40-72". */
export function partPlace(doc: string, p: DocPart): string {
  return p.page != null ? `${doc}, page ${p.page}` : p.lines ? `${doc}, lines ${p.lines[0]}-${p.lines[1]}` : doc;
}

/** The parts as the model reads them: each with its place, in the order they come in the document. */
export function docSection(found: Found[]): string {
  const sorted = [...found].sort((a, b) => a.doc.localeCompare(b.doc) || (a.part.page ?? a.part.lines?.[0] ?? 0) - (b.part.page ?? b.part.lines?.[0] ?? 0));
  return [
    'Parts of the documents in this chat that match the message (found by word match; the rest of each document was not given to you). Answer from them, quote the words that answer, and name the page (or lines) you used, like "(page 31)". If they do not hold the answer, say so; do not guess.',
    ...sorted.map(f => `[${partPlace(f.doc, f.part)}]\n${f.part.text}`),
  ].join('\n\n');
}

/** "4, 5, 6, 9" -> "4-6, 9". */
export function ranges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(', ');
}

/** "Read: manual.pdf pages 30-31; notes.md lines 1-40": the pages given to the model, shown under the answer. */
export function sourcesLine(found: Found[]): string {
  const by = new Map<string, { pages: number[]; lines: string[] }>();
  for (const f of found) {
    const x = by.get(f.doc) ?? { pages: [], lines: [] };
    if (f.part.page != null) x.pages.push(f.part.page);
    else if (f.part.lines) x.lines.push(`${f.part.lines[0]}-${f.part.lines[1]}`);
    by.set(f.doc, x);
  }
  return [...by].map(([doc, x]) => {
    if (x.pages.length) return `${doc} ${new Set(x.pages).size > 1 ? 'pages' : 'page'} ${ranges(x.pages)}`;
    if (x.lines.length) return `${doc} lines ${[...new Set(x.lines)].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(', ')}`;
    return doc;
  }).join('; ');
}

// ---- Kept beside the chat ----

export class Docs {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'docs');
  }

  private folder(chatId: string): string {
    if (!/^[a-f0-9]{12}$/.test(chatId)) throw new Error('Not a chat.');
    return join(this.dir, chatId);
  }

  async add(chatId: string, doc: Doc): Promise<void> {
    await mkdir(this.folder(chatId), { recursive: true });
    await writeAtomic(join(this.folder(chatId), `${doc.id}.json`), JSON.stringify(doc));
  }

  async all(chatId: string): Promise<Doc[]> {
    const folder = this.folder(chatId);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    const out: Doc[] = [];
    for (const n of names.filter(x => /^[a-f0-9]{12}\.json$/.test(x))) {
      try {
        out.push(JSON.parse(await readFile(join(folder, n), 'utf8')) as Doc);
      } catch {
        // A file cut short by a crash is left out, not fatal.
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async list(chatId: string): Promise<DocInfo[]> {
    return (await this.all(chatId)).map(info);
  }

  async remove(chatId: string, id: string): Promise<boolean> {
    if (!/^[a-f0-9]{12}$/.test(id)) return false;
    const file = join(this.folder(chatId), `${id}.json`);
    const had = (await readdir(this.folder(chatId)).catch(() => [] as string[])).includes(`${id}.json`);
    await rm(file, { force: true });
    return had;
  }

  /** A carried-on chat keeps the documents of the chat it came from. */
  async copy(fromChat: string, toChat: string): Promise<void> {
    for (const d of await this.all(fromChat)) await this.add(toChat, d);
  }

  /** Everything kept for a chat (when the chat is deleted). */
  async drop(chatId: string): Promise<void> {
    await rm(this.folder(chatId), { recursive: true, force: true });
  }
}
