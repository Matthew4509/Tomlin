// Audit of the first-run and core app (28 Nov 2026): one test for each fault found, each fixed and kept as a guard. Every copy of TOMLIN started here has an empty
// home of its own in the temp folder, on port 8760, and reaches nothing outside this PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testEnv } from './env.ts';

const PORT = 8760;
const ROOT = join(tmpdir(), 'tomlin-audit-firstrun');
mkdirSync(ROOT, { recursive: true });

/** True when something already listens on the port (the test then does not start a copy there). */
const portTaken = () => new Promise<boolean>(done => {
  const s = createConnection({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => (s.destroy(), done(true)));
  s.once('error', () => done(false));
});

/** A home with one hire (Sam) and one chat with him holding two lines. */
function makeHome(): string {
  const home = mkdtempSync(join(ROOT, 't-'));
  const data = join(home, 'data');
  mkdirSync(join(data, 'chats'), { recursive: true });
  mkdirSync(join(home, 'models'), { recursive: true });
  mkdirSync(join(home, 'startup'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), `${join(home, 'models')}\n`);
  writeFileSync(join(data, 'version.json'), JSON.stringify({ data: 1, app: JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version }));
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ who: 'staff:sam', chatId: 'aaaaaaaaaaaa' }));
  writeFileSync(join(data, 'staff.json'), JSON.stringify({ staff: [{ id: 'sam', name: 'Sam', role: 'writer', level: 'default', model: null }], auditions: {} }));
  writeFileSync(join(data, 'chats', 'index.json'), JSON.stringify([{ id: 'aaaaaaaaaaaa', who: 'staff:sam', title: 'Invoices', created: '2026-11-20T10:00:00.000Z', updated: '2026-11-20T10:01:00.000Z', messages: 2 }]));
  writeFileSync(join(data, 'chats', 'aaaaaaaaaaaa.json'), JSON.stringify([{ role: 'user', content: 'About invoices', at: '2026-11-20T10:00:00.000Z' }, { role: 'assistant', content: 'An answer.', at: '2026-11-20T10:01:00.000Z' }]));
  writeFileSync(join(data, 'queue.json'), JSON.stringify({ paused: false, items: [] }));
  return home;
}

/** A stand-in for a file another program holds: its reads fail with EBUSY for `ms` after the start (a preload). */
function holdStub(): string {
  const file = join(ROOT, 'hold-stub.mjs');
  writeFileSync(file, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const want = (process.env.HOLD_FILE || '').toLowerCase();
const until = Date.now() + Number(process.env.HOLD_MS || 8000);
const busy = p => want && String(p).replace(/\\//g, '\\\\').toLowerCase().endsWith(want) && Date.now() < until;
const err = p => Object.assign(new Error('EBUSY: resource busy or locked, open ' + p), { code: 'EBUSY', syscall: 'open', path: String(p) });
const orig = fs.promises.readFile;
fs.promises.readFile = function (p, ...a) { return busy(p) ? Promise.reject(err(p)) : orig.call(this, p, ...a); };
syncBuiltinESMExports();
`);
  return file;
}

interface Copy { said: () => string; exited: () => number | null; stop: () => Promise<void>; base: string }

function startCopy(home: string, extra: Record<string, string> = {}, preload?: string): Copy {
  const env = testEnv({
    TOMLIN_HOME: home, TOMLIN_PORT: String(PORT), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1',
    TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_OPEN: '', TOMLIN_UNINSTALL_KEY: 'none',
    TOMLIN_LOOK_IN: '', TOMLIN_RELEASE_API: 'http://127.0.0.1:8761', ...extra,
  });
  const args = [...(preload ? ['--import', pathToFileURL(preload).href] : []), fileURLToPath(new URL('../src/server.ts', import.meta.url))];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let said = '';
  let code: number | null = null;
  child.stdout.on('data', d => (said += d));
  child.stderr.on('data', d => (said += d));
  child.on('exit', c => (code = c ?? -1));
  return {
    said: () => said,
    exited: () => code,
    base: `http://127.0.0.1:${PORT}`,
    stop: async () => {
      if (code === null) child.kill();
      for (let i = 0; i < 50 && code === null; i++) await new Promise(r => setTimeout(r, 100));
    },
  };
}

/** Waits until the copy says it runs, or ends, or `ms` pass. */
async function settle(c: Copy, ms: number): Promise<'running' | 'ended' | 'neither'> {
  for (let t = 0; t < ms; t += 200) {
    if (c.said().includes('is running at')) return 'running';
    if (c.exited() !== null) return 'ended';
    await new Promise(r => setTimeout(r, 200));
  }
  return 'neither';
}

// ---- P0 ----

test('FR-01: a data file held by another program for a few seconds at start never leaves TOMLIN stuck on "getting ready" for ever', { timeout: 120_000 }, async t => {
  if (await portTaken()) return t.skip(`port ${PORT} is in use`);
  const home = makeHome();
  // queue.json is read after the start's fault catchers are in place: its read fails, and the start never finishes.
  const c = startCopy(home, { HOLD_FILE: '\\data\\queue.json', HOLD_MS: '8000' }, holdStub());
  try {
    const got = await settle(c, 60_000);
    // Either it starts (the file was let go after 8 s) or it ends with a plain reason; never a holding page for ever.
    assert.notEqual(got, 'neither', `After 60 s TOMLIN neither ran nor ended. It said:\n${c.said().slice(-800)}`);
  } finally {
    await c.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- P1 ----

test('FR-02: a settings, chats list or staff file held for a few seconds at start does not stop the start with a raw error', { timeout: 120_000 }, async t => {
  if (await portTaken()) return t.skip(`port ${PORT} is in use`);
  for (const f of ['\\data\\settings.json', '\\data\\chats\\index.json', '\\data\\staff.json']) {
    const home = makeHome();
    const c = startCopy(home, { HOLD_FILE: f, HOLD_MS: '8000' }, holdStub());
    try {
      const got = await settle(c, 60_000);
      assert.equal(got, 'running', `${f} held 8 s: ${c.said().slice(-600)}`);
      assert.doesNotMatch(c.said(), /\n\s+at \w/, 'no stack in the window');
    } finally {
      await c.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('FR-03: a damaged chats list (cut short) still lists the chats whose files are there', async () => {
  const { Store } = await import('../src/store.ts');
  const { Chats } = await import('../src/chats.ts');
  const home = makeHome();
  const data = join(home, 'data');
  const index = join(data, 'chats', 'index.json');
  const whole = readFileSync(index);
  writeFileSync(index, whole.subarray(0, whole.length >> 1));
  try {
    const store = new Store(data);
    const chats = new Chats(store);
    // As src/server/core.ts does at start.
    await chats.moveOld([]);
    const list = await chats.list();
    assert.ok(list.some(c => c.id === 'aaaaaaaaaaaa'), `the chat with two lines is not listed: ${JSON.stringify(list)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FR-04: one backup dated in the future (a clock that ran fast once) does not make the thinning keep only the newest real backup', async () => {
  const { keptByAge, keptBySize } = await import('../src/keep.ts');
  const MB = 2 ** 20;
  const real = [20, 21, 22, 23, 24, 25, 26].map(d => ({ name: `2026-11-${d} 101500 before 2.1.${d}.zip`, at: 0, bytes: 40 * MB }));
  const all = [{ name: '2027-11-30 101500 by hand.zip', at: 0, bytes: 20 * 1024 }, ...real];
  const now = new Date(2026, 10, 27, 12);
  const kept = keptBySize(all, keptByAge(all, now), 1e12);
  const keptReal = real.filter(b => kept.has(b.name)).length;
  const normal = keptBySize(real, keptByAge(real, now), 1e12).size;
  assert.ok(keptReal >= normal, `kept ${keptReal} real backups with the future one there, ${normal} without it`);
});

test('FR-05: offline, a Hugging Face look-up says in plain words that Hugging Face could not be reached and what to do', async () => {
  const { lookUpHf } = await import('../src/download.ts');
  const real = globalThis.fetch;
  // No network: what Node says when the PC is offline. Nothing leaves this PC.
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  try {
    await assert.rejects(lookUpHf('https://huggingface.co/someone/some-model-GGUF'), (e: Error) => {
      assert.doesNotMatch(e.message, /^fetch failed$/, 'Node\'s own words reach the page');
      assert.match(e.message, /Hugging Face/);
      assert.match(e.message, /internet|connection|online/i);
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

test('FR-06: after a damaged staff file is set aside, the chats are not all shown as "left the team" (one Clear would delete them all)', { timeout: 120_000 }, async t => {
  if (await portTaken()) return t.skip(`port ${PORT} is in use`);
  const home = makeHome();
  const staffFile = join(home, 'data', 'staff.json');
  const whole = readFileSync(staffFile);
  writeFileSync(staffFile, whole.subarray(0, whole.length >> 1));
  const c = startCopy(home);
  try {
    assert.equal(await settle(c, 60_000), 'running', c.said().slice(-600));
    const view = (await (await fetch(`${c.base}/api/chats`)).json()) as { chats: Array<{ id: string; left?: boolean }> };
    assert.ok(!view.chats.some(x => x.left), `chats marked as with someone who left: ${JSON.stringify(view.chats)}`);
  } finally {
    await c.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- P2 ----

test('FR-07: standing rules sent with text that is not words (null, a list) are refused, not saved as empty', async () => {
  const { loadRules, saveRules, getRules, DEFAULT_RULES } = await import('../src/rules.ts');
  const dir = mkdtempSync(join(ROOT, 'rules-'));
  try {
    await loadRules(dir);
    assert.equal(getRules().text, DEFAULT_RULES);
    let after = '';
    try {
      after = (await saveRules(dir, { text: null })).text;
    } catch {
      after = getRules().text;
    }
    assert.equal(after, DEFAULT_RULES, 'the standing rules were wiped by a body whose text was null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-08: a version file saved with a byte-order mark is still read (its data version is not lost)', async () => {
  const { readVersion } = await import('../src/keep.ts');
  const home = mkdtempSync(join(ROOT, 'ver-'));
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data', 'version.json'), `﻿${JSON.stringify({ data: 2, app: '9.0.0' })}`);
  try {
    const v = readVersion({ home, data: join(home, 'data'), models: '', runtime: '', backups: '', modelsFile: '' });
    assert.equal(v?.data, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FR-09: a chats list of the wrong shape is set aside, not replaced by an empty list at the next save', async () => {
  const { Store } = await import('../src/store.ts');
  const { Chats } = await import('../src/chats.ts');
  const home = makeHome();
  const data = join(home, 'data');
  const index = join(data, 'chats', 'index.json');
  const odd = JSON.stringify({ chats: JSON.parse(readFileSync(index, 'utf8')) });
  writeFileSync(index, odd);
  try {
    const chats = new Chats(new Store(data));
    await chats.moveOld([]);
    await chats.create('staff:sam');
    const kept = readFileSync(index, 'utf8') === odd || (await import('node:fs')).readdirSync(join(data, 'chats')).some(n => n.startsWith('index.json.damaged'));
    assert.ok(kept, 'the chats list was written over and no copy of it was kept');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
