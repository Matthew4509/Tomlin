import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingCardRunner } from '../src/runtimes.ts';

const p2000 = [{ name: 'NVIDIA Quadro P2000', integrated: false }];

test('missing card runner: a card of its own with only the CPU runner says so and names the fix', () => {
  const t = missingCardRunner('sd', p2000, () => false);
  assert.match(t, /NVIDIA Quadro P2000/);
  assert.match(t, /npm run fetch -- sd-vulkan/);
});

test('missing card runner: quiet when a card runner is there, or the PC has only a built-in chip', () => {
  assert.equal(missingCardRunner('sd', p2000, d => d === 'vulkan'), '');
  assert.equal(missingCardRunner('llama', p2000, d => d === 'cuda'), '');
  assert.equal(missingCardRunner('llama', [{ name: 'Intel(R) HD Graphics 520', integrated: true }], () => false), '');
  assert.equal(missingCardRunner('llama', [], () => false), '');
});
