// Self-test for the built-in audit: plants one fault per rule in a temp folder and checks each rule fires,
// checks a clean project stays quiet, and runs the localhost half against two tiny servers.
// Run: node test/audit.test.js   (no packages). Fake keys are assembled at run time so no key-shaped text sits in a file.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { runAudit } = require('../../src/bridge/audit');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const rep = (c, n) => c.repeat(n);
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

async function main() {
  // --- planted faults ---
  const bad = path.join(tmp, 'bad');
  // Random, key-shaped values made now (a repeated letter is a placeholder, and the audit rightly ignores it).
  const rnd = n => require('crypto').randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
  w('bad/keys/a.txt', '-----BEGIN ' + 'PRIVATE KEY-----\n' + rnd(64) + '\n' + rnd(64) + '\n-----END ' + 'PRIVATE KEY-----\n');
  w('bad/keys/b.js', 'const k = "' + 'sk-' + 'ant-' + rnd(40) + '";');
  w('bad/keys/c.js', 'const k = "' + 'sk_' + 'live_' + rnd(24) + '";');
  w('bad/config.php', "<?php $config = ['password' => 'Hunter2Real!'];\nini_set('display_errors', '1');");
  w('bad/sql.php', '<?php $db->query("SELECT * FROM users WHERE id = " . $_GET["id"]);');
  w('bad/run.php', '<?php include($_GET["page"]);');
  w('bad/ui.js', 'document.getElementById("out").innerHTML = localStorage.getItem("x");');
  w('bad/echo.php', '<?php echo "Hi " . $_GET["name"];');
  w('bad/hash.php', '<?php $h = md5($password);');
  w('bad/cmp.php', '<?php if ($token == $given) {}');
  w('bad/form.html', '<form method="post" action="/x"><input name="a"></form>');
  w('bad/up.php', '<?php move_uploaded_file($_FILES["f"]["tmp_name"], "u/" . $_FILES["f"]["name"]);');
  w('bad/srv.js', 'app.listen(3000, "0.0.0.0");\nserver.listen({ host: "0.0.0.0" });');
  w('bad/index.html', '<script src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>');
  w('bad/public_html/.env', 'DB_PASS=x');
  w('bad/public_html/dump.sql', '--');
  w('bad/public_html/site.zip', 'PK');
  // A fault only in a test folder is not reported (non-critical), but a key there still is.
  w('bad/tests/fixture.php', '<?php $h = md5($password);');

  const a = await runAudit(bad, null);
  const ids = new Set(a.findings.map(f => f.rule));
  for (const id of ['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004', 'INJ-001', 'INJ-002', 'INJ-003', 'INJ-004', 'AUTH-001', 'AUTH-002',
    'CSRF-001', 'UPL-001', 'CFG-001', 'CFG-002', 'PRIV-001', 'EXP-001', 'EXP-002', 'EXP-003']) {
    check('rule ' + id + ' fires', () => assert(ids.has(id), 'not found; got ' + [...ids].join(',')));
  }
  w('bad2/public_html/backups/a.sql', '--');
  w('bad2/public_html/backups/b.sql', '--');
  w('bad2/public_html/backups/c.sql', '--');
  const b2 = await runAudit(path.join(tmp, 'bad2'), null);
  // INJ-003 (revised): only outside data counts. One file per case, since a rule reports once per file.
  const inj = path.join(tmp, 'inj');
  const LOUD = {
    'direct-storage.js': 'out.innerHTML = localStorage.getItem("x");',
    'via-variable.js': 'const saved = sessionStorage.getItem("n");\nbox.innerHTML = "<b>" + saved + "</b>";',
    'input-value.js': 'const who = document.querySelector("#name").value;\nhi.innerHTML = `Hello ${who}`;',
    'url-param.js': 'const q = new URLSearchParams(location.search).get("q");\nres.innerHTML = q;',
    'fetch-json.js': 'const data = JSON.parse(text);\nlist.innerHTML = data.items.join("");',
    'message.js': 'window.addEventListener("message", ev => { panel.innerHTML = ev.data; });',
    'escaped-half.js': 'row.innerHTML = esc(a) + localStorage.getItem("b");',
  };
  const QUIET = {
    'fixed-steps.js': 'const STEPS = [{ title: "Welcome" }];\nfunction show(step) { tip.innerHTML = "<h3>" + step.title + "</h3>"; }',
    'picked-sentence.js': 'const MSGS = ["a", "b", "c"];\nconst msg = MSGS[n];\nnote.innerHTML = "<p>" + msg + "</p>";',
    'join-words.js': 'const missing = [];\nif (!name) missing.push("name");\nbar.innerHTML = "Add " + missing.join(", ");',
    'numbers.js': 'sum.innerHTML = jobs.length + " jobs, " + distanceKm.toFixed(1) + " km, " + Math.round(durationMin) + " min";',
    'escaped.js': 'const who = document.querySelector("#name").value;\nhi.innerHTML = "Hello " + escapeHtml(who);',
    'reused-name.js': 'function a() { const v = input.value; save(v); }\nfunction b(rows) { t.innerHTML = rows.map(([k, v]) => "<td>" + k + "</td>").join(""); }',
    'arrow-not-assignment.js': 'if (LIST.some(c => c[0] === sel.value)) {}\nnote.innerHTML = c.label;',
    'property-write.js': 'state.cost.currency = sel.value;\nlabel.innerHTML = "<b>" + currency + "</b>";',
  };
  for (const [n, t] of Object.entries(LOUD)) w('inj/' + n, t);
  for (const [n, t] of Object.entries(QUIET)) w('inj/' + n, t);
  w('inj/_build/deploy/direct-storage.js', LOUD['direct-storage.js']); // a build copy must not be counted again
  const ia = await runAudit(inj, null);
  const injFiles = new Set(ia.findings.filter(f => f.rule === 'INJ-003').map(f => f.where.replace(/:\d+$/, '')));
  for (const n of Object.keys(LOUD)) check('INJ-003 fires: ' + n, () => assert(injFiles.has(n), 'got ' + [...injFiles].join(',')));
  for (const n of Object.keys(QUIET)) check('INJ-003 quiet: ' + n, () => assert(!injFiles.has(n)));
  check('_build/ copy is skipped', () => assert(![...injFiles].some(f => f.startsWith('_build/'))));

  // Judged false positives: hidden from findings but returned as `setAside`; editing the line brings it back.
  const { fingerprint } = require('../../src/bridge/audit');
  const acc = [{ id: 'x1', rule: 'INJ-003', file: 'direct-storage.js', fp: fingerprint(LOUD['direct-storage.js']), verdict: 'false', why: 'test', by: 'test' }];
  const aa = await runAudit(inj, null, { judged: acc });
  check('a judged finding is moved to setAside, not lost', () => assert(!aa.findings.some(f => f.where.startsWith('direct-storage.js')) && aa.setAside.length === 1 && aa.setAside[0].judged.why === 'test'));
  w('inj/direct-storage.js', 'out.innerHTML = localStorage.getItem("y");');
  const ab = await runAudit(inj, null, { judged: acc });
  check('an edited line comes back', () => assert(ab.findings.some(f => f.where.startsWith('direct-storage.js')) && ab.setAside.length === 0));

  check('three exposed files in one folder = one finding', () => assert(b2.findings.length === 1 && /3 files/.test(b2.findings[0].where), JSON.stringify(b2.findings)));
  check('test-folder hash not reported', () => assert(!a.findings.some(f => f.where.startsWith('tests/'))));
  check('verdict is fix-first', () => assert.strictEqual(a.verdict, 'fix-first'));

  // --- rules added with the deeper audit: each planted once, with a guarded twin that must stay quiet ---
  const more = path.join(tmp, 'more');
  const PLANT = {
    'SEC-005': ['k.js', 'const hook = "' + 'whsec_' + rep('Q', 30) + '";'],
    'SEC-006': ['maps.js', 'const key = "' + 'AIza' + rep('x', 35) + '";'],
    'INJ-005': ['obj.php', '<?php $o = unserialize($_COOKIE["cart"]);'],
    'INJ-006': ['run.js', 'app.get("/ping", (req, res) => exec(`ping -c 1 ${req.query.host}`));'],
    'INJ-007': ['q.js', 'db.query(`SELECT * FROM users WHERE name = \'${req.query.name}\'`);'],
    'INJ-008': ['tool.py', 'os.system(f"convert {request.args[\'f\']} out.png")'],
    'INJ-009': ['load.py', 'data = pickle.loads(request.data)'],
    'INJ-010': ['calc.js', 'const r = eval(document.querySelector("#sum").value);'],
    'PATH-001': ['dl.php', '<?php readfile("files/" . $_GET["name"]);'],
    'REDIR-001': ['go.php', '<?php header("Location: " . $_GET["next"]);'],
    'CORS-001': ['api.php', "<?php header('Access-Control-Allow-Origin: ' . $_SERVER['HTTP_ORIGIN']); header('Access-Control-Allow-Credentials: true');"],
    'TLS-001': ['fetch.php', '<?php curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);'],
    'RAND-001': ['reset.js', 'const resetToken = Math.random().toString(36).slice(2);'],
    'JWT-001': ['auth.js', 'jwt.verify(token, key, { algorithms: ["none"] });'],
    'DEBUG-001': ['app.py', 'app.run(host="127.0.0.1", debug=True)'],
    'PHPINFO-001': ['public_html/info.php', '<?php phpinfo();'],
    'INJ-003': ['ins.js', 'const q = new URLSearchParams(location.search).get("q");\nlist.insertAdjacentHTML("beforeend", "<li>" + q + "</li>");'],
    'INJ-004': ['short.php', '<p><?= $_GET["q"] ?></p>'],
  };
  const TWIN = {
    'INJ-006': ['run2.js', 'app.get("/ping", (req, res) => execFile("ping", ["-c", "1", "example.com"]));'],
    'INJ-007': ['q2.js', 'db.query("SELECT * FROM users WHERE name = ?", [req.query.name]);'],
    'PATH-001': ['dl2.php', '<?php $n = basename($_GET["name"]); readfile("files/" . $_GET["name"]);'],
    'REDIR-001': ['go2.php', '<?php $n = $_GET["next"]; if (!str_starts_with($n, "/") || str_starts_with($n, "//")) $n = "/";\nheader("Location: " . $_GET["next"]);'],
    'CORS-001': ['api2.php', "<?php if (in_array($_SERVER['HTTP_ORIGIN'], $allowed, true)) header('Access-Control-Allow-Origin: ' . $_SERVER['HTTP_ORIGIN']);"],
    'RAND-001': ['reset2.js', 'const resetToken = crypto.randomBytes(24).toString("hex"); const shuffle = Math.random();'],
    'INJ-004': ['short2.php', '<p><?= htmlspecialchars($_GET["q"], ENT_QUOTES) ?></p>'],
    'INJ-010': ['calc2.js', 'setTimeout(() => save(input.value), 300);'],
  };
  for (const [rule, [f, t]] of Object.entries(PLANT)) w('more/' + f, t);
  for (const [rule, [f, t]] of Object.entries(TWIN)) w('more/' + f, t);
  w('more/public_html/.git/HEAD', 'ref: refs/heads/main');
  w('more/public_html/composer.json', '{}');
  w('more/public_html/error_log', '[x] PHP Warning');
  w('more/.vscode/sftp.json', '{ "host": "ftp.example.com", "password": "' + 'hunter' + '22" }');
  w('more/.vscode/sftp-nopass.json', '{ "host": "x" }');
  const mo = await runAudit(more, null);
  const at = (rule, file) => mo.findings.some(f => f.rule === rule && f.where.replace(/:\d+$/, '') === file);
  for (const [rule, [f]] of Object.entries(PLANT)) check('new rule ' + rule + ' fires on ' + f, () => assert(at(rule, f), 'got ' + mo.findings.map(x => x.rule + '@' + x.where).join(', ')));
  for (const [rule, [f]] of Object.entries(TWIN)) check('new rule ' + rule + ' quiet on the guarded ' + f, () => assert(!mo.findings.some(x => x.where.startsWith(f)), mo.findings.filter(x => x.where.startsWith(f)).map(x => x.rule).join(',')));
  check('EXP-005 .git folder inside the site folder', () => assert(at('EXP-005', 'public_html/.git/')));
  check('EXP-004 package list inside the site folder', () => assert(mo.findings.some(f => f.rule === 'EXP-004')));
  check('EXP-006 log file inside the site folder', () => assert(mo.findings.some(f => f.rule === 'EXP-006')));
  // --- false positives found on real projects (calibration), each kept quiet ---
  const fpq = path.join(tmp, 'fpq');
  const QUIET2 = {
    'game/term.ts': "const lines = ['-----BEGIN " + "OPENSSH PRIVATE KEY-----', `c2F0${sha(now)}`, '-----END OPENSSH PRIVATE KEY-----'];",
    'test/fake-key.mjs': "export const KEY = '" + 'sk-' + 'ant-' + 'api03-' + 'fake' + rnd(30) + "';",
    'lib/csp.php': "$script .= $ga ? ' https://www.googletagmanager.com' : '';",
    'old/analytics.php': ' * Note also that this loads a third-party script from googletagmanager.com. The',
    'page.html': '<!-- <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script> -->',
    'dev/php.sh': 'php -S 127.0.0.1:8000 -d display_errors=1',
    'rules.py': '      "The app runs with debug=True; the Werkzeug debugger lets a visitor run code",',
    'ui.js': 'const out = input.value;\nel.innerHTML = \'Empty plan. Drag out a <b>Room</b>, or pick one.\';',
    'art.php': "<?php echo Preview::fromText((string)($_POST['body'] ?? ''));",
    'modal.php': "<dialog<?= (string) ($_GET['open'] ?? '') === 'password' ? ' open' : '' ?>>",
    'field.php': "<input value=\"<?= e((string) ($_POST['signed_name'] ?? '')) ?>\">",
    'logo.php': "<?php $info = @getimagesize($tmp); if (!$info) exit;\nmove_uploaded_file($tmp, $dir . '/logo.png');",
    'upd.php': "<?php $head = file_get_contents($tmp, false, null, 0, 4); if ($head !== \"PK\\x03\\x04\") exit;\nmove_uploaded_file($tmp, $dest);",
    'srv.mjs': 'const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");',
    // a game's made-up key: its body decodes to readable text, not key bytes
    'game/relay.ts': "const K = [\n '-----BEGIN " + "OPENSSH PRIVATE KEY-----',\n '" + Buffer.from('training-key-not-a-real-key-anywhere-in-the-world-at-all-ok').toString('base64') + "',\n '-----END OPENSSH PRIVATE KEY-----'];",
    'min.js': "$('.legend').innerHTML='Replay · markers enlarged';status('x');const r=await fetch('/api');",
  };
  const LOUD2 = {
    'raw.php': "<?php echo trim($_GET['q']);",
    'raw2.php': "<p><?= sprintf('%s', $_GET['q']) ?></p>",
    'tpl.js': 'const q = location.hash;\nel.innerHTML = `<b>${q}</b>`;',
  };
  for (const [f, t] of Object.entries(QUIET2)) w('fpq/' + f, t);
  for (const [f, t] of Object.entries(LOUD2)) w('fpq/' + f, t);
  // the same fault in three release copies = one finding listing the others
  for (const v of ['v1.5', 'v1.6', 'v1.7']) w('fpq/port-' + v + '/tag.html', '<script src="https://www.googletagmanager.com/gtag/js?id=G-2"></script>');
  // an archive a page links to is a published download
  w('fpq/public_html/updates/app-1.0.zip', 'PK');
  w('fpq/public_html/updates/latest.json', '{ "zip": "app-1.0.zip" }');
  const fq = await runAudit(fpq, null);
  for (const f of Object.keys(QUIET2)) check('calibration quiet: ' + f, () => assert(!fq.findings.some(x => x.where.startsWith(f)), fq.findings.filter(x => x.where.startsWith(f)).map(x => x.rule).join(',')));
  for (const f of Object.keys(LOUD2)) check('calibration still loud: ' + f, () => assert(fq.findings.some(x => x.where.startsWith(f)), 'not found'));
  // Version copies side by side are now left out as old copies (lib/roots.js), so only the newest is scanned; with
  // that switched off (or copies the root step cannot tell apart), identical lines still merge into one finding.
  check('versions side by side: the highest is scanned, the older two are left out and named', () => {
    const t = fq.findings.filter(x => x.rule === 'PRIV-001');
    assert(t.length === 1 && t[0].where.startsWith('port-v1.7/') && !t[0].also && ['port-v1.5', 'port-v1.6'].every(r => fq.copiesLeftOut.some(l => l.rel === r)) && !fq.copiesLeftOut.some(l => l.rel === 'port-v1.7'),JSON.stringify(t) + JSON.stringify(fq.copiesLeftOut));
  });
  const fqAll = await runAudit(fpq, null, { root: false });
  check('three copies of one fault = one finding, others listed', () => {
    const t = fqAll.findings.filter(x => x.rule === 'PRIV-001');
    assert(t.length === 1 && t[0].also && t[0].also.length === 2, JSON.stringify(t));
  });
  check('a linked archive is a note, not EXP-003', () => assert(!fq.findings.some(x => x.rule === 'EXP-003') && fq.notes.some(n => /app-1\.0\.zip is named in/.test(n))));
  // --- rules added after the register cross-check ---
  const reg = path.join(tmp, 'reg');
  w('reg/public_html/index.php', '<?php echo 1;');
  w('reg/public_html/old/index.html', '<title>old</title>');
  w('reg/public_html/api/v1/index.php', '<?php echo 1;'); // an API version folder is not an old copy
  w('reg/booking.php', "<?php function ip() { return $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR']; }");
  w('reg/lib/ip.php', "<?php $trustProxy = (bool) cfg('trust_proxy', false);\nif ($trustProxy && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) { $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']); }");
  w('reg/index.html', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">\n<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>\n<script src="https://widget.bookings-example.io/w.js"></script>');
  w('reg/privacy.html', '<p>We use Google Fonts. Charts are drawn by a library served by jsDelivr.</p>');
  const rg = await runAudit(reg, null);
  const rgs = rg.findings.map(f => f.rule + '@' + f.where + ' ' + f.title).join('\n  ');
  check('EXP-007 old copy of the site in the site folder (not an API version folder)', () => assert(rg.findings.some(f => f.rule === 'EXP-007' && /old\/$/.test(f.where)) && !rg.findings.some(f => f.rule === 'EXP-007' && /v1/.test(f.where)), rgs));
  check('AUTH-003 forwarded header trusted as the visitor address', () => assert(rg.findings.some(f => f.rule === 'AUTH-003' && f.where.startsWith('booking.php')), rgs));
  check('AUTH-003 quiet when only trusted behind a named proxy setting', () => assert(!rg.findings.some(f => f.rule === 'AUTH-003' && f.where.startsWith('lib/ip.php')), rgs));
  check('PRIV-002 names the one service the privacy page leaves out, not the ones it names', () => {
    const p = rg.findings.find(f => f.rule === 'PRIV-002');
    assert(p && /bookings-example\.io/.test(p.title) && !/googleapis|jsdelivr/.test(p.title), rgs);
  });
  check('SEC-007 FTP password in editor settings (and not without one)', () => assert(at('SEC-007', '.vscode/sftp.json') && !mo.findings.some(f => f.where === '.vscode/sftp-nopass.json')));

  // --- clean project: the same shapes done safely ---
  const good = path.join(tmp, 'good');
  w('good/sql.php', '<?php $st = $db->prepare("SELECT * FROM users WHERE id = ?"); $st->execute([$_GET["id"]]);');
  w('good/echo.php', '<?php echo "Hi " . htmlspecialchars($_GET["name"], ENT_QUOTES);');
  w('good/form.html', '<form method="post"><input type="hidden" name="csrf" value="x"></form>');
  w('good/up.php', '<?php $ext = pathinfo($n, PATHINFO_EXTENSION); if (in_array($ext, $allowed)) move_uploaded_file($t, $d);');
  w('good/ui.js', 'el.textContent = name; el.innerHTML = "<b>fixed</b>";');
  w('good/opts.php', "<?php $o = ['include_links' => isset($_POST['include_links']) ? 1 : 0];");
  w('good/hosts.js', 'const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0"];');
  w('good/cfg.php', "<?php $password = 'changeme-example';");
  w('good/index.html', '<script>if (consent) load("https://www.googletagmanager.com/gtag/js")</script>');
  w('good/public_html/index.php', '<?php echo 1;');
  w('good/prep.php', "<?php $r = pd_row('SELECT * FROM listing WHERE id = ? AND a = ?', [(int) ($_POST['listing_id'] ?? 0), $id]);");
  w('good/ui2.js', 'box.innerHTML = html; row.innerHTML = "<td>" + esc(name) + "</td>";');
  // .sql files blocked by an .htaccess further up (a common admin-folder pattern) or by deny-all in their own folder
  w('good/public_html/admin/.htaccess', 'RedirectMatch 404 ^/admin/(lib|migrations)(/|$)');
  w('good/public_html/admin/migrations/001.sql', '--');
  w('good/public_html/private/.htaccess', 'Require all denied');
  w('good/public_html/private/dump.sql', '--');
  // a skipped vendored folder is not read
  w('good/vendored-copy/x.php', '<?php $h = md5($password);');
  const gopts = { skip: ['vendored-copy'] };
  const g = await runAudit(good, null, gopts);
  check('clean project has no findings', () => assert.strictEqual(g.findings.length, 0, JSON.stringify(g.findings.map(f => f.rule + ' ' + f.where))));
  check('clean verdict is passed', () => assert.strictEqual(g.verdict, 'passed'));

  // --- localhost half ---
  const home = '<html><body>home</body></html>';
  const leaky = http.createServer((req, res) => {
    if (req.url === '/.env') { res.writeHead(200); return res.end('DB_PASS=x\n'); }
    if (req.url === '/.git/HEAD') { res.writeHead(200); return res.end('ref: refs/heads/main\n'); }
    res.writeHead(200, { 'Content-Type': 'text/html', 'X-Powered-By': 'PHP/8.5.8', 'Set-Cookie': 'PHPSESSID=abc; Path=/' });
    res.end(home);
  });
  const tidy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff', 'Set-Cookie': 'sess=abc; HttpOnly; SameSite=Lax' });
    res.end(home); // answers every address with the home page, like a single-page app
  });
  await new Promise(r => leaky.listen(0, '127.0.0.1', r));
  await new Promise(r => tidy.listen(0, '127.0.0.1', r));
  const L = await runAudit(good, 'http://127.0.0.1:' + leaky.address().port + '/', gopts);
  const lids = new Set(L.findings.map(f => f.rule));
  for (const id of ['LIVE-001', 'LIVE-003', 'LIVE-004', 'LIVE-005', 'LIVE-006', 'LIVE-010', 'LIVE-011']) {
    check('live ' + id + ' fires', () => assert(lids.has(id), 'got ' + [...lids].join(',')));
  }
  // A dev server hands out .env, but the project's .htaccess refuses dot-files on a real server: a note, not a finding.
  w('hta/public_html/.env', 'DB_PASS=x');
  w('hta/public_html/.htaccess', '<FilesMatch "^\\.">\n  Require all denied\n</FilesMatch>\n');
  const H = await runAudit(path.join(tmp, 'hta'), 'http://127.0.0.1:' + leaky.address().port + '/');
  check('.env blocked by <FilesMatch "^\\."> is noted, not counted (localhost and file check)', () => {
    assert(!H.findings.some(f => f.rule === 'LIVE-010' || f.rule === 'EXP-001'), H.findings.map(f => f.rule).join(','));
    assert(H.notes.some(n => /\.env is handed out by the local dev server/.test(n)), H.notes.join('|'));
  });
  w('hta2/public_html/.env', 'DB_PASS=x');
  w('hta2/public_html/.htaccess', 'RedirectMatch 404 /\\.git\n');
  const H2 = await runAudit(path.join(tmp, 'hta2'), 'http://127.0.0.1:' + leaky.address().port + '/');
  check('a rule for .git only does not cover .env', () => assert(H2.findings.some(f => f.rule === 'LIVE-010') && H2.findings.some(f => f.rule === 'EXP-001')));
  const T = await runAudit(good, 'http://127.0.0.1:' + tidy.address().port + '/', gopts);
  check('tidy site passes (home-page fallback is not a leak)', () => assert.strictEqual(T.findings.length, 0, JSON.stringify(T.findings.map(f => f.rule))));
  const D = await runAudit(good, 'http://127.0.0.1:1/', gopts);
  check('site down is reported, not passed', () => assert(D.findings.some(f => f.rule === 'LIVE-000') && D.verdict === 'fix-first'));
  const X = await runAudit(good, 'http://example.com/', gopts);
  check('non-localhost address is never fetched', () => assert(X.findings.some(f => f.rule === 'LIVE-000')));
  leaky.close(); tidy.close();

  // A key in a file git ignores stays on this PC: a warning. The same kind of key in a file git takes stays critical.
  w('ign/.gitignore', 'local-keys.js\n');
  w('ign/local-keys.js', 'const k = "' + 'sk_' + 'live_' + rnd(24) + '";');
  w('ign/app.js', 'const k = "' + 'sk_' + 'live_' + rnd(24) + '";');
  require('child_process').execFileSync('git', ['init', '-q', path.join(tmp, 'ign')], { windowsHide: true });
  const I = await runAudit(path.join(tmp, 'ign'), null);
  const keyAt = file => I.findings.find(f => f.rule === 'SEC-003' && f.where.startsWith(file));
  check('a key in a git-ignored file is a warning, and says why', () => assert(keyAt('local-keys.js') && keyAt('local-keys.js').sev === 'Medium' && keyAt('local-keys.js').ignored.was === 'Critical' && /git ignores/.test(keyAt('local-keys.js').title)));
  check('a key in a file git would take stays critical', () => assert(keyAt('app.js') && keyAt('app.js').sev === 'Critical' && !keyAt('app.js').ignored));
  const N = await runAudit(bad, null);
  check('no git: nothing is softened', () => assert(!N.findings.some(f => f.ignored) && N.findings.some(f => f.rule === 'SEC-003' && f.sev === 'Critical')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main();
