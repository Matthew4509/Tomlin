// Sizes from the prompt, the drawing size, and mode presets (src/sizes.ts, src/modes.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationSize, parseSize } from '../src/sizes.ts';
import { boosted, detectMode, forModel, PRESETS, slug } from '../src/modes.ts';

test('a size in the prompt becomes the target and leaves the prompt', () => {
  assert.deepEqual(parseSize('icon smiley face 120px x 120px'), { size: { width: 120, height: 120 }, prompt: 'icon smiley face' });
  assert.deepEqual(parseSize('600px x 600px photo of a grand piano for a blog post'), { size: { width: 600, height: 600 }, prompt: 'photo of a grand piano for a blog post' });
  assert.deepEqual(parseSize('a cat, 600x400'), { size: { width: 600, height: 400 }, prompt: 'a cat' });
  assert.deepEqual(parseSize('hero image 1200 by 630 pixels of a beach'), { size: { width: 1200, height: 630 }, prompt: 'hero image of a beach' });
  assert.deepEqual(parseSize('favicon of a piano key at 32px'), { size: { width: 32, height: 32 }, prompt: 'favicon of a piano key' });
  assert.deepEqual(parseSize('1920×1080 mountain lake'), { size: { width: 1920, height: 1080 }, prompt: 'mountain lake' });
});

test('numbers that are not sizes stay in the prompt', () => {
  assert.deepEqual(parseSize('a 1920s jazz club'), { size: null, prompt: 'a 1920s jazz club' });
  assert.deepEqual(parseSize('3 cats on a sofa'), { size: null, prompt: '3 cats on a sofa' });
  assert.deepEqual(parseSize('a 9000x9000 poster'), { size: null, prompt: 'a 9000x9000 poster' });
});

test('the model draws about 512 x 512 worth of pixels in the target shape, sides multiples of 64', () => {
  assert.deepEqual(generationSize(null), { width: 512, height: 512 });
  assert.deepEqual(generationSize({ width: 120, height: 120 }), { width: 512, height: 512 });
  assert.deepEqual(generationSize({ width: 600, height: 600 }), { width: 512, height: 512 });
  assert.deepEqual(generationSize({ width: 1200, height: 630 }), { width: 704, height: 384 });
  assert.deepEqual(generationSize({ width: 630, height: 1200 }), { width: 384, height: 704 });
  assert.deepEqual(generationSize({ width: 4000, height: 500 }), { width: 1024, height: 256 });
  for (const s of [generationSize({ width: 1200, height: 630 }), generationSize({ width: 800, height: 600 })]) {
    assert.equal(s.width % 64, 0);
    assert.equal(s.height % 64, 0);
    assert.ok(Math.abs(s.width * s.height - 512 * 512) / (512 * 512) < 0.1);
  }
});

test('modes are picked from the prompt and the size', () => {
  assert.equal(detectMode('icon smiley face', { width: 120, height: 120 }).mode, 'icon');
  assert.equal(detectMode('smiley face', { width: 64, height: 64 }).mode, 'icon');
  assert.equal(detectMode('company logo, a piano key', null).mode, 'icon');
  assert.equal(detectMode('photo of a grand piano for a blog post', { width: 600, height: 600 }).mode, 'blog');
  assert.equal(detectMode('hero image of a beach', null).mode, 'blog');
  assert.equal(detectMode('a dragon made of clouds', null).mode, 'custom');
});

test('the model is not told where the picture will be used', () => {
  assert.equal(boosted('photo of a grand piano for a blog post', PRESETS.blog), 'photo of a grand piano, photorealistic, natural light, high detail');
  assert.equal(forModel('hero image of a beach for my website'), 'hero image of a beach');
  assert.equal(forModel('a dragon made of clouds'), 'a dragon made of clouds');
});

test('a soft picture uses more of the WebP budget, a busy one is squeezed into it', async () => {
  const sharp = (await import('sharp')).default;
  const { webp } = await import('../src/imaging.ts');
  const soft = await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 200, g: 180, b: 150 } } }).blur(2).png().toBuffer();
  const noise = Buffer.alloc(600 * 600 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  const busy = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } }).png().toBuffer();
  assert.ok((await webp(soft)).quality > 82, 'quality raised for a soft picture');
  const b = await webp(busy);
  assert.ok(b.data.length <= 120 * 1024 || b.quality === 45, 'busy picture fits 120 KB, or is at the lowest quality');
});

test('file names come from the prompt', () => {
  assert.equal(slug('photo of a grand piano for a blog post'), 'grand-piano');
  assert.equal(slug('A grand piano in a sunlit room, natural light, high detail'), 'grand-piano-sunlit-room-natural-light');
  assert.equal(slug('!!!'), 'picture');
});

test('background removal keeps a drawn shape and clears the white around it (needs models/helpers/u2netp.onnx)', async t => {
  const { existsSync } = await import('node:fs');
  const model = new URL('../models/helpers/u2netp.onnx', import.meta.url);
  if (!existsSync(model)) return t.skip('u2netp.onnx not downloaded');
  const sharp = (await import('sharp')).default;
  const { subjectMask } = await import('../src/rembg.ts');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#fff"/><circle cx="128" cy="128" r="70" fill="#d23"/></svg>');
  const png = await sharp(svg).png().toBuffer();
  const { mask, size } = await subjectMask((await import('node:url')).fileURLToPath(model), png);
  assert.deepEqual(size, { width: 256, height: 256 });
  assert.equal(mask.length, 256 * 256, 'one byte a pixel');
  assert.ok(mask[128 * 256 + 128] > 200, 'centre of the shape is kept');
  assert.ok(mask[5 * 256 + 5] < 30 && mask[250 * 256 + 250] < 30, 'corners are cleared');
});

test('"make an image of" and its kin never reach the model; the picture words stay', () => {
  assert.equal(forModel('Make an image of a grand piano'), 'a grand piano');
  assert.equal(forModel('can you draw me a picture of a cat on a sofa'), 'a cat on a sofa');
  assert.equal(forModel('please generate an illustration of a coffee cup, for a blog post'), 'a coffee cup');
  assert.equal(forModel('a photo of a piano'), 'a photo of a piano');
  assert.equal(forModel('an image of the sea at dusk'), 'the sea at dusk');
});
