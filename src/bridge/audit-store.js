// Running the audit for a project and keeping its last report in <data>/audits/<id>.json.
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { runAudit, summarise } = require('./audit');
const { liveOpts } = require('./live-state');
const { autoDetails, readPrivateList } = require('./disclosure');
const judged = require('./judged');
const review = require('./review');
const { keyOf } = require('./projects');
const { state } = require('./state');

const file = id => path.join(cfg.DATA, 'audits', id + '.json');
// A saved audit edited by hand or cut short is read as far as it makes sense: only findings with a rule and a place.
function lastAudit(id) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  a.findings = Array.isArray(a.findings) ? a.findings.filter(f => f && typeof f === 'object' && typeof f.rule === 'string' && typeof f.where === 'string' && typeof f.sev === 'string') : [];
  return a;
}
function auditSummary(a) { return a && { ranAt: a.ranAt, counts: a.counts, verdict: a.verdict, url: a.url, liveUrl: a.liveUrl || null }; }

// What the disclosure pass looks for in project p: the person's own list, this PC's details, and the names of every
// other project on the list (and the Bridge's own folder), but not p's own names.
function disclosureContext(p) {
  const others = [path.basename(cfg.HERE)];
  for (const x of state.projects) if (x.id !== p.id) others.push(x.folder, x.name);
  return { details: [...readPrivateList(cfg.PRIVATE_FILE), ...autoDetails(state.settings.workingFolders || [])], others, own: [p.folder, p.name] };
}

// The judged list for p: <data>/judged.json, plus older set-asides written by hand as auditAccept in the Bridge's
// projects.json ({ rule, file, fp, reason }; one with no fp only covers a finding that has no line, such as a file).
function judgedFor(p) {
  const legacy = (p.auditAccept || []).map(a => ({ id: 'projects.json', rule: a && a.rule, file: a && a.file, verdict: 'false',
    ...(a && a.fp ? { fp: a.fp } : { where: a && a.file }), why: (a && a.reason) || 'set aside in projects.json', by: 'projects.json', source: 'projects.json' }));
  return [...judged.entriesFor(cfg.JUDGED_FILE, keyOf(p.dir)), ...legacy];
}
function ownNotes(p) {
  const out = [];
  if (p.auditAcceptOwn) out.push('The project\'s own project.json asks to set aside ' + p.auditAcceptOwn + ' finding' + (p.auditAcceptOwn > 1 ? 's' : '') + ': not done. A project cannot vouch for itself; judge them in this window instead.');
  if (p.auditSkipOwn && p.auditSkipOwn.length) out.push('Left out at the request of the project\'s own project.json: ' + p.auditSkipOwn.slice(0, 8).join(', ') + '. Check that is only vendored or generated code.');
  return out;
}

// Each rule's record (lib/judged.js ruleRecords), from every project's judged list and every saved audit: a finding
// whose rule people have set aside in 3+ files, more often than it still stands, carries `check`; the audit carries
// the records of the rules it shows that someone has judged at all.
function withRecords(p, a) {
  const standing = {};
  const count = au => { for (const f of (au && au.findings) || []) standing[f.rule] = (standing[f.rule] || 0) + 1; };
  let names = []; try { names = fs.readdirSync(path.join(cfg.DATA, 'audits')).filter(n => n.endsWith('.json') && n !== p.id + '.json'); } catch {}
  for (const n of names) { try { count(JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'audits', n), 'utf8'))); } catch {} }
  count(a);
  const rec = judged.ruleRecords(cfg.JUDGED_FILE, standing);
  const strip = f => { const { check: _c, ...rest } = f; return rest; };
  const findings = a.findings.map(f => (rec[f.rule] && rec[f.rule].check ? { ...strip(f), check: true } : strip(f)));
  const records = {};
  for (const rule of new Set([...findings, ...(a.setAside || [])].map(f => f.rule))) if (rec[rule] && rec[rule].false) records[rule] = rec[rule];
  return { ...a, findings, records };
}

// target: the local copy's address when one is running (null: the project's files only).
async function auditProject(p, target) {
  const opts = { skip: p.auditSkip, include: p.auditInclude, judged: judgedFor(p), notes: ownNotes(p), disclosure: disclosureContext(p), ...(p.liveUrl ? { liveUrl: p.liveUrl, ...liveOpts(p.liveUrl) } : {}) };
  const a = withRecords(p, await runAudit(p.dir, target, opts));
  fs.writeFileSync(file(p.id), JSON.stringify(a, null, 2));
  return a;
}

// After a judgement changes: the last audit's findings (set-aside ones included) judged again, without a new scan.
function rejudge(p) {
  const a = lastAudit(p.id);
  if (!a) return null;
  const strip = f => { const { judged: _j, knownAs: _k, ...rest } = f; return rest; };
  const all = [...a.findings, ...(a.setAside || a.accepted || [])].map(strip);
  const j = judged.applyJudged(all, judgedFor(p));
  const out = withRecords(p, { ...a, findings: j.findings, setAside: j.setAside, ...summarise(j.findings) });
  delete out.accepted;
  fs.writeFileSync(file(p.id), JSON.stringify(out, null, 2));
  return out;
}

// body: { rule, where, fp, why, by } for one finding of the last audit.
function judge(p, body) {
  const a = lastAudit(p.id);
  const f = a && a.findings.find(x => x.rule === body.rule && x.where === body.where && (x.fp || null) === (body.fp || null));
  if (!f) return { ok: false, error: 'That finding is not in the last audit any more. Scan again, then judge it.' };
  const r = judged.addEntry(cfg.JUDGED_FILE, keyOf(p.dir), { rule: f.rule, where: f.where, fp: f.fp, verdict: 'false', why: body.why, by: body.by, source: 'audit window' }, p.dir);
  return r.ok ? { ok: true, audit: rejudge(p) } : r;
}
function unjudge(p, id) {
  if (id === 'projects.json') return { ok: false, error: 'That one is written in the Bridge\'s projects.json (auditAccept): remove it there.' };
  const r = judged.removeEntry(cfg.JUDGED_FILE, keyOf(p.dir), String(id || ''));
  return r.ok ? { ok: true, audit: rejudge(p) } : r;
}
// A report-back, pasted or read from a file on the page: its "False flags" table judges the scanner's findings, its
// "Findings" table (from Review with AI) goes on the project's fault list. Either table alone is fine.
function importReportBack(p, body) {
  const text = String(body.text || '');
  const found = review.parseFindings(text);
  // the false flags: from the "False flags" section, or every table row when there is no Findings section either
  const hasFindings = /^#{1,4}\s*\d*\.?\s*Findings\b/im.test(text);
  const rows = hasFindings && !/^#{1,4}\s*\d*\.?\s*False flags/im.test(text) ? [] : judged.parseReportBack(text);
  if (!rows.length && !found.rows.length && !found.refused.length) return { ok: false, error: 'No table rows found. Paste the "Findings" table (| Id | Severity | Category | Where | Evidence | Fix |) or the "False flags" table (| Rule | Where | Verdict | Why | What the rule should do |).' };
  if (rows.length + found.rows.length > 300) return { ok: false, error: 'That is ' + (rows.length + found.rows.length) + ' rows; import at most 300 at a time.' };
  const by = String(body.by || '').trim() || 'report-back', source = 'report-back' + (body.source ? ' (' + String(body.source).slice(0, 80) + ')' : '');
  const a = lastAudit(p.id);
  const all = a ? [...a.findings, ...(a.setAside || [])] : [];
  const results = rows.length ? judged.importRows(cfg.JUDGED_FILE, keyOf(p.dir), rows, all, p.dir, by, source) : [];
  const f = found.rows.length ? review.importFindings(cfg.DATA, keyOf(p.dir), found.rows, by, source) : { added: 0, again: 0, faults: review.readFaults(cfg.DATA, keyOf(p.dir)) };
  return { ok: true, results, findings: { added: f.added, again: f.again, refused: found.refused }, faults: f.faults, audit: rows.length ? rejudge(p) : a };
}

// "Review with AI…": the prompt for this project (to copy into any AI), and the project's fault list.
function reviewPrompt(p) {
  const { makeMatcher } = require('./disclosure');
  const scan = makeMatcher(disclosureContext(p));
  return { ok: true, prompt: review.buildPrompt(p, lastAudit(p.id), judgedFor(p), scan.redact), faults: review.readFaults(cfg.DATA, keyOf(p.dir)) };
}
const faultsOf = p => ({ ok: true, faults: review.readFaults(cfg.DATA, keyOf(p.dir)) });
const setFault = (p, body) => review.setStatus(cfg.DATA, keyOf(p.dir), String(body.fault || ''), String(body.status || ''), body.by, body.why);

module.exports = { lastAudit, auditSummary, auditProject, disclosureContext, judge, unjudge, importReportBack, judgedFor, reviewPrompt, faultsOf, setFault };
