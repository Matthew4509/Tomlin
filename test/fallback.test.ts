// The automatic runner fallback (src/faults.ts fallbackPick, src/server/faults.ts fallBack): off until the person says yes
// in the crash notice, then a crash moves the model to the next runner that can run it, never to the CPU on its own and
// never back to one that crashed with it lately. Nothing starts TOMLIN or a runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanFault, fallbackPick, makeFault, type TryOption } from '../src/faults.ts';
import { cleanRunWith, runnerSetAsk } from '../src/runset.ts';
import type { RuntimePin } from '../src/runtimes.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const PINS = (JSON.parse(read('runtimes.json')) as { runtimes: Record<string, RuntimePin> }).runtimes;
const LIST = [{ id: 'qwen.gguf', name: 'Qwen3.5-35B', bytes: 20e9 }];
const t = (pin: string, kind: TryOption['kind'], o: Partial<TryOption> = {}): TryOption => ({ pin, name: pin, device: kind === 'cpu' ? 'cpu' : pin.includes('vulkan') ? 'vulkan' : 'cuda', build: 'b1', kind, installed: true, bytes: 0, why: '', ...o });

test('the pick: the first runner that can run here and is installed; never the CPU, never one that crashed lately', () => {
  const tries = [t('llama-cuda13', 'version', { why: 'no code for this card' }), t('llama-cuda2', 'version', { installed: false }), t('llama-cuda3', 'version'), t('llama-vulkan', 'type'), t('llama-cpu', 'cpu')];
  assert.equal(fallbackPick(tries, new Set())?.pin, 'llama-cuda3');
  assert.equal(fallbackPick(tries, new Set(['llama-cuda3']))?.pin, 'llama-vulkan');
  // Every card runner crashed lately: nothing (the CPU is offered in the notice, not moved to on its own).
  assert.equal(fallbackPick(tries, new Set(['llama-cuda3', 'llama-vulkan'])), null);
  assert.equal(fallbackPick([], new Set()), null);
});

test('it is off until agreed: only a yes sets it, and the saved setting keeps nothing but true', () => {
  assert.equal(cleanRunWith({}, 'qwen.gguf', LIST, [8192]).fallback, undefined);
  assert.equal(cleanRunWith({ fallback: 'yes' }, 'qwen.gguf', LIST, [8192]).fallback, undefined);
  assert.equal(cleanRunWith({ fallback: true }, 'qwen.gguf', LIST, [8192]).fallback, true);
  // The notice's yes: fallback alone, the runner left as it is (null); off again the same way.
  const on = runnerSetAsk({ model: 'qwen.gguf', fallback: true }, LIST, PINS, () => true, () => '');
  assert.deepEqual('error' in on ? on : { runner: on.runner, fallback: on.fallback }, { runner: null, fallback: true });
  const off = runnerSetAsk({ model: 'qwen.gguf', fallback: false }, LIST, PINS, () => true, () => '');
  assert.ok(!('error' in off) && off.fallback === false);
  assert.ok('error' in runnerSetAsk({ model: 'gone.gguf', fallback: true }, LIST, PINS, () => true, () => ''));
  // A stray value is not a yes.
  assert.ok('error' in runnerSetAsk({ model: 'qwen.gguf', fallback: 'true' }, LIST, PINS, () => true, () => ''));
});

test('what the fallback did crosses the link with the fault, checked', () => {
  const f = makeFault({ pc: 'Z820', model: 'q', modelName: 'Q', runner: 'llama-cuda', runnerName: 'llama.cpp b11284, CUDA 12.4', device: 'cuda', kind: 'crash', tail: 'CUDA error: an illegal memory access was encountered' });
  const c = cleanFault({ ...f, fallback: true, fellBack: 'llama-cuda3', fallbackSaid: 'As you agreed, TOMLIN moved Q on "Z820" to b12250.' })!;
  assert.equal(c.fellBack, 'llama-cuda3');
  assert.equal(c.fallback, true);
  assert.match(c.fallbackSaid!, /^As you agreed/);
  assert.equal(cleanFault({ ...f, fellBack: '..\\x.exe', fallback: 'yes' })!.fellBack, undefined);
  assert.equal(cleanFault({ ...f, fallback: 'yes' })!.fallback, undefined);
});

test('the server falls back only on a crash with it agreed, and the notice asks before turning it on', () => {
  const srv = read('src/server/faults.ts');
  // A model whose file was gone (an unplugged drive) never falls back either: the runner was not at fault.
  assert.match(srv, /if \(f\.kind !== 'crash' \|\| !run\.fallback \|\| f\.gone\) return \{\};/);
  // A crash under Test now or the runner check is that test's result: nothing is moved while it says "Nothing was changed".
  assert.match(srv, /if \(testBusy\(\) \|\| checkBusy\(\)\) return \{\};/);
  assert.ok(srv.indexOf('if (testBusy() || checkBusy()) return {};') < srv.indexOf('const next = fallbackPick('), 'checked before a runner is picked');
  assert.match(srv, /const fb = await fallBack\(f\)/);
  assert.match(srv, /As you agreed, TOMLIN moved/);
  const node = read('src/jobrun/node.ts');
  assert.match(node, /typeof b\.runner === 'string' \|\| typeof b\.fallback === 'boolean'\) return runnerSetHere/);
  const js = read('public/crash.js');
  assert.match(js, /f\.fallbackSaid \? el\('p'/);
  assert.match(js, /if \(!confirm\(ask\)\) return;/);
  assert.match(js, /never moves it to the CPU on its own/);
});
