// SIMPLE built-in audit. Stands alone on purpose: it depends on no other audit tool, so nothing here imports one.
// Three parts (SCOPE §23-24): code rules over the project's files, GETs against the running localhost copy, and -
// when the project has a live address - slow GETs of the live site compared with the local copy (lib/live.js).
// Every check is a written RULE with an id; a finding names the rule, the file/line or address, and a way out.
// Gate: Critical or High = "fix first"; Medium = warning. It will miss things - it aims at the core criticals only.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { headerFindings, compareLive, siteOf } = require('./live');
const { disclosurePass, publishedFiles, RULE: DISC_RULES } = require('./disclosure');
const { gitConfigRisky } = require('./gitstate');
const { fingerprint, applyJudged } = require('./judged');
const { findRoots } = require('./roots');
const { RULES_MORE, locationFromRequestVar } = require('./rules-more');
const { crossAudit, CROSS_RULES } = require('./cross');

// Build output and release copies are skipped: a fault in the source would otherwise be counted once per copy
// (one real project showed 15 findings from 9 real lines, the rest in _build/deploy copies).
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv',
  '_backups', '.claude', 'coverage', 'playwright-report', 'test-results',
  '_build', '_builds', '_dist', '_out', '_release', '_releases', '_deploy', 'releases', '.next', '.nuxt', '.output', '.svelte-kit']);

// INJ-003 (revised after a run of false positives): innerHTML is only a fault when the value can come
// from OUTSIDE the code. Fixed text, fixed lists and numbers are safe. Checks the right-hand side of the assignment
// after removing escaped values (esc(...), escapeHtml(...)) and numeric ones (toFixed, Math.round, .length ...), for a
// direct outside source, or a variable that the same file filled from one (one step, simple on purpose).
const OUTSIDE = /\.value\b|\blocalStorage\b|\bsessionStorage\b|\blocation\b|\bURLSearchParams\b|\.searchParams\b|\bJSON\.parse\b|\bfetch\s*\(|\.responseText\b|\.responseJSON\b|\bxhr\.response\b|\.json\(\)|\bFileReader\b|\breader\.result\b|\bpostMessage\b|\b(event|evt|e|ev|msg|message)\.data\b|\bdocument\.cookie\b|\bdocument\.referrer\b|\bwindow\.name\b/;
const ESCAPED = /\b(esc|escape|escapeHtml|escapeHTML|htmlEscape|escHtml|encodeHTML|encodeHtml|sanitize|sanitizeHtml)\s*\(([^()]|\([^()]*\))*\)|\bDOMPurify\.sanitize\s*\(([^()]|\([^()]*\))*\)|\.textContent\b/g;
const NUMERIC = /[\w$.\])]+\.toFixed\s*\([^)]*\)|\bMath\.\w+\s*\(([^()]|\([^()]*\))*\)|\b(Number|parseInt|parseFloat)\s*\(([^()]|\([^()]*\))*\)|[\w$.\])]+\.length\b|[\w$.\])]+\.toLocaleString\s*\([^)]*\)/g;
// The file is read without scopes, so a name counts as outside data only when EVERY place the file sets it is from
// outside and it is never a function parameter. A short name reused across functions (v, c, k ...) is ambiguous and
// is not counted (`([k, v]) =>` was once blamed for a `v = input.value` in another function).
function taintedNames(text) {
  const dirty = new Map(), clean = new Set();
  // `name = value` only: not `c => ...` (arrow), not `==`/`===`, not `obj.name = ...` (a property, not the variable).
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]*)|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1] || m[3], rhs = m[2] != null ? m[2] : m[4];
    if (!name) continue;
    if (OUTSIDE.test(String(rhs).replace(ESCAPED, '').replace(NUMERIC, ''))) dirty.set(name, true);
    else clean.add(name);
  }
  const params = /\(([^()]*)\)\s*=>|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>|\bfunction\b\s*[\w$]*\s*\(([^()]*)\)|\bcatch\s*\(([^()]*)\)/g;
  while ((m = params.exec(text))) {
    for (const id of String(m[1] || m[2] || m[3] || m[4] || '').match(/[A-Za-z_$][\w$]*/g) || []) clean.add(id);
  }
  return new Set([...dirty.keys()].filter(n => !clean.has(n)));
}
// Every place a string becomes HTML: innerHTML/outerHTML, insertAdjacentHTML, document.write, React's
// dangerouslySetInnerHTML.
const HTML_SINK = /\.(innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(\s*['"`][^'"`]*['"`]\s*,|\bdocument\.write(ln)?\s*\(|dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/;
// Words inside fixed text are not variables: 'Drag out a <b>Room</b>' names no `out` or `a`. Quoted strings are
// blanked; a template literal keeps only its ${...} parts.
function codeOnly(s) {
  return String(s).replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, t => ' ' + (t.match(/\$\{[^}]*\}/g) || []).join(' + ') + ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
}
function innerHtmlFromOutside(line, ctx) {
  const m = HTML_SINK.exec(line);
  if (!m) return false;
  // up to the end of this statement only (a minified line holds many)
  const rhs = codeOnly(line.slice(m.index + m[0].length)).split(';')[0].replace(ESCAPED, '""').replace(NUMERIC, '0');
  if (OUTSIDE.test(rhs)) return true;
  if (!ctx.tainted) ctx.tainted = taintedNames(ctx.text);
  for (const n of ctx.tainted) if (new RegExp('(^|[^\\w$.])' + n.replace(/\$/g, '\\$') + '\\b').test(rhs)) return true;
  return false;
}
const CODE_EXT = /\.(php|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|less|json|ya?ml|ini|env|conf|htaccess|sh|bat|cmd|toml|pem|key|txt)$/i;
// Files only ever run on the developer's own PC (a dev/ folder, a *.dev.* or *.local.* file, docker-compose).
const DEV_FILE = /(^|\/)(dev|local|docker)(\/|[._-])|[._-](dev|local)\.[a-z]+$|docker-compose/i;
// A comment line: a tracker tag or a setting written in a comment is not live. Secrets are still read in comments.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#(?![!\[])|<!--|;|--\s|rem\s)/i;

// SEC-001: the BEGIN line alone is not a key (a detector, a game that prints a fake one); a key has a base64 body.
// A real key's body decodes to binary; a made-up one ("training-key-not-a-real-key...") decodes to plain text.
function binaryBody(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 24) return false;
  let text = 0;
  for (const c of buf) if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9) text++;
  return text / buf.length < 0.9;
}
function keyBodyFollows(line, ctx, lines, i) {
  const after = (line.split(/PRIVATE KEY-----/)[1] || '').replace(/\\n/g, '');
  const inline = /[A-Za-z0-9+/]{60,}={0,2}/.exec(after);
  if (inline) return binaryBody(inline[0]);
  let body = '';
  for (let k = i + 1; k < Math.min(lines.length, i + 6); k++) {
    const t = lines[k].replace(/^[\s'"`,+]+|[\s'"`,+;]+$|\\n/g, '');
    if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(t)) break;
    body += t;
  }
  return body ? binaryBody(body) : false;
}
// SEC-002/003: a key-shaped placeholder ("sk-ant-...fake...", "xxxxxxxx") is not a key.
function notPlaceholderKey(line) {
  const m = /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|sk_live_\w+|rk_live_\w+|AKIA\w+|ghp_\w+|github_pat_\w+|xox[baprs]-[\w-]+)/.exec(line);
  if (!m) return true;
  const body = m[0].replace(/^(sk-ant-(api\d+-)?|sk-(proj-)?|[sr]k_live_|AKIA|ghp_|github_pat_|xox[baprs]-)/, '');
  return !(/fake|test|dummy|example|sample|placeholder|your|xxxxx|00000000|12345678|abcdefgh/i.test(body) || new Set(body).size < 8);
}
// INJ-004: request data passed through a function other than a plain pass-through (trim, sprintf...) is taken as
// escaped or transformed (e(), Preview::fromText(), a template helper). Only a direct echo counts.
const PASS_THROUGH = /^(trim|rtrim|ltrim|strval|sprintf|vsprintf|implode|join|strtolower|strtoupper|ucfirst|ucwords|nl2br|stripslashes|urldecode|rawurldecode|substr|mb_substr|str_replace|preg_replace|print_r|var_export|string|isset|empty)$/i;
function echoedRaw(line) {
  const re = /\$_(GET|POST|REQUEST|COOKIE)\s*\[/g;
  let m;
  while ((m = re.exec(line))) {
    // walk back through the open brackets around this $_X and look at the word before each "("
    let depth = 0, raw = true;
    for (let k = m.index - 1; k >= 0; k--) {
      const c = line[k];
      if (c === ')') depth++;
      else if (c === '(') {
        if (depth) { depth--; continue; }
        const word = (/([\w:\\]+)\s*$/.exec(line.slice(0, k)) || [])[1] || '';
        if (word && !PASS_THROUGH.test(word.split(/::|\\/).pop())) { raw = false; break; }
      } else if (!depth && (c === ';' || c === '{' || c === '}' || line.slice(k - 2, k + 1) === '<?=' || /\b(echo|print)\s$/.test(line.slice(Math.max(0, k - 6), k + 1)))) break;
    }
    if (raw) return true;
  }
  return false;
}
// SEC-004: a value that is only the word for a password ('password' => 'password', a label picked by a ternary) is a
// name, not a password.
function realPasswordValue(line) {
  const m = /\b(password|passwd|db_pass|secret)\s*['"]?\s*[:=]>?\s*['"]([^'"\s$]{8,})['"]/i.exec(line);
  return !(m && /^(password|passwd|secret|passphrase|db_pass|new_?password|current_?password)$/i.test(m[2]));
}
// CSRF-001: a form with a hidden field the server fills from a token, a claim or a signed link (a one-time link from
// an email: confirm, unsubscribe, verify; an installer's claim) cannot be forged by another site. Read to </form>.
const SERVER_TOKEN = /<input\b(?=[^>]*type\s*=\s*["']?hidden)(?=[^>]*value\s*=\s*["']?\s*(<\?(=|php\s+echo)|\{\{|<%=|\$\{)[^>]*?\$?\b\w*(token|nonce|claim|sig|signature|hash|confirm\w*|ask)\b)[^>]*>/i;
function noServerToken(line, ctx, lines, i) {
  const form = [];
  for (let k = i; k < Math.min(lines.length, i + 80); k++) { form.push(lines[k]); if (/<\/form>/i.test(lines[k])) break; }
  return !SERVER_TOKEN.test(form.join('\n'));
}
// PRIV-001: the word "cookie" near a tracker (a banner beside it) proves nothing. The tag is taken as waiting for consent
// only when a consent tool holds it back (type="text/plain", data-category) or it sits inside a template branch that
// opens on consent above it and is not closed before it.
function notBehindConsent(line, ctx, lines, i) {
  if (/type\s*=\s*["']?text\/plain|data-(cookie)?(category|consent|cookiecategory|cookieconsent)\b/i.test(line)) return false;
  let closed = 0;
  for (let k = i - 1; k >= Math.max(0, i - 60); k--) {
    const l = lines[k];
    if (/<\?php\s+(endif|\})|\{%\s*endif|@endif|\{\{\/if/i.test(l)) closed++;
    if (/<\?php\s+if\s*\([^)]*(consent|cookie|allow|analytics|tracking)|\{%\s*if\b[^%]*(consent|cookie|allow|analytics)|@if\s*\([^)]*(consent|cookie)|\{\{#if\s+[^}]*(consent|cookie)/i.test(l)) {
      if (closed === 0) return false;
      closed--;
    }
  }
  return true;
}
const MAX_FILES = 6000;
const MAX_BYTES = 800 * 1024;

// Pattern rules. `test` runs per line; `file` limits which files; `except` drops obvious placeholders/tests.
const RULES = [
  { id: 'SEC-001', sev: 'Critical', area: 'secrets', title: 'Private key in a file', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, test: keyBodyFollows, fix: 'Move the key out of the project and rotate it.' },
  { id: 'SEC-002', sev: 'Critical', area: 'secrets', title: 'Anthropic / OpenAI API key in a file', test: notPlaceholderKey, re: /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,})/, fix: 'Rotate the key; read it from an environment variable or a config file outside the web root.' },
  { id: 'SEC-003', sev: 'Critical', area: 'secrets', title: 'Live payment / cloud / GitHub key in a file', test: notPlaceholderKey, re: /\b(sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/, fix: 'Rotate the key now; keep secrets out of the code.' },
  { id: 'SEC-005', sev: 'High', area: 'secrets', title: 'Service key in a file (webhook secret, Slack, SendGrid, Mailgun, Twilio)', re: /\b(whsec_[A-Za-z0-9]{24,}|hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{39,50}|key-[0-9a-f]{32}\b|SK[0-9a-f]{32}\b)/, fix: 'Rotate the key; read it from config outside the project files you share or upload.' },
  { id: 'SEC-006', sev: 'Medium', area: 'secrets', title: 'Google API key in a file: check it is restricted to your site', re: /\bAIza[0-9A-Za-z_-]{35}\b/, fix: 'In Google Cloud, restrict the key to your domain and to the APIs it needs; a key for server calls belongs in config, not code.' },
  { id: 'SEC-004', sev: 'Medium', area: 'secrets', title: 'Password written into the code', re: /\b(password|passwd|db_pass|secret)\s*['"]?\s*[:=]>?\s*['"][^'"\s$]{8,}['"]/i, except: /(example|changeme|your[_-]|placeholder|xxxx|\*\*\*|test|dummy|sample|not_?a_?secret|dev_?only)/i, test: realPasswordValue, fix: 'Read it from config outside the web root; if it is a real password, change it.' },

  { id: 'INJ-001', sev: 'High', area: 'injection', title: 'Request data joined into an SQL query', file: /\.php$/i, re: /(["'])[^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*\1\s*\.\s*\$_(GET|POST|REQUEST|COOKIE)|"[^"]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"]*\{?\$_(GET|POST|REQUEST|COOKIE)/i, fix: 'Use a prepared statement with ? placeholders.' },
  { id: 'INJ-002', sev: 'High', area: 'injection', title: 'Request data reaches eval / system / include', file: /\.php$/i, re: /\b(eval|assert|system|exec|shell_exec|passthru|popen|include|require)(_once)?\b\s*\(?[^;]*\$_(GET|POST|REQUEST|COOKIE)/i, fix: 'Never pass request data to code or shell; map it to a fixed list instead.' },
  { id: 'INJ-003', sev: 'Medium', area: 'injection', title: 'Outside data put into the page as HTML (innerHTML, insertAdjacentHTML, document.write)', file: /\.(m?js|tsx?|jsx|html?)$/i, re: HTML_SINK, test: innerHtmlFromOutside, fix: 'Use textContent, or escape the value (esc/escapeHtml) before it becomes HTML.' },
  { id: 'INJ-004', sev: 'Medium', area: 'injection', title: 'Request data echoed without escaping', file: /\.php$/i, re: /\b(echo|print)\s+[^;]*\$_(GET|POST|REQUEST|COOKIE)\[|<\?=\s*[^;?]*\$_(GET|POST|REQUEST|COOKIE)\[/i, except: /htmlspecialchars|htmlentities|intval|\(int\)|json_encode|urlencode|\b(e|esc\w*|h)\s*\(|\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]]*\]\s*(\?\?\s*[^)=]*\))?\s*[!=]==?/i, test: echoedRaw, fix: 'Wrap it in htmlspecialchars(..., ENT_QUOTES).' },
  { id: 'INJ-005', sev: 'High', area: 'injection', title: 'Request data given to unserialize()', file: /\.php$/i, re: /\bunserialize\s*\([^;]*\$_(GET|POST|REQUEST|COOKIE)/i, fix: 'Use json_decode for data from visitors; unserialize can run code.' },
  { id: 'INJ-006', sev: 'High', area: 'injection', title: 'Request data reaches a shell command', file: /\.(m?js|cjs|ts)$/i, re: /((?<![.\w$])(exec|execSync|spawn|spawnSync|execFile)|\b(child_process|childProcess|cp)\.(exec|execSync|spawn|spawnSync|execFile))\s*\([^;]*(req\.(query|body|params|headers)|`[^`]*\$\{[^}]*req\.)/, fix: 'Never build a command from request data; pass fixed arguments to execFile and check the values against a list.' },
  { id: 'INJ-007', sev: 'High', area: 'injection', title: 'Request data built into an SQL string', file: /\.(m?js|cjs|tsx?|py)$/i, re: /`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{[^}]*req\.(query|body|params)|\bf["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{[^}]*request\.(args|form|json|values|GET|POST)|["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*(\+|%)\s*\(?\s*(req\.(query|body|params)|request\.(args|form|GET|POST))/i, fix: 'Use placeholders (? or %s with a parameter list), never string building.' },
  { id: 'INJ-008', sev: 'High', area: 'injection', title: 'Python runs a shell command built from outside data', file: /\.py$/i, re: /\b(os\.system|os\.popen)\s*\([^)]*(request\.|f["']|\+|%|\.format\()|\bsubprocess\.\w+\([^)]*shell\s*=\s*True[^)]*\)?.*(request\.|f["'])|\bsubprocess\.\w+\(\s*(f["']|[^,)]*\+)[^)]*shell\s*=\s*True/, fix: 'Pass a list of fixed arguments without shell=True, and check any value from outside against a list.' },
  { id: 'INJ-009', sev: 'High', area: 'injection', title: 'Data from outside is unpickled (pickle can run code)', file: /\.py$/i, re: /\bpickle\.loads?\s*\([^)]*(request\.|\.recv\(|urlopen|\.content\b|\.body\b)/, fix: 'Use JSON for anything that comes from outside.' },
  { id: 'INJ-010', sev: 'Medium', area: 'injection', title: 'Outside data run as code (eval / new Function / setTimeout with a string)', file: /\.(m?js|tsx?|jsx|html?)$/i, re: /(?<![\w$.])(eval|new\s+Function|setTimeout|setInterval)\s*\((?!\s*(function\b|async\b|\([^)]*\)\s*=>|[\w$]+\s*=>|[\w$.]+\s*,))[^;]*?(location\b|\.value\b|localStorage|sessionStorage|URLSearchParams|document\.cookie|\b(e|ev|event|msg)\.data\b|\.responseText)/, fix: 'Never run text as code; parse it (JSON.parse) or map it to a fixed list of actions.' },
  { id: 'PATH-001', sev: 'High', area: 'injection', title: 'Request data picks the file to read, delete or fetch', file: /\.(php|m?js|cjs|ts|py)$/i, re: /\b(file_get_contents|readfile|fopen|file|unlink|copy|rename|file_put_contents|curl_init|simplexml_load_file)\s*\(\s*[^;,)]*\$_(GET|POST|REQUEST|COOKIE)|\b(readFile|readFileSync|createReadStream|sendFile|unlink|unlinkSync|download)\s*\([^;]*req\.(query|params|body)|\b(open|send_file|send_from_directory)\s*\([^)]*request\.(args|form|values)/i, needsNear: /basename|realpath|path\.normalize|startsWith|allow(ed)?_?list|white_?list|in_array\s*\(|secure_filename|safe_join|\.includes\(/i, fix: 'Map the request to a fixed list of files (or basename() plus a folder check), and never fetch a URL a visitor typed.' },
  { id: 'REDIR-001', sev: 'Medium', area: 'injection', title: 'Redirect goes wherever the request says (open redirect)', file: /\.(php|m?js|cjs|ts|py)$/i, test: locationFromRequestVar, re: /header\s*\(\s*["']Location:\s*["']?\s*\.\s*\$_(GET|POST|REQUEST)|header\s*\(\s*["']Location:\s*["']\s*\.\s*\$\w+\s*\)|header\s*\(\s*"Location:\s*\{?\$_(GET|POST|REQUEST)|\bres\.redirect\s*\(\s*(\d+\s*,\s*)?req\.(query|body|params)|\bredirect\s*\(\s*request\.(args|form|values)/i, needsNear: /parse_url|startsWith\s*\(\s*['"]\/|str_starts_with|allow(ed)?_?(list|hosts)|white_?list|is_safe_url|url_has_allowed_host|preg_match\s*\(\s*['"][#~/]\^\\?\//i, fix: 'Only redirect to your own paths: check the value starts with a single "/" (not "//"), or map it to a fixed list.' },
  { id: 'CORS-001', sev: 'Medium', area: 'config', title: 'Any site may call this with the visitor\'s cookies (CORS reflects the Origin)', file: /\.(php|m?js|cjs|ts|py|htaccess|conf)$/i, re: /Access-Control-Allow-Origin[^\n]*(\$_SERVER\s*\[\s*['"]HTTP_ORIGIN|req\.headers\.origin|req\.get\(\s*['"]origin|request\.headers\.get\(\s*['"]origin|%\{HTTP:Origin\})/i, needsNear: /allow(ed)?_?(list|origins)|white_?list|in_array\s*\(|\.includes\(|===\s*['"]https?:\/\//i, fix: 'Answer only your own origins: compare the Origin header with a fixed list before echoing it.' },
  { id: 'TLS-001', sev: 'Medium', area: 'config', title: 'Certificate checks switched off for outgoing requests', re: /rejectUnauthorized\s*:\s*false|CURLOPT_SSL_VERIFYPEER\s*,\s*(false|0)\b|CURLOPT_SSL_VERIFYHOST\s*,\s*(false|0)\b|\bverify\s*=\s*False\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, fix: 'Keep certificate checks on; if a CA bundle is missing, point to one (cacert.pem) instead of switching checks off.' },
  { id: 'RAND-001', sev: 'Medium', area: 'auth', title: 'Secret token made with a guessable random (Math.random / rand / uniqid)', re: /\b\$?\w*(token|secret|password|passwd|nonce|salt|otp|reset|session|apikey|api_key)\w*\s*(=|:|\.=)[^;\n]*(Math\.random\(|\bmt_rand\(|\brand\(|\buniqid\(|\brandom\.(random|randint|choice)\()/i, except: /crypto|random_bytes|random_int|secrets\.|getRandomValues|randomBytes/i, fix: 'Use a cryptographic source: random_bytes/bin2hex, crypto.randomBytes, secrets.token_urlsafe.' },
  { id: 'JWT-001', sev: 'High', area: 'auth', title: 'Sign-in token accepted without checking its signature', file: /\.(m?js|cjs|tsx?|py|php)$/i, re: /algorithms\s*[:=]\s*\[?\s*['"]none['"]|\bjwt\.decode\s*\([^)]*verify\s*=\s*False|verify_signature['"]?\s*:\s*False/i, fix: 'Use jwt.verify (or decode with verification and a fixed algorithm list); never accept "none".' },
  { id: 'DEBUG-001', sev: 'Medium', area: 'config', title: 'Debug server switched on (its console can run code)', file: /\.py$/i, re: /\.run\s*\([^)]*debug\s*=\s*True|DEBUG_PROPAGATE_EXCEPTIONS\s*=\s*True|use_debugger\s*=\s*True/, fix: 'Turn debug off outside your own PC; read it from an environment setting that defaults to off.' },
  { id: 'PHPINFO-001', sev: 'Medium', area: 'config', title: 'phpinfo() page in the project (shows the server setup and paths)', file: /\.php$/i, re: /^\s*(<\?php\s+)?phpinfo\s*\(\s*\)/i, fix: 'Delete the file before uploading.' },

  { id: 'AUTH-001', sev: 'High', area: 'auth', title: 'Password stored with a fast hash (md5/sha1)', re: /\b(md5|sha1)\s*\(\s*\$?(password|pass|pwd)/i, fix: 'Use password_hash / Argon2id / bcrypt.' },
  { id: 'AUTH-003', sev: 'Medium', area: 'auth', title: 'Visitor address read from a header the visitor can write (X-Forwarded-For): limits and logs can be dodged', file: /\.(php|m?js|cjs|ts|py)$/i, re: /\$_SERVER\s*\[\s*['"]HTTP_(X_FORWARDED_FOR|CLIENT_IP|X_REAL_IP|X_CLIENT_IP|FORWARDED)['"]\s*\]|req\.headers\s*\[\s*['"]x-(forwarded-for|real-ip|client-ip)['"]\s*\]|request\.headers\.get\(\s*['"]x-(forwarded-for|real-ip)['"]/i, needsNear: /trust(ed)?[_ -]?(prox|forward|ingress)|trustProxy|TRUSTED_PROXIES|trust proxy|ip_in_range|cidr|cloudflare_?ips|REMOTE_ADDR['"]\s*\]\s*(===|==|,\s*\$trusted)|parts\s*\[\s*-1\s*\]|end\(\s*\$parts\s*\)|\.pop\(\)/i, fix: 'Use REMOTE_ADDR (the real connection); read a forwarded header only when the request comes from your own proxy\'s address.' },
  { id: 'AUTH-002', sev: 'Medium', area: 'auth', title: 'Password compared with == (timing / type juggling)', file: /\.php$/i, re: /\$\w*(pass|token|secret)\w*\s*==\s*\$/i, except: /===|hash_equals|password_verify/i, fix: 'Use password_verify or hash_equals.' },

  { id: 'CSRF-001', sev: 'Medium', area: 'csrf', title: 'POST form with no token field', file: /\.(php|html?)$/i, re: /<form[^>]*method\s*=\s*["']?post/i, needsNear: /csrf|_token|nonce|xsrf/i, test: noServerToken, fix: 'Add a per-session token field and check it on the server.' },

  { id: 'UPL-001', sev: 'Medium', area: 'uploads', title: 'Upload saved - check the extension/type is limited', file: /\.php$/i, re: /move_uploaded_file\s*\(/, needsNear: /pathinfo|extension|mime|finfo|allowed|whitelist|allowlist|getimagesize|exif_imagetype|IMAGETYPE_|imagecreatefrom|\$head\b|magic|PK\\x03/i, fix: 'Allow a short list of extensions, check the real type, and store outside the web root.' },

  { id: 'CFG-001', sev: 'Medium', area: 'config', title: 'Errors shown to visitors', file: /\.(php|ini|env|htaccess|py|conf|sh|bat|cmd|toml|ya?ml)$|^\.env/i, re: /(display_errors['"]?\s*,\s*['"]?(1|on|true)|display_errors\s*=\s*(1|on)|^\s*(export\s+)?APP_DEBUG\s*=\s*['"]?true|^\s*DEBUG\s*=\s*True\b)/i, except: /dev|local|\.run\s*\(/i, skipFile: DEV_FILE, fix: 'Log errors; show visitors a plain message.' },
  { id: 'CFG-002', sev: 'Medium', area: 'config', title: 'Server listens on every address (0.0.0.0)', file: /\.(m?js|py|json)$/i, re: /\b(listen|host|hostname|bind)['"]?\s*[:=(,]\s*['"]0\.0\.0\.0['"]/i, fix: 'Bind to 127.0.0.1 unless it must be reached from other machines.' },

  { id: 'PRIV-001', sev: 'Medium', area: 'privacy', title: 'Tracker loads - check it waits for consent', file: /\.(php|html?|m?js|tsx?|jsx)$/i, re: /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\/[^"'\s>]*(googletagmanager\.com|google-analytics\.com\/(analytics|ga)\.js|connect\.facebook\.net|static\.hotjar\.com|clarity\.ms\/tag|pagead2\.googlesyndication\.com)/i, test: notBehindConsent, fix: 'Load trackers only after the visitor says yes.' },
  ...RULES_MORE,
];

// Files that must never sit in a web root.
const EXPOSED = [
  { id: 'EXP-001', sev: 'Critical', re: /^\.env(\..*)?$/i, title: '.env file inside the site folder' },
  { id: 'EXP-002', sev: 'High', re: /\.(sql|sqlite|db|bak|old|orig|swp)$/i, title: 'Database dump / backup file inside the site folder' },
  { id: 'EXP-003', sev: 'High', re: /\.(zip|tar|gz|7z|rar)$/i, title: 'Archive inside the site folder' },
  { id: 'EXP-004', sev: 'Medium', re: /^(package\.json|package-lock\.json|composer\.json|composer\.lock|yarn\.lock)$/i, title: 'Package list inside the site folder (shows which versions to attack)' },
  { id: 'EXP-006', sev: 'Medium', re: /^(error_log|debug\.log|php_errors\.log|laravel\.log)$|\.log$/i, title: 'Log file inside the site folder' },
];
// FTP/SFTP settings saved by an editor: they hold the hosting password in plain text, wherever they sit.
const FTP_FILES = /^(sftp-config\.json|sftp\.json|\.ftpconfig|ftp-config\.json|ftpsync\.settings|sitemanager\.xml|recentservers\.xml|deployment\.xml|\.remote-sync\.json)$/i;
const FTP_PASS = /"(password|pass|passphrase)"\s*:\s*"[^"]{3,}"|<Pass\b[^>]*>[^<]{3,}<\/Pass>|<option name="password" value="[^"]{3,}"/i;
const WEBROOT_NAMES = /^(public_html|public|www|htdocs|web|site)$/i;
const OLD_COPY = /^(old|_old|old-site|site-old|oldsite|backup|backups|bak|previous|[a-z0-9_-]*-(old|backup|bak|copy))$/i;
// PRIV-002: outside services the site loads code, styles, frames or data from; each receives the visitor's address.
const LOADS_FROM = /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})|<iframe\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})|<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})[^>]*|\bfetch\s*\(\s*["'`]https:\/\/([a-z0-9.-]+\.[a-z]{2,})|@import\s+url\(\s*["']?https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
const BRAND = [[/google|gstatic|doubleclick|youtube|ytimg/, 'google'], [/facebook|fbcdn|instagram/, 'facebook|meta'], [/cloudflare|cdnjs/, 'cloudflare'], [/jsdelivr/, 'jsdelivr'], [/unpkg/, 'unpkg'], [/stripe/, 'stripe'], [/paypal/, 'paypal'], [/microsoft|clarity\.ms|bing/, 'microsoft|clarity'], [/openstreetmap|osm/, 'openstreetmap'], [/tile\.|carto|mapbox/, 'map']];

// Apache: is this file already blocked by an .htaccess between it and the web root? Looks for "deny all" in its
// own folder, or a 403/404/[F] line naming its folder or extension further up. A guess, so it only ever SKIPS.
function blockedByHtaccess(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  // a dot-file (.env, .git): named in a rule (\.env), or covered by a rule for every dot-file (^\. or /\.( ... ))
  const base = path.basename(file).toLowerCase();
  const dotRule = l => base.startsWith('.') && (l.includes('\\' + base) || l.includes(base) || /(\^|\/|\))\\\.(?![a-z0-9_-])/i.test(l));
  let d = path.dirname(file);
  const own = d;
  const names = [];
  for (let i = 0; i < 8; i++) {
    let text = '';
    try { text = fs.readFileSync(path.join(d, '.htaccess'), 'utf8'); } catch {}
    if (text) {
      if (d === own && /Require\s+all\s+denied|Deny\s+from\s+all/i.test(text) && !/<Files/i.test(text)) return true;
      // <Files "x"> / <FilesMatch "pattern"> ... Require all denied ... </Files>: judged as one line "pattern denied"
      const joined = text.replace(/<Files(Match)?\s+([^>]*)>([\s\S]*?)<\/Files(Match)?>/gi, (m, a, pat, inner) => /denied|deny\s+from\s+all/i.test(inner) ? '\n' + pat + ' denied\n' : '\n');
      for (const line of joined.split(/\r?\n/)) {
        if (!/\b(403|404)\b|\[F[\],]|\[F\]|denied|deny/i.test(line)) continue;
        const l = line.toLowerCase();
        if ((ext && new RegExp('\\b' + ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(l)) || names.some(n => l.includes(n)) || dotRule(l)) return true;
      }
    }
    if (WEBROOT_NAMES.test(path.basename(d))) break;
    names.push(path.basename(d).toLowerCase());
    d = path.dirname(d);
  }
  return false;
}

function listFiles(dir, skip) {
  const out = [];
  const walk = (d, inWebroot, depth) => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' && inWebroot) out.push({ p, inWebroot, name: e.name, gitDir: true });
        // an old copy of the site kept inside the served folder (old/, backup/, site-old/ ...) that has its own home page
        if (inWebroot && OLD_COPY.test(e.name) && ['index.html', 'index.php', 'index.htm'].some(n => fs.existsSync(path.join(p, n))) && !blockedByHtaccess(path.join(p, 'index.html'))) out.push({ p, inWebroot, name: e.name, oldCopy: true });
        if (SKIP_DIRS.has(e.name)) continue;
        if (skip.has(path.relative(dir, p).replace(/\\/g, '/').toLowerCase())) continue;
        walk(p, inWebroot || WEBROOT_NAMES.test(e.name), depth + 1);
      } else if (e.isFile()) {
        out.push({ p, inWebroot, name: e.name });
      }
    }
  };
  walk(dir, false, 0);
  return out;
}

function codeAudit(dir, skipList, opts = {}) {
  const loads = new Map(); // outside host -> first file:line that loads from it (PRIV-002)
  const privacy = [];     // text of the privacy page(s)
  const findings = [];
  const skip = new Set((skipList || []).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
  const files = listFiles(dir, skip);
  const exposed = new Map(); // rule|folder -> finding (one per folder, with a count)
  const read = [], docs = []; // every file read, and the notes (.md), for the cross-file checks (lib/cross.js)
  let scanned = 0;
  for (const f of files) {
    const rel = path.relative(dir, f.p).replace(/\\/g, '/');
    if (f.oldCopy) {
      findings.push({ rule: 'EXP-007', sev: 'Medium', area: 'exposed files', title: 'An old copy of the site is inside the site folder (' + f.name + '/): it is still served, with its old faults and libraries', where: rel + '/', fix: 'Delete the old copy from the upload (keep it outside the site folder if you need it).' });
      continue;
    }
    if (f.gitDir) {
      if (!blockedByHtaccess(path.join(f.p, 'HEAD'))) findings.push({ rule: 'EXP-005', sev: 'High', area: 'exposed files', title: '.git folder inside the site folder (the whole source can be downloaded from it)', where: rel + '/', fix: 'Keep the repository outside the uploaded folder, or block /.git in .htaccess.' });
      continue;
    }
    if (FTP_FILES.test(f.name)) {
      let t = ''; try { t = fs.readFileSync(f.p, 'utf8'); } catch {}
      if (FTP_PASS.test(t)) findings.push({ rule: 'SEC-007', sev: 'High', area: 'secrets', title: 'Hosting (FTP/SFTP) password saved in an editor settings file', where: rel, fix: 'Remove the password from the file (let the editor ask for it), never upload or share this file, and change the hosting password if it was.' });
    }
    if (f.inWebroot) {
      for (const x of EXPOSED) {
        if (!x.re.test(f.name) || blockedByHtaccess(f.p)) continue;
        const k = x.id + '|' + path.posix.dirname(rel);
        const hit = exposed.get(k);
        if (hit) { hit.n++; hit.where = path.posix.dirname(rel) + '/ (' + hit.n + ' files, e.g. ' + hit.first + ')'; }
        else exposed.set(k, { rule: x.id, sev: x.sev, area: 'exposed files', title: x.title, where: rel, first: f.name, n: 1, fix: 'Move it out of the folder visitors can reach, block it in .htaccess, or leave it out of the upload.' });
      }
    }
    // Notes (README, INSTALL) are read for the cross-file checks only (INST-001: the PHP or Node they promise).
    if (/\.md$/i.test(f.name)) {
      try { if (fs.statSync(f.p).size < 200 * 1024) docs.push({ rel, text: fs.readFileSync(f.p, 'utf8') }); } catch {}
      continue;
    }
    if (!CODE_EXT.test(f.name) && !/^\.env/i.test(f.name)) continue;
    if (/\.min\.js$|package-lock\.json$|\.map$/i.test(f.name)) continue;
    let st; try { st = fs.statSync(f.p); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    let text; try { text = fs.readFileSync(f.p, 'utf8'); } catch { continue; }
    scanned++;
    const lines = text.split(/\r?\n/);
    const ctx = { text, rel, abs: f.p, dir };
    const isTest = /(^|\/)(tests?|spec|__tests__|fixtures?)\//i.test(rel) || /\.(test|spec)\./i.test(f.name) || /^test_\w*\.py$/i.test(f.name);
    read.push({ rel, name: f.name, text, lines, isTest });
    if (/privacy/i.test(f.name) && /\.(html?|php|md|tsx?|jsx?|vue|json|txt)$/i.test(f.name)) privacy.push(text.toLowerCase());
    if (!isTest && /\.(html?|php|m?js|tsx|jsx|vue|twig)$/i.test(f.name)) lines.forEach((l, i) => {
      if (l.length > 2000 || COMMENT_LINE.test(l)) return;
      for (const m of l.matchAll(LOADS_FROM)) {
        if (m[3] && !/stylesheet/i.test(m[0])) continue;
        const host = (m[1] || m[2] || m[3] || m[4] || m[5]).toLowerCase();
        if (!loads.has(host)) loads.set(host, rel + ':' + (i + 1));
      }
      // a picture or map tile whose address is built in a script ('https://tile.host/' + z + ...) is a load too
      if (/\.(m?js|tsx|jsx|html?|vue)$/i.test(f.name) && /\.(png|jpe?g|webp|gif|svg)\b|tile|\bimg\b|image|avatar|photo|\.src\b|background/i.test(l)) {
        for (const m of l.matchAll(/['"]https:\/\/([a-z0-9.-]+\.[a-z]{2,})\/[^'"]*['"]\s*\+|`https:\/\/([a-z0-9.-]+\.[a-z]{2,})\/[^`]*\$\{/gi)) {
          const host = (m[1] || m[2]).toLowerCase();
          if (!loads.has(host)) loads.set(host, rel + ':' + (i + 1));
        }
      }
    });
    for (const r of RULES) {
      if (r.file && !r.file.test(f.name)) continue;
      if (isTest && r.sev !== 'Critical') continue;
      if (r.skipFile && r.skipFile.test(rel)) continue;
      if (r.path && !r.path.test(rel)) continue;
      if (r.fileHas && !r.fileHas.test(text)) continue;
      if (r.fileLacks && r.fileLacks.test(text)) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 2000 || !r.re.test(line)) continue;
        if (r.area !== 'secrets' && !r.comments && COMMENT_LINE.test(line)) continue;
        if (r.except && r.except.test(line)) continue;
        if (r.test && !r.test(line, ctx, lines, i)) continue;
        if (r.guardAbove && r.guardAbove.re.test(lines.slice(Math.max(0, i - r.guardAbove.lines), i).join('\n'))) continue;
        if (r.guardAfter && r.guardAfter.re.test(lines.slice(i, i + 1 + r.guardAfter.lines).join('\n'))) continue;
        if (r.needAfter && !r.needAfter.re.test(lines.slice(i + 1, i + 1 + r.needAfter.lines).join('\n'))) continue;
        if (r.needsNear) {
          const near = lines.slice(Math.max(0, i - 40), i + 40).join('\n');
          if (r.needsNear.test(near)) continue;
        }
        findings.push({ rule: r.id, sev: r.sev, area: r.area, title: r.title, where: rel + ':' + (i + 1), fix: r.fix, fp: fingerprint(line) });
        break; // one finding per rule per file keeps the list readable
      }
    }
  }
  const notes = [];
  let has = null;
  for (const e of exposed.values()) {
    // An archive a page of the project links to (a download, an update feed) is published on purpose.
    if (e.rule === 'EXP-003' && e.n === 1) {
      has = has || projectIndex(dir, skipList);
      const by = has(e.first);
      if (by) { notes.push(e.where + ' is named in ' + by + ', so it is taken as a download you publish on purpose (not counted).'); continue; }
    }
    delete e.first; delete e.n; findings.push(e);
  }
  // Outside services the site loads from (not its own host, not a made-up or local one).
  const own = opts.ownHost ? siteOf(opts.ownHost) : null;
  const outside = [];
  for (const [host, at] of loads) {
    const site = siteOf(host);
    if (site === own || /^(localhost|example\.(com|org|net)|w3\.org|schema\.org)$/.test(site) || /\.(example|test|local|localhost)$/.test(host)) continue;
    outside.push({ host, site, at });
  }
  // PRIV-002: a privacy page exists, but the site loads from outside services it never names.
  if (privacy.length && outside.length) {
    const said = privacy.join('\n');
    const unnamed = [];
    for (const { host, site, at } of outside) {
      const brand = (BRAND.find(([re]) => re.test(host)) || [null, site.split('.')[0]])[1];
      if (said.includes(site) || new RegExp('\\b(' + brand + ')', 'i').test(said)) continue;
      unnamed.push({ host, at });
    }
    if (unnamed.length) findings.push({ rule: 'PRIV-002', sev: 'Medium', area: 'privacy', title: 'The privacy page does not name ' + unnamed.length + ' outside service' + (unnamed.length === 1 ? '' : 's') + ' the site loads from: ' + unnamed.slice(0, 5).map(u => u.host).join(', ') + (unnamed.length > 5 ? '…' : ''), where: unnamed[0].at, fix: 'Name each service on the privacy page (what it is for, that it receives the visitor\'s address), or serve the file from your own site.' });
  }
  // Cross-file checks: read the files together (lib/cross.js).
  const cross = crossAudit(read, { docs, dir, loads: outside, blocked: blockedByHtaccess },
    (r, f, i, title) => ({ rule: r.id, sev: r.sev, area: r.area, title: title || r.title, where: f.rel + ':' + (i + 1), fix: r.fix, fp: fingerprint(f.lines[i] || '') }));
  findings.push(...cross.findings);
  notes.push(...cross.notes);
  return { findings: mergeCopies(findings), notes, filesSeen: files.length, filesScanned: scanned, truncated: files.length >= MAX_FILES };
}

// The same line in the same file name across several folders (old release copies: v1.5/, v1.6/ ...) is one fault,
// reported once at the shortest path, with the other places listed.
function mergeCopies(findings) {
  const groups = new Map(), out = [];
  for (const f of findings) {
    if (!f.fp) { out.push(f); continue; }
    const k = f.rule + '|' + f.fp + '|' + path.posix.basename(f.where.replace(/:\d+$/, ''));
    if (!groups.has(k)) { groups.set(k, f); out.push(f); continue; }
    const g = groups.get(k);
    g.also = g.also || [];
    if (f.where.length < g.where.length) { g.also.push(g.where); g.where = f.where; } else g.also.push(f.where);
  }
  return out;
}


function get(url, timeout = 5000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return resolve(null); // localhost only, no pacing needed
    const req = http.get(u, { timeout, headers: { 'User-Agent': 'TOMLINAudit/1' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (body.length < 200000) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Localhost only, so no pacing is needed. `looks` must match the body when given; without it, an HTML answer
// (a "not found" page that says 200) does not count.
const PROBES = [
  { path: '/.env', id: 'LIVE-010', sev: 'Critical', title: '.env is downloadable', looks: /^\s*[A-Z][A-Z0-9_]*\s*=/m },
  { path: '/.env.local', id: 'LIVE-010', sev: 'Critical', title: '.env.local is downloadable', looks: /^\s*[A-Z][A-Z0-9_]*\s*=/m },
  { path: '/.env.production', id: 'LIVE-010', sev: 'Critical', title: '.env.production is downloadable', looks: /^\s*[A-Z][A-Z0-9_]*\s*=/m },
  { path: '/.git/HEAD', id: 'LIVE-011', sev: 'High', title: '.git folder is downloadable', looks: /^ref: refs\// },
  { path: '/.git/config', id: 'LIVE-011', sev: 'High', title: '.git folder is downloadable', looks: /^\[core\]/m },
  { path: '/.vscode/sftp.json', id: 'LIVE-017', sev: 'Critical', title: 'Editor FTP settings (with the hosting password) are downloadable', looks: /"(host|password)"\s*:/ },
  { path: '/sftp-config.json', id: 'LIVE-017', sev: 'Critical', title: 'Editor FTP settings (with the hosting password) are downloadable', looks: /"(host|password)"\s*:/ },
  { path: '/backup.zip', id: 'LIVE-012', sev: 'High', title: 'backup.zip is downloadable' },
  { path: '/database.sql', id: 'LIVE-013', sev: 'High', title: 'database.sql is downloadable' },
  { path: '/config.php.bak', id: 'LIVE-014', sev: 'High', title: 'config.php.bak is downloadable' },
  { path: '/phpinfo.php', id: 'LIVE-015', sev: 'Medium', title: 'phpinfo page is reachable', looks: /phpinfo\(\)|PHP Version/i },
  { path: '/error_log', id: 'LIVE-016', sev: 'Medium', title: 'PHP error log is downloadable (shows paths and code)', looks: /PHP (Warning|Fatal error|Notice|Parse error|Deprecated)|Stack trace:/ },
  { path: '/package.json', id: 'LIVE-018', sev: 'Medium', title: 'package.json is downloadable (lists versions to attack)', looks: /"(dependencies|devDependencies)"\s*:/ },
  { path: '/composer.json', id: 'LIVE-018', sev: 'Medium', title: 'composer.json is downloadable (lists versions to attack)', looks: /"require"\s*:/ },
];
const WEB_FOLDERS = ['', 'public', 'public_html', 'www', 'htdocs', 'web', 'site', 'dist'];

// A local dev server (php -S, a Node static server) ignores .htaccess, so a file it hands out may still be refused on
// the real server. When the file sits in the project behind an .htaccess rule that blocks it, the probe is noted, not
// counted.
function servedFileBlocked(dir, urlPath) {
  for (const w of WEB_FOLDERS) {
    const f = path.join(dir, w, ...urlPath.split('/').filter(Boolean));
    if (fs.existsSync(f)) return blockedByHtaccess(f) ? path.relative(dir, f).replace(/\\/g, '/') : null;
  }
  return null;
}

async function localAudit(base, dir, opts = {}) {
  const findings = [], notes = [];
  const home = await get(base);
  if (!home) return { findings: [{ rule: 'LIVE-000', sev: 'High', area: 'localhost', title: 'Site did not answer', where: base, fix: 'Start the local copy, then scan again.' }], notes, reached: false };
  if (opts.headersOnLive) notes.push('Headers were checked on the live site, not on localhost: a local dev server often leaves out what the live server adds.');
  else for (const f of headerFindings(home, base, {})) findings.push(f);

  const root = base.replace(/\/+$/, '');
  for (const p of PROBES) {
    const r = await get(root + p.path);
    if (!r || r.status !== 200) continue;
    if (r.body === home.body) continue; // an app that answers every address with its home page
    if (p.looks && !p.looks.test(r.body.slice(0, 20000))) continue;
    if (/<html|<!doctype/i.test(r.body.slice(0, 500)) && !p.looks) continue; // an HTML "not found" page with a 200
    const blocked = servedFileBlocked(dir, p.path);
    if (blocked) { notes.push(p.path + ' is handed out by the local dev server, but ' + blocked + ' is blocked by an .htaccess rule on a real server, so it is not counted.'); continue; }
    findings.push({ rule: p.id, sev: p.sev, area: 'exposed files', title: p.title, where: root + p.path, fix: 'Block or remove it on the server.' });
  }
  return { findings, notes, reached: true, status: home.status };
}

// "Does any project file mention this?" for the live compare: a production-only setting (an analytics tag printed
// only on the live site) is written somewhere in the project, an injected one is not. Build output is searched too,
// since that is what gets uploaded; node_modules and .git are not.
const HOST_SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.claude', 'coverage', 'playwright-report', 'test-results']);
function projectIndex(dir, skipList) {
  let files = null;
  const skip = new Set((skipList || []).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
  const load = () => {
    files = [];
    let bytes = 0;
    const walk = (d, depth) => {
      if (files.length >= 8000 || bytes > 150e6 || depth > 12) return;
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!HOST_SKIP.has(e.name) && !skip.has(path.relative(dir, p).replace(/\\/g, '/').toLowerCase())) walk(p, depth + 1); continue; }
        if (!e.isFile() || !(CODE_EXT.test(e.name) || /\.(xml|svg|twig|blade\.php|vue|svelte|astro|liquid|njk|hbs|ejs|md)$/i.test(e.name))) continue;
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.size > 3e6) continue;
        try { const t = fs.readFileSync(p, 'utf8').toLowerCase(); bytes += t.length; files.push({ rel: path.relative(dir, p).replace(/\\/g, '/'), t }); } catch {}
      }
    };
    walk(dir, 0);
  };
  return needle => {
    if (!files) load();
    const n = String(needle).toLowerCase();
    if (!n) return null;
    const hit = files.find(f => f.t.includes(n));
    return hit ? hit.rel : null;
  };
}

// A signed-in area in its own folder (admin/, account/ ...) with its own .htaccess: on Apache that .htaccess replaces
// the site's rewrite rules, so the https redirect can stop at its door. The live step asks for it over http.
function privateAreas(dir) {
  const out = [];
  for (const w of WEB_FOLDERS) {
    for (const name of ['admin', 'account', 'accounts', 'dashboard', 'portal']) {
      const d = path.join(dir, w, name);
      if (fs.existsSync(path.join(d, '.htaccess')) && !out.includes('/' + name + '/')) out.push('/' + name + '/');
    }
  }
  return out;
}

const ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
// Severity calibration (scanner training T7): rules whose findings are true but rarely harm anyone (accessibility
// polish, search-engine details, working notes, a test file that checks nothing) are Low, so they sit below the faults
// that need fixing. Low and Info never change the verdict.
const LOW_RULES = new Set(['A11Y-001', 'A11Y-002', 'A11Y-003', 'A11Y-004', 'DATA-007', 'NOTE-001', 'REQ-001', 'UX-007',
  'TEST-001', 'CACHE-001', 'LIVE-026', 'LIVE-029', 'LIVE-030', 'LIVE-031']);

// A line's fingerprint (lib/judged.js) is its text, hashed: a judged finding stays set aside while the line is
// unchanged, wherever it moves in the file; edit the line and it is checked again.

// Counts and the verdict, from the findings that are left.
// Git ignores it = it stays on this PC: a fault there is a warning (Medium), not "fix first". Anything git keeps or would
// take (tracked, or new and not ignored) can reach the remote and the live site, so it keeps its rating. Only in a git
// repository whose settings are safe to read; anywhere else every file could be uploaded, so nothing changes. A
// finding with copies (also) stays as it is when any copy is published. The live check still asks the live site for
// the usual leaks (.env, dumps), so an ignored file that was uploaded by hand is found there as its own finding.
async function softenIgnored(dir, findings) {
  if (!fs.existsSync(path.join(dir, '.git')) || gitConfigRisky(dir)) return 0;
  const list = await publishedFiles(dir, true);
  if (!list) return 0;
  const published = new Set(list.map(f => f.rel.toLowerCase()));
  const fileOf = w => String(w || '').replace(/:\d+$/, '').replace(/\/$/, '');
  const ignored = w => {
    const rel = fileOf(w);
    // "git history: …", an address, or a summary line ("dir/ (3 files, e.g. …)"): not one file here, so left as it is
    if (!rel || /^(git history|https?:)/i.test(rel) || !fs.existsSync(path.join(dir, rel))) return false;
    const low = rel.toLowerCase();
    if (published.has(low)) return false;
    // a folder (.git/, an old copy/): ignored only when nothing inside it is published
    for (const p of published) if (p.startsWith(low + '/')) return false;
    return true;
  };
  let n = 0;
  for (const f of findings) {
    // a .git folder inside the site folder goes up with the site whatever .gitignore says
    if (f.rule === 'EXP-005' || ORDER[f.sev] > ORDER.High || !ignored(f.where) || (f.also || []).some(w => !ignored(w))) continue;
    f.ignored = { was: f.sev };
    f.sev = 'Medium';
    f.title += ' (git ignores this file, so it stays on this PC)';
    f.fix = 'A warning, not critical: git leaves this file out, so it does not go to the remote. ' + f.fix + ' It is critical again if the file is uploaded by hand (FTP, a zip) or taken out of .gitignore.';
    n++;
  }
  return n;
}

function summarise(findings) {
  const count = s => findings.filter(f => f.sev === s).length;
  const counts = { Critical: count('Critical'), High: count('High'), Medium: count('Medium'), Low: count('Low'), Info: count('Info') };
  return { counts, verdict: counts.Critical + counts.High ? 'fix-first' : (counts.Medium ? 'warnings' : 'passed') };
}

// opts.skip: folders (relative to the project) to leave out, e.g. a vendored reference copy.
// opts.judged: what a person judged wrong or already known (lib/judged.js entries). Never dropped silently: a set-aside
// finding is returned in `setAside`, with the reason and who said it. opts.notes: notes from the caller.
// opts.liveUrl: where the project is hosted. Then the live site's headers are checked (instead of localhost's), a few
// fixed files are asked for, and its pages are compared with the local copy's (see lib/live.js compareLive).
// opts.resolve / opts.gapMs / opts.minGapMs: for the demo and tests only (made-up sites on this PC).
// SEC-012: a key or password taken out of the files that an older version in the git history still holds. Anyone with
// a copy of the repository has it, so it counts as given away until it is rotated. The disclosure pass reads every
// past file version once and hands each one here; a key the files still hold is left to its own rule (SEC-001..006).
const HISTORY_KEYS = { 'SEC-001': 'private key', 'SEC-002': 'Anthropic / OpenAI API key', 'SEC-003': 'live payment, cloud or GitHub key', 'SEC-005': 'service key', 'SEC-006': 'Google API key', 'SEC-004': 'password' };
const KEYISH = /PRIVATE KEY|sk-|sk_live_|rk_live_|AKIA|ghp_|github_pat_|xox[baprs]-|whsec_|hooks\.slack|SG\.|key-|SK[0-9a-f]{32}|AIza|passw|db_pass|secret/i;
function historySecrets() {
  const rules = RULES.filter(r => HISTORY_KEYS[r.id]);
  const now = new Set(), past = new Map();
  const hook = (text, rel, place, isCurrent) => {
    if (!KEYISH.test(text)) return;
    const lines = text.split(/\r?\n/);
    for (const r of rules) for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      const m = r.re.exec(line);
      if (!m || (r.except && r.except.test(line)) || (r.test && !r.test(line, {}, lines, i))) continue;
      // a private key's BEGIN line is the same in every key: the line after it tells two keys apart
      const k = r.id + '|' + (r.id === 'SEC-001' ? line + (lines[i + 1] || '') : m[0]);
      if (isCurrent) { now.add(k); continue; }
      let e = past.get(k);
      if (!e) past.set(k, e = { r, places: [], wheres: [] });
      if (e.wheres.length < 5 && !e.wheres.some(w => w.startsWith(rel + ':'))) e.wheres.push(rel + ':' + (i + 1));
      e.places.push(place);
    }
  };
  const findings = () => [...past].filter(([k]) => !now.has(k)).map(([k, e]) => {
    const pushed = e.places.some(p => /already on the remote/.test(p));
    const sev = e.r.sev === 'Critical' ? (pushed ? 'Critical' : 'High') : e.r.sev === 'High' ? 'High' : 'Medium';
    return { rule: 'SEC-012', sev, area: 'secrets', where: 'git history: ' + e.wheres[0], ...(e.wheres.length > 1 ? { also: e.wheres.slice(1).map(w => 'git history: ' + w) } : {}),
      title: 'A ' + HISTORY_KEYS[e.r.id] + ' taken out of the files is still in the git history — ' + (pushed ? 'already on the remote' : e.places.some(p => /not pushed/.test(p)) ? 'not pushed yet' : 'only on this PC'),
      fix: pushed
        ? 'Rotate it now: anyone with a copy of the repository has it. Removing it from the files does not take it out of the history; only rewriting the history (git filter-repo) or a fresh repository does, and copies already made keep it.'
        : 'It has not left this PC yet. Rotate it, or rewrite the history before the first push (git filter-repo), or start a fresh repository from the current files.',
      fp: fingerprint(k) };
  });
  return { hook, findings };
}

async function runAudit(dir, url, opts = {}) {
  const started = Date.now();
  let ownHost = null; try { ownHost = opts.liveUrl ? new URL(opts.liveUrl).hostname : null; } catch {}
  // Old copies of the app inside the project (lib/roots.js): left out of the code rules, and out of the disclosure
  // pass unless git would publish them. opts.root === false scans everything; opts.include brings folders back.
  const roots = opts.root === false ? { left: [], app: null, notes: [] } : findRoots(dir, { include: opts.include });
  const skip = [...(opts.skip || []), ...roots.left.map(l => l.rel)];
  const code = codeAudit(dir, skip, { ownHost });
  code.notes.unshift(...roots.notes);
  // opts.disclosure: { details, others, own } (lib/disclosure.js). What publishing would give away about the maker.
  if (opts.disclosure) {
    const hs = historySecrets();
    const d = await disclosurePass(dir, { ...opts.disclosure, historyHook: hs.hook, skip: [...(opts.skip || []), ...roots.left.filter(l => !l.publishes).map(l => l.rel)] });
    code.findings.push(...d.findings, ...hs.findings());
    code.notes.push(...d.notes);
  }
  const local = url ? await localAudit(url, dir, { headersOnLive: !!opts.liveUrl }) : null;
  let cmp = null;
  if (opts.liveUrl) {
    cmp = await compareLive({ liveUrl: opts.liveUrl, localUrl: local && local.reached ? url : null, resolve: opts.resolve, gapMs: opts.gapMs, minGapMs: opts.minGapMs,
      projectHas: projectIndex(dir, skip), maxPages: opts.maxPages || 4, maxScripts: 2, httpPaths: privateAreas(dir), dnsTxt: opts.dnsTxt });
  }
  const all = [...code.findings, ...(local ? local.findings : []), ...(cmp ? cmp.findings : [])];
  const softened = await softenIgnored(dir, code.findings);
  if (softened) code.notes.push(softened + (softened === 1 ? ' fault is' : ' faults are') + ' in files git ignores, so they stay on this PC: shown as warnings, not "fix first".');
  for (const f of all) if (LOW_RULES.has(f.rule) && ORDER[f.sev] < ORDER.Low) f.sev = 'Low';
  all.sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);
  const j = applyJudged(all, opts.judged);
  const findings = j.findings;
  return {
    ranAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    url: url || null,
    liveUrl: opts.liveUrl || null,
    skipped: opts.skip || [],
    app: roots.app,          // the folder taken as the app when copies sit side by side (null: the project folder)
    copiesLeftOut: roots.left, // [{ rel, why, publishes }]
    liveReached: local ? local.reached : null,
    compare: cmp ? cmp.report : null,
    notes: [...(opts.notes || []), ...j.notes, ...code.notes, ...(local ? local.notes : []), ...(cmp ? cmp.notes : [])],
    rules: RULES.length + EXPOSED.length + CROSS_RULES.length + 2 + (opts.disclosure ? Object.keys(DISC_RULES).length + 1 : 0) + (url ? PROBES.length + 7 : 0) + (opts.liveUrl ? 30 : 0),
    filesScanned: code.filesScanned,
    disclosure: !!opts.disclosure, // the disclosure pass ran (private details, other projects' names, AI trail, local paths)
    filesTruncated: code.truncated,
    ...summarise(findings),
    findings,
    setAside: j.setAside,
  };
}

module.exports = { runAudit, fingerprint, summarise, mergeCopies, projectIndex, RULES, EXPOSED, PROBES, CROSS_RULES };
