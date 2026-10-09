// The Bridge stays up and points at the right site when projects are odd: bad start entries, two projects on one
// port, a merged alternate port, npm/npx and other Windows scripts, folders added beside each other, names that
// resolve to this PC, other tenants of a shared host, a port holder that never answers, oversized requests.
// Everything runs over a made-up working folder in a temp folder and a test copy on a free port (dry run).
// Run: node test/robust.test.js   (Windows; no packages)
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { listProjects, projectId } = require('../../src/bridge/projects');
const platform = require('../../src/bridge/platform');
const live = require('../../src/bridge/live');

const NODE = process.execPath;
const SERVER = path.join(__dirname, 'serve.js');
const SITE = path.join(__dirname, 'site.js');
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const portOpen = port => new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(1000, () => { s.destroy(); r(false); }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
const PAGE = '<!doctype html><title>Made-up</title><p>A made-up site.</p>';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-robust-'));
// Every temp folder this test makes is removed when it ends, however it ends; a folder a killed process still holds
// gets a few tries.
const temps = [WS];
const removeTemps = () => { for (const d of temps.splice(0)) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} };
process.on('exit', removeTemps);
// The Bridge's own temp folders (its git scratch folder) go in one of ours: it is killed, so its own clean-up never runs.
const SRV_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-srvtmp-'));
temps.push(SRV_TMP);
function make(folder, files) {
  const d = path.join(WS, folder);
  fs.mkdirSync(d, { recursive: true });
  for (const [rel, text] of Object.entries(files)) { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return d;
}
const launch = (...configs) => JSON.stringify({ version: '0.0.1', configurations: configs });

async function main() {
  // ---- 1. The list: bad start entries (S1), root entries (S7), stable ids (S5) ----
  make('bad-object', { '.claude/launch.json': '{"configurations":{}}' });
  make('bad-null', { '.claude/launch.json': '{"configurations":[null]}' });
  make('bad-args', { 'project.json': '{"start":{"exe":"node","args":"server.js","port":5000}}' });
  make('bad-exe', { '.claude/launch.json': launch({ name: 'x', runtimeExecutable: 42, port: 5001 }) });
  make('array-project', { 'project.json': '[1,2,3]' });
  make('good', { '.claude/launch.json': launch({ name: 'good', runtimeExecutable: 'node', runtimeArgs: ['server.js'], port: 5002 }) });
  make('dev', { 'README.md': '# A project that happens to be called dev\n' });
  make('public', { 'index.html': PAGE });
  make('shop', { 'server.js': '// made-up\n' });
  make('.claude', { 'launch.json': launch(
    { name: 'root-dev', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5100 },
    { name: 'root-vite', runtimeExecutable: 'npx', runtimeArgs: ['vite', 'dev'], port: 5104 },
    { name: 'root-public', runtimeExecutable: 'npx', runtimeArgs: ['serve', 'public'], port: 5101 },
    { name: 'root-shop', runtimeExecutable: 'node', runtimeArgs: ['shop/server.js'], port: 5102 },
    { name: 'root-missing', runtimeExecutable: 'node', runtimeArgs: ['shop/missing.js'], port: 5103 },
    null,
  ) });
  const settings = { workingFolders: [WS], extraProjects: [], hidden: [], liveUrls: {} };
  const opts = { overridesFile: path.join(WS, 'none.json') };
  let rows;
  await check('S1: a folder of odd project files still lists every project, nothing throws', () => {
    rows = listProjects(settings, opts);
    for (const f of ['bad-object', 'bad-null', 'bad-args', 'bad-exe', 'array-project', 'good']) assert(rows.some(r => r.folder === f), f + ' missing');
  });
  const row = f => rows.find(r => r.folder === f);
  await check('S1: a bad start entry is skipped and counted, never trusted', () => {
    for (const f of ['bad-null', 'bad-args', 'bad-exe']) { assert.strictEqual(row(f).commands.length, 0, f); assert(row(f).startSkipped.length, f + ' not counted'); }
    assert.strictEqual(row('bad-object').commands.length, 0);
    assert.strictEqual(row('good').commands.length, 1);
  });
  await check('S7: "npm run dev" and "vite dev" in the root launch.json do not attach to a folder called dev', () => assert.strictEqual(row('dev').commands.length, 0, JSON.stringify(row('dev').commands)));
  await check('S7: a root entry attaches where its argument is a path inside the folder (serve public, shop/server.js)', () => {
    assert.deepStrictEqual(row('public').commands.map(c => c.name), ['root-public']);
    assert.deepStrictEqual(row('shop').commands.map(c => c.name), ['root-shop']);
  });
  const before = new Map(rows.map(r => [r.folder, r.id]));
  make('my-site', { 'README.md': '# one\n' });
  const myId = listProjects(settings, opts).find(r => r.folder === 'my-site').id;
  make('my site', { 'README.md': '# two\n' });
  make('Ωμέγα', { 'README.md': '# three\n' });
  make('Δέλτα', { 'README.md': '# four\n' });
  const after = listProjects(settings, opts);
  await check('S5: adding "my site" beside "my-site" leaves every existing id as it was', () => {
    assert.strictEqual(after.find(r => r.folder === 'my-site').id, myId);
    for (const [f, id] of before) assert.strictEqual(after.find(r => r.folder === f).id, id, f);
    assert.notStrictEqual(after.find(r => r.folder === 'my site').id, myId);
  });
  await check('S5: two folders with no plain letters get two different ids', () => {
    const a = after.find(r => r.folder === 'Ωμέγα').id, b = after.find(r => r.folder === 'Δέλτα').id;
    assert(a !== b && /^project-[0-9a-f]{6}$/.test(a), a + ' / ' + b);
  });
  await check('S5: the id is the same for the same folder however the path is written', () => assert.strictEqual(projectId(path.join(WS, 'good')), projectId(path.join(WS, 'GOOD') + path.sep)));

  // ---- 2. Windows scripts (S3) ----
  await check('S3: npm and npx become node + their own script (no shell)', () => {
    if (process.platform !== 'win32' || !platform.onPath('npm')) return;
    const r = platform.runnable('npm', ['run', 'dev']);
    assert(/node(\.exe)?$/i.test(r.exe) && /npm-cli\.js$/.test(r.args[0]) && r.args[1] === 'run', JSON.stringify(r));
    assert(/npx-cli\.js$/.test(platform.runnable('npx', ['serve']).args[0]));
  });
  await check('S3: a .cmd script with an argument cmd would read as a command is refused, with the reason', () => {
    if (process.platform !== 'win32') return;
    const r = platform.runnable(path.join(WS, 'tool.cmd'), ['a&calc']);
    assert(r.error && /command/.test(r.error), JSON.stringify(r));
  });

  // ---- 3. Live addresses (L1, S11) ----
  await check('L1: another tenant of a shared host is not "the site itself"', () => {
    assert(!live.isOwn('mallory.github.io', 'alice.github.io'));
    assert(!live.isOwn('evil.netlify.app', 'shop.netlify.app'));
    assert(live.isOwn('cdn.alice.github.io', 'alice.github.io'));
    assert(live.isOwn('www.example.com', 'example.com'));
  });
  await check('L1: a private address is never the site itself', () => assert(!live.isOwn('192.168.1.20', 'example.com') && !live.isOwn('10.0.0.5', 'example.com')));
  await check('S11: a public-looking name that resolves to this PC is refused when the request is made', async () => {
    const r = await live.get('http://127.0.0.1.nip.io:9/', { timeout: 4000 });
    if (r.error && /ENOTFOUND|EAI_AGAIN/.test(r.error.code)) return console.log('     (offline: name not resolved; checked the address test instead)'), assert(live.isPrivateIp('127.0.0.1') && live.isPrivateIp('::ffff:192.168.0.4') && live.isPrivateIp('fd00::1') && !live.isPrivateIp('93.184.216.34'));
    assert(r.error && r.error.code === 'BLOCKED', JSON.stringify(r.error));
  });

  // ---- 4. A test copy of the Bridge over this folder ----
  const pA = await freePort(), pAlt1 = await freePort(), pAlt2 = await freePort();
  // Two projects on one port (S2), and one app on two ports (S9).
  make('alpha', { 'public/index.html': PAGE, '.claude/launch.json': launch({ name: 'alpha', runtimeExecutable: NODE, runtimeArgs: [SITE, String(pA), '.'], port: pA }) });
  make('beta', { 'public/index.html': PAGE, '.claude/launch.json': launch({ name: 'beta', runtimeExecutable: NODE, runtimeArgs: [SITE, String(pA), '.'], port: pA }) });
  make('gamma', { 'public/index.html': PAGE, '.claude/launch.json': launch(
    { name: 'gamma', runtimeExecutable: NODE, runtimeArgs: [SITE, String(pAlt1), '.'], port: pAlt1 },
    { name: 'gamma-2', runtimeExecutable: NODE, runtimeArgs: [SITE, String(pAlt2), '.'], port: pAlt2 }) });
  // An npm-style .cmd start (S3): a Windows script that starts node.
  const pCmd = await freePort();
  make('cmd-site', { 'public/index.html': PAGE, 'serve.cmd': '@echo off\r\n"' + NODE + '" "' + SITE + '" %1 .\r\n',
    '.claude/launch.json': launch({ name: 'cmd', runtimeExecutable: 'serve.cmd', runtimeArgs: [String(pCmd)], port: pCmd }) });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-robust-data-'));
  temps.push(DATA);
  const PORT = await freePort();
  const env = { ...process.env, BRIDGE_TEST_LOCAL_LIVE: '1', BRIDGE_PORT: String(PORT), BRIDGE_DATA: DATA, BRIDGE_ROOT: WS, TEMP: SRV_TMP, TMP: SRV_TMP };
  const srv = spawn(NODE, [SERVER, '--dry-run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  const outside = [];
  try {
    for (let i = 0; i < 50 && !(await portOpen(PORT)); i++) await sleep(200);
    const BASE = 'http://127.0.0.1:' + PORT;
    const key = ((await (await fetch(BASE + '/')).text()).match(/name="bridge-key" content="([0-9a-f]+)"/) || [])[1];
    const api = async (p, body, raw) => {
      const res = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'X-Bridge-Key': key, 'Content-Type': 'application/json' }, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    const list = async () => (await api('/api/projects?fresh=1')).json.projects;
    const idOf = async folder => (await list()).find(p => p.folder === folder).id;

    await check('S1: the Bridge starts over the odd folders and lists them', async () => { const l = await list(); assert(l.some(p => p.folder === 'bad-null') && l.some(p => p.folder === 'good')); });
    await check('G2: the data folder gets a .gitignore of everything', () => assert(/^\*$/m.test(fs.readFileSync(path.join(DATA, '.gitignore'), 'utf8'))));
    await check('S1: a bad file written while it runs, then a fresh list and Check now: the Bridge stays up', async () => {
      make('late-bad', { '.claude/launch.json': '{"configurations":[null, 7, "x"]}', 'project.json': '{"start":{"exe":["node"]}}' });
      const site = http.createServer((q, s) => s.end(PAGE)); await new Promise(r => site.listen(0, '127.0.0.1', r)); outside.push(site);
      const set = await api('/api/live/set', { id: await idOf('good'), url: 'http://127.0.0.1:' + site.address().port + '/' });
      assert(set.json.ok, JSON.stringify(set.json));
      assert((await api('/api/live/check-all', {})).json.ok);
      await sleep(1500);
      assert(await portOpen(PORT), 'the Bridge stopped');
      assert((await list()).some(p => p.folder === 'late-bad'));
    });
    await check('U2: an oversized request is answered 413 with a reason, not a dropped connection', async () => {
      const r = await api('/api/scan', null, JSON.stringify({ pad: 'x'.repeat(20000) }));
      assert.strictEqual(r.status, 413); assert(/more than the Bridge takes/.test(r.json.error), JSON.stringify(r.json));
    });

    const alpha = await idOf('alpha'), beta = await idOf('beta');
    await check('S2: with alpha running on the shared port, beta\'s Open and Scan do not use alpha\'s site', async () => {
      const s = await api('/api/start', { id: alpha, key: '0', open: false });
      assert(s.json.ok, JSON.stringify(s.json));
      const o = (await api('/api/open-browser', { id: beta, key: '0' })).json;
      assert(!o.ok && /alpha/i.test(o.error), JSON.stringify(o));
      const a = (await api('/api/audit', { id: beta })).json;
      assert(!a.audit.url, 'beta was audited against ' + a.audit.url);
      const a2 = (await api('/api/audit', { id: alpha })).json;
      assert(a2.audit.url && a2.audit.url.includes(':' + pA + '/'), 'alpha was not audited on its own site');
      await api('/api/stop', { id: alpha });
    });
    await check('S9: a merged alternate port held by another program is the site that gets scanned', async () => {
      const gamma = (await list()).find(p => p.folder === 'gamma');
      assert.strictEqual(gamma.commands.length, 1, 'the two gamma entries were not merged');
      const site = http.createServer((q, s) => s.end(PAGE)); await new Promise(r => site.listen(pAlt2, '127.0.0.1', r)); outside.push(site);
      const a = (await api('/api/audit', { id: gamma.id })).json;
      assert(a.audit.url && a.audit.url.includes(':' + pAlt2 + '/'), 'audited ' + a.audit.url);
    });
    await check('S3: a project started by a Windows .cmd script comes up (no 20 s wait, no ENOENT)', async () => {
      if (process.platform !== 'win32') return;
      const t = Date.now();
      const s = (await api('/api/start', { id: await idOf('cmd-site'), key: '0', open: false })).json;
      assert(s.ok, JSON.stringify(s));
      assert(Date.now() - t < 15000);
      await api('/api/stop', { id: await idOf('cmd-site') });
    });
    await check('S3: a program that does not exist fails at once, not after 20 s', async () => {
      make('no-such-program', { '.claude/launch.json': launch({ name: 'x', runtimeExecutable: 'no-such-program-' + Date.now() + '.exe', port: await freePort() }) });
      const t = Date.now();
      const s = (await api('/api/start', { id: await idOf('no-such-program'), key: '0', open: false })).json;
      assert(!s.ok && /Could not start/.test(s.error), JSON.stringify(s));
      assert(Date.now() - t < 8000, 'took ' + (Date.now() - t) + ' ms');
    });
    await check('U1: an added project whose folder is gone can be taken off by its path', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-robust-added-'));
      temps.push(elsewhere);
      assert((await api('/api/projects/add', { path: elsewhere })).json.ok);
      fs.rmSync(elsewhere, { recursive: true, force: true });
      assert((await api('/api/settings')).json.extraProjects.some(x => !x.exists));
      assert((await api('/api/projects/forget', { path: elsewhere })).json.ok);
      assert(!(await api('/api/settings')).json.extraProjects.length);
    });
    await check('S10: the list revision moves when another program starts on a project port (within ~35 s)', async () => {
      const rev0 = (await api('/api/stats')).json.rowsRev;
      const pGood = (await list()).find(p => p.folder === 'beta').commands[0].port;
      const site = http.createServer((q, s) => s.end(PAGE)); await new Promise(r => site.listen(pGood, '127.0.0.1', r)); outside.push(site);
      let rev = rev0;
      for (let i = 0; i < 40 && rev === rev0; i++) { await sleep(1000); rev = (await api('/api/stats')).json.rowsRev; }
      assert.notStrictEqual(rev, rev0, 'rowsRev never moved');
    });
  } finally {
    for (const s of outside) s.close();
    srv.kill();
  }

  // ---- 5. Start-up against a port another program holds (S8; --status went with the stand-alone Bridge) ----
  // Takes the connection and never answers, in its own process (spawnSync below freezes this one).
  const pSilent = await freePort();
  const silent = spawn(NODE, ['-e', "const k=[];require('net').createServer(s=>k.push(s)).listen(" + pSilent + ", '127.0.0.1')"], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await portOpen(pSilent)); i++) await sleep(100);
  await check('S8: a port holder that never answers does not leave start-up waiting (gone in a few seconds, with the reason)', () => {
    const t = Date.now();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-robust-s8-'));
    temps.push(data);
    const r = spawnSync(NODE, [SERVER, '--dry-run'], { env: { ...process.env, BRIDGE_PORT: String(pSilent), BRIDGE_DATA: data, BRIDGE_ROOT: WS, TEMP: SRV_TMP, TMP: SRV_TMP }, encoding: 'utf8', timeout: 20000 });
    assert(Date.now() - t < 12000, 'took ' + (Date.now() - t) + ' ms');
    assert(/in use/.test(r.stderr + r.stdout), r.stdout + r.stderr);
  });
  silent.kill();

  removeTemps();
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
