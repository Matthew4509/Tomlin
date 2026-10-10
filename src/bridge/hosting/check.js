// Check before push: which files of the upload folder go to the host, which are left out and why, and anything in
// them that must not go live (a key, a password, a saved secret's value, a private detail, a path on this PC).
// A finding stops the push and names the file and line; the person can mark one "not a secret" (kept by the line's
// fingerprint, so an edited line is checked again), except a saved secret's own value, which always stops it.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const disclosure = require('../disclosure');
const { gitConfigRisky } = require('../gitstate');
const { fingerprint } = require('../judged');

const MAX_FILES = 20000;
const MAX_TEXT = 5 * 1024 * 1024; // up to this size a file is read whole; a bigger one is looked at first
const MAX_SCAN = 64 * 1024 * 1024; // a bigger text file cannot be looked inside: it stops the push until marked
const LINE_PART = 20000, LINE_OVERLAP = 2000; // a long line (a minified bundle) is checked in overlapping parts

// Never sent, whatever the folder holds. The reason is shown with each.
const HARD = [
  [/(^|\/)\.git(\/|$)/i, 'git\'s own history'],
  [/(^|\/)node_modules\//i, 'installed packages (the host installs its own)'],
  [/(^|\/)\.env($|\.|\/)/i, 'a secrets file (.env): its values belong in Secrets'],
  [/(^|\/)[^/]*\.(pem|key|p12|pfx|ppk|jks|keystore|kdbx)$/i, 'a key or certificate file'],
  [/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i, 'an SSH key'],
  [/(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.netrc|_netrc|\.git-credentials|\.pgpass|\.pypirc|\.my\.cnf)$|(^|\/)\.(aws|docker|ssh|kube)\//i, 'a file that holds logins or tokens (.npmrc, .netrc, .git-credentials, .aws/ and the like)'],
  [/(^|\/)(\.claude|\.cursor|\.codex|\.aider[^/]*|\.windsurf|\.vscode|\.idea)\//i, 'an editor\'s or AI tool\'s own folder'],
  [/(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)HANDOFF[^/]*\.md$|(^|\/)TOKEN-(LOG|USAGE)\.md$|(^|\/)(PROMPTS?|REVERT)([-_ .][^/]*)?\.(md|txt)$|(^|\/)\.(cursorrules|windsurfrules|clinerules)$/i, 'working notes (AI hand-offs and prompts)'],
  [/(^|\/)(Thumbs\.db|desktop\.ini|\.DS_Store)$/i, 'a file Windows or a Mac makes by itself'],
  [/(^|\/)tomlin-secrets\.php$/i, 'TOMLIN writes this file itself on each push'],
];
// Left out unless the person ticks the folder or kind back on (site.sendAnyway holds the keys).
const SOFT = [
// [key, which files, why they are left out, the tick that sends them anyway]
  ['data', /^data\//i, 'the data/ folder (often private: saved records, uploads, logs)', 'the data/ folder (often private: saved records, uploads, logs)'],
  ['sql', /\.sql(\.gz)?$/i, 'a database dump (.sql): load it with Database instead', 'database dumps (.sql files); a database is loaded with Database'],
  ['db', /\.(sqlite3?|db)$/i, 'a database file', 'database files (.sqlite, .db)'],
  ['logs', /(^|\/)logs?\/|\.log$/i, 'logs', 'logs (logs/ and .log files)'],
  ['backups', /(^|\/)(backups?|releases|build)\/|\.(zip|7z|rar|tar|tgz|gz|bak)$/i, 'backups, releases and archives', 'backups, releases and archives (.zip, .bak, build/)'],
  ['docs', /^docs\/|(^|\/)(PLAN|TODO|NOTES?)\.md$/i, 'plans and notes (docs/, PLAN.md, TODO.md)', 'plans and notes (docs/, PLAN.md, TODO.md)'],
  // Not by name: files the project's .gitignore leaves out (a built dist/ or vendor/ folder is often one), found by
  // comparing the folder with git's own list.
  ['gitignored', /(?!)/, 'in .gitignore (git leaves it out)', 'files your .gitignore leaves out (a built dist/ or vendor/ folder is often one)'],
];

// Key shapes that are a key on sight. Each is a stop.
const KEYS = [
  ['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Stripe live key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a SendGrid key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/],
  ['a cPanel token', /\bcpanel\s+[a-z0-9_]+:[A-Z0-9]{32}\b/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
];
// A password written into an address: scheme://user:password@host.
const URL_PASS = /\b[a-z][a-z0-9+.-]{1,15}:\/\/([^\s:@/'"<>]+):([^\s@/'"<>]{3,})@[\w.-]/gi;
// PHP's define('DB_PASSWORD', '...') (WordPress and others): the same idea as ASSIGN, written as a call.
const DEFINE = /\bdefine\s*\(\s*(['"])(\w*(?:PASS(?:WORD)?|PWD|SECRET|KEY|TOKEN|SALT)\w*)\1\s*,\s*(['"])([^'"]{8,})\3/gi;
// A password or key written into the code: name = "a literal of 8+ characters". Placeholders and reading from the
// environment are not counted.
const ASSIGN = /\b([A-Za-z_]*(?:pass(?:word|wd)?|pwd|secret|api_?key|apikey|token|private_?key|client_?secret|auth_?key)[A-Za-z_]*)['"]?\s*(?:=>|=|:)\s*(['"])([^'"\s]{8,})\2/i;
const PLACEHOLDER = /^(?:x+|\*+|\.+|changeme|change_me|password|secret|your[_-].*|<.*>|\{.*\}|\$\{.*\}|%.*%|example.*|test.*|dummy.*|placeholder.*|put your unique phrase here|pass(word)?|pwd|user(name)?|null|none|undefined|true|false|required|optional|text|string|hidden|current-password|new-password)$/i;

const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const ruleKey = (rule, rel, fp) => rule + '|' + rel.toLowerCase() + '|' + fp;

// Every file of the folder. A folder it could not read (or too deep) is named in missed: an incomplete list must not
// go out, as a file missing from it would be removed from the server. One that stopped at MAX_FILES says so in missed
// too (count: true), so a list made from it is never taken as whole.
function walk(dir, missed = []) {
  const out = [];
  const relOf = d => path.relative(dir, d).replace(/\\/g, '/') || '.';
  const go = (d, depth) => {
    if (out.length >= MAX_FILES) { if (!missed.some(m => m.count)) missed.push({ rel: '(more files)', count: true }); return; }
    if (depth > 20) { missed.push({ rel: relOf(d), why: 'is more than 20 folders deep' }); return; }
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { missed.push({ rel: relOf(d), why: 'could not be read (' + (e.code || e.message) + ')' }); return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') go(p, depth + 1); }
      else if (e.isFile()) out.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  };
  go(dir, 0);
  return out;
}

// The upload folder's files that git would publish (its .gitignore is followed), or every file when git cannot say.
async function candidates(projectDir, folder, missed) {
  const isRepo = fs.existsSync(path.join(projectDir, '.git')) && !gitConfigRisky(projectDir);
  let list = null;
  try { list = await disclosure.publishedFiles(folder, isRepo); } catch { list = null; }
  if (!list) return { rels: walk(folder, missed), ignored: [], ignoredMissed: [] };
  // A listed file that is gone (deleted, not committed yet) or is a folder (a submodule) is not one to send; one that
  // is there but cannot be looked at (no rights, held) stays, so the check names it instead of dropping it.
  const rels = [...new Set(list.map(f => f.rel.replace(/\\/g, '/')))].filter(rel => { try { return fs.statSync(path.join(folder, rel)).isFile(); } catch (e) { return e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; } });
  // Also the files git leaves out, so they are shown as left out with that reason, never dropped without a word. What
  // that walk could not see matters only when they are sent too (the tick), so it is kept for the check to decide.
  const known = new Set(rels.map(x => x.toLowerCase()));
  const ignoredMissed = [];
  return { rels, ignored: walk(folder, ignoredMissed).filter(rel => !known.has(rel.toLowerCase())), ignoredMissed };
}

/**
 * opts: { projectDir, folder (absolute upload folder), sendAnyway: [keys], ignore: [ruleKey], secrets: { label: value }
 *         (Local and Live values each under their own label, "local DB_PASS" / "live DB_PASS"; a value shorter than 6
 *         characters is not looked for: it would turn up in ordinary text everywhere),
 *         details: [{ label, value }] (private details), otherDetails: from disclosure.autoDetails }
 * -> { files: [{ rel, size, sha }], left: [{ rel, why }], findings: [{ rule, rel, line, what, key, canIgnore }], bytes }
 */
async function checkFolder(opts) {
  const folder = opts.folder;
  const missed = [];
  const all = await candidates(opts.projectDir, folder, missed);
  const files = [], left = [], findings = [];
  const ignoredToo = (opts.sendAnyway || []).includes('gitignored');
  for (const rel of all.ignored) {
    const hard = HARD.find(([re]) => re.test(rel));
    if (hard) left.push({ rel, why: hard[1] });
    else if (!ignoredToo) left.push({ rel, why: 'in .gitignore (git leaves it out)', soft: 'gitignored' });
  }
  const rels = [...all.rels, ...(ignoredToo ? all.ignored.filter(rel => !HARD.some(([re]) => re.test(rel))) : [])].sort();
  // Files the .gitignore leaves out are sent too: a folder that walk could not read makes that list incomplete as well.
  if (ignoredToo) for (const m of all.ignoredMissed) if (!missed.some(x => x.rel === m.rel)) missed.push(m);
  const cut = missed.some(m => m.count);
  for (const m of missed.filter(m => !m.count)) findings.push({ rule: 'FOLDER', rel: m.rel, line: 0, what: 'this folder ' + m.why + ', so the list of files to send is not complete: fix it and check again', key: '', canIgnore: false });
  const send = new Set(opts.sendAnyway || []);
  const ignore = new Set(opts.ignore || []);
  // One value saved under two labels (the same Local and Live value) is looked for once, named by both.
  const byValue = new Map();
  for (const [name, v] of Object.entries(opts.secrets || {})) if (typeof v === 'string' && v.length >= 6) byValue.set(v, [...(byValue.get(v) || []), name]);
  const values = [...byValue].map(([v, names]) => [names.join(' and '), v, names[0]]);
  const matcher = disclosure.makeMatcher({ details: [...(opts.details || []), ...(opts.otherDetails || [])] });
  let bytes = 0;
  if (rels.length >= MAX_FILES || cut) findings.push({ rule: 'COUNT', rel: '(more files)', line: 0, what: 'the folder has more than ' + MAX_FILES.toLocaleString('en') + ' files, the most TOMLIN looks at, so the list to send is not complete: pick a smaller upload folder in Set up', key: '', canIgnore: false });
  for (const rel of rels) {
    const hard = HARD.find(([re]) => re.test(rel));
    if (hard) { left.push({ rel, why: hard[1] }); continue; }
    const soft = SOFT.find(([k, re]) => re.test(rel) && !send.has(k));
    if (soft) { left.push({ rel, why: soft[2], soft: soft[0] }); continue; }
    const abs = path.join(folder, rel);
    // Gone since the list was made: not sent (as if deleted). There but not readable: a stop, never a silent drop (a
    // file TOMLIN sent before that is missing from the list would be removed from the server).
    let st; try { st = fs.statSync(abs); } catch (e) {
      if (e.code !== 'ENOENT') findings.push({ rule: 'READ', rel, line: 0, what: 'could not be looked at (' + (e.code || e.message) + '): close the program that holds it, or give your account rights to it, and check again', key: '', canIgnore: false });
      continue;
    }
    let buf = null, sha, bigText = false, hits = null;
    try {
      // A big file is read whole only when it is text to look inside; a big binary one (a video), or text too big to
      // look inside, is fingerprinted in parts, and those same parts are searched for a saved secret's value.
      const big = st.size > MAX_TEXT && !isBinaryStart(abs);
      bigText = big && st.size > MAX_SCAN;
      if (st.size > MAX_TEXT && (!big || bigText)) ({ sha, hits } = hashFile(abs, values.map(([, v]) => v), true));
      else { buf = fs.readFileSync(abs); sha = crypto.createHash('sha256').update(buf).digest('hex'); }
    } catch (e) { findings.push({ rule: 'READ', rel, line: 0, what: 'could not be read (' + e.code + '): close the program that holds it and check again', key: '', canIgnore: false }); continue; }
    files.push({ rel, size: st.size, sha });
    bytes += st.size;
    const found = (rule, line, lineText, what, canIgnore = true) => {
      const key = ruleKey(rule, rel, lineText == null ? 'file' : fingerprint(lineText));
      if (canIgnore && ignore.has(key)) return;
      findings.push({ rule, rel, line, what, key, canIgnore });
    };
    // The file's own name can hold a private detail (an email as a file name).
    for (const h of matcher.inName(rel)) if (h.rule === 'DISC-001') found('NAME', 0, null, 'its name has ' + [...h.labels].join(', '));
    if (bigText) found('BIG', 0, sha, 'is a text file of ' + Math.round(st.size / 1048576) + ' MB, too big for TOMLIN to look inside: leave it out of the upload folder, or mark it "not a secret" to send it unchecked');
    if (!buf) {
      for (const i of hits || []) found('VALUE', 0, null, 'holds the value of ' + values[i][0] + ' (inside the file): leave the file out, or take the value out of it', false);
      continue;
    }
    const text = disclosure.decodeText(buf);
    if (text == null) {
      // A file read as binary (a database file, a PDF) is still searched for a saved secret's value, as bytes.
      for (const [name, v, first] of values) if (buf.includes(Buffer.from(v, 'utf8')) || buf.includes(Buffer.from(v, 'utf16le'))) found('VALUE', 0, null, 'holds the value of ' + name + ' (inside the file): leave the file out, or take the value out of it', false);
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const [name, v, first] of values) {
      const i = lines.findIndex(l => l.includes(v));
      if (i >= 0) found('VALUE', i + 1, lines[i], 'holds the value of ' + name + ' written out: read it with getenv(\'' + first.replace(/^(live|local) /, '') + '\') instead', false);
    }
    for (let i = 0; i < lines.length; i++) {
      // The whole line; a long one (a minified bundle) in overlapping parts, so a key far along it is still found.
      const line = lines[i];
      let key = null, set = null;
      for (let at = 0; at < Math.max(line.length, 1) && !(key && set); at += LINE_PART - LINE_OVERLAP) {
        const l = line.length > LINE_PART ? line.slice(at, at + LINE_PART) : line;
        if (!key) key = KEYS.find(([, re]) => re.test(l)) || null;
        if (!set) set = writtenOut(l);
        if (line.length <= LINE_PART) break;
      }
      if (key) found('KEY', i + 1, line, 'holds ' + key[0]);
      if (set) found('ASSIGN', i + 1, line, set.url ? 'has a password written into an address (' + set.name + ':…@): keep it in Secrets and build the address from getenv()' : 'sets ' + set.name + ' to a written-out value: keep it in Secrets and read it with getenv(\'' + set.name.toUpperCase() + '\')');
    }
    for (const h of matcher(text)) {
      if (h.rule === 'DISC-001') found('PRIVATE', h.line, lines[h.line - 1] || '', 'has ' + [...h.labels].join(', '));
      else if (h.rule === 'DISC-004') found('PATH', h.line, lines[h.line - 1] || '', 'has a path on this PC (it names your user folder)');
    }
  }
  return { files, left, findings, bytes };
}

// A password or key written into the text: every assignment on it is looked at (not only the first), as is PHP's
// define() and a password inside an address. A placeholder value is not one.
const ASSIGN_ALL = new RegExp(ASSIGN.source, 'gi');
function writtenOut(l) {
  for (const m of l.matchAll(ASSIGN_ALL)) if (!PLACEHOLDER.test(m[3])) return { name: m[1] };
  for (const m of l.matchAll(DEFINE)) if (!PLACEHOLDER.test(m[4])) return { name: m[2] };
  for (const m of l.matchAll(URL_PASS)) if (!PLACEHOLDER.test(m[2]) && !/^[$%{<]/.test(m[2])) return { name: m[1], url: true };
  return null;
}

// A big file's first bytes: binary (no text TOMLIN can read in them) or text.
function isBinaryStart(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const b = Buffer.alloc(8000);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    return disclosure.decodeText(b.subarray(0, n)) == null;
  } finally { fs.closeSync(fd); }
}
// A file's sha256 read in parts, so a big one is never held in memory whole. With full, each part is also searched for
// each of values as UTF-8 and as UTF-16 bytes, with the end of the part before kept in front of it, so a value cut in
// two by the parts is still found: -> { sha, hits: [the index of each value found] }.
function hashFile(abs, values = [], full = false) {
  const h = crypto.createHash('sha256');
  const needles = values.flatMap((v, i) => [[i, Buffer.from(v, 'utf8')], [i, Buffer.from(v, 'utf16le')]]);
  const keep = needles.reduce((a, [, b]) => Math.max(a, b.length - 1), 0);
  const hits = new Set();
  const fd = fs.openSync(abs, 'r');
  try {
    const b = Buffer.alloc(1024 * 1024);
    let n, tail = Buffer.alloc(0);
    while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) {
      const part = b.subarray(0, n);
      h.update(part);
      if (!needles.length) continue;
      const look = tail.length ? Buffer.concat([tail, part]) : part;
      for (const [i, nb] of needles) if (!hits.has(i) && look.includes(nb)) hits.add(i);
      tail = Buffer.from(look.subarray(Math.max(0, look.length - keep)));
    }
  } finally { fs.closeSync(fd); }
  const sha = h.digest('hex');
  return full ? { sha, hits: [...hits].sort((a, b) => a - b) } : sha;
}

// The upload folder a project most likely means: a folder named like a web root that holds an index page, else the
// project's own folder.
function guessFolder(projectDir) {
  for (const n of ['public_html', 'public', 'htdocs', 'www', 'site', 'dist', 'build', 'web']) {
    const d = path.join(projectDir, n);
    try { if (fs.statSync(d).isDirectory() && fs.readdirSync(d).some(f => /^index\.(php|html?)$/i.test(f))) return n; } catch {}
  }
  return '';
}
// Folders the person can pick as the upload folder (two levels down, no hidden or package folders).
function folderChoices(projectDir) {
  const out = [''];
  const go = (d, rel, depth) => {
    if (depth > 2 || out.length > 60) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !/^(\.|node_modules$|vendor$)/.test(e.name)) { const r = rel ? rel + '/' + e.name : e.name; out.push(r); go(path.join(d, e.name), r, depth + 1); }
  };
  go(projectDir, '', 1);
  return out;
}
// The upload folder as an absolute path, refusing anything outside the project.
function folderOf(projectDir, rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (r.split('/').some(s => s === '..')) return null;
  const abs = path.resolve(projectDir, r);
  const base = path.resolve(projectDir);
  if (abs !== base && !abs.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return null;
  try { if (!fs.statSync(abs).isDirectory()) return null; } catch { return null; }
  return abs;
}

module.exports = { checkFolder, guessFolder, folderChoices, folderOf, hashFile, SOFT, HARD, ruleKey, sha, MAX_TEXT, MAX_SCAN };
