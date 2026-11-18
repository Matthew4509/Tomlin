import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_TOOLS, FileTurn, SAVE_DENIED, deniedFor, fileCallWords, filesFit, wantsFiles, wantsFilesFor, withFilesLine, type Permit } from '../src/filetools.ts';
import { CODE_BY_TOOLS, CODE_IN_CHAT, ROLES, staffSystem, type StaffMember } from '../src/staff.ts';

const run = (t: FileTurn, name: string, args: unknown) => t.run(name, JSON.stringify(args));
const allowed = { perCall: 4000, allowed: true };

test('the file tools are list_files, read_file and save_file', () => {
  assert.deepEqual(FILE_TOOLS.map(t => t.function.name), ['list_files', 'read_file', 'save_file']);
});

test('a model under 4B is not offered the file tools (a 0.8B offered them stopped answering what was asked)', () => {
  for (const small of ['Qwen3.5-0.8B-Q4_K_M', 'Qwen3.5-2B-Q4_K_M', 'gemma-2-2b-it-Q4_K_M']) assert.equal(filesFit(small), false, small);
  for (const big of ['Qwen3.6-35B-A3B-UD-Q2_K_XL', 'LFM2.5-8B-A1B-Q4_K_M', 'gpt-oss-20b-MXFP4', 'gemma-3n-E4B-it-Q4_K_M']) assert.equal(filesFit(big), true, big);
});

test('nothing is touched until the person allows it: Allow once lasts this answer, Allow for this thread is kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-'));
  try {
    await writeFile(join(root, 'app.js'), 'one');
    const asked: string[] = [];
    let kept = 0;
    const turn = (answer: Permit) => new FileTurn(root, { perCall: 4000, allowed: false, ask: async what => (asked.push(what), answer), onThread: async () => void kept++ });

    const no = turn('no');
    assert.match(await run(no, 'save_file', { path: 'app.js', text: 'two' }), /did not allow/i);
    assert.match(await run(no, 'read_file', { path: 'app.js' }), /did not allow/i);
    assert.match(await run(no, 'read_file', { path: 'app.js' }), /NOT allowed.*NOT read/s);
    assert.equal(asked.length, 1, 'asked once per answer, not again after a no');
    assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'one');

    const once = turn('once');
    assert.match(await run(once, 'read_file', { path: 'app.js' }), /one/);
    assert.match(await run(once, 'save_file', { path: 'app.js', text: 'two' }), /Saved app\.js/);
    assert.equal(asked.length, 2, 'once covers the rest of this answer');
    assert.equal(asked[1], 'Reading app.js');
    assert.equal(kept, 0);

    const thread = turn('thread');
    await run(thread, 'list_files', {});
    await run(thread, 'list_files', {});
    assert.equal(asked.length, 3);
    assert.equal(kept, 1, 'the chat is marked so its later answers are not asked');

    assert.match(await run(new FileTurn(root, allowed), 'read_file', { path: 'app.js' }), /two/);
    assert.equal(asked.length, 3, 'a thread already allowed is not asked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('with no one to ask (no page), nothing is touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-'));
  try {
    assert.match(await run(new FileTurn(root, { perCall: 4000, allowed: false }), 'list_files', {}), /did not allow/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file never gives back keys or passwords: well-known secret file names are refused, and text that looks like a key is withheld', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-secret-'));
  try {
    const t = new FileTurn(root, allowed);
    await writeFile(join(root, 'credentials.json'), '{"user":"me"}');
    await writeFile(join(root, 'secrets.yml'), 'a: 1');
    await writeFile(join(root, 'service-account.json'), '{}');
    await writeFile(join(root, 'app.secrets.json'), '{}');
    for (const p of ['credentials.json', 'secrets.yml', 'service-account.json', 'app.secrets.json']) assert.match(await run(t, 'read_file', { path: p }), /^Not read: .*keys or passwords by its name/, p);
    await writeFile(join(root, 'config.js'), 'export const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\n');
    await writeFile(join(root, 'notes.md'), 'password: hunter2hunter2hunter2\n');
    for (const p of ['config.js', 'notes.md']) {
      const said = await run(t, 'read_file', { path: p });
      assert.match(said, /^Not read: .*withheld/, p);
      assert.doesNotMatch(said, /sk-abc|hunter2/, p);
    }
    // An ordinary file is read as before.
    await writeFile(join(root, 'secretary.md'), 'Minutes of the meeting.');
    assert.match(await run(t, 'read_file', { path: 'secretary.md' }), /Minutes of the meeting/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a hire lists, reads and saves files in the workspace, and nothing outside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-'));
  const outside = await mkdtemp(join(tmpdir(), 'ft-out-'));
  try {
    await writeFile(join(root, 'app.js'), 'console.log(1);\n');
    await writeFile(join(outside, 'secret.txt'), 'no');
    const t = new FileTurn(root, allowed);
    assert.match(await run(t, 'list_files', {}), /app\.js/);
    assert.match(await run(t, 'read_file', { path: 'app.js' }), /console\.log\(1\);/);
    assert.match(await run(t, 'save_file', { path: 'src/new.ts', text: 'export const a = 1;\n' }), /Saved src\/new\.ts \(new file\)/);
    assert.equal(await readFile(join(root, 'src', 'new.ts'), 'utf8'), 'export const a = 1;\n');
    assert.match(await run(t, 'save_file', { path: 'app.js', text: 'console.log(2);\n' }), /Saved app\.js/);
    assert.equal(await readFile(join(root, 'app.js.bak'), 'utf8'), 'console.log(1);\n');
    for (const bad of ['../' + 'ft-out/secret.txt', join(outside, 'secret.txt'), 'C:\\Windows\\win.ini']) {
      assert.match(await run(t, 'read_file', { path: bad }), /not a text file in the workspace/i, bad);
      assert.match(await run(t, 'save_file', { path: bad, text: 'x' }), /inside the workspace/i, bad);
    }
    assert.match(await run(t, 'read_file', { path: 'gone.js' }), /no such file/i);
    assert.match(await run(t, 'save_file', { path: 'a.js' }), /no text to save/i);
    assert.match(await run(t, 'read_file', '{not json'), /could not be read/i);
    assert.match(await run(t, 'delete_file', { path: 'app.js' }), /no tool/i);
    assert.deepEqual(t.saved, ['src/new.ts', 'app.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a long file comes in parts, so one read cannot fill the context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-'));
  try {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2500));
    const t = new FileTurn(root, { perCall: 1000, allowed: true });
    const one = await run(t, 'read_file', { path: 'big.txt' });
    assert.match(one, /part 1 of 3/);
    assert.ok(one.length < 1300);
    assert.match(await run(t, 'read_file', { path: 'big.txt', part: 3 }), /part 3 of 3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the hire is told it can use the workspace, in its system turn', () => {
  const turns = withFilesLine([{ role: 'system', content: 'You are Rosa.' }, { role: 'user', content: 'Fix app.js' }]);
  assert.match(turns[0].content, /^You are Rosa\.\n\n.*read_file.*save_file/s);
  assert.equal(turns[1].content, 'Fix app.js');
  assert.match(withFilesLine([{ role: 'user', content: 'hi' }])[0].content, /save_file/);
  assert.equal(fileCallWords('read_file', '{"path":"app.js"}'), 'Reading app.js…');
  assert.equal(fileCallWords('save_file', '{"path":"app.js"}'), 'Saving app.js…');
});

test('with the file tools on, no hire is told to put a file in a code block for the Save button', () => {
  // Told both (a block for Save, and save_file), Qwen3.6 35B wrote save_file(...) as text in a ```js block and nothing
  // was saved (6 Nov 2026).
  for (const role of ROLES.filter(r => !r.kind)) {
    const card = staffSystem({ id: 'rosa', name: 'Rosa', role: role.id, level: 'default', model: 'm.gguf' } as StaffMember);
    const sent = withFilesLine([{ role: 'system', content: card }, { role: 'user', content: 'Make an app' }])[0].content;
    assert.ok(!sent.includes(CODE_IN_CHAT), role.id);
    assert.doesNotMatch(sent, /Save button|```|code in a code block/, role.id);
    if (card) assert.ok(sent.includes(CODE_BY_TOOLS), role.id);
  }
  const coder = staffSystem({ id: 'sam', name: 'Sam', role: 'coder', level: 'default', model: 'm.gguf' } as StaffMember);
  assert.ok(coder.includes(CODE_IN_CHAT) && coder.includes('```js'), 'without the tools, code still goes in a block');
  const sent = withFilesLine([{ role: 'system', content: coder }])[0].content;
  assert.match(sent, /call the save_file tool with the whole file, then say/);
  assert.match(sent, /- Saved index\.html and app\.js\./);
});

test('a request to write something new is answered in the chat, with no file tools offered (F1)', async () => {
  const projects = JSON.parse(await readFile(new URL('../benchmarks/soak/projects.json', import.meta.url), 'utf8')) as { projects?: { prompt: string }[] } | { prompt: string }[];
  const list = Array.isArray(projects) ? projects : projects.projects ?? [];
  assert.ok(list.length >= 15);
  for (const p of list) assert.equal(wantsFiles(p.prompt), false, p.prompt.slice(0, 60));
  for (const m of ['Write a Python function is_palindrome(s) that ignores case.', 'Please build me a calculator page in one HTML file.', 'Could you create a haiku about tea?']) assert.equal(wantsFiles(m), false, m);
});

test('a message about existing files, or asking for a save, keeps the file tools', () => {
  for (const m of [
    'Fix the bug in my app.js',
    'What files are in this folder?',
    'Read src/server/chat.ts and explain it.',
    'Write a function that sorts these, and save it as sort.js in my project.',
    'Create a README for the project in this folder.',
    'Build a game and save it to the drive.',
    'Update the existing file notes.md with a new line.',
    'Look through the code and tell me what is wrong.',
  ]) assert.equal(wantsFiles(m), true, m);
});

test('a plain question, or one with the code pasted in, is answered in the chat; a message that points at files, or a project chat, keeps the file tools (soak 17 Nov)', async () => {
  const prompts = JSON.parse(await readFile(new URL('../benchmarks/soak/prompts.json', import.meta.url), 'utf8')) as { id: string; prompt: string | string[] }[];
  assert.ok(prompts.length >= 150);
  // Only these two of the 157 soak prompts are about files (a .txt count in the folder; notes saved in named files).
  const about = new Set(['code-small-04', 'web-trigger-06']);
  for (const p of prompts) {
    const said = (Array.isArray(p.prompt) ? p.prompt : [p.prompt]).join('\n');
    assert.equal(wantsFiles(said), about.has(p.id), `${p.id}: ${said.slice(0, 60)}`);
  }
  assert.equal(wantsFiles('What is 7 times 8?'), false);
  assert.equal(wantsFiles('Why does this print a surprising result?\n\ndef add_item(x, bucket=[]):\n    bucket.append(x)\n    return bucket'), false);
  assert.equal(wantsFiles('Why does console.log(res.json()) print a promise?'), false);
  assert.equal(wantsFiles('Add a dark mode.', true), true, 'a chat in a project works on its folder');
  assert.equal(wantsFiles('Add a dark mode.', false), false);
  assert.equal(wantsFiles('Why is the output of app.js empty?'), true);
  assert.equal(wantsFiles(''), true, 'Continue has no message of its own');
});

test('Continue asks about the last thing the person said, not about an empty message (walk of 17 Nov)', () => {
  const chat = (q: string) => [{ role: 'user', content: q }, { role: 'assistant', content: 'A cut answer' }];
  assert.equal(wantsFilesFor('', chat('Tell me the history of the Roman Empire.')), false);
  assert.equal(wantsFilesFor('', chat('Fix the bug in my app.js')), true);
  assert.equal(wantsFilesFor('', chat('Write a to-do app in Node.')), false);
  assert.equal(wantsFilesFor('  ', chat('Why is 7 times 8 56?')), false);
  assert.equal(wantsFilesFor('', chat('Add a dark mode.'), true), true, 'a project chat works on its folder');
  assert.equal(wantsFilesFor('', []), true, 'nothing said in the chat: as before');
  assert.equal(wantsFilesFor('Tell me a joke.', chat('Fix the bug in my app.js')), false, 'a message of its own is judged on its own');
});

test('a save that was not allowed tells the model to write the whole answer in the chat', async () => {
  assert.equal(deniedFor('save_file'), SAVE_DENIED);
  assert.match(SAVE_DENIED, /Write the whole answer here in the chat/);
  assert.match(deniedFor('read_file'), /NOT allowed/);
  const root = await mkdtemp(join(tmpdir(), 'ft-'));
  try {
    const turn = new FileTurn(root, { perCall: 4000, allowed: false, ask: async () => 'no' });
    assert.equal(await run(turn, 'save_file', { path: 'a.js', text: 'x' }), SAVE_DENIED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
