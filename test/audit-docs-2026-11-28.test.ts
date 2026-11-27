// Audit of the documents, voice and web tools, 28 Nov 2026, and the faults it found (D1-D10), now fixed: each test names
// what must hold. Files are built by hand here (zip and PDF bytes), the web and model stand-ins run on 127.0.0.1 only,
// the voice uses a pretend engine, and the one copy of TOMLIN started (for the document cap) runs in a throwaway home on
// port 8807.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { testEnv, useTestEnv } from './env.ts';
import { ATTACKS } from './promptscan-corpus.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-audit-docs-'));
mkdirSync(join(home, 'models'), { recursive: true });
writeFileSync(join(home, 'models-folder.txt'), join(home, 'models'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_NO_PCLOOK: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });

const { docxText, xlsxSheets } = await import('../src/officefiles.ts');
const { readDoc, wholeText, PDF_MEMORY_MB } = await import('../src/docs.ts');
const { scanText } = await import('../src/promptscan.ts');
const { sayInWords } = await import('../src/phonemes.ts');
const { fetchPublic } = await import('../src/webtools.ts');
const { ResearchTurn, QUOTES_FILE } = await import('../src/researchtools.ts');

const children: ChildProcess[] = [];
test.after(() => {
  for (const c of children) c.kill();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

// ---- files made by hand ----

/** A zip of the given parts, deflated. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const c = deflateRawSync(data);
    const n = Buffer.from(name);
    const sum = crc32(data) >>> 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(sum, 14); l.writeUInt32LE(c.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(8, 10); h.writeUInt32LE(sum, 16); h.writeUInt32LE(c.length, 20); h.writeUInt32LE(data.length, 24); h.writeUInt16LE(n.length, 28); h.writeUInt32LE(off, 42);
    locals.push(l, n, c);
    cds.push(h, n);
    off += 30 + n.length + c.length;
  }
  const cd = Buffer.concat(cds);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(cds.length / 2, 8); e.writeUInt16LE(cds.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}

/** A PDF whose pages each hold one grey picture of w x h (no text: a scanned page), or a line of text. */
function pdf(pages: Array<{ text?: string; image?: { w: number; h: number } }>): Uint8Array {
  const objs: Buffer[] = [];
  const add = (o: Buffer | string) => objs.push(Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'));
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageAt: number[] = [];
  const placeholder = 'PAGES_REF';
  for (const p of pages) {
    let ops = '';
    let img = 0;
    if (p.image) {
      const z = deflateSync(Buffer.alloc(p.image.w * p.image.h, 200), { level: 9 });
      add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`), z, Buffer.from('\nendstream')]));
      img = objs.length;
      ops += 'q 600 0 0 800 0 0 cm /Im0 Do Q\n';
    }
    if (p.text) ops += `BT /F1 12 Tf 40 760 Td (${p.text}) Tj ET\n`;
    add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    const content = objs.length;
    add(`<< /Type /Page /Parent ${placeholder} /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >>${img ? ` /XObject << /Im0 ${img} 0 R >>` : ''} >> /Contents ${content} 0 R >>`);
    pageAt.push(objs.length);
  }
  add(`<< /Type /Pages /Kids [${pageAt.map(k => `${k} 0 R`).join(' ')}] /Count ${pageAt.length} >>`);
  const pagesObj = objs.length;
  add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const cat = objs.length;
  const out: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  let pos = out[0].length;
  const offs: number[] = [];
  objs.forEach((o, i) => {
    const body = o.includes(placeholder) ? Buffer.from(o.toString('latin1').replace(placeholder, `${pagesObj} 0 R`), 'latin1') : o;
    const head = Buffer.from(`${i + 1} 0 obj\n`);
    const tail = Buffer.from('\nendobj\n');
    offs.push(pos);
    out.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  out.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(out));
}

// ---- P0 ----

test('D1: a crafted Excel file of a few kilobytes is read (or refused) in under 2 seconds, so it cannot hold the whole app', () => {
  const book = '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  // Rows that open and never close: each row tag is matched against the rest of the sheet, again and again.
  const rows = zip({ 'xl/workbook.xml': book, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/sheet1.xml': `<sheetData>${'<row r="1">'.repeat(40_000)}</sheetData>` });
  const shared = zip({ 'xl/workbook.xml': book, 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': `<sst>${'<si>'.repeat(40_000)}</sst>`, 'xl/worksheets/sheet1.xml': '<sheetData></sheetData>' });
  for (const [what, bytes] of [['rows without ends', rows], ['shared words without ends', shared]] as const) {
    assert.ok(bytes.length < 4096, 'the file is small');
    const t = performance.now();
    try {
      xlsxSheets(bytes);
    } catch {
      // A plain refusal is fine too.
    }
    const ms = performance.now() - t;
    assert.ok(ms < 2000, `${what}: a ${bytes.length}-byte file held this thread for ${Math.round(ms)} ms`);
  }
  // The same for a Word file whose tags never end.
  const word = zip({ 'word/document.xml': `<w:document><w:body>${'<w:p <w:t '.repeat(40_000)}></w:body></w:document>` });
  const t = performance.now();
  try {
    docxText(word);
  } catch {
    // A plain refusal is fine too.
  }
  assert.ok(performance.now() - t < 2000, 'a Word file of tags that never end held this thread');
  // A cell read as before.
  const fine = zip({ 'xl/workbook.xml': book, 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': '<sst><si><t>Ann</t></si></sst>', 'xl/worksheets/sheet1.xml': '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>12</v></c></row></sheetData>' });
  assert.equal(xlsxSheets(fine)[0].text, 'Ann |  | 12');
});

test('D2: a PDF dropped into a chat is read within its stated memory limit (one page claiming a huge picture)', async () => {
  // One 20,000 x 20,000 grey picture on a page with no text: about 400 KB as a file.
  const bytes = pdf([{ image: { w: 20_000, h: 20_000 } }]);
  assert.ok(bytes.length < 1 << 20);
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  try {
    await readDoc('scan.pdf', bytes).catch(() => null);
  } finally {
    clearInterval(timer);
  }
  const grewMb = (peak - before) / 2 ** 20;
  assert.ok(grewMb < PDF_MEMORY_MB + 256, `reading it took ${Math.round(grewMb)} MB more memory, past the ${PDF_MEMORY_MB} MB limit`);
});

// ---- P1 ----

test('D3: a burst of 20 documents into one chat keeps no more than the chat limit', async () => {
  const h = mkdtempSync(join(tmpdir(), 'tomlin-audit-docs-srv-'));
  mkdirSync(join(h, 'models'), { recursive: true });
  writeFileSync(join(h, 'models-folder.txt'), join(h, 'models'));
  const stand = http.createServer((_q, s) => s.end('[]')).listen(8808, '127.0.0.1');
  const env = testEnv({ TOMLIN_HOME: h, TOMLIN_PORT: '8807', TOMLIN_MODELS_FILE: join(h, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(h, 'startup'), TOMLIN_DESKTOP_DIR: join(h, 'desktop'), TOMLIN_OPEN: '', TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_LOOK_IN: '', TOMLIN_RELEASE_API: 'http://127.0.0.1:8808' });
  const child = spawn(process.execPath, ['src/server.ts'], { env, stdio: 'ignore' });
  children.push(child);
  const base = 'http://127.0.0.1:8807';
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/voice/options`).then(r => r.ok, () => false)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post('/api/staff', { action: 'hire', name: 'Robin', role: 'default', level: 'default' })).status, 200);
    const chat = ((await (await post('/api/chats/new', { who: 'staff:robin' })).json()) as { chat: { id: string } }).chat.id;
    await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${base}/api/chat/doc`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-name': `notes-${i}.txt`, 'x-chat': chat }, body: 'plain words of a text file\n'.repeat(40) }).then(r => r.text())));
    const kept = readdirSync(join(h, 'data', 'docs', chat)).filter(n => n.endsWith('.json')).length;
    assert.ok(kept <= 8, `${kept} documents were kept in one chat; the limit is 8`);
  } finally {
    child.kill();
    stand.close();
    await new Promise(r => setTimeout(r, 500));
    rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('D4: a known attack line in a long document is flagged, or the person is told the scan did not read it all', async () => {
  const para = 'The quarterly figures for the northern region were steady and the team met its goals.\n';
  const text = para.repeat(Math.ceil(1_100_000 / para.length)) + ATTACKS[0][1] + '\n';
  const d = await readDoc('report.txt', new TextEncoder().encode(text));
  const s = scanText(`report.txt\n\n${wholeText(d)}`, { long: false });
  assert.ok(s.suspect || s.unreadFrom !== undefined, 'the line past the first million characters was not read, and nothing says so');
  if (!s.suspect) assert.match(s.reasons.join(' '), /the rest was not read/);
  // A short document is read through: nothing is said about it.
  const short = scanText(para.repeat(50), { long: false });
  assert.equal(short.unreadFrom, undefined);
  assert.deepEqual(short.reasons, []);
});

test('D5: a UTF-16 text file (as Windows PowerShell and Notepad "Unicode" save) is read as text', async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name,total\r\nAnn,12\r\n', 'utf16le')]);
  const d = await readDoc('sheet.csv', new Uint8Array(bytes));
  assert.match(wholeText(d), /Ann,12/);
  assert.ok(!wholeText(d).startsWith('﻿'), 'the mark at the start is not part of the text');
  // With no mark at the start, and big-end first.
  assert.match(wholeText(await readDoc('notes.txt', new Uint8Array(Buffer.from('Plain notes about the trip to the coast.\n', 'utf16le')))), /trip to the coast/);
  const be = Buffer.from('Big end first.\n', 'utf16le').swap16();
  assert.match(wholeText(await readDoc('be.txt', new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))), /Big end first/);
  // A program is still refused, and UTF-8 is still read as UTF-8.
  await assert.rejects(readDoc('a.txt', new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0])), /not plain text/);
  assert.match(wholeText(await readDoc('u.txt', new TextEncoder().encode('Café crème\n'))), /Café crème/);
});

test('D6: only one voice-over is read at a time, also when 20 Speak presses arrive together', async () => {
  const { voicePost, setVoiceEngine } = await import('../src/server/voice.ts');
  let live = 0;
  let most = 0;
  setVoiceEngine({ rate: 24_000, async say(tokens: number[]) { live++; most = Math.max(most, live); await new Promise(r => setTimeout(r, 20)); live--; return new Float32Array(tokens.length * 60).fill(0.1); } });
  const call = async (b: unknown) => {
    let status = 0;
    const res = { writeHead(s: number) { status = s; return this; }, end() { /* body not needed */ } };
    await (voicePost as Record<string, (x: unknown) => Promise<void>>)['/api/voice/speak']({ res, b });
    return status;
  };
  try {
    const said = await Promise.all(Array.from({ length: 20 }, (_, i) => call({ text: `Line ${i}. Hello there.` })));
    assert.equal(most, 1, `${most} voice-overs were read at once`);
    assert.equal(said.filter(s => s === 200).length, 1, 'one was read');
    assert.equal(said.filter(s => s === 409).length, 19, 'the others were told one is being read');
    // Once it is done, the next press is read.
    assert.equal(await call({ text: 'One more line.' }), 200);
  } finally {
    setVoiceEngine(null);
  }
});

test('D7: a voice-over reads every digit of a long number (an order or reference number)', () => {
  const said = sayInWords('Order 123456789012345678 is ready.');
  const digits = 'zero one two three four five six seven eight nine'.split(' ');
  const want = '123456789012345678'.split('').map(d => digits[Number(d)]).join(' ');
  assert.ok(said.includes(want), `read as: ${said}`);
  // With thousands commas and as an ordinal too; a smaller number is still said as a number.
  assert.match(sayInWords('Ref 9,007,199,254,740,993.'), /nine zero zero seven one nine nine two five four seven four zero nine nine three/);
  assert.match(sayInWords('the 12345678901234567th'), /one two three four five six seven eight nine zero one two three four five six seventh/);
  assert.match(sayInWords('Order 1205 of 30500.'), /thirty thousand five hundred/);
});

test('D8: a web page that sends a little every few seconds is given up on within 35 seconds', async () => {
  const stand = http.createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'text/html' });
    const t = setInterval(() => (s.destroyed ? clearInterval(t) : s.write('<p>x</p>')), 2000);
  }).listen(8809, '127.0.0.1');
  const ac = new AbortController();
  const ours = setTimeout(() => ac.abort(), 40_000);
  let why = '';
  try {
    await fetchPublic('http://127.0.0.1:8809/', { signal: ac.signal, maxBytes: 1 << 20, publicOnly: false });
  } catch (e) {
    why = (e as Error).message;
  } finally {
    clearTimeout(ours);
    stand.closeAllConnections();
    stand.close();
  }
  assert.ok(!ac.signal.aborted, `the fetch never gave up by itself (ended only by the test's own stop: ${why})`);
  assert.match(why, /still coming after \d+ seconds, so it was given up/);
});

test('D9: keeping a quote never cuts an existing quotes file down to the new quote', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tomlin-audit-docs-ws-'));
  try {
    mkdirSync(join(root, 'research'));
    const old = `# Quotes\n\n${Array.from({ length: 1000 }, (_, i) => `- 2026-01-01: claim ${i}\n  > ${'an old quote kept from a source long ago '.repeat(25)}\n  Source: https://e.example/${i}\n`).join('')}`;
    writeFileSync(join(root, QUOTES_FILE), old);
    const t = new ResearchTurn({ root, perCall: 4000, page: (u: string) => ({ url: u, title: 'p', text: 'The river is four hundred miles long and very wide.' }) });
    const said = await t.run('keep_quote', JSON.stringify({ claim: 'The river is long', quote: 'The river is four hundred miles long', source: 'https://e.example/p' }));
    const after = readFileSync(join(root, QUOTES_FILE), 'utf8');
    assert.ok((after.match(/^- /gm) ?? []).length >= 1000, `quotes.md now holds ${(after.match(/^- /gm) ?? []).length} quote(s); it held 1000`);
    // It was too big to add to here: the model is told so, and how a new one is started.
    assert.equal(after, old);
    assert.match(said, /^Not kept: .*could not be read \(it is over 1 MB.*moving it or renaming it starts a new one/);
    // With no file there, the quote starts a new one.
    rmSync(join(root, QUOTES_FILE));
    assert.match(await t.run('keep_quote', JSON.stringify({ claim: 'The river is long', quote: 'The river is four hundred miles long', source: 'https://e.example/p' })), /^Kept as quote 1/);
    assert.match(readFileSync(join(root, QUOTES_FILE), 'utf8'), /^# Quotes[\s\S]*> The river is four hundred miles long/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D10: scanned pages are read by a chat model here that can read pictures, and with none the person is told so truly', async () => {
  const { docStore, pageReaderOn, SEE_PAGE_SYSTEM } = await import('../src/server/chat.ts');
  const { Docs, pagesToRead, picturesSaid } = await import('../src/docs.ts');
  // No model is loaded here: nothing reads the pictures, and the words say what reading them needs.
  assert.equal(docStore.see, null);
  const d = await readDoc('scan.pdf', pdf([{ text: 'Page one has words.' }, { image: { w: 240, h: 320 } }]));
  assert.deepEqual(pagesToRead(d).map(p => p.page), [2]);
  assert.match(picturesSaid(d, !!docStore.see), /Page 2 is a picture .*needs a chat model that can read pictures .*loaded on this PC, and it is read once one is\./);
  // A stand-in for llama-server started with a vision file: it is sent the page's picture as the chat sends a picture.
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const stand = http.createServer((q, s) => {
    let raw = '';
    q.on('data', c => (raw += c));
    q.on('end', () => {
      bodies.push(JSON.parse(raw));
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      s.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The tuning hammer is kept in the case.' } }] })}\n\ndata: [DONE]\n\n`);
    });
  }).listen(8810, '127.0.0.1');
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-audit-docs-see-'));
  try {
    const docs = new Docs(dir);
    await docs.add('0123456789ab', d);
    // Set as the chat sets it, to the model here that reads pictures (none is loaded in a test: the stand-in instead).
    docs.seer = () => pageReaderOn('http://127.0.0.1:8810', 'stand-in-vl.gguf');
    assert.equal(await docs.readPictures('0123456789ab', d.id), 1);
    const sent = bodies[0].messages;
    assert.ok(sent.some(m => m.role === 'system' && String(m.content).includes(SEE_PAGE_SYSTEM.slice(0, 40))), 'it is told to write out the words only');
    const user = sent.find(m => m.role === 'user')!.content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    assert.ok(Array.isArray(user) && user.some(p => p.type === 'image_url' && /^data:image\/(jpeg|png);base64,/.test(p.image_url!.url)), 'the picture went with the message');
    const kept = (await docs.all('0123456789ab'))[0];
    assert.deepEqual(pagesToRead(kept), []);
    assert.match(wholeText(kept), /\[page 2, read from its picture\]\nThe tuning hammer is kept in the case\./);
  } finally {
    stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
