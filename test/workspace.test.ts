import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFolder, cleanPath, inside, list, read, save } from '../src/workspace.ts';
import { blogAsk, blogFile, blogSlug, blogSystem, splitPost } from '../src/blog.ts';

test('only plain relative text-file paths are accepted', () => {
  assert.equal(cleanPath('notes.md'), 'notes.md');
  assert.equal(cleanPath('blog\\post.md'), 'blog/post.md');
  for (const bad of ['../x.md', 'a/../../x.md', 'C:\\x.md', '.hidden.md', 'a/.git/x.md', 'run.exe', 'a.md.', 'x<y>.md', '', 'a//b.md']) assert.equal(cleanPath(bad), null, bad);
});

test('files are listed, read and saved inside the workspace; a changed file keeps one .bak; nothing else is touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'));
  try {
    await writeFile(join(root, 'a.md'), 'one');
    await writeFile(join(root, 'pic.png'), 'x');
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'c.md'), 'hidden');
    const files = await list(root);
    assert.deepEqual(files.map(f => f.path), ['a.md']);
    assert.deepEqual(await read(root, 'a.md'), { path: 'a.md', text: 'one' });
    assert.ok('error' in (await read(root, '../a.md')));
    assert.deepEqual(await save(root, 'blog/new.md', 'hello'), { path: 'blog/new.md', created: true });
    assert.deepEqual(await save(root, 'a.md', 'two'), { path: 'a.md', created: false });
    assert.equal(await readFile(join(root, 'a.md.bak'), 'utf8'), 'one');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), 'two');
    assert.ok('error' in (await save(root, '../out.md', 'x')));
    assert.ok('error' in (await save(root, 'bad.exe', 'x')));
    assert.ok('error' in (await save(root, 'missing.md', 'x', false)));
    assert.ok('error' in (await save(root, 'big.md', 'x'.repeat((1 << 20) + 1))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a link pointing out of the workspace is not followed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'out-'));
  try {
    await writeFile(join(outside, 'secret.md'), 'secret');
    const linked = await symlink(outside, join(root, 'link'), 'junction').then(() => true, () => false);
    if (linked) {
      assert.equal(await inside(root, 'link/secret.md'), null);
      assert.ok('error' in (await save(root, 'link/new.md', 'x')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the blog ask has limits, the post splits into title and body, the file has front matter and the picture', () => {
  assert.equal(blogAsk({ topic: '  ' }), null);
  assert.deepEqual(blogAsk({ topic: 'Tuning a piano', words: 5000 }), { topic: 'Tuning a piano', audience: '', words: 1200 });
  assert.match(blogSystem({ topic: 't', audience: 'new owners', words: 300 }), /About 300 words/);
  assert.match(blogSystem({ topic: 't', audience: 'new owners', words: 300 }), /new owners/);
  assert.deepEqual(splitPost('# How often to tune\n\nTwice a year is a good start.'), { title: 'How often to tune', body: 'Twice a year is a good start.' });
  assert.equal(splitPost('How often to tune\n\nText.').title, 'How often to tune');
  assert.equal(blogSlug('How Often Should You Tune a Piano in Winter?'), 'how-often-should-you-tune-a');
  const f = blogFile('Tuning', 'Body text.', { picture: 'tuning.webp', alt: 'A piano', date: new Date('2026-10-03T12:00:00Z') });
  assert.match(f, /^---\ntitle: "Tuning"\ndate: 2026-10-03\nimage: "tuning.webp"\n---\n\n# Tuning\n\n!\[A piano\]\(tuning.webp\)\n\nBody text.\n$/);
  assert.doesNotMatch(blogFile('T', 'B'), /image:/);
});

test('a folder typed or pasted from Windows is accepted with or without its quotes; drive roots and Windows folders are not', () => {
  assert.equal(cleanFolder(''), '');
  assert.equal(cleanFolder('  '), '');
  assert.equal(cleanFolder('C:\\Users\\me\\Writing'), 'C:\\Users\\me\\Writing');
  assert.equal(cleanFolder('"C:\\Users\\me\\My Writing"'), 'C:\\Users\\me\\My Writing');
  assert.equal(cleanFolder(' “C:\\Users\\me\\Writing” '), 'C:\\Users\\me\\Writing');
  for (const bad of ['C:\\', 'D:', 'Writing', 'C:\\Windows\\Temp', 'c:\\program files\\x', 'C:\\Users\\a"b', '"C:\\"']) assert.equal(cleanFolder(bad), null, bad);
});
