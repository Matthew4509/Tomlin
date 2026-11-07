// Self-test for lib/rules-more.js: every rule gets a should-fire file and a must-stay-quiet file, written differently
// from the museum's copies (test/museum/), so a rule that only matches its museum fixture shows up here.
// Run: node test/rules-more.test.js   (no packages). Names are made up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runAudit, RULES } = require('../../src/bridge/audit');
const { RULES_MORE } = require('../../src/bridge/rules-more');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

// A signed token of the shape Supabase hands out, made up and put together here.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (role, iss = 'supabase') => [b64({ alg: 'HS256', typ: 'JWT' }), b64({ iss, ref: 'madeupproject', role }), 'madeUpSignatureNotARealOne_0123456789'].join('.');

// [rule, file, fires, stays quiet]
const PAIRS = [
  ['IMG-001', 'thumb.php', `<?php\n$src = imagecreatefrompng($path);\nimagepng(imagescale($src, 200), $out);\n`,
    `<?php\n[$w, $h] = getimagesize($path);\nif ($w * $h > MAX_PIXELS) throw new RuntimeException('too many pixels');\n$src = imagecreatefrompng($path);\n`],
  ['IMG-002', 'profile.php', `<?php\nif (exif_imagetype($_FILES['p']['tmp_name']) !== IMAGETYPE_JPEG) exit;\nmove_uploaded_file($_FILES['p']['tmp_name'], "photos/$id.jpg");\n`,
    `<?php\nif (exif_imagetype($_FILES['p']['tmp_name']) !== IMAGETYPE_JPEG) exit;\nif (!fits_budget($_FILES['p']['tmp_name'])) exit;\n$im = imagecreatefromjpeg($_FILES['p']['tmp_name']);\nimagejpeg($im, "photos/$id.jpg");\n`],
  ['IMG-003', 'decode.php', `<?php\n$bytes = $jpeg;\n$im = @imagecreatefromstring($bytes);\n`, `<?php\n$size = getimagesizefromstring($bytes);\n$im = imagecreatefromstring($bytes);\nif (!$im) exit('That image is damaged.');\n`],
  ['ZIP-001', 'unpack.php', `<?php\n$z = new ZipArchive; $z->open($file);\n$z->extractTo($dest);\n`,
    `<?php\n$z = new ZipArchive; $z->open($file);\nfor ($i = 0; $i < $z->numFiles; $i++) { if ($z->statIndex($i)['size'] > LIMIT) exit; }\n$z->extractTo($dest);\n`],
  ['ZIP-002', 'inflate.php', `<?php\n$data = gzdecode($blob);\n`, `<?php\n$data = gzdecode($blob, 10000000);\n`],
  ['UPL-002', 'docs.php', `<?php\nif (!isset($_FILES['doc'])) { $err = 'Pick a file first.'; }\n`,
    `<?php\nif ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0 && !$_FILES) { http_response_code(413); }\nelseif (!isset($_FILES['doc'])) { $err = 'Pick a file first.'; }\n`],
  ['UPL-003', 'store.php', `<?php\nmove_uploaded_file($t, $target);\n$type = mime_content_type($target);\nif ($type !== 'image/png') unlink($target);\n`,
    `<?php\n$type = mime_content_type($_FILES['f']['tmp_name']);\nif ($type !== 'image/png') exit;\nmove_uploaded_file($t, $target);\n`],
  ['REQ-001', 'hook.php', `<?php\n$body = file_get_contents("php://input");\n`, `<?php\n$body = file_get_contents('php://input', false, null, 0, 1048577);\n`],
  ['GET-001', 'account/signout.php', `<?php\nsession_start();\nsession_destroy();\nheader('Location: /');\n`,
    `<?php\nsession_start();\nif ($_SERVER['REQUEST_METHOD'] !== 'POST') exit;\nsession_destroy();\n`],
  ['GET-002', 'confirm.php', `<?php\n$id = (int)$_GET['id'];\n$db->prepare("DELETE FROM bookings WHERE id = ?")->execute([$id]);\n`,
    `<?php\n$id = (int)$_GET['id'];\n$db->prepare("UPDATE pages SET views = views + 1 WHERE id = ?")->execute([$id]);\n`],
  ['AUTH-004', 'ip.php', `<?php\n$ip = $_SERVER['HTTP_TRUE_CLIENT_IP'] ?? $_SERVER['REMOTE_ADDR'];\n`,
    `<?php\n$ip = cidr_match($_SERVER['REMOTE_ADDR'], $edge) ? $_SERVER['HTTP_TRUE_CLIENT_IP'] : $_SERVER['REMOTE_ADDR'];\n`],
  ['AUTH-005', 'signin.js', `const key = 'attempts:' + req.body.email;\n`, `const key = 'attempts:' + prefix64(req.ip) + ':' + req.body.email;\n`],
  ['AUTH-006', 'limit.js', `const bucket = 'rate:' + req.ip;\n`, `const bucket = 'rate:' + prefix64(req.ip);\n`],
  ['AUTH-007', 'pw.php', `<?php\n$db->prepare('UPDATE users SET pass = ? WHERE id = ?')->execute([password_hash($_POST['password'], PASSWORD_BCRYPT), $uid]);\n`,
    `<?php\nif (!password_verify($_POST['old_password'], $row['pass'])) exit;\n$db->prepare('UPDATE users SET pass = ? WHERE id = ?')->execute([password_hash($_POST['password'], PASSWORD_BCRYPT), $uid]);\nsession_regenerate_id(true);\n`],
  ['AUTH-008', 'reset.php', `<?php\n$db->prepare("UPDATE users SET password = ? WHERE id = ?")->execute([$h, $uid]);\n`,
    `<?php\n$db->prepare("UPDATE users SET password = ? WHERE id = ?")->execute([$h, $uid]);\n$db->prepare("DELETE FROM sessions WHERE user_id = ?")->execute([$uid]);\n`],
  ['AUTH-009', 'admin-key.php', `<?php\nif ($_GET['key'] != ADMIN_KEY) exit;\n`, `<?php\nif (!hash_equals(ADMIN_KEY, (string)($_GET['key'] ?? ''))) exit;\n`],
  ['AUTH-010', 'oauth.js', `if (!expected || req.query.state === expected) finish(req.query.code);\n`,
    `if (!expected || req.query.state !== expected) return res.status(400).end();\nfinish(req.query.code);\n`],
  ['AUTH-011', 'login-google.js', `const payload = ticket.getPayload(); // id_token checked above\nconst user = await findByEmail(payload.email);\n`,
    `const payload = ticket.getPayload(); // id_token checked above\nif (!payload.email_verified) throw new Error('unverified');\nconst user = await findBySub(payload.sub);\n`],
  ['AUTH-012', 'forgot.js', `if (!user) return res.status(404).json({ error: 'Email not found' });\n`, `return res.json({ message: 'If that email has an account, a link is on its way.' });\n`],
  ['AUTH-013', 'captcha.js', `if (CAPTCHA_SECRET && !(await verify(token))) return res.status(400).end();\n`,
    `if (!CAPTCHA_SECRET) return res.status(503).end();\nif (!(await verify(token))) return res.status(400).end();\n`],
  ['AUTH-014', 'magic.js', `const t = new URLSearchParams(location.hash.slice(1)).get('t');\nsessionStorage.setItem('authToken', t);\n`,
    `const t = new URLSearchParams(location.hash.slice(1)).get('t');\nsessionStorage.setItem('lastTab', 'home');\n`],
  ['CORS-002', 'cors.js', `if (origin.endsWith('.shop.example')) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); }\n`,
    `if (ALLOWED.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); }\n`],
  ['CSRF-002', 'session.php', `<?php\nsession_set_cookie_params(['samesite' => 'None', 'secure' => true]);\n`, `<?php\nsession_set_cookie_params(['samesite' => 'Lax', 'secure' => true]);\n`],
  ['PAY-001', 'paypal.js', `const result = await api.post('/v2/checkout/orders/' + id + '/capture');\nawait markPaid(id);\n`,
    `const result = await api.post('/v2/checkout/orders/' + id + '/capture');\nif (result.status !== 'COMPLETED') throw new Error('not captured');\nawait markPaid(id);\n`],
  ['PAY-002', 'seats.php', `<?php\n$n = $db->query("SELECT seats FROM events WHERE id = $id")->fetchColumn();\nif ($n > 0) {\n  $db->exec("INSERT INTO tickets (event_id) VALUES ($id)");\n}\n`,
    `<?php\n$db->beginTransaction();\n$n = $db->query("SELECT seats FROM events WHERE id = $id FOR UPDATE")->fetchColumn();\nif ($n > 0) {\n  $db->exec("INSERT INTO tickets (event_id) VALUES ($id)");\n}\n`],
  ['PAY-003', 'hook.js', `if (!verifySignature(raw, req.headers['x-sig'])) {\n  return res.status(200).end();\n}\n`, `if (!verifySignature(raw, req.headers['x-sig'])) {\n  return res.status(401).end();\n}\n`],
  ['PAY-004', 'stripe.js', `const event = stripe.webhooks.constructEvent(raw, sig, secret);\nif (event.type === 'checkout.session.completed') fulfil(event);\n`,
    `const event = stripe.webhooks.constructEvent(raw, sig, secret);\nif (event.livemode !== LIVE) return res.end();\nif (event.type === 'checkout.session.completed') fulfil(event);\n`],
  ['DATA-001', 'settings.php', `<?php\n$cfg = json_decode($_POST['settings'], true);\n$theme = $cfg['theme'];\n`, `<?php\n$cfg = json_decode($_POST['settings'], true);\nif (!is_array($cfg)) exit;\n$theme = $cfg['theme'];\n`],
  ['DATA-002', 'quote.php', `<?php\n$fee = intval($_POST['call_fee']);\n`, `<?php\n$fee_cents = (int) round((float) $_POST['call_fee'] * 100);\n$stored = (int) $row['call_fee'];\n`],
  ['DATA-003', 'list.php', `<?php\n$all = $db->query("SELECT id, name FROM clients ORDER BY name")->fetchAll();\n$shown = array_slice($all, $start, 50);\n`,
    `<?php\n$all = $db->query("SELECT id, name FROM clients ORDER BY name LIMIT 50")->fetchAll();\n$shown = array_slice($all, 0, 10);\n`],
  ['DATA-004', 'qty.js', `const tickets = Math.max(0, parseInt(box.value, 10));\n`, `const tickets = Math.min(500, Math.max(0, parseInt(box.value, 10)));\nconst page = Math.max(1, parseInt(pager.value, 10));\n`],
  ['DATA-005', 'csv.php', `<?php\nfputcsv($fh, [$row['name'], $row['note']]);\n`, `<?php\nfunction csv_safe($v) { return preg_match('/^[=+\\-@]/', $v) ? "'" . $v : $v; }\nfputcsv($fh, array_map('csv_safe', [$row['name'], $row['note']]));\n`],
  ['DATA-006', 'teaser.php', `<?php\n$short = substr($post['excerpt'], 0, 90);\n`, `<?php\n$short = mb_substr($post['excerpt'], 0, 90);\n`],
  ['DATA-007', 'today.js', `const day = new Date().toISOString().split('T')[0];\n`, `const day = new Date().toLocaleDateString('en-CA');\n`],
  ['PDF-001', 'receipt.js', `doc.addImage(logo, 'PNG', 15, 12, 50, 20);\n`, `doc.addImage(logo, 'PNG', 15, 12, 50, 0);\n`],
  ['PDF-002', 'letter.php', `<?php\n$pdf = new FPDF();\n$pdf->Write(5, iconv('UTF-8', 'windows-1252', $text));\n`, `<?php\n$pdf = new tFPDF();\n$pdf->Write(5, $text);\n`],
  ['NET-001', 'unload.js', `document.addEventListener('visibilitychange', () => {\n  fetch(u, { method: 'POST', keepalive: true, body: blob });\n});\n`,
    `document.addEventListener('visibilitychange', () => {\n  if (blob.size < 60000) fetch(u, { method: 'POST', keepalive: true, body: blob });\n});\nfetch('/t', { method: 'POST', keepalive: true, body: JSON.stringify({ e: 'view' }) });\n`],
  ['NET-002', 'serve.js', `if (req.url === '/feed.xml') return fs.createReadStream('feed.xml').pipe(res);\n`,
    `const etag = stamp('feed.xml');\nif (req.url === '/feed.xml') { res.setHeader('ETag', etag); return fs.createReadStream('feed.xml').pipe(res); }\n`],
  ['NET-003', 'limit2.js', `if (tooMany) return res.status(429).json({ error: 'Slow down' });\n`, `if (tooMany) { res.set('Retry-After', '30'); return res.status(429).json({ error: 'Slow down: try again in 30 seconds' }); }\n`],
  ['NET-004', 'unfurl.php', `<?php\nif (!filter_var($link, FILTER_VALIDATE_URL)) exit;\n$ch = curl_init($link);\n`,
    `<?php\nif (!filter_var($link, FILTER_VALIDATE_URL)) exit;\nif (is_private_host($link)) exit;\n$ch = curl_init($link);\n`],
  ['REL-001', 'scripts/pack.py', `zip_path = f"dist/app-{version}.zip"\nwith zipfile.ZipFile(zip_path, 'w') as z:\n    z.write('app.py')\n`,
    `zip_path = f"dist/app-{version}.zip"\nif os.path.exists(zip_path):\n    sys.exit('already built: raise the version')\nwith zipfile.ZipFile(zip_path, 'w') as z:\n    z.write('app.py')\n`],
  ['INJ-011', 'boot.php', `<script>\nconst ME = <?php echo json_encode($me); ?>;\n</script>\n`, `<script>\nconst ME = <?php echo json_encode($me, JSON_HEX_TAG | JSON_HEX_AMP); ?>;\n</script>\n`],
  ['INJ-012', 'ssr.js', 'const html = `<script>window.__STATE__ = ${JSON.stringify(state)}</script>`;\n', 'const html = `<script>window.__STATE__ = ${JSON.stringify(state).replace(/</g, "\\\\u003c")}</script>`;\n'],
  ['INJ-013', 'member.php', `<a href="<?= e($member->homepage) ?>">Site</a>\n`, `<?php $url = safe_url($member->homepage); ?>\n<a href="<?= e($url) ?>">Site</a>\n`],
  ['INJ-014', 'find.php', `<?php\nif (preg_match('/' . $term . '/i', $name)) $hits[] = $name;\n`, `<?php\nif (preg_match('/' . preg_quote($term, '/') . '/i', $name)) $hits[] = $name;\n`],
  ['INJ-015', 'audit-log.php', `<?php\nerror_log("bad code for user " . $_POST['user']);\n`, `<?php\nerror_log("bad code for user " . json_encode($_POST['user'] ?? ''));\n`],
  ['INJ-016', 'mailer.php', `<?php\n$h = "From: {$_POST['email']}";\n`, `<?php\n$h = 'From: ' . SITE_MAIL;\n`],
  ['INJ-017', 'widget.js', `window.opener.postMessage(JSON.stringify(cart), "*");\n`, `window.opener.postMessage(JSON.stringify(cart), location.origin);\n`],
  ['INJ-018', 'verify.php', `<?php\n$url = "https://" . $_SERVER["HTTP_HOST"] . "/verify.php?token=$t";\nif (!mail($to, 'Confirm', $url)) exit('not sent');\n`,
    `<?php\n$url = SITE_URL . "/verify.php?token=$t";\nif (!mail($to, 'Confirm', $url)) exit('not sent');\n`],
  ['SEC-008', 'api.js', `} catch (err) { res.status(500).json({ error: err.message }); }\n`, `} catch (err) { log(err); res.status(500).json({ error: 'Saving failed; nothing changed.' }); }\n`],
  ['SEC-009', 'public_html/cron/nightly.php', `<?php\nrequire '../../app.php';\nprune();\n`, `<?php\nif (php_sapi_name() !== 'cli') exit;\nrequire '../../app.php';\nprune();\n`],
  ['SEC-010', 'dump.php', `<?php\n$f = sys_get_temp_dir() . '/report.pdf';\nfile_put_contents($f, $pdf);\n`, `<?php\n$f = tempnam(sys_get_temp_dir(), 'report');\n`],
  ['SEC-011', 'map.html', `<script\n  src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>\n`.replace('<script\n  ', '<script '),
    `<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-madeupvalueforthetest" crossorigin=""></script>\n`],
  ['HTA-001', 'portal/.htaccess', `RewriteEngine on\nRewriteRule ^(\\w+)$ index.php?p=$1 [L]\n`, `RewriteEngine on\nRewriteOptions Inherit\nRewriteRule ^(\\w+)$ index.php?p=$1 [L]\n`],
  ['HTA-002', '.htaccess', `Options -Indexes\nphp_value max_execution_time 60\n`, `Options -Indexes\n<IfModule mod_php7.c>\nphp_value max_execution_time 60\n</IfModule>\n`],
  ['HTA-003', 'site/.htaccess', `RewriteRule (^|/)\\. - [F]\n`, `RewriteRule (^|/)\\.(?!well-known) - [F]\n`],
  ['UX-001', 'save.js', `fetch('/api/note', { method: 'PUT', body })\n  .then(r => r.json())\n  .then(() => toast('Saved'));\n`,
    `fetch('/api/note', { method: 'PUT', body })\n  .then(r => { if (!r.ok) throw new Error('Not saved (' + r.status + ')'); return r.json(); })\n  .then(() => toast('Saved'));\n`],
  ['UX-002', 'pay.js', `if (!res.ok) { alert('Payment failed, please try again.'); return; }\n`, `if (!res.ok) { alert((await res.json()).error || 'Payment failed (' + res.status + ').'); return; }\n`],
  ['UX-003', 'notify.php', `<?php\n@mail($admin, 'New order', $body);\n`, `<?php\n$ok = mail($admin, 'New order', $body);\n`],
  ['UX-004', 'cache.js', `try { sessionStorage.setItem('notes', JSON.stringify(notes)); } catch {}\n`, `try { notes = JSON.parse(sessionStorage.getItem('notes')); } catch {}\ntry { localStorage.setItem('ui.theme', t); } catch {}\n`],
  ['UX-005', 'theme.js', `const saved = JSON.parse(localStorage['theme'] || 'null');\n`, `let saved = null;\ntry {\n  saved = JSON.parse(localStorage['theme'] || 'null');\n} catch (e) { saved = null; }\n`],
  ['UX-006', 'rows.js', `row.querySelector('.del').onclick = () =>\n  fetch('/api/rows/' + id, { method: 'DELETE' });\n`, `row.querySelector('.del').onclick = () => {\n  if (!window.confirm('Delete this row?')) return;\n  fetch('/api/rows/' + id, { method: 'DELETE' });\n};\n`],
  ['UX-007', 'detail.jsx', `<button onClick={() => navigate(-1)}>Back</button>\n`, `<button onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/jobs'))}>Back to Jobs</button>\n`],
  ['UX-008', 'service-worker.js', `let CACHE_NAME = "static";\nself.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME)));\n`, `let CACHE_NAME = "static-v7";\nself.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME)));\n`],
  ['UX-009', 'prefs.php', `<form method="post">\n<input type="checkbox" name="day" value="mon">\n<input type="checkbox" name="day" value="tue">\n</form>\n`,
    `<form method="post">\n<input type="checkbox" name="day[]" value="mon">\n<input type="checkbox" name="day[]" value="tue">\n</form>\n`],
  ['UX-010', 'Page.tsx', `export function Page() {\n  return <Layout><Header /></Layout>;\n}\n`, `import { Layout, Header } from './parts';\nexport function Page() {\n  return <Layout><Header /></Layout>;\n}\n`],
  // PRIV-001 (audit.js): a consent branch that closed above the tag does not cover it
  ['PRIV-001', 'foot.php', `<?php if ($consent_ok): ?>\n<p>Thanks</p>\n<?php endif; ?>\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-MADEUP1"></script>\n`,
    `<?php if ($consent_ok): ?>\n<p>Thanks</p>\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-MADEUP1"></script>\n<?php endif; ?>\n`],
  // the date is joined at run time, so this file itself carries no dated note (the bake refuses one)
  ['NOTE-001', 'cart.js', '// reviewed 3 Sep ' + '20' + '26, fixed AB-212\nconst cart = [];\n', `// The cart lives in memory until checkout.\nconst cart = [];\n`],
  ['A11Y-001', 'theme.scss', `.hint { font-size: 11px; }\n`, `.hint { font-size: 0.8rem; }\n`],
  ['A11Y-002', 'gallery.html', `<section class="lightbox open"><img src="a.jpg" width="10" height="10" alt=""></section>\n`, `<dialog class="lightbox"><img src="a.jpg" width="10" height="10" alt=""></dialog>\n`],
  ['A11Y-004', 'contact.html', `<label class="f">Your name</label><input id="n" name="n">\n`, `<label>Your name <input name="n"></label>\n`],
  ['A11Y-003', 'team.html', `<p><img alt="Our team at the bench" src="/team.webp"></p>\n`, `<p><img alt="Our team at the bench" width="960" height="640" src="/team.webp"></p>\n`],
  // Key-shaped text below is joined at run time: no line of this file looks like a real key.
  ['KEY-001', 'views/Admin.jsx', `const db = createClient(url, serviceRoleKey);\nexport const Admin = () => <p>{db.name}</p>;\n`, `const db = createClient(url, anonKey);\nexport const Admin = () => <p>{db.name}</p>;\n`],
  ['KEY-002', 'public/app.js', `const k = "${token('service_role')}";\n`, `const k = "${token('anon')}";\n`],
  // F11: an example key on the same line must not hide a real one; only the matched key is judged
  ['KEY-002', 'public/f11.js', `const k = "sb_secret_Ab3dE6gH9jK2mN5pQ8"; // e.g. sb_secret_example\n`, `const k = "sb_secret_example_0123456789";\n`],
  ['KEY-002', 'public/f11b.js', `const a = "sb_secret_your_key_here_0123", k = "sb_secret_Ab3dE6gH9jK2mN5pQ8";\n`, `const a = "sb_secret_your_key_here_0123", b = "sb_secret_xxxxxxxxxxxxxxxxxx";\n`],
  ['SEC-017', 'auth.js', `const t = jwt.sign(x, 'hard-written');\n`, `const t = jwt.sign(x, process.env.JWT_SECRET);\n`],
  ['SEC-018', 'verify.php', `<?php\ndefine('RECAPTCHA_SECRET', getenv('RECAPTCHA_SECRET') ?: 'q7Xv2Lm9Rt4Kp8Ws3Hn6');\n`, `<?php\ndefine('RECAPTCHA_SECRET', getenv('RECAPTCHA_SECRET') ?: '');\n`],
  ['SEC-019', 'config.php', `<?php\nreturn ['recaptcha_secret' => 'q7Xv2Lm9Rt4Kp8Ws3Hn6'];\n`, `<?php\nreturn ['recaptcha_secret' => getenv('RECAPTCHA_SECRET')];\n`],
  ['KEY-003', 'hooks/useStats.js', `const admin = require('firebase-admin');\nadmin.initializeApp({ credential: admin.credential.cert(key) });\n`, `import { initializeApp } from 'firebase/app';\ninitializeApp(webConfig);\n`],
  ['KEY-004', 'pages/index.js', `const key = require('../keys/acme-firebase-adminsdk-x1y2.json');\nexport default function Home() { return key.project_id; }\n`, `import site from '../site.json';\nexport default function Home() { return site.name; }\n`],
  ['KEY-005', 'static/key.json', `{"type": "service_account", "private_key": "${'made-up-not-a-key-'.repeat(4)}"}\n`, `{"type": "authorized_user", "note": "made up"}\n`],
  ['ENV-001', '.env.production', `export VITE_ADMIN_PASSWORD="made-up-value"\n`, `VITE_ADMIN_NAME="Pat"\nADMIN_PASSWORD="made-up-value"\n`],
  ['ENV-002', 'lib/ai.ts', `const { NEXT_PUBLIC_ANTHROPIC_API_KEY: key } = process.env;\n`, `const { NEXT_PUBLIC_SITE_URL: site } = process.env;\n`],
  ['ENV-003', 'vite.config.mjs', `export default { define: {\n  "process.env.API_KEY": JSON.stringify(env.API_KEY),\n} };\n`, `export default { define: {\n  "process.env.BUILD_ID": JSON.stringify(id),\n} };\n`],
  // loadEnv with an empty prefix hands over every setting; with no prefix given it hands over only the VITE_ ones
  ['ENV-003', 'sub/vite.config.ts', `export default ({ mode }) => ({ define: {\n  'process.env': JSON.stringify(loadEnv(mode, process.cwd(), '')),\n} });\n`, `export default ({ mode }) => ({ define: {\n  'process.env': JSON.stringify(loadEnv(mode, process.cwd())),\n} });\n`],
  ['PAY-006', 'checkout.php', `<?php\n$i = \\Stripe\\PaymentIntent::create(['amount' => (int) $_POST['amount'], 'currency' => 'usd']);\n`, `<?php\n$price = price_of((int) $_POST['item']);\n$i = \\Stripe\\PaymentIntent::create(['amount' => $price, 'currency' => 'usd']);\n`],
  ['LOG-001', 'auth.ts', `export const signIn = async (session) => {\n  console.info('signed in', session?.user?.id, req.headers.authorization);\n};\n`, `export const signIn = async (session) => {\n  console.info('signed in', session?.user?.id);\n};\n`],
  ['CORS-003', 'server.ts', `import cors from 'cors';\napp.use(cors({ origin: '*', credentials: true }));\n`, `import cors from 'cors';\napp.use(cors({ origin: '*' }));\n`],
  // the same hole with the headers set by hand, and in Hono's cors: the asking site is echoed back with cookies allowed
  ['CORS-003', 'api/open.js', `app.use((req, res, next) => {\n  res.header('Access-Control-Allow-Origin', req.headers.origin);\n  res.header('Access-Control-Allow-Credentials', 'true');\n  next();\n});\n`, `app.use((req, res, next) => {\n  if (ALLOWED.includes(req.headers.origin)) res.header('Access-Control-Allow-Origin', req.headers.origin);\n  res.header('Access-Control-Allow-Credentials', 'true');\n  next();\n});\n`],
  ['CORS-003', 'api/echo.js', `const origin = req.headers.origin;\nres.setHeader('Access-Control-Allow-Origin', origin);\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n`, `const origin = process.env.SITE_ORIGIN;\nres.setHeader('Access-Control-Allow-Origin', origin);\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n`],
  ['CORS-003', 'app/api/feed/route.ts', `export async function GET(req) {\n  return new Response('{}', { headers: {\n    'Access-Control-Allow-Origin': req.headers.get('origin'),\n    'Access-Control-Allow-Credentials': 'true',\n  } });\n}\n`, `export async function GET(req) {\n  return new Response('{}', { headers: {\n    'Access-Control-Allow-Origin': req.headers.get('origin'),\n  } });\n}\n`],
  ['CORS-003', 'srv-hono.ts', `import { cors } from 'hono/cors';\napp.use('*', cors({ origin: (origin) => origin, credentials: true }));\n`, `import { cors } from 'hono/cors';\napp.use('*', cors({ origin: (origin) => (LIST.includes(origin) ? origin : null), credentials: true }));\n`],
  // PAY-006: the shorthand on a const line, on one line or two
  // Hono's c.req, a Remix or React Router route's action in a .tsx file; the same amount in a browser component is not read
  ['PAY-006', 'srv/pay-hono.ts', `app.post('/pay', async (c) => {\n  const { amount } = await c.req.json();\n  await stripe.paymentIntents.create({ amount, currency: 'usd' });\n});\n`, `app.post('/pay', async (c) => {\n  const { itemId } = await c.req.json();\n  await stripe.paymentIntents.create({ amount: priceOf(itemId), currency: 'usd' });\n});\n`],
  ['PAY-006', 'app/routes/pay.tsx', `export async function action({ request }) {\n  const form = await request.formData();\n  await stripe.paymentIntents.create({ amount: Number(form.get('amount')), currency: 'usd' });\n  return null;\n}\nexport default function Pay() { return <form method="post" />; }\n`, `export async function action({ request }) {\n  const form = await request.formData();\n  await stripe.paymentIntents.create({ amount: priceOf(form.get('id')), currency: 'usd' });\n  return null;\n}\nexport default function Pay() { return <form method="post" />; }\n`],
  ['PAY-006', 'app/routes/pay-two.jsx', `export const action = async ({ request }) => {\n  const { price } = await request.json();\n  await stripe.checkout.sessions.create({ line_items: [{ price_data: { unit_amount: price } }] });\n  return null;\n};\n`, `export const action = async ({ request }) => {\n  const { id } = await request.json();\n  await stripe.checkout.sessions.create({ line_items: [{ price_data: { unit_amount: PRICES[id] } }] });\n  return null;\n};\n`],
  ['PAY-006', 'api/one-line.js', `const { amount } = await req.json();const intent = await stripe.paymentIntents.create({ amount, currency: 'usd' });\n`, `const { itemId } = await req.json(); const intent = await stripe.paymentIntents.create({ amount: priceOf(itemId), currency: 'usd' });\n`],
  ['PAY-006', 'api/two-lines.js', `const { amount } = req.body;\nconst intent = await stripe.paymentIntents.create({ amount, currency: 'usd' });\n`, `const { id } = req.body;\nconst amount = priceOf(id);\nconst intent = await stripe.paymentIntents.create({ amount, currency: 'usd' });\n`],
  // PAY-006 through a schema, a form and Python frameworks
  ['PAY-006', 'api/zod.js', `const { amount } = schema.parse(await req.json());\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`, `const { itemId } = schema.parse(await req.json());\nconst amount = priceOf(itemId);\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`],
  ['PAY-006', 'api/safe.js', `const body = await req.json();\nconst parsed = schema.safeParse(body);\nawait stripe.paymentIntents.create({ amount: parsed.data.amount, currency: 'usd' });\n`, `const body = await req.json();\nconst parsed = schema.safeParse(body);\nawait stripe.paymentIntents.create({ amount: priceOf(parsed.data.id), currency: 'usd' });\n`],
  ['PAY-006', 'api/safe2.js', `const body = await req.json();\nconst data = schema.safeParse(body).data;\nawait stripe.paymentIntents.create({ amount: data.price, currency: 'usd' });\n`, `const body = await req.json();\nconst data = schema.safeParse(body).data;\nawait stripe.paymentIntents.create({ amount: PRICES[data.id], currency: 'usd' });\n`],
  ['PAY-006', 'lib/pay-action.js', `export async function pay(formData) {\n  const amount = Number(formData.get('amount'));\n  await stripe.paymentIntents.create({ amount, currency: 'usd' });\n}\n`, `export async function pay(formData) {\n  const id = String(formData.get('id'));\n  const amount = priceOf(id);\n  await stripe.paymentIntents.create({ amount, currency: 'usd' });\n}\n`],
  ['PAY-006', 'lib/pay-inline.js', `await stripe.paymentIntents.create({\n  amount: Number(formData.get('price')) * 100,\n  currency: 'usd',\n});\n`, `await stripe.paymentIntents.create({\n  amount: priceOf(formData.get('id')) * 100,\n  currency: 'usd',\n});\n`],
  ['PAY-006', 'fast.py', `@app.post('/pay')\ndef pay(body: CheckoutIn):\n    return stripe.PaymentIntent.create(amount=body.amount, currency='usd')\n`, `@app.post('/pay')\ndef pay(body: CheckoutIn):\n    item = ITEMS[body.item_id]\n    return stripe.PaymentIntent.create(amount=item.price, currency='usd')\n`],
  ['PAY-006', 'flaskpay.py', `data = request.get_json()\namount = data['amount']\nintent = stripe.PaymentIntent.create(\n    amount=amount,\n    currency='usd',\n)\n`, `data = request.get_json()\namount = PRICES[data['item']]\nintent = stripe.PaymentIntent.create(\n    amount=amount,\n    currency='usd',\n)\n`],
  // public prefixes of SvelteKit, Astro, Vue CLI and Gatsby
  ['ENV-001', '.env.staging', `PUBLIC_OPENAI_API_KEY=made-up-value\nGATSBY_STRIPE_SECRET_KEY=made-up-value\n`, `PUBLIC_SITE_URL=https://shop.test\nGATSBY_SITE_URL=https://shop.test\nOPENAI_API_KEY=made-up-value\n`],
  ['ENV-001', 'v/.env', `VUE_APP_ANTHROPIC_API_KEY=made-up-value\n`, `VUE_APP_TITLE=Shop\n`],
  ['ENV-002', 'src/lib/ai.ts', `import { PUBLIC_OPENAI_API_KEY } from '$env/static/public';\n`, `import { PUBLIC_SITE_URL } from '$env/static/public';\n`],
  ['ENV-002', 'src/lib/ai2.ts', `import { env } from '$env/dynamic/public';\nconst k = env.PUBLIC_OPENAI_API_KEY;\n`, `import { env } from '$env/dynamic/public';\nconst k = env.PUBLIC_SITE_URL;\n`],
  ['ENV-002', 'src/ai3.ts', `const k = import.meta.env.PUBLIC_OPENAI_API_KEY;\n`, `const k = import.meta.env.PUBLIC_SITE_URL;\n`],
  ['ENV-002', 'src/ai4.js', `const k = process.env.VUE_APP_OPENAI_API_KEY;\nconst g = process.env.GATSBY_STRIPE_SECRET_KEY;\n`, `const k = process.env.VUE_APP_TITLE;\nconst g = process.env.GATSBY_SITE_URL;\n`],
  ['KEY-002', 'p/.env', `PUBLIC_SUPABASE_KEY=${token('service_role')}\n`, `PUBLIC_SUPABASE_KEY=${token('anon')}\n`],
  // build configs that copy a secret into the browser code
  ['ENV-003', 'next.config.js', `module.exports = { env: {\n  OPENAI_API_KEY: process.env.OPENAI_API_KEY,\n} };\n`, `module.exports = { env: {\n  SITE_URL: process.env.SITE_URL,\n} };\n`],
  ['ENV-003', 'next.config.mjs', `export default { env: { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY } };\n`, `export default { serverRuntimeConfig: { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY } };\n`],
  ['ENV-003', 'vite.config.js', `export default { define: { 'process.env': process.env } };\n`, `export default { define: { 'process.env': {} } };\n`],
  ['ENV-003', 'w/vite.config.ts', `export default { define: {\n  'process.env.SUPABASE_SERVICE_ROLE_KEY': JSON.stringify(env.SUPABASE_SERVICE_ROLE_KEY),\n} };\n`, `export default { define: {\n  'process.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL),\n} };\n`],
  ['ENV-003', 'nuxt.config.ts', `export default defineNuxtConfig({ runtimeConfig: {\n  public: {\n    stripeSecretKey: process.env.STRIPE_SECRET_KEY,\n  },\n} });\n`, `export default defineNuxtConfig({ runtimeConfig: {\n  stripeSecretKey: process.env.STRIPE_SECRET_KEY,\n  public: {\n    siteUrl: process.env.SITE_URL,\n  },\n} });\n`],
  // Astro: only a <script> block reaches the browser
  ['KEY-001', 'src/pages/admin.astro', `---\nconst title = 'Admin';\n---\n<script>\nconst db = createClient(url, serviceRoleKey);\n</script>\n`, `---\nconst db = createClient(url, import.meta.env.SUPABASE_SERVICE_ROLE_KEY);\n---\n<script>\nconst x = 1;\n</script>\n`],
  ['KEY-003', 'src/pages/stats.astro', `---\nconst title = 'Stats';\n---\n<script>\nimport admin from 'firebase-admin';\n</script>\n`, `---\nimport admin from 'firebase-admin';\n---\n<p>Stats</p>\n`],
  ['KEY-004', 'src/pages/key.astro', `<script>\nimport key from './serviceAccountKey.json';\n</script>\n`, `---\nimport key from './serviceAccountKey.json';\n---\n<p>{key.project_id}</p>\n`],
  ['ENV-002', 'src/pages/ai.astro', `<script>\nconst k = import.meta.env.PUBLIC_OPENAI_API_KEY;\n</script>\n`, `---\nconst k = import.meta.env.PUBLIC_OPENAI_API_KEY;\n---\n<p>{k.length}</p>\n`],
  // ENV-002 and ENV-004: a key by its generic name
  ['ENV-002', 'src/k1.js', `const a = import.meta.env.VITE_GOOGLE_GENERATIVE_AI_API_KEY;\n`, `const a = import.meta.env.VITE_FIREBASE_API_KEY;\n`],
  ['ENV-005', 'src/k2.js', `const a = import.meta.env.VITE_RAPIDAPI_KEY;\n`, `const a = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;\n`],
  ['ENV-002', 'src/k3.js', `const a = import.meta.env.VITE_STABILITY_API_KEY;\n`, `const a = import.meta.env.VITE_MAPBOX_TOKEN;\n`],
  ['ENV-002', 'src/k4.js', `const a = import.meta.env.VITE_ELEVEN_LABS_API_KEY;\n`, `const a = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;\n`],
  ['ENV-005', 'src/k5.js', `const a = process.env.NEXT_PUBLIC_SANITY_TOKEN;\n`, `const a = process.env.NEXT_PUBLIC_POSTHOG_KEY;\n`],
  ['ENV-005', 'src/k6.js', `const a = import.meta.env.VITE_DISCORD_WEBHOOK_URL;\n`, `const a = process.env.NEXT_PUBLIC_SENTRY_DSN;\n`],
  ['ENV-002', 'src/k7.js', `const a = import.meta.env.VITE_FIREBASE_SERVICE_ACCOUNT;\n`, `const a = process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_API_KEY;\n`],
  ['ENV-002', 'src/k8.js', `const a = process.env.NEXT_PUBLIC_SENTRY_AUTH_TOKEN;\n`, `const a = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;\n`],
  ['ENV-002', 'src/k9.js', `const a = import.meta.env.VITE_MAPBOX_SECRET_TOKEN;\n`, `const a = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;\n`],
  ['ENV-004', '.env.preview', `VITE_RAPIDAPI_KEY=made-up-value\nNEXT_PUBLIC_SANITY_TOKEN=made-up-value\n`, `VITE_FIREBASE_API_KEY=made-up-value\nVITE_MAPBOX_TOKEN=made-up-value\nVITE_RAPIDAPI_KEY=your_key_here\n`],
  // the money field on the callback's own item: the visitor's price, not one read from a table of the server's
  ['PAY-006', 'api/cart-sum.js', `const { items } = req.body;\nconst amount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`, `const { items } = req.body;\nconst amount = items.reduce((sum, i) => sum + PRODUCTS[i.id].price * i.quantity, 0);\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`],
  ['PAY-006', 'api/cart-sum2.js', `const body = await req.json();\nconst total = body.items.reduce(function (s, it) { return s + it.unitPrice; }, 0);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`, `const body = await req.json();\nconst total = body.items.reduce(function (s, it) { return s + PRICES[it.sku].unitPrice; }, 0);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`],
  ['PAY-006', 'api/cart-sum3.js', `const { items } = req.body;\nconst amount = items.reduce((s, { price, qty }) => s + price * qty, 0);\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`, `const { items } = req.body;\nconst amount = items.reduce((s, { id, qty }) => s + PRODUCTS[id].amount * qty, 0);\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`],
  // PAY-006 through one variable
  ['PAY-006', 'api/hop-cents.ts', `const { amount } = await req.json();\nconst amountInCents = Math.round(amount * 100);\nawait stripe.paymentIntents.create({ amount: amountInCents, currency: 'usd' });\n`, `const { itemId } = await req.json();\nconst amountInCents = Math.round(priceOf(itemId) * 100);\nawait stripe.paymentIntents.create({ amount: amountInCents, currency: 'usd' });\n`],
  ['PAY-006', 'api/hop-number.ts', `const data = await req.json();\nconst amount = Number(data.amount);\nawait stripe.paymentIntents.create({ amount, currency });\n`, `const data = await req.json();\nconst amount = Number(PRICES[data.id]);\nawait stripe.paymentIntents.create({ amount, currency });\n`],
  ['PAY-006', 'api/hop-field.ts', `const body = await req.json();\nconst total = body.total;\nawait stripe.checkout.sessions.create({ line_items: [{ price_data: { unit_amount: total } }] });\n`, `const body = await req.json();\nconst total = PRICES[body.id];\nawait stripe.checkout.sessions.create({ line_items: [{ price_data: { unit_amount: total } }] });\n`],
  ['PAY-006', 'api/hop-express.js', `const amount = req.body.amount;\nconst cents = amount * 100;\nawait stripe.paymentIntents.create({ amount: cents, currency: 'usd' });\n`, `const amount = PRICES[req.body.id];\nconst cents = amount * 100;\nawait stripe.paymentIntents.create({ amount: cents, currency: 'usd' });\n`],
  ['PAY-006', 'api/hop-fixed.js', `const { price } = req.body;\nconst shown = price.toFixed(2);\nawait paypal.orders.create({ amount: { value: shown } });\n`, `const { id } = req.body;\nconst shown = priceOf(id).toFixed(2);\nawait paypal.orders.create({ amount: { value: shown } });\n`],
  // PAY-006 through a function of this file that adds up what the visitor sent
  ['PAY-006', 'api/helper-sum.js', `const calculateOrderAmount = (items) => {\n  let total = 0;\n  items.forEach((item) => {\n    total += item.price;\n  });\n  return total;\n};\nconst { items } = req.body;\nconst total = calculateOrderAmount(items);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`, `const calculateOrderAmount = (items) => {\n  let total = 0;\n  items.forEach((item) => {\n    total += PRODUCTS[item.id].price * item.quantity;\n  });\n  return total;\n};\nconst { items } = req.body;\nconst total = calculateOrderAmount(items);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`],
  ['PAY-006', 'api/helper-inline.js', `function basketTotal(lines) {\n  return lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);\n}\nconst { lines } = req.body;\nawait stripe.paymentIntents.create({\n  amount: basketTotal(lines),\n  currency: 'usd',\n});\n`, `function basketTotal(lines) {\n  // return lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);\n  return 1400;\n}\nconst { lines } = req.body;\nawait stripe.paymentIntents.create({\n  amount: basketTotal(lines),\n  currency: 'usd',\n});\n`],
  ['PAY-006', 'api/helper-whole.ts', `async function chargeFor(order: Order): Promise<number> {\n  return order.total * 100;\n}\nconst order = await req.json();\nconst cents = await chargeFor(order);\nawait stripe.paymentIntents.create({ amount: cents, currency: 'usd' });\n`, `async function chargeFor(order: Order): Promise<number> {\n  const saved = await loadOrder(order.id);\n  return saved.total * 100;\n}\nconst order = await req.json();\nconst cents = await chargeFor(order);\nawait stripe.paymentIntents.create({ amount: cents, currency: 'usd' });\n`],
  ['PAY-006', 'api/helper-field.js', `function addUp(lines) {\n  return lines.reduce((s, l) => s + l.price, 0);\n}\nconst body = await req.json();\nconst items = body.items;\nconst sum = addUp(items);\nawait stripe.paymentIntents.create({ amount: sum, currency: 'usd' });\n`, `function addUp(lines) {\n  return lines.reduce((s, l) => s + l.qty * PRICE, 0);\n}\nconst body = await req.json();\nconst items = body.items;\nconst sum = addUp(items);\nawait stripe.paymentIntents.create({ amount: sum, currency: 'usd' });\n`],
  ['PAY-006', 'api/helper-loop.js', `function addUp(cart) {\n  let n = 0;\n  for (const { price, qty } of cart) n += price * qty;\n  return n;\n}\nconst { cart } = req.body;\nconst sum = addUp(cart);\nawait stripe.paymentIntents.create({ amount: sum, currency: 'usd' });\n`, `function addUp(cart) {\n  let n = 0;\n  for (const { id, qty } of cart) n += PRICES[id] * qty;\n  return n;\n}\nconst { cart } = req.body;\nconst sum = addUp(cart);\nawait stripe.paymentIntents.create({ amount: sum, currency: 'usd' });\n`],
  // PAY-006: a count from the visitor times the server's price is a fair sum; a money field still fires
  ['PAY-006', 'api/count-times-price.ts', `const { credits, price } = await req.json();\nawait stripe.paymentIntents.create({ amount: credits * price, currency: 'usd' });\n`, `const { credits } = await req.json();\nawait stripe.paymentIntents.create({ amount: credits * PRICE_PER_CREDIT, currency: 'usd' });\n`],
  ['PAY-006', 'api/plan-times.js', `const { plan, total } = req.body;\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`, `const { plan, quantity } = req.body;\nawait stripe.paymentIntents.create({ amount: PRICES[plan] * quantity, currency: 'usd' });\n`],
  ['PAY-006', 'api/renamed-field.js', `const { amount: wanted } = req.body;\nawait stripe.paymentIntents.create({ amount: wanted, currency: 'usd' });\n`, `const { id: wanted } = req.body;\nawait stripe.paymentIntents.create({ amount: PRICES[wanted], currency: 'usd' });\n`],
  ['PAY-006', 'api/cents-field.js', `const { cents } = req.body;\nawait stripe.paymentIntents.create({ amount: cents, currency: 'usd' });\n`, `const { seats } = req.body;\nawait stripe.paymentIntents.create({ amount: seats * SEAT_CENTS, currency: 'usd' });\n`],
  // a key known only by its usual ending: Medium, and worded so a beginner can judge it
  ['ENV-005', 'src/m1.js', `const a = import.meta.env.VITE_TMDB_API_KEY;\n`, `const a = import.meta.env.VITE_API_URL;\n`],
  ['ENV-005', 'src/m2.js', `const a = process.env.NEXT_PUBLIC_GIPHY_API_KEY;\nconst b = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;\n`, `const a = process.env.NEXT_PUBLIC_SITE_URL;\n`],
  ['ENV-001', 'e/.env', `VITE_TMDB_API_KEY=${['sk', 'live', 'Q3x9Lm2Vb7Tn4Rk8Wd5Hj6Zp'].join('_')}\n`, `VITE_TMDB_API_KEY=made-up-value\n`.replace('VITE_TMDB_API_KEY', 'VITE_API_URL')],
  // LOG-001: the settings, a whole login body, whole headers
  ['LOG-001', 'l/e1.js', `console.log('OpenAI key:', process.env.OPENAI_API_KEY);\n`, `console.log('OpenAI key set:', !!process.env.OPENAI_API_KEY);\n`],
  ['LOG-001', 'l/e2.js', `console.log('JWT_SECRET:', process.env.JWT_SECRET);\n`, `console.log('Site:', process.env.SITE_URL);\n`],
  ['LOG-001', 'l/e3.js', `console.log(process.env);\n`, `console.log(process.env.NODE_NAME);\n`],
  ['LOG-001', 'routes/login.js', `const check = password => password;\nconsole.log('Login attempt:', req.body);\n`, `const check = password => password;\nconsole.log('Login attempt:', req.body.email);\n`],
  ['LOG-001', 'l/h.js', `console.log('Headers:', req.headers);\n`, `console.log('Host:', req.headers.host);\n`],
  // CORS-003: every site by another road
  ['CORS-003', 'c/fast.py', `from fastapi.middleware.cors import CORSMiddleware\norigins = ["*"]\napp.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True)\n`, `from fastapi.middleware.cors import CORSMiddleware\norigins = ["https://app.test"]\napp.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True)\n`],
  ['CORS-003', 'c/cb.js', `const cors = require('cors');\napp.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));\n`, `const cors = require('cors');\napp.use(cors({ origin: (o, cb) => cb(null, LIST.includes(o)), credentials: true }));\n`],
  ['CORS-003', 'c/cb2.js', `const cors = require('cors');\napp.use(cors({\n  credentials: true,\n  origin: function (o, cb) {\n    cb(null, true);\n  },\n}));\n`, `const cors = require('cors');\napp.use(cors({\n  credentials: true,\n  origin: function (o, cb) {\n    if (!LIST.includes(o)) return cb(new Error('Not allowed.'));\n    cb(null, true);\n  },\n}));\n`],
  ['CORS-003', 'c/or.js', `const cors = require('cors');\napp.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));\n`, `const cors = require('cors');\napp.use(cors({ origin: process.env.CLIENT_URL || 'https://app.test', credentials: true }));\n`],
  ['CORS-003', 'c/nest.ts', `app.enableCors({ origin: true, credentials: true });\n`, `app.enableCors({ origin: 'https://app.test', credentials: true });\n`],
];

// Must stay quiet: shapes the rules first flagged on real projects, wrongly (written again with made-up names).
// [rule, file, text]
const QUIET = [
  ['UX-010', 'Nav.jsx', `export function Nav() {\n  /*\n  <Link> would be caught by the router here,\n  so a plain anchor is used */\n  return <a href="/">Home</a>;\n}\n`],
  ['UX-010', 'Field.jsx', `export function Field({ icon: Icon, as: Tag = 'div' }) {\n  return <Tag><Icon size={12} /></Tag>;\n}\n`],
  ['REL-001', 'tools/inspect.py', `zip_path = f"dist/app-{version}.zip"\nwith zipfile.ZipFile(zip_path) as z:\n    names = z.namelist()\n`],
  ['REL-001', 'tools/stage.js', `const VERSION = '1.2.3';\nfs.writeFileSync(path.join(stage, 'projects.json'), '[]');\n`],
  ['REL-001', 'tools/pack.py', `def guard(p):\n    if p.exists():\n        fail(f'{p.name} already exists: raise the version first. Nothing was changed.')\n` + '\n'.repeat(80) + `out = ROOT / f'app-{version}.zip'\nwith zipfile.ZipFile(out, 'w') as z:\n    z.write('a')\n`],
  ['UX-009', 'rows.php', `<form method="post"><input type="checkbox" name="taxable" value="1"></form>\n<form method="post"><input type="checkbox" name="taxable" value="1"></form>\n`],
  ['UX-009', 'settings.php', `<form method="post">\n<input type="checkbox" name="vip" value="1">\n</form>\n<div class="preview">\n<input type="checkbox" name="vip" value="1" disabled>\n</div>\n`],
  ['AUTH-010', 'panel.js', `if (!g || g.state === 'error') return null;\n`],
  ['AUTH-014', 'signin.js', `const back = new URLSearchParams(location.search).get('code');\nconst state = makeState();\nsessionStorage.setItem('oauth_state', state);\n`],
  ['INJ-013', 'card.php', `<a href="<?= e($biz['website']) ?>">Visit</a>\n`],
  ['PAY-001', 'capture.php', `<?php\n$r = call_api('POST', '/v2/checkout/orders/' . $id . '/capture', [], [\n  'Prefer: return=representation',\n]);\n\n\n\n\n\nif ((int)$r['code'] === 422) { $r = refetch($id); }\nreturn record_order($r['json']);\n`],
  ['UX-007', 'rules.js', `const R = { title: 'A Back control that calls history.back() leaves the site' };\n`],
  ['NOTE-001', 'scanner.js', `// SEC-001: fixed for keys with a real body\nconst x = 1;\n`],
  ['DATA-006', 'store.php', `<?php\nreturn $dir . '/' . substr($name, 0, 2) . '/' . $name;\nerror_log('reply: ' . substr($body, 0, 300));\n`],
  ['INJ-011', 'pay-page.php', `<script>\nconst T = { token: <?= json_encode($token) ?> };\n</script>\n<?php echo json_encode($data); ?>\n`],
  ['SEC-008', 'cron-run.php', `<?php\nif (PHP_SAPI !== 'cli') exit;\ntry { run(); } catch (Throwable $e) { echo $e->getMessage(), "\\n"; }\n`],
  ['GET-002', 'lib/session.php', `<?php\n$next = $_GET['next'] ?? '/';\nfunction bump($db, $id) { $db->prepare('UPDATE account SET epoch = epoch + 1 WHERE id = ?')->execute([$id]); }\n`],
  ['IMG-003', 'pdf-image.php', `<?php\nif (!fits($w, $h)) return null;\n$src = @imagecreatefromstring($png);\nif ($src === false) return null;\n`],
  ['AUTH-012', 'geo.php', `<?php\nreturn ['ok' => false, 'reason' => 'address not found'];\n`],
  ['NET-001', 'track.js', `export function track(e) {\n  fetch('/t', { method: 'POST', body: payload(e), keepalive: true });\n}\n`],
  ['SEC-010', 'health.php', `<?php\nfunction health_file() { return sys_get_temp_dir() . '/app_health.json'; }\n$ref = load(sys_get_temp_dir() . '/input-photo.png');\n`],
  ['DATA-002', 'jobs.php', `<?= money((int) $job['rate']) ?> / hr\n`],
  ['A11Y-003', 'mail-open.php', `<?php\n$pixel = '<img src="' . e(base_url('/o/' . $track . '.gif')) . '" alt="">';\n`],
  ['A11Y-004', 'person.html', `<div class="row"><label class="lbl">First name</label><div class="val">Nadia</div></div>\n<label class="lbl">This person is</label>\n<input type="radio" name="kind" value="a"> A\n`],
  // a test file (pytest's test_*.py) is not shipped code: non-critical rules skip it
  ['SEC-010', 'test_export.py', `f = open('/tmp/report.csv', 'w')\n`],
  // a tracker printed only inside a consent branch of the template
  ['PRIV-001', 'head.php', `<?php if ($consent_ok): ?>\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-MADEUP1"></script>\n<?php endif; ?>\n`],
  // honest shapes of the browser-key rules: the key on the server, or a value that is public by design
  ['KEY-001', 'lib/server/admin.ts', `const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n`],
  ['KEY-001', 'app/api/job/route.ts', `const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n`],
  ['KEY-001', 'supabase/functions/job/index.ts', `const admin = createClient(url, serviceRoleKey);\n`],
  ['KEY-001', 'lib/supabase/admin.ts', `export const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n`],
  ['KEY-001', 'components/Doc.tsx', `'use client';\nexport const Doc = () => <p>The service_role key is never used in this page.</p>;\n`],
  ['KEY-001', 'pages/report.tsx', `const k = process.env.SUPABASE_SERVICE_ROLE_KEY;\nexport async function getServerSideProps() { return { props: { n: count(k) } }; }\n`],
  ['KEY-002', '.env', `SUPABASE_SERVICE_ROLE_KEY=${token('service_role')}\n`],
  ['KEY-002', 'src/local.js', `export const k = "${token('service_role', 'supabase-demo')}";\n`],
  ['KEY-002', 'src/anon.js', `export const k = "${token('authenticated')}";\n`],
  ['KEY-003', 'functions/index.js', `const admin = require('firebase-admin');\nadmin.initializeApp();\n`],
  ['KEY-003', 'server/fb.ts', `import admin from 'firebase-admin';\nadmin.initializeApp({ credential: admin.credential.cert(key) });\n`],
  ['KEY-004', 'scripts/backfill.js', `const key = require('./serviceAccountKey.json');\nrun(key);\n`],
  ['KEY-005', 'config/key.json', `{"type": "service_account", "private_key": "${'made-up-not-a-key-'.repeat(4)}"}\n`],
  ['ENV-001', '.env.local', `NEXT_PUBLIC_SITE_URL=https://shop.test\nNEXT_PUBLIC_SUPABASE_ANON_KEY=made-up-public-value\nVITE_API_URL=https://api.shop.test\nVITE_PRIVATE_BETA=true\nNEXT_PUBLIC_PASSWORD_MIN_LENGTH=8\nNEXT_PUBLIC_RESET_PASSWORD=true\nEXPO_PUBLIC_MAPBOX_TOKEN=made-up-public-value\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=made-up-public-value\nNEXT_PUBLIC_RECAPTCHA_SITE_KEY=made-up-public-value\nNEXT_PUBLIC_SECRET_SANTA_URL=https://santa.test\n# NEXT_PUBLIC_STRIPE_SECRET_KEY=made-up-value\n`],
  ['ENV-001', '.env.example', `NEXT_PUBLIC_STRIPE_SECRET_KEY=your-key-here\n`],
  ['ENV-001', 'a/.env', `VITE_OPENAI_API_KEY=\nVITE_GEMINI_API_KEY=your_key_here\nNEXT_PUBLIC_DB_PASSWORD=xxxxxx\n`],
  ['ENV-002', 'src/config.js', `export const api = import.meta.env.VITE_API_URL;\nexport const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;\nexport const pk = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY;\n`],
  ['ENV-002', 'app/api/ai/route.ts', `const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n`],
  ['ENV-003', 'vite.config.ts', `export default { server: { proxy: {} }, envPrefix: 'VITE_' };\nconst x = { 'process.env.API_KEY': 'not in a define' };\n`],
  // honest shapes of the price rule: a price looked up on the server, a donation the visitor chooses, the name only
  ['PAY-006', 'api/buy.js', `const { itemId } = req.body;\nconst item = await db.item.findUnique({ where: { id: itemId } });\nawait stripe.paymentIntents.create({ amount: item.price, currency: 'usd' });\n`],
  ['PAY-006', 'api/buy2.js', `const { amount: wanted } = req.body;\nconst order = await loadOrder(req.body.id);\nif (wanted !== order.total) throw new Error('The total changed: please check your basket.');\nawait stripe.paymentIntents.create({ amount: order.total, currency: 'usd' });\n`],
  ['PAY-006', 'api/donate.js', `await stripe.paymentIntents.create({ amount: req.body.amount, currency: 'usd' });\n`],
  ['PAY-006', 'api/quote.js', `const totals = { amount: req.body.amount };\nsave(totals);\n`],
  ['PAY-006', 'api/receipt.js', `const paypal = load();\nconst { amount } = await lookup(req.query.id);\nreturn { amount, shown: true };\n`],
  // honest shapes of the log rule
  ['LOG-001', 'x/a.js', `console.log('token refreshed');\nconsole.log("password changed");\nconsole.log(tokens.length, tokenCount, token.length, !!token);\nconsole.log('has token', token ? 'yes' : 'no');\nconsole.log(session?.user?.id);\nconsole.log(mask(accessToken));\nconsole.log({ token: 'hidden' });\n`],
  ['LOG-001', 'x/lexer.js', `const lexer = make();\nconsole.log(token);\n`],
  ['LOG-001', 'x/workout.js', `console.log(session);\n`],
  ['LOG-001', 'x/dev.js', `if (process.env.NODE_ENV !== 'production') console.log(token);\nif (process.env.NODE_ENV !== 'production') {\n  console.log(password);\n}\n`],
  ['LOG-001', 'scripts/rotate.js', `console.log(accessToken);\n`],
  // honest shapes of the CORS rule
  ['CORS-003', 'y/app.js', `const cors = require('cors');\napp.use(cors({ origin: 'https://app.test', credentials: true }));\n`],
  ['CORS-003', 'y/public.js', `const cors = require('cors');\napp.use(cors({ origin: '*' }));\n`],
  ['CORS-003', 'y/list.js', `const cors = require('cors');\napp.use(cors({ origin: ['https://a.test', 'https://b.test'], credentials: true }));\n`],
  ['CORS-003', 'vite.config.js', `// cors dev server\nexport default { server: { cors: { origin: true, credentials: true } } };\n`],
  ['CORS-003', 'y/dev.js', `const cors = require('cors');\nconst dev = process.env.NODE_ENV !== 'production';\nif (dev) app.use(cors({ origin: true, credentials: true }));\n`],
  ['CORS-003', 'y/flask.py', `from flask_cors import CORS\nCORS(app, origins=["https://app.test"], supports_credentials=True)\n`],
  // hand-set headers: a list looked at first; a fixed site; every site with no cookies; a star, which browsers refuse with cookies
  ['CORS-003', 'y/hand-list.js', `const origin = req.headers.origin;\nif (ALLOWED.includes(origin)) {\n  res.setHeader('Access-Control-Allow-Origin', origin);\n  res.setHeader('Access-Control-Allow-Credentials', 'true');\n}\n`],
  ['CORS-003', 'y/hand-ternary.js', `res.setHeader('Access-Control-Allow-Origin', ALLOWED.has(req.headers.origin) ? req.headers.origin : '');\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n`],
  ['CORS-003', 'y/hand-fixed.js', `res.setHeader('Access-Control-Allow-Origin', 'https://app.test');\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n`],
  ['CORS-003', 'y/hand-open.js', `res.setHeader('Access-Control-Allow-Origin', req.headers.origin);\nres.setHeader('Access-Control-Allow-Methods', 'GET');\n`],
  ['CORS-003', 'y/hand-star.js', `res.setHeader('Access-Control-Allow-Origin', '*');\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n`],
  ['CORS-003', 'y/hono-list.ts', `import { cors } from 'hono/cors';\napp.use('*', cors({ origin: (origin) => origin.endsWith('.app.test') ? origin : null, credentials: true }));\n`],
  ['CORS-003', 'y/hono-open.ts', `import { cors } from 'hono/cors';\napp.use('*', cors({ origin: (origin) => origin }));\n`],
  // PAY-006 in .tsx and .jsx: a browser component reads a form and hands it to a server route; a client file with an action word
  ['PAY-006', 'components/Pay.tsx', `export function Pay() {\n  const submit = async (e) => {\n    const data = new FormData(e.target);\n    const formData = data;\n    const amount = Number(formData.get('amount'));\n    await paypal.pay({ amount, currency: 'usd' });\n  };\n  return <form onSubmit={submit} />;\n}\n`],
  ['PAY-006', 'app/pay/page.jsx', `'use client';\nexport const action = 1;\nconst formData = new FormData();\nconst amount = Number(formData.get('amount'));\nstripe.paymentIntents.create({ amount });\n`],
  // ENV-003: only the public settings
  ['ENV-003', 'lib2/vite.config.js', `export default ({ mode }) => ({ define: {\n  'process.env': JSON.stringify(loadEnv(mode, process.cwd(), 'VITE_')),\n} });\n`],
  // a price chosen by id: the id goes into a lookup, it is not the amount
  ['PAY-006', 'api/lookup.js', `const { id } = req.body;\nawait stripe.paymentIntents.create({ amount: PRICES[id], currency: 'usd' });\nawait stripe.paymentIntents.create({ amount: priceOf(id), currency: 'usd' });\n`],
  // PAY-006: a name is read at its own declaration: another route of the file may fill the same name from the server
  ['PAY-006', 'api/two-routes.js', `app.post('/quote', async (req, res) => {\n  const { amount } = req.body;\n  const total = amount * 1.2;\n  res.json({ total });\n});\napp.post('/pay', async (req, res) => {\n  const { id } = req.body;\n  const total = priceOf(id);\n  await stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n});\n`],
  ['PAY-006', 'api/two-routes2.js', `app.post('/quote', async (req, res) => {\n  const { amount } = req.body;\n  res.json({ shown: amount });\n});\napp.post('/pay', async (req, res) => {\n  const { amount } = await loadOrder(req.body.id);\n  await stripe.paymentIntents.create({ amount, currency: 'usd' });\n});\n`],
  // PAY-006: what the visitor sent is compared with the server's figure before it is charged
  ['PAY-006', 'api/hop-compared.js', `const { amount } = req.body;\nconst cents = amount * 100;\nconst order = await loadOrder(req.body.id);\nif (cents !== order.total) throw new Error('The total changed: please check your basket.');\nawait stripe.paymentIntents.create({ amount: cents, currency: 'usd' });\n`],
  // PAY-006: a comparison only chooses between the server's own figures, and a lookup or a call only uses the name
  ['PAY-006', 'api/hop-tier.js', `const { total } = req.body;\nconst fee = total > 100 ? FEE_HIGH : FEE_LOW;\nconst plain = total > 100;\nconst looked = PRICES[total];\nconst called = priceOf(total);\nawait stripe.paymentIntents.create({ amount: fee, currency: 'usd' });\nawait stripe.paymentIntents.create({ amount: plain, currency: 'usd' });\nawait stripe.paymentIntents.create({ amount: looked, currency: 'usd' });\nawait stripe.paymentIntents.create({ amount: called, currency: 'usd' });\n`],
  // PAY-006: a function of the file that prices the list itself, checks the sent price, or is handed something else
  ['PAY-006', 'api/helper-reprice.js', `function sumUp(items) {\n  items = items.map(i => ({ ...i, price: PRICES[i.id] }));\n  return items.reduce((s, i) => s + i.price, 0);\n}\nconst { items } = req.body;\nconst total = sumUp(items);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`],
  ['PAY-006', 'api/helper-checks.js', `function sumUp(items) {\n  let n = 0;\n  items.forEach(i => {\n    if (i.price !== PRICES[i.id]) throw new Error('That price has changed.');\n    n += i.price;\n  });\n  return n;\n}\nconst { items } = req.body;\nconst total = sumUp(items);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`],
  ['PAY-006', 'api/helper-other.js', `function sumUp(list) {\n  return list.reduce((s, i) => s + i.price, 0);\n}\nconst { items } = req.body;\nconst saved = await loadBasket(req.user.id);\nconst total = sumUp(saved);\nawait stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n`],
  ['PAY-006', 'api/helper-other-route.js', `function sumUp(list) {\n  return list.reduce((s, i) => s + i.price, 0);\n}\napp.post('/a', async (req, res) => {\n  const { items } = req.body;\n  res.json({ n: items.length });\n});\napp.post('/b', async (req, res) => {\n  const items = await loadBasket(req.user.id);\n  const total = sumUp(items);\n  const again = items.reduce((s, i) => s + i.price, 0);\n  await stripe.paymentIntents.create({ amount: total, currency: 'usd' });\n  await stripe.paymentIntents.create({ amount: again, currency: 'usd' });\n  await stripe.paymentIntents.create({ amount: sumUp(items), currency: 'usd' });\n});\n`],
  ['PAY-006', 'api/helper-next-door.js',`const sizeOf = items => items.length;\nconst other = { price: 5 };\nfunction later(o) { return other.price; }\nconst { items } = req.body;\nconst count = sizeOf(items);\nawait stripe.paymentIntents.create({ amount: count * PRICE, currency: 'usd' });\n`],
  // PAY-006: a commented-out line is not a declaration
  ['PAY-006', 'api/hop-comment.js', `const { itemId } = req.body;\n// const amount = body.amount;\nconst amount = priceOf(itemId);\nawait stripe.paymentIntents.create({ amount, currency: 'usd' });\n`],
  // a config that only reads a key for the server, or a define with a harmless name
  ['ENV-003', 'next.config.ts', `export default { serverRuntimeConfig: {\n  OPENAI_API_KEY: process.env.OPENAI_API_KEY,\n}, env: { SITE_URL: process.env.SITE_URL } };\n`],
  ['ENV-001', 'k/.env', `PUBLIC_SITE_URL=https://shop.test\nPUBLIC_KEY=made-up-public-value\nPUBLIC_API_URL=https://api.shop.test\n`],
  ['ENV-002', 'src/public-names.js', `const a = [import.meta.env.PUBLIC_SITE_URL, process.env.GATSBY_SITE_URL, process.env.VUE_APP_TITLE, process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY, process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY];\n`],
  // a log line that says whether the value is there
  ['LOG-001', 'x/set.js', `console.log('key', process.env.OPENAI_API_KEY ? 'set' : 'missing');\nconsole.log(Boolean(process.env.JWT_SECRET));\nconsole.log(process.env.OPENAI_API_KEY?.length);\n`],
  ['LOG-001', 'x/form.js', `console.log('Saved form:', req.body);\n`],
  // CORS-003: a list named for its sites, and an open CORS with no credentials
  ['CORS-003', 'y/list.py', `from fastapi.middleware.cors import CORSMiddleware\norigins = ["https://a.test"]\napp.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True)\nother = ["*"]\n`],
  ['CORS-003', 'y/open.py', `from fastapi.middleware.cors import CORSMiddleware\norigins = ["*"]\napp.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False)\n`],
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-rules-more-'));
  const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  // Each pair in its own folder pair, so one rule's file cannot silence or set off another's.
  PAIRS.forEach(([id, file, bad, good], n) => { w('loud/c' + n + '/' + file, bad); w('quiet/c' + n + '/' + file, good); });
  // HTA-001 reads the parent .htaccess (the site's https redirect).
  const https = 'RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]\n';
  PAIRS.forEach(([id], n) => { if (id === 'HTA-001') { w('loud/c' + n + '/.htaccess', https); w('quiet/c' + n + '/.htaccess', https); } });
  QUIET.forEach(([id, file, text], n) => w('quiet/q' + n + '/' + file, text));
  // INJ-013's quiet case: this project adds the scheme to every website where it is saved (in another file).
  w('quiet/q-save/listing-save.php', "<?php\n$site = preg_match('#^https?://#i', $site) ? $site : 'https://' . $site;\n");
  // KEY and ENV rules in a project with an app/ router: a component with no 'use client' runs on the server, unless a
  // client file imports it.
  const SERVER_PART = `export async function Stats() {\n  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n  const key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n  return db.name + key;\n}\n`;
  const LAYOUT = `export default function Layout({ children }) { return children; }\n`;
  w('quiet/q-router/app/layout.tsx', LAYOUT);
  w('quiet/q-router/app/page.tsx', `import { Stats } from '../components/Stats';\nconst k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\nexport default function Page() { return <Stats />; }\n`);
  w('quiet/q-router/components/Stats.tsx', SERVER_PART);
  w('loud/l-router/src/app/layout.tsx', LAYOUT);
  w('loud/l-router/src/components/Stats.tsx', SERVER_PART);
  w('loud/l-router/src/components/Panel.tsx', `'use client';\nimport { Stats } from './Stats';\nexport const Panel = () => <Stats />;\n`);
  // Keys many services mean for browsers: never rated High, in code or in .env.
  w('loud/l-design/src/design.js', `const a = [import.meta.env.VITE_TMDB_API_KEY, import.meta.env.VITE_OPENWEATHER_API_KEY, process.env.NEXT_PUBLIC_GIPHY_API_KEY, process.env.NEXT_PUBLIC_STREAM_API_KEY, process.env.NEXT_PUBLIC_GOOGLE_API_KEY, process.env.EXPO_PUBLIC_REVENUECAT_API_KEY];\n`);
  w('loud/l-design/.env', `VITE_TMDB_API_KEY=made-up-value\nNEXT_PUBLIC_GIPHY_API_KEY=made-up-value\nEXPO_PUBLIC_REVENUECAT_API_KEY=made-up-value\n`);
  // A shared lib file is browser code when a client file imports it; a file of the same name elsewhere is not it.
  const FB_ADMIN = `import admin from 'firebase-admin';\nimport key from './serviceAccountKey.json';\nadmin.initializeApp({ credential: admin.credential.cert(key) });\nexport default admin;\n`;
  w('loud/l-admin/lib/firebaseAdmin.ts', FB_ADMIN);
  w('loud/l-admin/components/Panel.tsx', `'use client';\nimport admin from '@/lib/firebaseAdmin';\nexport const Panel = () => <p>{admin.name}</p>;\n`);
  w('loud/l-admin2/lib/firebaseAdmin.ts', FB_ADMIN);
  w('loud/l-admin2/widgets/Panel.tsx', `'use client';\nimport admin from '../../src/bridge/firebaseAdmin';\nexport const Panel = () => <p>{admin.name}</p>;\n`);
  w('quiet/q-admin/lib/firebaseAdmin.ts', FB_ADMIN);
  w('quiet/q-admin/app/api/x/route.ts', `import admin from '@/lib/firebaseAdmin';\nexport async function GET() { return Response.json(admin.name); }\n`);
  w('quiet/q-admin/lib/supabase/admin.ts', `export const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n`);
  w('quiet/q-admin/components/admin.tsx', `export const Admin = () => <p>Admin</p>;\n`);
  w('quiet/q-admin/components/Panel.tsx', `'use client';\nimport { Admin } from './admin';\nexport const Panel = () => <Admin />;\n`);
  // A plain Vite app sends all of src/ to the browser; SvelteKit runs vite too, and its src/lib may be server code.
  w('loud/l-vite/vite.config.js', `export default {};\n`);
  w('loud/l-vite/index.html', `<!doctype html><title>x</title>\n`);
  w('loud/l-vite/src/firebase.js', `import admin from 'firebase-admin';\nexport default admin;\n`);
  w('quiet/q-svelte/vite.config.js', `export default {};\n`);
  w('quiet/q-svelte/svelte.config.js', `export default {};\n`);
  w('quiet/q-svelte/src/lib/firebase.js', `import admin from 'firebase-admin';\nexport default admin;\n`);
  const loud = await runAudit(path.join(tmp, 'loud'), null, { root: false });
  const quiet = await runAudit(path.join(tmp, 'quiet'), null, { root: false });
  const at = (r, id, n, file) => r.findings.some(f => f.rule === id && f.where.startsWith('c' + n + '/' + file));
  PAIRS.forEach(([id, file], n) => {
    check(id + ' fires on ' + file, () => assert(at(loud, id, n, file), 'not found; got ' + loud.findings.filter(f => f.where.startsWith('c' + n + '/')).map(f => f.rule).join(',')));
    check(id + ' stays quiet on the fixed ' + file, () => assert(!at(quiet, id, n, file), 'flagged ' + (quiet.findings.find(f => f.rule === id && f.where.startsWith('c' + n + '/')) || {}).where));
  });
  QUIET.forEach(([id, file], n) => {
    check(id + ' stays quiet on ' + file + ' (a shape it once flagged on a real project)', () =>
      assert(!quiet.findings.some(f => f.rule === id && f.where.startsWith('q' + n + '/')), 'flagged ' + (quiet.findings.find(f => f.rule === id && f.where.startsWith('q' + n + '/')) || {}).where));
  });
  for (const id of ['KEY-001', 'ENV-002']) {
    check(id + ' fires on a component a client file imports (app/ router)', () => assert(loud.findings.some(f => f.rule === id && f.where.startsWith('l-router/src/components/Stats.tsx')), 'not found'));
    check(id + ' stays quiet on a server component (app/ router)', () => assert(!quiet.findings.some(f => f.rule === id && f.where.startsWith('q-router/')), 'flagged'));
  }
  for (const [id, where] of [['KEY-003', 'l-admin/lib/firebaseAdmin.ts'], ['KEY-004', 'l-admin/lib/firebaseAdmin.ts'], ['KEY-003', 'l-admin2/lib/firebaseAdmin.ts'], ['KEY-003', 'l-vite/src/firebase.js']]) {
    // the same line in the same file name elsewhere is merged into one finding, with its other places in also
    check(id + ' fires on ' + where + ' (it reaches the browser)', () => assert(loud.findings.some(f => f.rule === id && [f.where, ...(f.also || [])].some(w => w.startsWith(where))), 'not found'));
  }
  check('keys many services mean for browsers are Medium, not High', () => {
    const here = loud.findings.filter(f => f.where.startsWith('l-design/'));
    assert(here.some(f => f.rule === 'ENV-005') && here.some(f => f.rule === 'ENV-004'), 'not found; got ' + here.map(f => f.rule).join(','));
    const high = here.filter(f => f.sev === 'High' || f.sev === 'Critical');
    assert(!high.length, high.map(f => f.rule + ' ' + f.where).join('; '));
  });
  for (const where of ['q-admin/', 'q-svelte/']) {
    check('KEY rules stay quiet in ' + where, () => assert(!quiet.findings.some(f => /^KEY-/.test(f.rule) && f.where.startsWith(where)), quiet.findings.filter(f => /^KEY-/.test(f.rule)).map(f => f.where).join(', ')));
  }
  check('a key known only by its ending is Medium, in code and in .env', () => {
    for (const id of ['ENV-004', 'ENV-005']) assert.strictEqual(RULES_MORE.find(r => r.id === id).sev, 'Medium', id);
    for (const id of ['ENV-004', 'ENV-005']) assert(/anyone can read/i.test(RULES_MORE.find(r => r.id === id).title) && /server route/i.test(RULES_MORE.find(r => r.id === id).fix), id + ' wording');
  });
  // PAY-006's reading of a file stays linear on files built to slow it down (400 KB each).
  const payRule = RULES_MORE.find(r => r.id === 'PAY-006');
  const hostile = {
    'declarations in a chain': "const { amount } = req.body;\n" + 'const a0 = amount * 2;\n'.repeat(18000) + 'amount: a0,\n',
    'one long line': 'const { amount } = req.body;' + 'const a0 = amount;'.repeat(22000) + '\namount: a0,\n',
    'unclosed function definitions': "const { items } = req.body;\n" + Array.from({ length: 7000 }, (_, n) => 'function f' + n + '(items) {\n  items.forEach(i => {\n').join('') + 'const t = f1(items);\namount: t,\n',
    'functions called, each read': "const { items } = req.body;\n" + Array.from({ length: 5000 }, (_, n) => 'function f' + n + '(items) {\n  items.forEach(i => { x(i.id); ' + 'y(i);'.repeat(30) + '\n').join('') + Array.from({ length: 5000 }, (_, n) => 'const t' + n + ' = f' + n + '(items);\n').join('') + 'amount: t1,\n',
    'many calls a line': "const { items } = req.body;\nfunction sum(items) { return items.length; }\n" + ('const t = ' + 'sum(items)+'.repeat(13) + '1;\namount: t,\n').repeat(2600),
    'many amounts': "const { amount } = req.body;\n" + 'const amount = amount * 2;\namount: amount,\n'.repeat(9000),
    'money names by the thousand': "const body = await req.json();\n" + Array.from({ length: 16000 }, (_, n) => 'const price' + n + ' = body.total;').join('\n') + '\namount: price7,\n',
    'open object types': "const { amount } = req.body;\n" + 'const a0: { = (((\n'.repeat(22000) + 'amount: a0,\n',
    'quoted text everywhere': "const { items } = req.body;\nfunction sum(items) { return '" + "'x".repeat(190000) + ";\nconst t = sum(items);\namount: t,\n",
  };
  let worstPay = 0;
  for (const [name, text] of Object.entries(hostile)) {
    const body = 'stripe.paymentIntents.create\n' + text;
    const lines = body.split('\n');
    const ctx = { rel: 'api/slow.js', text: body, lines };
    const start = process.hrtime.bigint();
    for (let i = 0; i < lines.length; i++) if (payRule.re.test(lines[i])) payRule.test(lines[i], ctx, lines, i);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    worstPay = Math.max(worstPay, ms);
    check('PAY-006 reads a hostile file in well under a second: ' + name + ' (' + Math.round(body.length / 1024) + ' KB, ' + Math.round(ms) + ' ms)', () => assert(ms < 500, Math.round(ms) + ' ms'));
  }
  // Every new rule has a pair here; ids are unique across the whole list.
  check('every rule in rules-more.js has a pair', () => {
    const have = new Set(PAIRS.map(p => p[0]));
    const missing = RULES_MORE.map(r => r.id).filter(id => !have.has(id));
    assert(!missing.length, 'no pair for ' + missing.join(', '));
  });
  check('rule ids are unique', () => {
    const ids = RULES.map(r => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate: ' + ids.filter((x, i) => ids.indexOf(x) !== i).join(','));
  });
  // A fixed copy raises nothing new at all from these rules: the quiet folder holds none of their findings.
  check('the fixed copies raise no new-rule finding at all', () => {
    const mine = new Set(RULES_MORE.map(r => r.id));
    const noisy = quiet.findings.filter(f => mine.has(f.rule)).map(f => f.rule + ' ' + f.where);
    assert(!noisy.length, noisy.join('; '));
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main();
