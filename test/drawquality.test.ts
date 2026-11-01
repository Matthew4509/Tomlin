// Draft / Mid / High and the seed reach a linked PC that draws: they used to stop at this PC, so an artist on another PC
// drew every picture at Mid with a random seed. Rules from src/nodestaff.ts, the way through from the source; drawn for
// real on a 4 GB card once that PC ran this. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawChoices } from '../src/nodestaff.ts';

const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('a good quality and seed are kept; anything else is left to that PC', () => {
  assert.deepEqual(drawChoices({ quality: 'draft', seed: 42 }), { quality: 'draft', seed: 42 });
  assert.deepEqual(drawChoices({ quality: 'high', seed: 0 }), { quality: 'high', seed: 0 });
  assert.deepEqual(drawChoices({ quality: 'mid' }), { quality: 'mid' });
  assert.deepEqual(drawChoices({}), {});
  assert.deepEqual(drawChoices({ quality: 'ultra', seed: -1 }), {});
  assert.deepEqual(drawChoices({ quality: 7, seed: 1.5 }), {});
  assert.deepEqual(drawChoices({ seed: '42' }), {}, 'a seed in words is not a seed');
  assert.deepEqual(drawChoices({ seed: 2 ** 40 }), {}, 'beyond what the runner takes');
});

test('they go all the way: the page, this PC, the door of that PC, and the picture it draws', () => {
  const pictures = read('server/pictures.ts');
  const away = /async function startAway\([\s\S]*?\n\}/.exec(pictures)![0];
  assert.match(away, /\.\.\.drawChoices\(b\)/, 'this PC sends them');
  assert.match(read('jobrun/links.ts'), /export async function drawOn\(r: Remote, ask: \{[^}]*quality\?: string; seed\?: number/);

  const node = read('jobrun/node.ts');
  const door = /async function workerDraw\([\s\S]*?\n\}/.exec(node)![0];
  assert.match(door, /const choices = nodestaff\.drawChoices\(b\);/);
  assert.match(door, /drawShared\(models\.find\(m => m\.id === want\)!, \{ prompt, style, width: size\(b\.width\), height: size\(b\.height\), \.\.\.choices \}/, 'a picture model asked for by name');
  assert.match(door, /d\.draw\(\{ prompt, mode: [^}]*forPc, \.\.\.choices \}/, 'what is connected there');
  const shared = /async function drawShared\([\s\S]*?\n\}/.exec(node)![0];
  assert.match(shared, /d\.draw\(\{ prompt: ask\.prompt, mode: [^}]*forPc, quality: ask\.quality, seed: ask\.seed \}/);

  const forPc = /export async function drawForPc\([\s\S]*?\n\}/.exec(pictures)![0];
  assert.match(forPc, /images\.generate\(\{ prompt: o\.prompt, [^}]*quality: o\.quality as Quality, seed: o\.seed/);
  assert.match(forPc, /drafts: 1/, 'one picture comes back, so one is drawn, even at Draft');
});
