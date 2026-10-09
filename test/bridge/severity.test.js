// Self-test for scanner training T7: Low and Info severities (they never change the verdict), the ships / repo-only
// split of the disclosure findings, and each rule's record from the judged list ("check this one").
// Run: node test/severity.test.js   (needs git; no packages). Names are made up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { runAudit, summarise } = require('../../src/bridge/audit');
const { disclosurePass } = require('../../src/bridge/disclosure');
const { ruleRecords, CHECK_FILES } = require('../../src/bridge/judged');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-severity-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

(async () => {
  // ---- Low never changes the verdict ----
  check('summarise counts Low and Info; only Low/Info is still "passed"', () => {
    const s = summarise([{ sev: 'Low' }, { sev: 'Info' }, { sev: 'Low' }]);
    assert.deepStrictEqual(s.counts, { Critical: 0, High: 0, Medium: 0, Low: 2, Info: 1 });
    assert.strictEqual(s.verdict, 'passed');
    assert.strictEqual(summarise([{ sev: 'Medium' }, { sev: 'Low' }]).verdict, 'warnings');
  });
  w('low/site/team.html', '<!doctype html><title>Team</title><img alt="The team" src="/team.jpg">\n<p style="font-size:9px">small print</p>\n');
  const L = await runAudit(path.join(tmp, 'low'), null, { root: false });
  check('accessibility polish (A11Y-001, A11Y-003) comes out Low, and the audit passes', () => {
    const a1 = L.findings.find(f => f.rule === 'A11Y-001'), a3 = L.findings.find(f => f.rule === 'A11Y-003');
    assert(a1 && a3 && a1.sev === 'Low' && a3.sev === 'Low', JSON.stringify(L.findings.map(f => f.rule + ' ' + f.sev)));
    assert.strictEqual(L.verdict, 'passed');
  });
  // the Low finding's file is read first, so only the sort puts the Medium one ahead of it
  w('mix/site/a-gallery.html', '<img alt="x" src="/x.png">\n');
  w('mix/site/z-go.php', "<?php\nheader('Location: ' . $_GET['next']);\n");
  const M = await runAudit(path.join(tmp, 'mix'), null, { root: false });
  check('Low findings sort after Medium ones (REDIR-001 before A11Y-003)', () => {
    const order = M.findings.map(f => f.sev);
    assert(order.indexOf('Medium') >= 0 && order.indexOf('Low') > order.lastIndexOf('Medium'), order.join(','));
  });

  // ---- ships or repo only ----
  const other = 'Red' + ' Kite';
  const ctx = { details: [{ label: 'my email', value: 'pat.quill' + '@mailbox.test' }], others: [other], own: ['bluebell'] };
  const dir = path.join(tmp, 'reach');
  w('reach/public/js/app.js', '// from the ' + other + ' project\nconst x = 1;\n');
  w('reach/docs/notes.md', 'Copied from ' + other + '.\n');
  w('reach/tests/run.js', '// like ' + other + '\n');
  w('reach/data/registers.json', '{"from": "' + other + '"}\n');
  w('reach/public/data/menu.json', '{"from": "' + other + '"}\n');
  w('reach/about.txt', 'write to pat.quill' + '@mailbox.test\n');
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=1+p@users.noreply.github.com', '-c', 'user.name=P', ...a], { cwd: dir, windowsHide: true, stdio: 'ignore' });
  git('init', '-q');
  w('reach/old.js', '// ' + other + ' helper\n');
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  fs.unlinkSync(path.join(dir, 'old.js'));
  git('add', '-A'); git('commit', '-q', '-m', 'two');
  const R = await disclosurePass(dir, ctx);
  const sevAt = (rule, re) => (R.findings.find(f => f.rule === rule && re.test(f.where)) || {}).sev;
  check('another project\'s name in a served script stays Medium', () => assert.strictEqual(sevAt('DISC-002', /^public\/js\/app\.js/), 'Medium', JSON.stringify(R.findings.map(f => f.where + ' ' + f.sev))));
  check('in docs, tests and a data file outside the web folder it is Low', () => {
    assert.strictEqual(sevAt('DISC-002', /^docs\/notes\.md/), 'Low');
    assert.strictEqual(sevAt('DISC-002', /^tests\/run\.js/), 'Low');
    assert.strictEqual(sevAt('DISC-002', /^data\/registers\.json/), 'Low');
  });
  check('a data file inside the web folder is served, so Medium', () => assert.strictEqual(sevAt('DISC-002', /^public\/data\/menu\.json/), 'Medium'));
  check('in the git history only it is Info, and says so', () => {
    const f = R.findings.find(x => x.rule === 'DISC-002' && /^git history: old\.js/.test(x.where));
    assert(f && f.sev === 'Info' && /git history only/.test(f.title), JSON.stringify(f));
  });
  check('a private detail stays High even in a repo-only file', () => assert.strictEqual(sevAt('DISC-001', /^about\.txt/), 'High'));

  // ---- each rule's record ----
  const jf = w('judged.json', JSON.stringify({ projects: {
    a: [{ rule: 'X-1', verdict: 'false', file: 'a.php' }, { rule: 'X-1', verdict: 'false', file: 'b.php' }, { rule: 'Y-1', verdict: 'false', file: 'a.php' }],
    b: [{ rule: 'X-1', verdict: 'false', file: 'c.php' }, { rule: 'X-1', verdict: 'false', file: 'c.php' }, { rule: 'Y-1', verdict: 'duplicate', file: 'b.php' }],
  } }));
  const rec = ruleRecords(jf, { 'X-1': 2, 'Y-1': 0, 'Z-1': 9 });
  check('a rule set aside in ' + CHECK_FILES + '+ files, more often than it stands, is marked check', () => {
    assert.deepStrictEqual(rec['X-1'], { false: 4, files: 3, standing: 2, check: true });
  });
  check('fewer files, or standing more often, is not marked; duplicates do not count as wrong', () => {
    assert.strictEqual(rec['Y-1'].check, false); assert.strictEqual(rec['Y-1'].false, 1);
    assert.strictEqual(ruleRecords(jf, { 'X-1': 4 })['X-1'].check, false);
    assert.strictEqual(rec['Z-1'].check, false);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
