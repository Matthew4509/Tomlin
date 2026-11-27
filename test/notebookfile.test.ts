import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGroup, DEFAULT_GROUP, parseBook, writeBook } from '../src/notebookfile.ts';
import { buildChat, cleanEntry, ENTRY_MAX, Notebooks, NOTEBOOK_MAX_CHARS, pickLines, rememberCommand, type NoteLine } from '../src/memory.ts';
import { Store } from '../src/store.ts';

const temp = () => mkdtemp(join(tmpdir(), 'sm-nbfile-'));

test('a notebook file reads back the same entries it was written with, odd ones too', () => {
  const entries = [
    { group: 'Always send', text: 'The shop is Tomlin & Co, never Tomlin and Co.' },
    { group: 'Style guide', text: 'Warm light, no text in pictures.\nKeep faces out of product shots.' },
    // Lines that look like Markdown of their own: a bullet, a heading, an indent, a blank line.
    { group: 'Style guide', text: 'Price list:\n- tea 3.50\n- cake 4.00\n## not a heading\n    indented code\n\nafter a blank line' },
    { group: 'Notes', text: '# also not the title' },
  ];
  const text = writeBook('Memory: Fern (artist)', ['Always send', 'Style guide', 'Notes', 'Empty one'], entries);
  assert.ok(text.startsWith('# Memory: Fern (artist)\n\n## Always send\n\n- The shop'));
  const back = parseBook(text);
  assert.deepEqual(back.entries, entries);
  // A group with nothing in it yet is kept.
  assert.deepEqual(back.groups, ['Always send', 'Style guide', 'Notes', 'Empty one']);
  // And again, with Windows line ends and a byte-order mark (Notepad's "UTF-8 with BOM").
  assert.deepEqual(parseBook(`﻿${text.replace(/\n/g, '\r\n')}`).entries, entries);
});

test('a file written by hand loads as best it can: blocks, stray spaces, no headings, a "#" further down', () => {
  const hand = [
    'Text before any heading goes under Notes.',
    '',
    '##   Style guide   ',
    'Warm light, no text in pictures.   ',
    'Keep faces out of product shots.',
    '',
    '* star bullet',
    '+ plus bullet',
    '-not a bullet without a space',
    '',
    '',
    '##',
    '## Rules',
    '- one',
    '  carried on',
    'lazy carried on',
    '',
    '# Later heading',
    '- under it',
  ].join('\n');
  const b = parseBook(hand);
  assert.deepEqual(b.entries, [
    { group: DEFAULT_GROUP, text: 'Text before any heading goes under Notes.' },
    { group: 'Style guide', text: 'Warm light, no text in pictures.\nKeep faces out of product shots.' },
    { group: 'Style guide', text: 'star bullet' },
    { group: 'Style guide', text: 'plus bullet\n-not a bullet without a space' },
    { group: 'Rules', text: 'one\ncarried on\nlazy carried on' },
    { group: 'Later heading', text: 'under it' },
  ]);
  assert.deepEqual(b.groups, ['Notes', 'Style guide', 'Rules', 'Later heading']);
  assert.equal(cleanGroup('  ## Too   many  '), 'Too many');
  assert.equal(cleanGroup(''), DEFAULT_GROUP);
  // Empty and title-only files have no entries.
  assert.deepEqual(parseBook('').entries, []);
  assert.deepEqual(parseBook('# Memory: x\n').entries, []);
});

test('a 2 MB notebook file reads in well under a second', () => {
  const block = `- ${'word '.repeat(60).trim()}\n  ${'more '.repeat(40).trim()}\n`;
  const text = `# Memory\n\n## Notes\n\n${block.repeat(Math.ceil(2_000_000 / block.length))}`;
  const t = performance.now();
  const b = parseBook(text);
  assert.ok(performance.now() - t < 1000);
  assert.ok(b.entries.length > 3000);
});

test('the JSON notebook of 2.1.27 moves into the .md once: ids and dates kept, pins under Pinned, JSON kept as .bak', async () => {
  const dir = await temp();
  try {
    await mkdir(join(dir, 'memory'));
    const old: NoteLine[] = [
      { id: 'a1', text: 'The shop closes on Mondays', at: '2026-10-01T10:00:00.000Z', from: 'owner' },
      { id: 'b2', text: 'A pinned answer', at: '2026-10-02T10:00:00.000Z', from: 'pin' },
      { id: 'c3', text: 'Sam likes short answers', at: '2026-10-03T10:00:00.000Z', from: 'suggested' },
    ];
    await writeFile(join(dir, 'memory', 'staff-fern.json'), JSON.stringify(old));
    const books = new Notebooks(new Store(dir), () => 'Memory: Fern (artist)');
    const got = await books.read('staff:fern');
    assert.deepEqual(got.map(l => [l.id, l.from, l.group, l.at]), [['a1', 'owner', 'Notes', '2026-10-01T10:00:00.000Z'], ['c3', 'suggested', 'Notes', '2026-10-03T10:00:00.000Z'], ['b2', 'pin', 'Pinned', '2026-10-02T10:00:00.000Z']]);
    const md = await readFile(join(dir, 'memory', 'staff-fern.md'), 'utf8');
    assert.equal(md, '# Memory: Fern (artist)\n\n## Notes\n\n- The shop closes on Mondays\n- Sam likes short answers\n\n## Pinned\n\n- A pinned answer\n');
    assert.ok(!existsSync(join(dir, 'memory', 'staff-fern.json')));
    assert.ok(existsSync(join(dir, 'memory', 'staff-fern.json.bak')));
    // Read again: the same, from the .md (the JSON is gone).
    assert.deepEqual((await books.read('staff:fern')).map(l => l.id), ['a1', 'c3', 'b2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the file is the truth: an edit in Notepad is read on the next ask; a lost sidecar still loads, as his, with ids that hold', async () => {
  const dir = await temp();
  try {
    const books = new Notebooks(new Store(dir));
    const a = await books.add('team', 'Prices include VAT', 'pin');
    assert.ok(!('error' in a));
    const file = books.fileOf('team');
    // He opens the file in Notepad, adds a group and an entry, and saves it with Windows line ends.
    const md = await readFile(file, 'utf8');
    await writeFile(file, `${md}\r\n## Style guide\r\nWarm light.\r\nNo text in pictures.\r\n`.replace(/(?<!\r)\n/g, '\r\n'));
    const now = await books.read('team');
    assert.deepEqual(now.map(l => [l.text, l.group, l.from]), [['Prices include VAT', 'Pinned', 'pin'], ['Warm light.\nNo text in pictures.', 'Style guide', 'owner']]);
    // The sidecar goes: the entries still load, as his, and an id read once is the same on the next read.
    await rm(file.replace(/\.md$/, '.meta.json'));
    const one = await books.read('team');
    const two = await books.read('team');
    assert.ok(one.every(l => l.from === 'owner'));
    assert.deepEqual(one.map(l => l.id), two.map(l => l.id));
    // So the page can still change one by its id.
    const e = await books.edit('team', one[1].id, 'Warm light, always.');
    assert.equal((e as NoteLine).text, 'Warm light, always.');
    // Each change keeps the file as it was before as .md.bak.
    assert.match(await readFile(`${file}.bak`, 'utf8'), /No text in pictures/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an entry with a key in it, typed in Notepad, stays in the file but is never sent; the app refuses to keep one', async () => {
  const dir = await temp();
  try {
    const books = new Notebooks(new Store(dir));
    await books.add('team', 'Invoices go out on the first', 'owner');
    const file = books.fileOf('team');
    await writeFile(file, `${await readFile(file, 'utf8')}- password: hunter2hunter2\n`);
    const book = await books.book('team');
    assert.equal(book.entries.length, 2);
    assert.ok(book.entries[1].withheld);
    assert.match(book.problems.join(' '), /never sent to a model/);
    assert.deepEqual((await books.read('team')).map(l => l.text), ['Invoices go out on the first']);
    // A change to another entry keeps it in the file (it is his, not the app's to drop).
    await books.add('team', 'Another', 'owner');
    assert.match(await readFile(file, 'utf8'), /hunter2/);
    const r = await books.add('team', 'the api key is sk-abcdefghijklmnopqrstuvwxyz123456', 'owner');
    assert.ok('error' in r);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('entries keep 4,000 characters and their lines; 4,001 is refused in plain words; the notebook has a size cap', async () => {
  const dir = await temp();
  try {
    const books = new Notebooks(new Store(dir));
    const guide = `Style guide\n\n${Array.from({ length: 80 }, (_, i) => `- rule ${i}: ${'x'.repeat(30)}`).join('\n')}`.slice(0, ENTRY_MAX);
    const kept = await books.add('staff:fern', guide, 'owner');
    assert.equal((kept as NoteLine).text, cleanEntry(guide));
    assert.ok((kept as NoteLine).text.includes('\n- rule 1:'));
    const r = await books.add('staff:fern', 'y'.repeat(ENTRY_MAX + 1), 'owner');
    assert.match((r as { error: string }).error, /at most 4,000 characters, and this one has 4,001/);
    // Spaces inside a line fold, indents stay, three blank lines become one.
    assert.equal(cleanEntry('a    b\r\n\r\n\r\n\r\n    indented   c  '), 'a b\n\n    indented c');
    // Full by characters: 100,000.
    for (let i = 0; (await books.book('staff:fern')).entries.reduce((n, e) => n + e.text.length, 0) + 3900 <= NOTEBOOK_MAX_CHARS; i++) await books.add('staff:fern', `${i} ${'z'.repeat(3890)}`, 'owner');
    const full = await books.add('staff:fern', 'q'.repeat(3950), 'owner');
    assert.match((full as { error: string }).error, /full \(100,000 characters\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('"remember:" keeps the whole rest of the message, its lines too', () => {
  assert.deepEqual(rememberCommand('remember: the price list\n- tea 3.50\n- cake 4.00'), { team: false, text: 'the price list\n- tea 3.50\n- cake 4.00' });
});

test('sending: Always send goes first, a group name counts as words, a long entry is cut (never dropped), the Inbox is never read', async () => {
  const n = (text: string, group: string, i: number): NoteLine => ({ id: `n${i}`, text, at: '', from: 'owner', group });
  const lines = [n('Prices include VAT', 'Notes', 1), n('Warm light.\nNo text in pictures.', 'Style guide', 2), n('Spelled Tomlin & Co', 'Always send', 3), n(`Long one about cakes\n${'cake line\n'.repeat(400)}`, 'Notes', 4)];
  const got = pickLines(lines, 'what style should the pictures have?', 70);
  assert.deepEqual(got.lines.map(l => l.id), ['n2', 'n3']);
  // A long entry on the topic with too little room: its first lines and a note.
  const cakes = pickLines(lines, 'cakes', 600);
  const cut = cakes.lines.find(l => l.id === 'n4')!;
  assert.ok(cut && cut.text.startsWith('Long one about cakes\ncake line') && /more lines left out/.test(cut.text));
  assert.equal(cakes.cut, 1);
  // The sent text names the groups when there are several, with the lines of an entry indented under it.
  const c = buildChat({ ctx: 8192, maxAnswer: 2048, card: 'card', team: lines.slice(0, 3), own: null, name: 'Fern', history: [], message: 'hi' });
  assert.match(c.turns[0].content, /Notes:\n- Prices include VAT\nStyle guide:\n- Warm light\.\n {2}No text in pictures\.\nAlways send:\n- Spelled Tomlin & Co/);
  const dir = await temp();
  try {
    const books = new Notebooks(new Store(dir));
    await books.add('team', 'kept', 'owner');
    await books.add('team', 'waiting for him', 'suggested', 'Inbox');
    assert.deepEqual((await books.read('team')).map(l => l.text), ['kept']);
    assert.equal((await books.book('team')).entries.length, 2);
    assert.ok((await stat(books.fileOf('team'))).size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Text view: read back first (check keeps nothing), kept in the file layout, who and when kept for what did not change, refused when the file changed meanwhile', async () => {
  const dir = await temp();
  try {
    const books = new Notebooks(new Store(dir));
    const a = (await books.add('team', 'Prices include VAT', 'pin')) as NoteLine;
    const { text, mtime } = await books.text('team');
    const typed = `${text}\n## Style guide\nWarm light.\nNo text in pictures.\n\n- password: hunter2hunter2\n`;
    const seen = await books.saveText('team', typed, mtime, true);
    assert.ok(!('error' in seen) && seen.entries === 3 && seen.groups.includes('Style guide') && /never sent/.test(seen.problems.join(' ')));
    assert.equal((await books.book('team')).entries.length, 1, 'check keeps nothing');
    const kept = await books.saveText('team', typed, mtime);
    assert.ok(!('error' in kept));
    const after = await books.book('team');
    assert.deepEqual(after.entries.map(e => [e.text, e.group]), [['Prices include VAT', 'Pinned'], ['Warm light.\nNo text in pictures.', 'Style guide'], ['password: hunter2hunter2', 'Style guide']]);
    assert.equal(after.entries[0].id, a.id);
    assert.equal(after.entries[0].from, 'pin');
    // Written back in the file's own layout (the block became a bullet with its line indented).
    assert.match(await readFile(books.fileOf('team'), 'utf8'), /## Style guide\n\n- Warm light\.\n {2}No text in pictures\./);
    // The page's copy is older than the file now: refused, nothing written over.
    const late = await books.saveText('team', '# x\n- gone\n', mtime);
    assert.ok('error' in late && late.changed);
    assert.equal((await books.book('team')).entries.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('groups: add, rename (its entries go with it), remove only when empty; order puts entries where they were dropped', async () => {
  const dir = await temp();
  try {
    const books = new Notebooks(new Store(dir));
    const one = (await books.add('team', 'one', 'owner')) as NoteLine;
    const two = (await books.add('team', 'two', 'owner')) as NoteLine;
    assert.deepEqual(await books.group('team', 'add', 'Prices'), { groups: ['Notes', 'Prices'] });
    assert.ok('error' in (await books.group('team', 'add', 'prices ')), 'the same name in other letters');
    assert.ok('error' in (await books.group('team', 'add', 'Prices')));
    await books.edit('team', two.id, undefined, 'Prices');
    assert.ok('error' in (await books.group('team', 'remove', 'Prices')), 'not while it has entries');
    await books.group('team', 'rename', 'Prices', 'Price list');
    assert.deepEqual((await books.book('team')).entries.map(e => [e.text, e.group]), [['one', 'Notes'], ['two', 'Price list']]);
    await books.edit('team', two.id, undefined, 'Notes');
    assert.deepEqual(await books.group('team', 'remove', 'Price list'), { groups: ['Notes'] });
    await books.order('team', [two.id, one.id]);
    assert.deepEqual((await books.read('team')).map(l => l.text), ['two', 'one']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
