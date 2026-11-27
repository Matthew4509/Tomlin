// Keep the colours of the first shot (src/colourmatch.ts): a tinted last frame comes out with the reference's colours,
// the reference is shot 1's picture or else the first frame (left as it is), and a frame that cannot be read is used as
// it came. Small pictures made with sharp, so no clip is needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { carryFrame, colourStats, matchColours, type ColourRef } from '../src/colourmatch.ts';

/** A 32 by 32 PNG: a left-to-right grey ramp, tinted by `tint` (added to red, green and blue) and stretched by `gain`. */
async function frame(tint: [number, number, number], gain = 1, alpha = false): Promise<Buffer> {
  const w = 32;
  const ch = alpha ? 4 : 3;
  const px = Buffer.alloc(w * w * ch);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const base = 64 + x * 4;
      for (let c = 0; c < 3; c++) px[(y * w + x) * ch + c] = Math.max(0, Math.min(255, Math.round(128 + (base - 128) * gain + tint[c])));
      if (alpha) px[(y * w + x) * ch + 3] = 255;
    }
  }
  return sharp(px, { raw: { width: w, height: w, channels: ch } }).png().toBuffer();
}

const near = (a: number[], b: number[], tol: number, what: string) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${what}: channel ${i} is ${v.toFixed(1)}, wanted ${b[i].toFixed(1)}`));

test('a tinted, over-saturated frame comes out with the reference\'s channel means and spreads', async () => {
  const ref = await colourStats(await frame([0, 0, 0]));
  const drifted = await frame([40, -10, -30], 1.4, true);
  const before = await colourStats(drifted);
  assert.ok(Math.abs(before.mean[0] - ref.mean[0]) > 30, 'the test frame is tinted');
  const out = await matchColours(drifted, ref);
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 32, 32]);
  const after = await colourStats(out);
  near(after.mean, ref.mean, 2, 'mean');
  near(after.std, ref.std, 2, 'spread');
});

test('the reference: shot 1\'s picture when there is one; else the first frame, kept as it is', async () => {
  const at = new Date('2026-11-26T10:00:00Z');
  const picture = await frame([20, 0, -20]);
  const tinted = await frame([-30, 30, 0]);
  // Shot 1 started from a picture: the frame is matched to it, and the reference is written once.
  const a = await carryFrame(tinted, { ref: null, key: 'picture:p.png:wide', picture: async () => picture, now: at });
  assert.equal(a.ref?.from, 'picture');
  assert.equal(a.ref?.key, 'picture:p.png:wide');
  assert.equal(a.ref?.at, at.toISOString());
  near((await colourStats(a.png!)).mean, (await colourStats(picture)).mean, 2, 'matched to the picture');
  // With the reference in the list, the picture is not read again.
  const b = await carryFrame(tinted, { ref: a.ref, key: a.ref!.key, picture: async () => assert.fail('read again') });
  assert.equal(b.ref, null);
  near((await colourStats(b.png!)).mean, a.ref!.mean, 2, 'the same reference');
  // Shot 1 started from nothing: the first frame is the reference and is used as it came.
  const c = await carryFrame(tinted, { ref: null, key: 'frame', picture: null });
  assert.equal(c.png, null);
  assert.equal(c.ref?.from, 'frame');
  near(c.ref!.mean, (await colourStats(tinted)).mean, 0.01, 'the frame is the reference');
  // The next frame drifts: matched back to the first frame's colours.
  const d = await carryFrame(await frame([10, 10, 40], 1.3), { ref: c.ref as ColourRef, key: 'frame', picture: null });
  near((await colourStats(d.png!)).mean, c.ref!.mean, 2, 'matched to the first frame');
  // Shot 1's picture is gone: the frame stands in for it under the same key.
  const e = await carryFrame(tinted, { ref: null, key: 'picture:gone.png:wide', picture: async () => null });
  assert.deepEqual([e.png, e.ref?.from, e.ref?.key], [null, 'frame', 'picture:gone.png:wide']);
});

test('a frame that cannot be read is used as it came (never a fault for the list)', async () => {
  const ref = await colourStats(await frame([0, 0, 0]));
  assert.deepEqual(await carryFrame(Buffer.from('not a picture'), { ref: { ...ref, from: 'frame', key: 'frame', at: 'x' }, key: 'frame', picture: null }), { png: null, ref: null });
});
