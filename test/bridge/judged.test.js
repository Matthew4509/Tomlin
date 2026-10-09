// Self-test for the judged list (lib/judged.js) and the Phase 5 false-flag fixes. Each fix has a case that must stay
// quiet (the false flag it stops) and a twin that must still fire (so the fix cannot hide a real one).
// Run: node test/judged.test.js   (no packages; git is used for the folder listing only).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runAudit } = require('../../src/bridge/audit');
const { disclosurePass, makeMatcher } = require('../../src/bridge/disclosure');
const J = require('../../src/bridge/judged');
const { listProjects } = require('../../src/bridge/projects');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-judged-test-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const rulesAt = (r, file) => r.findings.filter(f => f.where.replace(/:\d+$/, '') === file).map(f => f.rule);
const STORE = path.join(tmp, 'data', 'judged.json');

// A stored zip with the given entries (enough for the pass to read).
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const body = Buffer.from(e.data), name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function main() {
  // ---------- the judged list ----------
  const app = path.join(tmp, 'app');
  w('app/ui.js', 'const a = 1;\nout.innerHTML = localStorage.getItem("x");\n');
  w('app/two.js', 'one.innerHTML = location.hash;\ntwo.innerHTML = location.search;\n');
  w('app/public_html/dump.sql', '--');
  const key = 'c:\\projects\\app';
  let r0 = await runAudit(app, null);
  const inj = r0.findings.find(f => f.rule === 'INJ-003' && f.where.startsWith('ui.js'));
  check('a planted INJ-003 fires (the case to judge)', () => assert(inj && inj.fp));

  let res = J.addEntry(STORE, key, { rule: 'INJ-003', where: inj.where, fp: inj.fp, verdict: 'false', why: 'fixed text only', by: 'Robin' }, app);
  check('an entry is saved with its reason, who said it and the line text', () => assert(res.ok && res.entry.by === 'Robin' && res.entry.text === 'out.innerHTML = localStorage.getItem("x");' && res.entry.fp === inj.fp));
  let r1 = await runAudit(app, null, { judged: J.entriesFor(STORE, key) });
  check('the judged finding is set aside and listed with its reason', () => assert(!rulesAt(r1, 'ui.js').length && r1.setAside.length === 1 && r1.setAside[0].judged.why === 'fixed text only' && r1.setAside[0].judged.by === 'Robin'));
  check('only that place: the same rule still fires in another file', () => assert(rulesAt(r1, 'two.js').includes('INJ-003')));
  w('app/ui.js', 'const a = 1;\n\n\nout.innerHTML   =  localStorage.getItem("x");\n');
  let r2 = await runAudit(app, null, { judged: J.entriesFor(STORE, key) });
  check('moving the line or changing its spacing keeps it set aside', () => assert(!rulesAt(r2, 'ui.js').length && r2.setAside.length === 1));
  w('app/ui.js', 'const a = 1;\nout.innerHTML = localStorage.getItem("y");\n');
  let r3 = await runAudit(app, null, { judged: J.entriesFor(STORE, key) });
  check('an edited line comes back', () => assert(rulesAt(r3, 'ui.js').includes('INJ-003') && !r3.setAside.length));

  // A project-wide "false" is refused, on save and when read from a hand-edited file.
  check('a "false" with no file is refused on save', () => assert(!J.addEntry(STORE, key, { rule: 'INJ-003', where: '', verdict: 'false', why: 'all fine' }, app).ok));
  check('a "false" for "*" is refused on save', () => assert(!J.addEntry(STORE, key, { rule: 'INJ-003', where: '*', verdict: 'false', why: 'all fine' }, app).ok));
  check('a "false" with no reason is refused', () => assert(!J.addEntry(STORE, key, { rule: 'INJ-003', where: 'two.js:1', verdict: 'false', why: '' }, app).ok));
  const handMade = [{ id: 'h1', rule: 'INJ-003', file: '*', verdict: 'false', why: 'silence it', fp: 'x' }, { id: 'h2', rule: 'INJ-003', file: 'two.js', verdict: 'false', why: 'whole file' }];
  let r4 = await runAudit(app, null, { judged: handMade });
  check('a hand-written project-wide or file-wide "false" is not used, and says so', () => assert(rulesAt(r4, 'two.js').includes('INJ-003') && !r4.setAside.length && r4.notes.filter(n => /was not used/.test(n)).length === 2));
  // Judging by file:line reads the line from the project; "duplicate of" keeps the finding and tags it.
  res = J.addEntry(STORE, key, { rule: 'INJ-003', where: 'two.js:1', verdict: 'duplicate', duplicateOf: 'ap-012', why: 'known', by: 'report' }, app);
  let r5 = await runAudit(app, null, { judged: J.entriesFor(STORE, key) });
  const dup = r5.findings.find(f => f.rule === 'INJ-003' && f.where.startsWith('two.js'));
  check('"duplicate of <id>" keeps the finding counted and tags it', () => assert(res.ok && dup && dup.knownAs === 'AP-012' && r5.counts.Medium >= 1));
  // A finding with no line (a file) is judged by its place.
  const exp = r0.findings.find(f => f.rule === 'EXP-002');
  res = J.addEntry(STORE, key, { rule: 'EXP-002', where: exp.where, fp: null, verdict: 'false', why: 'blocked by the host', by: 'me' }, app);
  let r6 = await runAudit(app, null, { judged: J.entriesFor(STORE, key) });
  check('a finding with no line is judged by its exact place', () => assert(res.ok && !r6.findings.some(f => f.rule === 'EXP-002') && r6.setAside.some(f => f.rule === 'EXP-002')));
  const id = r6.setAside.find(f => f.rule === 'EXP-002').judged.id;
  J.removeEntry(STORE, key, id);
  let r7 = await runAudit(app, null, { judged: J.entriesFor(STORE, key) });
  check('Bring back: removing the entry makes it count again', () => assert(r7.findings.some(f => f.rule === 'EXP-002')));
  check('a disclosure line is never stored as text', () => {
    const e = J.addEntry(STORE, key, { rule: 'DISC-001', where: 'ui.js:2', verdict: 'false', why: 'my own public address', by: 'me' }, app).entry;
    assert(e && e.fp && !('text' in e));
  });

  // ---------- report-back tables ----------
  const md = [
    '# Report back', '## 2. Register ids', '| Id | Status |', '|---|---|', '| AP-1 | fixed |',
    '## 3. False flags (the part the scanner learns from)',
    '| Rule | Where it pointed (file:line or URL) | Verdict | Why it is wrong | What the rule should do instead |',
    '|---|---|---|---|---|',
    '| INJ-003 | ui.js:2 | false | the text is fixed | read the call |',
    '| INJ-003 | two.js:1, two.js:2 | false | both from a list | — |',
    '| INJ-003 | two.js | false | the one finding there | — |',
    '| INJ-003 | gone.js | false | whole file | — |',
    '| INJ-003 | * | false | silence it | — |',
    '| EXP-002 | public_html/dump.sql | real but elsewhere (x.sql) | moved | — |',
    '| none | | | | |',
    '## 4. Missed by the audit', '| What | Where | Severity |', '| x | y | High |'].join('\n');
  const rows = J.parseReportBack(md);
  check('the False flags table is read, two places in one row split, other tables left alone', () => assert(rows.length === 7 && rows[1].where === 'two.js:1' && rows[2].where === 'two.js:2' && rows[0].ruleShould === 'read the call', JSON.stringify(rows)));
  const store2 = path.join(tmp, 'data', 'judged2.json');
  const last = (await runAudit(app, null)).findings;
  const out = J.importRows(store2, key, rows, last, app, 'project thread', 'report-back');
  check('import: a row naming a line, or a file with one finding, is pinned to it', () => assert(out[0].ok && out[1].ok && out[2].ok && out[3].ok));
  check('import: no line and no single finding there is refused (it would judge a whole file)', () => assert(!out[4].ok && /name the line/.test(out[4].error)));
  check('import: "real but elsewhere" is not a judgement and is left alone', () => assert(!out[6].ok && /not "false"/.test(out[6].error)));
  check('import: a "false" for "*" is refused as project-wide', () => assert(!out[5].ok && /whole project/.test(out[5].error)));
  let r8 = await runAudit(app, null, { judged: J.entriesFor(store2, key) });
  check('imported rows set the findings aside, by the project thread', () => assert(!r8.findings.some(f => f.rule === 'INJ-003') && r8.setAside.filter(f => f.judged.by === 'project thread').length === 2));

  // ---------- a project cannot vouch for itself ----------
  const root = path.join(tmp, 'work');
  w('work/mine/project.json', JSON.stringify({ auditAccept: [{ rule: 'INJ-003', file: 'a.js', fp: 'abc' }], auditSkip: ['src'] }));
  w('work/other/x.txt', 'x');
  w('bridge-projects.json', JSON.stringify({ projects: { other: { auditAccept: [{ rule: 'EXP-002', file: 'a.sql', reason: 'ok' }] } } }));
  const list = listProjects({ workingFolders: [root] }, { overridesFile: path.join(tmp, 'bridge-projects.json') });
  const mine = list.find(p => p.folder === 'mine'), other = list.find(p => p.folder === 'other');
  check('a project\'s own project.json cannot set its findings aside (counted, not used)', () => assert(mine.auditAccept.length === 0 && mine.auditAcceptOwn === 1));
  check('its own auditSkip is still used but named', () => assert(mine.auditSkip[0] === 'src' && mine.auditSkipOwn[0] === 'src'));
  check('the Bridge\'s projects.json still sets aside', () => assert(other.auditAccept.length === 1 && other.auditAcceptOwn === 0));

  // ---------- false-flag fixes: code rules ----------
  w('code/pw.js', 'const run = async p => { const v = await p.$eval("#b", el => el.value); };');
  w('code/ev.js', 'eval(input.value);');
  w('code/labels.php', "<?php $map = ['home' => 'account', 'password' => 'password'];");
  w('code/dev.php', "<?php $c = ['db_pass' => 'devonly_notasecret'];");
  w('code/real.php', "<?php $c = ['password' => 'Hunter2Real!'];");
  w('code/confirm.php', '<form method="post" action="verify.php">\n  <input type="hidden" name="t" value="<?= h($token) ?>">\n  <button>Confirm</button>\n</form>');
  w('code/claim.php', '<form method="post">\n  <input type="hidden" name="cm_claim" value="<?= e((string) $claim[\'token\']) ?>">\n</form>');
  w('code/plain.php', '<form method="post" class="row">\n  <input type="hidden" name="action" value="generate">\n  <button>Go</button>\n</form>');
  const rc = await runAudit(path.join(tmp, 'code'), null);
  check('INJ-010 quiet: page.$eval(...)', () => assert(!rulesAt(rc, 'pw.js').includes('INJ-010'), JSON.stringify(rulesAt(rc, 'pw.js'))));
  check('INJ-010 still fires: eval of a typed value', () => assert(rulesAt(rc, 'ev.js').includes('INJ-010')));
  check('SEC-004 quiet: \'password\' => \'password\' is a label', () => assert(!rulesAt(rc, 'labels.php').includes('SEC-004')));
  check('SEC-004 quiet: a dev-only "notasecret" value', () => assert(!rulesAt(rc, 'dev.php').includes('SEC-004')));
  check('SEC-004 still fires: a real-looking password', () => assert(rulesAt(rc, 'real.php').includes('SEC-004')));
  check('CSRF-001 quiet: a form carrying the token from an email link', () => assert(!rulesAt(rc, 'confirm.php').includes('CSRF-001')));
  check('CSRF-001 quiet: an installer form carrying its claim token', () => assert(!rulesAt(rc, 'claim.php').includes('CSRF-001')));
  check('CSRF-001 still fires: a hidden field with a fixed value is not a token', () => assert(rulesAt(rc, 'plain.php').includes('CSRF-001')));

  // ---------- false-flag fixes: disclosure ----------
  const scan = makeMatcher({ details: [{ label: 'user', value: 'Wren', near: true }, { label: 'git name', value: 'quillcoder', allowInLink: true }], others: [], own: [] });
  const hits = text => scan(text).map(h => h.rule + ':' + [...h.labels].join(','));
  check('short user name quiet as a word ("Wren\'s support page", "FAIRY WREN")', () => assert(!hits("See Wren's support page.\n['FAIRY WREN','VIC']").length));
  check('short user name fires against a path or an @', () => assert(hits('C:/' + 'Users/Wren/x').length && hits('mail wren@example.test').length && hits('\\\\server\\wren\\share').length));
  check('git name quiet inside a link to your public repo', () => assert(!hits('Download from https://github.com/quillcoder/app/releases').length));
  check('git name still fires in plain text', () => assert(hits('Ask quillcoder about it').some(h => h.startsWith('DISC-001'))));
  const paths = ['/home/youraccount/public_html/x', '/home/YOUR-CPANEL-USERNAME/public_html/x', 'It looks like /home/jsmith/ in File Manager', "assert(cwd, '/home/operator/logs')"];
  check('DISC-004 quiet: placeholder and made-up users', () => assert(paths.every(p => !hits(p).some(h => h.startsWith('DISC-004'))), paths.filter(p => hits(p).length).join(' | ')));
  check('DISC-004 still fires: a real-looking user', () => assert(hits('error_log = "/home/' + 'redfern/logs/php.log"').some(h => h.startsWith('DISC-004'))));
  check('DISC-003 quiet: a thread number of 8 digits', () => assert(!hits('worker thr' + 'ead 12345678 started').length));
  check('DISC-003 still fires: a thread id with letters in it', () => assert(hits('see thr' + 'ead 1a2b3c4d').some(h => h.startsWith('DISC-003'))));

  // A working-notes file is one finding: what its lines hold is named in it, and a private detail makes it High.
  const ctx = { details: [{ label: 'my email', value: 'pat.quill' + '@mailbox.test' }], others: ['Snowfinch'], own: ['bluebell'] };
  w('notes/HANDOFF-PLAN.md', 'Mail pat.quill' + '@mailbox.test\nCopied from Snowfinch.\n');
  w('notes/plain.md', 'Mail pat.quill' + '@mailbox.test\nCopied from Snowfinch.\n');
  const dn = await disclosurePass(path.join(tmp, 'notes'), ctx);
  const ho = dn.findings.filter(f => f.where.startsWith('HANDOFF-PLAN.md'));
  check('a working-notes file: one finding, High, naming what it holds', () => assert(ho.length === 1 && ho[0].rule === 'DISC-003' && ho[0].sev === 'High' && /my email/.test(ho[0].title) && /other projects/.test(ho[0].title), JSON.stringify(ho)));
  check('the same lines in an ordinary file are still reported line by line', () => assert(['DISC-001', 'DISC-002'].every(r => rulesAt(dn, 'plain.md').includes(r))));
  w('notes2/HANDOFF-PLAN.md', 'Copied from Snowfinch.\n');
  const fpBefore = (await disclosurePass(path.join(tmp, 'notes2'), ctx)).findings[0].fp;
  w('notes2/HANDOFF-PLAN.md', 'Copied from Snowfinch.\nMail pat.quill' + '@mailbox.test\n');
  const fpAfter = (await disclosurePass(path.join(tmp, 'notes2'), ctx)).findings[0].fp;
  check('a new kind of detail in a set-aside notes file changes its fingerprint (it comes back)', () => assert(fpBefore && fpAfter && fpBefore !== fpAfter));

  // The same line in the file and in the zip that ships it is one finding, with the other place listed.
  w('ship/config.txt', 'owner = pat.quill' + '@mailbox.test\n');
  w('ship/other.txt', 'second = pat.quill' + '@mailbox.test\n');
  w('ship/build/app-1.0.zip', makeZip([{ name: 'config.txt', data: 'owner = pat.quill' + '@mailbox.test\n' }, { name: 'other.txt', data: 'changed = pat.quill' + '@mailbox.test\n' }]));
  const ds = await disclosurePass(path.join(tmp, 'ship'), ctx);
  const cfgHits = ds.findings.filter(f => /config\.txt/.test(f.where));
  check('the same line in the file and in a zip: one finding at the file, the zip listed', () => assert(cfgHits.length === 1 && cfgHits[0].where === 'config.txt:1' && cfgHits[0].also && /app-1\.0\.zip > config\.txt/.test(cfgHits[0].also[0]), JSON.stringify(cfgHits)));
  check('a different line in the zip is still its own finding', () => assert(ds.findings.filter(f => /other\.txt/.test(f.where)).length === 2));
}

main().catch(e => { failures++; console.log('FAIL crashed: ' + (e.stack || e)); }).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
});
