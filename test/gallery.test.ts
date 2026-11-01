// Gallery or draft: new pictures wait as drafts; older pictures (no flag) stay in the gallery; old drafts are cleared
// only when the person chose a number of days, and never a kept picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gallery, type Picture } from '../src/gallery.ts';

const pic = (id: string, at: string, extra: Partial<Picture> = {}): Picture => ({
  id, at, prompt: `a piano ${id}`, modelPrompt: '', negative: '', mode: 'blog', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1,
  sampler: 'lcm', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1,
  draft: true, original: `2026-10/${id}-o.png`, output: `2026-10/${id}.png`, format: 'png', bytes: 1, ...extra,
});

test('gallery, drafts and all; search by prompt words; old drafts cleared only by the setting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm2-gallery-'));
  try {
    await mkdir(join(dir, '2026-10'), { recursive: true });
    const g = new Gallery(dir);
    const old = '2026-09-01T10:00:00.000Z';
    for (const p of [pic('before', old), pic('draft-old', old, { kept: false }), pic('kept-old', old, { kept: true }), pic('draft-new', new Date().toISOString(), { kept: false, prompt: 'red cat' })]) {
      await writeFile(join(dir, p.output), 'x');
      await writeFile(join(dir, p.original), 'x');
      await g.add(p);
    }
    assert.deepEqual((await g.list(0, 60, 'gallery')).pictures.map(p => p.id).sort(), ['before', 'kept-old']);
    assert.deepEqual((await g.list(0, 60, 'drafts')).pictures.map(p => p.id).sort(), ['draft-new', 'draft-old']);
    assert.equal((await g.list(0, 60, 'all')).total, 4);
    assert.deepEqual((await g.list(0, 60, 'all', 'RED cat')).pictures.map(p => p.id), ['draft-new']);

    assert.equal(await g.clearDrafts(0), 0, 'keep forever');
    assert.equal(await g.clearDrafts(7), 1);
    assert.equal(existsSync(join(dir, '2026-10/draft-old.png')), false);
    assert.equal(existsSync(join(dir, '2026-10/before.png')), true, 'a picture from before drafts is never cleared');
    assert.equal(existsSync(join(dir, '2026-10/kept-old.png')), true);
    assert.equal((await g.list(0, 60, 'all')).total, 3);
    assert.equal(await g.file('2026-10/draft-old.png'), null, 'a cleared file is not served');

    await g.update('draft-new', { kept: true });
    const again = new Gallery(dir);
    assert.deepEqual((await again.list(0, 60, 'gallery')).pictures.map(p => p.id).sort(), ['before', 'draft-new', 'kept-old'], 'read back from the file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a list whose last line was cut off (a crash mid-write) does not swallow the next picture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm2-gallery-torn-'));
  try {
    await mkdir(join(dir, '2026-10'), { recursive: true });
    const first = pic('first', new Date().toISOString(), { kept: true });
    await writeFile(join(dir, 'gallery.jsonl'), `${JSON.stringify(first)}\n{"id":"half","at":"20`);
    await writeFile(join(dir, first.output), 'x');
    const next = pic('next', new Date().toISOString(), { kept: true });
    await writeFile(join(dir, next.output), 'x');
    await new Gallery(dir).add(next);
    const ids = (await new Gallery(dir).list(0, 60, 'all')).pictures.map(p => p.id).sort();
    assert.deepEqual(ids, ['first', 'next']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two pictures saved under one name at the same moment keep a file each', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm2-gallery-'));
  try {
    const g = new Gallery(dir);
    await g.save('first.png', Buffer.from('x'));
    // Big enough that each write is still going when the next save looks for a free name.
    const rels = await Promise.all(Array.from({ length: 40 }, (_, i) => g.save('same-name.png', Buffer.alloc(2_000_000, i))));
    assert.equal(new Set(rels).size, 40, rels.join(', '));
    const first = await Promise.all(rels.map(async rel => (await readFile(join(dir, rel)))[0]));
    assert.deepEqual(first, Array.from({ length: 40 }, (_, i) => i));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a damaged line in the list is skipped and said: search and the other pictures still work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-gallery-'));
  try {
    const good = pic('good', '2026-10-01T10:00:00.000Z');
    const lines = [
      good,
      { ...pic('no-prompt', '2026-10-01T11:00:00.000Z'), prompt: null },
      { ...pic('number-prompt', '2026-10-01T11:00:00.000Z'), prompt: 5 },
      { ...pic('no-file', '2026-10-01T11:00:00.000Z'), output: undefined },
      { ...pic('no-date', '2026-10-01T11:00:00.000Z'), at: 7 },
      { id: 'only-a-change', kept: true },
      { id: 5, prompt: 'a number for an id' },
      null, 'a string', [1, 2],
      { id: 'good', altText: 'a later change to a good picture' },
    ];
    await writeFile(join(dir, 'gallery.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n{"id":"half`);
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
    try {
      const g = new Gallery(dir);
      assert.deepEqual((await g.all()).map(p => p.id), ['good']);
      assert.equal((await g.get('good'))!.altText, 'a later change to a good picture');
      assert.deepEqual((await g.list(0, 60, 'all', 'piano')).pictures.map(p => p.id), ['good']);
      assert.equal(await g.get('no-prompt'), undefined);
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1, warned.join('; '));
    assert.match(warned[0], /9 damaged lines? .*skipped/);
    // Nothing is thrown away: the file still holds them, for someone to mend by hand.
    assert.match(await readFile(join(dir, 'gallery.jsonl'), 'utf8'), /no-prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
