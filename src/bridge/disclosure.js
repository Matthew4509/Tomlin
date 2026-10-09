// Disclosure pass: what a project would give away about the person who made it, if it were published.
// Reads only what would be published: files git tracks, files git would add (untracked, not ignored), the commits on
// every branch (their emails and messages), every file version in the history, and the newest zip in each folder
// (zips inside it too). A folder with no git is read through its .gitignore all the same.
// Looks for: private details (a list the person fills in, plus this PC's user name, PC name, home folder, git name and
// email, projects folder), the names of their other projects, an AI or prompt trail, and local paths.
// A finding names a LABEL ("your git email") and a place, never the value itself: the report can be pasted into an AI.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { gitConfigRisky } = require('./gitstate');
const { fingerprint: fp } = require('./judged');

// Never what a person writes: third-party code and tool caches.
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'bower_components', '__pycache__', '.venv', 'venv']);
// Pictures, sound, fonts and programs: no one writes a detail into them by hand, so they are passed over quietly.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|mp[34]|m4a|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|class|jar|pyc|wasm)$/i;
// Files that can hold text the pass cannot read yet: skipped, and every skip is named in a note.
const UNREAD_EXT = /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|rtf|sqlite3?|db|7z|rar|gz|tgz|bz2|xz|tar)$/i;
// Office files are zips of XML: their text is read like a zip's.
const OFFICE_EXT = /\.(docx|xlsx|pptx|odt|ods|odp)$/i;
const MAX_FILES = 8000;
const MAX_TEXT = 2 * 1024 * 1024;       // one zip entry or past file version read as text
const MAX_FILE = 16 * 1024 * 1024;      // one file on disk read as text (a minified bundle can be several MB)
const MAX_ZIP = 200 * 1024 * 1024;      // one zip on disk
const MAX_HISTORY = 300 * 1024 * 1024;  // all past file versions together
const UNPACK_BUDGET = 300 * 1024 * 1024; // everything unpacked from zips in one pass (a 96 KB zip can unpack to 8 GB)
const MAX_ENTRIES = 20000;               // zip entries looked at in one pass
const ZIP_DEPTH = 3;
const SLICE = 4000, OVERLAP = 400;       // a very long line (minified code) is read in overlapping slices

// ---------- the private details ----------

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '(?:\\\\\\\\|\\\\|/)+'; // \  \\  or  /  (a path written in code, JSON or a URL)
// The text to look for, as a pattern: a path matches with any slash, a phone number with any spacing.
function valuePattern(value) {
  const v = String(value || '').trim();
  const digits = v.replace(/\D/g, '');
  if (/^[+\d\s().-]+$/.test(v) && digits.length >= 6) return (v.startsWith('+') ? '\\+?' : '') + digits.split('').join('[\\s().-]*');
  return v.split(/[\\/]+/).map(part => part.split(/\s+/).map(esc).join('\\s+')).join(SEP);
}
const bounded = src => '(?<![A-Za-z0-9])(?:' + src + ')(?![A-Za-z0-9])';
// Only written against a path separator or an @ on one side: \<name>, /<name>, @<name>, <name>@, <name>\.
const nearPath = src => '(?:(?<=[\\\\/@])(?:' + src + ')(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:' + src + ')(?=[\\\\/@]))';

function gitGlobal(key) {
  try { return execFileSync('git', ['config', '--global', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); } catch { return ''; }
}

// Read from this PC each time, never stored. workingFolders: the folders that hold the projects.
function autoDetails(workingFolders = []) {
  const out = [];
  const add = (label, value, extra) => { if (value && String(value).length >= 4) out.push({ label, value: String(value), auto: true, ...extra }); };
  const home = os.homedir();
  // A short name is often a word or a brand as well ("Dell's support page", Italian "dell'"): it only counts written
  // against a path or an @ (C:/Users/<name>, <name>@host); the home folder above catches the usual place.
  const short = v => String(v || '').length < 6 ? { near: true } : {};
  add('your user name on this PC', os.userInfo().username, short(os.userInfo().username));
  add('this PC\'s name', os.hostname(), short(os.hostname()));
  add('your home folder', home);
  if (/^[A-Za-z]:\\/.test(home)) add('your home folder', '/' + home[0].toLowerCase() + home.slice(2).replace(/\\/g, '/')); // as Git Bash writes it
  // Your git name is also the copyright holder of what you publish, and often your public code host account: allowed
  // on a copyright line and inside a link (github.com/<name>/<repo> is the address you publish at), nowhere else.
  add('your git name', gitGlobal('user.name'), { allowOn: /\bcopyright\b|\(c\)|©/i, allowInLink: true });
  add('your git email', gitGlobal('user.email'));
  for (const w of workingFolders) {
    add('your projects folder', w);
    add('your projects folder\'s name', path.basename(w));
  }
  return out;
}

// The person's own list, in the Bridge's ignored data folder: [{ id, label, value }].
function readPrivateList(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(j.details) ? j.details : []).filter(d => d && typeof d.label === 'string' && typeof d.value === 'string' && d.value.trim());
  } catch { return []; }
}
// rows: [{ id?, label, value? }]. A row with an id and no new value keeps the value already saved.
function savePrivateList(file, rows) {
  const old = new Map(readPrivateList(file).map(d => [d.id, d]));
  const details = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const label = String((r && r.label) || '').trim().slice(0, 80);
    const fresh = typeof (r && r.value) === 'string' ? r.value.trim() : '';
    const value = fresh || (old.get(r && r.id) || {}).value || '';
    if (!label && !value) continue;
    if (!label) return { ok: false, error: 'Give every detail a label (it is what the audit prints instead of the detail itself).' };
    if (value.length < 3) return { ok: false, error: '"' + label + '" is too short to look for: at least 3 characters, or every file would match.' };
    details.push({ id: (r && old.has(r.id) && r.id) || crypto.randomBytes(6).toString('hex'), label, value: value.slice(0, 300) });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ note: 'Private details the audit looks for. Kept on this PC only; the audit prints the labels, never these values.', details }, null, 2));
  return { ok: true, details };
}
// What the page may see: labels and lengths, never the values.
const listForPage = file => readPrivateList(file).map(d => ({ id: d.id, label: d.label, length: d.value.length }));

// ---------- other projects' names ----------

// Single words that name ordinary things: a folder called "notes" or "media" is only counted when written as a
// path to it (../notes/), or every file that mentions notes would be flagged.
const ORDINARY = new Set(('about account admin analytics api app apps archive assets audit auth backend backup backups billing '
  + 'blog bot bridge build cache calendar chat client cloud code common config content core dashboard data demo design desktop '
  + 'dev docs editor email examples files folder frontend game games help helper home hub ideas images import inbox key lib '
  + 'library live main map maps media mirror misc mobile new news notes old open operations ops pages personal planner '
  + 'playground portal pricing private project projects public reports router sample sandbox scratch scripts search server '
  + 'service services settings share shop site src start static storage store strategy temp test tests theme tmp token tools '
  + 'tracker usage utils web website work').split(' '));
const ordinary = w => ORDINARY.has(w.toLowerCase()) || w.length < 4 || /^v?\d+(\.\d+)*$/i.test(w);
const words = n => String(n).split(/[^A-Za-z0-9]+/).filter(Boolean);
const squash = n => words(n).join('').toLowerCase();

// One pattern per other project. own: this project's folder and display names (never flagged, nor any name that
// contains one of them or sits inside one).
function projectNamePatterns(others, own) {
  const mine = own.map(squash).filter(Boolean);
  const seen = new Set(), out = [];
  for (const name of others) {
    const ws = words(name), sq = squash(name);
    if (!ws.length || seen.has(sq) || mine.some(m => m.includes(sq) || sq.includes(m))) continue;
    seen.add(sq);
    const asPath = '\\.\\.' + SEP + esc(name).replace(/\s+/g, '\\s+'); // ../garden  ..\garden shed - v2
    let src;
    if (!ws.every(ordinary)) src = ws.map(esc).join('[\\s_.-]*');      // red kite, red-kite, RedKite
    else if (!/\s/.test(name) && ws.length > 1) src = esc(name);         // map-store exactly as the folder is named
    src = src ? src + '|' + asPath : asPath;
    out.push(bounded(src));
  }
  return out;
}
// A name inside a link is a public address, not a private mention.
const LINKS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)`]+|\bwww\.[^\s"'<>)`]+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|dev|app|au|co|uk|nz|ai|me|info|biz|xyz|site|online|store|tech)(?:\.[a-z]{2})?\b(?:\/[^\s"'<>)`]*)?/gi;
const withoutLinks = l => l.replace(LINKS, m => ' '.repeat(m.length));

// ---------- AI and prompt trail ----------

// Files an AI tool reads or writes, and working notes from building with one.
const TRAIL_FILE = /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)\.(cursorrules|windsurfrules|clinerules)$|(^|\/)copilot-instructions\.md$|(^|\/)\.aider[^/]*$|(^|\/)HANDOFF[^/]*\.md$|(^|\/)TOKEN-(LOG|USAGE)\.md$|(^|\/)(PROMPTS?|REVERT)([-_ .][^/]*)?\.(md|txt)$/i;
const TRAIL_DIR = /(^|\/)(\.claude|\.cursor|\.codex|\.aider|\.windsurf)\//i;
// Lines that show the AI or the chat behind the code. Written so this file's own patterns do not match themselves.
const TRAIL_LINES = [
  /co-authored-by:\s*(claude|chatgpt|copilot|codex|gemini|cursor)\b|noreply@anthropic\.com/i,
  /generated with \[?(claude|chatgpt|codex|cursor|copilot|gemini)/i,
  /\bclaude\.ai\/(chat|code|share|project)\/|\bchatgpt\.com\/(c|share|g)\/|\bchat\.openai\.com\/(c|share)\//i,
  /\b(thread|session) (?=\d*[a-f])[0-9a-f]{8}\b/i, // an id has a letter in it; "thread 12345678" is a number
  /\bHANDOFF-\d{4}-\d\d-\d\d/,
  /\bas an ai (language model|assistant)\b|\bdear (ai|claude|chatgpt)\b/i,
  // a person quoted by date: the word owner or client, a comma or bracket, a day, a month name, a year, a colon
  /\b(owner|client|customer|boss)\s*[,(]?\s*\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+20\d\d\b\s*\)?\s*:?/i,
  // on-screen copy that says an AI wrote it ("written by ...", "made with ...")
  /\b(written|generated|created|drafted|authored|made|built)\s+(by|with|using)\s+(claude|chatgpt|gpt-?\d\w*|openai|gemini|copilot|an ai\b)/i,
  // a handover marker naming the note to start from
  /\bSTART HERE:?\s+[\w ./\\:-]*\.(md|txt)\b/,
];
// The same trail in a person's voice (wording or a decision credited to a named person, a rule credited to them), counted only
// inside a comment: in prose, a story or a help page, those phrases are ordinary text.
const TRAIL_COMMENT = [
  /\b(his|her) (own )?(words|idea|decision|request|instruction|wording|rule|call|preference)s?\b|\bthe owner (said|asked|wants|wanted|wrote|told|decided|reckons|on)\b/i,
  /\bowner['’]s (rule|floor|decision|call|wording|preference|request|instruction)\b|\bper (his|her|the owner['’]s) (rule|call|decision|request|instruction|wording)\b|\b(his|her) stated preference\b/i,
];
// The comment parts of a line (// ..., /* ... */, # ..., * ..., <!-- ... -->), or '' when it has none.
function commentOf(l) {
  const out = [];
  // a doc-comment star is followed by a space ("**bold**" starting a Markdown line is not a comment)
  const lead = /^\s*(#(?![!\[{])|\*(?=\s|\/|$)|--\s|;|rem\s)(.*)$/i.exec(l);
  if (lead) out.push(lead[2]);
  for (const m of l.matchAll(/\/\*([\s\S]*?)(\*\/|$)|<!--([\s\S]*?)(-->|$)/g)) out.push(m[1] || m[3] || '');
  const sl = /(?<![:\/\\"'`])\/\/(.*)$/.exec(l);
  if (sl) out.push(sl[1]);
  return out.join(' ');
}

// ---------- local paths ----------

// Placeholders and made-up example users in install guides, docs and games: /home/youraccount/, /home/YOUR-USERNAME/,
// /home/jsmith/, /home/operator/ (a game's player).
const NOT_A_NAME = /^(\.\.\.|…|.{1,2}|public|default|default user|all users|demo|you|your.*|.*user_?name.*|user|name|me|someone|example\w*|runner|admin|root|guest|player|operator|learner|student|tester|test_?user|jsmith|jdoe|john_?doe|jane_?doe|foo|bar|<.*|\{.*|%.*|\$.*|\[.*)$/i;
const WIN_HOME = /\b[A-Za-z]:(?:\\\\|\\|\/)+(?:Users|Documents and Settings)(?:\\\\|\\|\/)+([^\\/\s"'<>`*?|:]+)/gi;
const NIX_HOME = /(?<![\w.:/-])\/(?:Users|home)\/([A-Za-z_][\w.-]*)\//g;
const ROUTE = /(href|src|action|to|path|route)\s*[=:]\s*["'`]\/home\//i;
function localPathIn(line, me) {
  for (const re of [WIN_HOME, NIX_HOME]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const who = m[1].replace(/[.,;)\]]+$/, '');
      if (re === NIX_HOME && ROUTE.test(line)) continue;
      if (!who || NOT_A_NAME.test(who) || who.toLowerCase() === me) continue; // your own is reported as "your home folder"
      return true;
    }
  }
  return false;
}

// ---------- the matcher ----------

// ctx: { details: [{label, value, allowOn?}], others: [names], own: [names] }
function makeMatcher(ctx) {
  const details = (ctx.details || []).filter(d => d.value && String(d.value).trim().length >= 3)
    .map(d => ({ label: d.label, allowOn: d.allowOn, allowInLink: d.allowInLink,
      re: new RegExp(d.near ? nearPath(valuePattern(d.value)) : bounded(valuePattern(d.value)), 'i') }));
  const anyDetail = details.length ? new RegExp(details.map(d => d.re.source).join('|'), 'i') : null;
  const detailIn = (d, l) => d.re.test(d.allowInLink ? withoutLinks(l) : l) && !(d.allowOn && d.allowOn.test(l));
  const names = projectNamePatterns(ctx.others || [], ctx.own || []);
  const anyName = names.length ? new RegExp(names.join('|'), 'i') : null;
  const me = os.userInfo().username.toLowerCase();
  // Every hit in one text: [{ rule, labels:Set, line, fp }], one per rule (the first line), with a count of lines.
  function scan(text) {
    const hits = new Map();
    const hit = (rule, line, i, label) => {
      let h = hits.get(rule);
      if (!h) hits.set(rule, h = { rule, labels: new Set(), line: i + 1, lines: 0, fp: fp(line), more: [] });
      if (label) h.labels.add(label);
      // the next few lines with the same kind of hit are named too: fixing the first must not hide the rest
      if (h.last !== i + 1) {
        h.last = i + 1;
        h.lines++;
        if (h.lines > 1 && h.more.length < 4) h.more.push(i + 1);
      }
    };
    const quickDetail = anyDetail && anyDetail.test(text);
    const quickName = anyName && anyName.test(text);
    const quickPath = /Users|Documents and Settings|\/home\//i.test(text);
    const encoded = ENCODED.test(text);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const whole = lines[i];
      // A minified bundle is one line of megabytes: read in overlapping slices, so a detail in it is still found and
      // the fingerprint stays short. Each kind of hit counts once per line.
      const parts = whole.length > SLICE + OVERLAP ? slices(whole) : [whole];
      const got = new Set();
      const once = (rule, l, label) => { if (rule !== 'DISC-001' && got.has(rule)) return; got.add(rule); hit(rule, l, i, label); };
      for (const l of parts) {
        if (quickDetail || encoded) {
          // %40, &#64;, \u0040 written for @ (and the like) still name the detail.
          const plain = encoded && ENCODED.test(l) ? decodeEscapes(l) : null;
          for (const d of details) if (detailIn(d, l) || (plain && detailIn(d, plain))) once('DISC-001', l, d.label);
        }
        if (quickName && anyName.test(withoutLinks(l))) once('DISC-002', l);
        if (TRAIL_LINES.some(re => re.test(l))) once('DISC-003', l);
        else if (TRAIL_COMMENT.some(re => re.test(l))) { const c = commentOf(l); if (c && TRAIL_COMMENT.some(re => re.test(c))) once('DISC-003', l); }
        if (quickPath && localPathIn(l, me)) once('DISC-004', l);
      }
    }
    return [...hits.values()];
  }
  // The same text with every private detail replaced by its label: file names, zip entries and notes are printed, and
  // a detail in a name (an email as a file name) must not reach the report.
  const global = details.map(d => ({ label: d.label, re: new RegExp(d.re.source, 'gi') }));
  scan.redact = t => global.reduce((acc, d) => acc.replace(d.re, '[' + d.label + ']'), String(t));
  // A file or folder name, matched as one line: [{ rule, labels }] for private details and other projects' names.
  scan.inName = rel => scan(String(rel).replace(/[\\/]+/g, ' / ')).filter(h => h.rule === 'DISC-001' || h.rule === 'DISC-002');
  return scan;
}
const slices = l => { const out = []; for (let p = 0; p < l.length; p += SLICE) out.push(l.slice(Math.max(0, p - OVERLAP), p + SLICE)); return out; };
const ENCODED = /%[0-9a-f]{2}|&#x?[0-9a-f]+;|&(?:commat|period|lowbar|amp);|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i;
const NAMED = { commat: '@', period: '.', lowbar: '_', amp: '&' };
function decodeEscapes(l) {
  return l.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d % 0x110000))
    .replace(/&(commat|period|lowbar|amp);/gi, (m, n) => NAMED[n.toLowerCase()])
    .replace(/\\u([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const RULE = {
  'DISC-001': { sev: 'High', title: 'Private detail', fix: 'Take it out of the file before you publish or share it. If it is already public, decide whether it needs changing (an email can be swapped for a contact form or a noreply address).' },
  'DISC-002': { sev: 'Medium', title: 'The name of another of your projects', fix: 'Take it out unless you mean to make the link public: one project should not show what else you are working on.' },
  'DISC-003': { sev: 'Medium', title: 'AI or prompt trail (chat notes, thread ids, AI tool settings or sign-offs, a person quoted by date or rule)', fix: 'Remove the line, or keep the file out of what you publish (add it to .gitignore).' },
  'DISC-004': { sev: 'Medium', title: 'A local folder path (C:\\Users\\<name>\\…, /home/<name>/…)', fix: 'Use a relative path, or one that does not name a user.' },
};
const labelsText = h => h.labels.size ? ': ' + [...h.labels].join(', ') : '';

// ---------- what would be published ----------

function git(dir, args, opts = {}) {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.quotePath=false', ...(dir ? ['-C', dir] : []), ...args], {
      timeout: opts.timeout || 60000, windowsHide: true, maxBuffer: opts.maxBuffer || 64 * 1024 * 1024, encoding: opts.encoding || 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => resolve({ ok: !err, out: stdout || '', err: String(stderr || (err && err.message) || ''), missing: !!(err && err.code === 'ENOENT') }));
  });
}
const lines0 = s => String(s).split('\0').filter(Boolean);

// An empty repository of our own, used to ask git which files of a non-git folder its .gitignore leaves in.
let scratchGit = null;
async function scratchGitDir() {
  if (scratchGit && fs.existsSync(scratchGit)) return scratchGit;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-disclosure-'));
  const r = await git(null, ['init', '--bare', '-q', d]);
  scratchGit = r.ok ? d : null;
  process.once('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
  return scratchGit;
}

// [{ rel, untracked }], or null when git cannot say (then every file is read). A git repository inside the folder
// (git lists it as "name/" and does not go in) is listed through its own git: nested = its folder names.
async function publishedFiles(dir, isRepo, nested = [], depth = 0) {
  let list;
  if (isRepo) {
    const t = await git(dir, ['ls-files', '-z']);
    const u = await git(dir, ['ls-files', '-z', '--others', '--exclude-standard']);
    if (!t.ok || !u.ok) return null;
    list = [...lines0(t.out).map(rel => ({ rel })), ...lines0(u.out).map(rel => ({ rel, untracked: true }))];
  } else {
    const g = await scratchGitDir();
    if (!g) return null;
    const r = await git(null, ['--git-dir=' + g, '--work-tree=' + dir, 'ls-files', '-z', '--others', '--exclude-standard']);
    if (!r.ok) return null;
    list = lines0(r.out).map(rel => ({ rel, noGit: true }));
  }
  const out = [];
  for (const f of list) {
    if (!f.rel.endsWith('/')) { out.push(f); continue; }
    const sub = path.join(dir, f.rel);
    if (depth >= 3 || !fs.existsSync(path.join(sub, '.git')) || gitConfigRisky(sub)) continue;
    nested.push(f.rel);
    const inner = await publishedFiles(sub, true, [], depth + 1);
    for (const x of inner || []) out.push({ ...x, rel: f.rel + x.rel });
  }
  return out;
}
function walkAll(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= MAX_FILES || depth > 14) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
      else if (e.isFile()) out.push({ rel: path.relative(dir, p).replace(/\\/g, '/') });
    }
  };
  walk(dir, 0);
  return out;
}
const skipped = (rel, skip) => rel.split('/').slice(0, -1).some(s => SKIP_DIRS.has(s)) || skip.some(s => rel.toLowerCase() === s || rel.toLowerCase().startsWith(s + '/'));
const looksBinary = buf => buf.subarray(0, 8000).includes(0);
// A file's text, whatever it was saved as: UTF-8 (with or without a BOM), or UTF-16 (with a BOM, or plain ASCII text
// saved by Windows tools with a zero after every letter). null when it is not text.
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16(); return b.toString('utf16le'); }
  if (!looksBinary(buf)) return buf.toString('utf8');
  // UTF-16 with no BOM: most odd (or even) bytes zero, the others not.
  const n = Math.min(buf.length, 8000) & ~1;
  let oddZero = 0, evenZero = 0;
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) evenZero++; if (buf[i + 1] === 0) oddZero++; }
  if (n >= 8 && oddZero > n * 0.4 && evenZero < n * 0.05) return buf.toString('utf16le');
  if (n >= 8 && evenZero > n * 0.4 && oddZero < n * 0.05) { const b = Buffer.from(buf.subarray(0, buf.length & ~1)); b.swap16(); return b.toString('utf16le'); }
  return null;
}
// An Office file's XML as plain lines: a paragraph or row is one line, the markup between words is dropped.
const officeText = xml => xml.replace(/<\/(w:p|a:p|text:p|row|si)>/g, '\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// The newest zip in each folder (a release folder keeps a series; the newest is the one being shared).
function releaseZips(dir, skip) {
  const byFolder = new Map();
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !skipped(rel + '/x', skip)) walk(p, depth + 1); continue; }
      if (!e.isFile() || !/\.zip$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      const prev = byFolder.get(d);
      if (!prev || st.mtimeMs > prev.mtime) byFolder.set(d, { rel, mtime: st.mtimeMs, size: st.size, older: prev ? prev.older + 1 : 0, olderList: prev ? [...prev.olderList, { rel: prev.rel, size: prev.size }] : [] });
      else { prev.older++; prev.olderList.push({ rel, size: st.size }); }
    }
  };
  walk(dir, 0);
  return [...byFolder.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 10);
}

// ---------- zips (no packages: stored and deflated entries, zip64 sizes) ----------

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  let count = buf.readUInt16LE(eocd + 10), cd = buf.readUInt32LE(eocd + 16);
  if ((cd === 0xffffffff || count === 0xffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(eocd - 12));
    if (buf.readUInt32LE(z) === 0x06064b50) { count = Number(buf.readBigUInt64LE(z + 32)); cd = Number(buf.readBigUInt64LE(z + 48)); }
  }
  const out = [];
  let p = cd;
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24), off = buf.readUInt32LE(p + 42);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl);
    for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) { // zip64 extra: the real sizes and offset
      const id = buf.readUInt16LE(x), len = buf.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (off === 0xffffffff) off = Number(buf.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    // cap: the most this entry may unpack to (the pass's budget left); a declared size is never trusted past it.
    out.push({ name, size, encrypted: !!(flags & 1), read: (cap = Infinity) => {
      if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad entry');
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) {
        try { return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(size, cap)) }); }
        catch (e) { throw new Error(/buffer|length|range/i.test(e.message) ? 'unpacks to more than it says, or more than the budget left' : e.message); }
      }
      throw new Error('compression method ' + method);
    } });
  }
  return out;
}

// ---------- the pass ----------

// ctx: { details, others, own, skip }. Returns { findings, notes, read: { files, zips, commits, versions } }.
async function disclosurePass(dir, ctx = {}) {
  const scan = makeMatcher(ctx);
  const skip = (ctx.skip || []).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  const findings = [], notes = [];
  const read = { files: 0, zips: 0, commits: 0, versions: 0 };
  const seen = new Set(); // rule|file|line fingerprint: the same line in history and in the file is reported once
  const report = (h, where, place) => {
    const k = h.rule + '|' + where.replace(/:\d+$/, '').replace(/^git history: /, '') + '|' + h.fp;
    if (seen.has(k)) return;
    seen.add(k);
    const r = RULE[h.rule];
    const more = (h.more || []).map(n => where.replace(/:\d+$/, '') + ':' + n);
    findings.push({ rule: h.rule, sev: r.sev, area: 'disclosure', title: r.title + labelsText(h) + (h.lines > 1 ? ' (' + h.lines + ' lines)' : '') + (place ? ' — ' + place : ''), where, fix: r.fix, fp: h.fp, ...(more.length ? { also: more } : {}) });
  };
  const trailFiles = new Map(); // AI tool folder, or the folder holding working-notes files -> { files:Set, place }
  const trailFile = (rel, place) => {
    const d = TRAIL_DIR.exec(rel);
    if (!d && !TRAIL_FILE.test(rel)) return false;
    const key = d ? rel.slice(0, d.index + d[0].length) : 'notes|' + rel.replace(/[^/]*$/, '');
    const t = trailFiles.get(key);
    if (t) { t.files.add(rel); return t; }
    const n = { files: new Set([rel]), place, dir: !!d, sev: 'Medium', holds: new Set() };
    trailFiles.set(key, n);
    return n;
  };
  // A file that is itself a trail (a handover, CLAUDE.md) is reported once, as a file: the fix is to keep the file out,
  // which takes every line in it along. What its lines hold is named in that one finding, and a private detail in
  // any of them raises it to High.
  const fold = (trail, h) => {
    if (h.rule === 'DISC-001') { h.labels.forEach(l => trail.holds.add(l)); trail.sev = 'High'; }
    else if (h.rule === 'DISC-002') trail.holds.add('names of your other projects');
    else if (h.rule === 'DISC-004') trail.holds.add('local folder paths');
  };
  const zipNames = new Set(); // zip file names the project's own files mention (links to downloads, update feeds)
  const scanText = (buf, where, place, trail, office) => {
    let text = decodeText(buf);
    if (text == null) return;
    if (office) text = officeText(text);
    if (text.length < MAX_TEXT && /\.zip\b/i.test(text)) for (const m of text.matchAll(/[\w.+-]+\.zip\b/gi)) zipNames.add(m[0].toLowerCase());
    for (const h of scan(text)) if (trail) fold(trail, h); else report(h, where + ':' + h.line, place);
  };
  // Every file that could hold text and was not read is named, by kind, in one note each.
  const unread = new Map(); // why -> { n, first }
  const skippedFile = (rel, why) => { const u = unread.get(why); if (u) u.n++; else unread.set(why, { n: 1, first: rel }); };
  const kindOf = rel => { const m = /\.([^./]+)$/.exec(rel); return m ? m[1].toLowerCase() : 'file'; };
  // A private detail or another project's name in a file or folder name: one finding per name, at the shortest path
  // that carries it (a copied folder named after another project is one finding, not one per file inside it).
  const names = new Map(); // rule|prefix -> { rule, labels, prefix, files, place }
  const nameCheck = (rel, place) => {
    const parts = String(rel).split(/ > |\//);
    for (let i = 0; i < parts.length; i++) {
      const hs = scan.inName(parts[i]);
      if (!hs.length) continue;
      const sep = String(rel).match(/ > |\//g) || [];
      let prefix = parts[0];
      for (let k = 1; k <= i; k++) prefix += sep[k - 1] + parts[k];
      for (const h of hs) {
        const key = h.rule + '|' + prefix.toLowerCase();
        const x = names.get(key);
        if (x) { x.files++; h.labels.forEach(l => x.labels.add(l)); continue; }
        names.set(key, { rule: h.rule, labels: new Set(h.labels), prefix, files: 1, place, folder: i < parts.length - 1 });
      }
      return;
    }
  };
  // Unpacking zips has one budget per pass (bytes and entries), and the Bridge keeps answering while it runs.
  const budget = { bytes: 0, entries: 0, hit: false };
  const overBudget = (where, size) => {
    if (!budget.hit && budget.entries < MAX_ENTRIES && budget.bytes + size <= UNPACK_BUDGET) return false;
    if (!budget.hit) notes.push('Zips were read up to ' + (UNPACK_BUDGET >> 20) + ' MB unpacked / ' + MAX_ENTRIES + ' entries; the rest (from ' + where + ') was not read. A zip that unpacks to far more than its size can be a "zip bomb".');
    budget.hit = true;
    return true;
  };

  const isRepo = fs.existsSync(path.join(dir, '.git'));
  const risky = isRepo && gitConfigRisky(dir);
  if (risky) notes.push('Git history, commit emails and the list of ignored files were not read: this folder\'s git settings could run a program. Every file in the folder was read instead.');

  // 1. Files that would be published (tracked, or untracked and not ignored).
  const nested = [];
  let files = risky ? null : await publishedFiles(dir, isRepo, nested);
  const readNested = nested.filter(n => !skipped(n.replace(/\/+$/, '') + '/x', skip)); // a folder left out was not read
  nested.length = 0; nested.push(...readNested);
  if (nested.length) notes.push('Git repositories inside this folder (' + nested.slice(0, 5).join(', ') + (nested.length > 5 ? '…' : '') + '): their files were read, but not their history or commit emails. Add each one as its own project to read those.');
  if (!files) { if (!risky) notes.push('Git could not list what would be published, so every file in the folder was read (ignored files included).'); files = walkAll(dir); }
  files = files.filter(f => !skipped(f.rel, skip));
  if (files.length > MAX_FILES) { notes.push('Only the first ' + MAX_FILES + ' of ' + files.length + ' files were read.'); files = files.slice(0, MAX_FILES); }
  const zipsInList = new Set();
  const officeFiles = [];
  for (const f of files) {
    const place = f.untracked ? 'in a file not in git yet (git add would publish it)' : '';
    const trail = trailFile(f.rel, place);
    nameCheck(f.rel, place);
    if (/\.zip$/i.test(f.rel)) { zipsInList.add(f.rel); continue; }
    if (OFFICE_EXT.test(f.rel)) { officeFiles.push({ rel: f.rel, place }); continue; }
    if (UNREAD_EXT.test(f.rel)) { skippedFile(f.rel, kindOf(f.rel) + ' files (the pass cannot read inside them)'); continue; }
    if (BINARY_EXT.test(f.rel)) continue;
    let buf; try {
      const st = fs.statSync(path.join(dir, f.rel));
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) { skippedFile(f.rel, 'files over ' + (MAX_FILE >> 20) + ' MB'); continue; }
      buf = fs.readFileSync(path.join(dir, f.rel));
    } catch { continue; }
    read.files++;
    scanText(buf, f.rel, place, trail);
    if (read.files % 200 === 0) await new Promise(setImmediate); // let the Bridge answer meanwhile
  }

  // 2. Release zips, and the zips inside them.
  const zips = releaseZips(dir, skip);
  // An older zip that a page or a feed names (a download link, an update list) is still handed out: read it too.
  const linked = [];
  for (const z of zips) for (const o of z.olderList || []) if (zipNames.has(path.posix.basename(o.rel).toLowerCase())) linked.push({ rel: o.rel, size: o.size, older: 0 });
  for (const rel of zipsInList) if (!zips.some(z => z.rel === rel)) { try { zips.push({ rel, size: fs.statSync(path.join(dir, rel)).size, older: 0 }); } catch {} }
  const older = zips.reduce((n, z) => n + z.older, 0) - linked.length;
  zips.push(...linked.filter(l => !zips.some(z => z.rel === l.rel)));
  if (linked.length) notes.push(linked.length + ' older zip' + (linked.length > 1 ? 's were' : ' was') + ' read as well, because a file in the project links to ' + (linked.length > 1 ? 'them' : 'it') + ' (e.g. ' + linked[0].rel + ').');
  if (older > 0) notes.push(older + ' older zip' + (older > 1 ? 's' : '') + ' beside a newer one in the same folder were not read (the newest is taken as the one you share; one a page links to is read).');
  // office: an Word/Excel/PowerPoint file read as the zip it is (its XML text only, no file names reported).
  const openZip = async (buf, chain, depth, place = 'inside a zip', office = false) => {
    let entries; try { entries = readZip(buf); } catch (e) { notes.push(chain + ' could not be read as a zip (' + e.message + ').'); return; }
    for (const e of entries) {
      if (budget.hit) return;
      const where = chain + ' > ' + e.name;
      if (office && !/\.xml$/i.test(e.name)) continue;
      const trail = office ? null : trailFile(where, place);
      if (!office) nameCheck(where, place);
      if (e.encrypted) { notes.push(where + ' is password-protected and was not read.'); continue; }
      const nested = /\.zip$/i.test(e.name), isOffice = !office && OFFICE_EXT.test(e.name);
      if (!nested && !isOffice && UNREAD_EXT.test(e.name)) { skippedFile(where, kindOf(e.name) + ' files (the pass cannot read inside them)'); continue; }
      if (!nested && !isOffice && (BINARY_EXT.test(e.name))) continue;
      if (!nested && !isOffice && e.size > MAX_TEXT) { skippedFile(where, 'zip entries over ' + (MAX_TEXT >> 20) + ' MB'); continue; }
      if ((nested || isOffice) && (depth >= ZIP_DEPTH || e.size > MAX_ZIP)) { notes.push(where + ' was not opened (too deep or too big).'); continue; }
      budget.entries++;
      if (overBudget(where, e.size)) return;
      let data; try { data = e.read(UNPACK_BUDGET - budget.bytes); } catch (err) { notes.push(where + ' could not be read (' + err.message + ').'); continue; }
      budget.bytes += data.length;
      await new Promise(setImmediate); // inflating is synchronous: give the Bridge a turn between entries
      if (nested) await openZip(data, where, depth + 1, place);
      else if (isOffice) await openZip(data, where, depth + 1, place, true);
      else scanText(data, where, place, trail, office);
    }
  };
  for (const z of zips) {
    if (z.size > MAX_ZIP) { notes.push(z.rel + ' is over ' + (MAX_ZIP >> 20) + ' MB and was not read.'); continue; }
    let buf; try { buf = fs.readFileSync(path.join(dir, z.rel)); } catch { continue; }
    read.zips++;
    await openZip(buf, z.rel, 1);
  }
  for (const o of officeFiles) {
    let buf; try { const st = fs.statSync(path.join(dir, o.rel)); if (st.size > MAX_ZIP) { skippedFile(o.rel, 'files over ' + (MAX_ZIP >> 20) + ' MB'); continue; } buf = fs.readFileSync(path.join(dir, o.rel)); } catch { continue; }
    read.files++;
    await openZip(buf, o.rel, 1, o.place, true);
  }

  // 3. Git: commit emails on every branch, commit messages, and every past version of every file.
  if (isRepo && !risky) await historyPass(dir, ctx, scan, { findings, notes, read, report, trailFile, fold, skip, nameCheck, openZip, budget });

  for (const [why, u] of unread) notes.push(u.n + ' ' + why + ' were not read' + (u.n > 1 ? ', e.g. ' : ': ') + u.first + '.');
  for (const x of names.values()) {
    const r = RULE[x.rule];
    findings.push({ rule: x.rule, sev: r.sev, area: 'disclosure', fix: r.fix + ' Rename the ' + (x.folder ? 'folder' : 'file') + ' (or keep it out of what you publish).', fp: fp('name|' + x.prefix.toLowerCase()), where: x.prefix + (x.folder ? '/' : ''),
      title: r.title + (x.labels.size ? ': ' + [...x.labels].join(', ') : '') + ' — in a ' + (x.folder ? 'folder' : 'file') + ' name' + (x.files > 1 ? ' (' + x.files + ' files)' : '') + (x.place ? ' — ' + x.place : '') });
  }

  for (const [key, t] of trailFiles) {
    const n = t.files.size, first = [...t.files][0];
    const where = t.dir ? key : n > 1 ? (key.slice(6) ? key.slice(6) + ' ' : '') + '(' + n + ' files, e.g. ' + first.slice(key.length - 6) + ')' : first;
    const holds = [...t.holds].sort();
    // The fingerprint carries what the files hold, so a set-aside folder comes back when a new kind of detail lands in it.
    findings.push({ rule: 'DISC-003', sev: t.sev, area: 'disclosure', fix: RULE['DISC-003'].fix, fp: fp(key + '|' + holds.join('|')), where: where || first,
      title: (t.dir ? 'AI tool folder (' + n + ' file' + (n > 1 ? 's' : '') + ')' : n > 1 ? n + ' AI or working-notes files' : 'AI or working-notes file') + (t.place ? ' — ' + t.place : '')
        + (holds.length ? '; ' + (n > 1 ? 'they also hold' : 'it also holds') + ': ' + holds.join(', ') : '') });
  }
  // Nothing printed may carry a private detail or the project's full folder path: file names, zip entries, branch
  // names and git's own messages pass through here last.
  const hideDir = t => [dir, dir.replace(/\\/g, '/')].reduce((acc, d) => acc.split(d).join('<project folder>'), String(t));
  const clean = t => scan.redact(hideDir(t));
  for (const x of findings) { x.where = clean(x.where); x.title = clean(x.title); if (x.also) x.also = x.also.map(clean); }
  return { findings: mergePlaces(findings).map(reachOf), notes: notes.map(clean), read };
}

// Ships or repo only (scanner training T7): another project's name, an AI trail or a local path in what visitors are
// served (a page, a script, a release zip) stays Medium; in a file that only lives in the repository (notes, tests,
// tools, docs) it is Low; in the git history or commit messages only it is Info (it can only go by rewriting history).
// A private detail (DISC-001) and a commit email (DISC-005) keep their severity wherever they are.
const REPO_ONLY = /(^|\/)(tests?|spec|__tests__|fixtures?|docs?|notes?|tools|scripts|bin|handoffs?|memory|\.github|\.claude|\.cursor|\.codex)(\/|$)|\.(md|markdown|txt|log|csv)$|(^|\/)(HANDOFF|README|CHANGELOG|TODO|NOTES?)[^/]*$/i;
// code and pages; data files (.json, .xml) only inside a web folder (a register or a settings file elsewhere is not served)
const SERVED = /\.(html?|php|m?js|cjs|jsx|tsx?|css|vue|svelte|svg|webmanifest)$|(^|\/)(public|public_html|www|htdocs|web|dist|build|static|assets)\/.*\.(json|xml|txt)$/i;
function reachOf(f) {
  if (f.sev !== 'Medium') return f; // DISC-001 and DISC-005 are always High; a trail file holding a detail is High too
  const w = String(f.where);
  let reach;
  if (/^git history: |^commit messages/.test(w)) reach = 'history';
  else if (/ > /.test(w)) reach = 'ships';
  else {
    const rel = w.replace(/:\d+$/, '').replace(/\s+\(\d+ files, e\.g\. .*\)$/, '');
    reach = !rel || REPO_ONLY.test(rel) || /\/$/.test(rel) && REPO_ONLY.test(rel + 'x') || !SERVED.test(rel) && !/\/$/.test(rel) ? 'repo' : 'ships';
  }
  if (reach === 'ships') return { ...f, reach };
  return { ...f, reach, sev: reach === 'history' ? 'Info' : 'Low', title: f.title + (reach === 'history' ? ' (in the git history only)' : ' (in the repository only, not in what visitors are served)') };
}

// The same line in several places (the file, its past versions, the zips that ship it) is one fault with one fix: it is
// reported once, at the working file when there is one, with the other places listed in `also`.
function mergePlaces(findings) {
  const rank = w => (/ > /.test(w) ? 2 : /^git history: /.test(w) ? 1 : 0);
  const base = w => w.replace(/:\d+$/, '').split(/ > |\//).pop().toLowerCase();
  const groups = new Map(), out = [];
  for (const f of findings) {
    if (!/:\d+$/.test(f.where)) { out.push(f); continue; } // a whole file, a folder, an email: already one per place
    const k = f.rule + '|' + f.fp + '|' + base(f.where);
    const g = groups.get(k);
    if (!g) { groups.set(k, f); out.push(f); continue; }
    const [keep, other] = rank(f.where) < rank(g.where) ? [f, g] : [g, f];
    if (keep !== g) { Object.assign(g, keep, { also: [...(g.also || []), other.where] }); continue; }
    g.also = [...(g.also || []), other.where];
  }
  return out;
}

const NOREPLY = /@users\.noreply\.github\.com$|^noreply@|@noreply\.|^no-reply@|@localhost$|^$/i;
async function historyPass(dir, ctx, scan, out) {
  const { findings, notes, read, report, trailFile, fold, skip, nameCheck, openZip, budget } = out;
  const refsR = await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  if (!refsR.ok) { notes.push('Git history was not read: ' + refsR.err.split('\n')[0].slice(0, 160)); return; }
  const allRefs = refsR.out.split('\n').filter(r => r && !/\/HEAD$/.test(r));
  if (!allRefs.length) return; // no commits yet
  const refs = allRefs.slice(0, 60);
  if (allRefs.length > refs.length) notes.push('Commit emails were checked on the first ' + refs.length + ' of ' + allRefs.length + ' branches and tags.');
  const short = r => r.replace(/^refs\/(heads|remotes|tags)\//, '');
  const remoteRef = r => r.startsWith('refs/remotes/');
  const hasRemote = allRefs.some(remoteRef);

  // Commit emails, per branch. An address is matched against the details to name it; otherwise it is "an email".
  const detailRes = (ctx.details || []).filter(d => d.value && d.value.length >= 3).map(d => ({ label: d.label, re: new RegExp('^(?:' + valuePattern(d.value) + ')$', 'i') }));
  const emails = new Map(); // email -> { refs:Set, remote:bool, commits:Set }
  for (const ref of refs) {
    const r = await git(dir, ['log', ref, '--format=%H%x09%ae%x09%ce']);
    for (const line of r.out.split('\n')) {
      const [h, ae, ce] = line.split('\t');
      if (!h) continue;
      for (const e of new Set([ae, ce])) {
        const k = String(e || '').trim().toLowerCase();
        if (NOREPLY.test(k)) continue;
        let x = emails.get(k);
        if (!x) emails.set(k, x = { refs: new Set(), remote: false, commits: new Set() });
        x.refs.add(short(ref)); x.commits.add(h);
        if (remoteRef(ref)) x.remote = true;
      }
    }
  }
  let unnamed = 0;
  for (const [email, x] of emails) {
    const named = detailRes.find(d => d.re.test(email));
    const label = named ? named.label : 'an email address that is not a noreply address (#' + (++unnamed) + ')';
    const b = [...x.refs];
    findings.push({ rule: 'DISC-005', sev: 'High', area: 'disclosure',
      title: 'Commit email: ' + label + ', on ' + x.commits.size + ' commit' + (x.commits.size > 1 ? 's' : '') + ' in ' + b.slice(0, 4).join(', ') + (b.length > 4 ? ' and ' + (b.length - 4) + ' more' : '')
        + ' — ' + (x.remote ? 'already on the remote' : hasRemote ? 'not pushed yet' : 'only on this PC (no remote)'),
      where: 'git history (commit author or committer)', fp: fp(email), // set aside one address, not every one
      fix: 'For new commits set a noreply address: git config user.email <id>+<name>@users.noreply.github.com. Commits made before keep the old one unless the history is rewritten (git filter-repo --mailmap) or the project starts a fresh repository. See the addresses with: git log --all --format="%ae %ce"' });
  }

  // What is already on a remote (as of this PC's last fetch or push).
  const onRemote = new Set(hasRemote ? (await git(dir, ['rev-list', '--remotes', '--objects'])).out.split('\n').map(l => l.slice(0, 40)) : []);
  const placeOf = hash => onRemote.has(hash) ? 'in git history, already on the remote' : 'in git history' + (hasRemote ? ', not pushed yet' : ', only on this PC');

  // Commit messages: one finding per rule, counting the commits (an AI sign-off can sit on hundreds).
  const msgs = await git(dir, ['log', '--all', '--format=%H%x1f%B%x1e']);
  const RS = String.fromCharCode(0x1e), US = String.fromCharCode(0x1f); // the separators asked for above
  const inMsgs = new Map(); // rule -> { labels:Set, commits, remote, first }
  for (const rec of msgs.out.split(RS)) {
    const [h, body] = rec.replace(/^\s+/, '').split(US);
    if (!h || !body) continue;
    read.commits++;
    for (const hit of scan(body)) {
      let m = inMsgs.get(hit.rule);
      if (!m) inMsgs.set(hit.rule, m = { labels: new Set(), commits: 0, remote: 0, first: h });
      hit.labels.forEach(l => m.labels.add(l));
      m.commits++;
      if (onRemote.has(h)) m.remote++;
    }
  }
  for (const [rule, m] of inMsgs) {
    const r = RULE[rule];
    findings.push({ rule, sev: r.sev, area: 'disclosure', fp: fp('commit messages'), where: 'commit messages (e.g. ' + m.first.slice(0, 8) + ')', fix: r.fix + ' A commit message already pushed changes only if the history is rewritten.',
      title: r.title + (m.labels.size ? ': ' + [...m.labels].join(', ') : '') + ' — in ' + m.commits + ' commit message' + (m.commits > 1 ? 's' : '') + (hasRemote ? ' (' + (m.remote || 'none') + ' already on the remote)' : ', only on this PC') });
  }

  // Every version of every file on any branch (the file may be gone now, but the history still holds it).
  const objs = (await git(dir, ['rev-list', '--all', '--objects'])).out.split('\n');
  const pathOf = new Map();
  for (const l of objs) { const sp = l.indexOf(' '); if (sp === 40) pathOf.set(l.slice(0, 40), l.slice(41)); }
  const candidates = [...pathOf.keys()].filter(hsh => { const rel = pathOf.get(hsh); return rel && !skipped(rel, skip) && !BINARY_EXT.test(rel); });
  const sizes = await batch(dir, ['cat-file', '--batch-check'], candidates.join('\n') + '\n');
  const blobs = [], zipBlobs = [];
  // zips as they are now in the folder are read from the folder; a version that is gone (deleted, replaced) only here
  const current = new Set((await git(dir, ['ls-files', '-s'])).out.split('\n').map(l => l.split(' ')[1]).filter(Boolean));
  let total = 0, overflow = 0;
  for (const l of sizes.toString('utf8').split('\n')) {
    const [hsh, type, size] = l.split(' ');
    if (type !== 'blob') continue; // trees have paths too
    const rel = pathOf.get(hsh);
    if (/\.zip$/i.test(rel)) {
      nameCheck('git history: ' + rel, placeOf(hsh));
      if (current.has(hsh)) continue;
      if (+size > MAX_ZIP) notes.push('A zip in the git history (' + rel + ') is over ' + (MAX_ZIP >> 20) + ' MB and was not opened.');
      else zipBlobs.push(hsh);
      continue;
    }
    trailFile(rel, placeOf(hsh));
    nameCheck('git history: ' + rel, placeOf(hsh));
    if (+size > MAX_TEXT) continue;
    if (total + +size > MAX_HISTORY) { overflow++; continue; }
    total += +size;
    blobs.push(hsh);
  }
  if (overflow) notes.push(overflow + ' past file versions were not read (the history is over ' + (MAX_HISTORY >> 20) + ' MB of text).');
  // Zips that only the history still holds: opened with the same unpacking budget as the folder's zips.
  for (const hsh of zipBlobs) {
    if (budget.hit) break;
    const raw = await batch(dir, ['cat-file', '--batch'], hsh + '\n');
    const nl = raw.indexOf(10);
    if (nl < 0) continue;
    const size = +raw.toString('utf8', 0, nl).split(' ')[2];
    read.zips++;
    await openZip(raw.subarray(nl + 1, nl + 1 + size), 'git history: ' + pathOf.get(hsh), 1, placeOf(hsh));
  }
  if (!blobs.length) return;
  const data = await batch(dir, ['cat-file', '--batch'], blobs.join('\n') + '\n');
  let p = 0;
  while (p < data.length) {
    const nl = data.indexOf(10, p);
    if (nl < 0) break;
    const [hsh, , size] = data.toString('utf8', p, nl).split(' ');
    const body = data.subarray(nl + 1, nl + 1 + +size);
    p = nl + 1 + +size + 1;
    read.versions++;
    const text = decodeText(body);
    if (text == null) continue;
    const rel = pathOf.get(hsh), trail = trailFile(rel, placeOf(hsh));
    // ctx.historyHook (lib/audit.js, SEC-012): the same past versions read for keys, so the history is read once.
    if (ctx.historyHook) ctx.historyHook(text, rel, placeOf(hsh), current.has(hsh));
    for (const hit of scan(text)) if (trail) fold(trail, hit); else report(hit, 'git history: ' + rel + ':' + hit.line, placeOf(hsh));
  }
}

// git with input on stdin; the whole output as one Buffer.
function batch(dir, args, input) {
  return new Promise(resolve => {
    const chunks = [];
    const c = spawn('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], { windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    c.stdout.on('data', d => chunks.push(d));
    c.on('error', () => resolve(Buffer.alloc(0)));
    c.on('close', () => resolve(Buffer.concat(chunks)));
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}

module.exports = { disclosurePass, publishedFiles, autoDetails, readPrivateList, savePrivateList, listForPage, makeMatcher, readZip, decodeText, projectNamePatterns, RULE };
