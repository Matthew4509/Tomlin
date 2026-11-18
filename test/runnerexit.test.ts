// A model runner that ends on its own leaves one line in the log: its name, exit code or signal, how long it ran and its
// last 20 error lines, trimmed and with keys taken out (src/runnerexit.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TAIL_LINES, cleanTail, cleanedTail, exitWords, loanEndWords, ranFor, runnerName, watchRunner } from '../src/runnerexit.ts';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

/** A stand-in for a runner process: its error output, and exit then close as Node sends them. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
  child.stderr = new PassThrough();
  const end = (code: number | null, signal: string | null) => {
    child.emit('exit', code, signal);
    child.stderr.end();
    setImmediate(() => child.emit('close', code, signal));
  };
  return { child, end };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('how long, in plain words', () => {
  assert.equal(ranFor(40_400), '40 s');
  assert.equal(ranFor(12 * 60_000 + 5_000), '12 min');
  assert.equal(ranFor(3 * 3600_000 + 5 * 60_000), '3 h 5 min');
  assert.equal(ranFor(-5), '0 s');
});

test('the tail is trimmed, keeps the last 20, and loses anything like a key, an address or a user folder', () => {
  const many = Array.from({ length: 30 }, (_, i) => `  line ${i}  `);
  const t = cleanTail(many);
  assert.equal(t.length, TAIL_LINES);
  assert.equal(t[0], 'line 10');
  assert.equal(t.at(-1), 'line 29');
  const secret = cleanTail(['main: api key sk-abcdefghijklmnopqrstuvwx', 'token=hunter2hunter2', 'loading C:\\Users\\Pat Jones\\models\\a.gguf', 'from 192.168.1.20', '', '   ', `--api-key ${'ab12'.repeat(12)}`]);
  assert.equal(secret.length, 5);
  assert.ok(!secret.join('\n').includes('sk-abc'), secret.join('\n'));
  assert.ok(!secret.join('\n').includes('hunter2'));
  assert.ok(!secret.join('\n').includes('Pat Jones'));
  assert.ok(!secret.join('\n').includes('192.168.1.20'));
  assert.ok(!secret.join('\n').includes('ab12ab12ab12'));
  assert.equal(cleanTail(['word '.repeat(200)])[0].length, 300);
  assert.deepEqual(cleanedTail(() => ['  a  ', 'token: abcdef'])(), ['a', 'token: <secret>']);
});

test('the line says the runner, how it ended, how long it ran and its last lines', () => {
  assert.equal(runnerName('C:\\Users\\someone\\TOMLIN\\runtime\\llama-cuda\\llama-server.exe'), 'llama-server.exe');
  assert.equal(exitWords('rpc-server.exe', -1073741819, null, 125_000, ['ggml_cuda: out of memory', 'abort']),
    'The model runner rpc-server.exe stopped on its own after 2 min: exit code -1073741819 (0xC0000005). Its last lines: ggml_cuda: out of memory | abort.');
  assert.equal(exitWords('sd-server.exe', null, 'SIGKILL', 5_000, []), 'The model runner sd-server.exe stopped on its own after 5 s: ended by SIGKILL. It wrote nothing to its error output.');
});

test('a runner that ends on its own is logged once, with what it wrote last; one ended on purpose is not', async () => {
  const said: string[] = [];
  const a = fakeChild();
  watchRunner(a.child as never, 'C:\\x\\llama-server.exe', () => false, { say: l => said.push(l) });
  a.child.stderr.write('loading model\r\nsrv  error: cudaMalloc failed\n');
  a.child.stderr.write('last words without a line end');
  await settle();
  a.end(3, null);
  await settle();
  assert.equal(said.length, 1);
  assert.match(said[0], /^The model runner llama-server\.exe stopped on its own after 0 s: exit code 3 \(0x3\)\. Its last lines: loading model \| srv {2}error: cudaMalloc failed \| last words without a line end\.$/);

  const b = fakeChild();
  watchRunner(b.child as never, 'sd-server.exe', () => true, { say: l => said.push(l) });
  b.child.stderr.write('bye\n');
  b.end(0, null);
  await settle();
  assert.equal(said.length, 1, 'an end that was asked for is not a fault');

  // A caller that reads the pipe itself feeds whole lines in.
  const c = fakeChild();
  const w = watchRunner(c.child as never, 'llama-server.exe', () => false, { feed: true, say: l => said.push(l) });
  for (let i = 0; i < 25; i++) w.line(`line ${i}`);
  c.end(null, 'SIGTERM');
  await settle();
  assert.equal(said.length, 2);
  assert.match(said[1], /ended by SIGTERM\. Its last lines: line 5 \| line 6 .* \| line 24\.$/);
});

test('a runner that writes without ever ending a line is not kept whole in memory', async () => {
  const said: string[] = [];
  const a = fakeChild();
  watchRunner(a.child as never, 'llama-server.exe', () => false, { say: l => said.push(l) });
  const chunk = '.'.repeat(2 ** 20);
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    a.child.stderr.write(chunk);
    if (i % 10 === 0) await new Promise(r => setImmediate(r));
  }
  await settle();
  const heap = process.memoryUsage().heapUsed;
  a.end(1, null);
  await settle();
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms for 120 MB of dots`);
  assert.ok(heap < 100 * 2 ** 20, `${Math.round(heap / 2 ** 20)} MB held`);
  assert.equal(said.length, 1);
  assert.ok(said[0].length < 2000);
});

test('the loan line says how long it ran', () => {
  assert.equal(loanEndWords({ to: 'Main', why: 'someone is using this PC again', at: '2026-11-17T10:42:00.000Z' }, '2026-11-17T08:30:00.000Z'), 'Stopped lending to "Main" after 2 h 12 min: someone is using this PC again.');
  assert.equal(loanEndWords({ to: 'Main', why: 'x', at: '2026-11-17T10:42:00.000Z' }, null), 'Stopped lending to "Main": x.');
});

test('the chat and picture runners, and the RPC server, are watched', () => {
  const worker = read('src/worker.ts');
  assert.match(worker, /watchRunner\(child, spec\.exe, \(\) => this\.child !== child, \{ feed: true \}\)/);
  assert.match(worker, /if \(errors\) for \(const l of lines\) exitLog\.line\(l\);/);
  const lend = read('src/maxlend.ts');
  assert.match(lend, /const tail = cleanedTail\(keepTail\(child\)\);/);
  assert.match(read('src/jobrun/maxnode.ts'), /loanEndWords\(e, lender\?\.lease\?\.since\)/);
});
