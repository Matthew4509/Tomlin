// The expert-parallel messages between the lead and the PCs holding experts (prototype, src/cluster/experts.ts). One
// message a layer each way while writing: the lead sends the hidden state and the chosen experts this PC holds, with
// their weights; the PC answers with its weighted sum. Binary and small (Qwen3.8: 2560 values, about 10 KB), because
// the round trip of every layer is what decides the speed. Between real PCs these frames would travel inside the
// sealed link stream (src/linkstream.ts), as Max mode's RPC does; the harness uses plain TCP on 127.0.0.1 only.
// Tested in test/clusterwire.test.ts.

/** "TXP1": TOMLIN expert parallel, version 1. */
export const MAGIC = 0x31505854;
/** The longest frame accepted (a batch of 64 words of 10240 values is 2.6 MB; anything far bigger is not a frame). */
export const MAX_FRAME = 64 * 2 ** 20;
const HEAD = 18;

export const KIND = { hello: 1, compute: 2, result: 3, error: 4 } as const;
export type Kind = keyof typeof KIND;

/** One chosen expert for one word: its id and its weight from the router. */
export interface Pick {
  id: number;
  weight: number;
}

export interface Frame {
  kind: Kind;
  layer: number;
  /** Which request this is (a result carries the compute's seq). */
  seq: number;
  /** Words in the batch (1 while writing) and the hidden width. */
  rows: number;
  hidden: number;
  /** compute: the picks for each word (only the experts this PC holds). */
  picks?: Pick[][];
  /** compute and result: rows x hidden values. */
  values?: Float32Array;
  /** hello and error: words (JSON for hello). */
  text?: string;
}

const kindOf = (n: number): Kind | null => (Object.entries(KIND).find(([, v]) => v === n)?.[0] as Kind) ?? null;

/** One frame as bytes: a 4-byte length, then the 18-byte head, then the body. */
export function encode(f: Frame): Buffer {
  let body: Buffer;
  if (f.kind === 'compute' || f.kind === 'result') {
    const values = f.values ?? new Float32Array(f.rows * f.hidden);
    if (values.length !== f.rows * f.hidden) throw new Error(`a ${f.kind} frame needs ${f.rows * f.hidden} values, not ${values.length}`);
    const picks = f.kind === 'compute' ? (f.picks ?? []) : [];
    if (f.kind === 'compute' && picks.length !== f.rows) throw new Error(`a compute frame needs picks for each of its ${f.rows} words`);
    const pickBytes = picks.reduce((n, p) => n + 1 + p.length * 6, 0);
    body = Buffer.alloc(pickBytes + values.length * 4);
    let at = 0;
    for (const row of picks) {
      if (row.length > 255) throw new Error('too many experts for one word');
      body.writeUInt8(row.length, at++);
      for (const p of row) {
        body.writeUInt16LE(p.id, at);
        body.writeFloatLE(p.weight, at + 2);
        at += 6;
      }
    }
    Buffer.from(values.buffer, values.byteOffset, values.byteLength).copy(body, at);
  } else body = Buffer.from(f.text ?? '', 'utf8');
  const out = Buffer.alloc(4 + HEAD + body.length);
  out.writeUInt32LE(HEAD + body.length, 0);
  out.writeUInt32LE(MAGIC, 4);
  out.writeUInt8(KIND[f.kind], 8);
  out.writeUInt8(0, 9);
  out.writeUInt16LE(f.layer, 10);
  out.writeUInt32LE(f.seq >>> 0, 12);
  out.writeUInt16LE(f.rows, 16);
  out.writeUInt32LE(f.hidden, 18);
  body.copy(out, 4 + HEAD);
  return out;
}

/** One frame from its bytes after the length field. Throws in plain words on anything that is not a frame. */
export function decode(b: Buffer): Frame {
  if (b.length < HEAD || b.readUInt32LE(0) !== MAGIC) throw new Error('not an expert-parallel frame (wrong start)');
  const kind = kindOf(b.readUInt8(4));
  if (!kind) throw new Error(`unknown frame kind ${b.readUInt8(4)}`);
  const f: Frame = { kind, layer: b.readUInt16LE(6), seq: b.readUInt32LE(8), rows: b.readUInt16LE(12), hidden: b.readUInt32LE(14) };
  let at = HEAD;
  if (kind === 'compute' || kind === 'result') {
    if (kind === 'compute') {
      f.picks = [];
      for (let r = 0; r < f.rows; r++) {
        if (at >= b.length) throw new Error('a compute frame ended inside its picks');
        const n = b.readUInt8(at++);
        if (at + n * 6 > b.length) throw new Error('a compute frame ended inside its picks');
        const row: Pick[] = [];
        for (let i = 0; i < n; i++, at += 6) row.push({ id: b.readUInt16LE(at), weight: b.readFloatLE(at + 2) });
        f.picks.push(row);
      }
    }
    const want = f.rows * f.hidden * 4;
    if (b.length - at !== want) throw new Error(`a ${kind} frame has ${b.length - at} bytes of values, not ${want}`);
    // Copied out, so the values are aligned and do not hold the read buffer.
    f.values = new Float32Array(f.rows * f.hidden);
    Buffer.from(f.values.buffer).set(b.subarray(at, at + want));
  } else f.text = b.toString('utf8', at);
  return f;
}

/** Collects bytes from a stream and gives back whole frames as they complete (TCP cuts and joins them freely). */
export class FrameReader {
  private parts: Buffer[] = [];
  private have = 0;

  push(chunk: Buffer): Frame[] {
    this.parts.push(chunk);
    this.have += chunk.length;
    const out: Frame[] = [];
    for (;;) {
      if (this.have < 4) break;
      const head = this.peek(4);
      const len = head.readUInt32LE(0);
      if (len < HEAD || len > MAX_FRAME) throw new Error(`a frame of ${len} bytes is not accepted (the stream is not expert-parallel frames)`);
      if (this.have < 4 + len) break;
      const all = this.take(4 + len);
      out.push(decode(all.subarray(4)));
    }
    return out;
  }

  private peek(n: number): Buffer {
    if (this.parts[0].length >= n) return this.parts[0];
    const all = Buffer.concat(this.parts);
    this.parts = [all];
    return all;
  }

  private take(n: number): Buffer {
    const all = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    const got = all.subarray(0, n);
    const rest = all.subarray(n);
    this.parts = rest.length ? [rest] : [];
    this.have = rest.length;
    return got;
  }
}
