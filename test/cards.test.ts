// Character sets (src/cards.ts): a card's name and fields cleaned, @names filled in from the project's cards, and the
// views Make a sheet draws. Behaviour, not source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanCard, cleanName, expandPrompt, sheetPrompts, type Card } from '../src/cards.ts';
import { partOf as partOfName } from '../src/projectwork.ts';

const ember: Card = { kind: 'character', name: 'Ember', words: 'a young red fox, bright orange coat, white chest, amber eyes.', avoid: 'collar', refs: ['front.png'], at: '' };
const forest: Card = { kind: 'location', name: 'Pine forest', words: 'tall pines in deep snow, soft morning light', avoid: 'people', refs: [], at: '' };
const night: Card = { kind: 'location', name: 'Pine forest at night', words: 'tall pines in snow under a full moon', avoid: '', refs: [], at: '' };

test('names: letters, numbers, spaces, - and \', at most 40; nothing that could leave its folder', () => {
  assert.equal(cleanName('  Ember  '), 'Ember');
  assert.equal(cleanName("Mrs O'Hara-Smith 2"), "Mrs O'Hara-Smith 2");
  assert.equal(cleanName('Zoë'), 'Zoë');
  for (const bad of ['', ' ', '../x', 'a/b', 'a\\b', '.hidden', '-x', 'x'.repeat(41), 'Ember!', 12]) assert.equal(cleanName(bad), null, String(bad));
});

test('a card read back: its kind and name checked, words cut to length, refs only picture files in its own folder', () => {
  assert.equal(cleanCard({ kind: 'monster', name: 'X' }), null);
  assert.equal(cleanCard({ kind: 'character', name: '../x' }), null);
  const c = cleanCard({ kind: 'character', name: 'Ember', words: '  a  fox \n red ', avoid: 'x'.repeat(400), refs: ['a.png', 'a.png', '../b.png', 'c.txt', '.d.png', 'e.webp', 'f.jpg', 'g.jpeg', 'h.png'] });
  assert.ok(c);
  assert.equal(c.words, 'a fox red');
  assert.equal(c.avoid.length, 300);
  assert.deepEqual(c.refs, ['a.png', 'e.webp', 'f.jpg', 'g.jpeg']);
});

test('@names: each named card adds its words once, characters first; the longest name wins; any case; whole names only', () => {
  const e = expandPrompt('@ember leaping a log in @Pine forest at night, @Ember again', [ember, forest, night]);
  assert.equal(e.prompt, 'Ember leaping a log in Pine forest at night, Ember again. Ember: a young red fox, bright orange coat, white chest, amber eyes. Pine forest at night: tall pines in snow under a full moon.');
  assert.deepEqual(e.used.map(c => c.name), ['Ember', 'Pine forest at night']);
  assert.equal(e.avoid, 'collar');
  // Not a whole name: left as typed.
  assert.equal(expandPrompt('@Embers glowing', [ember]).prompt, '@Embers glowing');
  // No @: as typed, nothing used.
  const plain = expandPrompt('a fox in a forest', [ember, forest]);
  assert.equal(plain.prompt, 'a fox in a forest');
  assert.equal(plain.used.length, 0);
  // A card with no words: its name only.
  assert.equal(expandPrompt('@Ember runs', [{ ...ember, words: '' }]).prompt, 'Ember runs');
});

test('Make a sheet: 5 character views on a plain background, 3 location plates, the card words in each', () => {
  const s = sheetPrompts(ember);
  assert.equal(s.length, 5);
  assert.ok(s.every(p => p.includes('Ember, a young red fox') && p.includes('plain light grey background')));
  assert.ok(s[3].includes('back view'));
  const l = sheetPrompts(forest);
  assert.equal(l.length, 3);
  assert.ok(l[0].startsWith('Pine forest, tall pines in deep snow') && l[0].includes('wide shot'));
  // The page queues the same views (charsets.js), so the two lists must agree.
  const page = readFileSync(new URL('../public/charsets.js', import.meta.url), 'utf8');
  for (const v of ['full body, front view', 'full body, three-quarter view', 'full body, side view', 'full body, back view', 'head and shoulders close-up, front view', 'wide shot', 'middle shot', 'close detail shot']) assert.ok(page.includes(`'${v}'`), v);
  assert.ok(page.includes('plain light grey background, even studio light, no other people'));
});

test('the project page leaves characters and locations out of its work lists (they have their own strip)', () => {
  assert.equal(partOfName('specialists/characters/Ember/front.png'), null);
  assert.equal(partOfName('specialists/locations/Pine forest/card.json'), null);
  assert.equal(partOfName('specialists/images/a.png'), 'pictures');
});
