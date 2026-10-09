import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as keep from '../src/keep.ts';
import { PIN_FILE, Runtimes, pinKey, type RuntimePin } from '../src/runtimes.ts';

const PINS = { runtimes: { 'llama-cpu': { parts: [{ sha256: 'a' }] }, 'llama-cuda': { parts: [{ sha256: 'c1' }, { sha256: 'c2' }] } } };

async function put(file: string, text: string) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}

/** parent/{old, new} copies and a home beside them. */
async function world(oldPins: object = PINS) {
  const top = await mkdtemp(join(tmpdir(), 'sm-keep-'));
  const parent = join(top, 'apps');
  const root = join(parent, 'tomlin-2.0.27');
  const old = join(parent, 'shelby-2.0.25');
  await put(join(root, 'package.json'), JSON.stringify({ name: 'tomlin', version: '2.0.27' }));
  await put(join(root, 'runtimes.json'), JSON.stringify(PINS));
  await put(join(old, 'package.json'), JSON.stringify({ name: 'shelby', version: '2.0.25' }));
  await put(join(old, 'runtimes.json'), JSON.stringify(oldPins));
  await put(join(old, 'data', 'settings.json'), '{"managerName":"Ann"}');
  await put(join(old, 'data', 'chats', 'c1.json'), '[]');
  await put(join(old, 'data', 'chats', 'index.json'), '[]');
  await put(join(old, 'data', 'runners.json'), '[{"pid":1}]');
  await put(join(old, 'models', 'chat', 'org', 'qwen.gguf'), 'GGUF');
  await put(join(old, 'models', 'image', 'rv.safetensors'), 'PIC');
  await put(join(old, 'runtime', 'llama-cuda', 'llama-server.exe'), 'exe');
  await put(join(old, 'runtime', 'llama-cpu', 'llama-server.exe'), 'exe');
  await put(join(old, 'models-folder.txt'), 'D:\\LM\r\n');
  // Not a copy of TOMLIN: never offered.
  await put(join(parent, 'other-app', 'package.json'), JSON.stringify({ name: 'other' }));
  await put(join(parent, 'other-app', 'data', 'settings.json'), '{}');
  const home = keep.resolveHome({ TOMLIN_HOME: join(top, 'TOMLIN') });
  return { top, root, old, home };
}

test('the home: TOMLIN_HOME; else the folder around TOMLIN_DATA (a test copy); else "TOMLIN" in the user folder ("Smart Manager" when only that one holds data)', () => {
  const a = keep.resolveHome({ TOMLIN_HOME: 'C:\\h' });
  assert.equal(a.data, 'C:\\h\\data');
  assert.equal(a.models, 'C:\\h\\models');
  assert.equal(a.modelsFile, 'C:\\h\\models-folder.txt');
  const b = keep.resolveHome({ TOMLIN_DATA: 'C:\\scratch\\sm-a\\data' });
  assert.equal(b.home, 'C:\\scratch\\sm-a');
  assert.equal(b.data, 'C:\\scratch\\sm-a\\data');
  assert.match(keep.resolveHome({}).home, /\\(TOMLIN|Smart Manager)$/);
  const user = mkdtempSync(join(tmpdir(), 'sm-user-'));
  try {
    assert.equal(keep.defaultHome(user), join(user, 'TOMLIN'));
    // A PC set up before the TOMLIN name keeps its home where its data is: nothing is moved.
    mkdirSync(join(user, 'Smart Manager', 'data'), { recursive: true });
    assert.equal(keep.defaultHome(user), join(user, 'Smart Manager'));
    // Once TOMLIN holds data, it is the home.
    mkdirSync(join(user, 'TOMLIN', 'data'), { recursive: true });
    assert.equal(keep.defaultHome(user), join(user, 'TOMLIN'));
  } finally {
    rmSync(user, { recursive: true, force: true });
  }
});

test('an empty home with an older copy beside it asks once; "Start empty" ends the question', async () => {
  const w = await world();
  try {
    const r = await keep.prepare(w.home, w.root, '2.0.27');
    assert.equal(r.state, 'offer');
    assert.deepEqual(r.state === 'offer' && r.sources.map(s => [s.version, s.chats]), [['2.0.25', 1]]);
    // The page opened before the answer writes settings: the question is still asked at the next start.
    await put(join(w.home.data, 'settings.json'), '{}');
    assert.equal((await keep.prepare(w.home, w.root, '2.0.27')).state, 'offer');
    await keep.startEmpty(w.home, '2.0.27');
    assert.equal((await keep.prepare(w.home, w.root, '2.0.27')).state, 'ready');
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('import: data copied (the old folder keeps its own), models and same-pinned runners moved, startup re-pointed', async () => {
  const w = await world();
  try {
    await keep.prepare(w.home, w.root, '2.0.27');
    let repointed = '';
    await keep.planNext(w.home, { do: 'bring-in', from: w.old });
    const r = await keep.prepare(w.home, w.root, '2.0.27', { repoint: async from => ((repointed = from), true) });
    assert.equal(r.state, 'ready');
    assert.equal(await readFile(join(w.home.data, 'settings.json'), 'utf8'), '{"managerName":"Ann"}');
    assert.ok(existsSync(join(w.home.data, 'chats', 'c1.json')));
    assert.ok(existsSync(join(w.old, 'data', 'chats', 'c1.json')), 'the old copy keeps its data');
    assert.ok(!existsSync(join(w.home.data, 'runners.json')), 'live process numbers are not imported');
    assert.equal(await readFile(join(w.home.models, 'chat', 'org', 'qwen.gguf'), 'utf8'), 'GGUF');
    assert.ok(!existsSync(join(w.old, 'models', 'chat', 'org', 'qwen.gguf')), 'moved, not copied');
    assert.ok(existsSync(join(w.home.models, 'image', 'rv.safetensors')));
    assert.ok(existsSync(join(w.home.runtime, 'llama-cuda', 'llama-server.exe')));
    assert.ok(existsSync(join(w.old, 'runtime', 'llama-cpu')), 'a runner every zip ships stays');
    assert.equal(await readFile(w.home.modelsFile, 'utf8'), 'D:\\LM\r\n');
    assert.equal(repointed, w.old);
    assert.match(r.state === 'ready' ? r.note ?? '' : '', /Imported .* from TOMLIN 2\.0\.25 .*Moved 2 model files .* and 1 graphics-card runner.*Starting with Windows now starts this copy\./);
    // The moved runner counts as downloaded for this version (its pin is written beside it).
    const rt = new Runtimes(join(w.root, 'runtime'), join(w.root, 'runtimes.json'), w.home.runtime);
    assert.equal(rt.exe('llama', 'cuda'), join(w.home.runtime, 'llama-cuda', 'llama-server.exe'));
    // The question is not asked again, and the note is cleared once shown.
    assert.equal((await keep.prepare(w.home, w.root, '2.0.27')).state, 'ready');
    await keep.noteShown(w.home);
    assert.equal(keep.readVersion(w.home)?.note, undefined);
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('a runner pinned differently by the older copy is not moved, and a kept build with another pin is not used', async () => {
  const w = await world({ runtimes: { 'llama-cuda': { parts: [{ sha256: 'old' }] } } });
  try {
    await keep.prepare(w.home, w.root, '2.0.27');
    await keep.bringIn(w.home, w.root, w.old, '2.0.27');
    assert.ok(!existsSync(join(w.home.runtime, 'llama-cuda')));
    assert.ok(existsSync(join(w.old, 'runtime', 'llama-cuda', 'llama-server.exe')));
    await put(join(w.home.runtime, 'llama-cuda', 'llama-server.exe'), 'exe');
    await put(join(w.home.runtime, 'llama-cuda', PIN_FILE), pinKey({ parts: [{ sha256: 'old' }] } as unknown as RuntimePin));
    const rt = new Runtimes(join(w.root, 'runtime'), join(w.root, 'runtimes.json'), w.home.runtime);
    assert.equal(rt.exe('llama', 'cuda'), null);
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('data already in the home (a test copy) is adopted without a question, after a backup; a new version backs it up first', async () => {
  const w = await world();
  try {
    await put(join(w.home.data, 'settings.json'), '{"x":1}');
    assert.equal((await keep.prepare(w.home, w.root, '2.0.27')).state, 'ready');
    // Data with no version file (a test copy, or the file lost) is kept before it is used.
    assert.deepEqual((await keep.listBackups(w.home)).map(b => b.name.replace(/^\S+ \S+ /, '')), ['before 2.0.27.zip']);
    const r = await keep.prepare(w.home, w.root, '2.0.28');
    assert.equal(r.state, 'ready');
    const backups = await keep.listBackups(w.home);
    assert.equal(backups.length, 2);
    assert.match(backups[0].name, /before 2\.0\.28\.zip$/);
    assert.equal(r.state === 'ready' ? r.noteTitle : '', 'Update Successful!');
    assert.equal(r.state === 'ready' ? r.note : '', `You have successfully updated to TOMLIN 2.0.28.\nYour former account data was backed up as: ${backups[0].name.replace(/\.zip$/, '')}`);
    assert.equal(keep.readVersion(w.home)?.app, '2.0.28');
    // The note and its heading go together once the page has shown them.
    await keep.noteShown(w.home);
    assert.equal(keep.readVersion(w.home)?.noteTitle, undefined);
    // Starting an older copy again is not called an update.
    const back = await keep.prepare(w.home, w.root, '2.0.27');
    assert.equal(back.state === 'ready' ? back.noteTitle : 'x', undefined);
    assert.match(back.state === 'ready' ? back.note ?? '' : '', /TOMLIN 2\.0\.27 is using your data for the first time; the data as 2\.0\.28 left it/);
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('newer compares versions number by number', () => {
  assert.equal(keep.newer('2.0.29', '2.0.28'), true);
  assert.equal(keep.newer('2.0.29', '2.0.3'), true);
  assert.equal(keep.newer('2.1.0', '2.0.99'), true);
  assert.equal(keep.newer('2.0.28', '2.0.29'), false);
  assert.equal(keep.newer('2.0.29', '2.0.29'), false);
});

test('backups keep the last 5; a restore puts the data back and backs up what was there', async () => {
  const w = await world();
  try {
    await put(join(w.home.data, 'settings.json'), '{"v":"first"}');
    await keep.prepare(w.home, w.root, '2.0.27');
    const first = await keep.backup(w.home, 'by hand');
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 1100));
      await keep.backup(w.home, `n${i}`);
    }
    const names = (await readdir(w.home.backups)).sort();
    assert.equal(names.length, 5);
    assert.ok(!names.includes(first), 'the oldest went');
    await put(join(w.home.data, 'settings.json'), '{"v":"second"}');
    const keepName = names[0];
    await keep.planNext(w.home, { do: 'restore', name: keepName });
    // The restored backup came from the "first" data.
    await keep.prepare(w.home, w.root, '2.0.27');
    assert.equal(await readFile(join(w.home.data, 'settings.json'), 'utf8'), '{"v":"first"}');
    assert.ok((await keep.listBackups(w.home)).some(b => b.name.includes('before restoring')));
    assert.match(keep.readVersion(w.home)?.note ?? '', /Restored the backup/);
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('data changed by a newer version is refused, not misread', async () => {
  const w = await world();
  try {
    await put(join(w.home.data, 'settings.json'), '{}');
    await keep.writeVersion(w.home, { data: keep.DATA_VERSION + 1, app: '2.1.0' });
    assert.deepEqual(await keep.prepare(w.home, w.root, '2.0.27'), { state: 'too-new', app: '2.1.0' });
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('an import from a folder that is not offered does nothing', async () => {
  const w = await world();
  try {
    await keep.prepare(w.home, w.root, '2.0.27');
    const note = await keep.bringIn(w.home, w.root, join(w.top, 'apps', 'other-app'), '2.0.27');
    assert.match(note, /Nothing was imported/);
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('a data backup leaves out the Bridge snapshot browser profile (a locked file there failed every backup) and keeps the rest', async () => {
  const top = await mkdtemp(join(tmpdir(), 'sm-keep-snaps-'));
  try {
    const home = keep.resolveHome({ TOMLIN_HOME: join(top, 'TOMLIN') });
    const put = async (file: string, text: string) => {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, text);
    };
    await put(join(home.data, 'settings.json'), '{}');
    await put(join(home.data, 'bridge', 'snaps', 'site-1.png'), 'PNG');
    await put(join(home.data, 'bridge', 'snaps', 'profile', 'Default', 'Affiliation Database'), 'browser');
    const name = await keep.backup(home, 'before test');
    const { execFileSync } = await import('node:child_process');
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
    const listed = execFileSync(tar, ['-t', '-f', join(home.backups, name)], { encoding: 'utf8' });
    assert.match(listed, /settings\.json/);
    assert.match(listed, /bridge\/snaps\/site-1\.png/);
    assert.doesNotMatch(listed, /snaps\/profile/);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});
