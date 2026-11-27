// Colour match for a shot list (src/shots.ts): the last frame a shot carries on from is given the colours of the list's
// reference before the next clip starts from it, so a chain of shots does not drift (Wan 2.2 5B made each shot a little
// more saturated than the one before; after 12 shots it was about 6 times the first). The usual "colour match" step:
// each of red, green and blue is moved and stretched to the reference's mean and spread. Tested in test/colourmatch.test.ts.
import sharp from 'sharp';

/** A picture's colours: the mean and standard deviation of red, green and blue (0 to 255). */
export interface ColourStats {
  mean: [number, number, number];
  std: [number, number, number];
}

/**
 * The reference a list matches to, written into the list so every shot uses the same: shot 1's start picture (as the
 * clip took it, fitted to its size) or, when shot 1 started from nothing, the first last frame kept for the list.
 * `key` says which, so a changed shot 1 gets a new one.
 */
export interface ColourRef extends ColourStats {
  from: 'picture' | 'frame';
  key: string;
  at: string;
}

/** A spread is stretched by at most this much either way (a near-flat frame would turn noise into colour). */
export const MAX_GAIN = 3;

/**
 * A frame with no picture in it: every channel nearly one flat value (black, or one colour). A page that was hidden read
 * a black last frame (27 Nov); colour match made it flat grey and the next shot started from nothing like the clip
 * before. Such a frame is never carried on from.
 */
export const BLANK_SPREAD = 3;
/** Nearly flat colours only: a frame passing this may still hold a small real thing (blankFrame looks for it). */
export const isBlank = (s: ColourStats): boolean => s.std.every(x => x < BLANK_SPREAD);
/**
 * A pixel this far from the frame's mean colour (in any channel) is detail, not noise or a fade's soft vignette; a frame
 * with at least DETAIL_PIXELS of them (a 3 by 3 patch) has a picture in it. A distant bird of 5 by 5 pixels in a plain
 * 832 by 480 sky moves every channel's spread by under 3, so the spread alone called it blank.
 */
export const DETAIL_STEP = 24;
export const DETAIL_PIXELS = 9;
/** True for a black, flat or near-flat (faint noise, a fade out) frame; false when it has a picture in it, however small. */
export async function blankFrame(png: Buffer): Promise<boolean> {
  const s = await colourStats(png);
  if (!isBlank(s)) return false;
  const { data, info } = await sharp(png).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const [r, g, b] = s.mean;
  let found = 0;
  for (let i = 0; i + ch - 1 < data.length; i += ch) {
    const far = ch >= 3
      ? Math.abs(data[i] - r) > DETAIL_STEP || Math.abs(data[i + 1] - g) > DETAIL_STEP || Math.abs(data[i + 2] - b) > DETAIL_STEP
      : Math.abs(data[i] - r) > DETAIL_STEP;
    if (far && ++found >= DETAIL_PIXELS) return false;
  }
  return true;
}

/** The colours of a picture (alpha left out). */
export async function colourStats(png: Buffer): Promise<ColourStats> {
  const s = await sharp(png).removeAlpha().toColourspace('srgb').stats();
  const ch = s.channels.length >= 3 ? s.channels.slice(0, 3) : [s.channels[0], s.channels[0], s.channels[0]];
  return { mean: ch.map(c => c.mean) as ColourStats['mean'], std: ch.map(c => c.stdev) as ColourStats['std'] };
}

/**
 * A last frame a shot carries on from, as the list keeps its colours: `ref` is the reference written into the list (null
 * while it has none for `key`), `picture` reads shot 1's start picture (null when shot 1 started from nothing). Gives the
 * matched copy (null: use the frame as it is) and a new reference to write into the list (null: none). With no
 * reference and no picture the frame itself becomes the reference, left as it is. Never throws: a frame that cannot be
 * read is used as it came.
 */
export async function carryFrame(frame: Buffer, o: { ref: ColourRef | null; key: string; picture: (() => Promise<Buffer | null>) | null; now?: Date }): Promise<{ png: Buffer | null; ref: ColourRef | null }> {
  try {
    const at = (o.now ?? new Date()).toISOString();
    let ref = o.ref;
    let made: ColourRef | null = null;
    if (!ref) {
      const pic = o.picture ? await o.picture().catch(() => null) : null;
      // Shot 1's picture is gone: this frame stands in for it, under the same key, so the list keeps one reference.
      made = { ...(await colourStats(pic ?? frame)), from: pic ? 'picture' : 'frame', key: o.key, at };
      ref = made;
      if (!pic) return { png: null, ref: made };
    }
    // A flat frame is left as it is: moving it to the reference's mean only makes a flat grey (and it is refused anyway).
    if (await blankFrame(frame)) return { png: null, ref: made };
    return { png: await matchColours(frame, ref), ref: made };
  } catch {
    return { png: null, ref: null };
  }
}

/** `png` with each channel moved to `ref`'s mean and spread; a PNG of the same size (no alpha: video frames are opaque). */
export async function matchColours(png: Buffer, ref: ColourStats): Promise<Buffer> {
  const own = await colourStats(png);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 3; i++) {
    const gain = own.std[i] > 0.5 ? Math.min(MAX_GAIN, Math.max(1 / MAX_GAIN, ref.std[i] / own.std[i])) : 1;
    a.push(gain);
    b.push(ref.mean[i] - own.mean[i] * gain);
  }
  return sharp(png).removeAlpha().toColourspace('srgb').linear(a, b).png().toBuffer();
}
