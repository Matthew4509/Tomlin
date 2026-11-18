// A model's saves in the workspace keep the newest 5 time-stamped .bak copies of each file (src/bakcopies.ts, called
// by src/workspace.ts save): the file, its plain .bak and other files' copies are never touched. On a real temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP_BAKS, trimBaks } from '../src/bakcopies.ts';
import { save } from '../src/workspace.ts';

test('time-stamped .bak copies: the newest 5 of each file stay, nothing else beside them is touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-baks-'));
  try {
    assert.equal(KEEP_BAKS, 5);
    const stamp = (i: number) => `202611${String(10 + i).padStart(2, '0')}120000`;
    for (let i = 0; i < 8; i++) await writeFile(join(root, `post.md.${stamp(i)}.bak`), `v${i}`);
    const others = ['post.md', 'post.md.bak', 'post.md.123.bak', 'post.md.2026111012000x.bak', 'other.md.20261101120000.bak', 'apost.md.20261101120000.bak'];
    for (const n of others) await writeFile(join(root, n), 'x');
    assert.equal(await trimBaks(join(root, 'post.md')), 3);
    const left = (await readdir(root)).sort();
    assert.deepEqual(left.filter(n => /^post\.md\.\d{14}\.bak$/.test(n)), [3, 4, 5, 6, 7].map(i => `post.md.${stamp(i)}.bak`));
    for (const n of others) assert.ok(left.includes(n), n);
    assert.equal(await trimBaks(join(root, 'post.md')), 0, 'nothing more the second time');
    assert.equal(await trimBaks(join(root, 'missing', 'x.md')), 0, 'a folder that is not there is no fault');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a model saving one file again and again leaves at most 5 time-stamped copies of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-baks-save-'));
  try {
    await save(root, 'notes.md', 'first');
    // Each save keeps the last .bak under a time stamp: one a second here, as a model's steps would over time.
    for (let i = 0; i < 7; i++) {
      await writeFile(join(root, `notes.md.2026111${i}000000.bak`), `old ${i}`);
      await save(root, 'notes.md', `save ${i}`, true, true);
    }
    const stamped = (await readdir(root)).filter(n => /^notes\.md\.\d{14}\.bak$/.test(n));
    assert.ok(stamped.length <= 5, stamped.join(', '));
    assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'save 6');
    assert.equal(await readFile(join(root, 'notes.md.bak'), 'utf8'), 'save 5');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
