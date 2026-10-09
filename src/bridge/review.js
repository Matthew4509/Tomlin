// The reviewer layer (scanner training T6). Rules find patterns; a reviewer finds judgement faults ("a later grant
// cuts an earlier one"). The Bridge opens no AI app: it builds a review PROMPT for one project that the person copies
// into whichever AI they use, and it imports the FINDINGS table that comes back into a fault list per project, kept in
// the Bridge's data folder (never in the project): open, fixed or not a fault, with who and when.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- which files a reviewer should read first ----------
const SKIP = /(^|\/)(node_modules|vendor|\.git|dist|build|_releases?|releases|coverage|\.next|__pycache__)(\/|$)/i;
const CODE = /\.(php|m?js|cjs|tsx?|jsx|py|html?|vue|twig|sql)$/i;
// Whole words of a path (folders and file name, camelCase and separators split): "Html5Tokenizer" is not "token".
const wordsOf = rel => rel.replace(/\.[a-z0-9]+$/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const GROUPS = [
  ['Money (prices, payments, refunds, plans, tax)', /^(pay|pays|payment|payments|price|prices|pricing|invoice|invoices|bill|billing|checkout|stripe|paypal|refund|refunds|subscription|subscriptions|plan|plans|order|orders|cart|tax|gst|vat|receipt|receipts|quote|quotes|money|wallet|credit|credits|coupon|coupons|discount|discounts|totals|premium|purchase|purchases)$/],
  ['Sign-in, sessions and roles', /^(auth|login|logout|signin|signup|session|sessions|role|roles|admin|password|passwords|token|tokens|2fa|totp|otp|oauth|account|accounts|permission|permissions|invite|invites|access|gate|guard)$/],
  ['Privacy, terms and what the pages promise', /^(privacy|terms|cookie|cookies|consent|gdpr|legal|about|faq|pricing|help|tour)$/],
  ['Uploads, exports, PDFs and data in and out', /^(upload|uploads|import|export|exports|pdf|pdfs|csv|backup|restore|download|downloads|attach|attachment|attachments|photo|photos|image|images)$/],
  ['Release, update and install', /^(build|bake|release|releases|deploy|package|update|updater|updates|install|installer|setup|migrate|migration|migrations)$/],
];
// Helper scripts (tools/, scripts/, bin/) belong to the release group only.
const HELPER = /(^|\/)(tools|scripts|bin|parity|docs?)\//i;
function walk(dir, max = 4000) {
  const out = [];
  const go = (d, depth) => {
    if (out.length >= max || depth > 10) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name), rel = path.relative(dir, p).replace(/\\/g, '/');
      if (SKIP.test(rel) || e.name.startsWith('.') && e.name !== '.htaccess') continue;
      if (e.isDirectory()) go(p, depth + 1); else if (e.isFile() && (CODE.test(e.name) || e.name === '.htaccess')) out.push(rel);
    }
  };
  go(dir, 0);
  return out;
}
// skip: folders left out of the audit (old copies, the person's own skip list).
function fileGroups(dir, skip = []) {
  const left = skip.map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  const files = walk(dir).filter(f => !left.some(s => f.toLowerCase() === s || f.toLowerCase().startsWith(s + '/')) && !/(^|\/)(tests?|spec|__tests__|fixtures?)\//i.test(f));
  const groups = GROUPS.map(([name, re], gi) => ({ name, files: files.filter(f => (gi === GROUPS.length - 1 || !HELPER.test(f)) && wordsOf(f).some(w => re.test(w))).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 15) })).filter(g => g.files.length);
  const forms = [];
  for (const f of files.filter(x => /\.(php|html?|vue|jsx|tsx|twig)$/i.test(x))) {
    if (forms.length >= 12) break;
    try { if (fs.statSync(path.join(dir, f)).size < 512 * 1024 && /<form\b/i.test(fs.readFileSync(path.join(dir, f), 'utf8'))) forms.push(f); } catch {}
  }
  if (forms.length) groups.splice(2, 0, { name: 'Forms visitors send', files: forms });
  return { groups, total: files.length };
}

// ---------- the prompt ----------
const CHECKLIST = [
  'Money lifecycle: totals against payments, refunds, voids and corrections, renewals and stacked terms, plan changes, sandbox payments treated as real, mixed currencies, tax by country.',
  'Grants, gifts and free terms: proof tied to the person asking, reusable or renewed for ever, a later grant cutting an earlier one, free terms that can be abused.',
  'Words on screen against behaviour: marketing, tours, terms and privacy promises against what the code does.',
  'Privacy: what is kept, for how long, what an export or a delete really removes, consent reused for something else.',
  'Who may do what: approving yourself, publishing without review, how long links live, an installer that resets a password, identity proved before a privilege is given.',
  'Sign-in design: which pages two-step covers, remember-me against idle timeout, an installer or setup step that fails open.',
  'PDFs and documents: the layout chosen against the one sent, labels per document type, text running over, paging, pictures.',
  'Error messages say what went wrong and a way out; nothing is lost silently; two tabs open at once; blank waits.',
  'Capacity at real size: quotas, a full scan on every request, a shared cap one visitor can use up.',
  'Time windows and expiry promises; the order things happen in for bookings and orders.',
  'Releases and updates: are updates signed, what a feed offers, what the zip really contains.',
  'Real people\'s details used as examples; comments and docs that no longer match the code.',
  'Siblings: when one fault below is real, look for the same mistake in the other files that do the same job.',
];
const oneLine = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

// p: { name, folder, dir, auditSkip }; audit: the last audit (or null); judged: the judged list; redact(text): hides
// private details (the disclosure matcher's redact). Returns the prompt text. The project is named by its folder name
// only: the full path names this PC's user.
function buildPrompt(p, audit, judged = [], redact = t => t, opts = {}) {
  const r = t => redact(oneLine(t));
  const { groups, total } = fileGroups(p.dir, [...(p.auditSkip || []), ...((audit && audit.copiesLeftOut) || []).map(c => c.rel)]);
  const open = (audit && audit.findings) || [];
  const lines = [];
  lines.push('Review the project "' + r(p.name) + '" (folder ' + r(p.folder) + ') for faults that a rule-based scanner cannot find: judgement faults in how it handles money, access, promises and data.');
  lines.push('');
  lines.push('How to work:');
  lines.push('- Read the code at a place before you report it. Every finding must name one place as file:line (relative to the project folder) and quote or describe what is there.');
  lines.push('- Report only what you checked in the code. If you are unsure, say so in Evidence and use severity Low.');
  lines.push('- Do not name or quote any person, and do not copy keys, passwords or personal details into your answer.');
  lines.push('- Number your findings AI-1, AI-2, ... Severity is one of Critical, High, Medium, Low. Category is the checklist number below (1-13).');
  lines.push('');
  lines.push('Checklist:');
  CHECKLIST.forEach((c, i) => lines.push((i + 1) + '. ' + c));
  lines.push('');
  lines.push('Files to read first (' + total + ' code files in all):');
  for (const g of groups) lines.push('- ' + g.name + ': ' + g.files.map(r).join(', '));
  lines.push('');
  if (open.length) {
    lines.push('The built-in scanner already reports these (do not repeat them; if one is wrong, list it under False flags):');
    for (const f of open.slice(0, opts.maxFindings || 80)) lines.push('- ' + f.rule + ' [' + f.sev + '] ' + r(f.where) + ': ' + r(f.title));
    if (open.length > (opts.maxFindings || 80)) lines.push('- ... and ' + (open.length - (opts.maxFindings || 80)) + ' more of the same kinds.');
    lines.push('');
  }
  if (judged.length) {
    lines.push('A person already judged these places not a fault (leave them alone):');
    for (const j of judged.slice(0, 40)) lines.push('- ' + j.rule + ' ' + r(j.where || j.file || '') + ': ' + r(j.why || ''));
    lines.push('');
  }
  lines.push('Answer with two tables in Markdown, exactly these headings and columns, nothing else needed:');
  lines.push('');
  lines.push('## Findings');
  lines.push('| Id | Severity | Category | Where | Evidence | Fix |');
  lines.push('|---|---|---|---|---|---|');
  lines.push('| AI-1 | High | 1 | lib/pay.php:42 | what the code does there, and why it is wrong | what to change |');
  lines.push('');
  lines.push('## False flags');
  lines.push('| Rule | Where | Verdict | Why | What the rule should do |');
  lines.push('|---|---|---|---|---|');
  lines.push('| (a rule id from the scanner list) | file:line | false | why it is not a fault there | how the rule could tell |');
  lines.push('');
  lines.push('Write "none" in a table when it has no rows.');
  return lines.join('\n');
}

// ---------- the findings table ----------
const SEVS = { critical: 'Critical', high: 'High', medium: 'Medium', med: 'Medium', low: 'Low', info: 'Low' };
const PLACE = /^[^\s|:*?"<>]+(?:[ \w.\/()-]*[^\s|:*?"<>])?:\d+(?:-\d+)?$/;
// The "Findings" section of a report-back (| Id | Severity | Category | Where | Evidence | Fix |). Rows that do not
// name one place (file:line) are refused, with the reason.
function parseFindings(text) {
  // a Unicode line or paragraph separator inside a cell is a space, not a new line (or a new heading)
  const t = String(text || '').replace(/[\u2028\u2029]/g, ' ');
  const sec = /^#{1,4}\s*\d*\.?\s*Findings\b.*$([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(t);
  if (!sec) return { rows: [], refused: [] };
  const rows = [], refused = [];
  for (const raw of sec[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|') || /^\|[\s:|-]+\|?$/.test(line)) continue;
    const c = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim().replace(/^`+|`+$/g, ''));
    if (/^(id|none)?$/i.test(c[0]) || /^none\b/i.test(c.join(' '))) continue;
    if (c.length < 6) { refused.push({ id: c[0], error: 'the row has ' + c.length + ' columns; it needs Id | Severity | Category | Where | Evidence | Fix' }); continue; }
    const where = c[3].replace(/^\.?\//, '').replace(/\\/g, '/');
    if (!PLACE.test(where)) { refused.push({ id: c[0], error: 'a finding must name one place as file:line; "' + oneLine(c[3]).slice(0, 60) + '" does not' }); continue; }
    if (/(^|\/)\.\.(\/|$)/.test(where) || /^[a-z]:/i.test(where)) { refused.push({ id: c[0], error: '"' + oneLine(where).slice(0, 60) + '" is outside the project' }); continue; }
    const sev = SEVS[c[1].toLowerCase().replace(/[^a-z]/g, '')];
    if (!sev) { refused.push({ id: c[0], error: 'severity "' + oneLine(c[1]).slice(0, 20) + '" is not Critical, High, Medium or Low' }); continue; }
    rows.push({ ref: oneLine(c[0]).slice(0, 20), sev, category: oneLine(c[2]).slice(0, 40), where, evidence: oneLine(c[4]).slice(0, 600), fix: oneLine(c[5]).slice(0, 400) });
  }
  return { rows, refused };
}

// ---------- the fault list (data/faults/<project key hash>.json) ----------
const fileFor = (dataDir, key) => path.join(dataDir, 'faults', crypto.createHash('sha1').update(String(key).toLowerCase()).digest('hex').slice(0, 16) + '.json');
function readFaults(dataDir, key) {
  try { const j = JSON.parse(fs.readFileSync(fileFor(dataDir, key), 'utf8')); return Array.isArray(j.faults) ? j.faults : []; } catch { return []; }
}
function writeFaults(dataDir, key, faults) {
  const f = fileFor(dataDir, key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ note: 'Faults a reviewer reported for one project (Review with AI, then Import report-back). Kept on this PC.', faults }, null, 2));
}
// The same place and the same evidence is the same fault: imported again, it keeps its status and id.
const same = (a, b) => a.where === b.where && a.evidence.toLowerCase() === b.evidence.toLowerCase();
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function importFindings(dataDir, key, rows, by, source) {
  const faults = readFaults(dataDir, key);
  let added = 0, again = 0;
  for (const r of rows) {
    const old = faults.find(f => same(f, r));
    if (old) { again++; Object.assign(old, { sev: r.sev, category: r.category, fix: r.fix, ref: r.ref }); continue; }
    faults.push({ id: 'F' + crypto.randomBytes(4).toString('hex'), ...r, status: 'open', by: oneLine(by).slice(0, 60) || 'report-back', on: today(), source: oneLine(source).slice(0, 100) });
    added++;
  }
  writeFaults(dataDir, key, faults);
  return { added, again, faults };
}
const STATUSES = ['open', 'fixed', 'false'];
function setStatus(dataDir, key, id, status, by, why) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'A fault is open, fixed or false.' };
  if (status === 'false' && oneLine(why).length < 3) return { ok: false, error: 'Say why it is not a fault: the reason is kept with it.' };
  const faults = readFaults(dataDir, key);
  const f = faults.find(x => x.id === id);
  if (!f) return { ok: false, error: 'That fault is not on the list any more.' };
  f.status = status;
  f.changed = { by: oneLine(by).slice(0, 60) || 'you', on: today(), ...(status === 'false' ? { why: oneLine(why).slice(0, 400) } : {}) };
  writeFaults(dataDir, key, faults);
  return { ok: true, faults };
}

module.exports = { buildPrompt, fileGroups, parseFindings, readFaults, importFindings, setStatus, CHECKLIST };
