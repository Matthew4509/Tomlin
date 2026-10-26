// The scan finds what a site really carries: a test script left in the web root, a key behind thousands of pictures,
// a .env saved as UTF-16 (Windows PowerShell's own way), a key inside a long minified line, a big file it did not read
// (said, not silent), and a launch.json with a BOM. Each was missed before (measured 25 Oct).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runAudit } = require('../../src/bridge/audit');
const { findRoots } = require('../../src/bridge/roots');

const rnd = n => crypto.randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const liveKey = () => 'sk_' + 'live_' + rnd(24);
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-scanfix-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const rules = a => new Set(a.findings.map(f => f.rule));
// An ordinary SQL injection, as real code has it. Nothing an antivirus takes for a web shell: ESET deleted a fixture with
// include($_GET[...]) as soon as it was written (25 Oct), and a check on a file that is gone says nothing of the scan.
const SQL = '<?php $user = $db->query("SELECT name FROM users WHERE id = " . $_GET["id"]);\n';
/** The fixture is still there (an antivirus may remove it as it is written): when it is not, the test is skipped and says so. */
const there = (t, file) => {
  if (fs.existsSync(file)) return true;
  t.skip('the antivirus on this PC removed the test file as it was written (an exclusion for %TEMP%\\bridge-scanfix-* lets this run)');
  return false;
};

test('a test script left inside the web root is checked as the live code it is', async t => {
  const dir = project({ 'public_html/test/db.php': SQL, 'public_html/index.php': '<?php echo "hi";' });
  try {
    const a = await runAudit(dir, null);
    if (!there(t, path.join(dir, 'public_html', 'test', 'db.php'))) return;
    assert.ok(rules(a).has('INJ-001'), [...rules(a)].join(','));
    assert.notEqual(a.verdict, 'passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

test('a real test (a test framework\'s file) outside the web root still only counts its Critical faults', async () => {
  const dir = project({ 'tests/DbTest.php': '<?php class DbTest extends TestCase { function testX() { $h = md5($password); } }' });
  try {
    const a = await runAudit(dir, null);
    assert.ok(!rules(a).has('AUTH-001'), 'md5 in a real test is not reported');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

test('thousands of pictures do not use up the scan: the code behind them is read', async () => {
  const files = { 'src/pay.js': `const key = "${liveKey()}";\n` };
  for (let i = 0; i < 6500; i++) files[`assets/img${String(i).padStart(4, '0')}.jpg`] = 'x';
  const dir = project(files);
  try {
    const a = await runAudit(dir, null);
    assert.ok(rules(a).has('SEC-003'), `filesScanned ${a.filesScanned}, verdict ${a.verdict}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

test('a .env saved as UTF-16 (PowerShell 5.1\'s > and Out-File) is read for keys', async () => {
  const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`STRIPE_KEY=${liveKey()}\r\n`, 'utf16le')]);
  const dir = project({ '.env': body });
  try {
    assert.ok(rules(await runAudit(dir, null)).has('SEC-003'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

test('a key inside a long minified line is found', async () => {
  const line = 'var a=' + 'x+'.repeat(3000) + `1;var k="${liveKey()}";` + 'y+'.repeat(500) + '2;';
  const dir = project({ 'app.js': line });
  try {
    assert.ok(rules(await runAudit(dir, null)).has('SEC-003'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

test('a code file too big to read is named in a note, never skipped without a word', async () => {
  const dir = project({ 'big.php': '<?php echo 1;\n// ' + 'z'.repeat(900 * 1024) + '\n' });
  try {
    const a = await runAudit(dir, null);
    assert.ok(a.notes.some(n => /big\.php/.test(n) && /not read/.test(n)), JSON.stringify(a.notes));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); }
});

test('a launch.json saved with a BOM still names the folder the project runs from', () => {
  const launch = JSON.stringify({ version: '0.0.1', configurations: [{ name: 'shop', runtimeExecutable: 'php', runtimeArgs: ['-S', 'localhost:8000', '-t', 'shop'], port: 8000 }] });
  const files = {
    'shop/index.php': '<?php echo 1;', 'shop/cart.php': '<?php echo 2;',
    'shop-php/index.php': '<?php echo 1;', 'shop-php/cart.php': '<?php echo 2;', 'shop-php/more.php': '<?php echo 3;',
  };
  const plain = project({ ...files, '.claude/launch.json': launch });
  const bom = project({ ...files, '.claude/launch.json': '﻿' + launch });
  try {
    const a = findRoots(plain);
    const b = findRoots(bom);
    assert.deepEqual(b, a, 'the same roots with and without a BOM');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true, maxRetries: 10 });
    fs.rmSync(bom, { recursive: true, force: true, maxRetries: 10 });
  }
});
