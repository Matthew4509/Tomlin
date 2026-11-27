// Documents in a chat (PLAN F10 G6): reading, splitting, finding the parts a message is about, keeping them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cleanDocName, docKind, docSection, Docs, findParts, lastReview, pagesAsked, pagesToRead, pdfPages, PDF_MEMORY_MB, PDF_TIME_MS, PICTURE_PX, picturesNote, picturesSaid, ranges, rawOf, readDoc, reviewAsked, reviewSection, reviewSections, sourcesLine, splitText, textParts, unreadPictures, wholeSection, wholeText, withPageText, words, type Doc } from '../src/docs.ts';

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

test('a very long line (minified code) cut into parts keeps true line numbers, and read whole it is one line again', () => {
  const long = Array.from({ length: 400 }, (_, i) => `var v${i}=f(${i});`).join(' ') + 'end_of_the_long_line();';
  const text = ['// head', 'const x = 1;', long, 'end();'].join('\n');
  const parts = textParts(text);
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  for (const p of parts) assert.ok(p.lines![0] <= p.lines![1], `a part's lines run forwards: ${p.lines}`);
  assert.deepEqual(parts[0].lines, [1, 2], 'the head (the first piece of line 3 is too big to share its part)');
  for (const p of parts.slice(1, -1)) assert.deepEqual(p.lines, [3, 3], 'pieces of line 3');
  assert.deepEqual(parts.at(-1)!.lines, [3, 4], 'the end of line 3 and line 4');
  const found = parts.map(part => ({ doc: 'app.min.js', part, score: 1 }));
  assert.doesNotMatch(sourcesLine(found), /3-2/);
  const d: Doc = { id: 'a', name: 'app.min.js', kind: 'text', pages: 4, chars: text.length, at: '', parts };
  assert.equal(wholeText(d), text, 'read whole, the file is exactly as it was: the long line whole, nothing added');
});

test('a PDF is read in a thread of its own: one that takes too long or needs too much memory is stopped and said so, and this thread goes on', async () => {
  // Read with a normal limit, it works as before.
  assert.equal((await pdfPages(manual())).length, 40);
  // A time limit too short to read it: stopped, said plainly (read in this thread, it could not have been stopped).
  await assert.rejects(pdfPages(manual(), false, { ms: 1 }), /it took longer than \d+ seconds to read/);
  // A memory limit too small for the reader: stopped in that thread, said plainly.
  await assert.rejects(pdfPages(manual(), false, { memoryMb: 6 }), /it needs more memory to read than is allowed here/);
  assert.ok(PDF_MEMORY_MB >= 256 && PDF_TIME_MS >= 10_000);
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

/**
 * A scanned PDF: one picture drawn over each page (a JPEG, raw grey pixels or a black-and-white mask), or a page of
 * text, written by hand like makePdf.
 */
export function makeScanPdf(pages: Array<{ w: number; h: number; dict: string; data: Uint8Array } | string>): Uint8Array {
  const objs: Array<Array<string | Uint8Array>> = [];
  objs[1] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  objs[3] = ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const kids: string[] = [];
  pages.forEach((pg, i) => {
    const p = 4 + i * 3;
    const body = typeof pg === 'string' ? `BT /F1 11 Tf 72 760 Td (${pg}) Tj ET` : 'q 612 0 0 792 0 0 cm /Im0 Do Q';
    const res = typeof pg === 'string' ? '<< /Font << /F1 3 0 R >> >>' : `<< /XObject << /Im0 ${p + 2} 0 R >> >>`;
    objs[p] = [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${p + 1} 0 R >>`];
    objs[p + 1] = [`<< /Length ${body.length} >>\nstream\n${body}\nendstream`];
    objs[p + 2] = typeof pg === 'string' ? ['<< >>'] : [`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} ${pg.dict} /Length ${pg.data.length} >>\nstream\n`, pg.data, '\nendstream'];
    kids.push(`${p} 0 R`);
  });
  objs[2] = [`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`];
  const chunks: Uint8Array[] = [];
  let len = 0;
  const put = (x: string | Uint8Array) => {
    const b = typeof x === 'string' ? new Uint8Array(Buffer.from(x, 'latin1')) : x;
    chunks.push(b);
    len += b.length;
  };
  put('%PDF-1.4\n');
  const at: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    at[n] = len;
    put(`${n} 0 obj\n`);
    for (const x of objs[n]) put(x);
    put('\nendobj\n');
  }
  const xref = len;
  put(`xref\n0 ${objs.length}\n0000000000 65535 f \n${at.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Four pages: text, a big colour JPEG scan, raw grey pixels, a black-and-white mask. */
async function scanned(): Promise<Uint8Array> {
  const jpeg = new Uint8Array(await sharp({ create: { width: 2400, height: 3200, channels: 3, background: { r: 230, g: 225, b: 210 } } }).jpeg().toBuffer());
  return makeScanPdf([
    'Page one has real words about the tuning hammer.',
    { w: 2400, h: 3200, dict: '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: jpeg },
    { w: 100, h: 60, dict: '/ColorSpace /DeviceGray /BitsPerComponent 8', data: new Uint8Array(6000).fill(128) },
    { w: 64, h: 32, dict: '/ImageMask true /BitsPerComponent 1', data: new Uint8Array(8 * 32).fill(0xf0) },
  ]);
}

test('a scanned page keeps its picture beside the doc, sized sensibly, and the doc says which pages are pictures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-docs-'));
  try {
    const d = await readDoc('scan.pdf', await scanned());
    assert.equal(d.pages, 4);
    assert.deepEqual(d.parts.map(p => p.page), [1], 'only page 1 has text; nothing is made up for the others');
    assert.deepEqual(d.pictures?.map(p => p.page), [2, 3, 4]);
    assert.deepEqual(d.pictures?.map(p => p.file), [`${d.id}-p2.jpg`, `${d.id}-p3.jpg`, `${d.id}-p4.png`], 'black and white as PNG, else JPEG');
    assert.deepEqual([d.pictures![0].width, d.pictures![0].height], [1200, 1600], `the big scan is made at most ${PICTURE_PX} on its long side`);
    assert.deepEqual(pagesToRead(d).map(p => p.page), [2, 3, 4]);
    assert.deepEqual(unreadPictures(d), [2, 3, 4]);
    const docs = new Docs(dir);
    await docs.add('0123456789ab', d);
    const folder = join(dir, 'docs', '0123456789ab');
    const names = (await readdir(folder)).sort();
    assert.deepEqual(names, [`${d.id}-p2.jpg`, `${d.id}-p3.jpg`, `${d.id}-p4.png`, `${d.id}.json`]);
    assert.doesNotMatch(await readFile(join(folder, `${d.id}.json`), 'utf8'), /"bytes"|\/9j\//, 'the pictures are not in the .json');
    const meta = await sharp(await readFile(join(folder, `${d.id}-p2.jpg`))).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1200, 1600]);
    const mask = await sharp(await readFile(join(folder, `${d.id}-p4.png`))).raw().toBuffer({ resolveWithObject: true });
    assert.equal(mask.data[0], 255, 'a set mask bit is white');
    assert.equal(mask.data[4 * mask.info.channels], 0, 'a clear mask bit is ink');
    const pic = await docs.picture('0123456789ab', d, 2);
    assert.equal(pic?.type, 'image/jpeg');
    assert.deepEqual((await docs.list('0123456789ab')).map(x => [x.empty, x.pictures]), [[3, 3]]);
    // Without a model that can read pictures, nothing is read and the chat says so plainly.
    assert.equal(await docs.readPictures('0123456789ab', d.id), 0);
    const note = picturesNote([d]);
    assert.match(note, /scan\.pdf: pages 2-4 are pictures \(scanned, with no text\), so they were not read/);
    assert.match(note, /needs a chat model that can read pictures/);
    assert.match(wholeSection([d], 50_000)!, /pages 2-4 are pictures/);
    assert.match(docSection(findParts([d], 'tuning hammer', 3000), note), /pages 2-4 are pictures/);
    assert.match(picturesSaid(d, false), /Pages 2-4 are pictures \(scanned, with no text\), so they are not read\. Their pictures are kept: reading them needs a chat model that can read pictures \(one with its vision file, an mmproj file\) loaded on this PC, and they are read once one is\./);
    assert.match(picturesSaid(d, true), /they are being read from their pictures/);
    // A carried-on chat takes the pictures too; removing the doc takes them away.
    await docs.copy('0123456789ab', 'ba9876543210');
    assert.equal((await readdir(join(dir, 'docs', 'ba9876543210'))).length, 4);
    assert.equal(await docs.remove('0123456789ab', d.id), true);
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a blank page is a page with no text, not a picture', async () => {
  const gray = { w: 100, h: 60, dict: '/ColorSpace /DeviceGray /BitsPerComponent 8', data: new Uint8Array(6000).fill(128) };
  const d = await readDoc('mixed.pdf', makeScanPdf(['Words here.', '', gray]));
  assert.deepEqual(d.pictures?.map(p => p.page), [3]);
  assert.equal(picturesSaid(d, false), ' Page 3 is a picture (scanned, with no text), so it is not read. Its picture is kept: reading it needs a chat model that can read pictures (one with its vision file, an mmproj file) loaded on this PC, and it is read once one is. 1 other page has no text and cannot be read.');
  assert.equal(picturesSaid(await readDoc('manual.pdf', manual()), false), '');
});

test('the research tools read a PDF as before: no pictures are taken out unless asked', async () => {
  let got = 0;
  const pages = await pdfPages(await scanned(), false);
  assert.deepEqual(pages.map(p => !!p), [true, false, false, false]);
  await pdfPages(await scanned(), false, { pictures: () => void got++ });
  assert.equal(got, 3);
});

test('a model that can read pictures fills in the pages, page by page; its words are marked as read from the picture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-docs-'));
  try {
    const d = await readDoc('scan.pdf', await scanned());
    const docs = new Docs(dir);
    await docs.add('0123456789ab', d);
    const asked: Array<[number, string, number]> = [];
    docs.see = async (image, o) => {
      asked.push([o.page, o.type, image.length]);
      return o.page === 3 ? 'The bass strings are copper wound.' : o.page === 4 ? '' : `Scanned page ${o.page} about the soundboard.`;
    };
    // Two readings at once read each page once.
    const [a, b] = await Promise.all([docs.readPictures('0123456789ab', d.id), docs.readPictures('0123456789ab', d.id)]);
    assert.equal(a, 3);
    assert.equal(b, 3);
    assert.deepEqual(asked.map(x => [x[0], x[1]]), [[2, 'image/jpeg'], [3, 'image/jpeg'], [4, 'image/png']]);
    assert.ok(asked.every(x => x[2] > 0));
    const kept = (await docs.all('0123456789ab'))[0];
    assert.deepEqual(kept.parts.map(p => [p.page, !!p.seen]), [[1, false], [2, true], [3, true]]);
    assert.deepEqual(pagesToRead(kept), []);
    assert.equal(picturesNote([kept]), '');
    assert.equal(await docs.readPictures('0123456789ab', d.id), 0, 'nothing left to read');
    const found = findParts([kept], 'copper wound bass strings', 3000);
    assert.equal(found[0].part.page, 3);
    assert.match(docSection(found), /\[scan\.pdf, page 3, read from its picture\]\nThe bass strings are copper wound\./);
    assert.match(wholeText(kept), /\[page 2, read from its picture\]\nScanned page 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a page read from its picture goes in page order; pixels not as expected are left out', () => {
  const d: Doc = { id: 'aaaaaaaaaaaa', name: 's.pdf', kind: 'pdf', pages: 3, chars: 5, at: '', parts: [{ page: 1, text: 'one' }, { page: 3, text: 'three' }], pictures: [{ page: 2, file: 'aaaaaaaaaaaa-p2.jpg' }] };
  const after = withPageText(d, 2, '  two  ');
  assert.deepEqual(after.parts.map(p => p.page), [1, 2, 3]);
  assert.equal(after.pictures![0].read, true);
  assert.deepEqual(unreadPictures(after), []);
  assert.equal(rawOf({ width: 4, height: 4, kind: 2, data: new Uint8Array(48) }), null, 'too small to be a page');
  assert.equal(rawOf({ width: 20, height: 20, kind: 2, data: new Uint8Array(10) }), null, 'too few pixels');
});

/** A 60-page book: each page about its own topic. */
function book(): Uint8Array {
  return makePdf(Array.from({ length: 60 }, (_, i) => [`Page ${i + 1} is about topic number ${i + 1}.`, ...Array.from({ length: 8 }, (_, k) => `Line ${k + 1} of page ${i + 1}: ${'the tuner checks every unison and octave with care '.repeat(2)}`)]));
}

test('a review asks for the whole document, not some of it', () => {
  assert.ok(reviewAsked('Please review this PDF'));
  assert.ok(reviewAsked('Can you summarise the report?'));
  assert.ok(reviewAsked('go through the whole document and proofread it'));
  assert.equal(reviewAsked('What does page 4 say?'), false);
  assert.equal(reviewAsked('How long does a pitch raise take?'), false);
  assert.deepEqual(lastReview('book.pdf pages 13-24 (section 2 of 5)'), { doc: 'book.pdf', n: 2, of: 5 });
  assert.deepEqual(lastReview('my book.pdf page 9 (section 3 of 3)'), { doc: 'my book.pdf', n: 3, of: 3 });
  assert.equal(lastReview('book.pdf pages 1-3'), null);
});

test('a document too long for the context is reviewed in order, a section at a time, and "next section" goes on', async () => {
  const d = await readDoc('book.pdf', book());
  const room = 12_000;
  assert.equal(wholeSection([d], room), null, 'it does not fit whole');
  const sections = reviewSections(d, room - 700);
  assert.ok(sections.length >= 3, `${sections.length} sections`);
  assert.ok(sections.every(s => s.text.length <= room - 700));
  assert.equal(sections[0].from, 1);
  assert.equal(sections.at(-1)!.to, 60);
  for (let i = 1; i < sections.length; i++) assert.equal(sections[i].from, sections[i - 1].to + 1, 'in order, at page ends, nothing left out');
  const first = reviewSection([d], 'Review this PDF please', room)!;
  assert.match(first.sources, /^book\.pdf pages 1-\d+ \(section 1 of \d+\)$/);
  assert.match(first.text, /reviewed in order, a section at a time\. This is section 1 of/);
  assert.match(first.text, /\[page 1\]\nPage 1 is about topic number 1\./);
  assert.match(first.note, /Say "next section" to go on\./);
  assert.ok(first.text.length <= room, `${first.text.length}`);
  const second = reviewSection([d], 'next section', room, first.sources)!;
  assert.match(second.sources, new RegExp(`^book\\.pdf pages ${sections[1].from}-${sections[1].to} \\(section 2 of ${sections.length}\\)$`));
  const third = reviewSection([d], 'section 3', room)!;
  assert.match(third.sources, /\(section 3 of/);
  const last = reviewSection([d], 'go on', room, `book.pdf pages ${sections.at(-2)!.from}-${sections.at(-2)!.to} (section ${sections.length - 1} of ${sections.length})`)!;
  assert.match(last.text, /the last one\./);
  assert.match(last.note, /This is the last section\./);
  assert.equal(reviewSection([d], 'next section', room, last.sources), null, 'after the last section the review is over');
  assert.equal(reviewSection([d], 'next section', room), null, '"next" with no review before is an ordinary message');
  assert.equal(reviewSection([d], 'What is topic number 7?', room), null, 'a question gets the matching parts');
  // It fits whole: the whole documents are sent as before.
  assert.equal(reviewSection([d], 'Review it', 2_000_000), null);
});

test('a review names its document; one that fits alone goes whole, the others left out to make room', async () => {
  const big = await readDoc('book.pdf', book());
  const small = await readDoc('manual.pdf', manual());
  const room = 12_000;
  const r = reviewSection([big, small], 'review book.pdf', room)!;
  assert.match(r.sources, /^book\.pdf pages 1-/);
  const short = { ...small, parts: small.parts.slice(0, 3), name: 'notes.pdf' };
  const alone = reviewSection([big, short], 'review notes', room)!;
  assert.equal(alone.sources, 'notes.pdf (whole)');
  assert.match(alone.text, /The whole of notes\.pdf, in order/);
});
