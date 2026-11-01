// A new project's folder: named after the project, its own even when two are made at the same moment, and never made
// through a link that leads out of the workspace. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFolderFrom } from '../src/jobs.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const NOW = new Date(2026, 9, 7, 15, 30);

const freePort = () => new Promise<number>((ok, no) => {
  const s = createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});

/** A real TOMLIN on a throwaway home, with a folder outside its workspace for the links to lead to. */
async function withServer(fn: (s: { post: (path: string, b: unknown) => Promise<{ status: number; body: Record<string, any> }>; workspace: string; outside: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-projectfolders-'));
  const home = join(dir, 'home');
  const outside = join(dir, 'outside');
  mkdirSync(join(home, 'startup'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let said = '';
    server.stdout.on('data', d => (said += d));
    server.stderr.on('data', d => (said += d));
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(150);
    assert.match(said, /is running at/, said);
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, b: unknown) => {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
    const { workspace } = await (await fetch(`${base}/api/projects/setup`)).json() as { workspace: string };
    mkdirSync(workspace, { recursive: true });
    await fn({ post, workspace, outside });
  } finally {
    server.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('a project with no folder typed is named after the project, in plain words', () => {
  assert.equal(projectFolderFrom('Harbour: Bakery/2?', NOW), 'Harbour Bakery 2');
  assert.equal(projectFolderFrom('  tip-calculator ', NOW), 'tip-calculator');
  assert.equal(projectFolderFrom('Café für Äpfel', NOW), 'Café für Äpfel');
});

test('a name that cannot be a folder falls back to the date and time', () => {
  for (const name of ['', '   ', '???', '...', undefined, null, 'jobs', 'Notes', 'chats', 'CON', 'lpt1']) {
    assert.equal(projectFolderFrom(name, NOW), '2026-10-07-1530', String(name));
  }
});

test('the folder takes a long name\'s first words, and always passes the rules for a typed folder', () => {
  const made = projectFolderFrom('A very long project name that goes on for much longer than any folder needs to', NOW);
  assert.ok(made.length <= 40, made);
  assert.ok(made.startsWith('A very long'), made);
});

test('two projects with the same name, or at the same moment, each get a folder of their own', async () => {
  await withServer(async ({ post, workspace }) => {
    const one = await post('/api/projects/create', { name: 'Harbour: Bakery/2?', prompt: 'a shop page' });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.folder, 'Harbour Bakery 2');
    assert.ok(existsSync(join(workspace, 'Harbour Bakery 2')));
    const again = await post('/api/projects/create', { name: 'Harbour: Bakery/2?', prompt: 'another shop page' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.folder, 'Harbour Bakery 2 2');

    const names = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/api/projects/create', { name: 'Same moment', prompt: `page ${i}` })));
    for (const r of names) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(new Set(names.map(r => r.body.folder)).size, 6, names.map(r => r.body.folder).join(', '));

    // No name at all: the date and time, and still one folder each.
    const unnamed = await Promise.all(Array.from({ length: 4 }, (_, i) => post('/api/projects/create', { prompt: `page ${i}` })));
    for (const r of unnamed) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(new Set(unnamed.map(r => r.body.folder)).size, 4, unnamed.map(r => r.body.folder).join(', '));
    for (const r of unnamed) assert.match(r.body.folder, /^\d{4}-\d{2}-\d{2}-\d{4}/);
  });
});

test('a folder the person typed may still be shared, on purpose', async () => {
  await withServer(async ({ post }) => {
    const one = await post('/api/projects/create', { name: 'First', prompt: 'a page', folder: 'shared' });
    const two = await post('/api/projects/create', { name: 'Second', prompt: 'a page', folder: 'shared' });
    assert.equal(one.body.folder, 'shared');
    assert.equal(two.body.folder, 'shared');
  });
});

test('a folder that is already there, with the person\'s own files, is not taken by a new project', async () => {
  await withServer(async ({ post, workspace }) => {
    mkdirSync(join(workspace, 'Holiday'));
    writeFileSync(join(workspace, 'Holiday', 'mine.txt'), 'my own file');
    writeFileSync(join(workspace, 'Letters'), 'a file with that name');
    assert.equal((await post('/api/projects/create', { name: 'Holiday', prompt: 'a page' })).body.folder, 'Holiday 2');
    assert.equal((await post('/api/projects/create', { name: 'Letters', prompt: 'a page' })).body.folder, 'Letters 2');
  });
});

test('a refused project leaves no folder behind, so pressing again gets the same name', async () => {
  await withServer(async ({ post, workspace }) => {
    assert.equal((await post('/api/projects/create', { name: 'Refused first' })).status, 400, 'no prompt');
    assert.ok(!existsSync(join(workspace, 'Refused first')), 'no folder for a project that was not made');
    const made = await post('/api/projects/create', { name: 'Refused first', prompt: 'a page' });
    assert.equal(made.body.folder, 'Refused first');
  });
});

test('a project is never made through a link that leads out of the workspace', { skip: process.platform !== 'win32' && 'junctions' }, async () => {
  await withServer(async ({ post, workspace, outside }) => {
    writeFileSync(join(outside, 'keep.txt'), 'outside');
    symlinkSync(outside, join(workspace, 'jump'), 'junction');
    for (const folder of ['jump', 'jump/made-outside', 'jump/two/levels']) {
      const r = await post('/api/projects/create', { name: 'Through a link', prompt: 'a page', folder });
      assert.equal(r.status, 400, `${folder}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /outside the workspace/);
    }
    assert.deepEqual(readdirSync(outside), ['keep.txt'], 'the outside folder stays as it was');

    // A project's own name that is the link's name: the default moves on to a folder that is really inside.
    const named = await post('/api/projects/create', { name: 'jump', prompt: 'a page' });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.equal(named.body.folder, 'jump 2');
    assert.deepEqual(readdirSync(outside), ['keep.txt']);
  });
});

test('Start project\'s save follows the same rules', { skip: process.platform !== 'win32' && 'junctions' }, async () => {
  await withServer(async ({ post, workspace, outside }) => {
    symlinkSync(outside, join(workspace, 'jump'), 'junction');
    const answers = { what: 'A page that shows the opening hours', who: 'People nearby', must: ['Shows the hours'], statement: 'A page that shows the opening hours' };
    const through = await post('/api/projects/save', { answers, home: { name: 'Hours', folder: 'jump/hours' } });
    assert.equal(through.status, 400, JSON.stringify(through.body));
    assert.deepEqual(readdirSync(outside), []);
    const made = await post('/api/projects/save', { answers, home: { name: 'Hours page' } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.ok(existsSync(join(workspace, 'Hours page')), 'named after the project');
  });
});
