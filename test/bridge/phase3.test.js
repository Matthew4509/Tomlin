// Phase 3 fixes (5 Nov): a too-big file that git ignores is no gap (it never leaves this PC); a tracked one still is.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-phase3-'));
process.env.BRIDGE_DATA = path.join(tmp, 'data');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const { runAudit } = require(path.join(__dirname, '..', '..', 'src', 'bridge', 'audit'));
const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore', windowsHide: true });
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
function mk(name, ignoreBig) {
  const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>Shop</title>\n');
  fs.writeFileSync(path.join(d, 'big.js'), 'a'.repeat(900 * 1024));
  if (ignoreBig) fs.writeFileSync(path.join(d, '.gitignore'), 'big.js\n');
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 't@example.org'); git(d, 'config', 'user.name', 'T'); git(d, 'config', 'commit.gpgsign', 'false');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'one');
  return d;
}
(async () => {
  const ig = await runAudit(mk('ignored', true), null);
  const tr = await runAudit(mk('tracked', false), null);
  await check('a too-big file that git ignores leaves the audit not partly', () => assert.strictEqual(ig.partly, false, JSON.stringify(ig.notRead)));
  await check('...and its "not read" note is gone', () => assert(!ig.notes.some(n => /not read/.test(n)), JSON.stringify(ig.notes)));
  await check('a too-big file git keeps still makes it partly', () => assert.strictEqual(tr.partly, true));
  const PUB = path.join(__dirname, '..', '..', 'public', 'bridge'), rd = f => fs.readFileSync(f, 'utf8');
  await check('#59: the zip backup text says a zip is not encrypted and "read back" only means whole', () => {
    const t = rd(path.join(PUB, 'js', 'backups.js'));
    assert(/not encrypted/i.test(t) && /whole, not private|not private/i.test(t));
  });
  await check('#65: the Live tip says one availability request, not logins, data or alerts', () => {
    const t = rd(path.join(PUB, 'js', 'panels.js'));
    assert(/one availability request/i.test(t) && /logins/i.test(t));
  });
  await check('#72: the README says a pass or a rule count is not a claim of security', () => {
    const t = rd(path.join(__dirname, '..', '..', 'README.md'));
    assert(/rule count/i.test(t) && /not proof/i.test(t));
  });
  const sql = path.join(tmp, 'sqlq'); fs.mkdirSync(sql, { recursive: true });
  fs.writeFileSync(path.join(sql, 'plain.sql'), 'CREATE POLICY "open" ON items FOR INSERT TO anon WITH CHECK (true);\n');
  fs.writeFileSync(path.join(sql, 'quoted.sql'), 'CREATE POLICY "open2" ON items FOR INSERT TO "anon" WITH CHECK (true);\n');
  fs.writeFileSync(path.join(sql, 'owner.sql'), 'CREATE POLICY "own" ON items FOR INSERT TO "authenticated" WITH CHECK (auth.uid() = user_id);\n');
  const asql = await runAudit(sql, null);
  const db = f => asql.findings.some(x => x.rule === 'DBSEC-002' && x.where.startsWith(f));
  await check('#19: a policy for a quoted role is judged like an unquoted one', () => assert(db('plain.sql') && db('quoted.sql'), JSON.stringify(asql.findings.map(x => x.rule + '@' + x.where))));
  await check('#19: an owner-checked policy for a quoted role stays quiet', () => assert(!db('owner.sql')));
  await check('#52: an audit older than the project\'s last change is marked, a current one is not', () => {
    const CORE = fs.readFileSync(path.join(PUB, 'js', 'core.js'), 'utf8');
    const src = CORE.match(/function auditLabel\([^)]*\) \{[\s\S]*?\n\}/)[0];
    const label = new Function('fmtWhen', src + '\nreturn auditLabel;')(() => 'today');
    const ran = '2026-11-05T10:00:00.000Z', t = Date.parse(ran);
    const fresh = label({ counts: {}, ranAt: ran }, t - 1000), old = label({ counts: { High: 1 }, ranAt: ran }, t + 3600e3);
    assert.strictEqual(fresh.text, '✓ Passed');
    assert(/changed since/i.test(old.text) && /High/.test(old.text), old.text);
    assert.strictEqual(old.stale, true);
    assert.strictEqual(label({ counts: {}, ranAt: ran }).stale === true, false, 'no update time: never marked');
  });
  if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
})();
