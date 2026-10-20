// The start-line prompt says what the Bridge really reads: its own example, saved as a project.json, comes back as a
// working start command; the Prompts page gets it once (a deleted copy stays deleted); the page's copy is the same
// text; a project with no usable start line tells the page which file held a bad one.
// Run: node test/bridge/start-line.test.js   (no packages)
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { startCommands } = require('../../src/bridge/projects');
const { START_LINE_EXAMPLE, START_LINE_PROMPT, START_LINE_TITLE } = require('../../src/bridge/start-line');
const Prompts = require('../../src/bridge/prompts');

const NODE = process.execPath;
const SERVER = path.join(__dirname, 'serve.js');
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const portOpen = port => new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(1000, () => { s.destroy(); r(false); }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-start-line-'));
function make(folder, files) {
  const d = path.join(WS, folder);
  fs.mkdirSync(d, { recursive: true });
  for (const [rel, text] of Object.entries(files)) { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return d;
}
// The example exactly as the prompt shows it: the JSON block between the two blank lines after the first paragraph.
const shown = () => {
  const m = START_LINE_PROMPT.match(/\n\n(\{[\s\S]*?\n\})\n\n/);
  assert(m, 'no JSON block in the prompt');
  return JSON.parse(m[1]);
};

async function main() {
  await check('the example in the prompt text is the example object, as valid JSON', () => assert.deepStrictEqual(shown(), START_LINE_EXAMPLE));
  await check('the example, saved as a project.json, reads back as one start command run in its cwd with its env', () => {
    const dir = make('shop', { 'project.json': JSON.stringify(shown(), null, 2), 'frontend/package.json': '{}' });
    const skipped = [];
    const cs = startCommands(WS, dir, null, null, skipped);
    assert.deepStrictEqual(skipped, []);
    assert.strictEqual(cs.length, 1, JSON.stringify(cs));
    const c = cs[0], e = START_LINE_EXAMPLE.start;
    assert.strictEqual(c.from, 'project.json');
    assert.deepStrictEqual([c.name, c.exe, c.args, c.port], [e.name, e.exe, e.args, e.port]);
    assert.strictEqual(c.cwd, path.join(dir, 'frontend'));
    assert.deepStrictEqual(c.env, e.env);
  });
  await check('every field in the example is explained in the prompt', () => {
    for (const k of Object.keys(START_LINE_EXAMPLE.start).filter(k => k !== 'name')) assert(new RegExp('^- (.*\\. )?' + k + '\\b', 'm').test(START_LINE_PROMPT), k + ' not explained');
  });
  await check('the prompt names no folder on this PC and no address', () => assert(!/[A-Za-z]:\\|\/Users\/|@|https?:/.test(START_LINE_PROMPT)));
  await check('the prompt says TOMLIN starts the projects, not the stand-alone Bridge', () => {
    assert(/I start my projects with TOMLIN\./.test(START_LINE_PROMPT));
    assert(!/My Project Bridge|Myia/i.test(START_LINE_PROMPT));
  });

  // ---- Prompts page ----
  const pf = path.join(WS, 'data', 'prompts.json');
  await check('a new prompts file starts with the start-line prompt first, same text', () => {
    const st = Prompts.load(pf);
    assert.strictEqual(st.categories[0].name, 'TOMLIN');
    const p = st.prompts.find(x => x.category === st.categories[0].id);
    assert.deepStrictEqual([p.title, p.text], [START_LINE_TITLE, START_LINE_PROMPT]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(pf, 'utf8')).added, ['bridge']);
  });
  const old = path.join(WS, 'data', 'prompts-old.json');
  fs.writeFileSync(old, JSON.stringify({ categories: [{ id: 'mine', name: 'My prompts' }, { id: 'starter-seo', name: 'SEO specialist' }],
    prompts: [{ id: 'a1', category: 'mine', title: 'Mine', text: 'My own prompt.' }] }));
  await check('a file from an earlier version gets it once, at the front, and keeps everything it had', () => {
    const st = Prompts.load(old);
    assert.deepStrictEqual(st.categories.map(c => c.id), ['starter-bridge', 'mine', 'starter-seo']);
    assert.deepStrictEqual(st.prompts.map(p => p.id), ['starter-bridge-1', 'a1']);
    Prompts.load(old);
    assert.strictEqual(Prompts.load(old).prompts.filter(p => p.id === 'starter-bridge-1').length, 1, 'added twice');
  });
  await check('deleted by the person, it never comes back', () => {
    assert(Prompts.removeCategory(old, 'starter-bridge').ok);
    const st = Prompts.load(old);
    assert(!st.categories.some(c => c.id === 'starter-bridge') && !st.prompts.some(p => p.id === 'starter-bridge-1'), JSON.stringify(st.categories));
  });
  await check('a file that cannot be written (read-only, held by antivirus) still shows the list with the starter, and records it once it can', () => {
    const ro = path.join(WS, 'data', 'prompts-ro.json');
    const before = JSON.stringify({ categories: [{ id: 'mine', name: 'My prompts' }], prompts: [{ id: 'a1', category: 'mine', title: 'Mine', text: 'My own prompt.' }] });
    fs.writeFileSync(ro, before);
    fs.chmodSync(ro, 0o444);
    try {
      let st;
      assert.doesNotThrow(() => { st = Prompts.load(ro); });
      assert.deepStrictEqual(st.categories.map(c => c.id), ['starter-bridge', 'mine']);
      assert.strictEqual(fs.readFileSync(ro, 'utf8'), before, 'the read-only file was changed');
      assert(!fs.existsSync(ro + '.tmp'), 'a half-written copy was left beside it');
    } finally { fs.chmodSync(ro, 0o666); }
    Prompts.load(ro);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(ro, 'utf8')).added, ['bridge']);
  });
  await check('an edit elsewhere in the file keeps the record that it was given', () => {
    assert(Prompts.upsert(old, { category: 'mine', title: 'Two', text: 'Another.' }).ok);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(old, 'utf8')).added, ['bridge']);
    assert(!Prompts.load(old).categories.some(c => c.id === 'starter-bridge'));
  });

  // ---- A test copy of the Bridge: the page's copy, and which file held a bad start entry ----
  make('no-start', { 'README.md': '# A made-up project with no start line\n' });
  make('bad-start', { 'project.json': '{"start":{"exe":"node","args":"server.js","port":5000}}' });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-start-line-data-'));
  const PORT = await freePort();
  const srv = spawn(NODE, [SERVER, '--dry-run'], { env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_DATA: DATA, BRIDGE_ROOT: WS }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await portOpen(PORT)); i++) await sleep(200);
    const BASE = 'http://127.0.0.1:' + PORT;
    const key = ((await (await fetch(BASE + '/')).text()).match(/name="bridge-key" content="([0-9a-f]+)"/) || [])[1];
    const get = async p => (await fetch(BASE + p, { headers: { 'X-Bridge-Key': key } })).json();
    await check('the page gets the same prompt text as the Prompts starter', async () => {
      const r = await get('/api/start-prompt');
      assert.deepStrictEqual([r.title, r.text], [START_LINE_TITLE, START_LINE_PROMPT]);
    });
    await check('a project with no start line says none was skipped; one with a bad entry names project.json', async () => {
      const list = (await get('/api/projects?fresh=1')).projects;
      const row = f => list.find(p => p.folder === f);
      assert.deepStrictEqual([row('no-start').commands.length, row('no-start').startSkipped], [0, []]);
      assert.deepStrictEqual([row('bad-start').commands.length, row('bad-start').startSkipped], [0, ['project.json']]);
    });
  } finally { try { process.kill(srv.pid); } catch {} }

  await sleep(500); // the test copy lets go of its data folder
  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(failures ? failures + ' FAILED' : 'all passed');
  // No process.exit: on Windows it can stop Node while fetch's sockets are still closing (a libuv assertion).
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
