// The judged list: findings a person checked and found wrong, kept as data in the Bridge's ignored data folder, never
// as a list of rules in code. One entry is one place in one project: the rule, the file, and the line's fingerprint
// (a hash of the line's text), with the reason and who said it. A matching finding is not counted; it is listed as
// "set aside" with that reason. Edit the line and its fingerprint changes, so the finding comes back.
// A "false" that names no place (no file, "*", a pattern) would silence a rule for the whole project: it is refused.
// "duplicate of <id>" keeps the finding (it is real) and tags it with the id it is already known as.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The same fingerprint as lib/audit.js: the line's text with its spacing evened out, hashed.
const fingerprint = line => crypto.createHash('sha1').update(String(line).trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 12);
// 'lib/a.php:12' -> 'lib/a.php'. A place with no line (a file, a folder, an address) is kept whole.
const fileOf = where => String(where || '').replace(/:\d+$/, '').replace(/\\/g, '/').trim();
const lineOf = where => { const m = /:(\d+)$/.exec(String(where || '')); return m ? +m[1] : null; };
const sameFile = (a, b) => fileOf(a).toLowerCase() === fileOf(b).toLowerCase();
// The disclosure rules' lines can hold a private detail, so their text is never stored; the fingerprint is enough.
const textIsPrivate = rule => /^DISC-/.test(rule);

// ---------- the file ----------

function readAll(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j.projects === 'object' && j.projects ? j : { projects: {} }; }
  catch { return { projects: {} }; }
}
function writeAll(file, all) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  all.note = 'Findings checked by a person and judged wrong (or already known), per project. Kept on this PC only. An entry matches one line by its fingerprint; editing that line brings the finding back.';
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}
const entriesFor = (file, key) => (readAll(file).projects[key] || []).filter(e => e && typeof e === 'object');

// Why an entry cannot be used, or null. Checked when saved AND when read (the file can be edited by hand).
function refusal(e) {
  if (!e || !/^[A-Z]{2,6}-\d{3}$/.test(String(e.rule || ''))) return 'it names no rule (like INJ-003)';
  const file = String(e.file || '').trim();
  if (e.verdict !== 'false' && e.verdict !== 'duplicate') return 'its verdict is not "false" or "duplicate of <id>"';
  if (e.verdict === 'duplicate') return /^[A-Za-z]{1,6}-?\d{1,5}$/.test(String(e.duplicateOf || '')) ? null : 'a duplicate must name the id it repeats';
  if (!file || file === '*' || /[*?]/.test(file) || file === '.' || file === '/') return 'a "false" must name one place: one that names no file would silence ' + e.rule + ' for the whole project';
  if (!e.fp && !e.where) return 'it names a file but not the line (judge one finding at a time)';
  if (String(e.why || '').trim().length < 3) return 'it gives no reason';
  return null;
}

function matches(e, f) {
  if (e.rule !== f.rule) return false;
  if (e.verdict === 'duplicate' && (!e.file || e.file === '*')) return true; // a duplicate may cover every place
  if (!sameFile(e.file, f.where)) return false;
  if (e.fp) return e.fp === f.fp;
  return String(e.where).trim().toLowerCase() === String(f.where).trim().toLowerCase(); // a place with no line text
}

// findings -> { findings (kept), setAside, notes }. Set-aside findings keep every field, plus `judged`.
function applyJudged(findings, entries) {
  const usable = [], notes = [];
  for (const e of entries || []) {
    const why = refusal(e);
    if (why) notes.push('A judged entry for ' + (e && e.rule || 'a finding') + (e && e.file ? ' in ' + e.file : '') + ' was not used: ' + why + '.');
    else usable.push(e);
  }
  const kept = [], setAside = [];
  for (const f of findings) {
    const e = usable.find(x => matches(x, f));
    if (e && e.verdict === 'false') { setAside.push({ ...f, judged: { id: e.id, why: e.why, by: e.by || 'you', on: e.on || '', source: e.source || '' } }); continue; }
    kept.push(e ? { ...f, knownAs: String(e.duplicateOf).toUpperCase() } : f);
  }
  return { findings: kept, setAside, notes };
}

// ---------- adding and removing ----------

// this PC's own date (toISOString is UTC: wrong for hours each day away from London)
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const clip = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);

// e: { rule, where, fp?, verdict, why, by, duplicateOf?, source?, ruleShould? }; dir: the project (to read the line's
// text when no fingerprint is given). Returns { ok, entry } or { ok:false, error }.
function addEntry(file, key, e, dir) {
  const entry = {
    id: crypto.randomBytes(5).toString('hex'),
    rule: clip(e.rule, 12).toUpperCase(),
    file: fileOf(e.where),
    verdict: /^dup/i.test(String(e.verdict)) ? 'duplicate' : 'false',
    why: clip(e.why, 300),
    by: clip(e.by, 60) || 'you',
    on: today(),
    source: clip(e.source, 120) || 'audit window',
  };
  if (entry.verdict === 'duplicate') entry.duplicateOf = clip(e.duplicateOf, 12).toUpperCase();
  if (e.ruleShould) entry.ruleShould = clip(e.ruleShould, 300);
  let text = null;
  if (e.fp) entry.fp = String(e.fp).slice(0, 40);
  else if (lineOf(e.where) && dir) {
    text = lineAt(dir, e.where);
    if (text == null) return { ok: false, error: fileOf(e.where) + ' has no line ' + lineOf(e.where) + ' now, so there is no line to judge.' };
    entry.fp = fingerprint(text);
  } else entry.where = clip(e.where, 300);
  // The line's text, for a person reading the file later. Never for the disclosure rules (it may be the private detail).
  if (!textIsPrivate(entry.rule)) {
    if (text == null && lineOf(e.where) && dir) text = lineAt(dir, e.where);
    if (text != null && fingerprint(text) === entry.fp) entry.text = clip(text, 200);
  }
  const why = refusal(entry);
  if (why) return { ok: false, error: 'Not saved: ' + why + '.' };
  const all = readAll(file);
  const list = (all.projects[key] || []).filter(x => !(x.rule === entry.rule && sameFile(x.file, entry.file) && (x.fp || x.where) === (entry.fp || entry.where)));
  list.push(entry);
  all.projects[key] = list;
  writeAll(file, all);
  return { ok: true, entry };
}
function removeEntry(file, key, id) {
  const all = readAll(file);
  const list = all.projects[key] || [];
  const left = list.filter(x => x.id !== id);
  if (left.length === list.length) return { ok: false, error: 'That entry is not on the list any more.' };
  all.projects[key] = left;
  writeAll(file, all);
  return { ok: true };
}
// The text of line N of a project file, or null. Only a plain file inside the project (no "git history:", no zip).
function lineAt(dir, where) {
  const rel = fileOf(where), n = lineOf(where);
  if (!n || /^git history: | > /.test(rel)) return null;
  const full = path.resolve(dir, rel);
  if (!full.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)) return null;
  try { const st = fs.statSync(full); if (!st.isFile() || st.size > 4 * 1024 * 1024) return null; return fs.readFileSync(full, 'utf8').split(/\r?\n/)[n - 1] ?? null; }
  catch { return null; }
}

// ---------- report-back tables ----------

// The "False flags" table of a report-back (| Rule | Where | Verdict | Why | What the rule should do |), or, when the
// text has no such heading, every table row in it. Rows with no usable verdict are skipped with a reason.
function parseReportBack(text) {
  const t = String(text || '');
  const sec = /^#{1,4}\s*\d*\.?\s*False flags.*$([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(t);
  const body = sec ? sec[1] : t;
  const rows = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|') || /^\|[\s:|-]+\|?$/.test(line)) continue;
    const c = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim().replace(/^`+|`+$/g, ''));
    if (c.length < 4 || /^(rule|none)?$/i.test(c[0]) || /^none\b/i.test(c[0])) continue;
    const verdict = c[2];
    const dup = /duplicate(?:\s+of)?\s*:?\s*([A-Za-z]{1,6}-?\d{1,5})/i.exec(verdict);
    const kind = dup ? 'duplicate' : /^\W*(false|not a fault|not-a-fault)\b/i.test(verdict) ? 'false' : null;
    // "a.php:3, b.php:9" is two places.
    for (const where of c[1].split(/[,;]\s+(?=[^,;]*:\d+\b)/).map(s => s.trim()).filter(Boolean)) {
      rows.push({ rule: c[0].toUpperCase(), where, verdict: kind, duplicateOf: dup ? dup[1].toUpperCase() : '', why: c[3], ruleShould: c[4] || '', raw: verdict });
    }
  }
  return rows;
}

// Each row is pinned to one finding of the last audit (same rule and place) or, failing that, to the line in the file
// now. Returns [{ rule, where, ok, error? }].
function importRows(file, key, rows, lastFindings, dir, by, source) {
  const out = [];
  for (const r of rows) {
    if (!r.verdict) { out.push({ rule: r.rule, where: r.where, ok: false, error: 'verdict "' + clip(r.raw, 40) + '" is not "false" or "duplicate of <id>" (a real fault is fixed, not judged)' }); continue; }
    if (!fileOf(r.where) || /[*?]/.test(r.where)) { out.push({ rule: r.rule, where: r.where, ok: false, error: 'a "false" must name one place; "' + (r.where || '(blank)') + '" would silence ' + r.rule + ' for the whole project' }); continue; }
    const found = (lastFindings || []).filter(f => f.rule === r.rule && (f.where === r.where || (sameFile(f.where, r.where) && !lineOf(r.where))));
    // No line given: it must point at exactly one finding of the last audit, or it would judge a whole file.
    if (!lineOf(r.where) && found.length !== 1) { out.push({ rule: r.rule, where: r.where, ok: false, error: (found.length ? 'the last audit has ' + found.length : 'the last audit has no') + ' ' + r.rule + ' finding' + (found.length === 1 ? '' : 's') + ' there: name the line (file:line)' }); continue; }
    const f = found[0];
    const res = addEntry(file, key, { rule: r.rule, where: f ? f.where : r.where, fp: f ? f.fp : null, verdict: r.verdict, duplicateOf: r.duplicateOf, why: r.why, ruleShould: r.ruleShould, by, source }, dir);
    out.push({ rule: r.rule, where: r.where, ok: res.ok, error: res.error });
  }
  return out;
}

// ---------- each rule's record (scanner training T7) ----------
// How often people said a rule was wrong, across every project: places set aside as "false" and the files they sit in,
// against the places it still flags in the last saved audits. A rule set aside in 3 or more files, and more often than
// it is still standing, is marked "check": its findings are shown, with that record beside them, as less certain.
// file: judged.json; standing: { rule: count } from the last audits. Returns { rule: { false, files, standing, check } }.
const CHECK_FILES = 3;
function ruleRecords(file, standing = {}) {
  const out = {};
  for (const list of Object.values(readAll(file).projects)) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || e.verdict !== 'false' || !e.rule) continue;
      const r = out[e.rule] || (out[e.rule] = { false: 0, files: new Set(), standing: 0 });
      r.false++;
      r.files.add(String(e.file || e.where || '').toLowerCase());
    }
  }
  for (const [rule, n] of Object.entries(standing)) (out[rule] || (out[rule] = { false: 0, files: new Set(), standing: 0 })).standing = n;
  for (const r of Object.values(out)) { r.files = r.files.size; r.check = r.files >= CHECK_FILES && r.false > r.standing; }
  return out;
}

module.exports = { fingerprint, fileOf, applyJudged, refusal, entriesFor, addEntry, removeEntry, parseReportBack, importRows, lineAt, ruleRecords, CHECK_FILES };
