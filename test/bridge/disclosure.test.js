// Self-test for the disclosure pass (lib/disclosure.js): each check has a twin that must stay quiet, a planted email is
// found in git history and in a zip inside a zip, and no planted value ever appears in what the pass returns.
// Run: node test/disclosure.test.js   (needs git; no packages). Text the pass would flag in THIS file (an AI sign-off,
// a thread id, a user's folder) is assembled at run time, so the Bridge's own folder still scans clean.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { disclosurePass, autoDetails, savePrivateList, readPrivateList, listForPage } = require('../../src/bridge/disclosure');
const { runAudit, fingerprint } = require('../../src/bridge/audit');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-disclosure-test-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

// Made-up details. The values must never come back out.
const EMAIL = 'pat.quill' + '@mailbox.test';
const PHONE = '0400 123 456';
const HELPER = 'helper.wren' + '@mailbox.test';
const NAME = 'Pat Quillfeather';
const VALUES = [EMAIL, PHONE, '0400123456', HELPER, NAME];
const ctx = {
  details: [{ label: 'my email', value: EMAIL }, { label: 'my phone', value: PHONE }, { label: 'my name', value: NAME, allowOn: /\bcopyright\b/i }],
  others: ['red kite', 'notes', 'map-store', 'Snowfinch'],
  own: ['bluebell'],
};
const SIGN = 'Co-' + 'Authored-By: ' + 'Claude <x@y>';
const THREAD = 'thr' + 'ead 1a2b3c4d';
const HOME = 'C:' + '\\Users\\' + 'rowan' + '\\proj';

const NOHOOKS = path.join(tmp, 'no-hooks');
function git(dir, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=' + NOHOOKS, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'P', GIT_COMMITTER_NAME: 'P', GIT_AUTHOR_EMAIL: '1+p@users.noreply.github.com', GIT_COMMITTER_EMAIL: '1+p@users.noreply.github.com' },
  });
}
const commitAs = (dir, email, msg) => git(dir, '-c', 'user.email=' + email, '-c', 'user.name=P', 'commit', '-q', '--author=P <' + email + '>', '-m', msg);

// A zip with stored or deflated entries (no packages).
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const at = (r, rule, start) => r.findings.filter(f => f.rule === rule && f.where.startsWith(start));
const noValues = r => { const s = JSON.stringify(r).toLowerCase(); for (const v of VALUES) assert(!s.includes(v.toLowerCase()), 'a planted value came back out'); };

async function main() {
  // ---- 1. Files: should-fire / must-stay-quiet pairs (a folder with no git, read through its .gitignore) ----
  const PAIRS = [
    ['DISC-001', 'email.txt', 'Write to ' + EMAIL + ' today', 'email-quiet.txt', 'Write to other.person@example.org today'],
    ['DISC-001', 'phone.txt', 'Call 0400123456 after 5', 'phone-quiet.txt', 'Order 0400 123 457 is late'],
    ['DISC-001', 'readme-name.md', 'Made by ' + NAME + '.', 'LICENSE', 'Copyright (C) 2026 ' + NAME],
    ['DISC-002', 'names.md', 'This shares code with the Red-Kite project.', 'names-quiet.md', 'A red kitten sat on the mat.'],
    ['DISC-002', 'link-plain.md', 'Ported from red kite last year.', 'link-quiet.md', 'Source: https://github.com/someone/red-kite'],
    ['DISC-002', 'path.md', 'See ../notes/todo.txt for the list.', 'word-quiet.md', 'Keep your notes here.'],
    ['DISC-002', 'single.md', 'Snowfinch uses the same parser.', 'own-quiet.md', 'Bluebell home page.'],
    ['DISC-002', 'exact.md', 'Copied from map-store.', 'exact-quiet.md', 'A map store near you.'],
    ['DISC-003', 'sign.js', '// ' + SIGN, 'claude-quiet.js', '// Uses the Claude API to summarise a page.'],
    ['DISC-003', 'thread.md', 'Decided in ' + THREAD + '.', 'thread-quiet.js', 'Start one worker thread per job.'],
    ['DISC-004', 'home.js', 'const root = "' + HOME.replace(/\\/g, '\\\\') + '";', 'home-quiet.js', 'const pub = "C:\\\\Users\\\\Public\\\\Desktop"; // or %USERPROFILE%'],
    ['DISC-004', 'nix.sh', 'cd /home/alice/site/', 'route-quiet.html', '<a href="/home/about/">About</a>'],
  ];
  for (const [, loud, lt, quiet, qt] of PAIRS) { w('plain/' + loud, lt + '\n'); w('plain/' + quiet, qt + '\n'); }
  w('plain/CLAUDE.md', 'notes for the AI\n');
  w('plain/.cursor/rules.md', 'rules\n');
  w('plain/.gitignore', 'secret/\n_releases/\n');
  w('plain/secret/mine.txt', EMAIL + '\n'); // ignored: never published, so never read
  const P = await disclosurePass(path.join(tmp, 'plain'), ctx);
  for (const [rule, loud, , quiet] of PAIRS) {
    check(rule + ' fires on ' + loud, () => assert(at(P, rule, loud + ':').length, P.findings.map(f => f.rule + '@' + f.where).join(', ')));
    check(rule + ' quiet on ' + quiet, () => assert(!P.findings.some(f => f.where.startsWith(quiet + ':')), P.findings.filter(f => f.where.startsWith(quiet)).map(f => f.rule + ' ' + f.title).join('; ')));
  }
  check('labels name the detail: my email, my phone, my name', () => {
    assert(/my email/.test(at(P, 'DISC-001', 'email.txt')[0].title) && /my phone/.test(at(P, 'DISC-001', 'phone.txt')[0].title) && /my name/.test(at(P, 'DISC-001', 'readme-name.md')[0].title));
  });
  check('AI files: CLAUDE.md and the .cursor/ folder', () => assert(at(P, 'DISC-003', 'CLAUDE.md').length && at(P, 'DISC-003', '.cursor/').length));
  check('an ignored file is not read (.gitignore honoured without git)', () => assert(!P.findings.some(f => f.where.startsWith('secret/'))));
  check('no planted value in the result (files)', () => noValues(P));

  // ---- 2. Git: history, remote, every branch, commit emails and messages, untracked files ----
  const repo = path.join(tmp, 'repo'), remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(repo, { recursive: true });
  git(tmp, 'init', '-q', '--bare', remote);
  git(repo, 'init', '-q');
  w('repo/app.js', 'console.log(1);\n');
  w('repo/old.txt', 'Phone: ' + PHONE + '\n');
  git(repo, 'add', '-A'); commitAs(repo, EMAIL, 'first');
  fs.rmSync(path.join(repo, 'old.txt')); git(repo, 'add', '-A'); commitAs(repo, '1+p@users.noreply.github.com', 'remove old.txt\n\n' + SIGN);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  // after the push: a version only on this PC, and a side branch by someone else
  w('repo/late.txt', 'mail ' + EMAIL + '\n'); git(repo, 'add', '-A'); commitAs(repo, '1+p@users.noreply.github.com', 'late');
  fs.rmSync(path.join(repo, 'late.txt')); git(repo, 'add', '-A'); commitAs(repo, '1+p@users.noreply.github.com', 'drop late');
  git(repo, 'checkout', '-q', '-b', 'side');
  w('repo/side.js', 'x\n'); git(repo, 'add', '-A'); commitAs(repo, HELPER, 'side work');
  git(repo, 'checkout', '-q', 'main');
  w('repo/untracked.txt', 'call ' + PHONE + '\n');
  const G = await disclosurePass(repo, ctx);
  const gs = G.findings.map(f => f.rule + '@' + f.where + ' ' + f.title).join('\n  ');
  check('a planted phone in a deleted file is found in history, marked on the remote', () => assert(at(G, 'DISC-001', 'git history: old.txt').some(f => /already on the remote/.test(f.title)), gs));
  check('a planted email in a deleted, unpushed file is found, marked not pushed', () => assert(at(G, 'DISC-001', 'git history: late.txt').some(f => /not pushed yet/.test(f.title)), gs));
  check('commit email named by its label, and on the remote', () => assert(G.findings.some(f => f.rule === 'DISC-005' && /my email/.test(f.title) && /already on the remote/.test(f.title)), gs));
  check('a commit email only on a side branch is found, branch named, not pushed', () => assert(G.findings.some(f => f.rule === 'DISC-005' && /not a noreply/.test(f.title) && /\bside\b/.test(f.title) && /not pushed yet/.test(f.title)), gs));
  check('a noreply commit email stays quiet', () => assert.strictEqual(G.findings.filter(f => f.rule === 'DISC-005').length, 2, gs));
  check('AI sign-off in a commit message (1, on the remote)', () => assert(G.findings.some(f => f.rule === 'DISC-003' && /in 1 commit message \(1 already on the remote\)/.test(f.title)), gs));
  check('an untracked file is read and marked', () => assert(at(G, 'DISC-001', 'untracked.txt').some(f => /not in git yet/.test(f.title)), gs));
  check('no planted value in the result (git)', () => noValues(G));
  check('the pass leaves the repository as it was', () => assert.strictEqual(git(repo, 'status', '--porcelain'), '?? untracked.txt\n'));

  // ---- 3. Zips: the newest release zip, a zip inside it, and the older zip beside it left alone ----
  const inner = makeZip([{ name: 'deep/config.txt', data: 'owner = ' + EMAIL + '\n', deflate: true }, { name: 'deep/clean.txt', data: 'nothing here\n' }]);
  w('plain/_releases/app-0.9.zip', makeZip([{ name: 'old.txt', data: 'call ' + PHONE }]));
  fs.utimesSync(path.join(tmp, 'plain/_releases/app-0.9.zip'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  w('plain/_releases/app-1.0.zip', makeZip([{ name: 'app/readme.txt', data: 'hello\n' }, { name: 'app/inner.zip', data: inner, deflate: true }]));
  const Z = await disclosurePass(path.join(tmp, 'plain'), ctx);
  check('a planted email in a zip inside a zip (inside an ignored release folder) is found', () => assert(at(Z, 'DISC-001', '_releases/app-1.0.zip > app/inner.zip > deep/config.txt:1').length, Z.findings.map(f => f.where).join(', ')));
  check('the clean files in the zips stay quiet', () => assert(!Z.findings.some(f => /readme\.txt|clean\.txt/.test(f.where))));
  check('the older zip beside it is not read, and a note says so', () => assert(!Z.findings.some(f => /app-0\.9/.test(f.where)) && Z.notes.some(n => /1 older zip/.test(n)), Z.notes.join('|')));
  check('no planted value in the result (zips)', () => noValues(Z));

  // ---- 4. A folder whose git settings could run a program: git is not run, every file is read ----
  const risky = path.join(tmp, 'risky');
  fs.mkdirSync(risky);
  git(risky, 'init', '-q');
  fs.appendFileSync(path.join(risky, '.git', 'config'), '[filter "x"]\n\tclean = do-something\n');
  w('risky/a.txt', EMAIL + '\n');
  const R = await disclosurePass(risky, ctx);
  check('risky git settings: history not read, said in a note, files still read', () => assert(R.notes.some(n => /could run a program/.test(n)) && at(R, 'DISC-001', 'a.txt').length && !R.findings.some(f => f.rule === 'DISC-005')));

  // ---- 5. A git repository inside a folder with no git ----
  const outer = path.join(tmp, 'outer');
  fs.mkdirSync(path.join(outer, 'inner'), { recursive: true });
  git(path.join(outer, 'inner'), 'init', '-q');
  w('outer/inner/f.txt', EMAIL + '\n');
  git(path.join(outer, 'inner'), 'add', '-A');
  const O = await disclosurePass(outer, ctx);
  check('a repository inside the folder is read through its own git, and noted', () => assert(at(O, 'DISC-001', 'inner/f.txt').length && O.notes.some(n => /inside this folder \(inner\/\)/.test(n)), O.findings.map(f => f.where).join(',') + ' | ' + O.notes.join('|')));

  // ---- 6. Through the audit: only with opts.disclosure; a set-aside finding stays set aside ----
  const A0 = await runAudit(path.join(tmp, 'plain'), null);
  const A1 = await runAudit(path.join(tmp, 'plain'), null, { disclosure: ctx });
  check('the audit runs the pass only when asked', () => assert(!A0.findings.some(f => f.area === 'disclosure') && A1.findings.some(f => f.area === 'disclosure')));
  check('a private detail is High (fix first)', () => assert(A1.findings.some(f => f.rule === 'DISC-001' && f.sev === 'High') && A1.verdict === 'fix-first'));
  const acc = [{ id: 'x1', rule: 'DISC-001', file: 'email.txt', fp: fingerprint('Write to ' + EMAIL + ' today'), verdict: 'false', why: 'test', by: 'test' }];
  const A2 = await runAudit(path.join(tmp, 'plain'), null, { disclosure: ctx, judged: acc });
  check('a set-aside disclosure finding moves to setAside', () => assert(A2.setAside.some(f => f.where.startsWith('email.txt')) && !A2.findings.some(f => f.where.startsWith('email.txt'))));
  check('no planted value in the saved audit', () => noValues(A1));

  // ---- 7. The list the person fills in ----
  const listFile = path.join(tmp, 'data', 'private-details.json');
  check('saving: a label is required and a value must be 3+ characters', () => {
    assert(!savePrivateList(listFile, [{ label: '', value: 'abcd' }]).ok);
    assert(!savePrivateList(listFile, [{ label: 'x', value: 'ab' }]).ok);
  });
  const s1 = savePrivateList(listFile, [{ label: 'my email', value: EMAIL }]);
  const id = s1.details[0].id;
  savePrivateList(listFile, [{ id, label: 'my email (work)' }]); // no value: keep the saved one
  check('a row with its id and no value keeps the saved value', () => { const l = readPrivateList(listFile); assert(l.length === 1 && l[0].value === EMAIL && l[0].label === 'my email (work)'); });
  check('the page gets labels and lengths, never values', () => { const pg = listForPage(listFile); assert(pg[0].length === EMAIL.length); noValues(pg); });

  // ---- 8. Deep-audit fixes: long lines, UTF-16, Office files, noted skips, names, encoded details, zip budget ----
  const AT = '@', [USER, HOST] = EMAIL.split(AT);
  const more = path.join(tmp, 'more');
  w('more/bundle.min.js', 'var a=1;'.repeat(6000) + 'contact("' + EMAIL + '");' + 'var b=2;'.repeat(6000));
  w('more/clean.min.js', 'var a=1;'.repeat(12000));
  fs.writeFileSync(w('more/utf16-bom.txt', ''), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好'.repeat(3000) + '\r\nMail ' + EMAIL + '\r\n', 'utf16le')]));
  fs.writeFileSync(w('more/utf16-plain.txt', ''), Buffer.from('Mail ' + EMAIL + '\r\n', 'utf16le'));
  fs.writeFileSync(w('more/utf16-quiet.txt', ''), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Mail someone@example.org\r\n', 'utf16le')]));
  fs.writeFileSync(w('more/letter.docx', ''), makeZip([{ name: 'word/document.xml', data: '<w:document><w:p><w:r><w:t>Write to ' + EMAIL + '</w:t></w:r></w:p></w:document>', deflate: true }, { name: '[Content_Types].xml', data: '<Types/>' }]));
  fs.writeFileSync(w('more/quiet.docx', ''), makeZip([{ name: 'word/document.xml', data: '<w:p><w:t>Nothing private</w:t></w:p>', deflate: true }]));
  w('more/report.pdf', '%PDF-1.4 ' + EMAIL);
  w('more/app.sqlite', 'SQLite format 3');
  fs.writeFileSync(w('more/huge.txt', ''), Buffer.alloc(17 * 1024 * 1024, 'x'));
  w('more/notes-' + EMAIL + '.txt', 'nothing inside\n');
  w('more/red-kite-copy/a.js', 'x\n');
  w('more/red-kite-copy/b.js', 'y\n');
  w('more/ordinary-notes-folder/c.js', 'z\n');
  w('more/encoded-url.html', '<a href="mailto:' + USER + '%40' + HOST + '">mail</a>\n');
  w('more/encoded-entity.html', '<p>' + USER + '&#64;' + HOST + '</p>\n');
  w('more/encoded-js.js', 'var m = "' + USER + '\\u0040' + HOST + '";\n');
  w('more/encoded-quiet.html', '<p>someone&#64;example.org and 100%40 off</p>\n');
  w('more/_releases/r-1.0.zip', makeZip([{ name: 'r/' + EMAIL + '.txt', data: 'hi\n' }]));
  const M = await disclosurePass(more, ctx);
  const ms = M.findings.map(f => f.rule + '@' + f.where + ' ' + f.title).join('\n  ') + '\n  notes: ' + M.notes.join(' | ');
  check('D2: a detail inside a 96,000-character minified line is found', () => assert(at(M, 'DISC-001', 'bundle.min.js:1').length, ms));
  check('D2: a long clean line stays quiet', () => assert(!M.findings.some(f => f.where.startsWith('clean.min.js')), ms));
  check('D3: a UTF-16 file with a BOM is read (Chinese text, so only the BOM tells)', () => assert(at(M, 'DISC-001', 'utf16-bom.txt:2').length, ms));
  check('D3: a UTF-16 file without a BOM is read', () => assert(at(M, 'DISC-001', 'utf16-plain.txt:1').length, ms));
  check('D3: a clean UTF-16 file stays quiet', () => assert(!M.findings.some(f => f.where.startsWith('utf16-quiet')), ms));
  check('D4: a Word file is opened and its text read', () => assert(at(M, 'DISC-001', 'letter.docx > word/document.xml:').length, ms));
  check('D4: a clean Word file stays quiet', () => assert(!M.findings.some(f => f.where.startsWith('quiet.docx')), ms));
  check('D4: a PDF and a database file are named in a note, not passed over silently', () => assert(M.notes.some(n => /pdf files/.test(n) && /report\.pdf/.test(n)) && M.notes.some(n => /sqlite files/.test(n)), ms));
  check('D4: a file over 16 MB is named in a note', () => assert(M.notes.some(n => /over 16 MB/.test(n) && /huge\.txt/.test(n)), ms));
  check('D5: a private detail in a file name is found, with the label printed in its place', () => assert(M.findings.some(f => f.rule === 'DISC-001' && /file name/.test(f.title) && f.where === 'notes-[my email].txt'), ms));
  check('D5: a folder named after another project is ONE finding for the files in it', () => assert.strictEqual(M.findings.filter(f => f.rule === 'DISC-002' && f.where === 'red-kite-copy/' && /\(2 files\)/.test(f.title)).length, 1, ms));
  check('D5: a folder named with ordinary words stays quiet', () => assert(!M.findings.some(f => /ordinary-notes-folder/.test(f.where)), ms));
  check('D5: a detail in a zip entry name is found and not printed', () => assert(M.findings.some(f => f.rule === 'DISC-001' && /r-1\.0\.zip > r\/\[my email\]\.txt/.test(f.where)), ms));
  check('D8: %40, &#64; and \\u0040 written for @ still name the detail', () => assert(['encoded-url.html', 'encoded-entity.html', 'encoded-js.js'].every(n => at(M, 'DISC-001', n + ':1').length), ms));
  check('D8: other encoded text stays quiet', () => assert(!M.findings.some(f => f.where.startsWith('encoded-quiet')), ms));
  check('no planted value in the result (names, encodings, Office)', () => noValues(M));

  // D1: a small zip that unpacks to gigabytes is read up to the budget, then stopped with a note, quickly.
  const chunk = 'a'.repeat(1900 * 1024);
  const innerBomb = makeZip(Array.from({ length: 200 }, (_, i) => ({ name: 'f' + i + '.txt', data: chunk, deflate: true })));
  w('bomb/_releases/b-1.0.zip', makeZip(Array.from({ length: 6 }, (_, i) => ({ name: 'in' + i + '.zip', data: innerBomb, deflate: true }))));
  const t0 = Date.now();
  const B = await disclosurePass(path.join(tmp, 'bomb'), ctx);
  const took = Date.now() - t0;
  check('D1: a zip bomb (' + Math.round(fs.statSync(path.join(tmp, 'bomb/_releases/b-1.0.zip')).size / 1024) + ' KB, ~2.2 GB unpacked) stops at the budget with a note, in ' + Math.round(took / 1000) + ' s', () => {
    assert(B.notes.some(n => /zip bomb/.test(n)), B.notes.join(' | '));
    assert(took < 60000, 'took ' + took + ' ms');
  });
  // A zip entry that says it is small but unpacks to more is refused, not trusted.
  const liar = makeZip([{ name: 'small.txt', data: 'x'.repeat(500000), deflate: true }]);
  const cdAt = liar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  liar.writeUInt32LE(100, cdAt + 24); // the central directory now says 100 bytes
  w('liar/_releases/l-1.0.zip', liar);
  const L = await disclosurePass(path.join(tmp, 'liar'), ctx);
  check('D1: an entry that unpacks to more than it says is not read past its size', () => assert(L.notes.some(n => /small\.txt could not be read \(unpacks to more/.test(n)), L.notes.join(' | ')));

  // ---- 8b. Phase T4 gaps: each with a twin that stays quiet (phrases joined at run time, as above) ----
  const OWNERQ = 'Own' + 'er (3 March ' + '2026): no more than two banners';
  const PERRULE = 'per h' + 'er rule';
  const STARTH = 'STA' + 'RT HERE notes/next-steps.md for the invoice page';
  const MADEBY = 'This guide was drafted with ' + 'Chat' + 'GPT and checked by hand.';
  w('t4a/src/banner.js', '/* ' + OWNERQ + ' */\nconst MAX = 2;\n');
  w('t4a/src/limit.php', "<?php\n$max = 2; // " + PERRULE + "\n");
  w('t4a/docs/todo.txt', STARTH + '\n');
  w('t4a/web/guide.html', '<p>' + MADEBY + '</p>\n');
  w('t4a/PROMPT.txt', 'Rewrite the guide in plain words.\n');
  w('t4a/notes/REVERT-2.md', 'Put the old banner back.\n');
  w('t4a/list.txt', 'one\n' + PHONE + '\nthree\nfour\n' + PHONE + '\nsix\n' + PHONE + '\n');
  // quiet: the same words in prose and in ordinary names
  w('t4b/story/chapter1.txt', 'She said it in h' + 'er own words, and the owner of the inn nodded.\n');
  w('t4b/web/help.html', '<p>The site owner decides ' + PERRULE.replace('per ', 'by ') + 's what goes here; start here to read more.</p>\n');
  w('t4b/docs/prompts-for-the-quiz.json', '{"q": "What is 2 + 2?"}\n');
  w('t4b/web/about.html', '<p>Built with care in Hobart.</p>\n');
  w('t4b/docs/plan.md', '**Overrides** are for when the own' + 'er wants to give a shop more room.\n');
  const A4 = await disclosurePass(path.join(tmp, 't4a'), ctx), B4 = await disclosurePass(path.join(tmp, 't4b'), ctx);
  const at4 = (r, rule, file) => r.findings.some(f => f.rule === rule && f.where.startsWith(file));
  check('T4: a person quoted by date in a comment is a trail line', () => assert(at4(A4, 'DISC-003', 'src/banner.js'), A4.findings.map(f => f.where).join(', ')));
  check('T4: "per <someone\'s> rule" in a comment is a trail line', () => assert(at4(A4, 'DISC-003', 'src/limit.php')));
  check('T4: a handover marker naming a note is a trail line', () => assert(at4(A4, 'DISC-003', 'docs/todo.txt')));
  check('T4: page copy saying an AI drafted it is a trail line', () => assert(at4(A4, 'DISC-003', 'web/guide.html')));
  check('T4: PROMPT and REVERT notes are trail files', () => assert(A4.findings.some(f => f.rule === 'DISC-003' && /2 files|PROMPT\.txt|REVERT-2\.md/.test(f.where + f.title)), A4.findings.map(f => f.where + ' ' + f.title).join(' | ')));
  check('T4: the same detail on three lines names all three places', () => {
    const f = A4.findings.find(x => x.rule === 'DISC-001' && x.where.startsWith('list.txt'));
    assert(f && f.where === 'list.txt:2' && (f.also || []).join() === 'list.txt:5,list.txt:7', f && JSON.stringify(f));
  });
  check('T4: the same words in a story, a help page, a quiz file and plain copy stay quiet', () => assert(!B4.findings.length, B4.findings.map(f => f.rule + ' ' + f.where).join(', ')));
  // a quote planted in a 3 MB one-line bundle
  w('t4c/public/vendor.min.js', 'var a=1;'.repeat(190000) + '/*' + OWNERQ + '*/' + 'var b=2;'.repeat(190000));
  const C4 = await disclosurePass(path.join(tmp, 't4c'), ctx);
  check('T4: a dated quote inside a 3 MB one-line bundle is found', () => assert(fs.statSync(path.join(tmp, 't4c/public/vendor.min.js')).size > 3e6 && at4(C4, 'DISC-003', 'public/vendor.min.js'), C4.findings.map(f => f.where).join(', ') + ' ' + C4.notes.join(' | ')));
  // older zips: read when a file links to them, left alone otherwise
  const oldZip = makeZip([{ name: 'readme.txt', data: 'ring ' + PHONE + '\n' }]), newZip = makeZip([{ name: 'readme.txt', data: 'ring the shop\n' }]);
  const aged = p => { const t = new Date(2023, 5, 1); fs.utimesSync(p, t, t); };
  aged(w('t4d/dl/kit-1.zip', oldZip)); w('t4d/dl/kit-2.zip', newZip); w('t4d/index.html', '<a href="dl/kit-1.zip">old kit</a> <a href="dl/kit-2.zip">kit</a>\n');
  aged(w('t4e/dl/kit-1.zip', oldZip)); w('t4e/dl/kit-2.zip', newZip); w('t4e/index.html', '<a href="dl/kit-2.zip">kit</a>\n');
  w('t4d/.gitignore', 'dl/\n'); w('t4e/.gitignore', 'dl/\n'); // a published zip is read anyway; these sit in an ignored folder
  const D4 = await disclosurePass(path.join(tmp, 't4d'), ctx), E4 = await disclosurePass(path.join(tmp, 't4e'), ctx);
  check('T4: an older zip a page links to is read', () => assert(D4.findings.some(f => f.rule === 'DISC-001' && /kit-1\.zip > readme\.txt/.test(f.where)), D4.findings.map(f => f.where).join(', ')));
  check('T4: an older zip nothing links to is left (and noted)', () => assert(!E4.findings.some(f => /kit-1/.test(f.where)) && E4.notes.some(n => /older zip/.test(n)), E4.notes.join(' | ')));
  // a zip that only the git history still holds
  const hz = path.join(tmp, 't4f');
  fs.mkdirSync(hz, { recursive: true });
  git(hz, 'init', '-q');
  w('t4f/build/site.zip', makeZip([{ name: 'contact.txt', data: 'mail ' + EMAIL + '\n' }]));
  git(hz, 'add', '-A'); commitAs(hz, '1+p@users.noreply.github.com', 'build');
  fs.rmSync(path.join(hz, 'build'), { recursive: true });
  git(hz, 'add', '-A'); commitAs(hz, '1+p@users.noreply.github.com', 'drop build');
  const F4 = await disclosurePass(hz, ctx);
  check('T4: a zip deleted from the folder is opened from the git history', () => assert(F4.findings.some(f => f.rule === 'DISC-001' && /^git history: build\/site\.zip > contact\.txt/.test(f.where)), F4.findings.map(f => f.where).join(', ')));
  // a committed zip still in the folder as it is: read once, from the folder (not again from the history)
  const cz = path.join(tmp, 't4g');
  fs.mkdirSync(cz, { recursive: true });
  git(cz, 'init', '-q');
  w('t4g/out/app.zip', makeZip([{ name: 'about.txt', data: 'phone ' + PHONE + '\n' }]));
  git(cz, 'add', '-A'); commitAs(cz, '1+p@users.noreply.github.com', 'release');
  const G4 = await disclosurePass(cz, ctx);
  check('T4: a committed zip unchanged in the folder is read from the folder only', () => {
    const f = G4.findings.filter(x => x.rule === 'DISC-001');
    assert(f.length === 1 && /^out\/app\.zip > about\.txt/.test(f[0].where) && !(f[0].also || []).some(a => /git history/.test(a)), JSON.stringify(f));
    assert.strictEqual(G4.read.zips, 1, 'zips opened: ' + G4.read.zips + ' (the unpacking budget is spent once)');
  });
  check('T4: nothing returned carries a planted value', () => {
    const all = JSON.stringify([A4, B4, C4, D4, E4, F4]);
    for (const v of VALUES) assert(!all.includes(v), 'leaked a value');
  });

  // ---- 9. The Bridge's own folder scans clean, with this PC's real details and the real project names beside it ----
  // SEC-012: a key taken out of the files but kept by an older version; pushed = Critical, never pushed = High; a key
  // the files still hold is its own rule's finding only; the key text never reaches the audit.
  {
    const { runAudit } = require('../../src/bridge/audit');
    const kr = path.join(tmp, 'keys-repo'), kremote = path.join(tmp, 'keys-remote.git');
    const live = 'sk_' + 'live_' + '9fQ2xLmP4tRw8ZbN3vKd', gh = 'gh' + 'p_' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78';
    fs.mkdirSync(kr, { recursive: true });
    git(kr, 'init', '-q');
    fs.writeFileSync(path.join(kr, 'config.php'), '<?php\n$k = "' + live + '";\n');
    fs.writeFileSync(path.join(kr, 'keep.js'), 'const a = "' + gh + '";\n');
    git(kr, 'add', '-A'); commitAs(kr, '1+p@users.noreply.github.com', 'one');
    fs.writeFileSync(path.join(kr, 'config.php'), '<?php\n$k = getenv("STRIPE");\n');
    git(kr, 'add', '-A'); commitAs(kr, '1+p@users.noreply.github.com', 'two');
    const ctx = { details: [], others: [], own: [] };
    const a1 = await runAudit(kr, null, { disclosure: ctx, root: false });
    const h1 = a1.findings.filter(f => f.rule === 'SEC-012');
    check('SEC-012: a key gone from the files but in the history is found once, High while only on this PC', () => {
      assert.deepStrictEqual(h1.map(f => [f.sev, f.where]), [['High', 'git history: config.php:2']]);
      assert(/only on this PC/.test(h1[0].title), h1[0].title);
    });
    check('SEC-012: a key the files still hold is not reported again as history', () => assert(a1.findings.some(f => f.rule === 'SEC-003' && f.where === 'keep.js:1') && !h1.some(f => /keep\.js/.test(f.where))));
    check('SEC-012: the key itself never reaches the audit', () => assert(!JSON.stringify(a1).includes(live.slice(8)) && !JSON.stringify(a1).includes(gh.slice(4))));
    git(tmp, 'init', '-q', '--bare', kremote); git(kr, 'remote', 'add', 'origin', kremote); git(kr, 'push', '-q', 'origin', 'main');
    const h2 = (await runAudit(kr, null, { disclosure: ctx, root: false })).findings.filter(f => f.rule === 'SEC-012');
    check('SEC-012: once pushed it is Critical and says so', () => assert(h2.length === 1 && h2[0].sev === 'Critical' && /already on the remote/.test(h2[0].title), JSON.stringify(h2)));
  }

  // The Bridge part's own files (its four folders inside TOMLIN), copied out so only they are read: no names of
  // the other projects beside it, no private detail of this PC, no AI trail.
  const APP = path.resolve(__dirname, '..', '..');
  const HERE = path.join(tmp, 'bridge-part');
  for (const d of ['src/bridge', 'public/bridge', 'test/bridge', 'tools/bridge']) fs.cpSync(path.join(APP, d), path.join(HERE, d), { recursive: true });
  const projectsDir = path.dirname(APP);
  const siblings = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory() && !/^[._-]/.test(e.name) && e.name !== path.basename(APP)).map(e => e.name);
  const self = await disclosurePass(HERE, { details: autoDetails([projectsDir]), others: siblings, own: [path.basename(APP), 'bridge-part', 'myia bridge'] });
  // Myia Bridge, the stand-alone app this part came from, is named on purpose (About, Bring in from Myia Bridge).
  const selfFound = self.findings;
  check('the Bridge part\'s own files scan clean', () => assert.strictEqual(selfFound.length, 0, selfFound.map(f => f.rule + '@' + f.where + ' ' + f.title).join('\n  ')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
