// The cluster speed arithmetic (src/cluster/estimate.ts): estimates, never runs. Checked against what was measured: the
// Z820 alone writes Qwen3-Next-80B at 8.67 tok/s, and Max mode's layer split was slower than the Z820 alone (3.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, compositions, estimateAlone, estimateExperts, estimateLayers, expectedLayerMs, expertActive, GIGABIT, layerNetMs, rateFromRun, restActive } from '../src/cluster/estimate.ts';
import { DENSE12, FLASH38, GIB, NEXT80, z240, z820 } from './clusterfixtures.ts';

const net = { rttMs: 0.5, bytesPerSec: GIGABIT };

test('choose and compositions count right', () => {
  assert.equal(choose(5, 2), 10);
  assert.equal(choose(10, 0), 1);
  assert.equal(choose(3, 4), 0);
  // C(512, 10) = 312268282598377321216 exactly (worked out with whole numbers).
  assert.ok(Math.abs(choose(512, 10) / 312268282598377321216 - 1) < 1e-12);
  const c = compositions(10, 3);
  assert.equal(c.length, 66);
  assert.ok(c.every(x => x.reduce((a, b) => a + b, 0) === 10 && x.length === 3));
  assert.deepEqual(compositions(3, 1), [[3]]);
});

test('the bytes read a word: the experts chosen in every layer, and the rest outside them', () => {
  // 48 layers x 0.6611 GiB x 10/512 = 0.62 GiB.
  assert.ok(Math.abs(expertActive(NEXT80) / GIB - 0.6198) < 0.001);
  assert.equal(restActive(NEXT80), 1.288 * GIB);
  assert.equal(expertActive(DENSE12), 0);
  assert.equal(restActive(DENSE12), DENSE12.bytes);
});

test('rateFromRun undoes a measured run', () => {
  const bytes = 0.6655e9;
  const rate = rateFromRun(8.67, bytes, 15.5);
  assert.ok(Math.abs(rate / 6.7e9 - 1) < 0.02, String(rate));
  assert.equal(rateFromRun(1, 1e9, 2000), 0, 'a run slower than the other time is no reading');
});

test('one holder: a layer takes its chosen experts one after the other', () => {
  assert.ok(Math.abs(expectedLayerMs([512], 10, [0.2], [0]) - 2) < 1e-9);
});

test('two equal holders: the slowest of the two decides, between half and all of the work', () => {
  const t = expectedLayerMs([256, 256], 10, [1, 1], [0, 0]);
  // E[max(n, 10 - n)] for a near-binomial split of 10 is about 6.2.
  assert.ok(t > 6 && t < 6.5, String(t));
  // A far holder's wire time only counts when it holds a chosen expert.
  const far = expectedLayerMs([256, 256], 10, [1, 1], [0, 3]);
  assert.ok(far > t && far < t + 3, String(far));
  assert.ok(Math.abs(expectedLayerMs([512, 0], 10, [1, 1], [0, 3]) - 10) < 1e-9);
});

test('the wire time of a layer: the round trip and the hidden state both ways', () => {
  // 2 x 2560 values x 4 bytes = 20480 bytes at 117 MB/s = 0.175 ms.
  assert.ok(Math.abs(layerNetMs(2560, net) - (0.5 + 0.175)) < 0.001);
});

test('the Z820 alone comes out at its measured 8.67 tok/s on the 80B (the speeds are calibrated from that run)', () => {
  const e = estimateAlone(NEXT80, z820())!;
  assert.equal(e.label, 'estimate');
  assert.ok(Math.abs(e.tokPerSec - 8.67) < 0.3, String(e.tokPerSec));
  assert.match(e.lines.at(-1)!, /\(estimate\)$/);
});

test('the layer split is slower than the strongest PC alone on a model that fits it (as measured: 3.7 against 8.67)', () => {
  const alone = estimateAlone(NEXT80, z820())!;
  const split = estimateLayers(NEXT80, [z820(), z240()], net)!;
  assert.ok(split.tokPerSec < alone.tokPerSec, `${split.tokPerSec} vs ${alone.tokPerSec}`);
});

test('expert parallel beats the layer split, and on a fast enough wire the strongest PC alone', () => {
  const ms = [z820(), z240()];
  const split = estimateLayers(NEXT80, ms, net)!;
  const ep = estimateExperts(NEXT80, ms, [341, 171], net)!;
  assert.ok(ep.tokPerSec > split.tokPerSec * 1.5, `${ep.tokPerSec} vs ${split.tokPerSec}`);
  assert.ok(ep.tokPerSec > estimateAlone(NEXT80, z820())!.tokPerSec);
  // Qwen3.8 does not fit the Z820 alone; the layer split is the only way today.
  const split38 = estimateLayers(FLASH38, ms, net)!;
  const ep38 = estimateExperts(FLASH38, ms, [257, 255], net)!;
  assert.ok(ep38.tokPerSec > split38.tokPerSec * 3, `${ep38.tokPerSec} vs ${split38.tokPerSec}`);
});

test('no estimate without a PC\'s speeds, and none of expert parallel for a dense model', () => {
  const blind = { ...z240(), speeds: undefined };
  assert.equal(estimateLayers(NEXT80, [z820(), blind], net), null);
  assert.equal(estimateExperts(NEXT80, [z820(), blind], [256, 256], net), null);
  assert.equal(estimateExperts(DENSE12, [z820(), z240()], [1, 1], net), null);
  assert.equal(estimateAlone(NEXT80, blind), null);
});

test('a model the PCs cannot hold gets no speed from the layer split arithmetic', () => {
  const e = estimateLayers({ ...FLASH38, bytes: 300 * GIB }, [z820(), z240()], net)!;
  assert.equal(e.tokPerSec, 0);
  assert.ok(e.lines.some(l => /does not fit/.test(l)));
});
