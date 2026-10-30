// Backup, restore, the zip and the update's switch-over, attacked: what a person could lose, or a start that never comes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import * as keep from '../src/keep.ts';
import { checkZip, listFolder, writeZip } from '../src/zip.ts';
import { updateSide } from '../src/update.ts';

const windows = process.platform === 'win32';

async function inHome(fn: (home: keep.Home, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sm-bk-'));
  try {
    const home = keep.resolveHome({ TOMLIN_HOME: join(dir, 'home') } as NodeJS.ProcessEnv);
    await mkdir(home.data, { recursive: true });
    await fn(home, dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Every file under `dir`, by its path inside it. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p, base) : [relative(base, p).replace(/\\/g, '/')];
  }).sort();
}

/** Holds `file` open as a virus scanner or another program does: nothing else may open, move or delete it. */
async function held(file: string): Promise<() => Promise<void>> {
  const script = `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); 'held'; Start-Sleep 60`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  await once(p.stdout, 'data');
  return async () => {
    const gone = once(p, 'exit');
    p.kill();
    await gone;
  };
}

// ---- Put back: nothing goes missing whatever the names ----

test('Put back brings back every file whatever its name: emoji, %, &, #, quotes, brackets, a name starting with a dash, and a very long one', async () => {
  await inHome(async home => {
    const names = ['notes 🙂.txt', '100% done.txt', 'a&b.txt', '#1 [draft].txt', "it's.txt", '-rf.txt', '~$lock.txt', 'x=1,y=2;.txt', `${'n'.repeat(200)}.txt`, 'Ωmega/日本/🙂/deep.txt'];
    for (const n of names) await put(join(home.data, 'files', ...n.split('/')), `was ${n}`);
    await put(join(home.data, 'settings.json'), '{}');
    const name = await keep.backup(home, 'names');
    await rm(join(home.data, 'files'), { recursive: true });
    const said = await keep.restore(home, name, '2.0.0');
    assert.match(said, /^Restored/, said);
    for (const n of names) assert.equal(await readFile(join(home.data, 'files', ...n.split('/')), 'utf8'), `was ${n}`);
  });
});

test('Put back keeps a name written with separate accent marks (as a Mac writes them) as it was', { todo: 'Windows tar turns it into the one-letter form, and two files differing only so become one' }, async () => {
  await inHome(async home => {
    await put(join(home.data, 'files', 'é.txt'), 'marks');
    await put(join(home.data, 'files', 'é.txt'), 'one letter');
    const said = await keep.restore(home, await keep.backup(home, 'names'), '2.0.0');
    assert.match(said, /^Restored/, said);
    assert.equal(await readFile(join(home.data, 'files', 'é.txt'), 'utf8'), 'marks');
    assert.equal(await readFile(join(home.data, 'files', 'é.txt'), 'utf8'), 'one letter');
  });
});

test('a path past the old Windows limit (a deep project folder in the data) is backed up and comes back on Put back', { skip: !windows && 'Windows paths' }, async () => {
  await inHome(async home => {
    const deep = Array.from({ length: 12 }, (_, i) => `folder-${i}-${'x'.repeat(20)}`);
    await put(join(home.data, ...deep, 'deep.txt'), 'deep');
    await put(join(home.data, 'settings.json'), '{}');
    assert.ok(join(home.data, ...deep, 'deep.txt').length > 300);
    const name = await keep.backup(home, 'deep');
    const said = await keep.restore(home, name, '2.0.0');
    assert.match(said, /^Restored/, said);
    assert.equal(await readFile(join(home.data, ...deep, 'deep.txt'), 'utf8'), 'deep');
  });
});

// ---- Backups ----

test('an old backup that is open in another program does not turn a good new backup into a failed one', { skip: !windows && 'Windows file locks' }, async () => {
  await inHome(async home => {
    await put(join(home.data, 'settings.json'), '{}');
    await mkdir(home.backups, { recursive: true });
    const old = join(home.backups, '2001-01-01 000000 old.zip');
    await writeFile(old, 'an old backup');
    for (let i = 1; i <= 5; i++) await writeFile(join(home.backups, `2030-01-0${i} 000000 new.zip`), 'x');
    const release = await held(old);
    try {
      const name = await keep.backup(home, 'now');
      assert.ok(existsSync(join(home.backups, name)));
    } finally {
      await release();
    }
  });
});

// ---- First start with odd data ----

test('a version file with no app version in it (cut or edited by hand) still starts, and the data is kept', async () => {
  await inHome(async (home, dir) => {
    await put(join(home.data, 'settings.json'), '{}');
    await put(join(home.data, 'version.json'), '{"data":1}');
    const ready = await keep.prepare(home, join(dir, 'app'), '2.0.0');
    assert.equal(ready.state, 'ready');
    assert.equal(keep.readVersion(home)?.app, '2.0.0');
    assert.equal((await keep.listBackups(home)).length, 1);
  });
});

test('a leftover from a restore that cannot be removed yet does not stop the app from starting', { skip: !windows && 'Windows file locks' }, async () => {
  await inHome(async (home, dir) => {
    await put(join(home.data, 'settings.json'), '{"mine":true}');
    await keep.writeVersion(home, { data: 1, app: '2.0.0' });
    const stuck = `${home.data}.old`;
    await put(join(stuck, 'chats', 'a.json'), '{}');
    const half = `${home.data}.restoring`;
    await put(join(half, 'b.json'), '{}');
    const release = await held(join(stuck, 'chats', 'a.json'));
    const release2 = await held(join(half, 'b.json'));
    try {
      const ready = await keep.prepare(home, join(dir, 'app'), '2.0.0');
      assert.equal(ready.state, 'ready');
    } finally {
      await release();
      await release2();
    }
    // Once it is free, the next start clears it.
    await keep.prepare(home, join(dir, 'app'), '2.0.0');
    assert.equal(existsSync(stuck), false);
    assert.equal(await readFile(join(home.data, 'settings.json'), 'utf8'), '{"mine":true}');
  });
});

test('Push live records held by a program while a cut-off restore settles are not lost, and the app still starts', { skip: !windows && 'Windows file locks' }, async () => {
  await inHome(async (home, dir) => {
    await put(join(home.data, 'settings.json'), '{}');
    await keep.writeVersion(home, { data: 1, app: '2.0.0' });
    const secret = join(`${home.data}.old`, 'bridge', 'hosting', 'secret.bin');
    await put(secret, 'sealed');
    const release = await held(secret);
    try {
      const ready = await keep.prepare(home, join(dir, 'app'), '2.0.0');
      assert.equal(ready.state, 'ready');
    } finally {
      await release();
    }
    await keep.prepare(home, join(dir, 'app'), '2.0.0');
    assert.equal(await readFile(join(home.data, 'bridge', 'hosting', 'secret.bin'), 'utf8'), 'sealed');
    assert.equal(existsSync(`${home.data}.old`), false);
  });
});

test('data.old with the chats in it is not deleted because a new, nearly empty data folder appeared beside it', async () => {
  await inHome(async (home, dir) => {
    // A swap cut off between its two moves, and data/ made again before the next start settled it.
    await rm(home.data, { recursive: true });
    await put(join(`${home.data}.old`, 'settings.json'), '{"mine":true}');
    await put(join(`${home.data}.old`, 'version.json'), '{"data":1,"app":"2.0.0"}');
    await put(join(`${home.data}.old`, 'chats', 'a.json'), '{"chat":"precious"}');
    await put(join(home.data, 'version.json'), '{"data":1,"app":"2.0.0"}');
    await keep.prepare(home, join(dir, 'app'), '2.0.0');
    assert.equal(await readFile(join(home.data, 'chats', 'a.json'), 'utf8'), '{"chat":"precious"}');
  });
});

// ---- A restore that meets a fault part way ----

test('a restore whose old folder cannot be cleared at once says it was restored, not that the data is as it was', async () => {
  await inHome(async (home, dir) => {
    // A file named as the folder Push live's records go back into: they cannot be carried over, after the data is in place.
    await put(join(home.data, 'settings.json'), '{"when":"old"}');
    await put(join(home.data, 'bridge'), 'a file');
    await keep.writeVersion(home, { data: 1, app: '2.0.0' });
    const name = await keep.backup(home, 'point');
    await rm(join(home.data, 'bridge'));
    await put(join(home.data, 'settings.json'), '{"when":"new"}');
    await put(join(home.data, 'bridge', 'hosting', 'secret.bin'), 'sealed');
    await keep.planNext(home, { do: 'restore', name });
    const ready = await keep.prepare(home, join(dir, 'app'), '2.0.0');
    assert.equal(await readFile(join(home.data, 'settings.json'), 'utf8'), '{"when":"old"}');
    assert.match(String(ready.state === 'ready' ? ready.note : ''), /^Restored/);
    // The records are not thrown away, and the next start is not stopped by them.
    assert.equal(await readFile(join(`${home.data}.old`, 'bridge', 'hosting', 'secret.bin'), 'utf8'), 'sealed');
    assert.equal((await keep.prepare(home, join(dir, 'app'), '2.0.0')).state, 'ready');
  });
});

test('a file held for a moment as a restore starts (a closing program, a scanner) does not make the restore fail', { skip: !windows && 'Windows file locks' }, async () => {
  await inHome(async (home, dir) => {
    await put(join(home.data, 'settings.json'), '{"when":"old"}');
    await keep.writeVersion(home, { data: 1, app: '2.0.0' });
    const name = await keep.backup(home, 'point');
    await put(join(home.data, 'settings.json'), '{"when":"new"}');
    await put(join(home.data, 'chats', 'still-open.json'), '{}');
    await keep.planNext(home, { do: 'restore', name });
    const fh = await open(join(home.data, 'chats', 'still-open.json'), 'r');
    const later = setTimeout(() => void fh.close(), 900);
    try {
      const ready = await keep.prepare(home, join(dir, 'app'), '2.0.0');
      assert.match(String(ready.state === 'ready' ? ready.note : ''), /^Restored/);
    } finally {
      clearTimeout(later);
      await fh.close().catch(() => undefined);
    }
    assert.equal(await readFile(join(home.data, 'settings.json'), 'utf8'), '{"when":"old"}');
  });
});

test('a restore cut off after the move runs again and ends with the backup in place', async () => {
  await inHome(async (home, dir) => {
    await put(join(home.data, 'settings.json'), '{"when":"old"}');
    const name = await keep.backup(home, 'point');
    // As a power cut leaves it: the new data in place, the old beside it, the plan still there.
    await put(join(`${home.data}.old`, 'settings.json'), '{"when":"new"}');
    await keep.planNext(home, { do: 'restore', name });
    await keep.prepare(home, join(dir, 'app'), '2.0.0');
    assert.equal(await readFile(join(home.data, 'settings.json'), 'utf8'), '{"when":"old"}');
    assert.equal(existsSync(join(home.home, 'next-start.json')), false);
  });
});

// ---- The zip ----

test('a backup cut short, or a zip of nothing but junk, is refused and the data stays', async () => {
  await inHome(async home => {
    await put(join(home.data, 'settings.json'), '{"mine":true}');
    const name = await keep.backup(home, 'point');
    const zip = join(home.backups, name);
    const whole = await readFile(zip);
    for (const bad of [whole.subarray(0, whole.length - 10), whole.subarray(0, 40), Buffer.alloc(0), Buffer.from('not a zip at all')]) {
      await writeFile(zip, bad);
      const said = await keep.restore(home, name, '2.0.0');
      assert.match(said, /^Nothing was restored/, said);
      assert.equal(await readFile(join(home.data, 'settings.json'), 'utf8'), '{"mine":true}');
      assert.equal(existsSync(`${home.data}.restoring`), false);
    }
  });
});

test('writeZip keeps a folder of mixed sizes, with an unreadable big file between them, whole', { skip: !windows && 'Windows file locks' }, async () => {
  await inHome(async (home, dir) => {
    await put(join(home.data, 'a.txt'), 'a');
    await put(join(home.data, 'b.bin'), 'b'.repeat(5 << 20));
    await put(join(home.data, 'c.txt'), 'c');
    const release = await held(join(home.data, 'b.bin'));
    try {
      const { items } = await listFolder(home.data);
      const zip = join(dir, 'out.zip');
      const made = await writeZip(zip, items);
      assert.deepEqual(made.skipped.map(s => s.name), ['b.bin']);
      assert.ok((await checkZip(zip, made.entries)).ok);
      await assert.rejects(keep.backup(home, 'locked'), /b\.bin/);
      assert.equal((await keep.listBackups(home)).length, 0);
      assert.equal(existsSync(join(home.backups, '.making')), false);
    } finally {
      await release();
    }
  });
});

// ---- An update coming in ----

function side(root: string, over: Partial<Parameters<typeof updateSide>[0]> = {}) {
  return updateSide({ root, version: '1.0.0', allowed: () => true, pcName: () => 'A PC', restarts: true, busy: () => null, freeBytes: async () => 1e12, done: async () => undefined, ...over });
}
const entry = (path: string, text: string) => ({ path, bytes: Buffer.byteLength(text), sha: createHash('sha256').update(text).digest('hex') });
const who = { key: 'a'.repeat(32), name: 'Host' };

async function appAt(dir: string) {
  const root = join(dir, 'tomlin');
  await put(join(root, 'package.json'), '{"version":"1.0.0"}');
  const texts: Record<string, string> = { 'package.json': '{"name":"tomlin","version":"2.0.0"}', 'src/server.ts': 'new server', 'Start TOMLIN.cmd': 'start' };
  return { root, texts, files: Object.entries(texts).map(([p, t]) => entry(p, t)), staging: join(dir, '.tomlin-2.0.0-incoming') };
}

test('an update cut off just after the last piece of a file (or a scanner held it a moment) can be carried on, not "has not come in yet" for ever', async () => {
  await inHome(async (_home, dir) => {
    const { root, texts, files, staging } = await appAt(dir);
    await put(join(staging, 'src', 'server.ts.part'), texts['src/server.ts']); // whole, never moved into place
    const handle = side(root);
    const offer = await handle('/worker/update-offer', { version: '2.0.0', files }, who);
    assert.equal(offer.status, 200);
    // Whatever is still needed is sent as the sending PC would: only from where the offer says.
    const need = offer.json.need as number[];
    const at = offer.json.at as number[];
    for (const [j, k] of need.entries()) {
      const text = Buffer.from(texts[files[k].path]);
      if (at[j] < text.length) {
        const r = await handle('/worker/update-put', { version: '2.0.0', file: k, from: at[j] }, who, text.subarray(at[j]));
        assert.equal(r.status, 200);
      }
    }
    const end = await handle('/worker/update-finish', { version: '2.0.0' }, who);
    assert.equal(end.json.done, true, String(end.json.error));
  });
});

test('a whole-sized or longer part left from other files of that version is thrown away and sent again', async () => {
  await inHome(async (_home, dir) => {
    const { root, texts, files, staging } = await appAt(dir);
    await put(join(staging, 'src', 'server.ts.part'), 'X'.repeat(Buffer.byteLength(texts['src/server.ts'])));
    await put(join(staging, 'package.json.part'), 'Y'.repeat(500));
    const handle = side(root);
    const offer = await handle('/worker/update-offer', { version: '2.0.0', files }, who);
    const need = offer.json.need as number[];
    const at = offer.json.at as number[];
    for (const f of ['src/server.ts', 'package.json']) {
      const j = need.indexOf(files.findIndex(x => x.path === f));
      assert.ok(j >= 0, `${f} must be sent again`);
      assert.equal(at[j], 0);
    }
  });
});

test('a fault at the very end of an update does not leave the screen saying the new version is starting for ever', async () => {
  await inHome(async (_home, dir) => {
    const { root, texts, files } = await appAt(dir);
    const handle = side(root, { done: async () => { throw new Error('the disk is full'); } });
    const offer = await handle('/worker/update-offer', { version: '2.0.0', files }, who);
    for (const k of offer.json.need as number[]) await handle('/worker/update-put', { version: '2.0.0', file: k, from: 0 }, who, Buffer.from(texts[files[k].path]));
    await assert.rejects(handle('/worker/update-finish', { version: '2.0.0' }, who), /disk is full/);
    assert.equal(handle.incoming(), null);
  });
});

test('files of an earlier try at the same version are not left in the new copy (it would be another build than the one sent)', async () => {
  await inHome(async (_home, dir) => {
    const { root, texts, files, staging } = await appAt(dir);
    await put(join(staging, 'src', 'old-file.ts'), 'from the earlier try');
    let copy = '';
    const handle = side(root, { done: async d => { copy = d; } });
    const offer = await handle('/worker/update-offer', { version: '2.0.0', files }, who);
    for (const k of offer.json.need as number[]) await handle('/worker/update-put', { version: '2.0.0', file: k, from: 0 }, who, Buffer.from(texts[files[k].path]));
    const end = await handle('/worker/update-finish', { version: '2.0.0' }, who);
    assert.equal(end.json.done, true, String(end.json.error));
    assert.deepEqual(filesUnder(join(copy, 'src')), ['server.ts']);
  });
});
