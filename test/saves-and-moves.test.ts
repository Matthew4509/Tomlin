// Pictures reaching their project, saves that fail or arrive together, a chat's files moving, and what a backup
// leaves out. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gallery, type Picture } from '../src/gallery.ts';
import { promptWhy } from '../src/images.ts';
import * as keep from '../src/keep.ts';
import { listZip } from '../src/zip.ts';
import { addSnippet, NotesStore, setScratch } from '../src/notes.ts';
import * as ws from '../src/workspace.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pic = (id: string, extra: Partial<Picture> = {}): Picture => ({
  id, at: new Date().toISOString(), prompt: `a piano ${id}`, modelPrompt: '', negative: '', mode: 'blog', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1,
  sampler: 'lcm', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1,
  draft: true, original: `2026-10/${id}.png`, output: `2026-10/${id}.png`, format: 'png', bytes: 1, ...extra,
});

async function inDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sm-saves-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const freePort = () => new Promise<number>((ok, no) => {
  const s = createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});

/** A real TOMLIN on a home of its own; `stop` ends it. */
async function boot(home: string): Promise<{ base: string; stop: () => Promise<void> }> {
  mkdirSync(join(home, 'startup'), { recursive: true });
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(150);
  assert.match(said, /is running at/, said);
  return { base: `http://127.0.0.1:${port}`, stop: async () => { server.kill(); await sleep(300); } };
}

const post = async (base: string, path: string, b: unknown) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json() as Record<string, any> };
};

// ---- The gallery ----

test('keep says whether the picture came out of the drafts: only once, even with two presses at the same moment', async () => {
  await inDir(async dir => {
    const g = new Gallery(dir);
    await g.add(pic('draft', { kept: false }));
    await g.add(pic('old'));
    const [a, b] = await Promise.all([g.keep('draft', true), g.keep('draft', true)]);
    assert.equal(a?.picture.kept, true);
    assert.deepEqual([a?.fromDraft, b?.fromDraft], [true, false]);
    assert.equal((await g.keep('old', true))?.fromDraft, false, 'a picture from before drafts was in the gallery already');
    assert.equal((await g.keep('draft', false))?.fromDraft, false, 'taken back out: nothing to hand in');
    assert.equal(await g.keep('nobody', true), undefined);
    await g.update('old', { removed: true });
    assert.equal(await g.keep('old', true), undefined, 'a deleted picture cannot be kept');
    assert.equal((await new Gallery(dir).get('draft'))?.kept, false, 'the last press is what is on the disk');
  });
});

test('a gallery change that could not be written is not shown as made', async () => {
  await inDir(async dir => {
    const g = new Gallery(dir);
    await g.add(pic('a', { kept: true }));
    await rename(join(dir, 'gallery.jsonl'), join(dir, 'gallery.saved'));
    await mkdir(join(dir, 'gallery.jsonl'));
    await assert.rejects(g.update('a', { kept: false }));
    assert.equal((await g.get('a'))?.kept, true);
    await assert.rejects(g.keep('a', false));
    assert.equal((await g.get('a'))?.kept, true);
  });
});

test('a gallery that could not be read says so, and reads again next time instead of staying empty', async () => {
  await inDir(async dir => {
    await mkdir(join(dir, 'gallery.jsonl'));
    const g = new Gallery(dir);
    await assert.rejects(g.all(), /picture list could not be read/);
    await assert.rejects(g.list(), /picture list could not be read/);
    await rm(join(dir, 'gallery.jsonl'), { recursive: true });
    await writeFile(join(dir, 'gallery.jsonl'), `${JSON.stringify(pic('back'))}\n`);
    assert.deepEqual((await g.all()).map(p => p.id), ['back']);
    assert.deepEqual(await new Gallery(join(dir, 'never-made')).all(), [], 'no list yet is an empty gallery, not a fault');
  });
});

test('a picture finished while the list cannot be read is still written, and comes back once only', async () => {
  await inDir(async dir => {
    const g = new Gallery(dir);
    const realAll = g.all.bind(g);
    let failing = true;
    g.all = () => (failing ? Promise.reject(new Error('EPERM')) : realAll());
    await g.add(pic('new'));
    failing = false;
    assert.deepEqual((await g.all()).map(p => p.id), ['new']);
  });
});

test('pictures saved together into a gallery nobody has read yet are all in the list', async () => {
  await inDir(async dir => {
    for (let i = 0; i < 10; i++) {
      const g = new Gallery(join(dir, String(i)));
      await Promise.all([g.add(pic('a')), g.add(pic('b'))]);
      assert.deepEqual((await g.all()).map(p => p.id).sort(), ['a', 'b']);
      assert.deepEqual((await new Gallery(join(dir, String(i))).all()).map(p => p.id).sort(), ['a', 'b']);
    }
  });
});

// ---- Notes ----

test('a notes save that could not be written is not shown as saved, and the next one can still go through', async () => {
  await inDir(async dir => {
    const s = new NotesStore(dir);
    await s.save({ scratch: 'on disk', snippets: [] });
    await rm(join(dir, 'notes.json'));
    await mkdir(join(dir, 'notes.json'));
    await assert.rejects(s.save({ scratch: 'not on disk', snippets: [] }));
    assert.equal((await s.get()).scratch, 'on disk');
    const failed = await s.change(n => setScratch(n, 'still not', n.scratch)).catch(() => null);
    assert.equal(failed, null);
    assert.equal((await s.get()).scratch, 'on disk');
    await rm(join(dir, 'notes.json'), { recursive: true });
    const { saved } = await s.change(n => setScratch(n, 'now on disk', n.scratch));
    assert.equal(saved.scratch, 'now on disk');
    assert.equal((await new NotesStore(dir).get()).scratch, 'now on disk');
  });
});

test('notes changes at the same moment each see the one before: none lost, and a stale scratch pad is a clash', async () => {
  await inDir(async dir => {
    const s = new NotesStore(dir);
    await Promise.all(Array.from({ length: 12 }, (_, i) => s.change(n => addSnippet(n, `snippet ${i}`))));
    assert.equal((await s.get()).snippets.length, 12);
    assert.equal((await new NotesStore(dir).get()).snippets.length, 12);
    const [a, b] = await Promise.all([s.change(n => setScratch(n, 'first', '')), s.change(n => setScratch(n, 'second', ''))]);
    assert.deepEqual([a.result.ok, b.result.ok], [true, false]);
    assert.equal((await s.get()).scratch, 'first');
  });
});

test('the real notes route: saves at once on a fresh start and later all survive, and the scratch pad clash answers 409', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-saves-'));
  const s = await boot(home);
  try {
    const cold = await Promise.all(Array.from({ length: 20 }, (_, i) => post(s.base, '/api/notes', { add: `first ${i}` })));
    assert.ok(cold.every(r => r.status === 200));
    const warm = await Promise.all(Array.from({ length: 20 }, (_, i) => post(s.base, '/api/notes', { add: `later ${i}` })));
    assert.ok(warm.every(r => r.status === 200));
    const now = await (await fetch(`${s.base}/api/notes`)).json() as { snippets: unknown[] };
    assert.equal(now.snippets.length, 40);
    const clash = await Promise.all([post(s.base, '/api/notes', { scratch: 'one', was: '' }), post(s.base, '/api/notes', { scratch: 'two', was: '' })]);
    assert.deepEqual(clash.map(r => r.status).sort(), [200, 409]);
    assert.ok(clash.find(r => r.status === 409)?.body.notes, 'the clash sends back what is saved');
  } finally {
    await s.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

// ---- Keep hands the picture in; a chat's files move ----

test('the real routes: Keep copies a draft into its project once, and putting a chat in a project moves all its files', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-saves-'));
  const workspace = join(home, 'data', 'workspace');
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data', 'staff.json'), JSON.stringify({ staff: [{ id: 'wren', name: 'Wren Example', role: 'coder', level: 'default', model: '' }] }));
  let s = await boot(home);
  try {
    const made = await post(s.base, '/api/projects/create', { name: 'Shop page', prompt: 'a shop page', folder: 'shop' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const chat = await post(s.base, '/api/chats/new', { who: 'staff:wren' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    const id = chat.body.chat.id as string;
    const folder = (await post(s.base, '/api/chats/project', { id, project: '' })).body.chat.saveTo.dir as string;
    assert.match(folder, /^chats\//);
    await s.stop();

    // Files in a quick chat's folder: text, not text, in a sub-folder, and past the 500 the browsing list stops at.
    const from = join(workspace, ...folder.split('/'));
    mkdirSync(join(from, 'sub'), { recursive: true });
    writeFileSync(join(from, 'notes.md'), 'words');
    writeFileSync(join(from, 'picture.webp'), 'not text');
    writeFileSync(join(from, 'sub', 'deep.txt'), 'deep');
    mkdirSync(join(workspace, '0000-busy'), { recursive: true });
    for (let i = 0; i < 520; i++) writeFileSync(join(workspace, '0000-busy', `f${i}.txt`), 'x');
    // A draft in that chat, on the disk before the server reads the gallery.
    const images = join(home, 'data', 'images');
    mkdirSync(join(images, '2026-10'), { recursive: true });
    writeFileSync(join(images, '2026-10', 'cat.png'), 'a picture');
    writeFileSync(join(images, 'gallery.jsonl'), `${JSON.stringify(pic('cat', { kept: false, chat: id, prompt: 'a cat', output: '2026-10/cat.png', original: '2026-10/cat.png' }))}\n`);

    s = await boot(home);
    const moved = await post(s.base, '/api/chats/project', { id, project: made.body.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(existsSync(from), false, `the chat's folder is empty and gone: ${moved.body.said}`);
    assert.match(moved.body.said, /3 files from this chat moved/);
    const projectFiles = readdirSync(join(workspace, 'shop'), { recursive: true }).map(String);
    assert.ok(projectFiles.some(f => f.endsWith('picture.webp')), projectFiles.join());
    assert.ok(projectFiles.some(f => f.endsWith('deep.txt')), projectFiles.join());

    const kept = await post(s.base, '/api/images/keep', { id: 'cat', kept: true });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.kept, true);
    const handed = () => { try { return readdirSync(join(workspace, 'shop', 'specialists', 'images')); } catch { return []; } };
    for (let i = 0; i < 40 && !handed().length; i++) await sleep(100);
    assert.equal(handed().length, 1, 'the draft is handed in');
    assert.equal(await readFile(join(workspace, 'shop', 'specialists', 'images', handed()[0]), 'utf8'), 'a picture');
    await post(s.base, '/api/images/keep', { id: 'cat', kept: true });
    await sleep(300);
    assert.equal(handed().length, 1, 'Keep pressed again hands nothing more in');
  } finally {
    await s.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('filesUnder lists every file of one folder, whatever else is in the workspace, and says which links it did not follow', { skip: process.platform !== 'win32' && 'junctions' }, async () => {
  await inDir(async dir => {
    const root = join(dir, 'workspace');
    const busy = join(root, 'aaa');
    mkdirSync(busy, { recursive: true });
    for (let i = 0; i < 510; i++) writeFileSync(join(busy, `f${i}.txt`), 'x');
    mkdirSync(join(root, 'chats', 'one', 'sub'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'secret.txt'), 'x');
    writeFileSync(join(root, 'chats', 'one', 'a.md'), 'x');
    writeFileSync(join(root, 'chats', 'one', 'b.png'), 'x');
    writeFileSync(join(root, 'chats', 'one', 'sub', 'c.pdf'), 'x');
    symlinkSync(join(dir, 'outside'), join(root, 'chats', 'one', 'jump'), 'junction');
    const got = await ws.filesUnder(root, 'chats/one');
    assert.deepEqual(got?.files.sort(), ['chats/one/a.md', 'chats/one/b.png', 'chats/one/sub/c.pdf']);
    assert.deepEqual(got?.links, ['chats/one/jump']);
    assert.deepEqual(got?.folders, ['chats/one/sub']);
    assert.equal(await ws.filesUnder(root, 'chats/none'), null);
  });
});

// ---- Backups ----

test('a backup that left out a link says which, and a note of it goes in the zip but never comes back into the data', { skip: process.platform !== 'win32' && 'junctions' }, async () => {
  await inDir(async dir => {
    const home = keep.resolveHome({ TOMLIN_HOME: join(dir, 'home') } as NodeJS.ProcessEnv);
    mkdirSync(join(home.data, 'workspace'), { recursive: true });
    writeFileSync(join(home.data, 'workspace', 'mine.txt'), 'mine');
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'far.txt'), 'far');
    symlinkSync(join(dir, 'outside'), join(home.data, 'workspace', 'jump'), 'junction');
    const made = await keep.backupSaying(home, 'by hand');
    assert.deepEqual(made.links, ['workspace/jump']);
    const names = (await listZip(join(home.backups, made.name))).map(e => e.name);
    assert.ok(names.includes(keep.LINKS_NOTE));
    assert.ok(!names.some(n => n.includes('far.txt')), 'the link is not followed');
    assert.ok(names.includes('workspace/mine.txt'));

    await keep.restore(home, made.name, '2.0.68');
    assert.equal(existsSync(join(home.data, keep.LINKS_NOTE)), false, 'the note does not come back into the data');
    assert.equal(await readFile(join(home.data, 'workspace', 'mine.txt'), 'utf8'), 'mine');

    rmSync(join(home.data, 'workspace', 'jump'), { recursive: true, force: true });
    const clean = await keep.backupSaying(home, 'no links');
    assert.deepEqual(clean.links, []);
    assert.ok(!(await listZip(join(home.backups, clean.name))).some(e => e.name === keep.LINKS_NOTE), 'nothing left out: no note');
    assert.equal(typeof await keep.backup(home, 'plain'), 'string');
  });
});

// ---- A prompt's limit ----

test('one limit for a prompt, here and on another PC: over it is refused in words, never cut', () => {
  assert.equal(promptWhy('a'.repeat(2000)), null);
  assert.match(promptWhy('a'.repeat(2001)) ?? '', /too long/);
  assert.equal(promptWhy('a'.repeat(1500)), null, 'a prompt over the old 1,000 for another PC goes whole');
});
