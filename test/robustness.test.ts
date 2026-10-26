// The base holds up: text cut in the middle of an emoji never reaches a model runner (llama-server refuses the whole
// ask, measured: a 500), a failed first read of the settings is tried again, two changes to the chat list at once both
// stay, and a runner Disconnect lands on while it is still starting is ended, not left running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamChat } from '../src/engine.ts';
import { cleanNote } from '../src/memory.ts';
import { Store } from '../src/store.ts';
import { Chats } from '../src/chats.ts';
import { Pane } from '../src/pane.ts';
import { alive } from '../src/hardware.ts';

/** JSON with a lone surrogate escape: what llama-server's parser refuses. */
const LONE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

test('half an emoji (cut by a length limit) never reaches the model: the ask is always well-formed', async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => (body += c));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // A notebook line cut at 300 characters with an emoji there, as cleanNote cuts it, and a stray low half.
    const note = cleanNote(`${'x'.repeat(299)}😀 and more after it`);
    const turns = [
      { role: 'system' as const, content: `Notes:\n${note}` },
      { role: 'user' as const, content: `tail half: \udc00 then text` },
      { role: 'assistant' as const, content: '😀'.repeat(3).slice(0, 5) },
      { role: 'user' as const, content: 'Whole emoji are kept: 😀 🎹' },
    ];
    await streamChat(base, 'm', turns, () => undefined, new AbortController().signal, 64);
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0], LONE, 'no lone surrogate in the request');
    const sent = JSON.parse(bodies[0]) as { messages: { content: string }[] };
    for (const m of sent.messages) assert.ok(m.content.isWellFormed(), JSON.stringify(m.content.slice(-20)));
    assert.ok(sent.messages.some(m => m.content.includes('😀 🎹')), 'whole emoji untouched');
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('a first read of the settings that fails (the file held by another program) is tried again, not refused until restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-settings-'));
  try {
    // A folder where settings.json should be: reading it fails.
    await mkdir(join(dir, 'settings.json'));
    const store = new Store(dir);
    await assert.rejects(store.settings());
    await rmdir(join(dir, 'settings.json'));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ managerName: 'Ann' }));
    assert.equal((await store.settings()).managerName, 'Ann', 'read again once the file can be read');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two changes to the chat list at the same moment, just after start: both are kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-chatrace-'));
  try {
    const seed = new Chats(new Store(dir));
    const old = await seed.create('manager');
    // A fresh start: nothing read yet, then a new chat and a rename land together.
    const chats = new Chats(new Store(dir));
    const [made] = await Promise.all([chats.create('manager'), chats.mark(old.id, { title: 'Renamed' } as never)]);
    const again = new Chats(new Store(dir));
    assert.ok(await again.get(made.id), 'the new chat is in the list on disk');
    assert.ok(await again.get(old.id), 'the old one too');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Disconnect pressed while Connect is still starting the runner: nothing is left running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-orphan-'));
  const fake = join(dir, 'fake-runner.mjs');
  await writeFile(fake, `import { createServer } from 'node:http';
createServer((q, s) => { s.writeHead(200); s.end('{"status":"ok"}'); }).listen(Number(process.argv[2]), '127.0.0.1');
setTimeout(() => process.exit(0), 60000);
`);
  const pids: number[] = [];
  const pane = new Pane('chat');
  try {
    const req = {
      model: 'm', modelName: 'M', asked: 'auto' as const, threads: 0, devices: ['cpu' as const], expectedSeconds: 1, why: (t: string) => t,
      build: () => ({ exe: process.execPath, args: (port: number) => [fake, String(port)], ready: async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`)).ok, device: 'cpu' as const, timeoutSeconds: 20 }),
    };
    const first = pane.connect(req);
    // In the same moment: Connect is still waiting for a free port.
    await pane.disconnect();
    await first;
    await new Promise(r => setTimeout(r, 1500));
    if (pane.worker.pid) pids.push(pane.worker.pid);
    // Every node process started from the stand-in's file (what was really spawned), from Windows' own list.
    const { execFileSync } = await import('node:child_process');
    const listed = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${fake.replace(/\\/g, '\\\\').replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number)
      : [];
    pids.push(...listed);
    assert.equal(pane.view.state, 'disconnected');
    assert.deepEqual(pids.filter(p => alive(p)), [], 'no runner left running after Disconnect');
  } finally {
    for (const p of pids) if (alive(p)) process.kill(p);
    await pane.disconnect().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('watching a long answer for repeats as it streams costs little, and a loop is still cut where it began', async () => {
  const { repeatCut, repeatWatch } = await import('../src/engine.ts');
  // 60,000 characters with no repeat, fed a word at a time (an 8K-token answer): 10 s of checks before.
  const words: string[] = [];
  for (let i = 0; words.join(' ').length < 60_000; i++) words.push(i % 17 === 16 ? `item${i}.\n\nNext` : `w${i}`);
  const watch = repeatWatch();
  let text = '';
  const t0 = Date.now();
  for (const w of words) {
    text += `${w} `;
    assert.equal(watch(text), null);
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `${ms} ms of checks over a 60,000-character answer`);
  // A paragraph that comes round again: cut, and at the same place as a check of the whole answer.
  const para = 'This paragraph is long enough to count as one, and it says the same thing again.';
  const loop = repeatWatch();
  let looped = '';
  let cut: string | null = null;
  for (let i = 0; i < 40 && cut === null; i++) {
    looped += `${para}\n\n`;
    cut = loop(looped);
  }
  assert.ok(cut !== null, 'the loop was seen');
  assert.equal(cut, repeatCut(looped));
});

test('a linked PC sends a long answer as it grows without resending all of it for every word (306 MB for 8K tokens before)', async () => {
  const { paced } = await import('../src/engine.ts');
  // An 8,192-token answer (about 56,000 characters) written at 80 tokens a second, on a clock the test moves.
  let clock = 0;
  const sent: string[] = [];
  const pace = paced(text => sent.push(text), () => clock);
  let text = '';
  for (let i = 0; i < 8192; i++) {
    text += i % 12 === 11 ? 'word.\n' : 'word ';
    clock += 12.5;
    pace.push(text);
  }
  pace.flush();
  const chars = sent.reduce((n, s) => n + s.length, 0);
  assert.ok(chars < 8_000_000, `${(chars / 1e6).toFixed(1)} million characters sent for one answer`);
  assert.equal(sent.at(-1), text, 'the last words are always sent (before done)');
  assert.ok(sent.length > 50, `${sent.length} updates: the other PC still sees it grow`);
  // A short answer: every update within the first 150 ms is held, then sent.
  const few: string[] = [];
  let t = 0;
  const p2 = paced(s => few.push(s), () => t);
  p2.push('a');
  t += 10;
  p2.push('ab');
  t += 10;
  p2.push('abc');
  p2.flush();
  assert.deepEqual(few, ['a', 'abc']);
});
