// The scratch pad and the snippet library (src/notes.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSnippet, clean, NotesStore, removeSnippet, restoreSnippet, SCRATCH_MAX, setScratch, SNIPPET_MAX, SNIPPETS_MAX, type Notes } from '../src/notes.ts';

const EMPTY: Notes = { scratch: '', snippets: [] };
const NOW = new Date(2026, 9, 5, 21, 0);
const ok = (c: ReturnType<typeof addSnippet>) => {
  assert.ok(c.ok, c.ok ? '' : c.error);
  return c as Extract<typeof c, { ok: true }>;
};

test('a snippet goes on top, trimmed; the same words saved again move up instead of being kept twice', () => {
  const a = ok(addSnippet(EMPTY, '  Summarise this in three lines.  ', NOW));
  assert.equal(a.notes.snippets[0].text, 'Summarise this in three lines.');
  const b = ok(addSnippet(a.notes, 'Write a short reply.', NOW));
  assert.deepEqual(b.notes.snippets.map(s => s.text), ['Write a short reply.', 'Summarise this in three lines.']);
  const c = ok(addSnippet(b.notes, 'Summarise this in three lines.', NOW));
  assert.deepEqual(c.notes.snippets.map(s => s.text), ['Summarise this in three lines.', 'Write a short reply.']);
  assert.equal(c.id, a.id, 'the same snippet, moved up');
});

test('an empty, too long or one-too-many snippet is refused with the way out', () => {
  const empty = addSnippet(EMPTY, '   ');
  assert.ok(!empty.ok && /type the prompt or note first/.test(empty.error));
  const long = addSnippet(EMPTY, 'x'.repeat(SNIPPET_MAX + 1));
  assert.ok(!long.ok && /Keep the part you need/.test(long.error));
  let n = EMPTY;
  for (let i = 0; i < SNIPPETS_MAX; i++) n = ok(addSnippet(n, `prompt ${i}`)).notes;
  const full = addSnippet(n, 'one more');
  assert.ok(!full.ok && /Delete one you no longer use/.test(full.error));
  assert.ok(addSnippet(n, 'prompt 3').ok, 'saving words already there still moves them up when full');
});

test('delete, then Undo puts it back in its place', () => {
  let n = EMPTY;
  for (const t of ['three', 'two', 'one']) n = ok(addSnippet(n, t)).notes;
  const gone = n.snippets[1];
  const after = ok(removeSnippet(n, gone.id)).notes;
  assert.deepEqual(after.snippets.map(s => s.text), ['one', 'three']);
  const back = ok(restoreSnippet(after, gone, 1)).notes;
  assert.deepEqual(back.snippets.map(s => s.text), ['one', 'two', 'three']);
  assert.equal(ok(restoreSnippet(back, gone, 1)).notes.snippets.length, 3, 'Undo twice keeps one copy');
  assert.ok(!restoreSnippet(back, { id: '../x', text: 'y' }, 0).ok, 'a made-up snippet is not taken');
});

test('the scratch pad keeps what is typed, line ends made plain, up to its limit', () => {
  const s = setScratch(EMPTY, 'line one\r\nline two');
  assert.ok(s.ok);
  assert.equal(s.ok && s.notes.scratch, 'line one\nline two');
  const big = setScratch(EMPTY, 'x'.repeat(SCRATCH_MAX + 1));
  assert.ok(!big.ok && /Move the rest into a snippet/.test(big.error));
});

test('two windows on one scratch pad: a window that started from older words does not save over the newer ones', () => {
  const saved = { ...EMPTY, scratch: 'typed in window A' };
  // Window B loaded the pad empty, then typed: A's words would be lost.
  const b = setScratch(saved, 'typed in window B', '');
  assert.ok(!b.ok && b.clash && /Another window changed the scratch pad/.test(b.error));
  // Started from what is saved (line ends as the browser sends them): saved.
  assert.ok(setScratch({ ...EMPTY, scratch: 'one\ntwo' }, 'one\ntwo\nthree', 'one\r\ntwo').ok);
  // Keep mine (no words to start from) saves over them; the same words as saved are no clash.
  assert.ok(setScratch(saved, 'typed in window B').ok);
  assert.ok(setScratch(saved, 'typed in window A', 'old').ok);
});

test('a damaged or odd file reads as empty or cleaned, never throws', () => {
  assert.deepEqual(clean(null), EMPTY);
  assert.deepEqual(clean({ scratch: 5, snippets: 'no' }), EMPTY);
  const c = clean({ scratch: 'hi', snippets: [{ id: 'abc123', text: 'keep' }, { id: 'abc123', text: 'twice' }, { id: 'bad id', text: 'x' }, { id: 'def456', text: '  ' }] });
  assert.deepEqual(c.snippets.map(s => s.text), ['keep']);
});

test('the store writes data/notes.json and reads it back; a broken file starts empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-notes-'));
  try {
    const store = new NotesStore(dir);
    assert.deepEqual(await store.get(), EMPTY);
    const n = ok(addSnippet(await store.get(), 'Check the spelling.')).notes;
    await store.save({ ...n, scratch: 'call the shop at 3' });
    const again = await new NotesStore(dir).get();
    assert.equal(again.scratch, 'call the shop at 3');
    assert.equal(again.snippets[0].text, 'Check the spelling.');
    assert.match(await readFile(join(dir, 'notes.json'), 'utf8'), /Check the spelling/);
    await writeFile(join(dir, 'notes.json'), '{ broken');
    assert.deepEqual(await new NotesStore(dir).get(), EMPTY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a snippet may carry a subject; saving the same words again keeps or replaces it, and a cleaned file keeps it', () => {
  const a = ok(addSnippet(EMPTY, 'Write a blog intro.', NOW, '  blog   posts '));
  assert.equal(a.notes.snippets[0].subject, 'blog posts');
  const b = ok(addSnippet(a.notes, 'Write a blog intro.', NOW));
  assert.equal(b.notes.snippets[0].subject, 'blog posts', 'no subject typed: the old one stays');
  const c = ok(addSnippet(b.notes, 'Write a blog intro.', NOW, 'website'));
  assert.equal(c.notes.snippets[0].subject, 'website');
  assert.equal(clean({ snippets: [{ id: 'abc123', text: 'x', subject: 's'.repeat(200) }] }).snippets[0].subject.length, 80);
  assert.equal(clean({ snippets: [{ id: 'abc123', text: 'x' }] }).snippets[0].subject, '', 'an older file: no subject');
});
