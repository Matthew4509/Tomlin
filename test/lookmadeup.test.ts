// A hire's made-up look (public/look.js fromId): the same person whatever their role. The role only adds its things
// (a coder's headphones, a designer's beret, glasses), so a Default hire changed to Coder is not drawn as someone else
// (3 Nov: Rosa's skin, hair and top changed with her role, because the coder's headphones took a draw before them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { LOOK_OPTIONS } from '../src/look.ts';

const PERSON = ['gender', 'skin', 'hair', 'hairColour', 'top', 'facial'] as const;

async function look() {
  const ctx = { app: {} as { look: { setOptions: (o: unknown) => void; fromId: (id: string, role?: string) => Record<string, string> } }, el: () => null };
  vm.runInNewContext(await readFile(new URL('../public/look.js', import.meta.url), 'utf8'), ctx);
  ctx.app.look.setOptions(LOOK_OPTIONS);
  return ctx.app.look;
}

test('a made-up look is the same person in every role; only the role\'s things change', async () => {
  const l = await look();
  for (let i = 0; i < 200; i++) {
    const id = (i * 2654435761 >>> 0).toString(16).padStart(8, '0');
    const base = l.fromId(id, 'default');
    for (const role of ['coder', 'writer', 'designer', 'artist', 'pm', '']) {
      const other = l.fromId(id, role);
      for (const k of PERSON) assert.equal(other[k], base[k], `${id} ${role} ${k}`);
    }
  }
});

test('a Default hire\'s made-up look is as it was before 2.0.75', async () => {
  const l = await look();
  assert.deepEqual({ ...l.fromId('a1b2c3d4', 'default') }, { gender: 'nonbinary', skin: 'medium', hair: 'afro', hairColour: 'ginger', top: 'mint', glasses: 'none', facial: 'none', headwear: 'none' });
  assert.deepEqual({ ...l.fromId('rosa0001', 'default') }, { gender: 'nonbinary', skin: 'very-light', hair: 'curly', hairColour: 'black', top: 'steel', glasses: 'none', facial: 'none', headwear: 'beret' });
  assert.deepEqual({ ...l.fromId('ffff0000', 'default') }, { gender: 'man', skin: 'dark', hair: 'bald', hairColour: 'blue', top: 'sky', glasses: 'none', facial: 'none', headwear: 'none' });
});

test('the role still shows: many coders wear headphones, many writers and coders glasses', async () => {
  const l = await look();
  const ids = Array.from({ length: 400 }, (_, i) => `c${i}`);
  const share = (role: string, k: string, v: (x: string) => boolean) => ids.filter(id => v(l.fromId(id, role)[k])).length / ids.length;
  assert.ok(share('coder', 'headwear', x => x === 'headphones') > 0.3);
  assert.ok(share('designer', 'headwear', x => x === 'beret') > 0.35);
  assert.ok(share('coder', 'glasses', x => x === 'square' || x === 'round') > 0.4);
  assert.ok(share('default', 'glasses', x => x === 'square' || x === 'round') < 0.35);
});
