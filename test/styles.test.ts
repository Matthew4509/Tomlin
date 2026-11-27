// Picture styles and their samples (src/styles.ts): the words each adds and leaves out, the four old values kept, the
// sample's record made only from a drawn picture's facts, and the pages that show them. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/styles.ts';
import { PRESETS } from '../src/modes.ts';
import { optionsFrom } from '../src/images.ts';
import { cleanItem } from '../src/queue.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('every style has its own id, a name, words, a shape and a mode; Auto comes first', () => {
  assert.equal(S.STYLES[0].id, 'auto');
  assert.equal(S.STYLES.length, 11);
  assert.equal(new Set(S.STYLES.map(s => s.id)).size, S.STYLES.length);
  for (const s of S.STYLES) {
    assert.ok(s.name && s.about, s.id);
    assert.ok(s.shape === 'auto' || s.shape in S.SHAPES, s.id);
    assert.ok(['auto', 'blog', 'icon', 'cartoon', 'custom'].includes(s.mode), s.id);
    if (s.mode !== 'auto') assert.ok(s.boost && s.negative, `${s.id} adds and leaves out words`);
    assert.doesNotMatch(`${s.name} ${s.about}`, /#[0-9a-f]{3,6}\b/i, 'no colour codes in words');
  }
  for (const name of ['Photo', 'Cinematic', 'Anime', 'Chinese ink', 'Chinese drama (realistic)', 'Cartoon', 'Watercolour', 'Surreal', 'Pixel art', 'Flat icon']) assert.ok(S.STYLES.some(s => s.name === name), name);
  assert.equal(S.styleOf('cinematic')!.shape, '16:9');
  assert.equal(S.styleOf('icon')!.shape, '1:1');
  assert.equal(S.styleOf('cdrama')!.shape, '16:9');
  assert.match(S.styleOf('cdrama')!.negative, /3d render/);
  assert.match(S.styleOf('cdrama')!.boost, /Chinese people/);
});

test('Photo, Cartoon and Flat icon are their modes exactly; every other style rides on Custom with its own words', () => {
  for (const [id, mode] of [['photo', 'blog'], ['cartoon', 'cartoon'], ['icon', 'icon']] as const) {
    const s = S.styleOf(id)!;
    assert.equal(s.mode, mode);
    assert.deepEqual(S.presetOf(s), PRESETS[mode], `${id} draws as ${mode} always did`);
    assert.deepEqual(S.extraWords(s), { boost: '', negative: '' }, 'nothing more for a linked PC');
  }
  for (const s of S.STYLES.filter(x => !['auto', 'photo', 'cartoon', 'icon'].includes(x.id))) {
    // The page (images.js modeOfStyle) sends Custom for every value that is not one of the four.
    assert.equal(s.mode, 'custom', s.id);
    const p = S.presetOf(s);
    assert.equal(p.boost, s.boost);
    assert.equal(p.drafts, PRESETS.custom.drafts);
    assert.deepEqual(S.extraWords(s), { boost: s.boost, negative: s.negative });
  }
  assert.throws(() => S.presetOf(S.styleOf('auto')!));
  assert.deepEqual(S.extraWords(null), { boost: '', negative: '' });
});

test('the old values are still read: blog is Photo, auto is no style; unknown values are none', () => {
  assert.equal(S.styleOf('blog')!.id, 'photo');
  assert.equal(S.pickedStyle('auto'), null);
  assert.equal(S.pickedStyle('nonsense'), null);
  assert.equal(S.pickedStyle(7), null);
  for (const s of S.STYLES) assert.equal(S.styleOf(S.formValue(s))!.id, s.id);
  assert.deepEqual(S.STYLES.filter(s => ['auto', 'photo', 'icon', 'cartoon'].includes(s.id)).map(S.formValue), ['auto', 'blog', 'cartoon', 'icon']);
});

test('a picture request carries the style: its mode and its id; the mode alone works as before', () => {
  const anime = optionsFrom({ prompt: 'a cat', style: 'anime', mode: 'custom' }, 'page');
  assert.equal(anime.mode, 'custom');
  assert.equal(anime.look, 'anime');
  const old = optionsFrom({ prompt: 'a cat', mode: 'blog' }, 'page');
  assert.equal(old.mode, 'blog');
  assert.equal(old.look, undefined, 'an older page sends no style');
  assert.equal(optionsFrom({ prompt: 'a cat', style: 'blog' }, 'page').mode, 'blog');
  assert.equal(optionsFrom({ prompt: 'a cat', style: 'auto', mode: 'icon' }, 'page').mode, 'icon', 'Auto leaves the mode as sent');
  assert.equal(optionsFrom({ prompt: 'a cat', style: '<b>', mode: 'cartoon' }, 'page').look, undefined);
});

test('words go on the end of the prompt and the leave-out list', () => {
  assert.equal(S.withWords('a fox. ', 'anime style'), 'a fox, anime style');
  assert.equal(S.withWords('a fox', ''), 'a fox');
  assert.equal(S.bothNegative(' blurry ', 'text'), 'blurry, text');
  assert.equal(S.bothNegative(undefined, 'text'), 'text');
});

test('a shape at the model\'s own size keeps about as many pixels', () => {
  assert.equal(S.shapeSize('auto', 512), null);
  assert.deepEqual(S.shapeSize('1:1', 512), { width: 512, height: 512 });
  assert.deepEqual(S.shapeSize('16:9', 512), { width: 680, height: 384 });
  assert.deepEqual(S.shapeSize('9:16', 1024), { width: 768, height: 1368 });
});

test('the samples: one per style but Auto, the same prompt, seed and quality, each in its shape', () => {
  const items = S.sampleItems('ann', 512);
  assert.equal(items.length, 10);
  assert.equal(S.SAMPLE_PROMPT, 'a red fox sitting in a snowy pine forest at dusk');
  for (const it of items) {
    assert.equal(it.prompt, S.SAMPLE_PROMPT);
    assert.equal(it.seed, S.SAMPLE_SEED);
    assert.equal(it.quality, 'mid');
    assert.equal(it.sample, true);
    assert.equal(it.as, 'ann');
    const s = S.styleOf(it.style)!;
    assert.equal(it.mode, s.mode);
    assert.deepEqual({ width: it.width, height: it.height }, S.shapeSize(s.shape, 512) ?? { width: undefined, height: undefined });
  }
});

const drawnPic = (o: Partial<S.DrawnFacts> = {}): S.DrawnFacts => ({ prompt: S.SAMPLE_PROMPT, seed: 4242, steps: 20, seconds: 12.34, target: { width: 680, height: 384 }, at: '2026-11-27T10:00:00.000Z', format: 'png', ...o });

test('a sample\'s record is made from the drawn picture and what drew it, nothing else', () => {
  const r = S.sampleRecord('cinematic', drawnPic(), { model: 'dreamshaper-8', modelName: 'DreamShaper 8 (SD 1.5)', pc: 'Worker PC' });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { style: 'cinematic', model: 'dreamshaper-8', modelName: 'DreamShaper 8', pc: 'Worker PC', seconds: 12.3, steps: 20, width: 680, height: 384, seed: 4242, prompt: S.SAMPLE_PROMPT, at: '2026-11-27T10:00:00.000Z', file: 'cinematic.png' });
  assert.equal(S.honestLine(r), 'Drawn by DreamShaper 8 on Worker PC in 12 s, 680×384, 20 steps, 27 Nov 2026');
  const photo = S.sampleRecord('blog', drawnPic({ format: 'webp' }), { model: 'rv6', modelName: 'Realistic Vision', pc: 'Here' });
  assert.ok(!('error' in photo) && photo.style === 'photo' && photo.file === 'photo.webp');
  // Not enough to be honest: refused in words, never filled in.
  assert.match((S.sampleRecord('anime', drawnPic(), { model: null, modelName: 'X', pc: 'P' }) as { error: string }).error, /did not say which picture model/);
  assert.match((S.sampleRecord('anime', drawnPic({ settingsUnknown: true }), { model: 'm', pc: 'P' }) as { error: string }).error, /steps and seed/);
  assert.match((S.sampleRecord('anime', drawnPic({ prompt: 'a dog' }), { model: 'm', pc: 'P' }) as { error: string }).error, /sample prompt/);
  assert.ok('error' in S.sampleRecord('auto', drawnPic(), { model: 'm', pc: 'P' }));
  assert.ok('error' in S.sampleRecord('anime', drawnPic(), { model: '../x', pc: 'P' }));
});

test('a record read back keeps only what fits', () => {
  const r = S.sampleRecord('pixel', drawnPic(), { model: 'm1', modelName: 'M', pc: 'P' }) as S.SampleRecord;
  assert.deepEqual(S.cleanRecord(JSON.parse(JSON.stringify(r))), r);
  assert.equal(S.cleanRecord({ ...r, file: 'other.png' }), null);
  assert.equal(S.cleanRecord({ ...r, model: '..' }), null);
  assert.equal(S.cleanRecord({ ...r, seconds: 'fast' }), null);
  assert.equal(S.cleanRecord(null), null);
});

test('a queue line keeps its style and sample flag; a sample needs a style', () => {
  const base = { id: 'a1', kind: 'picture', state: 'waiting', title: 't', added: 'x', project: '' };
  const it = cleanItem({ ...base, look: 'ink', sample: true })!;
  assert.equal(it.look, 'ink');
  assert.equal(it.sample, true);
  const none = cleanItem({ ...base, look: 'bogus', sample: true })!;
  assert.equal(none.look, undefined);
  assert.equal(none.sample, undefined);
  assert.equal(cleanItem(base)!.look, undefined, 'an older line has none');
});

test('the queue keeps a sample only from the drawn picture, and the server serves the samples', () => {
  const q = read('src/server/queue.ts');
  assert.match(q, /keepSample\(it\.look, got\.pic, got\.drawn\)/);
  assert.match(q, /'\/api\/stylesamples\/make'/);
  const ss = read('src/server/stylesamples.ts');
  assert.match(ss, /sampleRecord\(styleId, pic, drawn\)/);
  assert.match(ss, /'\/api\/stylesamples'/);
  assert.match(ss, /'\/api\/stylesamples\/file'/);
  assert.match(read('src/server.ts'), /styleSamplesGet/);
  const p = read('src/server/pictures.ts');
  // What drew it: this PC's model, or the id the linked PC sent back.
  assert.match(p, /drawn: \{ model: pic\.model, modelName: pic\.modelName, pc: thisPcName\(\) \}/);
  assert.match(p, /model: got\.made\?\.model \|\| null/);
});

test('the Images window: the Style inputs stay for every style, with tiles; Character sets and Hire staff show samples', () => {
  const html = read('public/index.html');
  for (const s of S.STYLES) assert.match(html, new RegExp(`name="img-style" value="${S.formValue(s)}"`), s.id);
  assert.match(html, /id="img-style-tiles"/);
  assert.match(html, /Make the style samples/);
  assert.match(html, /<h3 id="hs-styles-title">Image styles<\/h3>/);
  assert.ok(html.indexOf('src="stylepick.js"') < html.indexOf('src="images.js"'));
  const pick = read('public/stylepick.js');
  // Said once above the tiles (missingLine), and in the larger picture's words of a tile with none.
  assert.match(pick, /No sample yet for \$\{name\}/);
  assert.match(pick, /function missingLine\(data, model, modelName\)/);
  assert.match(pick, /Sample from \$\{got\.r\.modelName\}, not yours/);
  assert.match(pick, /addEventListener\('focus'/, 'keyboard focus shows the larger picture too');
  assert.doesNotMatch(pick, /#[0-9a-f]{6}\b/i);
  const img = read('public/images.js');
  assert.match(img, /style: styleNow\(\)/);
  assert.match(img, /setRadio\('img-shape', s\.shape\)/);
  assert.match(read('public/queue.js'), /mode: \$\('#img-mode'\)\.value, style,/);
  assert.match(read('public/charsets.js'), /stylePick\.tiles\(/);
  assert.match(read('public/hire.js'), /stylePick\.strip\(key\)/);
  const css = read('public/style.css');
  const block = css.slice(css.indexOf('/* The Style picker (stylepick.js)'));
  for (const m of block.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, 'colours come from the page tokens');
});
