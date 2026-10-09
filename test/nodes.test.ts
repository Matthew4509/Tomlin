// Nodes: the memory bar and the set-up steps read from the facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBar, needOf } from '../src/nodes.ts';

const GB = 2 ** 30;

test('the memory bar splits used memory into the models loaded and the rest, and names each part', () => {
  const bar = memoryBar(16 * GB, 11 * GB, [{ name: 'Qwen3.5-9B', bytes: 6 * GB }, { name: 'Realistic Vision 6', bytes: 2 * GB }]);
  assert.deepEqual(bar.segments.map(s => [s.kind, s.bytes / GB]), [['models', 8], ['other', 3], ['free', 5]]);
  assert.equal(bar.segments[0].label, 'Models loaded: Qwen3.5-9B, Realistic Vision 6');
  assert.ok(Math.abs(bar.segments.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  assert.equal(bar.text, 'models loaded 8.0 GB · other programs 3.0 GB · free 5.0 GB (of 16 GB)');
});

test('the bar never adds up to more than the PC has, and leaves out empty parts', () => {
  // A model counted larger than all use (memory borrowed for graphics) is capped at what is used.
  const bar = memoryBar(8 * GB, 3 * GB, [{ name: 'Big', bytes: 5 * GB }]);
  assert.deepEqual(bar.segments.map(s => [s.kind, s.bytes / GB]), [['models', 3], ['free', 5]]);
  assert.equal(memoryBar(8 * GB, 2 * GB, []).text, 'other programs 2.0 GB · free 6.0 GB (of 8.0 GB)');
  assert.equal(Math.round(needOf(GB) / 2 ** 20), Math.round(1.1 * 1024 + 0.8 * 1024));
});
