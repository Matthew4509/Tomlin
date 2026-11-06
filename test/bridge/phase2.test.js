// Phase 2 fixes (5 Nov 2026) in TOMLIN's copy of the Bridge, written before the fixes: F04 wording, Partly for unread
// files, KEY-002 and F11, F13, F02, F14, F18. Run: node test/bridge/phase2.test.js   (git on PATH; temp folders only).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-phase2-'));
process.env.BRIDGE_DATA = path.join(tmp, 'data');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const SRC = path.join(__dirname, '..', '..', 'src', 'bridge'), PUB = path.join(__dirname, '..', '..', 'public', 'bridge');
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const { runAudit } = require(path.join(SRC, 'audit'));
const review = require(path.join(SRC, 'review'));

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const w = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore', windowsHide: true });
const proj = name => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); w(d, 'index.html', '<!doctype html><title>Shop</title>\n'); return d; };
const REAL = 'sb_secret_' + 'Ab3dE6gH9jK2mN5pQ8';

(async () => {
  // ---- KEY-002 and F11 ----
  const k = proj('keys');
  w(k, 'public/real.js', `const k = "${REAL}";\n`);
  w(k, 'public/f11.js', `const k = "${REAL}"; // e.g. sb_secret_example\n`);
  w(k, 'public/f11b.js', `const a = "sb_secret_your_key_here_0123", k = "${REAL}";\n`);
  w(k, 'public/example.js', `const k = "sb_secret_example_0123456789";\n`);
  w(k, 'public/xs.js', `const k = "sb_secret_xxxxxxxxxxxxxxxxxx";\n`);
  const ak = await runAudit(k, null);
  const hit = f => ak.findings.some(x => x.rule === 'KEY-002' && x.where.startsWith(f));
  await check('KEY-002: a Supabase secret key in a file is found', () => assert(hit('public/real.js'), JSON.stringify(ak.findings.map(x => x.rule + '@' + x.where))));
  await check('F11: an example key on the same line does not hide a real one', () => assert(hit('public/f11.js') && hit('public/f11b.js')));
  await check('KEY-002: an example or xxx key alone is left alone', () => assert(!hit('public/example.js') && !hit('public/xs.js')));

  // ---- F13 ----
  const lone = proj('lone');
  fs.rmSync(path.join(lone, 'index.html'));
  w(lone, 'server.js', 'require("http").createServer().listen(3000);\n');
  await check('F13: a project whose only code is server.js lists it for review', () => {
    const g = review.fileGroups(lone);
    assert.strictEqual(g.groups.reduce((n, x) => n + x.files.length, 0), 1, JSON.stringify(g.groups));
  });

  // ---- F02 ----
  const ig = proj('ign');
  w(ig, '.gitignore', 'local/\n');
  w(ig, 'local/api.js', 'app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = " + req.query.id); res.end(); });\nconst K = "sk_live_' + 'q7Zr3Lm9Xc2Vb5Nk8Pw4Yt1H' + '";\n');
  git(ig, 'init', '-q'); git(ig, 'config', 'user.email', 't@example.org'); git(ig, 'config', 'user.name', 'T'); git(ig, 'config', 'commit.gpgsign', 'false');
  git(ig, 'add', '-A'); git(ig, 'commit', '-qm', 'one');
  const ai = await runAudit(ig, null);
  const inLocal = ai.findings.filter(f => /local\/api\.js/.test(f.where));
  await check('F02: an ignored file keeps the full severity of a fault in code that runs', () => {
    const run = inLocal.filter(f => f.area === 'injection' || f.area === 'authorization' || f.area === 'auth');
    assert(run.length && run.every(f => !f.ignored), JSON.stringify(inLocal.map(f => [f.rule, f.area, f.sev, !!f.ignored])));
  });
  await check('F02: an ignored file still softens a leak', () => {
    const leak = inLocal.filter(f => f.area === 'secrets');
    assert(leak.length && leak.every(f => f.ignored && f.sev === 'Medium'), JSON.stringify(inLocal.map(f => [f.rule, f.area, f.sev])));
  });

  // ---- Partly (F03 in TOMLIN) ----
  const big = proj('big');
  w(big, 'huge.js', '// ' + 'x'.repeat(900 * 1024) + '\n');
  const ab = await runAudit(big, null);
  await check('Partly: a code file too big to read makes the audit partly checked and names it', () => {
    assert.strictEqual(ab.partly, true, JSON.stringify(Object.keys(ab)));
    assert(Array.isArray(ab.notRead) && ab.notRead.some(n => /KB|over/.test(n)), JSON.stringify(ab.notRead));
  });
  await check('Partly: a project read whole is not partly', () => assert.strictEqual(ak.partly === true, false));

  // ---- F04 wording (page source) and the Partly row ----
  const ACT = read(path.join(PUB, 'js', 'actions.js'));
  await check('F04: the audit window says "No known faults in the checks that ran", never "Passed every rule"', () => {
    assert(!/Passed every rule/.test(ACT) && /No known faults in the checks that ran/.test(ACT));
    assert(/not proof the app is safe/.test(ACT));
  });
  await check('Partly: the window has an amber Partly row and no green pass when files were not read', () => {
    assert(/◐ Partly/.test(ACT) && /a\.partly/.test(ACT));
    assert(/!major\.length && !partly/.test(ACT), 'the green row is off when partly');
  });

  await check('Partly: the audit list label never says plain Passed for a partly checked audit', () => {
    const CORE = read(path.join(PUB, 'js', 'core.js'));
    const src = CORE.match(/function auditLabel\([^)]*\) \{[\s\S]*?\n\}/)[0];
    const label = new Function('fmtWhen', src + '\nreturn auditLabel;')(() => 'today');
    assert.strictEqual(label({ counts: {}, ranAt: '2026-11-05', partly: true }).text, '◐ Passed, partly checked');
    assert.strictEqual(label({ counts: {}, ranAt: '2026-11-05' }).text, '✓ Passed');
  });

  await check('F22: a review-required finding is marked on its row in the window', () => {
    assert(/f\.confidence === 'review-required'.*check this by hand/.test(ACT));
  });
  await check('F22: the scanner patch rules carry confidence into the finding', async () => {
    const d = proj('conf');
    w(d, 'api.js', 'app.post("/r", (req, res) => { account.role = req.body.role; });\n');
    const r = await runAudit(d, null);
    assert(r.findings.some(f => f.rule === 'AZ-001' && f.confidence === 'review-required'), JSON.stringify(r.findings.map(f => f.rule)));
  });

  // ---- F14 ----
  const HTML = read(path.join(PUB, 'index.html'));
  await check('F14: every nav button and link carries an aria-label (the words hide on a narrow window)', () => {
    const tags = HTML.match(/<(?:button|a)\b[^>]*class="(?:nav-item|brand)[^"]*"[^>]*>/g) || [];
    assert(tags.length >= 8, 'found ' + tags.length);
    const bare = tags.filter(t => !/aria-label="[^"]{2,}"/.test(t));
    assert(!bare.length, bare.join(' '));
  });

  // ---- F18 ----
  const store = require(path.join(SRC, 'audit-store'));
  const sd = proj('shop');
  const p = { id: 'shop', dir: sd, folder: 'shop', name: 'Shop', auditSkip: [], auditSkipOwn: [], auditInclude: [] };
  await store.auditProject(p, null);
  const saved = path.join(process.env.BRIDGE_DATA, 'audits', 'shop.json');
  const before = fs.readFileSync(saved, 'utf8');
  w(sd, 'app.js', 'eval(location.hash);\n');
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { if (/\.tmp$/.test(String(a))) { const e = new Error('no space left'); e.code = 'ENOSPC'; throw e; } return real(a, b); };
  let threw = false;
  try { await store.auditProject(p, null); } catch { threw = true; }
  fs.renameSync = real;
  await check('F18: a save that fails to swap in throws, and the old report is whole', () => { assert(threw); assert.strictEqual(fs.readFileSync(saved, 'utf8'), before); });
  await check('F18: no half-written temp file is left', () => assert(!fs.readdirSync(path.dirname(saved)).some(f => /\.tmp$/.test(f))));

  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
