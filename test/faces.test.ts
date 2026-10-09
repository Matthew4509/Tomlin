// Profile photos per person (src/faces.ts) and the Cartoon mode / "profile picture of …" portrait (src/modes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FACE_SIZE, Faces, faceFile, isFaceKey, visibleFaces } from '../src/faces.ts';
import { boosted, detectMode, forModel, portraitAsk, PRESETS } from '../src/modes.ts';

const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();

test('a face key names one person; anything else is refused', () => {
  for (const ok of ['manager', 'me', 'staff:rowan', 'staff:ana-2']) assert.ok(isFaceKey(ok), ok);
  for (const bad of ['', 'staff:', 'staff:../x', 'Manager', 'pc:1', 'staff:Rowan', 'partner']) assert.ok(!isFaceKey(bad), bad);
  assert.equal(faceFile('staff:rowan'), 'staff-rowan.png');
});

test('each person keeps their own photo; one change never touches another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faces-'));
  try {
    const faces = new Faces(dir);
    await faces.set('staff:rowan', await picture(768, 512), { id: 'a1', prompt: 'a piano tuner' }, new Date('2026-10-03T10:00:00Z'));
    await faces.set('manager', await picture(512, 512), { id: 'b2', prompt: 'a manager' }, new Date('2026-10-03T10:01:00Z'));
    const all = await faces.all();
    assert.deepEqual(Object.keys(all).sort(), ['manager', 'staff:rowan']);
    assert.equal(all['staff:rowan'].picture, 'a1');
    // Cut to a square from the middle.
    const meta = await sharp(join(dir, 'staff-rowan.png')).metadata();
    assert.equal(meta.width, FACE_SIZE);
    assert.equal(meta.height, FACE_SIZE);
    assert.ok(await faces.clear('staff:rowan'));
    assert.ok(!existsSync(join(dir, 'staff-rowan.png')));
    assert.deepEqual(Object.keys(await faces.all()), ['manager']);
    assert.equal(await faces.clear('staff:rowan'), false);
    assert.equal(await faces.path('staff:rowan'), null);
    assert.ok((await faces.path('manager'))?.endsWith('manager.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a face left by the removed private chat is never listed; the address changes with the photo', () => {
  const all = { manager: { picture: 'a', prompt: 'm', at: '2026-10-03T10:00:00.000Z' }, partner: { picture: 'b', prompt: 'p', at: '2026-10-03T10:00:00.000Z' } };
  assert.deepEqual(Object.keys(visibleFaces(all)), ['manager']);
  const later = visibleFaces({ manager: { ...all.manager, at: '2026-10-03T11:00:00.000Z' } });
  assert.notEqual(later.manager.url, visibleFaces(all).manager.url);
});

test('cartoon words pick the Cartoon mode; icon words still win', () => {
  assert.equal(detectMode('a cartoon dog on a skateboard', null).mode, 'cartoon');
  assert.equal(detectMode('anime girl with a violin', null).mode, 'cartoon');
  assert.equal(detectMode('cartoon piano icon', null).mode, 'icon');
  assert.equal(detectMode('a dog on a skateboard', null).mode, 'custom');
  assert.ok(PRESETS.cartoon.boost.includes('flat colours') && PRESETS.cartoon.negative.includes('photorealistic'));
});

test('"cartoon profile picture of …" is a square portrait of the subject, in the cartoon style', () => {
  const ask = 'make a cartoon profile picture of a friendly piano tuner';
  assert.ok(portraitAsk(ask));
  assert.ok(!portraitAsk('a piano in a sunlit room'));
  assert.equal(forModel(ask), 'a friendly piano tuner, cartoon style');
  assert.equal(forModel('a profile picture of a woman with red hair'), 'a woman with red hair');
  const words = boosted(ask, PRESETS.cartoon);
  assert.ok(words.startsWith('a friendly piano tuner, cartoon style, head and shoulders, facing the viewer'), words);
  assert.ok(words.endsWith(PRESETS.cartoon.boost), words);
  assert.ok(!words.includes('profile picture'), words);
});
