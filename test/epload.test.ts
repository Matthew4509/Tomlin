// Expert parallel at load time (src/jobrun/epload.ts): the patched runner is found by what its llama.dll reads, each
// lender's RAM device is picked from the runner's list, and the runner gets small batch buffers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expertRunner, hasExpertSplit, lenderRam, EXPERT_RUNNER_DIR } from '../src/jobrun/epload.ts';
import { chatArgs } from '../src/llama.ts';

const GIB = 2 ** 30;
const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

test('the patched runner is found only when its llama.dll reads LLAMA_EXPERT_SPLIT', () => {
  const root = mkdtempSync(join(tmpdir(), 'tomlin-ep-'));
  try {
    const dir = join(root, EXPERT_RUNNER_DIR);
    mkdirSync(dir);
    writeFileSync(join(dir, exe), '');
    writeFileSync(join(dir, 'llama.dll'), 'stock llama');
    assert.equal(hasExpertSplit(dir), false);
    assert.equal(expertRunner(root, ''), null, 'a stock build in the folder is not used');
    const own = join(root, 'own');
    mkdirSync(own);
    writeFileSync(join(own, exe), '');
    writeFileSync(join(own, 'llama.dll'), 'xx LLAMA_EXPERT_SPLIT xx');
    assert.equal(expertRunner(root, own), join(own, exe), 'the folder TOMLIN_EXPERT_RUNNER names');
    assert.equal(expertRunner(join(root, 'none'), ''), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the patched runner is looked for in the home runtime folder and the app folder (2.0.93: only the app folder was searched)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tomlin-ep-'));
  try {
    const app = join(root, 'app');
    const home = join(root, 'home');
    const dir = join(home, EXPERT_RUNNER_DIR);
    mkdirSync(app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, exe), '');
    writeFileSync(join(dir, 'llama.dll'), 'xx LLAMA_EXPERT_SPLIT xx');
    assert.equal(expertRunner([home, app], ''), join(dir, exe), 'found in the home folder');
    assert.equal(expertRunner([app, home], ''), join(dir, exe), 'whichever folder is listed first');
    assert.equal(expertRunner([app], ''), null, 'not in the app folder alone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each lender\'s RAM is its last device; one device counts only when it is not known to be a card', () => {
  const listed = [
    { name: 'CUDA0', what: 'Quadro P2000', total: 5 * GIB, free: 4.2 * GIB },
    { name: 'RPC0', what: '127.0.0.1:50073', total: 12 * GIB, free: 11 * GIB },
    { name: 'RPC1', what: '127.0.0.1:50073', total: 64 * GIB, free: 58 * GIB },
    { name: 'RPC2', what: '127.0.0.1:50080', total: 32 * GIB, free: 26 * GIB },
  ];
  assert.equal(lenderRam(listed, '127.0.0.1:50073', true)?.name, 'RPC1');
  assert.equal(lenderRam(listed, '127.0.0.1:50080', false)?.name, 'RPC2');
  assert.equal(lenderRam(listed, '127.0.0.1:50080', null)?.name, 'RPC2');
  assert.equal(lenderRam(listed, '127.0.0.1:50080', true), null, 'a lone card is never used for experts');
  assert.equal(lenderRam(listed, '127.0.0.1:50099', null), null);
});

test('expert parallel starts with -b 32 -ub 32 instead of the 2048 prompt chunks, its devices and -lm none', () => {
  const run = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const, moe: true, rpc: ['127.0.0.1:50073'], batch: 32, maxPlace: { device: 'cuda' as const, dev: ['CUDA0', 'RPC1'], split: [1, 0], override: ['^output\\.weight=CUDA0'], ngl: 23 } };
  const args = chatArgs('m.gguf', 8080, 'cuda', 4, false, run, true);
  const s = args.join(' ');
  assert.match(s, /-b 32 -ub 32/);
  assert.doesNotMatch(s, /-ub 2048/);
  assert.match(s, /-ngl 23/);
  assert.match(s, /-dev CUDA0,RPC1 -ts 1,0 -ot \^output\\\.weight=CUDA0/);
  assert.match(s, /--rpc 127\.0\.0\.1:50073 -lm none/);
  const plain = chatArgs('m.gguf', 8080, 'cuda', 4, false, { ...run, batch: undefined }, true).join(' ');
  assert.match(plain, /-ub 2048/);
});
