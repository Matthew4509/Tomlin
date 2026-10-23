// A card start that put the model on the CPU (src/runnerpush.ts noCardStart) counts as failed in a real pane: a
// stand-in runner (a Node script) writes the lines a CUDA build wrote at log level 4 on a laptop with no NVIDIA card,
// then answers; the pane ends it, starts the next device and says why. A start that used its card connects as before.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pane } from '../src/pane.ts';
import { noCardStart } from '../src/runnerpush.ts';
import type { Device } from '../src/runtimes.ts';

const dir = mkdtempSync(join(tmpdir(), 'tomlin-nocard-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = join(dir, 'runner.mjs');
writeFileSync(script, [
  "import { createServer } from 'node:http';",
  'const [port, kind] = process.argv.slice(2);',
  "const card = ['0.02.061.113 I llama_prepare_model_devices: using device Vulkan0 (Intel(R) HD Graphics 520) (unknown id) - 7385 MiB free'];",
  "const lines = [...(kind === 'card' ? card : []), '0.02.651.077 I load_tensors: offloaded 25/25 layers to GPU'];",
  "// 'split': the card line comes in two pieces (a busy pipe cuts lines anywhere).",
  "if (kind === 'split') { process.stderr.write(card[0].slice(0, 50)); await new Promise(r => setTimeout(r, 100)); process.stderr.write(card[0].slice(50) + '\\n'); }",
  "for (const l of lines) process.stderr.write(l + '\\n');",
  "createServer((req, res) => res.end('{}')).listen(Number(port), '127.0.0.1');",
].join('\n'));

const spec = (device: Device, kind: 'cpu' | 'card' | 'split') => ({
  exe: process.execPath,
  args: (port: number) => [script, String(port), kind],
  ready: async (port: number) => (await fetch(`http://127.0.0.1:${port}/`)).ok,
  device,
  timeoutSeconds: 30,
});
const ask = (devices: Device[], kind: (d: Device) => 'cpu' | 'card' | 'split') => ({
  model: 'm', modelName: 'M', asked: 'auto' as const, threads: 0, devices, expectedSeconds: 1,
  build: (d: Device) => spec(d, kind(d)),
  why: () => 'It did not load.',
  started: (d: Device, facts: string[]) => noCardStart(d, facts),
});

test('a CUDA start that loaded the model on the CPU is ended, Vulkan is started, and the note says why', async () => {
  const pane = new Pane('chat');
  const view = await pane.connect(ask(['cuda', 'vulkan'], d => (d === 'cuda' ? 'cpu' : 'card')));
  try {
    assert.equal(view.state, 'connected');
    assert.equal(view.device, 'vulkan');
    assert.equal(view.note, 'The NVIDIA card (CUDA) could not run it (the CUDA runner found no card it can use on this PC and loaded the model on the CPU), so it runs on the graphics chip (Vulkan).');
  } finally {
    await pane.disconnect();
  }
});

test('the last card runner left loaded on the CPU: the start fails, saying so; one that used its card connects', async () => {
  const pane = new Pane('chat');
  const failed = await pane.connect(ask(['vulkan'], () => 'cpu'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'The Vulkan runner found no card it can use on this PC and loaded the model on the CPU.');
  assert.equal(failed.pid, null);
  const fine = await pane.connect(ask(['vulkan'], () => 'card'));
  try {
    assert.equal(fine.state, 'connected');
    assert.equal(fine.note, null);
  } finally {
    await pane.disconnect();
  }
});

test('a card line that comes in two pieces is read whole: a start that used its card is not taken for one on the CPU', async () => {
  const pane = new Pane('chat');
  const view = await pane.connect(ask(['vulkan'], () => 'split'));
  try {
    assert.equal(view.state, 'connected', view.error ?? '');
    assert.equal(view.note, null);
  } finally {
    await pane.disconnect();
  }
});

test('whole lines from pieces: a cut line waits for its end, a carriage return ends a line, the rest comes at the end', async () => {
  const { lineSplitter } = await import('../src/worker.ts');
  const s = lineSplitter();
  assert.deepEqual(s('using dev'), []);
  assert.deepEqual(s('ice CUDA0 (RTX)\nloading 10%\rloading 20%\r'), ['using device CUDA0 (RTX)', 'loading 10%', 'loading 20%']);
  assert.deepEqual(s('\nlast'), []);
  assert.deepEqual(s.rest(), ['last']);
  assert.deepEqual(s.rest(), []);
  // The picture runner draws its bar after a carriage return with no line end: a bar ending in its rate is whole.
  assert.deepEqual(s('\r  |=====>      | 3/20 - 1.20s/it'), ['  |=====>      | 3/20 - 1.20s/it']);
  assert.deepEqual(s('\r  |======>     | 4/20 - 2.5it/s'), ['  |======>     | 4/20 - 2.5it/s']);
  // A part with no line end that grows past 4,000 characters is let go as it is.
  assert.equal(s('x'.repeat(4500)).length, 1);
});
