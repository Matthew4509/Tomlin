// Pictures, for any model (2.0.65): Draft / Mid / High (small, the model's own size, its largest), each model drawn at
// its own size (Qwen-Image was drawn at a quarter of its pixels), Icon never picked by itself for people or from a small
// size alone, two or more people drawn wide, "leave out" words that work on the fast models, and quick drafts to pick
// from when they are cheap. Pure rules in src/quality.ts and src/modes.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectMode, groupAsk } from '../src/modes.ts';
import { cfgFor, draftCount, GROUP_SIZE, QUALITIES, qualitySide, qualitySize } from '../src/quality.ts';
import { generationSize } from '../src/sizes.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const model = (id: string) => JSON.parse(read(`registry/${id}.json`));
const SD15 = model('sd15-realistic-lcm');
const QWEN = model('qwen-image-2.1');

test('Icon is never picked by itself when people are asked for, nor from a small size alone', () => {
  for (const p of ['two women talking in a park', 'a logo of 2 people', 'a couple dancing, icon', 'a family picnic emoji', 'an old man reading']) {
    const d = detectMode(p, null);
    assert.notEqual(d.mode, 'icon', p);
  }
  assert.match(detectMode('a logo of 2 people', null).why, /people/);
  assert.notEqual(detectMode('a red bicycle', { width: 256, height: 256 }).mode, 'icon', 'a small size alone is not an icon');
  // Still Icon when asked for, with no people in it.
  assert.equal(detectMode('a coffee cup icon', null).mode, 'icon');
  assert.equal(detectMode('a house logo with a green roof', { width: 128, height: 128 }).mode, 'icon');
});

test('two or more people: drawn wide when no size was given', () => {
  for (const p of ['two people talking', '2 women kissing', 'a couple on a beach', 'a family picnic', 'three friends laughing', 'a group of children playing', 'a man and a woman at a table', 'twins on a swing']) assert.equal(groupAsk(p), true, p);
  for (const p of ['a woman reading', 'three cats', 'two apples on a table', 'a lighthouse', 'one man']) assert.equal(groupAsk(p), false, p);
  assert.ok(GROUP_SIZE.width > GROUP_SIZE.height);
  const g = generationSize(GROUP_SIZE, 512);
  assert.ok(g.width > g.height, `${g.width}x${g.height}`);
});

test('Draft / Mid / High: each model its own sizes; Qwen-Image no longer at a quarter of its pixels', () => {
  assert.deepEqual(QUALITIES, ['draft', 'mid', 'high']);
  assert.equal(qualitySide(SD15, 'mid'), 512, 'SD 1.5 is made for 512');
  assert.ok(qualitySide(SD15, 'draft') < 512);
  assert.ok(qualitySide(SD15, 'high') >= 512);
  assert.ok(qualitySide(QWEN, 'mid') >= 768, 'Qwen-Image mid is at least 768');
  assert.ok(qualitySide(QWEN, 'high') >= 1024, 'Qwen-Image high is about 1 megapixel');
  assert.ok(qualitySide(QWEN, 'draft') < qualitySide(QWEN, 'mid'));
  // A model with no list of its own: derived from its native size.
  const plain = { native: 512, defaults: { steps: 20, cfg: 7 } } as never;
  assert.ok(qualitySide(plain, 'draft') < 512 && qualitySide(plain, 'mid') === 512 && qualitySide(plain, 'high') >= 512);
  // The size drawn keeps the shape asked for.
  const wide = qualitySize(QWEN, 'high', { width: 1600, height: 900 });
  assert.ok(wide.width > wide.height && wide.width % 64 === 0 && wide.height % 64 === 0);
  assert.deepEqual(qualitySize(SD15, 'mid', null), { width: 512, height: 512 });
});

test('Draft draws several quick pictures to pick from when the model is fast; Mid and High draw one', () => {
  assert.equal(draftCount(SD15, 'draft'), 4, 'a 4-step model: four drafts');
  assert.equal(draftCount(QWEN, 'draft'), 2, 'a slow model: two');
  assert.equal(draftCount(SD15, 'mid'), 1);
  assert.equal(draftCount(QWEN, 'high'), 1);
});

test('"leave out" words work on the fast models: their guidance goes up from 1 (where they are ignored) for Mid and High', () => {
  assert.equal(SD15.defaults.cfg, 1);
  assert.equal(cfgFor(SD15, 'mid', 'text, watermark'), 1.5);
  assert.equal(cfgFor(SD15, 'high', 'text'), 1.5);
  assert.equal(cfgFor(SD15, 'draft', 'text'), 1, 'drafts stay quick');
  assert.equal(cfgFor(SD15, 'mid', ''), 1, 'nothing to leave out: no cost');
  assert.equal(cfgFor(QWEN, 'mid', 'text'), QWEN.defaults.cfg, 'a model that reads them already keeps its own');
});

test('the page has Draft / Mid / High beside Draw, sends it, and says when a background was cut away', () => {
  const html = read('public/index.html');
  assert.match(html, /<div class="img-quality" role="radiogroup" aria-label="Quality">/);
  for (const q of ['draft', 'mid', 'high']) assert.match(html, new RegExp(`<input type="radio" name="img-quality" value="${q}"`));
  const js = read('public/images.js');
  assert.match(js, /quality: \$\('input\[name="img-quality"\]:checked'\)\?\.value \?\? 'mid'/);
  assert.match(js, /store\('img-quality'/);
  assert.match(js, /Background cut away \(Icon mode\)/);
  const server = read('src/images.ts');
  assert.match(server, /qualitySize\(m, quality, target0\)/);
  assert.match(server, /draft: !final && quality === 'draft'/);
});

test('High is sharpened when the sharpener is downloaded: the runner is told its folder, and each picture goes through its upscale request', () => {
  const up = model('realesrgan-x4-anime6b');
  assert.equal(up.kind, 'helper');
  assert.equal(up.files.length, 1);
  assert.equal(up.files[0].role, 'upscaler');
  assert.match(up.files[0].rev, /^[0-9a-f]{40}$/);
  assert.match(up.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(up.licence, /BSD-3-Clause/);
  const server = read('src/images.ts');
  assert.match(server, /args\.push\('--hires-upscalers-dir', this\.upscalerDir\)/);
  assert.match(server, /\/sdcpp\/v1\/upscale/);
  assert.match(server, /const upscale = !base && quality === 'high' && this\.upscalerReady\(\);/);
  // Only on a graphics card: on a CPU it is far too slow (measured). An answer that takes minutes is waited for.
  assert.ok(server.includes("this.upscalerDir === dirname(up.path) && (this.pane.view.device ?? 'cpu') !== 'cpu'"));
  assert.ok(server.includes('postLong(`${base}/sdcpp/v1/upscale`'));
  // Enlarged to twice the drawn size when no size was asked for; a failed sharpen keeps the picture and says so.
  assert.match(server, /target0 \?\? \(upscale \? \{ width: generated\.width \* 2, height: generated\.height \* 2 \} : generated\)/);
  assert.match(server, /the sharpener did not run/);
});

test('the middle model: RealVisXL V5 Lightning (SDXL, 1024), pinned, commercial use allowed, two drafts not four', () => {
  const x = model('realvisxl-v5-lightning');
  assert.equal(x.kind, 'image');
  assert.equal(x.native, 1024);
  assert.equal(x.nonCommercial ?? false, false);
  assert.deepEqual(x.files.map((f: { role: string }) => f.role).sort(), ['model', 'taesd', 'vae']);
  for (const f of x.files) {
    assert.match(f.rev, /^[0-9a-f]{40}$/, f.path);
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
    assert.ok(f.bytes > 1_000_000, f.path);
  }
  // Its fast decoder is saved under its own name, not over the SD 1.5 one.
  const taesd = x.files.find((f: { role: string }) => f.role === 'taesd');
  assert.notEqual(taesd.saveAs, model('sd15-realistic-lcm').files.find((f: { role: string }) => f.role === 'taesd').saveAs);
  assert.equal(draftCount(x, 'draft'), 2, 'a 1024 model is not cheap: two drafts');
  assert.equal(qualitySide(x, 'mid'), 1024);
});

test('Mid and High are finished with the full decoder; only a Draft uses the fast one (a 1024 Mid showed its grid)', () => {
  const server = read('src/images.ts');
  assert.ok(server.includes("const wantDecoder: Decoder = (plan.draft && !plan.final) && m.files.some(f => f.role === 'taesd') ? 'fast' : 'full';"));
});
