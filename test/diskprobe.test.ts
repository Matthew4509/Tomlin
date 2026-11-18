import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE_BYTES, probeRead } from '../src/diskprobe.ts';

test('the drive probe gives bytes a second from a timed slice, and nothing for a small file, a missing one or a cached read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-probe-'));
  try {
    const small = join(dir, 'small.gguf');
    await writeFile(small, Buffer.alloc(1024));
    assert.equal(await probeRead(small), null, 'too small to test');
    assert.equal(await probeRead(join(dir, 'none.gguf')), null, 'missing');
    const big = join(dir, 'big.gguf');
    await writeFile(big, '');
    await truncate(big, PROBE_BYTES * 5);
    // A clock that says the slice took 1.2 s: 96 MiB over 1.2 s.
    let t = 0;
    const slow = () => (t += 1200);
    assert.equal(await probeRead(big, 0.5, slow), PROBE_BYTES / 1.2);
    // A real read of the same file is far faster than 1.5 GB/s only when it is in memory: either way the answer is a rate or null, never a nonsense figure.
    const real = await probeRead(big);
    assert.ok(real === null || (real > 0 && real < 1.5e9));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a model in parts is probed on its largest part, not the small first one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-probe-'));
  try {
    const first = join(dir, 'm-00001-of-00002.gguf');
    const second = join(dir, 'm-00002-of-00002.gguf');
    await writeFile(first, Buffer.alloc(4096));
    await writeFile(second, '');
    await truncate(second, PROBE_BYTES * 5);
    let t = 0;
    assert.equal(await probeRead(first, 0.5, () => (t += 1200)), PROBE_BYTES / 1.2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
