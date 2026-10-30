// The real thing on the CPU only: TOMLIN started on an empty home, the 0.8B model loaded with Run on: CPU, a hire
// answers in words (tokens come, however slowly), and two sends at the same moment in one chat take turns (before,
// both answered from the same history and their lines landed mixed: user, user, answer, answer). Needs the CPU runner
// in runtime/llama-cpu and the 0.8B model in the folder models-folder.txt names; skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = join(ROOT, 'runtime', 'llama-cpu', 'llama-server.exe');
const MODELS = (() => {
  try {
    return readFileSync(join(ROOT, 'models-folder.txt'), 'utf8').trim();
  } catch {
    return '';
  }
})();
const ready = existsSync(RUNNER) && !!MODELS && existsSync(join(MODELS, 'Qwen3.5-0.8B-Q4_K_M.gguf'));

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('on the CPU only, a hire answers in words, and two sends at once in one chat take turns', { skip: ready ? false : 'needs runtime/llama-cpu and the 0.8B test model', timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-cpuchat-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), MODELS);
  // The runners are this copy's: the empty home borrows its runtime folder.
  symlinkSync(join(ROOT, 'runtime'), join(home, 'runtime'), 'junction');
  const port = await freePort();
  const server = spawn(process.execPath, [join(ROOT, 'src', 'server.ts')], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const send = async (b: unknown) => (await post('/api/chat', b)).text();
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
    assert.match(said, /is running at/, said);
    const id = (await get('/api/models')).chat[0]?.id;
    assert.ok(id, 'the test model is listed');
    assert.equal((await post('/api/settings', { pane: 'chat', asked: 'cpu', threads: 2 })).status, 200);
    assert.equal((await post(`/api/models/${encodeURIComponent(id)}/load`, { device: 'cpu', threads: 2 })).status, 202);
    let pane: { state: string; device?: string } = { state: 'loading' };
    for (let i = 0; i < 300 && pane.state === 'loading'; i++) {
      await sleep(500);
      pane = (await get('/api/status')).panes.chat;
    }
    assert.equal(pane.state, 'connected', JSON.stringify(pane));
    assert.equal(pane.device, 'cpu');
    assert.equal((await post('/api/staff', { action: 'hire', name: 'Cpu Test', role: 'default', level: 'default', model: id })).status, 200);
    const who = 'staff:cpu-test';
    const first = await send({ chatId: '', who, message: 'Count from 1 to 5, separated by commas.' });
    const done = /event: done\ndata: (.*)/.exec(first);
    assert.ok(done, first.slice(-500));
    const answer = JSON.parse(done[1]) as { text: string; perSecond: number };
    assert.match(answer.text, /1.*2.*3/s);
    assert.ok(answer.perSecond > 0, 'tokens were made');
    const chatId = /"chat":"([^"]+)"/.exec(first)![1];
    await Promise.all([send({ chatId, who, message: 'Say only: one.' }), send({ chatId, who, message: 'Say only: two.' })]);
    const lines = ((await get(`/api/chat?chat=${chatId}`)).lines ?? []) as Array<{ role: string; content: string }>;
    const roles = lines.map(l => l.role).join(',');
    // Every answer follows the message it answers: never two answers in a row.
    assert.doesNotMatch(roles, /assistant,assistant/, roles);
    assert.equal(lines.at(-1)?.role, 'assistant', roles);
    assert.equal(lines.at(-2)?.role, 'user', roles);
  } finally {
    server.kill();
    await sleep(1500);
    // The borrowed runtime is unlinked first, and the home is removed only once it is surely gone (never this copy's runners).
    rmSync(join(home, 'runtime'), { force: true });
    if (!existsSync(join(home, 'runtime'))) rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
