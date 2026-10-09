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
const JS_HTML = /\.(m?js|cjs|tsx?|jsx|html?|php|vue)$/i;
const MARKUP = /\.(html?|php|vue|jsx|tsx|twig)$/i;
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
// Read once per project folder and kept for the rest of the run.
const schemeChecked = new Map();
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
function jsxUnknownTag(line, ctx) {
  for (const m of line.matchAll(/(?:^|[^\w$.<])<([A-Z][\w$]+)(?=[\s/>])/g)) {
    const name = m[1];
    if (/^\s*(extends|,)/.test(line.slice(m.index + m[0].length))) continue; // a type parameter, not a tag
    const all = (ctx.text.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    const tags = (ctx.text.match(new RegExp('</?' + name + '\\b', 'g')) || []).length;
    if (all === tags && !/^(React|Fragment)$/.test(name)) return true;
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
  for (let k = i - 1; k >= 0; k--) {
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
  return new RegExp('\\$' + v + '\\s*=\\s*[^;]*\\$_(GET|POST|REQUEST)\\b').test(ctx.text);
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
      return !!name && new RegExp('\\b(const|let|var)\\s+' + name.replace(/\$/g, '\\$') + '\\s*=[^;\\n]*(URLSearchParams|searchParams|location\\.(search|hash)|params\\.get)').test(ctx.text);
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
];

module.exports = { RULES_MORE, insideTry, insideScript, locationFromRequestVar };
