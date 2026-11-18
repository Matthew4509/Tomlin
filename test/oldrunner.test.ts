// A loaded chat model keeps the runner it started with (src/oldrunner.ts): after a runner is installed, updated or
// picked for it, the pane says plainly that it is still on the old one, until it is dropped and loaded again.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTime, oldRunnerNote, type StartedWith } from '../src/oldrunner.ts';

const dir = mkdtempSync(join(tmpdir(), 'tomlin-oldrunner-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const cuda12 = 'C:\\TOMLIN\\runtime\\llama-cuda\\llama-server.exe';
const cuda13 = 'C:\\TOMLIN\\runtime\\llama-cuda13\\llama-server.exe';
const was: StartedWith = { exe: cuda12, runner: 'cuda', device: 'cuda', mtimeMs: 1000 };

test('the same runner, unchanged: nothing is said', () => {
  assert.equal(oldRunnerNote(was, { exe: cuda12, runner: 'cuda' }, 1000), '');
  // The same path written another way (slashes, case) is the same runner.
  assert.equal(oldRunnerNote(was, { exe: cuda12.replace(/\\/g, '/').toUpperCase(), runner: 'cuda' }, 1000), '');
});

test('another runner would start it now (CUDA 13 installed, or picked for the model): the pane names both', () => {
  assert.equal(oldRunnerNote(was, { exe: cuda13, runner: 'cuda13' }, 5), 'This model is still on the CUDA 12 runner it started with; it would start on the CUDA 13 runner now. Drop it and load it again to use that one.');
});

test('the runner was updated in place (same path, newer file): the pane says so', () => {
  assert.equal(oldRunnerNote(was, { exe: cuda12, runner: 'cuda' }, 2000), 'This model is still on the CUDA 12 runner as it was before the runner was updated. Drop it and load it again to use the new one.');
});

test('the runner it started from is gone: it keeps running until dropped', () => {
  assert.equal(oldRunnerNote(was, null, null), 'This model is still on the CUDA 12 runner it started with, which is no longer installed. It keeps running until it is dropped.');
});

test('nothing known about the start, or no file time either side: nothing is said', () => {
  assert.equal(oldRunnerNote(null, { exe: cuda13 }, 5), '');
  assert.equal(oldRunnerNote({ ...was, mtimeMs: null }, { exe: cuda12, runner: 'cuda' }, 2000), '');
  assert.equal(oldRunnerNote(was, { exe: cuda12, runner: 'cuda' }, null), '');
});

test('a CPU or Vulkan start is named by its device', () => {
  const cpu: StartedWith = { exe: 'C:\\r\\llama-cpu\\llama-server.exe', device: 'cpu', mtimeMs: 1 };
  assert.match(oldRunnerNote(cpu, { exe: 'C:\\r\\llama-cpu2\\llama-server.exe' }, 1), /^This model is still on the CPU runner it started with; it would start on another runner now\./);
  const vk: StartedWith = { exe: 'C:\\r\\llama-vulkan\\llama-server.exe', runner: 'vulkan', device: 'vulkan', mtimeMs: 1 };
  assert.match(oldRunnerNote(vk, { exe: vk.exe, runner: 'vulkan' }, 9), /still on the Vulkan runner as it was before/);
});

test('fileTime: a file\'s time, null for a missing file or no path', () => {
  const f = join(dir, 'llama-server.exe');
  writeFileSync(f, 'x');
  utimesSync(f, 1_700_000_000, 1_700_000_000);
  assert.equal(fileTime(f), 1_700_000_000_000);
  assert.equal(fileTime(join(dir, 'none.exe')), null);
  assert.equal(fileTime(undefined), null);
});
