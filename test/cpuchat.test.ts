// The real thing on the CPU only: TOMLIN started on an empty home, the 0.8B model loaded with Run on: CPU, a hire
// answers in words (tokens come, however slowly), and two sends at the same moment in one chat take turns (before,
// both answered from the same history and their lines landed mixed: user, user, answer, answer). Needs the CPU runner
// in runtime/llama-cpu and the 0.8B model in the folder models-folder.txt names; skipped without them. CPUCHAT_MODEL
// names another small model file in that folder to run it with (the 0.8B is not on every test PC).
// Steady under load: the home gets a models folder holding only the test model (the folder named can hold big models,
// and the first one listed is the one loaded); the copy runs as a test install (its own install folder), so it never
// moves the real install's current.txt; and the answer is judged on what TOMLIN does (it came back, in words, with
// tokens counted), not on how a small model at its chat temperature words it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const MODEL = process.env.CPUCHAT_MODEL || 'Qwen3.5-0.8B-Q4_K_M.gguf';
const ready = existsSync(RUNNER) && !!MODELS && existsSync(join(MODELS, MODEL));

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('on the CPU only, a hire answers in words, and two sends at once in one chat take turns', { skip: ready ? false : 'needs runtime/llama-cpu and the 0.8B test model (or CPUCHAT_MODEL)', timeout: 900_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-cpuchat-'));
  mkdirSync(join(home, 'startup'));
  // Only the test model in the folder the copy reads (a hard link costs no space; a copy where one cannot be made).
  const models = join(home, 'models');
  mkdirSync(models);
  try {
    linkSync(join(MODELS, MODEL), join(models, MODEL));
  } catch {
    copyFileSync(join(MODELS, MODEL), join(models, MODEL));
  }
  writeFileSync(join(home, 'models-folder.txt'), models);
  // The runners are this copy's: the empty home borrows its runtime folder.
  symlinkSync(join(ROOT, 'runtime'), join(home, 'runtime'), 'junction');
  const port = await freePort();
  // Every TOMLIN_ setting of the shell running the tests is dropped and every place a copy could write is in the home.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  Object.assign(env, {
    TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '',
    TOMLIN_INSTALL_ROOT: join(home, 'install'), TOMLIN_DESKTOP_DIR: join(home, 'desktop'), TOMLIN_START_MENU_DIR: join(home, 'start-menu'), TOMLIN_UNINSTALL_KEY: 'none',
  });
  const server = spawn(process.execPath, [join(ROOT, 'src', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(r => server.once('exit', r));
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const send = async (b: unknown) => (await post('/api/chat', b)).text();
  try {
    // Up to 2 minutes to start: a loaded PC starts Node slowly.
    for (let i = 0; i < 400 && !said.includes('is running at') && server.exitCode === null; i++) await sleep(300);
    assert.match(said, /is running at/, said);
    const id = (await get('/api/models')).chat[0]?.id;
    assert.ok(id, 'the test model is listed');
    assert.equal((await post('/api/settings', { pane: 'chat', asked: 'cpu', threads: 2 })).status, 200);
    assert.equal((await post(`/api/models/${encodeURIComponent(id)}/load`, { device: 'cpu', threads: 2 })).status, 202);
    let pane: { state: string; device?: string } = { state: 'loading' };
    // Up to 5 minutes to load; the whole test has 15 (a hang guard: three answers on 2 CPU threads, the CPU loaded, took over 5).
    for (let i = 0; i < 600 && pane.state === 'loading'; i++) {
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
    // An answer to the question, in words: it names a number from 1 to 5, as a figure or a word.
    assert.match(answer.text, /\b(1|2|3|4|5|one|two|three|four|five)\b/i, answer.text);
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
    // Gone before its home is removed (not a fixed time), up to 30 s.
    await Promise.race([exited, sleep(30_000)]);
    // The borrowed runtime is unlinked first, and the home is removed only once it is surely gone (never this copy's runners).
    rmSync(join(home, 'runtime'), { force: true });
    if (!existsSync(join(home, 'runtime'))) rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
