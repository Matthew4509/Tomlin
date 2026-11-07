// More code rules (scanner training, phase T2): fault classes taken from real registers, each with a should-fire and a
// must-stay-quiet pair in the museum (test/museum/) and in test/rules-more.test.js. Same shape as RULES in audit.js.
//
// Extra keys the engine reads (lib/audit.js codeAudit):
//   path       the file's path (relative, forward slashes) must match
//   fileHas    the whole file must match (the rule needs this context)
//   fileLacks  a guard anywhere in the file silences the rule
//   guardAbove { re, lines }: a guard within this many lines ABOVE the hit silences it (not one anywhere in the file:
//              a guard far away is usually for something else)
//   guardAfter { re, lines }: a guard on the hit's line or within this many lines below silences it
//   needAfter  { re, lines }: the hit counts only when this follows within so many lines
// test(line, ctx, lines, i) gets ctx.text, ctx.rel (path) and ctx.abs (full path).
'use strict';
const fs = require('fs');
const path = require('path');

const PHP = /\.php$/i;
const JS = /\.(m?js|cjs|tsx?|jsx)$/i;
const JS_HTML = /\.(m?js|cjs|tsx?|jsx|html?|php|vue|svelte|astro)$/i;
const MARKUP = /\.(html?|php|vue|svelte|astro|jsx|tsx|twig)$/i;
const SERVER = /\.(php|m?js|cjs|ts|py)$/i;

// Inside a try block? Walks back over braces from the hit (strings with braces can fool it; it only ever silences).
function insideTry(lines, i, col) {
  let depth = 0;
  for (let k = i; k >= Math.max(0, i - 60); k--) {
    const s = k === i ? lines[k].slice(0, col) : lines[k];
    for (let c = s.length - 1; c >= 0; c--) {
      if (s[c] === '}') depth++;
      else if (s[c] === '{') {
        if (depth) { depth--; continue; }
        if (/\btry\s*$/.test(s.slice(0, c))) return true;
      }
    }
  }
  return false;
}
// Inside an open <script> block: the last <script ...> above (or earlier on the line) is not yet closed.
function insideScript(lines, i, col) {
  for (let k = i; k >= Math.max(0, i - 200); k--) {
    const s = k === i ? lines[k].slice(0, col) : lines[k];
    const open = s.lastIndexOf('<script'), close = s.lastIndexOf('</script');
    if (open > close) return true;
    if (close > open) return false;
  }
  return false;
}
// INJ-013: does any PHP file of the project check (or add) the scheme of an address field as it is saved?
// Read once per project folder in each audit (newRun starts the next one, so an edited project is read again).
const schemeChecked = new Map();
const newRun = () => { schemeChecked.clear(); routerRoots.clear(); clientImportLists.clear(); viteRoots.clear(); };
function projectChecksScheme(dir) {
  if (schemeChecked.has(dir)) return schemeChecked.get(dir);
  const RE = /preg_match\s*\(\s*['"][#~\/!@]\^https\?:?\\?\/\\?\/[^\n]{0,60}\$\w*(site|website|homepage|url|link)|(website|homepage)[^\n]{0,80}FILTER_VALIDATE_URL[^\n]{0,80}(scheme|https?)/i;
  let found = false, n = 0;
  const walk = (d, depth) => {
    if (found || depth > 8 || n > 3000) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|vendor|\.git|_releases|releases)$/.test(e.name)) walk(p, depth + 1); }
      else if (/\.php$/i.test(e.name) && ++n) { try { if (RE.test(fs.readFileSync(p, 'utf8'))) found = true; } catch {} }
    }
  };
  walk(dir, 0);
  schemeChecked.set(dir, found);
  return found;
}
// Inside a /* ... */ comment that opened on an earlier line (JSX notes often quote a <Tag>).
function inBlockComment(lines, i) {
  for (let k = i - 1; k >= Math.max(0, i - 40); k--) {
    const open = lines[k].lastIndexOf('/*'), close = lines[k].lastIndexOf('*/');
    if (close > open) return false;
    if (open > close) return true;
  }
  return false;
}
// The line with its quoted strings emptied: a rule's own title or a message that names a call is not the call.
const blankStrings = s => String(s).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
// The nearest `if (` header at or above the hit (within n lines).
function ifAbove(lines, i, n) {
  for (let k = i; k >= Math.max(0, i - n); k--) if (/\bif\s*\(/.test(lines[k])) return lines[k];
  return '';
}

// AUTH-005 and AUTH-006: a limiter or lockout key built from what the caller typed, or from the full address.
const KEY_WORD = /['"][\w:.-]*(rl|rate|limit|throttle|attempt|fail|tries|lock|bucket|flood)[\w:.-]*['"]/i;

// UX-010: tags a JSX file uses must be imported or declared in it.
// A name that appears in the file ONLY as a tag (<Modal>, </Modal>) was never imported, declared, passed in or
// renamed ({ icon: Icon }, const Tag = as || 'div'): any other mention counts as its source.
// Per file, counted once: how often each word appears, and how often as a tag (<Name or </Name).
const perFile = new WeakMap();
function fileMemo(ctx) { let m = perFile.get(ctx); if (!m) perFile.set(ctx, m = {}); return m; }
function wordCounts(ctx) {
  const memo = fileMemo(ctx);
  if (!memo.words) {
    const all = new Map(), tags = new Map();
    for (const m of ctx.text.matchAll(/\w+/g)) all.set(m[0], (all.get(m[0]) || 0) + 1);
    for (const m of ctx.text.matchAll(/<\/?(\w+)/g)) tags.set(m[1], (tags.get(m[1]) || 0) + 1);
    memo.words = { all, tags };
  }
  return memo.words;
}
function jsxUnknownTag(line, ctx) {
  for (const m of line.matchAll(/(?:^|[^\w$.<])<([A-Z][\w$]+)(?=[\s/>])/g)) {
    const name = m[1];
    if (/^\s*(extends|,)/.test(line.slice(m.index + m[0].length))) continue; // a type parameter, not a tag
    if (name.includes('$')) continue;
    const { all, tags } = wordCounts(ctx);
    if ((all.get(name) || 0) === (tags.get(name) || 0) && !/^(React|Fragment)$/.test(name)) return true;
  }
  return false;
}

// HTA-001: a subfolder .htaccess that turns rewriting on replaces the parent's rewrite rules for that folder (unless it
// inherits them), so the https redirect written above stops at its door.
function parentRedirectsHttps(line, ctx) {
  if (!/\//.test(ctx.rel)) return false;
  let d = path.dirname(path.dirname(ctx.abs));
  for (let k = 0; k < 8; k++) {
    let t = ''; try { t = fs.readFileSync(path.join(d, '.htaccess'), 'utf8'); } catch {}
    if (/%\{HTTPS\}|%\{SERVER_PORT\}|X-Forwarded-Proto|RewriteRule[^\n]*https:\/\//i.test(t)) return true;
    const up = path.dirname(d);
    if (up === d || path.relative(ctx.dir, d).startsWith('..')) break;
    d = up;
  }
  return false;
}

// HTA-002: php_flag / php_value outside an <IfModule mod_php...> block.
function outsideIfModule(line, ctx, lines, i) {
  let open = 0;
  for (let k = 0; k < i; k++) {
    if (/^\s*<IfModule\s+[^>]*php/i.test(lines[k])) open++;
    else if (/^\s*<\/IfModule>/i.test(lines[k]) && open) open--;
  }
  return open === 0;
}

// UX-009: checkboxes sharing a name without [] in a form PHP reads: PHP keeps only the last one.
function repeatedCheckbox(line, ctx, lines, i) {
  if (!PHP.test(ctx.rel) && !/action\s*=\s*["'][^"']*\.php/i.test(ctx.text)) return false;
  const name = (/\bname\s*=\s*["']([^"'\[\]]+)["']/i.exec(line) || [])[1];
  if (!name) return false;
  const re = new RegExp('<input\\b(?=[^>]*type\\s*=\\s*["\']?checkbox)[^>]*\\bname\\s*=\\s*["\']' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']', 'i');
  // only inside the same form: stop at the form's own start (another form further up is another request)
  if (/<form\b/i.test(line.slice(0, line.search(re)))) return false; // this checkbox opens its own form
  for (let k = i - 1; k >= Math.max(0, i - 500); k--) { // a form's checkboxes sit within a few hundred lines
    if (/<\/form>/i.test(lines[k])) return false; // a form closed above: that one is another request
    if (re.test(lines[k])) return true;
    if (/<form\b/i.test(lines[k])) return false;
  }
  return false;
}

// REDIR-001 widened: header('Location: ' . $next) where $next was filled from the request.
function locationFromRequestVar(line, ctx) {
  const v = (/Location:\s*['"]\s*\.\s*\$(\w+)/i.exec(line) || [])[1];
  if (!v || v.startsWith('_')) return true; // the request array itself (the old form)
  const memo = fileMemo(ctx);
  if (!memo.fromRequest) { // every $name the file fills from the request, found once per file
    memo.fromRequest = new Set();
    for (const m of ctx.text.matchAll(/\$(\w+)\s*=\s*[^;]{0,300}?\$_(?:GET|POST|REQUEST)\b/g)) memo.fromRequest.add(m[1]);
  }
  return memo.fromRequest.has(v);
}

// CORS-002: the Origin is matched by a pattern that lets in subdomains (or anything ending in the name).
function loosePattern(line) {
  const m = /preg_match\s*\(\s*(['"])(.)(.*?)\2[a-z]*\1\s*,\s*\$\w*origin/i.exec(line);
  if (!m) return true; // endsWith / str_ends_with
  const p = m[3];
  return !/^\^https?:/.test(p) || /\.\*|\[\^|\(\[|\([^)]*\\\.\)\?|\+\\\./.test(p);
}

// PAY-003: a 200 answered inside the branch that handles a bad signature.
function badSignatureBranch(line, ctx, lines, i) {
  const head = ifAbove(lines, i, 4);
  return /!\s*[\w:>$-]*(verif|valid|check|hash_equals)\w*\s*\(/i.test(head) && /sig|hmac|signature/i.test(head);
}

// REL-001: the line writes a zip (a zip opened for writing, or a write whose target was named *.zip above) and the
// zip's name carries the version.
function writesVersionZip(line, ctx, lines, i) {
  const opensZip = /ZipFile\s*\([^)]*,\s*(mode\s*=\s*)?['"][wx]['"]|make_archive\s*\(|\bzip\s+-r\b|writeZip\s*\(|archiver\s*\(/.test(line);
  const m = /(?:ZipFile|make_archive|writeZip|writeFileSync|createWriteStream)\s*\(\s*([\w$.]+)|(?:copyFileSync|renameSync)\s*\([^,]+,\s*([\w$.]+)|['"]-f['"]\s*,\s*([\w$.]+)/.exec(line);
  const target = m ? (m[1] || m[2] || m[3]) : '';
  if (!opensZip && (!target || /ZipFile\s*\(/.test(line))) return false; // a zip opened to read
  // where the target was named: its last assignment within 60 lines above (else the 12 lines above)
  let named = '';
  if (target) {
    const set = new RegExp('(^|[^\\w$.])' + target.replace(/[.$]/g, '\\$&') + '\\s*=(?!=)');
    for (let k = i; k >= Math.max(0, i - 60); k--) if (set.test(lines[k])) { named = lines[k]; break; }
  }
  const near = named || lines.slice(Math.max(0, i - 12), i + 1).join('\n');
  if (!opensZip && !/\.zip\b/i.test(named) && !/zip/i.test(target)) return false;
  return /version/i.test(near + '\n' + line);
}

// ---- SEC-018: a secret written in under its own name, or as the fallback when a setting is empty ----
// The name says what it is and the value must look like one. A name for the secret's setting, a label, a path or a word
// is not a secret, and neither is the key Google publishes for testing.
const SECRET_NAME = /secret|passw(?:or)?d|private[_-]?key/i;
const SECRET_SETTING_NAME = /secret|passw(?:or)?d|private[_-]?key|api[_-]?key|auth[_-]?token|access[_-]?token/i;
const NAMES_SOMETHING_ELSE = /(?:name|file|path|header|url|uri|id|dir|field|label|prefix|suffix|hash|env|var|ref|arn|manager|store|length|len|size|type|title|message|msg|text|placeholder|regex|pattern|param|policy|version|count|rotation)s?$/i;
const NOT_A_SECRET_NAME = /^\$?(?:is|has|show|hide|use|uses|needs|with|no|can|should)(?=[A-Z_-])|^\$?(?:site|public|publishable|anon)/i;
const SECRET_PLACEHOLDER = /example|changeme|change[_-]me|changeit|your[_-]|yourStrong|placeholder|_here|xxxx|\*\*\*|test|dummy|sample|not[_-]?a[_-]?secret|dev[_-]?only|^6LeIxAcTAAAAA/i;
const NOT_A_VALUE = /[/\\.$<>{}%\s]/;
const namesSecret = (text, word) => (text.match(/[A-Za-z_$][\w$-]{0,80}/g) || []).some(id => word.test(id) && !NAMES_SOMETHING_ELSE.test(id) && !NOT_A_SECRET_NAME.test(id));
const plainValue = v => !NOT_A_VALUE.test(v) && !SECRET_PLACEHOLDER.test(v) && !/^[A-Z0-9_]+$/.test(v);
const hasLetterAndDigit = v => /[a-z]/i.test(v) && /\d/.test(v);
const fallbackValue = v => plainValue(v) && (v.length >= 20 || hasLetterAndDigit(v));
const keyShaped = v => plainValue(v) && v.length >= 20 && hasLetterAndDigit(v) && new Set(v).size >= 8;
const SETTING_WITH_LITERAL = /\b(?:getenv|environ\.get|environ\.setdefault|ENV\.fetch|env|config)\s*\(\s*['"]([^'"\n]{1,80})['"]\s*,\s*['"]([^'"\s]{8,200})['"]/;
const LITERAL_AFTER_FALLBACK = /(\?:|\?\?|\|\||\s:)\s*(['"`])([^'"`\s]{8,200})\2\s*[)\]},;]*\s*(?:(?:\/\/|#).*)?$/;
const LITERAL_BESIDE_NAME = /(?:^|[\s,;({[])(\$?[A-Za-z_][\w-]{0,80}|['"][\w.-]{1,80}['"]\s*\]?)\s*(?:=>|=|:)\s*(['"`])([^'"`\s]{20,200})\2\s*[)\]},;]*\s*(?:(?:\/\/|#).*)?$/;
const DEFINE_WITH_LITERAL = /\bdefine\s*\(\s*['"]([\w-]{1,80})['"]\s*,\s*['"]([^'"\s]{20,200})['"]/;
// Lines SEC-004, SEC-013 and SEC-017 already report.
const READ_ELSEWHERE = /\b(?:password|passwd|db_pass|secret)\s{0,20}['"]?\s{0,20}[:=]>?\s{0,20}['"][^'"\s$]{8,}['"]|\bdefine\s*\(\s*['"](?:[A-Z0-9_]{0,40}_)?(?:PASSWORD|PASSWD|PASS|SECRET)(?:_[A-Z0-9_]{0,40})?['"]\s*,\s*['"]/i;
const SIGNING_SECRET_IN_JS = /\.(m?[jt]sx?|cjs|mts|cts)$/i;
const SIGNING_SECRET = /\b\w{0,30}(?:JWT|SESSION|COOKIE|AUTH|SIGNING)_?SECRET\w{0,30}\s*(?:[:=]|\|\||\?\?)\s*['"`]/i;
// A PHP settings file is where a secret belongs, as long as it is never shared: SEC-019 says so at Medium.
const PHP_SETTINGS_FILE = /(^|\/)[^/]*(config|settings|secrets?|credentials)[^/]*\.php$/i;
function secretAsFallback(line, ctx) {
  if (line.length > 2000 || READ_ELSEWHERE.test(line)) return false;
  if (SIGNING_SECRET.test(line) && SIGNING_SECRET_IN_JS.test((ctx && ctx.rel) || '')) return false;
  const call = SETTING_WITH_LITERAL.exec(line);
  if (call && namesSecret(call[1], SECRET_SETTING_NAME) && fallbackValue(call[2])) return true;
  const fb = LITERAL_AFTER_FALLBACK.exec(line);
  if (fb && fallbackValue(fb[3])) {
    const left = line.slice(0, fb.index);
    const ternary = fb[1].trim() === ':';
    // cond ? 'a' : 'b' picks between two literals; neither is what a setting falls back to.
    if ((!ternary || (left.includes('?') && !/\?\s*['"`][^'"`]*['"`]\s*$/.test(left))) && namesSecret(left, SECRET_SETTING_NAME)) return true;
  }
  return false;
}
function secretBesideName(line, ctx) {
  if (line.length > 2000 || READ_ELSEWHERE.test(line)) return false;
  if (SIGNING_SECRET.test(line) && SIGNING_SECRET_IN_JS.test((ctx && ctx.rel) || '')) return false;
  const plain = LITERAL_BESIDE_NAME.exec(line);
  if (plain && keyShaped(plain[3]) && namesSecret(plain[1], SECRET_NAME)) return true;
  const def = DEFINE_WITH_LITERAL.exec(line);
  return !!def && keyShaped(def[2]) && namesSecret(def[1], SECRET_NAME);
}
const writtenInSecret = (line, ctx) => secretAsFallback(line, ctx) || (secretBesideName(line, ctx) && !PHP_SETTINGS_FILE.test((ctx && ctx.rel) || ''));
const secretInSettingsFile = (line, ctx) => !secretAsFallback(line, ctx) && secretBesideName(line, ctx);

// ---- keys that reach the browser (apps built quickly, often with an AI helper) ----
// Test folders: a rule rated Critical runs on test files unless it says otherwise (lib/audit.js codeAudit).
const TEST_PATH = /(^|\/)(tests?|spec|__tests__|fixtures?|museum)\/|\.(test|spec)\.\w+$|(^|\/)test_\w*\.py$/i;
// Code in these places runs only on the server, so a key used there is where it belongs.
// (src/api/ and public/scripts/ hold browser code in many apps, so those names count only outside such a folder.)
const SERVER_ONLY_PATH = /(^|\/)(app\/(?:[^\n]*\/)?api|pages\/api|server|backend|lib\/server|supabase\/functions|netlify\/functions|edge-functions|cron|migrations?|prisma|seeds?)\/|(?:^|\/)(?<!src\/)(?<!public\/)(?<!static\/)(?<!assets\/)(?:api|functions|scripts|tools)\/|(^|\/)(route|middleware|proxy|server)\.(m?js|cjs|ts)$|\.server\.\w+$|(^|\/)\+server\.\w+$|(^|\/)(vite|next|webpack|tailwind|postcss|nuxt)\.config\.\w+$/i;
// Code in these places is sent to the visitor's browser.
const BROWSER_PATH = /(^|\/)(components|views|screens|hooks|composables|contexts?|providers?|frontend|client|public|static|assets|pages|www)\/|(^|\/)src\/(App|main)\.(jsx|tsx)$|(^|\/)src\/App\.js$|(^|\/)src\/index\.(jsx|tsx)$/i;
const SERVER_MARK = /\bserver-only\b|^[ \t]*['"]use server['"]|\bgetServerSideProps\b|\bgetStaticProps\b|\bcreateServer\s*\(|\brequire\(\s*['"](?:node:)?(?:fs|http|https|child_process|express|fastify|koa)['"]\s*\)|\bfrom\s+['"](?:node:)?(?:fs|http|https|child_process|express|fastify|koa|hono)['"]/m;
const USE_CLIENT = /^[ \t]*['"]use client['"]/m;
// With Next.js's app/ router a component runs on the server unless it says 'use client' or a client file imports it.
const MAY_RUN_ON_SERVER = /(^|\/)(components|views|screens|hooks|contexts?|providers?)\//i;
const routerRoots = new Map(), clientImportLists = new Map(), viteRoots = new Map();
function appRouterRoot(ctx) {
  let d = path.dirname(ctx.abs);
  for (let k = 0; k < 12; k++) {
    if (!routerRoots.has(d)) routerRoots.set(d, ['app', path.join('src', 'app')].some(a => ['tsx', 'jsx', 'js', 'ts'].some(x => fs.existsSync(path.join(d, a, 'layout.' + x)))));
    if (routerRoots.get(d)) return d;
    const up = path.dirname(d);
    if (up === d || path.relative(ctx.dir, up).startsWith('..')) return null;
    d = up;
  }
  return null;
}
const modulePath = s => s.replace(/\.(?:m?js|cjs|tsx?|jsx|json)$/i, '').replace(/\/index$/i, '');
// What the client files of the project import, read once per project in each audit: paths from the root for ./x, and
// what follows the alias for @/x (a folder's name alone is not enough: lib/supabase/admin.ts is not components/admin).
function clientImports(root) {
  if (clientImportLists.has(root)) return clientImportLists.get(root);
  const paths = new Set(), aliased = new Set();
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 8 || n > 3000) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|vendor|\.git|\.next|dist|build|out|_releases|releases)$/.test(e.name)) walk(p, depth + 1); continue; }
      if (!e.isFile() || !/\.(m?js|tsx?|jsx)$/i.test(e.name) || ++n > 3000) continue;
      let t = ''; try { if (fs.statSync(p).size < 800 * 1024) t = fs.readFileSync(p, 'utf8'); } catch {}
      if (!USE_CLIENT.test(t)) continue;
      const dir = path.relative(root, d).replace(/\\/g, '/');
      for (const m of t.matchAll(/\b(?:from|import)\s*\(?\s*['"`]([^'"`\n]{1,200})['"`]/g)) {
        const alias = /^[@~#]\/(.+)$/.exec(m[1]);
        if (alias) aliased.add(modulePath(alias[1]));
        else if (m[1][0] === '.') paths.add(modulePath(path.posix.join(dir, m[1])));
      }
    }
  };
  walk(root, 0);
  const list = { paths, aliased: [...aliased] };
  clientImportLists.set(root, list);
  return list;
}
function importedByClient(ctx, root) {
  const { paths, aliased } = clientImports(root);
  const rel = modulePath(path.relative(root, ctx.abs).replace(/\\/g, '/'));
  return paths.has(rel) || aliased.some(a => rel === a || rel.endsWith('/' + a));
}
// A server component: no 'use client', in an app/ router project, and no client file imports it.
function serverComponent(ctx) {
  const memo = fileMemo(ctx);
  if (memo.serverComponent === undefined) {
    memo.serverComponent = false;
    const inApp = /(^|\/)app\//.test(ctx.rel);
    if ((inApp || MAY_RUN_ON_SERVER.test(ctx.rel)) && !USE_CLIENT.test(ctx.text)) {
      const root = appRouterRoot(ctx);
      memo.serverComponent = !!root && (inApp || !importedByClient(ctx, root));
    }
  }
  return memo.serverComponent;
}
// A plain Vite app sends all of src/ to the browser. vite.config beside index.html is that shape; SvelteKit and Nuxt run
// vite too, with no index.html there, and their src/ may be server code.
function plainViteSource(ctx) {
  let d = path.dirname(ctx.abs);
  for (let k = 0; k < 12; k++) {
    if (!viteRoots.has(d)) viteRoots.set(d, fs.existsSync(path.join(d, 'index.html')) && ['js', 'ts', 'mjs', 'cjs', 'mts'].some(x => fs.existsSync(path.join(d, 'vite.config.' + x))));
    if (viteRoots.get(d)) return path.relative(d, ctx.abs).replace(/\\/g, '/').startsWith('src/');
    const up = path.dirname(d);
    if (up === d || path.relative(ctx.dir, up).startsWith('..')) return false;
    d = up;
  }
  return false;
}
// Only what is plain from the file: a shared lib file with no sign either way is left alone (it stays quiet).
function browserCode(ctx) {
  const memo = fileMemo(ctx);
  if (memo.browser === undefined) {
    const { rel, text } = ctx;
    memo.browser = /\.(m?js|cjs|tsx?|jsx|html?|vue|svelte|astro)$/i.test(rel) && !SERVER_ONLY_PATH.test(rel) && (
      USE_CLIENT.test(text) ||
      (!SERVER_MARK.test(text) && (/\.(html?|vue|svelte|astro)$/i.test(rel) || (BROWSER_PATH.test(rel) && !serverComponent(ctx)) || /\b(?:VITE|REACT_APP|EXPO_PUBLIC|VUE_APP|GATSBY)_[A-Z0-9_]/.test(text) ||
        plainViteSource(ctx) || importedByClient(ctx, appRouterRoot(ctx) || ctx.dir))));
  }
  return memo.browser;
}
// Astro runs its frontmatter and template on the server: only a <script> block reaches the browser.
const inAstroScript = (line, lines, i) => insideScript(lines, i, line.length);
const usedInBrowser = (line, ctx, lines, i) => !/^\s*(\/\/|\/\*|\*)/.test(line) && (/\.astro$/i.test(ctx.rel) ? !SERVER_ONLY_PATH.test(ctx.rel) && inAstroScript(line, lines, i) : browserCode(ctx));
// A build tool copies any variable with one of these prefixes into the pages every visitor downloads. PUBLIC_ alone is
// SvelteKit's and Astro's; a name's own \b keeps NEXT_PUBLIC_X from being read twice.
const PUBLIC_PREFIX = '(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|VUE_APP|GATSBY|PUBLIC)';
const PUBLIC_VAR = new RegExp('\\b(' + PUBLIC_PREFIX + '_[A-Z0-9_]{1,80})', 'g');
const LEADING_PREFIX = new RegExp('^' + PUBLIC_PREFIX + '_');
const ENV_LINE_PUBLIC = new RegExp('^\\s*(?:export\\s+)?' + PUBLIC_PREFIX + '_');
// Keys that are meant to be in the page: anon and publishable keys, site keys, Firebase web keys, map and analytics
// keys. A secret version of one of them says so in its name, and that is read first (isStrongSecret).
const PUBLIC_BY_DESIGN = /ANON|PUBLISHABLE|PUBLIC_?KEY|SITE_?KEY|CLIENT_ID|(?:^|_)(?:SHOW|HIDE|ENABLE|DISABLE|HAS|USE|ALLOW|REQUIRE|RESET|FORGOT|MIN|MAX)_(?:\w{0,30}_)?PASSWORD$|(?:^|_)FIREBASE_(?:WEB_)?API_?KEY$|(?:^|_)(?:GOOGLE_?)?(?:MAPS?|GMAPS?|PLACES)(?:_JAVASCRIPT)?(?:_API)?_?(?:KEY|TOKEN)$|(?:^|_)(?:MAPBOX|MAPTILER|STADIA|CESIUM|HERE_MAPS)(?:_\w{0,20})?_(?:KEY|TOKEN)$|(?:^|_)POSTHOG(?:_PROJECT)?(?:_API)?_?(?:KEY|TOKEN)$|(?:^|_)ALGOLIA_\w{0,20}SEARCH\w{0,20}_?KEY$|(?:^|_)DOCSEARCH_API_KEY$|(?:^|_)(?:TINYMCE|SEGMENT|MIXPANEL|AMPLITUDE|INTERCOM|PLAUSIBLE|UMAMI|GA|GTM|CRISP|HOTJAR|CLARITY)(?:_\w{0,20})?_(?:KEY|TOKEN)$/;
// Named for a secret, ending on the word: SECRET_SANTA_URL, PRIVATE_BETA and PASSWORD_MIN_LENGTH are not secrets.
const SECRET_VAR = /SERVICE_?ROLE|SUPABASE_\w{0,30}SERVICE_KEY|SERVICE_ACCOUNT(?:_KEY|_JSON)?$|(?:^|_)SECRET(?:_ACCESS)?(?:_KEY|_TOKEN)?$|(?:^|_)AUTH_TOKEN$|(?:^|_)PRIVATE_?KEY$|(?:^|_)(?:PASSWORD|PASSWD)$|(?:^|_)(?:DB|DATABASE|ADMIN|ROOT|SMTP|MAIL|EMAIL|MYSQL|POSTGRES|PG)_(?:PASS|PWD)$|(?:^|_)(?:DATABASE|DB|POSTGRES|MONGO|MONGODB)_(?:URL|URI)$|(?:^|_)(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE_GENERATIVE_AI|GROQ|MISTRAL|COHERE|DEEPSEEK|OPENROUTER|PERPLEXITY|XAI|REPLICATE|HUGGING_?FACE|HF|ELEVEN_?LABS|STABILITY|TOGETHER|SENDGRID|RESEND|MAILGUN|POSTMARK|TWILIO|GITHUB|GH|SLACK|DISCORD|TELEGRAM|NOTION|AIRTABLE)(?:_\w{0,30})?_(?:KEY|TOKEN|SECRET)$|(?:^|_)STRIPE_(?:SK|RESTRICTED_KEY)$/;
// Some service's key by its usual ending. Whether it is safe in a page depends on the service, and no list of names can
// keep up with every service, so these are rated Medium and the finding says how to judge (ENV-004, ENV-005).
const KEY_LIKE_VAR = /API_?KEY$|(?:^|_)(?:ACCESS_)?TOKEN$|WEBHOOK_URL$/;
const isStrongSecret = name => {
  const bare = name.replace(LEADING_PREFIX, '');
  return SECRET_VAR.test(bare) && (/SERVICE_?ROLE|SECRET|PRIVATE_?KEY/.test(bare) || !PUBLIC_BY_DESIGN.test(bare));
};
const isSecretVar = name => {
  const bare = name.replace(LEADING_PREFIX, '');
  return isStrongSecret(name) || (KEY_LIKE_VAR.test(bare) && !PUBLIC_BY_DESIGN.test(bare));
};
const SECRET_VALUE = /^['"]?(?:[sr]k_(?:live|test)_\w{8}|sk-(?:ant-|proj-)?[\w-]{20}|whsec_\w{16}|sb_secret_\w{8})/;
const PLACEHOLDER_VALUE = /^['"]?(?:$|['"]$|your|<|\.\.\.|x{3}|change|replace|todo|placeholder|example)/i;
const ENV_LINE = /^\s*(?:export\s+)?([A-Z0-9_]{1,120})\s*=\s*(.*)$/;
const PUBLIC_ENV_LINE = new RegExp('^\\s*(?:export\\s+)?' + PUBLIC_PREFIX + '_[A-Z0-9_]{1,80}\\s*=');
const PUBLIC_VAR_READ = new RegExp(String.raw`\b(?:process\.env|import\.meta\.env)\s*(?:\.|\[\s*['"])\s*` + PUBLIC_PREFIX + String.raw`_[A-Z0-9_]{1,80}|\{[^{}\n]{0,300}\}\s*=\s*(?:process\.env|import\.meta\.env)\b|\{[^{}\n]{0,300}\}\s*from\s+['"]\$env\/(?:static|dynamic)\/public['"]|\benv\.PUBLIC_[A-Z0-9_]{1,80}`);
// ENV-001: one line of a .env file. The name or the value says it is a secret, and a real value is filled in.
function publicEnvSecret(line) {
  const m = ENV_LINE.exec(line);
  if (!m) return false;
  const value = m[2].trim();
  if (SECRET_VALUE.test(value)) return true;
  return isStrongSecret(m[1]) && !PLACEHOLDER_VALUE.test(value);
}
// ENV-004: the same for a key known only by its usual ending: the page gives it away, but what it can do is not known.
function publicEnvKey(line) {
  const m = ENV_LINE.exec(line);
  if (!m) return false;
  const value = m[2].trim();
  return !SECRET_VALUE.test(value) && !isStrongSecret(m[1]) && isSecretVar(m[1]) && !PLACEHOLDER_VALUE.test(value);
}
// ENV-002 and ENV-005: a public variable read in code that is not plainly server-only, by what its name says.
function publicVarInCode(line, ctx, lines, i, says) {
  if (SERVER_ONLY_PATH.test(ctx.rel)) return false;
  if (/\.astro$/i.test(ctx.rel) ? !inAstroScript(line, lines, i) : serverComponent(ctx)) return false;
  for (const m of line.matchAll(PUBLIC_VAR)) if (says(m[1])) return true;
  return false;
}
const isOnlyKeyLike = name => isSecretVar(name) && !isStrongSecret(name);
// The name of the block a line sits in: for env: { ... } that is env.
function enclosingKey(lines, i, col) {
  let depth = 0, budget = 4000; // a config's blocks are short: a file of nothing but such lines must not cost more
  for (let k = i; k >= Math.max(0, i - 60) && budget > 0; k--) {
    const s = k === i ? lines[k].slice(0, col) : lines[k];
    if (s.length > 2000) return '';
    budget -= s.length;
    for (let c = s.length - 1; c >= 0; c--) {
      if (s[c] === '}') depth++;
      else if (s[c] === '{') {
        if (depth) { depth--; continue; }
        return (/([\w$]+)['"]?\s*:\s*$/.exec(s.slice(Math.max(0, c - 80), c)) || [])[1] || '';
      }
    }
  }
  return '';
}
// ENV-003: a build config that puts a secret in the browser code: vite's define, next's env and publicRuntimeConfig,
// nuxt's runtimeConfig.public. (A key in next's serverRuntimeConfig or at the top of nuxt's runtimeConfig stays on the server.)
function configSendsSecret(line, ctx, lines, i) {
  if (/^\s*(\/\/|\/\*|\*)/.test(line) || line.length > 2000) return false;
  const base = path.basename(ctx.rel).toLowerCase();
  if (base.startsWith('vite.')) {
    if (!/\bdefine\s*:/.test(ctx.text)) return false;
    if (/['"`]process\.env['"`]\s*:\s*(?:JSON\.stringify\s*\(\s*)?(?:process\.env|env)\b/.test(line)) return true;
    // loadEnv with an empty prefix returns every setting; with none given, only the VITE_ ones
    if (/['"`]process\.env['"`]\s{0,20}:\s{0,20}(?:JSON\.stringify\s{0,20}\(\s{0,20})?loadEnv\s{0,20}\([^\n]{0,120}?,\s{0,20}(?:''|""|``)\s{0,20}\)/.test(line)) return true;
    const m = /['"`](?:process|import\.meta)\.env\.(\w{1,80})['"`]\s*:/.exec(line);
    return !!m && isSecretVar(m[1]);
  }
  const blocks = base.startsWith('next.') ? ['env', 'publicRuntimeConfig'] : ['public'];
  // the block is read once a line, at its first secret: a line that opens two blocks is not how a config is written
  for (const m of line.matchAll(/\b\w{1,60}['"`]?\s*:\s*process\.env\.(\w{1,80})/g)) {
    if (isSecretVar(m[1])) return blocks.includes(enclosingKey(lines, i, m.index));
  }
  return false;
}
// KEY-002: a Supabase service-role key: a token whose middle part says role service_role (the fixed key the local
// Supabase tools print for every developer is left alone), or a key in the newer sb_secret_ form.
const SIGNED_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,1000}\.(eyJ[A-Za-z0-9_-]{16,2000})\.[A-Za-z0-9_-]{16}/g;
function serviceRoleKey(line, ctx) {
  // In a .env file the key is where it belongs, unless the variable's name sends it to the browser.
  if (!ctx.history && /^\.env/i.test(path.basename(ctx.rel)) && !ENV_LINE_PUBLIC.test(line)) return false;
  // each key is judged by itself: an example key elsewhere on the line must not hide a real one
  for (const m of line.matchAll(/\bsb_secret_\w{16,}/g)) if (!/^sb_secret_(?:x{3}|your|example)/i.test(m[0])) return true;
  for (const m of line.matchAll(SIGNED_TOKEN)) {
    let said = '';
    try { said = Buffer.from(m[1], 'base64').toString('utf8'); } catch { continue; }
    if (/"role"\s*:\s*"service_role"/.test(said) && !/"iss"\s*:\s*"supabase-demo"/.test(said)) return true;
  }
  return false;
}

// LOG-001: a value named for a secret among what console.log prints. Words inside quotes are only words; the length of
// a token, or whether there is one, tells a reader of the log nothing.
const LOGGED_SECRET = /(?:^|[,\s+{(]|\$\{)(?:[\w$]{1,40}(?:\?\.|\.)){0,6}(token|access_?token|refresh_?token|auth_?token|id_?token|session_?token|bearer_?token|jwt|password|passwd|secret|client_?secret|secret_?key|api_?key|private_?key|authorization|credentials|cookie|session)\b(?!\s*(?:\?|[!=]==?|&&|\|\||:|\.|\(|\[|[\w$]))/gi;
// The server's settings, the request's whole headers (cookies and tokens), and a sign-in's whole body (the password).
const LOGGED_SETTING = /(?:^|[,\s+{(]|\$\{)(?:process\.env|import\.meta\.env)(?:\.(\w{1,80}))?(?![\w.])(?!\s*(?:\?|[!=]==?|&&|\|\||:|\.|\(|\[))/g;
const LOGGED_REQUEST = /(?:^|[,\s+{(]|\$\{)(?:(?:req|request)\.(headers|body)|(body))\b(?!\s*(?:\?|[!=]==?|&&|\|\||:|\.|\(|\[|[\w$]))/g;
const SIGN_IN_PATH = /log-?in|sign-?in|sign-?up|register|auth|password/i;
// mask(token) prints what mask gives back
const inACall = (args, m) => m[0][0] === '(' && /[\w$]$/.test(args.slice(0, m.index));
function logsSecret(line, ctx) {
  const at = line.search(/\bconsole\.(?:log|info|debug|warn|error)\s*\(/);
  const args = line.slice(line.indexOf('(', at) + 1)
    .replace(/`(?:\\.|\$\{[^}]*\}|\$(?!\{)|[^`\\$])*`/g, t => ' ' + (t.match(/\$\{[^}]*\}/g) || []).join(' , ') + ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""').split(';')[0]
    .replace(/\bJSON\.stringify\s*\(/g, ' ( ');
  for (const m of args.matchAll(LOGGED_SETTING)) if (!inACall(args, m) && (!m[1] || isSecretVar(m[1]))) return true;
  for (const m of args.matchAll(LOGGED_REQUEST)) {
    if (inACall(args, m)) continue;
    if (m[1] === 'headers') return true;
    if (SIGN_IN_PATH.test(ctx.rel) && /password/i.test(ctx.text)) return true;
  }
  for (const m of args.matchAll(LOGGED_SECRET)) {
    const word = m[1].toLowerCase();
    if (inACall(args, m)) continue;
    // a lexer's token, a chat's token count, a workout's session
    if (word === 'token' && /\b(?:lexer|tokenizer|tokenize|tiktoken|parser)\b/i.test(ctx.text)) continue;
    if (word === 'session' && !/\b(?:getSession|useSession|getServerSession|next-auth|req\.session|supabase\.auth|cookie)\b/i.test(ctx.text)) continue;
    return true;
  }
  return false;
}

// CORS-003: the option that opens CORS to every site, with credentials on in the same block.
const HAND_SET_ORIGIN = /[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin['"`]\s{0,20}[,:]\s{0,20}([^\n]{0,160})/;
const HAND_SET_CREDENTIALS = /[Aa]ccess-[Cc]ontrol-[Aa]llow-[Cc]redentials['"`]\s{0,20}[,:]\s{0,20}(?:['"`]true['"`]|true\b)/;
const REQUEST_ORIGIN = /\b(?:req|request|event)\.headers\.origin\b|\bheaders\s{0,20}\[\s{0,20}['"`]origin['"`]|\b(?:headers\.get|req\.get|req\.header|getHeader)\s{0,20}\(\s{0,20}(?:\w{1,20}\s{0,20},\s{0,20})?['"`]origin['"`]|\{[^{}\n]{0,60}\borigin\b[^{}\n]{0,60}\}\s{0,20}=\s{0,20}(?:req|request)\.headers\b/i;
const ORIGIN_LOOKED_AT = /\.(?:includes|has|test|indexOf|match|some|find|endsWith|startsWith)\s{0,20}\(|[!=]==?|\?(?!\?)/;
const ORIGIN_ECHOED = /\borigin\s{0,20}:\s{0,20}(?:async\s{1,20})?\(?\s{0,20}([A-Za-z_$][\w$]{0,30})(?:\s{0,20},\s{0,20}[\w$]{1,30})?\s{0,20}\)?\s{0,20}=>\s{0,20}(?:\{\s{0,20}return\s{1,20})?\1(?![\w$])(?!\s{0,20}[.([?&|=+\-!<>])/;
// The visitor's own Origin sent back as the allowed one, by hand, with nothing looked at first. A star is left alone:
// browsers refuse a star with credentials.
function reflectsOriginByHand(hand, line, lines, i) {
  const value = hand[1];
  const name = (/^([A-Za-z_$][\w$]{0,40})\s{0,20}(?:[,)}]|$)/.exec(value) || [])[1];
  const above = lines.slice(Math.max(0, i - 5), i);
  if (!REQUEST_ORIGIN.test(value) && !(name && above.some(l => l.includes(name) && REQUEST_ORIGIN.test(l)))) return false;
  if (ORIGIN_LOOKED_AT.test(value)) return false;
  if (ORIGIN_LOOKED_AT.test(line.slice(0, hand.index))) return false;
  return !above.some(l => (/origin/i.test(l) || (name && l.includes(name))) && ORIGIN_LOOKED_AT.test(l));
}
function openCorsCredentials(line, ctx, lines, i) {
  const near = lines.slice(Math.max(0, i - 5), i + 6).join('\n');
  if (/\bNODE_ENV\b|\bisDev\b|__DEV__/.test(near)) return false;
  const hand = HAND_SET_ORIGIN.exec(line);
  if (hand) return HAND_SET_CREDENTIALS.test(near) && reflectsOriginByHand(hand, line, lines, i);
  if (/\bCORS\s*\(/.test(line)) return !/\b(?:origins|resources)\s*=\s*(?:\[\s*)?['"{](?!\*)/.test(line);
  if (/allow_origins/.test(line)) {
    if (!/\ballow_credentials\s*=\s*True\b/.test(near)) return false;
    // allow_origins=origins, where origins = ["*"] (the lists are found once a file)
    const name = (/\ballow_origins\s*=\s*([A-Za-z_]\w*)/.exec(line) || [])[1];
    if (!name) return true;
    const memo = fileMemo(ctx);
    if (!memo.starLists) memo.starLists = new Set([...ctx.text.matchAll(/^[ \t]*([A-Za-z_]\w{0,60})\s*=\s*\[\s*['"]\*['"]\s*\]/gm)].map(m => m[1]));
    return memo.starLists.has(name);
  }
  if (!/\bcredentials\s*:\s*true\b/.test(near)) return false;
  // Hono's origin: (origin) => origin hands back whichever site asked
  if (ORIGIN_ECHOED.test(line)) return true;
  // origin: (o, cb) => cb(null, true) says yes to every site; a function that looks first is a list
  const fn = /\borigin\s*:\s*(?:async\s*)?(?:function\b[^(\n]{0,40})?\(\s*\w{1,30}\s*,\s*(\w{1,30})\s*\)\s*(?:=>\s*)?\{?\s*/.exec(line);
  if (!fn) return true;
  let after = line.slice(fn.index + fn[0].length);
  if (!after.trim()) after = (lines.slice(i + 1, i + 4).find(l => l.trim()) || '').trim();
  return after.startsWith(fn[1]) && /^\s*\(\s*null\s*,\s*true\s*\)/.test(after.slice(fn[1].length));
}

// PAY-006: an amount for the payment provider that comes from what the visitor sent.
const MONEY_FIELD = /amount|amt|price|total|cost|cents|dollars|euros|pence/i;
const PAY_DECL = String.raw`\b(?:const|let|var)\s+(\{[^{}\n]{0,300}\}|[A-Za-z_$][\w$]{0,40})\s*(?::\s*\w{1,40}\s*)?=\s*(?:await\s+)?`;
// schema.parse(...), safeParse, validate: checked, but still what the visitor sent
const PAY_PARSER = String.raw`[\w$.]{1,40}\.(?:parse|parseAsync|safeParse|safeParseAsync|validate|validateSync)\s*\(\s*`;
// the request may hang off an object: Hono's c.req.json(), Koa's ctx.request.body
const PAY_BODY = new RegExp(PAY_DECL + '(?:' + PAY_PARSER + String.raw`(?:await\s+)?)?(?:(?:[\w$]{1,20}\.)?(?:req|request)\.(?:body|query|params|json\s*\(\s*\)|parseBody\s*\(\s*\)|formData\s*\(\s*\)|valid\s*\(\s*['"](?:json|form|query)['"]\s*\))|readBody\s*\(\s*[\w$]{1,20}\s*\)|JSON\.parse\s*\(\s*(?:req|request)\.body\s*\))(?![\w.[])`, 'g');
const PAY_PARSED = new RegExp(PAY_DECL + PAY_PARSER + String.raw`([A-Za-z_$][\w$]{0,40})\s*\)`, 'g');
const PAY_ALIAS = new RegExp(PAY_DECL + String.raw`([A-Za-z_$][\w$]{0,40})(?:\.data)?(?=[ \t]*(?:;|\r?$))`, 'gm');
// A function of this file that is handed what the visitor sent: { name: [params], at: where its code starts }.
const PAY_FN = /\bfunction\s+([A-Za-z_$][\w$]{0,60})\s*\(([^)\n]{0,200})\)[^{\n]{0,60}\{|\b(?:const|let|var)\s+([A-Za-z_$][\w$]{0,60})\s*(?::[^=\n]{0,60})?=\s*(?:async\s+)?(?:function\b[^(\n]{0,40})?(?:\(([^)\n]{0,200})\)[^\n=]{0,60}?(?:=>|\{)|([A-Za-z_$][\w$]{0,40})\s*=>)/g;
function payFunctions(text) {
  const fns = new Map();
  for (const m of text.matchAll(PAY_FN)) {
    const name = m[1] || m[3];
    if (!fns.has(name)) fns.set(name, { params: (m[2] ?? m[4] ?? m[5]).split(',').map(p => (/[A-Za-z_$][\w$]*/.exec(p) || [''])[0]), at: m.index + m[0].length, opened: m[0].endsWith('{') });
    if (fns.size >= 5000) break;
  }
  return fns;
}
// The code of such a function, up to 1,500 characters: comments and quoted text out, stopping where its block ends.
function payFunctionBody(text, fn) {
  const code = text.slice(fn.at, fn.at + 1500).replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '""').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trimStart();
  let depth = fn.opened ? 1 : 0, k = 0;
  for (; k < code.length; k++) {
    const c = code[k];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { if (--depth <= 0) { k++; break; } } else if (depth === 0 && (c === ';' || c === '\n')) break;
  }
  return code.slice(0, k);
}
// Does this code take a money field from its parameter, or from one item of it? PRODUCTS[item.id].price is the server's
// price, a list it fills in again is its own, and a sent price it compares with its own figure is being checked.
function readsSentPrice(body, param) {
  if (!param || /\.\w{0,30}(?:amount|price|total|cost)\w{0,30}\s*!==?|!==?\s*[\w$.[\]]{0,60}\.\w{0,30}(?:amount|price|total|cost)/i.test(body)) return false;
  const assigned = new Set([...body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,40})\s*=(?![=>])/g)].map(a => a[1]));
  if (assigned.has(param)) return false;
  const items = new Set([param]);
  const item = e => {
    if (e[0] !== '{') { if (!assigned.has(e)) items.add(e); return false; }
    return e.slice(1, -1).split(',').some(p => MONEY_FIELD.test(p.split(':')[0]));
  };
  for (const e of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,40})\.(forEach|map|flatMap|filter|reduce)\s*\(\s*(?:async\s*)?(?:function\b[^(\n]{0,40})?\(?\s*(\{[^{}\n]{0,160}\}|[A-Za-z_$][\w$]{0,40})(?:\s*(?::[^,)\n]{0,40})?,\s*(\{[^{}\n]{0,160}\}|[A-Za-z_$][\w$]{0,40}))?/g)) {
    if (e[1] === param && item(e[2] === 'reduce' ? e[4] || '' : e[3])) return true;
  }
  for (const e of body.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+(\{[^{}\n]{0,160}\}|[A-Za-z_$][\w$]{0,40})\s+of\s+([A-Za-z_$][\w$]{0,40})\s*\)/g)) {
    if (e[2] === param && item(e[1])) return true;
  }
  for (const t of body.matchAll(/(?<![\w$.\]])([A-Za-z_$][\w$]{0,40})(?:\[\w{1,12}\])?\.([A-Za-z_$][\w$]{0,40})/g)) if (items.has(t[1]) && MONEY_FIELD.test(t[2])) return true;
  return false;
}
function bodyNames(ctx) {
  const memo = fileMemo(ctx);
  if (!memo.bodyNames) {
    // whole: the request's body under one name. sent: names that hold something taken out of it. money: those that hold
    // an amount, not a count or an id.
    const whole = new Set(), money = new Set(), sent = new Set();
    // Where each name is declared, and whether that declaration holds what the visitor sent: several routes of one file
    // use the same names, so a name is judged by its nearest declaration above.
    const decls = new Map();
    const mark = (name, at, held) => {
      let d = decls.get(name);
      if (!d) decls.set(name, d = new Map());
      if (held || !d.has(at)) d.set(at, held || d.get(at) || false);
    };
    const hold = (name, at) => { sent.add(name); money.add(name); mark(name, at, true); };
    const partName = part => (/([A-Za-z_$][\w$]*)\s*(?:=[^,]*)?$/.exec(part.trim()) || [])[1];
    const add = (target, at) => {
      if (target[0] !== '{') { whole.add(target); return; }
      // { price: p } keeps the name after the colon; a count or an id from the visitor is no price
      for (const part of target.slice(1, -1).split(',')) {
        const n = partName(part);
        if (!n) continue;
        sent.add(n);
        mark(n, at, true);
        if (MONEY_FIELD.test(part.split('=')[0])) money.add(n);
      }
    };
    for (const m of ctx.text.matchAll(PAY_BODY)) add(m[1], m.index);
    for (const m of ctx.text.matchAll(PAY_PARSED)) if (whole.has(m[2])) add(m[1], m.index);
    for (const m of ctx.text.matchAll(PAY_ALIAS)) if (whole.has(m[2])) add(m[1], m.index);
    for (const m of ctx.text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]{0,40})\s*=[^;\n]{0,80}\b(?:req|request)\.(?:body|query|params)\.(\w{1,40})/g)) if (MONEY_FIELD.test(m[2])) hold(m[1], m.index);
    // Number(formData.get('amount')), a server action's form or an address's search part
    for (const m of ctx.text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]{0,40})\s*(?::\s*\w{1,40}\s*)?=[^;\n]{0,80}\b(\w{1,40})\.get\s*\(\s*['"`](\w{1,40})['"`]/g)) {
      if ((m[2] === 'formData' || m[2] === 'searchParams' || whole.has(m[2])) && MONEY_FIELD.test(m[3])) hold(m[1], m.index);
    }
    // const total = items.reduce((s, i) => s + i.price * i.qty, 0), over a list the visitor sent. The money field must be
    // the callback's own item's: PRODUCTS[i.id].price is the server's price. Whose list it is shows further down.
    const sums = new Map();
    for (const m of ctx.text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]{0,40})\s*=\s*([A-Za-z_$][\w$]{0,40})(\.[A-Za-z_$][\w$]{0,40})?\.reduce\s*\(\s*(?:async\s*)?(?:function\b[^(\n]{0,40})?\(\s*[A-Za-z_$][\w$]{0,40}(?::\s*\w{1,30})?\s*,\s*(\{[^{}\n]{0,160}\}|[A-Za-z_$][\w$]{0,40})[^)\n]{0,60}\)[^\n]{0,20}?(?:=>|\{)/g)) {
      const rest = ctx.text.slice(m.index + m[0].length, m.index + m[0].length + 240);
      const paid = m[4][0] === '{'
        ? [...rest.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b/g)].some(t => MONEY_FIELD.test(t[1]) && new Set(m[4].slice(1, -1).split(',').map(p => p.trim().split(':').pop().trim())).has(t[1]))
        : [...rest.matchAll(/(?<![\w$.\]])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)].some(t => t[1] === m[4] && MONEY_FIELD.test(t[2]));
      if (paid) sums.set(m.index, { from: m[2], nested: !!m[3] });
    }
    // calculateOrderAmount(items): a function of this file, handed what the visitor sent, that adds up the prices in it.
    // Each one is read once, and a file with more of them than an honest one holds stops being read.
    let fns = null;
    const prices = new Map();
    const priced = (name, pos) => {
      const fn = fns.get(name), key = name + '/' + pos;
      if (!fn || !fn.params[pos]) return false;
      if (!prices.has(key)) {
        if (prices.size >= 200) return false;
        prices.set(key, readsSentPrice(payFunctionBody(ctx.text, fn), fn.params[pos]));
      }
      return prices.get(key);
    };
    const pricedCall = (expr, isSent) => {
      if (!whole.size && !sent.size) return false;
      if (!fns) fns = payFunctions(ctx.text);
      for (const c of expr.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,60})\s*\(([^()\n]{0,120})/g)) {
        if (!fns.has(c[1])) continue;
        const args = c[2].split(',');
        for (let pos = 0; pos < args.length && pos < 8; pos++) {
          const a = /^\s*([A-Za-z_$][\w$]{0,40})(\.[\w$.]{1,60})?\s*$/.exec(args[pos]);
          if (a && (a[2] ? whole.has(a[1]) : isSent(a[1])) && priced(c[1], pos)) return true;
        }
      }
      return false;
    };
    // One variable on from there, in the file's order: const cents = amount * 100, const total = body.total,
    // const total = addUp(items). What a comparison decides, and what stands before the ? of a choice, is not the value
    // itself. A value that goes through two variables is still seen.
    const now = new Map();
    const isSent = n => whole.has(n) || now.get(n) === true;
    const isMoney = n => money.has(n) && now.get(n) === true;
    if (whole.size || sent.size || sums.size) {
      let seen = 0;
      for (const m of ctx.text.matchAll(new RegExp(PAY_DECL + String.raw`(?=([^;\n]{1,160}))`, 'g'))) {
        if (++seen > 25000) break;
        if (/\/\/|^[ \t]*\*/.test(ctx.text.slice(Math.max(0, m.index - 160), m.index).split('\n').pop())) continue;
        const had = n => { const d = decls.get(n); return !!d && d.get(m.index) === true; };
        if (m[1][0] === '{') {
          for (const part of m[1].slice(1, -1).split(',')) { const n = partName(part); if (n) { now.set(n, had(n)); mark(n, m.index, false); } }
          continue;
        }
        const name = m[1], sum = sums.get(m.index);
        const code = m[2].replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '""');
        let held = had(name);
        if (sum) {
          if (whole.has(sum.from) || (!sum.nested && isSent(sum.from))) { hold(name, m.index); held = true; }
        } else if (!held && !/^\s*(?:[{[]|function\b)|=>/.test(code)) {
          if (expressionHolds(code, whole, isMoney, isSent, pricedCall)) { hold(name, m.index); held = true; }
          // const items = body.items: not money, but still the visitor's list
          else if (/^\s*[A-Za-z_$][\w$]{0,40}\.[\w$.]{1,60}\s*$/.test(code) && (whole.has(code.trim().split('.')[0]) || /^\s*(?:req|request)\.(?:body|query|params)\./.test(code))) { sent.add(name); mark(name, m.index, true); held = true; }
        }
        now.set(name, held);
        if (!held) mark(name, m.index, false);
      }
    }
    // the declarations of each name by line, for the search below
    const lineStarts = [];
    if (sent.size) for (let k = ctx.text.indexOf('\n'); k >= 0; k = ctx.text.indexOf('\n', k + 1)) lineStarts.push(k);
    const lineOf = at => { let lo = 0, hi = lineStarts.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] < at) lo = mid + 1; else hi = mid; } return lo; };
    const byLine = new Map();
    for (const name of sent) byLine.set(name, [...decls.get(name) || []].sort((a, b) => a[0] - b[0]).map(([at, held]) => [lineOf(at), held]));
    const heldAt = (name, line) => {
      const list = byLine.get(name);
      if (!list) return false;
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= line) lo = mid + 1; else hi = mid; }
      return lo === 0 ? true : list[lo - 1][1];
    };
    memo.bodyNames = { whole, heldAt, live: (name, line) => money.has(name) && heldAt(name, line), pricedCall };
  }
  return memo.bodyNames;
}
// An expression with its number wrappers taken off, and its lookups and other calls blanked: PRICES[id] and priceOf(id)
// use the id, they do not charge it. amount.toFixed(2) is still the amount.
function amountExpression(rhs, wrappers) {
  let s = rhs.replace(/\.(?:toFixed|toString|valueOf)\s*\([^()]{0,8}\)/g, '').replace(wrappers, '(');
  for (let k = 0; k < 2; k++) s = s.replace(/[\w$.]{1,60}\s*\([^()]*\)/g, ' 0 ').replace(/\[[^[\]]*\]/g, '');
  return s;
}
const JS_NUMBER_CALL = /\b(?:Number|parseInt|parseFloat|Math\.\w{1,10}|BigInt|Decimal)\s*\(/g;
// Does the right side of a declaration hold a value the visitor sent?
function expressionHolds(raw, whole, isMoney, isSent, pricedCall) {
  const choice = /(?<!\?)\?(?![.?])/.exec(raw);
  const expr = choice ? raw.slice(choice.index + 1) : raw;
  if (/[!=]==?|[<>]/.test(expr)) return false;
  if (pricedCall(expr, isSent)) return true;
  for (const t of amountExpression(expr.replace(/\.data\./g, '.'), JS_NUMBER_CALL).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    if (!t[2] && isMoney(t[1])) return true;
    if (t[2] && whole.has(t[1]) && MONEY_FIELD.test(t[2])) return true;
  }
  return false;
}
const PY_NUMBER_CALL = /\b(?:int|float|round|Decimal)\s*\(/g;
// PHP: 'amount' => $_POST['amount'], or a variable filled from it.
function phpAmount(line, ctx) {
  const m = /['"](?:amount|unit_amount)['"]\s*=>\s*([^,\n]{0,80})/.exec(line);
  if (!m) return false;
  for (const f of m[1].matchAll(/\$_(?:POST|GET|REQUEST)\s*\[\s*['"](\w{1,40})/g)) if (MONEY_FIELD.test(f[1])) return true;
  const memo = fileMemo(ctx);
  if (!memo.phpValues) {
    memo.phpValues = new Set();
    for (const v of ctx.text.matchAll(/\$(\w{1,40})\s*=[^;\n]{0,80}\$_(?:POST|GET|REQUEST)\s*\[\s*['"](\w{1,40})/g)) if (MONEY_FIELD.test(v[2])) memo.phpValues.add(v[1]);
  }
  return [...m[1].matchAll(/\$(\w{1,40})\b(?!\s*[[(]|->)/g)].some(v => memo.phpValues.has(v[1]));
}
// Python: a FastAPI route's typed body, or Flask's request.get_json() and the values taken from it.
const PY_NOT_A_BODY = /^(?:Request|Response|BackgroundTasks|Session|AsyncSession|User|Annotated|Optional|Depends)$/;
function pyNames(ctx) {
  const memo = fileMemo(ctx);
  if (!memo.pyNames) {
    const whole = new Set(), values = new Set();
    for (const m of ctx.text.matchAll(/^[ \t]*@\w{1,30}\.(?:post|put|patch|api_route)\b[^\n]{0,200}\n(?:[ \t]*@[^\n]{0,200}\n){0,2}[ \t]*(?:async\s+)?def\s+\w{1,60}\s*\(([^)\n]{0,400})\)/gm)) {
      for (const part of m[1].split(',')) {
        const p = /^\s*(\w{1,40})\s*:\s*([A-Z]\w{0,40})\s*$/.exec(part);
        if (p && !PY_NOT_A_BODY.test(p[2])) whole.add(p[1]);
      }
    }
    for (const m of ctx.text.matchAll(/^[ \t]*(\w{1,40})\s*=\s*(?:await\s+)?request\.(?:get_json\s*\([^)\n]{0,40}\)|json\s*\(\s*\)|json|form|args|values)[ \t\r]*$/gm)) whole.add(m[1]);
    for (const m of ctx.text.matchAll(/^[ \t]*(\w{1,40})\s*=[^\n]{0,60}\b(\w{1,40})(?:\[\s*|\.get\(\s*)['"](\w{1,40})['"]/gm)) {
      if ((whole.has(m[2]) || /^(?:json|form|args|values)$/.test(m[2])) && MONEY_FIELD.test(m[3])) values.add(m[1]);
    }
    for (const m of ctx.text.matchAll(/^[ \t]*(\w{1,40})\s*=[^\n]{0,60}\b(\w{1,40})\.(\w{1,40})\b/gm)) if (whole.has(m[2]) && MONEY_FIELD.test(m[3])) values.add(m[1]);
    memo.pyNames = { whole, values };
  }
  return memo.pyNames;
}
function pyAmount(line, ctx, lines, i) {
  // amount = data['amount'] only names the value; create(amount=amount) is the use of it
  if (/^\s*(?:amount|unit_amount)\s*=\s/.test(line)) return false;
  const m = /['"]?\b(?:amount|unit_amount)['"]?\s*[=:]\s*([^,\n]{1,80})/.exec(line);
  if (!m || !/\bcreate\s*\(|line_items|price_data/.test(lines.slice(Math.max(0, i - 8), i + 1).join('\n'))) return false;
  const { whole, values } = pyNames(ctx);
  for (const k of m[1].matchAll(/\b(\w{1,40})(?:\(\s*\))?(?:\[\s*|\.get\(\s*)['"](\w{1,40})['"]/g)) {
    if ((whole.has(k[1]) || /^(?:json|form|args|values|get_json)$/.test(k[1])) && MONEY_FIELD.test(k[2])) return true;
  }
  for (const t of amountExpression(m[1], PY_NUMBER_CALL).matchAll(/(?<![\w.])([A-Za-z_]\w*)(?:\.(\w+))?/g)) {
    if (!t[2] && values.has(t[1])) return true;
    if (t[2] && whole.has(t[1]) && MONEY_FIELD.test(t[2])) return true;
  }
  return false;
}
// A .tsx or .jsx file runs in the browser unless it says otherwise: a Remix or React Router action or loader, or a server action.
const JSX_ON_SERVER = /^[ \t]*['"]use server['"]|^[ \t]*export\s{1,20}(?:async\s{1,20}function|function|const|let)\s{1,20}(?:action|loader)\b/m;
function jsxInBrowser(ctx) {
  const memo = fileMemo(ctx);
  if (memo.jsxInBrowser === undefined) memo.jsxInBrowser = USE_CLIENT.test(ctx.text) || !JSX_ON_SERVER.test(ctx.text);
  return memo.jsxInBrowser;
}
function amountFromRequest(line, ctx, lines, i) {
  if (/\.php$/i.test(ctx.rel)) return phpAmount(line, ctx);
  if (/\.py$/i.test(ctx.rel)) return pyAmount(line, ctx, lines, i);
  if (/\.[jt]sx$/i.test(ctx.rel) && jsxInBrowser(ctx)) return false;
  // const { amount } = req.body only names the value; the use of it, maybe later on the same line, is what counts
  const code = line.replace(/\b(?:const|let|var)\s*\{[^{}\n]{0,300}\}\s*(?::\s*\w{1,40}\s*)?=[^;\n]{0,300};?/g, ' ');
  const m = /\b(?:amount|unit_amount|unitAmount|total_amount|totalAmount|value)\s*:\s*([^,;\n]{1,120})/.exec(code);
  const { whole, heldAt, live, pricedCall } = bodyNames(ctx);
  if (!m) {
    // { amount, currency: 'usd' } in the call that makes the payment
    const short = /(?:[{,]\s*|^\s*)(amount|unit_amount|unitAmount)\s*[,}]/.exec(code);
    return !!short && live(short[1], i) && !/\bfunction\b/.test(code) &&
      /\.create\s*\(|price_data|line_items|createOrder|createPayment/.test(lines.slice(Math.max(0, i - 8), i + 1).join('\n'));
  }
  const rhs = m[1].replace(/\.data\./g, '.');
  for (const f of rhs.matchAll(/\b(?:req|request)\.(?:body|query|params)(?:\.|\[\s*['"])(\w{1,40})/g)) if (MONEY_FIELD.test(f[1])) return true;
  for (const f of rhs.matchAll(/\b(\w{1,40})\.get\s*\(\s*['"`](\w{1,40})['"`]/g)) if ((f[1] === 'formData' || f[1] === 'searchParams' || whole.has(f[1])) && MONEY_FIELD.test(f[2])) return true;
  // amount: calculateOrderAmount(items). The call may run past the comma the value above stops at.
  if (pricedCall(code.slice(m.index, m.index + 200), n => whole.has(n) || heldAt(n, i))) return true;
  for (const t of amountExpression(rhs, JS_NUMBER_CALL).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    if (!t[2] && live(t[1], i)) return true;
    if (t[2] && whole.has(t[1]) && MONEY_FIELD.test(t[2])) return true;
    // items.map(item => ({ ... unit_amount: item.price ... })), over a list the visitor sent
    if (t[2] && MONEY_FIELD.test(t[2])) {
      const above = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      for (const e of above.matchAll(/([A-Za-z_$][\w$]{0,40})(?:\.([A-Za-z_$][\w$]{0,40}))?\.map\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]{0,40})/g)) {
        if (e[3] === t[1] && (heldAt(e[2] || e[1], i) || whole.has(e[1]))) return true;
      }
    }
  }
  return false;
}

const RULES_MORE = [
  // ---- images and uploads ----
  { id: 'IMG-001', sev: 'Medium', area: 'uploads', title: 'An image is decoded with no check on its pixel count first (a small file can need gigabytes and stop the page with a blank 500)', file: PHP,
    re: /\bimagecreatefrom(jpeg|png|gif|webp|bmp|string)\s*\(/i, except: /['"]imagecreatefrom\w*\(\)['"]/,
    fileLacks: /memory_get_usage|memory_limit|max_?pixels|pixel_?cap|MAX_DIM|max_side/i,
    guardAbove: { re: /getimagesize|\b\w*(fits|budget|guard|can_?decode|check_?size)\w*\s*\(/i, lines: 12 },
    fix: 'Read the size first (getimagesize) and refuse anything over a pixel limit in words, before decoding.' },
  { id: 'IMG-002', sev: 'Medium', area: 'privacy', title: 'An uploaded photo is stored as sent: its GPS position and camera details stay in the public file', file: PHP,
    re: /move_uploaded_file\s*\([^;]*(avatar|photo|picture|image|img|gallery|upload|profile)s?\b/i,
    fileHas: /IMAGETYPE_JPEG|image\/jpe?g|\.jpe?g['"]|getimagesize|exif_imagetype/i, fileLacks: /imagecreatefrom|Imagick|stripImage|->strip\(/i,
    fix: 'Draw the photo again from its pixels (imagecreatefromjpeg + imagejpeg) or strip its metadata before keeping it.' },
  { id: 'IMG-003', sev: 'Medium', area: 'uploads', title: 'A broken or cut-off JPEG is accepted with its errors silenced (saved half grey)', file: PHP,
    re: /jpeg_ignore_warning['"]\s*,\s*['"]?(1|true|on)\b|@\s*imagecreatefrom(jpeg|string)\s*\(/i,
    // imagecreatefromstring decodes a JPEG only where JPEGs are handled (a PDF builder that embeds JPEGs raw decodes
    // only PNGs with it)
    test: (line, ctx, lines, i) => !/@\s*imagecreatefromstring/i.test(line) || /jpe?g/i.test(lines.slice(Math.max(0, i - 5), i + 6).join('\n')),
    fix: 'Decode without @ and with gd.jpeg_ignore_warning off; when it returns false, tell the person the file is damaged.' },
  { id: 'ZIP-001', sev: 'Medium', area: 'uploads', title: 'A zip is unpacked with no limit on the number of entries or their unpacked size (zip bomb)', file: PHP,
    re: /->(extractTo|getFromIndex|getFromName|getStream)\s*\((?!\s*['"])/, fileLacks: /statIndex|statName|['"]size['"]|numFiles\s*>/,
    fix: 'Check numFiles and each entry\'s statIndex size (and a running total) before reading; refuse in words above the limit.' },
  { id: 'ZIP-002', sev: 'Medium', area: 'uploads', title: 'Data is inflated with no maximum length (a small file can expand to gigabytes)', file: PHP,
    re: /\b(gzdecode|gzinflate|gzuncompress|zlib_decode)\s*\(\s*(\(string\)\s*)?\$[^,()]*(\([^()]*\))?[^,()]*\)/i,
    fix: 'Pass the max length argument, or inflate in chunks with a running total and a ceiling.' },
  { id: 'UPL-002', sev: 'Medium', area: 'uploads', title: 'A file over the server\'s post_max_size arrives as an empty form, and the page says "choose a file" instead of "too big"', file: PHP,
    re: /\b(empty|isset)\s*\(\s*\$_FILES\b|\$_FILES\s*\[[^\]]+\]\s*\[\s*['"]error['"]\s*\]/i, fileLacks: /CONTENT_LENGTH|post_max_size|UPLOAD_ERR_INI_SIZE|UPLOAD_ERR_FORM_SIZE/,
    fix: 'Compare CONTENT_LENGTH with post_max_size first (and check UPLOAD_ERR_INI_SIZE); answer 413 naming the limit.' },
  { id: 'UPL-003', sev: 'Medium', area: 'uploads', title: 'An upload is moved into place first and checked afterwards (for a moment the unchecked file is there to be opened)', file: PHP,
    re: /move_uploaded_file\s*\(/, needAfter: { re: /\b(getimagesize|finfo_file|mime_content_type|exif_imagetype)\s*\(\s*\$(?!_FILES)/, lines: 5 },
    fix: 'Check the temporary file (tmp_name) first, then move it under a name the server picks.' },
  { id: 'REQ-001', sev: 'Medium', area: 'input', title: 'The whole request body is read into memory with no size cap', file: PHP,
    re: /file_get_contents\s*\(\s*['"]php:\/\/input['"]\s*\)/i,
    fix: 'Read at most a set length (file_get_contents(\'php://input\', false, null, 0, MAX + 1)) and answer 413 above it.' },

  // ---- actions on GET ----
  { id: 'GET-001', sev: 'Medium', area: 'csrf', title: 'Signing out happens on a plain GET: any page, image or link can sign a person out', file: PHP, path: /(^|\/)[^/]*(log-?out|sign-?out)[^/]*$/i,
    re: /\bsession_destroy\s*\(|\$_SESSION\s*=\s*(\[\s*\]|array\(\s*\))/, fileLacks: /REQUEST_METHOD|\$_POST|csrf|_token|nonce/i,
    fix: 'Sign out on POST from a button with a token; answer GET with the button.' },
  { id: 'GET-002', sev: 'Medium', area: 'csrf', title: 'A GET request changes data (link checkers and mail scanners open links, so the change happens without the person)', file: PHP,
    re: /['"]\s*(UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/i, fileHas: /\$_GET\s*\[/, fileLacks: /REQUEST_METHOD|\$_POST\b|is_?post\s*\(|isPost\s*\(/i,
    except: /\b(views?|hits|clicks|opens|last_(seen|login|used|active))\s*=\s*\w*\s*\+?|SET\s+last_/i,
    // a payment provider's return or callback page is a GET by its design
    // and a library file is not a page anyone opens
    skipFile: /(return|callback|webhook|ipn|notify)[^/]*\.php$|(^|\/)(lib|libs|includes?|inc|src\/lib)\//i,
    fix: 'Show a page with a button that POSTs (with a token); make the change only on the POST.' },

  // ---- sign-in, limits, secrets ----
  { id: 'AUTH-004', sev: 'Medium', area: 'auth', title: 'CF-Connecting-IP is trusted without checking the request came from Cloudflare (anyone can send that header)', file: SERVER,
    re: /HTTP_CF_CONNECTING_IP|HTTP_TRUE_CLIENT_IP|['"]cf-connecting-ip['"]|['"]true-client-ip['"]/i,
    needsNear: /ip_in_range|cidr|cloudflare|trusted|173\.245\.|103\.21\.|2400:cb00/i,
    fix: 'Use the header only when REMOTE_ADDR is one of Cloudflare\'s published ranges; otherwise use REMOTE_ADDR.' },
  { id: 'AUTH-005', sev: 'Medium', area: 'auth', title: 'Wrong tries are counted per email, so anyone can lock a stranger out of their account', file: SERVER,
    re: /['"][\w:.-]*(fail|attempt|lock|tries)[\w:.-]*['"]\s*[.+]\s*[^;\n]*(\$_(POST|GET|REQUEST)\s*\[\s*['"](email|user(name)?|login)['"]|\$(email|username|login)\b|req\.body\.(email|username))/i,
    except: /REMOTE_ADDR|\$ip\b|client_?ip|ip_(address|prefix|block)|req\.ip\b/i,
    fix: 'Count tries per address and email together (and slow down rather than lock), so a stranger\'s tries never lock the owner out from their own address.' },
  { id: 'AUTH-006', sev: 'Medium', area: 'auth', title: 'A limit is keyed on the full IPv6 address (one home has billions of them, so the limit never bites)', file: SERVER,
    re: new RegExp(KEY_WORD.source + /\s*[.+]\s*(\$_SERVER\s*\[\s*['"]REMOTE_ADDR['"]\s*\]|req\.ip\b|req\.socket\.remoteAddress)/.source, 'i'),
    fileLacks: /inet_pton|\/64|ipv6|ip_prefix|ip_block|prefix64/i,
    fix: 'Key IPv6 addresses on their first 64 bits (the block a home is given); keep IPv4 whole.' },
  { id: 'AUTH-007', sev: 'Medium', area: 'auth', title: 'The password can be changed without the current one (a borrowed or stolen session takes the account)', file: PHP,
    re: /password_hash\s*\(\s*\$_(POST|REQUEST)\s*\[\s*['"](new_?password|password|new_?pass|newpass|password1)['"]/i,
    fileHas: /UPDATE\s+\w*users?\b[^;]*pass/i, fileLacks: /password_verify|current_?pass|old_?pass|token|reset/i,
    fix: 'Ask for the current password (password_verify) before saving a new one.' },
  { id: 'AUTH-008', sev: 'Medium', area: 'auth', title: 'After a password change every other signed-in device stays signed in', file: PHP,
    re: /['"]UPDATE\s+\w*users?\s+SET\s+[^'"]*\bpass\w*\s*=/i,
    fileLacks: /session_regenerate_id|session_version|token_version|sessions?\b[^;\n]*WHERE|DELETE\s+FROM\s+\w*(sessions?|remember|tokens?)\b|logout_?others|revoke/i,
    fix: 'Bump a session version (or delete the user\'s other sessions and remember-me tokens) and regenerate this session id.' },
  { id: 'AUTH-009', sev: 'Medium', area: 'auth', title: 'A secret is compared with == or !== (timing shows how much of it matched)', file: /\.(php|m?js|cjs|ts)$/i,
    re: /\$_(SERVER|GET|POST|REQUEST|COOKIE)\s*\[\s*['"][^'"]*(KEY|TOKEN|SECRET|SIG)[^'"]*['"]\s*\][^;]{0,20}[!=]==?\s*\(?\s*[$A-Z]|[!=]==?\s*\(?\s*\$_(SERVER|GET|POST|REQUEST|COOKIE)\s*\[\s*['"][^'"]*(key|token|secret|sig)[^'"]*['"]|\breq\.(headers|query|body)\[?['".]?[\w-]*(key|token|secret|signature)[\w-]*['"\]]?\s*[!=]==?\s*[\w$]*(KEY|SECRET|TOKEN|secret|token)/i,
    except: /hash_equals|password_verify|timingSafeEqual|[!=]==?\s*(''|""|null|false|true|0)\b|(''|""|null)\s*[!=]==?/i,
    fix: 'Compare secrets with hash_equals (PHP) or crypto.timingSafeEqual (Node).' },
  { id: 'AUTH-010', sev: 'High', area: 'auth', title: 'The sign-in callback accepts any state when none was saved (a sign-in link from someone else signs you in as them)', file: SERVER,
    // !saved || state === saved: the same name on both sides (not !g || g.state === 'error')
    re: /!\s*(\$?[\w.]+)\s*\|\|[^|&;{]{0,80}\bstate\b[^|&;{]{0,40}(?<![!=<>])===?(?!=)\s*\1\b/i,
    fix: 'Refuse the callback when no state was saved or it does not match (hash_equals), and remove the saved state once used.' },
  { id: 'AUTH-011', sev: 'High', area: 'auth', title: 'A sign-in provider\'s email is trusted without email_verified (an unconfirmed address can take over the account with that email)', file: SERVER,
    re: /\$(claims|payload|token_?data|user_?info|profile|g\w*)\s*\[\s*['"]email['"]\s*\]|\$(claims|payload|userinfo)->email\b|\b(claims|payload|profile|userInfo)\.email\b/i,
    // the token is read in this file (a helper elsewhere may already refuse unverified emails)
    fileHas: /id_?token|idToken|verify_id_token|getPayload\s*\(|userinfo|jwt/i, fileLacks: /email_verified|emailVerified|verified_email/i,
    fix: 'Refuse unless email_verified is true, and find the account by the provider\'s id (sub), not by email.' },
  { id: 'AUTH-012', sev: 'Medium', area: 'auth', title: 'A sign-in or reset form says whether an email has an account', file: SERVER,
    // about an account and its email (not "address not found" from a map lookup, not an admin page's 404)
    re: /['"][^'"]*\b(no|isn't an?|is not an?)\s+(account|user)\b[^'"]{0,30}\b(with|for)\s+(that|this)\s+(email|e-mail|username)|['"][^'"]*\b(e-?mail|username)\s+(is\s+)?not\s+(found|registered|recogni[sz]ed)|['"]\s*unknown\s+(e-?mail|username)/i,
    fileLacks: /\bSTDERR\b|PHP_SAPI\s*[!=]==?\s*['"]cli|\$argv\b/,
    fix: 'Give the same answer either way ("If that email has an account, a link is on its way").' },
  { id: 'AUTH-013', sev: 'Medium', area: 'auth', title: 'A check is skipped when its secret is not set (an empty setting turns the protection off without a word)', file: SERVER,
    re: /if\s*\(\s*(\$?[\w.]*(SECRET|KEY|TOKEN)[\w.]*\s*!==?\s*(''|""|null)|!\s*empty\s*\(\s*\$?[\w.]*(secret|key|token)\w*\s*\)|[A-Z][A-Z0-9_]*(SECRET|KEY|TOKEN)[A-Z0-9_]*)\s*&&\s*!/,
    fix: 'When the secret is missing, refuse (and log it), instead of letting every request through.' },
  { id: 'AUTH-014', sev: 'Medium', area: 'auth', title: 'A token from the address is kept in browser storage (history, logs and any script on the page can read it)', file: JS_HTML,
    re: /(localStorage|sessionStorage)\.setItem\s*\(\s*['"][^'"]*(token|session|secret|auth|jwt|key)[^'"]*['"]/i, fileHas: /URLSearchParams|location\.(search|hash)|searchParams/,
    // the value stored is the one read from the address (not a value the page made itself, such as its own state)
    test: (line, ctx) => {
      const v = (/setItem\s*\(\s*['"][^'"]*['"]\s*,\s*([^)]*)\)/.exec(line) || [])[1] || '';
      if (/\.get\s*\(|location\.(search|hash)|searchParams/.test(v)) return true;
      const name = (/^\s*([\w$]+)\s*$/.exec(v) || [])[1];
      const memo = fileMemo(ctx);
      if (!memo.fromAddress) { // every variable the file fills from the address, found once per file
        memo.fromAddress = new Set();
        for (const m of ctx.text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=[^;\n]{0,300}?(?:URLSearchParams|searchParams|location\.(?:search|hash)|params\.get)/g)) memo.fromAddress.add(m[1]);
      }
      return !!name && memo.fromAddress.has(name);
    },
    fix: 'Exchange the token with the server for an HttpOnly cookie, and remove it from the address (history.replaceState).' },
  { id: 'CORS-002', sev: 'Medium', area: 'config', title: 'CORS lets any subdomain (or any name ending the same way) call with the visitor\'s cookies', file: SERVER,
    re: /preg_match\s*\(\s*['"][^,]*,\s*\$\w*origin|\borigin\w*\.endsWith\s*\(|str_ends_with\s*\(\s*\$\w*origin/i, test: loosePattern, fileHas: /Allow-Credentials/i,
    fix: 'Compare the Origin with a fixed list of full origins (in_array with strict), not a pattern.' },
  { id: 'CSRF-002', sev: 'Medium', area: 'csrf', title: 'A sign-in cookie is sent with SameSite=None and no Origin check: another site can post with it', file: SERVER,
    re: /SameSite\s*=\s*None|['"]samesite['"]\s*=>\s*['"]None['"]|sameSite\s*:\s*['"]none['"]/i, fileLacks: /\borigin\b|csrf|xsrf|x-requested-with|sec-fetch-site/i,
    fix: 'Use SameSite=Lax for the session cookie, or check the Origin header (or a token) on every change.' },

  // ---- payments, money, data ----
  { id: 'PAY-001', sev: 'High', area: 'payments', title: 'A payment capture is treated as paid without reading the status it answered', file: SERVER,
    // the order is marked paid within a few lines, and nothing between reads the capture's status
    re: /(\$\w+|\b(const|let|var)\s+\w+)\s*=\s*[^;]*\/capture\b/i,
    needAfter: { re: /\b\w*(mark\w*_?paid|set_?paid|markPaid|fulfil\w*|grant_\w+)\s*\(|status\s*=\s*['"]paid['"]/i, lines: 6 },
    guardAfter: { re: /\[\s*['"]status['"]\s*\]|->status\b|\.status\b|COMPLETED|\bstatus\b/, lines: 6 },
    fix: 'Read the capture\'s status (COMPLETED) and amount before marking the order paid; say in words when it is not.' },
  { id: 'PAY-002', sev: 'High', area: 'payments', title: 'A balance or count is read, then spent in a second query: two requests at once spend it twice', file: PHP,
    re: /['"]SELECT\s+[^'"]*\b(remaining|balance|credits?|stock|quantity|qty|paid|uses|uses_left|seats|spots|available|quota)\b[^'"]*\bFROM\b/i,
    needAfter: { re: /['"]\s*(UPDATE\s+\w+\s+SET|INSERT\s+INTO)\b/i, lines: 15 }, fileLacks: /FOR\s+UPDATE|GET_LOCK|flock\s*\(|LOCK\s+TABLES|ON\s+DUPLICATE\s+KEY|INSERT\s+IGNORE|beginTransaction|BEGIN\s+IMMEDIATE/i,
    fix: 'Spend in one statement that checks as it writes (UPDATE ... SET n = n - 1 WHERE ... AND n > 0, then rowCount), or lock the row (FOR UPDATE).' },
  { id: 'PAY-003', sev: 'Medium', area: 'payments', title: 'A webhook with a bad signature is answered 200, so the sender never finds out', file: SERVER,
    re: /http_response_code\s*\(\s*200\s*\)|\.status\s*\(\s*200\s*\)|writeHead\s*\(\s*200|statusCode\s*=\s*200\b/, test: badSignatureBranch,
    fix: 'Answer 400 (or 401) to a bad signature, and log it.' },
  { id: 'PAY-004', sev: 'Medium', area: 'payments', title: 'A Stripe event is acted on without checking livemode (a test payment can unlock a real order)', file: SERVER,
    re: /constructEvent\s*\(/, fileLacks: /livemode/,
    fix: 'Ignore events whose livemode does not match the site\'s mode.' },
  { id: 'DATA-001', sev: 'Medium', area: 'input', title: 'Decoded JSON from outside is used with no shape check (an array or number where text was expected answers 500, or imports junk)', file: PHP,
    // decoded straight from the request: the body, an uploaded file or a form field (not the site's own files or
    // another service's reply)
    re: /\$\w+\s*=\s*json_decode\s*\(\s*(\(string\)\s*)?(\$_(POST|GET|REQUEST|COOKIE)\b|\$(raw|input|payload|request_?body|post_?body|body)\b(?!\s*\[)|(file_get_contents|stream_get_contents)\s*\(\s*(['"]php:\/\/input|\$_FILES))/i,
    guardAfter: { re: /is_array|is_object|instanceof|validate|schema|json_last_error|JSON_THROW_ON_ERROR|===?\s*null|!\s*\$\w+\s*\)|\?\?\s*\[\]|\?:\s*\[/i, lines: 3 },
    fix: 'Check the decoded value is an array with the fields and types you expect (is_array, is_string, is_int) before using or saving it; answer 400 in words otherwise.' },
  { id: 'DATA-002', sev: 'Medium', area: 'money', title: 'Money is cut to whole numbers ((int) / intval / number_format with 0 decimals)', file: PHP,
    // A typed price cast to a whole number, or money printed with no decimals. (int) on a stored amount is left
    // alone: over 43 real projects most such columns hold whole cents, where (int) is right.
    re: /(\(int\)|\bintval\s*\()\s*\(?\s*\$_(POST|GET|REQUEST)\s*\[\s*['"](\w*_)?(price|rate|amount|cost|fee|subtotal|vat|charge)s?['"]\s*\]|\bnumber_format\s*\(\s*\$\w*(price|amount|cost|fee|total|subtotal|tax|vat|charge)\b[^,]*,\s*0\s*\)/i,
    except: /cents|pence|minor|_c\b|rate_?limit|frame_?rate|sample_?rate|hit_?rate/i,
    fix: 'Keep money as a decimal (or whole cents) and print it with two decimals.' },
  { id: 'DATA-003', sev: 'Medium', area: 'performance', title: 'Every row is fetched and the page is cut out in code, instead of LIMIT in the query', file: SERVER,
    re: /['"]SELECT\s+(?![^'"]*\bLIMIT\b)[^'"]*\bFROM\b[^'"]*['"]/i, needAfter: { re: /\barray_slice\s*\(|\.slice\s*\(\s*\$?\w*(offset|start|page)/i, lines: 4 },
    fix: 'Put LIMIT and OFFSET in the query (bound as integers).' },
  { id: 'DATA-004', sev: 'Medium', area: 'input', title: 'A typed number has a floor but no ceiling (one typo orders 10,000,000)', file: JS_HTML,
    re: /(?<![\w.])(Math\.)?max\s*\(\s*\d+\s*,[^;]*(\.value\b|\$_(POST|GET|REQUEST)|req\.(body|query))/, except: /\b(Math\.)?min\s*\(/,
    // an amount someone orders or books (a page number past the end just shows an empty page)
    test: (line, ctx, lines, i) => {
      const AMOUNT = /qty|quantit|amount|units|seats|guests|people|copies|tickets|nights|items|count\b/i;
      if (AMOUNT.test(line)) return true;
      for (let k = i - 1; k >= Math.max(0, i - 2); k--) if (/\bfunction\b|=>\s*\{\s*$|\)\s*\{\s*$/.test(lines[k])) return AMOUNT.test(lines[k]);
      return false;
    },
    fix: 'Cap it too (Math.min(MAX, ...)), and check the same limit on the server.' },
  { id: 'DATA-005', sev: 'Medium', area: 'injection', title: 'A CSV export writes typed text as is, so "=HYPERLINK(...)" runs when the file opens in a spreadsheet', file: PHP,
    re: /\bfputcsv\s*\(/, fileLacks: /\^\[=+|\[=+\\?-@|\[=\\\+|formula|csv_?(safe|cell|escape)|csvSafe|escapeCsv/i,
    fix: 'Put a \' in front of any cell that starts with = + - @ tab or return.' },
  { id: 'DATA-006', sev: 'Medium', area: 'text', title: 'Text is cut with substr, which can split a character in half (a broken character in the page or email)', file: PHP,
    re: new RegExp(/(?<![\w>:])substr\s*\(\s*\$(\w*(K)\w*|\w+\s*\[\s*['"]\w*(K)\w*['"]\s*\]|\w+->\w*(K)\w*)\s*,\s*0\s*,\s*([2-9]\d|\d{3,})\s*\)/.source
      .replace(/K/g, 'bio|name|title|text|desc|description|summary|body|message|comment|excerpt|content|note|label|caption|subject|about'), 'i'),
    except: /error_log|\blog\w*\s*\(/i, skipFile: /(^|\/)(build-tools|tools|scripts)\//i,
    fix: 'Use mb_substr (or mb_strimwidth) for text people read.' },
  { id: 'DATA-007', sev: 'Medium', area: 'dates', title: 'toISOString().slice(0, 10) is used as today (it is the UTC date: wrong for hours each day away from London)', file: JS_HTML,
    re: /new\s+Date\s*\(\s*\)\s*\.toISOString\s*\(\s*\)\s*\.\s*(slice|substring|substr)\s*\(\s*0\s*,\s*10\s*\)|new\s+Date\s*\(\s*\)\s*\.toISOString\s*\(\s*\)\s*\.split\s*\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/,
    fix: 'Build the date from getFullYear/getMonth/getDate (local time), or name the timezone on purpose.' },
  { id: 'PDF-001', sev: 'Medium', area: 'pdf', title: 'An image is drawn into a PDF at a fixed width AND height, so any other shape is squashed', file: JS_HTML,
    re: /->Image\s*\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[1-9][\d.]*\s*,\s*[1-9][\d.]*\s*[,)]|\.addImage\s*\(\s*[^,]+,\s*['"]\w+['"]\s*,\s*[^,]+,\s*[^,]+,\s*[1-9][\d.]*\s*,\s*[1-9][\d.]*\s*[,)]/,
    fix: 'Give one side and 0 for the other (worked out from the image\'s own shape), or fit it inside a box keeping its ratio.' },
  { id: 'PDF-002', sev: 'Medium', area: 'pdf', title: 'A PDF uses a built-in Latin-1 font with utf8_decode, so names in other scripts print as "?"', file: PHP,
    re: /\butf8_decode\s*\(|\biconv\s*\(\s*['"]UTF-8['"]\s*,\s*['"](ISO-8859-1|windows-1252|CP1252)/i, fileHas: /->SetFont\s*\(|FPDF|->Cell\s*\(|->MultiCell\s*\(/,
    fix: 'Embed a Unicode TTF font (AddFont with unicode on, or tFPDF) and pass the UTF-8 text as is.' },

  // ---- requests, caching, release ----
  { id: 'NET-001', sev: 'Medium', area: 'saving', title: 'A save on page close uses keepalive with no size check (browsers drop keepalive bodies over 64 KB)', file: JS_HTML,
    re: /keepalive\s*:\s*(true|!0)\b/, except: /\.length\s*[<>]|byteLength|\.size\s*[<>]|JSON\.stringify\s*\(\s*\{/,
    // a save as the page closes (a small tracking ping with keepalive is fine)
    test: (line, ctx, lines, i) => /pagehide|beforeunload|unload|visibilitychange/.test(lines.slice(Math.max(0, i - 15), i + 1).join('\n')),
    guardAbove: { re: /\.length\s*[<>]|byteLength|\.size\s*[<>]|MAX_KEEPALIVE|65536|64\s*\*\s*1024/i, lines: 6 },
    fix: 'Check the body length first (under about 60 KB) and fall back to a normal save.' },
  { id: 'NET-002', sev: 'Medium', area: 'performance', title: 'A data file is served with no ETag or Last-Modified, so every visit downloads it again', file: /\.(m?js|cjs|ts)$/i,
    re: /createReadStream\s*\([^)]*\.(json|csv|xml|geojson)['"`]?\s*\)\s*\.pipe\s*\(\s*res\b/i, fileLacks: /etag|last-modified|if-none-match|if-modified-since|express\.static|serve-static/i,
    fix: 'Send an ETag (size + modified time) and answer 304 when If-None-Match matches.' },
  { id: 'NET-003', sev: 'Medium', area: 'limits', title: 'A "too many requests" answer gives no Retry-After, so neither people nor scripts know when to try again', file: SERVER,
    re: /http_response_code\s*\(\s*429\s*\)|writeHead\s*\(\s*429|\.status\s*\(\s*429\s*\)|statusCode\s*=\s*429\b/, needsNear: /Retry-After/i,
    fix: 'Send Retry-After (seconds) with every 429, and say the wait in the message.' },
  { id: 'NET-004', sev: 'High', area: 'injection', title: 'A typed address is fetched after only filter_var (http://127.0.0.1 and the cloud\'s metadata address pass)', file: PHP,
    re: /filter_var\s*\(\s*\$\w+\s*,\s*FILTER_VALIDATE_URL/,
    // the address checked is the one fetched a few lines on (not one only stored or shown)
    test: (line, ctx, lines, i) => {
      const v = (/filter_var\s*\(\s*\$(\w+)/.exec(line) || [])[1];
      return new RegExp('\\b(curl_init|file_get_contents|fetch_\\w*|get_headers|wp_remote_get|fopen)\\s*\\(\\s*\\$' + v + '\\b').test(lines.slice(i, i + 12).join('\n'));
    },
    fileLacks: /FILTER_FLAG_NO_PRIV_RANGE|FILTER_FLAG_NO_RES_RANGE|gethostbyname|dns_get_record|is_?private|private_?ip|169\.254/i,
    fix: 'Resolve the host, refuse private and reserved addresses, and connect to the address you checked.' },
  { id: 'REL-001', sev: 'Medium', area: 'release', title: 'The build writes the release zip over one already made for that version (a zip already shared changes under people)', file: /\.(m?js|cjs|ts|py|sh)$/i,
    re: /\b(writeFileSync|createWriteStream|copyFileSync|renameSync|ZipFile|make_archive|writeZip|archiver)\s*\(|\bzip\s+-r\b|['"]-f['"]\s*,/,
    test: writesVersionZip,
    // The check sits above the write (a check anywhere in the file is often for something else), or the build refuses
    // in words ("... already exists: raise the version") somewhere in it.
    guardAbove: { re: /existsSync|path\.exists|\.exists\s*\(|-e\s+|already exists|wx['"]/i, lines: 60 },
    fileLacks: /(die|fail|exit|raise|error|throw)\b[^\n]{0,40}already exists|already exists[^\n]{0,80}(raise|bump|version|nothing was changed)/i,
    fix: 'Refuse to build when the zip for this version already exists: raise the version first.' },

  // ---- output into pages, mail, logs ----
  { id: 'INJ-011', sev: 'Medium', area: 'injection', title: 'Data is printed into a <script> with json_encode and no HEX flags, so a "</script>" in it breaks out', file: PHP,
    re: /\bjson_encode\s*\(/,
    // Printed straight into the page (<?= / echo in an HTML part) inside an open <script>, or joined onto a string
    // that opens a <script> a line or two above. The whole call is read for the flags (they may sit on the next line).
    test: (line, ctx, lines, i) => {
      const at = line.search(/\bjson_encode\s*\(/);
      if (/JSON_HEX_TAG/.test(lines.slice(i, i + 3).join(' ').slice(at))) return false;
      // one value that cannot hold "</script>": a token, an id, a count
      if (/^json_encode\s*\(\s*\$\w*(token|_id|Id|nonce|count|total)\w*(\[[^\]]*\])?\s*\)/i.test(line.slice(at))) return false;
      if (/<\?(=|php\s+echo)\s*$/.test(line.slice(0, at))) return insideScript(lines, i, at);
      return /<script/i.test(lines.slice(Math.max(0, i - 3), i).join('\n') + '\n' + line.slice(0, at)) && !/^\s*(echo|print|return|exit|die)\s+json_encode/.test(line);
    },
    fix: 'Add JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT.' },
  { id: 'INJ-012', sev: 'Medium', area: 'injection', title: 'JSON.stringify output is written into a <script> without escaping "<"', file: JS,
    re: /<script[^'"`]*['"`][^;]*JSON\.stringify\s*\(|<script[^`]*\$\{\s*JSON\.stringify\s*\(/i, except: /replace\s*\(\s*\/<\/g|u003c|serialize-javascript|devalue|htmlSafe/i,
    fix: 'Replace "<" with \\u003c in the JSON before it goes into the script.' },
  { id: 'INJ-013', sev: 'Medium', area: 'injection', title: 'A stored address is printed as a link with only HTML escaping, so a javascript: link runs when clicked', file: MARKUP,
    // a field people type an address into (website, homepage, social links), printed straight from the record
    re: /\bhref\s*=\s*["']?\s*<\?(?:php\s+echo|=)\s*(?:htmlspecialchars|htmlentities|e|h)?\s*\(?\s*\$(\w+\s*\[\s*['"]\w*(website|homepage|web_?site|social|facebook|instagram|twitter|linkedin|web_?url|site_?url)\w*['"]\s*\]|\w+->\w*(website|homepage|web_?site|social|facebook|instagram|twitter|linkedin)\w*|\w*(website|homepage)\w*)(?!\s*\()/i,
    except: /esc_url|sanitize_url|safe_?url|filter_url/i,
    fileLacks: /preg_match\s*\(\s*['"][~#\/!@]\^https?|PHP_URL_SCHEME|safe_?url|is_?http|^\s*\$\w+\s*=\s*str_starts_with\s*\([^)]*https?:/im,
    // the project forces a scheme on the address where it is saved (another file): then it is safe to print
    test: (line, ctx) => !projectChecksScheme(ctx.dir),
    fix: 'Print it only when it starts with http:// or https:// (check the scheme), then escape it.' },
  { id: 'INJ-014', sev: 'Medium', area: 'injection', title: 'What a person types becomes a regular expression (a "(" breaks it, a crafted one hangs the page)', file: JS_HTML,
    re: /new\s+RegExp\s*\(\s*[\w$.]*(\.value|query|search|term|filter|needle)\b\s*[,)]|\bpreg_(match|match_all|replace|split)\s*\(\s*['"][^'"]*['"]\s*\.\s*\$(q|query|search|term|needle|input|filter|keyword)\b/i,
    except: /preg_quote|escapeRegExp|escapeRegex|escRe/i,
    // a search that offers regular expressions on purpose catches the bad ones
    test: (line, ctx, lines, i) => !insideTry(lines, i, line.search(/RegExp|preg_/)),
    fix: 'Escape the text first (replace /[.*+?^${}()|[\\]\\\\]/g with \\\\$&, or preg_quote).' },
  { id: 'INJ-015', sev: 'Medium', area: 'injection', title: 'Typed text goes into the log as is, so a line break in it writes fake log lines', file: PHP,
    re: /\berror_log\s*\([^;]*\$_(POST|GET|REQUEST|COOKIE)\b/, except: /json_encode|str_replace|preg_replace|addcslashes|var_export|urlencode|\(int\)|intval/i,
    fix: 'Write it through json_encode (or strip line breaks) before logging.' },
  { id: 'INJ-016', sev: 'Medium', area: 'injection', title: 'A typed email goes into a mail header unchecked (a line break in it adds headers)', file: PHP,
    re: /['"](Reply-To|From|Cc|Bcc)\s*:\s*['"]\s*\.\s*[^;\n]*\$_(POST|GET|REQUEST)|['"](Reply-To|From|Cc|Bcc)\s*:\s*\{?\$_(POST|GET|REQUEST)/i,
    fix: 'Check the address with filter_var(FILTER_VALIDATE_EMAIL) first, and leave the header out when it fails.' },
  { id: 'INJ-017', sev: 'Medium', area: 'privacy', title: 'postMessage with "*" sends the data to whatever page framed or opened this one', file: JS_HTML,
    re: /\.postMessage\s*\([^;]*,\s*['"]\*['"]\s*\)/,
    fix: 'Name the page\'s origin as the second argument.' },
  { id: 'INJ-018', sev: 'Medium', area: 'injection', title: 'A link is built from the Host header, so a forged request mails or redirects to someone else\'s site', file: PHP,
    re: /['"]https?:\/\/['"]\s*\.\s*\$_SERVER\s*\[\s*['"](HTTP_HOST|HTTP_X_FORWARDED_HOST|SERVER_NAME)['"]\s*\]|['"]\/\/['"]\s*\.\s*\$_SERVER\s*\[\s*['"]HTTP_HOST/i,
    fileHas: /\bmail\s*\(|send_?mail|->send\s*\(|Location:|canonical|reset|verify|token/i, needsNear: /in_array\s*\([^)]*HTTP_HOST|ALLOWED_HOSTS|allowed_?hosts/i,
    fix: 'Build links from the site address in your config (SITE_URL), not from the request.' },
  { id: 'SEC-008', sev: 'Medium', area: 'config', title: 'An exception\'s own text is sent to the visitor (it can hold paths, SQL and keys)', file: SERVER,
    re: /\b(echo|print|json_encode|exit|die)\b[^;\n]*->getMessage\s*\(\)|\bres\.(status\s*\(\s*\d+\s*\)\s*\.)?(json|send|end)\s*\([^;\n]*\b(err|error|e|ex)\.message\b/,
    // a command-line tool printing to its own console is not a page
    skipFile: /(^|\/)(tools|scripts|bin|cli|cron)\//i, fileLacks: /PHP_SAPI\s*[!=]==?\s*['"]cli|php_sapi_name\s*\(\s*\)\s*[!=]==?\s*['"]cli|\$argv\b|\bSTDERR\b/,
    fix: 'Log the exception; send the visitor a plain message that says what failed and what to do.' },
  { id: 'SEC-009', sev: 'High', area: 'exposed files', title: 'A command-line tool sits in the web folder with no PHP_SAPI check, so anyone can run it by its address', file: PHP,
    path: /(^|\/)(public|public_html|www|htdocs|web)\/(.*\/)?(tools|scripts|cron|bin|cli|maintenance)\/[^/]+$|(^|\/)(public|public_html|www|htdocs|web)\/[^/]*(reindex|migrate|rebuild|backfill|cleanup|seed)[^/]*\.php$/i,
    re: /<\?php/, fileLacks: /PHP_SAPI|php_sapi_name|\$argv|STDIN|hash_equals|require_admin|session_start|_KEY\b|auth/i,
    fix: 'Move it out of the web folder, or start it with: if (PHP_SAPI !== \'cli\') { http_response_code(404); exit; }' },
  { id: 'SEC-010', sev: 'Medium', area: 'files', title: 'A temp file has a fixed name, so two runs at once overwrite each other (and another user can plant it)', file: /\.(php|m?js|cjs|ts|py)$/i,
    re: /(os\.tmpdir\(\)|sys_get_temp_dir\(\)|tempfile\.gettempdir\(\))\s*[,.+]\s*['"][\\/]?[\w.-]+\.\w+['"]|['"]\/tmp\/[\w.-]+\.\w+['"]/,
    // a file meant to be shared between runs (a lock, a cache, a health or state record) has a fixed name on purpose
    except: /mkdtemp|tempnam|uniqid|random|Date\.now|getpid|process\.pid|NamedTemporaryFile|mkstemp|\.lock['"]|\.pid['"]|lock|cache|health|state|status|stamp|last_?run|seen/i,
    // the fixed path is written to (on this line or just after), not only read
    test: (line, ctx, lines, i) => /writeFileSync|createWriteStream|appendFileSync|file_put_contents|fopen\s*\([^)]*['"][wax]|\bopen\s*\([^)]*['"][wa]|copy\s*\(|move_uploaded_file|rename\s*\(|\.save\s*\(|\.write\s*\(/.test(lines.slice(i, i + 6).join('\n')),
    fix: 'Make a fresh temp folder per run (fs.mkdtempSync, tempnam, tempfile.mkstemp).' },
  { id: 'SEC-011', sev: 'Medium', area: 'injection', title: 'A script from a public CDN loads with no integrity check (if the CDN copy changes, it runs on your page)', file: MARKUP,
    re: /<script\b[^>]*\bsrc\s*=\s*["']https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|code\.jquery\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|ajax\.googleapis\.com\/ajax\/libs)/i,
    test: (line, ctx, lines, i) => !/\bintegrity\s*=/i.test(lines.slice(i, i + 4).join(' ').split(/<\/script>|>\s*$/)[0]),
    fix: 'Add integrity="sha384-..." crossorigin="anonymous" (the CDN shows the hash), or serve the file yourself.' },

  // ---- .htaccess ----
  { id: 'HTA-001', sev: 'Medium', area: 'config', title: 'A subfolder .htaccess turns its own rewrites on, which drops the site\'s https redirect for that folder', file: /\.htaccess$/i,
    re: /^\s*RewriteEngine\s+On\b/i, fileLacks: /RewriteOptions\s+Inherit|%\{HTTPS\}|%\{SERVER_PORT\}|https:\/\//i, test: parentRedirectsHttps,
    fix: 'Add RewriteOptions InheritBefore (or repeat the https redirect) in this folder\'s .htaccess.' },
  { id: 'HTA-002', sev: 'Medium', area: 'config', title: 'php_flag / php_value without an IfModule guard: a host running PHP as FPM answers 500 for every page', file: /\.htaccess$/i,
    re: /^\s*php_(flag|value|admin_flag|admin_value)\b/i, test: outsideIfModule,
    fix: 'Wrap them in <IfModule mod_php.c> (and mod_php7.c / mod_php8.c), or set them in .user.ini.' },
  { id: 'HTA-003', sev: 'Medium', area: 'config', title: 'A rule that hides every dot-file also blocks /.well-known/, so certificate renewal fails', file: /\.htaccess$/i,
    // a dot at the start of a path part (/\. or ^\.), not a file extension (.*\.(md|zip))
    re: /^\s*(RedirectMatch\s+(403|404|gone)\s+\S*(\/|\^|\(\^\|\/\))\\\.(?![a-z0-9_-])|RewriteRule\s+\S*(\/|\^|\(\^\|\/\))\\\.(?![a-z0-9_-])\S*\s+-\s+\[[^\]]*\bF\b)/i, except: /well-known/i,
    fix: 'Leave .well-known out of the rule (e.g. /\\.(?!well-known/)).' },

  // ---- replies, errors, saving ----
  { id: 'UX-001', sev: 'Medium', area: 'replies', title: 'Success is shown after a save without looking at the reply\'s status', file: JS_HTML,
    re: /\.then\s*\(\s*(function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+\2\.json\(\)\s*;?\s*\}|\(?\s*(\w+)\s*\)?\s*=>\s*\3\.json\(\))\s*\)/,
    test: (line, ctx, lines, i) => /method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n')),
    fix: 'Check r.ok (or r.status) before saying it worked, and show the server\'s message when it did not.' },
  { id: 'UX-002', sev: 'Medium', area: 'replies', title: 'A failed request shows a fixed "Something went wrong" and drops the reason the server gave', file: JS_HTML,
    re: /if\s*\(\s*!\s*\w+\.ok\s*\)\s*\{?[^}]*?(textContent|innerText|alert\s*\(|toast\w*\s*\(|show\w*\s*\()\s*=?\s*\(?\s*['"][^'"]*(went wrong|try again|failed|an error)[^'"]*['"]\s*\)?\s*;/i,
    fix: 'Read the reply (await r.json()) and show its error, or at least the status, with a way out.' },
  { id: 'UX-003', sev: 'Medium', area: 'replies', title: 'PHP carries on as if the mail was sent without reading what mail() returned', file: PHP,
    re: /^\s*@?(mail|wp_mail)\s*\(/,
    fix: 'Keep mail()\'s result; when it is false, log it and tell the person the message did not go.' },
  { id: 'UX-004', sev: 'Medium', area: 'saving', title: 'An empty catch hides a failed save, so the person thinks it was kept', file: /\.(m?js|cjs|tsx?|jsx|html?|php)$/i,
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    test: (line, ctx, lines, i) => {
      const at = line.search(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
      const before = lines.slice(Math.max(0, i - 4), i).join('\n') + '\n' + line.slice(0, at);
      const body = before.slice(before.lastIndexOf('try'));
      // a save of the person's own work (a draft, notes, a log, a form, a record): a remembered setting or the app's
      // own state file failing quietly costs nothing they made
      return /\btry\b/.test(before) && /setItem|addImage|\bsave\w*\s*\(|\bwrite\w*\s*\(|\bput\w*\s*\(|\binsert\w*\s*\(|\bsend\w*\s*\(|\bmail\s*\(|persist|\.commit\s*\(/i.test(body) &&
        /draft|note|\blog\b|_log\b|log_|LOG|journal|entr(y|ies)|record|message|form|content|document|work\b|job|invoice|booking|order/i.test(body) && !/getItem|readFile|\bread\w*\s*\(|JSON\.parse|unlink|rmSync/.test(body);
    },
    fix: 'Tell the person when the save failed (and what to do), or log it.' },
  { id: 'UX-005', sev: 'Medium', area: 'saving', title: 'Saved settings are read and parsed outside a try (a blocked or broken value stops the whole page)', file: JS_HTML,
    re: /JSON\.parse\s*\(\s*(window\.)?(localStorage|sessionStorage)(\.getItem\s*\(|\s*\[)/,
    test: (line, ctx, lines, i) => !insideTry(lines, i, line.search(/JSON\.parse/)), skipFile: /(^|\/)(build-tools|tools|scripts)\//i,
    fix: 'Wrap the read and the parse in try/catch and fall back to defaults.' },
  { id: 'UX-006', sev: 'Medium', area: 'saving', title: 'A Delete button removes the record at once, with no confirm and no undo', file: JS_HTML,
    re: /method\s*:\s*['"]DELETE['"]|\baxios\.delete\s*\(/i,
    test: (line, ctx, lines, i) => /addEventListener\s*\(\s*['"]click|onclick|onClick/.test(lines.slice(Math.max(0, i - 4), i + 1).join('\n')),
    guardAbove: { re: /confirm\s*\(|confirm\w*\s*\(|undo/i, lines: 4 },
    fix: 'Ask first (naming what will be deleted), or offer Undo for a few seconds.' },
  { id: 'UX-007', sev: 'Medium', area: 'navigation', title: 'A "Back" control calls history.back() (from a shared link or a new tab it leaves the site)', file: JS_HTML,
    re: /history\.back\s*\(\s*\)|history\.go\s*\(\s*-1\s*\)|navigate\s*\(\s*-1\s*\)/, needsNear: /history\.length|document\.referrer/,
    test: line => /history\.back\s*\(\s*\)|history\.go\s*\(\s*-1\s*\)|navigate\s*\(\s*-1\s*\)/.test(blankStrings(line)) || /on\w+\s*=\s*["'][^"']*history\.(back|go)/i.test(line),
    fix: 'Link to the parent page by its address, and name it ("Back to Clients").' },
  { id: 'UX-008', sev: 'Medium', area: 'caching', title: 'The service worker\'s cache name never changes, so visitors keep the old files after an update', file: /\.(m?js)$/i,
    re: /^\s*(const|let|var)\s+\w*cache\w*\s*=\s*['"][^'"\d]*['"]\s*;?\s*$/i, fileHas: /caches\.open\s*\(/,
    fix: 'Put the release version in the cache name and delete the other caches on activate.' },
  { id: 'UX-009', sev: 'Medium', area: 'forms', title: 'Several checkboxes share a name without [], so PHP keeps only the last one ticked', file: /\.(html?|php)$/i,
    re: /<input\b(?=[^>]*type\s*=\s*["']?checkbox)[^>]*\bname\s*=\s*["'][^"'\[\]]+["']/i, test: repeatedCheckbox,
    fix: 'Name them name="tag[]" so PHP receives every ticked value.' },
  { id: 'UX-010', sev: 'Medium', area: 'code', title: 'A component is used without being imported (the page breaks when that part shows)', file: /\.(jsx|tsx)$/i,
    re: /(?:^|[^\w$.<])<[A-Z][\w$]+[\s/>]/, test: (line, ctx, lines, i) => !inBlockComment(lines, i) && jsxUnknownTag(line, ctx),
    fix: 'Import the component at the top of the file.' },

  // ---- working notes left in shipped comments ----
  // A comment that carries a date or a commit hash together with a review id or "fixed/review" is a note to the team,
  // not an explanation of the code. Rule ids alone (SEC-001 in a scanner's own comments) are not enough.
  { id: 'NOTE-001', sev: 'Medium', area: 'disclosure', comments: true, title: 'A shipped comment is a working note (review ids, commit hashes, dates): it tells readers about the team, not the code', file: /\.(m?js|cjs|tsx?|jsx|css|scss|html?|php|vue)$/i,
    re: /(\/\/|\/\*|^\s*\*|<!--|^\s*#)(?=.*(\b20\d\d-[01]\d-[0-3]\d\b|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d\d\b|\b[Cc]ommit\s+[0-9a-f]{7,40}\b))(?=.*(\b[A-Z]{2,3}-\d{2,4}\b|\b([Ff]ixed|[Rr]eview(ed)?|[Rr]everted|per)\b))/,
    fix: 'Say what the code does and why; keep review ids, dates and commits in the commit message or the handover.' },

  // ---- reading and access ----
  { id: 'A11Y-001', sev: 'Medium', area: 'accessibility', title: 'Text is set below 12px', file: /\.(css|scss|less|html?|php|vue|jsx|tsx)$/i,
    re: /font-size\s*:\s*(0?\.\d+|[1-9](\.\d+)?|1[01](\.\d+)?)px|font-size\s*:\s*[1-8](\.\d+)?pt\b|fontSize\s*:\s*['"]?(1[01]|[1-9])(px)?['"]?\s*[,}]/i,
    fix: 'Use 12px (9pt) or more; for small print, lighten it instead of shrinking it.' },
  { id: 'A11Y-002', sev: 'Medium', area: 'accessibility', title: 'A pop-up has no role="dialog", so screen readers and keyboards are lost in it', file: MARKUP,
    re: /<(div|section|aside)\b[^>]*\bclass\s*=\s*["']([^"']*\s)?(modal|popup|lightbox|dialog)(\s[^"']*)?["']/i, except: /\brole\s*=|aria-modal|aria-labelledby|data-bs-|data-toggle/i,
    fix: 'Use <dialog>, or add role="dialog" aria-modal="true" aria-labelledby, close on Escape and keep focus inside.' },
  // An image without width/height: 1,453 files over 43 real projects in T2, so it came back only once Low existed (T7:
  // lib/audit.js LOW_RULES). One finding per file; an image sized in its own style or a tracking pixel is left alone.
  { id: 'A11Y-003', sev: 'Medium', area: 'accessibility', title: 'An image has no width and height, so the page jumps as it loads', file: /\.(html?|php|vue|jsx|tsx|twig)$/i,
    re: /<img\b(?![^>]*\bwidth\s*=)(?![^>]*\bheight\s*=)(?![^>]*style\s*=\s*["'][^"']*(width|height|aspect-ratio))[^>]*\bsrc\s*=/i,
    except: /\{\{|<\?|\$\{|data:image\/gif|pixel|track|beacon|1x1/i,
    fix: 'Give the image its width and height (the picture\'s own size; CSS can still scale it): the browser keeps the space and nothing jumps.' },
  { id: 'A11Y-004', sev: 'Medium', area: 'accessibility', title: 'A label is not tied to its field (no for=, not wrapped round it), so a screen reader reads the field unnamed', file: MARKUP,
    re: /<label\b(?![^>]*\b(for|htmlFor)\s*=)[^>]*>[^<]+<\/label>/i,
    // only when a typed field follows straight after it (a label over radio buttons or plain text is a group heading)
    test: (line, ctx, lines, i) => {
      const after = line.slice(line.search(/<\/label>/i)) + '\n' + lines.slice(i + 1, i + 3).join('\n');
      const field = /<(input|select|textarea)\b[^>]*>/i.exec(after);
      return !!field && after.slice(0, field.index).replace(/<\/?(div|span|p|br)\b[^>]*>|<\/label>|\s/gi, '') === '' &&
        !/aria-label|type\s*=\s*["']?(hidden|submit|button|checkbox|radio|image|reset)\b/i.test(field[0]);
    },
    fix: 'Add for="the field\'s id", or put the field inside the label.' },

  // ---- a signing secret in the code: whoever reads it can sign in as anyone ----
  { id: 'SEC-017', sev: 'High', area: 'secrets', title: 'The secret that signs sign-ins is written into the code, so anyone who reads it can sign in as anyone', file: /\.(m?[jt]sx?|cjs|mts|cts)$/i, skipFile: TEST_PATH,
    re: /\b\w{0,30}(?:JWT|SESSION|COOKIE|AUTH|SIGNING)_?SECRET\w{0,30}\s*(?:[:=]|\|\||\?\?)\s*['"`][^'"`$\s]{1,200}['"`]|\bjwt\.(?:sign|verify)\s*\([^,\n]{1,200},\s*['"`][^'"`$\n]{1,200}['"`]/i, except: /example|placeholder|xxxx/i,
    fix: 'Replace that secret (everyone will need to sign in again), keep the new one in a server setting, and stop the app starting if the setting is missing instead of falling back to a written-in value.' },

  { id: 'SEC-018', sev: 'High', area: 'secrets', title: 'A secret is written into the code, as a value or as the fallback when a setting is empty', file: /\.(m?[jt]sx?|cjs|mts|cts|py|php|rb)$/i, skipFile: TEST_PATH,
    re: /secret|passw(?:or)?d|private[_-]?key|api[_-]?key|auth[_-]?token|access[_-]?token/i, test: writtenInSecret,
    fix: 'Replace the key, because anyone who has seen this file has it. Keep the new one in a server setting outside the web root, and delete the written-in value so a missing setting fails instead of using it.' },
  { id: 'SEC-019', sev: 'Medium', area: 'secrets', title: 'A secret is kept in a settings file: fine only if that file is never shared', file: /\.php$/i, path: PHP_SETTINGS_FILE, skipFile: TEST_PATH,
    re: /secret|passw(?:or)?d|private[_-]?key/i, test: secretInSettingsFile,
    fix: 'Check that git ignores this file, that no zip you share holds it, and that it sits outside the web root. If it was ever shared, replace the key.' },

  // ---- keys that reach the browser ----
  { id: 'KEY-001', sev: 'High', area: 'secrets', title: 'The Supabase service-role key is used in code that runs in the browser (that key skips every access rule on your database)', file: JS_HTML, skipFile: TEST_PATH,
    re: /\bcreate(?:Browser|Server)?Client\s*\([^;]{0,200}?(?:service_?role|service_?key)|\b(?:process\.env|import\.meta\.env)(?:\.|\[\s*['"])\w{0,60}(?:SERVICE_ROLE|SUPABASE_\w{0,30}SERVICE_KEY)/i,
    test: usedInBrowser,
    fix: 'Use the anon key in the browser and let row-level security decide what each person sees. Move anything that needs the service-role key to a server route (app/api, supabase/functions).' },
  { id: 'KEY-002', sev: 'Critical', area: 'secrets', title: 'A Supabase service-role key is written into a file (whoever sees it can read and change your whole database)', skipFile: TEST_PATH,
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,1000}\.eyJ[A-Za-z0-9_-]{16,2000}\.[A-Za-z0-9_-]{16}|\bsb_secret_\w{16}/, test: serviceRoleKey,
    fix: 'In the Supabase dashboard, replace the key now (treat this one as leaked). Keep the new one in a server-only setting with no public prefix, and use the anon key in the browser.' },
  { id: 'KEY-003', sev: 'High', area: 'secrets', title: 'Firebase\'s admin library is used in code that runs in the browser (admin access belongs on the server only)', file: JS_HTML, skipFile: TEST_PATH,
    re: /\bfrom\s+['"]firebase-admin(?:\/[\w-]{1,30})?['"]|\brequire\s*\(\s*['"]firebase-admin|\badmin\.credential\.cert\s*\(|\bcredential\s*:\s*cert\s*\(/,
    test: usedInBrowser,
    fix: 'Use the normal firebase package in the browser, with security rules. Move admin work to a server route or a Cloud Function.' },
  { id: 'KEY-004', sev: 'Critical', area: 'secrets', title: 'A Firebase or Google service account file is imported into browser code, so its private key goes to every visitor', file: JS_HTML, skipFile: TEST_PATH,
    re: /\b(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"][^'"\n]{0,200}(?:service[-_]?account|adminsdk)[^'"\n]{0,80}\.json['"]/i,
    test: usedInBrowser,
    fix: 'Create a new key in the Google Cloud console and delete this one (treat it as leaked). Keep the file out of the project, and use it from server code only.' },
  { id: 'KEY-005', sev: 'Critical', area: 'secrets', title: 'A service account key file sits in a folder the site serves: anyone can download it by its address', file: /\.json$/i, path: /(^|\/)(public|public_html|static|www|htdocs|assets)\//i, skipFile: TEST_PATH,
    re: /"type"\s*:\s*"service_account"/, fileHas: /"private_key"\s*:\s*"[^"]{40}/,
    fix: 'Delete the file from the folder, create a new key in the Google Cloud console and delete the old one (treat it as leaked). Keep the new key outside the project.' },
  { id: 'ENV-001', sev: 'Critical', area: 'secrets', title: 'A secret has a public prefix in the .env file, so the build copies it into the pages every visitor downloads', file: /^\.env/i,
    skipFile: /(^|\/)\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults?|test)$|(^|\/)\.env\.test(?:\.|$)/i,
    re: PUBLIC_ENV_LINE, test: publicEnvSecret,
    fix: 'Take the public prefix off the name, use the value only from a server route, and have the browser call that route. If the site was ever built with this name, replace the key (treat the old one as leaked).' },
  { id: 'ENV-004', sev: 'Medium', area: 'secrets', title: 'Anyone can read this key in the page, because the .env file gives it a public prefix: fine for a key the service says is safe in a browser', file: /^\.env/i,
    skipFile: /(^|\/)\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults?|test)$|(^|\/)\.env\.test(?:\.|$)/i,
    re: PUBLIC_ENV_LINE, test: publicEnvKey,
    fix: 'Look in the service\'s own docs. If its key is meant for browsers (and you can limit it to your site), nothing needs to change: set this finding aside. If someone with this key could spend your money or read your data, move it to a server route: take the prefix off, have the browser call your route, and replace the key.' },
  { id: 'ENV-002', sev: 'High', area: 'secrets', title: 'Code reads a secret through a public variable (NEXT_PUBLIC_, VITE_, PUBLIC_ and the like), so its value ends up in the browser', file: /\.(m?js|cjs|tsx?|jsx|html?|vue|svelte|astro)$/i,
    re: PUBLIC_VAR_READ, test: (line, ctx, lines, i) => publicVarInCode(line, ctx, lines, i, isStrongSecret),
    fix: 'Call the service from a server route, read the key there under a name with no public prefix, and have the browser call your route. Replace the key if the site was ever built this way.' },
  { id: 'ENV-005', sev: 'Medium', area: 'secrets', title: 'Anyone can read this key in the page, because code reads it through a public variable: fine for a key the service says is safe in a browser', file: /\.(m?js|cjs|tsx?|jsx|html?|vue|svelte|astro)$/i,
    re: PUBLIC_VAR_READ, test: (line, ctx, lines, i) => publicVarInCode(line, ctx, lines, i, isOnlyKeyLike),
    fix: 'Look in the service\'s own docs. If its key is meant for browsers (and you can limit it to your site), nothing needs to change: set this finding aside. If someone with this key could spend your money or read your data, move it to a server route, have the browser call your route, and replace the key.' },
  { id: 'ENV-003', sev: 'High', area: 'secrets', title: 'A build config copies a secret into the browser code (a key set this way is in the page for anyone to read)', file: /\.(m?js|cjs|ts|mts)$/i, path: /(^|\/)(vite|next|nuxt)\.config\.\w+$/i,
    re: /['"`](?:process|import\.meta)\.env(?:\.\w{1,80})?['"`]\s*:|\b\w{1,60}['"`]?\s*:\s*process\.env\.\w{1,80}/, test: configSendsSecret,
    fix: 'Take it out of the config (vite define, next env, nuxt runtimeConfig.public), call the service from a server route that holds the key, and replace the key if the site was ever built this way.' },

  // ---- payments, logs and open doors ----
  { id: 'PAY-006', sev: 'High', area: 'payments', title: 'The amount to charge comes from what the visitor sent, so anyone can change the price to 1 cent before paying', file: /\.(php|m?js|cjs|tsx?|jsx|py)$/i,
    re: /\b(?:amount|unit_amount|unitAmount|total_amount|totalAmount|value)\s*:\s*[^,;\n]{1,120}|\b(?:amount|unit_amount|unitAmount)\s*[,}]|['"](?:amount|unit_amount)['"]\s*=>|\b(?:amount|unit_amount)['"]?\s*[=:]\s*[^,\n]{1,80}/,
    fileHas: /\b(?:checkout\.sessions|paymentIntents|invoiceItems|charges|paymentLinks)\.create\b|\bPaymentIntent::create|\bSession::create|\bstripe\.(?:PaymentIntent|checkout\.Session)\.create|\.orders\.create\b|paypal|lemonsqueezy|razorpay|paddle/i,
    // a donation or a tip is an amount the visitor chooses
    skipFile: /donat|(^|\/)(tips?|gifts?|top-?ups?|pay-what)[\w.-]*(\/|$)/i, test: amountFromRequest,
    guardAbove: { re: /\b(?:amount|price|total)\w*\s*(?:!==|!=)\s*\w|\b(?:expected|computed|calculated)\w*\s*(?:!==|!=)|(?:!==|!=)\s*(?:[\w$]{1,40}\.)?\w{0,30}(?:amount|price|total)/i, lines: 10 },
    fix: 'Send only the item\'s id from the browser. On the server, look up its price (your database or a fixed list) and use that amount.' },
  { id: 'LOG-001', sev: 'Medium', area: 'privacy', title: 'A token, password, key or session is written to the log, where hosting staff, log tools and error reports can read it', file: /\.(m?js|cjs|tsx?|jsx|html?|vue|svelte|astro)$/i,
    re: /\bconsole\.(?:log|info|debug|warn|error)\s*\(/, except: /NODE_ENV|__DEV__|import\.meta\.env\.DEV/, skipFile: /(^|\/)(build-tools|tools|scripts|bin|cli)\//i, test: logsSecret,
    guardAbove: { re: /NODE_ENV|__DEV__|import\.meta\.env\.DEV|\bisDev\b/, lines: 2 },
    fix: 'Log what happened ("token refreshed") or only whether the value is there, never the value itself. If real values were logged, replace them.' },
  { id: 'CORS-003', sev: 'Medium', area: 'config', title: 'CORS is open to every site with credentials switched on, so another site can try to call this API as the signed-in visitor', file: SERVER,
    re: new RegExp(/\borigin\s*:\s*(?:['"`]\*['"`]|true\b)|\borigin\s*:\s*[^,;\n]{0,100}(?:\|\||\?\?)\s*(?:['"`]\*['"`]|true\b)|\borigin\s*:\s*(?:async\s*)?(?:function\b[^(\n]{0,40})?\(\s*\w{1,30}\s*,\s*\w{1,30}\s*\)|\ballow_origins\s*=\s*(?:\[\s*['"]\*['"]\s*\]|[A-Za-z_]\w{0,60})|\bCORS\s*\(\s*\w{1,40}[^)\n]{0,200}supports_credentials\s*=\s*True|/.source + ORIGIN_ECHOED.source + '|' + HAND_SET_ORIGIN.source), fileHas: /cors|access-control-allow-origin/i,
    skipFile: /(^|\/)(vite|webpack|next|nuxt)\.config\.\w+$/i, test: openCorsCredentials,
    fix: 'Name the sites that may call it: origin: \'https://your-site.example\' (a fixed list of full addresses), and keep credentials on only for those.' },
];

module.exports = { RULES_MORE, insideTry, insideScript, locationFromRequestVar, newRun };
