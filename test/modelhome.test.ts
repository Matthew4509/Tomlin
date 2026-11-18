// Where models are kept: the chosen folder, the drives, the "another drive has room" words, and moving models with a
// loaded one left where it is. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsHome, SPARE, byDrive, driveOf, drivesFrom, filesToMove, lettersFrom, moveModels, moveSaid, otherDriveHint, sameDrives, wholeDrive, type Drive } from '../src/modelhome.ts';
import { Models } from '../src/models.ts';
import { Registry } from '../src/registry.ts';

const GB = 2 ** 30;
const temp = () => mkdtemp(join(tmpdir(), 'tomlin-where-'));
const put = async (file: string, text: string) => {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
};

test('the folder models are kept in: the usual one until another is chosen, and the one before is still read', async () => {
  const dir = await temp();
  try {
    const usual = join(dir, 'home', 'models');
    const file = join(dir, 'home', 'models-home.txt');
    await mkdir(usual, { recursive: true });
    const home = new ModelsHome(file, usual);
    assert.equal(home.dir(), usual);
    assert.equal(home.chosen(), null);
    assert.deepEqual(home.others(), []);
    assert.equal(home.missing(), null);
    const d = join(dir, 'drive d', 'TOMLIN models');
    await mkdir(d, { recursive: true });
    home.set(d);
    // Read again from the file, as the next start does.
    const again = new ModelsHome(file, usual);
    assert.equal(again.dir(), d);
    assert.deepEqual(again.others(), [usual], 'the usual folder is still read for the models in it');
    const e = join(dir, 'drive e', 'models');
    await mkdir(e, { recursive: true });
    again.set(e);
    assert.equal(again.dir(), e);
    assert.deepEqual(again.others(), [usual, d]);
    // Back to a folder used before: it is the chosen one, not also an earlier one.
    again.set(d);
    assert.deepEqual(again.others(), [usual, e]);
    again.forget(e);
    assert.deepEqual(again.others(), [usual]);
    // The usual folder again: nothing chosen, and the folder left is still read.
    again.set(null);
    assert.equal(again.chosen(), null);
    assert.equal(again.dir(), usual);
    assert.deepEqual(again.others(), [d]);
    again.forget(d);
    assert.equal(existsSync(file), false, 'nothing chosen and nothing earlier: no file is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chosen folder whose drive is not there now is named as missing, and found again when it is back', async () => {
  const dir = await temp();
  try {
    const usual = join(dir, 'models');
    const usb = join(dir, 'usb', 'models');
    await mkdir(usb, { recursive: true });
    const home = new ModelsHome(join(dir, 'models-home.txt'), usual);
    home.set(usb);
    assert.equal(home.missing(), null);
    await rm(join(dir, 'usb'), { recursive: true, force: true });
    assert.equal(home.missing(), usb);
    assert.equal(home.dir(), usb, 'the choice is kept while the drive is away');
    await mkdir(usb, { recursive: true });
    assert.equal(home.missing(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('drives: a letter is read from a path, a whole drive is told from a folder, and Windows\' list is read', () => {
  assert.equal(driveOf('d:\\TOMLIN models\\chat\\a.gguf'), 'D:');
  assert.equal(driveOf('C:\\'), 'C:');
  assert.ok(wholeDrive('D:\\') && wholeDrive('d:') && wholeDrive('\\\\nas\\share'));
  assert.ok(!wholeDrive('D:\\Models') && !wholeDrive('\\\\nas\\share\\models'));
  const list = drivesFrom(JSON.stringify([
    { d: 'D', l: 'New Volume', t: 'Fixed', x: 'NTFS', s: 2000 * GB, f: 1600 * GB },
    { d: 'C', l: '', t: 'Fixed', x: 'NTFS', s: 476 * GB, f: 2 * GB },
    { d: 'E', l: 'STICK', t: 'Removable', x: 'FAT32', s: 32 * GB, f: 30 * GB },
    { d: 'G', l: '', t: 'CD-ROM', x: '', s: 0, f: 0 },
  ]));
  assert.deepEqual(list.map(d => [d.drive, d.removable, d.fs]), [['C:', false, 'NTFS'], ['D:', false, 'NTFS'], ['E:', true, 'FAT32']]);
  // One drive comes back as one object, not a list; and nonsense is no drives.
  assert.deepEqual(drivesFrom(JSON.stringify({ d: 'C', l: '', t: 'Fixed', x: 'NTFS', s: 10, f: 5 })).map(d => d.drive), ['C:']);
  assert.deepEqual(drivesFrom('not json'), []);
});

test('a full drive names another drive that has room, and none when none has', () => {
  const all: Drive[] = [
    { drive: 'C:', label: '', removable: false, fs: 'NTFS', free: 2 * GB, total: 476 * GB },
    { drive: 'D:', label: 'New Volume', removable: false, fs: 'NTFS', free: 1600 * GB, total: 2000 * GB },
    { drive: 'E:', label: '', removable: true, fs: 'exFAT', free: 30 * GB, total: 32 * GB },
  ];
  const said = otherDriveHint(12 * GB, 'C:\\Users\\me\\TOMLIN\\models\\chat', all);
  assert.match(said, /keep your models on another drive: D: \(New Volume\) has 1600\.0 GB free/);
  assert.match(said, /Where models are kept/);
  assert.equal(otherDriveHint(12 * GB, 'D:\\models', all), ' Or keep your models on another drive: E: has 30.0 GB free. Choose it under Models, Import models, Where models are kept.');
  assert.equal(otherDriveHint(5000 * GB, 'C:\\models', all), '', 'no drive has that much room');
  assert.equal(otherDriveHint(1 * GB, 'C:\\models', []), '');
});

test('the models on this PC are listed by the drive each is on', () => {
  const all: Drive[] = [{ drive: 'D:', label: 'Big', removable: false, fs: 'NTFS', free: 9 * GB, total: 10 * GB }];
  const rows = byDrive([
    { name: 'a', path: 'C:\\h\\models\\chat\\a.gguf', bytes: 1 },
    { name: 'b', path: 'd:\\m\\chat\\b.gguf', bytes: 2 },
    { name: 'c', path: 'D:\\m\\image\\c.gguf', bytes: 3 },
  ], all);
  assert.deepEqual(rows.map(r => [r.drive, r.bytes, r.models.map(m => m.name), r.free]), [['C:', 1, ['a'], null], ['D:', 5, ['b', 'c'], 9 * GB]]);
});

test('moving models: every file keeps its place, a half download stays, and what is already there is not copied twice', async () => {
  const dir = await temp();
  try {
    const from = join(dir, 'old');
    const to = join(dir, 'new');
    await put(join(from, 'chat', 'a.gguf'), 'aaaa');
    await put(join(from, 'chat', 'pub', 'm', 'b.gguf'), 'bb');
    await put(join(from, 'chat', 'c.gguf.part'), 'half');
    await put(join(from, 'image', 'sdxl.safetensors'), 'sdxl');
    await put(join(from, 'image', 'loras', 'lcm.safetensors'), 'l');
    await put(join(from, 'helpers', 'u2net.onnx'), 'u');
    await put(join(from, 'chat', 'same.gguf'), 'same');
    await put(join(to, 'chat', 'same.gguf'), 'same');
    await put(join(from, 'chat', 'clash.gguf'), 'one size');
    await put(join(to, 'chat', 'clash.gguf'), 'another size here');
    assert.equal(filesToMove([from]).length, 7, 'the half download is not a model file');
    const s = await moveModels([from], to);
    assert.equal(s.state, 'done');
    assert.equal(s.moved, 6);
    for (const rel of [['chat', 'a.gguf'], ['chat', 'pub', 'm', 'b.gguf'], ['image', 'sdxl.safetensors'], ['image', 'loras', 'lcm.safetensors'], ['helpers', 'u2net.onnx'], ['chat', 'same.gguf']]) {
      assert.ok(existsSync(join(to, ...rel)), rel.join('/'));
      assert.ok(!existsSync(join(from, ...rel)), `${rel.join('/')} left behind`);
    }
    assert.ok(existsSync(join(from, 'chat', 'c.gguf.part')), 'the half download stays where it was');
    assert.equal(readFileSync(join(to, 'chat', 'clash.gguf'), 'utf8'), 'another size here', 'a different file of the same name is never written over');
    assert.ok(existsSync(join(from, 'chat', 'clash.gguf')));
    assert.deepEqual(s.skipped, [{ name: 'clash.gguf', why: 'a different file of that name is already in the new folder' }]);
    assert.match(s.said, /^Moved 6 model files \(.* to /);
    assert.match(s.said, /clash\.gguf was not moved: a different file of that name/);
    // Again: nothing left to move but the clash.
    const again = await moveModels([from], to);
    assert.equal(again.moved, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a model in use is not moved and is named; all the others are moved', async () => {
  const dir = await temp();
  try {
    const from = join(dir, 'old');
    const to = join(dir, 'new');
    await put(join(from, 'chat', 'loaded.gguf'), 'loaded');
    await put(join(from, 'chat', 'idle.gguf'), 'idle');
    await put(join(from, 'image', 'pic.gguf'), 'pic');
    const busy = join(from, 'chat', 'loaded.gguf').toLowerCase();
    const s = await moveModels([from], to, { inUse: p => p.toLowerCase() === busy });
    assert.equal(s.moved, 2);
    assert.ok(existsSync(join(from, 'chat', 'loaded.gguf')), 'the loaded model stays where it is');
    assert.ok(!existsSync(join(to, 'chat', 'loaded.gguf')));
    assert.ok(existsSync(join(to, 'chat', 'idle.gguf')) && existsSync(join(to, 'image', 'pic.gguf')));
    assert.deepEqual(s.skipped, [{ name: 'loaded.gguf', why: 'it is in use' }]);
    assert.match(s.said, /loaded\.gguf could not be moved as it is in use; all others are now moved to the new location\./);
    // Dropped, then Move again: it follows.
    const again = await moveModels([from], to);
    assert.equal(again.moved, 1);
    assert.ok(existsSync(join(to, 'chat', 'loaded.gguf')));
    assert.equal(filesToMove([from]).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('to another drive a file is copied, checked and only then removed; no room or a stop leaves it where it was', async () => {
  const dir = await temp();
  try {
    const from = join(dir, 'old');
    const to = join(dir, 'new');
    const big = 'x'.repeat(200_000);
    await put(join(from, 'chat', 'a.gguf'), big);
    await put(join(from, 'chat', 'b.gguf'), 'bb');
    // As Windows answers a rename to another drive.
    const otherDrive = async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    };
    // No room for the big one: it stays, the small one goes.
    const tight = await moveModels([from], to, { rename: otherDrive, free: async () => SPARE + 1000 });
    assert.deepEqual(tight.skipped.map(x => x.name), ['a.gguf']);
    assert.match(tight.skipped[0].why, /there is not enough free space on /);
    assert.ok(existsSync(join(from, 'chat', 'a.gguf')) && !existsSync(join(to, 'chat', 'a.gguf')) && !existsSync(join(to, 'chat', 'a.gguf.part')));
    assert.ok(existsSync(join(to, 'chat', 'b.gguf')) && !existsSync(join(from, 'chat', 'b.gguf')));
    // Stopped before it starts: nothing moves, nothing is lost.
    const ac = new AbortController();
    ac.abort();
    const stopped = await moveModels([from], to, { rename: otherDrive, free: async () => 100 * GB, signal: ac.signal });
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.moved, 0);
    assert.ok(existsSync(join(from, 'chat', 'a.gguf')));
    // With room: copied whole, and gone from where it was.
    const s = await moveModels([from], to, { rename: otherDrive, free: async () => 100 * GB });
    assert.equal(s.moved, 1);
    assert.equal(s.got, big.length);
    assert.equal(await readFile(join(to, 'chat', 'a.gguf'), 'utf8'), big);
    assert.ok(!existsSync(join(from, 'chat', 'a.gguf')) && !existsSync(join(to, 'chat', 'a.gguf.part')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('what a move did is said in plain words', () => {
  const base = { state: 'done' as const, to: 'D:\\TOMLIN models', got: 3 * GB, bytes: 3 * GB, moved: 0, now: '', skipped: [], said: '' };
  assert.equal(moveSaid(base), 'There was nothing to move: your models are in D:\\TOMLIN models already.');
  assert.equal(moveSaid({ ...base, moved: 2 }), 'Moved 2 model files (3.0 GB) to D:\\TOMLIN models.');
  assert.match(moveSaid({ ...base, skipped: [{ name: 'x.gguf', why: 'it is in use' }] }), /^No model file was moved\. x\.gguf could not be moved as it is in use\. Press Drop/);
  assert.match(moveSaid({ ...base, moved: 1, skipped: [{ name: 'x.gguf', why: 'it is in use' }, { name: 'y.gguf', why: 'it is in use' }] }), /x\.gguf, y\.gguf could not be moved as they are in use; all others are now moved to the new location\./);
  assert.match(moveSaid({ ...base, state: 'stopped', moved: 1 }), /^Stopped\. Press Move again to carry on\. Moved 1 model file /);
});

test('after another folder is chosen, the models in the folder before are still listed and found, and a download goes to the new one', async () => {
  const dir = await temp();
  try {
    const usual = join(dir, 'home', 'models');
    const chosen = join(dir, 'd', 'TOMLIN models');
    await put(join(usual, 'chat', 'old.gguf'), 'old');
    await mkdir(chosen, { recursive: true });
    const home = new ModelsHome(join(dir, 'home', 'models-home.txt'), usual);
    const models = new Models(join(home.dir(), 'chat'), join(dir, 'home', 'models-folder.txt'), undefined, null);
    models.copies = () => home.others().map(d => join(d, 'chat'));
    assert.equal(models.target('new.gguf'), join(usual, 'chat', 'new.gguf'));
    home.set(chosen);
    models.setOwn(join(home.dir(), 'chat'));
    assert.equal(models.target('new.gguf'), join(chosen, 'chat', 'new.gguf'), 'a download goes to the chosen folder');
    assert.deepEqual(models.list().map(m => [m.id, m.where]), [['old.gguf', 'own']], 'the model left in the usual folder keeps its id');
    assert.equal(models.path('old.gguf'), join(usual, 'chat', 'old.gguf'));
    // Moved: the same id, in the new place.
    await moveModels(home.others(), home.dir());
    models.forget();
    assert.equal(models.path('old.gguf'), join(chosen, 'chat', 'old.gguf'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a picture model\'s files are found in the folder before, and its download goes to the chosen one', async () => {
  const dir = await temp();
  try {
    const reg = join(dir, 'registry');
    await put(join(reg, 'm.json'), JSON.stringify({ id: 'm', kind: 'image', name: 'M', about: '', licence: '', quant: '', minRamGB: 1, minVramGB: 1, files: [{ role: 'model', path: 'm.gguf', bytes: 5, sha256: 'x' }, { role: 'lora', path: 'l.safetensors', bytes: 2, sha256: 'y' }] }));
    const usual = join(dir, 'models');
    const chosen = join(dir, 'd', 'models');
    await put(join(usual, 'image', 'm.gguf'), '12345');
    await put(join(usual, 'image', 'loras', 'l.safetensors'), '12');
    const r = new Registry(reg, usual);
    const m = r.get('m')!;
    assert.ok(r.installed(m));
    r.dir = chosen;
    r.copies = () => [usual];
    assert.ok(r.installed(m), 'still installed: used from the folder before');
    assert.equal(r.filePath(m, m.files[0]), join(usual, 'image', 'm.gguf'));
    assert.equal(r.ownPath(m, m.files[0]), join(chosen, 'image', 'm.gguf'));
    await moveModels([usual], chosen);
    assert.equal(r.filePath(m, m.files[0]), join(chosen, 'image', 'm.gguf'));
    assert.equal(r.filePath(m, m.files[1]), join(chosen, 'image', 'loras', 'l.safetensors'));
    assert.ok(r.installed(m));
    // A missing models folder is said before any download starts.
    r.noHome = () => 'Your models are kept in E:\\m, and that folder is not there now.';
    await assert.rejects(r.start('m'), /that folder is not there now/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the server and the page are joined up: the routes, the folder put to use at once, and the page\'s parts', async () => {
  const read = (rel: string) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
  const server = await read('src/server/modelhome.ts');
  for (const path of ["'/api/models/where'", "'/api/models/move'", "'/api/models/move/stop'"]) assert.ok(server.includes(path), path);
  assert.match(server, /chatModels\.setOwn\(join\(dir, 'chat'\)\)/);
  assert.match(server, /images\.registry\.dir = dir/);
  assert.match(server, /inUse: p => inUseNow\(\)\.has/);
  assert.match(await read('src/server.ts'), /modelHomeGet\)[\s\S]*modelHomePost\)/);
  const core = await read('src/server/core.ts');
  assert.match(core, /new Models\(join\(modelsHome\.dir\(\), 'chat'\)/);
  assert.match(core, /\.\.\.modelsHome\.others\(\)\]\.map\(d => join\(d, 'chat'\)\)/);
  assert.match(await read('src/server/panes.ts'), /images\.registry\.copies = \(\) => \[\.\.\.cachedCopies\(\), \.\.\.modelsHome\.others\(\)/);
  assert.match(await read('src/server/hf.ts'), /otherDriveHint\(m\.bytes, chatModels\.own/);
  const html = await read('public/index.html');
  for (const id of ['mp-where-form', 'mp-where-now', 'mp-where-usual', 'mp-where-line', 'mp-move-box', 'mp-move-go', 'mp-move-stop', 'mp-move-line', 'mp-drives']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<h4 id="mp-tile-where">Where models are kept<\/h4>/);
  const page = await read('public/models.js');
  assert.match(page, /api\('\/api\/models\/where'\)/);
  assert.match(page, /mpWhereAsk\('\/api\/models\/move', \{\}\)/);
  assert.match(page, /USB drive/);
  assert.match(page, /new downloads go here/);
});

// A linked PC's hello read the drives once a minute with a PowerShell (about 400 ms of CPU and 30 MB each time): the free
// space is read again without one while Windows has the same letters (from fsutil), and all of it when they change.
test('the drive letters come from fsutil, and a drive added or taken out is a change while a network drive is not', () => {
  const letters = lettersFrom('\r\nDrives: C:\\ D:\\ z:\\ \r\n');
  assert.deepEqual([...letters], ['C:', 'D:', 'Z:']);
  const list: Drive[] = [{ drive: 'C:', label: '', removable: false, fs: 'NTFS', free: 1, total: 2 }, { drive: 'D:', label: '', removable: false, fs: 'NTFS', free: 1, total: 2 }];
  // Z: was a network drive at the last whole reading: left aside.
  assert.equal(sameDrives(letters, new Set(['Z:']), list), true);
  assert.equal(sameDrives(letters, new Set(), list), false);
  assert.equal(sameDrives(lettersFrom('Drives: C:\\ Z:\\'), new Set(['Z:']), list), false);
  assert.equal(sameDrives(lettersFrom('Drives: C:\\ D:\\ E:\\ Z:\\'), new Set(['Z:']), list), false);
});