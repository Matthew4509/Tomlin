// The unattended retest (tools/retest.ts): each CPU's heat on a two-socket PC, where the runner put the model, and
// finding a model file by name, a split one by its first part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuTemps, findModel, placement, VARIANTS, variantWords } from '../tools/retest.ts';

const sensor = (Text: string, Value: string) => ({ Text, Value, Children: [] });
const cpu = (n: number, pkg: string, cores: string[]) => ({
  Text: `Intel Xeon E5-2670 #${n}`, ImageURL: 'images_icon/cpu.png',
  Children: [{ Text: 'Temperatures', Children: [sensor('CPU Package', pkg), ...cores.map((c, i) => sensor(`CPU Core #${i + 1}`, c)), sensor('CPU Core #1 Distance to TjMax', '40.0 °C'), sensor('Core Average', '50.0 °C')] }],
});

test('two CPUs: each one has its own package heat and hottest core; distance to TjMax is never read as heat', () => {
  const root = { Text: 'Sensor', Children: [{ Text: 'MACHINE', Children: [cpu(1, '61.0 °C', ['55.0 °C', '58,5 °C']), cpu(2, '72.0 °C', ['70.0 °C', '69.0 °C']), { Text: 'NVIDIA GeForce RTX 3060', ImageURL: 'images_icon/nvidia.png', Children: [sensor('GPU Core', '65.0 °C')] }] }] };
  assert.deepEqual(cpuTemps(root), [
    { cpu: 'Intel Xeon E5-2670 #1', package: 61, coreMax: 58.5 },
    { cpu: 'Intel Xeon E5-2670 #2', package: 72, coreMax: 70 },
  ]);
});

test('no CPU in the reading: none', () => {
  assert.deepEqual(cpuTemps({ Text: 'Sensor', Children: [] }), []);
});

test('placement: build, layers on the card, and the card and RAM shares from the runner log', () => {
  const log = [
    'common_params_print_info: build 12250 (abc1234) with Clang',
    'load_tensors: offloaded 41/41 layers to GPU',
    'load_tensors:        CUDA0 model buffer size = 10240.00 MiB',
    'load_tensors:   CPU_Mapped model buffer size =  8192.00 MiB',
    'load_tensors:   CPU_Mapped model buffer size =  2048.00 MiB',
  ].join('\n');
  assert.equal(placement(log), 'b12250, 41/41 layers offloaded, 10.0 GB on the card, 10.0 GB in RAM');
  assert.equal(placement(''), '');
});

test('a model is found by name in a nested folder, a split model by its first part, and a missing one is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retest-'));
  try {
    mkdirSync(join(dir, 'maker', 'model'), { recursive: true });
    writeFileSync(join(dir, 'maker', 'model', 'Some-Model-Q4_K_M.gguf'), '');
    writeFileSync(join(dir, 'Big-Model-Q3_K_XL-00002-of-00003.gguf'), '');
    writeFileSync(join(dir, 'Big-Model-Q3_K_XL-00001-of-00003.gguf'), '');
    assert.equal(findModel('some-model-q4_k_m.gguf', [dir]), join(dir, 'maker', 'model', 'Some-Model-Q4_K_M.gguf'));
    assert.equal(findModel('Big-Model-Q3_K_XL.gguf', [dir]), join(dir, 'Big-Model-Q3_K_XL-00001-of-00003.gguf'));
    assert.equal(findModel('Missing.gguf', [dir, join(dir, 'not-there')]), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CPU-only runs try default threads, 16, 32 and NUMA distribute; card runs one setting', () => {
  assert.deepEqual(VARIANTS.cpu.map(variantWords), ['default threads, no NUMA setting', '16 threads, no NUMA setting', '32 threads, no NUMA setting', '16 threads, --numa distribute', '32 threads, --numa distribute']);
  assert.equal(VARIANTS.gpu.length, 1);
});
