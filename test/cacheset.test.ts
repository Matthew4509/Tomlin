// How a model keeps its context (2.1.10): the cache type and whether it is in RAM rather than on the card
// (--no-kv-offload). At a 262,144 context Qwen3.8's cache took 6.0 GB of the Z820's 3060, so weights went to the
// processors and it wrote 3 times slower. The two-PC door is tested in test/runseton.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatArgs } from '../src/llama.ts';
import { cacheSetAsk, cacheWords, cleanRunWith } from '../src/runset.ts';

const list = [{ id: 'big.gguf', name: 'Big', bytes: 4000 }, { id: 'ollama:qwen', name: 'Qwen', bytes: 100 }];

test('the context in RAM is kept only as true, and reaches the runner only on a card', () => {
  assert.equal(cleanRunWith({ ctx: 8192, cache: 'q8_0', kvRam: true }, 'big.gguf', list, [8192]).kvRam, true);
  for (const v of [false, 'true', 1, '--no-kv-offload']) assert.equal('kvRam' in cleanRunWith({ kvRam: v }, 'big.gguf', list, [8192]), false, String(v));
  const run = { ctx: 262144, cache: 'q8_0' as const, place: 'auto' as const, kvRam: true };
  assert.ok(chatArgs('m.gguf', 1, 'cuda', 8, false, run, true).includes('--no-kv-offload'));
  assert.ok(chatArgs('m.gguf', 1, 'vulkan', 8, false, run, true).includes('--no-kv-offload'));
  // On the processor it is in RAM already.
  assert.ok(!chatArgs('m.gguf', 1, 'cpu', 8, false, run).includes('--no-kv-offload'));
  assert.ok(!chatArgs('m.gguf', 1, 'cuda', 8, false, { ...run, kvRam: false }, true).includes('--no-kv-offload'));
});

test('a host asks for a cache type, RAM or the card, or both, for a model this PC has', () => {
  assert.deepEqual(cacheSetAsk({ model: 'big.gguf', cache: 'q8_0' }, list), { model: list[0], cache: 'q8_0' });
  assert.deepEqual(cacheSetAsk({ model: 'big.gguf', kvRam: true }, list), { model: list[0], kvRam: true });
  assert.deepEqual(cacheSetAsk({ model: 'big.gguf', cache: 'f16', kvRam: false }, list), { model: list[0], cache: 'f16', kvRam: false });
  const no = (b: Record<string, unknown>, status: number) => assert.equal((cacheSetAsk(b, list) as { status: number }).status, status, JSON.stringify(b));
  no({ model: 'big.gguf' }, 400);
  no({ model: 'big.gguf', cache: 'q2_k' }, 400);
  no({ model: 'big.gguf', cache: 'q8_0 -ngl 0' }, 400);
  no({ model: 'big.gguf', kvRam: 'yes' }, 400);
  no({ cache: 'q8_0' }, 400);
  no({ model: 'C:\\models\\big.gguf', cache: 'q8_0' }, 404);
  no({ model: 'ollama:qwen', cache: 'q8_0' }, 400);
  assert.equal(cacheWords('q8_0', true), 'q8_0 cache in RAM');
  assert.equal(cacheWords('f16', false), 'f16 cache on the card');
});
