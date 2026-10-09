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
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-rules-more-'));
  // Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
  const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  // Each pair in its own folder pair, so one rule's file cannot silence or set off another's.
  PAIRS.forEach(([id, file, bad, good], n) => { w('loud/c' + n + '/' + file, bad); w('quiet/c' + n + '/' + file, good); });
  // HTA-001 reads the parent .htaccess (the site's https redirect).
  const https = 'RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]\n';
  PAIRS.forEach(([id], n) => { if (id === 'HTA-001') { w('loud/c' + n + '/.htaccess', https); w('quiet/c' + n + '/.htaccess', https); } });
  QUIET.forEach(([id, file, text], n) => w('quiet/q' + n + '/' + file, text));
  // INJ-013's quiet case: this project adds the scheme to every website where it is saved (in another file).
  w('quiet/q-save/listing-save.php', "<?php\n$site = preg_match('#^https?://#i', $site) ? $site : 'https://' . $site;\n");
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
