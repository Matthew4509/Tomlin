// The expert-parallel frames (src/cluster/wire.ts): small, exact, and safe against a stream that is not frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, FrameReader, MAX_FRAME, type Frame } from '../src/cluster/wire.ts';

const values = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i) * 3);
const compute = (): Frame => ({ kind: 'compute', layer: 47, seq: 123456, rows: 2, hidden: 8, picks: [[{ id: 511, weight: 0.25 }, { id: 3, weight: 0.75 }], []], values: values(16) });

test('a compute frame comes back exactly as sent', () => {
  const f = compute();
  const b = encode(f);
  assert.equal(b.readUInt32LE(0), b.length - 4);
  const g = decode(b.subarray(4));
  assert.equal(g.kind, 'compute');
  assert.equal(g.layer, 47);
  assert.equal(g.seq, 123456);
  assert.equal(g.rows, 2);
  assert.equal(g.hidden, 8);
  assert.deepEqual(g.picks, f.picks);
  assert.deepEqual([...g.values!], [...f.values!]);
});

test('a layer frame for Qwen3.8 is about 10 KB (2560 values, 5 picks)', () => {
  const b = encode({ kind: 'compute', layer: 0, seq: 1, rows: 1, hidden: 2560, picks: [Array.from({ length: 5 }, (_, i) => ({ id: i, weight: 0.2 }))], values: values(2560) });
  assert.equal(b.length, 4 + 18 + 1 + 5 * 6 + 2560 * 4);
});

test('result, hello and error frames', () => {
  const r = decode(encode({ kind: 'result', layer: 1, seq: 9, rows: 1, hidden: 4, values: values(4) }).subarray(4));
  assert.equal(r.kind, 'result');
  assert.equal(r.picks, undefined);
  assert.deepEqual([...r.values!], [...values(4)]);
  const h = decode(encode({ kind: 'hello', layer: 0, seq: 0, rows: 0, hidden: 0, text: JSON.stringify({ from: 0, to: 257 }) }).subarray(4));
  assert.deepEqual(JSON.parse(h.text!), { from: 0, to: 257 });
  const e = decode(encode({ kind: 'error', layer: 0, seq: 0, rows: 0, hidden: 0, text: 'no layer 60 here' }).subarray(4));
  assert.equal(e.text, 'no layer 60 here');
});

test('encode refuses frames whose sizes do not agree', () => {
  assert.throws(() => encode({ ...compute(), values: values(15) }), /needs 16 values/);
  assert.throws(() => encode({ ...compute(), picks: [[]] }), /picks for each/);
});

test('decode refuses what is not a frame', () => {
  const b = encode(compute()).subarray(4);
  const bad = Buffer.from(b);
  bad.writeUInt32LE(0xdeadbeef, 0);
  assert.throws(() => decode(bad), /wrong start/);
  const kind = Buffer.from(b);
  kind.writeUInt8(99, 4);
  assert.throws(() => decode(kind), /unknown frame kind/);
  assert.throws(() => decode(b.subarray(0, b.length - 4)), /bytes of values/);
  assert.throws(() => decode(b.subarray(0, 20)), /ended inside its picks|bytes of values/);
});

test('the reader joins frames cut anywhere and splits frames sent together', () => {
  const a = encode(compute());
  const b = encode({ kind: 'result', layer: 2, seq: 7, rows: 1, hidden: 3, values: values(3) });
  const all = Buffer.concat([a, b, a]);
  for (const cut of [1, 3, 4, 5, 21, 22, 50, a.length, a.length + 1, all.length - 1]) {
    const r = new FrameReader();
    const got = [...r.push(all.subarray(0, cut)), ...r.push(all.subarray(cut))];
    assert.deepEqual(got.map(f => f.seq), [123456, 7, 123456], `cut at ${cut}`);
  }
  const r = new FrameReader();
  const got: Frame[] = [];
  for (const byte of all) got.push(...r.push(Buffer.from([byte])));
  assert.equal(got.length, 3);
});

test('the reader stops a stream that is not frames instead of waiting for gigabytes', () => {
  const r = new FrameReader();
  const len = Buffer.alloc(4);
  len.writeUInt32LE(MAX_FRAME + 1, 0);
  assert.throws(() => r.push(len), /not accepted/);
  assert.throws(() => new FrameReader().push(Buffer.from('GET / HTTP/1.1\r\n')), /not accepted/);
});
