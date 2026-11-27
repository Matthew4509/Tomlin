// Joining a shot list's clips into one video, with no other program: each clip is a WebM file (stable-diffusion.cpp
// writes VP8 in WebM, src/video.ts), so the frames are copied as they are, shot after shot, into one new WebM. Every
// clip must have the same codec, size and time scale (one video has one track); a clip that does not is named. The
// clusters keep their frames and the frames' times inside a cluster; only each cluster's start time moves on by the
// length of the clips before it. The new file has a header, its length, the first clip's track and the clusters: no
// seek index (a player reads a short video from the start). Plain functions, tested in test/webmjoin.test.ts.

/** The element ids used (with their length marker, as written in the file). */
const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  MuxingApp: 0x4d80, WritingApp: 0x5741, Tracks: 0x1654ae6b, TrackEntry: 0xae, CodecID: 0x86, Video: 0xe0,
  PixelWidth: 0xb0, PixelHeight: 0xba, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0,
  Block: 0xa1, BlockDuration: 0x9b,
} as const;
/** Elements at the Segment's own level: an open-ended Cluster ends where one of these starts. */
const SEGMENT_LEVEL = new Set([0x114d9b74, ID.Info, ID.Tracks, ID.Cluster, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);
/** The most a joined video may hold (bytes), so a list of many large clips never fills the memory. */
export const JOIN_MOST = 1024 * 1024 * 1024;

interface El { id: number; start: number; dataStart: number; end: number; open: boolean }

/** An element id at `pos` (its length marker kept), and where it ends; null when the bytes are not one. */
function readId(b: Uint8Array, pos: number): { id: number; next: number } | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 4 || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, next: pos + len };
}

/** A size at `pos` (its marker taken off); `open` when it is the "not known" size (all ones). */
function readSize(b: Uint8Array, pos: number): { size: number; open: boolean; next: number } | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 8 || pos + len > b.length) return null;
  let size = first & (0xff >> len);
  let ones = size === 0xff >> len;
  for (let i = 1; i < len; i++) {
    size = size * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) ones = false;
  }
  return { size, open: ones, next: pos + len };
}

/** The elements between `from` and `to`, one level (an open-ended one runs to `to`, or a Cluster to the next big one). */
function children(b: Uint8Array, from: number, to: number): El[] {
  const out: El[] = [];
  let pos = from;
  while (pos < to) {
    const id = readId(b, pos);
    if (!id) break;
    const sz = readSize(b, id.next);
    if (!sz) break;
    let end = sz.open ? to : sz.next + sz.size;
    if (sz.open && id.id === ID.Cluster) {
      // An open-ended Cluster: it ends where the next Segment-level element starts.
      let p = sz.next;
      while (p < to) {
        const cid = readId(b, p);
        const csz = cid && readSize(b, cid.next);
        if (!cid || !csz) break;
        if (SEGMENT_LEVEL.has(cid.id)) break;
        p = csz.open ? to : csz.next + csz.size;
      }
      end = Math.min(p, to);
    }
    if (end > to) end = to;
    out.push({ id: id.id, start: pos, dataStart: sz.next, end, open: sz.open });
    pos = end;
  }
  return out;
}

const uintOf = (b: Uint8Array, e: El) => {
  let n = 0;
  for (let i = e.dataStart; i < e.end; i++) n = n * 256 + b[i];
  return n;
};
const floatOf = (b: Uint8Array, e: El) => {
  const v = new DataView(b.buffer, b.byteOffset + e.dataStart, e.end - e.dataStart);
  return e.end - e.dataStart === 4 ? v.getFloat32(0) : e.end - e.dataStart === 8 ? v.getFloat64(0) : NaN;
};
const textOf = (b: Uint8Array, e: El) => Buffer.from(b.subarray(e.dataStart, e.end)).toString('latin1').replace(/\0+$/, '');
const find = (list: El[], id: number) => list.find(e => e.id === id);

/** One clip as the join needs it. */
export interface WebmParts {
  header: Uint8Array;
  /** Nanoseconds in one time unit of the file (1,000,000: milliseconds). */
  scale: number;
  tracks: Uint8Array;
  codec: string;
  width: number;
  height: number;
  /** Each cluster: its start time (in the file's units) and its frames, as they are in the file. */
  clusters: { time: number; blocks: Uint8Array[] }[];
  /** How long it runs (in the file's units). */
  length: number;
}

/** A WebM clip's parts, or why it cannot be joined (one video track, frames in clusters). */
export function parseWebm(bytes: Uint8Array): WebmParts | { error: string } {
  const top = children(bytes, 0, bytes.length);
  const ebml = find(top, ID.EBML);
  const seg = find(top, ID.Segment);
  if (!ebml || !seg) return { error: 'it is not a WebM video' };
  const inSeg = children(bytes, seg.dataStart, seg.end);
  const info = find(inSeg, ID.Info);
  const infoKids = info ? children(bytes, info.dataStart, info.end) : [];
  const scaleEl = find(infoKids, ID.TimecodeScale);
  const scale = scaleEl ? uintOf(bytes, scaleEl) : 1_000_000;
  const durEl = find(infoKids, ID.Duration);
  const tracksEl = find(inSeg, ID.Tracks);
  if (!tracksEl) return { error: 'it has no track' };
  const entries = children(bytes, tracksEl.dataStart, tracksEl.end).filter(e => e.id === ID.TrackEntry);
  if (entries.length !== 1) return { error: `it has ${entries.length} tracks, and only a video with one can be joined` };
  const entry = children(bytes, entries[0].dataStart, entries[0].end);
  const codecEl = find(entry, ID.CodecID);
  const videoEl = find(entry, ID.Video);
  const videoKids = videoEl ? children(bytes, videoEl.dataStart, videoEl.end) : [];
  const w = find(videoKids, ID.PixelWidth);
  const h = find(videoKids, ID.PixelHeight);
  if (!codecEl || !w || !h) return { error: 'its track says no codec or size' };
  const clusters: WebmParts['clusters'] = [];
  let last = 0;
  let gap = 0;
  for (const c of inSeg.filter(e => e.id === ID.Cluster)) {
    const kids = children(bytes, c.dataStart, c.end);
    const tc = find(kids, ID.Timecode);
    const time = tc ? uintOf(bytes, tc) : 0;
    const blocks: Uint8Array[] = [];
    for (const k of kids) {
      if (k.id !== ID.SimpleBlock && k.id !== ID.BlockGroup) continue;
      blocks.push(bytes.subarray(k.start, k.end));
      // The frame's own time: after its track number (a size-like number), two bytes, signed, from the cluster's start.
      const body = k.id === ID.SimpleBlock ? k : find(children(bytes, k.dataStart, k.end), ID.Block);
      if (!body) continue;
      const tn = readSize(bytes, body.dataStart);
      if (!tn) continue;
      const rel = (bytes[tn.next] << 8 | bytes[tn.next + 1]) << 16 >> 16;
      const at = time + rel;
      if (at > last) {
        gap = at - last;
        last = at;
      }
    }
    if (blocks.length) clusters.push({ time, blocks });
  }
  if (!clusters.length) return { error: 'it has no frames' };
  // Its length: the file's Duration when it says one, or the last frame's time and one frame more.
  const said = durEl ? floatOf(bytes, durEl) : NaN;
  // Rounded up: a length rounded down could end on the last frame, and the next clip's first frame would sit on it.
  const length = Number.isFinite(said) && said > last ? Math.ceil(said) : last + (gap || Math.round(40_000_000 / scale));
  return { header: bytes.subarray(ebml.start, ebml.end), scale, tracks: bytes.subarray(tracksEl.start, tracksEl.end), codec: textOf(bytes, codecEl), width: uintOf(bytes, w), height: uintOf(bytes, h), clusters, length };
}

// ---- Writing ----

const idBytes = (id: number) => {
  const out: number[] = [];
  for (let n = id; n > 0; n = Math.floor(n / 256)) out.unshift(n & 0xff);
  return Uint8Array.from(out);
};
/** A size in eight bytes (allowed for any element, and simple to write). */
const size8 = (n: number) => {
  const b = new Uint8Array(8);
  b[0] = 0x01;
  for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) b[i] = v & 0xff;
  return b;
};
const el = (id: number, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([idBytes(id), size8(body.length), body]);
};
const uint = (id: number, n: number) => {
  const out: number[] = [];
  for (let v = n; v > 0 || !out.length; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return el(id, Uint8Array.from(out));
};
const float64 = (id: number, n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return el(id, b);
};
const text = (id: number, s: string) => el(id, Buffer.from(s, 'latin1'));

/** One clip of a join, by the words that name it ("Shot 3"). */
export interface JoinPart { name: string; bytes: Uint8Array }

/**
 * The clips joined into one WebM, in order, and its length in seconds; or why not, naming the clip. Each must have the
 * first one's codec, size and time scale.
 */
export function joinWebm(parts: JoinPart[]): { bytes: Buffer; seconds: number } | { error: string } {
  if (parts.length < 2) return { error: 'Two clips or more are needed to join.' };
  const read: WebmParts[] = [];
  for (const p of parts) {
    const r = parseWebm(p.bytes);
    if ('error' in r) return { error: `${p.name} cannot be joined: ${r.error}.` };
    read.push(r);
  }
  const first = read[0];
  for (const [i, r] of read.entries()) {
    if (r.codec !== first.codec) return { error: `${parts[i].name} was made with ${r.codec} and ${parts[0].name} with ${first.codec}: one video needs one kind.` };
    if (r.width !== first.width || r.height !== first.height) return { error: `${parts[i].name} is ${r.width}×${r.height} and ${parts[0].name} is ${first.width}×${first.height}: one video needs one size. Make it again at ${first.width}×${first.height}, or skip it.` };
    if (r.scale !== first.scale) return { error: `${parts[i].name} keeps time differently from ${parts[0].name}, so they cannot be joined.` };
  }
  const clusters: Buffer[] = [];
  let at = 0;
  for (const r of read) {
    for (const c of r.clusters) clusters.push(el(ID.Cluster, uint(ID.Timecode, at + c.time), ...c.blocks));
    at += r.length;
  }
  const info = el(ID.Info, uint(ID.TimecodeScale, first.scale), float64(ID.Duration, at), text(ID.MuxingApp, 'TOMLIN'), text(ID.WritingApp, 'TOMLIN'));
  const body = [info, Buffer.from(first.tracks), ...clusters];
  const total = body.reduce((n, b) => n + b.length, 0);
  if (total > JOIN_MOST) return { error: 'Joined, they would be more than 1 GB: join fewer shots at a time.' };
  const bytes = Buffer.concat([Buffer.from(first.header), idBytes(ID.Segment), size8(total), ...body]);
  return { bytes, seconds: Math.round((at * first.scale) / 1e8) / 10 };
}

// ---- The last frame, with no decoder ----
// stable-diffusion.cpp writes every frame of a clip as a VP8 key frame, and a VP8 key frame is what a lossy WebP picture
// holds: the last frame's bytes, put in a WebP wrapper, are a picture sharp can read. So a shot list carries on from the
// shot before on the server itself, with no page open (a hidden page read a black frame, 27 Nov).

/** The last frame of a VP8 WebM clip as a WebP picture, or why not (another codec, laced, or not a key frame). */
export function lastFrameWebp(bytes: Uint8Array): Buffer | { error: string } {
  const p = parseWebm(bytes);
  if ('error' in p) return p;
  if (p.codec !== 'V_VP8') return { error: `its frames are ${p.codec || 'in an unknown codec'}, not VP8` };
  const block = p.clusters.at(-1)?.blocks.at(-1);
  if (!block) return { error: 'it has no frames' };
  const id = readId(block, 0);
  const sz = id && readSize(block, id.next);
  if (!id || !sz) return { error: 'its last frame cannot be read' };
  let body = sz.next;
  if (id.id === ID.BlockGroup) {
    const inner = children(block, sz.next, block.length).find(e => e.id === ID.Block);
    if (!inner) return { error: 'its last frame cannot be read' };
    body = inner.dataStart;
  }
  const tn = readSize(block, body);
  if (!tn) return { error: 'its last frame cannot be read' };
  // After the track number: two bytes of time and one of flags; laced blocks hold several frames and are not read here.
  const flags = block[tn.next + 2];
  if (flags === undefined || flags & 0x06) return { error: 'its last frame is laced' };
  const frame = block.subarray(tn.next + 3);
  // A VP8 key frame: the low bit of its first byte is 0, and the start code 9d 01 2a follows its three-byte tag.
  if (frame.length < 10 || frame[0] & 1 || frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) return { error: 'its last frame is not a key frame' };
  return vp8Webp(frame);
}

/** A VP8 key frame in a WebP file: RIFF, WEBP, and one "VP8 " chunk (padded to an even length). */
export function vp8Webp(frame: Uint8Array): Buffer {
  const pad = frame.length & 1;
  const chunk = Buffer.alloc(8 + frame.length + pad);
  chunk.write('VP8 ', 0, 'latin1');
  chunk.writeUInt32LE(frame.length, 4);
  chunk.set(frame, 8);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + chunk.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk]);
}
