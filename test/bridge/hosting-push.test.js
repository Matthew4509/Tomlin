// Push live's check on settings files, and what comes off the server: real check.js and deploy.js, with a host in memory
// instead of a real one (nothing leaves this PC). Run: npm test
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TOP = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-push-'));
Object.assign(process.env, { BRIDGE_DATA: path.join(TOP, 'data'), BRIDGE_ROOT: path.join(TOP, 'root'), BRIDGE_SELF: TOP, BRIDGE_PORT: '0', BRIDGE_TEST_HOSTING: '1' });
fs.mkdirSync(process.env.BRIDGE_DATA, { recursive: true });
fs.mkdirSync(process.env.BRIDGE_ROOT, { recursive: true });
const check = require('../../src/bridge/hosting/check.js');
const deploy = require('../../src/bridge/hosting/deploy.js');
const store = require('../../src/bridge/hosting/store.js');
const connections = require('../../src/bridge/hosting/connections.js');

after(() => {
  try { fs.rmSync(TOP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the temp folder is cleared with the rest */ }
});

const put = (dir, name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const scan = dir => check.checkFolder({ projectDir: dir, folder: dir, secrets: {}, details: [], otherDetails: [], sendAnyway: [], ignore: [] });

test('settings files: secrets written without quotes stop the push, and any *.env file is never sent', async () => {
  const dir = path.join(TOP, 'site-check');
  put(dir, 'index.html', '<h1>hi</h1>');
  put(dir, 'prod.env', 'DB_PASS=hunter2hunter2\n');
  put(dir, 'x.env.local', 'API_TOKEN=abcd1234abcd1234\n');
  put(dir, 'config.ini', '[db]\npassword = hunter2hunter2\n');
  put(dir, 'settings.yml', 'db:\n  password: hunter2hunter2\n');
  const r = await scan(dir);
  const sent = r.files.map(f => f.rel);
  assert.ok(!sent.includes('prod.env') && !sent.includes('x.env.local'), sent.join());
  assert.ok(r.left.some(l => l.rel === 'prod.env'), JSON.stringify(r.left));
  const found = r.findings.map(f => `${f.rule} ${f.rel}:${f.line}`);
  assert.ok(found.includes('ASSIGN config.ini:2'), found.join());
  assert.ok(found.includes('ASSIGN settings.yml:2'), found.join());
});

test('settings files: a setting that only looks like a secret does not stop the push', async () => {
  const dir = path.join(TOP, 'site-fine');
  put(dir, 'index.html', '<h1>hi</h1>');
  put(dir, 'app.ini', 'token_expiry = 3600\npassword_required = true\nsecret_file = /etc/app/key\npassword = changeme\napi_key = ${API_KEY}\n');
  put(dir, 'ci.yml', 'token: ${{ secrets.TOKEN }}\n');
  put(dir, 'notes.txt', 'password = not a settings file here\n');
  const r = await scan(dir);
  assert.deepEqual(r.findings.filter(f => f.rule === 'ASSIGN').map(f => `${f.rel}:${f.line}`), []);
});

test('a file deleted here comes off the server after Send every file, and after the push that follows Go back', async () => {
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end('no'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = path.join(process.env.BRIDGE_ROOT, 'site2');
  put(dir, 'index.html', 'one');
  put(dir, 'private.html', 'A PRIVATE PAGE');
  put(dir, 'also.html', 'also');
  const remote = new Map();
  connections.transport = async () => ({
    kind: 'ftps',
    listDir: async d => [...remote.keys()].filter(k => path.posix.dirname(k) === d).map(k => ({ name: path.posix.basename(k), type: 'file', size: remote.get(k).length })),
    mkdirs: async () => {},
    upload: async items => { for (const it of items) remote.set(it.remote, fs.readFileSync(it.local, 'utf8')); },
    download: async (r, l) => { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.writeFileSync(l, remote.get(r) ?? ''); },
    putText: async (r, t) => { remote.set(r, String(t)); return { chmod: true }; },
    remove: async r => { remote.delete(r); },
    copy: async (a, b) => { remote.set(b, remote.get(a)); },
    freeBytes: async () => null,
  });
  store.putConnection({ id: 'conn1', kind: 'ftps', label: 'x', host: 'host.example.test', port: 21, user: 'u', secret: 'x' });
  const p = { id: 'p1', name: 'site2', dir, folder: 'site2' };
  store.putSite(dir, { kind: 'ftps', connection: 'conn1', domain: '127.0.0.1', sub: '', root: 'public_html', url: `http://127.0.0.1:${srv.address().port}/`, secretsDir: 'tomlin-secrets', folder: '', sendAnyway: [], ignore: [], pushes: [], lastSent: null });
  const run = async fn => {
    const x = fn();
    assert.ok(x.ok, x.error);
    for (;;) {
      const j = deploy.progress(x.job);
      if (j.job.done) return j.job;
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    assert.ok((await run(() => deploy.push(p))).ok);
    assert.ok(remote.has('public_html/private.html'));

    fs.rmSync(path.join(dir, 'private.html'));
    const all = await run(() => deploy.push(p, { all: true }));
    assert.ok(all.ok, all.error);
    assert.equal(all.result.removed, 1);
    assert.equal(remote.has('public_html/private.html'), false);
    assert.equal(all.result.sent, 2, 'every file still here went again');

    // Pushed, then undone: the server is back as it was, and the next push still knows what is on it.
    put(dir, 'new.html', 'new');
    assert.ok((await run(() => deploy.push(p))).ok);
    const back = deploy.goBack ? await run(() => deploy.goBack(p)) : null;
    assert.ok(back && back.ok, back && back.error);
    assert.equal(remote.has('public_html/new.html'), false);
    assert.equal(Object.keys(store.site(dir).lastSent).includes('also.html'), true);
    fs.rmSync(path.join(dir, 'also.html'));
    const next = await run(() => deploy.push(p));
    assert.ok(next.ok, next.error);
    assert.equal(remote.has('public_html/also.html'), false, 'deleted here, off the server');
    assert.equal(remote.has('public_html/index.html'), true);
    assert.equal(remote.get('public_html/new.html'), 'new');
  } finally {
    srv.close();
  }
});
