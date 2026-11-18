import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINDINGS_MOST, NOTE_TOOLS, NoteTurn, RESEARCH_BUDGET, keepFinding, noteSlug, sourcesBlock, sourcesOf, type Source } from '../src/notetools.ts';
import { PACE, POLITE, Pacer, WEB_ROUNDS, WebTurn, type Fetcher } from '../src/webtools.ts';

const USES = [
  { name: 'web_search', input: 'cuda 13', ok: true, said: '8 results' },
  { name: 'open_page', input: 'https://b.example/two', ok: true, said: 'Second Page, 802 words' },
  { name: 'open_page', input: 'https://c.example/bad', ok: false, said: 'not opened: 404' },
  { name: 'open_page', input: 'https://a.example/one', ok: true, said: 'First, with a comma, part 2 of 3, 1,234 words' },
  { name: 'open_page', input: 'https://b.example/two', ok: true, said: 'Second Page, part 2 of 2, 300 words' },
];
const SOURCES: Source[] = [{ url: 'https://b.example/two', title: 'Second Page' }, { url: 'https://a.example/one', title: 'First, with a comma' }];
const DAY = () => new Date(2026, 10, 10);

test('the Sources block lists exactly the pages opened, in order, each once, built by code', () => {
  assert.deepEqual(sourcesOf(USES), SOURCES);
  assert.equal(sourcesBlock(SOURCES), '## Sources\n\n1. Second Page - https://b.example/two\n2. First, with a comma - https://a.example/one\n');
  assert.equal(sourcesBlock([]), '');
  assert.deepEqual(sourcesOf([]), []);
  assert.deepEqual(NOTE_TOOLS.map(t => t.function.name), ['save_note', 'suggest_finding']);
});

test('save_note stays inside research/, carries the code\'s sources and the date, and passes the save checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nt-'));
  try {
    const t = new NoteTurn({ root, sources: () => SOURCES, today: DAY });
    assert.match(await t.run('save_note', JSON.stringify({ title: 'CUDA 13: what changed?', text: 'It dropped two cards.\n\n## Sources\n\n1. made-up.example' })), /Saved the note as research\/cuda-13-what-changed\.md, with 2 sources listed/);
    const text = await readFile(join(root, 'research', 'cuda-13-what-changed.md'), 'utf8');
    assert.match(text, /^# CUDA 13: what changed\?\n\nSaved 2026-11-10\.\n\nIt dropped two cards\./);
    assert.ok(text.endsWith('## Sources\n\n1. Second Page - https://b.example/two\n2. First, with a comma - https://a.example/one\n'), 'the code\'s block is the last word on sources');
    for (const title of ['../../outside', '..\\..\\x', 'C:\\Windows\\note', '/etc/note', '.hidden', 'a/b/c']) {
      assert.match(await t.run('save_note', JSON.stringify({ title, text: 'x' })), /Saved the note as research\/[a-z0-9-]+\.md/, title);
    }
    assert.deepEqual((await readdir(root)).sort(), ['research'], 'nothing was written beside research/');
    assert.ok(t.saved.every(p => /^research\/[a-z0-9-]+\.md$/.test(p)), t.saved.join(' '));
    assert.match(await t.run('save_note', JSON.stringify({ title: 'Keys', text: 'api_key = abcdefghijklmnop1234' })), /Not saved: the text looks like it holds a password, key or token/);
    assert.match(await t.run('save_note', JSON.stringify({ title: '', text: 'x' })), /needs a title and a text/);
    assert.match(await t.run('save_note', JSON.stringify({ title: 'Big', text: 'x'.repeat(60_001) })), /at most 60,000/);
    assert.match(await t.run('save_note', 'nope'), /not JSON/);
    const none = new NoteTurn({ root, sources: () => [], today: DAY });
    assert.match(await none.run('save_note', JSON.stringify({ title: 'From memory', text: 'x' })), /lists no sources/);
    assert.doesNotMatch(await readFile(join(root, 'research', 'from-memory.md'), 'utf8'), /Sources/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a note never overwrites a different note: it gets a new name; the same note again is not a second file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nt-'));
  try {
    const t = new NoteTurn({ root, sources: () => [], today: DAY });
    const save = (text: string) => t.run('save_note', JSON.stringify({ title: 'Prices', text }));
    assert.match(await save('one'), /research\/prices\.md/);
    assert.match(await save('two'), /research\/prices-2\.md/);
    assert.match(await save('three'), /research\/prices-3\.md/);
    assert.match(await save('two'), /already saved as research\/prices-2\.md/);
    assert.match(await readFile(join(root, 'research', 'prices.md'), 'utf8'), /one/);
    assert.deepEqual((await readdir(join(root, 'research'))).sort(), ['prices-2.md', 'prices-3.md', 'prices.md'], 'no .bak: nothing was written over');
    assert.equal(noteSlug('  Ünïcode & Signs!!  '), 'unicode-signs');
    assert.equal(noteSlug('***'), 'note');
    assert.equal(noteSlug('x'.repeat(200)).length, 60);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a suggested finding is not stored until the person presses Save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nt-'));
  try {
    const t = new NoteTurn({ root, sources: () => SOURCES, today: DAY });
    const said = await t.run('suggest_finding', JSON.stringify({ text: 'CUDA 13 drops  two\ncards.', source: 'https://b.example/two/' }));
    assert.match(said, /Shown to the person.*NOT saved yet/s);
    assert.deepEqual(t.findings, [{ id: 'f1', text: 'CUDA 13 drops two cards.', source: 'https://b.example/two' }]);
    assert.deepEqual(await readdir(root), [], 'nothing on the drive');
    assert.match(await t.run('suggest_finding', JSON.stringify({ text: 'Made up.', source: 'https://evil.example/x' })), /not a page you opened in this answer, so it is shown without one/);
    assert.equal(t.findings[1].source, '');
    assert.match(await t.run('suggest_finding', JSON.stringify({ text: '' })), /Not suggested/);
    assert.match(await t.run('suggest_finding', JSON.stringify({ text: 'x'.repeat(601) })), /at most 600/);
    assert.match(await t.run('suggest_finding', JSON.stringify({ text: 'password = hunter2hunter2hunter2' })), /looks like it holds a password/);
    for (let i = t.findings.length; i < FINDINGS_MOST; i++) await t.run('suggest_finding', JSON.stringify({ text: `Finding ${i}` }));
    assert.match(await t.run('suggest_finding', JSON.stringify({ text: 'One more' })), /is the most in one answer/);
    assert.deepEqual(await readdir(root), [], 'still nothing on the drive');

    // The Save press.
    assert.deepEqual(await keepFinding(root, t.findings[0], DAY()), { path: 'research/findings.md' });
    assert.deepEqual(await keepFinding(root, { text: 'Second.', source: 'javascript:alert(1)' }, DAY()), { path: 'research/findings.md' });
    assert.equal(await readFile(join(root, 'research', 'findings.md'), 'utf8'), '# Findings\n\n- 2026-11-10: CUDA 13 drops two cards. (https://b.example/two)\n\n- 2026-11-10: Second.\n');
    assert.ok('error' in (await keepFinding(root, { text: '', source: '' })));
    assert.ok('error' in (await keepFinding(root, { text: 'token = abcdefghijklmnop1234', source: '' })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the research role reads more pages in an answer; without it the limit is as it was', async () => {
  assert.deepEqual([PACE.pagesPerAnswer, WEB_ROUNDS], [20, 8], 'the usual limits are untouched');
  assert.ok(RESEARCH_BUDGET.pagesPerAnswer > PACE.pagesPerAnswer && RESEARCH_BUDGET.rounds > WEB_ROUNDS);
  const pace = new Pacer();
  pace.delay = false;
  void POLITE;
  const get: Fetcher = async url => ({ status: 200, type: 'text/html', body: Buffer.from(`<html><title>T</title><body><p>page ${url}</p></body></html>`), headers: {} } as never);
  const urls = Array.from({ length: 30 }, (_, i) => `https://site${i}.example/p`);
  const read = async (pagesPerAnswer?: number) => {
    const t = new WebTurn([urls.join(' ')], { search: { provider: 'duckduckgo' }, perCall: 1500, total: 600_000, get, pace: Object.assign(pace, { wait: async () => undefined }), ...(pagesPerAnswer ? { pagesPerAnswer } : {}) });
    let ok = 0;
    for (const [i, u] of urls.entries()) if (!/^Not opened/.test(await t.run('open_page', JSON.stringify({ url: u }), new AbortController().signal, i))) ok++;
    return ok;
  };
  assert.equal(await read(), 20);
  assert.equal(await read(RESEARCH_BUDGET.pagesPerAnswer), 30);
});
