// Max mode, one loan at a time from this PC: a second model loaded while the first still holds the lenders is refused in
// plain words before anything starts (it used to fail later with "RPC server did not answer"). And the streams to a
// lending PC use TCP keep-alive, so a PC that drops off the network ends its stream instead of hanging it. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog } from '../src/log.ts';
import { keepWireAlive, lendersInUse, maxLoad, secondLoanWhy, streamClosed, streamOpened, WIRE_KEEPALIVE_MS } from '../src/jobrun/maxhost.ts';
import type { Remote } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxloan-'));
openLog(dir);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const worker = { id: 'a1b2c3d4', name: 'Worker PC' } as Remote;
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the second-loan words: nothing in use, the same model, or another model holding the lenders', () => {
  assert.equal(secondLoanWhy('Qwen 80B', 'GLM 30B', []), '');
  assert.equal(secondLoanWhy('Qwen 80B', 'Qwen 80B', ['Worker PC']), '');
  assert.equal(secondLoanWhy('Qwen 80B', 'GLM 30B', ['Worker PC', 'Big PC']), 'Max mode lends the linked PCs to one model at a time, and GLM 30B is still loaded with Max mode and uses "Worker PC" and "Big PC". Unload GLM 30B first, then load Qwen 80B again.');
  assert.match(secondLoanWhy('Qwen 80B', '', ['Worker PC']), /a model here still uses "Worker PC" with Max mode\. Unload it first/);
});

test('a second Max mode load while the first holds the lenders is refused before any PC is asked', async () => {
  const first = await maxLoad('GLM 30B', 'Worker PC', [worker], async () => ({ endpoints: ['127.0.0.1:50123'], lent: ['Worker PC'], notes: [] }));
  assert.equal(first?.refuse, undefined);
  // The runner for GLM 30B has its streams open now.
  streamOpened('Worker PC');
  streamOpened('Worker PC');
  assert.deepEqual(lendersInUse(), ['Worker PC']);
  const second = await maxLoad('Qwen 80B', 'Worker PC', [worker], async () => assert.fail('no PC is asked while the first loan is held'));
  assert.match(second!.refuse!, /one model at a time, and GLM 30B is still loaded/);
  assert.deepEqual(second!.endpoints, []);
  // GLM 30B unloaded: its streams close, and the next load borrows.
  streamClosed('Worker PC');
  assert.deepEqual(lendersInUse(), ['Worker PC']);
  streamClosed('Worker PC');
  assert.deepEqual(lendersInUse(), []);
  const third = await maxLoad('Qwen 80B', 'Worker PC', [worker], async () => ({ endpoints: ['127.0.0.1:50124'], lent: ['Worker PC'], notes: [] }));
  assert.equal(third?.refuse, undefined);
  assert.deepEqual(third?.endpoints, ['127.0.0.1:50124']);
  // A close too many never counts below nothing.
  streamClosed('Worker PC');
  assert.deepEqual(lendersInUse(), []);
});

test('the chat load stops on the refusal (src/server/panes.ts)', () => {
  assert.match(read('src/server/panes.ts'), /if \(max\?\.refuse\) return \{ error: max\.refuse \};/);
});

test('streams to and from a lending PC use TCP keep-alive', () => {
  const calls: [boolean, number][] = [];
  keepWireAlive({ setKeepAlive: (on, ms) => calls.push([on, ms]) });
  assert.deepEqual(calls, [[true, WIRE_KEEPALIVE_MS]]);
  assert.ok(WIRE_KEEPALIVE_MS <= 30_000);
  // A socket without the method (a stand-in stream) is left alone.
  keepWireAlive({});
  assert.match(read('src/jobrun/maxhost.ts'), /keepWireAlive\(socket\);\s*resolve\(/);
  assert.match(read('src/jobrun/maxnode.ts'), /keepWireAlive\(socket as .*\);\s*l\.track\(socket\)/);
});

test('the speed scripts: a permission card is answered at once, and no 5-minute header limit', () => {
  const run = read('benchmarks/z820run.mjs');
  assert.match(run, /event: permit/);
  assert.match(run, /\/api\/chat\/permit', \{ chatId: id, answer: 'no' \}/);
  const speed = read('tools/max-speed.ts');
  assert.match(speed, /headersTimeout: 0, bodyTimeout: 0/);
  assert.match(speed, /dispatcher: patient/);
});
