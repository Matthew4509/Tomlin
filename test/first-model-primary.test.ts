// P1-5 (3 Nov): a hire with no model, then given one, got it as the second model (fallback), not the primary.
// The first model a hire has is always their first choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('no fallback is kept: clearing the first choice leaves none, and asking for a second sets none', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default', 'big.gguf');
  const two = await s.change(m.id, { fallback: 'small.gguf' });
  assert.equal(two?.model, 'big.gguf');
  assert.equal(two?.fallback ?? null, null);
  const after = await s.change(m.id, { model: null });
  assert.equal(after?.model ?? null, null);
  assert.equal(after?.fallback ?? null, null);
}));

test('a fallback saved before is dropped when the staff file is read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-model-'));
  try {
    const s = await Staff.load(dir);
    const m = await s.hire('Rosa', 'coder', 'default', 'big.gguf');
    const file = join(dir, 'staff.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.staff.find((x: { id: string }) => x.id === m.id).fallback = 'small.gguf';
    await writeFile(file, JSON.stringify(raw));
    const again = (await Staff.load(dir)).get(m.id);
    assert.equal(again?.model, 'big.gguf');
    assert.equal(again?.fallback ?? null, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hire whose PC was let go (parked) is not given the fallback as first choice: the model comes back with the PC', () => withStaff(async s => {
  const m = await s.hire('Rosa', 'coder', 'default');
  const parked = [{ pc: 'pc1', model: 'remote:pc1:a', fallback: null, left: null }];
  const after = await s.change(m.id, { parked, fallback: 'small.gguf' });
  assert.equal(after?.model ?? null, null);
  assert.equal(after?.fallback ?? null, null);
}));
