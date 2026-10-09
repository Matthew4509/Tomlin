// The 2.0.35 base audit's fixes (docs/AUDIT-2026-10-06-BASE-STABILITY.md): data that cannot be read is set aside, not
// saved over; saves that read and change a file keep what changed meanwhile; one copy per home; an import or restore
// never deletes the data when its backup failed; and the smaller guards beside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DamagedFile, clearDamaged, damaged, readData, updateData } from '../src/atomic.ts';
import { Store } from '../src/store.ts';
import { ATTEMPT_FILE, judge, LOCK_FILE, processInfo, releaseHome, takeHome, takeHomeOrRepair } from '../src/onecopy.ts';
import * as keep from '../src/keep.ts';
import * as link from '../src/link.ts';
import { fetchChecked } from '../src/download.ts';
import { MAX_DAY_BYTES, log, logFile, openLog } from '../src/log.ts';
import { Models } from '../src/models.ts';
import { overlaps } from '../src/workspace.ts';
import { refreshTray, type Build } from '../src/trayfresh.ts';
import { CURRENT, EXE } from '../src/installer.ts';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `sm-${name}-`));
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// ---- A1: reading and saving ----

test('a file that is not there reads as empty; one that is there but damaged is set aside and reported, never read as empty and saved over', async () => {
  const dir = tmp('read');
  try {
    clearDamaged();
    assert.deepEqual(await readData(join(dir, 'none.json'), { empty: true }), { empty: true });
    assert.deepEqual(damaged(), []);
    // A power cut can leave the right size full of NULs.
    put(join(dir, 'settings.json'), '\0\0\0\0\0\0');
    assert.deepEqual(await readData(join(dir, 'settings.json'), {}), {});
    const said = damaged();
    assert.equal(said.length, 1);
    assert.equal(said[0].file, join(dir, 'settings.json'));
    assert.equal(existsSync(join(dir, 'settings.json')), false, 'moved out of the way, so nothing is saved over it');
    assert.equal(readFileSync(join(dir, said[0].keptAs), 'utf8'), '\0\0\0\0\0\0', 'kept as it was, beside it');
    // A lock is left where it is, and says so: it is never read as "no PIN".
    put(join(dir, 'app-lock.json'), '{"salt":');
    await assert.rejects(readData(join(dir, 'app-lock.json'), null, { leave: true }), DamagedFile);
    assert.equal(readFileSync(join(dir, 'app-lock.json'), 'utf8'), '{"salt":');
  } finally {
    clearDamaged();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two changes to one file at once both stay (each reads what the other saved)', async () => {
  const dir = tmp('update');
  try {
    const file = join(dir, 'list.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateData<number[]>(file, [], now => [...now, i])));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sort((a: number, b: number) => a - b), Array.from({ length: 20 }, (_, i) => i));
    // undefined saves nothing.
    const before = readFileSync(file, 'utf8');
    await updateData<number[]>(file, [], () => undefined);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat cleared while an answer is written: the answer saves nothing into it; lines added meanwhile are kept', async () => {
  const dir = tmp('chat');
  try {
    const store = new Store(dir);
    const file = 'chats/aaaaaaaaaaaa.json';
    await store.saveChat([{ role: 'user', content: 'hello', at: '1' }], file);
    // Two answers adding a line each at the same moment: both lines stay.
    await Promise.all([
      store.changeChat(file, l => [...l, { role: 'assistant', content: 'one', at: '2' }]),
      store.changeChat(file, l => [...l, { role: 'assistant', content: 'two', at: '3' }]),
    ]);
    assert.deepEqual((await store.chat(file)).map(l => l.content).sort(), ['hello', 'one', 'two']);
    // An answer starts (its mark), the chat is cleared, the answer ends: nothing of it comes back.
    const mark = store.chatMark(file);
    store.chatEmptied(file);
    await store.saveChat([], file);
    assert.equal(await store.changeChat(file, l => [...l, { role: 'assistant', content: 'late', at: '4' }], mark), null);
    assert.deepEqual(await store.chat(file), []);
    // A new answer after the clear saves as usual.
    assert.ok(await store.changeChat(file, l => [...l, { role: 'assistant', content: 'new', at: '5' }], store.chatMark(file)));
    assert.deepEqual((await store.chat(file)).map(l => l.content), ['new']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings written by a newer copy keep the fields this one does not know', async () => {
  const dir = tmp('settings');
  try {
    put(join(dir, 'settings.json'), JSON.stringify({ who: 'standard', fromNewer: { x: 1 } }));
    const store = new Store(dir);
    await store.saveSettings({ tone: 'warm' });
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.fromNewer, { x: 1 });
    assert.equal(saved.tone, 'warm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A6: one copy per home ----

test('one copy per home: a second is told, a lock left by a copy that ended is taken over, and it goes at the end', () => {
  const home = tmp('home');
  try {
    assert.deepEqual(takeHome(home, 111, () => false), { ok: true });
    assert.equal(readFileSync(join(home, LOCK_FILE), 'utf8'), '111');
    // 111 still runs, and is TOMLIN: the second copy (222) is told which process holds it.
    assert.deepEqual(takeHome(home, 222, pid => pid === 111, () => 'running'), { other: 111 });
    // 111 ended hard (its lock left behind): taken over.
    assert.deepEqual(takeHome(home, 222, () => false), { ok: true });
    // Only the holder gives it back.
    releaseHome(home, 111);
    assert.equal(existsSync(join(home, LOCK_FILE)), true);
    releaseHome(home, 222);
    assert.equal(existsSync(join(home, LOCK_FILE)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a lock whose number Windows gave to another program is repaired: not Node, or started after the lock', () => {
  const at = '2026-10-07T06:00:00.000Z';
  assert.equal(judge({ pid: 5, at }, { name: 'conhost.exe', started: '2026-10-07T05:00:00.000Z' }), 'stale');
  assert.equal(judge({ pid: 5, at }, { name: 'node.exe', started: '2026-10-07T07:00:00.000Z' }), 'stale', 'started after the lock was written');
  assert.equal(judge({ pid: 5, at }, { name: 'node.exe', started: '2026-10-07T05:59:58.000Z' }), 'running');
  assert.equal(judge({ pid: 5, at }, null), 'unsure');
  const home = tmp('home');
  try {
    writeFileSync(join(home, LOCK_FILE), '12196');
    const r = takeHome(home, 333, () => true, () => 'stale');
    assert.ok('ok' in r && /process 12196/.test(r.repaired ?? ''));
    assert.equal(readFileSync(join(home, LOCK_FILE), 'utf8'), '333', 'the lock still holds the number alone, as older copies read it');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('when Windows cannot say, the second start repairs the lock, but never while something answers on the port', async () => {
  const home = tmp('home');
  try {
    writeFileSync(join(home, LOCK_FILE), '444');
    const o = { pid: 555, alive: () => true, check: () => 'unsure' as const };
    const t0 = Date.parse('2026-10-07T06:00:00.000Z');
    // First start: refused, and the note says so.
    assert.deepEqual(await takeHomeOrRepair(home, async () => false, { ...o, now: t0 }), { other: 444, unsure: true });
    assert.equal(existsSync(join(home, ATTEMPT_FILE)), true);
    // Started again at once (5 s): still refused (a copy may be starting slowly).
    assert.deepEqual(await takeHomeOrRepair(home, async () => false, { ...o, now: t0 + 5000 }), { other: 444, unsure: true });
    // A minute later, but something answers on the port: that is the copy running, so nothing is repaired.
    assert.deepEqual(await takeHomeOrRepair(home, async () => true, { ...o, now: t0 + 65_000 }), { other: 444, unsure: true });
    // Later again, with nothing on the port: repaired, and the note goes.
    const r = await takeHomeOrRepair(home, async () => false, { ...o, now: t0 + 130_000 });
    assert.ok('ok' in r && /second start/.test(r.repaired ?? ''));
    assert.equal(readFileSync(join(home, LOCK_FILE), 'utf8'), '555');
    assert.equal(existsSync(join(home, ATTEMPT_FILE)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows says what this test\'s own process is: Node, started before now', { skip: process.platform !== 'win32' }, () => {
  const me = processInfo(process.pid);
  assert.ok(me, 'PowerShell answered');
  assert.match(me!.name, /^node(\.exe)?$/i);
  assert.ok(Date.parse(me!.started) <= Date.now());
  assert.equal(judge({ pid: process.pid, at: new Date().toISOString() }, me), 'running');
});

// ---- A2: import and restore ----

async function homeWithOldCopy() {
  const top = tmp('keep');
  const parent = join(top, 'apps');
  const root = join(parent, 'shelby-2.0.35');
  const old = join(parent, 'shelby-2.0.30');
  put(join(root, 'package.json'), JSON.stringify({ name: 'shelby', version: '2.0.35' }));
  put(join(old, 'package.json'), JSON.stringify({ name: 'shelby', version: '2.0.30' }));
  put(join(old, 'data', 'settings.json'), '{"from":"old"}');
  const home = keep.resolveHome({ TOMLIN_HOME: join(top, 'TOMLIN') });
  put(join(home.data, 'settings.json'), '{"from":"home"}');
  put(join(home.data, 'staff.json'), '{"staff":[]}');
  return { top, root, old, home };
}

test('an import whose backup cannot be made replaces nothing, says why, and is not tried again at every start', { skip: process.platform !== 'win32' }, async () => {
  const w = await homeWithOldCopy();
  const was = process.env.SystemRoot;
  try {
    await keep.prepare(w.home, w.root, '2.0.35');
    await keep.planNext(w.home, { do: 'bring-in', from: w.old });
    // No tar where Windows keeps it: the backup fails.
    process.env.SystemRoot = join(w.top, 'no-windows');
    const r = await keep.prepare(w.home, w.root, '2.0.35');
    assert.equal(r.state, 'ready');
    assert.equal(readFileSync(join(w.home.data, 'settings.json'), 'utf8'), '{"from":"home"}', 'the data here is as it was');
    assert.match(keep.readVersion(w.home)?.note ?? '', /^Nothing was imported: the backup of your data could not be made/);
    assert.equal(existsSync(join(w.home.home, 'next-start.json')) || readdirSync(w.home.home).some(n => /next/.test(n)), false, 'the plan is gone');
  } finally {
    process.env.SystemRoot = was;
    rmSync(w.top, { recursive: true, force: true });
  }
});

test('a restore cut off half way: the next start puts the data that was there back (or keeps the new data when it was in place)', async () => {
  const w = await homeWithOldCopy();
  try {
    await keep.prepare(w.home, w.root, '2.0.35');
    // Cut off after data/ became data.old and before the restored copy took its place.
    const { renameSync } = await import('node:fs');
    renameSync(w.home.data, `${w.home.data}.old`);
    put(join(`${w.home.data}.restoring`, 'settings.json'), '{"from":"half"}');
    await keep.prepare(w.home, w.root, '2.0.35');
    assert.equal(readFileSync(join(w.home.data, 'settings.json'), 'utf8'), '{"from":"home"}');
    assert.equal(existsSync(`${w.home.data}.old`), false);
    assert.equal(existsSync(`${w.home.data}.restoring`), false);
  } finally {
    rmSync(w.top, { recursive: true, force: true });
  }
});

test('a backup is listed only when it is whole: none left half made, and the folder it is made in goes', { skip: process.platform !== 'win32' }, async () => {
  const w = await homeWithOldCopy();
  const was = process.env.SystemRoot;
  try {
    await keep.prepare(w.home, w.root, '2.0.35');
    const before = (await keep.listBackups(w.home)).length;
    process.env.SystemRoot = join(w.top, 'no-windows');
    await assert.rejects(keep.backup(w.home, 'by hand'));
    process.env.SystemRoot = was;
    assert.equal((await keep.listBackups(w.home)).length, before);
    const name = await keep.backup(w.home, 'by hand');
    assert.ok((await keep.listBackups(w.home)).some(b => b.name === name));
    assert.deepEqual(readdirSync(w.home.backups).filter(n => !n.endsWith('.zip')), [], 'no making folder left');
  } finally {
    process.env.SystemRoot = was;
    rmSync(w.top, { recursive: true, force: true });
  }
});

test('"Later" on the import question: once the home has chats or staff of its own, it is not asked again', async () => {
  const w = await homeWithOldCopy();
  try {
    rmSync(w.home.data, { recursive: true, force: true });
    assert.equal((await keep.prepare(w.home, w.root, '2.0.35')).state, 'offer');
    // Weeks of use after "Later".
    put(join(w.home.data, 'chats', 'index.json'), '[{"id":"aaaaaaaaaaaa"}]');
    assert.equal((await keep.prepare(w.home, w.root, '2.0.35')).state, 'ready');
    assert.equal(keep.readVersion(w.home)?.offer, undefined);
  } finally {
    rmSync(w.top, { recursive: true, force: true });
  }
});

// ---- B10: linking again takes over the old link only with its keys ----

test('linking again takes over the old link only with proof of its keys', async () => {
  const oldKeys = Buffer.alloc(64, 7);
  const otherKeys = Buffer.alloc(64, 9);
  const pub = 'the-new-public-key';
  const proof = link.takeOverProof(oldKeys, pub);
  assert.equal(link.takeOverProven(oldKeys, pub, proof), true);
  assert.equal(link.takeOverProven(oldKeys, 'another-public-key', proof), false, 'bound to this pairing');
  assert.equal(link.takeOverProven(otherKeys, pub, proof), false, 'made with other keys');
  assert.equal(link.takeOverProven(oldKeys, pub, undefined), false, 'none given');
});

// ---- Downloads ----

test('a download never writes over another model of the same name; a part already whole is checked, not fetched again', async () => {
  const dir = tmp('dl');
  try {
    const data = Buffer.from('a whole model file');
    const hash = createHash('sha256').update(data).digest('hex');
    // Nothing listens on port 9: any fetch would fail.
    const nowhere = 'http://127.0.0.1:9/model.gguf';
    put(join(dir, 'other.gguf'), 'a different model, same name');
    await assert.rejects(fetchChecked(nowhere, join(dir, 'other.gguf'), data.length, hash), /different model file named other\.gguf/);
    assert.equal(readFileSync(join(dir, 'other.gguf'), 'utf8'), 'a different model, same name');
    writeFileSync(join(dir, 'model.gguf.part'), data);
    assert.equal(await fetchChecked(nowhere, join(dir, 'model.gguf'), data.length, hash), 'kept');
    assert.ok(readFileSync(join(dir, 'model.gguf')).equals(data));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The log ----

test('a day\'s log stops growing at its limit', () => {
  const dir = tmp('log');
  try {
    openLog(dir);
    const file = logFile()!;
    writeFileSync(file, Buffer.alloc(MAX_DAY_BYTES, 'x'));
    log.error('test', 'one more fault');
    assert.equal(statSync(file).size, MAX_DAY_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Models in another folder ----

test('the model list is kept a moment when asked (a slow folder is walked once), and walked again after forget', async () => {
  const dir = tmp('models');
  try {
    const own = join(dir, 'chat');
    await mkdir(own, { recursive: true });
    const models = new Models(own, join(dir, 'models-folder.txt'), undefined, null);
    await writeFile(join(own, 'a.gguf'), 'GGUF a');
    assert.deepEqual(models.list().map(m => m.id), ['a.gguf']);
    models.cacheMs = 60_000;
    models.list();
    await writeFile(join(own, 'b.gguf'), 'GGUF bb');
    assert.deepEqual(models.list().map(m => m.id), ['a.gguf'], 'kept');
    models.forget();
    assert.deepEqual(models.list().map(m => m.id).sort(), ['a.gguf', 'b.gguf']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- B9: the workspace ----

test('a workspace is never TOMLIN\'s own folder, inside it, or a folder that holds it', () => {
  const kept = ['C:\\Apps\\TOMLIN\\shelby-2.0.35', 'C:\\Users\\you\\TOMLIN'];
  assert.equal(overlaps('C:\\Users\\you\\TOMLIN', kept), true);
  assert.equal(overlaps('C:\\Users\\you\\TOMLIN\\data', kept), true);
  assert.equal(overlaps('C:\\Users\\you', kept), true);
  assert.equal(overlaps('c:\\apps\\tomlin\\shelby-2.0.35\\src\\', kept), true);
  assert.equal(overlaps('C:\\Users\\you\\Documents\\Writing', kept), false);
  assert.equal(overlaps('C:\\Users\\you\\TOMLIN 2', kept), false, 'a name that only starts the same');
});

// ---- A7 and the tray ----

test('an older copy kept beside the current one never builds the program again', async () => {
  const root = tmp('tray');
  try {
    for (const v of ['shelby-1.0.0', 'shelby-2.0.0']) put(join(root, v, 'tools', 'tray.cs'), `class V { /* ${v} */ }`);
    writeFileSync(join(root, CURRENT), 'shelby-2.0.0');
    writeFileSync(join(root, EXE), 'the program');
    const built: string[] = [];
    const fake: Build = async o => {
      built.push(o.source);
      writeFileSync(o.out, 'built');
    };
    assert.equal(await refreshTray(join(root, 'shelby-1.0.0'), fake), 'same');
    assert.deepEqual(built, []);
    assert.equal(await refreshTray(join(root, 'shelby-2.0.0'), fake), 'built');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
