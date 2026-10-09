// Self-test for lib/cross.js: every cross-file rule gets a small project where it must fire and a fixed one where it
// must stay quiet, written differently from the museum's copies (test/museum/cases-3-cross-file.js). Then QUIET
// projects built from the wrong flags seen on real projects (names made up): each shape stays quiet.
// Run: node test/cross.test.js   (no packages).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runAudit } = require('../../src/bridge/audit');
const { CROSS_RULES } = require('../../src/bridge/cross');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

const LIMITER = `<?php
function throttle_pass($scope, $who, $most, $window) {
  $n = (int)apcu_fetch("t:$scope:$who");
  if ($n >= $most) return false;
  apcu_store("t:$scope:$who", $n + 1, $window);
  return true;
}
`;

// [rule, { fires }, { stays quiet }]
const PAIRS = [
  ['ABUSE-001', { 'inc/throttle.php': LIMITER, 'public/subscribe.php': `<?php
require '../inc/throttle.php';
$addr = filter_var($_POST['addr'] ?? '', FILTER_VALIDATE_EMAIL);
$pdo->prepare('INSERT INTO subscribers (addr) VALUES (?)')->execute([$addr]);
` }, { 'inc/throttle.php': LIMITER, 'public/subscribe.php': `<?php
require '../inc/throttle.php';
if (!throttle_pass('sub', $_SERVER['REMOTE_ADDR'], 3, 600) || !throttle_pass('sub', 'everyone', 500, 86400)) { http_response_code(429); exit; }
$addr = filter_var($_POST['addr'] ?? '', FILTER_VALIDATE_EMAIL);
$pdo->prepare('INSERT INTO subscribers (addr) VALUES (?)')->execute([$addr]);
` }],
  ['ABUSE-002', { 'inc/throttle.php': LIMITER, 'public/weather.php': `<?php
require '../inc/throttle.php';
if (!throttle_pass('wx', $_SERVER['REMOTE_ADDR'], 30, 3600)) exit;
$town = $_GET['town'] ?? '';
echo file_get_contents('https://api.weather-paid.example/v1?q=' . urlencode($town) . '&apikey=' . WX_KEY);
` }, { 'inc/throttle.php': LIMITER, 'public/weather.php': `<?php
require '../inc/throttle.php';
if (!throttle_pass('wx', $_SERVER['REMOTE_ADDR'], 30, 3600) || !throttle_pass('wx', 'all', 1000, 86400)) exit;
$town = $_GET['town'] ?? '';
echo file_get_contents('https://api.weather-paid.example/v1?q=' . urlencode($town) . '&apikey=' . WX_KEY);
` }],
  ['DATA-008', { 'public/track.php': "<?php\n$pdo->prepare('INSERT INTO clicks (link, at) VALUES (?, NOW())')->execute([$id]);\n",
    'jobs/cleanup.php': "<?php\n$pdo->exec('DELETE FROM password_resets WHERE created < NOW() - INTERVAL 1 DAY');\n" },
  { 'public/track.php': "<?php\n$pdo->prepare('INSERT INTO clicks (link, at) VALUES (?, NOW())')->execute([$id]);\n",
    'jobs/cleanup.php': "<?php\n$pdo->exec('DELETE FROM password_resets WHERE created < NOW() - INTERVAL 1 DAY');\n$pdo->exec('DELETE FROM clicks WHERE at < NOW() - INTERVAL 60 DAY');\n" }],
  ['DATA-009', { 'quote.php': "<?php\n$q = $pdo->prepare('SELECT * FROM quotes WHERE public_token = ?');\n$q->execute([$_GET['t'] ?? '']);\nheader('Content-Type: application/json');\necho json_encode($q->fetch());\n" },
    { 'quote.php': "<?php\n$q = $pdo->prepare('SELECT total, valid_until FROM quotes WHERE public_token = ?');\n$q->execute([$_GET['t'] ?? '']);\nheader('Content-Type: application/json');\necho json_encode($q->fetch());\n" }],
  ['PAY-005', { 'inc/shop.php': "<?php\nfunction process_payment($ev) {\n  $o = order_by_ref($ev['ref']);\n  if (!$o) return null;\n  return settle($o);\n}\n",
    'ipn/listener.php': "<?php\nrequire '../inc/shop.php';\n$ev = read_signed_event();\nprocess_payment($ev);\necho 'ok';\n" },
  { 'inc/shop.php': "<?php\nfunction process_payment($ev) {\n  $o = order_by_ref($ev['ref']);\n  if (!$o) return null;\n  return settle($o);\n}\n",
    'ipn/listener.php': "<?php\nrequire '../inc/shop.php';\n$ev = read_signed_event();\nif (process_payment($ev) === null) { http_response_code(503); exit; }\necho 'ok';\n" }],
  ['REL-002', { 'web/home.html': '<!doctype html><title>x</title>\n', 'web/NOTES-for-launch.md': '# notes\n', 'web/test-mail.php': '<?php mail("x@y.example", "t", "t");\n',
    'scripts/release.py': "import shutil\nshutil.copytree('web', 'out/web')\n" },
  { 'web/home.html': '<!doctype html><title>x</title>\n', 'web/NOTES-for-launch.md': '# notes\n', 'web/test-mail.php': '<?php mail("x@y.example", "t", "t");\n',
    'scripts/release.py': "import shutil\nshutil.copytree('web', 'out/web', ignore=shutil.ignore_patterns('*.md', 'test-*'))\n" }],
  ['REL-003', { 'www/index.html': '<!doctype html><title>x</title><script src="js/menu.js"></script>\n', 'www/js/menu.js': 'void 0;\n',
    'release.js': "const fs = require('fs');\nconst FILES = ['index.html'];\nfor (const n of FILES) fs.copyFileSync('www/' + n, 'zip/' + n);\n" },
  { 'www/index.html': '<!doctype html><title>x</title><script src="js/menu.js"></script>\n', 'www/js/menu.js': 'void 0;\n',
    'release.js': "const fs = require('fs');\nconst FILES = ['index.html', 'js/menu.js'];\nfor (const n of FILES) fs.copyFileSync('www/' + n, 'zip/' + n);\n" }],
  // a page in a second list (not SHIP/FILES/PAGES) is checked too
  ['REL-003', { 'www/index.html': '<!doctype html><title>x</title>\n', 'www/about.html': '<link rel="stylesheet" href="about.css">\n', 'www/about.css': '\n',
    'package-site.js': "const fs = require('fs');\nconst PAGES = ['index.html'];\nconst EXTRA_HTML = ['about.html'];\nfor (const n of [...PAGES, ...EXTRA_HTML]) fs.copyFileSync('www/' + n, 'zip/' + n);\n" },
  { 'www/index.html': '<!doctype html><title>x</title>\n', 'www/about.html': '<link rel="stylesheet" href="about.css">\n', 'www/about.css': '\n',
    'package-site.js': "const fs = require('fs');\nconst PAGES = ['index.html'];\nconst EXTRA_HTML = ['about.html', 'about.css'];\nfor (const n of [...PAGES, ...EXTRA_HTML]) fs.copyFileSync('www/' + n, 'zip/' + n);\n" }],
  ['CLAIM-001', { 'index.php': '<?php ?><p>Uploaded photos are removed within 7 days.</p>\n', 'save.php': "<?php\nmove_uploaded_file($_FILES['p']['tmp_name'], 'photos/' . bin2hex(random_bytes(6)));\n" },
    { 'index.php': '<?php ?><p>Uploaded photos are removed within 7 days.</p>\n', 'save.php': "<?php\nmove_uploaded_file($_FILES['p']['tmp_name'], 'photos/' . bin2hex(random_bytes(6)));\n",
      'nightly.sh': "#!/bin/sh\nfind photos -type f -mtime +7 -delete\n" }],
  ['PRIV-002', { 'js/avatars.js': "img.src = 'https://avatars.facecdn.net/u/' + id + '.png';\n", 'privacy.html': '<p>We keep your account details.</p>\n' },
    { 'js/avatars.js': "img.src = 'https://avatars.facecdn.net/u/' + id + '.png';\n", 'privacy.html': '<p>We keep your account details. Avatars load from facecdn.net, which sees your address.</p>\n' }],
  ['PRIV-003', { 'js/cart.js': "localStorage.setItem('basket', JSON.stringify(items));\n", 'privacy.html': '<p>Nothing is stored on your device.</p>\n' },
    { 'js/cart.js': "localStorage.setItem('basket', JSON.stringify(items));\n", 'privacy.html': '<p>Your basket is kept in this browser (basket) until you check out.</p>\n' }],
  ['PRIV-004', { 'index.html': '<!doctype html><title>x</title>\n', 'privacy.html': '<p>We use Microsoft Clarity to see where visitors get stuck.</p>\n' },
    { 'index.html': '<!doctype html><title>x</title>\n', 'privacy.html': '<p>We do not use any recording tool.</p>\n' }],
  ['PRIV-005', { 'index.html': '<!doctype html><title>x</title><script src="https://cdn.libshost.net/chart.js"></script>\n' },
    { 'index.html': '<!doctype html><title>x</title><script src="https://cdn.libshost.net/chart.js"></script><footer><a href="privacy.html">Privacy</a></footer>\n',
      'privacy.html': '<p>Charts load from libs-host.</p>\n' }],
  ['DATA-010', { 'inc/pets.php': "<?php\nfunction pet_validate(array $p) { if (strlen($p['name'] ?? '') > 60) throw new Exception('name'); return $p; }\n",
    'api/pet-add.php': "<?php\n$p = pet_validate($in);\n$pdo->prepare('INSERT INTO pets (name) VALUES (?)')->execute([$p['name']]);\n",
    'api/pet-import.php': "<?php\nforeach ($csv as $p) $pdo->prepare('INSERT INTO pets (name) VALUES (?)')->execute([$p['name']]);\n" },
  { 'inc/pets.php': "<?php\nfunction pet_validate(array $p) { if (strlen($p['name'] ?? '') > 60) throw new Exception('name'); return $p; }\n",
    'api/pet-add.php': "<?php\n$p = pet_validate($in);\n$pdo->prepare('INSERT INTO pets (name) VALUES (?)')->execute([$p['name']]);\n",
    'api/pet-import.php': "<?php\nforeach ($csv as $p) { $p = pet_validate($p); $pdo->prepare('INSERT INTO pets (name) VALUES (?)')->execute([$p['name']]); }\n" }],
  ['AUTH-015', { 'inc/session.php': "<?php\nfunction signed_in_id() { return (int)($_SESSION['member'] ?? 0) ?: exit; }\n",
    'api/photo-remove.php': "<?php\n$me = signed_in_id();\n$pdo->prepare('UPDATE photos SET hidden = 1 WHERE id = ?')->execute([(int)$_POST['photo']]);\n" },
  { 'inc/session.php': "<?php\nfunction signed_in_id() { return (int)($_SESSION['member'] ?? 0) ?: exit; }\n",
    'api/photo-remove.php': "<?php\n$me = signed_in_id();\n$pdo->prepare('UPDATE photos SET hidden = 1 WHERE id = ? AND owner = ?')->execute([(int)$_POST['photo'], $me]);\n" }],
  ['AUTH-016', { 'inc/gate.php': "<?php\nfunction need_staff_role() { if (empty($_SESSION['is_admin'])) { http_response_code(403); exit; } }\n",
    'manage/users.php': "<?php\nrequire '../inc/gate.php';\nswitch ($_REQUEST['op'] ?? '') {\n  case 'ban_user': ban((int)$_POST['u']); break;\n}\n" },
  { 'inc/gate.php': "<?php\nfunction need_staff_role() { if (empty($_SESSION['is_admin'])) { http_response_code(403); exit; } }\n",
    'manage/users.php': "<?php\nrequire '../inc/gate.php';\nneed_staff_role();\nswitch ($_REQUEST['op'] ?? '') {\n  case 'ban_user': ban((int)$_POST['u']); break;\n}\n" }],
  ['DATA-011', { 'web/estimate.js': 'const TRAVEL_FEE = 40;\n', 'api/bill.py': 'TRAVEL_FEE = 45\n' }, { 'web/estimate.js': 'const TRAVEL_FEE = 45;\n', 'api/bill.py': 'TRAVEL_FEE = 45\n' }],
  ['INJ-019', { 'inc/tidy.php': "<?php\nfunction sanitize_review($r) { $r['author'] = htmlspecialchars($r['author']); return $r; }\n",
    'reviews.php': "<?php\nforeach ($rows as $r) echo '<b>' . $r['author'] . '</b> ' . $r['headline'];\n" },
  { 'inc/tidy.php': "<?php\nfunction sanitize_review($r) { $r['author'] = htmlspecialchars($r['author']); return $r; }\n",
    'reviews.php': "<?php\nforeach ($rows as $r) echo '<b>' . $r['author'] . '</b> ' . htmlspecialchars($r['headline']);\n" }],
  ['DATA-012', { 'api/attach.php': "<?php\nmove_uploaded_file($_FILES['f']['tmp_name'], \"files/$ticket_id/\" . basename($name));\n",
    'api/ticket-close.php': "<?php\n$pdo->prepare('DELETE FROM tickets WHERE id = ?')->execute([$ticket_id]);\n" },
  { 'api/attach.php': "<?php\nmove_uploaded_file($_FILES['f']['tmp_name'], \"files/$ticket_id/\" . basename($name));\n",
    'api/ticket-close.php': "<?php\n$pdo->prepare('DELETE FROM tickets WHERE id = ?')->execute([$ticket_id]);\nremove_dir(\"files/$ticket_id\");\n" }],
  ['DATA-013', { 'inc/pages.php': "<?php\nfile_put_contents(ROOT . '/public/event/' . $e['slug'] . '.html', $html);\n",
    'admin/event-delete.php': "<?php\n$pdo->prepare('DELETE FROM events WHERE id = ?')->execute([$id]);\n" },
  { 'inc/pages.php': "<?php\nfile_put_contents(ROOT . '/public/event/' . $e['slug'] . '.html', $html);\n",
    'admin/event-delete.php': "<?php\n$pdo->prepare('DELETE FROM events WHERE id = ?')->execute([$id]);\n@unlink(ROOT . '/public/event/' . $slug . '.html');\n" }],
  ['PRIV-006', { 'js/notes.js': "localStorage.setItem('notes.draft', d);\nlocalStorage.setItem('notes.theme', t);\nfunction eraseEverything() { localStorage.removeItem('notes.theme'); }\n" },
    { 'js/notes.js': "localStorage.setItem('notes.draft', d);\nlocalStorage.setItem('notes.theme', t);\nconst ALL = ['notes.draft', 'notes.theme'];\nfunction eraseEverything() { ALL.forEach(k => localStorage.removeItem(k)); }\n" }],
  ['PRIV-006', { 'js/store.js': "const KEYS = ['s.cart', 's.seen'];\nlocalStorage.setItem('s.cart', c);\nlocalStorage.setItem('s.seen', n);\nlocalStorage.setItem('s.addr', a);\nfunction wipeAll() { KEYS.forEach(k => localStorage.removeItem(k)); }\n" },
    { 'js/store.js': "const KEYS = ['s.cart', 's.seen', 's.addr'];\nlocalStorage.setItem('s.cart', c);\nlocalStorage.setItem('s.seen', n);\nlocalStorage.setItem('s.addr', a);\nfunction wipeAll() { KEYS.forEach(k => localStorage.removeItem(k)); }\n" }],
  ['ROUTE-001', { 'public/js/orders.js': "fetch('/api/orders/refund', { method: 'POST' });\n", 'server/app.js': "const express = require('express');\napp.get('/api/orders', list);\napp.post('/api/orders', create);\n" },
    { 'public/js/orders.js': "fetch('/api/orders/refund', { method: 'POST' });\n", 'server/app.js': "const express = require('express');\napp.get('/api/orders', list);\napp.post('/api/orders', create);\napp.post('/api/orders/refund', refund);\n" }],
  ['FEAT-001', { 'public/settings.js': 'window.flags = { invoices: false };\n', 'api/invoices.php': "<?php\n$me = current_user();\necho json_encode(all_invoices($me));\n" },
    { 'public/settings.js': 'window.flags = { invoices: false };\n', 'api/invoices.php': "<?php\n$me = current_user();\nif (!feature_enabled('invoices')) { http_response_code(404); exit; }\necho json_encode(all_invoices($me));\n" }],
  ['INST-001', { 'README.md': '# Setup\nRuns on PHP 8.0 or newer.\n', 'src/check.php': "<?php\nif (!json_validate($raw)) exit;\n" },
    { 'README.md': '# Setup\nRuns on PHP 8.3 or newer.\n', 'src/check.php': "<?php\nif (!json_validate($raw)) exit;\n" }],
  ['HTA-004', { 'htdocs/.htaccess': 'Options -Indexes\n', 'cron/export.php': "<?php\nfile_put_contents(__DIR__ . '/../htdocs/orders-' . date('W') . '.csv', $csv);\n" },
    { 'htdocs/.htaccess': '<FilesMatch "\\.(csv|sql)$">\n  Require all denied\n</FilesMatch>\n', 'cron/export.php': "<?php\nfile_put_contents(__DIR__ . '/../htdocs/orders-' . date('W') . '.csv', $csv);\n" }],
  ['CSP-001', { 'site/.htaccess': 'Header set Content-Security-Policy "default-src \'self\'; script-src \'self\'"\n', 'site/index.html': '<!doctype html><title>x</title><script src="https://widgets.chat-box.example/w.js"></script>\n' },
    { 'site/.htaccess': 'Header set Content-Security-Policy "default-src \'self\'; script-src \'self\' https://widgets.chat-box.example"\n', 'site/index.html': '<!doctype html><title>x</title><script src="https://widgets.chat-box.example/w.js"></script>\n' }],
  ['CACHE-001', { '.htaccess': 'ExpiresActive On\nExpiresByType text/css "access plus 1 year"\n', 'index.php': '<?php ?><link rel="stylesheet" href="/css/site.css">\n' },
    { '.htaccess': 'ExpiresActive On\nExpiresByType text/css "access plus 1 year"\n', 'index.php': '<?php ?><link rel="stylesheet" href="/css/site.css?v=2.1.0">\n' }],
  ['TEST-001', { 'tests/smoke.py': "print('skip: no browser on this machine')\n" }, { 'tests/smoke.py': "from app import total\nassert total([2, 3]) == 5\n" }],
];

// Shapes that were flagged on real projects and are not faults (made-up names). [rule, files]
const QUIET = [
  // ABUSE-001: a library function that inserts (the page that calls it holds the guard)
  ['ABUSE-001', { 'lib/crm.php': "<?php\nfunction crm_add_note($cid, $text) {\n  $pdo = db();\n  $pdo->prepare('INSERT INTO notes (cid, body) VALUES (?, ?)')->execute([$cid, $text]);\n}\nif (isset($_POST['x'])) {}\n" }],
  // CSP-001: a meta policy on one page, the form on another
  ['CSP-001', { 'a.html': '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; form-action \'none\'">\n', 'b.html': '<form method="post" action="/send.php"><button>Go</button></form>\n' }],
  // CSP-001: a page that only talks about a policy (help text) does not send it
  ['CSP-001', { 'help.html': '<p>Our server sends Content-Security-Policy: default-src \'self\'; form-action \'none\' on the API.</p>\n<form method="post" action="/ask.php"><button>Ask</button></form>\n' }],
  // CSP-001: a policy inside <Files "404.html"> only covers that page
  ['CSP-001', { '.htaccess': '<Files "404.html">\n  Header always set Content-Security-Policy "default-src \'self\'; form-action \'none\'"\n</Files>\n', 'contact.php': '<form method="post"><button>Send</button></form>\n' }],
  // CSP-001: the page's script sends the form itself
  ['CSP-001', { 'contact.html': '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; form-action \'none\'">\n<form id="f"><button>Send</button></form>\n<script>f.addEventListener("submit", e => { e.preventDefault(); send(); });</script>\n' }],
  // CSP-001: a policy quoted in a comment or a report file is not sent
  ['CSP-001', { 'js/notes.js': "/*\n   the site sends Content-Security-Policy: default-src 'none' on the API\n*/\n", 'index.html': '<script src="https://cdn.other-host.example/x.js"></script>\n' }],
  // CSP-001: a policy set by a server file covers that file only (which pages it serves is not readable)
  ['CSP-001', { 'serve.js': "const H = { 'Content-Security-Policy': \"default-src 'self'\" };\n", 'demo/shop/index.html': '<script src="https://cdn.other-host.example/x.js"></script>\n' }],
  // DATA-010: a one-field check (status) and a one-column update do not need the record's validator
  ['DATA-010', { 'lib/c.php': "<?php\nfunction crm_client_status_valid($s) { return in_array($s, ['a', 'b']); }\n",
    'admin/a.php': "<?php\nif (crm_client_status_valid($s)) $pdo->prepare('INSERT INTO client (status) VALUES (?)')->execute([$s]);\n",
    'lib/unsub.php': "<?php\n$pdo->prepare('UPDATE client SET unsubscribed_at = ? WHERE id = ?')->execute([$now, $id]);\n",
    'lib/demo.php': "<?php\n$pdo->prepare('INSERT INTO client (status) VALUES (?)')->execute(['lead']);\n" }],
  // TEST-001: a PHP suite with its own pass/fail counter that prints SKIP for one part
  ['TEST-001', { 'tests/mail.php': "<?php\n$fail = 0;\nif (!function_exists('curl_init')) {\n  echo \"  SKIP: no curl here\\n\";\n}\nexit($fail === 0 ? 0 : 1);\n" }],
  // AUTH-016: a mail app's own "delete" of the person's own messages is not an admin action
  ['AUTH-016', { 'lib/gate.php': "<?php\nfunction need_admin() { if (($_SESSION['role'] ?? '') !== 'admin') { http_response_code(403); exit; } }\n",
    'api/mailbox.php': "<?php\nrequire_login();\nswitch ($op) {\n  case 'delete': mailbox_delete($uid, $msg); break;\n}\n" }],
  // PAY-005: a refusal call followed by exit is not the handler
  ['PAY-005', { 'lib/rate.php': "<?php\nfunction rate_refuse($s) { if (!$s) return; header('Retry-After: ' . $s); }\n",
    'api/paypal-webhook.php': "<?php\nif (too_many()) {\n  rate_refuse(30);\n  exit('slow down');\n}\nhttp_response_code(200);\n" }],
  // PAY-005: a bare call to a log function that can return false is not the handler
  ['PAY-005', { 'lib/log.php': "<?php\nfunction log_event($e) { if (!$e) return false; return file_put_contents('log', json_encode($e), FILE_APPEND); }\n",
    'webhooks/stripe.php': "<?php\n$e = verified_event();\nlog_event($e);\nif (!fulfil_order($e)) { http_response_code(500); exit; }\nhttp_response_code(200);\n" }],
  // PRIV-004: the page says the site does NOT use the service
  ['PRIV-004', { 'privacy.html': '<li>No advertising trackers: no Facebook pixel, no ad networks.</li>\n', 'index.html': '<!doctype html><title>x</title>\n' }],
  // PRIV-006: a function that resets one part on purpose; a wipe over a key list constant; a wipe over a scan
  ['PRIV-006', { 'js/usage.js': "localStorage.setItem('u.days', d);\nlocalStorage.setItem('u.theme', t);\nexport const resetAllUsageData = () => { localStorage.removeItem('u.days'); };\n" }],
  ['PRIV-006', { 'js/data.js': "const KEYS = ['a.one', 'a.two'];\nlocalStorage.setItem('a.one', 1);\nlocalStorage.setItem('a.two', 2);\nfunction wipeAll() { KEYS.forEach(k => { localStorage.removeItem(k); }); }\n" }],
  ['PRIV-006', { 'js/clear.js': "localStorage.setItem('pd_a', 1);\nlocalStorage.setItem('pd_b', 2);\nfunction ours() { var keys = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^pd_/.test(k)) keys.push(k); } return keys; }\nfunction clearAll() { var keys = ours(); keys.forEach(function (k) { localStorage.removeItem(k); }); }\nvar k = 'pd_a';\n" }],
  // REL-003: a second fixed list, a folder copied by a loop, a file named in an inline list
  ['REL-003', { 'src/index.html': '<link rel="stylesheet" href="fonts/f.css"><link rel="stylesheet" href="extra.css"><link rel="stylesheet" href="theme/t.css">\n', 'src/fonts/f.css': '\n', 'src/extra.css': '\n', 'src/theme/t.css': '\n',
    'build-deploy.py': "import os, shutil\nPAGES = ['index.html']\nCSS = ['theme/t.css']\nfor n in PAGES + ['extra.css']:\n    shutil.copy(os.path.join('src', n), 'out')\nfor n in os.listdir(os.path.join('src', 'fonts')):\n    pass\n" }],
  // ROUTE-001: Next.js file routes
  ['ROUTE-001', { 'app/page.tsx': "export default function P() { useEffect(() => { fetch('/api/library'); }, []); return null; }\n", 'app/api/library/route.ts': 'export async function GET() { return Response.json({}); }\n',
    'app/api/chat/route.ts': 'export async function POST() { return Response.json({}); }\n', 'public/triage.html': "<script>fetch('/api/chat', { method: 'POST' });</script>\n",
    'lib/health.ts': "export const HEALTH = ['/api/health', '/api/version'];\n" }],
  // CACHE-001: HSTS's max-age is not a cache time; immutable only for named vendor files
  ['CACHE-001', { 'public/.htaccess': '<FilesMatch "\\.(css|js)$">\n  Header always set Strict-Transport-Security "max-age=15552000"\n</FilesMatch>\n', 'public/index.html': '<link rel="stylesheet" href="/site.css">\n' }],
  ['CACHE-001', { 'v2/.htaccess': '<FilesMatch "^(three\\.module|jspdf\\.umd\\.min)\\.js$">\n  Header set Cache-Control "public, max-age=2592000, immutable"\n</FilesMatch>\n', 'v2/install.php': '<?php ?><link rel="stylesheet" href="install.css"><script src="app.js"></script>\n' }],
  // PRIV-005: a server's own fetch to an outside service is not a visitor load
  ['PRIV-005', { 'index.html': '<!doctype html><title>x</title>\n', 'server/live.mjs': "import fs from 'fs';\nconst r = await fetch('https://quotes.marketfeed.net/v1');\n" }],
  // ABUSE-001: a limiter written out in the page (counter per address, then 429) plus a cap call for everyone
  ['ABUSE-001', { 'inc/throttle.php': LIMITER, 'public/ask.php': "<?php\nrequire '../inc/throttle.php';\n$ip = $_SERVER['REMOTE_ADDR'];\nif (hits_for($ip) > 5) { http_response_code(429); exit; }\nif (!throttle_pass('ask', 'everyone', 300, 86400)) exit;\n$q = $_POST['q'] ?? '';\nmail(OWNER, 'Question', $q);\n" }],
  // ABUSE-001: two limiter calls inside one if (the second must be read too)
  ['ABUSE-001', { 'inc/throttle.php': LIMITER, 'public/join.php': "<?php\nrequire '../inc/throttle.php';\nif (!throttle_pass('j', $_SERVER['REMOTE_ADDR'], 3, 600) || !throttle_pass('j', 'all', 100, 86400)) exit('Please wait a while.');\n$pdo->prepare('INSERT INTO members (n) VALUES (?)')->execute([$_POST['n'] ?? '']);\n" }],
  // DATA-010: a one-column update next to a whole-record validator
  ['DATA-010', { 'inc/pets.php': "<?php\nfunction pet_validate(array $p) { return $p; }\n",
    'api/pet-add.php': "<?php\n$p = pet_validate($in);\n$pdo->prepare('INSERT INTO pets (name) VALUES (?)')->execute([$p['name']]);\n",
    'api/pet-edit.php': "<?php\n$p = pet_validate($in);\n$pdo->prepare('INSERT INTO pets (name) VALUES (?)')->execute([$p['name']]);\n",
    'api/pet-seen.php': "<?php\n$pdo->prepare('UPDATE pets SET seen_at = NOW() WHERE id = ?')->execute([$id]);\n" }],
  // PAY-005: a handler-named call followed straight by exit is a refusal path, not the answer
  ['PAY-005', { 'lib/h.php': "<?php\nfunction handle_rejected($e) { if (!$e) return false; return log_it($e); }\n",
    'webhook.php': "<?php\nif (!sig_ok()) {\n  handle_rejected($raw);\n  exit;\n}\nif (!apply_event($e)) { http_response_code(500); exit; }\nhttp_response_code(200);\n" }],
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cross-'));
  // Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
  const write = (dir, files) => { for (const [rel, text] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } };
  const scan = async (name, files) => { const d = path.join(tmp, name); write(d, files); return (await runAudit(d, null, { root: false })).findings; };
  const where = fs_ => fs_.map(f => f.rule + ' ' + f.where).join(', ') || 'nothing';
  for (const [n, [id, bad, good]] of PAIRS.entries()) {
    const loud = await scan('loud' + n, bad), quiet = await scan('quiet' + n, good);
    check(id + ' fires', () => assert(loud.some(f => f.rule === id), 'not found; got ' + where(loud)));
    check(id + ' stays quiet on the fixed copy', () => assert(!quiet.some(f => f.rule === id), 'flagged ' + where(quiet.filter(f => f.rule === id))));
  }
  for (const [n, [id, files]] of QUIET.entries()) {
    const found = await scan('q' + n, files);
    check(id + ' stays quiet (a shape it once flagged on a real project, #' + n + ')', () => assert(!found.some(f => f.rule === id), 'flagged ' + where(found.filter(f => f.rule === id))));
  }
  check('every cross-file rule has a pair', () => {
    const have = new Set(PAIRS.map(p => p[0]));
    const missing = CROSS_RULES.map(r => r.id).filter(id => !have.has(id));
    assert(!missing.length, 'no pair for ' + missing.join(', '));
  });
  check('cross-file rule ids are unique and not used by a one-file rule', () => {
    const { RULES } = require('../../src/bridge/audit');
    const ids = CROSS_RULES.map(r => r.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const one = new Set(RULES.map(r => r.id));
    assert(!ids.some(id => one.has(id)), ids.filter(id => one.has(id)).join(','));
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main();
