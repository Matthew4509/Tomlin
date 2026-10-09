import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheBytes, modelShape, readHeader, shapeOf } from '../src/gguf.ts';

/** A tiny GGUF file: header values only, no tensors. */
function gguf(values: Array<[string, 'u32' | 'str' | 'u32s' | 'strs', unknown]>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(values.length));
  for (const [key, type, v] of values) {
    parts.push(str(key));
    if (type === 'u32') parts.push(u32(4), u32(v as number));
    else if (type === 'str') parts.push(u32(8), str(v as string));
    else if (type === 'u32s') parts.push(u32(9), u32(4), u64((v as number[]).length), ...(v as number[]).map(u32));
    else parts.push(u32(9), u32(8), u64((v as string[]).length), ...(v as string[]).map(str));
  }
  return Buffer.concat(parts);
}

test('the header is read, long token lists are skipped, and the shape comes out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gguf-'));
  try {
    const file = join(dir, 'm.gguf');
    await writeFile(file, gguf([
      ['general.architecture', 'str', 'llama'],
      ['tokenizer.ggml.tokens', 'strs', Array.from({ length: 20000 }, (_, i) => `tok${i}`)],
      ['llama.block_count', 'u32', 32],
      ['llama.attention.head_count', 'u32', 32],
      ['llama.attention.head_count_kv', 'u32', 8],
      ['llama.embedding_length', 'u32', 4096],
      ['llama.context_length', 'u32', 131072],
    ]));
    const h = await readHeader(file, k => !k.startsWith('tokenizer'));
    assert.equal(h.has('tokenizer.ggml.tokens'), false);
    const s = await modelShape(file);
    assert.deepEqual(s, { arch: 'llama', layers: 32, attentionLayers: 32, kvHeads: 8, keyLength: 128, valueLength: 128, trainedContext: 131072, experts: 0, swaWindow: 0, swaEvery: 0 });
    // Llama 3 8B at 8k with an f16 cache: 1 GiB, the figure llama.cpp prints.
    assert.equal(cacheBytes(s!, 8192), 2 ** 30);
    assert.equal(cacheBytes(s!, 8192, 'q8_0'), 2 ** 30 * 17 / 32);
    await writeFile(file, 'not a model');
    assert.equal(await modelShape(file), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hybrid and sliding-window models count only the layers that keep the whole context', () => {
  const m = (o: Record<string, unknown>) => new Map(Object.entries(o) as [string, never][]);
  // Qwen3.5 2B as read from the real file: one full-attention layer in four.
  const qwen = shapeOf(m({ 'general.architecture': 'qwen35', 'qwen35.block_count': 24, 'qwen35.attention.head_count': 8, 'qwen35.attention.head_count_kv': 2, 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.full_attention_interval': 4 }))!;
  assert.equal(qwen.attentionLayers, 6);
  // A per-layer list with zeros marks the layers with no per-token cache.
  assert.equal(shapeOf(m({ 'general.architecture': 'x', 'x.block_count': 4, 'x.attention.head_count': 8, 'x.attention.head_count_kv': [0, 2, 0, 2], 'x.embedding_length': 1024 }))!.attentionLayers, 2);
  // Gemma 2 2B: half the layers keep only a 4096-token window (measured: 8k -> 32k adds about 1.25 GB).
  const gemma2 = shapeOf(m({ 'general.architecture': 'gemma2', 'gemma2.block_count': 26, 'gemma2.attention.head_count': 8, 'gemma2.attention.head_count_kv': 4, 'gemma2.attention.key_length': 256, 'gemma2.attention.value_length': 256, 'gemma2.attention.sliding_window': 4096 }))!;
  assert.deepEqual([gemma2.swaWindow, gemma2.swaEvery], [4096, 2]);
  const added = (cacheBytes(gemma2, 32768) - cacheBytes(gemma2, 8192)) / 2 ** 20;
  assert.ok(added > 1150 && added < 1350, String(added));
  // An unknown family with a window: counted in full (never under-estimated).
  assert.equal(shapeOf(m({ 'general.architecture': 'new', 'new.block_count': 2, 'new.attention.head_count': 2, 'new.embedding_length': 256, 'new.attention.sliding_window': 512 }))!.swaEvery, 0);
  assert.equal(shapeOf(m({ 'general.architecture': 'x' })), null);
});
