// The many-PC arithmetic (src/cluster/scale.ts): estimates only. What it must show: the layer split gets slower with
// every PC; expert parallel gains until about as many PCs as experts are chosen a layer, then levels off on gigabit,
// because every frame crosses the main loader's own port; a faster port for the main loader lifts that ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameBytes, layerMs, NET_10G, NET_1G, NET_MIXED, perSec, scale } from '../src/cluster/scale.ts';
import { FLASH38, GIB, NEXT80 } from './clusterfixtures.ts';

// 600 random choices a layer time: rougher than the plan's 4000, close enough for these comparisons and quick.
const base = { ramRate: 6.7e9, roomPerPc: 40 * GIB, cardRate: 250e9, fixedMs: 10, samples: 600 };

test('a Qwen3.8 layer frame is about 10.8 KB on the wire, packet headers included', () => {
  // 2560 x 4 + 83 bytes of frame = 10323, in 8 packets of 54 header bytes each.
  assert.equal(frameBytes(2560), 10323 + 8 * 54);
});

test('one member holding every expert: one frame out, its experts one after another, one frame back', () => {
  const t = layerMs({ experts: 512, k: 10, holders: 1, perExpertMs: 0.3, latencyMs: 0.5, frameMs: 0.1 }, 50);
  assert.ok(Math.abs(t - (0.1 + 0.5 + 10 * 0.3 + 0.1)) < 1e-9, String(t));
});

test('the same seed gives the same layer time, and more holders mean less work each but more frames', () => {
  const o = { experts: 512, k: 10, perExpertMs: 0.34, latencyMs: 0.69, frameMs: 0.092 };
  assert.equal(layerMs({ ...o, holders: 4 }), layerMs({ ...o, holders: 4 }));
  const two = layerMs({ ...o, holders: 2 });
  const ten = layerMs({ ...o, holders: 10 });
  assert.ok(ten < two, `${ten} vs ${two}`);
  // Free compute: then only the frames count, and more holders cost more.
  const free = { ...o, perExpertMs: 0 };
  assert.ok(layerMs({ ...free, holders: 10 }) > layerMs({ ...free, holders: 2 }));
});

test('the layer split gets slower with every PC added', () => {
  const at = (pcs: number) => perSec(scale(FLASH38, { ...base, pcs, net: NET_1G }).layersMs);
  assert.ok(at(10) < at(2) && at(40) < at(10), `${at(2)} ${at(10)} ${at(40)}`);
});

test('expert parallel on all-gigabit levels off near 10 PCs: 40 is within a few percent of 10', () => {
  for (const model of [FLASH38, NEXT80]) {
    const ten = perSec(scale(model, { ...base, pcs: 10, net: NET_1G }).experts.ms);
    const forty = perSec(scale(model, { ...base, pcs: 40, net: NET_1G }).experts.ms);
    const two = perSec(scale(model, { ...base, pcs: 2, net: NET_1G }).experts.ms);
    assert.ok(ten > two * 1.2, `${model.name}: ${two} -> ${ten}`);
    assert.ok(forty <= ten * 1.05, `${model.name}: ${ten} -> ${forty}`);
  }
});

test('a 10 GbE port for the main loader lifts the ceiling, and 10 GbE everywhere lifts it more', () => {
  const at = (net: typeof NET_1G) => perSec(scale(FLASH38, { ...base, pcs: 40, net }).experts.ms);
  assert.ok(at(NET_MIXED) > at(NET_1G) * 1.3, `${at(NET_1G)} vs ${at(NET_MIXED)}`);
  assert.ok(at(NET_10G) > at(NET_MIXED));
});

test('expert parallel is faster than the layer split and tensor parallel at every size tried', () => {
  for (const net of [NET_1G, NET_MIXED, NET_10G]) {
    for (const pcs of [2, 4, 10, 40]) {
      const r = scale(FLASH38, { ...base, pcs, net });
      assert.ok(r.experts.ms < r.layersMs && r.experts.ms < r.tensorMs, `${net.name}, ${pcs} PCs`);
    }
  }
});

test('tensor parallel through the main loader falls off past about 10 PCs on gigabit', () => {
  const at = (pcs: number) => perSec(scale(FLASH38, { ...base, pcs, net: NET_1G }).tensorMs);
  assert.ok(at(40) < at(10), `${at(10)} vs ${at(40)}`);
});

test('room: the experts must fit the members\' RAM shared out', () => {
  assert.equal(scale(FLASH38, { ...base, pcs: 2, net: NET_1G }).fits, true);
  assert.equal(scale(FLASH38, { ...base, roomPerPc: 20 * GIB, pcs: 2, net: NET_1G }).fits, false);
  assert.equal(scale(FLASH38, { ...base, roomPerPc: 20 * GIB, pcs: 4, net: NET_1G }).fits, true);
});
