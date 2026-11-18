// The Mini cluster's engine interface (src/cluster/engine.ts): version 1, the layer split, behind it with the same plan
// src/layersplit.ts makes today; version 2, expert parallel, a prototype that never takes a load in this TOMLIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseEngine, commonBuild, engineWanted, LayerSplitEngine, refused, type EnginePlan, type LoadContext } from '../src/cluster/engine.ts';
import { ExpertParallelEngine } from '../src/cluster/experts.ts';
import { GIGABIT } from '../src/cluster/estimate.ts';
import { planLayers } from '../src/layersplit.ts';
import type { Lender, Listed } from '../src/maxplace.ts';
import { DENSE12, FLASH38, GIB, NEXT80, z240, z820 } from './clusterfixtures.ts';

const net = { rttMs: 0.5, bytesPerSec: GIGABIT };
const dev = (name: string, what: string, totalGb: number, freeGb: number): Listed => ({ name, what, total: totalGb * GIB, free: freeGb * GIB });
const main: Lender = { name: 'Main PC', endpoint: '127.0.0.1:5001', hasCard: true };
// The main loader (the Z820) with its 3060; the main PC lends its P2000 and its RAM.
const LISTED: Listed[] = [dev('CUDA0', 'RTX 3060', 12, 11.2), dev('RPC0', main.endpoint, 5, 4.5), dev('RPC1', main.endpoint, 48, 40), dev('CPU', 'Xeon', 64, 58)];
const ctx: LoadContext = { device: 'cuda', listed: LISTED, lenders: [main] };

test('the layer split engine makes the same plan as src/layersplit.ts, as llama-server run fields', () => {
  const e = new LayerSplitEngine();
  const p = e.plan(NEXT80, [z820(), z240()], ctx);
  assert.ok(!refused(p), JSON.stringify(p));
  const want = planLayers({ layers: NEXT80.layers, bytes: NEXT80.bytes, kv: NEXT80.kv }, LISTED, [main], { free: 58 * GIB });
  assert.ok(!('why' in want));
  const plan = p as EnginePlan;
  assert.deepEqual(plan.run?.maxPlace, { device: 'cuda', dev: want.dev, split: want.split, override: [], ngl: want.ngl });
  assert.deepEqual(plan.run?.rpc, [main.endpoint]);
  assert.equal(plan.words, want.words);
  assert.deepEqual(plan.members, ['Big PC', 'Main PC']);
});

test('the layer split engine refuses a model the PCs cannot hold, in the words src/layersplit.ts gives', () => {
  const big = { ...FLASH38, bytes: 200 * GIB };
  const p = new LayerSplitEngine().plan(big, [z820(), z240()], ctx);
  assert.ok(refused(p));
  assert.equal(p.refuse, true);
  assert.match(p.why, /more room than the PCs have free/);
});

test('the layer split needs two PCs, a main loader and one llama.cpp build on all of them', () => {
  const e = new LayerSplitEngine();
  assert.match(e.cannot(NEXT80, [z820()]), /at least two PCs/);
  assert.match(e.cannot(NEXT80, [{ ...z820(), loader: false }, z240()]), /no main loader/);
  assert.match(e.cannot(NEXT80, [z820(), { ...z240(), builds: ['b12250'] }]), /different llama\.cpp builds/);
  assert.equal(e.cannot(NEXT80, [z820(), { ...z240(), builds: [] }]), '', 'an older TOMLIN that does not say its build is not refused here');
  assert.equal(e.cannot(DENSE12, [z820(), z240()]), '', 'the layer split takes dense models too');
});

test('commonBuild finds the build every PC can run', () => {
  assert.equal(commonBuild([{ ...z820(), builds: ['b12250', 'b11284'] }, z240()]), 'b11284');
  assert.equal(commonBuild([z820(), { ...z240(), builds: ['b12250'] }]), '');
  assert.equal(commonBuild([{ ...z820(), builds: [] }, { ...z240(), builds: [] }]), '');
});

test('the pool is each PC\'s RAM less the 4.5 GB it keeps, plus its card less its margin', () => {
  const pool = new LayerSplitEngine().pool([z820(), z240()]);
  // Z820: 58 - 4.5 = 53.5 GB of RAM and 11.2 - 1.5 = 9.7 GB of card; main PC: 40 - 4.5 = 35.5 and 4.5 - 0.5 = 4.
  assert.equal(Math.round((pool / GIB) * 10) / 10, 102.7);
});

test('version 1 is used unless TOMLIN_CLUSTER_ENGINE asks for experts', () => {
  assert.equal(engineWanted(''), 'layers');
  assert.equal(engineWanted('layers'), 'layers');
  assert.equal(engineWanted('nonsense'), 'layers');
  for (const s of ['experts', 'expert', 'Expert-Parallel', '2', 'v2']) assert.equal(engineWanted(s), 'experts', s);
});

test('asking for expert parallel today still loads with the layer split, and says why in one line', () => {
  const engines = [new LayerSplitEngine(), new ExpertParallelEngine(net)];
  const off = chooseEngine(engines, FLASH38, [z820(), z240()], '');
  assert.equal(off.engine.id, 'layers');
  assert.equal(off.note, '');
  const asked = chooseEngine(engines, FLASH38, [z820(), z240()], 'experts');
  assert.equal(asked.engine.id, 'layers');
  assert.match(asked.note, /^Cluster: Expert parallel .* cannot run Qwen3\.8-Flash-Next \(it is a prototype in this TOMLIN.*\), so the layer split is used\.$/);
  const dense = chooseEngine(engines, DENSE12, [z820(), z240()], 'experts');
  assert.match(dense.note, /not a mixture-of-experts model/);
  const missing = chooseEngine([new LayerSplitEngine()], FLASH38, [z820(), z240()], 'experts');
  assert.equal(missing.engine.id, 'layers');
  assert.match(missing.note, /not in this TOMLIN/);
});

test('a built expert-parallel engine would be chosen when asked (the switch for the day the runner side exists)', () => {
  const engines = [new LayerSplitEngine(), new ExpertParallelEngine(net, true)];
  const got = chooseEngine(engines, FLASH38, [z820(), z240()], 'experts');
  assert.equal(got.engine.id, 'experts');
  assert.equal(got.note, '');
});

test('each engine says whether its PCs work at the same time', () => {
  assert.equal(new LayerSplitEngine().parallel, false);
  assert.equal(new ExpertParallelEngine(net).parallel, true);
});
