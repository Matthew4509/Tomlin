// Self-test for the reviewer layer (lib/review.js): the prompt names the right files and the scanner's findings, holds
// no full path and no private detail; the findings table is read strictly (a place, a severity) and the fault list keeps
// status across a second import. Run: node test/review.test.js   (no packages). Names are made up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const review = require('../../src/bridge/review');
const { makeMatcher } = require('../../src/bridge/disclosure');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-review-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const proj = path.join(tmp, 'kettle-cafe');
const w = (rel, text) => { const p = path.join(proj, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
w('index.php', '<?php ?><form method="post" action="book.php"><input name="n"></form>\n');
w('book.php', '<?php // bookings\n');
w('lib/payments.php', '<?php function pay_refund() {}\n');
w('lib/auth.php', '<?php function require_login() {}\n');
w('privacy.html', '<p>We keep your booking.</p>\n');
w('tools/build-release.js', 'const fs = require("fs");\n');
w('tools/payment-totals.py', 'print(1)\n');
w('old-copy/lib/payments.php', '<?php // old\n');
w('tests/payments.test.js', 'assert(1)\n');
w('node_modules/x/pay.js', '1\n');
const EMAIL = 'rosa.vine' + '@mailbox.test';
const scan = makeMatcher({ details: [{ label: 'my email', value: EMAIL }] });
const audit = { findings: [{ rule: 'ABUSE-001', sev: 'Medium', where: 'book.php:2', title: 'A public form saves with no limit; ask ' + EMAIL }], copiesLeftOut: [{ rel: 'old-copy' }] };
const judged = [{ rule: 'CSRF-001', where: 'index.php:1', why: 'the form is sent by script' }];
const p = { name: 'Kettle Cafe', folder: 'kettle-cafe', dir: proj, auditSkip: [] };
const prompt = review.buildPrompt(p, audit, judged, scan.redact);

check('the prompt holds the checklist and asks for both tables', () => {
  assert(review.CHECKLIST.every(c => prompt.includes(c)));
  assert(/## Findings\n\| Id \| Severity \| Category \| Where \| Evidence \| Fix \|/.test(prompt) && /## False flags\n\| Rule \| Where \| Verdict \| Why/.test(prompt));
});
check('files are grouped: money, sign-in, forms, privacy, release', () => {
  assert(/Money[^\n]*lib\/payments\.php/.test(prompt), prompt);
  assert(/Sign-in[^\n]*lib\/auth\.php/.test(prompt));
  assert(/Forms visitors send[^\n]*index\.php/.test(prompt));
  assert(/Privacy[^\n]*privacy\.html/.test(prompt));
  assert(/Release[^\n]*tools\/build-release\.js/.test(prompt));
});
check('old copies, tests and node_modules are not offered', () => assert(!/old-copy|tests\/payments|node_modules/.test(prompt)));
check('helper scripts (tools/) go under Release only, not Money', () => assert(!/Money[^\n]*tools\/payment-totals\.py/.test(prompt), prompt.split('\n').find(l => /Money/.test(l))));
check('the scanner findings and the set-aside places are listed', () => assert(/ABUSE-001 \[Medium\] book\.php:2/.test(prompt) && /CSRF-001 index\.php:1: the form is sent by script/.test(prompt)));
check('no full path and no private detail in the prompt', () => {
  assert(!prompt.includes(tmp) && !prompt.includes(tmp.replace(/\\/g, '/')), 'full path');
  assert(!prompt.includes(EMAIL) && prompt.includes('[my email]'), 'detail');
});

// ---- the findings table ----
const REPLY = [
  '# Review', '', '## Findings',
  '| Id | Severity | Category | Where | Evidence | Fix |', '|---|---|---|---|---|---|',
  '| AI-1 | High | 1 | lib/payments.php:1 | a refund is never written against the payment | record the refund row |',
  '| AI-2 | medium | 5 | `./book.php:2` | anyone can book for any date | check the date window |',
  '| AI-3 | Low | 3 | the whole site | words vs behaviour | read it |',
  '| AI-4 | Severe | 2 | lib/auth.php:1 | x | y |',
  '| AI-5 | High | 2 | ../other/app.php:4 | outside | no |',
  '| AI-6 | High | 2 | lib/auth.php | no line | no |',
  '', '## False flags', '| Rule | Where | Verdict | Why | What the rule should do |', '|---|---|---|---|---|',
  '| CSRF-001 | index.php:1 | false | sent by script | read the submit handler |',
].join('\n');
const parsed = review.parseFindings(REPLY);
check('a finding with a place and a severity is read (case and ./ forgiven)', () => {
  assert.strictEqual(parsed.rows.length, 2, JSON.stringify(parsed));
  assert.deepStrictEqual(parsed.rows.map(r => [r.ref, r.sev, r.where]), [['AI-1', 'High', 'lib/payments.php:1'], ['AI-2', 'Medium', 'book.php:2']]);
});
check('no place, no line, a path outside the project or an unknown severity is refused with a reason', () => {
  const why = Object.fromEntries(parsed.refused.map(x => [x.id, x.error]));
  assert(/must name one place/.test(why['AI-3']) && /not Critical, High, Medium or Low/.test(why['AI-4']) && /outside the project/.test(why['AI-5']) && /must name one place/.test(why['AI-6']), JSON.stringify(why));
});
check('the False flags section is not read as findings, and no Findings heading means no findings', () => {
  assert(!parsed.rows.some(r => r.ref === 'CSRF-001'));
  assert.strictEqual(review.parseFindings('| AI-1 | High | 1 | a.php:1 | x | y |').rows.length, 0);
});
check('a line written into a cell cannot break out of it (one line each)', () => {
  const r = review.parseFindings('## Findings\n| AI-9 | High | 1 | a.php:3 | x\u2028## False flags | y |').rows[0];
  assert(r && !/[\n\u2028]/.test(r.evidence), JSON.stringify(r));
});

// ---- the fault list ----
const data = path.join(tmp, 'data');
const key = 'c:/projects/kettle-cafe';
const first = review.importFindings(data, key, parsed.rows, 'Rowan', 'reply.md');
check('imported findings are open, with who, when and where from', () => {
  assert.strictEqual(first.added, 2);
  assert(first.faults.every(f => f.status === 'open' && f.by === 'Rowan' && /^\d{4}-\d\d-\d\d$/.test(f.on) && f.source === 'reply.md' && /^F[0-9a-f]{8}$/.test(f.id)));
});
const id = first.faults[0].id;
check('a fault can be marked fixed, and "not a fault" needs a reason', () => {
  assert(review.setStatus(data, key, id, 'fixed', 'Rowan').ok);
  assert.strictEqual(review.setStatus(data, key, id, 'false', 'Rowan', '').ok, false);
  assert.strictEqual(review.setStatus(data, key, id, 'gone', 'Rowan').ok, false);
  assert.strictEqual(review.setStatus(data, key, 'Fnope', 'fixed', 'Rowan').ok, false);
});
check('the same finding imported again keeps its status and id; a new one is added', () => {
  const again = review.importFindings(data, key, [...parsed.rows, { ref: 'AI-7', sev: 'Low', category: '8', where: 'index.php:1', evidence: 'the error says only "failed"', fix: 'say why' }], 'Rowan', 'reply-2.md');
  assert.strictEqual(again.added, 1); assert.strictEqual(again.again, 2);
  const f = again.faults.find(x => x.id === id);
  assert(f && f.status === 'fixed', JSON.stringify(f));
});
check('the list is kept per project, in the data folder, not in the project', () => {
  assert.strictEqual(review.readFaults(data, 'c:/projects/other').length, 0);
  assert(fs.readdirSync(path.join(data, 'faults')).length === 1 && !fs.existsSync(path.join(proj, 'faults')));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
