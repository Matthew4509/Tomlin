// Runner faults and the run history (src/faults.ts), and the crash notice's page parts (public/crash.js, chatview.js).
// Nothing starts a runner or TOMLIN: the record, its words, what is kept across a restart, and what crosses the link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanDetail, cleanFault, faultWords, KEEP_FAULTS, makeFault, modelFileGone, noticeTitle, RunHistory, tryOptions, type TryOption } from '../src/faults.ts';

const ROOT = join(import.meta.dirname, '..');
const CUDA_TAIL = 'load_tensors: offloaded 41/41 layers to GPU\nCUDA error: an illegal memory access was encountered\n  current device: 0, in function launch_mul_mat_q at ggml-cuda/mmq.cuh:3884';

test('an illegal memory access is said in plain words, naming the runner build and the model', () => {
  const w = faultWords(CUDA_TAIL, { device: 'cuda', runnerName: 'llama.cpp b11284, CUDA 12.4 (NVIDIA, older cards too)', kind: 'crash', modelName: 'Qwen3.5-35B-A3B' });
  assert.match(w, /^the CUDA runner \(llama\.cpp b11284\) crashed while Qwen3\.5-35B-A3B was loaded/);
  assert.match(w, /illegal memory access/);
  assert.match(w, /another runner version, or Vulkan/);
});

test('other faults: memory on the card, a lost Vulkan device, a load, and a runner that says nothing', () => {
  const o = { device: 'cuda' as const, runnerName: 'llama.cpp b11284, CUDA 12.4', kind: 'crash' as const, modelName: 'M' };
  assert.match(faultWords('CUDA error: out of memory', o), /ran out of memory on the NVIDIA card/);
  assert.match(faultWords('ggml_vulkan: vk::DeviceLostError: vk::Device::waitForFences: ErrorDeviceLost', { ...o, device: 'vulkan' }), /lost the graphics chip/);
  assert.match(faultWords('something odd', { ...o, kind: 'load' }), /could not load M on the NVIDIA card/);
  assert.match(faultWords('', o), /stopped on its own while M was loaded, without saying why/);
});

test('the notice names the PC; a runner\'s lines that carry a prompt are left out', () => {
  assert.equal(noticeTitle({ pc: 'Z820' }), 'An error has occurred with "Z820"');
  const d = cleanDetail('slot 0: prompt processing progress, n_past = 10\nuser: my secret question\nCUDA error: an illegal memory access was encountered');
  assert.doesNotMatch(d, /prompt|secret/);
  assert.match(d, /illegal memory access/);
});

test('a fault from a linked PC is checked field by field: unknown runner ids, devices and stray fields go', () => {
  const f = makeFault({ pc: 'Z820', model: 'qwen.gguf', modelName: 'Qwen', runner: 'llama-cuda', runnerName: 'llama.cpp b11284, CUDA 12.4', device: 'cuda', kind: 'crash', tail: CUDA_TAIL });
  const raw = { ...f, runner: '..\\..\\evil.exe', device: 'rocm', extra: 'x', tries: [{ pin: 'llama-vulkan', name: 'Vulkan', device: 'vulkan', build: 'b11284', kind: 'type', installed: true, bytes: 1, why: '' }, { pin: 'C:\\x', device: 'cuda' }], history: [{ runner: 'llama-cuda', ok: 3, failed: 1, lastOk: f.at, lastFailed: f.at, lastFault: 'x', write: 26.13 }] };
  const c = cleanFault(JSON.parse(JSON.stringify(raw)))!;
  assert.equal(c.runner, '');
  assert.equal(c.device, '');
  assert.equal((c as unknown as Record<string, unknown>).extra, undefined);
  assert.equal(c.tries!.length, 1);
  assert.equal(c.history![0].write, 26.1);
  assert.equal(cleanFault({ at: 'never', fault: 'x' }), null);
  assert.equal(cleanFault('a string'), null);
});

test('the run history counts whole answers and crashes per PC, model and runner, and keeps them across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-faults-'));
  try {
    const file = join(dir, 'run-history.json');
    const h = await new RunHistory(file).load();
    h.success('Z820', 'qwen', 'llama-vulkan', 26.1);
    h.success('Z820', 'qwen', 'llama-vulkan', 25.9);
    h.success('Z820', 'qwen', 'llama-cuda', 40, new Date(Date.now() - 60_000).toISOString());
    const f = makeFault({ pc: 'Z820', model: 'qwen', modelName: 'Qwen', runner: 'llama-cuda', runnerName: 'llama.cpp b11284, CUDA 12.4', device: 'cuda', kind: 'crash', tail: CUDA_TAIL });
    await h.failure(f);
    // The same fault told twice (the runner's exit and the chat that saw it) is kept once.
    await h.failure(f);
    const again = await new RunHistory(file).load();
    const rows = again.rows('Z820', 'qwen');
    assert.deepEqual(rows.map(r => [r.runner, r.ok, r.failed]), [['llama-vulkan', 2, 0], ['llama-cuda', 1, 1]]);
    assert.equal(rows[0].write, 25.9);
    assert.match(rows[1].lastFault, /illegal memory access/);
    assert.equal(again.find(f.id)?.model, 'qwen');
    assert.equal(again.recent({ model: 'qwen', pc: 'Z820' }).length, 1);
    assert.equal(again.recent({ pc: 'This PC' }).length, 0);
    // A runner whose last word was a crash is shaky with this model; one that has worked since is not.
    assert.deepEqual([...again.shaky('Z820', 'qwen')], ['llama-cuda']);
    again.success('Z820', 'qwen', 'llama-cuda', 40, new Date(Date.now() + 1000).toISOString());
    assert.deepEqual([...again.shaky('Z820', 'qwen')], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest faults are kept for one runner, and a damaged file starts empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-faults-'));
  try {
    const file = join(dir, 'run-history.json');
    const h = await new RunHistory(file).load();
    for (let i = 0; i < KEEP_FAULTS + 5; i++) await h.failure(makeFault({ pc: 'P', model: 'm', modelName: 'm', runner: 'llama-cuda', runnerName: '', device: 'cuda', kind: 'crash', tail: '', at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    assert.equal(h.rows('P', 'm')[0].failed, KEEP_FAULTS);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{"entries": {"x": {"pc": 1}, "y": "no"}}');
    assert.deepEqual((await new RunHistory(file).load()).recent(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what to try after a CUDA crash: another CUDA version first, then Vulkan, then the CPU; the one that failed is not offered', () => {
  const pin = (p: string, device: TryOption['device'], o: Partial<TryOption> = {}) => ({ pin: p, name: p, device, build: 'b1', installed: true, bytes: 0, why: '', ...o });
  const pins = [pin('llama-cpu', 'cpu'), pin('llama-vulkan', 'vulkan'), pin('llama-cuda', 'cuda'), pin('llama-cuda13', 'cuda', { why: 'no code for this card' }), pin('llama-cuda2', 'cuda', { installed: false, bytes: 600 }), pin('llama-cuda3', 'cuda')];
  const t = tryOptions({ runner: 'llama-cuda', device: 'cuda' }, pins);
  assert.deepEqual(t.map(x => x.pin), ['llama-cuda3', 'llama-cuda2', 'llama-vulkan', 'llama-cpu', 'llama-cuda13']);
  assert.deepEqual(t.map(x => x.kind), ['version', 'version', 'type', 'cpu', 'version']);
  // A runner that crashed with this model lately goes after the others of its kind.
  assert.deepEqual(tryOptions({ runner: 'llama-cuda', device: 'cuda' }, pins, new Set(['llama-cuda3'])).slice(0, 2).map(x => x.pin), ['llama-cuda2', 'llama-vulkan']);
  // After a Vulkan crash: the CUDA builds are the other type.
  assert.equal(tryOptions({ runner: 'llama-vulkan', device: 'vulkan' }, pins)[0].kind, 'type');
});

test('the page: the notice is loaded, drawn on a fault event, names the PC, opens Report a problem and asks before it acts', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<script src="chatview\.js"><\/script>\r?\n<script src="crash\.js"><\/script>/);
  const view = readFileSync(join(ROOT, 'public', 'chatview.js'), 'utf8');
  assert.match(view, /ev === 'fault' && app\.crashNotice/);
  const js = readFileSync(join(ROOT, 'public', 'crash.js'), 'utf8');
  assert.match(js, /An error has occurred with "\$\{f\.pc\}"/);
  assert.match(js, /app\.openReport\(crashReport\(f\)/);
  assert.match(js, /See the error log/);
  assert.match(js, /Nothing changes until you choose/);
  // No font under 12px in the notice's own style.
  const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8').split(/\r?\n/).filter(l => /\.crash\b/.test(l)).join('\n');
  assert.doesNotMatch(css, /font-size:\s*(\d|1[01])px/);
});

test('a runner that stopped because the model file went (a drive unplugged) is not blamed, offered nothing, and not counted', async () => {
  // The file is gone when the list has no path for it (its folder is not there) or the path it gives is not on disk.
  const list = { path: (id: string) => (id === 'on-usb' ? 'E:/models/on-usb.gguf' : id === 'folder-gone' ? null : `C:/models/${id}.gguf`) };
  const onDisk = (p: string) => p.startsWith('C:/');
  assert.equal(modelFileGone('here', list, onDisk), false);
  assert.equal(modelFileGone('on-usb', list, onDisk), true);
  assert.equal(modelFileGone('folder-gone', list, onDisk), true);
  assert.equal(modelFileGone('', list, onDisk), false, 'no model named: not said to be gone');
  assert.equal(modelFileGone('x', { path: () => { throw new Error('odd'); } }, onDisk), false, 'a check that fails keeps the runner\'s own words');

  const dir = mkdtempSync(join(tmpdir(), 'tomlin-faults-'));
  try {
    const f = makeFault({ pc: 'This PC', model: 'on-usb', modelName: 'Qwen', runner: 'llama-cuda', runnerName: 'llama.cpp b11284, CUDA 12.4', device: 'cuda', kind: 'crash', tail: 'something odd', gone: true });
    assert.equal(f.gone, true);
    assert.match(f.fault, /The file of Qwen is not there any more/);
    assert.match(f.fault, /unplugged/);
    assert.match(f.fault, /not a fault in the runner/);
    assert.doesNotMatch(f.fault, /another runner/i);
    // It crosses the link with its mark.
    assert.equal(cleanFault(JSON.parse(JSON.stringify(f)))?.gone, true);
    assert.equal(cleanFault({ ...f, gone: 'yes' })?.gone, undefined);
    // Kept (the notice finds it), but not counted against the runner: it is not shaky, and still works there.
    const h = await new RunHistory(join(dir, 'run-history.json')).load();
    h.success('This PC', 'on-usb', 'llama-cuda', 30, new Date(Date.now() - 60_000).toISOString());
    await h.failure(f);
    assert.equal(h.recent({ model: 'on-usb' }).length, 1);
    assert.deepEqual(h.rows('This PC', 'on-usb').map(r => [r.runner, r.ok, r.failed]), [['llama-cuda', 1, 0]]);
    assert.deepEqual([...h.shaky('This PC', 'on-usb')], []);
    assert.ok(h.workedOn('This PC').has('llama-cuda'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server: a gone file is checked when a fault is kept, offers no runner and never falls back; the page shows no runner buttons', () => {
  const server = readFileSync(join(ROOT, 'src', 'server', 'faults.ts'), 'utf8');
  assert.match(server, /const gone = modelFileGone\(p\.model, chatModels, existsSync\)/);
  assert.match(server, /if \(f\.gone\) return \{ \.\.\.f, tries: \[\]/);
  assert.match(server, /!run\.fallback \|\| f\.gone\) return \{\}/);
  assert.match(readFileSync(join(ROOT, 'public', 'crash.js'), 'utf8'), /const acts = f\.gone \? \[\] :/);
});
