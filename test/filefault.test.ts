// A model file the runner cannot read (an unknown quant type such as TQ3_0 from another llama.cpp fork, or a damaged
// file) fails the same way on every device: the pane stops at the first such fault instead of reading the file again on
// Vulkan and the CPU, and says what is wrong in plain words (not "damaged" for a whole file of an unknown type). The
// failed load's note is drawn once under the fault, however often the status is asked (public/app.js showFault).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pane } from '../src/pane.ts';
import { fileFault, quantOfName, whyItFailed } from '../src/llama.ts';
import type { Device } from '../src/runtimes.ts';

// The lines llama.cpp b11284 (the shipped runner) wrote on 20 Nov 2026 for a GGUF file whose tensor has a type id it
// does not know (a made-up file with type 45), trimmed of the file path.
const UNKNOWN_TYPE_TAIL = [
  "0.00.050.410 E gguf_init_from_reader: tensor 'token_embd.weight' has invalid ggml type 45. should be in [0, 43)",
  '0.00.050.413 E gguf_init_from_reader: failed to read tensor info',
  '0.00.050.443 E llama_model_load: error loading model: llama_model_loader: failed to load model from model.gguf',
  '0.00.050.447 E llama_model_load_from_file_impl: failed to load model',
  '0.00.050.932 E srv  llama_server: exiting due to model loading error',
].join('\n');
const DAMAGED_TAIL = 'gguf_init_from_file_impl: invalid magic characters: GGUX\nllama_model_load: error loading model';
const NAME = 'Qwen3.8-Flash-Next-Gyro-L-abliterated-TQ3_0.gguf';

test('an unknown quant type is said as one the runner cannot read, not as a damaged file', () => {
  const why = whyItFailed(UNKNOWN_TYPE_TAIL, NAME);
  assert.match(why, /cannot read the way this file is packed \(TQ3_0\)/);
  assert.match(why, /The file is not damaged/);
  assert.doesNotMatch(why, /incomplete or damaged/);
  // Without a name, the type number the runner gave.
  assert.match(whyItFailed(UNKNOWN_TYPE_TAIL), /\(type 45\)/);
  // A type the runner lists but no longer runs (block size 0).
  assert.match(whyItFailed("gguf_init_from_reader: tensor 'blk.0.ffn_up.weight' of type 31 (q4_0_4_4) has 4096 elements per row, not a multiple of block size (0)\ngguf_init_from_reader: failed to read tensor info"), /cannot read the way this file is packed/);
  // A truly damaged file is still said as damaged.
  assert.match(whyItFailed(DAMAGED_TAIL, NAME), /incomplete or damaged/);
});

test('the quant type is read from the file name', () => {
  assert.equal(quantOfName(NAME), 'TQ3_0');
  assert.equal(quantOfName('models/Qwen3.6-35B-A3B-UD-Q4_K_S.gguf'), 'UD-Q4_K_S');
  assert.equal(quantOfName('gemma-2-2b-it-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOfName('Big-IQ1_S.gguf'), 'IQ1_S');
  assert.equal(quantOfName('no-quant-here.gguf'), '');
});

test('a file fault is told apart from a fault of the runner or the device', () => {
  assert.equal(fileFault(UNKNOWN_TYPE_TAIL), true);
  assert.equal(fileFault(DAMAGED_TAIL), true);
  assert.equal(fileFault("error loading model architecture: unknown model architecture: 'qwen9'"), true);
  assert.equal(fileFault('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory'), false);
  assert.equal(fileFault('ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected'), false);
  assert.equal(fileFault(''), false);
});

// ---- In a real pane: a stand-in runner that writes the given lines and ends, as llama-server does on a bad file ----

const dir = mkdtempSync(join(tmpdir(), 'tomlin-filefault-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = join(dir, 'runner.mjs');
writeFileSync(script, "process.stderr.write(Buffer.from(process.argv[2], 'base64').toString() + '\\n'); setTimeout(() => process.exit(1), 50);\n");

function ask(tail: (d: Device) => string, started: Device[]) {
  return {
    model: NAME, modelName: 'Qwen3.8-Flash-Next-Gyro-L-abliterated-TQ3_0', asked: 'auto' as const, threads: 0,
    devices: ['cuda', 'vulkan', 'cpu'] as Device[], expectedSeconds: 1,
    build: (device: Device) => {
      started.push(device);
      return { exe: process.execPath, args: () => [script, Buffer.from(tail(device)).toString('base64')], ready: async () => false, device, timeoutSeconds: 30 };
    },
    why: (t: string) => whyItFailed(t, NAME),
    fileFault,
    note: 'Context 32,768 tokens.',
  };
}

test('a file the runner cannot read stops at the first device: no Vulkan and CPU tries, one plain reason', async () => {
  const pane = new Pane('chat');
  const started: Device[] = [];
  const view = await pane.connect(ask(() => UNKNOWN_TYPE_TAIL, started));
  assert.deepEqual(started, ['cuda']);
  assert.equal(view.state, 'failed');
  assert.match(view.error ?? '', /cannot read the way this file is packed \(TQ3_0\)/);
  // The note says only what was set: no "CUDA could not run it ..., so it runs on Vulkan" for a fall-back never tried.
  assert.equal(view.note, 'Context 32,768 tokens.');
});

test('a fault of the device itself still falls back to the next device, as before', async () => {
  const pane = new Pane('chat');
  const started: Device[] = [];
  const view = await pane.connect(ask(d => (d === 'cpu' ? UNKNOWN_TYPE_TAIL : 'ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected'), started));
  assert.deepEqual(started, ['cuda', 'vulkan', 'cpu']);
  assert.equal(view.state, 'failed');
  assert.match(view.note ?? '', /could not run it/);
});

// ---- The page: a failed load's note under the fault, drawn once however often the status is asked ----

test('the failed load note is drawn once, not added again on each status poll', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const src = /function showFault\(box, text, detail, note\) \{[\s\S]*?\n\}/.exec(app)?.[0];
  assert.ok(src, 'showFault takes the note');
  // Nothing appends the pane's note to its fault box outside showFault.
  assert.doesNotMatch(app, /p\.fault\.append\(/);
  type Node = { text?: string; kids: Node[] };
  const make = (_tag: string, o: { text?: string } = {}, ...kids: Node[]): Node => ({ text: o.text, kids });
  const box = { hidden: true, dataset: { sig: '' } as Record<string, string>, kids: [] as Node[], replaceChildren(...k: Node[]) { this.kids = k; }, append(...k: Node[]) { this.kids.push(...k); } };
  const showFault = new Function('el', `${src}; return showFault;`)(make) as (b: typeof box, t: string | null, d?: string | null, n?: string | null) => void;
  const note = 'Context 32,768 tokens. Auto: llama.cpp fills the graphics card and puts what does not fit in RAM.';
  for (let i = 0; i < 17; i++) showFault(box, 'This model did not load.', 'runner lines', note);
  assert.equal(box.kids.filter(k => k.text === note).length, 1);
  showFault(box, null);
  assert.equal(box.kids.length, 0);
});

test('a new chat\'s answer is found by its id once the server gives it, so opening the chat does not follow it twice', () => {
  const view = readFileSync(new URL('../public/chatview.js', import.meta.url), 'utf8');
  const line = /const streamOf = [^\n]+/.exec(view)?.[0];
  assert.ok(line, 'streamOf is there');
  assert.match(view, /function followAnswer\(chatId\) \{[\s\S]{0,200}if \(!chatId \|\| streamOf\(chatId\)\) return;/);
  const streams = new Map<string, { liveId?: string }>([['new:staff:qwen', { liveId: 'caa35ebc1d67' }]]);
  const streamOf = new Function('streams', `${line}; return streamOf;`)(streams) as (id: string) => unknown;
  assert.equal(streamOf('caa35ebc1d67'), streams.get('new:staff:qwen'));
  assert.equal(streamOf('another0chat'), undefined);
  assert.equal(streamOf(''), undefined);
});
