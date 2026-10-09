// Museum, section 5b of the training plan: one-file fault classes no scanner here has a rule for yet (phase T2), and a
// few the Bridge's rules already catch (so the benchmark shows what works, not only what is missing).
'use strict';

module.exports = [
  // ---- 5b.2 success shown without checking the reply ----
  {
    id: 'fetch-success-no-ok', bucket: 'R', phase: 'T2', faults: 4, examples: ['JP-056', 'PD-061', 'CW-004'],
    title: '"Sent" is shown after a fetch without looking at the reply\'s status',
    at: 'contact.js',
    bad: { 'contact.js': `form.addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/api/contact', { method: 'POST', body: new FormData(form) })
    .then(function (r) { return r.json(); })
    .then(function () { status.textContent = 'Thanks, your message was sent.'; });
});
` },
    good: { 'contact.js': `form.addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/api/contact', { method: 'POST', body: new FormData(form) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) { status.textContent = x.ok ? 'Thanks, your message was sent.' : (x.j.error || 'The message was not sent.'); });
});
` },
  },
  {
    id: 'catch-fixed-text', bucket: 'R', phase: 'T2', faults: 5, examples: ['PD-091', 'PD-098', 'IP-285'],
    title: 'A failed request shows a fixed "Something went wrong" and drops the reason the server gave',
    at: 'booking.js',
    bad: { 'booking.js': `async function book(slot) {
  const r = await fetch('/api/book', { method: 'POST', body: JSON.stringify({ slot }) });
  if (!r.ok) { status.textContent = 'Something went wrong. Please try again.'; return; }
  status.textContent = 'Booked.';
}
` },
    good: { 'booking.js': `async function book(slot) {
  const r = await fetch('/api/book', { method: 'POST', body: JSON.stringify({ slot }) });
  if (!r.ok) {
    const j = await r.json().catch(function () { return {}; });
    status.textContent = j.error || ('The booking was not made (the server answered ' + r.status + '). Try another time.');
    return;
  }
  status.textContent = 'Booked.';
}
` },
  },
  {
    id: 'mail-result-ignored', bucket: 'R', phase: 'T2', faults: 1, examples: ['PD-061'],
    title: 'PHP says the message was sent without reading what mail() returned',
    at: 'send.php',
    bad: { 'send.php': `<?php
mail($to, $subject, $body, $headers);
$sent = true;
` },
    good: { 'send.php': `<?php
$sent = mail($to, $subject, $body, $headers);
if (!$sent) error_log('contact form: mail() refused the message');
` },
  },
  // ---- 5b.3 empty catch ----
  {
    id: 'empty-catch', bucket: 'R', phase: 'T2', faults: 8, examples: ['CW-049', 'SP-051', 'IN-005'],
    title: 'An empty catch hides a failed save, so the person thinks their draft is kept',
    at: 'draft.js',
    bad: { 'draft.js': `function keepDraft(draft) {
  try { localStorage.setItem('draft', JSON.stringify(draft)); } catch (e) {}
}
` },
    good: { 'draft.js': `function keepDraft(draft) {
  try { localStorage.setItem('draft', JSON.stringify(draft)); }
  catch (e) { note.textContent = 'This browser would not keep your draft (storage full or a private window): copy it before you leave.'; }
}
` },
  },
  // ---- 5b.4 check-then-insert race ----
  {
    id: 'race-check-then-write', bucket: 'R', phase: 'T2', faults: 6, examples: ['CW-001', 'CW-007', 'SP-003'],
    title: 'A voucher\'s remaining count is read, then spent in a second query: two clicks at once spend it twice',
    at: 'redeem.php',
    bad: { 'redeem.php': `<?php
$st = $db->prepare('SELECT remaining FROM vouchers WHERE code = ?');
$st->execute([$code]);
$left = $st->fetchColumn();
if ($left > 0) {
  $db->prepare('UPDATE vouchers SET remaining = remaining - 1 WHERE code = ?')->execute([$code]);
  grant_credit($userId);
}
` },
    good: { 'redeem.php': `<?php
$st = $db->prepare('UPDATE vouchers SET remaining = remaining - 1 WHERE code = ? AND remaining > 0');
$st->execute([$code]);
if ($st->rowCount() === 1) {
  grant_credit($userId);
}
` },
  },
  // ---- 5b.5 sign-in protocol gaps ----
  {
    id: 'oauth-state-optional', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-280'],
    title: 'The sign-in callback accepts any state when none was saved (a login link from someone else signs you in as them)',
    at: 'auth/callback.php',
    bad: { 'auth/callback.php': `<?php
session_start();
$saved = $_SESSION['oauth_state'] ?? '';
if (!$saved || ($_GET['state'] ?? '') === $saved) {
  finish_sign_in($_GET['code'] ?? '');
}
` },
    good: { 'auth/callback.php': `<?php
session_start();
$saved = $_SESSION['oauth_state'] ?? '';
unset($_SESSION['oauth_state']);
if (!$saved || !hash_equals($saved, (string)($_GET['state'] ?? ''))) { http_response_code(400); exit('This sign-in link has expired: start again from the Sign in button.'); }
finish_sign_in($_GET['code'] ?? '');
` },
  },
  {
    id: 'oauth-email-unverified', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-028', 'IP-029'],
    title: 'A sign-in provider\'s email is trusted without email_verified, and the account is found by email instead of the provider\'s id',
    at: 'auth/google.php',
    bad: { 'auth/google.php': `<?php
$claims = verify_id_token($_POST['credential']);
$user = find_user_by_email($claims['email']);
sign_in($user);
` },
    good: { 'auth/google.php': `<?php
$claims = verify_id_token($_POST['credential']);
if (empty($claims['email_verified'])) exit('Google has not confirmed this email address yet.');
$user = find_user_by_provider('google', $claims['sub']);
sign_in($user);
` },
  },
  {
    id: 'cors-subdomain-credentials', bucket: 'R', phase: 'T2', faults: 4, examples: ['PD-036', 'PD-077'],
    title: 'CORS lets any subdomain call the API with the visitor\'s cookies',
    at: 'api/cors.php',
    bad: { 'api/cors.php': `<?php
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (preg_match('~\\.example-shop\\.com$~', $origin)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Access-Control-Allow-Credentials: true');
}
` },
    good: { 'api/cors.php': `<?php
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ['https://example-shop.com', 'https://www.example-shop.com'], true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Access-Control-Allow-Credentials: true');
}
` },
  },
  // ---- 5b.6 links built from the request ----
  {
    id: 'link-from-host-header', bucket: 'R', phase: 'T2', faults: 6, examples: ['IP-005', 'IP-094', 'CS-008'],
    title: 'A password-reset link is built from the Host header, so a forged request mails a link to someone else\'s site',
    at: 'forgot.php',
    bad: { 'forgot.php': `<?php
$link = 'https://' . $_SERVER['HTTP_HOST'] . '/reset.php?token=' . $token;
send_mail($email, 'Reset your password', 'Open ' . $link);
` },
    good: { 'forgot.php': `<?php
$link = SITE_URL . '/reset.php?token=' . $token;
send_mail($email, 'Reset your password', 'Open ' . $link);
` },
  },
  // ---- 5b.7 secrets ----
  {
    id: 'secret-compare-not-constant', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-027', 'PD-035'],
    title: 'A secret key is compared with !== (leaks how much of it matched, by timing)',
    at: 'cron.php',
    bad: { 'cron.php': `<?php
if (($_SERVER['HTTP_X_CRON_KEY'] ?? '') !== CRON_KEY) { http_response_code(403); exit; }
run_jobs();
` },
    good: { 'cron.php': `<?php
if (!hash_equals(CRON_KEY, (string)($_SERVER['HTTP_X_CRON_KEY'] ?? ''))) { http_response_code(403); exit; }
run_jobs();
` },
  },
  {
    id: 'secret-from-query-stored', bucket: 'R', phase: 'T2', faults: 6, examples: ['IP-090', 'IP-105', 'JP-038'],
    title: 'A sign-in token arrives in the address and is kept in localStorage (history, logs and any script can read it)',
    at: 'welcome.js',
    bad: { 'welcome.js': `const token = new URLSearchParams(location.search).get('token');
if (token) localStorage.setItem('session_token', token);
` },
    good: { 'welcome.js': `const token = new URLSearchParams(location.search).get('token');
history.replaceState(null, '', location.pathname); // the token leaves the address bar and history at once
if (token) fetch('/api/exchange', { method: 'POST', body: JSON.stringify({ token: token }), credentials: 'same-origin' }); // answered with an HttpOnly cookie
` },
  },
  // ---- 5b.8 limiter keyed on what the caller controls ----
  {
    id: 'rate-key-xff', bucket: 'R', phase: 'done', faults: 2, examples: ['IP-003'],
    title: 'The visitor address for a limit is read from X-Forwarded-For, which the visitor writes',
    at: 'limit.php',
    bad: { 'limit.php': `<?php
$ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'];
if (!rate_ok('contact', $ip, 5, 3600)) exit('Too many messages from you today.');
` },
    good: { 'limit.php': `<?php
$ip = $_SERVER['REMOTE_ADDR'];
if (!rate_ok('contact', $ip, 5, 3600)) exit('Too many messages from you today.');
` },
  },
  {
    id: 'rate-key-cf-unchecked', bucket: 'R', phase: 'T2', faults: 4, examples: ['IP-298'],
    title: 'CF-Connecting-IP is trusted without checking the request came from Cloudflare',
    at: 'client-ip.php',
    bad: { 'client-ip.php': `<?php
function client_ip() {
  return $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'];
}
` },
    good: { 'client-ip.php': `<?php
function client_ip() {
  $peer = $_SERVER['REMOTE_ADDR'];
  if (isset($_SERVER['HTTP_CF_CONNECTING_IP']) && ip_in_ranges($peer, CLOUDFLARE_RANGES)) return $_SERVER['HTTP_CF_CONNECTING_IP'];
  return $peer;
}
` },
  },
  {
    id: 'rate-key-ipv6-full', bucket: 'R', phase: 'T2', faults: 4, examples: ['IP-237', 'PD-070'],
    title: 'A limit is keyed on the full IPv6 address (one home has billions of them)',
    at: 'throttle.php',
    bad: { 'throttle.php': `<?php
$key = 'rl_signup_' . $_SERVER['REMOTE_ADDR'];
if ((int)apcu_fetch($key) >= 3) exit('Too many sign-ups from here.');
apcu_inc($key, 1, $ok, 3600);
` },
    good: { 'throttle.php': `<?php
$ip = $_SERVER['REMOTE_ADDR'];
$bin = inet_pton($ip);
$key = 'rl_signup_' . (strlen($bin) === 16 ? bin2hex(substr($bin, 0, 8)) : $ip); // IPv6: the /64 a home is given
if ((int)apcu_fetch($key) >= 3) exit('Too many sign-ups from here.');
apcu_inc($key, 1, $ok, 3600);
` },
  },
  // ---- 5b.9 money and PDF numbers ----
  {
    id: 'money-int-cast', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-062', 'IP-064'],
    title: 'A rate is cast to (int) and the total printed with no cents',
    at: 'invoice.php',
    bad: { 'invoice.php': `<?php
$rate = (int)$item['rate'];
$line = $rate * $item['hours'];
echo number_format($line, 0);
` },
    good: { 'invoice.php': `<?php
$rate = (float)$item['rate'];
$line = round($rate * $item['hours'], 2);
echo number_format($line, 2);
` },
  },
  {
    id: 'pdf-core-font', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-072', 'IP-078'],
    title: 'A PDF uses a built-in Latin-1 font with utf8_decode, so names in other scripts print as "?"',
    at: 'pdf.php',
    bad: { 'pdf.php': `<?php
$pdf->SetFont('Helvetica', '', 11);
$pdf->Cell(0, 6, utf8_decode($client['name']));
` },
    good: { 'pdf.php': `<?php
$pdf->AddFont('DejaVu', '', 'DejaVuSans.ttf', true);
$pdf->SetFont('DejaVu', '', 11);
$pdf->Cell(0, 6, $client['name']);
` },
  },
  // ---- 5b.10 tracker before consent ----
  {
    id: 'tracker-no-consent', bucket: 'R', phase: 'done', faults: 2, examples: ['PD-017'],
    title: 'An analytics tag loads with the page, before any consent',
    at: 'index.html',
    bad: { 'index.html': `<!doctype html><title>Shop</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-MUSEUM01"></script>
<h1>Shop</h1>
` },
    good: { 'index.html': `<!doctype html><title>Shop</title>
<h1>Shop</h1>
<button id="allow">Allow statistics</button>
<script src="/consent.js"></script>
`, 'consent.js': `document.getElementById('allow').addEventListener('click', function () {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-MUSEUM01';
  document.head.appendChild(s);
});
` },
  },
  {
    id: 'tracker-cookie-word', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-047', 'PD-041'],
    title: 'An analytics tag loads before consent, beside a cookie banner (the word "cookie" nearby silences today\'s rule)',
    at: 'index.html',
    bad: { 'index.html': `<!doctype html><title>Shop</title>
<div id="cookie-banner">We use cookies for statistics. <button id="allow">Allow</button></div>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-MUSEUM01"></script>
<h1>Shop</h1>
` },
    good: { 'index.html': `<!doctype html><title>Shop</title>
<div id="cookie-banner">We use cookies for statistics. <button id="allow">Allow</button></div>
<script src="/consent.js"></script>
<h1>Shop</h1>
`, 'consent.js': `document.getElementById('allow').addEventListener('click', function () {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-MUSEUM01';
  document.head.appendChild(s);
});
` },
  },
  // ---- 5b.11 input shape and length ----
  {
    id: 'json-shape-unchecked', bucket: 'R', phase: 'T2', faults: 5, examples: ['IP-085', 'IP-087', 'IP-099'],
    title: 'A JSON body is used with no is_array / type check (an array or number where text was expected answers 500)',
    at: 'api/rename.php',
    bad: { 'api/rename.php': `<?php
$raw = file_get_contents('php://input', false, null, 0, 65537);
if (strlen($raw) > 65536) { http_response_code(413); exit; }
$in = json_decode($raw, true);
$name = trim($in['name']);
rename_project((int)$in['id'], $name);
` },
    good: { 'api/rename.php': `<?php
$raw = file_get_contents('php://input', false, null, 0, 65537);
if (strlen($raw) > 65536) { http_response_code(413); exit; }
$in = json_decode($raw, true);
if (!is_array($in) || !is_string($in['name'] ?? null) || !is_int($in['id'] ?? null)) { http_response_code(400); exit('Send {"id": number, "name": text}.'); }
$name = trim($in['name']);
rename_project($in['id'], $name);
` },
  },
  {
    id: 'number-no-upper-cap', bucket: 'R', phase: 'T2', faults: 6, examples: ['PD-055', 'IP-117'],
    title: 'A quantity has a floor but no ceiling (one typo orders 10,000,000)',
    at: 'cart.js',
    bad: { 'cart.js': `function quantity(input) {
  return Math.max(1, Math.round(Number(input.value) || 1));
}
` },
    good: { 'cart.js': `function quantity(input) {
  return Math.min(99, Math.max(1, Math.round(Number(input.value) || 1)));
}
` },
  },
  // ---- 5b.12 storage outside try, unbounded queries ----
  {
    id: 'storage-read-outside-try', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-072', 'PD-092'],
    title: 'Saved settings are read and parsed outside a try (a blocked or broken value stops the whole page)',
    at: 'prefs.js',
    bad: { 'prefs.js': `const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
applyTheme(prefs.theme);
` },
    good: { 'prefs.js': `let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('prefs') || '{}') || {}; } catch (e) { prefs = {}; }
applyTheme(prefs.theme);
` },
  },
  {
    id: 'query-no-limit', bucket: 'R', phase: 'T2', faults: 5, examples: ['PD-053', 'PD-080', 'IP-172'],
    title: 'Every row is fetched and the page is cut out in PHP, instead of LIMIT in the query',
    at: 'bookings.php',
    bad: { 'bookings.php': `<?php
$rows = $db->query('SELECT * FROM bookings ORDER BY created DESC')->fetchAll();
$page = array_slice($rows, $offset, 20);
` },
    good: { 'bookings.php': `<?php
$st = $db->prepare('SELECT * FROM bookings ORDER BY created DESC LIMIT 20 OFFSET ?');
$st->bindValue(1, $offset, PDO::PARAM_INT);
$st->execute();
$page = $st->fetchAll();
` },
  },
  // ---- 5b.13 small ones ----
  {
    id: 'webhook-200-bad-signature', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-020'],
    title: 'A webhook with a bad signature is answered 200, so the sender never finds out',
    at: 'hooks/pay.php',
    bad: { 'hooks/pay.php': `<?php
$payload = file_get_contents('php://input', false, null, 0, 262144);
if (!verify_signature($payload, $_SERVER['HTTP_X_SIGNATURE'] ?? '')) {
  error_log('payment hook: bad signature');
  http_response_code(200);
  exit;
}
handle_event(json_decode($payload, true));
` },
    good: { 'hooks/pay.php': `<?php
$payload = file_get_contents('php://input', false, null, 0, 262144);
if (!verify_signature($payload, $_SERVER['HTTP_X_SIGNATURE'] ?? '')) {
  error_log('payment hook: bad signature');
  http_response_code(400);
  exit;
}
handle_event(json_decode($payload, true));
` },
  },
  {
    id: 'stripe-livemode-unchecked', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-311'],
    title: 'A Stripe event is acted on without checking livemode (a test payment unlocks a real order)',
    at: 'hooks/stripe.php',
    bad: { 'hooks/stripe.php': `<?php
$event = \\Stripe\\Webhook::constructEvent($payload, $sig, WEBHOOK_SECRET);
if ($event->type === 'checkout.session.completed') mark_paid($event->data->object->client_reference_id);
` },
    good: { 'hooks/stripe.php': `<?php
$event = \\Stripe\\Webhook::constructEvent($payload, $sig, WEBHOOK_SECRET);
if ($event->livemode !== (STRIPE_MODE === 'live')) { http_response_code(200); exit; } // a test event on the live site (or the reverse) changes nothing
if ($event->type === 'checkout.session.completed') mark_paid($event->data->object->client_reference_id);
` },
  },
  {
    id: 'postmessage-star', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-022'],
    title: 'postMessage with "*" sends the visitor\'s details to whatever page framed this one',
    at: 'embed.js',
    bad: { 'embed.js': `parent.postMessage({ type: 'signed-in', email: user.email }, '*');
` },
    good: { 'embed.js': `parent.postMessage({ type: 'signed-in', email: user.email }, 'https://example-shop.com');
` },
  },
  {
    id: 'repeated-field-no-brackets', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-221'],
    title: 'Several checkboxes share a name without [], so PHP keeps only the last one ticked',
    at: 'filter.html',
    bad: { 'filter.html': `<form method="get" action="/search.php">
  <label><input type="checkbox" name="tag" value="grand"> Grand</label>
  <label><input type="checkbox" name="tag" value="upright"> Upright</label>
  <button>Search</button>
</form>
` },
    good: { 'filter.html': `<form method="get" action="/search.php">
  <label><input type="checkbox" name="tag[]" value="grand"> Grand</label>
  <label><input type="checkbox" name="tag[]" value="upright"> Upright</label>
  <button>Search</button>
</form>
` },
  },
  {
    id: 'iso-date-as-today', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-287'],
    title: 'toISOString().slice(0, 10) is used as "today" (it is the UTC date: wrong for hours each day east or west of London)',
    at: 'diary.js',
    bad: { 'diary.js': `const today = new Date().toISOString().slice(0, 10);
` },
    good: { 'diary.js': `const d = new Date();
const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
` },
  },
  {
    id: 'delete-no-confirm', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-091', 'IP-121'],
    title: 'A Delete button removes a client at once, with no confirm and no undo',
    at: 'clients.js',
    bad: { 'clients.js': `deleteButton.addEventListener('click', function () {
  fetch('/api/clients/' + client.id, { method: 'DELETE' }).then(function (r) { if (r.ok) reload(); else showError(r); });
});
` },
    good: { 'clients.js': `deleteButton.addEventListener('click', function () {
  if (!confirm('Delete ' + client.name + '? This cannot be undone.')) return;
  fetch('/api/clients/' + client.id, { method: 'DELETE' }).then(function (r) { if (r.ok) reload(); else showError(r); });
});
` },
  },
  {
    id: 'cli-tool-in-webroot', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-167', 'IP-168'],
    title: 'A command-line tool sits in the web folder with no PHP_SAPI check, so anyone can run it by address',
    at: 'public/tools/reindex.php',
    bad: { 'public/tools/reindex.php': `<?php
require __DIR__ . '/../../config.php';
reindex_everything();
` },
    good: { 'public/tools/reindex.php': `<?php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/../../config.php';
reindex_everything();
` },
  },
  {
    id: 'back-is-history', bucket: 'R', phase: 'T2', faults: 2, examples: ['IP-139', 'IP-316'],
    title: 'A bare "Back" button calls history.back() (from a shared link it leaves the site)',
    at: 'client.html',
    bad: { 'client.html': `<!doctype html><title>Client</title>
<button type="button" id="back">Back</button>
<script>document.getElementById('back').addEventListener('click', function () { history.back(); });</script>
` },
    good: { 'client.html': `<!doctype html><title>Client</title>
<a href="/clients/">Back to Clients</a>
` },
  },
  {
    id: 'sw-constant-cache', bucket: 'R', phase: 'T2', faults: 2, examples: ['IP-313'],
    title: 'The service worker\'s cache name never changes, so visitors keep the old files after an update',
    at: 'sw.js',
    bad: { 'sw.js': `const CACHE = 'app-cache';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/app.js']))));
` },
    good: { 'sw.js': `const CACHE = 'app-cache-1.4.2'; // the release version: a new release opens a new cache and the old one is removed
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/app.js']))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));
` },
  },
  {
    id: 'fixed-temp-file', bucket: 'R', phase: 'T2', faults: 1, examples: ['SC-010'],
    title: 'A temp file has a fixed name, so two runs at once overwrite each other (and another user can plant it)',
    at: 'export.js',
    bad: { 'export.js': `const tmp = path.join(os.tmpdir(), 'export.csv');
fs.writeFileSync(tmp, csv);
` },
    good: { 'export.js': `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
const tmp = path.join(dir, 'export.csv');
fs.writeFileSync(tmp, csv);
` },
  },
  {
    id: 'log-injection', bucket: 'R', phase: 'T2', faults: 1, examples: ['SP-017'],
    title: 'A typed email goes into the log as is, so a line break in it writes fake log lines',
    at: 'signin.php',
    bad: { 'signin.php': `<?php
error_log('Sign-in failed for ' . $_POST['email']);
` },
    good: { 'signin.php': `<?php
error_log('Sign-in failed for ' . json_encode((string)($_POST['email'] ?? '')));
` },
  },
  {
    id: 'symbol-not-imported', bucket: 'R', phase: 'T2', faults: 2, examples: ['SP-046'],
    title: 'A component is used without being imported (the page breaks when that branch shows)',
    at: 'src/Settings.jsx',
    bad: { 'src/Settings.jsx': `import React from 'react';
export default function Settings({ open }) {
  return open ? <Modal title="Settings">Choose a theme</Modal> : null;
}
` },
    good: { 'src/Settings.jsx': `import React from 'react';
import Modal from './Modal';
export default function Settings({ open }) {
  return open ? <Modal title="Settings">Choose a theme</Modal> : null;
}
` },
  },
  {
    id: 'font-below-floor', bucket: 'R', phase: 'T2', faults: 2, examples: ['JP-048'],
    title: 'Text set below 12px',
    at: 'style.css',
    bad: { 'style.css': `.small-print { font-size: 10px; }
` },
    good: { 'style.css': `.small-print { font-size: 12px; }
` },
  },
  {
    id: 'modal-no-dialog-role', bucket: 'R', phase: 'T2', faults: 3, examples: ['JP-099', 'PD-097'],
    title: 'A pop-up has no role="dialog" and no Escape, so screen readers and keyboards are lost in it',
    at: 'edit.html',
    bad: { 'edit.html': `<div class="modal" id="edit">
  <h2>Edit client</h2>
  <button class="close">Close</button>
</div>
` },
    good: { 'edit.html': `<div class="modal" id="edit" role="dialog" aria-modal="true" aria-labelledby="edit-title">
  <h2 id="edit-title">Edit client</h2>
  <button class="close">Close</button>
</div>
<script>document.addEventListener('keydown', function (e) { if (e.key === 'Escape') document.getElementById('edit').hidden = true; });</script>
` },
  },
  {
    id: 'img-no-dimensions', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-318'],
    title: 'An image has no width and height, so the page jumps as it loads',
    at: 'about.html',
    bad: { 'about.html': `<img src="/shop-front.jpg" alt="The shop from the street">
` },
    good: { 'about.html': `<img src="/shop-front.jpg" alt="The shop from the street" width="1200" height="800">
` },
  },
  {
    id: 'label-not-tied', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-317'],
    title: 'A label is not tied to its field (no for=, not wrapped), so a screen reader reads the field unnamed',
    at: 'newsletter.html',
    bad: { 'newsletter.html': `<label>Email</label>
<input id="email" type="email" name="email">
` },
    good: { 'newsletter.html': `<label for="email">Email</label>
<input id="email" type="email" name="email">
` },
  },
  {
    id: 'csv-formula', bucket: 'R', phase: 'T2', faults: 2, examples: ['CW-052'],
    title: 'A CSV export writes typed text as is, so "=HYPERLINK(...)" runs when the file opens in a spreadsheet',
    at: 'export.php',
    bad: { 'export.php': `<?php
foreach ($clients as $c) fputcsv($out, [$c['name'], $c['email'], $c['notes']]);
` },
    good: { 'export.php': `<?php
$cell = fn($v) => preg_match('/^[=+\\-@\\t\\r]/', (string)$v) ? "'" . $v : $v;
foreach ($clients as $c) fputcsv($out, array_map($cell, [$c['name'], $c['email'], $c['notes']]));
` },
  },
  {
    id: 'ssrf-filter-var-only', bucket: 'R', phase: 'T2', faults: 3, examples: ['IP-095', 'IP-257'],
    title: 'A typed address is fetched after only filter_var (http://127.0.0.1 and the cloud\'s metadata address pass)',
    at: 'preview.php',
    bad: { 'preview.php': `<?php
$url = (string)($_POST['url'] ?? '');
if (!filter_var($url, FILTER_VALIDATE_URL)) exit('That is not a web address.');
$html = fetch_page($url);
` },
    good: { 'preview.php': `<?php
$url = (string)($_POST['url'] ?? '');
if (!filter_var($url, FILTER_VALIDATE_URL)) exit('That is not a web address.');
$ip = gethostbyname(parse_url($url, PHP_URL_HOST));
if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) exit('That address is on a private network, so it is not fetched.');
$html = fetch_page($url, $ip); // connects to the address checked above, not a fresh lookup
` },
  },
  {
    id: 'reply-to-from-input', bucket: 'R', phase: 'T2', faults: 1, examples: ['SP-016'],
    title: 'A typed email goes into a mail header unchecked (a line break in it adds headers)',
    at: 'enquiry.php',
    bad: { 'enquiry.php': `<?php
if (!rate_ok('enquiry', $_SERVER['REMOTE_ADDR'], 5, 3600) || !rate_ok('enquiry-all', 'site', 200, 86400)) exit('Too many messages today: please email us instead.');
$headers = 'Reply-To: ' . $_POST['email'];
if (!mail(SHOP_EMAIL, 'Enquiry', $_POST['message'], $headers)) exit('The message did not go: please email us instead.');
` },
    good: { 'enquiry.php': `<?php
if (!rate_ok('enquiry', $_SERVER['REMOTE_ADDR'], 5, 3600) || !rate_ok('enquiry-all', 'site', 200, 86400)) exit('Too many messages today: please email us instead.');
$email = filter_var($_POST['email'] ?? '', FILTER_VALIDATE_EMAIL);
$headers = $email ? 'Reply-To: ' . $email : '';
if (!mail(SHOP_EMAIL, 'Enquiry', $_POST['message'], $headers)) exit('The message did not go: please email us instead.');
` },
  },
  {
    id: 'exception-text-out', bucket: 'R', phase: 'T2', faults: 2, examples: ['IP-155', 'IP-264'],
    title: 'An exception\'s own text is sent to the visitor (it can hold paths, SQL and keys)',
    at: 'api/save.php',
    bad: { 'api/save.php': `<?php
try { save_all($in); }
catch (Throwable $e) { http_response_code(500); echo json_encode(['error' => $e->getMessage()]); }
` },
    good: { 'api/save.php': `<?php
try { save_all($in); }
catch (Throwable $e) { error_log('save: ' . $e->getMessage()); http_response_code(500); echo json_encode(['error' => 'Saving failed on the server; nothing was changed. Try again in a minute.']); }
` },
  },
  {
    id: 'account-enumeration', bucket: 'R', phase: 'T2', faults: 1, examples: ['PD-036'],
    title: 'The reset form says whether an email has an account',
    at: 'reset-request.php',
    bad: { 'reset-request.php': `<?php
$user = find_user_by_email($_POST['email'] ?? '');
if (!$user) exit('There is no account with that email.');
send_reset($user);
exit('We have sent you a link.');
` },
    good: { 'reset-request.php': `<?php
$user = find_user_by_email($_POST['email'] ?? '');
if ($user) send_reset($user);
exit('If that email has an account, a link is on its way.');
` },
  },
  {
    id: 'sri-missing', bucket: 'R', phase: 'T2', faults: 1, examples: ['JP-096'],
    title: 'A script from a public CDN loads with no integrity check',
    at: 'chart.html',
    bad: { 'chart.html': `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
` },
    good: { 'chart.html': `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" integrity="sha384-museumexamplehashvalueforthetestonly000000000000000000000000" crossorigin="anonymous"></script>
` },
  },
  {
    id: 'utf8-byte-cut', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-062'],
    title: 'Text is cut with substr, which can split a character in half (a broken character in the page or email)',
    at: 'card.php',
    bad: { 'card.php': `<?php
echo htmlspecialchars(substr($bio, 0, 160));
` },
    good: { 'card.php': `<?php
echo htmlspecialchars(mb_substr($bio, 0, 160));
` },
  },
  {
    id: 'regex-from-input', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-139'],
    title: 'What a person types becomes a regular expression (a "(" breaks the search, a crafted one hangs the page)',
    at: 'search.js',
    bad: { 'search.js': `const re = new RegExp(box.value, 'i');
rows.forEach(r => { r.hidden = !re.test(r.textContent); });
` },
    good: { 'search.js': `const re = new RegExp(box.value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'i');
rows.forEach(r => { r.hidden = !re.test(r.textContent); });
` },
  },
  {
    id: 'upload-stored-before-check', bucket: 'R', phase: 'T2', faults: 1, examples: ['CW-029'],
    title: 'An upload is moved into the public folder first and checked afterwards (for a moment it can be run)',
    at: 'attach.php',
    bad: { 'attach.php': `<?php
$dest = __DIR__ . '/files/' . basename($_FILES['file']['name']);
move_uploaded_file($_FILES['file']['tmp_name'], $dest);
if (!getimagesize($dest)) { unlink($dest); exit('Images only.'); }
` },
    good: { 'attach.php': `<?php
if (!getimagesize($_FILES['file']['tmp_name'])) exit('Images only.');
$dest = __DIR__ . '/files/' . bin2hex(random_bytes(8)) . '.jpg';
move_uploaded_file($_FILES['file']['tmp_name'], $dest);
` },
  },
  // ---- 5b.14 rules that exist but never fire on this kind of code ----
  {
    id: 'csrf-json-post', bucket: 'R', phase: 'T2', faults: 3, examples: ['PD-077', 'IP-300'],
    title: 'A JSON API takes a cookie session marked SameSite=None and checks no Origin (another site can post to it)',
    at: 'server.js',
    bad: { 'server.js': `function signIn(res, sid) {
  res.setHeader('Set-Cookie', 'sid=' + sid + '; HttpOnly; Secure; SameSite=None; Path=/');
}
function transfer(req, res) {
  const user = userFromCookie(req);
  readJson(req).then(body => moveCredit(user, body.to, body.amount)).then(() => res.end('{"ok":true}'));
}
` },
    good: { 'server.js': `function signIn(res, sid) {
  res.setHeader('Set-Cookie', 'sid=' + sid + '; HttpOnly; Secure; SameSite=Lax; Path=/');
}
function transfer(req, res) {
  if (req.headers.origin !== 'https://example-shop.com') { res.statusCode = 403; return res.end('{"error":"Sent from another site, so refused."}'); }
  const user = userFromCookie(req);
  readJson(req).then(body => moveCredit(user, body.to, body.amount)).then(() => res.end('{"ok":true}'));
}
` },
  },
  {
    id: 'redirect-via-variable', bucket: 'R', phase: 'T2', faults: 1, examples: ['IP-094'],
    title: 'An open redirect where the request value goes through a variable first (today\'s rule reads only $_GET in the same call)',
    at: 'go.php',
    bad: { 'go.php': `<?php
$next = $_REQUEST['next'] ?? '/';
header('Location: ' . $next);
` },
    good: { 'go.php': `<?php
$next = (string)($_REQUEST['next'] ?? '/');
if (!str_starts_with($next, '/') || str_starts_with($next, '//') || str_contains($next, chr(92))) $next = '/'; // only a path on this site
header('Location: ' . $next);
` },
  },
  // ---- caught today (kept so the benchmark shows them) ----
  {
    id: 'innerhtml-from-fetch', bucket: 'R', phase: 'done', faults: 1, examples: ['IP-118'],
    title: 'Data from the server is put into the page as HTML without escaping',
    at: 'list.js',
    bad: { 'list.js': `async function show() {
  const r = await fetch('/api/items');
  const items = await r.json();
  list.innerHTML = items.map(i => '<li>' + i.name + '</li>').join('');
}
` },
    good: { 'list.js': `async function show() {
  const r = await fetch('/api/items');
  const items = await r.json();
  list.replaceChildren(...items.map(i => { const li = document.createElement('li'); li.textContent = i.name; return li; }));
}
` },
  },
  {
    id: 'secret-key-in-public-js', bucket: 'R', phase: 'done', faults: 1, examples: ['SP-033'],
    title: 'A live payment secret key sits in a file the browser downloads',
    at: 'public/config.js',
    bad: { 'public/config.js': `window.PAY = { key: '{{SKLIVE}}' };
` },
    good: { 'public/config.js': `window.PAY = { checkoutUrl: '/api/checkout' }; // the secret key stays on the server
` },
  },
  {
    id: 'skip-check-when-key-empty', bucket: 'R', phase: 'T2', faults: 2, examples: ['IP-114', 'IP-297'],
    title: 'The spam check is skipped when its secret is not set (an empty setting turns protection off silently)',
    at: 'signup.php',
    bad: { 'signup.php': `<?php
if (SPAM_CHECK_SECRET !== '' && !spam_check_ok($_POST['spam-token'] ?? '')) exit('The spam check failed.');
create_account($_POST);
` },
    good: { 'signup.php': `<?php
if (SPAM_CHECK_SECRET === '') { error_log('signup: SPAM_CHECK_SECRET is not set'); http_response_code(503); exit('Sign-up is paused while the spam check is set up.'); }
if (!spam_check_ok($_POST['spam-token'] ?? '')) exit('The spam check failed.');
create_account($_POST);
` },
  },
];
