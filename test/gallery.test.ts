// Gallery or draft: new pictures wait as drafts; older pictures (no flag) stay in the gallery; old drafts are cleared
// only when the person chose a number of days, and never a kept picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
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
