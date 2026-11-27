// Reference pictures (Character sets, src/cards.ts): the two models that take them, the pictures made small and sent as
// ref_images, only as many as a model takes, kept with the picture so Full quality and Draw again use them too, and
// never taken from the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { optionsFrom, refPictures } from '../src/images.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const card = (id: string) => JSON.parse(read(`registry/${id}.json`));

test('Qwen-Image-Edit 2511 and FLUX.2 Klein 4B take references; Apache-2.0; the 2511 switch and the vision part are there', () => {
  const q = card('qwen-image-edit-2511');
  assert.equal(q.refs, 3);
  assert.match(q.licence, /^Apache-2\.0/);
  assert.equal(q.nonCommercial, undefined);
  assert.deepEqual(q.files.map((f: { role: string }) => f.role), ['diffusion', 'llm', 'llm_vision', 'vae']);
  // Without it, 2511's editing comes out much worse (stable-diffusion.cpp docs/models/qwen_image_edit.md).
  assert.ok(q.args.join(' ').includes('--model-args qwen_image_zero_cond_t=true'));
  const k = card('flux2-klein-4b');
  assert.equal(k.refs, 4);
  assert.match(k.licence, /^Apache-2\.0/);
  assert.equal(k.defaults.steps, 4);
  assert.equal(k.defaults.cfg, 1);
  // The same VAE file as FLUX.2 dev, so a PC with both keeps one copy.
  assert.deepEqual(k.files.find((f: { role: string }) => f.role === 'vae'), card('flux2-dev').files.find((f: { role: string }) => f.role === 'vae'));
  // No other model says it takes references.
  for (const id of ['z-image-turbo', 'qwen-image-2.1', 'qwen-image', 'flux2-dev', 'flux1-krea-dev', 'realvisxl-v5-lightning']) assert.equal(card(id).refs, undefined, id);
  assert.match(read('src/images.ts'), /if \(path\('llm_vision'\)\) args\.push\('--llm_vision', path\('llm_vision'\)!\);/);
});

test('refPictures: at most as many as the model takes, at most 1024 on a side, PNG; one that is missing is passed over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refs-'));
  try {
    const big = join(dir, 'big.png');
    const small = join(dir, 'small.webp');
    await sharp({ create: { width: 2048, height: 1024, channels: 3, background: { r: 200, g: 120, b: 30 } } }).png().toFile(big);
    await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 120, b: 30 } } }).webp().toFile(small);
    writeFileSync(join(dir, 'not.png'), 'not a picture');
    assert.deepEqual(await refPictures([big, small], 0), [], 'a model that takes none gets none');
    assert.deepEqual(await refPictures(undefined, 4), []);
    const got = await refPictures([join(dir, 'gone.png'), join(dir, 'not.png'), big, small], 4);
    assert.equal(got.length, 2);
    const m0 = await sharp(Buffer.from(got[0], 'base64')).metadata();
    assert.equal(m0.format, 'png');
    assert.equal(m0.width, 1024);
    assert.equal(m0.height, 512);
    const m1 = await sharp(Buffer.from(got[1], 'base64')).metadata();
    assert.equal(m1.width, 300, 'never made bigger');
    // Only the first `most` paths are tried.
    assert.equal((await refPictures([big, small], 1)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page cannot name files: refs come only from the project\'s cards, on the server', () => {
  assert.equal((optionsFrom({ prompt: 'x', refs: ['C:/Windows/win.ini'] }, 'page') as { refs?: unknown }).refs, undefined);
  const pic = read('src/server/pictures.ts');
  assert.match(pic, /refs = e\.refs;/);
  assert.match(pic, /images\.generate\(\{ \.\.\.optionsFrom\(b, 'page'\), chat: chat\?\.id \?\? '', \.\.\.\(refs\.length \? \{ refs \} : \{\}\) \}\)/);
  const cards = read('src/server/cards.ts');
  assert.match(cards, /const at = await ws\.inside\(root, `\$\{c\.folder\}\/\$\{r\}`, false\);\s*if \(!at\) continue;\s*refs\.push\(at\);/);
});

test('sent as ref_images, and kept with the picture so Full quality and Draw again use them', () => {
  const img = read('src/images.ts');
  // A linked PC's pictures, sent as data (refData), go in place of files read here: each read and made again first.
  assert.match(img, /const refImages = job\.opts\.refData\?\.length \? await refPicturesOf\(job\.opts\.refData, m\.refs \?\? 0\) : await refPictures\(job\.opts\.refs, m\.refs \?\? 0\);/);
  assert.match(img, /\.\.\.\(refImages\.length \? \{ ref_images: refImages \} : \{\}\),/);
  assert.match(img, /if \(base\?\.refs\?\.length && !opts\.refs\?\.length\) opts = \{ \.\.\.opts, refs: base\.refs \};/);
  assert.match(img, /\.\.\.\(job\.opts\.refs\?\.length && m\.refs \? \{ refs: job\.opts\.refs\.slice\(0, m\.refs\) \} : \{\}\),/);
});
