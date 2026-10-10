// Push live, end to end through the Bridge's own API, against stand-ins on this PC (hosting-fakes.js, fake-sftp.js):
// cPanel (connect with a password used once, a pasted token, sites, secrets, the check, push, a second push, Go back,
// an older cPanel without the new file functions, the database, disconnect), FTPS through Windows' real curl.exe
// against a plain FTP server, and SFTP with a real key from Windows' ssh-keygen against a stand-in sftp.exe.
// Nothing leaves the PC. Windows only (curl.exe, ssh-keygen.exe, icacls, PowerShell for the one real DPAPI check).
// Run: node test/bridge/hosting.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const assert = require('assert');
const { fakeCpanel, ftpServer } = require('./hosting-fakes');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + (e && e.stack || e) + (e && e.cause ? ' (cause: ' + (e.cause.code || '') + ' ' + e.cause.message + ')' : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hosting-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const WS = path.join(TMP, 'ws'), DATA = path.join(TMP, 'tomlin data'), HOME = path.join(TMP, 'cpanel-home'), FTP = path.join(TMP, 'ftp-root'), SFTP = path.join(TMP, 'sftp-root'), OLDHOME = path.join(TMP, 'old-cpanel-home');
for (const d of [WS, DATA, HOME, FTP, SFTP, OLDHOME]) fs.mkdirSync(d, { recursive: true });
const w = (base, rel, text) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const r = (base, rel) => fs.readFileSync(path.join(base, rel), 'utf8');
const has = (base, rel) => fs.existsSync(path.join(base, rel));
// The Live secrets file's name for a site (its name and a fingerprint of its server folder).
const secName = (domain, root) => require('../../src/bridge/hosting/deploy').secretsName({ domain, root });
const tempsLeft = prefix => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(prefix));

async function main() {
  const tempBefore = { k: tempsLeft('tomlin-k-').length, put: tempsLeft('tomlin-put-').length };
  const cp = await fakeCpanel(HOME);
  const old = await fakeCpanel(OLDHOME, { old: true });
  const ftp = await ftpServer(FTP);
  // The FTPS site's pages, served from the FTP folder's public_html.
  const ftpSite = http.createServer((req, res) => {
    const f = path.join(FTP, 'public_html', ...decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200); res.end(/\.php$/.test(f) ? '' : fs.readFileSync(f));
  });
  await new Promise(x => ftpSite.listen(0, '127.0.0.1', x));
  const port = await freePort();
  Object.assign(process.env, {
    BRIDGE_TEST_HOSTING: '1', BRIDGE_TEST_VAULT: 'plain', BRIDGE_DRYRUN: '1', BRIDGE_PORT: String(port), BRIDGE_DATA: DATA, BRIDGE_ROOT: WS, BRIDGE_SELF: DATA,
    BRIDGE_TEST_SITE_MAP: JSON.stringify({ 'shop.test': 'http://127.0.0.1:' + cp.sitePort + '/', 'other.test': 'http://127.0.0.1:' + cp.sitePort + '/other/' }),
    BRIDGE_TEST_SFTP: path.join(__dirname, 'fake-sftp.js'), FAKE_SFTP_ROOT: SFTP, FAKE_SFTP_LOG: path.join(TMP, 'sftp.log'),
  });

  // ---- the projects ----
  const SHOP = path.join(WS, 'shop-site');
  w(SHOP, 'README.md', '# Shop\n\nA made-up shop for the push live test.\n');
  w(SHOP, 'public_html/index.php', '<?php @include __DIR__ . \'/tomlin-secrets.php\'; echo "Shop " . (getenv(\'API_KEY\') ? \'ready\' : \'no key\');\n');
  w(SHOP, 'public_html/about.html', '<h1>About</h1>\n');
  w(SHOP, 'public_html/css/site.css', 'body{margin:0}\n');
  w(SHOP, 'public_html/.env', 'API_KEY=local-only\n');
  w(SHOP, 'public_html/data/orders.json', '[]\n');
  // A working-notes file, named the way the check leaves out (built here, so this test file is not one itself).
  const NOTES = ['HAND', 'OFF-notes.md'].join('');
  w(SHOP, 'public_html/' + NOTES, 'notes\n');
  w(SHOP, 'db/schema.sql', 'CREATE TABLE orders (id INT);\nINSERT INTO orders VALUES (1);\n');
  // A file another site already has on the server (other.test lives inside public_html, as cPanel puts addon domains).
  w(HOME, 'public_html/other.test/index.html', 'OTHER SITE\n');
  w(HOME, 'public_html/about.html', 'An about page someone uploaded by hand\n');

  const app = require('../../src/bridge/app');
  const server = app.start();
  await new Promise(x => (server.listening ? x() : server.once('listening', x)));
  await sleep(300);
  const BASE = 'http://127.0.0.1:' + port;
  const pageHtml = await (await fetch(BASE + '/')).text();
  const KEY = pageHtml.match(/name="bridge-key" content="([0-9a-f]+)"/)[1];
  // A kept-open connection the server closes (idle 5 s) just as a request goes out on it: the request never reached
  // the server, so it is sent once more on a new one (a browser does the same). On Windows the same race can show as a
  // reset (ECONNRESET, seen once in a full run under load), before any answer came back.
  const api = async (p, body, tries = 2) => {
    try {
      const res = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'X-Bridge-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return res.json();
    } catch (e) {
      if (tries > 1 && e && e.cause && (e.cause.code === 'UND_ERR_SOCKET' || e.cause.code === 'ECONNRESET')) return api(p, body, tries - 1);
      throw e;
    }
  };
  const { state, refreshProjects } = require('../../src/bridge/state');
  refreshProjects(true);
  const shop = state.projects.find(p => p.dir.toLowerCase() === SHOP.toLowerCase());
  assert(shop, 'the shop project is listed');
  const waitJob = async id => { for (let i = 0; i < 600; i++) { const j = (await api('/api/hosting/progress', { job: id })).job; if (j && j.done) return j; await sleep(50); } throw new Error('job did not finish'); };
  const raw = () => fs.readFileSync(path.join(DATA, 'hosting', 'connections.json'), 'utf8');

  await check('push live is off until turned on, and every hosting action says so', async () => {
    assert.strictEqual((await api('/api/hosting')).on, false);
    const x = await api('/api/hosting/connect', { kind: 'cpanel', host: 'localhost', user: 'user', password: 'right-password' });
    assert(x.off && /off/.test(x.error), JSON.stringify(x));
    assert((await api('/api/hosting/on', { on: true })).on === true);
  });

  const cpBody = extra => ({ kind: 'cpanel', host: 'localhost', port: cp.port, user: 'user', scheme: 'http', ...extra });
  let conn;
  await check('cPanel: a wrong password is refused plainly and nothing is kept', async () => {
    const x = await api('/api/hosting/connect', cpBody({ password: 'wrong' }));
    assert(!x.ok && /refused that user name and password/.test(x.error), JSON.stringify(x));
    assert(!fs.existsSync(path.join(DATA, 'hosting', 'connections.json')) || !JSON.parse(raw()).connections.length);
    assert.strictEqual(cp.tokens.size, 0);
  });
  await check('cPanel: the password is used once to make a token, then dropped (nothing on disk holds it)', async () => {
    const x = await api('/api/hosting/connect', cpBody({ password: 'right-password', label: 'Test host' }));
    assert(x.ok && x.passwordDropped, JSON.stringify(x));
    conn = x.connection;
    assert.strictEqual(cp.tokens.size, 1);
    const [name, token] = [...cp.tokens][0];
    assert(/^TOMLIN_/.test(name) && conn.tokenName === name);
    assert(!raw().includes('right-password') && !raw().includes(token), 'no password or plain token on disk');
    assert(!JSON.stringify(x).includes(token), 'the page never gets the token');
    assert.deepStrictEqual(x.domains.map(d => d.domain), ['shop.test', 'other.test']);
    for (const f of fs.readdirSync(DATA, { recursive: true })) if (fs.statSync(path.join(DATA, f)).isFile()) assert(!fs.readFileSync(path.join(DATA, f), 'utf8').includes('right-password'), f);
  });
  await check('cPanel: a pasted token connects too', async () => {
    cp.tokens.set('handmade', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    const x = await api('/api/hosting/connect', cpBody({ token: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }));
    assert(x.ok && !x.passwordDropped && x.connection.tokenName === null, JSON.stringify(x));
    const d = await api('/api/hosting/disconnect', { connection: x.connection.id });
    assert(d.ok && /still in cPanel/.test(d.note), 'a pasted token is not deleted by TOMLIN: the note says so');
    assert(cp.tokens.has('handmade'));
  });

  await check('site: set up on shop.test, the upload folder guessed as public_html', async () => {
    const s0 = await api('/api/hosting/site?id=' + encodeURIComponent(shop.id));
    assert.strictEqual(s0.guess, 'public_html');
    const x = await api('/api/hosting/site/set', { id: shop.id, connection: conn.id, domain: 'shop.test', folder: 'public_html' });
    assert(x.ok, JSON.stringify(x));
    assert.strictEqual(x.site.root, '/home/user/public_html');
    assert.strictEqual(x.site.secretsDir, '/home/user/tomlin-secrets');
    const bad = await api('/api/hosting/site/set', { id: shop.id, connection: conn.id, domain: 'shop.test', folder: '../elsewhere' });
    assert(!bad.ok, 'an upload folder outside the project is refused');
  });

  await check('secrets: saved sealed; the page sees names only; a value is one line', async () => {
    const x = await api('/api/hosting/secrets', { id: shop.id, rows: [{ name: 'api_key', local: 'local-secret-abc', live: 'live-secret-123456' }, { name: 'SESSION_SALT', generateLive: true }] });
    assert(x.ok, JSON.stringify(x));
    assert.deepStrictEqual(x.secrets.map(s => [s.name, s.local, s.live]), [['API_KEY', true, true], ['SESSION_SALT', false, true]]);
    assert(!JSON.stringify(x).includes('live-secret-123456'));
    const file = fs.readdirSync(path.join(DATA, 'hosting', 'secrets'))[0];
    assert(!r(path.join(DATA, 'hosting', 'secrets'), file).includes('live-secret-123456'), 'never written out plainly');
    const bad = await api('/api/hosting/secrets', { id: shop.id, rows: [{ name: 'X1', live: 'a\nb' }] });
    assert(!bad.ok && /line break/.test(bad.error));
    const kept = await api('/api/hosting/secrets', { id: shop.id, rows: [{ name: 'API_KEY' }, { name: 'SESSION_SALT' }] });
    assert(kept.secrets[0].live && kept.secrets[0].local && kept.secrets[1].live, 'a value left out keeps the saved one');
  });

  await check('check: .env, data/ and working notes left out; a planted key and a written-out secret stop it, with file and line', async () => {
    // Made up, and joined at run time so the file itself holds no key-shaped text (GitHub's push check refuses one).
    w(SHOP, 'public_html/config.php', '<?php\n$stripe = \'' + 'sk_' + 'live_abcdefghijklmnopqrstuvwx\';\n');
    w(SHOP, 'public_html/lib/api.php', '<?php\n// call\n$k = "live-secret-123456";\n');
    const x = await api('/api/hosting/check', { id: shop.id });
    assert(x.ok, JSON.stringify(x));
    const f = x.findings.map(f => f.rule + ' ' + f.rel + ':' + f.line);
    assert(f.includes('KEY config.php:2'), f.join(', '));
    assert(f.includes('VALUE lib/api.php:3'), f.join(', '));
    assert(!x.findings.find(f => f.rule === 'VALUE').canIgnore, 'a saved secret written out can never be set aside');
    assert(!JSON.stringify(x).includes('live-secret-123456'), 'the value itself is not in the report');
    const left = x.left.map(l => l.why).join(' | ');
    assert(/\.env/.test(left) && /data\//.test(left) && /working notes/.test(left), left);
  });
  await check('push: a finding stops it before anything is sent', async () => {
    const j = await waitJob((await api('/api/hosting/push', { id: shop.id })).job);
    assert(!j.ok && /must not go live/.test(j.error) && j.findings.length === 2, JSON.stringify(j));
    assert(!has(HOME, 'public_html/index.php'), 'nothing reached the server');
  });

  let first;
  await check('push: one press sends the files, keeps a copy of the replaced one, writes secrets outside the web folder, sets the address', async () => {
    fs.rmSync(path.join(SHOP, 'public_html', 'config.php'));
    w(SHOP, 'public_html/lib/api.php', '<?php\n$k = getenv(\'API_KEY\');\n');
    const start = await api('/api/hosting/push', { id: shop.id });
    const j = await waitJob(start.job);
    assert(j.ok, JSON.stringify(j));
    first = j.result;
    assert.strictEqual(first.sent, 4); // index.php, about.html, css/site.css, lib/api.php (db/ is outside public_html)
    for (const f of ['index.php', 'about.html', 'css/site.css', 'lib/api.php']) assert(has(HOME, 'public_html/' + f), f);
    for (const f of ['.env', 'data/orders.json', NOTES]) assert(!has(HOME, 'public_html/' + f), f + ' must not be sent');
    assert.strictEqual(r(HOME, 'public_html/other.test/index.html'), 'OTHER SITE\n', 'the addon domain is untouched');
    const SHOP_SEC = secName('shop.test', '/home/user/public_html');
    assert(/^shop\.test-[0-9a-f]{10}\.php$/.test(SHOP_SEC), SHOP_SEC);
    const sec = r(HOME, 'tomlin-secrets/' + SHOP_SEC);
    assert(sec.includes("'API_KEY' => 'live-secret-123456'") && !sec.includes('local-secret-abc'), 'Live values only');
    assert.strictEqual(cp.modes.get(path.join(HOME, 'tomlin-secrets', SHOP_SEC)), '0600');
    assert(/Require all denied/.test(r(HOME, 'tomlin-secrets/.htaccess')));
    const loader = r(HOME, 'public_html/tomlin-secrets.php');
    assert(loader.includes("'/home/user/tomlin-secrets/" + SHOP_SEC + "'") && !loader.includes('live-secret'), 'the loader has a path, no value');
    assert(first.leaks.every(l => l.ok), JSON.stringify(first.leaks));
    assert.strictEqual(first.kept, 1, 'the hand-uploaded about.html was copied before it was replaced');
    assert.strictEqual(state.settings.liveUrls[shop.dir.toLowerCase()], 'http://127.0.0.1:' + cp.sitePort + '/');
    assert(first.live && first.live.state, 'the live light was checked');
  });

  await check('push again: only the changed file goes; a file gone from the folder is removed on the server', async () => {
    w(SHOP, 'public_html/about.html', '<h1>About us</h1>\n');
    fs.rmSync(path.join(SHOP, 'public_html', 'css', 'site.css'));
    w(SHOP, 'public_html/new.html', 'new\n');
    const j = await waitJob((await api('/api/hosting/push', { id: shop.id })).job);
    assert(j.ok, JSON.stringify(j));
    assert.strictEqual(j.result.sent, 2);
    assert.strictEqual(j.result.removed, 1);
    assert(!has(HOME, 'public_html/css/site.css') && r(HOME, 'public_html/about.html') === '<h1>About us</h1>\n' && has(HOME, 'public_html/new.html'));
    assert(fs.readdirSync(path.join(HOME, 'tomlin-push-backups', 'shop.test')).length === 2, 'each push keeps its copies outside the web folder');
  });
  await check('Go back: the last push is undone (changed file back, removed file back, new file gone)', async () => {
    const j = await waitJob((await api('/api/hosting/back', { id: shop.id })).job);
    assert(j.ok, JSON.stringify(j));
    assert.strictEqual(r(HOME, 'public_html/about.html'), '<h1>About</h1>\n');
    assert(has(HOME, 'public_html/css/site.css') && !has(HOME, 'public_html/new.html'));
    const j2 = await waitJob((await api('/api/hosting/back', { id: shop.id })).job);
    assert(j2.ok && r(HOME, 'public_html/about.html') === 'An about page someone uploaded by hand\n', 'and the first push too: the hand-made page is back');
    assert(!has(HOME, 'public_html/index.php'));
    const none = await api('/api/hosting/back', { id: shop.id });
    assert(!none.ok && /no push/.test(none.error));
  });

  await check('check: a key far along a long line, a key in a text file over 5 MB, and a Local value that differs from the Live one all stop it', async () => {
    const tok = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
    w(SHOP, 'public_html/js/app.min.js', 'var a=1;'.repeat(3000) + 'var t="' + tok + '";\n');
    w(SHOP, 'public_html/js/big.js', '// big\n' + ('x'.repeat(1000) + '\n').repeat(6 * 1024) + 'var t="' + tok + '";\n');
    w(SHOP, 'public_html/lib/local.php', '<?php\n$k = "local-secret-abc";\n');
    const bin = Buffer.alloc(6 * 1024 * 1024, 7); bin[10] = 0;
    fs.mkdirSync(path.join(SHOP, 'public_html', 'media'), { recursive: true });
    fs.writeFileSync(path.join(SHOP, 'public_html', 'media', 'clip.bin'), bin);
    const x = await api('/api/hosting/check', { id: shop.id });
    assert(x.ok, JSON.stringify(x));
    const f = x.findings.map(f => f.rule + ' ' + f.rel + ':' + f.line);
    assert(f.includes('KEY js/app.min.js:1'), f.join(', '));
    assert(f.includes('KEY js/big.js:' + (6 * 1024 + 2)), f.join(', '));
    assert(f.includes('VALUE lib/local.php:2'), f.join(', '));
    assert(/local API_KEY/.test(x.findings.find(f => f.rule === 'VALUE').what), 'named as the Local value');
    const full = await require('../../src/bridge/hosting/deploy').runCheck(shop);
    assert(!f.some(s => s.includes('media/clip.bin')) && full.files.some(f => f.rel === 'media/clip.bin' && f.sha.length === 64), 'a big binary file is sent, only fingerprinted');
    for (const rel of ['js/app.min.js', 'js/big.js', 'lib/local.php', 'media/clip.bin']) fs.rmSync(path.join(SHOP, 'public_html', ...rel.split('/')));
  });

  await check('check: login files left out; define(), a password in an address, a second assignment on a line and a saved value inside a binary file stop it', async () => {
    const check = require('../../src/bridge/hosting/check');
    const dir = path.join(TMP, 'rules-site');
    w(dir, '.npmrc', '//registry.npmjs.org/:_authToken=npm_' + 'a1B2c3D4e5'.repeat(3) + 'a1B2c3\n');
    w(dir, '.git-credentials', 'https://bob:' + 'pw' + '1234567@example.test\n');
    w(dir, 'wp-config.php', "<?php\ndefine('DB_PASSWORD', 'Hunter2Secret99');\ndefine('AUTH_KEY', 'put your unique phrase here');\n");
    w(dir, 'db.js', 'const url = "mysql://shop:' + 'Zx81kLm29' + '@db.example.test/shop";\n');
    w(dir, 'app.js', 'const a = { token: "placeholder", secret: "Zx81kLm29QwEr7" }; // see process.env\n');
    const bin = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('the-saved-value-42', 'utf16le'), Buffer.alloc(16)]);
    fs.writeFileSync(path.join(dir, 'data.bin'), bin);
    const x = await check.checkFolder({ projectDir: dir, folder: dir, secrets: { 'live DB_X': 'the-saved-value-42' } });
    const f = x.findings.map(f => f.rule + ' ' + f.rel + ':' + f.line);
    assert(x.left.some(l => l.rel === '.npmrc') && x.left.some(l => l.rel === '.git-credentials'), JSON.stringify(x.left));
    assert(f.includes('ASSIGN wp-config.php:2') && !f.includes('ASSIGN wp-config.php:3'), f.join(', '));
    assert(f.includes('ASSIGN db.js:1') && f.includes('ASSIGN app.js:1'), f.join(', '));
    assert(f.includes('VALUE data.bin:0'), f.join(', '));
  });

  await check('check: in a git project, files .gitignore leaves out are listed as left out (with a tick to send them), not dropped', async () => {
    const { spawnSync } = require('child_process');
    const check = require('../../src/bridge/hosting/check');
    const dir = path.join(TMP, 'git-site');
    w(dir, '.gitignore', 'vendor/\n');
    w(dir, 'index.php', '<?php require "vendor/lib.php";\n');
    w(dir, 'vendor/lib.php', '<?php // a library\n');
    if (spawnSync('git', ['init', '-q'], { cwd: dir }).status !== 0) return console.log('     (git not on PATH: skipped)');
    const x = await check.checkFolder({ projectDir: dir, folder: dir });
    assert(x.files.some(f => f.rel === 'index.php') && !x.files.some(f => f.rel === 'vendor/lib.php'), JSON.stringify(x.files));
    assert(x.left.some(l => l.rel === 'vendor/lib.php' && l.soft === 'gitignored'), JSON.stringify(x.left));
    const y = await check.checkFolder({ projectDir: dir, folder: dir, sendAnyway: ['gitignored'] });
    assert(y.files.some(f => f.rel === 'vendor/lib.php'), 'sent when ticked');
  });

  await check('push that stops part way: kept on the list as stopped, and Go back undoes it', async () => {
    const connections = require('../../src/bridge/hosting/connections');
    const real = connections.transport;
    assert((await waitJob((await api('/api/hosting/push', { id: shop.id })).job)).ok, 'a good push first');
    const before = r(HOME, 'public_html/about.html');
    w(SHOP, 'public_html/about.html', '<h1>About, changed</h1>\n');
    w(SHOP, 'public_html/half.html', 'half\n');
    connections.transport = async c => { const t = await real(c); return { ...t, upload: async (list, onDone) => { await t.upload(list.slice(0, 1), onDone); throw new Error('the connection dropped'); } }; };
    try {
      const j = await waitJob((await api('/api/hosting/push', { id: shop.id })).job);
      assert(!j.ok && /connection dropped/.test(j.error), JSON.stringify(j));
    } finally { connections.transport = real; }
    const site = await api('/api/hosting/site?id=' + encodeURIComponent(shop.id));
    assert(site.site.pushes[0].failed && !site.site.pushes[0].ok, JSON.stringify(site.site.pushes[0]));
    const b = await waitJob((await api('/api/hosting/back', { id: shop.id })).job);
    assert(b.ok && b.result.filesOnly, JSON.stringify(b));
    assert.strictEqual(r(HOME, 'public_html/about.html'), before, 'the replaced file is back');
    assert(!has(HOME, 'public_html/half.html'), 'the added file is gone');
    fs.rmSync(path.join(SHOP, 'public_html', 'half.html'));
    w(SHOP, 'public_html/about.html', before);
  });

  await check('a file changed after the check is not sent; two projects never push into the same server folder at once', async () => {
    const connections = require('../../src/bridge/hosting/connections');
    const real = connections.transport;
    const TWIN = path.join(WS, 'twin-site');
    w(TWIN, 'public_html/index.html', 'twin\n');
    refreshProjects(true);
    const twin = state.projects.find(p => p.dir.toLowerCase() === TWIN.toLowerCase());
    assert((await api('/api/hosting/site/set', { id: twin.id, connection: conn.id, domain: 'shop.test', folder: 'public_html' })).ok);
    connections.transport = async c => { await sleep(400); return real(c); };
    try {
      w(SHOP, 'public_html/about.html', '<h1>About, once more</h1>\n');
      const first = await api('/api/hosting/push', { id: shop.id });
      assert(first.ok, JSON.stringify(first));
      const second = await api('/api/hosting/push', { id: twin.id });
      assert(!second.ok && /same folder/.test(second.error), JSON.stringify(second));
      assert((await waitJob(first.job)).ok);
    } finally { connections.transport = real; }
    // The stage copy is checked against the checked file: a change in between stops the push.
    const check = require('../../src/bridge/hosting/check');
    const realHash = check.hashFile;
    check.hashFile = () => 'changed';
    try {
      w(SHOP, 'public_html/about.html', '<h1>About, changed after the check</h1>\n');
      const j = await waitJob((await api('/api/hosting/push', { id: shop.id })).job);
      assert(!j.ok && /changed after it was checked/.test(j.error), JSON.stringify(j));
    } finally { check.hashFile = realHash; }
    assert.strictEqual(r(HOME, 'public_html/about.html'), '<h1>About, once more</h1>\n', 'nothing was sent');
    await api('/api/hosting/site/remove', { id: twin.id });
  });

  await check('while a push runs, Set up, Forget, Secrets, Not a secret, the database and Disconnect wait; a record changed anyway stops the push before the site changes', async () => {
    const connections = require('../../src/bridge/hosting/connections');
    const store = require('../../src/bridge/hosting/store');
    const real = connections.transport;
    connections.transport = async c => { await sleep(1500); return real(c); };
    try {
      w(SHOP, 'public_html/about.html', '<h1>About, while busy</h1>\n');
      const before = store.site(shop.dir);
      const first = await api('/api/hosting/push', { id: shop.id });
      assert(first.ok, JSON.stringify(first));
      const tries = {
        set: await api('/api/hosting/site/set', { id: shop.id, connection: conn.id, domain: 'other.test', folder: 'public_html' }),
        remove: await api('/api/hosting/site/remove', { id: shop.id }),
        secrets: await api('/api/hosting/secrets', { id: shop.id, rows: [{ name: 'API_KEY', live: 'changed-midway-999' }] }),
        ignore: await api('/api/hosting/ignore', { id: shop.id, key: 'KEY|x|y' }),
        dbSetup: await api('/api/hosting/db/setup', { id: shop.id, name: 'other' }),
        dbLoad: await api('/api/hosting/db/load', { id: shop.id, file: 'db/schema.sql' }),
        dbForget: await api('/api/hosting/db/forget', { id: shop.id }),
        disconnect: await api('/api/hosting/disconnect', { connection: conn.id }),
      };
      for (const [k, x] of Object.entries(tries)) assert(!x.ok && /running|right now/.test(x.error), k + ': ' + JSON.stringify(x));
      const j = await waitJob(first.job);
      assert(j.ok, JSON.stringify(j));
      const after = store.site(shop.dir);
      assert(after && ['connection', 'domain', 'root', 'db', 'ignore'].every(k => JSON.stringify(after[k]) === JSON.stringify(before[k])), 'the site record is as it was');
      assert.strictEqual((await require('../../src/bridge/hosting/secrets').values(shop.dir, 'live')).API_KEY, 'live-secret-123456', 'the secret was not changed');
      assert(store.connection(conn.id), 'the connection is still there');
      assert.strictEqual(r(HOME, 'public_html/about.html'), '<h1>About, while busy</h1>\n');

      // A change that does not come through those buttons (another TOMLIN window on an older copy, a hand edit).
      w(SHOP, 'public_html/about.html', '<h1>About, must not go</h1>\n');
      const second = await api('/api/hosting/push', { id: shop.id });
      assert(second.ok);
      await sleep(150);
      const was = store.site(shop.dir).root;
      store.updateSite(shop.dir, x => ({ ...x, root: '/home/user/public_html/other.test' }));
      const j2 = await waitJob(second.job);
      store.updateSite(shop.dir, x => ({ ...x, root: was }));
      assert(!j2.ok && /changed or taken off while the push ran/.test(j2.error), JSON.stringify(j2));
      assert(r(HOME, 'public_html/about.html') === '<h1>About, while busy</h1>\n' && r(HOME, 'public_html/other.test/index.html') === 'OTHER SITE\n', 'nothing was sent anywhere');
    } finally { connections.transport = real; }
    w(SHOP, 'public_html/about.html', '<h1>About</h1>\n');
  });

  await check('a live site that cannot be asked is not a pass: the push says the check did not run', async () => {
    const live = require('../../src/bridge/live');
    const realGet = live.get;
    live.get = async () => ({ error: { message: 'timed out' } });
    try {
      w(SHOP, 'public_html/about.html', '<h1>About</h1>\n');
      const j = await waitJob((await api('/api/hosting/push', { id: shop.id })).job);
      assert(!j.ok && j.result && j.result.verified === 'not-checked' && /could not ask the site/.test(j.error), JSON.stringify(j));
    } finally { live.get = realGet; }
    const site = await api('/api/hosting/site?id=' + encodeURIComponent(shop.id));
    assert.strictEqual(site.site.pushes[0].verified, 'not-checked');
  });

  await check('database: made through cPanel with a generated password, kept as Live secrets, written to the server', async () => {
    const x = await api('/api/hosting/db/setup', { id: shop.id, name: 'shop' });
    assert(x.ok, JSON.stringify(x));
    assert.deepStrictEqual(x.db, { name: 'user_shop', user: 'user_shop' });
    assert(cp.dbs.list.includes('user_shop') && cp.dbs.grants.includes('user_shop@user_shop'));
    const pw = cp.dbs.users.get('user_shop');
    assert(pw && pw.length === 32);
    assert(!JSON.stringify(x).includes(pw));
    const names = (await api('/api/hosting/site?id=' + encodeURIComponent(shop.id))).secrets.map(s => s.name);
    assert(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS'].every(n => names.includes(n)), names.join(','));
    assert(r(HOME, 'tomlin-secrets/' + secName('shop.test', '/home/user/public_html')).includes(pw));
    const again = await api('/api/hosting/db/setup', { id: shop.id, name: 'shop' });
    assert(!again.ok && /already has a database/.test(again.error));
  });
  await check('database: a .sql file is loaded by a one-time page that then deletes itself and the file', async () => {
    const x = await api('/api/hosting/db/load', { id: shop.id, file: 'db/schema.sql' });
    assert(x.ok && x.statements === 2, JSON.stringify(x));
    assert(/CREATE TABLE orders/.test(cp.site.loaded));
    assert(!fs.readdirSync(path.join(HOME, 'public_html')).some(n => /^tomlin-import-/.test(n)), 'the loader page is gone');
    assert(!fs.readdirSync(path.join(HOME, 'tomlin-secrets')).some(n => /\.sql$/.test(n)), 'the .sql file is gone');
    const bad = await api('/api/hosting/db/load', { id: shop.id, file: '../outside.sql' });
    assert(!bad.ok);
  });

  await check('database: a load that breaks part way says it may be part loaded, and the page and the .sql file are still taken off', async () => {
    const before = (await api('/api/hosting/site?id=' + encodeURIComponent(shop.id))).site.db.loaded;
    const closedPort = await freePort();
    const leftovers = () => [...fs.readdirSync(path.join(HOME, 'public_html')).filter(n => /^tomlin-import-/.test(n)), ...fs.readdirSync(path.join(HOME, 'tomlin-secrets')).filter(n => /\.sql$/.test(n))];
    try {
      for (const [how, said] of [['drop', /broke off part way.*not all of it|not all of it.*broke off/], ['fatal', /answered 500.*not all of it/]]) {
        cp.site.importFails = how;
        const x = await api('/api/hosting/db/load', { id: shop.id, file: 'db/schema.sql' });
        assert(!x.ok && said.test(x.error), how + ': ' + JSON.stringify(x));
        assert(!/Is the domain pointing/.test(x.error), how + ': the site was reached: ' + x.error);
        assert.deepStrictEqual(leftovers(), [], how + ': the loader page and the .sql file are taken off');
        assert.deepStrictEqual((await api('/api/hosting/site?id=' + encodeURIComponent(shop.id))).site.db.loaded, before, how + ': not marked as loaded');
      }
    } finally { delete cp.site.importFails; }
    // Nothing answers at the site's address: never reached, so nothing was loaded (and the files are taken off too).
    const store = require('../../src/bridge/hosting/store');
    const realUrl = store.site(shop.dir).url;
    store.updateSite(shop.dir, x => ({ ...x, url: 'http://127.0.0.1:' + closedPort + '/' }));
    try {
      const x = await api('/api/hosting/db/load', { id: shop.id, file: 'db/schema.sql' });
      assert(!x.ok && /Could not reach .*nothing was loaded/.test(x.error), JSON.stringify(x));
      assert.deepStrictEqual(leftovers(), []);
    } finally { store.updateSite(shop.dir, x => ({ ...x, url: realUrl })); }
    // The project is free again: the next load works.
    const ok = await api('/api/hosting/db/load', { id: shop.id, file: 'db/schema.sql' });
    assert(ok.ok, JSON.stringify(ok));
  });

  await check('an older cPanel (no copy_file/delete_file): API 2 does the copies and removals', async () => {
    const x = await api('/api/hosting/connect', { kind: 'cpanel', host: 'localhost', port: old.port, user: 'user', scheme: 'http', password: 'right-password' });
    assert(x.ok, JSON.stringify(x));
    w(OLDHOME, 'public_html/about.html', 'old about\n');
    const OLDP = path.join(WS, 'old-site');
    w(OLDP, 'public_html/about.html', 'new about\n');
    w(OLDP, 'public_html/index.html', 'home\n');
    refreshProjects(true);
    const op = state.projects.find(p => p.dir.toLowerCase() === OLDP.toLowerCase());
    assert((await api('/api/hosting/site/set', { id: op.id, connection: x.connection.id, domain: 'shop.test', folder: 'public_html' })).ok);
    const j = await waitJob((await api('/api/hosting/push', { id: op.id })).job);
    assert(j.ok, JSON.stringify(j));
    assert(old.calls.some(c => typeof c === 'string' && c.startsWith('API2 Fileman::fileop copy')), 'copied through API 2');
    const b = await waitJob((await api('/api/hosting/back', { id: op.id })).job);
    assert(b.ok && r(OLDHOME, 'public_html/about.html') === 'old about\n' && !has(OLDHOME, 'public_html/index.html'), JSON.stringify(b));
    // A database user someone made by hand is never taken over (another site may use it): nothing is made.
    old.dbs.users.set('user_taken', 'their-own-password');
    const taken = await api('/api/hosting/db/setup', { id: op.id, name: 'taken' });
    assert(!taken.ok && /already on this account/.test(taken.error), JSON.stringify(taken));
    assert.strictEqual(old.dbs.users.get('user_taken'), 'their-own-password');
    assert(!old.dbs.list.includes('user_taken'));
    // A file the last push added, already taken off the server by hand: Go back skips it and finishes.
    w(OLDP, 'public_html/extra.html', 'extra\n');
    assert((await waitJob((await api('/api/hosting/push', { id: op.id })).job)).ok);
    fs.rmSync(path.join(OLDHOME, 'public_html', 'extra.html'));
    const b2 = await waitJob((await api('/api/hosting/back', { id: op.id })).job);
    assert(b2.ok, JSON.stringify(b2));
  });

  await check('local copy: the Local secrets reach it as environment variables, never the Live ones; two presses of Start make one copy', async () => {
    const ENVP = path.join(WS, 'env-site');
    const p2 = await freePort();
    w(ENVP, 'serve.js', 'require("fs").writeFileSync(require("path").join(__dirname,"seen.txt"), String(process.env.API_KEY));require("http").createServer((q,s)=>s.end("ok")).listen(' + p2 + ',"127.0.0.1");');
    w(ENVP, '.claude/launch.json', JSON.stringify({ configurations: [{ name: 'env', runtimeExecutable: process.execPath, runtimeArgs: ['serve.js'], port: p2 }] }));
    refreshProjects(true);
    const ep = state.projects.find(p => p.dir.toLowerCase() === ENVP.toLowerCase());
    assert((await api('/api/hosting/secrets', { id: ep.id, rows: [{ name: 'API_KEY', local: 'the-local-one', live: 'the-live-one' }] })).ok);
    const s = await api('/api/start', { id: ep.id, key: ep.commands[0].key, open: false });
    assert(s.ok, JSON.stringify(s));
    await sleep(200);
    assert.strictEqual(r(ENVP, 'seen.txt'), 'the-local-one');
    await api('/api/stop', { id: ep.id });
    // Two presses of Start while the secrets are still being opened (Windows can take a moment): one copy, not two.
    const secrets = require('../../src/bridge/hosting/secrets');
    const realValues = secrets.values;
    secrets.values = async (...a) => { await sleep(500); return realValues(...a); };
    try {
      const both = await Promise.all([1, 2].map(() => api('/api/start', { id: ep.id, key: ep.commands[0].key, open: false })));
      assert.strictEqual(both.filter(x => x.ok && !x.already).length, 1, JSON.stringify(both));
      assert(both.some(x => x.starting), JSON.stringify(both));
    } finally { secrets.values = realValues; }
    await api('/api/stop', { id: ep.id });
  });

  // ---------- FTPS (Windows' curl against a plain FTP server: the tests' only exception to "FTPS only") ----------
  let fconn;
  await check('FTPS: a wrong password is refused plainly; the right one connects and lists the folders', async () => {
    const bad = await api('/api/hosting/connect', { kind: 'ftps', host: 'localhost', port: ftp.port, user: 'ftpuser', password: 'nope', plain: true });
    assert(!bad.ok && /refused that user name and password/.test(bad.error), JSON.stringify(bad));
    fs.mkdirSync(path.join(FTP, 'public_html'), { recursive: true });
    const x = await api('/api/hosting/connect', { kind: 'ftps', host: 'localhost', port: ftp.port, user: 'ftpuser', password: 'ftp-pass', plain: true });
    assert(x.ok && x.folders.includes('public_html'), JSON.stringify(x));
    fconn = x.connection;
    assert(!raw().includes('ftp-pass'));
    assert(!ftp.log.some(l => /ftp-pass/.test(l)));
  });
  await check('FTPS: plain FTP is refused outside the tests', async () => {
    const ftps = require('../../src/bridge/hosting/ftps');
    process.env.BRIDGE_TEST_HOSTING = '0';
    try { assert.throws(() => ftps.client({ host: 'x.example', user: 'u', password: 'p', plain: true }), /unprotected/); }
    finally { process.env.BRIDGE_TEST_HOSTING = '1'; }
  });
  await check('FTPS: push, secrets one folder up with owner-only rights, a second push with a copy kept, Go back', async () => {
    const FP = path.join(WS, 'ftp-site');
    w(FP, 'public_html/index.html', 'ftp home\n');
    w(FP, 'public_html/sub dir/page one.html', 'page one\n');
    refreshProjects(true);
    const fp = state.projects.find(p => p.dir.toLowerCase() === FP.toLowerCase());
    const set = await api('/api/hosting/site/set', { id: fp.id, connection: fconn.id, root: 'public_html', url: 'http://127.0.0.1:' + ftpSite.address().port + '/', folder: 'public_html' });
    assert(set.ok && set.site.secretsDir === 'tomlin-secrets', JSON.stringify(set));
    assert((await api('/api/hosting/secrets', { id: fp.id, rows: [{ name: 'MAIL_PASS', live: 'ftp-live-value-1' }] })).ok);
    const j = await waitJob((await api('/api/hosting/push', { id: fp.id })).job);
    assert(j.ok, JSON.stringify(j));
    assert(r(FTP, 'public_html/sub dir/page one.html') === 'page one\n');
    const FP_SEC = secName('127.0.0.1', 'public_html');
    assert(r(FTP, 'tomlin-secrets/' + FP_SEC).includes('ftp-live-value-1'));
    assert.strictEqual(ftp.srv.modes.get('/tomlin-secrets/' + FP_SEC), '600');
    assert(/dirname\(__DIR__\)/.test(r(FTP, 'public_html/tomlin-secrets.php')));
    w(FP, 'public_html/index.html', 'ftp home 2\n');
    const j2 = await waitJob((await api('/api/hosting/push', { id: fp.id })).job);
    assert(j2.ok && j2.result.sent === 1 && j2.result.kept === 1, JSON.stringify(j2));
    const b = await waitJob((await api('/api/hosting/back', { id: fp.id })).job);
    assert(b.ok && r(FTP, 'public_html/index.html') === 'ftp home\n', JSON.stringify(b));
  });
  await check('FTPS: two sites of one domain in sibling folders each keep their own Live secrets file; an old shared name goes only when nothing reads it', async () => {
    const store = require('../../src/bridge/hosting/store');
    const deploy = require('../../src/bridge/hosting/deploy');
    const url = 'http://127.0.0.1:' + ftpSite.address().port;
    const two = [];
    for (const n of ['one', 'two']) {
      const dir = path.join(WS, 'ftp-' + n);
      w(dir, 'index.html', n + '\n');
      refreshProjects(true);
      const pr = state.projects.find(p => p.dir.toLowerCase() === dir.toLowerCase());
      const set = await api('/api/hosting/site/set', { id: pr.id, connection: fconn.id, root: 'public_html/' + n, url: url + '/' + n + '/', folder: '' });
      assert(set.ok && set.site.secretsDir === 'public_html/tomlin-secrets', JSON.stringify(set));
      assert((await api('/api/hosting/secrets', { id: pr.id, rows: [{ name: 'DB_PASS', live: 'pass-of-site-' + n + '-123' }] })).ok);
      two.push(pr);
    }
    const push = async pr => { const j = await waitJob((await api('/api/hosting/push', { id: pr.id })).job); assert(j.ok, JSON.stringify(j)); return j; };
    for (const pr of two) await push(pr);
    const [f1, f2] = ['one', 'two'].map(n => secName('127.0.0.1', 'public_html/' + n));
    assert(f1 !== f2, 'two names');
    const one = r(FTP, 'public_html/tomlin-secrets/' + f1);
    assert(one.includes('pass-of-site-one-123') && !one.includes('pass-of-site-two'), one);
    assert(r(FTP, 'public_html/tomlin-secrets/' + f2).includes('pass-of-site-two-123'));
    assert(r(FTP, 'public_html/one/tomlin-secrets.php').includes(f1) && r(FTP, 'public_html/two/tomlin-secrets.php').includes(f2), 'each loader reads its own file');
    assert.strictEqual(store.site(two[0].dir).secretsFile, 'public_html/tomlin-secrets/' + f1);

    // Both written by an older TOMLIN under the one name they shared: the first to push again leaves it (the other
    // site still reads it); the second takes it off.
    const OLD = 'public_html/tomlin-secrets/127.0.0.1.php';
    w(FTP, OLD, '<?php return array();\n');
    for (const pr of two) store.updateSite(pr.dir, x => { delete x.secretsFile; return x; });
    assert.strictEqual(deploy.secretsFileOf(store.site(two[0].dir)), OLD);
    await push(two[0]);
    assert(has(FTP, OLD), 'kept while the other site still reads it');
    await push(two[1]);
    assert(!has(FTP, OLD), 'gone once no site reads it');
    assert(r(FTP, 'public_html/tomlin-secrets/' + f2).includes('pass-of-site-two-123'));
    for (const pr of two) await api('/api/hosting/site/remove', { id: pr.id });
  });

  // ---------- SFTP (a real key from Windows' ssh-keygen; a stand-in sftp.exe) ----------
  await check('SFTP: a key is made (public half shown), the server key remembered, a push and secrets with chmod 600', async () => {
    const x = await api('/api/hosting/connect', { kind: 'sftp', host: 'localhost', port: 2222, user: 'user' });
    assert(x.ok && /^ssh-ed25519 \S+ TOMLIN$/.test(x.connection.publicKey), JSON.stringify(x));
    assert(!raw().includes('BEGIN OPENSSH PRIVATE KEY'), 'the private key is sealed');
    const t = await api('/api/hosting/test', { connection: x.connection.id });
    assert(t.ok && /^ssh-ed25519 SHA256:/.test(t.connection.hostKey), JSON.stringify(t));
    fs.mkdirSync(path.join(SFTP, 'www'), { recursive: true });
    const SP = path.join(WS, 'sftp-site');
    w(SP, 'index.html', 'sftp home\n');
    w(SP, 'img/a b.txt', 'x\n');
    refreshProjects(true);
    const sp = state.projects.find(p => p.dir.toLowerCase() === SP.toLowerCase());
    assert((await api('/api/hosting/site/set', { id: sp.id, connection: x.connection.id, root: 'www', url: 'http://127.0.0.1:' + ftpSite.address().port + '/', folder: '' })).ok);
    assert((await api('/api/hosting/secrets', { id: sp.id, rows: [{ name: 'TOKEN_A', live: 'sftp-live-value' }] })).ok);
    const j = await waitJob((await api('/api/hosting/push', { id: sp.id })).job);
    assert(j.ok, JSON.stringify(j));
    assert(r(SFTP, 'www/img/a b.txt') === 'x\n' && r(SFTP, 'tomlin-secrets/' + secName('127.0.0.1', 'www')).includes('sftp-live-value'));
    assert(fs.readFileSync(process.env.FAKE_SFTP_LOG, 'utf8').includes('"chmod":"600"'));
    // The server's key changes: nothing is sent, and the reason says so.
    process.env.FAKE_SFTP_HOSTKEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIGRpZmZlcmVudC1zZXJ2ZXIta2V5LWhlcmUtISE=';
    w(SP, 'index.html', 'changed\n');
    const j2 = await waitJob((await api('/api/hosting/push', { id: sp.id })).job);
    assert(!j2.ok && /key is not the one TOMLIN saw/.test(j2.error), JSON.stringify(j2));
    assert.strictEqual(r(SFTP, 'www/index.html'), 'sftp home\n');
    delete process.env.FAKE_SFTP_HOSTKEY;
  });

  await check('disconnect: TOMLIN\'s cPanel token is deleted on the server, and the site forgets the connection', async () => {
    const before = cp.tokens.size;
    const d = await api('/api/hosting/disconnect', { connection: conn.id });
    assert(d.ok && /deleted in cPanel/.test(d.note), JSON.stringify(d));
    assert.strictEqual(cp.tokens.size, before - 1);
    assert.strictEqual((await api('/api/hosting/site?id=' + encodeURIComponent(shop.id))).site.connection, null);
  });

  await check('the hosting records: one TOMLIN cannot read is an error, never "nothing set up"; a damaged one is kept aside', async () => {
    const store = require('../../src/bridge/hosting/store');
    const dir = path.join(TMP, 'store-test');
    fs.mkdirSync(path.join(dir, 'held.json'), { recursive: true }); // a folder in its place: reading it fails
    assert.throws(() => store.readJson(path.join(dir, 'held.json'), () => ({ sites: {} })), /could not read held\.json .*changed nothing/);
    w(dir, 'bad.json', '{ not json');
    assert.deepStrictEqual(store.readJson(path.join(dir, 'bad.json'), () => ({ sites: {} })), { sites: {} });
    assert(fs.readdirSync(dir).some(n => n.startsWith('bad.json.damaged-')), 'the damaged file is kept aside');
    // Damaged, and the copy cannot be made (disk full): an error, never empty, so no save writes over the only copy.
    w(dir, 'worse.json', '{ not json either');
    const realCopy = fs.copyFileSync;
    fs.copyFileSync = () => { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; };
    try { assert.throws(() => store.readJson(path.join(dir, 'worse.json'), () => ({ sites: {} })), /worse\.json is damaged .*ENOSPC.*changed nothing/); }
    finally { fs.copyFileSync = realCopy; }
    assert.strictEqual(r(dir, 'worse.json'), '{ not json either');
    store.writeJson(path.join(dir, 'good.json'), { a: 1 });
    assert.deepStrictEqual(store.readJson(path.join(dir, 'good.json'), () => ({})), { a: 1 });
    assert(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')), 'no temp file is left');
  });

  await check('no key file or secret temp file is left in the temp folder', async () => {
    assert.strictEqual(tempsLeft('tomlin-k-').length, tempBefore.k);
    assert.strictEqual(tempsLeft('tomlin-put-').length, tempBefore.put);
  });

  await check('vault: a real Windows (DPAPI) seal opens again, and only for this account', async () => {
    const vault = require('../../src/bridge/hosting/vault');
    delete process.env.BRIDGE_TEST_VAULT;
    try {
      const [a] = await vault.sealAll(['dpapi-test-value']);
      assert(a.startsWith('dpapi:') && !a.includes('dpapi-test-value'));
      assert.strictEqual(await vault.open(a), 'dpapi-test-value');
      await assert.rejects(vault.open('test:' + Buffer.from('x').toString('base64')), /test copy/);
    } finally { process.env.BRIDGE_TEST_VAULT = 'plain'; }
  });

  server.close();
  await Promise.all([cp.close(), old.close(), ftp.close(), new Promise(x => ftpSite.close(x))]);
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
