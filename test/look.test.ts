// A hire's look (src/look.ts): kept only when every part is a known id, saved with the hire (src/staff.ts), and every
// shape id has a drawing in public/look.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOK_KEYS, LOOK_OPTIONS, cleanLook } from '../src/look.ts';
import { Staff } from '../src/staff.ts';

const LOOK = { gender: 'woman', skin: 'tan', hair: 'curly', hairColour: 'auburn', top: 'mint', glasses: 'round', facial: 'none', headwear: 'beret' };

test('a look is kept only when every part is one of the listed ids', () => {
  assert.deepEqual(cleanLook(LOOK), LOOK);
  // A part not there takes the first choice (a look saved before that part existed keeps the rest).
  const { headwear, ...older } = LOOK;
  void headwear;
  assert.deepEqual(cleanLook(older), { ...LOOK, headwear: 'none' });
  // Unknown or the wrong type: no look at all, never half of one.
  for (const bad of [{ ...LOOK, hair: 'mohawk' }, { ...LOOK, skin: 3 }, { ...LOOK, top: '#ff0000' }, null, 'woman', [], 7]) assert.equal(cleanLook(bad), null, JSON.stringify(bad));
  // Extra keys are not carried.
  assert.deepEqual(Object.keys(cleanLook({ ...LOOK, evil: '<script>' })!).sort(), [...LOOK_KEYS].sort());
});

test('every list has unique ids and names, and every colour list has colours', () => {
  for (const k of LOOK_KEYS) {
    const ids = LOOK_OPTIONS[k].map(o => o.id);
    assert.equal(new Set(ids).size, ids.length, k);
    assert.equal(new Set(LOOK_OPTIONS[k].map(o => o.name)).size, ids.length, k);
    for (const o of LOOK_OPTIONS[k]) assert.match(o.id, /^[a-z-]{1,20}$/, `${k}:${o.id}`);
  }
  for (const k of ['skin', 'hairColour', 'top'] as const) for (const o of LOOK_OPTIONS[k]) assert.match(o.colour ?? '', /^#[0-9a-f]{6}$/, `${k}:${o.id}`);
  for (const k of ['glasses', 'facial', 'headwear'] as const) assert.equal(LOOK_OPTIONS[k][0].id, 'none', `${k} starts with None`);
});

test('every shape id has a drawing on the page (public/look.js names it)', async () => {
  const page = await readFile(new URL('../public/look.js', import.meta.url), 'utf8');
  for (const k of ['hair', 'glasses', 'facial', 'headwear'] as const) {
    for (const o of LOOK_OPTIONS[k]) assert.ok(page.includes(`'${o.id}'`), `public/look.js does not name ${k} '${o.id}'`);
  }
  // Page scripts share one global scope: the file adds nothing to it but app.look.
  assert.match(page, /^'use strict';\s*\(\(\) => \{/m);
});

test('a look is saved with the hire, changed, and taken off; a bad one saves nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'look-'));
  try {
    const staff = await Staff.load(dir);
    const maya = await staff.hire('Maya', 'designer', 'default', null, () => false, LOOK);
    assert.deepEqual(maya.look, LOOK);
    const otto = await staff.hire('Otto', 'coder', 'default', null, () => false, { ...LOOK, hair: 'mohawk' });
    assert.equal(otto.look, undefined);
    await staff.change('otto', { look: { ...LOOK, gender: 'man', facial: 'beard', headwear: 'headphones' } });
    // Kept on disk: a fresh load reads it back.
    const again = await Staff.load(dir);
    assert.equal(again.get('otto')?.look?.facial, 'beard');
    assert.equal(again.get('maya')?.look?.headwear, 'beret');
    // Other changes leave the look alone; null takes it off.
    await again.change('maya', { tone: 'warm' });
    assert.deepEqual(again.get('maya')?.look, LOOK);
    await again.change('maya', { look: null });
    assert.equal(again.get('maya')?.look, null);
    const file = JSON.parse(await readFile(join(dir, 'staff.json'), 'utf8'));
    assert.equal(file.staff.find((m: { id: string }) => m.id === 'otto').look.headwear, 'headphones');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
