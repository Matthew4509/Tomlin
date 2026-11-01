// Faults that made no sound, from an outside audit: backups that lost or skipped files and still said all was well, a
// backup reading through a link, notification settings that were not what they seemed, and a stopped answer coming back.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateData } from '../src/atomic.ts';
import { Notifier } from '../src/notify.ts';
import { newRid, Outbox, type Follower, type Lock } from '../src/outbox.ts';
import { doneSignatures, hashFiles, keyOf, namesOf, projectFiles, unreadWords } from '../src/projectbackup.ts';

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const inDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-silent-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};

// ---- Two projects, one folder in the backup ----

test('two projects whose names only differ in characters a backup cannot use keep a folder each', () => {
  const dirs = ['C:\\Work\\Client @', 'C:\\Work\\Client #', 'C:\\Work\\client !'];
  const names = dirs.map(d => namesOf(dirs).get(keyOf(d))!);
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 3, names.join(', '));
  assert.ok(names.every(n => n.startsWith('Client -') || n.startsWith('client -')), names.join(', '));
  assert.deepEqual(dirs.map(d => namesOf([...dirs].reverse()).get(keyOf(d))), names, 'the same project always gets the same name');

  const other = ['C:\\A\\\u9879\u76ee', 'C:\\A\\\u4f5c\u54c1'];
  assert.equal(new Set(other.map(d => namesOf(other).get(keyOf(d)))).size, 2, 'two names with no plain letters at all');
});

test('a project with a name of its own keeps it', () => {
  const dirs = ['C:\\Work\\shop', 'C:\\Work\\Client @', 'C:\\Work\\blog'];
  assert.deepEqual(dirs.map(d => namesOf(dirs).get(keyOf(d))), ['shop', 'Client -', 'blog']);
});

// ---- A file that cannot be read ----

const FILE = { path: 'Bridge projects/shop/a.db', full: 'C:\\made-up\\a.db', bytes: 9, mtime: 2000 };
const fails = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };

test('a file that cannot be read is named, never quietly dropped, and is read again next time', async () => {
  const never = await hashFiles([FILE], {}, fails('EACCES'));
  assert.deepEqual(never.unread, [FILE.path]);
  assert.deepEqual(never.out, [], 'no copy of it exists to keep');
  assert.deepEqual(never.now, {});

  const last = { bytes: 5, mtime: 1000, id: 'a'.repeat(40) };
  const had = await hashFiles([FILE], { [FILE.path]: last }, fails('EBUSY'));
  assert.deepEqual(had.unread, [FILE.path]);
  assert.deepEqual(had.out.map(f => f.id), [last.id], 'the last good copy stays in the backup');
  assert.deepEqual(had.now[FILE.path], last, 'still the old size and time, so it is read again next time');
});

test('a file deleted since it was listed is simply gone, and an unchanged one is not read', async () => {
  const gone = await hashFiles([FILE], { [FILE.path]: { bytes: 5, mtime: 1000, id: 'a'.repeat(40) } }, fails('ENOENT'));
  assert.deepEqual([gone.out, gone.unread, gone.now], [[], [], {}]);

  const same = await hashFiles([FILE], { [FILE.path]: { bytes: 9, mtime: 2000, id: 'b'.repeat(40) } }, fails('EACCES'));
  assert.deepEqual(same.unread, []);
  assert.deepEqual(same.out.map(f => f.id), ['b'.repeat(40)]);
});

test('a backup that could not read a file never counts as up to date, so the next round tries again', () => {
  const set = { sig: 'whole', parts: { shop: { name: 'shop', sig: 's1', files: 1, bytes: 9 }, blog: { name: 'blog', sig: 'b1', files: 1, bytes: 9 } } };
  const clean = doneSignatures(set, []);
  assert.equal(clean.sig, 'whole');
  assert.equal(clean.parts.shop.sig, 's1');
  const missed = doneSignatures(set, [FILE.path]);
  assert.notEqual(missed.sig, 'whole');
  assert.notEqual(missed.parts.shop.sig, 's1', 'that project is not shown as up to date');
  assert.equal(missed.parts.blog.sig, 'b1', 'the other project is');
});

test('it says so, naming the files', () => {
  assert.equal(unreadWords([]), '');
  assert.match(unreadWords(['Bridge projects/shop/a.db']), /1 file could not be read.*a\.db/);
  const many = unreadWords(['a', 'b', 'c', 'd', 'e']);
  assert.match(many, /5 files could not be read/);
  assert.match(many, /and 2 more/);
  assert.match(many, /tried again/);
});

// ---- A link inside a project ----

test('a tracked folder replaced by a link is not followed out of the project', { skip: (process.platform !== 'win32' || !hasGit) && 'needs Windows and git' }, async () => {
  await inDir(async dir => {
    const project = join(dir, 'project');
    const outside = join(dir, 'outside');
    mkdirSync(join(project, 'linked'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(project, 'keep.txt'), 'mine');
    writeFileSync(join(project, 'linked', 'fixture.txt'), 'in the project');
    writeFileSync(join(outside, 'fixture.txt'), 'made-up private words');
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['add', '.'], { cwd: project });
    renameSync(join(project, 'linked'), join(dir, 'moved'));
    symlinkSync(outside, join(project, 'linked'), 'junction');
    const got = await projectFiles(project);
    assert.equal(got.how, 'git');
    assert.deepEqual(got.files.map(f => f.path), ['keep.txt']);
    assert.match(got.note ?? '', /link/);
    assert.match(got.note ?? '', /linked\/fixture\.txt/);
  });
});

// ---- Notification settings ----

test('two settings changed at the same moment are both kept, even as the first thing after a start', async () => {
  await inDir(async dir => {
    const n = new Notifier(dir);
    await Promise.all([n.save({ volume: 17 }), n.save({ windows: false })]);
    for (const read of [n, new Notifier(dir)]) {
      const s = await read.settings();
      assert.equal(s.volume, 17);
      assert.equal(s.windows, false);
    }
  });
});

test('a setting that could not be saved does not look saved', { timeout: 30_000 }, async () => {
  await inDir(async dir => {
    const n = new Notifier(dir);
    const before = await n.settings();
    mkdirSync(join(dir, 'notify.json'));
    await assert.rejects(n.save({ sound: !before.sound }));
    assert.equal((await n.settings()).sound, before.sound);
    // A failed save does not stop the next one.
    rmSync(join(dir, 'notify.json'), { recursive: true });
    assert.equal((await n.save({ sound: !before.sound })).sound, !before.sound);
  });
});

// ---- Stop ----

test('Stop while the finished answer is being kept: it does not come back', { timeout: 10_000 }, async () => {
  await inDir(async dir => {
    const owner = 'a1b2c3d4e5f60718';
    const rid = newRid();
    const box = new Outbox(dir);
    let ended!: () => void;
    const finished = new Promise<void>(r => { ended = r; });
    const f: Follower = { send: () => undefined, end: () => ended() };
    let release!: () => void;
    let entered!: () => void;
    let sealed!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inside = new Promise<void>(r => { entered = r; });
    const keeping = new Promise<void>(r => { sealed = r; });
    // The file's own queue held, so the keep is waiting its turn when Stop comes.
    const held = updateData(join(dir, `${owner}-${rid}.box`), null, async () => {
      entered();
      await gate;
      return undefined as never;
    });
    await inside;
    const plain: Lock = { seal: b => b, open: b => b };
    const lock: Lock = { ...plain, seal: b => { sealed(); return b; } };
    box.start(owner, rid, lock, f, async send => {
      send('text', { text: 'made-up answer' });
      send('done', { model: 'made-up' });
    });
    await keeping;
    await box.stop(owner, rid);
    release();
    await held;
    await finished;
    assert.equal(await box.kept(owner, rid, plain), null);
  });
});
