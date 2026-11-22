// Max mode "lend card, RAM and cores together": one RPC server with the card and the CPU as devices (-d CUDA0,CPU), the
// host asks for it (TOMLIN_MAX_SHARE=all, in its sealed request), and the memory check counts the card plus the RAM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lendThreads, rpcArgs } from '../src/maxlend.ts';
import { lentBytes, shareAll } from '../src/jobrun/maxhost.ts';

const GB = 2 ** 30;
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

test('all: the RPC server gets the card and the CPU, with threads for the CPU device', () => {
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cuda', threads: 6, all: true }, false, 12), ['-H', '127.0.0.1', '-p', '5000', '-d', 'CUDA0,CPU', '-t', '6']);
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'vulkan', threads: 0, all: true }, true, 12), ['-H', '127.0.0.1', '-p', '5000', '-c', '-d', 'Vulkan0,CPU', '-t', '6']);
  // A PC with no card already lends its CPU: nothing is added, and the card-only default is untouched.
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cpu', threads: 4, all: true }, false, 12), ['-H', '127.0.0.1', '-p', '5000', '-t', '4']);
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cuda', threads: 4 }, false, 12), ['-H', '127.0.0.1', '-p', '5000']);
  // CPU only (the cluster test's second member per socket): the card is left out, with the threads.
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cuda', threads: 8, cpuOnly: true }, false, 32), ['-H', '127.0.0.1', '-p', '5000', '-d', 'CPU', '-t', '8']);
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'vulkan', threads: 0, cpuOnly: true, all: true }, false, 32), ['-H', '127.0.0.1', '-p', '5000', '-d', 'CPU', '-t', '16']);
});

test('the lending threads: the PC\'s own setting, else half the logical cores, at least 2', () => {
  assert.equal(lendThreads(12), 6);
  assert.equal(lendThreads(4), 2);
  assert.equal(lendThreads(1), 2);
});

test('the memory a lender adds: the card only, or the card plus the RAM', () => {
  const h = (cards: number, gpuTotal: number, ramTotal: number, ramUsed: number) => ({ can: ['max'], memory: { cards: { count: cards, total: gpuTotal * GB }, gpu: cards ? { total: gpuTotal * GB, used: 0 } : null, ram: { total: ramTotal * GB, used: ramUsed * GB } } });
  const z = h(1, 12, 64, 4);
  assert.equal(lentBytes([z]), 11.5 * GB);
  // The RAM counts what leaves the PC 4 GB free, less 0.5 GB for the runner (64 GB with 4 used: 55.5 GB, not 57).
  assert.equal(lentBytes([z], true), 11.5 * GB + 55.5 * GB);
  // A PC with 32 GB of RAM or less lends at most 55% of its free RAM (the 24 GB HP 800 stalled with 14 to 17 GB, 14 Nov 2026).
  const hp = h(1, 4, 24, 4);
  assert.equal(lentBytes([hp], true), 3.5 * GB + 20 * GB * 0.55);
  // No card: the RAM either way.
  assert.equal(lentBytes([h(0, 0, 48, 2)]), 41.5 * GB);
  assert.equal(lentBytes([h(0, 0, 48, 2)], true), 41.5 * GB);
  assert.equal(lentBytes([h(0, 0, 32, 2)]), 30 * GB * 0.55);
  // Nearly no RAM left never counts below nothing.
  assert.equal(lentBytes([h(1, 4, 8, 7)], true), 3.5 * GB);
  assert.equal(lentBytes([h(1, 4, 24, 4)], true), 3.5 * GB + 20 * GB * 0.55);
  assert.equal(lentBytes([z, hp], true), (11.5 + 55.5 + 3.5) * GB + 20 * GB * 0.55);
});

test('the host asks for the card, RAM and cores unless TOMLIN_MAX_SHARE says card, and the lender reads that ask', () => {
  assert.equal(shareAll('all'), true);
  assert.equal(shareAll(' ALL '), true);
  assert.equal(shareAll(''), true, "a lender's permission covers its RAM and cores: the default");
  assert.equal(shareAll('card'), false);
  assert.equal(shareAll(' Cards '), false);
  assert.equal(shareAll('off'), false);
  assert.match(read('src/jobrun/maxhost.ts'), /\.\.\.\(shareAll\(\) \? \{ share: 'all' \} : \{\}\)/);
  assert.match(read('src/jobrun/maxnode.ts'), /opened\.body\.share === 'all'/);
  assert.match(read('src/jobrun/maxnode.ts'), /\{ \.\.\.program, all: true \}/);
  assert.match(read('src/server/panes.ts'), /shareAll\(\) \? 'card, RAM and cores' : 'card memory'/);
});

test('the expert placement is off unless TOMLIN_MAX_PLACE turns it on (it measured slower than the layer split over RPC)', async () => {
  const { placeOff } = await import('../src/jobrun/maxplaced.ts');
  assert.equal(placeOff(''), true);
  assert.equal(placeOff('off'), true);
  assert.equal(placeOff('on'), false);
  assert.equal(placeOff(' Experts '), false);
  assert.equal(placeOff('1'), false);
});
