// Audit of the projects, jobs, agents, memory and to-do area (27 Nov 2026). Each test is named after its finding: a P0
// fails now and passes once fixed; a P1 or P2 is marked todo. One real server is started for the HTTP tests, on 8794
// (or a free port when 8794 is taken), with its home in %TEMP%\tomlin-audit-projects; no model is loaded.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './env.ts';
import { dueNow, nextTime } from '../src/agenttriggers.ts';
import { Notebooks, INBOX_GROUP } from '../src/memory.ts';
import { Store } from '../src/store.ts';
import { logAction } from '../src/actionlog.ts';
import { TodoStore } from '../src/todo.ts';

const ROOT = join(tmpdir(), 'tomlin-audit-projects');
mkdirSync(ROOT, { recursive: true });
const scratch = (name: string) => mkdtempSync(join(ROOT, `${name}-`));
const DAY = 86_400_000;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const portFree = (port: number) => new Promise<boolean>(resolve => {
  const s = createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

// ---- The server, shared by the HTTP tests ----

let server: ChildProcess | null = null;
let home = '';
let base = '';
let said = '';
const post = async (p: string, body: unknown) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const get = async (p: string) => (await (await fetch(`${base}${p}`)).json()) as Record<string, any>;

before(async () => {
  home = scratch('home');
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = (await portFree(8794)) ? 8794 : await freePort();
  server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: testEnv({ TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', d => (said += d));
  server.stderr!.on('data', d => (said += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400 && !said.includes('is running at'); i++) await wait(300);
  assert.match(said, /is running at/, said);
  assert.equal((await post('/api/staff', { action: 'hire', name: 'Robin', role: 'agent', level: 'default' })).status, 200);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(r => server!.once('exit', r));
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      break;
    } catch {
      await wait(500);
    }
  }
});

/** A standing job by hand only, approved and saved; its id. */
async function handJob(name: string): Promise<string> {
  const text = `Name: ${name}\nAgent: Robin\nWhen: By hand\nTask: Write one line about the weather.\nTools: working notes`;
  const saved = await post('/api/agents', { action: 'save', text, approve: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body.saved as string;
}
const runsOf = async (job: string) => ((await get('/api/agents')).runs as any[]).filter(r => r.job === job);
const pauseQueue = (paused: boolean) => post('/api/queue/pause', { paused });

// ---- Agents: Pause, Run now, Delete ----

test('A-01: Pause stops a run of that job that is already waiting in the queue', { timeout: 300_000 }, async () => {
  const job = await handJob('Weather line A01');
  await pauseQueue(true);
  try {
    assert.equal((await post('/api/agents', { action: 'run', job })).status, 200);
    assert.equal((await runsOf(job))[0].state, 'waiting');
    // The person pauses the job while its run waits for the PC.
    assert.equal((await post('/api/agents', { action: 'pause', job, paused: true })).status, 200);
  } finally {
    await pauseQueue(false);
  }
  let run: any = null;
  for (let i = 0; i < 360; i++) {
    run = (await runsOf(job))[0];
    if (run.state !== 'waiting' && run.state !== 'running') break;
    await wait(500);
  }
  // Expected: the paused job's run does not go ahead (stopped or skipped, saying it was paused). Now it runs as if
  // nothing was pressed (here it fails only because this PC has no model).
  assert.notEqual(run.state, 'running');
  assert.match(`${run.state} ${run.line}`, /paus/i, JSON.stringify(run));
});

test('A-02: Run now pressed twice at once puts one run in line, not two', { timeout: 120_000 }, async () => {
  const job = await handJob('Weather line A02');
  await pauseQueue(true);
  try {
    const [a, b] = await Promise.all([post('/api/agents', { action: 'run', job }), post('/api/agents', { action: 'run', job })]);
    const runs = (await runsOf(job)).filter(r => r.state === 'waiting' || r.state === 'running');
    assert.equal(runs.length, 1, `statuses ${a.status} ${b.status}, ${runs.length} runs in line`);
  } finally {
    for (const r of await runsOf(job)) if (r.state === 'waiting') await post('/api/agents', { action: 'stop', job });
    await post('/api/agents', { action: 'delete', job });
    await pauseQueue(false);
  }
});

test('A-03: Delete ends a run of that job that was waiting, instead of leaving it listed as waiting', { timeout: 60_000 }, async () => {
  const job = await handJob('Weather line A03');
  await pauseQueue(true);
  try {
    assert.equal((await post('/api/agents', { action: 'run', job })).status, 200);
    assert.equal((await post('/api/agents', { action: 'delete', job })).status, 200);
    const run = (await runsOf(job))[0];
    assert.notEqual(run.state, 'waiting', JSON.stringify(run));
  } finally {
    await pauseQueue(false);
  }
});

// ---- Triggers and the clock ----

test('D-01: a clock that ran ahead and was put right does not leave a daily trigger silent until the wrong date', () => {
  const now = new Date(2026, 10, 27, 9, 0).getTime();
  const daily = { kind: 'daily' as const, at: '07:00', days: [0, 1, 2, 3, 4, 5, 6] };
  // The PC's clock jumped a year ahead (a flat clock battery, a bad time server), the timer saved its next time on
  // that clock, then the clock was put right.
  const wrong = nextTime(daily, now + 365 * DAY)!;
  const d = dueNow([daily], [wrong], now);
  // A daily trigger is never more than 8 days away: the next time must come back to this clock.
  assert.ok(d.next[0]! - now <= 8 * DAY, `next time is ${((d.next[0]! - now) / DAY).toFixed(0)} days away`);
  // The same for every N hours.
  const hours = { kind: 'hours' as const, hours: 6 };
  const h = dueNow([hours], [nextTime(hours, now + 365 * DAY)], now);
  assert.ok(h.next[0]! - now <= DAY, `every 6 hours: next is ${((h.next[0]! - now) / DAY).toFixed(0)} days away`);
});

test('D-02: a daily time the clocks skip (01:30 in London on the night they go forward) runs at the first minute after it', () => {
  // In its own process, on London's clock (the time zone is read when a process starts on Windows).
  const src = new URL('../src/agenttriggers.ts', import.meta.url).href;
  const code = `const { nextTime } = await import(${JSON.stringify(src)}); const d = new Date(nextTime({ kind: 'daily', at: '01:30', days: [0,1,2,3,4,5,6] }, new Date(2026, 2, 29, 0, 0).getTime())); console.log(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The file's own words: "a time that does not exist that night runs at the first minute after it" (02:00, when the clocks jump from 01:00 to 02:00).
  assert.equal(r.stdout.trim(), '2:00');
});

// ---- Memory ----

test('M-01: an entry edited in two windows does not silently lose the first edit', { timeout: 60_000 }, async () => {
  const add = await post('/api/memory', { scope: 'team', action: 'add', text: 'The van is booked on Fridays.' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const id = add.body.line.id as string;
  const opened = await get('/api/memory?scope=team');
  // Window A changes the line.
  const a = await post('/api/memory', { scope: 'team', action: 'edit', id, text: 'The van is booked on Mondays.' });
  assert.equal(a.status, 200);
  // Window B, opened before A saved, changes the same line from what it showed (its text and the notebook's time).
  const b = await post('/api/memory', { scope: 'team', action: 'edit', id, text: 'The van is booked on Fridays and Saturdays.', was: 'The van is booked on Fridays.', mtime: opened.mtime });
  const now = ((await get('/api/memory?scope=team')).lines as any[]).map(l => l.text);
  // Expected: B is told the line changed (409), or both edits are still there. Now B's save wins without a word.
  assert.ok(b.status === 409 || now.includes('The van is booked on Mondays.'), `B answered ${b.status}; the notebook holds ${JSON.stringify(now)}`);
});

test('M-02: an agent\'s Inbox proposals never fill the notebook so the person cannot keep a line', async () => {
  const dir = scratch('books');
  try {
    const books = new Notebooks(new Store(dir));
    // 67 daily runs of 3 proposals each, none kept or dropped yet: written as the file would be (adding them one by one
    // takes about a quarter of a second each).
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'staff-robin.md'), `# Memory: robin\n\n## ${INBOX_GROUP}\n\n${Array.from({ length: 200 }, (_, i) => `- Proposal number ${i} about a page that moved.`).join('\n')}\n`);
    assert.equal((await books.book('staff:robin')).entries.length, 200);
    const mine = await books.add('staff:robin', 'The shop closes on Mondays.', 'owner');
    assert.ok(!('error' in mine), 'error' in mine ? mine.error : '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Projects ----

test('P-01: a damaged plan.json is said, not dropped from every list without a word', { timeout: 60_000 }, async () => {
  const ws = (await get('/api/files')).folder as string;
  const id = '20261127-0300-ab12';
  mkdirSync(join(ws, 'jobs', id), { recursive: true });
  writeFileSync(join(ws, 'jobs', id, 'plan.json'), '{"id":"20261127-0300-ab12","goal":"A tip calculator","steps":[{"title":"Page"');
  const list = await get('/api/jobs');
  const named = [...(list.jobs as any[]), ...(list.unplanned as any[])].some(j => j.id === id);
  assert.ok(named, 'the project is in neither list, and nothing says its plan is damaged');
});

test('G-01: a project folder can never point outside the workspace (guard, passes now)', { timeout: 60_000 }, async () => {
  const ws = (await get('/api/files')).folder as string;
  const outside = scratch('outside');
  try {
    for (const folder of ['..\\..\\escape-a', '../escape-b', 'a/../../escape-c', 'C:\\escape-d', '\\\\?\\C:\\escape-e', 'jobs', 'CON', 'x/y/z/w']) {
      const r = await post('/api/projects/create', { name: 'Escape test', prompt: 'A tip calculator page.', folder });
      if (r.status === 200) assert.ok(existsSync(join(ws, ...String(r.body.folder).split('/'))), `${folder} -> ${r.body.folder}`);
      else assert.equal(r.status, 400, `${folder}: ${JSON.stringify(r.body)}`);
    }
    for (const n of ['escape-a', 'escape-b', 'escape-c']) assert.ok(!existsSync(join(dirname(ws), n)) && !existsSync(join(dirname(dirname(ws)), n)), n);
    // A junction inside the workspace that leads out of it.
    symlinkSync(outside, join(ws, 'leads-out'), 'junction');
    const r = await post('/api/projects/create', { name: 'Junction test', prompt: 'A tip calculator page.', folder: 'leads-out/sub' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(!existsSync(join(outside, 'sub')));
  } finally {
    rmSync(join(ws, 'leads-out'), { force: true, recursive: false });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---- To Do and the action log ----

test('T-01: a To Do note changed in two windows does not silently lose the first change', async () => {
  const dir = scratch('todo');
  try {
    const t = new TodoStore(join(dir, 'todo.json'));
    const added = await t.add({ project: 'job:20261127-0300-ab12', name: 'Tip calculator', note: 'Check the sums', zone: 'today', size: 60 });
    assert.ok(added.ok);
    const id = added.ok ? added.item!.id : '';
    await t.set(id, { note: 'Check the sums and the rounding' });
    // The second window still showed "Check the sums"; the To Do has no way to say so, and its save wins.
    const second = await (t.set as (id: unknown, o: Record<string, unknown>) => Promise<{ ok: boolean }>)(id, { note: 'Check the sums on a phone', was: 'Check the sums' });
    const v = await t.view({ 'job:20261127-0300-ab12': 'Tip calculator' });
    const note = v.zones[0].items[0].note;
    assert.ok(!second.ok || note.includes('rounding'), note);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L-01: the action log never stops recording a model\'s actions without a line saying so', () => {
  const dir = scratch('actions');
  try {
    const now = new Date(2026, 10, 27, 10, 0);
    const file = join(dir, '2026-11-27.log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'x'.repeat(5 * 2 ** 20));
    logAction(dir, { kind: 'command', window: 'workspace', action: 'ran a named command', outcome: 'done' }, now);
    const text = readFileSync(file, 'utf8');
    assert.match(text.slice(-400), /command|full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Prompt injection ----

test('S-01: a model\'s save in the workspace cannot rewrite an agent\'s report, which the next run reads unscanned', async () => {
  const { ownedByTomlin } = await import('../src/folders.ts');
  // The next run is handed its last report (src/server/agents.ts lastReportOf, src/agentrun.ts brief) with no prompt
  // scan; a coder hire's save_file in Default works from the workspace top, where agents\ is.
  assert.equal(ownedByTomlin('agents/robin/price-check/2026-11-27-0700/report.md'), true);
});
