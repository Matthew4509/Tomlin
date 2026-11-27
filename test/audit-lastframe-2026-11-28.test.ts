// Audit of the last-frame carry-on in 9b80c9a (src/webmjoin.ts lastFrameWebp, src/colourmatch.ts isBlank,
// src/server/shots.ts takeFrame, src/keepawake.ts). P1/P2 findings are todo. Run: node --test test/audit-lastframe-2026-11-28.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { lastFrameWebp, parseWebm } from '../src/webmjoin.ts';
import { blankFrame } from '../src/colourmatch.ts';
import { KeepAwake } from '../src/keepawake.ts';

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/fake-clip.webm', import.meta.url)));

function el(id: number[], ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  for (let i = 7, v = body.length; i >= 1; i--, v = Math.floor(v / 256)) size[i] = v & 0xff;
  return Buffer.concat([Buffer.from(id), size, body]);
}
async function vp8Of(png: Buffer): Promise<Buffer> {
  const webp = await sharp(png).webp({ quality: 90 }).toBuffer();
  return webp.subarray(20, 20 + webp.readUInt32LE(16));
}
/** A WebM with the fixture's header and track; each frame a SimpleBlock with these flags (0x80 = key frame, no lacing). */
function webmOf(frames: Buffer[], flags = 0x80): Uint8Array {
  const p = parseWebm(fixture);
  assert.ok(!('error' in p));
  const blocks = frames.map((f, i) => el([0xa3], Buffer.from([0x81, 0, i * 40, i === frames.length - 1 ? flags : 0x80]), f));
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], Buffer.from([0])), ...blocks);
  return new Uint8Array(Buffer.concat([Buffer.from(p.header), el([0x18, 0x53, 0x80, 0x67], Buffer.from(p.tracks), cluster)]));
}
const flat = (w: number, h: number, v: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } });
const svg = (w: number, h: number, inner: string) => Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);

// ---- Reading the last frame ----

test('LF-01 (holds): a laced last block, an inter frame and a last block cut short are refused in words, never read as a picture', async () => {
  const a = await vp8Of(await flat(64, 48, 200).png().toBuffer());
  const b = await vp8Of(await sharp(svg(64, 48, '<rect width="64" height="48" fill="#3080c0"/><circle cx="30" cy="20" r="10" fill="#e06010"/>')).png().toBuffer());
  assert.deepEqual(lastFrameWebp(webmOf([a, b], 0x80 | 0x02)), { error: 'its last frame is laced' });
  const inter = Buffer.from(b);
  inter[0] |= 1;
  assert.deepEqual(lastFrameWebp(webmOf([a, inter])), { error: 'its last frame is not a key frame' });
  assert.ok('error' in (lastFrameWebp(webmOf([a, b.subarray(0, 6)])) as object));
});

test('LF-02 (holds): a key frame cut part way (a damaged last block) is not turned into a picture that is carried on from', async () => {
  const b = await vp8Of(await sharp(svg(64, 48, '<rect width="64" height="48" fill="#3080c0"/><circle cx="30" cy="20" r="10" fill="#e06010"/>')).png().toBuffer());
  const webp = lastFrameWebp(webmOf([b, b.subarray(0, Math.floor(b.length / 2))]));
  if ('error' in (webp as object)) return;
  const png = await sharp(webp as Buffer).png().toBuffer().catch(() => null);
  assert.equal(png, null, 'half a key frame decoded to a picture');
});

test('LF-03 (holds): a WebM file cut short inside its last frame gives no frame, not the frame before it', async () => {
  const a = await vp8Of(await flat(64, 48, 200).png().toBuffer());
  const b = await vp8Of(await sharp(svg(64, 48, '<rect width="64" height="48" fill="#3080c0"/>')).png().toBuffer());
  const whole = webmOf([a, b]);
  const cut = whole.subarray(0, whole.length - Math.floor(b.length / 2));
  const got = lastFrameWebp(cut);
  if ('error' in (got as object)) return;
  // Whatever came back must be the last frame (blue), not the white one before it.
  const s = await sharp(got as Buffer).stats().catch(() => null);
  assert.ok(!s || s.channels[2].mean > s.channels[0].mean + 40, 'an earlier frame was taken as the last one');
});

// ---- Blank or not ----

test('LF-04 (holds): a truly black, a flat grey and a near-flat grey with faint noise are blank', async () => {
  assert.equal(await blankFrame(await flat(256, 256, 0).png().toBuffer()), true);
  assert.equal(await blankFrame(await flat(256, 256, 128).png().toBuffer()), true);
  const noise = Buffer.alloc(256 * 256 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = 120 + ((i * 7919) % 5);
  assert.equal(await blankFrame(await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer()), true);
});

test('LF-05 (holds): a plain sky with one small bird (a real picture) is not refused as blank', async () => {
  const sky = await sharp(svg(512, 512, '<rect width="512" height="512" fill="#7fb4e6"/><rect x="250" y="200" width="10" height="10" fill="#202020"/>')).png().toBuffer();
  assert.equal(await blankFrame(sky), false, 'refused as blank: the list waits on this frame for ever');
});

test('LF-06 (holds): a dim scene (a night room, values 4 to 16) is not refused as blank', async () => {
  const dim = await sharp(svg(512, 288, '<defs><linearGradient id="g"><stop offset="0" stop-color="#040406"/><stop offset="1" stop-color="#10100c"/></linearGradient></defs><rect width="512" height="288" fill="url(#g)"/><rect x="300" y="120" width="40" height="60" fill="#14120e"/>')).png().toBuffer();
  assert.equal(await blankFrame(dim), false, 'refused as blank');
});

test('LF-07: a clip that fades out (its last frame nearly black with a faint vignette) does not hold the list for ever', async () => {
  const fade = await sharp(svg(512, 288, '<defs><radialGradient id="g"><stop offset="0" stop-color="#0c0c0c"/><stop offset="1" stop-color="#020202"/></radialGradient></defs><rect width="512" height="288" fill="url(#g)"/>')).png().toBuffer();
  // Blank is right for this frame; the fault is what follows (src/server/shots.ts takeFrame 400 "It is read again",
  // framesHere every 3 s, no limit): the list stays running, the clip is read whole every 3 s, the PC is kept awake.
  assert.equal(await blankFrame(fade), true);
  const src = readFileSync(new URL('../src/server/shots.ts', import.meta.url), 'utf8');
  // Fixed in 94d260e: a blank frame read from the clip itself fails the next shot (Shots.blankEnd, tested in test/shots.test.ts).
  assert.match(src, /blankFrame\(png\)[\s\S]{0,300}shots\.blankEnd\(/, 'a blank last frame is retried with no end');
});

// ---- Kept awake ----

test('LF-08 (holds): the shot list\'s hold on Windows is let go about a minute after the list stops running, fails or is cancelled', () => {
  let held = 0;
  const k = new KeepAwake(() => (held++, { release: () => held-- }), 60_000);
  k.set(true, 0);
  k.set(true, 15_000);
  assert.equal(held, 1);
  k.set(false, 30_000);
  k.set(false, 75_000);
  assert.equal(held, 1);
  k.set(false, 90_000);
  assert.equal(held, 0);
  k.set(false, 200_000);
  assert.equal(held, 0);
});

test('LF-09: a list scheduled to start later keeps the PC awake (or wakes it) until it starts', () => {
  const src = readFileSync(new URL('../src/shots.ts', import.meta.url), 'utf8');
  assert.match(src, /anyRunning\(\)[\s\S]{0,200}'scheduled'/, 'a scheduled list is not held awake: a PC asleep at its start time never starts it');
});

test('LF-10: a plain sky with a distant bird of 5 by 5 pixels in an 832 by 480 frame is not refused as blank (every channel spread is under 3)', async () => {
  const sky = await sharp(svg(832, 480, '<rect width="832" height="480" fill="#7fb4e6"/><rect x="250" y="200" width="5" height="5" fill="#202020"/>')).png().toBuffer();
  assert.equal(await blankFrame(sky), false, 'refused as blank: the shot after it waits on this frame for ever');
});
