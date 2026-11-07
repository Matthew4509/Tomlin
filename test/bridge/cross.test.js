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
  ['API-001', { 'src/app/api/profiles/[id]/route.js': "import { db } from '@/db';\nexport async function PATCH(req, { params }) {\n  await db.profile.update({ where: { id: params.id }, data: await req.json() });\n  return Response.json({ ok: true });\n}\n" },
    { 'src/app/api/profiles/[id]/route.js': "import { db } from '@/db';\nimport { currentUser } from '@clerk/nextjs/server';\nexport async function PATCH(req, { params }) {\n  const me = await currentUser();\n  if (!me) return new Response('Please sign in first.', { status: 401 });\n  await db.profile.update({ where: { id: me.id }, data: await req.json() });\n  return Response.json({ ok: true });\n}\n" }],
  // a helper in the project, whose name says nothing, does the check
  ['API-001', { 'lib/me.js': "export function whoIsIt() { return null; }\n", 'pages/api/invoices/index.js': "import { whoIsIt } from '../../../../src/bridge/me';\nexport default async function handler(req, res) {\n  whoIsIt();\n  res.json(await Invoice.find({}));\n}\n" },
    { 'lib/me.js': "export function whoIsIt(req, res) { if (!req.cookies.sid) res.status(401).end(); }\n", 'pages/api/invoices/index.js': "import { whoIsIt } from '../../../../src/bridge/me';\nexport default async function handler(req, res) {\n  whoIsIt(req, res);\n  res.json(await Invoice.find({}));\n}\n" }],
  // a router in its own file: the check is where it is mounted
  ['API-001', { 'routes/accounts.js': "const router = require('express').Router();\nrouter.put('/accounts/:id', async (req, res) => {\n  await Account.findByIdAndUpdate(req.params.id, req.body);\n  res.json({ ok: true });\n});\nmodule.exports = router;\n", 'server.js': "const express = require('express');\nconst app = express();\napp.use('/auth', require('./routes/auth-pages'));\napp.use('/api', require('./routes/accounts'));\n" },
    { 'routes/accounts.js': "const router = require('express').Router();\nrouter.put('/accounts/:id', async (req, res) => {\n  await Account.findByIdAndUpdate(req.params.id, req.body);\n  res.json({ ok: true });\n});\nmodule.exports = router;\n", 'server.js': "const express = require('express');\nconst app = express();\napp.use('/api', verifyToken, require('./routes/accounts'));\n" }],
  // Clerk's middleware with no rule in it signs people in but protects nothing
  ['API-001', { 'app/api/orders/route.ts': "export async function POST() {\n  await prisma.order.deleteMany();\n  return Response.json({});\n}\n", 'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server';\nexport default clerkMiddleware();\nexport const config = { matcher: ['/((?!_next).*)', '/(api|trpc)(.*)'] };\n" },
    { 'app/api/orders/route.ts': "export async function POST() {\n  await prisma.order.deleteMany();\n  return Response.json({});\n}\n", 'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server';\nexport default clerkMiddleware(async (auth) => { await auth.protect(); });\nexport const config = { matcher: ['/((?!_next).*)', '/(api|trpc)(.*)'] };\n" }],
  // a table named in a query builder (Drizzle) is read as well as one in quotes
  ['API-001', { 'app/api/people/route.ts': "export async function GET() { return Response.json(await db.select().from(users)); }\n" },
    { 'app/api/people/route.ts': "export async function GET() { const s = await auth(); if (!s) return new Response(null, { status: 401 }); return Response.json(await db.select().from(users)); }\n" }],
  ['API-002', { 'pages/api/gadgets.ts': "export default async function handler(req, res) {\n  res.json(await db.query('SELECT * FROM gadgets'));\n}\n" },
    { 'pages/api/gadgets.ts': "import { withIronSessionApiRoute } from 'iron-session/next';\nexport default withIronSessionApiRoute(async function route(req, res) {\n  if (!req.session.user) return res.status(401).end();\n  res.json(await db.query('SELECT * FROM gadgets WHERE owner = $1', [req.session.user.id]));\n}, options);\n" }],
  ['DEBUG-002', { 'app/admin/reset/route.js': "export async function POST() {\n  await db.user.deleteMany();\n  return Response.json({});\n}\n" },
    { 'app/admin/reset/route.js': "export async function POST(req) {\n  if (req.headers.get('x-reset-key') !== process.env.RESET_KEY) return new Response('Not allowed.', { status: 403 });\n  await db.user.deleteMany();\n  return Response.json({});\n}\n" }],
  ['DEBUG-002', { 'api.js': "const express = require('express');\nconst app = express();\napp.get('/api/test-mail', async (req, res) => {\n  await sendMail(req.query.to, 'hello');\n  res.end();\n});\n" },
    { 'api.js': "const express = require('express');\nconst app = express();\nif (process.env.NODE_ENV !== 'production') {\n  app.get('/api/test-mail', async (req, res) => {\n    await sendMail(req.query.to, 'hello');\n    res.end();\n  });\n}\n" }],
  ['PAY-007', { 'webhooks/paddle.php': "<?php\n$event = json_decode(file_get_contents('php://input'), true);\nif ($event['event_type'] === 'transaction.completed') grant($event);\n" },
    { 'webhooks/paddle.php': "<?php\n$raw = file_get_contents('php://input');\nif (!hash_equals(hash_hmac('sha256', $raw, PADDLE_KEY), $_SERVER['HTTP_PADDLE_SIGNATURE'] ?? '')) { http_response_code(400); exit; }\n$event = json_decode($raw, true);\ngrant($event);\n" }],
  // setting up sessions, or mounting a router named for sign-in, checks nobody
  ['API-001', { 'srv.js': "const express = require('express');\nconst session = require('express-session');\nconst app = express();\napp.use(session({ secret: s }));\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\n" },
    { 'srv.js': "const express = require('express');\nconst session = require('express-session');\nconst app = express();\napp.use(session({ secret: s }));\napp.use(requireLogin);\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(authRoutes);\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(authMiddleware);\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\napp.use(authController);\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/customers', requireLogin, async (req, res) => res.json(await Customer.find({})));\napp.use(authController);\n" }],
  // a server action is a public address like any route
  ['API-001', { 'app/actions.ts': "'use server';\nimport { prisma } from '@/lib/db';\nexport async function deleteOrder(id) {\n  await prisma.order.delete({ where: { id } });\n}\n" },
    { 'app/actions.ts': "'use server';\nimport { prisma } from '@/lib/db';\nimport { auth } from '@/auth';\nexport async function deleteOrder(id) {\n  const s = await auth();\n  if (!s) throw new Error('Please sign in first.');\n  await prisma.order.deleteMany({ where: { id, userId: s.user.id } });\n}\n" }],
  // one action of two has the check: the other is still open
  ['API-001', { 'lib/actions.js': "'use server';\nexport async function renameOrder(id, n) {\n  const s = await getServerSession();\n  await prisma.order.update({ where: { id, userId: s.user.id }, data: { n } });\n}\nexport const dropOrder = async id => {\n  await prisma.order.delete({ where: { id } });\n};\n" },
    { 'lib/actions.js': "'use server';\nexport async function renameOrder(id, n) {\n  const s = await getServerSession();\n  await prisma.order.update({ where: { id, userId: s.user.id }, data: { n } });\n}\nexport const dropOrder = async id => {\n  const s = await getServerSession();\n  await prisma.order.deleteMany({ where: { id, userId: s.user.id } });\n};\n" }],
  // the name of an action is not a check
  ['API-001', { 'app/users/actions.ts': "'use server';\nexport async function getUser(id) {\n  return prisma.user.findUnique({ where: { id } });\n}\n" },
    { 'app/users/actions.ts': "'use server';\nexport async function getUser(id) {\n  const s = await auth();\n  return prisma.user.findUnique({ where: { id: s.user.id } });\n}\n" }],
  // a list on the same route as a sign-up is not a sign-up
  ['API-001', { 'app/api/users/route.ts': "import bcrypt from 'bcryptjs';\nexport async function GET() { return Response.json(await prisma.user.findMany()); }\nexport async function POST(req) {\n  const { email, password } = await req.json();\n  const hash = await bcrypt.hash(password, 10);\n  await prisma.user.create({ data: { email, hash } });\n  return Response.json({});\n}\n" },
    { 'app/api/users/route.ts': "import bcrypt from 'bcryptjs';\nexport async function POST(req) {\n  const { email, password } = await req.json();\n  const hash = await bcrypt.hash(password, 10);\n  await prisma.user.create({ data: { email, hash } });\n  return Response.json({});\n}\n" }],
  // creating a user with no password is not a sign-up
  ['API-001', { 'pages/api/members.ts': "export default async function handler(req, res) { res.json(await prisma.member.create({ data: req.body })); }\n" },
    { 'pages/api/members.ts': "export default async function handler(req, res) { const hash = await argon2.hash(req.body.password); res.json(await prisma.member.create({ data: { email: req.body.email, hash } })); }\n" }],
  // PAY-007: Flask, and a webhook that only reads the signature header
  ['PAY-007', { 'pay.py': "import stripe\n@app.route('/webhook', methods=['POST'])\ndef hook():\n    event = request.get_json()\n    fulfil(event)\n    return '', 200\n" },
    { 'pay.py': "import stripe\n@app.route('/webhook', methods=['POST'])\ndef hook():\n    event = stripe.Webhook.construct_event(request.data, request.headers['Stripe-Signature'], SECRET)\n    fulfil(event)\n    return '', 200\n" }],
  ['PAY-007', { 'app/api/stripe/webhook/route.ts': "export async function POST(req) {\n  const sig = req.headers.get('stripe-signature');\n  if (!sig) return new Response('No signature.', { status: 400 });\n  const event = await req.json();\n  await fulfil(event);\n  return Response.json({});\n}\n" },
    { 'app/api/stripe/webhook/route.ts': "import { billing } from '@/services/billing';\nexport async function POST(req) {\n  const sig = req.headers.get('stripe-signature');\n  const event = billing.parse(await req.text(), sig);\n  await fulfil(event);\n  return Response.json({});\n}\n" }],
  // one protected mount does not protect the router mounted beside it
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst notesRouter = require('./routes/notes');\nconst usersRouter = require('./routes/users');\napp.use('/api/notes', protect, notesRouter);\napp.use('/api/users', usersRouter);\n",
    'routes/notes.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await Note.find()));\nmodule.exports = router;\n",
    'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nrouter.delete('/:id', async (req, res) => { await User.findByIdAndDelete(req.params.id); res.end(); });\nmodule.exports = router;\n" },
  { 'server.js': "const express = require('express');\nconst app = express();\nconst notesRouter = require('./routes/notes');\nconst usersRouter = require('./routes/users');\napp.use('/api/notes', protect, notesRouter);\napp.use('/api/users', protect, usersRouter);\n",
    'routes/notes.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await Note.find()));\nmodule.exports = router;\n",
    'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nrouter.delete('/:id', async (req, res) => { await User.findByIdAndDelete(req.params.id); res.end(); });\nmodule.exports = router;\n" }],
  // a guard set after the mount does not cover it; another router's own guard does not either
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst usersRouter = require('./routes/users');\napp.use('/api/users', usersRouter);\napp.use(requireLogin);\n",
    'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" },
  { 'server.js': "const express = require('express');\nconst app = express();\nconst usersRouter = require('./routes/users');\napp.use(requireLogin);\napp.use('/api/users', usersRouter);\n",
    'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst a = require('./routes/notes');\nconst b = require('./routes/users');\napp.use('/api/notes', a);\napp.use('/api/users', b);\n",
    'routes/notes.js': "const router = require('express').Router();\nrouter.use(protect);\nrouter.get('/', async (req, res) => res.json(await Note.find()));\nmodule.exports = router;\n",
    'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" },
  { 'server.js': "const express = require('express');\nconst app = express();\nconst a = require('./routes/notes');\nconst b = require('./routes/users');\napp.use('/api/notes', a);\napp.use('/api/users', b);\n",
    'routes/notes.js': "const router = require('express').Router();\nrouter.use(protect);\nrouter.get('/', async (req, res) => res.json(await Note.find()));\nmodule.exports = router;\n",
    'routes/users.js': "const router = require('express').Router();\nrouter.use(protect);\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  // Fastify's hook is its .use: it needs an auth-like name
  ['API-001', { 'srv.js': "const fastify = require('fastify');\nconst app = fastify();\napp.addHook('onRequest', logRequest);\napp.get('/customers', async () => Customer.find({}));\n" },
    { 'srv.js': "const fastify = require('fastify');\nconst app = fastify();\napp.addHook('onRequest', app.authenticate);\napp.get('/customers', async () => Customer.find({}));\n" }],
  // PAY-007: Nuxt reads the event with readBody
  ['PAY-007', { 'server/api/webhooks/stripe.post.ts': "export default defineEventHandler(async (event) => {\n  const body = await readBody(event);\n  await fulfil(body);\n  return { received: true };\n});\n" },
    { 'server/api/webhooks/stripe.post.ts': "export default defineEventHandler(async (event) => {\n  const raw = await readRawBody(event);\n  const body = stripe.webhooks.construct" + "Event(raw, getHeader(event, 'stripe-signature'), key);\n  await fulfil(body);\n  return { received: true };\n});\n" }],
  // SvelteKit and Nuxt routes
  ['API-001', { 'src/routes/api/orders/+server.ts': "export async function DELETE({ request }) {\n  await prisma.order.deleteMany();\n  return new Response(null);\n}\n" },
    { 'src/routes/api/orders/+server.ts': "export async function DELETE({ request, locals }) {\n  if (!locals.user) throw error(401, 'Please sign in first.');\n  await prisma.order.deleteMany({ where: { userId: locals.user.id } });\n  return new Response(null);\n}\n" }],
  ['API-001', { 'src/routes/api/orders/+server.ts': "export async function DELETE() {\n  await prisma.order.deleteMany();\n  return new Response(null);\n}\n", 'src/hooks.server.ts': "export const handle = async ({ event, resolve }) => {\n  event.locals.user = await readUser(event.cookies);\n  return resolve(event);\n};\n" },
    { 'src/routes/api/orders/+server.ts': "export async function DELETE() {\n  await prisma.order.deleteMany();\n  return new Response(null);\n}\n", 'src/hooks.server.ts': "export const handle = async ({ event, resolve }) => {\n  event.locals.user = await readUser(event.cookies);\n  if (!event.locals.user) throw error(401, 'Please sign in first.');\n  return resolve(event);\n};\n" }],
  ['API-001', { 'src/routes/api/orders/+server.ts': "export async function DELETE() {\n  await prisma.order.deleteMany();\n  return new Response(null);\n}\n", 'src/hooks.server.ts': "export const handle = async ({ event, resolve }) => {\n  if (event.url.pathname.startsWith('/dashboard') && !event.locals.user) throw redirect(303, '/login');\n  return resolve(event);\n};\n" },
    { 'src/routes/api/orders/+server.ts': "export async function DELETE() {\n  await prisma.order.deleteMany();\n  return new Response(null);\n}\n", 'src/hooks.server.ts': "export const handle = async ({ event, resolve }) => {\n  if (event.url.pathname.startsWith('/api') && !event.locals.user) throw error(401, 'Please sign in first.');\n  return resolve(event);\n};\n" }],
  ['API-001', { 'server/api/orders/[id].delete.ts': "export default defineEventHandler(async (event) => {\n  await prisma.order.delete({ where: { id: getRouterParam(event, 'id') } });\n  return { ok: true };\n});\n" },
    { 'server/api/orders/[id].delete.ts': "export default defineEventHandler(async (event) => {\n  await requireUserSession(event);\n  await prisma.order.delete({ where: { id: getRouterParam(event, 'id') } });\n  return { ok: true };\n});\n" }],
  ['API-001', { 'server/api/orders.get.ts': "export default defineEventHandler(async () => prisma.order.findMany());\n" },
    { 'server/api/orders.get.ts': "export default defineEventHandler(async () => prisma.order.findMany());\n", 'server/middleware/auth.ts': "export default defineEventHandler(async (event) => {\n  if (!event.context.user) throw createError({ statusCode: 401, message: 'Please sign in first.' });\n});\n" }],
  ['API-002', { 'src/routes/api/gadgets/+server.js': "export async function GET() { return json(await prisma.gadget.findMany()); }\n" },
    { 'src/routes/api/gadgets/+server.js': "export async function GET({ locals }) { const s = await locals.getSession(); if (!s) throw error(401, 'Please sign in first.'); return json(await prisma.gadget.findMany()); }\n" }],
  ['DEBUG-002', { 'src/routes/api/seed/+server.ts': "export async function GET() { await prisma.user.deleteMany(); return new Response('ok'); }\n" },
    { 'src/routes/api/seed/+server.ts': "export async function GET() { if (process.env.NODE_ENV === 'production') return new Response(null, { status: 404 }); await prisma.user.deleteMany(); return new Response('ok'); }\n" }],
  // DEBUG-002: a leftover that sends mail is still one
  ['DEBUG-002', { 'app/api/test-email/route.ts': "export async function GET() { await sendMail('a@b.test', 'hello'); return Response.json({}); }\n" },
    { 'app/api/test-email/route.ts': "export async function GET() { if (process.env.NODE_ENV === 'production') return new Response(null, { status: 404 }); await sendMail('a@b.test', 'hello'); return Response.json({}); }\n" }],
  // RLS-001: Drizzle's folder; another database's migrations next to Supabase used for sign-in only
  ['RLS-001', { 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(u, k);\n", 'drizzle/0000_first.sql': 'CREATE TABLE "notes" ("id" serial PRIMARY KEY);\n' },
    { 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(u, k);\n", 'drizzle/0000_first.sql': 'CREATE TABLE "notes" ("id" serial PRIMARY KEY);\nALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;\n' }],
  ['RLS-001', { 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(u, k);\nexport const load = () => sb.from('notes').select('*');\nexport const me = () => sb.auth.getUser();\n", 'db/migrations/001_init.sql': 'create table notes (id int);\n' },
    { 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(u, k);\nexport const me = () => sb.auth.getUser();\n", 'db/migrations/001_init.sql': 'create table notes (id int);\n' }],
  // RLS-001: database.sql in the project root
  ['RLS-001', { 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const db = createClient(u, k);\n", 'database.sql': 'create table notes (id int);\n' },
    { 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const db = createClient(u, k);\n", 'database.sql': 'create table notes (id int);\nalter table notes enable row level security;\n' }],
  // every route of a file is read: an open GET on a table of no one's does not hide the open DELETE after it
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));\napp.delete('/api/todos/:id', async (req, res) => {\n  await prisma.todo.delete({ where: { id: req.params.id } });\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));\napp.delete('/api/todos/:id', requireUser, async (req, res) => {\n  await prisma.todo.delete({ where: { id: req.params.id } });\n  res.end();\n});\n" }],
  // Clerk: the matcher says where the middleware runs; createRouteMatcher's list says what it protects
  ['API-001', { 'app/api/users/route.ts': "export async function GET() { return Response.json(await prisma.user.findMany()); }\nexport async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n",
    'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isProtectedRoute = createRouteMatcher(['/dashboard(.*)']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (isProtectedRoute(req)) await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" },
  { 'app/api/users/route.ts': "export async function GET() { return Response.json(await prisma.user.findMany()); }\nexport async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n",
    'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/api/users(.*)']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (isProtectedRoute(req)) await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n",
    'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/api/users(.*)']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (!isPublicRoute(req)) await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" },
  { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n",
    'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (!isPublicRoute(req)) await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n",
    'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server';\nexport default clerkMiddleware(async (auth, req) => {\n  console.log(req.url);\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" },
  { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n",
    'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server';\nexport default clerkMiddleware(async (auth, req) => {\n  await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  // a path of Hono's with a star takes in everything under it, and nothing beside it
  ['API-001', { 'srv.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.use('/admin/*', jwt({ secret }));\napp.post('/api/todos', async (c) => {\n  await db.insert(todos).values(await c.req.json());\n  return c.json({});\n});\n" },
    { 'srv.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.use('/api/*', jwt({ secret }));\napp.post('/api/todos', async (c) => {\n  await db.insert(todos).values(await c.req.json());\n  return c.json({});\n});\n" }],
  // a project's own function on the .use line is read: it refuses, or it does not
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\nfunction logCalls(req, res, next) { console.log(req.url); next(); }\napp.use('/api', logCalls);\napp.post('/api/todos', async (req, res) => {\n  await prisma.todo.create({ data: req.body });\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\nfunction checkCaller(req, res, next) {\n  if (req.get('x-caller-key') !== process.env.CALLER_KEY) return res.status(401).end();\n  next();\n}\napp.use('/api', checkCaller);\napp.post('/api/todos', async (req, res) => {\n  await prisma.todo.create({ data: req.body });\n  res.end();\n});\n" }],
  // a router named for what it holds is a mount, not a check; one standing behind isAdmin has a check
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst admin = require('./routes/admin');\napp.use('/api/admin', admin);\n", 'routes/admin.js': "const router = require('express').Router();\nrouter.delete('/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\nmodule.exports = router;\n" },
    { 'server.js': "const express = require('express');\nconst app = express();\nconst admin = require('./routes/admin');\napp.use('/api/admin', isAdmin, admin);\n", 'routes/admin.js': "const router = require('express').Router();\nrouter.delete('/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\nmodule.exports = router;\n" }],
  // an inline server action inside a page answers anyone who posts to that page
  ['API-001', { 'app/people/page.tsx': "export default function Page() {\n  async function wipe() {\n    'use server';\n    await prisma.user.deleteMany();\n  }\n  return <form action={wipe}><button>Wipe</button></form>;\n}\n" },
    { 'app/people/page.tsx': "export default async function Page() {\n  async function wipe() {\n    'use server';\n    const s = await auth();\n    if (!s) return;\n    await prisma.user.deleteMany();\n  }\n  return <form action={wipe}><button>Wipe</button></form>;\n}\n" }],
  // NextAuth's auth, handed over as the middleware with no authorized callback, turns no one away
  ['API-001', { 'auth.ts': "import NextAuth from 'next-auth';\nexport const { handlers, auth } = NextAuth({ providers: [] });\n", 'middleware.ts': "export { auth as middleware } from '@/auth';\n",
    'app/api/notes/route.ts': "export async function DELETE() { await prisma.note.deleteMany(); return Response.json({}); }\n" },
  { 'auth.ts': "import NextAuth from 'next-auth';\nexport const { handlers, auth } = NextAuth({ providers: [], callbacks: { authorized({ auth }) { return !!auth; } } });\n", 'middleware.ts': "export { auth as middleware } from '@/auth';\n",
    'app/api/notes/route.ts': "export async function DELETE() { await prisma.note.deleteMany(); return Response.json({}); }\n" }],
  // FIRE-001: Firebase's test-mode rules, in each of its three rule files
  ['FIRE-001', { 'src/fb.js': "import { initializeApp } from 'firebase/app';\nexport const app = initializeApp(cfg);\n", 'firestore.rules': "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if true;\n    }\n  }\n}\n" },
    { 'src/fb.js': "import { initializeApp } from 'firebase/app';\nexport const app = initializeApp(cfg);\n", 'firestore.rules': "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /posts/{id} {\n      allow read: if true;\n      allow write: if request.auth != null;\n    }\n  }\n}\n" }],
  ['FIRE-001', { 'firebase.json': '{"storage":{"rules":"storage.rules"}}\n', 'storage.rules': "service firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} {\n      allow read, write;\n    }\n  }\n}\n" },
    { 'firebase.json': '{"storage":{"rules":"storage.rules"}}\n', 'storage.rules': "service firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} {\n      allow read;\n      allow write: if request.auth != null;\n    }\n  }\n}\n" }],
  ['FIRE-001', { 'package.json': '{"dependencies":{"firebase":"10.0.0"}}\n', 'database.rules.json': '{\n  "rules": {\n    ".read": true,\n    ".write": true\n  }\n}\n' },
    { 'package.json': '{"dependencies":{"firebase":"10.0.0"}}\n', 'database.rules.json': '{\n  "rules": {\n    ".read": true,\n    ".write": "auth != null"\n  }\n}\n' }],
  ['FIRE-001', { 'firebase.json': '{}\n', 'firestore.rules': "match /{document=**} {\n  allow read, write: if request.time < timestamp.date(2999, 1, 1);\n}\n" },
    { 'firebase.json': '{}\n', 'firestore.rules': "match /{document=**} {\n  allow read, write: if request.time < timestamp.date(2001, 1, 1);\n}\n" }],
  ['RLS-001', { 'package.json': '{"dependencies":{"@supabase/supabase-js":"2.0.0"}}\n', 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const db = createClient(u, k);\n", 'schema.sql': 'DROP TABLE IF EXISTS profiles;\nCREATE TABLE IF NOT EXISTS "public"."profiles" (id uuid);\n' },
    { 'package.json': '{"dependencies":{"@supabase/supabase-js":"2.0.0"}}\n', 'src/db.js': "import { createClient } from '@supabase/supabase-js';\nexport const db = createClient(u, k);\n", 'schema.sql': 'DROP TABLE IF EXISTS profiles;\nCREATE TABLE IF NOT EXISTS "public"."profiles" (id uuid);\nALTER TABLE ONLY "public"."profiles" ENABLE ROW LEVEL SECURITY;\n' }],
  // Clerk's older authMiddleware: everything is protected except publicRoutes and ignoredRoutes, which the matcher says nothing about
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({ publicRoutes: ['/', '/api/(.*)'] });\nexport const config = { matcher: ['/((?!_next).*)', '/(api|trpc)(.*)'] };\n" },
    { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({ publicRoutes: ['/', '/api/webhooks(.*)'] });\nexport const config = { matcher: ['/((?!_next).*)', '/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({\n  ignoredRoutes: [\n    '/api/orders',\n  ],\n});\n" },
    { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({\n  ignoredRoutes: [\n    '/api/health',\n  ],\n});\n" }],
  // a guard written out in app.use: what its block does decides, not that it is there
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use((req, res, next) => {\n  res.setHeader('X-Api-Key-Version', '1');\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.use((req, res, next) => {\n  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in first.' });\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(async (req, res, next) => {\n  console.log(req.user, req.url);\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(async (req, res, next) => {\n  try {\n    const token = req.headers.authorization.split(' ')[1];\n    req.me = await admin.auth().verifyIdToken(token);\n    next();\n  } catch (err) {\n    res.status(401).json({ error: 'Please sign in first.' });\n  }\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  // filling in who is calling turns no one away; a guard with a path covers what it names, and only after it is set
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use((req, res, next) => {\n  req.me = req.session.userId;\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.use('/api', function (req, res, next) {\n  if (!req.session.userId) return res.redirect('/login');\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(\n  (req, res, next) => {\n    if (req.path.includes('..')) return res.status(403).end();\n    next();\n  }\n);\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(\n  (req, res, next) => {\n    if (!req.session.userId) return res.status(401).end();\n    next();\n  }\n);\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use('/admin', (req, res, next) => {\n  if (!req.session.userId) return res.status(401).end();\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.all('/api/*', requireAuth);\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\nfunction logCalls(req, res, next) { console.log(req.url); next(); }\napp.all('/api/*', logCalls);\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\nfunction gate(req, res, next) { if (!req.cookies.sid) return res.sendStatus(401); next(); }\napp.all('*', gate);\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\nawait Promise.all([requireAuth(), db.all('SELECT 1')]);\napp.all('/admin/*', requireAuth);\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" },
    { 'srv.js': "const express = require('express');\nconst app = express();\napp.all('/api/*', (req, res, next) => {\n  if (!req.session.userId) return res.status(401).end();\n  next();\n});\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  // the usual router-and-controller app: the route names a function in another file
  ['API-001', { 'routes/userRoutes.js': "const express = require('express');\nconst router = express.Router();\nconst { deleteUser } = require('../controllers/userController');\nrouter.delete('/:id', deleteUser);\nmodule.exports = router;\n", 'controllers/userController.js': "const asyncHandler = require('express-async-handler');\nconst User = require('../models/userModel');\nconst deleteUser = asyncHandler(async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.json({ message: 'Removed' });\n});\nmodule.exports = { deleteUser };\n" },
    { 'routes/userRoutes.js': "const express = require('express');\nconst router = express.Router();\nconst { deleteUser } = require('../controllers/userController');\nconst { protect } = require('../middleware/authMiddleware');\nrouter.delete('/:id', protect, deleteUser);\nmodule.exports = router;\n", 'controllers/userController.js': "const asyncHandler = require('express-async-handler');\nconst User = require('../models/userModel');\nconst deleteUser = asyncHandler(async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.json({ message: 'Removed' });\n});\nmodule.exports = { deleteUser };\n" }],
  ['API-001', { 'routes/users.js': "import { Router } from 'express';\nimport {\n  getUsers,\n  addUser,\n} from '../controllers/users.js';\nconst router = Router();\nrouter.route('/').get(getUsers).post(addUser);\nexport default router;\n", 'controllers/users.js': "export const getUsers = async (req, res) => {\n  res.json(await User.find({}));\n};\nexport const addUser = async (req, res) => {\n  res.json(await new User(req.body).save());\n};\n" },
    { 'routes/users.js': "import { Router } from 'express';\nimport {\n  getUsers,\n  addUser,\n} from '../controllers/users.js';\nimport { protect } from '../middleware/auth.js';\nconst router = Router();\nrouter.use(protect);\nrouter.route('/').get(getUsers).post(addUser);\nexport default router;\n", 'controllers/users.js': "export const getUsers = async (req, res) => {\n  res.json(await User.find({}));\n};\nexport const addUser = async (req, res) => {\n  res.json(await new User(req.body).save());\n};\n" }],
  ['API-001', { 'routes/notes.js': "const router = require('express').Router();\nconst notes = require('../controllers/notes');\nrouter.route('/:id')\n  .get(notes.show)\n  .delete(notes.drop);\nmodule.exports = router;\n", 'controllers/notes.js': "exports.show = async (req, res) => res.json(await Note.findById(req.params.id));\nexports.drop = async (req, res) => {\n  await Note.findByIdAndDelete(req.params.id);\n  res.end();\n};\n" },
    { 'routes/notes.js': "const router = require('express').Router();\nconst notes = require('../controllers/notes');\nrouter.route('/:id')\n  .get(notes.show)\n  .delete(notes.drop);\nmodule.exports = router;\n", 'controllers/notes.js': "exports.show = async (req, res) => {\n  res.json(await Note.findOne({ _id: req.params.id, owner: req.user.id }));\n};\nexports.drop = async (req, res) => {\n  await Note.findOneAndDelete({ _id: req.params.id, owner: req.user.id });\n  res.end();\n};\n" }],
  // a route's own function calls one in another file
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst userRepo = require('./db/userRepo');\napp.get('/api/users', async (req, res) => {\n  res.json(await userRepo.findAll());\n});\n", 'db/userRepo.js': "const db = require('./pool');\nmodule.exports = {\n  findAll: () => db.query('SELECT * FROM users'),\n  remove: id => db.query('DELETE FROM users WHERE id = ?', [id]),\n};\n" },
    { 'server.js': "const express = require('express');\nconst app = express();\nconst userRepo = require('./db/userRepo');\nconst { requireUser } = require('./mw');\napp.get('/api/users', requireUser, async (req, res) => {\n  res.json(await userRepo.findAll());\n});\n", 'db/userRepo.js': "const db = require('./pool');\nmodule.exports = {\n  findAll: () => db.query('SELECT * FROM users'),\n  remove: id => db.query('DELETE FROM users WHERE id = ?', [id]),\n};\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst repo = require('./repo');\napp.delete('/api/orders/:id', async (req, res) => {\n  await repo.dropOrder(req.params.id);\n  res.end();\n});\n", 'repo.js': "class Repo {\n  async dropOrder(id) {\n    await db.query('DELETE FROM orders WHERE id = ?', [id]);\n  }\n}\nmodule.exports = new Repo();\n" },
    { 'server.js': "const express = require('express');\nconst app = express();\nconst repo = require('./repo');\nconst repoOfThings = require('some-package');\napp.delete('/api/orders/:id', async (req, res) => {\n  await repoOfThings.dropOrder(req.params.id);\n  res.end();\n});\n", 'repo.js': "class Repo {\n  async dropOrder(id) {\n    await db.query('DELETE FROM orders WHERE id = ?', [id]);\n  }\n}\nmodule.exports = new Repo();\n" }],
  // router.route with its handlers written out, over several lines: each method is judged by its own brackets
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nrouter.route('/')\n  .get(async (req, res) => {\n    if (!req.user) return res.sendStatus(401);\n    res.json(await User.find({}));\n  })\n  .delete(async (req, res) => {\n    await User.deleteMany({});\n    res.end();\n  });\nmodule.exports = router;\n" },
    { 'routes/users.js': "const router = require('express').Router();\nrouter.route('/')\n  .get(async (req, res) => {\n    if (!req.user) return res.sendStatus(401);\n    res.json(await User.find({}));\n  })\n  .delete(async (req, res) => {\n    if (!req.user) return res.sendStatus(401);\n    await User.deleteMany({});\n    res.end();\n  });\nmodule.exports = router;\n" }],
  // one name in two controllers: the file the route loads it from decides
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nconst { remove } = require('../controllers/users');\nrouter.delete('/:id', remove);\nmodule.exports = router;\n", 'controllers/users.js': "const remove = async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { remove };\n", 'controllers/posts.js': "const remove = async (req, res) => {\n  if (!req.user) return res.sendStatus(401);\n  await Post.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { remove };\n" },
    { 'routes/users.js': "const router = require('express').Router();\nconst { remove } = require('../controllers/users');\nrouter.delete('/:id', remove);\nmodule.exports = router;\n", 'controllers/users.js': "const remove = async (req, res) => {\n  if (!req.user) return res.sendStatus(401);\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { remove };\n", 'controllers/posts.js': "const remove = async (req, res) => {\n  await Post.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { remove };\n" }],
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
  // API-002: a fixed list in the code is not the database; a key compared in a header is a check
  ['API-002', { 'app/api/widgets/route.ts': "const WIDGETS = [{ id: 1 }];\nconst Parts = [{ id: 2 }];\nexport async function GET() { return Response.json([WIDGETS.find(w => w.id === 1), Parts.find(w => w.id === 2)]); }\n" }],
  ['API-001', { 'app/api/orders/route.ts': "export async function POST(req) { if (req.headers.get('x-admin-key') !== ADMIN_KEY) return new Response(null); await prisma.order.deleteMany(); return Response.json({}); }\n" }],
  // API and DEBUG: a test that is the app's own subject, deep in the address
  ['DEBUG-002', { 'app/api/quiz/test/route.ts': "export async function GET() { return Response.json(await prisma.quiz.findMany()); }\n" }],
  // PAY-007: a React hooks folder; a service object that handles the webhook elsewhere
  ['PAY-007', { 'src/hooks/useStripe.ts': "export const load = async (request) => { const r = await request.json(); return stripe(r); };\n" }],
  ['PAY-007', { 'app/api/stripe/webhook/route.ts': "import { billing } from '@/services/billing';\nexport async function POST(req) { const raw = await req.text(); await billing.handleWebhook(raw); return Response.json({}); }\n" }],
  // DEBUG-002: the password reset route is not a leftover, in Next.js or Express
  ['DEBUG-002', { 'app/api/reset-password/route.ts': "export async function POST(req) { const { token, password } = await req.json(); await prisma.user.update({ where: { token }, data: { password: await hash(password) } }); return Response.json({}); }\n" }],
  ['DEBUG-002', { 'srv.js': "const express = require('express');\nconst app = express();\napp.post('/api/reset-password', async (req, res) => {\n  await User.updateOne({ token: req.body.token }, { hash: await hash(req.body.pw) });\n  res.end();\n});\n" }],
  // API-001: honest mounts: a guard on a path that covers the mount, before every route, or in the router's own file
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst router = require('./routes/users');\napp.use('/api', auth, router);\n", 'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst usersRouter = require('./routes/users');\napp.use('/api', verifyToken);\napp.use('/api/users', usersRouter);\n", 'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst usersRouter = require('./routes/users');\napp.use(auth);\napp.use('/api/users', usersRouter);\n", 'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst usersRouter = require('./routes/users');\napp.use('/api/users', usersRouter);\n", 'routes/users.js': "const router = require('express').Router();\nrouter.use(auth);\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  // API-001: a router whose mount cannot be read is given the benefit of the doubt
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\napp.use('/api', auth, mountAll());\n", 'routes/users.js': "const router = require('express').Router();\nrouter.get('/', async (req, res) => res.json(await User.find()));\nmodule.exports = router;\n" }],
  // API-001: Fastify's hooks, in the file, in the plugin, and in the root that registers the routes
  ['API-001', { 'srv.js': "const fastify = require('fastify');\nconst app = fastify();\napp.addHook('preHandler', requireUser);\napp.get('/customers', async () => Customer.find({}));\n" }],
  ['API-001', { 'srv.js': "const fastify = require('fastify');\nconst app = fastify();\napp.addHook('onRequest', async (req, reply) => {\n  await req.jwtVerify();\n});\napp.get('/customers', async () => Customer.find({}));\n" }],
  ['API-001', { 'server.js': "const fastify = require('fastify');\nconst app = fastify();\napp.addHook('onRequest', app.authenticate);\napp.register(require('./routes/customers'));\n", 'routes/customers.js': "const server = require('fastify')();\nserver.get('/customers', async () => Customer.find({}));\n" }],
  // SvelteKit, Nuxt: public by nature, a plain Express folder of that name, and a page's load is not a route
  ['API-001', { 'src/routes/api/health/+server.ts': "export async function GET() { await prisma.user.count(); return new Response('ok'); }\n" }],
  ['API-002', { 'src/routes/api/blog/+server.ts': "export async function GET() { return json(await prisma.post.findMany({ where: { published: true } })); }\n" }],
  ['API-001', { 'server/api/auth/register.post.ts': "export default defineEventHandler(async (event) => prisma.user.create({ data: await readBody(event) }));\n" }],
  ['API-001', { 'src/routes/orders/+page.server.ts': "export async function load() { return { orders: await prisma.order.findMany() }; }\n" }],
  ['API-001', { 'src/routes/api/orders/+server.ts': "export async function DELETE() { await prisma.order.deleteMany(); return new Response(null); }\n", 'src/hooks.server.ts': "export const handle = async ({ event, resolve }) => {\n  if (!event.url.pathname.startsWith('/public') && !event.locals.user) throw redirect(303, '/login');\n  return resolve(event);\n};\n" }],
  ['API-001', { 'server/routes/users.js': "module.exports = function list(req, res) { return null; };\nconst x = prisma.user.findMany();\n" }],
  // RLS-001: a different database's migrations, with Supabase there for sign-in only
  ['RLS-001', { 'src/auth.js': "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(u, k);\nexport const me = () => sb.auth.getUser();\n", 'db/migrations/001_init.sql': 'create table notes (id int);\n', 'schema.sql': 'create table other (id int);\n' }],
  // DEBUG-002: a dynamic part after test is a feature (a quiz app's exam route)
  ['DEBUG-002', { 'app/api/test/[id]/route.ts': "export async function GET() { return Response.json(await prisma.exam.findMany()); }\n" }],
  ['DEBUG-002', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/api/test/:id', async (req, res) => res.json(await Exam.find({})));\n" }],
  // API-001: a sign-up by REST, with a look for the email first; a router under a public mount
  ['API-001', { 'app/api/users/route.ts': "import bcrypt from 'bcryptjs';\nexport async function POST(req) {\n  const { email, password } = await req.json();\n  if (await prisma.user.findUnique({ where: { email } })) return Response.json({ error: 'That email already has an account.' }, { status: 409 });\n  const hash = await bcrypt.hash(password, 10);\n  await prisma.user.create({ data: { email, hash } });\n  return Response.json({});\n}\n" }],
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nrouter.post('/', async (req, res) => {\n  const hash = await bcrypt.hash(req.body.password, 10);\n  res.json(await User.create({ email: req.body.email, hash }));\n});\nmodule.exports = router;\n" }],
  ['API-001', { 'routes/webhooks.js': "const router = require('express').Router();\nrouter.post('/', async (req, res) => {\n  await Order.updateOne({ id: req.body.id }, { paid: true });\n  res.end();\n});\nmodule.exports = router;\n", 'server.js': "const express = require('express');\nconst app = express();\nconst hooks = require('./routes/webhooks');\napp.use('/api/webhooks', hooks);\n" }],
  // API-001: server actions that are sign-in, a form, or that check through a helper or a wrapped client
  ['API-001', { 'app/actions.ts': "'use server';\nexport async function signUp(formData) {\n  await prisma.user.create({ data: { email: formData.get('email') } });\n}\nexport async function sendContact(formData) {\n  await prisma.enquiry.create({ data: { text: formData.get('text') } });\n}\n" }],
  ['API-001', { 'app/actions.ts': "'use server';\nasync function me() { const s = await auth(); if (!s) throw new Error('Please sign in first.'); return s.user; }\nexport async function dropOrder(id) {\n  const u = await me();\n  await prisma.order.deleteMany({ where: { id, userId: u.id } });\n}\n" }],
  ['API-001', { 'app/actions.ts': "'use server';\nexport const dropOrder = authAction.action(async ({ id, ctx }) => {\n  await prisma.order.deleteMany({ where: { id, userId: ctx.user.id } });\n});\n" }],
  // a 'use server' written inside a function of a component is not a file of actions: other() is not an action
  ['API-001', { 'app/page.tsx': "export default function Page() {\n  async function go() {\n    'use server';\n    await prisma.interest.create({ data: {} });\n  }\n  return <form action={go} />;\n}\nexport async function other() { return prisma.order.deleteMany(); }\n" }],
  // API-001/002: honest routes
  ['API-001', { 'app/api/health/route.ts': "export async function GET() { await prisma.user.count(); return Response.json({ ok: true }); }\n" }],
  ['API-002', { 'app/api/blog/route.ts': "export async function GET() { return Response.json(await prisma.post.findMany({ where: { published: true } })); }\n" }],
  ['API-002', { 'app/api/latest/route.ts': "export async function GET() { return Response.json(await prisma.post.findMany()); }\n" }],
  ['API-002', { 'pages/api/stuff.ts': "export default async function handler(req, res) { res.json(await db.query('SELECT * FROM stuff WHERE is_public = true')); }\n" }],
  ['API-001', { 'app/api/auth/register/route.ts': "export async function POST(req) { await prisma.user.create({ data: await req.json() }); return Response.json({}); }\n" }],
  ['API-001', { 'app/api/bookings/route.ts': "export async function POST(req) { await prisma.booking.create({ data: await req.json() }); return Response.json({}); }\n" }],
  ['API-001', { 'app/api/stripe/webhook/route.ts': "export async function POST(req) { const e = stripe.webhooks.constructEvent(await req.text(), s, k); await prisma.order.update({ where: { id: e.id }, data: {} }); return Response.json({}); }\n" }],
  // a session check made in the file, through a wrapper, through a helper it imports, through middleware
  ['API-001', { 'app/api/a/route.ts': "export async function POST() { const s = await getServerSession(); if (!s) return new Response(null, { status: 401 }); await prisma.order.create({ data: {} }); return Response.json({}); }\n" }],
  ['API-001', { 'app/api/b/route.ts': "export const POST = withAuth(async () => { await prisma.order.create({ data: {} }); return Response.json({}); });\n" }],
  ['API-001', { 'app/api/c/route.ts': "import { requireUser } from '@/lib/guards';\nexport async function POST() { await requireUser(); await prisma.order.create({ data: {} }); return Response.json({}); }\n" }],
  ['API-001', { 'app/api/d/route.ts': "export async function POST() { await prisma.order.create({ data: {} }); return Response.json({}); }\n", 'src/middleware.ts': "export default withAuth({});\nexport const config = { matcher: ['/api/:path*'] };\n", 'src/app/api/d/route.ts': "export async function POST() { await prisma.order.create({ data: {} }); return Response.json({}); }\n" }],
  ['API-001', { 'apps/web/app/api/e/route.ts': "export async function POST() { await prisma.order.create({ data: {} }); return Response.json({}); }\n", 'apps/web/middleware.ts': "import { auth } from './auth';\nexport default auth;\n" }],
  // a Supabase client that runs as the signed-in person is limited by row-level security
  ['API-001', { 'app/api/f/route.ts': "import { createClient } from '@/lib/supabase/server';\nexport async function GET() { const s = await createClient(); return Response.json(await s.from('notes').select('*')); }\n", 'lib/supabase/server.ts': "export const createClient = () => createServerClient(url, anon, { cookies: {} });\n" }],
  // Express: the check on the route, across the app, in the body; a mock server; a handler defined elsewhere
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use(requireLogin);\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/customers', async (req, res) => {\n  if (!req.user) return res.sendStatus(401);\n  res.json(await Customer.find({}));\n});\n" }],
  ['API-001', { 'mocks/srv.js': "const express = require('express');\nconst app = express();\napp.get('/customers', async (req, res) => res.json(await Customer.find({})));\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/customers', list.customers);\n" }],
  // the same words in an app that is not a server at all
  ['API-001', { 'src/orders.js': "const app = makeApp();\napp.get('/orders', () => db.query('SELECT * FROM orders'));\n" }],
  // DEBUG-002: a test route with a fixed answer; a password reset page; a real test folder
  ['DEBUG-002', { 'app/api/test/route.ts': "export async function GET() { return Response.json({ hello: 'world' }); }\n" }],
  ['DEBUG-002', { 'srv.js': "const express = require('express');\nconst app = express();\napp.post('/reset', async (req, res) => {\n  await User.updateOne({ token: req.body.token }, { password: hash(req.body.password) });\n  res.end();\n});\n" }],
  ['DEBUG-002', { 'tests/fixtures/app/api/seed/route.ts': "export async function GET() { await prisma.user.deleteMany(); return Response.json({}); }\n" }],
  // PAY-007: another service's webhook; the event handler itself, after the route checked it; a helper in a package
  ['PAY-007', { 'app/api/github/webhook/route.ts': "export async function POST(req) { const e = await req.json(); await build(e); return Response.json({}); }\n" }],
  ['PAY-007', { 'lib/webhooks/stripe-events.ts': "export async function onEvent(event) { if (event.type === 'checkout.session.completed') await grant(event); }\n" }],
  ['PAY-007', { 'app/api/webhooks/paddle/route.ts': "import { paddle } from '@/lib/paddle';\nexport async function POST(req) { const e = await paddle.webhooks.unmarshal(await req.text(), key, req.headers.get('paddle-signature')); await grant(e); return Response.json({}); }\n" }],
  // API-001: a project's own guard handed to the route itself, by a name that says so and by one that does not
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst checkApiKey = (req, res, next) => { if (req.headers['x-api-key'] !== process.env.API_KEY) return res.sendStatus(401); next(); };\napp.delete('/api/users/:id', checkApiKey, async (req, res) => { await User.findByIdAndDelete(req.params.id); res.end(); });\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst gatekeeper = (req, res, next) => { if (req.headers['x-pass'] !== process.env.PASS) return res.sendStatus(401); next(); };\napp.delete('/api/users/:id', gatekeeper, async (req, res) => { await User.findByIdAndDelete(req.params.id); res.end(); });\n" }],
  // RLS-001: enabled in a later migration; a table outside public; a project with no Supabase; a loop that enables it
  ['RLS-001', { 'supabase/migrations/1.sql': 'create table notes (id int);\n', 'supabase/migrations/2.sql': 'alter table if exists public.notes enable row level security;\n' }],
  ['RLS-001', { 'supabase/migrations/1.sql': 'create table private.audit (id int);\n/* create table public.old (id int); */\n-- create table public.older (id int);\n' }],
  ['RLS-001', { 'db/schema.sql': 'create table notes (id int);\n', 'src/db.js': "import pg from 'pg';\nexport const db = new pg.Pool();\n" }],
  ['RLS-001', { 'supabase/migrations/1.sql': "create table a (id int);\ncreate table b (id int);\ndo $$ declare r record; begin for r in select tablename from pg_tables where schemaname = 'public' loop\n  execute format('alter table %I enable row level security', r.tablename);\nend loop; end $$;\n" }],
  // Clerk: anything not read as a plain if counts as covering; a route that checks for itself needs nothing
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isPublicRoute = createRouteMatcher(['/sign-in(.*)']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (isPublicRoute(req)) return;\n  await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isAdminRoute = createRouteMatcher(['/admin(.*)']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (isAdminRoute(req)) await auth.protect({ role: 'admin' });\n  await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isPublicRoute = createRouteMatcher(PUBLIC_PATHS);\nexport default clerkMiddleware(async (auth, req) => {\n  if (!isPublicRoute(req)) await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';\nconst isPublicRoute = createRouteMatcher(['/shop/(a|b)/(.*)']);\nexport default clerkMiddleware(async (auth, req) => {\n  if (!isPublicRoute(req)) await auth.protect();\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server';\nexport default clerkMiddleware(async (auth, req) => {\n  const { userId } = await auth();\n  if (!userId) return Response.redirect(new URL('/sign-in', req.url));\n});\nexport const config = { matcher: ['/(api|trpc)(.*)'] };\n" }],
  ['API-001', { 'app/api/users/route.ts': "import { auth } from '@clerk/nextjs/server';\nexport async function DELETE() { const { userId } = await auth(); if (!userId) return new Response(null, { status: 401 }); await prisma.user.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { clerkMiddleware } from '@clerk/nextjs/server';\nexport default clerkMiddleware();\n" }],
  // Express: a project's own guard on the .use line, by name or by what it does
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\nfunction checkApiKey(req, res, next) {\n  if (req.headers['x-api-key'] !== process.env.API_KEY) return res.status(401).json({ error: 'That key is not right.' });\n  next();\n}\napp.use('/api', checkApiKey);\napp.post('/api/todos', async (req, res) => {\n  await prisma.todo.create({ data: req.body });\n  res.end();\n});\n" }],
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\nconst { apiKey } = require('./mw');\napp.use('/api', apiKey);\napp.post('/api/todos', async (req, res) => {\n  await prisma.todo.create({ data: req.body });\n  res.end();\n});\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst adminRouter = require('./routes/admin');\nconst { isAdmin } = require('./mw');\napp.use('/api/admin', isAdmin, adminRouter);\n", 'routes/admin.js': "const router = require('express').Router();\nrouter.delete('/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\nmodule.exports = router;\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst teamRouter = require('./routes/team');\nconst { hasPermission } = require('./mw');\napp.use('/api/team', hasPermission('team'), teamRouter);\n", 'routes/team.js': "const router = require('express').Router();\nrouter.delete('/:id', async (req, res) => {\n  await Member.findByIdAndDelete(req.params.id);\n  res.end();\n});\nmodule.exports = router;\n" }],
  // Hono: the same star on the whole server, and with no slash before it
  ['API-001', { 'srv.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.use('/*', bearerAuth({ token }));\napp.delete('/api/todos/:id', async (c) => {\n  await db.delete(todos).where(eq(todos.id, c.req.param('id')));\n  return c.json({});\n});\n" }],
  ['API-001', { 'srv.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.use('/api*', jwt({ secret }));\napp.delete('/api/todos/:id', async (c) => {\n  await db.delete(todos).where(eq(todos.id, c.req.param('id')));\n  return c.json({});\n});\n" }],
  // inline server actions: a page that checks, a middleware over the page, a public form that only adds a record
  ['API-001', { 'app/people/page.tsx': "import { auth } from '@/auth';\nexport default async function Page() {\n  const session = await auth();\n  if (!session) redirect('/login');\n  async function wipe() {\n    'use server';\n    await prisma.user.deleteMany();\n  }\n  return <form action={wipe} />;\n}\n" }],
  ['API-001', { 'app/people/page.tsx': "export default function Page() {\n  async function wipe() {\n    'use server';\n    await prisma.user.deleteMany();\n  }\n  return <form action={wipe} />;\n}\n", 'middleware.ts': "export { default } from 'next-auth/middleware';\nexport const config = { matcher: ['/people/:path*'] };\n" }],
  ['API-001', { 'app/page.tsx': "export default function Page() {\n  async function join(data) {\n    'use server';\n    await prisma.interest.create({ data: { email: data.get('email') } });\n  }\n  return <form action={join} />;\n}\n" }],
  // NextAuth: a wrapper written out refuses for itself; the export of another project's own auth is not NextAuth's
  ['API-001', { 'auth.ts': "import NextAuth from 'next-auth';\nexport const { auth } = NextAuth({ providers: [] });\n", 'middleware.ts': "import { auth } from '@/auth';\nexport default auth((req) => {\n  if (!req.auth) return Response.redirect(new URL('/login', req.url));\n});\n", 'app/api/notes/route.ts': "export async function DELETE() { await prisma.note.deleteMany(); return Response.json({}); }\n" }],
  ['API-001', { 'lib/auth.ts': "export function auth(req) { if (!req.cookies.get('sid')) return Response.redirect('/login'); }\n", 'middleware.ts': "export { auth as middleware } from './lib/auth';\n", 'app/api/notes/route.ts': "export async function DELETE() { await prisma.note.deleteMany(); return Response.json({}); }\n" }],
  // FIRE-001: guarded rules; a project with no Firebase; a line commented out; a form anyone may add to; a skipped folder
  ['FIRE-001', { 'src/fb.js': "import { getFirestore } from 'firebase/firestore';\n", 'firestore.rules': "match /{document=**} {\n  allow read, write: if request.auth != null;\n}\n" }],
  ['FIRE-001', { 'src/db.js': "import pg from 'pg';\nexport const db = new pg.Pool();\n", 'firestore.rules': "match /{document=**} {\n  allow read, write: if true;\n}\n" }],
  ['FIRE-001', { 'firebase.json': '{}\n', 'firestore.rules': "match /{document=**} {\n  // allow read, write: if true;\n  /* allow write: if true; */\n  allow read, write: if request.auth != null;\n}\n" }],
  ['FIRE-001', { 'firebase.json': '{}\n', 'firestore.rules': "match /enquiries/{id} {\n  allow create: if true;\n  allow read, update, delete: if request.auth != null;\n}\n" }],
  ['FIRE-001', { 'firebase.json': '{}\n', 'tests/firestore.rules': "match /{document=**} {\n  allow read, write: if true;\n}\n" }],
  ['FIRE-001', { 'firebase.json': '{}\n', 'database.rules.json': '{\n  // ".write": true,\n  "rules": { "posts": { ".read": true, ".write": false } }\n}\n' }],
  // API-001: Clerk's older middleware with no list, a list it cannot read, and a pattern it cannot read
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware();\n" }],
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({ publicRoutes: PUBLIC_PATHS });\n" }],
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({ publicRoutes: (req) => req.url.endsWith('/open') });\n" }],
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from '@clerk/nextjs';\nexport default authMiddleware({ publicRoutes: ['/((?!api).*)'] });\n" }],
  ['API-001', { 'app/api/orders/route.ts': "export async function DELETE() { await prisma.order.deleteMany(); return Response.json({}); }\n", 'middleware.ts': "import { authMiddleware } from \"@clerk/nextjs\";\nexport default authMiddleware({ publicRoutes: [\"/\", \"/api/webhooks(.*)\"] });\n" }],
  // API-001: a guard written out in app.use, on one line
  ['API-001', { 'srv.js': "const express = require('express');\nconst app = express();\napp.use((req, res, next) => { if (!req.session.userId) return res.status(401).end(); next(); });\napp.delete('/api/users/:id', async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n});\n" }],
  // API-001: the standard honest controller shapes
  ['API-001', { 'routes/userRoutes.js': "const express = require('express');\nconst router = express.Router();\nconst { registerUser, loginUser } = require('../controllers/userController');\nrouter.post('/', registerUser);\nrouter.post('/login', loginUser);\nmodule.exports = router;\n", 'controllers/userController.js': "const registerUser = asyncHandler(async (req, res) => {\n  const { email, password } = req.body;\n  if (await User.findOne({ email })) throw new Error('That email already has an account.');\n  res.json(await User.create({ email, password }));\n});\nconst loginUser = asyncHandler(async (req, res) => {\n  res.json(await User.findOne({ email: req.body.email }));\n});\nmodule.exports = { registerUser, loginUser };\n" }],
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nconst { addUser } = require('../controllers/users');\nrouter.post('/', addUser);\nmodule.exports = router;\n", 'controllers/users.js': "exports.addUser = async (req, res) => {\n  const { email, password } = req.body;\n  res.json(await User.create({ email, password }));\n};\n" }],
  ['API-001', { 'routes/products.js': "const router = require('express').Router();\nconst { getProducts } = require('../controllers/products');\nconst { protect, admin } = require('../middleware/auth');\nrouter.route('/').get(getProducts).post(protect, admin, createProduct);\nrouter.route('/:id')\n  .put(protect, admin, updateProduct)\n  .delete(protect, admin, deleteProduct);\nmodule.exports = router;\n", 'controllers/products.js': "const getProducts = asyncHandler(async (req, res) => {\n  res.json(await Product.find({}));\n});\nconst createProduct = asyncHandler(async (req, res) => {\n  res.json(await new Product(req.body).save());\n});\nconst updateProduct = asyncHandler(async (req, res) => {\n  res.json(await Product.findByIdAndUpdate(req.params.id, req.body));\n});\nconst deleteProduct = asyncHandler(async (req, res) => {\n  await Product.findByIdAndDelete(req.params.id);\n  res.end();\n});\nmodule.exports = { getProducts, createProduct, updateProduct, deleteProduct };\n" }],
  ['API-002', { 'routes/products.js': "const router = require('express').Router();\nconst { getProducts } = require('../controllers/products');\nrouter.route('/').get(getProducts);\nmodule.exports = router;\n", 'controllers/products.js': "const getProducts = asyncHandler(async (req, res) => {\n  res.json(await Product.find({}));\n});\nmodule.exports = { getProducts };\n", 'server.js': "const express = require('express');\nconst app = express();\nconst productRoutes = require('./routes/products');\napp.use('/api/products', productRoutes);\n" }],
  // API-001: a guard from a package this scan cannot read stands before the handler; a guard kept in a list
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nconst { signedInOnly } = require('some-package');\nconst { deleteUser } = require('../controllers/users');\nrouter.delete('/:id', signedInOnly, deleteUser);\nmodule.exports = router;\n", 'controllers/users.js': "const deleteUser = async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { deleteUser };\n" }],
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nconst adminOnly = [loadUser, mustBeStaff];\nconst { deleteUser } = require('../controllers/users');\nrouter.delete('/:id', adminOnly, deleteUser);\nmodule.exports = router;\n", 'controllers/users.js': "const deleteUser = async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { deleteUser };\n" }],
  // API-001: a controller that hands the check to a helper of its own
  ['API-001', { 'routes/users.js': "const router = require('express').Router();\nconst { deleteUser } = require('../controllers/users');\nrouter.delete('/:id', deleteUser);\nmodule.exports = router;\n", 'controllers/users.js': "function whoIsIt(req, res) { if (!req.cookies.sid) res.status(401).end(); }\nconst deleteUser = async (req, res) => {\n  whoIsIt(req, res);\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { deleteUser };\n" }],
  // API-001: a guard on the mount of the router; a project-wide guard in the server file
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst userRoutes = require('./routes/users');\napp.use('/api/users', passport.authenticate('jwt'), userRoutes);\n", 'routes/users.js': "const router = require('express').Router();\nconst { deleteUser } = require('../controllers/users');\nrouter.delete('/:id', deleteUser);\nmodule.exports = router;\n", 'controllers/users.js': "const deleteUser = async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { deleteUser };\n" }],
  // API-001: a page that counts its visits is not a route that changes people's data; helpers in a test folder are not the app
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst { countVisit } = require('./lib/visits');\napp.get('/welcome', (req, res) => {\n  countVisit(req.ip);\n  res.send('Hello');\n});\n", 'lib/visits.js': "exports.countVisit = ip => db.query('UPDATE visits SET n = n + 1 WHERE ip = ?', [ip]);\n" }],
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst { listAll } = require('./lib/reports');\napp.get('/welcome', listAll);\n", 'test/fixtures/reports.js': "const listAll = async (req, res) => res.json(await User.find({}));\n" }],
  // API-001: code after a route that is not part of it, with a function that starts the app
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nfunction seedUsers() { return User.deleteMany({}); }\napp.get('/welcome', (req, res) => res.send('Hello'));\nseedUsers();\napp.listen(3000);\n" }],
  // API-001: a method of a package's object that shares its name with a project's function
  ['API-001', { 'server.js': "const express = require('express');\nconst app = express();\nconst mailer = require('mail-package');\napp.post('/api/notify', async (req, res) => {\n  await mailer.remove(req.body.id);\n  res.end();\n});\n", 'lib/stock.js': "exports.remove = id => db.query('DELETE FROM stock WHERE id = ?', [id]);\n" }],
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cross-'));
  const write = (dir, files) => { for (const [rel, text] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } };
  const scan = async (name, files) => { const d = path.join(tmp, name); write(d, files); return (await runAudit(d, null, { root: false })).findings; };
  const where = fs_ => fs_.map(f => f.rule + ' ' + f.where).join(', ') || 'nothing';
  for (const [n, [id, bad, good]] of PAIRS.entries()) {
    const loud = await scan('loud' + n, bad), quiet = await scan('quiet' + n, good);
    check(id + ' fires (#' + n + ')', () => assert(loud.some(f => f.rule === id), 'not found; got ' + where(loud)));
    check(id + ' stays quiet on the fixed copy (#' + n + ')', () => assert(!quiet.some(f => f.rule === id), 'flagged ' + where(quiet.filter(f => f.rule === id))));
  }
  for (const [n, [id, files]] of QUIET.entries()) {
    const found = await scan('q' + n, files);
    check(id + ' stays quiet (a shape it once flagged on a real project, #' + n + ')', () => assert(!found.some(f => f.rule === id), 'flagged ' + where(found.filter(f => f.rule === id))));
  }
  // One finding a file, and the worst route of the file: a change, then someone's data, then anything else.
  const crud = await scan('crud', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));\napp.get('/api/people', async (req, res) => res.json(await prisma.user.findMany()));\napp.delete('/api/todos/:id', async (req, res) => {\n  await prisma.todo.delete({ where: { id: req.params.id } });\n  res.end();\n});\napp.post('/api/tags', async (req, res) => {\n  await prisma.tag.create({ data: req.body });\n  res.end();\n});\n" });
  check('a file of open routes gets one finding, for its worst: the delete', () => {
    const open = crud.filter(f => /^API-00[12]$/.test(f.rule));
    assert.strictEqual(open.length, 1, where(open));
    assert(open[0].rule === 'API-001' && /\/api\/todos\/:id changes/.test(open[0].title), open[0].title);
  });
  const reads = await scan('reads', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));\napp.get('/api/people', async (req, res) => res.json(await prisma.user.findMany()));\n" });
  check('with no change in the file, someone\'s data beats a plain read', () => {
    const open = reads.filter(f => /^API-00[12]$/.test(f.rule));
    assert(open.length === 1 && open[0].rule === 'API-001' && /\/api\/people returns/.test(open[0].title), where(open));
  });
  const plain = await scan('plain', { 'srv.js': "const express = require('express');\nconst app = express();\napp.get('/api/todos', async (req, res) => res.json(await prisma.todo.findMany()));\napp.get('/api/tasks', async (req, res) => res.json(await prisma.task.findMany()));\n" });
  check('plain reads alone stay Medium, one finding for the file', () => {
    const open = plain.filter(f => /^API-00[12]$/.test(f.rule));
    assert(open.length === 1 && open[0].rule === 'API-002', where(open));
  });
  // A route that only adds a record, by POST alone: Medium, in words a beginner can judge.
  const addsOnly = { 'app/api/messages/route.ts': "export async function POST(req) {\n  await prisma.message.create({ data: await req.json() });\n  return Response.json({ ok: true });\n}\n", 'app/api/subscribers/route.ts': "export const POST = async (req) => {\n  await prisma.subscriber.create({ data: await req.json() });\n  return Response.json({ ok: true });\n};\nexport async function OPTIONS() { return new Response(null); }\n" };
  const adds = await scan('adds', addsOnly);
  check('a POST that only adds a record is API-002 Medium, not API-001, for each route', () => {
    assert(!adds.some(f => f.rule === 'API-001'), where(adds));
    const open = adds.filter(f => f.rule === 'API-002');
    assert.strictEqual(open.length, 2, where(open));
    assert(open.every(f => f.sev === 'Medium'), 'not Medium');
  });
  check('its words say when it is fine, and what to add when it is not', () => {
    for (const f of adds.filter(x => x.rule === 'API-002')) {
      assert(/adds a record/.test(f.title) && /public form/.test(f.title) && !/returns data/.test(f.title), f.title);
      assert(/public form/.test(f.fix) && /limit/.test(f.fix) && /check/.test(f.fix), f.fix);
    }
  });
  for (const [name, text] of [
    ['also has a GET', "export async function GET() { return Response.json([]); }\nexport async function POST(req) {\n  await prisma.message.create({ data: await req.json() });\n  return Response.json({});\n}\n"],
    ['shares a handler with GET', "async function handle(req) { return Response.json(await prisma.message.create({ data: {} })); }\nexport { handle as GET, handle as POST };\n"],
    ['also reads', "export async function POST(req) {\n  const n = await prisma.message.count();\n  await prisma.message.create({ data: { n } });\n  return Response.json({});\n}\n"],
    ['also changes', "export async function POST(req) {\n  await prisma.message.create({ data: {} });\n  await prisma.message.deleteMany({ where: { old: true } });\n  return Response.json({});\n}\n"],
  ]) {
    const found = await scan('adds-' + name.replace(/\W/g, ''), { 'app/api/messages/route.ts': text });
    check('a route that ' + name + ' stays API-001', () => assert(found.some(f => f.rule === 'API-001'), where(found)));
  }
  const pagesAdd = await scan('adds-pages', { 'pages/api/members.ts': "export default async function handler(req, res) { res.json(await prisma.member.create({ data: req.body })); }\n" });
  check('a pages/api route says nothing of its method, so it stays API-001', () => assert(pagesAdd.some(f => f.rule === 'API-001'), where(pagesAdd)));
  const addsSigned = await scan('adds-signed', { 'app/api/messages/route.ts': "export async function POST(req) {\n  const s = await auth();\n  if (!s) return new Response(null, { status: 401 });\n  await prisma.message.create({ data: {} });\n  return Response.json({});\n}\n" });
  check('a POST that adds with a check stays quiet', () => assert(!addsSigned.some(f => /^API-00[12]$/.test(f.rule)), where(addsSigned)));
  // The finding of a followed route stands at the route, and says what the function it calls does.
  const followed = await scan('followed', { 'routes/userRoutes.js': "const router = require('express').Router();\nconst { deleteUser } = require('../controllers/users');\n\nrouter.delete('/:id', deleteUser);\nmodule.exports = router;\n", 'controllers/users.js': "const deleteUser = async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n  res.end();\n};\nmodule.exports = { deleteUser };\n", 'server.js': "const express = require('express');\nconst app = express();\nconst userRoutes = require('./routes/userRoutes');\napp.use('/api/users', userRoutes);\n" });
  check('a followed route is reported at the route, with its real address', () => {
    const open = followed.filter(f => f.rule === 'API-001');
    assert.strictEqual(open.length, 1, where(open));
    assert(open[0].where.startsWith('routes/userRoutes.js:4'), open[0].where);
    assert(/\/api\/users\/:id changes data/.test(open[0].title), open[0].title);
  });
  const reposChange = await scan('repo-get', { 'server.js': "const express = require('express');\nconst app = express();\nconst repo = require('./repo');\napp.get('/api/orders', async (req, res) => {\n  res.json(await repo.listOrders());\n});\n", 'repo.js': "exports.listOrders = () => db.query('SELECT * FROM orders');\nexports.dropOrder = id => db.query('DELETE FROM orders WHERE id = ?', [id]);\n" });
  check('one function of a file is read, not its neighbour', () => {
    const open = reposChange.filter(f => f.rule === 'API-001');
    assert(open.length === 1 && /returns data/.test(open[0].title), where(open) + ' ' + (open[0] || {}).title);
  });
  // The new reading of routes, guards and functions stays linear on project files built to slow it down (400 KB each).
  const { crossAudit } = require('../../src/bridge/cross');
  const asFile = (rel, text) => ({ name: rel.split('/').pop(), rel, text, lines: text.split('\n') });
  const hostileCross = {
    'unclosed guards': [asFile('srv.js', "const express = require('express');\n" + 'app.use((req, res, next) => {\n'.repeat(13800))],
    'unclosed route chains': [asFile('srv.js', "const express = require('express');\n" + "router.route('/a').get((\n".repeat(15000))],
    'chains that never end': [asFile('srv.js', "const express = require('express');\nrouter.route('/a')\n" + '.get(x)\n'.repeat(50000))],
    'routes naming functions': [asFile('routes/a.js', "const router = require('express').Router();\n" + Array.from({ length: 500 }, (_, n) => "router.delete('/" + n + "', h" + n + ', h' + (n + 1) + ', h' + (n + 2) + ');').join('\n') + '\n'), asFile('controllers/a.js', Array.from({ length: 1000 }, (_, n) => 'const h' + n + ' = wrap(async (req, res) => {\n').join('') + ('x(\n').repeat(100000))],
    'a function in every line': [asFile('routes/b.js', "const router = require('express').Router();\n" + Array.from({ length: 500 }, (_, n) => "router.get('/" + n + "', async (req, res) => { res.json(await repo.m" + n + '()); });').join('\n') + '\n'), asFile('repo.js', Array.from({ length: 14000 }, (_, n) => 'm' + n + ': async () => { q(\n').join(''))],
    'one short name in every line': [asFile('controllers/d.js', 'const a=async()=>{}\n'.repeat(20000)), asFile('routes/d.js', "const router = require('express').Router();\n" + "router.delete('/a', a);\n".repeat(500))],
    'lists that never close': Array.from({ length: 200 }, (_, n) => asFile('app/api/r' + n + '/route.ts', 'export async function DELETE() { await prisma.user.deleteMany(); return Response.json({}); }\n')).concat([asFile('middleware.ts', "export default authMiddleware();\n" + 'publicRoutes: [\n'.repeat(25000))]),
    'one name everywhere': Array.from({ length: 40 }, (_, n) => asFile('controllers/c' + n + '.js', 'const remove = async (req, res) => { User.find({}); };\n'.repeat(180))).concat([asFile('routes/c.js', "const router = require('express').Router();\n" + "router.delete('/a', remove);\n".repeat(500))]),
  };
  let worstCross = 0;
  for (const [name, files] of Object.entries(hostileCross)) {
    const size = files.reduce((n, f) => n + f.text.length, 0);
    const start = process.hrtime.bigint();
    const { notes } = crossAudit(files, {}, (r, f, i, title) => ({ rule: r.id, title }));
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    worstCross = Math.max(worstCross, ms);
    check('the cross-file rules read a hostile project in well under a second: ' + name + ' (' + Math.round(size / 1024) + ' KB, ' + Math.round(ms) + ' ms)', () => { assert(ms < 800, Math.round(ms) + ' ms'); assert(!notes.length, notes.join('; ')); });
  }
  const fire = await scan('fire', { 'firebase.json': '{}\n', 'firestore.rules': "match /{document=**} {\n  allow read, write: if true;\n}\n", 'storage.rules': "match /{allPaths=**} {\n  allow write: if true;\n}\n", 'node_modules/x/firestore.rules': "allow write: if true;\n" });
  check('FIRE-001 is High, one finding a rules file, at the open line, none from node_modules', () => {
    const hits = fire.filter(f => f.rule === 'FIRE-001');
    assert.strictEqual(hits.length, 2, where(hits));
    assert(hits.every(f => f.sev === 'High'), 'not High');
    assert(hits.some(f => f.where.startsWith('firestore.rules:2')), where(hits));
  });
  const skipDir = path.join(tmp, 'fire-skip');
  write(skipDir, { 'firebase.json': '{}\n', 'old/firestore.rules': "match /{document=**} {\n  allow write: if true;\n}\n" });
  const skipped = (await runAudit(skipDir, null, { root: false, skip: ['old'] })).findings;
  check('FIRE-001 does not read a folder on the skip list', () => assert(!skipped.some(f => f.rule === 'FIRE-001'), where(skipped)));
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
