// Finding model files (src/llama.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatArgs, listModels, modelPath, TEMPLATE_FAULT, whyItFailed } from '../src/llama.ts';

test('models in folders and in parts are found, each once, and nothing outside the folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-models-'));
  try {
    await writeFile(join(dir, 'small.gguf'), 'x');
    await mkdir(join(dir, 'lmstudio-community', 'Big-GGUF'), { recursive: true });
    await writeFile(join(dir, 'lmstudio-community', 'Big-GGUF', 'Big-Q4_K_M.gguf'), 'xxxx');
    await writeFile(join(dir, 'lmstudio-community', 'Big-GGUF', 'mmproj-Big-F16.gguf'), 'xx');
    await mkdir(join(dir, 'split'));
    await writeFile(join(dir, 'split', 'Huge-Q4_K_M-00001-of-00002.gguf'), 'xxxxx');
    await writeFile(join(dir, 'split', 'Huge-Q4_K_M-00002-of-00002.gguf'), 'xxxxx');
    await writeFile(join(dir, 'notes.txt'), 'x');
    assert.deepEqual(listModels(dir), [
      { file: 'small.gguf', bytes: 1 },
      { file: 'lmstudio-community/Big-GGUF/Big-Q4_K_M.gguf', bytes: 4 },
      { file: 'split/Huge-Q4_K_M-00001-of-00002.gguf', bytes: 10 },
    ]);
    assert.equal(modelPath(dir, 'lmstudio-community/Big-GGUF/Big-Q4_K_M.gguf'), join(dir, 'lmstudio-community', 'Big-GGUF', 'Big-Q4_K_M.gguf'));
    assert.equal(modelPath(dir, '../outside.gguf'), null);
    assert.equal(modelPath(dir, 'split/Huge-Q4_K_M-00002-of-00002.gguf'), null);
    assert.deepEqual(listModels(join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a model that will not load is explained in plain words, by what the runner said', () => {
  assert.match(whyItFailed("llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen9'"), /newer than/);
  assert.match(whyItFailed('ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 23622320128'), /ran out of free memory/);
  assert.match(whyItFailed('gguf_init_from_file_impl: invalid magic characters: GGUX'),/incomplete or damaged/);
  assert.match(whyItFailed('something nobody has seen before'), /Try once more/);
});

test('the runner is started with the model\'s own context, cache and expert placement', () => {
  const base = chatArgs('m.gguf', 9000, 'cpu', 0);
  assert.deepEqual(base, ['-m', 'm.gguf', '--host', '127.0.0.1', '--port', '9000', '-c', '8192', '--no-webui', '-ngl', '0']);
  const big = chatArgs('m.gguf', 9000, 'cuda', 4, false, { ctx: 32768, cache: 'q8_0', place: 'ram' }, true);
  assert.deepEqual(big.slice(6), ['-c', '32768', '--no-webui', '-ngl', '999', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--cpu-moe', '-t', '4']);
  // Experts in RAM means nothing on the CPU (everything is in RAM already).
  assert.ok(!chatArgs('m.gguf', 9000, 'cpu', 0, true, { ctx: 4096, cache: 'f16', place: 'ram' }).includes('--cpu-moe'));
  // Auto on a card of its own: no layer count, so llama.cpp's fit fills the card(s) and puts the rest in RAM.
  const auto = chatArgs('m.gguf', 9000, 'cuda', 0, false, { ctx: 8192, cache: 'f16', place: 'auto' }, true);
  assert.ok(!auto.includes('-ngl') && !auto.includes('--cpu-moe'));
  // Auto on a chip built into the processor (shared RAM): every layer on it, as before.
  assert.deepEqual(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ctx: 8192, cache: 'f16', place: 'auto' }, false).slice(9), ['-ngl', '999']);
  // All on the card: every layer, even with a card of its own.
  assert.deepEqual(chatArgs('m.gguf', 9000, 'cuda', 0, false, { ctx: 8192, cache: 'f16', place: 'card' }, true).slice(9), ['-ngl', '999']);
});

test('a chat template the runner cannot read is recognised, so the runner tries its plain formats', () => {
  const nemo = 'While executing FilterExpression at line 12, column 122 in source:';
  assert.ok(TEMPLATE_FAULT.test(nemo));
  assert.ok(TEMPLATE_FAULT.test("Error: selectattr: unknown test 'tool_calls'"));
  assert.ok(!TEMPLATE_FAULT.test('llama_model_load: error loading model: tensor data is not within the file bounds'));
  assert.match(whyItFailed(nemo), /chat format/);
});
