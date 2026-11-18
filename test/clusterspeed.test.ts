// The cluster is never slower than its main loader alone (src/cluster/experts.ts shareExperts and speedRule). Before a
// load the share is planned to never cost more than keeping every expert on the main loader; after a load the timed
// words decide. The figures of 14 Nov 2026 are used where they are real: 2.5 ms per remote layer between the Z240 and
// the Z820 through Max mode's path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExpertParallelEngine, expertCap, shareExperts, speedRule } from '../src/cluster/experts.ts';
import { estimateAlone, estimateExperts, GIGABIT } from '../src/cluster/estimate.ts';
import type { EnginePlan, Member, ModelFacts } from '../src/cluster/engine.ts';
import { seeded } from '../src/cluster/moe.ts';
import { FLASH38, GIB, NEXT80, z240, z820 } from './clusterfixtures.ts';

/** The wire time measured on 14 Nov: 2.5 ms per remote layer (round trip 2.33 ms plus a 10 KB frame each way at 1 GbE). */
const MEASURED = { rttMs: 2.33, bytesPerSec: GIGABIT };

/** A smaller mixture-of-experts model every main loader here can hold: Qwen3-30B-A3B shaped (48 layers, 128 experts, 8 chosen). */
const MOE30: ModelFacts = { name: 'Qwen3-30B-A3B', bytes: 16.5 * GIB, layers: 48, kv: 1 * GIB, moe: { experts: 128, used: 8, expertLayer: 0.32 * GIB, rest: 1.1 * GIB, restActive: 0.9 * GIB, hidden: 2048 } };

const alone = (model: ModelFacts, ms: Member[], net: typeof MEASURED) => estimateExperts(model, ms, ms.map((m, i) => (i === 0 ? model.moe!.experts : 0)), net)!.msPerToken;
const planned = (model: ModelFacts, ms: Member[], net: typeof MEASURED) => estimateExperts(model, ms, shareExperts(model, ms, net)!, net)!.msPerToken;

test('keeping every expert on the main loader is exactly the one-PC figure', () => {
  for (const model of [NEXT80, MOE30]) {
    const ms = [z820(), z240()];
    const one = estimateAlone(model, ms[0])!.msPerToken;
    assert.ok(Math.abs(alone(model, ms, MEASURED) - one) < 1e-9, model.name);
  }
});

test('never slower than one PC: 500 random clusters, networks and speeds, whenever the main loader can hold the model', () => {
  const rnd = seeded(20261114);
  let checked = 0;
  let shared = 0;
  for (let i = 0; i < 500; i++) {
    const model = [NEXT80, MOE30][i % 2];
    const pcs = 2 + Math.floor(rnd() * 3);
    const ms: Member[] = Array.from({ length: pcs }, (_, k) => {
      const base = k === 0 ? z820() : z240();
      return { ...base, id: `pc${k}`, name: `PC ${k}`, loader: k === 0, ramFree: (24 + rnd() * 40) * GIB, speeds: { card: 250e9, ram: (2 + rnd() * 18) * 1e9, fixedMs: 10 } };
    });
    const net = { rttMs: 0.05 + rnd() * 5, bytesPerSec: rnd() < 0.5 ? GIGABIT : 1.17e9 };
    if (expertCap(model, ms[0]) < model.moe!.experts) continue;
    checked++;
    const p = planned(model, ms, net);
    const a = alone(model, ms, net);
    assert.ok(p <= a + 1e-9, `case ${i}: shared ${p.toFixed(3)} ms against ${a.toFixed(3)} ms alone (${pcs} PCs, ${net.rttMs.toFixed(2)} ms)`);
    if (p < a - 1e-9) shared++;
  }
  assert.ok(checked > 200, `only ${checked} cases had a main loader that holds the model`);
  assert.ok(shared > 20 && shared < checked, `sharing should win sometimes, not always (${shared} of ${checked})`);
});

test('with the 2.5 ms measured between the Z240 and the Z820, the 80B stays on the Z820, at its own speed', () => {
  const ms = [z820(), z240()];
  assert.deepEqual(shareExperts(NEXT80, ms, MEASURED), [512, 0]);
  const p = new ExpertParallelEngine(MEASURED).plan(NEXT80, ms) as EnginePlan;
  assert.deepEqual(p.members, ['Big PC']);
  assert.ok(p.notes.some(n => /runs on "Big PC" alone/.test(n)));
  assert.ok(Math.abs(new ExpertParallelEngine(MEASURED).estimate(NEXT80, ms)!.msPerToken - estimateAlone(NEXT80, ms[0])!.msPerToken) < 1e-9);
});

test('with the same 2.5 ms, a model with heavier work a layer gives the main PC only a few experts, and only because that is faster', () => {
  // Qwen3-30B-A3B shaped: 8 of 128 experts a layer, 2.7 MB each. Sharing 11 of them comes out at 162.5 ms against 167.7 alone.
  const ms = [z820(), z240()];
  const owned = shareExperts(MOE30, ms, MEASURED)!;
  assert.ok(owned[1] > 0 && owned[1] < 32, owned.join('/'));
  assert.ok(planned(MOE30, ms, MEASURED) < estimateAlone(MOE30, ms[0])!.msPerToken);
});

test('a model that does not fit the main loader is shared out whatever the network (there is no one-PC time to keep)', () => {
  assert.ok(expertCap(FLASH38, z820()) < 512);
  assert.deepEqual(shareExperts(FLASH38, [z820(), z240()], MEASURED), [257, 255]);
});

test('the layers timed between the Z240 and the Z820 on 14 Nov: every split was slower, so the rule keeps one machine', () => {
  // docs/cluster-native/overlap.cpp --compare 10, one word, the Z820's processor as the far PC through Max mode's path:
  // [one machine, then the far PC taking 1..5 of the 10 chosen experts], ms a layer.
  const timed: Record<string, number[]> = {
    '80B size, 1.4 MB an expert': [1.6, 4.52, 4.93, 3.77, 3.76, 3.91],
    'Qwen3.8 size, 2.2 MB an expert': [2.32, 4.88, 4.82, 6.71, 4.94, 4.21],
    '4x Qwen3.8 size, 8.8 MB an expert': [5.1, 7.77, 7.77, 6.63, 7.55, 6.41],
  };
  for (const [size, [one, ...splits]] of Object.entries(timed)) {
    const best = Math.min(...splits);
    const rule = speedRule({ aloneMs: one, splitMs: best });
    assert.equal(rule.split, false, size);
    // What the cluster then runs at: the one-machine time, never the slower split.
    assert.equal(rule.split ? best : one, one, size);
  }
});

test('the speed rule on timed words: shared only when it is at least as fast as the main loader alone', () => {
  assert.equal(speedRule({ aloneMs: 115, splitMs: 92 }).split, true);
  assert.equal(speedRule({ aloneMs: 115, splitMs: 115 }).split, true, 'the same time is allowed');
  const slow = speedRule({ aloneMs: 115, splitMs: 130 }, '"Big PC"');
  assert.equal(slow.split, false);
  assert.match(slow.words, /runs on "Big PC" alone, so it is never slower than one PC/);
  const big = speedRule({ aloneMs: null, splitMs: 228 });
  assert.equal(big.split, true);
  assert.match(big.words, /does not fit/);
});
