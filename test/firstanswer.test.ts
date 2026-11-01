// The first answer of a project's chat, saved as a file: when it cannot be, the person is told why and can save it again,
// and a later, different answer is never saved in its place. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tomlin-firstanswer-'));
Object.assign(process.env, { TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const { workPost } = await import('../src/server/work.ts');
const { chats } = await import('../src/server/core.ts');
const { keepFirstAnswer, placesPost } = await import('../src/server/places.ts');
(await import('../src/server/jobs.ts')).startJobs();

const call = async (routes: any, path: string, b: unknown) => {
  let status = 0;
  let body: any;
  const res = { writeHead(s: number) { status = s; return this; }, end(x: string) { body = JSON.parse(x); } };
  await routes[path]({ res, b });
  return { status, body };
};

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  // The job routes keep this process alive; the results are out by now.
  setTimeout(() => process.exit(0), 300);
});

async function projectChat(folder: string) {
  const made = await call(workPost, '/api/projects/create', { name: 'First answers', folder, prompt: 'a page' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const c = await chats.create('manager');
  await chats.setProject(c.id, made.body.id);
  await chats.mark(c.id, { saveAnswer: true });
  return (await chats.get(c.id))!;
}

test('saved: its path comes back, and the flag is used up', async () => {
  const c = await projectChat('saved-here');
  const kept = await keepFirstAnswer(c, 'what to write', 'the answer');
  assert.ok('path' in kept!, JSON.stringify(kept));
  assert.equal((await chats.get(c.id))!.saveAnswer, undefined);
  assert.match(readFileSync(join(home, 'data', 'workspace', ...kept.path.split('/')), 'utf8'), /the answer/);
  assert.equal(await keepFirstAnswer((await chats.get(c.id))!, 'what to write', 'a second answer'), null, 'only the first');
});

test('not saved: it says why, a later answer is not saved as the first, and the same text can be saved again', async () => {
  const c = await projectChat('blocked-here');
  const folder = join(home, 'data', 'workspace', 'blocked-here');
  rmdirSync(folder);
  writeFileSync(folder, 'a file where the folder should be');
  const kept = await keepFirstAnswer(c, 'what to write', 'the first answer');
  assert.ok(kept && 'error' in kept, JSON.stringify(kept));
  assert.ok(kept.error.length > 3, 'a reason in words');

  // The next, different answer must not take the first's place.
  assert.equal((await chats.get(c.id))!.saveAnswer, undefined);
  assert.equal(await keepFirstAnswer((await chats.get(c.id))!, 'another question', 'a different answer'), null);

  // Still blocked: the button says so.
  const still = await call(placesPost, '/api/chats/keep-answer', { id: c.id, prompt: 'what to write', text: 'the first answer' });
  assert.equal(still.status, 400);
  assert.match(still.body.error, /not saved/);

  unlinkSync(folder);
  mkdirSync(folder);
  const again = await call(placesPost, '/api/chats/keep-answer', { id: c.id, prompt: 'what to write', text: 'the first answer' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(readdirSync(folder).length, 1);
  assert.match(readFileSync(join(folder, readdirSync(folder)[0]), 'utf8'), /the first answer/);
  assert.doesNotMatch(readFileSync(join(folder, readdirSync(folder)[0]), 'utf8'), /different/);
});

test('saving again refuses what cannot be saved', async () => {
  assert.equal((await call(placesPost, '/api/chats/keep-answer', { id: 'no-such-chat', prompt: 'x', text: 'y' })).status, 404);
  const plain = await chats.create('manager');
  assert.equal((await call(placesPost, '/api/chats/keep-answer', { id: plain.id, prompt: 'x', text: 'y' })).status, 400, 'a chat in no project');
  const c = await projectChat('empty-text');
  assert.equal((await call(placesPost, '/api/chats/keep-answer', { id: c.id, prompt: 'x', text: '  ' })).status, 400);
});

test('the chat says it plainly and offers the button', () => {
  const chat = read('src/server/chat.ts');
  assert.match(chat, /could not be saved/);
  assert.match(chat, /unsaved/);
  const page = read('public/chatview.js');
  assert.match(page, /if \(data\.unsaved\) out\.append\(saveAnswerAgain\(/);
  assert.match(read('public/app.js'), /\/api\/chats\/keep-answer/);
});
