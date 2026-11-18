// Max mode needs the same llama.cpp build on both PCs (12 Nov 2026: b11284 here and b12250 on the Z820 failed at the
// handshake, "RPC server version mismatch"). The build is read from a runner's name, a node says which builds it can
// lend with, and the borrower says so in plain words before it loads instead of dying in the handshake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOf, Runtimes } from '../src/runtimes.ts';
import { buildClash } from '../src/jobrun/maxhost.ts';
import { cleanRunner } from '../src/runnerpush.ts';

const PINS = fileURLToPath(new URL('../runtimes.json', import.meta.url));

test('the build is read from a runner name', () => {
  assert.equal(buildOf('llama.cpp b11284, CUDA 12.4 (NVIDIA, older cards too)'), 'b11284');
  assert.equal(buildOf('llama.cpp b12250, CUDA 12.4'), 'b12250');
  assert.equal(buildOf('stable-diffusion.cpp master'), '');
});

test('each pinned CUDA runner knows its build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-build-'));
  try {
    const rt = new Runtimes(dir, PINS);
    assert.equal(rt.buildOfPin('llama-cuda'), 'b11284');
    assert.equal(rt.buildOfPin('llama-cuda3'), 'b12250');
    assert.equal(rt.buildOfPin('nothing'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a program is told from its folder, so the RPC server next to the chat runner has the same build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-build-'));
  try {
    const rt = new Runtimes(dir, PINS);
    const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    for (const id of ['llama-cuda', 'llama-cuda3']) {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, exe), '');
      writeFileSync(join(dir, id, 'ggml-rpc-server.exe'), '');
    }
    assert.equal(rt.buildOfExe(join(dir, 'llama-cuda3', 'ggml-rpc-server.exe')), 'b12250');
    assert.equal(rt.buildOfExe(join(dir, 'llama-cuda', 'ggml-rpc-server.exe')), 'b11284');
    assert.equal(rt.buildOfExe(join(dir, 'elsewhere', 'ggml-rpc-server.exe')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a node that lends with another build is named in words', () => {
  const why = buildClash('b11284', 'Worker PC', ['b12250']);
  assert.match(why, /"Worker PC" lends with llama\.cpp b12250 and this PC runs b11284/);
  assert.match(why, /same build/);
  // What happened and what to do, in words: left out of this load (never tried), and the two ways to match the builds.
  assert.match(why, /a mix crashes\), so "Worker PC" was left out of this load/);
  assert.match(why, /send the b11284 runner to "Worker PC" \(Models, Model runners, Send to\), or hold this model here to a b12250 runner \(its gear, Runner\)/);
});

test('the same build, a node that lends with several, or an older TOMLIN that says nothing, is not a clash', () => {
  assert.equal(buildClash('b12250', 'Worker PC', ['b12250']), '');
  assert.equal(buildClash('b11284', 'Worker PC', ['b12250', 'b11284']), '');
  assert.equal(buildClash('b11284', 'Worker PC', undefined), '');
  assert.equal(buildClash('b11284', 'Worker PC', []), '');
  assert.equal(buildClash('', 'Worker PC', ['b12250']), '');
});

test('a hello carries the builds a node can lend with, and drops anything that is not a build id', () => {
  const r = cleanRunner({ nvidia: true, rpc: ['b12250', 'b11284', '../x', 7] });
  assert.deepEqual(r?.rpc, ['b12250', 'b11284']);
  assert.equal(cleanRunner({ nvidia: true })?.rpc, undefined);
});
