// Documents in a chat (PLAN F10 G6): reading, splitting, finding the parts a message is about, keeping them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanDocName, docKind, docSection, Docs, findParts, pagesAsked, ranges, readDoc, sourcesLine, splitText, textParts, words, type Doc } from '../src/docs.ts';

/** A plain PDF with one page per entry (each entry's lines in Helvetica), written by hand: enough for a reader test. */
export function makePdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const esc = (s: string) => s.replace(/[\\()]/g, m => `\\${m}`);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const kids: string[] = [];
  pages.forEach((lines, i) => {
    const page = 4 + i * 2;
    const body = `BT /F1 11 Tf 72 760 Td 14 TL ${lines.map(l => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objs[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`;
    objs[page + 1] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
    kids.push(`${page} 0 R`);
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    at[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${at.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A 40-page piano manual: page 31 is the only one about the pitch raise. */
export function manual(): Uint8Array {
  return makePdf(Array.from({ length: 40 }, (_, i) => i + 1 === 31
    ? ['Chapter 9. The pitch raise.', 'A piano more than 20 cents flat gets a pitch raise first:', 'a quick pass that brings every string near pitch, then a fine tuning.', 'Allow an extra 45 minutes for it.']
    : [`Page ${i + 1}. General care of the instrument.`, 'Keep the room between 40 and 50 per cent humidity.', 'Close the lid when the piano is not played, and dust the keys with a soft cloth.']));
}

test('which files a chat reads, and their names kept plain', () => {
  assert.equal(docKind('Manual.PDF'), 'pdf');
  assert.equal(docKind('notes.md'), 'text');
  assert.equal(docKind('app.py'), 'text');
  assert.equal(docKind('photo.jpg'), null);
  assert.equal(cleanDocName('C:\\Users\\x\\My "big" file?.pdf'), 'My big file.pdf');
  assert.equal(cleanDocName(''), 'document');
});

test('a 40-page PDF is read page by page; every part knows its page', async () => {
  const d = await readDoc('manual.pdf', manual());
  assert.equal(d.kind, 'pdf');
  assert.equal(d.pages, 40);
  assert.ok(d.parts.every(p => p.page! >= 1 && p.page! <= 40));
  const p31 = d.parts.filter(p => p.page === 31).map(p => p.text).join(' ');
  assert.match(p31, /pitch raise first/);
  assert.match(p31, /extra 45 minutes/);
});

test('asking about page 31 brings page 31 first; asking about the pitch raise finds it by its words', async () => {
  const d = await readDoc('manual.pdf', manual());
  const byPage = findParts([d], 'What does page 31 say?', 3000);
  assert.equal(byPage[0].part.page, 31);
  const byWords = findParts([d], 'How long does a pitch raise take?', 600);
  assert.equal(byWords[0].part.page, 31);
  assert.equal(sourcesLine(byWords), 'manual.pdf page 31');
  assert.match(docSection(byWords), /\[manual\.pdf, page 31\]\nChapter 9/);
});

test('page asks are read in their usual forms', () => {
  assert.deepEqual(pagesAsked('see page 31'), [31]);
  assert.deepEqual(pagesAsked('p. 4 and pp 7-9'), [4, 7, 8, 9]);
  assert.deepEqual(pagesAsked('pages 4 to 6'), [4, 5, 6]);
  assert.deepEqual(pagesAsked('the 31 keys'), []);
});

test('words: lower case, stop words out, plurals folded', () => {
  assert.deepEqual(words('The Strings of the pianos are TUNED'), ['string', 'piano', 'tuned']);
});

test('text is split at blank lines or line ends, about 1,500 characters a part', () => {
  const para = (n: number) => `Paragraph ${n}. ${'word '.repeat(60).trim()}.`;
  const text = Array.from({ length: 10 }, (_, i) => para(i)).join('\n\n');
  const parts = splitText(text);
  assert.ok(parts.length >= 3 && parts.every(p => p.length <= 1500), parts.map(p => p.length).join(','));
  assert.ok(parts.every(p => p.startsWith('Paragraph')), 'cut between paragraphs');
});

test('a text file keeps true line numbers in its parts', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}: ${'x'.repeat(20)}`);
  const parts = textParts(lines.join('\n'));
  assert.deepEqual(parts[0].lines?.[0], 1);
  assert.equal(parts.at(-1)!.lines![1], 300);
  for (const p of parts) assert.ok(p.text.startsWith(`line ${p.lines![0]}:`), `${p.lines}`);
  const found = findParts([{ id: 'a', name: 'log.txt', kind: 'text', pages: 300, chars: 0, at: '', parts }], 'what is on line 250?', 4000);
  assert.ok(found.length > 0);
});

test('a file a chat cannot read says why in plain words', async () => {
  await assert.rejects(readDoc('photo.jpg', new Uint8Array([1, 2, 3])), /a chat reads PDF, text and code files/);
  await assert.rejects(readDoc('broken.pdf', new TextEncoder().encode('not a pdf')), /could not be read as a PDF/);
  await assert.rejects(readDoc('x.txt', new Uint8Array([0, 1, 2, 0])), /not plain text/);
});

test('documents are kept beside their chat, listed and removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-docs-'));
  try {
    const docs = new Docs(dir);
    const d: Doc = await readDoc('notes.md', new TextEncoder().encode('# Notes\nThe tuning fork is A440.'));
    await docs.add('0123456789ab', d);
    assert.deepEqual((await docs.list('0123456789ab')).map(x => [x.name, x.parts]), [['notes.md', 1]]);
    assert.equal(await docs.remove('0123456789ab', d.id), true);
    assert.equal((await docs.all('0123456789ab')).length, 0);
    await assert.rejects(docs.all('../evil'), /Not a chat/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pages read are named as ranges, and a page that only repeats another is left out', async () => {
  assert.equal(ranges([9, 4, 5, 6, 31, 5]), '4-6, 9, 31');
  const d = await readDoc('manual.pdf', manual());
  const found = findParts([d], 'How much humidity should the room have?', 20000);
  // Pages 1-30 and 32-40 say the same with their number changed: one of them is enough.
  assert.equal(found.length, 1);
  assert.match(sourcesLine(found), /^manual\.pdf page \d+$/);
});
