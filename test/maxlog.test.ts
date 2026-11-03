// Max mode leaves a trace in the log on both PCs: each chat load on the borrowing PC says what it borrowed or why not,
// and the lending PC writes down each refusal. 2 Nov: two loads left no word either way, so a split that never happened
// could not be told from one refused. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { logFile, openLog } from '../src/log.ts';
import { maxLoad } from '../src/jobrun/maxhost.ts';
import { MAX_DOOR, maxUpgrade } from '../src/jobrun/maxnode.ts';
import type { Remote } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxlog-'));
openLog(dir);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
/** Today's "[max]" lines in the log. */
const lines = () => { try { return readFileSync(logFile()!, 'utf8').split('\n').filter(l => l.includes('[max]')); } catch { return []; } };
const worker = { id: '3fcca362', name: 'Worker PC' } as Remote;

test('Max mode off (no TOMLIN_MAX): nothing is asked and nothing is written', async () => {
  const before = lines().length;
  assert.equal(await maxLoad('Qwen 2B', '', [], async () => assert.fail('no PC is asked')), null);
  assert.equal(lines().length, before);
});

test('TOMLIN_MAX names no linked PC here: the load says so, and so does the log', async () => {
  const max = await maxLoad('Qwen 35B', 'Wroker PC', [], async () => assert.fail('no PC is asked'));
  assert.deepEqual(max?.endpoints, []);
  assert.match(max!.notes.join(' '), /Max mode: no linked PC here is called "Wroker PC"/);
  assert.match(lines().at(-1)!, /Qwen 35B: nothing borrowed\. Max mode: no linked PC here is called "Wroker PC"/);
});

test('A PC that lends: the log names it and the --rpc address the runner was given', async () => {
  await maxLoad('Qwen 80B', 'Worker PC', [worker], async () => ({ endpoints: ['127.0.0.1:50123'], lent: ['Worker PC'], notes: [] }));
  assert.match(lines().at(-1)!, /Qwen 80B: borrowing "Worker PC" \(--rpc 127\.0\.0\.1:50123\)/);
});

test('A PC that refuses: the log gives its reason', async () => {
  const why = 'Max mode: someone is using "Worker PC" (last used 2 min ago).';
  await maxLoad('Qwen 2B', 'Worker PC', [worker], async () => ({ endpoints: [], lent: [], notes: [why] }));
  assert.ok(lines().at(-1)!.endsWith(`Qwen 2B: nothing borrowed. ${why}`), lines().at(-1));
});

test('The lending PC writes each refusal in its own log', async () => {
  const socket = new PassThrough();
  let answer = '';
  socket.on('data', b => (answer += b));
  const req = { socket: { remoteAddress: '8.8.8.8' }, headers: {}, url: MAX_DOOR } as never;
  await maxUpgrade(req, socket, Buffer.alloc(0));
  assert.match(answer, /403/);
  assert.match(lines().at(-1)!, /Did not lend \(8\.8\.8\.8\): This worker only answers PCs on its own home network\./);
});

test('the borrowing PC waits longer for a stream than the lending PC can take to open one from cold', async () => {
  const { OPEN_MS } = await import('../src/jobrun/maxhost.ts');
  const { PRESENCE_FIRST_MS, RPC_START_MS, RPC_REACH_MS } = await import('../src/maxlend.ts');
  // 3 Nov: the lending PC's RPC server had stopped between two loads; starting it again took nearly 30 s, and the
  // borrowing PC gave up at 30 s ("did not answer in 30 seconds"), then borrowed fine 26 s later.
  assert.ok(OPEN_MS >= PRESENCE_FIRST_MS + RPC_START_MS + RPC_REACH_MS + 15_000, `${OPEN_MS}`);
});
