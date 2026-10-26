import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driverAtLeast, missingCardRunner, runnerWhy } from '../src/runtimes.ts';

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

test('CUDA runner: only for a PC with an NVIDIA card of its own and a driver that knows CUDA 12.4', () => {
  const gtx = [{ name: 'NVIDIA GeForce GTX 1060 6GB', vendor: 'nvidia' as const, integrated: false }];
  assert.equal(runnerWhy('cuda', gtx, '581.57'), '');
  assert.equal(runnerWhy('cuda', gtx, '551.61'), '');
  // No nvidia-smi answer: the driver is not known, so it is not refused for it.
  assert.equal(runnerWhy('cuda', gtx, null), '');
  assert.match(runnerWhy('cuda', gtx, '536.23', 'Worker PC'), /^"Worker PC" has NVIDIA driver 536\.23; the CUDA runner needs 551\.61 or newer\. Update the driver/);
  assert.match(runnerWhy('cuda', [{ name: 'AMD Radeon RX 580', vendor: 'amd', integrated: false }], null), /no NVIDIA card of its own/);
  assert.match(runnerWhy('cuda', [{ name: 'Intel(R) HD Graphics 520', vendor: 'intel', integrated: true }], null, 'Laptop'), /^"Laptop" has no NVIDIA card of its own/);
  assert.match(runnerWhy('cuda', [], null), /no NVIDIA card/);
  // Every other runner is for any PC.
  assert.equal(runnerWhy('vulkan', [], null), '');
  assert.equal(runnerWhy('cpu', [], null), '');
});

test('driver versions are compared as numbers, not as words', () => {
  assert.equal(driverAtLeast('551.61', '551.61'), true);
  assert.equal(driverAtLeast('560.9', '551.61'), true);
  assert.equal(driverAtLeast('551.6', '551.61'), false);
  assert.equal(driverAtLeast('99.1', '551.61'), false);
  assert.equal(driverAtLeast('1000.1', '551.61'), true);
});

test('a runner\'s program is looked up on disk once, not on every Home poll (1,000 asks made 4,000+ disk calls)', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = fs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Runtimes } = await import('../src/runtimes.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-rt-'));
  try {
    const pins = join(dir, 'runtimes.json');
    writeFileSync(pins, JSON.stringify({ runtimes: { 'llama-cpu': { engine: 'llama', device: 'cpu', name: 'cpu', licence: '', parts: [{ url: 'https://x/a.zip', bytes: 1, sha256: 'a' }] }, 'llama-vulkan': { engine: 'llama', device: 'vulkan', name: 'vk', licence: '', parts: [{ url: 'https://x/b.zip', bytes: 1, sha256: 'b' }] } } }));
    mkdirSync(join(dir, 'app', 'llama-cpu'), { recursive: true });
    writeFileSync(join(dir, 'app', 'llama-cpu', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '');
    const rt = new Runtimes(join(dir, 'app'), pins, join(dir, 'home'));
    let calls = 0;
    const names = ['existsSync', 'readFileSync', 'readdirSync', 'statSync'] as const;
    const was = Object.fromEntries(names.map(n => [n, fs[n]]));
    for (const n of names) (fs as unknown as Record<string, unknown>)[n] = (...a: unknown[]) => { calls++; return (was[n] as (...x: unknown[]) => unknown)(...a); };
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 1000; i++) {
        rt.installed('llama', 'cpu');
        rt.installed('llama', 'vulkan');
      }
    } finally {
      for (const n of names) (fs as unknown as Record<string, unknown>)[n] = was[n];
      syncBuiltinESMExports();
    }
    assert.ok(calls <= 40, `${calls} disk calls for 2,000 asks`);
    assert.equal(rt.installed('llama', 'cpu'), true);
    assert.equal(rt.installed('llama', 'vulkan'), false);
    // A runner unpacked or removed here is seen at once (the remembered answer is dropped).
    await rt.removePin('llama-cpu').catch(() => undefined);
    rmSync(join(dir, 'app', 'llama-cpu'), { recursive: true, force: true });
    await rt.removePin('llama-cpu').catch(() => undefined);
    assert.equal(rt.installed('llama', 'cpu'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
