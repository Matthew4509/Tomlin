// Museum, section 5a of the training plan: fault classes another scanner already has a rule for (phase T2 ports them).
// Each case: the fault ("bad") and the same files with only that fault fixed ("good"). Names are made up.
// faults: how many of the 839 real faults this class stands for. examples: register ids it was built from.
'use strict';

module.exports = [
  {
    id: 'img-decode-memory', bucket: 'R', phase: 'T2', faults: 3, examples: ['SP-001', 'JP-018'],
    title: 'An uploaded photo is decoded with no check on its pixel count (a small file can need gigabytes)',
    at: 'photo.php',
    bad: { 'photo.php': `<?php
$tmp = $_FILES['photo']['tmp_name'];
$img = imagecreatefromstring(file_get_contents($tmp));
imagejpeg($img, __DIR__ . '/uploads/' . bin2hex(random_bytes(8)) . '.jpg', 85);
` },
    good: { 'photo.php': `<?php
$tmp = $_FILES['photo']['tmp_name'];
$info = getimagesize($tmp);
if (!$info || $info[0] * $info[1] > 40000000) { http_response_code(413); exit('That photo has too many pixels (over 40 megapixels): make it smaller and try again.'); }
$img = imagecreatefromstring(file_get_contents($tmp));
imagejpeg($img, __DIR__ . '/uploads/' . bin2hex(random_bytes(8)) . '.jpg', 85);
` },
  },
  {
    id: 'img-exif-kept', bucket: 'R', phase: 'T2', faults: 4, examples: ['SP-025', 'CW-018'],
    title: 'An uploaded photo is stored as sent, so its GPS position and camera details stay in the public file',
    at: 'avatar.php',
    bad: { 'avatar.php': `<?php
$tmp = $_FILES['photo']['tmp_name'];
$info = getimagesize($tmp);
if (!$info || $info[2] !== IMAGETYPE_JPEG) exit('Please choose a JPEG photo.');
move_uploaded_file($tmp, __DIR__ . '/avatars/' . bin2hex(random_bytes(8)) . '.jpg');
` },
    good: { 'avatar.php': `<?php
$tmp = $_FILES['photo']['tmp_name'];
$info = getimagesize($tmp);
if (!$info || $info[2] !== IMAGETYPE_JPEG) exit('Please choose a JPEG photo.');
// Drawn again from the pixels: the copy that is kept carries no location or camera details.
$img = imagecreatefromjpeg($tmp);
imagejpeg($img, __DIR__ . '/avatars/' . bin2hex(random_bytes(8)) . '.jpg', 85);
` },
  },
  {
    id: 'img-truncated-jpeg', bucket: 'R', phase: 'T2', faults: 8, examples: ['JP-021', 'CW-029'],
    title: 'A broken or cut-off JPEG is accepted with its errors silenced, and saved half grey',
    at: 'gallery-upload.php',
    bad: { 'gallery-upload.php': `<?php
$info = getimagesize($_FILES['photo']['tmp_name']);
if (!$info || $info[0] * $info[1] > 40000000) exit('That photo has too many pixels (over 40 megapixels).');
ini_set('gd.jpeg_ignore_warning', '1');
$img = @imagecreatefromjpeg($_FILES['photo']['tmp_name']);
imagejpeg($img, __DIR__ . '/gallery/' . bin2hex(random_bytes(8)) . '.jpg', 85);
` },
    good: { 'gallery-upload.php': `<?php
$info = getimagesize($_FILES['photo']['tmp_name']);
if (!$info || $info[0] * $info[1] > 40000000) exit('That photo has too many pixels (over 40 megapixels).');
$img = imagecreatefromjpeg($_FILES['photo']['tmp_name']);
if ($img === false) { http_response_code(422); exit('That photo could not be read (the file may be cut short): save it again and upload the new copy.'); }
imagejpeg($img, __DIR__ . '/gallery/' . bin2hex(random_bytes(8)) . '.jpg', 85);
` },
  },
  {
    id: 'zip-inflate-cap', bucket: 'R', phase: 'T2', faults: 7, examples: ['PD-002', 'PD-003'],
    title: 'An uploaded zip is unpacked entry by entry with no limit on count or unpacked size (zip bomb)',
    at: 'restore.php',
    bad: { 'restore.php': `<?php
$zip = new ZipArchive();
if ($zip->open($_FILES['backup']['tmp_name']) !== true) exit('Not a backup file.');
for ($i = 0; $i < $zip->numFiles; $i++) {
  $data = $zip->getFromIndex($i);
  import_rows(json_decode($data, true));
}
` },
    good: { 'restore.php': `<?php
$zip = new ZipArchive();
if ($zip->open($_FILES['backup']['tmp_name']) !== true) exit('Not a backup file.');
if ($zip->numFiles > 200) exit('This backup holds more than 200 files, so it is not one of ours.');
$total = 0;
for ($i = 0; $i < $zip->numFiles; $i++) {
  $st = $zip->statIndex($i);
  $total += $st['size'];
  if ($st['size'] > 20000000 || $total > 100000000) exit('This backup unpacks to more than 100 MB, so it was not loaded.');
  $data = $zip->getFromIndex($i, 20000000);
  import_rows(json_decode($data, true));
}
` },
  },
  {
    id: 'upload-413', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-015', 'PD-015'],
    title: 'A file over the server\'s post_max_size arrives as an empty form, and the page says "choose a file"',
    at: 'upload.php',
    bad: { 'upload.php': `<?php
if (empty($_FILES['doc']['name'])) { $error = 'Please choose a file.'; }
elseif ($_FILES['doc']['error'] !== UPLOAD_ERR_OK) { $error = 'The upload failed.'; }
` },
    good: { 'upload.php': `<?php
$len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($len > 0 && empty($_POST) && empty($_FILES)) { http_response_code(413); $error = 'That file is larger than the ' . ini_get('post_max_size') . ' this site takes: make it smaller and try again.'; }
elseif (empty($_FILES['doc']['name'])) { $error = 'Please choose a file.'; }
elseif ($_FILES['doc']['error'] === UPLOAD_ERR_INI_SIZE) { $error = 'That file is larger than ' . ini_get('upload_max_filesize') . '.'; }
elseif ($_FILES['doc']['error'] !== UPLOAD_ERR_OK) { $error = 'The upload failed.'; }
` },
  },
  {
    id: 'php-input-unbounded', bucket: 'R', phase: 'T2', faults: 5, examples: ['JP-112'],
    title: 'The whole request body is read into memory with no size cap',
    at: 'api/notes.php',
    bad: { 'api/notes.php': `<?php
$raw = file_get_contents('php://input');
$in = json_decode($raw, true);
if (!is_array($in)) { http_response_code(400); exit; }
save_note($in);
` },
    good: { 'api/notes.php': `<?php
$raw = file_get_contents('php://input', false, null, 0, 65537);
if (strlen($raw) > 65536) { http_response_code(413); exit('That note is longer than 64 KB.'); }
$in = json_decode($raw, true);
if (!is_array($in)) { http_response_code(400); exit; }
save_note($in);
` },
  },
  {
    id: 'logout-on-get', bucket: 'R', phase: 'T2', faults: 3, examples: ['PD-001'],
    title: 'Signing out happens on a plain GET, so any page or image link can sign a person out',
    at: 'logout.php',
    bad: { 'logout.php': `<?php
session_start();
$_SESSION = [];
session_destroy();
header('Location: /');
` },
    good: { 'logout.php': `<?php
session_start();
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !hash_equals($_SESSION['csrf'] ?? '', $_POST['csrf'] ?? '')) { http_response_code(405); exit('Use the Sign out button.'); }
$_SESSION = [];
session_destroy();
header('Location: /');
` },
  },
  {
    id: 'get-link-acts', bucket: 'R', phase: 'T2', faults: 4, examples: ['JP-076', 'CW-016', 'SP-012'],
    title: 'A link in an email changes data on a GET (link checkers and mail scanners click it)',
    at: 'unsubscribe.php',
    bad: { 'unsubscribe.php': `<?php
$email = $_GET['email'] ?? '';
$db->prepare('UPDATE subscribers SET active = 0 WHERE email = ?')->execute([$email]);
echo 'You are unsubscribed.';
` },
    good: { 'unsubscribe.php': `<?php
$email = $_GET['email'] ?? '';
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  echo '<form method="post"><input type="hidden" name="csrf" value="' . htmlspecialchars(csrf_token()) . '"><button>Unsubscribe ' . htmlspecialchars($email) . '</button></form>';
  exit;
}
$db->prepare('UPDATE subscribers SET active = 0 WHERE email = ?')->execute([$email]);
echo 'You are unsubscribed.';
` },
  },
  {
    id: 'lockout-by-email', bucket: 'R', phase: 'T2', faults: 9, examples: ['JP-013', 'PD-004', 'CW-026', 'SP-037'],
    title: 'Wrong passwords lock the account by its email, so anyone can lock a stranger out',
    at: 'login.php',
    bad: { 'login.php': `<?php
$key = 'login_fail_' . strtolower(trim($_POST['email'] ?? ''));
if ((int)apcu_fetch($key) >= 5) { exit('This account is locked for 15 minutes.'); }
if (!check_password($_POST['email'], $_POST['password'])) { apcu_inc($key, 1, $ok, 900); exit('Wrong email or password.'); }
` },
    good: { 'login.php': `<?php
// Tries count per address (IPv6: its /64) AND email: a stranger's tries never lock the real owner out from their own address.
$key = 'login_fail_' . ip_prefix($_SERVER['REMOTE_ADDR']) . '_' . hash('sha256', strtolower(trim($_POST['email'] ?? '')));
if ((int)apcu_fetch($key) >= 5) { exit('Too many tries from this address: wait 15 minutes, or reset your password.'); }
if (!check_password($_POST['email'], $_POST['password'])) { apcu_inc($key, 1, $ok, 900); exit('Wrong email or password.'); }
` },
  },
  {
    id: 'pw-change-no-current', bucket: 'R', phase: 'T2', faults: 4, examples: ['JP-064', 'PD-023', 'CW-039'],
    title: 'The password can be changed without the current one (a borrowed or stolen session takes the account)',
    at: 'account/password.php',
    bad: { 'account/password.php': `<?php
$user = require_user();
$hash = password_hash($_POST['new_password'], PASSWORD_DEFAULT);
$db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$hash, $user['id']]);
session_regenerate_id(true); // (other devices: signed out by the session version, not shown)
` },
    good: { 'account/password.php': `<?php
$user = require_user();
if (!password_verify($_POST['current_password'] ?? '', $user['password_hash'])) exit('Your current password is not right.');
$hash = password_hash($_POST['new_password'], PASSWORD_DEFAULT);
$db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$hash, $user['id']]);
session_regenerate_id(true); // (other devices: signed out by the session version, not shown)
` },
  },
  {
    id: 'pw-change-sessions', bucket: 'R', phase: 'T2', faults: 3, examples: ['JP-063', 'PD-068'],
    title: 'After a password change every other signed-in device stays signed in',
    at: 'account/new-password.php',
    bad: { 'account/new-password.php': `<?php
$user = require_user();
if (!password_verify($_POST['current_password'] ?? '', $user['password_hash'])) exit('Your current password is not right.');
$db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($_POST['new_password'], PASSWORD_DEFAULT), $user['id']]);
echo 'Password changed.';
` },
    good: { 'account/new-password.php': `<?php
$user = require_user();
if (!password_verify($_POST['current_password'] ?? '', $user['password_hash'])) exit('Your current password is not right.');
$db->prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?')->execute([password_hash($_POST['new_password'], PASSWORD_DEFAULT), $user['id']]);
session_regenerate_id(true);
$_SESSION['session_version'] = $user['session_version'] + 1;
echo 'Password changed. Other devices are signed out.';
` },
  },
  {
    id: 'pay-status-ignored', bucket: 'R', phase: 'T2', faults: 3, examples: ['SP-004', 'SP-040'],
    title: 'A payment capture is treated as paid without reading the status it answered',
    at: 'pay/capture.php',
    bad: { 'pay/capture.php': `<?php
$res = paypal_post('/v2/checkout/orders/' . rawurlencode($orderId) . '/capture', []);
mark_order_paid($orderId);
` },
    good: { 'pay/capture.php': `<?php
$res = paypal_post('/v2/checkout/orders/' . rawurlencode($orderId) . '/capture', []);
if (($res['status'] ?? '') !== 'COMPLETED') { http_response_code(402); exit('The payment did not go through (' . htmlspecialchars($res['status'] ?? 'no answer') . '): nothing was charged.'); }
mark_order_paid($orderId);
` },
  },
  {
    id: 'import-no-shape', bucket: 'R', phase: 'T2', faults: 3, examples: ['PD-054', 'CW-043', 'SP-057'],
    title: 'An imported file is written to the database before its shape is checked',
    at: 'import.php',
    bad: { 'import.php': `<?php
require_admin();
$data = json_decode(file_get_contents($_FILES['file']['tmp_name']), true);
foreach ($data['clients'] as $c) {
  $db->prepare('INSERT INTO clients (name, email) VALUES (?, ?)')->execute([$c['name'], $c['email']]);
}
` },
    good: { 'import.php': `<?php
require_admin();
$data = json_decode(file_get_contents($_FILES['file']['tmp_name']), true);
if (!is_array($data) || !isset($data['clients']) || !is_array($data['clients'])) exit('This is not a client list exported from here.');
foreach ($data['clients'] as $i => $c) {
  if (!is_array($c) || !is_string($c['name'] ?? null) || !is_string($c['email'] ?? null)) exit('Client ' . ($i + 1) . ' has no name or email: nothing was imported.');
}
foreach ($data['clients'] as $c) {
  $db->prepare('INSERT INTO clients (name, email) VALUES (?, ?)')->execute([$c['name'], $c['email']]);
}
` },
  },
  {
    id: 'pdf-img-fixed-box', bucket: 'R', phase: 'T2', faults: 2, examples: ['PD-097'],
    title: 'A logo is drawn into a PDF at a fixed width AND height, so any other shape is squashed',
    at: 'invoice-pdf.php',
    bad: { 'invoice-pdf.php': `<?php
$pdf->Image($logoPath, 10, 10, 60, 30);
` },
    good: { 'invoice-pdf.php': `<?php
$pdf->Image($logoPath, 10, 10, 60, 0); // height 0: worked out from the logo's own shape
` },
  },
  {
    id: 'fetch-keepalive-big', bucket: 'R', phase: 'T2', faults: 1, examples: ['IN-012'],
    title: 'A save on page close uses keepalive with no size check (browsers drop keepalive bodies over 64 KB)',
    at: 'autosave.js',
    bad: { 'autosave.js': `window.addEventListener('pagehide', function () {
  fetch('/api/save', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
});
` },
    good: { 'autosave.js': `window.addEventListener('pagehide', function () {
  var body = JSON.stringify(state);
  if (body.length > 60000) return; // too big for a keepalive send: the regular save every 30 s covers it
  fetch('/api/save', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body });
});
` },
  },
  {
    id: 'big-file-no-validator', bucket: 'R', phase: 'T2', faults: 1, examples: ['IN-028'],
    title: 'A large data file is served with no ETag or Last-Modified, so every visit downloads it again',
    at: 'server.js',
    bad: { 'server.js': `const http = require('http');
const fs = require('fs');
http.createServer((req, res) => {
  if (req.url === '/data/catalogue.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return fs.createReadStream(__dirname + '/data/catalogue.json').pipe(res);
  }
  res.writeHead(404); res.end();
}).listen(8080, '127.0.0.1');
` },
    good: { 'server.js': `const http = require('http');
const fs = require('fs');
http.createServer((req, res) => {
  if (req.url === '/data/catalogue.json') {
    const st = fs.statSync(__dirname + '/data/catalogue.json');
    const etag = '"' + st.size + '-' + st.mtimeMs + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, 'Last-Modified': st.mtime.toUTCString() });
    return fs.createReadStream(__dirname + '/data/catalogue.json').pipe(res);
  }
  res.writeHead(404); res.end();
}).listen(8080, '127.0.0.1');
` },
  },
  {
    id: 'build-overwrites-release', bucket: 'R', phase: 'T2', faults: 6, examples: ['CW-044', 'SP-061', 'IN-031'],
    title: 'The build writes the release zip over one already made for that version (a shared zip changes under people)',
    at: 'tools/build.js',
    bad: { 'tools/build.js': `const fs = require('fs');
const path = require('path');
const VERSION = require('../package.json').version;
const out = path.join(__dirname, '..', 'releases', 'app-' + VERSION + '.zip');
fs.writeFileSync(out, makeZip());
` },
    good: { 'tools/build.js': `const fs = require('fs');
const path = require('path');
const VERSION = require('../package.json').version;
const out = path.join(__dirname, '..', 'releases', 'app-' + VERSION + '.zip');
if (fs.existsSync(out)) { console.error(out + ' already exists: raise the version before building again.'); process.exit(1); }
fs.writeFileSync(out, makeZip());
` },
  },
  {
    id: 'retry-after-missing', bucket: 'R', phase: 'T2', faults: 6, examples: ['JP-113', 'PD-007'],
    title: 'A "too many requests" answer gives no Retry-After, so neither people nor scripts know when to try again',
    at: 'api/search.php',
    bad: { 'api/search.php': `<?php
if (!rate_ok('search', $_SERVER['REMOTE_ADDR'], 30, 60)) {
  http_response_code(429);
  exit(json_encode(['error' => 'Too many searches.']));
}
` },
    good: { 'api/search.php': `<?php
if (!rate_ok('search', $_SERVER['REMOTE_ADDR'], 30, 60)) {
  http_response_code(429);
  header('Retry-After: 60');
  exit(json_encode(['error' => 'Too many searches: try again in a minute.']));
}
` },
  },
  {
    id: 'json-in-script-php', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-020'],
    title: 'Data is printed into a <script> with json_encode and no HEX flags, so a "</script>" in it breaks out',
    at: 'page.php',
    bad: { 'page.php': `<?php $settings = load_settings(); ?>
<script>window.APP = <?= json_encode($settings) ?>;</script>
` },
    good: { 'page.php': `<?php $settings = load_settings(); ?>
<script>window.APP = <?= json_encode($settings, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;</script>
` },
  },
  {
    id: 'json-in-script-js', bucket: 'R', phase: 'T2', faults: 1, examples: ['JP-060'],
    title: 'A Node page writes JSON.stringify output into a <script> without escaping "<"',
    at: 'render.js',
    bad: { 'render.js': `module.exports = function page(data) {
  return '<!doctype html><script>window.DATA = ' + JSON.stringify(data) + ';</script>';
};
` },
    good: { 'render.js': `module.exports = function page(data) {
  return '<!doctype html><script>window.DATA = ' + JSON.stringify(data).replace(/</g, '\\\\u003c') + ';</script>';
};
` },
  },
  {
    id: 'href-scheme', bucket: 'R', phase: 'T2', faults: 3, examples: ['JP-059', 'IP-096'],
    title: 'A link a user typed is printed as an href with only HTML escaping, so javascript: links run',
    at: 'profile.php',
    bad: { 'profile.php': `<?php $p = load_profile($id); ?>
<a href="<?= htmlspecialchars($p['website']) ?>" rel="nofollow">Website</a>
` },
    good: { 'profile.php': `<?php $p = load_profile($id);
$site = preg_match('~^https?://~i', $p['website']) ? $p['website'] : ''; ?>
<?php if ($site): ?><a href="<?= htmlspecialchars($site) ?>" rel="nofollow">Website</a><?php endif; ?>
` },
  },
  {
    id: 'hta-subfolder-https', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-032', 'SP-006'],
    title: 'A subfolder .htaccess turns its own rewrites on, which drops the site\'s https redirect for that folder',
    at: 'admin/.htaccess',
    bad: { '.htaccess': `RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
`, 'admin/.htaccess': `RewriteEngine On
RewriteRule ^report/([0-9]+)$ report.php?id=$1 [L]
` },
    good: { '.htaccess': `RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
`, 'admin/.htaccess': `RewriteEngine On
RewriteOptions InheritBefore
RewriteRule ^report/([0-9]+)$ report.php?id=$1 [L]
` },
  },
  {
    id: 'hta-php-flag', bucket: 'R', phase: 'T2', faults: 5, examples: ['IN-010', 'CS-014'],
    title: 'php_flag / php_value in .htaccess with no IfModule guard: a host running PHP as FPM answers 500 for every page',
    at: '.htaccess',
    bad: { '.htaccess': `php_flag display_errors off
php_value upload_max_filesize 20M
` },
    good: { '.htaccess': `<IfModule mod_php.c>
  php_flag display_errors off
  php_value upload_max_filesize 20M
</IfModule>
` },
  },
  {
    id: 'hta-blocks-well-known', bucket: 'R', phase: 'T2', faults: 2, examples: ['SP-023'],
    title: 'A rule that hides every dot-file also blocks /.well-known/, so certificate renewal fails',
    at: '.htaccess',
    bad: { '.htaccess': `RedirectMatch 404 /\\..*$
` },
    good: { '.htaccess': `RedirectMatch 404 /\\.(?!well-known/).*$
` },
  },
];
