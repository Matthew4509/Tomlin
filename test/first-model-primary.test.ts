// P1-5 (3 Nov): a hire with no model, then given one, got it as the second model (fallback), not the primary.
// The first model a hire has is always their first choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Staff } from '../src/staff.ts';

async function withStaff(run: (s: Staff) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'first-model-'));
  try { await run(await Staff.load(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a hire with no model given only a fallback gets it as their first choice', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default');
  assert.equal(m.model ?? null, null);
  const after = await s.change(m.id, { fallback: 'remote:pc1:gpt-oss-20b' });
  assert.equal(after?.model, 'remote:pc1:gpt-oss-20b');
  assert.equal(after?.fallback, null);
}));

test('"Use it always" from the backup window on a hire with no model makes it the first choice', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default');
  // The same call /api/staff/backup makes for "always".
  const after = await s.change(m.id, { fallback: 'qwen3-8b.gguf', cover: null });
  assert.equal(after?.model, 'qwen3-8b.gguf');
  assert.equal(after?.fallback, null);
}));

test('clearing the first choice moves the fallback up rather than leaving a hire with only a second model', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default', 'big.gguf');
  await s.change(m.id, { fallback: 'small.gguf' });
  const after = await s.change(m.id, { model: null });
  assert.equal(after?.model, 'small.gguf');
  assert.equal(after?.fallback, null);
}));

test('a hire with a first choice keeps the fallback as the second', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default', 'big.gguf');
  const after = await s.change(m.id, { fallback: 'small.gguf' });
  assert.equal(after?.model, 'big.gguf');
  assert.equal(after?.fallback, 'small.gguf');
}));

test('a hire whose PC was let go (parked) is not given the fallback as first choice: the model comes back with the PC', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default');
  const parked = [{ pc: 'pc1', model: 'remote:pc1:a', fallback: null, left: null }];
  const after = await s.change(m.id, { parked, fallback: 'small.gguf' });
  assert.equal(after?.model ?? null, null);
  assert.equal(after?.fallback, 'small.gguf');
}));
