import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { autostart, OLD_STARTUP_FILES, STARTUP_FILE, startupDir, startupScript } from '../src/autostart.ts';

test('the startup file runs this copy\'s Start TOMLIN.cmd, minimised; a % in the folder is doubled for cmd', () => {
  const text = startupScript('C:\\Apps\\Smart 100%\\shelby-2');
  assert.match(text, /^@echo off\r\n/);
  assert.ok(text.includes('start "TOMLIN" /min "C:\\Apps\\Smart 100%%\\shelby-2\\Start TOMLIN.cmd"'));
  assert.equal(startupDir({ TOMLIN_STARTUP_DIR: 'X:\\t' }), 'X:\\t');
});

test('ticking writes the file, unticking removes it, and nothing else is left in the folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-startup-'));
  try {
    const a = autostart('C:\\sm', { TOMLIN_STARTUP_DIR: dir });
    assert.equal(await a.on(), false);
    await a.set(true);
    assert.equal(await a.on(), true);
    assert.deepEqual(await readdir(dir), [STARTUP_FILE]);
    assert.equal(await readFile(join(dir, STARTUP_FILE), 'utf8'), startupScript('C:\\sm'));
    // Another copy's file is not this one's.
    assert.equal(await autostart('D:\\other', { TOMLIN_STARTUP_DIR: dir }).on(), false);
    await a.set(false);
    assert.equal(await a.on(), false);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Startup file under the earlier name (Smart Manager.cmd) counts, and is replaced by TOMLIN.cmd: it never starts twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-startup-'));
  try {
    assert.equal(STARTUP_FILE, 'TOMLIN.cmd');
    await writeFile(join(dir, OLD_STARTUP_FILES[0]), startupScript('C:\\sm'));
    const a = autostart('C:\\sm', { TOMLIN_STARTUP_DIR: dir });
    assert.equal(await a.on(), true);
    await a.set(true);
    assert.deepEqual(await readdir(dir), [STARTUP_FILE]);
    await writeFile(join(dir, OLD_STARTUP_FILES[0]), 'left over');
    await a.set(false);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
