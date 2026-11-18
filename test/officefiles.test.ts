import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { csvTable, docxText, officeKind, TEXT_MOST, unzip, xlsxSheets, ZIP_ENTRY_MOST, ZIP_READ_MOST, ZIP_TOTAL_MOST } from '../src/officefiles.ts';

/** A zip made here for the tests: each file packed (or stored), then the list of parts and the end record. */
export function zipOf(files: Record<string, string | Uint8Array>, o: { store?: boolean; lieSize?: number } = {}): Uint8Array {
  const parts: Buffer[] = [];
  const list: Buffer[] = [];
  let at = 0;
  for (const [name, body] of Object.entries(files)) {
    const raw = Buffer.from(body);
    const data = o.store ? raw : deflateRawSync(raw);
    const nm = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(o.store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(o.lieSize ?? raw.length, 22);
    local.writeUInt16LE(nm.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(o.store ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(o.lieSize ?? raw.length, 24);
    central.writeUInt16LE(nm.length, 28);
    central.writeUInt32LE(at, 42);
    parts.push(local, nm, data);
    list.push(central, nm);
    at += 30 + nm.length + data.length;
  }
  const dir = Buffer.concat(list);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

const DOCX = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Sales rose </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>12%</w:t></w:r><w:r><w:t> &amp; costs fell.</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p><w:p><w:r><w:t>(new)</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100 | 5</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>line two</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p><w:p/>
</w:body></w:document>`;

export const docxOf = (xml = DOCX) => zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml, 'word/styles.xml': '<w:styles/>' });

export function xlsxOf(): Uint8Array {
  return zipOf({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sales &amp; costs" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/other.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Region</t></si><si><t>Sales</t></si><si><r><t>Nor</t></r><r><t>th</t></r></si><si><t>South</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100.5</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3" t="inlineStr"><is><t>late</t></is></c><c r="D3" t="b"><v>1</v></c></row><row r="4"><c r="A4" s="2"/></row></sheetData></worksheet>',
    'xl/worksheets/other.xml': '<worksheet><sheetData/></worksheet>',
  });
}

test('a zip is unpacked by name, packed or stored; what is not a zip, or is damaged, is said plainly', () => {
  for (const store of [false, true]) {
    const got = unzip(zipOf({ 'a.txt': 'alpha', 'dir/b.txt': 'beta' }, { store }), n => n.endsWith('b.txt'));
    assert.deepEqual([...got.keys()], ['dir/b.txt']);
    assert.equal(Buffer.from(got.get('dir/b.txt')!).toString(), 'beta');
  }
  assert.throws(() => unzip(new TextEncoder().encode('just some text, long enough to look at'), () => true), /not a file of this kind/);
  const cut = zipOf({ 'a.txt': 'alpha' });
  cut[0] = 0;
  assert.throws(() => unzip(cut, () => true), /damaged/);
});

test('a part that would unpack past the limit is refused, whatever size it claims', () => {
  assert.throws(() => unzip(zipOf({ 'big.xml': 'x' }, { lieSize: ZIP_ENTRY_MOST + 1 }), () => true), /unpacks to more than can be read/);
  // It says it is small; zlib is given the limit itself, so the unpacking stops there.
  const bomb = zipOf({ 'big.xml': new Uint8Array(ZIP_ENTRY_MOST + 1024) }, { lieSize: 10 });
  assert.ok(bomb.length < 200_000, 'the packed file is small');
  assert.throws(() => unzip(bomb, () => true));
});

test('parts that each say they hold nothing are counted by what they really unpack to, and stop at the total; too many parts are refused', () => {
  // Each sheet is under the one-part limit and says 0 bytes; together they are more than the total may be.
  const sheet = new Uint8Array(30 * 2 ** 20);
  const files: Record<string, Uint8Array> = {};
  for (let i = 1; i <= 4; i++) files[`xl/worksheets/sheet${i}.xml`] = sheet;
  const bomb = zipOf(files, { lieSize: 0 });
  assert.ok(bomb.length < 1_000_000, 'the packed file is small');
  assert.ok(4 * sheet.length > ZIP_TOTAL_MOST);
  assert.throws(() => unzip(bomb, () => true), /unpacks to more than can be read/);
  // Many small parts: only so many are read.
  const many: Record<string, string> = {};
  for (let i = 0; i <= ZIP_READ_MOST; i++) many[`xl/worksheets/s${i}.xml`] = '<x/>';
  assert.throws(() => unzip(zipOf(many), () => true), /too many parts/);
  assert.equal(unzip(zipOf(many), n => !n.endsWith('0.xml')).size > 0, true, 'fewer wanted: read');
});

test('a Word file is read as lines, its table as rows, its marks as the characters they stand for', () => {
  assert.equal(docxText(docxOf()), ['Quarterly report', 'Sales rose 12% & costs fell.', 'Region | Sales', 'North (new) | 100 / 5', '', 'Line one\nline two\ttabbed'].join('\n'));
  assert.throws(() => docxText(zipOf({ 'other.xml': '<x/>' })), /no document text/);
});

test('an Excel file is read sheet by sheet: shared words, numbers as stored, gaps kept in their column', () => {
  const sheets = xlsxSheets(xlsxOf());
  assert.deepEqual(sheets.map(s => s.label), ['sheet "Sales & costs"', 'sheet "Empty"']);
  assert.equal(sheets[0].text, ['Region | Sales', 'North | 100.5', 'South |  | late | TRUE'].join('\n'));
  assert.equal(sheets[1].text, '');
  assert.throws(() => xlsxSheets(docxOf()), /no workbook/);
});

test('a small Excel file naming far-off columns cannot fill the memory: past Excel\'s last column is refused, and the text read is capped', () => {
  const book = '<workbook><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const of = (rows: string) => zipOf({ 'xl/workbook.xml': book, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>` });
  // 573 bytes that asked for 308 million cells: 11 s and 2 GB before this.
  const t0 = Date.now();
  assert.throws(() => xlsxSheets(of('<row><c r="ZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row>')), /column/);
  // The last column Excel has, on every one of 20,000 rows: about 1 GB of text before this.
  const wide = xlsxSheets(of('<row><c r="XFD1" t="inlineStr"><is><t>x</t></is></c></row>'.repeat(20000)));
  assert.ok(wide[0].text.length <= TEXT_MOST + 200, `${wide[0].text.length} characters`);
  assert.match(wide[0].text, /cut here/);
  assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
  // One cell at Excel's last column still reads, in its place.
  assert.equal(xlsxSheets(of('<row><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="D1" t="inlineStr"><is><t>d</t></is></c></row>'))[0].text, 'a |  |  | d');
});

test('a Word file with a character mark past the last one there is still read', () => {
  assert.equal(docxText(docxOf('<w:document><w:body><w:p><w:r><w:t>a&#99999999;b&#x110000;c</w:t></w:r></w:p></w:body></w:document>')), 'a�b�c');
});

test('a CSV is a table of rows; the kinds of file are told by their ending', () => {
  assert.equal(csvTable('a,b\n"x, y",2\n'), 'a | b\nx, y | 2');
  assert.deepEqual(['r.DOCX', 'r.xlsx', 'r.csv', 'r.tsv', 'r.pdf', 'r.doc', 'r.txt', 'r'].map(officeKind), ['docx', 'xlsx', 'csv', 'csv', 'pdf', null, null, null]);
});
