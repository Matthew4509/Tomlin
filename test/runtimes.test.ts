import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driverAtLeast, firstStartNote, missingCardRunner, pageDownloads, runnerWhy, tccNote } from '../src/runtimes.ts';
import { readFileSync } from 'node:fs';

const p2000 = [{ name: 'NVIDIA Quadro P2000', integrated: false }];

test('missing card runner: a card of its own with only the CPU runner says so and names the fix', () => {
  const t = missingCardRunner('sd', p2000, () => false);
  assert.match(t, /NVIDIA Quadro P2000/);
  // The page's own Download first (audit C6: an AMD or Intel PC had only the command line), the command as well.
  assert.match(t, /Models, Model runners: Download .*Vulkan/);
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

test('the page downloads the card runners (CUDA and Vulkan), never the CPU ones that come with TOMLIN', () => {
  assert.equal(pageDownloads({ engine: 'sd', device: 'vulkan' }), true, 'an AMD or Intel PC gets the picture runner for its card from the page');
  assert.equal(pageDownloads({ engine: 'llama', device: 'cuda' }), true);
  assert.equal(pageDownloads({ engine: 'llama', device: 'cpu' }), false);
  assert.equal(pageDownloads(undefined), false);
});

const PINS = JSON.parse(readFileSync(new URL('../runtimes.json', import.meta.url), 'utf8')).runtimes;
const P100 = { name: 'Tesla P100-PCIE-16GB', vendor: 'nvidia', integrated: false, total: 16 * 2 ** 30, cc: 60, tcc: true, smiIndex: 1 };

// 26 Oct: a data-centre card (Tesla P40, P100, T4) often runs in TCC mode on Windows: CUDA uses it, but the Vulkan
// runner and Windows' own graphics readings cannot see it. Said, with the way to change it, only when it matters.
test('a card in compute-only (TCC) mode is named, with the command that changes it, when a runner other than CUDA would run', () => {
  const t = tccNote([P100], false, 'pictures');
  assert.match(t, /Tesla P100-PCIE-16GB is in compute-only mode \(TCC\)/);
  assert.match(t, /nvidia-smi -i 1 -dm WDDM/);
  assert.match(t, /pictures/);
  assert.equal(tccNote([P100], true, 'chat'), '', 'CUDA runs on it: nothing to say');
  assert.equal(tccNote([{ ...P100, tcc: false }], false, 'pictures'), '');
  assert.equal(tccNote([], false, 'chat'), '');
});

test('the first start on a card the CUDA build has no code made for says it compiles once', () => {
  const P40 = { name: 'Tesla P40', vendor: 'nvidia', integrated: false, total: 24 * 2 ** 30, cc: 61 };
  assert.match(firstStartNote(PINS['llama-cuda'], [P40]), /first start on the Tesla P40 compiles .* once/);
  assert.equal(firstStartNote(PINS['llama-cuda'], [{ ...P40, name: 'NVIDIA GeForce RTX 3060', cc: 86 }]), '', 'code made for it');
  assert.equal(firstStartNote(PINS['llama-cpu'], [P40]), '');
  assert.equal(firstStartNote(PINS['llama-cuda'], [{ ...P40, cc: null }]), '', 'not known: not said');
});
