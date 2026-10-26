// The Model menu's parts: Hugging Face links, models in parts, and models in two folders. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupGguf, hfUrl, parseHfLink } from '../src/download.ts';
import { Models } from '../src/models.ts';

test('only Hugging Face model links are taken, pointing at a repo or a file', () => {
  assert.deepEqual(parseHfLink('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF'), { repo: 'unsloth/Qwen3.5-9B-GGUF', rev: 'main', path: '' });
  assert.deepEqual(parseHfLink('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/blob/main/Qwen3.5-9B-Q4_K_M.gguf?download=true'), { repo: 'unsloth/Qwen3.5-9B-GGUF', rev: 'main', path: 'Qwen3.5-9B-Q4_K_M.gguf' });
  assert.deepEqual(parseHfLink(' https://huggingface.co/a/b/resolve/abc123/Q4/x.gguf '), { repo: 'a/b', rev: 'abc123', path: 'Q4/x.gguf' });
  // A link with a broken %-escape is not a link it can use: said plainly, not "URI malformed".
  for (const bad of ['http://huggingface.co/a/b', 'https://huggingface.co.evil.com/a/b', 'https://evil.com/a/b', 'https://huggingface.co/datasets/a/b', 'https://huggingface.co/a', 'not a link', 'https://huggingface.co/unsloth/Qwen3-GGUF%', 'https://huggingface.co/a/b/blob/main/x%E0%A4%A.gguf']) {
    assert.equal(parseHfLink(bad), null, bad);
  }
  assert.equal(hfUrl('a/b', 'abc', 'Q4/x y.gguf'), 'https://huggingface.co/a/b/resolve/abc/Q4/x%20y.gguf');
});

test('a model in parts is one model with the size of every part; vision add-ons are left out', () => {
  const f = (path: string, bytes: number) => ({ path, bytes, sha256: 'x' });
  const got = groupGguf([
    f('Big-Q4-00002-of-00002.gguf', 5), f('Big-Q4-00001-of-00002.gguf', 5), f('small.gguf', 3), f('mmproj-F16.gguf', 1), f('README.md', 1),
  ]);
  assert.deepEqual(got.map(m => [m.name, m.bytes, m.files.map(x => x.path)]), [
    ['small', 3, ['small.gguf']],
    ['Big-Q4', 10, ['Big-Q4-00001-of-00002.gguf', 'Big-Q4-00002-of-00002.gguf']],
  ]);
});

test('models in TOMLIN\'s own folder and another folder are listed together and kept apart by their ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-two-'));
  try {
    const own = join(dir, 'own');
    const other = join(dir, 'lmstudio', 'models');
    await mkdir(own, { recursive: true });
    await mkdir(join(other, 'pub', 'm'), { recursive: true });
    await writeFile(join(own, 'a.gguf'), 'x');
    await writeFile(join(other, 'pub', 'm', 'b.gguf'), 'xx');
    const setting = join(dir, 'models-folder.txt');
    const models = new Models(own, setting);
    assert.deepEqual(models.list().map(m => m.id), ['a.gguf']);
    models.setOther(other);
    assert.deepEqual(models.list().map(m => [m.id, m.where]), [['a.gguf', 'own'], ['*/pub/m/b.gguf', 'other']]);
    assert.equal(models.path('*/pub/m/b.gguf'), join(other, 'pub', 'm', 'b.gguf'));
    assert.equal(models.path('pub/m/b.gguf'), null);
    assert.equal(models.path('*/../own/a.gguf'), null);
    assert.ok(models.has('B.gguf'));
    models.setOther(null);
    assert.equal(models.other(), null);
    assert.equal(models.path('*/pub/m/b.gguf'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('models already installed by Ollama are listed by their Ollama names and used from Ollama\'s own store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-ollama-'));
  try {
    const hash = 'a'.repeat(64);
    await mkdir(join(dir, 'blobs'), { recursive: true });
    await writeFile(join(dir, 'blobs', `sha256-${hash}`), 'xxx');
    const manifest = (digest: string) => JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest }] });
    await mkdir(join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3'), { recursive: true });
    await writeFile(join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3', '4b'), manifest(`sha256:${hash}`));
    await mkdir(join(dir, 'manifests', 'hf.co', 'someone', 'Nemo-GGUF'), { recursive: true });
    await writeFile(join(dir, 'manifests', 'hf.co', 'someone', 'Nemo-GGUF', 'Q4_K_M'), manifest(`sha256:${hash}`));
    // Its model file is missing: left out.
    await writeFile(join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3', '8b'), manifest(`sha256:${'b'.repeat(64)}`));
    // Not a sha256: left out, so nothing outside the store can be named.
    await writeFile(join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3', 'bad'), manifest('sha256:../../evil'));
    const models = new Models(join(dir, 'none'), join(dir, 'setting.txt'), undefined, dir);
    assert.deepEqual(models.list().map(m => [m.id, m.where]).sort(), [['ollama:hf.co/someone/Nemo-GGUF:Q4_K_M', 'ollama'], ['ollama:qwen3:4b', 'ollama']]);
    assert.equal(models.path('ollama:qwen3:4b'), join(dir, 'blobs', `sha256-${hash}`));
    assert.equal(models.path('ollama:qwen3:8b'), null);
    assert.equal(models.path('ollama:qwen3:bad'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding each model\'s file does not walk the whole folder again for every model (100 models among 5,000 files: 41 s before)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-bigdir-'));
  try {
    const other = join(dir, 'drive');
    for (let i = 0; i < 100; i++) {
      await mkdir(join(other, `pub${i % 10}`, `m${i}`), { recursive: true });
      await writeFile(join(other, `pub${i % 10}`, `m${i}`, `model-${i}.gguf`), 'x');
      for (let k = 0; k < 49; k++) await writeFile(join(other, `pub${i % 10}`, `m${i}`, `note-${k}.txt`), '');
    }
    const models = new Models(join(dir, 'own'), join(dir, 'models-folder.txt'));
    models.cacheMs = 2000; // as the server keeps it
    models.setOther(other);
    let t0 = Date.now();
    const list = models.list();
    const once = Math.max(1, Date.now() - t0);
    assert.equal(list.length, 100);
    t0 = Date.now();
    for (const m of list) assert.ok(models.path(m.id), m.id);
    const all = Date.now() - t0;
    assert.ok(all < Math.max(50, once * 3), `path() for 100 models took ${all} ms; one listing takes ${once} ms`);
    assert.equal(models.path('*/pub0/m0/../../pub1/m1/model-1.gguf'), null, 'a name that climbs is still refused');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
