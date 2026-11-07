// Faults a read-only walk reproduced, each with the honest shape beside it: keys in files that look like programs, a
// run of slashes against the home folder, key shapes of newer services, passwords and signing secrets in code, and the
// money routes and webhooks the API rules read.
// Run: node test/walk-0115.test.js   (no packages; git on PATH).
// Every key is made up and put together at run time, so no line here looks like the real thing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { runAudit } = require('../../src/bridge/audit');
const { makeMatcher } = require('../../src/bridge/disclosure');
const { makeZip } = require('./museum/kit');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-walk-'));
const j = (...parts) => parts.join('');
const MIX = 'q7Xv2Lm9Rt4Kp8Ws3Hn6Jd1Gb5Cz0Fy';
const rnd = n => MIX.repeat(Math.ceil(n / MIX.length)).slice(0, n);
let failures = 0, n = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const audit = async files => {
  const dir = path.join(tmp, 'p' + (++n));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return { dir, a: await runAudit(dir, null, { disclosure: { details: [], others: [], own: [] } }) };
};
const list = a => JSON.stringify(a.findings.filter(f => !/^DISC-/.test(f.rule)).map(f => f.sev + ' ' + f.rule + ' ' + f.where));
const fires = (name, rule, sev, files) => check(name, async () => {
  const { a } = await audit(files);
  assert(a.findings.some(f => f.rule === rule && f.sev === sev), 'wanted ' + sev + ' ' + rule + ', got ' + list(a));
});
const quiet = (name, rule, files) => check(name, async () => {
  const { a } = await audit(files);
  assert(!a.findings.some(f => new RegExp(rule).test(f.rule)), 'wanted no ' + rule + ', got ' + list(a));
});

const LIVE = j('sk_', 'live_') + rnd(24);
const HUB = j('gh', 'p_') + rnd(36);

async function main() {
  // ---- keys in files that look like programs ----
  const nul = String.fromCharCode(0);
  await fires('a key before a NUL byte in a settings file', 'SEC-003', 'Critical', { 'a.env': 'K=' + LIVE + '\n' + nul + 'tail\n' });
  await fires('a key after a leading NUL in a text file', 'SEC-003', 'Critical', { 'a.txt': nul + '\nK=' + HUB + '\n' });
  await fires('a key beside a NUL in a code file', 'SEC-003', 'Critical', { 'a.js': '// ' + nul + '\nconst k = "' + LIVE + '";\n' });
  await fires('a key in a data file', 'SEC-003', 'Critical', { 'a.dat': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(' ' + HUB + ' '), Buffer.from([0])]) });
  await fires('a key in a pickle', 'SEC-003', 'Critical', { 'a.pkl': Buffer.concat([Buffer.from([0x80, 4, 0]), Buffer.from(LIVE), Buffer.from([0x94])]) });
  await fires('a key in a .bin file', 'SEC-003', 'Critical', { 'a.bin': Buffer.concat([Buffer.from([0]), Buffer.from(' ' + LIVE + ' ')]) });
  await fires('a key inside a .jar', 'SEC-003', 'Critical', { 'lib/a.jar': makeZip([{ name: 'conf/app.properties', data: 'k=' + LIVE + '\n' }]) });
  await quiet('a binary with no key says nothing about keys', '^SEC-', { 'a.dat': Buffer.from([0, 1, 2, 3, 255, 254, 0, 65, 66, 67]) });
  await check('a key removed from a binary-looking file is still found in the history', async () => {
    const dir = path.join(tmp, 'hist');
    fs.mkdirSync(dir);
    const git = (...a) => execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x.test', '-C', dir, ...a], { stdio: 'pipe' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* -diff\n');
    fs.writeFileSync(path.join(dir, 'a.env'), 'K=' + LIVE + '\n' + nul + 'tail\n');
    git('add', '.'); git('commit', '-qm', 'one');
    fs.writeFileSync(path.join(dir, 'a.env'), 'K=\n');
    git('add', '.'); git('commit', '-qm', 'two');
    const a = await runAudit(dir, null, { disclosure: { details: [], others: [], own: [] } });
    assert(a.findings.some(f => f.rule === 'SEC-012'), 'wanted SEC-012, got ' + list(a));
  });

  // ---- a run of slashes against the home folder ----
  await check('a long run of backslashes or slashes against the home folder is quick', () => {
    const scan = makeMatcher({ details: [{ label: 'your home folder', value: ['C:', 'Users', 'Wren'].join('\\') }, { label: 'your home folder', value: ['', 'c', 'Users', 'Wren'].join('/') }], others: [], own: [] });
    for (const run of ['\\'.repeat(16000), '//'.repeat(8000)]) {
      const t0 = Date.now();
      assert.strictEqual(scan(run).length, 0);
      assert(Date.now() - t0 < 1500, (Date.now() - t0) + ' ms');
    }
    assert.strictEqual(scan('see /' + ['', 'c', 'Users', 'Wren', 'notes'].join('/') + '\n').length, 1, 'a path after two slashes is still found');
    assert.strictEqual(scan('see \\' + ['', 'c', 'Users', 'Wren', 'notes'].join('\\') + '\n').length, 1, 'a path after two backslashes is still found');
  });

  // ---- key shapes of newer services ----
  const shapes = {
    'a project key': [j('sk-', 'proj-') + rnd(18) + '_' + rnd(30) + '-' + rnd(40), 'SEC-002', 'Critical'],
    'a service account key': [j('sk-', 'svcacct-') + rnd(20) + '-' + rnd(40), 'SEC-002', 'Critical'],
    'an OpenRouter key': [j('sk-', 'or-v1-') + 'a1b2c3d4e5f60718'.repeat(4), 'SEC-002', 'Critical'],
    'a Groq key': [j('gs', 'k_') + rnd(52), 'SEC-002', 'Critical'],
    'a Hugging Face key': [j('h', 'f_') + rnd(34), 'SEC-002', 'Critical'],
    'a Replicate key': [j('r', '8_') + rnd(37), 'SEC-002', 'Critical'],
    'an xAI key': [j('xa', 'i-') + rnd(70), 'SEC-002', 'Critical'],
    'a Perplexity key': [j('ppl', 'x-') + rnd(48), 'SEC-002', 'Critical'],
    'a Neon password': [j('np', 'g_') + rnd(12), 'SEC-003', 'Critical'],
    'a Resend key': [j('r', 'e_') + rnd(8) + '_' + rnd(24), 'SEC-005', 'High'],
    'a Vercel storage key': [j('vercel_', 'blob_rw_') + rnd(16) + '_' + rnd(30), 'SEC-005', 'High'],
  };
  for (const [what, [key, rule, sev]] of Object.entries(shapes)) {
    await fires(what + ' in code', rule, sev, { 'lib/client.ts': 'const K = "' + key + '";\n' });
    await fires(what + ' in a settings file', rule, sev, { '.env': 'X=' + key + '\n' });
  }
  await quiet('a long spinner class is no key', '^SEC-00[23]$', { 'a.css': '.sk-circle-fade-dot-animation-delay-one-two-three-four { color: red; }\n' });
  await quiet('a placeholder project key is no key', '^SEC-002$', { 'a.js': 'const K = "' + j('sk-', 'proj-') + 'your-key-goes-here-your-key-goes-here-your";\n' });
  await quiet('a word that starts like a key is no key', '^SEC-00[235]$', { 'a.js': 'const a = "hf_model_name"; const b = "xai-grok-model-name-long"; const c = "re_try_after_the_first_attempt_ends"; const d = "npg_status";\n' });

  // ---- a database password in code ----
  const PW = 'Vx7' + rnd(12);
  await fires('a Mongo address with its password', 'SEC-016', 'High', { 'server.js': "mongoose.connect('mongodb+srv://admin:" + PW + "@cluster0.x.mongodb.net/app');\n" });
  await fires('a Postgres address with its password', 'SEC-016', 'High', { 'db.js': "const p = new Pool({ connectionString: 'postgresql://postgres:" + PW + "@db.x.supabase.co:5432/postgres' });\n" });
  await quiet('an address on this PC is left alone', '^SEC-016$', { 'db.js': "const a = 'postgres://postgres:" + PW + "@localhost:5432/app';\nconst b = 'mongodb://root:" + PW + "@127.0.0.1/app';\n" });
  await quiet('an address built from settings is left alone', '^SEC-016$', { 'db.js': 'const a = `postgres://${USER}:${PASS}@db.x.supabase.co/app`;\nconst b = process.env.DATABASE_URL;\n' });
  await quiet('an example address is left alone', '^SEC-016$', { 'db.js': "const a = 'postgres://user:password@db.example.com/app';\nconst b = 'mongodb+srv://USER:YOUR_PASSWORD@cluster0.mongodb.net';\nconst c = 'mysql://root:changeme@db.host.io/app';\n" });
  await fires('a password in a pool setting', 'SEC-004', 'Medium', { 'db.js': "const p = mysql.createPool({ host: 'db.x.io', user: 'root', password: '" + PW + "' });\n" });

  // ---- a signing secret in code ----
  await fires('a signing secret held in a constant', 'SEC-017', 'High', { 'auth.js': "const JWT_SECRET = '" + rnd(40) + "';\nconst t = jwt.sign(x, JWT_SECRET);\n" });
  await fires('a signing secret given in the call', 'SEC-017', 'High', { 'auth.js': "const t = jwt.verify(x, 'secret');\n" });
  await fires('a weak fallback for a signing secret', 'SEC-017', 'High', { 'auth.js': "const s = process.env.JWT_SECRET || 'secret';\n" });
  await quiet('a signing secret read from settings', '^SEC-017$', { 'auth.js': "const JWT_SECRET = process.env.JWT_SECRET;\nconst t = jwt.sign(x, JWT_SECRET, { expiresIn: '1h' });\nconst u = jwt.verify(x, getKey());\nconst v = jwt.sign(x, key, { algorithm: 'RS256' });\n" });
  await quiet('a test may hold one', '^SEC-017$', { 'test/auth.test.js': "const t = jwt.sign(x, 'secret');\n" });

  // ---- a secret written in under its own name, or as the fallback when a setting is empty ----
  const RC = '6L' + rnd(38);
  const writtenIn = [
    ['PHP define: a literal after a ternary', 'a.php', "<?php\ndefine('RECAPTCHA_V3_SECRET_KEY', $rc !== '' ? $rc : '" + RC + "'); // fallback: delete after rotating\n"],
    ['PHP define: a literal after ?:', 'a.php', "<?php\ndefine('RECAPTCHA_SECRET', getenv('RECAPTCHA_SECRET') ?: '" + RC + "');\n"],
    ['PHP define: a literal after ??', 'a.php', "<?php\ndefine('APP_SECRET', $_ENV['APP_SECRET'] ?? '" + RC + "');\n"],
    ['PHP define: a name SEC-013 does not read', 'a.php', "<?php\ndefine('APP_SECRETKEY', '" + RC + "');\n"],
    ['PHP variable: a literal after ?:', 'a.php', "<?php\n$secret = getenv('RECAPTCHA_SECRET') ?: '" + RC + "';\n"],
    ['PHP variable: a literal after ??', 'a.php', "<?php\n$recaptcha_secret = $_ENV['RECAPTCHA_SECRET'] ?? '" + RC + "';\n"],
    ['PHP array: a literal after ?:', 'a.php', "<?php\n$cfg['secret'] = getenv('S') ?: '" + RC + "';\n"],
    ['PHP password: a literal after ?:', 'a.php', "<?php\n$db_password = getenv('DB_PASSWORD') ?: 'Summer2031x';\n"],
    ['PHP variable: written in under its name', 'a.php', "<?php\n$recaptcha_secret = '" + RC + "';\n"],
    ['PHP variable: written in, camel case', 'a.php', "<?php\n$secretKey = '" + RC + "';\n"],
    ['PHP const: written in', 'a.php', "<?php\nconst RECAPTCHA_SECRET = '" + RC + "';\n"],
    ['PHP Laravel env(): a literal second argument', 'a.php', "<?php\n$k = env('RECAPTCHA_SECRET', '" + RC + "');\n"],
    ['JS: a literal after ||', 'a.js', "const s = process.env.RECAPTCHA_SECRET || '" + RC + "';\n"],
    ['JS: a literal after ??', 'a.js', "const s = process.env.API_SECRET ?? '" + RC + "';\n"],
    ['JS: an API key with a literal fallback', 'a.js', "const s = process.env.PAYMENTS_API_KEY || '" + RC + "';\n"],
    ['JS: written in, constant', 'a.js', "const RECAPTCHA_SECRET = '" + RC + "';\n"],
    ['JS: written in, camel case', 'a.ts', "const apiSecret = '" + RC + "';\n"],
    ['JS: a literal fallback in an object', 'a.js', "module.exports = { recaptchaSecret: process.env.X || '" + RC + "' };\n"],
    ['Python: environ.get with a literal', 'a.py', "RC = os.environ.get('RECAPTCHA_SECRET', '" + RC + "')\n"],
    ['Python: getenv with a literal', 'a.py', "SECRET_KEY = os.getenv('SECRET_KEY', '" + RC + "')\n"],
    ['Python: written in', 'a.py', "RECAPTCHA_SECRET = '" + RC + "'\n"],
    ['Ruby: ENV.fetch with a literal', 'a.rb', "RC = ENV.fetch('RECAPTCHA_SECRET', '" + RC + "')\n"],
    ['Ruby: a literal after ||', 'a.rb', "rc = ENV['RECAPTCHA_SECRET'] || '" + RC + "'\n"],
  ];
  for (const [name, file, text] of writtenIn) await fires(name, 'SEC-018', 'High', { [file]: text });
  const notWrittenIn = [
    ['an empty fallback', 'a.php', "<?php\ndefine('RC_SECRET', getenv('RC_SECRET') ?: '');\n$secret = getenv('S') ?: null;\n"],
    ['read from settings', 'a.php', "<?php\n$secret = $cfg['recaptcha_secret'] ?? '';\ndefine('RC_SECRET', $secret);\n"],
    ['a placeholder fallback', 'a.js', "const s = process.env.API_SECRET || 'changeme';\nconst t = process.env.X_SECRET || 'your-secret-here-1';\n"],
    ['a header name, a setting name', 'a.js', "const SECRET_HEADER = 'x-webhook-signature-256-v1-abcdef';\nconst secretName = 'prod-db-secret-2031-a-long-name';\n"],
    ['a file and a path', 'a.js', "const SECRET_FILE = 'secrets.json';\nconst secretPath = '/run/secrets/db1';\n"],
    ['a label picked by a ternary', 'a.js', "const label = isSecret ? 'hiddenvalue1' : 'shownvalue2';\nconst m = password.length > 8 ? 'strong1234' : 'weak123456';\n"],
    ['a path or a name as the fallback', 'a.py', "P = os.getenv('SECRET_FILE', '/etc/app/secrets1.json')\nN = os.environ.get('DB_SECRET', 'prod-db-secret')\n"],
    ['read from the environment', 'a.py', "S = os.environ['SECRET_KEY']\nT = os.getenv('SECRET_KEY')\n"],
    ['a site key, which is public', 'a.js', "const RECAPTCHA_SITE_KEY = '" + RC + "';\nconst publicKey = '" + RC + "';\n"],
    ['the name of a setting as the value', 'a.js', "const secretKey = 'RECAPTCHA_SECRET_KEY_NAME_2';\n"],
    ['a word, not a key', 'a.js', "const secretMessage = 'nothing_to_see_in_here_at_all';\n"],
    ['the key Google publishes for testing', 'a.php', "<?php\n$secret = getenv('S') ?: '" + j('6LeIxAcTAAAAA', rnd(27)) + "';\n"],
    ['a comparison is not a value', 'a.js', "if (secret === '" + RC + "') go();\n"],
    ['a test file may hold one', 'test/a.js', "const RECAPTCHA_SECRET = '" + RC + "';\n"],
  ];
  for (const [name, file, text] of notWrittenIn) await quiet('written-in secret, quiet: ' + name, '^SEC-018$', { [file]: text });
  await fires('a key in a PHP settings file is a Medium to check', 'SEC-019', 'Medium', { 'config.php': "<?php\nreturn ['recaptcha_secret' => '" + RC + "'];\n" });
  await fires('a PHP secrets file too', 'SEC-019', 'Medium', { 'private/admin-secrets.php': "<?php\nreturn ['app_secret' => '" + RC + "'];\n" });
  await quiet('a settings file is not reported as written into the code', '^SEC-018$', { 'config.php': "<?php\nreturn ['recaptcha_secret' => '" + RC + "'];\n", 'lib/secrets.php': "<?php\n$app_secret = '" + RC + "';\n" });
  await fires('a fallback in a settings file is still the High', 'SEC-018', 'High', { 'config.php': "<?php\n$rc = getenv('RECAPTCHA_SECRET') ?: '" + RC + "';\n" });
  await quiet('a fallback in a settings file is not reported twice', '^SEC-019$', { 'config.php': "<?php\n$rc = getenv('RECAPTCHA_SECRET') ?: '" + RC + "';\n" });
  await fires('a JS file named config is still the High', 'SEC-018', 'High', { 'src/config.js': "const apiSecret = '" + RC + "';\n" });
  await check('one finding for a line an older rule already reads', async () => {
    const { a } = await audit({ 'a.php': "<?php\ndefine('RC_SECRET', '" + RC + "');\n$secret = '" + RC + "';\n", 'auth.js': "const JWT_SECRET = '" + RC + "';\n" });
    assert(!a.findings.some(f => f.rule === 'SEC-018'), list(a));
    assert(['SEC-013', 'SEC-004', 'SEC-017'].every(r => a.findings.some(f => f.rule === r)), list(a));
  });
  await check('a long line of fallbacks is read quickly', async () => {
    const t0 = Date.now();
    await audit({ 'a.js': "const a = x || 'abcd1234' ".repeat(70) + '\n' + "const secret_a = b ? c : 'abcd1234' ".repeat(50) + '\n' });
    assert(Date.now() - t0 < 1000, (Date.now() - t0) + ' ms');
  });

  // ---- the amount to charge ----
  await fires('Nuxt: the amount from what was posted', 'PAY-006', 'High', { 'server/api/pay.post.ts': "export default defineEventHandler(async event => {\n  const { amount } = await readBody(event);\n  return stripe.paymentIntents.create({ amount, currency: 'eur' });\n});\n" });
  await fires('Nuxt: the amount through a name', 'PAY-006', 'High', { 'server/api/pay.post.ts': "export default defineEventHandler(async event => {\n  const body = await readBody(event);\n  return stripe.paymentIntents.create({ amount: body.amount, currency: 'eur' });\n});\n" });
  await fires('Hono: the amount from a checked body', 'PAY-006', 'High', { 'src/pay.ts': "app.post('/pay', zValidator('json', s), async c => {\n  const { amount } = c.req.valid('json');\n  return c.json(await stripe.paymentIntents.create({ amount, currency: 'eur' }));\n});\n" });
  await quiet('Nuxt: the amount from the server', 'PAY-006', { 'server/api/pay.post.ts': "export default defineEventHandler(async event => {\n  const { id } = await readBody(event);\n  const item = await getItem(id);\n  return stripe.paymentIntents.create({ amount: item.price, currency: 'eur' });\n});\n" });

  // ---- open money routes and other databases ----
  await fires('an open refund route', 'API-001', 'High', { 'server.js': "const app = require('express')();\napp.post('/api/refund', async (req, res) => {\n  res.json(await stripe.refunds.create({ payment_intent: req.body.paymentIntent }));\n});\n" });
  await fires('an open transfer route', 'API-001', 'High', { 'server.js': "const app = require('express')();\napp.post('/api/send', async (req, res) => {\n  res.json(await stripe.transfers.create({ amount: 5, destination: req.body.to }));\n});\n" });
  await fires('an open billing portal route', 'API-001', 'High', { 'server.js': "const app = require('express')();\napp.post('/api/portal', async (req, res) => {\n  res.json(await stripe.billingPortal.sessions.create({ customer: req.body.customerId }));\n});\n" });
  await fires('an open update through knex', 'API-001', 'High', { 'server.js': "const app = require('express')();\napp.post('/api/staff/:id', async (req, res) => {\n  await knex('employees').where({ id: req.params.id }).update(req.body);\n  res.json({ ok: true });\n});\n" });
  await quiet('a refund route with a check', 'API-001', { 'server.js': "const app = require('express')();\napp.post('/api/refund', requireAdmin, async (req, res) => {\n  res.json(await stripe.refunds.create({ payment_intent: req.body.paymentIntent }));\n});\n" });
  await quiet('a checkout route is a public act', 'API-001', { 'server.js': "const app = require('express')();\napp.post('/api/checkout', async (req, res) => {\n  res.json(await stripe.checkout.sessions.create({ mode: 'payment', line_items: ITEMS }));\n});\n" });

  // ---- webhooks: a check held somewhere else, and none at all ----
  const WEBHOOK = "app.post('/stripe/webhook', raw, stripeSig, (req, res) => {\n  if (req.body.type === 'checkout.session.completed') grant(req.body);\n  res.send('ok');\n});\n";
  await quiet('a signature check in imported middleware', 'PAY-007', { 'server.js': "const stripeSig = require('./middleware/stripeSig');\n" + WEBHOOK, 'middleware/stripeSig.js': "module.exports = (req, res, next) => { req.body = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], S); next(); };\n" });
  await fires('imported middleware that checks nothing', 'PAY-007', 'High', { 'server.js': "const stripeSig = require('./middleware/stripeSig');\n" + WEBHOOK, 'middleware/stripeSig.js': 'module.exports = (req, res, next) => next();\n' });
  await fires('a middleware name alone proves nothing', 'PAY-007', 'High', { 'server.js': WEBHOOK });
  await quiet('asking Stripe whether the event is real', 'PAY-007', { 'server.js': "app.post('/stripe/webhook', async (req, res) => {\n  const pi = await stripe.paymentIntents.retrieve(req.body.data.object.id);\n  if (pi.status === 'succeeded') grant(pi);\n  res.send('ok');\n});\n" });
  await quiet('a shared secret compared', 'PAY-007', { 'server.js': "app.post('/stripe/webhook', (req, res) => {\n  if (req.headers['x-webhook-secret'] !== process.env.HOOK_SECRET) return res.sendStatus(401);\n  grant(req.body);\n  res.send('ok');\n});\n" });
  await fires('a shared secret only looked at', 'PAY-007', 'High', { 'server.js': "app.post('/stripe/webhook', (req, res) => {\n  console.log(req.headers['x-webhook-secret']);\n  grant(req.body);\n  res.send('ok');\n});\n" });

  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main();
