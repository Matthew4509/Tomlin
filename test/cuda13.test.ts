// The two CUDA builds of the chat runner (12.4 and 13.4): which one suits a card, why a PC cannot use one, the order
// Auto tries them in, a model held to one, what a node says about each, and the speed finder's runner rows. The code
// levels in runtimes.json were read from each build's ggml-cuda.dll.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccFromName, ccNumber, codeFor, cudaOrder, pinKey, pinWhy, PIN_FILE, Runtimes, runnerOfPin, RUNNER_PINS, type GpuFacts, type RuntimePin } from '../src/runtimes.ts';
import * as rp from '../src/runnerpush.ts';
import { cleanRunWith, devicesForRun } from '../src/runset.ts';
import * as sf from '../src/speedfinder.ts';

const ROOT = join(import.meta.dirname, '..');
const PINS = (JSON.parse(readFileSync(join(ROOT, 'runtimes.json'), 'utf8')) as { runtimes: Record<string, RuntimePin> }).runtimes;
const C12 = PINS['llama-cuda'];
const C13 = PINS['llama-cuda13'];
const ALL = Object.values(PINS);

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const nv = (name: string, cc: number | null, total = 8 * 2 ** 30): GpuFacts => ({ name, vendor: 'nvidia', integrated: false, total, cc });
const GTX1060 = nv('NVIDIA GeForce GTX 1060 6GB', 61, 6 * 2 ** 30);
const RTX2060 = nv('NVIDIA GeForce RTX 2060', 75, 6 * 2 ** 30);
const RTX4090 = nv('NVIDIA GeForce RTX 4090', 89, 24 * 2 ** 30);
const RTX5080 = nv('NVIDIA GeForce RTX 5080', 120, 16 * 2 ** 30);

test('the pins carry the code measured in each build, and both are the same llama.cpp release', () => {
  assert.deepEqual(C12.cuda, { version: '12.4', native: [86, 89], ptx: [50, 61, 70, 75, 80, 90], driver: '551.61' });
  assert.deepEqual(C13.cuda, { version: '13.4', native: [86, 89, 120, 121], ptx: [75, 80, 90], driver: '580', jitDriver: '615' });
  assert.equal(C13.engine, 'llama');
  assert.equal(C13.device, 'cuda');
  assert.ok(C13.parts.every(p => p.url.includes('/b11284/') && /^[0-9a-f]{64}$/.test(p.sha256) && p.bytes > 1e8));
  assert.deepEqual(C13.parts.map(p => p.sha256), ['561237327bccd555d435ee51e96072b8e5495b807f5b536b96ae234484920604', '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668']);
  assert.ok(C12.parts.every(p => p.url.includes('/b11284/')));
});

test('a card\'s sm level from nvidia-smi, else from its name; Ada and Quadro RTX names are not taken for RTX 50 or 40', () => {
  assert.equal(ccNumber('6.1'), 61);
  assert.equal(ccNumber(' 12.0 '), 120);
  assert.equal(ccNumber('[N/A]'), null);
  assert.equal(ccNumber(undefined), null);
  assert.equal(ccFromName('NVIDIA GeForce RTX 5080'), 120);
  assert.equal(ccFromName('NVIDIA GeForce RTX 5060 Ti'), 120);
  assert.equal(ccFromName('NVIDIA RTX PRO 6000 Blackwell Workstation Edition'), 120);
  assert.equal(ccFromName('NVIDIA GeForce RTX 4090'), 89);
  assert.equal(ccFromName('NVIDIA RTX 5000 Ada Generation'), 89);
  assert.equal(ccFromName('Quadro RTX 5000'), 75);
  assert.equal(ccFromName('Quadro RTX 4000'), 75);
  assert.equal(ccFromName('NVIDIA GeForce RTX 3060'), 86);
  assert.equal(ccFromName('NVIDIA RTX A4000'), 86);
  assert.equal(ccFromName('NVIDIA GeForce GTX 1660 SUPER'), 75);
  assert.equal(ccFromName('NVIDIA GeForce GTX 1060 6GB'), 61);
  assert.equal(ccFromName('NVIDIA Quadro P2000'), 61);
  assert.equal(ccFromName('NVIDIA GeForce GTX 970'), 50);
  assert.equal(ccFromName('Intel(R) HD Graphics 520'), null);
  assert.equal(ccFromName('NVIDIA GeForce GT 730'), null);
});

test('how each build runs on a card: code made for it, compiled at the first start, or none', () => {
  assert.equal(codeFor(C12, 61), 'jit');
  assert.equal(codeFor(C12, 75), 'jit');
  assert.equal(codeFor(C12, 86), 'native');
  assert.equal(codeFor(C12, 89), 'native');
  assert.equal(codeFor(C12, 87), 'native');
  assert.equal(codeFor(C12, 120), 'jit');
  assert.equal(codeFor(C12, 37), 'none');
  assert.equal(codeFor(C13, 61), 'none');
  assert.equal(codeFor(C13, 70), 'none');
  assert.equal(codeFor(C13, 75), 'jit');
  assert.equal(codeFor(C13, 89), 'native');
  assert.equal(codeFor(C13, 120), 'native');
  assert.equal(codeFor(C13, 121), 'native');
  assert.equal(codeFor(C13, null), 'unknown');
  assert.equal(codeFor(PINS['sd-cuda'], 61), 'unknown');
});

test('why a PC cannot use a build: no NVIDIA card, a card it has no code for (naming the one that works), a driver too old for its code', () => {
  assert.equal(pinWhy(C12, [GTX1060], '581.57'), '');
  assert.equal(pinWhy(C13, [RTX5080], '581.57'), '');
  assert.equal(pinWhy(C12, [RTX5080], '581.57'), '');
  assert.match(pinWhy(C13, [GTX1060], '581.57', 'Worker PC', ALL), /^"Worker PC" has NVIDIA GeForce GTX 1060 6GB, and the CUDA 13\.4 runner has no code for it: it needs an RTX 20 or GTX 16 series \(Turing\) card or newer\. The CUDA 12\.4 runner works there instead\.$/);
  assert.match(pinWhy(C13, [RTX5080], '576.02', 'Gaming PC'), /^"Gaming PC" has NVIDIA driver 576\.02; the CUDA 13\.4 runner needs 580 or newer there\. Update the driver/);
  // Code compiled at the first start needs the driver that knows CUDA 13.4's PTX.
  assert.match(pinWhy(C13, [RTX2060], '581.57'), /needs 615 or newer/);
  assert.equal(pinWhy(C13, [RTX2060], '615.10'), '');
  assert.match(pinWhy(C12, [GTX1060], '536.23', 'Worker PC'), /^"Worker PC" has NVIDIA driver 536\.23; the CUDA 12\.4 runner needs 551\.61 or newer there\./);
  assert.match(pinWhy(C13, [{ name: 'AMD Radeon RX 580', vendor: 'amd', integrated: false }], null), /no NVIDIA card of its own/);
  // A driver that could not be read is not held against it.
  assert.equal(pinWhy(C13, [RTX5080], null), '');
  // A card whose level is not known: usable, but only with the driver that can compile the build's PTX.
  assert.match(pinWhy(C13, [nv('NVIDIA Mystery 9000', null)], '581.57'), /needs 615 or newer/);
  // A pin with no code list (the picture runner) keeps the CUDA 12 rule.
  assert.equal(pinWhy(PINS['sd-cuda'], [GTX1060], '581.57'), '');
  assert.match(pinWhy(PINS['sd-cuda'], [GTX1060], '536.23'), /needs 551\.61 or newer/);
});

test('the order Auto tries the CUDA builds in: code made for the biggest card first, then the older build; one a PC cannot use is left out', () => {
  assert.deepEqual(cudaOrder(PINS, 'llama', [RTX5080], '581.57'), ['llama-cuda13', 'llama-cuda']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [RTX4090], '581.57'), ['llama-cuda', 'llama-cuda13']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [GTX1060], '581.57'), ['llama-cuda']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [RTX2060], '581.57'), ['llama-cuda']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [RTX2060], '615.10'), ['llama-cuda', 'llama-cuda13']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [RTX5080], '576.02'), ['llama-cuda']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [], null), []);
  // An old and a new card: the build with code for both first (CUDA 13 has none for the GTX 1060), the other kept
  // for the speed finder to try.
  assert.deepEqual(cudaOrder(PINS, 'llama', [GTX1060, RTX5080], '581.57'), ['llama-cuda', 'llama-cuda13']);
  assert.deepEqual(cudaOrder(PINS, 'sd', [GTX1060], '581.57'), ['sd-cuda']);
});

/** A home runtime folder with these builds unpacked (a stand-in llama-server.exe and the pin it came from). */
function homeWith(ids: string[]): Runtimes {
  const root = mkdtempSync(join(tmpdir(), 'tomlin-cuda13-'));
  made.push(root);
  const kept = join(root, 'home-runtime');
  for (const id of ids) {
    mkdirSync(join(kept, id), { recursive: true });
    writeFileSync(join(kept, id, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '');
    writeFileSync(join(kept, id, PIN_FILE), pinKey(PINS[id]));
  }
  return new Runtimes(join(root, 'app-runtime'), join(ROOT, 'runtimes.json'), kept);
}

test('the build that runs a device follows the PC\'s order and what is unpacked; each build is found, sized and removed by its own id', async () => {
  const both = homeWith(['llama-cuda', 'llama-cuda13']);
  both.order = (engine, device) => (device === 'cuda' ? cudaOrder(both.pins, engine, [RTX5080], '581.57') : both.idsOf(engine, device));
  assert.equal(both.id('llama', 'cuda'), 'llama-cuda13');
  assert.ok(both.exe('llama', 'cuda')!.includes('llama-cuda13'));
  assert.ok(both.usable('llama', 'cuda'));
  assert.equal(both.bytesPin('llama-cuda13'), C13.parts.reduce((n, p) => n + p.bytes, 0));
  assert.ok(both.zipOfPin('llama-cuda13', 0).endsWith('llama-b11284-bin-win-cuda-13.4-x64.zip'));
  // On a Pascal PC the CUDA 13 build is never picked, even when it is the one unpacked.
  const only13 = homeWith(['llama-cuda13']);
  only13.order = (engine, device) => (device === 'cuda' ? cudaOrder(only13.pins, engine, [GTX1060], '581.57') : only13.idsOf(engine, device));
  assert.equal(only13.id('llama', 'cuda'), 'llama-cuda');
  assert.equal(only13.usable('llama', 'cuda'), false);
  assert.equal(only13.installed('llama', 'cuda'), false);
  // Removing one build leaves the other.
  await both.removePin('llama-cuda13');
  assert.equal(both.installedPin('llama-cuda13'), false);
  assert.ok(both.installedPin('llama-cuda'));
  assert.equal(both.id('llama', 'cuda'), 'llama-cuda');
  // Without an order set: every pin of that kind, in the file's order.
  assert.deepEqual(homeWith([]).order('llama', 'cuda'), ['llama-cuda', 'llama-cuda13']);
});

test('a model held to a build: kept only as CUDA 12, CUDA 13 or Vulkan, each naming its own build and device', () => {
  const list = [{ id: 'chat/A.gguf', name: 'A', bytes: 1e9 }];
  assert.equal(cleanRunWith({ runner: 'cuda13' }, 'chat/A.gguf', list, [8192]).runner, 'cuda13');
  assert.equal(cleanRunWith({ runner: 'cuda12' }, 'chat/A.gguf', list, [8192]).runner, undefined);
  assert.deepEqual(RUNNER_PINS, { cuda: 'llama-cuda', cuda13: 'llama-cuda13', vulkan: 'llama-vulkan' });
  assert.equal(runnerOfPin('llama-cuda13'), 'cuda13');
  assert.equal(runnerOfPin('llama-cpu'), '');
  // Held to CUDA 13: it starts on the CUDA device only.
  assert.deepEqual(devicesForRun(['cuda', 'vulkan', 'cpu'], 'cuda'), ['cuda']);
});

/** Lines a runner wrote at log level 4, measured on a laptop with no NVIDIA card (CUDA 12.4 build) and its Intel chip (Vulkan). */
const CPU_LINES = ['0.02.651.077 I load_tensors: offloaded 25/25 layers to GPU'];
const VULKAN_LINES = ['0.02.061.113 I llama_prepare_model_devices: using device Vulkan0 (Intel(R) HD Graphics 520) (unknown id) - 7385 MiB free', 'I load_tensors: offloaded 25/25 layers to GPU'];

test('a card start that put the model on the CPU counts as failed; one that used its card, or said nothing, does not', () => {
  assert.equal(rp.startFact(CPU_LINES[0]), true);
  assert.equal(rp.startFact(VULKAN_LINES[0]), true);
  assert.equal(rp.noCardStart('cuda', CPU_LINES), 'the CUDA runner found no card it can use on this PC and loaded the model on the CPU');
  assert.equal(rp.noCardStart('vulkan', CPU_LINES), 'the Vulkan runner found no card it can use on this PC and loaded the model on the CPU');
  assert.equal(rp.noCardStart('vulkan', VULKAN_LINES), '');
  assert.equal(rp.noCardStart('cuda', ['I llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce GTX 1060 6GB) (0000:01:00.0) - 5123 MiB free', ...CPU_LINES]), '');
  // The Vulkan card's line does not vouch for a CUDA start.
  assert.notEqual(rp.noCardStart('cuda', VULKAN_LINES), '');
  assert.equal(rp.noCardStart('cpu', CPU_LINES), '');
  assert.equal(rp.noCardStart('cuda', []), '');
});

test('a node says how each CUDA build is there and which suits its card; a host reads it back clean, and an older node is asked to update', () => {
  const h = rp.cleanRunner({ nvidia: true, driver: '581.57', why: '', cuda: 'installed', pins: { 'llama-cuda': { state: 'installed', why: '' }, 'llama-cuda13': { state: 'none', why: 'x'.repeat(500) }, 'evil/../x': { state: 'installed' } }, best: 'llama-cuda13', said: '', last: null });
  assert.deepEqual(Object.keys(h!.pins!), ['llama-cuda', 'llama-cuda13']);
  assert.equal(h!.pins!['llama-cuda13'].why.length, 300);
  assert.equal(h!.best, 'llama-cuda13');
  assert.equal(rp.cleanRunner({ nvidia: true, driver: null, why: '', cuda: 'none', pins: { 'llama-cuda': { state: 'none', why: '' } }, best: 'llama-cuda13', said: '', last: null })!.best, undefined);
  const pc = (runner: rp.RunnerHello | null): rp.RunnerPc => ({ name: 'Worker PC', ok: true, away: null, can: ['carry', 'runner'], backupsOnly: false, runner });
  const now = { nvidia: true, driver: '581.57', why: '', cuda: 'installed' as const, pins: { 'llama-cuda': { state: 'installed' as const, why: '' }, 'llama-cuda13': { state: 'none' as const, why: '' } }, said: '', last: null };
  assert.match(rp.sendRunnerWhy(pc(now), 'llama-cuda'), /already has it/);
  assert.equal(rp.sendRunnerWhy(pc(now), 'llama-cuda13'), '');
  const pascal = { ...now, pins: { ...now.pins, 'llama-cuda13': { state: 'none' as const, why: '"Worker PC" has NVIDIA GeForce GTX 1060 6GB, and the CUDA 13.4 runner has no code for it.' } } };
  assert.match(rp.sendRunnerWhy(pc(pascal), 'llama-cuda13'), /no code for it/);
  // An older TOMLIN knows its CUDA 12.4 build only.
  const old = { nvidia: true, driver: '581.57', why: '', cuda: 'none' as const, said: '', last: null };
  assert.equal(rp.sendRunnerWhy(pc(old), 'llama-cuda'), '');
  assert.match(rp.sendRunnerWhy(pc(old), 'llama-cuda13'), /older TOMLIN that does not know this runner: update it first/);
});

const facts = (runners: sf.PcFacts['runners']): sf.PcFacts => ({ cards: [{ name: 'RTX 5080', total: 16 * 2 ** 30, free: 15 * 2 ** 30 }], cores: 16, threads: 0, models: [], runners });
const model: sf.ModelFacts = { id: 'chat/Q.gguf', name: 'Qwen3.5-9B-Q4_K_M', bytes: 5.6e9, moe: false, layers: 32, expertsPerLayer: 0, rest: 5.6e9, ctxBytes: 0.5e9, guesser: null };
const BASE = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const };

test('the speed finder tries each other card runner against the one in use, first; the faster is recommended as for any row', () => {
  const now = { run: BASE, spilled: false, cardBytes: 6e9 };
  const q = sf.setupsFor(facts(['cuda13', 'cuda', 'vulkan']), model, now, 'quick');
  assert.deepEqual(q.rows.slice(1, 3).map(r => r.id), ['runner-cuda', 'runner-vulkan']);
  assert.equal(q.rows[1].name, 'CUDA 12 runner (instead of CUDA 13)');
  assert.deepEqual(q.rows[1].run, { ...BASE, runner: 'cuda' });
  assert.match(q.rows[1].why, /Two CUDA builds/);
  assert.equal(q.rows[2].name, 'Vulkan runner (instead of CUDA 13)');
  // Held to Vulkan: both CUDA builds are tried.
  const v = sf.setupsFor(facts(['cuda13', 'cuda', 'vulkan']), model, { ...now, run: { ...BASE, runner: 'vulkan' } }, 'quick');
  assert.deepEqual(v.rows.slice(1, 3).map(r => r.id), ['runner-cuda13', 'runner-cuda']);
  assert.match(sf.describeRun({ ...BASE, runner: 'cuda13' }), /CUDA 13 runner/);
  // A saved runner no longer here: the one Auto tries first is the one in use.
  const gone = sf.setupsFor(facts(['cuda', 'vulkan']), model, { ...now, run: { ...BASE, runner: 'cuda13' } }, 'quick');
  assert.deepEqual(gone.rows.slice(1, 2).map(r => r.id), ['runner-vulkan']);
  // One runner, or none: no runner rows.
  assert.ok(!sf.setupsFor(facts(['cuda13']), model, now, 'full').rows.some(r => r.id.startsWith('runner-')));
  // The CUDA 13 row winning by more than 5% is the one recommended.
  const rec = sf.recommend([
    { id: 'a', ok: true, write: 40, read: 900, cardFree: 8e9, spilled: false, ramFit: 'ok', sameWords: null, cache: 'f16', changes: 0 },
    { id: 'runner-cuda13', ok: true, write: 52, read: 1100, cardFree: 8e9, spilled: false, ramFit: 'ok', sameWords: null, cache: 'f16', changes: 1 },
  ]);
  assert.equal(rec.best, 'runner-cuda13');
});
