// Finding the app inside a project folder (lib/roots.js): old copies, unpacked releases and side-by-side versions are
// left out of the code rules and named in the notes; git-published copies are still read for private details.
// Run: node test/roots.test.js   (no packages). Everything is made in a temp folder and removed after.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { findRoots } = require('../../src/bridge/roots');
const { runAudit } = require('../../src/bridge/audit');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-roots-'));
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const age = (rel, days) => { const t = new Date(Date.now() - days * 86400000); const walk = p => { if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n)); fs.utimesSync(p, t, t); }; walk(path.join(tmp, rel)); };
const rels = r => r.left.map(l => l.rel).sort();
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const FAULT = '<?php include($_GET["page"]);\n'; // INJ-002: one planted code fault
const EMAIL = 'robin.lark@mailbox.test';

async function main() {
  // ---- parts of one app are not copies, however alike their names ----
  for (const [a, b] of [['todo-api', 'todo-web'], ['shop-frontend', 'shop-backend'], ['blog', 'blog-mobile'], ['notes_client', 'notes_server']]) {
    const d = path.join(tmp, 'split-' + a);
    fs.mkdirSync(path.join(d, a), { recursive: true });
    fs.mkdirSync(path.join(d, b), { recursive: true });
    fs.writeFileSync(path.join(d, 'README.md'), 'Notes.\n');
    fs.writeFileSync(path.join(d, a, 'index.php'), '<?php echo 1;\n');
    fs.writeFileSync(path.join(d, b, 'index.html'), '<title>x</title>\n');
    const old = new Date(Date.now() - 86400000 * 30);
    fs.utimesSync(path.join(d, a, 'index.php'), old, old);
    const r = findRoots(d);
    check(a + '/ and ' + b + '/ are two parts of one app: neither is left out', () => assert.deepStrictEqual(r.left.map(l => l.rel), []));
  }
  // The real app kept in old/, with only a docs folder beside it: old/ is what there is.
  const docsBeside = path.join(tmp, 'docs-beside');
  fs.mkdirSync(path.join(docsBeside, 'old'), { recursive: true });
  fs.mkdirSync(path.join(docsBeside, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(docsBeside, 'old', 'index.php'), '<?php echo 1;\n');
  fs.writeFileSync(path.join(docsBeside, 'docs', 'index.html'), '<title>x</title>\n');
  check('a docs folder beside old/ does not make old/ a copy of anything', () => assert(!findRoots(docsBeside).left.some(l => l.rel === 'old')));

  // ---- 1. copies side by side, nothing of its own at the top ----
  w('side/lantern/index.php', FAULT); w('side/lantern/README.md', '# Lantern\n');
  w('side/lantern-php/index.php', FAULT);
  w('side/lantern-fixes/index.php', FAULT);
  age('side/lantern', 40); age('side/lantern-fixes', 20);
  const S = findRoots(path.join(tmp, 'side'));
  check('the newest of the copies side by side is the app', () => assert(S.app && S.app.rel === 'lantern-php', JSON.stringify(S.app)));
  check('the older copy and the fixes copy are left out, each with its reason', () => {
    assert.deepStrictEqual(rels(S), ['lantern', 'lantern-fixes']);
    assert(/older copy beside lantern-php/.test(S.left.find(l => l.rel === 'lantern').why));
    assert(/fixes/.test(S.left.find(l => l.rel === 'lantern-fixes').why));
  });
  check('the notes name the app and every folder left out, and the way to bring one back', () => {
    const n = S.notes.join(' ');
    assert(/Scanned as the app: lantern-php\//.test(n) && /lantern\/ \(/.test(n) && /lantern-fixes\//.test(n) && /auditInclude/.test(n), n);
  });

  // ---- 2. launch.json picks the app, even when it is not the newest ----
  w('launched/.claude/launch.json', JSON.stringify({ configurations: [{ name: 'dev', runtimeExecutable: 'php', runtimeArgs: ['-S', 'localhost:8000', '-t', 'harbour'], port: 8000 }] }));
  w('launched/harbour/index.php', FAULT); w('launched/harbour-next/index.php', FAULT);
  age('launched/harbour', 30);
  const L = findRoots(path.join(tmp, 'launched'));
  check('the folder launch.json starts is the app', () => assert(L.app && L.app.rel === 'harbour' && /launch\.json/.test(L.app.why) && rels(L).join() === 'harbour-next', JSON.stringify(L)));

  // ---- 3. copies by name inside an app folder ----
  w('named/index.php', '<?php echo "home";\n');
  w('named/original project files/index.php', FAULT);
  w('named/site-v1.2.3/index.php', FAULT); w('named/site-v1.2.3.zip', 'zip');
  w('named/releases/v1.0.4/index.php', FAULT);
  w('named/old/index.php', FAULT);
  w('named/chart-4.4.1/chart.js', 'var c = 1;\n');      // a library folder: versioned, but no zip and no sibling
  w('named/frontend/app.js', 'var a = 1;\n'); w('named/backend/server.js', 'var b = 1;\n');
  const N = findRoots(path.join(tmp, 'named'));
  check('original files, an unpacked release beside its zip, a release folder\'s copy and old/ are left out', () =>
    assert.deepStrictEqual(rels(N), ['old', 'original project files', 'releases/v1.0.4', 'site-v1.2.3'], rels(N).join(', ')));
  check('a versioned library folder, frontend/ and backend/ are scanned (parts of the app, not copies)', () =>
    assert(!rels(N).some(r => /chart|frontend|backend/.test(r)) && !N.app));
  w('parts/admin/index.php', '<?php echo 1;\n'); w('parts/admin-api/index.php', '<?php echo 2;\n');
  check('admin/ and admin-api/ share a name but are parts of one app, not copies', () => { const P = findRoots(path.join(tmp, 'parts')); assert(!P.left.length && !P.app, JSON.stringify(P)); });
  check('the zip is named as the reason', () => assert(/site-v1\.2\.3\.zip is beside it/.test(N.left.find(l => l.rel === 'site-v1.2.3').why)));
  const I = findRoots(path.join(tmp, 'named'), { include: ['old/'] });
  check('auditInclude brings a folder back', () => assert(!rels(I).includes('old') && rels(I).includes('site-v1.2.3')));

  // ---- 3b. a name alone is not a copy: "-fixes", "old-" and "-old" need the folder they would be a copy of ----
  for (const live of ['css-fixes', 'app-fixes', 'old-posts', 'posts-old']) w('alone/' + live + '/index.php', FAULT);
  w('alone/index.php', '<?php echo "home";\n');
  const AL = findRoots(path.join(tmp, 'alone'));
  check('css-fixes/, app-fixes/, old-posts/ and posts-old/ with nothing they copy are part of the project', () => assert.deepStrictEqual(rels(AL), [], rels(AL).join(', ')));
  w('pairs/index.php', '<?php echo "home";\n');
  for (const n of ['my-app', 'my-app-fixes', 'shop', 'shop-old', 'blog', 'old-blog']) w('pairs/' + n + '/index.php', FAULT);
  const PR = findRoots(path.join(tmp, 'pairs'));
  check('beside the folder they copy they are copies: my-app-fixes/, shop-old/, old-blog/', () => assert.deepStrictEqual(rels(PR), ['my-app-fixes', 'old-blog', 'shop-old'], rels(PR).join(', ')));
  w('bare/index.php', '<?php echo "home";\n');
  for (const n of ['old', 'backup', 'archive']) w('bare/' + n + '/index.php', FAULT);
  const BA = findRoots(path.join(tmp, 'bare'));
  check('bare old/, backup/ and archive/ stay copies', () => assert.deepStrictEqual(rels(BA), ['archive', 'backup', 'old'], rels(BA).join(', ')));
  // A folder taken as a copy that git would publish goes up with the project: not a clean read, and its keys are read.
  const KEY = 'sk_' + 'live_' + 'Q3x9Lm2Vb7Tn4Rk8Wd5Hj6Zp';
  w('tracked/index.php', '<?php echo "home";\n'); w('tracked/archive/pay.js', 'const k = "' + KEY + '";\n'); w('tracked/old/ok.txt', 'x\n');
  const gitT = (...args) => execFileSync('git', ['-C', path.join(tmp, 'tracked'), ...args], { stdio: 'ignore', windowsHide: true });
  gitT('init', '-q'); gitT('config', 'user.email', '1+robin@users.noreply.github.com'); gitT('config', 'user.name', 'Robin'); gitT('config', 'commit.gpgsign', 'false'); gitT('add', '-A'); gitT('commit', '-qm', 'first');
  const TA = await runAudit(path.join(tmp, 'tracked'), null, { disclosure: { details: [], others: [], own: ['tracked'] } });
  check('a tracked archive/ counts as not read, and the key in it is found', () => {
    assert(TA.partly && TA.notRead.includes('Folders taken as old copies, read for keys only: archive, old'), JSON.stringify(TA.notRead));
    assert(TA.findings.some(f => f.rule === 'SEC-003' && f.where === 'archive/pay.js:1'), TA.findings.map(f => f.rule + '@' + f.where).join(', '));
  });

  // ---- 4. a folder whose only code is an old copy keeps it ----
  w('only/HANDOFF.md', '# notes\n'); w('only/original-2026-01-31/app.js', 'var x = 1;\n');
  const O = findRoots(path.join(tmp, 'only'));
  check('a folder that only keeps an original copy still scans it', () => assert(!O.left.length && O.app && O.app.rel === 'original-2026-01-31' && /only copy/.test(O.app.why), JSON.stringify(O)));
  const E = findRoots(path.join(tmp, 'side', 'lantern-php'));
  check('a plain app folder leaves nothing out and says nothing', () => assert(!E.left.length && !E.app && !E.notes.length));

  // ---- 5. the audit: faults in copies are not counted; the app's are; skips are listed ----
  const A = await runAudit(path.join(tmp, 'side'), null, {});
  check('the audit counts the fault in the app only', () => {
    const at = A.findings.filter(f => f.rule === 'INJ-002').map(f => f.where);
    assert(at.length === 1 && /^lantern-php\//.test(at[0]) && !(A.findings.find(f => f.rule === 'INJ-002').also || []).length, JSON.stringify(A.findings));
  });
  check('the report lists the copies left out (never hidden)', () => assert(A.copiesLeftOut.length === 2 && A.app.rel === 'lantern-php' && A.notes.some(n => /Left out as copies/.test(n))));
  const Z = await runAudit(path.join(tmp, 'side'), null, { root: false });
  check('root: false scans every copy (the old behaviour)', () => assert(Z.findings.filter(f => f.rule === 'INJ-002').length + (Z.findings.find(f => f.rule === 'INJ-002').also || []).length === 3));

  // ---- 6. disclosure: a copy git would publish is still read for private details ----
  const git = (dir, ...args) => execFileSync('git', ['-C', path.join(tmp, dir), ...args], { stdio: 'ignore', windowsHide: true });
  for (const d of ['pub', 'ign']) {
    w(d + '/index.php', '<?php echo "home";\n');
    w(d + '/original project files/notes.txt', 'write to ' + EMAIL + '\n');
    git(d, 'init', '-q'); git(d, 'config', 'user.email', '1+robin@users.noreply.github.com'); git(d, 'config', 'user.name', 'Robin'); git(d, 'config', 'commit.gpgsign', 'false');
  }
  w('ign/.gitignore', 'original project files/\n');
  git('pub', 'add', '-A'); git('pub', 'commit', '-q', '-m', 'first');
  git('ign', 'add', '-A'); git('ign', 'commit', '-q', '-m', 'first');
  const ctx = { details: [{ label: 'my email', value: EMAIL }], others: [], own: ['pub'] };
  const P = await runAudit(path.join(tmp, 'pub'), null, { disclosure: ctx });
  check('a tracked old copy is still read for private details (git publishes it), and the note says why', () =>
    assert(P.findings.some(f => f.rule === 'DISC-001' && /^original project files\//.test(f.where)) && P.notes.some(n => /git would publish/.test(n)), JSON.stringify(P.findings.map(f => f.rule + ' ' + f.where))));
  const G = await runAudit(path.join(tmp, 'ign'), null, { disclosure: { ...ctx, own: ['ign'] } });
  check('an old copy git ignores is left out of the private-detail pass too', () =>
    assert(!G.findings.some(f => f.rule === 'DISC-001') && G.copiesLeftOut[0].publishes === false, JSON.stringify(G.findings.map(f => f.rule + ' ' + f.where))));
  w('plain/index.php', '<?php echo "home";\n'); w('plain/old/notes.txt', 'write to ' + EMAIL + '\n');
  const Q = await runAudit(path.join(tmp, 'plain'), null, { disclosure: { ...ctx, own: ['plain'] } });
  check('with no git repository, an old copy is left out of the private-detail pass', () => assert(!Q.findings.some(f => f.rule === 'DISC-001')));

  // a left-out copy that is its own git repository is not named as "read" in the nested-repository note
  for (const d of ['side/lantern', 'side/lantern-php']) { git(d, 'init', '-q'); git(d, 'config', 'user.email', '1+robin@users.noreply.github.com'); git(d, 'config', 'user.name', 'Robin'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'first'); }
  const R = await runAudit(path.join(tmp, 'side'), null, { disclosure: { ...ctx, own: ['side'] } });
  check('the note on repositories inside names only the ones that were read', () => {
    const n = R.notes.find(x => /Git repositories inside/.test(x)) || '';
    assert(/lantern-php\//.test(n) && !/[(\s]lantern\//.test(n), n);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main();
