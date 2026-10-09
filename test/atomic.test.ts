import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../src/atomic.ts';
import { Store } from '../src/store.ts';

test('fifty writes to one file at once: the last one wins, whole, with no copies left behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-atomic-'));
  try {
    const file = join(dir, 'a.json');
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeAtomic(file, JSON.stringify({ i, pad: 'x'.repeat(5000 + i) }))));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).i, 49);
    assert.deepEqual(await readdir(dir), ['a.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write that fails does not stop the next one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-atomic-'));
  try {
    const file = join(dir, 'b.json');
    // A folder where the file should be: the swap fails.
    await writeAtomic(join(file, 'inner'), 'x');
    await assert.rejects(writeAtomic(file, 'first'));
    await rm(file, { recursive: true });
    await writeAtomic(file, 'second');
    assert.equal(await readFile(file, 'utf8'), 'second');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settings saved many times at once keep every change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-atomic-'));
  try {
    const store = new Store(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.saveSettings({ loadSeconds: { [`m${i}`]: i } })));
    const again = new Store(dir);
    assert.equal(Object.keys((await again.settings()).loadSeconds).length, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a leftover runner is ended only when its program and start time both match', async () => {
  const { stale } = await import('../src/leftovers.ts');
  const noted = [{ pid: 10, exe: 'C:/SM/runtime/llama-cpu/llama-server.exe', at: 1_000_000 }, { pid: 11, exe: 'C:/SM/runtime/sd-cpu/sd-server.exe', at: 2_000_000 }, { pid: 12, exe: 'C:/SM/runtime/llama-cpu/llama-server.exe', at: 3_000_000 }];
  const running = [
    { pid: 10, path: 'C:/SM/runtime/llama-cpu/LLAMA-SERVER.exe', startMs: 999_200 },
    { pid: 11, path: 'C:/Windows/notepad.exe', startMs: 2_000_000 },
    { pid: 12, path: 'C:/SM/runtime/llama-cpu/llama-server.exe', startMs: 3_600_000 },
  ];
  assert.deepEqual(stale(noted, running), [10]);
});

test('two graphics cards count as their memory added up', async () => {
  const { cardsTogether } = await import('../src/hardware.ts');
  const GB = 2 ** 30;
  assert.deepEqual(cardsTogether([{ total: 16 * GB, used: 1 * GB }, { total: 16 * GB, used: 2 * GB }]), { count: 2, total: 32 * GB, used: 3 * GB });
  assert.equal(cardsTogether([]), null);
});
