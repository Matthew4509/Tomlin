// Speed tests kept with the hardware and model they ran on (src/speed.ts): the results history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSample, quantOf, summarise } from '../src/speed.ts';

test('quantOf reads the quantisation from a model name', () => {
  assert.equal(quantOf('Qwen3.5-35B-A3B-UD-Q2_K_XL'), 'UD-Q2_K_XL');
  assert.equal(quantOf('llama-3-8b-Q4_K_M'), 'Q4_K_M');
  assert.equal(quantOf('gemma-2b-f16'), 'F16');
  assert.equal(quantOf('qwen3:4b'), '');
});

test('a test keeps its hardware snapshot, model details, total time and result; control characters and empty fields go', () => {
  const s = cleanSample({ write: 12.34, tokens: 220, first: 1.5, total: 20, ok: true, snap: { node: 'HP 800 G1', gpu: 'Quadro K1200\n', vram: '4 GB', cpu: '' }, model: { name: 'm', quant: 'Q4_K_M', ctx: 8192 } });
  assert.equal(s?.total, 20);
  assert.equal(s?.ok, true);
  assert.deepEqual(s?.snap, { node: 'HP 800 G1', gpu: 'Quadro K1200', vram: '4 GB' });
  assert.deepEqual(s?.model, { name: 'm', quant: 'Q4_K_M', ctx: 8192 });
});

test('a sample with no details is the same as before, and the history lists tests newest first', () => {
  const a = cleanSample({ write: 5, tokens: 100 }, '2026-11-11T10:00:00Z')!;
  const b = cleanSample({ write: 6, tokens: 100 }, '2026-11-11T11:00:00Z')!;
  assert.equal('snap' in a, false);
  const sum = summarise({ name: 'm', where: 'x', answers: [], tests: [a, b] })!;
  assert.deepEqual(sum.history.map(t => t.write), [6, 5]);
});
