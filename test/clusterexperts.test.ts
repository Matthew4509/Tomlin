// The expert-parallel planner (src/cluster/experts.ts): each PC's share of every layer's experts, within its RAM, chosen
// for the fastest expected word; a slow network keeps a model that fits the lead on the lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExpertParallelEngine, expertCap, expertRoom, sharesOf, shareExperts } from '../src/cluster/experts.ts';
import { refused, type EnginePlan } from '../src/cluster/engine.ts';
import { GIGABIT } from '../src/cluster/estimate.ts';
import { DENSE12, FLASH38, GIB, NEXT80, z240, z820 } from './clusterfixtures.ts';

const at = (rttMs: number) => ({ rttMs, bytesPerSec: GIGABIT });

test('the lead keeps the lookup tables and what its card cannot hold in its RAM, so it holds fewer experts', () => {
  // Qwen3.8 on the Z820: 53.5 GB of RAM room, less the 27.1 GB of tables (30.99 + 1.5 cache - 5.35 on the card).
  assert.ok(Math.abs(expertRoom(FLASH38, z820()) / GIB - 26.36) < 0.05);
  // One expert of every layer: 48 x 1.09 GiB / 512 = 0.102 GiB.
  assert.equal(expertCap(FLASH38, z820()), 257);
  assert.equal(expertCap(FLASH38, z240()), 347);
  assert.equal(expertCap(DENSE12, z820()), 0);
  // With no room on its card, the lead's RAM holds the cache and everything else too.
  const smallCard = { ...z820(), card: { free: 2 * GIB, total: 2 * GIB } };
  assert.ok(expertRoom(FLASH38, smallCard) < expertRoom(FLASH38, z820()));
});

test('shares add up to every expert, within each PC\'s cap, the lead first', () => {
  for (const rtt of [0.1, 0.5, 1, 2, 5]) {
    for (const model of [NEXT80, FLASH38]) {
      const ms = [z820(), z240()];
      const owned = shareExperts(model, ms, at(rtt))!;
      assert.equal(owned.reduce((a, b) => a + b, 0), 512, `${model.name} at ${rtt} ms`);
      owned.forEach((n, i) => assert.ok(n >= 0 && n <= expertCap(model, ms[i])));
    }
  }
});

test('a slower network gives the far PC fewer experts, and at last none when the lead holds the model', () => {
  const ms = [z820(), z240()];
  const far = [0.2, 0.5, 1, 1.5, 3].map(r => shareExperts(NEXT80, ms, at(r))![1]);
  for (let i = 1; i < far.length; i++) assert.ok(far[i] <= far[i - 1], far.join(','));
  assert.ok(far[0] > 150, far.join(','));
  assert.equal(far.at(-1), 0);
  // Qwen3.8 cannot stay on the Z820 alone: its share is capped by room, whatever the network.
  assert.deepEqual(shareExperts(FLASH38, ms, at(5)), [257, 255]);
});

test('without speeds the share is by room only, the lead filled first', () => {
  const ms = [{ ...z820(), speeds: undefined }, { ...z240(), speeds: undefined }];
  assert.deepEqual(shareExperts(NEXT80, ms, at(0.5)), [512, 0]);
  assert.deepEqual(shareExperts(FLASH38, ms, at(0.5)), [257, 255]);
});

test('expert runs are contiguous ids, so each PC\'s part of an expert tensor is one stretch of the file', () => {
  const ms = [z820(), z240()];
  assert.deepEqual(sharesOf(ms, [300, 212]), [{ member: 'Big PC', from: 0, to: 300 }, { member: 'Main PC', from: 300, to: 512 }]);
  assert.deepEqual(sharesOf(ms, [512, 0]), [{ member: 'Big PC', from: 0, to: 512 }]);
});

test('the plan names each PC\'s experts, and says it is a prototype', () => {
  const e = new ExpertParallelEngine(at(0.5));
  const p = e.plan(FLASH38, [z820(), z240()]);
  assert.ok(!refused(p));
  const plan = p as EnginePlan;
  assert.deepEqual(plan.experts, [{ member: 'Big PC', from: 0, to: 257 }, { member: 'Main PC', from: 257, to: 512 }]);
  assert.match(plan.words, /"Big PC" holds experts 0 to 256 of every layer, "Main PC" holds experts 257 to 511 of every layer; "Big PC" does the attention on its card/);
  assert.ok(plan.notes.some(n => /Prototype/.test(n)));
  assert.equal(plan.run, undefined, 'nothing for llama-server: this engine cannot start a runner yet');
});

test('a slow network keeps a model that fits on the lead, and the plan says so', () => {
  const p = new ExpertParallelEngine(at(5)).plan(NEXT80, [z820(), z240()]) as EnginePlan;
  assert.deepEqual(p.members, ['Big PC']);
  assert.ok(p.notes.some(n => /would slow Qwen3-Next-80B down on this network/.test(n)));
});

test('a model whose experts do not fit is refused before anything loads, with the numbers', () => {
  const p = new ExpertParallelEngine(at(0.5)).plan(FLASH38, [z820(), { ...z240(), ramFree: 10 * GIB }]);
  assert.ok(refused(p));
  assert.equal(p.refuse, true);
  assert.match(p.why, /experts need 52\.3 GB and the PCs have \d+\.\d GB free for them/);
});

test('cannot: dense models, one PC, no room, and (in this version) always the prototype line', () => {
  const e = new ExpertParallelEngine(at(0.5));
  assert.match(e.cannot(DENSE12, [z820(), z240()]), /not a mixture-of-experts model/);
  assert.match(e.cannot(FLASH38, [z820()]), /at least two PCs/);
  assert.match(e.cannot(FLASH38, [z820(), { ...z240(), ramFree: 10 * GIB }]), /cannot hold all/);
  assert.match(e.cannot(FLASH38, [z820(), z240()]), /prototype/);
  assert.equal(new ExpertParallelEngine(at(0.5), true).cannot(FLASH38, [z820(), z240()]), '');
});

test('its estimate uses the share it plans', () => {
  const e = new ExpertParallelEngine(at(0.5));
  const est = e.estimate(FLASH38, [z820(), z240()])!;
  assert.equal(est.label, 'estimate');
  assert.ok(est.tokPerSec > 5 && est.tokPerSec < 9, String(est.tokPerSec));
  assert.ok(est.lines.some(l => /holds 257 of 512 experts/.test(l)));
});
