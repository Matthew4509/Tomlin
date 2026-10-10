// The disk fills up while TOMLIN runs: the server, started on an empty home with test/fulldisk.mjs loaded, has every
// write inside its home fail as a full disk fails it (ENOSPC) while <home>/.disk-full is there. Each save that cannot
// happen must say so (and say what to do), the server must keep answering, nothing saved before may be lost or left
// half written, and once space is back the same saves work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});
const filesIn = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name));

test('a full disk: each save says the disk is full, the server keeps answering, nothing is lost, and saves work again after', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-diskfull-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, ['--import', pathToFileURL(fileURLToPath(new URL('./fulldisk.mjs', import.meta.url))).href, fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  let exited = false;
  server.on('exit', () => (exited = true));
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  const errorOf = (b: Record<string, unknown>) => String(typeof b.error === 'object' && b.error ? (b.error as { message?: string }).message : b.error ?? '');
  const flag = join(home, '.disk-full');
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);

    // Saved while there is space.
    assert.equal((await post('/api/staff', { action: 'hire', name: 'Wren', role: 'writer', level: 'junior' })).status, 200);
    const made = await post('/api/chats/new', { who: 'staff:wren' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = (made.body.chat as { id: string }).id;
    assert.equal((await post('/api/chats/rename', { id, title: 'Before the disk filled' })).status, 200);
    assert.equal((await post('/api/pc/power', { id: 'here', watts: 100, kwh: '' })).status, 200);
    const note = await post('/api/notes/save', { text: 'A made-up note saved before the disk filled' });
    assert.equal(note.status, 200, JSON.stringify(note.body));

    writeFileSync(flag, '');
    const tries = {
      rename: await post('/api/chats/rename', { id, title: 'While the disk is full' }),
      newChat: await post('/api/chats/new', { who: 'staff:wren' }),
      hire: await post('/api/staff', { action: 'hire', name: 'Ivo', role: 'writer', level: 'junior' }),
      power: await post('/api/pc/power', { id: 'here', watts: 250, kwh: '' }),
      note: await post('/api/notes/save', { text: 'A made-up note while the disk is full' }),
    };
    for (const [k, r] of Object.entries(tries)) {
      assert(r.status >= 400, `${k}: ${r.status} ${JSON.stringify(r.body)}`);
      // Fault, reason, way out: it names a full disk and what to do, not only a code.
      assert.match(errorOf(r.body), /disk .*full|full .*disk/i, `${k}: ${errorOf(r.body)}`);
      assert.match(errorOf(r.body), /free (up )?some space/i, `${k}: ${errorOf(r.body)}`);
    }
    // Still answering, and what was saved before reads back whole.
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    const during = JSON.stringify(await (await fetch(`${base}/api/chats`)).json());
    assert(during.includes('Before the disk filled') && !during.includes('While the disk is full'), during.slice(0, 400));
    // A save that was refused does not show as done either: not in the list, not in the team, not in the settings.
    assert.equal((JSON.parse(during) as { chats: unknown[] }).chats.length, 1, 'only the chat made before');
    assert(!JSON.stringify(await (await fetch(`${base}/api/staff`)).json()).includes('Ivo'), 'the refused hire is on the team');
    assert(!JSON.stringify(await (await fetch(`${base}/api/pc?id=here`)).json()).includes('250'), 'the refused power setting shows');
    assert(!exited, 'the server stopped: ' + said.slice(-2000));
    // No half-written copy left behind by a save that failed.
    assert.deepEqual(filesIn(home).filter(f => /\.tmp$/i.test(f)), []);

    rmSync(flag);
    const after = await post('/api/chats/rename', { id, title: 'After space came back' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal((await post('/api/pc/power', { id: 'here', watts: 250, kwh: '' })).status, 200);
    const back = JSON.stringify(await (await fetch(`${base}/api/chats`)).json());
    assert(back.includes('After space came back'), back.slice(0, 400));
    assert.equal((await post('/api/notes/save', { text: 'A made-up note after space came back' })).status, 200);
    // A failing log file must not turn into a flood of messages about itself.
    assert(said.length < 200_000, `the window said ${said.length} characters`);
    assert(!exited, 'the server stopped: ' + said.slice(-2000));
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
