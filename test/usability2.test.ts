// Usability phase 2: a new hire never takes the id of someone who left (their chats and notebook stay theirs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Staff } from '../src/staff.ts';
import { Speeds, cleanSample, hereKey, pcKey, summarise } from '../src/speed.ts';

test('speed: a short answer is not counted; the test is the baseline until three real answers make an average', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speed-'));
  try {
    assert.equal(cleanSample({ write: 40, tokens: 5 }), null);
    assert.equal(cleanSample({ write: 0, tokens: 200 }), null);
    const s = await Speeds.load(dir);
    const k = hereKey('*/Qwen3.5-2B-Q4_K_M.gguf');
    assert.equal(s.get(k), null);
    assert.equal(s.add(k, 'Qwen3.5-2B', 'this PC', { write: 9.04, tokens: 200, read: 80, first: 1.25 }, 'test'), true);
    assert.deepEqual([s.expect(k), s.get(k)!.basis], [9, 'test']);
    s.add(k, 'Qwen3.5-2B', 'this PC', { write: 12, tokens: 100 }, 'answer');
    s.add(k, 'Qwen3.5-2B', 'this PC', { write: 14, tokens: 300, read: 90 }, 'answer');
    assert.equal(s.get(k)!.basis, 'test');
    s.add(k, 'Qwen3.5-2B', 'this PC', { write: 13, tokens: 100, read: 70 }, 'answer');
    const sum = s.get(k)!;
    assert.deepEqual([sum.expect, sum.basis, sum.average], [13, 'answers', { write: 13, read: 80, n: 3 }]);
    assert.equal(sum.test!.first, 1.3);
    // While a linked PC is being tested, its answers count as the test only.
    s.testing.add('pc:abc|');
    assert.equal(s.add(pcKey('abc', 'Qwen3.5-35B-A3B'), 'Qwen3.5-35B-A3B', 'big-pc', { write: 30, tokens: 200 }, 'answer'), false);
    assert.equal(s.add(pcKey('abc', 'Qwen3.5-35B-A3B'), 'Qwen3.5-35B-A3B', 'big-pc', { write: 30, tokens: 200 }, 'test'), true);
    s.testing.clear();
    await s.flush();
    const again = await Speeds.load(dir);
    assert.equal(again.get(k)!.recent.length, 3);
    assert.equal(again.get(pcKey('abc', 'Qwen3.5-35B-A3B'))!.where, 'big-pc');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('speed: real answers older than 30 days no longer make the average', () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const sum = summarise({ name: 'm', where: 'this PC', answers: [1, 2, 3].map(() => ({ at: old, write: 5, tokens: 100 })), tests: [{ at: old, write: 7, tokens: 200 }] })!;
  assert.deepEqual([sum.expect, sum.basis, sum.average], [7, 'test', null]);
});

test('a hire with the name of someone who left gets a fresh id, also after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'staff2-'));
  try {
    const s = await Staff.load(dir);
    const rowan = await s.hire('Rowan', 'coder', 'junior');
    assert.equal(rowan.id, 'rowan');
    assert.equal(await s.fire('rowan'), true);
    const again = await s.hire('Rowan', 'writer', 'junior');
    assert.equal(again.id, 'rowan-2');
    // A third Rowan while the second still works here, then after a restart.
    assert.equal((await s.hire('Rowan', 'coder', 'junior')).id, 'rowan-3');
    const loaded = await Staff.load(dir);
    await loaded.fire('rowan-3');
    assert.equal((await loaded.hire('Rowan', 'coder', 'junior')).id, 'rowan-4');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an id with chats left on disk from before leavers were listed is not given out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'staff2-'));
  try {
    const s = await Staff.load(dir);
    const m = await s.hire('Sam', 'coder', 'junior', undefined, id => id === 'sam' || id === 'sam-2');
    assert.equal(m.id, 'sam-3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the host has its own model: older settings start with the chat model picked then, and saving it keeps it', async () => {
  const { Store } = await import('../src/store.ts');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'sm-host-'));
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ chat: { model: '*/gemma-3-1b.gguf' } }));
    const s = new Store(dir);
    assert.equal((await s.settings()).hostModel, '*/gemma-3-1b.gguf');
    // Opening a hire's chat moves the chat pane to their model: the host's stays.
    await s.saveSettings({ chat: { model: '*/qwen-0.8b.gguf' } });
    assert.equal((await s.settings()).hostModel, '*/gemma-3-1b.gguf');
    await s.saveSettings({ hostModel: '*/qwen-2b.gguf' });
    assert.equal((await new Store(dir).settings()).hostModel, '*/qwen-2b.gguf');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
