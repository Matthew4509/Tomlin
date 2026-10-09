// Where work goes in the workspace (src/folders.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatFolder, firstWords, keptFromModels, handedIn, handedInLines, moves, notePath, picturePath, saveTo, specialistFolder, stamp, stamped, stampOf, writerHandIn } from '../src/folders.ts';
import { cleanFiles, cleanProjectFolder, cleanStep, folderStamp } from '../src/jobs.ts';
import { cleanPath } from '../src/workspace.ts';

const NOW = new Date(2026, 9, 7, 15, 30);

test('every name starts with the same date and time as a project folder', () => {
  assert.equal(stamp(NOW), '2026-10-07-1530');
  assert.equal(folderStamp(NOW), '2026-10-07-1530');
  assert.equal(stamped('chapter-1.md', NOW), '2026-10-07-1530 chapter-1.md');
  assert.equal(stamped('2026-10-01-0900 chapter-1.md', NOW), '2026-10-01-0900 chapter-1.md', 'a stamped name keeps its own');
  assert.equal(stampOf('2026-10-07-1530 video cards.md'), '2026-10-07-1530');
  assert.equal(stampOf('2026-10-07-1530-2'), '2026-10-07-1530');
  assert.equal(stampOf('chapter-1.md'), null);
});

test('a note is saved in notes, or in the project\'s admin notes, named by when and its first words', () => {
  assert.equal(notePath('Video cards: 12 GB for 1440p, check the PSU!', null, NOW), 'notes/2026-10-07-1530 Video cards 12 GB for 1440p check the.md');
  assert.equal(notePath('Ask about the cover', 'clients/acme', NOW), 'clients/acme/admin notes/2026-10-07-1530 Ask about the cover.md');
  assert.equal(notePath('Top of the workspace', '', NOW), 'admin notes/2026-10-07-1530 Top of the workspace.md');
  assert.equal(firstWords('???'), 'note');
  assert.ok(firstWords('a '.repeat(80)).length <= 40);
  // Every path made here is one the workspace takes, even for a project three folders deep.
  for (const p of [notePath('x', 'a/b/c', NOW), picturePath('a/b/c', 'A red fox at dusk, oil paint', '.png', NOW), `${saveTo({ chatFolder: '', projectFolder: 'a/b/c', role: 'writer' }).dir}/2026-10-07-1530 chapter-1.md`]) {
    assert.ok(cleanPath(p, false), p);
  }
});

test('a quick chat has its own folder, named by when it started; a second chat that minute gets -2', () => {
  const created = NOW.toISOString();
  assert.equal(chatFolder(created, []), 'chats/2026-10-07-1530');
  assert.equal(chatFolder(created, ['chats/2026-10-07-1530']), 'chats/2026-10-07-1530-2');
  assert.equal(chatFolder(created, ['chats/2026-10-07-1530', 'chats/2026-10-07-1530-2']), 'chats/2026-10-07-1530-3');
});

test('Save in a chat: Default into its own chats folder; a project into the project; a writer or artist into specialists', () => {
  assert.deepEqual(saveTo({ chatFolder: 'chats/2026-10-07-1530', projectFolder: null, role: 'writer' }), { dir: 'chats/2026-10-07-1530', stamped: false });
  assert.deepEqual(saveTo({ chatFolder: 'chats/x', projectFolder: 'my-book', role: 'coder' }), { dir: 'my-book', stamped: false });
  assert.deepEqual(saveTo({ chatFolder: 'chats/x', projectFolder: 'my-book', role: 'writer' }), { dir: 'my-book/specialists/writer', stamped: true });
  assert.deepEqual(saveTo({ chatFolder: 'chats/x', projectFolder: 'my-book', role: 'artist' }), { dir: 'my-book/specialists/images', stamped: true });
  assert.deepEqual(saveTo({ chatFolder: 'chats/x', projectFolder: '', role: 'pm' }), { dir: '', stamped: false });
  assert.equal(specialistFolder('designer'), 'images');
  assert.equal(specialistFolder('default'), null);
});

test('a quick chat\'s files move into the project, and a file whose name is taken there stays', () => {
  const r = moves(['chats/2026-10-07-1530/gpu.md', 'chats/2026-10-07-1530/sub/list.txt', 'chats/2026-10-07-1530/notes.md', 'chats/other/x.md'], 'chats/2026-10-07-1530', 'my-pc', new Set(['my-pc/notes.md']));
  assert.deepEqual(r.move, [{ from: 'chats/2026-10-07-1530/gpu.md', to: 'my-pc/gpu.md' }, { from: 'chats/2026-10-07-1530/sub/list.txt', to: 'my-pc/sub/list.txt' }]);
  assert.deepEqual(r.stay, ['chats/2026-10-07-1530/notes.md']);
  assert.deepEqual(moves(['chats/a/x.md'], 'chats/a', '', new Set()).move, [{ from: 'chats/a/x.md', to: 'x.md' }]);
  // Into a writer's specialists folder: each name starts with when the chat started.
  assert.deepEqual(moves(['chats/2026-10-07-1530/heron.md'], 'chats/2026-10-07-1530', 'my-book/specialists/writer', new Set(), '2026-10-07-1530').move, [{ from: 'chats/2026-10-07-1530/heron.md', to: 'my-book/specialists/writer/2026-10-07-1530 heron.md' }]);
});

test('the work handed in is listed newest first by the date and time in its name', () => {
  const list = handedIn([
    { path: 'specialists/writer/2026-10-06-0900 chapter-1.md', bytes: 1200, at: '2026-10-07T12:00:00.000Z' },
    { path: 'specialists/writer/2026-10-07-1100 chapter-1.md', bytes: 1500, at: '2026-10-07T11:00:00.000Z' },
    { path: 'specialists/writer/2026-10-07-1100 chapter-1.md.bak', bytes: 1, at: '2026-10-07T11:00:00.000Z' },
    { path: 'specialists/images/2026-10-07-1000 cover.md', bytes: 90, at: '2026-10-07T10:00:00.000Z' },
    { path: 'index.html', bytes: 900, at: '2026-10-07T13:00:00.000Z' },
  ]);
  assert.deepEqual(list.map(h => h.path), ['specialists/writer/2026-10-07-1100 chapter-1.md', 'specialists/images/2026-10-07-1000 cover.md', 'specialists/writer/2026-10-06-0900 chapter-1.md']);
  const lines = handedInLines(list);
  assert.match(lines[0], /the newest from the writer folder/);
  assert.match(lines[1], /the newest from the images folder/);
  assert.doesNotMatch(lines[2], /newest/);
});

test('a writer\'s new text file goes in specialists/writer, and every step that names it follows', () => {
  const steps = [
    cleanStep({ title: 'Write chapter-1.md', role: 'writer', files: 'chapter-1.md', brief: 'Write chapter-1.md: the fox meets the owl.', check: 'chapter-1.md reads well' })!,
    cleanStep({ title: 'Show it', role: 'coder', files: 'index.html, chapter-1.md', brief: 'Load chapter-1.md into index.html.' })!,
    cleanStep({ title: 'Readme', role: 'writer', files: 'README.md', brief: 'Say what this is.' })!,
    cleanStep({ title: 'Edit the old one', role: 'writer', files: 'old.md', brief: 'Tidy old.md.' })!,
  ];
  const r = writerHandIn(steps, new Set(['old.md']), NOW);
  const to = 'specialists/writer/2026-10-07-1530 chapter-1.md';
  assert.deepEqual(r.moved, { 'chapter-1.md': to });
  assert.deepEqual(r.steps[0].files, [to]);
  assert.equal(r.steps[0].title, `Write ${to}`);
  assert.equal(r.steps[0].brief, `Write ${to}: the fox meets the owl.`);
  assert.deepEqual(r.steps[1].files, ['index.html', to]);
  assert.equal(r.steps[1].brief, `Load ${to} into index.html.`);
  assert.deepEqual(r.steps[2].files, ['README.md'], 'the project\'s own text stays');
  assert.deepEqual(r.steps[3].files, ['old.md'], 'a file already there stays');
  assert.ok(cleanPath(to));
});

test('no model is given the person\'s notes or the quick chats\' folders', () => {
  for (const p of ['notes/2026-10-07-1530 gpu.md', 'chats/2026-10-07-1530/a.js', 'my-book/admin notes/x.md', 'admin notes/x.md']) assert.equal(keptFromModels(p), true, p);
  for (const p of ['my-book/notes.md', 'my-book/specialists/writer/x.md', 'index.html', 'my-notes/x.md']) assert.equal(keptFromModels(p), false, p);
  assert.deepEqual(cleanFiles('index.html, notes/2026-10-07-1530 gpu.md, my-book/admin notes/x.md'), ['index.html']);
});

test('a project cannot take the names of the chats and notes folders', () => {
  for (const bad of ['chats', 'notes', 'Chats', 'notes/x']) assert.equal(cleanProjectFolder(bad), null, bad);
  assert.equal(cleanProjectFolder('my-notes'), 'my-notes');
});
