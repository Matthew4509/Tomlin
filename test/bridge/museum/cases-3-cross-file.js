// Museum, section 5c of the training plan: faults that only show when two files (or a file and a page) are read
// together. Phase T3 builds the per-project index these need. No "at": the finding may name either file.
'use strict';

const LIMITS = `<?php
function rate_ok($bucket, $key, $max, $seconds) {
  $k = 'rl_' . $bucket . '_' . $key;
  $n = (int)apcu_fetch($k);
  if ($n >= $max) return false;
  apcu_store($k, $n + 1, $seconds);
  return true;
}
`;

module.exports = [
  {
    id: 'anon-write-no-limit', bucket: 'X', phase: 'T3', faults: 16, examples: ['IP-108', 'IP-204', 'SP-056', 'CW-031'],
    title: 'A public form saves and mails with no per-visitor limit and no site-wide cap',
    bad: { 'lib/limits.php': LIMITS, 'api/contact.php': `<?php
require __DIR__ . '/../lib/limits.php';
$name = trim($_POST['name'] ?? ''); $email = trim($_POST['email'] ?? ''); $body = trim($_POST['body'] ?? '');
$db->prepare('INSERT INTO messages (name, email, body) VALUES (?, ?, ?)')->execute([$name, $email, $body]);
mail(SHOP_EMAIL, 'New message', $body);
` },
    good: { 'lib/limits.php': LIMITS, 'api/contact.php': `<?php
require __DIR__ . '/../lib/limits.php';
$name = trim($_POST['name'] ?? ''); $email = trim($_POST['email'] ?? ''); $body = trim($_POST['body'] ?? '');
if (!rate_ok('contact', $_SERVER['REMOTE_ADDR'], 5, 3600) || !rate_ok('contact-all', 'site', 200, 86400)) { http_response_code(429); header('Retry-After: 3600'); exit('Too many messages: try again in an hour.'); }
$db->prepare('INSERT INTO messages (name, email, body) VALUES (?, ?, ?)')->execute([$name, $email, $body]);
mail(SHOP_EMAIL, 'New message', $body);
` },
  },
  {
    id: 'table-never-pruned', bucket: 'X', phase: 'T3', faults: 6, examples: ['IP-213', 'SP-068', 'IP-204'],
    title: 'A table that every visit writes to is never cleaned up by the nightly job',
    bad: { 'api/visit.php': `<?php
$db->prepare('INSERT INTO visits (page, at) VALUES (?, NOW())')->execute([$page]);
`, 'cron/prune.php': `<?php
$db->exec('DELETE FROM sessions WHERE last_seen < NOW() - INTERVAL 30 DAY');
` },
    good: { 'api/visit.php': `<?php
$db->prepare('INSERT INTO visits (page, at) VALUES (?, NOW())')->execute([$page]);
`, 'cron/prune.php': `<?php
$db->exec('DELETE FROM sessions WHERE last_seen < NOW() - INTERVAL 30 DAY');
$db->exec('DELETE FROM visits WHERE at < NOW() - INTERVAL 90 DAY');
` },
  },
  {
    id: 'public-whole-row', bucket: 'X', phase: 'T3', faults: 6, examples: ['IP-001', 'IP-026', 'IP-093'],
    title: 'A public page answers with the whole database row (email, notes, its own secret token)',
    bad: { 'lib/public.php': `<?php
function public_route() { header('Cache-Control: no-store'); }
`, 'api/booking.php': `<?php
require __DIR__ . '/../lib/public.php';
public_route();
$st = $db->prepare('SELECT * FROM bookings WHERE share_code = ?');
$st->execute([$_GET['code'] ?? '']);
echo json_encode($st->fetch());
` },
    good: { 'lib/public.php': `<?php
function public_route() { header('Cache-Control: no-store'); }
`, 'api/booking.php': `<?php
require __DIR__ . '/../lib/public.php';
public_route();
$st = $db->prepare('SELECT day, start_time, service FROM bookings WHERE share_code = ?');
$st->execute([$_GET['code'] ?? '']);
echo json_encode($st->fetch());
` },
  },
  {
    id: 'webhook-ack-own-failure', bucket: 'X', phase: 'T3', faults: 6, examples: ['CW-002', 'CW-042', 'SP-018'],
    title: 'A webhook marks the event as seen and answers 200 even when its own handler failed (the payment is lost)',
    bad: { 'lib/orders.php': `<?php
function handle_event($e) {
  $order = find_order($e['order_id']);
  if (!$order) return false;
  return mark_paid($order);
}
`, 'hooks/payment.php': `<?php
require __DIR__ . '/../lib/orders.php';
$e = verified_event();
mark_event_seen($e['id']);
handle_event($e);
http_response_code(200);
` },
    good: { 'lib/orders.php': `<?php
function handle_event($e) {
  $order = find_order($e['order_id']);
  if (!$order) return false;
  return mark_paid($order);
}
`, 'hooks/payment.php': `<?php
require __DIR__ . '/../lib/orders.php';
$e = verified_event();
if (!handle_event($e)) { http_response_code(500); exit; } // the sender tries again later
mark_event_seen($e['id']);
http_response_code(200);
` },
  },
  {
    id: 'build-ships-unvetted', bucket: 'X', phase: 'T3', faults: 12, examples: ['SP-055', 'CS-012', 'SP-034', 'IP-042'],
    title: 'The release build copies the whole site folder, notes and installer included',
    bad: { 'site/index.html': '<!doctype html><title>Shop</title>\n', 'site/AUDIT-REPORT-2026-01-05.md': '# Audit\nOpen faults: 3\n', 'site/install.php': '<?php // creates the first admin\n',
      'tools/build.js': `const fs = require('fs');
fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('site', 'dist/site', { recursive: true });
` },
    good: { 'site/index.html': '<!doctype html><title>Shop</title>\n', 'site/AUDIT-REPORT-2026-01-05.md': '# Audit\nOpen faults: 3\n', 'site/install.php': '<?php // creates the first admin\n',
      'tools/build.js': `const fs = require('fs');
const SHIP = ['index.html']; // an allow list: a new file stays out until it is named here
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/site', { recursive: true });
for (const f of SHIP) fs.copyFileSync('site/' + f, 'dist/site/' + f);
` },
  },
  {
    id: 'build-drops-referenced-file', bucket: 'X', phase: 'T3', faults: 5, examples: ['CW-022', 'CS-004', 'SC-007'],
    title: 'The release leaves out a file its own page links to (the live site shows unstyled)',
    bad: { 'site/index.html': '<!doctype html><title>Shop</title><link rel="stylesheet" href="/assets/app.css">\n', 'site/assets/app.css': 'body { margin: 0; }\n',
      'tools/build.js': `const fs = require('fs');
const SHIP = ['index.html'];
for (const f of SHIP) { fs.mkdirSync(require('path').dirname('dist/' + f), { recursive: true }); fs.copyFileSync('site/' + f, 'dist/' + f); }
` },
    good: { 'site/index.html': '<!doctype html><title>Shop</title><link rel="stylesheet" href="/assets/app.css">\n', 'site/assets/app.css': 'body { margin: 0; }\n',
      'tools/build.js': `const fs = require('fs');
const SHIP = ['index.html', 'assets/app.css'];
for (const f of SHIP) { fs.mkdirSync(require('path').dirname('dist/' + f), { recursive: true }); fs.copyFileSync('site/' + f, 'dist/' + f); }
` },
  },
  {
    id: 'claim-vs-code', bucket: 'X', phase: 'T3', faults: 10, examples: ['CS-024', 'CS-001', 'CS-006'],
    title: 'The page promises uploads are deleted after a day; nothing in the code deletes them',
    bad: { 'index.html': '<!doctype html><title>Converter</title><p>Your files are deleted after 24 hours.</p>\n', 'api/upload.php': `<?php
move_uploaded_file($_FILES['f']['tmp_name'], __DIR__ . '/../store/' . bin2hex(random_bytes(8)));
` },
    good: { 'index.html': '<!doctype html><title>Converter</title><p>Your files are deleted after 24 hours.</p>\n', 'api/upload.php': `<?php
move_uploaded_file($_FILES['f']['tmp_name'], __DIR__ . '/../store/' . bin2hex(random_bytes(8)));
`, 'cron/cleanup.php': `<?php
foreach (glob(__DIR__ . '/../store/*') as $f) if (filemtime($f) < time() - 86400) unlink($f);
` },
  },
  {
    id: 'privacy-omits-script-host', bucket: 'X', phase: 'done', faults: 2, examples: ['SC-003', 'SP-069'],
    title: 'The privacy page does not name a service the site loads a script from',
    bad: { 'index.html': '<!doctype html><title>Shop</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>\n',
      'privacy.html': '<!doctype html><title>Privacy</title><p>We keep your order details to send your order.</p>\n' },
    good: { 'index.html': '<!doctype html><title>Shop</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>\n',
      'privacy.html': '<!doctype html><title>Privacy</title><p>We keep your order details to send your order. Charts load from jsDelivr, which sees your address.</p>\n' },
  },
  {
    id: 'privacy-omits-image-host', bucket: 'X', phase: 'T3', faults: 4, examples: ['SC-025', 'CS-016'],
    title: 'Map tiles load from an outside host built in code; the privacy page does not name it',
    bad: { 'map.js': `function tileUrl(z, x, y) { return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png'; }
`, 'privacy.html': '<!doctype html><title>Privacy</title><p>We keep your bookings to run them.</p>\n' },
    good: { 'map.js': `function tileUrl(z, x, y) { return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png'; }
`, 'privacy.html': '<!doctype html><title>Privacy</title><p>We keep your bookings to run them. The map pictures come from OpenStreetMap, which sees your address.</p>\n' },
  },
  {
    id: 'privacy-omits-storage-key', bucket: 'X', phase: 'T3', faults: 3, examples: ['IP-319', 'IN-030'],
    title: 'The privacy page says nothing is kept on the device, but the code keeps recent searches there',
    bad: { 'search.js': `localStorage.setItem('recent_searches', JSON.stringify(recent.slice(0, 10)));
`, 'privacy.html': '<!doctype html><title>Privacy</title><p>We store nothing on your device.</p>\n' },
    good: { 'search.js': `localStorage.setItem('recent_searches', JSON.stringify(recent.slice(0, 10)));
`, 'privacy.html': '<!doctype html><title>Privacy</title><p>Your last ten searches are kept in this browser only (recent_searches), so you can repeat them. Clear them with Forget searches.</p>\n' },
  },
  {
    id: 'privacy-names-dropped-service', bucket: 'X', phase: 'T3', faults: 2, examples: ['SC-025', 'IP-320'],
    title: 'The privacy page still names a recording tool the site no longer loads',
    bad: { 'index.html': '<!doctype html><title>Shop</title><h1>Shop</h1>\n', 'privacy.html': '<!doctype html><title>Privacy</title><p>We use Hotjar to record how visitors use the pages.</p>\n' },
    good: { 'index.html': '<!doctype html><title>Shop</title><h1>Shop</h1>\n', 'privacy.html': '<!doctype html><title>Privacy</title><p>We do not record how visitors use the pages.</p>\n' },
  },
  {
    id: 'no-privacy-page', bucket: 'X', phase: 'T3', faults: 2, examples: ['SC-016'],
    title: 'The site loads from an outside service and has no privacy page at all',
    bad: { 'index.html': '<!doctype html><title>Shop</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">\n' },
    good: { 'index.html': '<!doctype html><title>Shop</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><a href="/privacy.html">Privacy</a>\n',
      'privacy.html': '<!doctype html><title>Privacy</title><p>The page font comes from Google Fonts, which sees your address.</p>\n' },
  },
  {
    id: 'alternate-write-skips-guard', bucket: 'X', phase: 'T3', faults: 8, examples: ['JP-010', 'PD-047', 'PD-049'],
    title: 'Every save of a client goes through the validator except the restore page',
    bad: { 'lib/clients.php': `<?php
function validate_client(array $c) { if (!is_string($c['name'] ?? null) || strlen($c['name']) > 120) throw new InvalidArgumentException('name'); return $c; }
`, 'api/clients.php': `<?php
$c = validate_client($in);
$db->prepare('INSERT INTO clients (name, email) VALUES (?, ?)')->execute([$c['name'], $c['email']]);
`, 'admin/restore.php': `<?php
foreach ($rows as $c) $db->prepare('INSERT INTO clients (name, email) VALUES (?, ?)')->execute([$c['name'], $c['email']]);
` },
    good: { 'lib/clients.php': `<?php
function validate_client(array $c) { if (!is_string($c['name'] ?? null) || strlen($c['name']) > 120) throw new InvalidArgumentException('name'); return $c; }
`, 'api/clients.php': `<?php
$c = validate_client($in);
$db->prepare('INSERT INTO clients (name, email) VALUES (?, ?)')->execute([$c['name'], $c['email']]);
`, 'admin/restore.php': `<?php
foreach ($rows as $c) { $c = validate_client($c); $db->prepare('INSERT INTO clients (name, email) VALUES (?, ?)')->execute([$c['name'], $c['email']]); }
` },
  },
  {
    id: 'idor-delete-no-owner', bucket: 'X', phase: 'T3', faults: 6, examples: ['SP-002', 'CW-048', 'IP-004'],
    title: 'A signed-in person can delete anyone\'s note by its number (the query never asks whose it is)',
    bad: { 'lib/auth.php': `<?php
function require_user() { session_start(); if (empty($_SESSION['uid'])) { http_response_code(401); exit; } return (int)$_SESSION['uid']; }
`, 'api/note-delete.php': `<?php
require __DIR__ . '/../lib/auth.php';
$uid = require_user();
$db->prepare('DELETE FROM notes WHERE id = ?')->execute([(int)$_POST['id']]);
` },
    good: { 'lib/auth.php': `<?php
function require_user() { session_start(); if (empty($_SESSION['uid'])) { http_response_code(401); exit; } return (int)$_SESSION['uid']; }
`, 'api/note-delete.php': `<?php
require __DIR__ . '/../lib/auth.php';
$uid = require_user();
$db->prepare('DELETE FROM notes WHERE id = ? AND user_id = ?')->execute([(int)$_POST['id'], $uid]);
` },
  },
  {
    id: 'action-switch-no-role', bucket: 'X', phase: 'T3', faults: 5, examples: ['SP-009', 'CW-015'],
    title: 'The admin page checks sign-in once, then every action in its switch runs for any signed-in person',
    bad: { 'lib/auth.php': `<?php
function require_login() { session_start(); if (empty($_SESSION['uid'])) exit; }
function require_role($r) { if (($_SESSION['role'] ?? '') !== $r) { http_response_code(403); exit('Only an admin can do that.'); } }
`, 'admin/actions.php': `<?php
require __DIR__ . '/../lib/auth.php';
require_login();
switch ($_POST['action'] ?? '') {
  case 'delete_user': delete_user((int)$_POST['id']); break;
  case 'export': export_all(); break;
}
` },
    good: { 'lib/auth.php': `<?php
function require_login() { session_start(); if (empty($_SESSION['uid'])) exit; }
function require_role($r) { if (($_SESSION['role'] ?? '') !== $r) { http_response_code(403); exit('Only an admin can do that.'); } }
`, 'admin/actions.php': `<?php
require __DIR__ . '/../lib/auth.php';
require_login();
switch ($_POST['action'] ?? '') {
  case 'delete_user': require_role('admin'); delete_user((int)$_POST['id']); break;
  case 'export': require_role('admin'); export_all(); break;
}
` },
  },
  {
    id: 'price-drift', bucket: 'X', phase: 'T3', faults: 5, examples: ['JP-054', 'JP-070', 'JP-091'],
    title: 'The call-out fee is written in two places with two different values (the quote and the invoice disagree)',
    bad: { 'public/quote.js': `const CALL_OUT_FEE = 85;
`, 'api/invoice.php': `<?php
const CALL_OUT_FEE = 95;
` },
    good: { 'public/quote.js': `const CALL_OUT_FEE = 95;
`, 'api/invoice.php': `<?php
const CALL_OUT_FEE = 95;
` },
  },
  {
    id: 'sanitiser-misses-field', bucket: 'X', phase: 'T3', faults: 2, examples: ['JP-001', 'JP-059'],
    title: 'The save step cleans name and bio but not the tagline, which the profile page prints raw',
    bad: { 'lib/clean.php': `<?php
function clean_profile(array $p) { $p['name'] = strip_tags($p['name']); $p['bio'] = strip_tags($p['bio']); return $p; }
`, 'profile.php': `<?php
$p = load_profile($id);
echo '<h1>' . $p['name'] . '</h1><p>' . $p['tagline'] . '</p>';
` },
    good: { 'lib/clean.php': `<?php
function clean_profile(array $p) { foreach (['name', 'bio', 'tagline'] as $k) $p[$k] = strip_tags($p[$k] ?? ''); return $p; }
`, 'profile.php': `<?php
$p = load_profile($id);
echo '<h1>' . $p['name'] . '</h1><p>' . $p['tagline'] . '</p>';
` },
  },
  {
    id: 'outside-api-no-cap', bucket: 'X', phase: 'T3', faults: 5, examples: ['JP-058', 'PD-027', 'PD-050'],
    title: 'A public page calls a paid map service for every visitor, with no cache and no daily cap',
    bad: { 'lib/limits.php': LIMITS, 'api/geocode.php': `<?php
require __DIR__ . '/../lib/limits.php';
if (!rate_ok('geo', $_SERVER['REMOTE_ADDR'], 20, 3600)) exit;
$q = strtolower(trim($_GET['q'] ?? ''));
echo file_get_contents('https://geo.example-maps.com/search?q=' . urlencode($q) . '&key=' . GEO_KEY);
` },
    good: { 'lib/limits.php': LIMITS, 'api/geocode.php': `<?php
require __DIR__ . '/../lib/limits.php';
if (!rate_ok('geo', $_SERVER['REMOTE_ADDR'], 20, 3600)) exit;
$q = strtolower(trim($_GET['q'] ?? ''));
$hit = apcu_fetch('geo_' . md5($q));
if ($hit !== false) exit($hit);
if (!rate_ok('geo-all', 'site', 2000, 86400)) { http_response_code(503); exit('The map search is busy today: type the address instead.'); }
$out = file_get_contents('https://geo.example-maps.com/search?q=' . urlencode($q) . '&key=' . GEO_KEY);
apcu_store('geo_' . md5($q), $out, 30 * 86400);
echo $out;
` },
  },
  {
    id: 'delete-leaves-files', bucket: 'X', phase: 'T3', faults: 4, examples: ['IP-007', 'IP-154', 'IP-201'],
    title: 'Deleting a job removes its row but leaves its uploaded photos on the server',
    bad: { 'api/upload.php': `<?php
move_uploaded_file($_FILES['photo']['tmp_name'], __DIR__ . '/../uploads/' . (int)$jobId . '/' . bin2hex(random_bytes(8)) . '.jpg');
`, 'api/job-delete.php': `<?php
$db->prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?')->execute([$jobId, $uid]);
` },
    good: { 'api/upload.php': `<?php
move_uploaded_file($_FILES['photo']['tmp_name'], __DIR__ . '/../uploads/' . (int)$jobId . '/' . bin2hex(random_bytes(8)) . '.jpg');
`, 'api/job-delete.php': `<?php
$st = $db->prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?');
$st->execute([$jobId, $uid]);
if ($st->rowCount()) { array_map('unlink', glob(__DIR__ . '/../uploads/' . (int)$jobId . '/*')); @rmdir(__DIR__ . '/../uploads/' . (int)$jobId); }
` },
  },
  {
    id: 'wipe-misses-keys', bucket: 'X', phase: 'T3', faults: 5, examples: ['IN-001', 'IN-008', 'IN-009'],
    title: '"Forget everything" clears two of the three things the app keeps in the browser',
    bad: { 'app.js': `localStorage.setItem('log_entries', JSON.stringify(entries));
localStorage.setItem('log_prefs', JSON.stringify(prefs));
localStorage.setItem('last_instrument', current.id);
function forgetAll() {
  localStorage.removeItem('log_entries');
  localStorage.removeItem('log_prefs');
}
` },
    good: { 'app.js': `localStorage.setItem('log_entries', JSON.stringify(entries));
localStorage.setItem('log_prefs', JSON.stringify(prefs));
localStorage.setItem('last_instrument', current.id);
function forgetAll() {
  for (const k of ['log_entries', 'log_prefs', 'last_instrument']) localStorage.removeItem(k);
}
` },
  },
  {
    id: 'baked-page-outlives-data', bucket: 'X', phase: 'T3', faults: 2, examples: ['JP-003', 'JP-004'],
    title: 'A listing is baked into its own page, and deleting the listing leaves that page online',
    bad: { 'lib/bake.php': `<?php
function bake_listing($l) { file_put_contents(__DIR__ . '/../public/listing/' . (int)$l['id'] . '.html', render_listing($l)); }
`, 'admin/listing-delete.php': `<?php
$db->prepare('DELETE FROM listings WHERE id = ?')->execute([$id]);
` },
    good: { 'lib/bake.php': `<?php
function bake_listing($l) { file_put_contents(__DIR__ . '/../public/listing/' . (int)$l['id'] . '.html', render_listing($l)); }
function unbake_listing($id) { @unlink(__DIR__ . '/../public/listing/' . (int)$id . '.html'); }
`, 'admin/listing-delete.php': `<?php
$db->prepare('DELETE FROM listings WHERE id = ?')->execute([$id]);
unbake_listing($id);
` },
  },
  {
    id: 'dead-api-route', bucket: 'X', phase: 'T3', faults: 6, examples: ['IP-008', 'IP-013', 'IP-147'],
    title: 'The page calls an API address the server has no route for (the Export button always fails)',
    bad: { 'public/app.js': `exportButton.onclick = () => fetch('/api/invoices/export').then(r => r.blob()).then(save);
`, 'server.js': `const routes = { 'GET /api/invoices': listInvoices, 'POST /api/invoices': addInvoice };
` },
    good: { 'public/app.js': `exportButton.onclick = () => fetch('/api/invoices/export').then(r => r.blob()).then(save);
`, 'server.js': `const routes = { 'GET /api/invoices': listInvoices, 'POST /api/invoices': addInvoice, 'GET /api/invoices/export': exportInvoices };
` },
  },
  {
    id: 'feature-off-in-browser-only', bucket: 'X', phase: 'T3', faults: 5, examples: ['IP-219', 'IP-282', 'JP-087'],
    title: 'A feature switched off in the page\'s settings still answers on the server',
    bad: { 'public/config.js': `window.FEATURES = { export: false };
`, 'api/export.php': `<?php
$uid = require_user();
header('Content-Type: text/csv');
export_clients_csv($uid);
` },
    good: { 'public/config.js': `window.FEATURES = { export: false };
`, 'api/export.php': `<?php
$uid = require_user();
if (!feature_on('export')) { http_response_code(404); exit; }
header('Content-Type: text/csv');
export_clients_csv($uid);
` },
  },
  {
    id: 'install-drift', bucket: 'X', phase: 'T3', faults: 5, examples: ['IP-140', 'IP-324', 'SP-065'],
    title: 'The install notes say PHP 8.1 is enough, but the code uses a constant that PHP 8.3 added',
    bad: { 'INSTALL.md': '# Install\n\nNeeds PHP 8.1 or newer.\n', 'lib/fetch.php': `<?php
curl_setopt($ch, CURLOPT_PROTOCOLS_STR, 'https');
` },
    good: { 'INSTALL.md': '# Install\n\nNeeds PHP 8.3 or newer.\n', 'lib/fetch.php': `<?php
curl_setopt($ch, CURLOPT_PROTOCOLS_STR, 'https');
` },
  },
  {
    id: 'webroot-deny-gap', bucket: 'X', phase: 'T3', faults: 2, examples: ['JP-095', 'PD-065'],
    title: 'A backup job writes zips into the web folder, and the deny list there does not cover zips',
    bad: { 'public/.htaccess': `<FilesMatch "\\.(sql|log)$">
  Require all denied
</FilesMatch>
`, 'tools/backup.php': `<?php
make_backup_zip(__DIR__ . '/../public/backup-' . date('Ymd') . '.zip');
` },
    good: { 'public/.htaccess': `<FilesMatch "\\.(sql|log)$">
  Require all denied
</FilesMatch>
`, 'tools/backup.php': `<?php
make_backup_zip(__DIR__ . '/../backups/backup-' . date('Ymd') . '.zip'); // outside the web folder
` },
  },
  {
    id: 'csp-blocks-own-form', bucket: 'X', phase: 'T3', faults: 5, examples: ['PD-024', 'JP-096'],
    title: 'The Content-Security-Policy forbids form posts, and the site has a search form',
    bad: { '.htaccess': `Header always set Content-Security-Policy "default-src 'self'; form-action 'none'"
`, 'index.html': '<!doctype html><title>Shop</title><form action="/search.php" method="get"><input name="q"><button>Search</button></form>\n' },
    good: { '.htaccess': `Header always set Content-Security-Policy "default-src 'self'; form-action 'self'"
`, 'index.html': '<!doctype html><title>Shop</title><form action="/search.php" method="get"><input name="q"><button>Search</button></form>\n' },
  },
  {
    id: 'immutable-unversioned', bucket: 'X', phase: 'T3', faults: 3, examples: ['JP-035', 'PD-115'],
    title: 'Scripts are cached for a year as "immutable", but the page links them with no version in the address',
    bad: { '.htaccess': `<FilesMatch "\\.(js|css)$">
  Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
`, 'index.html': '<!doctype html><title>Shop</title><script src="/app.js"></script>\n' },
    good: { '.htaccess': `<FilesMatch "\\.(js|css)$">
  Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
`, 'index.html': '<!doctype html><title>Shop</title><script src="/app.js?v=1.4.2"></script>\n' },
  },
  {
    id: 'hollow-tests', bucket: 'X', phase: 'T3', faults: 5, examples: ['CW-036', 'SP-076', 'SC-032'],
    title: 'The test suite checks nothing: it prints SKIPPED and passes',
    bad: { 'tests/run.js': `console.log('SKIPPED: needs a database');
process.exit(0);
` },
    good: { 'tests/run.js': `const assert = require('assert');
const { total } = require('../lib/cart');
assert.strictEqual(total([{ price: 250, qty: 2 }]), 500);
console.log('all passed');
` },
  },
];
