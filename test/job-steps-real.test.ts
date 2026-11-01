// Job steps, the queue and handoffs through the real routes, with a stand-in for llama-server on this PC: what a step
// writes is whole, an existing big file is never written over, an answer with nowhere to go is kept, a fault is not an
// answer, and a project carries on after its picture. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResult } from '../src/jobs.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>((ok, no) => {
  const s = createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});

type Say = { text?: string; status?: number; error?: string };
let behave: (body: { messages: { content: string }[] }) => Say = () => ({ text: 'ok' });
let asked = 0;

const HOME = mkdtempSync(join(tmpdir(), 'sm-job-steps-'));
const PORT = await freePort();
const RUNNER = await freePort();
Object.assign(process.env, { TOMLIN_HOME: HOME, TOMLIN_PORT: String(PORT), TOMLIN_NO_TOAST: '1', TOMLIN_OPEN: '', TOMLIN_STARTUP_DIR: join(HOME, 'startup'), TOMLIN_MODELS_FILE: join(HOME, 'models-folder.txt') });
mkdirSync(join(HOME, 'startup'), { recursive: true });
mkdirSync(join(HOME, 'models', 'chat'), { recursive: true });
writeFileSync(join(HOME, 'models-folder.txt'), '');
writeFileSync(join(HOME, 'models', 'chat', 'fake-1B.gguf'), 'GGUF-not-really');

const runner = httpServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    asked++;
    const b = behave(JSON.parse(raw || '{}'));
    if (b.status) {
      res.writeHead(b.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: b.error ?? 'runner fault' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: b.text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 5, predicted_per_second: 50, prompt_n: 5, prompt_per_second: 50 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>(r => runner.listen(RUNNER, '127.0.0.1', r));

await import('../src/server.ts');
const panes = await import('../src/server/panes.ts');
const core = await import('../src/server/core.ts');
const modelId = panes.chatList()[0].id;
const pane = panes.main() as unknown as { worker: { port: number; view: Record<string, unknown> } };
pane.worker.port = RUNNER;
pane.worker.view = { ...pane.worker.view, state: 'connected', model: modelId, modelName: 'fake-1B', device: 'cpu', pid: 1 };
const hire = await core.staff.hire('Wren Test', 'writer', 'mid', modelId);
await core.staff.hire('Cody Test', 'coder', 'mid', modelId);
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/api/queue`).then(r => r.ok, () => false)) break;
  await sleep(100);
}
const root = await core.workspaceDir();

after(async () => {
  runner.close();
  // The server keeps this process alive; the results are out by now.
  setTimeout(() => process.exit(0), 300);
});

const U = `http://127.0.0.1:${PORT}`;
const post = async (p: string, b: unknown) => {
  const r = await fetch(U + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, text: await r.text() };
};
const events = async (p: string, b: unknown) => [...(await post(p, b)).text.matchAll(/^event: (.+)$/gm)].map(m => m[1]);
const step = (title: string, role: string, files: string[], brief = title) => ({ title, role, files, brief, check: '', status: 'todo', summary: '', wrote: [] as string[] });
let seq = 0;
const newJob = (steps: ReturnType<typeof step>[], extra: Record<string, unknown> = {}) => {
  const id = `20261101-1200-${(0x1000 + seq++).toString(16)}`;
  mkdirSync(join(root, 'jobs', id), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(root, 'jobs', id, 'plan.json'), JSON.stringify({ id, goal: 'a goal', created: at, updated: at, notes: '', steps, ...extra }));
  return id;
};
const job = (id: string) => JSON.parse(readFileSync(join(root, 'jobs', id, 'plan.json'), 'utf8')) as { steps: ReturnType<typeof step>[] };

test('a "Summary:" line in what a file says stays in the file; only the closing SUMMARY line closes a block with no END', () => {
  const doc = '# Report\n\nIntro.\n\nSummary: sales rose.\n\n**Summary:** more words.\n\n## Actions\n- do it';
  const withEnd = parseResult(`=== FILE: r.md ===\n${doc}\n=== END FILE ===\nSUMMARY: wrote it`, ['r.md']);
  assert.equal(withEnd.files[0].text, `${doc}\n`);
  assert.equal(withEnd.summary, 'wrote it');
  const noEnd = parseResult(`=== FILE: r.md ===\n${doc}\nSUMMARY: wrote it`, ['r.md']);
  assert.equal(noEnd.files[0].text, `${doc}\n`);
  assert.equal(noEnd.summary, 'wrote it');
  const inCapitals = parseResult('=== FILE: r.md ===\nline\nSUMMARY: an old heading\nmore\nand more\nand more still\nthe end', ['r.md']);
  assert.match(inCapitals.files[0].text, /the end/, 'a heading in capitals far from the end does not close it');
  const closes = parseResult('=== FILE: r.md ===\nline\n**SUMMARY:** wrote it', ['r.md']);
  assert.equal(closes.files[0].text, 'line\n');
});

test('the real route: a step writes a file with a Summary: line in it, whole', async () => {
  const id = newJob([step('Write the report', 'writer', ['report.md'])]);
  const doc = '# Report\n\nIntro.\n\nSummary: sales rose.\n\nThe rest of the report.';
  behave = () => ({ text: `=== FILE: report.md ===\n${doc}\n=== END FILE ===\nSUMMARY: wrote the report` });
  await events('/api/jobs/run', { id });
  assert.equal(job(id).steps[0].status, 'done');
  assert.equal(readFileSync(join(root, 'report.md'), 'utf8'), `${doc}\n`);
});

test('a step naming an existing file over 1 MB stops with words, and the file is as it was', async () => {
  const big = 'row,value\n'.repeat(120_000);
  writeFileSync(join(root, 'big.csv'), big);
  const id = newJob([step('Add a header', 'writer', ['big.csv'])]);
  const before = asked;
  behave = () => ({ text: '=== FILE: big.csv ===\nname,value\n=== END FILE ===\nSUMMARY: added it' });
  const said = (await post('/api/jobs/run', { id })).text;
  assert.match(said, /cannot be used by a step/);
  assert.equal(asked, before, 'the model is not asked');
  assert.equal(job(id).steps[0].status, 'todo');
  assert.equal(statSync(join(root, 'big.csv')).size, big.length);
  assert.equal(existsSync(join(root, 'big.csv.bak')), false);
});

test('Save refuses an existing file over 1 MB too, even with a result already waiting', async () => {
  writeFileSync(join(root, 'big2.txt'), 'x'.repeat((1 << 20) + 10));
  const id = newJob([step('Change it', 'writer', ['big2.txt'])]);
  const r = await post('/api/jobs/change', { id, action: 'accept', n: 0, files: [{ path: 'big2.txt', text: 'small' }], summary: 's' });
  assert.equal(r.status, 409, r.text);
  assert.equal(statSync(join(root, 'big2.txt')).size, (1 << 20) + 10);
});

test('a step with no files listed keeps a new file it names, and never writes over one that is there', async () => {
  const id = newJob([step('Write the tax function', 'coder', [])]);
  behave = () => ({ text: '=== FILE: tax.js ===\nexport const tax = p => p * 1.2;\n=== END FILE ===\nSUMMARY: wrote the tax function' });
  await events('/api/jobs/run', { id });
  assert.equal(job(id).steps[0].status, 'done');
  assert.deepEqual(job(id).steps[0].wrote, ['tax.js']);
  assert.match(readFileSync(join(root, 'tax.js'), 'utf8'), /p \* 1\.2/);

  writeFileSync(join(root, 'mine.js'), 'my own work\n');
  const two = newJob([step('Change my file', 'coder', [])]);
  behave = () => ({ text: '=== FILE: mine.js ===\nreplaced\n=== END FILE ===\nSUMMARY: changed it' });
  await events('/api/jobs/run', { id: two });
  assert.equal(readFileSync(join(root, 'mine.js'), 'utf8'), 'my own work\n');
  assert.deepEqual(job(two).steps[0].wrote, ['step-1 answer.md']);
  assert.match(readFileSync(join(root, 'step-1 answer.md'), 'utf8'), /replaced/, 'its words are kept to read');
});

test('a step with no files listed keeps a long plain answer in a file; a short one needs none', async () => {
  const words = `${'A long plain answer. '.repeat(40)}The end.`;
  const id = newJob([step('Write the words', 'writer', [])]);
  behave = () => ({ text: `${words}\nSUMMARY: wrote the words` });
  await events('/api/jobs/run', { id });
  const wrote = job(id).steps[0].wrote;
  assert.equal(wrote.length, 1);
  assert.match(readFileSync(join(root, wrote[0]), 'utf8'), /The end\./);

  const short = newJob([step('Say so', 'writer', [])]);
  behave = () => ({ text: 'SUMMARY: nothing needed doing' });
  await events('/api/jobs/run', { id: short });
  assert.equal(job(short).steps[0].status, 'done');
  assert.deepEqual(job(short).steps[0].wrote, []);
});

test('a re-run that fails keeps what came back before', async () => {
  const id = newJob([step('Write it', 'writer', ['kept.md'])]);
  behave = () => ({ text: '=== FILE: kept.md ===\nfirst\n=== END FILE ===\nSUMMARY: first' });
  await events('/api/jobs/step', { id, n: 0 });
  behave = () => ({ status: 500, error: 'runner crashed' });
  assert.ok((await events('/api/jobs/step', { id, n: 0 })).includes('error'));
  const { loadWaiting } = await import('../src/jobrun/jobfiles.ts');
  assert.equal((await loadWaiting(id))?.result.files[0].text, 'first\n');
});

test('the real queue: a chat message that faulted is sent again by Again, not shown as answered', async () => {
  const c = await core.chats.create(`staff:${hire.id}`);
  behave = () => ({ status: 500, error: 'runner crashed' });
  const add = JSON.parse((await post('/api/queue/add', { kind: 'chat', chat: c.id, message: 'What is 2+2?' })).text) as { items: { id: string }[] };
  const qid = add.items.at(-1)!.id;
  const finished = async () => {
    for (let i = 0; i < 300; i++) {
      const q = await (await fetch(`${U}/api/queue`)).json() as { items: { id: string; state: string; result?: string }[] };
      const it = q.items.find(x => x.id === qid);
      if (it && ['done', 'failed', 'needs', 'cancelled'].includes(it.state)) return it;
      await sleep(100);
    }
    throw new Error('the queue did not finish');
  };
  assert.notEqual((await finished()).state, 'done');
  const before = asked;
  behave = () => ({ text: 'Four.' });
  await post('/api/queue/again', { id: qid });
  const again = await finished();
  assert.equal(again.state, 'done');
  assert.ok(asked > before, 'the model is asked again');
  const lines = await core.chats.lines(c.id);
  assert.equal(lines.at(-1)?.content, 'Four.');
  assert.equal(lines.filter(l => l.failed).length, 0, 'the fault line came out with the old try');
});

test('the real queue: a project back from its picture carries on, also when it runs again after that step is done', async () => {
  const id = newJob([{ ...step('Draw the cover', 'artist', []), status: 'done', summary: 'Drawn.' }, step('Write the page', 'writer', ['page.md'])]);
  const at = new Date().toISOString();
  behave = () => ({ text: '=== FILE: page.md ===\nthe page\n=== END FILE ===\nSUMMARY: wrote the page' });
  await post('/api/queue/clear', { all: true });
  // What a Stop then Resume left saved: the project still naming a picture whose step is already marked done.
  writeFileSync(join(HOME, 'data', 'queue.json'), JSON.stringify({ paused: false, items: [
    { id: 'pic1', kind: 'picture', state: 'done', title: 'cover', prompt: 'cover', added: at, ended: at, project: id, projectName: 'p', step: 0, result: 'Drawn', output: 'x.png' },
    { id: 'proj1', kind: 'project', state: 'waiting', title: 'p', added: at, project: id, projectName: 'p', waitFor: 'pic1' },
  ] }));
  await post('/api/queue/pause', { paused: false });
  let it: { state: string; error?: string; waitFor?: string } | undefined;
  for (let i = 0; i < 300; i++) {
    const q = await (await fetch(`${U}/api/queue`)).json() as { items: { id: string; state: string; error?: string; waitFor?: string }[] };
    it = q.items.find(x => x.id === 'proj1');
    if (it && ['done', 'failed', 'needs'].includes(it.state)) break;
    await sleep(100);
  }
  assert.equal(it?.state, 'done', JSON.stringify(it));
  assert.equal(job(id).steps[1].status, 'done');
  assert.equal(readFileSync(join(root, 'page.md'), 'utf8'), 'the page\n');
});

test('a handoff chat stays in its project, with its Think and Web', async () => {
  const id = newJob([step('x', 'writer', ['y.md'])], { name: 'My project' });
  const c = await core.chats.create(`staff:${hire.id}`);
  await core.chats.setProject(c.id, id);
  await core.chats.mark(c.id, { web: true, think: true });
  const next = await core.chats.carryOn((await core.chats.get(c.id))!, 'The handoff.');
  assert.equal(next.project, id);
  assert.equal(next.think, true);
  assert.equal(next.web, true);
  const plain = await core.chats.create(`staff:${hire.id}`);
  const after = await core.chats.carryOn(plain, 'Another.');
  assert.equal('project' in after, false);
});
