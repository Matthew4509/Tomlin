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

test('a guessing model (speculative drafts): started beside the big one, on the card with it, or in RAM on the CPU', () => {
  const run = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const, draft: 'C:/models/Qwen3.5-0.8B-Q4_K_M.gguf' };
  const card = chatArgs('big.gguf', 9000, 'vulkan', 0, false, run, true);
  assert.deepEqual(card.slice(card.indexOf('--spec-type')), ['--spec-type', 'draft-simple', '-md', 'C:/models/Qwen3.5-0.8B-Q4_K_M.gguf', '-ngld', '999']);
  // On the CPU the guessing model is in RAM too.
  const cpu = chatArgs('big.gguf', 9000, 'cpu', 0, false, run);
  assert.deepEqual(cpu.slice(cpu.indexOf('--spec-type')), ['--spec-type', 'draft-simple', '-md', 'C:/models/Qwen3.5-0.8B-Q4_K_M.gguf', '-ngld', '0']);
  // Its context memory follows the big model's smaller cache.
  const half = chatArgs('big.gguf', 9000, 'vulkan', 0, false, { ...run, cache: 'q8_0' }, true);
  assert.deepEqual(half.slice(half.indexOf('-ngld') + 2), ['-ctkd', 'q8_0', '-ctvd', 'q8_0']);
  // None chosen: no speculative flags at all.
  assert.ok(!chatArgs('big.gguf', 9000, 'vulkan', 0, false, { ctx: 8192, cache: 'f16', place: 'auto' }, true).some(a => a.startsWith('--spec') || a === '-md'));
});

test('the speed setups: each new run setting gives its own flags, and old settings give exactly today\'s', () => {
  const base = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const };
  const tail = (a: string[]) => a.slice(a.indexOf('--no-webui') + 1);
  // Old settings: nothing new.
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 4, false, base, true)), ['-t', '4']);
  // A smaller card margin for llama.cpp's own fit: only where it fits (Auto on a card of its own).
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, fitMargin: 512 }, true)), ['-fitt', '512']);
  assert.ok(!chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, place: 'card', fitMargin: 512 }, true).includes('-fitt'));
  assert.ok(!chatArgs('m.gguf', 9000, 'cpu', 0, false, { ...base, fitMargin: 512 }).includes('-fitt'));
  // The experts of the first N layers in RAM, the rest on the card.
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, place: 'layers', moeCpu: 30 }, true)), ['-ngl', '999', '--n-cpu-moe', '30']);
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'cpu', 0, false, { ...base, place: 'layers', moeCpu: 30 })), ['-ngl', '0']);
  // Flash attention on or off (with a smaller cache it is on already).
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, fa: 'off' }, true)), ['-fa', 'off']);
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, fa: 'on' }, true)), ['-fa', 'on']);
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, cache: 'q8_0', fa: 'off' }, true)), ['-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0']);
  assert.ok(!chatArgs('m.gguf', 9000, 'cpu', 0, false, { ...base, fa: 'on' }).includes('-fa'));
  // Threads for this model, over the PC's own figure.
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'cpu', 4, false, { ...base, threads: 3 })).slice(-2), ['-t', '3']);
  // Copy-ahead (no second model).
  assert.deepEqual(tail(chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, spec: 'ngram' }, true)), ['--spec-type', 'ngram-mod']);
  // A guessing model in RAM beside a model on the card, and its own smaller cache.
  const d = chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, draft: 'C:/d.gguf', draftOn: 'ram', draftCache: 'q8_0' }, true);
  assert.deepEqual(d.slice(d.indexOf('--spec-type')), ['--spec-type', 'draft-simple', '-md', 'C:/d.gguf', '-ngld', '0', '-ctkd', 'q8_0', '-ctvd', 'q8_0']);
  // A guessing model wins over copy-ahead (one speculative kind at a time).
  const both = chatArgs('m.gguf', 9000, 'vulkan', 0, false, { ...base, draft: 'C:/d.gguf', spec: 'ngram' }, true);
  assert.equal(both.filter(a => a === '--spec-type').length, 1);
  assert.ok(both.includes('draft-simple'));
});

test('a chat template the runner cannot read is recognised, so the runner tries its plain formats', () => {
  const nemo = 'While executing FilterExpression at line 12, column 122 in source:';
  assert.ok(TEMPLATE_FAULT.test(nemo));
  assert.ok(TEMPLATE_FAULT.test("Error: selectattr: unknown test 'tool_calls'"));
  assert.ok(!TEMPLATE_FAULT.test('llama_model_load: error loading model: tensor data is not within the file bounds'));
  assert.match(whyItFailed(nemo), /chat format/);
});
