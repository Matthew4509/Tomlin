// Every picture model in the list: each file is pinned (revision and SHA-256) and has a role the picture runner is
// started with, so no file is downloaded and then left out. Run: node --test test/picturemodels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../registry/', import.meta.url);
const models = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
const images = readFileSync(new URL('../src/images.ts', import.meta.url), 'utf8');
const STARTED = ['model', 'diffusion', 'llm', 'llm_vision', 'clip_l', 't5xxl', 'vae', 'taesd', 'lora'];

test('each picture model file is pinned and its role is one the runner is started with', () => {
  const pics = models.filter(m => m.kind === 'image');
  assert.ok(pics.length >= 9);
  for (const m of pics) {
    assert.ok(m.files.some((f: { role: string }) => f.role === 'model' || f.role === 'diffusion'), `${m.id} has no model file`);
    assert.ok(m.licence, `${m.id} says no licence`);
    for (const f of m.files) {
      assert.ok(STARTED.includes(f.role), `${m.id}: role ${f.role}`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${m.id} ${f.path}`);
      if (f.repo) assert.match(f.rev, /^[0-9a-f]{40}$/, `${m.id} ${f.path}`);
      assert.ok(f.bytes > 0);
    }
  }
});

test('FLUX.1\'s CLIP-L and T5-XXL files are handed to the runner', () => {
  const krea = models.find(m => m.id === 'flux1-krea-dev');
  assert.deepEqual(krea.files.map((f: { role: string }) => f.role), ['diffusion', 'clip_l', 't5xxl', 'vae']);
  assert.match(images, /if \(path\('clip_l'\)\) args\.push\('--clip_l', path\('clip_l'\)!\);/);
  assert.match(images, /if \(path\('t5xxl'\)\) args\.push\('--t5xxl', path\('t5xxl'\)!\);/);
});

test('one file name is one file: models that share a name share the same bytes (it is kept once)', () => {
  const seen = new Map<string, string>();
  for (const m of models) for (const f of m.files) {
    const name = f.saveAs ?? String(f.path ?? f.url).split('/').pop();
    const had = seen.get(name);
    if (had) assert.equal(had, f.sha256, `${name} differs in ${m.id}`);
    seen.set(name, f.sha256);
  }
});

test('the FLUX-family picture models decode in tiles (P1): a whole 1024 px decode did not fit beside the model on a 12 GB card', () => {
  // Measured on the Z820 (RTX 3060 12 GB), 26 Nov: Z-Image Turbo at Mid drew all 8 steps on the card, then "generate_image
  // returned no results" at the decode and the picture moved to the CPU. Z-Image, FLUX.1 Krea and FLUX.2 share that
  // decoder family; the Qwen models (their own decoder) never failed, and keep their arguments as they were.
  const byId = Object.fromEntries(models.map(m => [m.id, m]));
  for (const id of ['z-image-turbo', 'flux1-krea-dev', 'flux2-dev']) assert.ok(byId[id].args.includes('--vae-tiling'), id);
  for (const id of ['qwen-image', 'qwen-image-2.1', 'qwen-image-2.1-turbo']) assert.ok(!byId[id].args.includes('--vae-tiling'), id);
  // RealVisXL (SDXL) has decoded in tiles since 2.0.65, for the same reason on smaller cards.
  assert.ok(byId['realvisxl-v5-lightning'].args.includes('--vae-tiling'));
});
