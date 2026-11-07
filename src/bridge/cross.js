// Cross-file rules (scanner training, phase T3): faults that only show when two files, or a file and a page, are
// read together. codeAudit (lib/audit.js) hands over every file it read; buildIndex reads them once (functions and
// their bodies, guards, limiters, table writes, storage keys, routes, privacy text) and each rule asks the index.
// Each rule has a should-fire and a must-stay-quiet project in test/cross.test.js and in the museum (cases-3).
// A rule here only ever reads the project: nothing is fetched, nothing is run.
'use strict';
const fs = require('fs');
const path = require('path');

// The same comment-line test as lib/audit.js: a commented-out line is not live code.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#(?![!\[])|<!--|;|--\s|rem\s)/i;
const PHP = /\.php$/i;
const JS = /\.(m?js|cjs|tsx?|jsx)$/i;
const MARKUP = /\.(html?|php|vue|svelte|astro|jsx|tsx|twig)$/i;
const SERVER_CODE = /\.(php|m?js|cjs|ts|py|sh|ps1)$/i;
// Files that run once by hand (installers, migrations, seeds, tools): not requests from visitors.
const ONE_OFF = /(^|\/)(cron|crons|tools|scripts|bin|install|installer|migrations?|setup|seeds?|database|db|schema)\/|(^|\/)(install|setup|migrate|seed|schema|upgrade|cron)[\w.-]*\.\w+$/i;
const ADMIN_PATH = /(^|\/)(admin|administrator|backend|dashboard|staff|manage|cp)\//i;

// ---- reading helpers ----
// The body of the block that opens on line i (or within the next 3 lines): braces counted, strings ignored roughly.
function blockFrom(lines, i, max = 300) {
  let depth = 0, started = false;
  const out = [];
  for (let k = i; k < Math.min(lines.length, i + max); k++) {
    const l = lines[k];
    out.push(l);
    for (const c of l.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')) {
      if (c === '{') { depth++; started = true; } else if (c === '}') depth--;
    }
    if (started && depth <= 0) break;
    if (!started && k >= i + 3) break;
  }
  return out.join('\n');
}
// Python: the indented lines under a def.
function pyBlock(lines, i) {
  const ind = /^\s*/.exec(lines[i])[0].length;
  const out = [lines[i]];
  for (let k = i + 1; k < Math.min(lines.length, i + 200); k++) {
    if (lines[k].trim() && /^\s*/.exec(lines[k])[0].length <= ind) break;
    out.push(lines[k]);
  }
  return out.join('\n');
}
const DEF = /\bfunction\s+&?([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:async\s+)?def\s+(\w+)\s*\(/;
const KEYWORDS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'function', 'return', 'array', 'list', 'isset', 'empty', 'echo', 'print', 'require', 'include', 'require_once', 'include_once', 'new', 'typeof', 'elseif', 'unset', 'exit', 'die', 'and', 'or', 'not', 'in', 'def', 'class']);
function callsIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?<![\w$>:.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!KEYWORDS.has(m[1].toLowerCase())) out.add(m[1]);
  return out;
}
const singular = t => String(t).toLowerCase().replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/s$/, '');
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Only the code of a line: quoted text blanked (a word inside a message is not a call).
const codeOf = l => String(l).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');

// A path a rule built from the project's own code: read only when it is inside the project ("../../" is not).
const inProject = (idx, p) => { if (!idx.dir) return true; const r = path.relative(idx.dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };

// ---- the index ----
function buildIndex(files, extra = {}) {
  const idx = { files, fns: new Map(), docs: extra.docs || [], dir: extra.dir, skip: extra.skip || new Set(), loads: extra.loads || [], blocked: extra.blocked || (() => false), all: extra.all || [] };
  // Function bodies kept for the checks, up to 40 MB in all: past that a definition keeps only its first line (a file
  // of thousands of unclosed definitions would otherwise hold a copy of the rest of the file for each one).
  let bodyBytes = 0;
  const MAX_BODIES = 40 * 1024 * 1024;
  for (const f of files) {
    f.code = f.lines.map(l => (l.length > 2000 || COMMENT_LINE.test(l) ? '' : l));
    f.codeText = f.code.join('\n');
    f.browser = isBrowser(f);
    f.fnRanges = [];
    f.code.forEach((l, i) => {
      const m = DEF.exec(l);
      if (!m) return;
      const name = m[1] || m[2] || m[3];
      let body = m[3] ? pyBlock(f.code, i) : blockFrom(f.code, i);
      f.fnRanges.push([i, i + body.split('\n').length - 1]);
      if (bodyBytes + body.length > MAX_BODIES) body = l;
      bodyBytes += body.length;
      if (!idx.fns.has(name)) idx.fns.set(name, []);
      idx.fns.get(name).push({ f, i, body });
    });
  }
  const bodies = new Map();
  idx.bodyOf = name => { if (!bodies.has(name)) bodies.set(name, (idx.fns.get(name) || []).map(d => d.body).join('\n')); return bodies.get(name); };
  idx.defined = name => idx.fns.has(name);
  return idx;
}
// A script that runs in the visitor's browser (not a server or a build tool).
function isBrowser(f) {
  if (/\.(html?|vue|svelte|astro|jsx|tsx)$/i.test(f.name)) return true;
  if (!JS.test(f.name)) return false;
  if (/require\(\s*['"](node:)?(http|https|fs|path|child_process|express|fastify|koa)['"]\)|from\s+['"](node:)?(fs|http|path|express|fastify|koa|hono)['"]|\bprocess\.(argv|env|exit)\b|createServer\s*\(/.test(f.text)) return false;
  return /(^|\/)(public|static|assets|js|src|client|frontend|www|web|site|app)\//i.test(f.rel) || /\b(document|window|localStorage|addEventListener)\b/.test(f.text);
}

// A signed-in check in this file: a guard call, a direct session check, or a call to a project function that does one.
const AUTH_CALL = /\b(require_?(login|user|auth|admin|role|staff|signed_?in)|is_?logged_?in|auth_?required|check_?auth|ensure_?(auth|login|admin)|must_?be_?(admin|logged_?in)|requireAuth|requireUser|requireAdmin|isAuthenticated|verify_?(token|session|jwt)|check_?admin|current_?user|login_?required|authenticate)\s*\(|@login_required|\$_SESSION\s*\[\s*['"](uid|user|user_?id|userid|admin|role|logged_?in|account_?id|staff)['"]\s*\]|\bIsGranted\b|->can\s*\(/i;
const GUARD_BODY = /\$_SESSION|session_start\s*\(|\b(401|403)\b|login\.php|req\.(session|user)\b|\bjwt\b/i;
function guarded(idx, f) {
  if (ADMIN_PATH.test(f.rel)) return true;
  if (AUTH_CALL.test(f.codeText)) return true;
  for (const n of callsIn(f.codeText)) if (idx.defined(n) && GUARD_BODY.test(idx.bodyOf(n)) && !/^(public|cors|json|send|respond|header)/i.test(n)) return true;
  return false;
}
// Limiter calls in a file: a project function that counts and refuses, or one named for it. perCaller: keyed on the
// visitor (address, session, user); site: keyed on a fixed value (a cap for everyone together).
const LIMIT_NAME = /rate|limit|throttle|attempt|quota|budget|cap_?ok|allow_?request/i;
// A body that counts something and then compares or refuses after it. Two plain searches, not one pattern that spans
// the body: that one went back over the whole body for every place a counting word appeared.
const LIMIT_COUNTS = /apcu_(fetch|inc|store)|redis|memcache|\bcount\b|attempts?|hits|COUNT\s*\(\s*\*\s*\)/i;
const LIMIT_BODY = { test(body) { const m = LIMIT_COUNTS.exec(body); return !!m && /(>=|>|return\s+false)/i.test(body.slice(m.index + m[0].length)); } };
function limiterCalls(idx, f) {
  const out = [];
  // the arguments are read in a lookahead, so a call inside another call's brackets (if (!rate_ok(...))) is seen too;
  // the arguments are read up to 400 characters, so a call that never closes does not send it to the end of the file
  for (const m of f.codeText.matchAll(/(?<![\w$>:.])([A-Za-z_$][\w$]*)\s*\((?=([^;{}]{0,400}?)\)\s*(\)|\|\||&&|;|\{|,|$))/gm)) {
    const name = m[1];
    if (KEYWORDS.has(name.toLowerCase()) || !(LIMIT_NAME.test(name) || (idx.defined(name) && LIMIT_BODY.test(idx.bodyOf(name))))) continue;
    if (idx.defined(name) && !LIMIT_BODY.test(idx.bodyOf(name)) && !LIMIT_NAME.test(name)) continue;
    const args = m[2].replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
    const perCaller = /\$|\b(ip|req|request|user|uid|session|email|client|addr|remote)\w*/i.test(args.replace(/\b[A-Z][A-Z0-9_]+\b/g, ''));
    out.push({ name, perCaller, site: !perCaller });
  }
  return out;
}
// A line inside a function body is library code: it runs when a page calls it, and that page holds the guards.
const inFunction = (f, i) => f.fnRanges.some(([a, b]) => i > a && i <= b);
// A limiter written out in the page itself (a counter file per address, then 429): counts as a per-visitor limit.
const INLINE_LIMIT = /http_response_code\s*\(\s*429|Too many (requests|messages|tries|attempts)/i;
const READS_REQUEST = /\$_(POST|GET|REQUEST|FILES)\b|php:\/\/input|\breq\.(body|query|params)\b|\brequest\.(form|args|json|get_json|values)\b/;

// ---- rules ----
// Each rule: { id, sev, area, title, fix, run(idx) -> [{ f, i, title? }] }. The finding is placed at file f, line i.
const RULES = [];
const rule = r => RULES.push(r);

// ABUSE-001: a public request that saves or sends mail, with no per-visitor limit or no cap for everyone together.
rule({ id: 'ABUSE-001', sev: 'Medium', area: 'abuse', title: 'A public form saves or sends mail with no per-visitor limit and no cap for everyone together',
  fix: 'Limit each visitor (by address) AND cap the total per hour or day with a fixed key, and answer 429 with Retry-After.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (!PHP.test(f.name) || f.isTest || ONE_OFF.test(f.rel) || !READS_REQUEST.test(f.codeText) || guarded(idx, f)) continue;
      const i = f.code.findIndex((l, k) => /\bINSERT\s+(IGNORE\s+)?INTO\b|(?<![\w>$])(wp_)?mail\s*\(|\bsend_?mail\s*\(|->send\s*\(\s*\)/i.test(l) && !inFunction(f, k));
      if (i < 0) continue;
      const lim = limiterCalls(idx, f);
      const per = lim.some(l => l.perCaller) || (INLINE_LIMIT.test(f.codeText) && /REMOTE_ADDR|\$ip\b|_ip\b/.test(f.codeText)), site = lim.some(l => l.site);
      if (per && site) continue;
      out.push({ f, i, title: per ? 'A public form saves or sends mail with a per-visitor limit but no cap for everyone together (many addresses still flood it)' : site ? 'A public form saves or sends mail with a cap for everyone together but no per-visitor limit (one visitor can use up the cap)' : null });
    }
    return out;
  } });

// ABUSE-002: a public request reaches a paid outside service with no cache and no cap for everyone together.
rule({ id: 'ABUSE-002', sev: 'Medium', area: 'abuse', title: 'A public request calls a paid outside service with no cache and no daily cap (a per-visitor limit alone lets many addresses run up the bill)',
  fix: 'Cache answers by their question, and cap the calls per day with a fixed key; say what the visitor can do when the cap is reached.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (!/\.(php|py)$/i.test(f.name) || f.isTest || ONE_OFF.test(f.rel) || !READS_REQUEST.test(f.codeText) || guarded(idx, f)) continue;
      const i = f.code.findIndex((l, k) => (/\b(file_get_contents|curl_init|wp_remote_(get|post)|fopen|requests\.(get|post)|httpx\.(get|post)|urlopen)\s*\(\s*['"]https:\/\//i.test(l) || /CURLOPT_URL\s*,\s*['"]https:\/\//.test(l)) && !inFunction(f, k));
      if (i < 0) continue;
      if (!/key=|api_?key|apikey|_KEY\b|token|Authorization|Bearer|secret/i.test(f.codeText)) continue;
      const cached = /apcu_(fetch|entry)|\bcache\w*\s*\(|\$cache\w*\b|get_transient|redis|memcache|SELECT[^;'"]*\bcache/i.test(f.codeText);
      if (cached || limiterCalls(idx, f).some(l => l.site)) continue;
      out.push({ f, i });
    }
    return out;
  } });

// DATA-008: the project has a clean-up job, and a table that requests keep adding to is not in it.
const PRUNE_FILE = /prune|clean-?up|purge|housekeep|retention|(^|\/)gc[\w.-]*\.\w+$|(^|\/)cron/i;
const LOG_TABLE = /(visit|view|hit|log|event|attempt|click|impression|request|session|token|rate|throttle|audit|search|stat|ping|beacon|track)s?$/i;
rule({ id: 'DATA-008', sev: 'Medium', area: 'data', title: 'A table that requests keep adding to is not in the clean-up job, so it grows for ever',
  fix: 'Add the table to the clean-up job, keeping rows only as long as they are needed (and at least as long as any limit reads them).',
  run(idx) {
    const prune = idx.files.filter(f => PRUNE_FILE.test(f.rel) && /\bDELETE\s+FROM\b|\bTRUNCATE\b/i.test(f.codeText));
    if (!prune.length) return [];
    const pruneText = prune.map(f => f.codeText).join('\n');
    const agedDelete = t => idx.files.some(f => f.code.some(l => new RegExp('DELETE\\s+FROM\\s+[`"]?' + esc(t) + '\\b[^;]*(INTERVAL|<\\s*(NOW|\\?|:\\w+|\\$)|time\\(\\)|datetime|strftime)', 'i').test(l)));
    const seen = new Set(), out = [];
    for (const f of idx.files) {
      if (f.isTest || prune.includes(f) || ONE_OFF.test(f.rel) || !SERVER_CODE.test(f.name)) continue;
      f.code.forEach((l, i) => {
        const m = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+[`"]?(\w+)/i.exec(l);
        if (!m || seen.has(m[1].toLowerCase())) return;
        const t = m[1];
        if (!LOG_TABLE.test(t) && !/NOW\(\)|CURRENT_TIMESTAMP|time\(\)|datetime\(/i.test(l)) return;
        if (new RegExp('\\b' + esc(t) + '\\b', 'i').test(pruneText) || agedDelete(t)) return;
        seen.add(t.toLowerCase());
        out.push({ f, i, title: 'The ' + t + ' table is added to on requests but is not in the clean-up job (' + prune[0].rel + '), so it grows for ever' });
      });
    }
    return out;
  } });

// DATA-009: a public request (found by a share code or token) answers with SELECT * as it is.
rule({ id: 'DATA-009', sev: 'High', area: 'privacy', title: 'A public link answers with the whole database row (every column: email, notes, its own secret code)',
  fix: 'Name the columns the page needs in the SELECT (or copy only those fields into the answer).',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (!PHP.test(f.name) || f.isTest || guarded(idx, f)) continue;
      const i = f.code.findIndex(l => /SELECT\s+\*\s+FROM\s+[`"]?\w+[`"]?\s+WHERE\s+[`"]?\w*(code|token|slug|share|hash|ref|uuid|key|link)\w*[`"]?\s*=/i.test(l));
      if (i < 0) continue;
      if (!/json_encode\s*\(\s*\$\w+->fetch(All)?\s*\(|json_encode\s*\(\s*\$(row|rows|item|record|result|data|r)\s*[,)]/i.test(f.codeText)) continue;
      out.push({ f, i });
    }
    return out;
  } });

// PAY-005: a webhook calls a handler that can fail, ignores its answer, and still answers 2xx.
rule({ id: 'PAY-005', sev: 'High', area: 'payments', title: 'A webhook ignores its own handler\'s failure and answers 200, so the sender never tries again (the event is lost)',
  fix: 'Check the handler\'s result: answer 500 when it fails (the sender retries), and mark the event as seen only after it worked.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (f.isTest || !SERVER_CODE.test(f.name)) continue;
      if (!/webhook|(^|\/)hooks?\/|ipn|notify|callback/i.test(f.rel) && !/verified_event|constructEvent|verify_?signature|HTTP_STRIPE_SIGNATURE|X-Signature/i.test(f.codeText)) continue;
      for (let i = 0; i < f.code.length; i++) {
        const m = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*;\s*$/.exec(f.code[i]);
        if (!m || KEYWORDS.has(m[1].toLowerCase()) || !idx.defined(m[1])) continue;
        // the call that does the work (handle, process, fulfil, mark paid ...), not a refusal or a log line
        if (!/handle|process|fulfil|apply|capture|credit|activate|mark_?paid|complete|dispatch|record_?pay|book/i.test(m[1])) continue;
        if (/^\s*(exit|die|return|throw)\b/.test(f.code[i + 1] || '')) continue;
        if (!/return\s+(false|null|None)\b|return\s*;/.test(idx.bodyOf(m[1]))) continue;
        const after = f.code.slice(i + 1).join('\n');
        if (!/http_response_code\s*\(\s*20\d|\bres\.(status\s*\(\s*20\d|sendStatus\s*\(\s*20\d|json\s*\()|echo\s+['"](ok|received)|return\s+['"]?ok/i.test(after)) continue;
        const seenFirst = f.code.slice(0, i).some(l => /\b(mark|set|save|record)_?\w*(seen|processed|handled|done)\w*\s*\(/i.test(l));
        out.push({ f, i, title: 'A webhook ignores ' + m[1] + '()\'s failure and answers 200' + (seenFirst ? ' after marking the event as seen' : '') + ', so the sender never tries again (the event is lost)' });
        break;
      }
    }
    return out;
  } });

// REL-002 / REL-003: release builders.
const BUILDER = /(^|\/)[^/]*(build|bake|release|deploy|package|bundle|publish|make-?zip|dist)[^/]*\.(m?js|cjs|py|php|sh|ps1|bat|cmd)$/i;
const NOTE_FILE = /^(AUDIT|HANDOFF|REVERT|PROMPT|NOTES?|TODO|SCRATCH)[\w .-]*\.(md|txt)$|^install\.php$|^index2\.php$|^\.user\.ini$|^phpinfo\.php$|\.(bak|old|orig|sql|log)$|^test[-_]?\w*\.(php|html?)$|^(?!README|LICENSE|CHANGELOG|SECURITY|CONTRIBUTING)[\w.-]+\.md$/i;
const WHOLE_COPY = /\b(?:fs\.)?(cpSync|cp|copy|copySync|copytree|copy_tree|copyDir|copydir)\s*\(\s*([^,)]+)|\b(?:cp|Copy-Item)\s+-[rR]\w*\s+(\S+)|\bxcopy\s+(\S+)[^\n]*\/[Ee]\b|\brobocopy\s+(\S+)\s+\S+[^\n]*\/(E|S|MIR)\b|\bzip\s+-r\w*\s+\S+\s+(\S+)|RecursiveDirectoryIterator\s*\(\s*([^,)]+)/;
function literalOf(f, expr) {
  const s = String(expr || '').trim();
  const q = /^['"`]([^'"`$]+)['"`]$/.exec(s) || /^r?['"]([^'"]+)['"]$/.exec(s);
  if (q) return q[1];
  const id = /^([A-Za-z_]\w*)$/.exec(s) || /(?:\/|\bjoin\s*\()\s*([A-Za-z_]\w*)\s*\)?$/.exec(s);
  if (id) {
    const def = new RegExp('\\b' + esc(id[1]) + '\\s*=\\s*[^\\n]*?[\'"]([^\'"]+)[\'"]\\s*\\)?\\s*;?\\s*$', 'm').exec(f.codeText);
    if (def) return def[1];
  }
  const tail = /['"]([\w.\/-]+)['"]\s*\)?\s*$/.exec(s);
  return tail ? tail[1] : null;
}
function walkNames(dir, max = 3000) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length > max || depth > 8) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!/^(node_modules|\.git|vendor)$/.test(e.name)) walk(path.join(d, e.name), depth + 1); }
      else out.push(path.join(d, e.name));
    }
  };
  walk(dir, 0);
  return out;
}
rule({ id: 'REL-002', sev: 'High', area: 'release', title: 'The release build copies a whole folder, and that folder holds files that must not ship',
  fix: 'Ship from an allow list (name each file or folder that goes out), or filter the copy against notes, installers, test pages and backups.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (f.isTest || !BUILDER.test(f.rel)) continue;
      for (let i = 0; i < f.code.length; i++) {
        const l = f.code[i];
        const m = WHOLE_COPY.exec(l);
        if (!m) continue;
        const stmt = f.code.slice(i, i + 3).join(' ');
        if (/cpSync|cp\b|copy\b|copySync/.test(m[1] || '') && !/recursive\s*:\s*true|dirs_exist_ok/.test(stmt) && !/copytree|copy_tree|copyDir|copydir/i.test(m[1] || '')) continue;
        if (/\bfilter\s*[:=]|\bignore\s*=|ignore_patterns|--exclude|\s-x\s|\/X[FD]\b|-Exclude\b/i.test(stmt)) continue;
        const lit = literalOf(f, m[2] || m[3] || m[4] || m[5] || m[7] || m[8]);
        if (!lit || /^[.\/]*$/.test(lit) && lit !== '.') continue;
        const src = [path.join(idx.dir, lit), path.join(idx.dir, path.dirname(f.rel), lit)].find(p => { try { return inProject(idx, p) && fs.statSync(p).isDirectory(); } catch { return false; } });
        if (!src) continue;
        const bad = walkNames(src).map(p => path.basename(p)).filter(n => NOTE_FILE.test(n));
        if (!bad.length) continue;
        out.push({ f, i, title: 'The release build copies the whole ' + lit.replace(/\/+$/, '') + '/ folder, which holds files that must not ship (' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? ', …' : '') + ')' });
        break;
      }
    }
    return out;
  } });
const LIST_NAME = /\b(SHIP|FILES|INCLUDE|ALLOW\w*|KEEP|MANIFEST|ASSETS|PAGES|RELEASE\w*|DIST\w*|COPY\w*)\b\s*=\s*\[/i;
rule({ id: 'REL-003', sev: 'Medium', area: 'release', title: 'The release leaves out a file its own page links to (the live site shows the page broken)',
  fix: 'Add the file to the release list, and have the build check every local href/src of the shipped pages is in the zip.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (f.isTest || !BUILDER.test(f.rel) || f.code.some(l => WHOLE_COPY.test(l) && /recursive\s*:\s*true|copytree/.test(l))) continue;
      const at = f.code.findIndex(l => LIST_NAME.test(l));
      if (at < 0) continue;
      // every fixed list in the builder ships something (PAGES, CSS, FONTS ...): a file in any of them is shipped
      const list = [];
      for (const arr of f.codeText.matchAll(/\b[A-Z][A-Z0-9_]*\s*=\s*\[([^\]]*)\]/g)) list.push(...[...arr[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1].replace(/^\.?\//, '')));
      if (!list.length) continue;
      // the folder the listed files are copied from: the prefix joined to a list entry where the listed pages exist
      const roots = [...f.codeText.matchAll(/['"`]([\w.-]+(?:\/[\w.-]+)*)\/['"`]\s*\+\s*\w+|join\(\s*['"]([\w.\/-]+)['"]\s*,\s*\w+\s*\)/g)].map(m => m[1] || m[2]);
      const pagesIn = r => list.some(e => /\.(html?|php)$/i.test(e) && fs.existsSync(path.join(idx.dir, r, e)));
      const base = path.join(idx.dir, roots.find(pagesIn) || '');
      if (!inProject(idx, base)) continue;
      // listed, under a listed folder, or named anywhere in the builder as text ('pillar.css' in an inline list)
      const shipped = rel => list.some(e => e === rel || (!path.extname(e) && rel.startsWith(e.replace(/\/?$/, '/')))) || new RegExp('[\'"`/]' + esc(rel) + '[\'"`]').test(f.codeText);
      for (const page of list.filter(e => /\.(html?|php)$/i.test(e))) {
        if (!inProject(idx, path.join(base, page))) continue;
        let text = ''; try { text = fs.readFileSync(path.join(base, page), 'utf8'); } catch { continue; }
        for (const m of text.matchAll(/<(?:link|script|img|source)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"'#?]+)/gi)) {
          const ref = m[1];
          if (/^([a-z]+:|\/\/)/i.test(ref) || /<\?|\{\{/.test(ref) || !path.extname(ref)) continue;
          const rel = ref.startsWith('/') ? ref.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(page), ref));
          if (shipped(rel) || !inProject(idx, path.join(base, rel)) || !fs.existsSync(path.join(base, rel))) continue;
          // a folder the builder names on its own ('fonts', copied by a loop over its files) ships too
          const top = rel.split('/')[0];
          if (rel.includes('/') && new RegExp('[\'"`/]' + esc(top) + '/?[\'"`]').test(f.codeText)) continue;
          out.push({ f, i: at, title: 'The release leaves out ' + rel + ', which ' + page + ' links to (the live page shows broken)' });
          break;
        }
        if (out.length && out[out.length - 1].f === f) break;
      }
    }
    return out;
  } });

// CLAIM-001: a page promises files or data are deleted after a time; nothing in the code deletes by age.
const DELETE_CLAIM = /\b(deleted|removed|erased|wiped|purged|destroyed)\s+(automatically\s+)?(after|within)\s+(\d+|an?|one|two|a\s+few)\s+(minutes?|hours?|days?|weeks?)\b|\bkept\s+(for|only\s+for)\s+(\d+|an?|one|two)\s+(minutes?|hours?|days?)\b/i;
const DELETES = /\b(unlink|unlinkSync|rmSync|rmdirSync|os\.remove|os\.unlink|shutil\.rmtree|Remove-Item)\s*\(?|\bDELETE\s+FROM\b|->delete\s*\(|\.deleteMany\s*\(|\bfind\s+\S+.*-delete\b|\brm\s+-/i;
const AGE = /filemtime|mtime|ctime|INTERVAL|time\(\)\s*-|Date\.now\(\)\s*-|\b(86400|3600|86_400)\b|older|expire|created_at\s*<|<\s*NOW|\bttl\b|maxAge|\bage\b|-mtime|timedelta|strtotime\(/i;
rule({ id: 'CLAIM-001', sev: 'High', area: 'claims', title: 'A page promises that data is deleted after a time, but nothing in the code deletes by age',
  fix: 'Add the clean-up job that keeps the promise (and run it on a schedule), or change the page to say what really happens.',
  run(idx) {
    const pages = idx.files.filter(f => !f.isTest && MARKUP.test(f.name));
    const out = [];
    let ok = null;
    for (const f of pages) {
      const i = f.lines.findIndex(l => DELETE_CLAIM.test(l.replace(/<[^>]+>/g, ' ')));
      if (i < 0) continue;
      if (ok === null) ok = idx.files.some(g => !g.isTest && SERVER_CODE.test(g.name) && g.code.some((l, k) => DELETES.test(l) && AGE.test(g.code.slice(Math.max(0, k - 6), k + 6).join('\n'))));
      if (ok) return [];
      out.push({ f, i });
    }
    return out;
  } });

// ---- privacy page against the code ----
const isPrivacy = f => /privacy/i.test(f.name) && /\.(html?|php|md|tsx?|jsx?|vue|json|txt)$/i.test(f.name);
const STORE_DENIAL = /\b(store|keep|save|put|place)s?\s+nothing\s+(on|in)\s+your\s+(device|browser|computer|phone)|\bnothing\s+is\s+(stored|kept|saved)\s+(on|in)\s+your\s+(device|browser|computer|phone)|\bno\s+(data|information)\s+is\s+(stored|kept|saved)\s+(on|in)\s+your\s+(device|browser)|\b(do|does)\s+not\s+(store|keep|save)\s+anything\s+(on|in)\s+your\s+(device|browser)|\bno\s+cookies\s+(or|and|,)\s+no\s+(local\s*storage|tracking)|\bwe\s+(do\s+not|don['’]t)\s+use\s+(cookies\s+or\s+)?(local\s*storage|browser\s+storage)/i;
rule({ id: 'PRIV-003', sev: 'Medium', area: 'privacy', title: 'The privacy page says nothing is kept on the visitor\'s device, but the code keeps data in the browser',
  fix: 'Say on the privacy page what is kept in the browser (each item, why, and how to clear it), or stop keeping it.',
  run(idx) {
    const priv = idx.files.filter(isPrivacy);
    const denial = priv.map(f => ({ f, i: f.lines.findIndex(l => STORE_DENIAL.test(l.replace(/<[^>]+>/g, ' '))) })).find(x => x.i >= 0);
    if (!denial) return [];
    const said = priv.map(f => f.text.toLowerCase()).join('\n');
    for (const f of idx.files) {
      if (f.isTest || !f.browser) continue;
      for (let i = 0; i < f.code.length; i++) {
        const m = /\b(localStorage|sessionStorage)\.setItem\s*\(\s*['"`]([^'"`]+)|\b(localStorage|sessionStorage)\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=(?!=)|\bdocument\.cookie\s*=(?!=)|\bindexedDB\.open\s*\(/.exec(f.code[i]);
        if (!m) continue;
        const key = m[2] || m[4];
        if (key && said.includes(key.toLowerCase())) continue;
        return [{ f, i, title: 'The privacy page (' + denial.f.rel + ') says nothing is kept on the visitor\'s device, but the code keeps ' + (key ? '"' + key + '"' : 'data') + ' in the browser' }];
      }
    }
    return [];
  } });
// Services a privacy page may name: how the page names it, and how the code loads it.
const SERVICES = [
  ['Hotjar', /\bhotjar\b/i, /hotjar/i], ['Google Analytics', /google\s+analytics/i, /google-analytics\.com|googletagmanager\.com|\bgtag\s*\(|\bga\s*\(\s*['"](create|send)/i],
  ['Google Tag Manager', /tag\s+manager/i, /googletagmanager\.com/i], ['Meta Pixel', /facebook\s+pixel|meta\s+pixel/i, /connect\.facebook\.net|\bfbq\s*\(/i],
  ['Microsoft Clarity', /\bclarity\b/i, /clarity\.ms/i], ['Mixpanel', /\bmixpanel\b/i, /mixpanel/i], ['Intercom', /\bintercom\b/i, /intercom/i],
  ['Crisp', /\bcrisp\b(?!\w)/i, /crisp\.chat/i], ['Tawk.to', /\btawk(\.to)?\b/i, /tawk\.to/i], ['FullStory', /\bfullstory\b/i, /fullstory/i],
  ['Matomo', /\b(matomo|piwik)\b/i, /matomo|piwik/i], ['Plausible', /\bplausible\b(?=[^.]{0,40}(analytics|\.io|script))|plausible\.io/i, /plausible\.io/i],
  ['Fathom', /\bfathom\b/i, /usefathom|fathom\.js|cdn\.usefathom/i], ['LogRocket', /\blogrocket\b/i, /logrocket/i], ['Sentry', /\bsentry\b/i, /sentry/i],
  ['reCAPTCHA', /\brecaptcha\b/i, /recaptcha/i], ['hCaptcha', /\bhcaptcha\b/i, /hcaptcha/i], ['Turnstile', /\bturnstile\b/i, /turnstile|challenges\.cloudflare\.com/i],
  ['Google AdSense', /\badsense\b/i, /googlesyndication|adsbygoogle/i], ['Mailchimp', /\bmailchimp\b/i, /mailchimp|list-manage\.com/i],
];
rule({ id: 'PRIV-004', sev: 'Medium', area: 'privacy', title: 'The privacy page names a service the site no longer uses (visitors are told about data that is not collected; the real list is out of date)',
  fix: 'Take the service off the privacy page (and check the rest of the list against what the site loads today).',
  run(idx) {
    const priv = idx.files.filter(isPrivacy);
    if (!priv.length) return [];
    const code = idx.files.filter(f => !f.isTest && !isPrivacy(f) && !/terms|cookie|legal|policy/i.test(f.name)).map(f => f.codeText).join('\n');
    const out = [];
    for (const f of priv) {
      for (const [name, said, used] of SERVICES) {
        const i = f.lines.findIndex(l => said.test(l));
        if (i < 0 || used.test(code)) continue;
        const sentence = f.lines[i].replace(/<[^>]+>/g, ' ').split(/(?<=[.!?])\s+/).find(s => said.test(s)) || '';
        if (/\b(not|no|no\s+longer|never|don['’]t|without|stopped|removed|instead\s+of)\b/i.test(sentence)) continue;
        out.push({ f, i, title: 'The privacy page names ' + name + ', which the site no longer loads' });
      }
    }
    return out.slice(0, 3);
  } });
rule({ id: 'PRIV-005', sev: 'Medium', area: 'privacy', title: 'The site loads from outside services and has no privacy page (visitors are not told who receives their address)',
  fix: 'Add a privacy page that names each outside service and what it receives, and link it from every page; or serve the files from your own site.',
  run(idx) {
    // loads made by a page or a browser script: a server's own fetch sends the server's address, not the visitor's
    const byRel = new Map(idx.files.map(f => [f.rel, f]));
    const loads = idx.loads.filter(l => { const f = byRel.get(l.at.replace(/:\d+$/, '')); return f && (f.browser || /\.php$/i.test(f.name)); });
    if (!loads.length || idx.files.some(isPrivacy) || idx.docs.some(d => /privacy/i.test(d.rel))) return [];
    const pages = idx.files.filter(f => !f.isTest && /\.(html?|php)$/i.test(f.name));
    if (!pages.some(f => /(^|\/)index\.(html?|php)$/i.test(f.rel))) return [];
    if (idx.files.some(f => !f.isTest && /privacy/i.test(f.codeText))) return [];
    const first = loads[0];
    const [rel, line] = [first.at.replace(/:\d+$/, ''), +(/:(\d+)$/.exec(first.at) || [0, 1])[1]];
    const f = idx.files.find(x => x.rel === rel);
    return f ? [{ f, i: line - 1, title: 'The site loads from ' + loads.length + ' outside service' + (loads.length === 1 ? '' : 's') + ' (' + loads.slice(0, 3).map(l => l.host).join(', ') + ') and has no privacy page' }] : [];
  } });

// DATA-010: most writers of a table call its validator; one does not (a restore page, an admin fix, an import).
const VALIDATOR = /valid|sanit|clean|normali[sz]e|^check_|^assert_|guard/i;
rule({ id: 'DATA-010', sev: 'Medium', area: 'data', title: 'One place saves to a table without the check every other place runs first',
  fix: 'Run the same validator on this path too (restore, import and admin fixes are where bad rows get in).',
  run(idx) {
    const writes = new Map(); // table -> [{ f, i }]
    for (const f of idx.files) {
      if (f.isTest || !SERVER_CODE.test(f.name) || /(^|\/)(migrations?|seeds?|schema|install)/i.test(f.rel)) continue;
      const seen = new Set();
      f.code.forEach((l, i) => {
        // new rows only: an UPDATE of one column (a date, a flag) does not need the whole record's check
        const m = /\b(?:INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO)\s+[`"]?(\w+)/i.exec(l);
        if (!m || seen.has(m[1].toLowerCase())) return;
        seen.add(m[1].toLowerCase());
        const t = m[1].toLowerCase();
        if (!writes.has(t)) writes.set(t, []);
        writes.get(t).push({ f, i });
      });
    }
    const out = [];
    for (const [t, ws] of writes) {
      if (new Set(ws.map(w => w.f)).size < 2) continue;
      const stem = singular(t);
      // a check of the whole record (validate_client, pd_listing_validate), not of one field (client_status_valid)
      const whole = new RegExp('^([a-z0-9]+_)?(validate|valid|is_valid|sanitize|sanitise|clean|check|normali[sz]e|assert)_?' + esc(stem) + '$|^([a-z0-9]+_)?' + esc(stem) + '_?(validate|valid|is_valid|sanitize|sanitise|clean|check|normali[sz]e)$', 'i');
      const vals = [...idx.fns.keys()].filter(n => whole.test(n));
      for (const v of vals) {
        const re = new RegExp('(?<![\\w$])' + esc(v) + '\\s*\\(');
        const calls = ws.filter(w => re.test(w.f.codeText) && !(idx.fns.get(v) || []).some(d => d.f === w.f && !re.test(w.f.codeText.replace(d.body, ''))));
        const skips = ws.filter(w => !re.test(w.f.codeText));
        if (!calls.length || calls.length < skips.length) continue;
        for (const w of skips) out.push({ f: w.f, i: w.i, title: 'This saves to ' + t + ' without calling ' + v + '(), which the other ' + calls.length + ' place' + (calls.length === 1 ? '' : 's') + ' saving it run first' });
        break;
      }
    }
    return out;
  } });

// AUTH-015: a signed-in person changes or deletes a row by its id, and the query never asks whose row it is.
rule({ id: 'AUTH-015', sev: 'High', area: 'auth', title: 'A signed-in request deletes or changes a row by its number alone (anyone signed in can change anyone\'s)',
  fix: 'Add the owner to the query (WHERE id = ? AND user_id = ?) and say "not found" when no row matched.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (!PHP.test(f.name) || f.isTest || ADMIN_PATH.test(f.rel) || !READS_REQUEST.test(f.codeText)) continue;
      if (/\b(require_?(admin|role|staff)|is_?admin|has_?role|check_?admin|current_user_can)\s*\(|\$_SESSION\s*\[\s*['"](role|is_?admin|admin|level)['"]/i.test(f.codeText)) continue;
      // the signed-in person's id, from a guard function (read across files) or from the session directly
      let who = null;
      for (const m of f.codeText.matchAll(/\$(\w+)\s*=\s*(?:\(int\)\s*)?(?:([A-Za-z_]\w*)\s*\(|\$_SESSION\s*\[)/g)) {
        if (m[2] && !(idx.defined(m[2]) && /\$_SESSION/.test(idx.bodyOf(m[2])) && /return/.test(idx.bodyOf(m[2])))) continue;
        who = m[1]; break;
      }
      if (!who || (f.codeText.match(new RegExp('\\$' + esc(who) + '\\b', 'g')) || []).length > 1) continue;
      const i = f.code.findIndex(l => /\b(DELETE\s+FROM|UPDATE)\s+[`"]?\w+[`"]?\s+(SET\s+[^'"]*?\s+)?WHERE\s+[`"]?id[`"]?\s*=\s*(\?|:\w+)\s*(LIMIT\s+1\s*)?['"]/i.test(l));
      if (i < 0) continue;
      out.push({ f, i });
    }
    return out;
  } });

// AUTH-016: an action switch whose risky branches run for anyone signed in, while the project has a role check.
rule({ id: 'AUTH-016', sev: 'High', area: 'auth', title: 'An action switch checks sign-in only: its admin actions (delete, export, roles) run for anyone signed in',
  fix: 'Call the role check in each risky branch (or before the switch), so only the right people can run them.',
  run(idx) {
    const roleFns = [...idx.fns.keys()].filter(n => /role|admin|perm|can|allow/i.test(n) && /role|admin|perm|level/i.test(idx.bodyOf(n)) && /403|exit|die|throw|return\s+false/i.test(idx.bodyOf(n)));
    if (!roleFns.length) return [];
    const out = [];
    for (const f of idx.files) {
      if (!PHP.test(f.name) || f.isTest) continue;
      const i = f.code.findIndex(l => /switch\s*\(\s*(\$_(POST|GET|REQUEST)\s*\[\s*['"](action|op|do|cmd|task)['"]|\$(action|op|cmd|task)\b)/i.test(l));
      if (i < 0) continue;
      const cases = [...f.codeText.matchAll(/case\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
      // an admin page's switch, or actions that are about other people (a user deleting their own mail is not)
      const RISKY = ADMIN_PATH.test(f.rel) || /admin/i.test(f.name) ? /delete|remove|export|reset|grant|role|ban|purge|wipe|drop|promote|refund|admin|impersonate/i
        : /(delete|remove|ban|block|promote|demote|reset_?password|impersonate)_?(user|account|member|staff)|grant|role|set_?admin|export_?all|purge|wipe|refund/i;
      if (!cases.some(c => RISKY.test(c))) continue;
      if (roleFns.some(n => new RegExp('(?<![\\w$])' + esc(n) + '\\s*\\(').test(f.codeText.replace((idx.fns.get(n) || []).filter(d => d.f === f).map(d => d.body).join(''), '')))) continue;
      if (/\$_SESSION\s*\[\s*['"](role|is_?admin|admin|level|perm\w*)['"]|\b(is_?admin|has_?role|current_user_can|user_can)\s*\(/i.test(f.codeText)) continue;
      out.push({ f, i, title: 'An action switch checks sign-in only: ' + cases.filter(c => RISKY.test(c)).slice(0, 3).join(', ') + ' run for anyone signed in (' + roleFns[0] + '() is never called here)' });
    }
    return out;
  } });

// DATA-011: the same price or fee constant written in two files with two different values.
const MONEY_WORD = /^(FEE|FEES|PRICE|PRICES|COST|CHARGE|TAX|GST|VAT|DEPOSIT|DISCOUNT|SURCHARGE|CALLOUT)$/;
rule({ id: 'DATA-011', sev: 'High', area: 'money', title: 'The same price is written in two places with two different values (the quote and the bill disagree)',
  fix: 'Keep the value in one place (a settings file both sides read), or make the two agree and add a test that compares them.',
  run(idx) {
    const defs = new Map();
    for (const f of idx.files) {
      if (f.isTest || !/\.(php|m?js|cjs|tsx?|jsx|py)$/i.test(f.name)) continue;
      f.code.forEach((l, i) => {
        const m = /\b(?:const|let|var|final|static|public|private)?\s*(?:define\s*\(\s*['"])?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{3,})['"]?\s*(?:=|,)\s*(-?\d+(?:\.\d+)?)\s*[;,)]?\s*(\/\/.*|#.*)?$/.exec(l);
        if (!m) return;
        const parts = m[1].split('_');
        if (!parts.some(p => MONEY_WORD.test(p)) && !(parts.includes('RATE') && parts.some(p => /^(HOURLY|TAX|GST|VAT|CALL)$/.test(p)))) return;
        if (!defs.has(m[1])) defs.set(m[1], []);
        defs.get(m[1]).push({ f, i, v: Number(m[2]) });
      });
    }
    const out = [];
    for (const [name, ds] of defs) {
      const vals = new Set(ds.map(d => d.v));
      if (vals.size < 2 || new Set(ds.map(d => d.f)).size < 2) continue;
      const a = ds[0], b = ds.find(d => d.v !== a.v && d.f !== a.f);
      if (!b) continue;
      out.push({ f: b.f, i: b.i, title: name + ' is ' + b.v + ' here but ' + a.v + ' in ' + a.f.rel + ' (the quote and the bill disagree)' });
    }
    return out;
  } });

// INJ-019: a clean-up function cleans some fields of a record; a page prints another field of it raw.
rule({ id: 'INJ-019', sev: 'Medium', area: 'injection', title: 'The save step cleans some fields but not one the page prints raw (stored script injection)',
  fix: 'Escape on output (htmlspecialchars on every printed field), and clean the missing field on save as well.',
  run(idx) {
    const cleaned = new Set();
    for (const [name, ds] of idx.fns) {
      if (!/clean|sanit|strip|purif|escape|filter_/i.test(name)) continue;
      for (const d of ds) {
        for (const m of d.body.matchAll(/\$\w+\[\s*['"](\w+)['"]\s*\]\s*=\s*(strip_tags|htmlspecialchars|htmlentities|esc\w*|e|clean\w*|sanit\w*|filter_var|wp_kses\w*)\s*\(/g)) cleaned.add(m[1]);
        if (/foreach\s*\(\s*\[/.test(d.body)) for (const m of d.body.matchAll(/foreach\s*\(\s*\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/['"](\w+)['"]/g)) cleaned.add(k[1]);
      }
    }
    if (!cleaned.size) return [];
    const out = [];
    for (const f of idx.files) {
      if (!PHP.test(f.name) || f.isTest) continue;
      for (let i = 0; i < f.code.length; i++) {
        const l = f.code[i];
        if (!/\b(echo|print)\b|<\?=/.test(l)) continue;
        const raw = l.replace(/\b(htmlspecialchars|htmlentities|esc\w*|e|h|strip_tags|intval|number_format|urlencode|json_encode)\s*\(([^()]|\([^()]*\))*\)/g, '""');
        const keys = [...raw.matchAll(/\$\w+\[\s*['"](\w+)['"]\s*\]/g)].map(m => m[1]);
        const miss = keys.filter(k => !cleaned.has(k) && !/^(id|count|total|price|qty|n|num|year|day)$/i.test(k));
        if (keys.some(k => cleaned.has(k)) && miss.length) { out.push({ f, i, title: 'The save step cleans ' + keys.filter(k => cleaned.has(k)).join(', ') + ' but not ' + miss[0] + ', which this page prints raw' }); break; }
      }
    }
    return out;
  } });

// DATA-012 / DATA-013: deleting a record leaves its files behind (uploads, or a page baked for it).
const CLEANS_FILES = /\bunlink\s*\(|rmdir|rmSync|unlinkSync|rimraf|os\.remove|shutil\.rmtree|delete_?(files?|dir|folder|uploads?|photos?|images?|attachments?|page)|remove_?(files?|dir|folder|uploads?|photos?|page)|deleteFiles|removeDir|Storage::delete|unbake|unpublish|rebuild|regenerate/i;
function deletesOf(idx) {
  const out = [];
  for (const f of idx.files) {
    if (f.isTest || !SERVER_CODE.test(f.name) || ONE_OFF.test(f.rel)) continue;
    f.code.forEach((l, i) => { const m = /\bDELETE\s+FROM\s+[`"]?(\w+)/i.exec(l); if (m) out.push({ f, i, t: m[1], e: singular(m[1]) }); });
  }
  return out;
}
rule({ id: 'DATA-012', sev: 'Medium', area: 'data', title: 'Deleting a record leaves its uploaded files on the server (they stay reachable and fill the disk)',
  fix: 'Delete the record\'s files in the same step (after the row is gone), or move them to a folder a nightly job empties.',
  run(idx) {
    const out = [];
    const uploads = idx.files.filter(f => !f.isTest && SERVER_CODE.test(f.name)).flatMap(f => f.code.filter(l => /move_uploaded_file|file_put_contents|image(jpeg|png|webp|gif)\s*\(|writeFileSync|\.mv\s*\(|\bcopy\s*\(/.test(l) && /upload|photo|image|file|media|attach|storage|store/i.test(l)));
    for (const d of deletesOf(idx)) {
      const id = new RegExp('\\$' + d.e + '_?id\\b|\\$' + d.e + 'Id\\b|\\$' + d.e + '\\[\\s*[\'"]id|\\b' + d.e + '_?id\\b|\\b' + d.e + 'Id\\b', 'i');
      if (!uploads.some(l => id.test(l)) || CLEANS_FILES.test(d.f.codeText)) continue;
      out.push({ f: d.f, i: d.i, title: 'Deleting a ' + d.e + ' removes its row but leaves its uploaded files on the server' });
    }
    return out;
  } });
rule({ id: 'DATA-013', sev: 'Medium', area: 'data', title: 'A record is baked into its own page, and deleting the record leaves that page online',
  fix: 'Remove (or rebuild) the baked page in the same step that deletes the record.',
  run(idx) {
    const baked = new Set();
    for (const f of idx.files) {
      if (f.isTest || !SERVER_CODE.test(f.name)) continue;
      for (const l of f.code) {
        if (!/file_put_contents|writeFileSync|writeFile\s*\(|open\s*\([^)]*['"]w/.test(l) || !/\.html?['"]/.test(l)) continue;
        const m = /\/(\w+)\/['"]\s*(\.|\+)/.exec(l) || /\/(\w+)\/\$\{/.exec(l);
        if (m) baked.add(singular(m[1]));
      }
    }
    if (!baked.size) return [];
    return deletesOf(idx).filter(d => baked.has(d.e) && !CLEANS_FILES.test(d.f.codeText))
      .map(d => ({ f: d.f, i: d.i, title: 'Each ' + d.e + ' is baked into its own page, and deleting it here leaves that page online' }));
  } });

// PRIV-006: "forget everything" removes some of the keys the app keeps in the browser, not all.
// Constants in a file: NAME = 'text' and NAME = ['a', 'b'] (a key held in a constant is still a key).
function constantsOf(f) {
  if (f.consts) return f.consts;
  const c = new Map();
  for (const m of f.codeText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([\w.:-]+)['"]/g)) c.set(m[1], [m[2]]);
  for (const m of f.codeText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\s*\(\s*)?\[([^\]]*)\]/g)) { const v = [...m[2].matchAll(/['"]([\w.:-]+)['"]/g)].map(x => x[1]); if (v.length) c.set(m[1], v); }
  return (f.consts = c);
}
rule({ id: 'PRIV-006', sev: 'Medium', area: 'privacy', title: '"Forget everything" leaves some of what the app keeps in the browser',
  fix: 'Remove every key the app writes (keep the list in one place, or remove by a shared prefix).',
  run(idx) {
    const keys = new Map();
    for (const f of idx.files) {
      if (f.isTest || !f.browser) continue;
      const c = constantsOf(f);
      f.code.forEach((l, i) => {
        for (const m of l.matchAll(/\blocalStorage\.setItem\s*\(\s*(?:['"]([\w.:-]+)['"]|([A-Za-z_$][\w$]*)\s*,)/g)) {
          const k = m[1] || (c.get(m[2]) || [])[0];
          if (k && (m[1] || (c.get(m[2]) || []).length === 1) && !keys.has(k)) keys.set(k, { f, i });
        }
      });
    }
    if (keys.size < 2) return [];
    const out = [];
    for (const [name, ds] of idx.fns) {
      // the app's whole wipe only (forgetAll, wipeAll, clearAll, resetEverything): resetUsageData clears one part on purpose
      if (!/^_?(forget|wipe|erase)\w*$|^_?(clear|delete|remove|reset)_?(all|everything|data|local_?data|storage|device|browser)$/i.test(name)) continue;
      for (const d of ds) {
        if (!d.f.browser || !/localStorage\.removeItem/.test(d.body) || /localStorage\.clear\s*\(|Object\.keys\s*\(\s*localStorage|startsWith|for\s*\([^)]*localStorage\.length|localStorage\.key\s*\(/.test(d.body)) continue;
        const c = constantsOf(d.f);
        const named = new Set([...d.body.matchAll(/['"]([\w.:-]+)['"]/g)].map(m => m[1]));
        let unknown = false;
        for (const m of d.body.matchAll(/localStorage\.removeItem\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
          const loopVar = new RegExp('function\\s*\\(\\s*' + esc(m[1]) + '\\b|\\(?\\s*' + esc(m[1]) + '\\s*\\)?\\s*=>|\\b(const|let|var)\\s+' + esc(m[1]) + '\\s+(of|in)\\b').test(d.body);
          if (c.has(m[1]) && !loopVar) { c.get(m[1]).forEach(k => named.add(k)); continue; }
          // a loop variable: over a list constant in this file (KEYS.forEach(k => ...), for (const k of KEYS))
          const list = [...d.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.forEach\s*\(|\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+([A-Za-z_$][\w$]*)/g)].map(x => x[1] || x[2]).filter(n => c.has(n));
          if (list.length) list.forEach(n => c.get(n).forEach(k => named.add(k))); else unknown = true;
        }
        if (unknown) continue;
        const left = [...keys.keys()].filter(k => !named.has(k));
        if (left.length) out.push({ f: d.f, i: d.i, title: name + '() leaves ' + left.slice(0, 3).join(', ') + (left.length > 3 ? ' …' : '') + ' in the browser (the app keeps ' + keys.size + ' keys; it removes ' + (keys.size - left.length) + ')' });
      }
    }
    return out;
  } });

// ROUTE-001: the page calls an /api/ address the server has no route for.
rule({ id: 'ROUTE-001', sev: 'Medium', area: 'code', title: 'The page calls an API address the server has no route for (that button always fails)',
  fix: 'Add the route on the server, or point the page at the address that exists.',
  run(idx) {
    const known = [];
    for (const f of idx.files) {
      if (f.isTest) continue;
      const api = /(?:^|\/)(api\/.+)$/i.exec(f.rel);
      // Next.js: app/api/x/[id]/route.ts and pages/api/x.ts are routes by their place
      const next = /(?:^|\/)app\/((?:[^/]+\/)*?api(?:\/[^/]+)*)\/route\.[mc]?[jt]sx?$/i.exec(f.rel) || /(?:^|\/)pages\/(api(?:\/[^/]+)*?)(?:\/index)?\.[mc]?[jt]sx?$/i.exec(f.rel);
      if (next) {
        const p = '/' + next[1].replace(/\([^)]*\)\//g, '').replace(/\[\[?\.\.\.[^\]]+\]\]?/g, '*').replace(/\[[^\]]+\]/g, ':p');
        known.push(p.includes('*') ? { p: p.slice(0, p.indexOf('*')), prefix: true } : { p, prefix: false });
      }
      if (api && /\.(php|py)$/i.test(f.name)) { known.push({ p: '/' + api[1], prefix: false }); known.push({ p: '/' + api[1].replace(/\.(php|py)$/i, ''), prefix: false }); if (/index\.php$/i.test(f.name)) known.push({ p: '/' + api[1].replace(/index\.php$/i, ''), prefix: true }); }
      if (f.browser) continue;
      const t = f.codeText.replace(/\\\//g, '/');
      for (const m of t.matchAll(/\/api\/[A-Za-z0-9_\-\/.:{}*]*/g)) {
        const next = t[m.index + m[0].length] || '';
        const before = t.slice(Math.max(0, m.index - 30), m.index);
        if (/fetch\s*\(\s*['"`]?$/.test(before)) continue;
        known.push({ p: m[0].replace(/\/+$/, '') || '/api', prefix: !/['"`\s,)]/.test(next) || m[0].endsWith('/') || /\*/.test(m[0]) || /\b(use|startsWith|indexOf|match|test)\s*\(\s*['"`]?$|\(\s*\^?$|\^$/.test(before) });
      }
      if (/RewriteRule[^\n]*api/i.test(f.text)) known.push({ p: '/api', prefix: true });
    }
    if (known.length < 2) return [];
    const seg = p => p.replace(/\/+$/, '').split('/');
    const matches = p => known.some(k => {
      if (k.p === p) return true;
      if (k.prefix && p.startsWith(k.p)) return true;
      const a = seg(k.p), b = seg(p);
      return a.length === b.length && a.every((s, n) => s === b[n] || /^[:{*(]|^\$/.test(s) || /^:p$/.test(b[n]));
    });
    const out = [];
    for (const f of idx.files) {
      if (f.isTest || !f.browser) continue;
      for (let i = 0; i < f.lines.length; i++) {
        for (const m of f.lines[i].matchAll(/\b(?:fetch|axios\.(?:get|post|put|delete|patch)|\$\.(?:get|post|getJSON|ajax))\s*\(\s*(['"`])(\/api\/[^'"`?#]*)(\1|\$\{|['"`]?\s*\+)?/g)) {
          let p = m[2].replace(/\$\{[^}]*\}/g, ':p');
          if (m[3] && m[3] !== m[1] && p.endsWith('/')) p += ':p';
          p = p.replace(/\/+$/, '');
          if (!p || matches(p)) continue;
          out.push({ f, i, title: 'The page calls ' + p + ', and the server has no route for it (that action always fails)' });
          break;
        }
        if (out.length && out[out.length - 1].f === f) break;
      }
    }
    return out;
  } });

// FEAT-001: a feature switched off in the browser's settings, while its server address still answers.
rule({ id: 'FEAT-001', sev: 'Medium', area: 'auth', title: 'A feature switched off only in the page\'s settings still answers on the server',
  fix: 'Check the same switch on the server (answer 404 or 403 when it is off); the page\'s settings only hide the button.',
  run(idx) {
    const off = [];
    for (const f of idx.files) {
      if (f.isTest || !f.browser) continue;
      for (const m of f.codeText.matchAll(/\b(FEATURES|features|FLAGS|flags|featureFlags|feature_flags)\s*=\s*\{([^}]*)\}/g)) {
        for (const k of m[2].matchAll(/['"]?(\w{3,})['"]?\s*:\s*false\b/g)) off.push({ key: k[1], f });
      }
    }
    const out = [];
    for (const { key } of off) {
      const word = new RegExp('(^|[\\/_.-])' + esc(key) + '([\\/_.-]|$)', 'i');
      for (const f of idx.files) {
        if (f.isTest || f.browser || !/\.(php|py|m?js|cjs|ts)$/i.test(f.name) || !word.test(f.rel.replace(/\.\w+$/, ''))) continue;
        if (new RegExp('(feature|flag|enabled?|switch)\\w*\\W{1,6}[\'"]?' + esc(key) + '|' + esc(key) + '\\w*\\W{1,4}(enabled?|on|off)\\b', 'i').test(f.codeText)) continue;
        const i = Math.max(0, f.code.findIndex(l => l.trim() && !/^<\?php\s*$/.test(l.trim())));
        out.push({ f, i, title: 'The "' + key + '" feature is switched off in the page\'s settings, but ' + f.rel + ' still answers' });
      }
    }
    return out;
  } });

// INST-001: install notes promise an older PHP or Node than the code needs.
const PHP_NEWER = [[/\bCURLOPT_PROTOCOLS_STR\b|\bCURLOPT_REDIR_PROTOCOLS_STR\b/, '8.3', 'CURLOPT_PROTOCOLS_STR'], [/(?<![\w>:$])json_validate\s*\(/, '8.3', 'json_validate()'], [/(?<![\w>:$])mb_str_pad\s*\(|(?<![\w>:$])array_find\s*\(|(?<![\w>:$])array_any\s*\(|(?<![\w>:$])array_all\s*\(/, '8.4', 'an 8.4 function'],
  [/\bFILTER_FLAG_GLOBAL_RANGE\b/, '8.2', 'FILTER_FLAG_GLOBAL_RANGE'], [/\bRandom\\Randomizer\b|\bnew\s+Randomizer\s*\(/, '8.2', 'Random\\Randomizer'], [/(?<![\w>:$])array_is_list\s*\(/, '8.1', 'array_is_list()'],
  [/(?<![\w>:$])str_(contains|starts_with|ends_with)\s*\(/, '8.0', 'str_contains()']];
const NODE_NEWER = [[/['"]node:sqlite['"]/, 22, 'node:sqlite'], [/\bprocess\.loadEnvFile\s*\(/, 21, 'process.loadEnvFile'], [/\bObject\.groupBy\s*\(|\bMap\.groupBy\s*\(/, 21, 'Object.groupBy'],
  [/\bfs\.globSync\s*\(|\bglobSync\s*\(/, 22, 'fs.globSync'], [/\.toSorted\s*\(|\.toReversed\s*\(|\.toSpliced\s*\(/, 20, 'toSorted()'], [/\bPromise\.withResolvers\s*\(/, 22, 'Promise.withResolvers']];
const ver = s => s.split('.').map(Number).reduce((a, n, k) => a + n / Math.pow(100, k), 0);
rule({ id: 'INST-001', sev: 'Medium', area: 'install', title: 'The install notes say an older PHP or Node is enough, but the code uses something only a newer one has',
  fix: 'Raise the version in the install notes (and in the installer\'s check), or replace the newer call.',
  run(idx) {
    const notes = [...idx.docs, ...idx.files.filter(f => /^(install|readme|requirements|setup|composer\.json|package\.json)/i.test(f.name))];
    let php = null, node = null;
    for (const d of notes) {
      const t = d.text;
      const p = /\bPHP\s*(?:version\s*)?(?:>=?\s*|v)?(\d\.\d)\s*(\+|or\s+(newer|later|above|higher))/i.exec(t) || /"php"\s*:\s*"\s*(?:>=|\^|~)\s*(\d\.\d)/.exec(t);
      if (p && (!php || ver(p[1]) < ver(php.v))) php = { v: p[1], d };
      const n = /\bNode(?:\.js)?\s*(?:version\s*)?(?:>=?\s*|v)?(\d{2})(?:\.\d+)*\s*(\+|or\s+(newer|later|above|higher))/i.exec(t) || /"node"\s*:\s*"\s*(?:>=|\^|~)\s*(\d{2})/.exec(t);
      if (n && (!node || +n[1] < node.v)) node = { v: +n[1], d };
    }
    const out = [];
    if (php) {
      done: for (const [re, need, what] of PHP_NEWER) {
        if (ver(need) <= ver(php.v)) continue;
        if (idx.files.some(f => new RegExp('function_exists\\s*\\(\\s*[\'"]' + esc(what.replace(/\(\)$/, '')) + '|defined\\s*\\(\\s*[\'"]' + esc(what)).test(f.codeText))) continue;
        for (const f of idx.files) {
          if (f.isTest || !PHP.test(f.name)) continue;
          const i = f.code.findIndex(l => re.test(codeOf(l)) || re.test(l));
          if (i >= 0) { out.push({ f, i, title: (php.d.rel || 'The install notes') + ' says PHP ' + php.v + ' is enough, but the code uses ' + what + ' (PHP ' + need + ')' }); break done; }
        }
      }
    }
    if (node) {
      done2: for (const [re, need, what] of NODE_NEWER) {
        if (need <= node.v) continue;
        for (const f of idx.files) {
          if (f.isTest || f.browser || !JS.test(f.name)) continue;
          const i = f.code.findIndex(l => re.test(l));
          if (i >= 0) { out.push({ f, i, title: (node.d.rel || 'The install notes') + ' says Node ' + node.v + ' is enough, but the code uses ' + what + ' (Node ' + need + ')' }); break done2; }
        }
      }
    }
    return out;
  } });

// HTA-004: code writes a backup, dump or log into the web folder, and the server's deny rules there do not cover it.
rule({ id: 'HTA-004', sev: 'High', area: 'exposed files', title: 'Code writes a backup, dump or log into the web folder, and the deny rules there do not cover that kind of file',
  fix: 'Write it outside the web folder; or deny that extension in the web folder\'s .htaccess before the first file is written.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (f.isTest || !SERVER_CODE.test(f.name)) continue;
      for (let i = 0; i < f.code.length; i++) {
        const l = f.code[i];
        if (!/file_put_contents|fopen|ZipArchive|zip|backup|dump|writeFileSync|createWriteStream|copy\s*\(|rename\s*\(|open\s*\(|tar\b|mysqldump|>\s*['"]?\S+/i.test(l)) continue;
        const m = /['"`]([^'"`]*?\/(public_html|public|www|htdocs|web)\/[^'"`]*)['"`][^;]*?\.(zip|tar|gz|tgz|7z|sql|sqlite|db|bak|log|csv|xlsx)\b['"`]/i.exec(l) || /['"`]([^'"`]*?\/(public_html|public|www|htdocs|web)\/[^'"`]*\.(zip|tar|gz|tgz|7z|sql|sqlite|db|bak|log|csv|xlsx))['"`]/i.exec(l);
        if (!m) continue;
        const folder = m[2], ext = m[3];
        const roots = [path.join(idx.dir, path.dirname(f.rel), m[1].replace(/^\.?\/?/, '').split(new RegExp('\\/' + folder + '\\/', 'i'))[0], folder), path.join(idx.dir, folder)];
        const web = roots.find(p => { try { return inProject(idx, p) && fs.statSync(p).isDirectory(); } catch { return false; } });
        if (!web || idx.blocked(path.join(web, 'probe.' + ext))) continue;
        out.push({ f, i, title: 'Code writes .' + ext + ' files into ' + path.relative(idx.dir, web).replace(/\\/g, '/') + '/, and no deny rule there covers .' + ext + ' (they can be downloaded)' });
        break;
      }
    }
    return out;
  } });

// CSP-001 / CACHE-001: server settings against the site's own pages.
function cspOf(line) {
  if (/Content-Security-Policy-Report-Only/i.test(line) || !/Content-Security-Policy/i.test(line)) return null;
  const after = line.slice(line.search(/Content-Security-Policy/i) + 23);
  const s = after.search(/\b(default|script|style|img|connect|font|frame|form|object|base|media|worker|child|manifest)-(src|action|uri|ancestors)\b/i);
  if (s < 0) return null;
  const body = after.slice(s).split(/"\s*[,)>]|"\s*$|"$|`/)[0];
  const dirs = new Map();
  for (const part of body.split(';')) { const w = part.trim().split(/\s+/); if (w[0]) dirs.set(w[0].toLowerCase(), w.slice(1)); }
  return dirs;
}
function hostAllowed(list, host) {
  if (!list) return true;
  return list.some(s => {
    s = s.replace(/^'|'$/g, '').toLowerCase();
    if (s === '*' || s === 'https:' || s === 'http:') return true;
    const h = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (h.startsWith('*.')) return host.endsWith(h.slice(1));
    return h === host;
  });
}
const SENDS_CSP = /Header\s+(always\s+)?(set|add)\s+["']?Content-Security-Policy\b|http-equiv\s*=\s*["']Content-Security-Policy["']|header\s*\(\s*["']Content-Security-Policy\s*:|["']Content-Security-Policy["']\s*[:,]/i;
// Which pages a policy covers: a meta tag its own page; an .htaccess its folder (inside <Files>/<FilesMatch>, only
// the files named); a header set in code the pages in the code's own folder (a guess on the quiet side).
function cspScope(f, i) {
  const base = path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel) + '/';
  if (/http-equiv/i.test(f.code[i])) return p => p === f;
  // set in code (PHP header(), a server's header map): which pages it reaches is not readable, so only its own file
  if (!/(^|\/)\.htaccess$|\.conf$/i.test(f.rel)) return p => p === f;
  let only = null;
  if (/(^|\/)\.htaccess$|\.conf$/i.test(f.rel)) {
    for (let k = i; k >= 0; k--) {
      if (/<\/Files(Match)?>/i.test(f.code[k]) && k !== i) break;
      const m = /<Files(Match)?\s+"?([^">]+)"?\s*>/i.exec(f.code[k]);
      if (m) { const pat = m[2]; only = m[1] ? (n => { try { return new RegExp(pat, 'i').test(n); } catch { return false; } }) : (n => n.toLowerCase() === pat.toLowerCase()); break; }
    }
  }
  return p => p.rel.startsWith(base) && (!only || only(p.name));
}
rule({ id: 'CSP-001', sev: 'Medium', area: 'config', title: 'The Content-Security-Policy blocks the site\'s own features (a form or a script the pages use)',
  fix: 'Allow what the pages use (form-action \'self\', the script\'s host in script-src), and load each page once with the browser console open.',
  run(idx) {
    const out = [];
    const allPages = idx.files.filter(f => !f.isTest && MARKUP.test(f.name));
    for (const f of idx.all) {
      if (f.isTest || !/\.(htaccess|conf|html?|php|m?js|cjs|ts)$|(^|\/)\.htaccess$/i.test(f.rel)) continue;
      for (let i = 0; i < f.code.length; i++) {
        // only a policy that is SENT: an Apache Header line, a meta tag, a PHP header() call or a header map entry
        if (!SENDS_CSP.test(f.code[i])) continue;
        const csp = cspOf(f.code[i]);
        if (!csp) continue;
        const pages = allPages.filter(cspScope(f, i));
        const fa = csp.get('form-action');
        if (fa) {
          // a form the page's script sends itself (submit handler with preventDefault) never posts, so it is not blocked
          const form = pages.filter(p => !/preventDefault\s*\(/.test(p.text)).map(p => ({ p, k: p.lines.findIndex(l => /<form\b/i.test(l)) })).find(x => x.k >= 0);
          if (form && (fa.includes("'none'") || !fa.some(s => /^'self'$|^\*$|^https?:$/.test(s)) && /<form\b(?![^>]*action\s*=\s*["']?https?:)/i.test(form.p.lines[form.k]))) {
            out.push({ f, i, title: 'The Content-Security-Policy says form-action ' + fa.join(' ') + ', so the form in ' + form.p.rel + ' cannot be sent' });
            break;
          }
        }
        const ss = csp.get('script-src') || csp.get('default-src');
        if (ss) {
          let hit = null;
          for (const p of pages) {
            for (const m of p.text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) if (!hostAllowed(ss, m[1].toLowerCase())) { hit = { p, host: m[1] }; break; }
            if (hit) break;
          }
          if (hit) { out.push({ f, i, title: 'The Content-Security-Policy does not allow scripts from ' + hit.host + ', which ' + hit.p.rel + ' loads (the browser blocks it)' }); break; }
        }
      }
    }
    return out.slice(0, 2);
  } });
rule({ id: 'CACHE-001', sev: 'Medium', area: 'caching', title: 'Scripts and styles are cached for a long time, but the pages link them with no version in the address (visitors keep old files after an update)',
  fix: 'Add the release version (?v=1.2.3) or a content hash to each script and style address, or shorten the cache time.',
  run(idx) {
    const out = [];
    for (const h of idx.all.filter(f => /(^|\/)\.htaccess$/.test(f.rel))) {
      // which file names get a long cache: the FilesMatch patterns whose Cache-Control says immutable or 30+ days
      const long = [];
      const lasting = b => b.split(/\r?\n/).some(l => /Cache-Control/i.test(l) && /immutable|max-age\s*=\s*(\d{8,}|[3-9]\d{6})/i.test(l));
      for (const m of h.code.join('\n').matchAll(/<FilesMatch\s+"?([^">]+)"?\s*>([\s\S]*?)<\/FilesMatch>/gi)) {
        if (!lasting(m[2])) continue;
        try { long.push(new RegExp(m[1], 'i')); } catch {}
      }
      if (/ExpiresByType\s+(text\/css|application\/(x-)?javascript|text\/javascript)\s+["']?access\s+plus\s+(\d+\s+)?(year|month)/i.test(h.codeText)) long.push(/\.(js|css)$/i);
      if (!long.length) continue;
      const base = path.posix.dirname(h.rel) === '.' ? '' : path.posix.dirname(h.rel) + '/';
      for (const p of idx.files) {
        if (p.isTest || !/\.(html?|php)$/i.test(p.name) || !p.rel.startsWith(base)) continue;
        let hit = -1;
        p.lines.some((l, i) => {
          const m = /<script\b[^>]*\bsrc\s*=\s*["'](?!https?:|\/\/)([^"'?]+\.js)["']|<link\b(?=[^>]*stylesheet)[^>]*\bhref\s*=\s*["'](?!https?:|\/\/)([^"'?]+\.css)["']/i.exec(l);
          if (!m || /[.-][0-9a-f]{6,}\.(js|css)["']|\.\d+\.\d+(\.\d+)?\.(js|css)["']|<\?|\{\{/i.test(m[0])) return false;
          const name = path.posix.basename(m[1] || m[2]);
          if (!long.some(re => re.test(name))) return false;
          hit = i; return true;
        });
        if (hit < 0) continue;
        out.push({ f: p, i: hit, title: 'Scripts and styles are cached for a long time (' + h.rel + '), but ' + p.rel + ' links them with no version in the address' });
        break;
      }
    }
    return out;
  } });

// TEST-001: a test file that asserts nothing and prints a skip, or exits 0, so the suite passes without testing.
rule({ id: 'TEST-001', sev: 'Medium', area: 'tests', title: 'A test file checks nothing: it skips or exits with success, so the suite passes without testing',
  fix: 'Make the skipped test run (a test database, a fake), or fail loudly when it cannot run; a pass must mean something was checked.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (!f.isTest || !/\.(m?js|cjs|ts|py|php|sh)$/i.test(f.name) || /(^|\/)(fixtures?|museum|helpers?|support|mocks?)\//i.test(f.rel)) continue;
      // any way to fail counts as testing: an assert, a thrown error, a failure counter ($fail++, failures), a check()
      if (/\b(assert\w*|expect|should|deepEqual|strictEqual|ok\s*\(|check\s*\(|fail(s|ed|ures?)?\b|throw\b|raise\b|pytest|unittest|PHPUnit|\$this->assert|test\s*\(|it\s*\(|describe\s*\()/i.test(f.codeText)) continue;
      if (/process\.exit\s*\(\s*[1-9]|sys\.exit\s*\(\s*[1-9]|\bexit\s*\(?\s*[1-9]/.test(f.codeText)) continue;
      const i = f.code.findIndex(l => /^\s*(console\.(log|info|warn)|print|echo)\b.*\bskip/i.test(l));
      const j = f.code.findIndex(l => /process\.exit\s*\(\s*0\s*\)|sys\.exit\s*\(\s*0\s*\)|^\s*exit\s*\(?\s*0\b/.test(l));
      if (i < 0 && j < 0) continue;
      out.push({ f, i: i >= 0 ? i : j });
    }
    return out;
  } });

// ---- data routes and tables open to anyone, unsigned payment events, leftover test routes ----
// Faults that apps built quickly (often with an AI helper) tend to ship. The file's shape decides what is a route;
// anything that looks like a check silences the rule, because a route that wrongly fires costs more trust than one missed.
const NEXT_APP_ROUTE = /(^|\/)app\/(?:[^\n]*\/)?route\.(?:m?js|tsx?)$/i;
const NEXT_PAGES_API = /(^|\/)pages\/api\/[^\n]*\.(?:m?js|tsx?)$/i;
const NODE_APP = /\brequire\(\s*['"](?:express|fastify)['"]\s*\)|\bfrom\s+['"](?:express|fastify|hono)['"]|\bexpress\.Router\s*\(|\bnew\s+Hono\b/;
const ROUTE_LINE = /\b(?:app|router|api|server|fastify|\w{1,30}(?:Router|Routes))\.(get|post|put|patch|delete|all)\s*\(\s*['"`](\/[^'"`\n]{0,200})['"`]\s*,(.*)$/;
// router.route('/:id').get(getUser).delete(protect, deleteUser), on one line or several
const ROUTE_CHAIN = /\b(?:app|router|api|server|fastify|\w{1,30}(?:Router|Routes))\.route\s*\(\s*['"`](\/[^'"`\n]{0,200})['"`]\s*\)(.*)$/;
const NOT_LIVE_DIR = /(^|\/)(tests?|spec|__tests__|fixtures?|e2e|museum|mocks?|__mocks__|examples?|demos?|stubs?|tools|scripts)\//i;
const appRoot = rel => rel.replace(/(?:^|\/)(?:src\/)?(?:app|pages)\/[^\n]*$/, '');
// A Next.js route file's address: (group) folders and the file's own name dropped.
function nextRoutePath(rel) {
  const m = /(?:^|\/)(?:app|pages)\/([^\n]*)$/.exec(rel);
  return '/' + m[1].replace(/\.(?:m?js|tsx?)$/i, '').split('/').filter(p => !/^\(.*\)$/.test(p) && p !== 'route' && p !== 'index').join('/');
}
// The routes a file answers: [{ path, method, i, args, body }]. For Next.js the file is one route, and each exported
// function of a 'use server' file is one (anyone can call a server action). For a node server, each route's body runs to
// the next route. At most 80 lines a body, at most 500 routes a file.
const USE_SERVER_FILE = /^\s*['"]use server['"]/;
const EXPORTED_ACTION = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]{0,60})|^\s*export\s+const\s+([A-Za-z_$][\w$]{0,60})\s*=/;
// SvelteKit's routes/**/+server.ts and Nuxt's server/api/**: one route a file, like Next.js. server/routes/ is also an
// Express folder name, so a Nuxt file must say defineEventHandler.
const SVELTE_ROUTE = /(?:^|\/)routes\/(?:[^\n]*\/)?\+server\.(?:m?js|ts)$/i;
const NUXT_ROUTE = /(?:^|\/)server\/(api|routes)\/([^\n]*)\.(?:m?js|ts)$/i;
const NUXT_HANDLER = /\b(?:defineEventHandler|eventHandler|defineCachedEventHandler)\b/;
const routeParts = parts => parts.filter(p => !/^\(.*\)$/.test(p) && p !== 'index' && p !== '+server');
// 'use server' inside a function under app/: an action of that page, open to anyone who can post to the page. The page's
// own address is kept, because a middleware over the page does cover its inline actions.
const APP_FILE = /(?:^|\/)app\/([^\n]*\.(?:m?js|tsx?|jsx))$/i;
const INLINE_USE_SERVER = /(?:^[ \t]*|\{[ \t]{0,20})['"]use server['"]/;
const ACTION_OPENS = /\bfunction\s{1,20}([A-Za-z_$][\w$]{0,60})\s{0,20}\(|\b(?:const|let|var)\s{1,20}([A-Za-z_$][\w$]{0,60})\s{0,20}=\s{0,20}async\b|\b(?:action|formAction)\s{0,20}=\s{0,20}\{\s{0,20}async\b/;
function inlineActions(f, rel) {
  const page = '/' + routeParts(rel.split('/').slice(0, -1)).join('/');
  const out = [];
  // a page holds a handful: 50 is far past any honest one, and each body is read several times over
  for (let i = 1; i < f.code.length && out.length < 50; i++) {
    if (!INLINE_USE_SERVER.test(f.code[i])) continue;
    let k = i, m = null;
    for (; k >= i - 3 && k >= 0; k--) if ((m = ACTION_OPENS.exec(f.code[k]))) break;
    if (!m) continue; // not a shape read here: left alone
    const name = m[1] || m[2] || '';
    const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    out.push({ path: page, label: name ? 'The server action ' + name : 'A server action on the page ' + page, action: true, inline: true,
      words: [...kebab.split('-'), kebab, ...routeWordsOf(page)].filter(Boolean), i: k, args: '', body: blockFrom(f.code, k, 80) });
  }
  return out;
}
function otherFileRoute(f) {
  if (SVELTE_ROUTE.test(f.rel)) {
    const at = f.rel.search(/(?:^|\/)routes\//);
    return { kind: 'svelte', base: f.rel.slice(0, Math.max(at, 0)), path: '/' + routeParts(f.rel.slice(at).replace(/^\/?routes\//, '').replace(/\.\w+$/, '').split('/')).join('/') };
  }
  const n = NUXT_ROUTE.exec(f.rel);
  if (n && NUXT_HANDLER.test(f.codeText)) {
    const parts = routeParts(n[2].replace(/\.(?:get|post|put|patch|delete|head|options)$/i, '').split('/'));
    return { kind: 'nuxt', base: f.rel.slice(0, n.index), path: '/' + (n[1].toLowerCase() === 'api' ? ['api', ...parts] : parts).join('/') };
  }
  return null;
}
// Each method of a router.route(...) chain is a route of its own, with what stands in its brackets as its body. Returns
// the last line read, so a chain is read only once. At most 80 lines a chain.
function chainedRoutes(code, i, c, found) {
  let depth = 0, open = null, last = i;
  const start = c.index + c[0].length - c[2].length;
  for (let k = i; k < Math.min(code.length, i + 80) && found.length < 500; k++) {
    const raw = code[k];
    const plain = raw.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, s => '"'.repeat(s.length));
    if (k > i && depth === 0 && plain.trim() && !plain.trimStart().startsWith('.')) break;
    last = k;
    for (let j = k === i ? start : 0; j < plain.length; j++) {
      const ch = plain[j];
      if (depth === 0) {
        if (ch === ';') return k;
        const m = ch === '.' ? /^\.(get|post|put|patch|delete|all)\s*\(/.exec(plain.slice(j, j + 16)) : null;
        if (m) {
          j += m[0].length;
          open = { method: m[1], path: c[1], i: k, rest: raw.slice(j), lines: [raw.slice(j)] };
          found.push(open);
          depth = 1;
          j--;
          continue;
        }
      }
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
        if (depth === 0 && open) {
          const from = open.i === k ? raw.length - open.lines[0].length : 0;
          open.lines[open.lines.length - 1] = raw.slice(from, j);
          if (open.i === k) open.rest = open.lines[0];
          open.body = open.lines.join('\n');
          open = null;
        }
      }
    }
    if (open) open.lines.push(code[k + 1] === undefined ? '' : code[k + 1]);
  }
  if (open) open.body = open.lines.join('\n');
  return last;
}
function routesIn(f) {
  if (f.routes) return f.routes;
  f.routes = [];
  if (NEXT_APP_ROUTE.test(f.rel) || NEXT_PAGES_API.test(f.rel)) {
    if (!NOT_LIVE_DIR.test(appRoot(f.rel)) && !/\.(test|spec)\.\w+$/i.test(f.name)) f.routes.push({ path: nextRoutePath(f.rel), label: 'The route ' + nextRoutePath(f.rel), next: true, i: 0, args: '', body: f.codeText });
    return f.routes;
  }
  const other = otherFileRoute(f);
  if (other) {
    if (!NOT_LIVE_DIR.test(other.base + '/')) f.routes.push({ path: other.path, label: 'The route ' + other.path, next: true, hooks: other, i: 0, args: '', body: f.codeText });
    return f.routes;
  }
  if (/\.(m?js|tsx?|jsx)$/i.test(f.name) && !f.isTest && !NOT_LIVE_DIR.test(f.rel) && USE_SERVER_FILE.test(f.codeText)) {
    const found = [];
    for (let i = 0; i < f.code.length && found.length < 500; i++) {
      const m = EXPORTED_ACTION.exec(f.code[i]);
      if (m) found.push({ name: m[1] || m[2], i });
    }
    found.forEach((a, n) => {
      const body = f.code.slice(a.i, Math.min(n + 1 < found.length ? found[n + 1].i : f.code.length, a.i + 80)).join('\n');
      // the name is read as words (signUp: sign, up, sign-up); it is not a call to a check (a function called getUser)
      const kebab = a.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      f.routes.push({ path: '/' + kebab, label: 'The server action ' + a.name, action: true, words: [...kebab.split('-'), kebab], i: a.i, args: '', body, check: body.replace(a.name, '') });
    });
    return f.routes;
  }
  const inApp = !f.isTest && !/\.(test|spec)\.\w+$/i.test(f.name) && !NOT_LIVE_DIR.test(appRoot(f.rel)) && f.codeText.includes('use server') ? APP_FILE.exec(f.rel) : null;
  if (inApp) {
    f.routes = inlineActions(f, inApp[1]);
    if (f.routes.length) return f.routes;
  }
  if (f.isTest || NOT_LIVE_DIR.test(f.rel) || /mock|dev-server/i.test(f.name) || !/\.(m?js|cjs|ts)$/i.test(f.name) || !NODE_APP.test(f.codeText)) return f.routes;
  const found = [];
  for (let i = 0; i < f.code.length && found.length < 500; i++) {
    const m = ROUTE_LINE.exec(f.code[i]);
    if (m) { found.push({ method: m[1], path: m[2], i, rest: m[3] }); continue; }
    const chain = f.code[i].includes('.route') ? ROUTE_CHAIN.exec(f.code[i]) : null;
    if (chain) i = chainedRoutes(f.code, i, chain, found);
  }
  found.forEach((r, n) => {
    const end = Math.min(f.code.length, n + 1 < found.length ? found[n + 1].i : f.code.length, r.i + 80);
    const body = r.lines ? r.body : f.code.slice(r.i, end).join('\n');
    // what stands before the handler is the route's own checks: app.get('/x', requireUser, (req, res) => ...)
    const args = (r.rest.trim() ? r.rest : f.code[r.i + 1] || '').split(/=>|\bfunction\b/)[0];
    f.routes.push({ path: r.path, label: 'The route ' + r.path, method: r.method, i: r.i, args, body, chained: !!r.lines });
  });
  return f.routes;
}
const routeWordsOf = path_ => path_.toLowerCase().split('/').filter(s => s && !/^[:[]/.test(s)).map(s => s.replace(/\.\w{1,5}$/, ''));
// A leftover is the first real part of the address: /api/debug or /admin/reset, not /api/quiz/test. With a dynamic part
// straight after it, /api/test/[id] is a feature (a quiz app's exam).
const firstWord = words => words.filter(w => !/^(?:api|admin|v\d+|internal|dev)$/.test(w))[0] || '';
// A router file's addresses start wherever another file mounts it: app.use('/api/users', usersRouter).
const moduleBase = p => p.split('/').pop().replace(/\.\w+$/, '');
function mountOf(idx, f) {
  // every mount of the project, named by the file it loads, found once a scan
  if (!idx.mounts) {
    idx.mounts = new Map();
    for (const g of idx.files) {
      if (g.isTest || !JS.test(g.name) || !g.codeText.includes('.use')) continue;
      const loaded = new Map();
      for (const m of g.codeText.matchAll(/\b(?:const|let|var|import)\s+([A-Za-z_$][\w$]{0,40})\b[^\n]{0,80}?['"`]([^'"`\n]{1,160})['"`]/g)) loaded.set(m[1], moduleBase(m[2]));
      g.code.forEach((l, i) => {
        const m = /\.use\s*\(\s*['"`](\/[^'"`\n]{0,100})['"`]\s*,(.{0,300})$/.exec(l);
        if (!m) return;
        const inline = /['"`]([^'"`\n]{1,160})['"`]/.exec(m[2]);
        const name = (/([A-Za-z_$][\w$]{0,40})\s*\)\s*;?\s*$/.exec(m[2]) || [])[1];
        const base = inline ? moduleBase(inline[1]) : loaded.get(name);
        if (base && !idx.mounts.has(base)) idx.mounts.set(base, { g, i, line: l, prefix: m[1] });
      });
    }
  }
  const x = idx.mounts.get(f.name.replace(/\.\w+$/, ''));
  return x && x.g !== f ? x : null;
}
const isRouterFile = f => /\bRouter\s*\(/.test(f.codeText) && !/\bexpress\s*\(\s*\)/.test(f.codeText);
// routesIn, with a router file's real address (or its file name standing in for one it cannot name) and the address's words.
function routesOf(idx, f) {
  const list = routesIn(f);
  if (f.routesRead) return list;
  f.routesRead = true;
  const router = list.length && !list[0].next && !list[0].action && isRouterFile(f);
  const mount = router ? mountOf(idx, f) : null;
  for (const r of list) {
    r.local = r.path;
    r.router = !!router;
    r.mount = mount;
    if (mount) { r.path = mount.prefix.replace(/\/$/, '') + (r.path === '/' ? '' : r.path); r.label = 'The route ' + r.path; }
    else if (router) r.label = 'The route ' + r.path + ' in this router file';
    r.words = r.words || routeWordsOf(r.path);
    if (router && !mount) r.words.push(f.name.replace(/\.\w+$/, '').toLowerCase());
  }
  return list;
}
const isLeftover = r => !r.action && LEFTOVER_ROUTE.test(firstWord(r.words)) && !/\/test\/[:[]/i.test(r.path);

// Saving, changing and reading: the usual database libraries, written so a word in a message does not count.
const FROM_TABLE = String.raw`\.from\s*\(\s*['"${'`'}][\w.-]{1,60}['"${'`'}]\s*\)\s*\.\s*`;
const DB_CREATE = new RegExp(String.raw`\b(?:prisma|db|tx|ctx\.db|ctx\.prisma)\.\w{1,40}\.(?:create|createMany)\s*\(|` + FROM_TABLE + String.raw`insert\b|\.(?:insertOne|insertMany)\s*\(|\baddDoc\s*\(|\.collection\s*\([^)\n]{0,80}\)\s*\.\s*add\s*\(|\bdb\s*\.\s*insert\s*\(|['"${'`'}][ \t]{0,5}(?:INSERT\s+INTO|insert\s+into)\s|\bsql\s*${'`'}[ \t\n]{0,10}(?:INSERT|insert)\b|\bnew\s+[A-Z]\w{0,40}\s*\([^)\n]{0,200}\)\s*\.save\s*\(|\b(?!Object\b|Reflect\b|Promise\b|Array\b|Date\b|Stripe\b|Joi\b|Yup\b)[A-Z][a-z]\w{0,40}\.create\s*\(`);
const DB_CHANGE = new RegExp(String.raw`\bstripe\w{0,10}\.(?:refunds\.create|transfers\.create|payouts\.create|billingPortal\.sessions\.create|subscriptions\.(?:cancel|update|del))\s*\(|\bknex\s*\([^)\n]{0,80}\)[^;\n]{0,200}\.(?:update|del|delete)\s*\(|\b(?:prisma|db|tx|ctx\.db|ctx\.prisma)\.\w{1,40}\.(?:update|updateMany|upsert|delete|deleteMany)\s*\(|` + FROM_TABLE + String.raw`(?:update|upsert|delete)\b|\.(?:updateOne|updateMany|deleteOne|deleteMany|replaceOne|findOneAndUpdate|findOneAndDelete|findByIdAndUpdate|findByIdAndDelete)\s*\(|\.save\s*\(\s*\)|\b(?:setDoc|updateDoc|deleteDoc)\s*\(|\bdb\s*\.\s*(?:update|delete)\s*\(|['"${'`'}][ \t]{0,5}(?:UPDATE\s+\w{1,60}\s+SET\s|DELETE\s+FROM\s|update\s+\w{1,60}\s+set\s|delete\s+from\s)|\bsql\s*${'`'}[ \t\n]{0,10}(?:UPDATE|DELETE|update|delete)\b`);
const DB_READ = new RegExp(String.raw`\bknex\s*\(\s*['"]\w{1,60}['"]\s*\)|\b(?:prisma|db|tx|ctx\.db|ctx\.prisma)\.\w{1,40}\.(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\s*\(|` + FROM_TABLE + String.raw`select\b|\b(?!Object\b|Array\b|Promise\b)[A-Z][a-z]\w{0,40}\.(?:find\s*\(\s*[{)]|findOne\s*\(|findById\s*\(|findAll\s*\()|\.collection\s*\([^)\n]{0,80}\)\s*\.\s*(?:find|findOne|get)\s*\(|\b(?:getDocs|getDoc)\s*\(|\b(?:db|pool|conn|connection|client)\s*\.\s*query\s*\(|\bdb\s*\.\s*(?:execute|all|get|select|prepare)\s*\(|\bsql\s*${'`'}[ \t\n]{0,10}(?:SELECT|select)\b|['"${'`'}][ \t]{0,5}(?:SELECT|select)\s[^'"${'`'}\n]{0,200}\b(?:FROM|from)\b`);
const DB_TARGET = /\b(?:prisma|db|tx)\.(\w{1,40})\.|\.from\s*\(\s*['"`]?([\w-]{1,60})|\bcollection\s*\(\s*(?:\w{1,20}\s*,\s*)?['"`]([\w-]{1,60})|\b(?:FROM|INTO|UPDATE|from|into|update)\s+["`]?(\w{1,60})|^([A-Z]\w{1,40})\.|\bdb\s*\.\s*(?:insert|update|delete)\s*\(\s*(\w{1,60})/;
const targetAt = (text, m) => { const t = DB_TARGET.exec(text.slice(m.index, m.index + 240)); return t ? (t[1] || t[2] || t[3] || t[4] || t[5] || t[6]) : ''; };
const PERSONAL_DATA = /(?:^|_)(?:users?|profiles?|accounts?|customers?|orders?|payments?|invoices?|subscriptions?|messages?|bookings?|addresses|contacts?|members?|patients?|clients?|employees?|transactions?|sessions?|tokens?|notes?|documents?|carts?)$/;
const isPersonal = t => PERSONAL_DATA.test(t.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
// Parts of an address that are public by nature: sign-in itself, signed events, forms, status pages.
const PUBLIC_ANY = /^(?:auth|login|log-?in|signin|sign-?in|signup|sign-?up|register|logout|log-?out|signout|sign-?out|callback|oauth|forgot|forgot-password|reset-password|verify-email|webhooks?|hooks?|cron|contact|newsletter|subscribe|unsubscribe|waitlist|feedback|track|analytics|revalidate|health|healthz|ping|status|version|checkout|stripe|trpc)$/;
// Saving a new record is what these are for, even with no sign-in.
const PUBLIC_FORM = /^(?:leads?|enquir(?:y|ies)|inquir(?:y|ies)|rsvps?|quotes?|bookings?|appointments?|reservations?|orders?|comments?|reviews?|votes?|likes?|surveys?|applications?|demo|support|tickets?)$/;
// Reading these is what the public does.
const PUBLIC_READ = /^(?:public|blogs?|posts?|articles?|news|products?|catalog|catalogue|categor(?:y|ies)|tags?|faqs?|docs?|pricing|plans?|sitemap|robots|rss|feed|og|search|menus?|events?|gallery|galleries|reviews?|testimonials?|courses?|lessons?|listings?|items?|games?|recipes?|pages?|stats|leaderboard|config|share|shared|invite|embed|countries|cities|locations?|services?|teams?|authors?|comments?|projects?|portfolio|images?|photos?)$/;
const LEFTOVER_ROUTE = /^(?:debug|test|seed|dump|env|wipe|populate|reset|(?:debug|test|seed|reset|wipe)-[\w-]{1,40}|[\w-]{1,40}-(?:debug|test|seed))$/;
const LEFTOVER_ACTS = /^(?:seed|wipe|populate|dump|(?:seed|reset|wipe)-[\w-]{1,40}|[\w-]{1,40}-seed)$/;

// Anything in the file that looks like a check. A helper's name alone is enough, wherever it comes from.
const SESSION_CHECK = /\b(?:get(?:Server)?(?:Auth)?Session|getUserSession|serverSupabaseUser|getIronSession|getKindeServerSession|currentUser|getCurrentUser|getUser|getAuth|getToken|auth|require(?!Env|Db|Database|Dir|Config|Table|Connection|Schema|Field|Param|Body|Method)[A-Z_]\w{0,24}|with\w{0,20}(?:Auth|User|Session|Admin|Login|Protect)\w{0,12}|verify[A-Z_]\w{0,24}|validate(?:Request|Session|Token|User)\w{0,12}|authenticate\w{0,12}|authorize\w{0,12}|isAuthenticated|isLoggedIn|isAdmin|ensure(?!Env|Db|Database|Dir|Config|Table|Connection|Schema)[A-Z_]\w{0,24}|protect\w{0,24}|check\w{0,8}(?:Auth|Session|Admin|Login|Token|User)\w{0,12})\s*\(|\b(?:req|request|ctx|event)\.(?:user|session|auth)\b|\blocals\.(?:user|session|auth|getSession|safeGetSession)\b|\bcontext\.(?:user|session|auth)\b|\berror\s*\(\s*40[13]\b|\bauthorization\b|\bx-[\w-]{0,30}(?:key|secret|token)\b|\btimingSafeEqual\b|\bcookies\s*\(\s*\)|\.cookies\.get\b|\bjwt\.verify\b|\bjwtVerify\b|\.auth\.getUser\b|\b(?:status|statusCode)\s*[:=(]\s*40[13]\b|\.status\s*\(\s*40[13]\s*\)|\bsendStatus\s*\(\s*40[13]\s*\)/i;
const AUTH_IMPORT = /\bimport\b[^;\n]{0,200}\bfrom\s+['"`][^'"`\n]{0,120}(?:auth|session|clerk|kinde|lucia|guard)[^'"`\n]{0,60}['"`]|\brequire\(\s*['"`][^'"`\n]{0,120}(?:auth|session|clerk|guard)[^'"`\n]{0,60}['"`]\s*\)/i;
const SECRET_COMPARED = /[!=]==?\s*`?(?:Bearer\s+\$\{)?process\.env\.(?!NODE_ENV\b)\w{1,60}|process\.env\.(?!NODE_ENV\b)\w{1,60}\s*[!=]==?/;
const NOT_A_HELPER = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|handler|main|run|json|send|respond)$/;
// Each helper is read once a scan, however many routes call it.
function helperHas(idx, memo, re, n) {
  const seen = idx[memo] || (idx[memo] = new Map());
  if (!seen.has(n)) seen.set(n, re.test(idx.bodyOf(n)));
  return seen.get(n);
}
function callsAGuard(idx, text) {
  for (const n of callsIn(codeOf(text))) if (!NOT_A_HELPER.test(n) && idx.defined(n) && helperHas(idx, 'sessionHelpers', SESSION_CHECK, n)) return true;
  return false;
}
// app.use(requireAuth) and app.use('/api', verifyToken, routes) add a check. Setting up sessions
// (app.use(session({ secret }))) checks nobody, and neither does mounting a router merely named for sign-in
// (app.use('/auth', authRoutes), app.use(authController)).
const USE_SETUP_ONLY = /\.use\s*\(\s*(?:['"`][^'"`\n]{0,120}['"`]\s*,\s*)?(?:session|express\.\w{1,20}|cors|helmet|cookieParser|bodyParser\.\w{1,20}|morgan|compression|passport\.(?:initialize|session))\s*\(/;
// admin, role and permission count only as a question (isAdmin, adminOnly, hasRole): a bare admin or roles is usually the
// router being mounted, and a router named for what it holds checks nobody.
const CHECK_NAME = /auth|protect|verify|ensure|require|isLogged|checkJwt|jwt|guard|api_?key(?!s)|(?:^|\.)(?:is|has|check|must|only|can|need)\w{0,20}(?:admin|role|permission)|(?:admin|role|permission)s?[._]?(?:only|check|guard|required?|middleware)/i;
const namesACheck = text => (codeOf(text).match(/[A-Za-z_$][\w$.]*/g) || []).some(n => n !== 'require' && CHECK_NAME.test(n) && !/rout|controller|initialize|passport\.session/i.test(n));
function useAddsCheck(idx, l) {
  if (!/\.use\s*\(/.test(l) || USE_SETUP_ONLY.test(l)) return false;
  const args = l.slice(l.indexOf('.use') + 4);
  if (namesACheck(args)) return true;
  // a project's own function on the line, called or only handed over: what it does decides, whatever it is called
  const names = (codeOf(args).match(/(?<![\w$.])[A-Za-z_$][\w$]{0,60}/g) || []).filter(n => !/rout|controller/i.test(n));
  return callsAGuard(idx, names.map(n => n + '(').join(' '));
}
// app.use((req, res, next) => { ... }): the guard is written out in the call. It counts when its block looks at who is
// calling and can turn them away: one that only logs, sets a header or fills in req.user checks nobody.
const OPENS_FUNCTION = /^\s*(?:async\b\s*)?(?:function\b|\([^()\n]{0,120}\)\s*(?::[^=\n]{0,40})?=>|[A-Za-z_$][\w$]{0,30}\s*=>)/;
const SAYS_NO = /\b(?:status|statusCode)\s*[:=(]\s*40[13]\b|\bsendStatus\s*\(\s*40[13]\b|,\s*40[13]\s*\)|\.code\s*\(\s*40[13]\b|\bwriteHead\s*\(\s*40[13]\b|\bredirect\s*\(|\bthrow\b|\bnext\s*\(\s*(?:new\b|err\b|error\b|e\b|createError\b|[\w$.]{0,30}Error\b)|\b(?:require|verify)[A-Z]\w{0,24}\s*\(/;
const BLOCK_ASKS = text => SESSION_CHECK.test(text.replace(/\b(?:status|statusCode|sendStatus|error)\s*[:=(]\s*40[13]\b/g, ' ')) || SECRET_COMPARED.test(text) || /\b(?:req|request)\.(?:cookies|signedCookies)\b/.test(text);
// A server holds a handful of these: past 200 in a file the rest are not read.
function functionGuards(idx, f, i, after) {
  if (!OPENS_FUNCTION.test(after.trim() ? after : f.code[i + 1] || '')) return false;
  const read = f.guardsRead || (f.guardsRead = new Map());
  if (!read.has(i)) {
    if (read.size >= 200) return false;
    const block = blockFrom(f.code, i, 40);
    read.set(i, (BLOCK_ASKS(block) && SAYS_NO.test(block)) || callsAGuard(idx, block));
  }
  return read.get(i);
}
function useAddsCheckAt(idx, f, i) {
  const l = f.code[i];
  if (useAddsCheck(idx, l)) return true;
  const at = /\.use\s*\(\s*(?:['"`][^'"`\n]{0,120}['"`]\s*,\s*)?/.exec(l);
  return !!at && !USE_SETUP_ONLY.test(l) && functionGuards(idx, f, i, l.slice(at.index + at[0].length));
}
// app.all('/api/*', requireAuth) does what app.use('/api', requireAuth) does. Only a path that takes in others counts, and
// only on a router or an app: Promise.all and db.all are not routes.
const ALL_GUARD = /\b(?:app|router|api|server|fastify|\w{1,30}(?:Router|Routes))\.all\s*\(\s*['"`]([/*][^'"`\n]{0,100})['"`]\s*,(.{0,300})$/;
function allGuardPrefix(idx, f, i) {
  const m = ALL_GUARD.exec(f.code[i]);
  if (!m || !/(?:\*|\(\.\*\))$/.test(m[1])) return null;
  const args = m[2].split(/=>|\bfunction\b/)[0];
  const names = (codeOf(args).match(/(?<![\w$.])[A-Za-z_$][\w$]{0,60}/g) || []).filter(n => !/rout|controller/i.test(n));
  const guards = namesACheck(args) || callsAGuard(idx, names.map(n => n + '(').join(' ')) || functionGuards(idx, f, i, m[2]);
  return guards ? m[1].replace(/\(\.\*\)$/, '*') : null;
}
// Fastify's way of saying the same: app.addHook('onRequest', app.authenticate), or a hook written out in the call.
const REQUEST_HOOK = /\.addHook\s*\(\s*['"`](?:onRequest|preHandler|preValidation|preParsing)['"`]\s*,/;
function hookAddsCheck(code, i) {
  if (!REQUEST_HOOK.test(code[i])) return false;
  return namesACheck(code.slice(i, i + 4).join('\n').split(/\n\s*\}\s*\)/)[0].replace(REQUEST_HOOK, ' '));
}
function fileChecks(idx, f) {
  if (f.checks === undefined) f.checks = SESSION_CHECK.test(f.codeText) || AUTH_IMPORT.test(f.codeText) || SECRET_COMPARED.test(f.codeText) || f.code.some((l, i) => useAddsCheckAt(idx, f, i)) || callsAGuard(idx, f.codeText);
  return f.checks;
}
// Every check added to a node server, found once a scan: { f, i, prefix, scoped }. One in a router's file, or a Fastify
// hook in a file that registers nothing, is scoped: it covers that file only.
function serverGuards(idx) {
  if (idx.guards) return idx.guards;
  idx.guards = [];
  for (const f of idx.files) {
    if (f.isTest || !JS.test(f.name)) continue;
    const hasUse = f.codeText.includes('.use'), hasHook = f.codeText.includes('.addHook'), hasAll = f.codeText.includes('.all');
    if (!hasUse && !hasHook && !hasAll) continue;
    const routerFile = isRouterFile(f), registers = /\.register\s*\(/.test(f.codeText);
    f.code.forEach((l, i) => {
      if (hasUse && useAddsCheckAt(idx, f, i)) {
        const prefix = (/\.use\s*\(\s*['"`](\/[^'"`\n]{0,100})['"`]/.exec(l) || [])[1] || null;
        idx.guards.push({ f, i, prefix, scoped: routerFile || /rout[\w$]*\.use\s*\(/i.test(l) });
      } else if (hasHook && hookAddsCheck(f.code, i)) idx.guards.push({ f, i, prefix: null, scoped: !registers });
      else if (hasAll && l.includes('.all')) {
        const prefix = allGuardPrefix(idx, f, i);
        if (prefix) idx.guards.push({ f, i, prefix, scoped: routerFile || /rout[\w$]*\.all\s*\(/i.test(l) });
      }
    });
  }
  return idx.guards;
}
// A trailing /* or * is a prefix: /api/* takes in /api and all under it, /api* anything that starts so, /* everything.
function pathCovers(prefix, p) {
  if (!prefix) return true;
  const loose = prefix.endsWith('*') && !prefix.endsWith('/*');
  let base = prefix.endsWith('*') ? prefix.slice(0, -1) : prefix;
  if (loose) return p.startsWith(base);
  if (base.endsWith('/')) base = base.slice(0, -1);
  return !base || p === base || p.startsWith(base + '/');
}
// A check covers a route when it stands before it in the same file, on the line that mounts its router, or, for the
// whole server, with no path or a path that takes the route in. One protected mount says nothing about the router
// mounted beside it. A router whose mount cannot be read gets the benefit of the doubt: any check in the project counts.
function guardCovers(idx, f, r) {
  const guards = serverGuards(idx);
  if (guards.some(g => g.f === f && g.i < r.i && pathCovers(g.prefix, r.local))) return true;
  if (r.router && !r.mount) return guards.length > 0;
  if (r.mount && useAddsCheckAt(idx, r.mount.g, r.mount.i)) return true;
  return guards.some(g => !g.scoped && g.f !== f && (!r.mount || g.f !== r.mount.g || g.i < r.mount.i) && pathCovers(g.prefix, r.path));
}
// SvelteKit's hooks.server.ts and Nuxt's server/middleware/ run before every route. They cover one only if they refuse:
// a hook that just fills in event.locals.user checks nobody. A path it names limits it; a negated one cannot be read, so
// it counts as covering.
const HOOK_REFUSES = /\b(?:status|statusCode)\s*[:=(]\s*40[13]\b|\b(?:error|redirect)\s*\(\s*(?:30[1-8]|40[13])\b|\brequire[A-Z]\w{0,24}\s*\(|\bverify[A-Z]\w{0,24}\s*\(/;
function hookPathCovers(text, route) {
  const named = [];
  for (const m of text.matchAll(/\.startsWith\s*\(\s*['"`](\/[^'"`\n]{0,120})['"`]/g)) {
    if (/!\s*[\w$.()]*$/.test(text.slice(Math.max(0, m.index - 60), m.index))) return true;
    named.push(m[1]);
    if (named.length > 50) return true;
  }
  return !named.length || named.some(p => route.startsWith(p));
}
function hooksCover(idx, r) {
  const { kind, base } = r.hooks;
  const key = kind + '|' + base;
  const known = idx.hookFiles || (idx.hookFiles = new Map());
  if (!known.has(key)) {
    const pre = base ? base + '/' : '';
    known.set(key, idx.files.filter(g => g.rel.startsWith(pre) && (kind === 'svelte' ? /^hooks\.server\.(?:m?js|ts)$/i.test(g.rel.slice(pre.length)) : /^server\/middleware\/[^\n]*\.(?:m?js|ts)$/i.test(g.rel.slice(pre.length)))));
  }
  return known.get(key).some(h => HOOK_REFUSES.test(h.codeText) && hookPathCovers(h.codeText, r.path));
}
// Does one matcher of a Next.js middleware cover this address? Read by hand, never run as a pattern: a project's own
// text must not be able to freeze the scan. Anything not understood counts as covering (no finding).
function matcherCovers(p, route) {
  const look = /^\/\(\(\?!/.test(p) ? p.slice(5) : null;
  if (look !== null) {
    // /((?!api|_next/static|favicon.ico).*): every address except those it names
    let depth = 0, cur = '';
    const alts = [];
    for (const c of look) {
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      if (c === '|' && depth === 0) { alts.push(cur); cur = ''; } else cur += c;
    }
    alts.push(cur);
    return !alts.some(a => { const lit = (/^[\w./-]+/.exec(a) || [''])[0].replace(/\/$/, ''); return lit && route.startsWith('/' + lit); });
  }
  const group = /^\/\(([\w|/-]{1,200})\)/.exec(p);
  if (group) return group[1].split('|').some(a => route === '/' + a || route.startsWith('/' + a + '/'));
  const open = /\/:\w{1,30}[*+]$|\/\(\.\*\)$|\(\.\*\)$/.exec(p);
  const base = open ? p.slice(0, open.index) : p;
  if (/[()[\]*+?]/.test(base)) return true;
  const want = base.split('/'), have = route.split('/');
  if (!open ? want.length !== have.length : want.length > have.length) return false;
  return want.every((w, n) => w[0] === ':' || w === have[n] || /^\[/.test(have[n] || ''));
}
const MIDDLEWARE_CHECK = /\b(?:auth|authMiddleware|getToken|withAuth|getSession|getServerSession|updateSession|getUser|jwtVerify|verifyToken|verifySession|protect|redirectToSignIn)\b|\.cookies\.get\b|next-auth\/middleware/;
// Is this matcher a shape read in full? (matcherCovers says yes to the ones it cannot read.)
function matcherIsRead(p) {
  if (/^\/\(\(\?!/.test(p)) return false;
  if (/^\/\(([\w|/-]{1,200})\)/.test(p)) return true;
  const open = /\/:\w{1,30}[*+]$|\/\(\.\*\)$|\(\.\*\)$/.exec(p);
  return !/[()[\]*+?]/.test(open ? p.slice(0, open.index) : p);
}
// Clerk's matcher only says where its middleware runs. What it protects is in the code: createRouteMatcher's list where a
// plain if uses it (with a ! or an early return, everything except that list), all of it when nothing limits the check,
// nothing when nothing checks. Anything else counts as covering.
const CLERK_REFUSES = /\bprotect\b|\bredirectToSignIn\b/g;
const CLERK_LOOKS = /\b(?:userId|sessionId|sessionClaims|orgId)\b/;
function clerkCovers(text, route) {
  const refuses = (text.match(CLERK_REFUSES) || []).length;
  if (!refuses && !CLERK_LOOKS.test(text)) return false;
  const lists = [];
  if (text.includes('createRouteMatcher')) {
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]{0,40})\s{0,20}=\s{0,20}createRouteMatcher\s{0,20}\(\s{0,20}(\[[^\]]{0,2000}\])?/g)) {
      if (!m[2] || lists.length >= 20) return true; // a list held elsewhere cannot be read
      lists.push({ name: m[1], patterns: [...m[2].matchAll(/['"`](\/[^'"`\n]{0,300})['"`]/g)].map(x => x[1]) });
    }
  }
  if (!lists.length) return true;
  let inIfs = 0, earlyReturn = false, covered = false;
  for (const { name, patterns } of lists) {
    const calls = text.split(name + '(').length - 1;
    const plain = [...text.matchAll(new RegExp('\\bif\\s{0,20}\\(\\s{0,20}(!?)\\s{0,20}' + esc(name) + '\\s{0,20}\\(\\s{0,20}[\\w$]{1,30}\\s{0,20}\\)\\s{0,20}\\)', 'g'))];
    if (plain.length < calls) return true;
    for (const u of plain) {
      const stmt = text.slice(u.index + u[0].length, u.index + u[0].length + 300).replace(/^\s*\{?\s*/, '').split(/[;\n]/)[0];
      const returns = /^return\b/.test(stmt);
      if (returns) earlyReturn = true;
      else if (stmt.match(CLERK_REFUSES)) inIfs++;
      else return true;
      const everythingElse = (u[1] === '!') !== returns;
      if (everythingElse ? !patterns.some(p => matcherIsRead(p) && matcherCovers(p, route)) : patterns.some(p => matcherCovers(p, route))) covered = true;
    }
  }
  // a check the ifs do not hold runs for every address
  if (refuses > inIfs && !earlyReturn) return true;
  return covered || !lists.some(l => text.split(l.name + '(').length > 1);
}
// Clerk's older authMiddleware protects every address except the ones its publicRoutes and ignoredRoutes name, whatever
// the matcher says. A list held elsewhere, a function, or a pattern not read in full names nothing here.
function clerkListsLeaveOpen(m, route) {
  if (!m.clerkOpenLists) {
    m.clerkOpenLists = [];
    let lists = 0;
    for (const at of m.codeText.matchAll(/\b(?:publicRoutes|ignoredRoutes)\s{0,20}:\s{0,20}\[/g)) {
      if (++lists > 20) break;
      const from = at.index + at[0].length, part = m.codeText.slice(from, from + 2000), end = part.indexOf(']');
      if (end >= 0) for (const p of part.slice(0, end).matchAll(/['"`](\/[^'"`\n]{0,300})['"`]/g)) if (matcherIsRead(p[1])) m.clerkOpenLists.push(p[1]);
    }
  }
  return m.clerkOpenLists.some(p => matcherCovers(p, route));
}
// NextAuth's auth, handed over as the middleware, turns no one away unless an authorized callback says who may pass. Only
// when the project really uses NextAuth: an auth of the project's own may refuse by itself.
const BARE_NEXTAUTH = /\bexport\s{0,20}\{\s{0,20}auth\s{1,20}as\s{1,20}(?:middleware|proxy|default)\s{0,20}\}|\bexport\s{1,20}const\s{1,20}(?:middleware|proxy)\s{0,20}=\s{0,20}auth\s{0,20}(?:;|$)|\bexport\s{1,20}default\s{1,20}auth\s{0,20}(?:;|$)/m;
function nextAuthRefusesNobody(idx) {
  if (idx.nextAuthOpen === undefined) {
    const live = idx.files.filter(g => !g.isTest);
    idx.nextAuthOpen = live.some(g => /\bNextAuth\s{0,20}\(/.test(g.codeText)) && !live.some(g => /\bauthorized\s{0,20}[:(,}]/.test(g.codeText));
  }
  return idx.nextAuthOpen;
}
function middlewareCovers(idx, f, route) {
  const root = appRoot(f.rel);
  const known = idx.middleware || (idx.middleware = new Map());
  if (!known.has(root)) known.set(root, idx.files.find(g => /^(?:src\/)?(?:middleware|proxy)\.(?:m?js|ts)$/i.test(root ? (g.rel.startsWith(root + '/') ? g.rel.slice(root.length + 1) : '') : g.rel)) || null);
  const m = known.get(root);
  if (!m || !MIDDLEWARE_CHECK.test(m.codeText)) return false;
  if (m.codeText.includes('clerkMiddleware') && !clerkCovers(m.codeText, route)) return false;
  if (m.codeText.includes('authMiddleware') && clerkListsLeaveOpen(m, route)) return false;
  if (BARE_NEXTAUTH.test(m.codeText) && nextAuthRefusesNobody(idx)) return false;
  const at = m.codeText.search(/\bmatcher\s*:/);
  if (at < 0) return true; // no matcher: it runs on every address
  const part = m.codeText.slice(at, at + 2000).split(/\n\s*\}|\};/)[0];
  const patterns = [...part.matchAll(/['"`](\/[^'"`\n]{0,300})['"`]/g)].map(x => x[1]);
  return !patterns.length || patterns.some(p => matcherCovers(p, route));
}
// A server action has no middleware to rely on and no neighbours: each one checks for itself, or is built on a
// signed-in action client (authAction.action(...)).
const SIGNED_IN_ACTION = /\b\w{0,20}(?:auth|protected|admin|user)\w{0,20}(?:Action|Client|Procedure)\b/i;
function routeChecked(idx, f, r) {
  if (r.next) return fileChecks(idx, f) || (r.hooks ? hooksCover(idx, r) : middlewareCovers(idx, f, r.path));
  // an inline action: a check in the page may be its own or the page's, and from here they cannot be told apart
  if (r.inline) return fileChecks(idx, f) || middlewareCovers(idx, f, r.path);
  if (r.action) return SESSION_CHECK.test(r.check) || SECRET_COMPARED.test(r.check) || SIGNED_IN_ACTION.test(r.check) || callsAGuard(idx, r.check);
  if (/auth|protect|verify|ensure|require|isLogged|isAdmin|jwt|session|guard|permission|api_?key|\bcan[A-Z]/i.test(codeOf(r.args))) return true;
  // a project's own function handed to the route: what it does decides, whatever it is called
  // (one name in several files is left to followRoute below, which reads the file this route loads it from)
  if (callsAGuard(idx, (codeOf(r.args).match(/(?<![\w$.])[A-Za-z_$][\w$]{0,60}/g) || []).filter(n => (idx.fns.get(n) || []).length < 2).map(n => n + '(').join(' '))) return true;
  return SESSION_CHECK.test(r.body) || AUTH_IMPORT.test(r.body) || SECRET_COMPARED.test(r.body) || callsAGuard(idx, r.body) || guardCovers(idx, f, r) || followRoute(idx, f, r).some(x => x.fn.checks);
}
// ---- one step into the project: the function a route names, or calls ----
// router.delete('/:id', deleteUser) with deleteUser in a controller file, and app.get('/x', ...) that calls
// userRepo.findAll(). The function is read once a scan, whatever calls it. Functions of a test folder are not the app.
const HANDLER_VALUE = String.raw`\s*=\s*(?:[A-Za-z_$][\w$.]{0,40}\s*\(\s*)?(?:async\b|function\b|\(|[A-Za-z_$][\w$]{0,30}\s*=>)`;
const HANDLER_DEF = new RegExp('^[ \\t]*(?:'
  + String.raw`(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]{0,60})(?:\s*:[^=\n]{0,60})?` + HANDLER_VALUE // const getUsers = asyncHandler(async (req, res) => {
  + '|' + String.raw`[A-Za-z_$][\w$]{0,40}(?:\.[A-Za-z_$][\w$]{0,40}){0,2}\.([A-Za-z_$][\w$]{0,60})` + HANDLER_VALUE // exports.getUsers = async (req, res) => {
  + '|' + String.raw`(?:async\s+)?([A-Za-z_$][\w$]{0,60})\s*:\s*(?:[A-Za-z_$][\w$.]{0,40}\s*\(\s*)?(?:async\b|function\b|\(|[A-Za-z_$][\w$]{0,30}\s*=>)` // findAll: () => db.query(...)
  + '|' + String.raw`(?:(?:public|private|protected|static|async)\s+){0,3}([A-Za-z_$][\w$]{0,60})\s*\([^)\n]{0,160}\)\s*(?::[^{\n]{0,60})?\{\s*$` // async findAll() {
  + ')');
function projectDefs(idx, name) {
  if (!idx.handlerDefs) {
    idx.handlerDefs = new Map();
    idx.defsOfName = new Map();
    for (const g of idx.files) {
      if (g.isTest || !JS.test(g.name) || NOT_LIVE_DIR.test(g.rel)) continue;
      g.code.forEach((l, i) => {
        if (l.length > 400) return;
        const m = HANDLER_DEF.exec(l);
        const n = m && (m[1] || m[2] || m[3] || m[4]);
        if (!n || KEYWORDS.has(n.toLowerCase())) return;
        if (!idx.handlerDefs.has(n)) idx.handlerDefs.set(n, []);
        idx.handlerDefs.get(n).push({ f: g, i });
      });
    }
  }
  if (!idx.defsOfName.has(name)) {
    const named = (idx.fns.get(name) || []).filter(d => !d.f.isTest && JS.test(d.f.name) && !NOT_LIVE_DIR.test(d.f.rel));
    const known = new Set(named.map(d => d.f.rel + ':' + d.i));
    idx.defsOfName.set(name, [...named, ...(idx.handlerDefs.get(name) || []).filter(d => !known.has(d.f.rel + ':' + d.i))]);
  }
  return idx.defsOfName.get(name);
}
// What this file loads, by the names it gives them: name -> the module's path. Read from its first 20,000 characters.
function importsOf(f) {
  if (f.imports) return f.imports;
  f.imports = new Map();
  for (const m of f.codeText.slice(0, 20000).matchAll(/\b(?:const|let|var|import)\b([^;'"`]{0,400}?)(?:=\s{0,20}require\s{0,20}\(\s{0,20}|\bfrom\s{1,20})['"`]([^'"`\n]{1,160})['"`]/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]{0,60}/g) || []) if (!f.imports.has(n)) f.imports.set(n, m[2]);
  }
  return f.imports;
}
const PROJECT_PATH = /^(?:\.|@\/|~\/|\/|src\/|lib\/)/;
// One statement from its first line: brackets counted, quoted text ignored, at most 60 lines and 6,000 characters.
function statementFrom(code, i, max = 60) {
  let depth = 0, size = 0;
  const out = [];
  for (let k = i; k < Math.min(code.length, i + max) && size < 6000; k++) {
    const l = code[k];
    out.push(l);
    size += l.length + 1;
    for (const c of codeOf(l)) { if (c === '(' || c === '{' || c === '[') depth++; else if (c === ')' || c === '}' || c === ']') depth--; }
    if (depth <= 0 && !/=>\s*$/.test(l)) break;
  }
  return out.join('\n');
}
// Up to 4 MB of functions a scan, past which a route is judged by what it says itself. With one name in several files,
// the file this route loads it from decides; a name loaded from a package is that package's.
function readFunction(idx, f, name, receiver) {
  const from = importsOf(f).get(receiver || name);
  if (from && !PROJECT_PATH.test(from)) return null;
  const picked = f.defsPicked || (f.defsPicked = new Map());
  const pick = name + '|' + (from || '');
  if (!picked.has(pick)) {
    let defs = projectDefs(idx, name);
    if (defs.length > 1) {
      const same = from ? defs.filter(d => d.f.name.replace(/\.\w+$/, '') === moduleBase(from)) : defs.filter(d => d.f === f);
      if (same.length) defs = same;
    }
    picked.set(pick, defs.slice(0, 6));
  }
  const defs = picked.get(pick);
  if (!defs.length) return null;
  const key = name + '|' + defs[0].f.rel + '|' + defs.length;
  const memo = idx.functionsRead || (idx.functionsRead = new Map());
  if (!memo.has(key)) {
    idx.functionBytes = idx.functionBytes || 0;
    if (idx.functionBytes > 4 * 1024 * 1024) { memo.set(key, null); return null; }
    const parts = defs.map(d => statementFrom(d.f.code, d.i));
    const text = parts.join('\n');
    idx.functionBytes += text.length;
    // a function called getUser is not a call to a check
    const own = parts.map(p => p.replace(name, '')).join('\n');
    memo.set(key, { f: defs[0].f, text, change: DB_CHANGE.exec(text), create: DB_CREATE.exec(text), read: DB_READ.exec(text), checks: SESSION_CHECK.test(own) || SECRET_COMPARED.test(own) || callsAGuard(idx, own) });
  }
  return memo.get(key);
}
const NOT_PROJECT_CODE = /^(?:req|request|res|response|reply|ctx|c|next|err|error|async|await|function|require|console|JSON|Math|Object|Array|Promise|Date|Number|String|Boolean|Buffer|process|this|router|app|server|express|path|fs|crypto)$/;
// A function that signs people in, or takes a provider's signed event, has to work with nobody signed in.
const PUBLIC_BY_NATURE = /^(?:register|sign_?up|log_?in|sign_?in|log_?out|sign_?out|auth|forgot|reset_?pass|verify_?email|create_?account|refresh_?token)|webhook|callback|oauth|^(?:health|ping)/i;
const HANDLER_NAMES = /(?<![\w$.])[A-Za-z_$][\w$]{0,60}(?:\.[A-Za-z_$][\w$]{0,60}){0,3}/g;
const lastPart = t => t.split('.').pop();
function followRoute(idx, f, r) {
  if (r.follow) return r.follow;
  r.follow = [];
  if (!r.method) return r.follow;
  const seen = new Set();
  const take = (name, receiver, named) => {
    if (seen.has(name) || seen.size >= 8 || NOT_PROJECT_CODE.test(name) || KEYWORDS.has(name.toLowerCase()) || PUBLIC_BY_NATURE.test(name)) return;
    if (receiver && NOT_PROJECT_CODE.test(receiver)) return;
    seen.add(name);
    const fn = readFunction(idx, f, name, receiver);
    if (fn) r.follow.push({ fn, named });
  };
  for (const t of codeOf(r.args).match(HANDLER_NAMES) || []) take(lastPart(t), t.includes('.') ? t.split('.')[0] : null, true);
  const own = codeOf(r.chained ? r.body : statementFrom(f.code, r.i));
  for (const n of callsIn(own)) if (!NOT_A_HELPER.test(n)) take(n, null, false);
  for (const c of own.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,40})\.([A-Za-z_$][\w$]{0,60})\s*\(/g)) take(c[2], c[1], false);
  return r.follow;
}
// The work a route's functions do, the heaviest of them. A function it only calls on the way, on a GET, is judged by what
// it reads: a page that counts its visits is not a route that changes people's data.
function workOfFunctions(idx, f, r) {
  let best = null, weight = 0;
  for (const { fn, named } of followRoute(idx, f, r)) {
    const writes = named || r.method !== 'get';
    const change = writes ? fn.change : null, create = writes ? fn.create : null, read = fn.read;
    const w = change ? 3 : create ? 2 : read ? 1 : 0;
    if (w > weight) { weight = w; best = { f: fn.f, text: fn.text, change, create, read }; }
  }
  return best;
}
// Something this scan cannot read stands before the handler, and it may be the check: a guard from a package, or a list of them.
const NOT_A_GUARD_NAME = /valid|upload|multer|cors|limit|cache|log|parse|sanitize|schema|body|wrap|async|catch|handler/i;
const unreadMiddleware = (idx, r) => (codeOf(r.args).match(HANDLER_NAMES) || []).filter(t => !NOT_PROJECT_CODE.test(t)).slice(0, -1).some(t => !projectDefs(idx, lastPart(t)).length && !NOT_A_GUARD_NAME.test(t));
// A Supabase query with the signed-in person's own client is limited by row-level security (RLS-001 looks at that).
// It counts as open only when this file, or a file it imports the client from, holds the service-role key.
function supabaseOnly(idx, f, body) {
  const others = body.replace(new RegExp(FROM_TABLE + String.raw`\w+`, 'g'), '');
  if (DB_CREATE.test(others) || DB_CHANGE.test(others) || DB_READ.test(others)) return false;
  const SERVICE = /service_?role|SERVICE_KEY|supabaseAdmin|createAdminClient|adminClient/i;
  if (SERVICE.test(f.codeText)) return false;
  for (const m of f.codeText.matchAll(/\bfrom\s+['"`]([^'"`\n]{1,160})['"`]/g)) {
    const base = m[1].split('/').pop();
    if (base && idx.files.some(g => (g.name === base || g.name.replace(/\.\w+$/, '') === base) && SERVICE.test(g.codeText))) return false;
  }
  return true;
}
const lineOfIndex = (text, at) => { let n = 0; for (let k = text.indexOf('\n'); k >= 0 && k < at; k = text.indexOf('\n', k + 1)) n++; return n; };
// A new account saved with a hashed password is a sign-up, the one write that has to work with nobody signed in.
const ACCOUNT_TABLE = /^(?:users?|accounts?|members?|customers?)$/i;
const HASHES_PASSWORD = /\b(?:bcrypt\w{0,10}|argon2\w{0,6}|scrypt\w{0,6}|pbkdf2\w{0,6}|hashPassword|hash_password|password_hash)\b|\bhash\s*\([^)\n]{0,40}password/i;
const LISTS_TOO = /\bexport\s+(?:async\s+)?(?:function|const)\s+GET\b|\bmethod\s*===?\s*['"]GET['"]/;
const EXPORTS_POST = /\bexport\s+(?:async\s+)?(?:function|const)\s+POST\b|\bas\s+POST\b/;
const EXPORTS_OTHER = /\bexport\s+(?:async\s+)?(?:function|const)\s+(?:GET|PUT|PATCH|DELETE)\b|\bas\s+(?:GET|PUT|PATCH|DELETE)\b/;
const TAKES_ONLY_POST = text => EXPORTS_POST.test(text) && !EXPORTS_OTHER.test(text);
// The routes with data and no check, found once: API-001 and API-002 report from the same list. One finding a file, for
// its worst route: a change, then someone's data, then any other read.
const routeWeight = o => (o.write ? 3 : o.personal ? 2 : 1);
function openRoutes(idx) {
  if (idx.open) return idx.open;
  const open = [];
  for (const f of idx.files) {
    let worst = null;
    for (const r of routesOf(idx, f)) {
      const words = r.words;
      if (words.some(w => PUBLIC_ANY.test(w)) || isLeftover(r)) continue;
      let body = r.body, change = DB_CHANGE.exec(body), create = DB_CREATE.exec(body), read = DB_READ.exec(body);
      // nothing here touches the database: what the route names or calls may
      const far = !change && !create && !read ? workOfFunctions(idx, f, r) : null;
      if (far) ({ text: body, change, create, read } = far);
      if (!change && !create && !read) continue;
      if (r.inline && !change) continue; // a page's form that only adds a record or reads: too often meant for the public
      let write = change || (create && !words.some(w => PUBLIC_FORM.test(w)) ? create : null);
      // a controller that saves a password: the model hashes it, in a file of its own
      if (!change && create && (HASHES_PASSWORD.test(body) || (far && /\bpassword\b/i.test(body))) && ACCOUNT_TABLE.test(targetAt(body, create))) {
        // a look for the email first is part of the sign-up; a list of everyone on the same route is not
        if (r.next ? !LISTS_TOO.test(body) : r.method !== 'get') continue;
        write = null;
      }
      if (!write && !read) continue; // a public form that only adds a record
      const target = targetAt(body, write || read);
      if (!write && !isPersonal(target) && (!read || words.some(w => PUBLIC_READ.test(w)) || PUBLIC_READ.test(target.toLowerCase()) || /\b(?:published|is_?public|isPublic|visibility)\b/.test(body))) continue;
      if (routeChecked(idx, f, r) || supabaseOnly(idx, far ? far.f : f, body) || (far && unreadMiddleware(idx, r))) continue;
      const m = write || read;
      // a Next.js route that takes only POST and only adds a record: often a public form, so the owner judges it
      const addsOnly = !!write && !change && !read && NEXT_APP_ROUTE.test(f.rel) && TAKES_ONLY_POST(body);
      const found = addsOnly ? { f, i: lineOfIndex(body, m.index), label: r.label, target, write: false, personal: false, addsOnly }
        : { f, i: (r.next ? 0 : r.i) + (far ? 0 : lineOfIndex(body, m.index)), label: r.label, target, write: !!write, personal: isPersonal(target) };
      if (!worst || routeWeight(found) > routeWeight(worst)) worst = found;
      if (worst.write) break;
    }
    if (worst) open.push(worst);
  }
  return (idx.open = open);
}
const CHECK_FIX = 'Check who is calling at the top of the route (getServerSession, auth() or your own requireUser) and answer 401 when nobody is signed in, or cover it with middleware whose matcher includes this address. Then check the record belongs to that person.';
rule({ id: 'API-001', sev: 'High', area: 'auth', title: 'A route changes or returns people\'s data and nothing checks who is calling: anyone on the internet can use it', fix: CHECK_FIX,
  run(idx) {
    return openRoutes(idx).filter(o => o.write || o.personal).map(o => ({ f: o.f, i: o.i,
      title: o.label + (o.write ? ' changes' : ' returns') + ' data' + (o.target ? ' (' + o.target + ')' : '') + ' and nothing checks who is calling: anyone on the internet can use it' }));
  } });
const ADDS_ONLY_FIX = 'If this is a public form, such as a contact form or a mailing list, it is fine with nobody signed in: add a limit on how often one visitor can post, so nobody can fill your database. If it is not meant for the public, also add a check: ' + CHECK_FIX;
rule({ id: 'API-002', sev: 'Medium', area: 'auth', title: 'A route returns data from the database with no session check: fine if that data is public, a leak if not', fix: 'If this data is meant for everyone, nothing needs to change (set this finding aside). If not: ' + CHECK_FIX,
  run(idx) {
    return openRoutes(idx).filter(o => !o.write && !o.personal).map(o => (o.addsOnly
      ? { f: o.f, i: o.i, fix: ADDS_ONLY_FIX, title: o.label + ' adds a record' + (o.target ? ' (' + o.target + ')' : '') + ' for anyone who posts to it, and does nothing else: fine for a public form; if it is not one, add a limit and a check on who is calling' }
      : { f: o.f, i: o.i, title: o.label + ' returns data' + (o.target ? ' (' + o.target + ')' : '') + ' with no session check: fine if that data is public, a leak if not' }));
  } });

// DEBUG-002: a route left in from building the app. A test route with a fixed answer harms nobody: this one wipes,
// fills or dumps, or it touches the database, the settings or the mail.
const LEFTOVER_TOUCHES = /\bprocess\.env\b|\bsendMail\s*\(|\bfs\.\w{1,20}\s*\(|\bemails?\.send\s*\(/;
rule({ id: 'DEBUG-002', sev: 'High', area: 'exposed files', title: 'A debug, test or seed route is still in the app with no check: anyone can call it by its address',
  fix: 'Delete the route before the site goes live. If you still need it, refuse outside your own PC (if (process.env.NODE_ENV === \'production\') answer 404) or require a sign-in.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      for (const r of routesOf(idx, f)) {
        const words = r.words;
        // a word that is public by nature (reset-password) makes it a real feature, whatever else the address says
        if (!isLeftover(r) || words.some(w => PUBLIC_ANY.test(w) || /^(?:password|passwords)$/.test(w))) continue;
        // /reset alone is usually a password reset page; /admin/reset is not
        if (words.includes('reset') && /password/i.test(r.body)) continue;
        const acts = words.some(w => LEFTOVER_ACTS.test(w)) || (words.includes('admin') && words.includes('reset'));
        const db = DB_CHANGE.exec(r.body) || DB_CREATE.exec(r.body) || DB_READ.exec(r.body);
        if (!acts && !db && !LEFTOVER_TOUCHES.test(r.body)) continue;
        if (/\bNODE_ENV\b|\bVERCEL_ENV\b|\bisDev\b/.test(r.next ? f.codeText : f.code.slice(Math.max(0, r.i - 3), r.i).join('\n') + r.body)) continue;
        if (routeChecked(idx, f, r)) continue;
        out.push({ f, i: (r.next ? 0 : r.i) + (db ? lineOfIndex(r.body, db.index) : 0), title: r.label + ' is a leftover debug, test or seed route with no check: anyone can call it by its address' });
        break;
      }
    }
    return out;
  } });

// PAY-007: a payment provider's event is taken from the request and believed: anyone can post one and get the goods free.
const PAY_SHAPE = /\b(?:stripe|paddle|lemon-?squeezy|lemonsqueezy|checkout\.session\.completed|payment_intent\.\w|invoice\.pa(?:id|yment)|customer\.subscription\.\w|subscription_created|order_created|transaction\.completed)/i;
const READS_EVENT = /\b(?:req|request)\.(?:body|json|text|rawBody|get_json|data)\b|\bevent\.body\b|\breadBody\s*\(|\breadRawBody\s*\(|php:\/\/input/;
const SIGNATURE_CHECK = /\bstripe\w{0,10}\.(?:events|paymentIntents|invoices|subscriptions|checkout\.sessions)\.retrieve\s*\(|(?:secret|token)['"]\s*\]\s*[!=]==?\s*(?:process\.env|env\b)|\bconstruct[E]vent(?:Async)?\b|\bconstruct_event\b|\bwebhooks\.unwrap\b|\bwebhooks\.unmarshal\b|\b(?:verify|validate|check|is_?valid)\w{0,20}(?:signature|sig|hmac|webhook)\w{0,10}|\b(?:signature|sig|hmac|webhook)\w{0,10}(?:verif|valid)|\bverify\w{0,30}\s*\(|\.\w{0,30}webhook\w{0,20}\s*\(|\bcreateHmac\b|\bhash_hmac\b|\bhmac\.\w{1,20}\s*\(|\btimingSafeEqual\b|\bhash_equals\b|\bstripe\.events\.retrieve\b|\bsvix\b/i;
// Reading the signature header is not a check. Handing it on to another call, or comparing it, may be: the check is then
// somewhere this scan cannot follow (billing.parse(raw, sig)), so it counts. if (!sig) only sees whether one was sent.
const SIGNATURE_HEADER = /stripe-signature|paddle-signature|x-signature|webhook-signature|HTTP_STRIPE_SIGNATURE|HTTP_PADDLE_SIGNATURE|HTTP_X_SIGNATURE/i;
const NOT_A_HAND_ON = /\b(?:console\.\w{1,10}|log\w{0,10}|print|error_log)\s*\(/;
const ONLY_SEES_IF_SENT = /\b(?:if|while)\s*\(\s*!?\s*[\w.$]{1,60}(?:\[[^\]\n]{0,60}\]|\([^)\n]{0,60}\))?\s*\)/g;
// app.post('/stripe/webhook', raw, stripeSig, handler): middleware named on the route and brought in from a file of this
// project, which does the check. A name alone proves nothing, so the file itself is read.
function routeArgumentChecks(idx, f) {
  for (const m of f.codeText.matchAll(/\.(?:post|all)\s*\(\s*['"`][^'"`\n]{0,120}['"`]\s*,([^\n]{0,200})/g)) {
    for (const [n] of m[1].matchAll(/[A-Za-z_$][\w$]{2,40}/g)) {
      const from = new RegExp(String.raw`\b${n.replace(/\$/g, '\\$')}\b[^=\n]{0,80}(?:=\s*require\s*\(\s*|from\s+)['"]([^'"\n]{1,200})['"]`).exec(f.codeText);
      if (!from || !from[1].startsWith('.')) continue;
      const want = path.posix.join(path.posix.dirname(f.rel), from[1]).replace(/\.\w+$/, '');
      if (idx.files.some(x => (x.rel.replace(/\.\w+$/, '') === want || x.rel.replace(/\/index\.\w+$/, '') === want) && SIGNATURE_CHECK.test(x.codeText))) return true;
    }
  }
  return false;
}
function signaturePassedOn(f) {
  const names = [];
  for (const raw of f.code) {
    if (!SIGNATURE_HEADER.test(raw)) continue;
    const l = raw.replace(ONLY_SEES_IF_SENT, ' ');
    if (/\w\s*\([^)\n]{0,160}(?:headers?|\$_SERVER|\.get\s*\()/.test(l) && !NOT_A_HAND_ON.test(l)) return true;
    const d = /(?:\b(?:const|let|var)\s+|^\s*\$?)([A-Za-z_]\w{0,40})\s*=(?!=)/.exec(l);
    if (d && names.length < 5) names.push(d[1]);
  }
  for (const n of names) {
    const word = new RegExp('(?<![\\w$])\\$?' + esc(n) + '\\b');
    for (const raw of f.code) {
      if (SIGNATURE_HEADER.test(raw) || !raw.includes(n)) continue;
      const l = raw.replace(ONLY_SEES_IF_SENT, ' ');
      if (!word.test(l) || NOT_A_HAND_ON.test(l)) continue;
      if (/[!=]==?/.test(l) || /\w\s*\(/.test(l)) return true;
    }
  }
  return false;
}
rule({ id: 'PAY-007', sev: 'High', area: 'payments', title: 'A payment webhook believes whatever is posted to it, with no signature check: anyone can send a fake "paid" event and get the goods free',
  fix: 'Check the signature before acting on the event: stripe.webhooks.construct' + 'Event(rawBody, signatureHeader, webhookSecret) for Stripe, or the provider\'s HMAC check for Paddle and Lemon Squeezy. Answer 400 when it does not match.',
  run(idx) {
    const out = [];
    for (const f of idx.files) {
      if (f.isTest && !NEXT_APP_ROUTE.test(f.rel) && !NEXT_PAGES_API.test(f.rel)) continue;
      if (NOT_LIVE_DIR.test(f.rel) || !SERVER_CODE.test(f.name)) continue;
      const byName = /webhook|(^|\/)api\/hooks?\//i.test(f.rel); // not src/hooks/: that is a React folder
      if (!byName && !/\.(?:post|all)\s*\(\s*['"`][^'"`\n]{0,120}(?:webhook|\/hooks?\b)|@\w{1,30}\.(?:route|post)\s*\(\s*['"][^'"\n]{0,120}(?:webhook|\/hooks?\b)/i.test(f.codeText)) continue;
      if (!PAY_SHAPE.test(f.rel) && !PAY_SHAPE.test(f.codeText)) continue;
      if (!READS_EVENT.test(f.codeText) || SIGNATURE_CHECK.test(f.codeText) || signaturePassedOn(f) || routeArgumentChecks(idx, f)) continue;
      let helper = false;
      for (const n of callsIn(codeOf(f.codeText))) if (!NOT_A_HELPER.test(n) && idx.defined(n) && helperHas(idx, 'signatureHelpers', SIGNATURE_CHECK, n)) { helper = true; break; }
      if (helper) continue;
      const i = f.code.findIndex(l => READS_EVENT.test(l));
      out.push({ f, i: Math.max(0, i) });
    }
    return out;
  } });

// RLS-001: Supabase hands every visitor the anon key, so a table with no row-level security is open to all of them.
// .sql files are not among the files the scan reads, so they are read here, only for a project that uses Supabase.
const SQL_SKIP_DIR = /^(?:node_modules|\.git|vendor|dist|build|out|\.next|\.nuxt|\.output|_build|_builds|_dist|_release|_releases|releases|_backups|backups?|prisma|tests?|fixtures?)$/i;
// Supabase used for sign-in only (sb.auth, and no query with .from): its tables are not the ones in db/migrations/.
const SUPABASE_QUERY = new RegExp(FROM_TABLE + '|\\bsupabase\\w{0,20}\\s*\\??\\.\\s*from\\s*\\(', 'i');
const SUPABASE_AUTH = /\.auth\.(?:getUser|getSession|signIn\w{0,20}|signUp|signOut|onAuthStateChange)\b/;
function supabaseSql(idx) {
  const live = idx.files.filter(f => !f.isTest);
  const authOnly = live.some(f => SUPABASE_AUTH.test(f.codeText)) && !live.some(f => SUPABASE_QUERY.test(f.codeText));
  return filesOnDisk(idx, (name, rel) => {
    if (!/\.sql$/i.test(name)) return false;
    return /(^|\/)(supabase|drizzle)\//i.test(rel) || (!authOnly && (/(^|\/)migrations?\//i.test(rel) || /schema|supabase|migration|setup|init|tables|database/i.test(name)));
  });
}
// Files the scan does not read, read from disk when a rule needs them: the skip list kept, with limits on the walk.
function filesOnDisk(idx, want) {
  const out = [];
  let seen = 0, bytes = 0;
  const walk = (d, depth) => {
    if (depth > 6 || seen > 4000) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 4000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SQL_SKIP_DIR.test(e.name) && !idx.skip.has(path.relative(idx.dir, p).replace(/\\/g, '/').toLowerCase())) walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(idx.dir, p).replace(/\\/g, '/');
      if (!want(e.name, rel) || idx.skip.has(rel.toLowerCase())) continue;
      try {
        const size = fs.statSync(p).size;
        if (size > 2 * 1024 * 1024 || bytes + size > 30 * 1024 * 1024) continue;
        bytes += size;
        out.push({ rel, text: fs.readFileSync(p, 'utf8') });
      } catch {}
    }
  };
  walk(idx.dir, 0);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}
// The SQL with its comments blanked, line breaks kept, in one pass (no pattern, so an unclosed comment costs nothing).
// lineMark is the character that doubled starts a line comment: - for SQL, / for Firebase's rules.
function sqlWithoutComments(text, lineMark = 45) {
  const out = [];
  let from = 0, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === lineMark && text.charCodeAt(i + 1) === lineMark) { // -- or //
      out.push(text.slice(from, i));
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      i = from = e;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) { // slash star
      out.push(text.slice(from, i));
      let e = text.indexOf('*/', i + 2);
      e = e < 0 ? n : e + 2;
      out.push(text.slice(i, e).replace(/[^\n]/g, ' '));
      i = from = e;
    } else i++;
  }
  out.push(text.slice(from));
  return out.join('');
}
rule({ id: 'RLS-001', sev: 'High', area: 'auth', title: 'A Supabase table has no row-level security: anyone with the public anon key can read and change every row',
  fix: 'In a new migration, for each table: alter table the_table enable row level security; then add a policy for who may read and write it (for example auth.uid() = user_id).',
  run(idx) {
    if (!idx.dir) return [];
    let uses = idx.files.some(f => /(^|\/)supabase\//i.test(f.rel) || /@supabase\//.test(f.text));
    if (!uses) try { uses = fs.statSync(path.join(idx.dir, 'supabase')).isDirectory(); } catch {}
    if (!uses) return [];
    const made = new Map(), safe = new Set();
    for (const s of supabaseSql(idx)) {
      const code = sqlWithoutComments(s.text);
      // a loop that enables it on every table: not readable table by table, so taken as done
      if (/\bexecute\b[^;]{0,300}\benable\s+row\s+level\s+security\b/i.test(code)) return [];
      // dropped first: a schema file usually says drop table if exists x; create table x
      for (const m of code.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?(?:"?\w{1,63}"?\s*\.\s*)?"?(\w{1,63})"?/gi)) made.delete(m[1].toLowerCase());
      for (const m of code.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w{1,63})"?\s*\.\s*)?"?(\w{1,63})"?/gi)) {
        const schema = (m[1] || 'public').toLowerCase(), name = m[2].toLowerCase();
        if (schema === 'public' && !made.has(name)) made.set(name, { s, code, at: m.index });
      }
      for (const m of code.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w{1,63}"?\s*\.\s*)?"?(\w{1,63})"?\s+enable\s+row\s+level\s+security\b/gi)) safe.add(m[1].toLowerCase());
    }
    const open = [...made.keys()].filter(t => !safe.has(t));
    if (!open.length) return [];
    const first = made.get(open[0]);
    const names = open.slice(0, 5).join(', ') + (open.length > 5 ? ' and ' + (open.length - 5) + ' more' : '');
    return [{ f: { rel: first.s.rel, lines: first.s.text.split(/\r?\n/) }, i: lineOfIndex(first.code, first.at),
      title: (open.length === 1 ? 'The Supabase table ' + names + ' has' : open.length + ' Supabase tables (' + names + ') have') + ' no row-level security: anyone with the public anon key can read and change every row' }];
  } });

// FIRE-001: the rules Firebase's test mode writes. The web config is public, so anyone can then change or wipe the data.
// A public read with writes guarded is how a blog works and a public create is how a form works, so neither counts.
// The rule files are not among the files the scan reads, so they are read here, only for a project that uses Firebase.
const FIRE_FILE = /^(?:firestore\.rules|storage\.rules|database\.rules\.json)$/i;
const FIREBASE_USED = /['"`](?:firebase(?:-admin)?(?:\/[\w/-]{1,40})?|@firebase\/[\w-]{1,40}|@angular\/fire(?:\/[\w/-]{1,40})?|vuefire)['"`]/;
const FIRE_ALLOW = /\ballow[ \t\r\n]{1,40}([a-z][a-z, \t]{0,40}?)[ \t\r\n]{0,40}(?::[ \t\r\n]{0,40}if[ \t\r\n]{1,40}([^;\n}]{1,160}))?[ \t\r]{0,40}(?:;|\n|\})/g;
const FIRE_WRITE = /^(?:write|update|delete)$/;
const FIRE_UNTIL_DATE = /^request\.time\s{0,20}<=?\s{0,20}timestamp\.date\s{0,20}\(\s{0,20}(\d{4})\s{0,20},\s{0,20}(\d{1,2})\s{0,20},\s{0,20}(\d{1,2})\s{0,20}\)$/;
const FIRE_DB_WRITE = /"\.write"[ \t\r\n]{0,40}:[ \t\r\n]{0,40}(?:true\b|"[ \t]{0,20}true[ \t]{0,20}"|"[ \t]{0,20}now[ \t]{0,20}<[ \t]{0,20}(\d{10,16})[ \t]{0,20}")/g;
// where anyone can change data, or -1: a condition of true, none at all, or test mode's date while that date is ahead
function fireOpenAt(rel, code) {
  const now = Date.now();
  if (/\.json$/i.test(rel)) {
    for (const m of code.matchAll(FIRE_DB_WRITE)) if (!m[1] || Number(m[1]) > now) return m.index;
    return -1;
  }
  for (const m of code.matchAll(FIRE_ALLOW)) {
    if (!m[1].split(',').some(op => FIRE_WRITE.test(op.trim()))) continue;
    const when = (m[2] || 'true').trim();
    const date = FIRE_UNTIL_DATE.exec(when);
    if (when === 'true' || (date && Date.UTC(+date[1], +date[2] - 1, +date[3]) > now)) return m.index;
  }
  return -1;
}
rule({ id: 'FIRE-001', sev: 'High', area: 'auth', title: 'Firebase rules let anyone change or delete your data with no sign-in: the public web config is all they need',
  fix: 'Replace the open line with one that checks the person, for example allow read, write: if request.auth != null && request.auth.uid == userId; (in database.rules.json: ".write": "auth != null"). Then publish the rules with firebase deploy --only firestore:rules,storage,database.',
  run(idx) {
    if (!idx.dir) return [];
    let uses = idx.files.some(f => !f.isTest && f.text.includes('fire') && FIREBASE_USED.test(f.text));
    if (!uses) uses = ['firebase.json', '.firebaserc'].some(n => { try { return fs.statSync(path.join(idx.dir, n)).isFile(); } catch { return false; } });
    if (!uses) return [];
    const out = [];
    for (const s of filesOnDisk(idx, name => FIRE_FILE.test(name))) {
      const code = sqlWithoutComments(s.text, 47);
      const at = fireOpenAt(s.rel, code);
      if (at >= 0) out.push({ f: { rel: s.rel, lines: s.text.split(/\r?\n/) }, i: lineOfIndex(code, at),
        title: s.rel + ' lets anyone change or delete your data with no sign-in: the public web config is all they need' });
    }
    return out;
  } });

// A rule that throws is reported in the notes (with its id), never silently dropped.
function crossAudit(files, extra, mk) {
  const idx = buildIndex(files, { ...extra, all: files });
  const findings = [], notes = [];
  for (const r of RULES) {
    let hits = [];
    try { hits = r.run(idx) || []; } catch (e) { notes.push('Cross-file check ' + r.id + ' could not run: ' + e.message); }
    for (const h of hits) {
      const made = mk(r, h.f, h.i, h.title);
      if (h.fix) made.fix = h.fix; // the one finding's own advice, where the rule's would mislead
      findings.push(made);
    }
  }
  return { findings, notes };
}

module.exports = { crossAudit, buildIndex, CROSS_RULES: RULES.map(({ id, sev, area, title }) => ({ id, sev, area, title })) };
