// Free up space (src/cleanup.ts, src/lastused.ts, public/cleanup.js): the category split, the ranking, the space needed,
// the choice of what to suggest, the last-used record, and the pages that carry the dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GB, SPARE, agoWords, blockWhy, categoryOf, driveOf, gbWords, lastUsedWords, prepare, shortBy, suggest, tally, tallyWords, type CleanInput } from '../src/cleanup.ts';
import { LastUsed, cleanLastUsed } from '../src/lastused.ts';
import { cleanShared, sharedList } from '../src/nodestaff.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10);
const m = (id: string, o: Partial<CleanInput> = {}): CleanInput => ({ id, name: id, kind: 'chat', bytes: 10 * GB, usedAt: NOW - 5 * DAY, installedAt: NOW - 90 * DAY, ...o });
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('categories: pictures are the draw models, code has coder or code in its name or file, the rest is chat', () => {
  assert.equal(categoryOf({ kind: 'image', name: 'SDXL Turbo' }), 'pictures');
  assert.equal(categoryOf({ kind: 'image', name: 'Code picture' }), 'pictures');
  assert.equal(categoryOf({ kind: 'chat', name: 'Qwen2.5-Coder 7B' }), 'code');
  assert.equal(categoryOf({ kind: 'chat', name: 'Some model', file: 'sub/deepseek-code-v2.Q4.gguf' }), 'code');
  assert.equal(categoryOf({ kind: 'chat', name: 'gpt-oss-20b' }), 'chat');
  assert.equal(categoryOf({ kind: 'chat', name: 'Gemma 3' }), 'chat');
});

test('ranking: the oldest use first, a record beats the file time, a tie goes to the larger, then name', () => {
  const rows = prepare([
    m('recent', { usedAt: NOW - DAY }),
    m('old-small', { usedAt: NOW - 40 * DAY, bytes: 2 * GB }),
    m('old-big', { usedAt: NOW - 40 * DAY, bytes: 20 * GB }),
    m('never', { usedAt: null, installedAt: NOW - 200 * DAY }),
    m('never-newer', { usedAt: null, installedAt: NOW - 100 * DAY }),
  ]);
  assert.deepEqual(rows.map(r => r.id), ['never', 'never-newer', 'old-big', 'old-small', 'recent']);
  assert.equal(rows[0].recorded, false);
  assert.equal(rows[2].recorded, true);
  // With no record and no file time it is the very oldest (nothing is known of it).
  assert.equal(prepare([m('x', { usedAt: null, installedAt: null }), m('y')])[0].id, 'x');
});

test('a model not loaded, hidden, kept by Ollama or in use is blocked, with the reason', () => {
  assert.equal(blockWhy({}), '');
  assert.match(blockWhy({ loaded: true }), /in use now/);
  assert.match(blockWhy({ busy: true }), /in use now/);
  assert.match(blockWhy({ ollama: true }), /Ollama/);
  assert.match(blockWhy({ hidden: true }), /unhide/);
});

test('"only one of its kind" marks a category with a single model', () => {
  const rows = prepare([m('a'), m('b'), m('coder', { name: 'X-Coder' }), m('pic', { kind: 'image' })]);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.a.only, false);
  assert.equal(by.coder.only, true);
  assert.equal(by.pic.only, true);
});

test('space needed: the model and the spare room, less what is free; nothing when it fits', () => {
  assert.equal(SPARE, 2 * GB);
  assert.equal(shortBy(33.2 * GB - SPARE, 21 * GB), 33.2 * GB - 21 * GB);
  assert.equal(shortBy(10 * GB, 50 * GB), 0);
  assert.equal(shortBy(10 * GB, 12 * GB), 0);
  assert.ok(shortBy(10 * GB, 11.9 * GB) > 0);
});

test('the running total: needs, free, freed, still missing, and enough', () => {
  const t = tally([{ bytes: 8 * GB }, { bytes: 3 * GB }], 21 * GB, 31.2 * GB);
  assert.equal(t.need, 33.2 * GB);
  assert.equal(t.freed, 11 * GB);
  assert.equal(t.enough, false);
  assert.equal(Math.round((t.left / GB) * 10) / 10, 1.2);
  assert.equal(tallyWords(t), 'Needs 33.2 GB, free 21.0 GB, freed so far 11.0 GB');
  const ok = tally([{ bytes: 8 * GB }, { bytes: 6.5 * GB }], 21 * GB, 31.2 * GB);
  assert.equal(ok.enough, true);
  assert.equal(ok.left, 0);
  assert.equal(tallyWords(ok), 'Needs 33.2 GB, free 21.0 GB, freed so far 14.5 GB');
  assert.equal(tally([{ bytes: 14 * GB }], 21 * GB, 31.2 * GB).enough, true);
  // Only freeing space (nothing to install): anything ticked counts, nothing ticked does not.
  assert.equal(tally([], 5 * GB, null).enough, false);
  assert.equal(tally([{ bytes: GB }], 5 * GB, null).enough, true);
  assert.equal(tallyWords(tally([{ bytes: GB }], 5 * GB, null)), 'free 5.0 GB, freed so far 1.0 GB');
});

test('suggest: the least-used of each category first, then more until the need is covered', () => {
  const rows = prepare([
    m('chat-old', { usedAt: NOW - 90 * DAY, bytes: 10 * GB }),
    m('chat-mid', { usedAt: NOW - 30 * DAY, bytes: 8 * GB }),
    m('chat-new', { usedAt: NOW - 1 * DAY, bytes: 30 * GB }),
    m('code-old', { name: 'A-Coder', usedAt: NOW - 60 * DAY, bytes: 5 * GB }),
    m('code-new', { name: 'B-Coder', usedAt: NOW - 2 * DAY, bytes: 5 * GB }),
    m('pic-old', { kind: 'image', usedAt: NOW - 70 * DAY, bytes: 6 * GB }),
    m('pic-new', { kind: 'image', usedAt: NOW - 3 * DAY, bytes: 6 * GB }),
  ]);
  // No need (just freeing space): one per category, nothing ticked.
  const none = suggest(rows, 0);
  assert.deepEqual(none.ids, ['chat-old', 'code-old', 'pic-old']);
  assert.deepEqual(none.ticked, []);
  assert.equal(none.covers, true);
  // A need that the three cover (21 GB): the three, all ticked.
  const some = suggest(rows, 20 * GB);
  assert.deepEqual(some.ids, ['chat-old', 'code-old', 'pic-old']);
  assert.deepEqual(some.ticked, ['chat-old', 'code-old', 'pic-old']);
  // A small need: still the three offered, but only the first is ticked.
  const small = suggest(rows, 4 * GB);
  assert.deepEqual(small.ids, ['chat-old', 'code-old', 'pic-old']);
  assert.deepEqual(small.ticked, ['chat-old']);
  // A bigger need: further least-used ones are added after the three, oldest first, until covered.
  const more = suggest(rows, 33 * GB);
  assert.deepEqual(more.ids, ['chat-old', 'code-old', 'pic-old', 'chat-mid', 'pic-new']);
  assert.deepEqual(more.ticked, more.ids);
  assert.equal(more.covers, true);
  assert.deepEqual(suggest(rows, 40 * GB).ids, ['chat-old', 'code-old', 'pic-old', 'chat-mid', 'pic-new', 'code-new']);
  // More than everything suggestable frees: says it does not cover.
  const huge = suggest(rows, 500 * GB);
  assert.equal(huge.covers, false);
  assert.equal(huge.ids.length, 7);
});

test('suggest never offers a model in use, hidden, kept by Ollama, worked on by a hire, or the only one of its kind', () => {
  const rows = prepare([
    m('loaded', { usedAt: NOW - 300 * DAY, loaded: true }),
    m('hidden', { usedAt: NOW - 290 * DAY, hidden: true }),
    m('ollama', { usedAt: NOW - 280 * DAY, ollama: true }),
    m('hired', { usedAt: NOW - 270 * DAY, usedBy: ['Ana'] }),
    m('free-one', { usedAt: NOW - 10 * DAY }),
    m('only-pic', { kind: 'image', usedAt: NOW - 400 * DAY }),
  ]);
  const s = suggest(rows, 0);
  assert.deepEqual(s.ids, ['free-one']);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by['only-pic'].only, true);
  assert.ok(by.loaded.block && by.hidden.block && by.ollama.block);
  // All of them are still listed, so the person can tick one by hand.
  assert.equal(rows.length, 6);
});

test('words: sizes, "last used" and "not used since install"', () => {
  assert.equal(gbWords(14.5 * GB), '14.5 GB');
  assert.equal(gbWords(300 * 2 ** 20), '300 MB');
  assert.equal(agoWords(NOW, NOW), 'today');
  assert.equal(agoWords(NOW - DAY, NOW), 'yesterday');
  assert.equal(agoWords(NOW - 12 * DAY, NOW), '12 days ago');
  assert.equal(agoWords(NOW - 90 * DAY, NOW), '3 months ago');
  assert.equal(lastUsedWords({ recorded: true, sortAt: NOW - 3 * DAY }, NOW), 'last used 3 days ago');
  assert.equal(lastUsedWords({ recorded: false, sortAt: NOW - 90 * DAY }, NOW), 'not used since install (3 months ago)');
  assert.equal(lastUsedWords({ recorded: false, sortAt: 0 }, NOW), 'not used since install');
});

test('the last-used record: kept per model, a quiet minute between writes, forgotten with the model, bad entries dropped', async () => {
  assert.deepEqual(cleanLastUsed({ a: 5, b: 'x', c: -1, d: NaN, '': 3, e: 1.4 }), { a: 5, e: 1 });
  assert.deepEqual(cleanLastUsed([1, 2]), {});
  const dir = await mkdtemp(join(tmpdir(), 'lastused-'));
  try {
    const l = await LastUsed.load(dir);
    assert.equal(l.get('m1'), null);
    l.touch('m1', 1_000_000);
    l.touch('m1', 1_030_000);
    assert.equal(l.get('m1'), 1_000_000);
    l.touch('m1', 1_070_000);
    assert.equal(l.get('m1'), 1_070_000);
    l.touch('m2', 5_000_000);
    await l.settled();
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'last-used.json'), 'utf8')), { m1: 1_070_000, m2: 5_000_000 });
    assert.equal((await LastUsed.load(dir)).get('m2'), 5_000_000);
    l.forget('m1');
    await l.settled();
    assert.equal((await LastUsed.load(dir)).get('m1'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a node tells linked PCs when each model last answered, and an older node says nothing', () => {
  const list = sharedList({ models: [{ id: 'a', name: 'A', bytes: 1 }, { id: 'b', name: 'B', bytes: 1 }], ctxOf: () => 8192, loaded: () => false, busy: () => false, usedAt: id => (id === 'a' ? 1234567 : null) });
  assert.equal(list[0].usedAt, 1234567);
  assert.equal('usedAt' in list[1], false);
  assert.equal(cleanShared(JSON.parse(JSON.stringify(list)))[0].usedAt, 1234567);
  assert.equal('usedAt' in cleanShared([{ id: 'z', name: 'Z', bytes: 5 }])[0], false);
});

test('the page maths is the same as the tested maths', () => {
  const src = read('public/cleanup.js');
  const math = /\/\/ --- math[^\n]*\n([\s\S]*?)\/\/ --- end math ---/.exec(src)![1];
  const page = new Function('GB', `${math}; return { gbWords, tally, tallyWords };`)(GB) as { gbWords: (n: number) => string; tally: typeof tally; tallyWords: typeof tallyWords };
  for (const [ticked, free, wanted] of [[[8, 6.5], 21, 31.2], [[14], 21, 31.2], [[], 5, null], [[1], 5, null], [[0.2], 0.1, 0.5], [[30], 1, 40]] as [number[], number, number | null][]) {
    const rows = ticked.map(g => ({ bytes: g * GB }));
    const a = page.tally(rows, free * GB, wanted === null ? null : wanted * GB);
    const b = tally(rows, free * GB, wanted === null ? null : wanted * GB);
    assert.deepEqual(a, b);
    assert.equal(page.tallyWords(a), tallyWords(b));
  }
  for (const n of [1, 5e5, 3e8, GB, 14.5 * GB, 300 * GB]) assert.equal(page.gbWords(n), gbWords(n));
});

test('the dialog: two columns with the headings asked for, the buttons, a confirm that says it cannot be undone, no small text', () => {
  const html = read('public/index.html');
  const dlg = /<dialog id="cleanup-dlg"[\s\S]*?<\/dialog>/.exec(html)![0];
  for (const t of ['Suggested to remove', 'All installed', 'Approved to remove', 'Remove selected', 'Remove anyway']) assert.ok(dlg.includes(t), t);
  assert.doesNotMatch(dlg, /#[0-9a-f]{6}\b/i);
  assert.ok(html.indexOf('<script src="cleanup.js">') < html.indexOf('<script src="pcs.js">'), 'cleanup.js loads before pcs.js');
  const js = read('public/cleanup.js');
  assert.match(js, /cannot be undone/);
  assert.match(js, /Insufficient room/);
  assert.match(js, /only one of its kind/);
  assert.match(js, /not used since install/);
  // Nothing goes without the confirm, and deletes use the models list's own door, one model at a time.
  assert.match(js, /if \(!ok\) return;/);
  assert.match(js, /api\('\/api\/models\/delete', \{ id: r\.id, kind: r\.kind \}\)/);
  const css = read('public/style.css');
  const block = css.slice(css.indexOf('/* Free up space'));
  for (const px of block.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(px[1]) >= 12, `font-size ${px[1]}px`);
});

test('removing shows a screen like the update one: each model going, then Completed with what was freed and what is left', () => {
  const html = read('public/index.html');
  const dlg = /<dialog id="cleanup-dlg"[\s\S]*?<\/dialog>/.exec(html)![0];
  for (const id of ['cleanup-result', 'cleanup-result-title', 'cleanup-result-steps', 'cleanup-result-line', 'cleanup-result-done']) assert.ok(dlg.includes(`id="${id}"`), id);
  const js = read('public/cleanup.js');
  assert.match(js, /'Completed'/);
  assert.match(js, /Finished, with problems/);
  assert.match(js, /freed\.` : ''\}\$\{left\}/);
  assert.match(js, /now has \$\{gbWords\(st\.data\.disk\.free\)\} free of/);
  // The list steps aside while models go (showResult(true) before the first one), and Close and Esc wait.
  assert.ok(js.indexOf('showResult(true)') > js.indexOf('if (!ok) return;') && js.indexOf('showResult(true)') < js.indexOf("'/api/models/delete'"));
  assert.match(js, /if \(busy\) e\.preventDefault\(\)/);
  assert.match(js, /\$\('#cleanup-result-done'\)\.addEventListener\('click', \(\) => showResult\(false\)\)/);
});

test('Free up space opens from the models lists and from a failed install; the errors carry the numbers', () => {
  assert.match(read('public/pcs.js'), /text: 'Free up space'[^\n]*app\.openCleanup\?\.\(\{ pc: v\.id, onChanged: modelsChanged \}\)/);
  assert.match(read('public/models.js'), /app\.cleanupButton\(e\.data\.room\)/);
  assert.match(read('public/models.js'), /app\.cleanupButton\(error\.data\.room\)/);
  assert.match(read('src/server/hf.ts'), /room: \{ name: m\.name, bytes: m\.bytes, free \}/);
  assert.match(read('src/registry.ts'), /\{ room: \{ name: model\.name, bytes: need, free \} \}/);
  assert.match(read('src/images.ts'), /\.\.\.\(room \? \{ room \} : \{\}\)/);
});

test('the record is kept when a model answers or draws, and a linked PC can be cleaned only when it is on and has its tick set', () => {
  assert.match(read('src/server/costs.ts'), /lastUsed\.touch\(model\)/);
  assert.match(read('src/server/thispc.ts'), /drawings\.drawn = model => lastUsed\.touch\(model\)/);
  assert.match(read('src/images.ts'), /drawings\.drawn\?\.\(this\.pane\.view\.model \?\? ''\)/);
  const t = read('src/server/thispc.ts');
  // A linked PC is removed from over the link (test/cleanupon.test.ts); only a real block turns it off.
  assert.match(t, /canDelete = !why;/);
  assert.doesNotMatch(t, /canDelete = false;/);
  assert.match(t, /lastUsed\.forget\(id\)/);
});

test('models on two drives: a model frees room only on its own drive, so only those on the short drive are offered', () => {
  assert.equal(driveOf('D:\TOMLIN-test-models\a.gguf'), 'D:');
  assert.equal(driveOf('c:/x'), 'C:');
  assert.equal(driveOf('\\server\share\a.gguf'), '');
  const rows = prepare([
    m('old-on-d', { drive: 'D:', usedAt: NOW - 90 * DAY }),
    m('older-on-d', { drive: 'D:', usedAt: NOW - 99 * DAY }),
    m('on-c', { drive: 'C:', usedAt: NOW - 30 * DAY, file: 'coder.gguf' }),
    m('on-c-too', { drive: 'C:', usedAt: NOW - 20 * DAY }),
  ]);
  // A model for C: that needs 5 GB more: the old ones on D: free nothing there, so they are not offered or ticked.
  const forC = suggest(rows, 5 * GB, 'C:');
  assert.ok(forC.ids.every(id => id.includes('on-c')), forC.ids.join());
  assert.equal(forC.ticked.length, 1, 'one 10 GB model on C: covers it');
  assert.ok(forC.ticked[0].startsWith('on-c'));
  // With no model wanted (only freeing space), every drive is offered, as before.
  assert.ok(suggest(rows, 0).ids.includes('older-on-d'));
  // The window: each drive's free space, the drive on each row, and ticks on another drive not counted for a model.
  const page = read('public/cleanup.js');
  assert.match(page, /A model frees room only on its own drive/);
  assert.match(page, /const counted = picked\.filter\(r => onDrive\(r, drive\)\)/);
  assert.match(page, /frees nothing on \$\{drive\}/);
  assert.equal(gbWords(0), '0 GB', 'nothing freed is said as nothing');
  assert.match(read('src/server/thispc.ts'), /cleanup\.suggest\(rows, short, wanted \? drive : ''\)/);
});
