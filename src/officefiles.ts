// Word (.docx), Excel (.xlsx) and CSV files read into text, with tables kept as tables (one row a line, cells parted
// by " | "). A .docx and an .xlsx are zip files of XML: the zip is read here with Node's own zlib, nothing downloaded,
// nothing run, and with limits on how much it may unpack (a small file made to unpack to gigabytes is refused).
// Read only: nothing is ever written back. Plain parts, tested in test/officefiles.test.ts.
import { inflateRawSync } from 'node:zlib';
import { csvRows } from './sums.ts';

export const ZIP_ENTRIES_MOST = 5000;
export const ZIP_ENTRY_MOST = 40 * 2 ** 20;
export const ZIP_TOTAL_MOST = 80 * 2 ** 20;
/** The most parts unpacked from one file (a workbook with more sheets than this is not read). */
export const ZIP_READ_MOST = 300;
export const ROWS_MOST = 20_000;
/** Excel's last column (XFD): a cell said to be further along is not a real one. */
export const COLUMNS_MOST = 16_384;
/**
 * The most characters read out of one workbook: a few kilobytes naming the last column on 20,000 rows made about 1 GB of
 * empty cells, and one naming column ZZZZZZ asked for 308 million.
 */
export const TEXT_MOST = 8 * 2 ** 20;

export interface DocPiece { label: string; text: string }

/** The files inside a zip whose names pass `want`, unpacked. Throws in plain words when it is not a zip, or too big. */
export function unzip(bytes: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is in the last 64 KB (after it comes only a comment).
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('it is not a file of this kind (no zip record in it)');
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  if (count > ZIP_ENTRIES_MOST) throw new Error('it holds too many parts to read');
  const out = new Map<string, Uint8Array>();
  // What the parts really unpack to, counted as they unpack: the sizes a zip says for itself may be lies (a part that
  // says 0 bytes still unpacks), so the total is kept from the bytes that came out, never from what was said.
  let total = 0;
  let read = 0;
  const tooBig = () => new Error('it unpacks to more than can be read here');
  for (let n = 0; n < count; n++) {
    if (at + 46 > b.length || b.readUInt32LE(at) !== 0x02014b50) throw new Error('its list of parts is damaged');
    const method = b.readUInt16LE(at + 10);
    const packed = b.readUInt32LE(at + 20);
    const size = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    const local = b.readUInt32LE(at + 42);
    const name = b.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (++read > ZIP_READ_MOST) throw new Error('it holds too many parts to read');
    if (size > ZIP_ENTRY_MOST || total + size > ZIP_TOTAL_MOST) throw tooBig();
    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) throw new Error('one of its parts is damaged');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + packed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) {
      // The limit is given to zlib itself: no more than one part may hold, nor than is left of the total, so a part
      // that lies about its size cannot unpack past either.
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(ZIP_ENTRY_MOST, ZIP_TOTAL_MOST - total)) });
      } catch (e) {
        if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw tooBig();
        throw new Error('one of its parts is damaged');
      }
    } else throw new Error('it is packed in a way that cannot be read here');
    if ((total += data.byteLength) > ZIP_TOTAL_MOST) throw tooBig();
    out.set(name, data);
  }
  return out;
}

/** A character mark's character; one past the last character there is (a damaged or made-up file) reads as a mark of its own. */
const charOf = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�');
const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#x([0-9a-f]+);/gi, (_, h) => charOf(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => charOf(Number(d))).replace(/&amp;/g, '&');
const cell = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
const utf8 = (u: Uint8Array | undefined) => (u ? Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('utf8') : '');

/** A Word file's text: paragraphs a line each, a table as rows of "a | b | c". */
export function docxText(bytes: Uint8Array): string {
  const xml = utf8(unzip(bytes, n => n === 'word/document.xml').get('word/document.xml'));
  if (!xml) throw new Error('it has no document text in it (is it a Word .docx file?)');
  const lines: string[] = [];
  let para = '';
  let inText = false;
  // Tables may sit inside tables: each level keeps its own row and cell.
  const tables: Array<{ row: string[]; cell: string[] }> = [];
  const tag = /<(\/?)w:(tbl|tr|tc|tab|br|cr|p|t)\b[^>]*?(\/?)>|([^<]+)/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[4] !== undefined) {
      if (inText) para += xmlText(m[4]);
      continue;
    }
    const [, close, name, self] = m;
    if (name === 't') inText = !close && !self;
    else if (name === 'tab' && !close) para += '\t';
    else if ((name === 'br' || name === 'cr') && !close) para += '\n';
    else if (name === 'p' && (close || self)) {
      const t = tables.at(-1);
      if (t) { if (para.trim()) t.cell.push(para); }
      else lines.push(para.replace(/[ \t]+$/gm, ''));
      para = '';
    } else if (name === 'tbl') {
      if (!close) tables.push({ row: [], cell: [] });
      else { tables.pop(); if (!tables.length) lines.push(''); }
    } else if (name === 'tr' && close) {
      const t = tables.at(-1);
      if (t) {
        const line = t.row.join(' | ');
        // A table inside a cell goes into that cell's text; the outermost table's rows are lines of the document.
        const outer = tables.at(-2);
        if (outer) outer.cell.push(line);
        else lines.push(line);
        t.row = [];
      }
    } else if (name === 'tc' && close) {
      const t = tables.at(-1);
      if (t) { t.row.push(cell(t.cell.join(' '))); t.cell = []; }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A1, B7, AA3: the column's place, 0 for A. */
const colOf = (ref: string): number => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** An Excel file's sheets, each as rows of "a | b | c" (the cells' values as stored: a date is its number, a sum its last result). */
export function xlsxSheets(bytes: Uint8Array): DocPiece[] {
  const files = unzip(bytes, n => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const book = utf8(files.get('xl/workbook.xml'));
  if (!book) throw new Error('it has no workbook in it (is it an Excel .xlsx file?)');
  const shared = [...utf8(files.get('xl/sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => [...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map(t => xmlText(t[1])).join(''));
  const attr = (tagText: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tagText)?.[1] ?? '';
  const rels = new Map([...utf8(files.get('xl/_rels/workbook.xml.rels')).matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')] as const));
  const out: DocPiece[] = [];
  let rowsLeft = ROWS_MOST;
  let charsLeft = TEXT_MOST;
  for (const [i, s] of [...book.matchAll(/<sheet\b[^>]*>/g)].entries()) {
    const target = rels.get(attr(s[0], 'r:id')) ?? `worksheets/sheet${i + 1}.xml`;
    const xml = utf8(files.get(`xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`));
    const lines: string[] = [];
    let cut = false;
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rowsLeft-- <= 0 || charsLeft <= 0) { cut = true; break; }
      const cells: string[] = [];
      // Counted as the row is made, so one row of long shared words in every column cannot get past the cap either.
      let rowChars = 0;
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = colOf(attr(c[1], 'r'));
        if (at >= COLUMNS_MOST) throw new Error(`it names a column past Excel's last one (${attr(c[1], 'r').slice(0, 12)}), so it is not a real workbook`);
        const type = attr(c[1], 't');
        const v = /<v\b[^>]*>([^<]*)<\/v>/.exec(c[2] ?? '')?.[1] ?? '';
        const text = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? [...(c[2] ?? '').matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map(t => xmlText(t[1])).join('') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : xmlText(v);
        const place = at >= 0 ? at : cells.length;
        rowChars += Math.max(0, place - cells.length) * 3 + text.length + 3;
        if (rowChars > charsLeft) {
          charsLeft = 0;
          break;
        }
        while (cells.length < place) cells.push('');
        cells[place] = cell(text);
      }
      if (cells.some(Boolean)) {
        const line = cells.join(' | ');
        lines.push(line);
        charsLeft -= line.length + 1;
      }
    }
    const said = charsLeft <= 0 ? `\n[cut here: only the first ${(TEXT_MOST / 2 ** 20).toFixed(0)} million characters are read]` : `\n[cut here: only the first ${ROWS_MOST.toLocaleString('en-GB')} rows are read]`;
    out.push({ label: `sheet "${xmlText(attr(s[0], 'name')) || `Sheet ${i + 1}`}"`, text: lines.join('\n') + (cut || charsLeft <= 0 ? said : '') });
  }
  return out;
}

/** A CSV text as rows of "a | b | c". */
export function csvTable(text: string): string {
  return csvRows(text, ROWS_MOST).map(r => r.map(cell).join(' | ')).join('\n');
}

export type OfficeKind = 'docx' | 'xlsx' | 'csv' | 'pdf';
export function officeKind(name: string): OfficeKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return ext === 'docx' || ext === 'xlsx' || ext === 'csv' || ext === 'pdf' ? ext : ext === 'tsv' ? 'csv' : null;
}
