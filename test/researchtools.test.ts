import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_SYSTEM, FOLD_KEEP_ROUNDS, NOTES_FILE, NOTES_MOST, QUOTES_FILE, RESEARCH_TOOLS, ResearchTurn, findPassages, foldToolTurns, isResearchTool, plainText, quoteIn, quotedIn, researchDefs, researchFree, researchReadsFile, type PageSeen } from '../src/researchtools.ts';
import { docxOf, xlsxOf } from './officefiles.test.ts';

const PAGE: PageSeen = {
  url: 'https://a.example/report',
  title: 'The report',
  text: `${'Filler about nothing in particular. '.repeat(40)}The mill was built in 1894 by the \u201cHarlow\u201d brothers, and it closed in 1971 after the flood.\n\n${'More filler that says little. '.repeat(40)}Its wheel was 9 metres across \u2014 the largest in the county.`,
};
const DAY = () => new Date(2026, 10, 10);
const args = (o: unknown) => JSON.stringify(o);

async function turn(o: { second?: ConstructorParameters<typeof ResearchTurn>[0]['second']; root?: string | null; perCall?: number } = {}) {
  const root = o.root === undefined ? await mkdtemp(join(tmpdir(), 'rt-')) : o.root;
  const t = new ResearchTurn({ root, perCall: o.perCall ?? 3000, page: u => (u.replace(/\/$/, '') === PAGE.url ? PAGE : null), second: o.second, today: DAY });
  return { t, root: root as string, end: () => (root ? rm(root, { recursive: true, force: true }) : Promise.resolve()) };
}

test('the tools are a closed list; a chat with no folder is not offered the one that only reads files', () => {
  assert.deepEqual(RESEARCH_TOOLS.map(t => t.function.name), ['find_in_text', 'keep_quote', 'keep_note', 'read_notes', 'read_document', 'calculate', 'table_stats', 'check_draft']);
  assert.ok(isResearchTool('keep_quote') && !isResearchTool('save_note'));
  assert.ok(!researchDefs({ folder: false }).some(t => t.function.name === 'read_document'));
  assert.ok(researchFree('calculate') && researchFree('read_notes') && !researchFree('keep_quote'));
  assert.ok(researchReadsFile('read_document', '{}') && researchReadsFile('find_in_text', args({ source: 'a.txt' })) && researchReadsFile('table_stats', args({ path: 'a.csv' })));
  assert.ok(!researchReadsFile('find_in_text', args({ source: 'https://a.example/x' })) && !researchReadsFile('table_stats', args({ text: 'a,b' })) && !researchReadsFile('keep_note', '{}'));
});

test('text is matched in one plain form: spacing, curly quotes, long dashes and a word broken over a line do not matter', () => {
  assert.equal(plainText('  The \u201cHarlow\u201d  bro-\nthers \u2014 it\u2019s\u00ad  SO '), 'the "harlow" brothers - it\'s so');
  assert.ok(quoteIn([{ label: 'p', text: PAGE.text }], 'built in 1894 by the "Harlow" brothers'));
  assert.ok(quoteIn([{ label: 'p', text: PAGE.text }], 'Its wheel was 9 metres across - the largest'));
  assert.equal(quoteIn([{ label: 'p', text: PAGE.text }], 'built in 1984 by the Harlow brothers'), null, 'one digit changed');
  assert.deepEqual(quoteIn([{ label: 'page 1', text: 'It ends at the' }, { label: 'page 2', text: 'top of the next page.' }], 'ends at the top of the next'), { piece: 'page 1' }, 'over a page break');
});

test('find_in_text gives the passage that holds the words, from a long page, and says when nothing does', async () => {
  const { t, end } = await turn();
  try {
    const got = await t.run('find_in_text', args({ source: PAGE.url, query: 'closed in 1971' }));
    assert.match(got, /^1 passage in https:\/\/a\.example\/report for "closed in 1971":/);
    assert.match(got, /the phrase itself:\n…?.*it closed in 1971 after the flood/s);
    assert.ok(got.length < 900, 'a passage, not the page');
    const loose = await t.run('find_in_text', args({ source: PAGE.url, query: 'wheel metres county largest' }));
    assert.match(loose, /the whole phrase is not there; these hold the most of its words/);
    assert.match(loose, /9 metres across/);
    const none = await t.run('find_in_text', args({ source: PAGE.url, query: 'zebra crossing' }));
    assert.match(none, /^Nothing in .* holds "zebra crossing"/);
    assert.match(none, /Do not state what it says about this/);
    assert.match(await t.run('find_in_text', args({ source: 'https://b.example/never', query: 'x y z' })), /was not opened in this answer/);
    assert.match(await t.run('find_in_text', args({ source: PAGE.url })), /Say the words/);
    assert.deepEqual(t.uses.map(u => u.ok), [true, true, true, false, false]);
  } finally {
    await end();
  }
  assert.equal(findPassages([{ label: 'p', text: 'alpha beta gamma' }], '').length, 0);
});

test('keep_quote keeps a quote only when its words are in the source; a reworded one is refused with what the source says', async () => {
  const { t, root, end } = await turn();
  try {
    const ok = await t.run('keep_quote', args({ claim: 'The mill shut in 1971.', quote: '\u201cit closed in  1971 after the flood\u201d', source: `${PAGE.url}/` }));
    assert.equal(ok, 'Kept as quote 1: the words are in https://a.example/report.');
    const file = await readFile(join(root, QUOTES_FILE), 'utf8');
    assert.match(file, /^# Quotes\n\nEach quote here was found, word for word, in its source when it was kept\.\n\n- 2026-11-10: The mill shut in 1971\.\n {2}> it closed in 1971 after the flood\n {2}Source: https:\/\/a\.example\/report\n$/);

    const bad = await t.run('keep_quote', args({ claim: 'The mill shut in 1975.', quote: 'the mill was closed in 1975 following a fire', source: PAGE.url }));
    assert.match(bad, /^Not kept: those words are not in https:\/\/a\.example\/report\. A quote must be copied word for word/);
    assert.match(bad, /The nearest passage there reads:\n.*closed in 1971 after the flood/s, 'the real words are shown');
    assert.equal(t.quotes.length, 1, 'the refused quote is not kept');
    assert.equal(await readFile(join(root, QUOTES_FILE), 'utf8'), file, 'nor written');

    assert.match(await t.run('keep_quote', args({ claim: 'Again.', quote: 'it closed in 1971 after the flood', source: PAGE.url })), /already kept as quote 1/);
    assert.match(await t.run('keep_quote', args({ claim: 'x', quote: 'in 1894', source: PAGE.url })), /too short/);
    assert.match(await t.run('keep_quote', args({ claim: 'x', quote: 'y'.repeat(700), source: PAGE.url })), /at most 600/);
    assert.match(await t.run('keep_quote', args({ claim: 'x', quote: 'built in 1894 by the Harlow', source: 'https://never.example/' })), /^Not kept: That page was not opened/);
    assert.match(await t.run('keep_quote', args({ quote: 'built in 1894 by the' })), /give the claim/);
    assert.deepEqual(t.quotes.map(q => [q.n, q.source, q.place]), [[1, 'https://a.example/report', '']]);
    assert.deepEqual([...t.saved], [QUOTES_FILE]);
  } finally {
    await end();
  }
});

test('a quote from a file in the folder is checked the same way, with the page or sheet it stands on; nothing outside the folder is read', async () => {
  const { t, root, end } = await turn();
  try {
    await writeFile(join(root, 'report.docx'), docxOf());
    await writeFile(join(root, 'book.xlsx'), xlsxOf());
    await writeFile(join(root, 'plain.txt'), 'The valve opens at 4 bar and shuts at 6 bar.');
    assert.equal(await t.run('keep_quote', args({ claim: 'Sales went up 12%.', quote: 'Sales rose 12% & costs fell.', source: 'report.docx' })), 'Kept as quote 1: the words are in report.docx.');
    assert.equal(await t.run('keep_quote', args({ claim: 'North sold 100.5.', quote: 'North | 100.5', source: 'book.xlsx' })), 'Kept as quote 2: the words are in book.xlsx (sheet "Sales & costs").');
    assert.match(await t.run('keep_quote', args({ claim: 'Opens at 5 bar.', quote: 'The valve opens at 5 bar', source: 'plain.txt' })), /^Not kept: those words are not in plain\.txt/);
    assert.match(await t.run('find_in_text', args({ source: 'plain.txt', query: 'shuts at' })), /shuts at 6 bar/);
    for (const out of ['../outside.txt', 'C:\\Windows\\win.ini', '/etc/passwd', '..\\..\\x.docx']) assert.match(await t.run('find_in_text', args({ source: out, query: 'anything here' })), /^(?!\d+ passage)/, out);
    assert.match(await t.run('find_in_text', args({ source: 'missing.docx', query: 'a b c' })), /no file|no such file|Not read/i);
  } finally {
    await end();
  }
});

test('working notes are kept by the code: the same note twice is kept once, the file outlives the answer, a secret is refused', async () => {
  const { t, root, end } = await turn();
  try {
    assert.equal(await t.run('keep_note', args({ text: 'File menu read: New, Open, Save.' })), 'Kept as note 1.');
    assert.match(await t.run('keep_note', args({ text: '  file menu read:  new, open, SAVE. ' })), /^That note is already kept \(note 1 of 1\)\. Do not keep it again: go on to the next step\.$/);
    assert.equal(await t.run('keep_note', args({ text: 'Edit menu next.' })), 'Kept as note 2.');
    assert.match(await t.run('keep_note', args({ text: 'x'.repeat(700) })), /at most 600/);
    assert.match(await t.run('keep_note', args({})), /say the note/);
    assert.match(await t.run('keep_note', args({ text: 'the key is ' + ['sk', 'ant', 'api03'].join('-') + '-' + 'A'.repeat(40) })), /password, key or token/);
    assert.deepEqual(t.notes, ['File menu read: New, Open, Save.', 'Edit menu next.']);
    assert.equal(await readFile(join(root, NOTES_FILE), 'utf8'), '# Working notes\n\nKept by TOMLIN as the model works. The newest is last.\n\n- File menu read: New, Open, Save.\n- Edit menu next.\n');
    assert.equal(await t.run('read_notes', '{}'), 'Your working notes:\n1. File menu read: New, Open, Save.\n2. Edit menu next.');

    // The next answer in the same folder starts from the notes the last one kept.
    const next = new ResearchTurn({ root, perCall: 3000 });
    assert.match(await next.run('keep_note', args({ text: 'Edit menu next.' })), /already kept \(note 2 of 2\)/);
    assert.equal(await next.run('keep_note', args({ text: 'View menu read.' })), 'Kept as note 3.');
    assert.match(await next.run('read_notes', '{}'), /3\. View menu read\.$/);
  } finally {
    await end();
  }
  // No folder: the notes are kept for this answer only, and nothing is written.
  const bare = await turn({ root: null });
  assert.equal(await bare.t.run('keep_note', args({ text: 'kept in memory' })), 'Kept as note 1.');
  assert.equal(await bare.t.run('read_notes', '{}'), 'Your working notes:\n1. kept in memory');
  assert.equal(bare.t.saved.size, 0);
  assert.equal(await (await turn({ root: null })).t.run('read_notes', '{}'), 'No notes or quotes are kept yet.');
  assert.ok(NOTES_MOST >= 40);
});

test('read_document reads Word, Excel and CSV files a part at a time, tables as rows', async () => {
  const { t, root, end } = await turn({ perCall: 900 });
  try {
    await writeFile(join(root, 'report.docx'), docxOf());
    await writeFile(join(root, 'book.xlsx'), xlsxOf());
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data', 'long.csv'), `n,word\n${Array.from({ length: 200 }, (_, i) => `${i + 1},row ${i + 1}`).join('\n')}\n`);
    assert.match(await t.run('read_document', args({ path: 'report.docx' })), /^report\.docx, part 1 of 1 \(the document\)\.\n\nQuarterly report\n.*Region \| Sales\nNorth \(new\) \| 100 \/ 5/s);
    assert.match(await t.run('read_document', args({ path: 'book.xlsx' })), /^book\.xlsx, part 1 of 1 \(sheet "Sales & costs"\)\.\n\nRegion \| Sales\nNorth \| 100\.5/);
    const one = await t.run('read_document', args({ path: 'data/long.csv' }));
    const parts = Number(/part 1 of (\d+)/.exec(one)?.[1]);
    assert.ok(parts >= 3, `several parts (${parts})`);
    assert.match(one, /ask read_document with part 2 for the next, or find_in_text/);
    assert.ok(one.length <= 900);
    assert.match(one, /\n1 \| row 1\n/);
    assert.doesNotMatch(one.split('\n').at(-1)!, /^\d+ \| row$/, 'cut at a line end');
    const last = await t.run('read_document', args({ path: 'data/long.csv', part: 99 }));
    assert.match(last, new RegExp(`part ${parts} of ${parts}`));
    assert.match(last, /200 \| row 200/);
    assert.match(await t.run('read_document', args({ path: 'notes.txt' })), /Read a text file with read_file/);
    assert.match(await t.run('read_document', args({ path: 'gone.docx' })), /no file|no such file/i);
    await writeFile(join(root, 'bad.docx'), 'this is not a zip at all, only words that say so');
    assert.match(await t.run('read_document', args({ path: 'bad.docx' })), /^Not read: it is not a file of this kind/);
    assert.match(await t.run('read_document', args({ path: '../x.docx' })), /no file/i);
  } finally {
    await end();
  }
});

test('calculate and table_stats do the sums: a file in the folder, a sheet by name, or text given', async () => {
  const { t, root, end } = await turn();
  try {
    assert.equal(await t.run('calculate', args({ expression: 'days(2026-01-05, 2026-03-01)' })), 'days(2026-01-05, 2026-03-01) = 55');
    assert.match(await t.run('calculate', args({ expression: 'process.exit()' })), /^Not worked out/);
    await writeFile(join(root, 'sales.csv'), 'Region,Sales\nNorth,100\nSouth,250\nNorth,50\n');
    await writeFile(join(root, 'book.xlsx'), xlsxOf());
    assert.match(await t.run('table_stats', args({ path: 'sales.csv', where: 'Region = North' })), /^sales\.csv:\n2 rows where Region = North \(of 3\).*\nSales: count 2, total 150, average 75/s);
    assert.match(await t.run('table_stats', args({ text: 'a,b\n1,2\n3,4' })), /^the table given:\n2 rows.*\na: count 2, total 4.*\nb: count 2, total 6/s);
    assert.match(await t.run('table_stats', args({ path: 'book.xlsx' })), /more than one sheet: say which\. The sheets are: "Sales & costs", "Empty"/);
    assert.match(await t.run('table_stats', args({ path: 'book.xlsx', sheet: 'sales & costs' })), /Sales: count 1, total 100\.5/);
    assert.match(await t.run('table_stats', args({ path: 'sales.csv', where: 'nonsense' })), /write the test as a column, a sign and a value/);
    assert.match(await t.run('table_stats', args({ path: 'notes.txt' })), /give a CSV or Excel/);
    assert.match(await t.run('table_stats', '{}'), /give a file's path, or the table as CSV text/);
  } finally {
    await end();
  }
});

test('check_draft: quoted words that were never read are named, and a second model reads the draft against the kept quotes', async () => {
  const asked: Array<{ system: string; user: string }> = [];
  const { t, end } = await turn({ second: async (system, user) => (asked.push({ system, user }), { text: '1. "It reopened in 1980" is not in the quotes.', by: 'Checker on Worker PC' }) });
  try {
    const none = await t.run('check_draft', args({ draft: 'The mill closed in 1971 after a flood, and that is all that is known about it.' }));
    assert.match(none, /No quote is kept for this answer, so none of its facts is checked/);
    assert.equal(asked.length, 0, 'with no quotes there is nothing for a second model to read against');
    assert.equal(t.uses.at(-1)!.ok, false);

    await t.run('keep_quote', args({ claim: 'It closed in 1971.', quote: 'it closed in 1971 after the flood', source: PAGE.url }));
    const draft = 'The mill "closed in 1971 after the flood". Its owner said \u201cwe will never open these doors again\u201d. It reopened in 1980. The wheel was "9 metres across".';
    assert.deepEqual(quotedIn(draft), ['closed in 1971 after the flood', 'we will never open these doors again']);
    const got = await t.run('check_draft', args({ draft }));
    assert.match(got, /^Quoted in the draft but not found in anything you kept or read \(1\):\n- "we will never open these doors again"\nTake these out/);
    assert.match(got, /A subagent \(Checker on Worker PC\) read the draft against your 1 kept quote:\n1\. "It reopened in 1980" is not in the quotes\.\nMend each of these/);
    assert.equal(asked[0].system, CHECK_SYSTEM);
    assert.match(asked[0].user, /^QUOTES\n1\. "it closed in 1971 after the flood" \(https:\/\/a\.example\/report\)\n\nDRAFT\nThe mill /);
    assert.equal(t.uses.at(-1)!.ok, false, 'a draft with an unfound quote does not pass');

    const clean = await t.run('check_draft', args({ draft: 'The mill "closed in 1971 after the flood", and nothing more is claimed here.' }));
    assert.match(clean, /^The 1 passage the draft quotes is in what you kept or read\./);
    assert.equal(t.uses.at(-1)!.ok, true);
    assert.match(await t.run('check_draft', args({ draft: 'short' })), /Give the whole draft/);
  } finally {
    await end();
  }
  // No second model, one that answers nothing, and one that fails: the code's check still stands, and says which it was.
  for (const [second, words] of [[undefined, /no second model to ask here/], [async () => null, /No node is free for a subagent now, so the draft was checked by the code only/], [async () => { throw new Error('the PC is off.'); }, /The subagent could not be asked \(the PC is off\), so the draft was checked by the code only/]] as const) {
    const x = await turn({ second: second as never });
    await x.t.run('keep_quote', args({ claim: 'c', quote: 'it closed in 1971 after the flood', source: PAGE.url }));
    assert.match(await x.t.run('check_draft', args({ draft: 'The mill closed in 1971, as the page says, after the flood came.' })), words);
    await x.end();
  }
  const ok = await turn({ second: async () => ({ text: ' ALL SUPPORTED. ', by: 'B' }) });
  await ok.t.run('keep_quote', args({ claim: 'c', quote: 'it closed in 1971 after the flood', source: PAGE.url }));
  assert.doesNotMatch(await ok.t.run('check_draft', args({ draft: 'The mill closed in 1971, as the page says, after the flood came.' })), /Mend each/);
  await ok.end();
});

test('a subagent is asked for first; with no node free it is queued to read the finished answer on this PC, once', async () => {
  const QUOTE = { claim: 'c', quote: 'it closed in 1971 after the flood', source: PAGE.url };
  const DRAFT = 'The mill closed in 1971, as the page says, after the flood came.';
  const FINAL = 'The mill closed in 1971 after the flood, says the report page.';
  const make = async (o: { allow: boolean; second?: () => Promise<{ text: string; by: string } | null>; canQueue?: boolean }) => {
    const asked: string[] = [];
    const t = new ResearchTurn({ root: null, perCall: 3000, page: () => PAGE, second: o.second, canQueue: o.canQueue, allowSecond: async () => (asked.push('card'), o.allow) });
    await t.run('keep_quote', args(QUOTE));
    return { t, asked };
  };
  // Not allowed: no model is asked, nothing is queued, and the model is told not to claim a second check.
  let ran = 0;
  const no = await make({ allow: false, second: async () => (ran++, { text: 'x', by: 'B' }), canQueue: true });
  assert.match(await no.t.run('check_draft', args({ draft: DRAFT })), /A subagent was not allowed, so the draft was checked by the code only\. Do not say a second model checked it\./);
  assert.deepEqual([no.asked.length, ran, no.t.afterAnswer(FINAL)], [1, 0, null]);

  // Allowed and a node is free: it runs there, nothing is queued.
  const node = await make({ allow: true, second: async () => ({ text: 'ALL SUPPORTED', by: 'B on Worker PC' }), canQueue: true });
  assert.match(await node.t.run('check_draft', args({ draft: DRAFT })), /A subagent \(B on Worker PC\) read the draft/);
  assert.equal(node.t.afterAnswer(FINAL), null);

  // Allowed, no node free (or the node failed, or there is none), and this PC may queue: queued, for the finished answer, once.
  for (const second of [async () => null, async () => { throw new Error('the PC is off.'); }, undefined]) {
    const q = await make({ allow: true, second: second as never, canQueue: true });
    const said = await q.t.run('check_draft', args({ draft: DRAFT }));
    assert.match(said, /A subagent is queued: it will read your finished answer against the quotes on this PC when you have written it/);
    assert.match(said, /do not say it has been checked by a second model/);
    assert.equal(q.t.afterAnswer('too short'), null, 'nothing worth reading');
    const job = q.t.afterAnswer(FINAL);
    assert.equal(job?.system, CHECK_SYSTEM);
    assert.equal(job!.user, `QUOTES\n1. "it closed in 1971 after the flood" (https://a.example/report)\n\nDRAFT\n${FINAL}`);
    assert.equal(q.t.afterAnswer(FINAL), null, 'once');
  }
  // With no quotes kept there is nothing to read against: no card is put up at all.
  const bare = new ResearchTurn({ root: null, perCall: 3000, canQueue: true, allowSecond: async () => { throw new Error('asked'); } });
  assert.match(await bare.run('check_draft', args({ draft: DRAFT })), /No quote is kept/);
});

test('a result is cut to the room one call has', async () => {
  const { t, end } = await turn({ perCall: 600 });
  try {
    for (let i = 0; i < 12; i++) await t.run('keep_note', args({ text: `note number ${i} ${'padding '.repeat(20)}` }));
    const got = await t.run('read_notes', '{}');
    assert.ok(got.length <= 600 + 30, String(got.length));
    assert.match(got, /\[cut here: no more room\]$/);
  } finally {
    await end();
  }
});

// A long answer's tool turns: three rounds of calls, each with a long result.
const round = (n: number, text: string) => [
  { role: 'assistant', content: '', tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'open_page', arguments: `{"url":"https://a.example/${n}"}` } }] },
  { role: 'tool', tool_call_id: `c${n}`, content: text },
];
const LONG = (n: number) => `Page ${n}: ${'words of the page '.repeat(300)}`;

test('a long answer is folded: old results cut down, the last two rounds whole, the calls made and the notes handed back', () => {
  const small = [...round(1, 'short'), ...round(2, 'also short')];
  assert.deepEqual(foldToolTurns(small, 'Your working notes:\n1. x'), small, 'nothing changes while the results are small');

  const turns = [...round(1, LONG(1)), ...round(2, LONG(2)), ...round(3, LONG(3)), ...round(4, 'tiny')];
  const folded = foldToolTurns(turns, 'Your working notes:\n1. File menu read.');
  assert.equal(folded.length, turns.length, 'every call still has its result (the model server refuses a call without one)');
  assert.deepEqual(folded.map(t => t.role), turns.map(t => t.role));
  assert.deepEqual(folded.map(t => t.tool_call_id), turns.map(t => t.tool_call_id));
  const text = (i: number) => String(folded[i].content);
  assert.match(text(1), /^Page 1: words of the page .*…\n\[The rest of this result \([\d,]+ characters\) was dropped to save room\. Do not guess what it said/s);
  assert.ok(text(1).length < 500);
  assert.match(text(3), /^Page 2: .*dropped to save room/s);
  assert.equal(text(5), LONG(3), `the last ${FOLD_KEEP_ROUNDS} rounds are whole`);
  assert.match(text(7), /^tiny\n\n\[Kept for you by TOMLIN, because older results above were dropped to save room\]\nCalls you already made \(do not make them again\):\n1\. open_page \{"url":"https:\/\/a\.example\/1"\}\n2\. open_page \{"url":"https:\/\/a\.example\/2"\}\n\nYour working notes:\n1\. File menu read\.$/);
  assert.equal(turns[1].content, LONG(1), 'the turns given are not changed');

  // Folded again with one more round: the same, with the kept block moved to the new last result (never twice).
  const again = foldToolTurns([...folded, ...round(5, 'five')], 'Your working notes:\n1. File menu read.\n2. Edit menu read.');
  assert.equal(again.filter(t => String(t.content).includes('[Kept for you by TOMLIN')).length, 1);
  assert.match(String(again.at(-1)!.content), /^five\n\n\[Kept for you.*3\. open_page \{"url":"https:\/\/a\.example\/3"\}\n\nYour working notes:\n1\. File menu read\.\n2\. Edit menu read\.$/s);
  assert.equal(String(again[7].content), 'tiny');
  assert.deepEqual(foldToolTurns(again, 'Your working notes:\n1. File menu read.\n2. Edit menu read.'), again, 'folding what is folded changes nothing');
  // With no notes, the calls made are still handed back.
  assert.match(String(foldToolTurns(turns, '').at(-1)!.content), /Calls you already made[^]*a\.example\/2"\}$/);
});
