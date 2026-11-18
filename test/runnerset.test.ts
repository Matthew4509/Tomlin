// The per-model Runner setting (src/runset.ts runnerSetAsk, src/runtimes.ts pinOfRunner) and Test now: what a model may
// be held to, what a linked PC may ask a node for, and where the page offers it. Nothing starts TOMLIN or a runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanRunWith, runnerSetAsk } from '../src/runset.ts';
import { isHeldRunner, pinOfRunner, type RuntimePin } from '../src/runtimes.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const PINS = (JSON.parse(read('runtimes.json')) as { runtimes: Record<string, RuntimePin> }).runtimes;
const LIST = [{ id: 'qwen.gguf', name: 'Qwen3.5-35B', bytes: 20e9 }, { id: 'ollama:llama3', name: 'llama3', bytes: 4e9 }];

test('a model can be held to any pinned chat card runner by its id, as well as by the old short names', () => {
  assert.equal(pinOfRunner('cuda'), 'llama-cuda');
  assert.equal(pinOfRunner('cuda13'), 'llama-cuda13');
  assert.equal(pinOfRunner('llama-cuda3'), 'llama-cuda3');
  assert.equal(pinOfRunner('llama-vulkan'), 'llama-vulkan');
  assert.equal(pinOfRunner('llama-cpu'), '');
  assert.equal(pinOfRunner('sd-cuda'), '');
  assert.equal(pinOfRunner('..\\x'), '');
  assert.equal(pinOfRunner(undefined), '');
  assert.ok(isHeldRunner('llama-cuda2'));
  assert.ok(!isHeldRunner('C:\\runner.exe'));
  // Saved run settings keep a pin id and drop anything else.
  assert.equal(cleanRunWith({ runner: 'llama-cuda3' }, 'qwen.gguf', LIST, [8192]).runner, 'llama-cuda3');
  assert.equal(cleanRunWith({ runner: 'cuda' }, 'qwen.gguf', LIST, [8192]).runner, 'cuda');
  assert.equal(cleanRunWith({ runner: '--flag' }, 'qwen.gguf', LIST, [8192]).runner, undefined);
});

test('a linked PC may set only a card runner the node pins, has unpacked and can use; empty is Auto', () => {
  const installed = (id: string) => id !== 'llama-cuda2';
  const why = (id: string) => (id === 'llama-cuda13' ? '"Node" has a GTX 1060, and the CUDA 13.4 runner has no code for it.' : '');
  const ask = (b: Record<string, unknown>) => runnerSetAsk(b, LIST, PINS, installed, why);
  const ok = ask({ model: 'qwen.gguf', runner: 'llama-cuda3' });
  assert.ok(!('error' in ok) && ok.runner === 'llama-cuda3');
  const auto = ask({ model: 'qwen.gguf', runner: '' });
  assert.ok(!('error' in auto) && auto.runner === '');
  const short = ask({ model: 'qwen.gguf', runner: 'vulkan' });
  assert.ok(!('error' in short) && short.runner === 'llama-vulkan');
  const r = (b: Record<string, unknown>) => ask(b) as { status: number; error: string };
  assert.equal(r({ model: 'qwen.gguf', runner: 'llama-cuda2' }).status, 409);
  assert.match(r({ model: 'qwen.gguf', runner: 'llama-cuda2' }).error, /not installed on this PC yet/);
  assert.match(r({ model: 'qwen.gguf', runner: 'llama-cuda13' }).error, /no code for it/);
  assert.equal(r({ model: 'qwen.gguf', runner: 'llama-cpu' }).status, 400);
  assert.equal(r({ model: 'qwen.gguf', runner: 'llama-cuda9' }).status, 400);
  assert.equal(r({ model: 'qwen.gguf', runner: 'C:\\evil.exe' }).status, 400);
  assert.equal(r({ model: 'gone.gguf', runner: '' }).status, 404);
  assert.equal(r({ model: 'ollama:llama3', runner: '' }).status, 400);
  assert.equal(r({ model: 'qwen.gguf' }).status, 400);
});

test('the node takes it at the run-set door behind its owner\'s tick, the host passes only ids, and Test now has its doors', () => {
  const node = read('src/jobrun/node.ts');
  assert.match(node, /if \(typeof b\.runner === 'string' \|\| typeof b\.fallback === 'boolean'\) return runnerSetHere\(b, by\);/);
  assert.match(node, /runset\.runnerSetAsk\(b, d\.chatList\(\), rt\.pins/);
  assert.match(node, /action === 'runner-test-start'\)\)/);
  const copies = read('src/jobrun/copies.ts');
  assert.match(copies, /runner: b\.runner\.slice\(0, 40\)/);
  assert.match(copies, /fallback: b\.fallback/);
  assert.match(copies, /'runner-test-start', 'runner-test-state', 'runner-test-stop'/);
  const jobs = read('src/server/jobs.ts');
  assert.match(jobs, /action\.startsWith\('runner-test-'\) \? import\('\.\/faults\.ts'\)/);
  assert.match(jobs, /runnerTesting\.busy\(\)/);
});

test('the page: the gear has a Runner list with Test now, the crash notice has Test now and Use this runner, and each asks first', () => {
  const html = read('public/index.html');
  assert.match(html, /id="ctx-runner-row" hidden>/);
  assert.match(html, /id="ctx-runner-test">Test now</);
  const app = read('public/app.js');
  assert.match(app, /runner: \$\('#ctx-runner'\)\.value \|\| null/);
  assert.match(app, /if \(!confirm\(`Test this model on/);
  const crash = read('public/crash.js');
  assert.match(crash, /if \(!confirm\(`Test \$\{model\} on \$\{t\.name\}, \$\{where\}\?/);
  assert.match(crash, /if \(!confirm\(`Use \$\{t\.name\} for \$\{model\} \$\{where\} from now on\?/);
  assert.match(crash, /'\/api\/network\/run-set'/);
});
