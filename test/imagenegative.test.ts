// The Images form's Leave out: typed words, and the hidden ones shown by where they come from (the artist's recipe,
// the style, a portrait, the model), each one removable. Rules from src/images.ts; the page from public/. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { joinNegative, NEGATIVE_SOURCES, negativeParts, optionsFrom } from '../src/images.ts';
import { PORTRAIT_NEGATIVE, PRESETS } from '../src/modes.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('with nothing taken out, the negative is what it always was', () => {
  const typed = 'blurry, two heads';
  const recipe = 'photo, realistic, text';
  const model = 'lowres, blurry, deformed, watermark, text';
  const parts = negativeParts({ typed, recipe, mode: PRESETS.icon.negative, portrait: true, model });
  assert.equal(joinNegative(parts), [typed, recipe, PRESETS.icon.negative, PORTRAIT_NEGATIVE, model].join(', '));
  assert.deepEqual(parts.map(p => p.source), ['typed', 'recipe', 'mode', 'portrait', 'model']);
  assert.deepEqual(parts[1].words, ['photo', 'realistic', 'text']);
  assert.equal(joinNegative(negativeParts({ mode: '', model: '' })), '', 'nothing to leave out');
  assert.deepEqual(negativeParts({ portrait: false, model: ' , ' }), [], 'empty sources are left out');
});

test('a source turned off, or one hidden word dropped, goes; typed words never do', () => {
  const parts = negativeParts({ typed: 'text, cats', recipe: 'photo, Text', mode: 'watermark, text', model: 'lowres' });
  assert.equal(joinNegative(parts, ['recipe']), 'text, cats, watermark, text, lowres');
  assert.equal(joinNegative(parts, ['recipe', 'mode', 'portrait', 'model']), 'text, cats', 'all hidden off: only what was typed');
  assert.equal(joinNegative(parts, [], ['text']), 'text, cats, photo, watermark, lowres', 'dropped from every source, case ignored, typed kept');
  assert.equal(joinNegative(parts, ['model'], ['WATERMARK', 'photo']), 'text, cats, Text, text');
});

test('optionsFrom keeps only good sources and short dropped words', () => {
  const o = optionsFrom({ prompt: 'a boat', negativeOff: ['mode', 'model', 'mode', 'typed', 'bogus', 7], negativeDrop: [' text ', '', 3, 'x'.repeat(81), 'watermark'] }, 'page');
  assert.deepEqual(o.negativeOff, ['mode', 'model'], 'each source once, in order; typed words cannot be turned off');
  assert.deepEqual(o.negativeDrop, ['text', 'watermark']);
  const none = optionsFrom({ prompt: 'a boat', negativeOff: 'mode', negativeDrop: 'text' }, 'api');
  assert.equal(none.negativeOff, undefined, 'not a list: ignored');
  assert.equal(none.negativeDrop, undefined);
  assert.equal(optionsFrom({ prompt: 'a', negativeDrop: Array.from({ length: 150 }, (_, i) => `w${i}`) }, 'api').negativeDrop!.length, 100);
  assert.deepEqual([...NEGATIVE_SOURCES], ['recipe', 'mode', 'portrait', 'model']);
  assert.equal(optionsFrom({ prompt: 'a', drafts: 3 }, 'api').drafts, 3, 'the drafts option still works for the API');
});

test('drawing and the plan use the same parts, and the plan names the artist', () => {
  const src = read('src/images.ts');
  assert.match(src, /const negative = base \? base\.negative : joinNegative\(negativeParts\(\{ typed: opts\.negative, recipe: recipe\?\.negative, mode: preset\.negative, portrait: portraitAsk\(parsed\.prompt\), model: defaults\.negative \}\), opts\.negativeOff, opts\.negativeDrop\);/);
  const plan = /if \(p === '\/api\/images\/plan'\) \{[\s\S]*?\n {4}\}/.exec(src)![0];
  assert.match(plan, /url\.searchParams\.get\('as'\)/);
  // The style's own words when one is picked (src/styles.ts), else the mode's, as generate does.
  assert.match(plan, /const preset = look \? presetOf\(look\) : PRESETS\[mode\];/);
  assert.match(plan, /negativeParts\(\{ recipe: recipe\?\.negative, mode: preset\.negative, portrait: portraitAsk\(parsed\.prompt\), model: m\?\.defaults\?\.negative \}\)\.filter\(x => x\.source !== 'typed'\)/);
  assert.match(plan, /better: this\.betterFor\(mode, m\), negative \}/);
});

test('the form: essentials first, one closed Advanced, no Drafts field', () => {
  const html = read('public/index.html');
  const form = /<form class="img-form draw-box" id="img-form">[\s\S]*?<\/form>/.exec(html)![0];
  const at = (s: string) => form.indexOf(s);
  for (const s of ['id="img-prompt"', 'id="img-chips"', 'name="img-shape"', 'name="img-style"', 'id="img-go"', 'id="img-advanced"']) assert.ok(at(s) > 0, s);
  assert.ok(at('id="img-prompt"') < at('id="img-chips"') && at('id="img-chips"') < at('name="img-shape"') && at('name="img-shape"') < at('name="img-style"') && at('name="img-style"') < at('id="img-go"') && at('id="img-go"') < at('id="img-advanced"'));
  assert.doesNotMatch(form, /<details class="img-advanced" id="img-advanced" open/, 'closed by default');
  assert.equal(form.match(/<details/g)!.length, 2, 'Advanced and, inside it, the list fold');
  assert.ok(at('id="img-list-box"') > at('id="img-advanced"'));
  assert.doesNotMatch(form, /img-drafts/);
  for (const v of ['auto', '1:1', '4:3', '16:9', '9:16']) assert.match(form, new RegExp(`name="img-shape" value="${v}"`));
  for (const v of ['auto', 'blog', 'icon', 'cartoon']) assert.match(form, new RegExp(`name="img-style" value="${v}"`));
  assert.match(form, /<select id="img-sampler"><option value="">Auto<\/option><option value="lcm">Fast \(lcm\)<\/option>/);
  // queue.js reads these: they stay, filled from Shape, Style and Advanced.
  for (const id of ['img-mode', 'img-w', 'img-h']) assert.match(form, new RegExp(`<input type="hidden" id="${id}"`));
  const js = read('public/images.js');
  assert.match(js, /negativeDrop: droppedWords\.length \? droppedWords : undefined/);
  assert.doesNotMatch(js, /drafts: num\(/);
  assert.match(js, /localStorage\.setItem\(formKey\(\), JSON\.stringify\(kept\)\)/);
});
