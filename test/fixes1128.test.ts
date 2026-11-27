// Fixes from the 27 Nov walk (REVIEW-2026-11-27-PICTURES-VIDEO-WALK.md): read in the page and server code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('L2: a hire on a model made for 720p starts at 720p, and that size is kept apart from the others', () => {
  const page = read('public/clips.js');
  assert.match(page, /const sizeKey = \(\) => \(app\.chatPerson\?\.hd \? 'size720' : 'size'\);/);
  assert.match(page, /const first = \(app\.chatPerson\?\.hd && sizes\.find\(s => s\.hd\)\) \|\| sizes\[0\];/);
  assert.match(page, /clipSize\.addEventListener\('change', \(\) => clipKeep\(sizeKey\(\), clipSize\.value\)\);/);
});

test('F2: Edit staff offers the same styles as the style tiles, and an artist\'s preferred one is used when a picture names none', async () => {
  const { sampleStyles, STYLES } = await import('../src/styles.ts');
  const team = read('src/server/team.ts');
  assert.match(team, /styles: sampleStyles\(\)\.map\(st => \(\{ id: st\.id, name: st\.name \}\)\),/);
  assert.equal(sampleStyles().length, STYLES.length - 1, 'every style but Auto');
  assert.match(read('src/staff.ts'), /if \(change\.style !== undefined\) m\.style = pickedStyle\(change\.style\)\?\.id \?\? null;/);
  const pic = read('src/server/pictures.ts');
  assert.match(pic, /const pref = preferredLook\(/);
  assert.match(pic, /const look = pickedStyle\(o\.look\) \?\? \(o\.plain \? null : preferredLook\(/);
});

test('F6 and F10: a hire with no model "cannot draw" or "cannot make clips"; the Save to project tooltip keeps its backslash', () => {
  const team = read('public/team.js');
  assert.match(team, /const verb = m\.kind === 'video' \? 'make clips' : m\.kind === 'image' \? 'draw' : 'answer';/);
  assert.ok(read('public/images.js').includes(String.raw`title: 'A copy goes into the specialists\\images folder`));
});
