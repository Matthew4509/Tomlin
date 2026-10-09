// Live sites: the address a project is hosted at, whether it answers, and how its live pages compare with the local
// copy. Plain GETs only, one at a time; live pages in a compare are fetched at least 5 s apart, because a burst of
// requests can get this PC's own address blocked by the host's firewall.
// No packages: Node's http/https/zlib only.
'use strict';
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns');

const UA = 'TOMLIN/1 (site check)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCAL_HOST = /^(localhost|.*\.localhost|.*\.local|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;
// An address a name resolved to that is this PC, the home network or a cloud's own internal address: a public-looking
// name (127.0.0.1.nip.io, localtest.me, or a domain someone points at 192.168.x) must not aim the Bridge there.
function isPrivateIp(a) {
  a = String(a || '').toLowerCase().replace(/^::ffff:/, '');
  if (/^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true;
  return a === '::' || a === '::1' || /^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(a);
}
// dns.lookup for live requests: refuses a name whose address is private (checked when the connection is made, so a
// name that changes its answer between two looks is caught too).
function publicLookup(host, opts, cb) {
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    const bad = list.find(x => isPrivateIp(x.address));
    if (bad) return cb(Object.assign(new Error(host + ' points at a local or private address (' + bad.address + '), which the Bridge does not check'), { code: 'BLOCKED' }));
    if (opts && opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

// ---------- the address ----------
// "example.com" becomes https://example.com/. An address on this PC or the home network is not a hosted site
// (unless opts.allowLocal, for tests); the local copy has its own button.
function parseLiveUrl(text, opts = {}) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return { url: '' };
  if (t.length > 500) return { error: 'That address is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'https://' + t;
  let u;
  try { u = new URL(t); } catch { return { error: '"' + String(text).trim() + '" is not a web address. Type it like example.com or https://www.example.com/.' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Only http:// and https:// addresses can be checked.' };
  if (u.username || u.password) return { error: 'Leave the user name and password out of the address: the Bridge only opens the public page.' };
  if (!opts.allowLocal) {
    if (LOCAL_HOST.test(u.hostname)) return { error: u.hostname + ' is this PC or your own network, not a hosted site. The local copy is started with Run local copy.' };
    if (!u.hostname.includes('.')) return { error: '"' + u.hostname + '" is not a full domain name. Type it like example.com.' };
  }
  u.hash = '';
  return { url: u.href };
}

// ---------- one GET ----------
// o.resolve(u) -> { host, port } sends the request to another place (the demo's made-up sites, tests) while the
// page still thinks it is at u. Returns { status, headers, body, ms, cert, error }. Bodies over maxBytes are cut.
function requestOnce(url, o = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: { code: 'BADURL', message: 'not a web address' } }); }
    const t0 = Date.now();
    const target = o.resolve ? o.resolve(u) : null;
    let lib = u.protocol === 'https:' ? https : http;
    const opts = { method: 'GET', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search,
      agent: false, timeout: o.timeout || 10000, servername: u.hostname,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', Connection: 'close' } };
    if (target) { lib = http; opts.hostname = target.host; opts.port = target.port; opts.headers.Host = u.host; delete opts.servername; }
    else if (!o.allowLocal && !LOCAL_HOST.test(u.hostname)) opts.lookup = publicLookup;
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve({ ms: Date.now() - t0, ...v }); } };
    const req = lib.request(opts, res => {
      let cert = null;
      try {
        const c = res.socket && res.socket.getPeerCertificate && res.socket.getPeerCertificate();
        if (c && c.valid_to) cert = { validTo: new Date(c.valid_to).toISOString(), days: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400000), issuer: c.issuer && (c.issuer.O || c.issuer.CN) || '' };
      } catch {}
      const max = o.maxBytes || 400000;
      const chunks = []; let n = 0, cut = false;
      const finish = () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        // Cap the decompressed size: ~400 KB of gzip/brotli can expand to gigabytes (a "zip bomb") and OOM the
        // Bridge. zlib throws ERR_BUFFER_TOO_LARGE past the cap; the catch then leaves the body compressed (judged
        // as an unreadable page, never crashing the process).
        const maxOut = o.maxDecoded || 8 * 1024 * 1024;
        try {
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: maxOut });
          else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH, maxOutputLength: maxOut });
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: maxOut });
        } catch {}
        done({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), cert, cut });
      };
      res.on('data', c => { if (n < max) { chunks.push(c); n += c.length; } else if (!cut) { cut = true; finish(); res.destroy(); } });
      res.on('end', finish);
      res.on('error', () => finish());
      res.on('close', () => finish());
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })); });
    req.on('error', e => done({ error: { code: e.code || 'ERROR', message: e.message } }));
    req.end();
  });
}

// GET with redirects followed (up to 6), like a browser. Returns the last answer plus the chain it took.
async function get(url, o = {}) {
  const chain = [];
  let cur = url, r = null;
  for (let i = 0; i < 7; i++) {
    r = await requestOnce(cur, o);
    chain.push({ url: cur, status: r.status || null });
    if (r.error || !(r.status >= 300 && r.status < 400 && r.headers.location) || o.follow === false) break;
    let next; try { next = new URL(r.headers.location, cur).href; } catch { break; }
    // Do not follow a redirect to this PC or the private network (SSRF): a hosted site must not steer the Bridge at
    // 127.0.0.1, a LAN device or a cloud metadata address. The demo/tests use o.resolve, which keeps traffic local
    // on purpose, so the guard is skipped there (and when opts.allowLocal is set).
    if (!o.allowLocal && !o.resolve) {
      let nh = ''; try { nh = new URL(next).hostname; } catch {}
      if (isLocalHost(nh)) return { error: { code: 'BLOCKED', message: 'it redirects to a local or private address (' + nh + '), which the Bridge does not follow' }, chain, finalUrl: next };
    }
    if (chain.some(c => c.url === next)) return { ...r, chain, finalUrl: next, loop: true };
    cur = next;
    if (i === 6) return { ...r, chain, finalUrl: cur, loop: true };
  }
  return { ...r, chain, finalUrl: cur };
}

// ---------- what a page is, when it is not the site ----------
const titleOf = body => { const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(body || ''); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
const SUSPENDED = /account (has been )?suspended|this account has been suspended|website (is|has been) suspended|site (is|has been) suspended|bandwidth limit exceeded/i;
const PARKED = /domain (is )?(for sale|parked)|this domain (name )?(has expired|is available|may be for sale)|buy this domain|domain has expired|parkingcrew|sedoparking|bodis\.com|afternic/i;
const DEFAULT_PAGE = /^(Apache2? (Ubuntu |Debian )?Default Page|Welcome to nginx!?|IIS Windows Server|Default Web Site Page|Index of \/|Test Page for the (Apache|Nginx) HTTP Server|Web Server's Default Page|cPanel Default|Future home of)/i;
const FIREWALL_TITLE = /Unauthorized Access|Access Denied|Request Rejected|Attention Required|Just a moment|Checking your browser|DDoS[- ]Guard|Security check|Sucuri WebSite Firewall|Imunify360|Blocked|Forbidden|Captcha|Human Verification|Not Acceptable/i;
const FIREWALL_BODY = /cf-chl-|challenge-platform|Imunify360|Sucuri WebSite Firewall|bot protection|has been blocked|your (IP|access) (address )?(has been|is) blocked/i;

// Is this answer a firewall/challenge page rather than the site? (Used to stop a compare before it reads fiction.)
function looksBlocked(r) {
  if (!r || r.error) return false;
  if (r.status === 429) return true;
  const t = titleOf(r.body);
  if (FIREWALL_TITLE.test(t) && (r.status >= 400 || (r.body || '').length < 30000)) return true;
  return r.status >= 400 && FIREWALL_BODY.test((r.body || '').slice(0, 20000));
}

const NAMES = { 500: 'server error', 501: 'not implemented', 502: 'bad gateway', 503: 'service unavailable', 504: 'gateway timeout', 508: 'resource limit reached', 520: 'unknown error (Cloudflare)', 521: 'web server is down (Cloudflare)', 522: 'connection timed out (Cloudflare)', 523: 'origin unreachable (Cloudflare)', 524: 'timeout (Cloudflare)', 525: 'SSL handshake failed (Cloudflare)', 526: 'invalid SSL certificate (Cloudflare)' };
const bareHost = h => String(h || '').toLowerCase().replace(/^www\./, '');

// ---------- the light ----------
// up = green, unsure = amber, down = red. `net` marks a failure before any answer (for the "PC offline" check).
function judge(url, r, o = {}) {
  const host = new URL(url).hostname;
  const secs = r.ms != null ? (r.ms / 1000).toFixed(1) + ' s' : '';
  const base = { status: r.status || null, ms: r.ms || null, finalUrl: r.finalUrl || url, certDays: r.cert ? r.cert.days : null, certTo: r.cert ? r.cert.validTo : null };
  const out = (state, reason, extra) => ({ ...base, state, reason, ...extra });
  if (r.error) {
    const c = r.error.code;
    if (c === 'BLOCKED') return out('unsure', 'Up, but ' + r.error.message + '.');
    if (c === 'ENOTFOUND') return out('down', 'The name ' + host + ' was not found (DNS). The domain may have expired, or its DNS records changed.', { net: true });
    if (c === 'EAI_AGAIN') return out('unsure', 'Could not look up ' + host + ': this PC may be offline, or its DNS is not answering.', { net: true });
    if (c === 'ECONNREFUSED') return out('down', 'The server refused the connection: nothing is serving the site.', { net: true });
    if (c === 'TIMEOUT' || c === 'ETIMEDOUT') return out('down', 'No answer within ' + Math.round((o.timeout || 10000) / 1000) + ' seconds (asked twice).', { net: true });
    if (c === 'ECONNRESET' || c === 'EPIPE') return out('down', 'The connection was cut before the page arrived (asked twice).', { net: true });
    if (c === 'CERT_HAS_EXPIRED') return out('down', 'Its security certificate has expired: visitors see a warning page instead of the site.');
    if (c === 'ERR_TLS_CERT_ALTNAME_INVALID' || c === 'HOSTNAME_MISMATCH') return out('down', 'Its security certificate is for a different name, so visitors see a warning page.');
    if (/SELF_SIGNED/.test(c)) return out('down', 'It uses a self-signed certificate: visitors see a warning page.');
    if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/.test(c)) return out('unsure', 'Its certificate could not be checked from this PC: the server may be missing an intermediate certificate (some phones and apps then refuse it), or antivirus/a proxy is inspecting secure traffic. Browsers may still open it.');
    return out('down', 'Could not reach it: ' + r.error.message + '.', { net: true });
  }
  if (r.loop) return out('down', 'It redirects in a loop, so browsers give up ("too many redirects").');
  const s = r.status;
  if (s >= 500) return out('down', 'The server answered ' + s + (NAMES[s] ? ' (' + NAMES[s] + ')' : '') + '.');
  if (s === 404 || s === 410) return out('down', 'The home page answers ' + s + ' (not found): the site\'s files may be missing.');
  if (s === 401) return out('unsure', 'It asks for a password (401). Up, but visitors cannot see it without signing in.');
  if (s === 429) return out('unsure', 'The server said "too many requests" (429). Try again later.');
  if (s === 403) return out('unsure', 'The server refused (403)' + (looksBlocked(r) ? ' with a firewall page' : '') + '. If it opens fine elsewhere, the host\'s firewall may have blocked this PC\'s address: ask the host to unblock it.');
  if (s >= 400) return out('unsure', 'The server answered ' + s + '.');
  if (s >= 300) return out('unsure', 'It answered a redirect (' + s + ') with nowhere to go.');
  const body = r.body || '', title = titleOf(body), head = body.slice(0, 50000);
  if (SUSPENDED.test(title) || SUSPENDED.test(head.slice(0, 8000))) return out('down', 'The host shows an "account suspended" page instead of the site.');
  if (PARKED.test(title) || (body.length < 60000 && PARKED.test(head))) return out('down', 'It shows a parked or for-sale page: the domain may have expired or moved.');
  if (looksBlocked(r)) return out('unsure', 'It answered with a security check or firewall page ("' + title.slice(0, 60) + '"), not the site.');
  if (DEFAULT_PAGE.test(title)) return out('unsure', 'It shows a default server page ("' + title.slice(0, 60) + '"), not the site: the files may not be uploaded.');
  const fin = new URL(r.finalUrl || url);
  if (bareHost(fin.hostname) !== bareHost(host)) return out('unsure', 'It sends visitors on to ' + fin.hostname + '.');
  if (new URL(url).protocol === 'https:' && fin.protocol === 'http:') return out('unsure', 'It moves visitors from https to plain http: browsers mark it "Not secure".');
  if (fin.protocol === 'http:') return out('unsure', 'It is on plain http, so browsers mark it "Not secure". Add a certificate and use https.');
  if (r.cert && r.cert.days < 14) return out('unsure', 'Up, but its security certificate expires in ' + Math.max(0, r.cert.days) + ' day' + (r.cert.days === 1 ? '' : 's') + '.');
  if (r.ms > (o.slowMs || 6000)) return out('unsure', 'Up, but slow: the page took ' + secs + '.');
  if (r.retried) return out('unsure', 'Up, but it only answered when asked a second time.');
  return out('up', 'Up: answered ' + s + ' in ' + secs + (r.cert ? '; certificate good for ' + r.cert.days + ' days' : '') + '.');
}

// One site: one GET (redirects followed); a timeout or cut connection is asked once more, 5 s later.
async function checkSite(url, o = {}) {
  const at = new Date().toISOString();
  let r = await get(url, o);
  if (r.error && /^(TIMEOUT|ETIMEDOUT|ECONNRESET|EPIPE)$/.test(r.error.code)) {
    await sleep(o.retryMs == null ? 5000 : o.retryMs);
    const again = await get(url, o);
    r = again.error ? again : { ...again, retried: true };
  }
  return { url, at, ...judge(url, r, o) };
}

// ---------- reading a page ----------
function attrsOf(s) {
  const a = {};
  const re = /([^\s=/>"']+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))|([^\s=/>"']+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) a[m[1].toLowerCase()] = (m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] || '').replace(/&amp;/g, '&');
    else if (m[6]) a[m[6].toLowerCase()] = '';
  }
  return a;
}
// Parts of the page a visitor cannot see: an element hidden by its own style (display:none, off-screen, zero size,
// zero font, invisible). SEO-spam injections hide their links this way.
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|(left|top|text-indent)\s*:\s*-\d{3,}\s*(px|em)|font-size\s*:\s*0(?![.\d])|(height|width)\s*:\s*[01]px[^;]*;?[^"']*overflow\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/i;
function hiddenRanges(html) {
  const out = [];
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const a = attrsOf(m[2]);
    if (!('hidden' in a || (a.style && HIDDEN_STYLE.test(a.style)))) continue;
    if (/^(input|img|br|hr|meta|link|script|style|template|noscript|svg|path|dialog)$/.test(tag)) continue;
    // find the matching close tag, counting nested ones of the same name
    const open = new RegExp('<' + tag + '\\b|</' + tag + '\\s*>', 'gi');
    open.lastIndex = re.lastIndex;
    let depth = 1, end = html.length, x;
    while ((x = open.exec(html))) { if (x[0][1] === '/') { if (--depth === 0) { end = x.index; break; } } else depth++; }
    out.push([m.index, end]);
  }
  return out;
}

// Every reference a page makes: { host|null (null = same site), url, kind, active, hidden, tag, at }.
// active = something the browser loads or runs (script, frame, form target, redirect, stylesheet); passive = a link or picture.
const DATA_SCRIPT = /^(application\/(ld\+)?json|application\/json|text\/template|text\/x-template|text\/html|importmap|speculationrules)$/i;
function pageRefs(html, pageUrl) {
  html = String(html || '');
  const refs = [];
  const hidden = hiddenRanges(html);
  const inHidden = i => hidden.some(([a, b]) => i >= a && i < b);
  const add = (raw, kind, active, at, tag, extraHidden) => {
    raw = String(raw || '').trim();
    if (!raw || /^(#|javascript:|mailto:|tel:|data:|blob:|about:|sms:|whatsapp:|geo:)/i.test(raw)) return;
    let u; try { u = new URL(raw, pageUrl); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    refs.push({ url: u.href, host: u.hostname.toLowerCase(), protocol: u.protocol, kind, active, tag, at, hidden: !!extraHidden || inHidden(at) });
  };
  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase(), a = attrsOf(m[2]), at = m.index;
    const selfHidden = a.style && HIDDEN_STYLE.test(a.style);
    if (tag === 'script' && a.src != null) add(a.src, 'script', true, at, tag);
    else if ((tag === 'iframe' || tag === 'frame') && a.src) add(a.src, 'frame', true, at, tag, selfHidden);
    else if (tag === 'embed' && a.src) add(a.src, 'embed', true, at, tag);
    else if (tag === 'object' && a.data) add(a.data, 'object', true, at, tag);
    else if (tag === 'form' && a.action) add(a.action, 'form', true, at, tag);
    else if (tag === 'base' && a.href) add(a.href, 'base', true, at, tag);
    else if (tag === 'meta' && /refresh/i.test(a['http-equiv'] || '')) { const u = /url\s*=\s*['"]?([^'";]+)/i.exec(a.content || ''); if (u) add(u[1], 'redirect', true, at, tag); }
    else if (tag === 'link' && a.href) {
      const rel = (a.rel || '').toLowerCase();
      if (/stylesheet/.test(rel)) add(a.href, 'stylesheet', true, at, tag);
      else if (/modulepreload|preload|prefetch/.test(rel) && /^(script|style)$/i.test(a.as || 'script')) add(a.href, 'preload', true, at, tag);
      else if (/icon|manifest|canonical|alternate|preconnect|dns-prefetch|preload|prefetch|me|author|license|search/.test(rel)) add(a.href, 'hint', false, at, tag);
      else add(a.href, 'link', false, at, tag);
    }
    else if ((tag === 'a' || tag === 'area') && a.href) add(a.href, 'link', false, at, tag, selfHidden);
    else if (/^(img|source|video|audio|track|input)$/.test(tag) && (a.src || a.srcset)) add(a.src || String(a.srcset).trim().split(/\s+/)[0], 'image', false, at, tag, selfHidden);
  }
  // Inline scripts: outside addresses written in them, and whether they load code (then the address is active).
  for (const s of inlineScripts(html)) {
    const loads = /createElement\s*\(\s*['"](script|iframe)|\.src\s*=|document\.write|(window\.)?location(\.href)?\s*=|location\.(replace|assign)\s*\(|import\s*\(|importScripts|new\s+Worker/i.test(s.text);
    // https://host, or //host right after a quote (never a // comment)
    for (const u of s.text.matchAll(/(?:https?:\/\/|(?<=["'`(])\/\/)((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?=[/"'`?\s)\\:;,]|$)/gi)) {
      const raw = /^\/\//.test(u[0]) ? 'https:' + u[0] : u[0];
      add(raw, 'inline-script', loads, s.at, 'script');
    }
  }
  return refs;
}
function inlineScripts(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const a = attrsOf(m[1]);
    if (a.src != null || DATA_SCRIPT.test(a.type || '')) continue;
    if (m[2].trim()) out.push({ text: m[2], at: m.index });
  }
  return out;
}
// Signs of code written to hide what it does (common in injected scripts; rare in a project's own inline code).
const OBFUSCATED = /\beval\s*\(|\batob\s*\(|String\.fromCharCode\s*\(|\bunescape\s*\(|document\.write\s*\(\s*(unescape|atob|String\.fromCharCode)|(\\x[0-9a-f]{2}){8,}|(\\u00[0-9a-f]{2}){8,}|\b_0x[0-9a-f]{4,}\b|[A-Za-z0-9+/]{400,}={0,2}/i;
const normScript = t => String(t).replace(/\s+/g, '').replace(/\d+/g, '0').replace(/(["'])[A-Za-z0-9+/=_-]{16,}\1/g, '""');
const sha = t => crypto.createHash('sha1').update(t).digest('hex').slice(0, 12);

// Hosting services that give every customer a sub-domain of their own: alice.github.io and bob.github.io are two
// different people's sites, so the site there is three labels long, never the service's own domain.
const SHARED_HOSTS = /\.(github\.io|gitlab\.io|netlify\.app|netlify\.com|pages\.dev|workers\.dev|vercel\.app|now\.sh|herokuapp\.com|web\.app|firebaseapp\.com|azurewebsites\.net|azurestaticapps\.net|onrender\.com|fly\.dev|glitch\.me|surge\.sh|repl\.co|replit\.app|wixsite\.com|wordpress\.com|blogspot\.com|neocities\.org|cloudfront\.net|amplifyapp\.com|r2\.dev|ngrok\.io|ngrok-free\.app|trycloudflare\.com)$/i;
// Same site: the live host, its www twin, and any sub-domain of the same domain (cdn.example.com for example.com).
function siteOf(host) {
  const parts = bareHost(host).split('.');
  const shared = SHARED_HOSTS.exec('.' + parts.join('.'));
  if (shared) { const n = shared[1].split('.').length + 1; return parts.slice(-n).join('.'); }
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  // example.com.au, example.co.uk: the domain is three labels long
  return /^(com|net|org|co|gov|edu|ac|id|asn|nsw|vic|qld|sa|wa|tas|nt|act|ltd|plc|me|or|ne|go)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
}
// A local or private address is never "the site itself" (it is this PC or the network the page was viewed from).
const isOwn = (host, liveHost) => host === liveHost || (!LOCAL_HOST.test(host) && (bareHost(host) === bareHost(liveHost) || siteOf(host) === siteOf(liveHost)));

// Hosts that the hosting company or its proxy adds to every page by itself (not the project, not an attacker).
const HOST_ADDED = /^(static\.cloudflareinsights\.com|ajax\.cloudflare\.com)$/i;
// Links every site may carry without its code naming them one by one (shared buttons, the page's own validator...).
const HOST_ALWAYS = /^(www\.w3\.org|schema\.org|ogp\.me|purl\.org|xmlns\.com)$/i;

// ---------- header checks on a page answer (live or localhost) ----------
function headerFindings(r, where, o = {}) {
  const f = [];
  const h = r.headers || {};
  const add = (rule, sev, title, fix) => f.push({ rule, sev, area: 'headers', title, where, fix });
  const csp = String(h['content-security-policy'] || '').trim();
  if (!csp) add('LIVE-001', 'Medium', 'No Content-Security-Policy header', 'Send a CSP; start with default-src \'self\'.');
  else if (!/(^|;)\s*(default-src|script-src)\b/i.test(csp)) add('LIVE-008', 'Medium', 'The CSP header is there but limits no scripts (no default-src or script-src)', 'Add default-src \'self\' (and script-src for any outside scripts) to the header; a policy with only frame-ancestors stops framing, nothing else.');
  else if (/unsafe-eval/.test(csp)) add('LIVE-002', 'Medium', 'CSP allows unsafe-eval', 'Remove unsafe-eval.');
  if (!/nosniff/i.test(h['x-content-type-options'] || '')) add('LIVE-003', 'Medium', 'No X-Content-Type-Options: nosniff', 'Add the header.');
  if (!h['x-frame-options'] && !/frame-ancestors/.test(csp)) add('LIVE-004', 'Medium', 'Page can be framed by other sites', 'Add frame-ancestors \'self\' to the CSP or X-Frame-Options: SAMEORIGIN.');
  if (/PHP\/\d|Apache\/\d|nginx\/\d|LiteSpeed\/\d|Microsoft-IIS\/\d/i.test(String(h['x-powered-by'] || '') + ' ' + String(h['server'] || ''))) add('LIVE-005', 'Medium', 'Server announces its software version', 'Hide X-Powered-By and the server version.');
  const cookies = [].concat(h['set-cookie'] || []);
  for (const c of cookies) {
    if (/sess|auth|token|login|remember/i.test(c.split('=')[0]) && !/httponly/i.test(c)) { add('LIVE-006', 'High', 'Sign-in cookie readable by page scripts (no HttpOnly)', 'Set HttpOnly (and SameSite=Lax) on the session cookie.'); break; }
  }
  if (o.https) {
    if (!/max-age\s*=\s*[1-9]/i.test(h['strict-transport-security'] || '')) add('LIVE-020', 'Medium', 'No Strict-Transport-Security (HSTS) header', 'Send Strict-Transport-Security: max-age=31536000 once the whole site is on https.');
    for (const c of cookies) {
      if (/sess|auth|token|login|remember/i.test(c.split('=')[0]) && !/;\s*secure/i.test(c)) { add('LIVE-022', 'Medium', 'Sign-in cookie can travel over plain http (no Secure flag)', 'Add the Secure flag to the session cookie.'); break; }
    }
  }
  if (/<title>\s*Index of \//i.test(r.body || '')) add('LIVE-007', 'Medium', 'Folder listing is switched on', 'Turn off directory listing.');
  return f;
}

// Files that must never be fetchable. `looks` must match the body, so a "not found" page that answers 200 never counts.
const LIVE_PROBES = [
  { path: '/.env', id: 'LIVE-010', sev: 'Critical', title: '.env is downloadable', looks: /^\s*[A-Z][A-Z0-9_]*\s*=/m, notHtml: true },
  { path: '/.git/HEAD', id: 'LIVE-011', sev: 'High', title: '.git folder is downloadable (the whole source can be rebuilt from it)', looks: /^ref: refs\//, notHtml: true },
  { path: '/error_log', id: 'LIVE-016', sev: 'Medium', title: 'PHP error log is downloadable (shows paths and code)', looks: /PHP (Warning|Fatal error|Notice|Parse error|Deprecated)|Stack trace:/, notHtml: true },
  { path: '/package.json', id: 'LIVE-018', sev: 'Medium', title: 'package.json is downloadable from the live site (lists the versions to attack)', looks: /"(dependencies|devDependencies)"\s*:/, notHtml: true },
  { path: '/composer.json', id: 'LIVE-018', sev: 'Medium', title: 'composer.json is downloadable from the live site (lists the versions to attack)', looks: /"require"\s*:/, notHtml: true },
];

// Library versions with known holes, read from a served file's banner ("/*! axios v0.21.1 ..."). [name, banner
// pattern (version in group 1), fixed in, why]. Only a version below the fix is reported.
const OLD_LIBS = [
  ['axios', /\baxios\s+v?(\d+\.\d+\.\d+)/i, '1.7.4', 'server-side request forgery (CVE-2024-39338)'],
  ['jQuery', /\bjQuery\s+(?:JavaScript Library\s+)?v?(\d+\.\d+\.\d+)/i, '3.5.0', 'cross-site scripting in htmlPrefilter (CVE-2020-11022)'],
  ['lodash', /\blodash\s+(?:<https?:[^>]*>\s*)?(?:\(Custom Build\)\s*)?v?(\d+\.\d+\.\d+)|\blodash\b[^\n]{0,40}\bVERSION\s*=\s*['"](\d+\.\d+\.\d+)/i, '4.17.21', 'command injection in template (CVE-2021-23337)'],
  ['Moment.js', /\bmoment(?:\.js)?\s*(?:\|\s*)?v?(?:ersion\s*:?\s*)?(\d+\.\d+\.\d+)/i, '2.29.4', 'slow-regex denial of service (CVE-2022-31129)'],
  ['Bootstrap', /\bBootstrap\s+v(3\.\d+\.\d+)/i, '3.4.1', 'cross-site scripting in tooltips (CVE-2019-8331)'],
  ['Bootstrap', /\bBootstrap\s+v(4\.\d+\.\d+)/i, '4.3.1', 'cross-site scripting in tooltips (CVE-2019-8331)'],
];
const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
function oldLibraries(body) {
  const out = [];
  const head = String(body || '').slice(0, 4000);
  for (const [name, re, fixed, why] of OLD_LIBS) {
    const m = re.exec(head);
    const v = m && (m[1] || m[2]);
    if (v && older(v, fixed)) out.push({ name, version: v, fixed, why });
  }
  return out;
}
// The registrable part of a host, for DNS records that sit on the domain (www.shop.example -> shop.example).
const domainOf = host => siteOf(host);

// ---------- live vs local ----------
// Fetches the live home page and a few pages linked from it (at most maxPages, gapMs apart, same site only), and
// the same pages from the local copy when it runs. Anything outside the site that the LIVE page loads or links to,
// which the local page does not have and no project file names, is reported: that is what an injection looks like.
// o: { liveUrl, localUrl, resolve, gapMs, maxPages, maxScripts, projectHas(host|text) -> file or null, probes }
async function compareLive(o) {
  const findings = [], notes = [];
  const gap = Math.max(o.minGapMs == null ? 5000 : o.minGapMs, o.gapMs == null ? 5000 : o.gapMs);
  const liveUrl = new URL(o.liveUrl);
  const liveHost = liveUrl.hostname.toLowerCase();
  const https = liveUrl.protocol === 'https:';
  const report = { ran: true, liveUrl: liveUrl.href, localUrl: o.localUrl || null, pages: [], requests: 0, stopped: null, gapSeconds: gap / 1000 };
  let last = 0;
  const liveGet = async (url, extra) => {
    const wait = last + gap - Date.now();
    if (last && wait > 0) await sleep(wait);
    const r = await get(url, { resolve: o.resolve, timeout: 15000, ...extra });
    last = Date.now();
    report.requests += r.chain ? r.chain.length : 1;
    return r;
  };
  const localGet = url => get(url, { timeout: 8000 });
  const stop = (why) => { report.stopped = why; notes.push('Live compare stopped: ' + why); return { findings, notes, report }; };

  const home = await liveGet(liveUrl.href);
  if (home.error) return stop(liveUrl.href + ' did not answer (' + home.error.message + ').');
  if (looksBlocked(home)) return stop(liveUrl.href + ' answered with a firewall or security-check page, so nothing was compared. If the site opens in your browser, the host may be blocking this PC.');
  if (!(home.status >= 200 && home.status < 300)) return stop(liveUrl.href + ' answered ' + home.status + '.');
  if (home.cert && home.cert.days < 14) findings.push({ rule: 'LIVE-024', sev: 'Medium', area: 'live site', title: 'Security certificate expires in ' + Math.max(0, home.cert.days) + ' days', where: liveUrl.href, fix: 'Renew it (most hosts renew automatically: check AutoSSL / Let\'s Encrypt is on).' });
  for (const f of headerFindings(home, liveUrl.href, { https })) findings.push({ ...f, area: 'live headers' });

  const localBase = o.localUrl ? new URL(o.localUrl) : null;
  const localHome = localBase ? await localGet(localBase.href) : null;
  const localOk = r => r && !r.error && r.status >= 200 && r.status < 300 && /html/i.test(String(r.headers['content-type'] || 'text/html'));
  if (localBase && !localOk(localHome)) notes.push('The local copy (' + localBase.href + ') did not give a page, so the live pages were checked against the project\'s files only.');

  // Pages: the home page, then same-site links from the local home page (or the live one without a local copy).
  const source = localOk(localHome) ? { html: localHome.body, url: localBase.href } : { html: home.body, url: home.finalUrl || liveUrl.href };
  const paths = [];
  for (const r of pageRefs(source.html, source.url)) {
    if (r.kind !== 'link' || r.hidden) continue;
    const u = new URL(r.url);
    if (!(localBase && u.host === localBase.host) && !isOwn(u.hostname, liveHost)) continue;
    if (u.search || /\/(log-?out|sign-?out|delete|remove|unsubscribe|cart|checkout|wp-admin|admin|api)\b/i.test(u.pathname)) continue;
    if (/\.[a-z0-9]{2,5}$/i.test(u.pathname) && !/\.(html?|php)$/i.test(u.pathname)) continue;
    if (u.pathname === '/' || paths.includes(u.pathname)) continue;
    paths.push(u.pathname);
  }
  const pageList = [{ path: liveUrl.pathname || '/', live: home, local: localOk(localHome) ? localHome : null }];
  for (const p of paths.slice(0, Math.max(0, (o.maxPages || 4) - 1))) pageList.push({ path: p });

  const seenHosts = new Map(); // host -> finding already made (one finding per host)
  const scriptPairs = [];
  for (const pg of pageList) {
    const lu = new URL(pg.path, liveUrl).href;
    if (!pg.live) {
      pg.live = await liveGet(lu);
      if (looksBlocked(pg.live)) return stop(lu + ' answered with a firewall or security-check page; nothing after it was fetched.');
      if (localBase) { const r = await localGet(new URL(pg.path, localBase).href); pg.local = localOk(r) ? r : null; }
    }
    const lv = pg.live;
    if (pg.path !== pageList[0].path && !lv.error && lv.status >= 200 && lv.status < 300) {
      // a server layer can send different headers per folder: judge each page, report each rule once
      for (const f of headerFindings(lv, lu, { https })) if (!findings.some(x => x.rule === f.rule)) findings.push({ ...f, area: 'live headers' });
    }
    report.pages.push({ path: pg.path, live: lv.error ? 'no answer' : lv.status, local: localBase ? (pg.local ? pg.local.status : 'no page') : null });
    if (lv.error || !(lv.status >= 200 && lv.status < 300)) { notes.push(lu + ': ' + (lv.error ? 'no answer' : 'answered ' + lv.status) + ', not compared.'); continue; }
    if (localBase && !pg.local) notes.push(pg.path + ' is on the live site but the local copy gave no page for it; checked against the project\'s files only.');
    const liveRefs = pageRefs(lv.body, lv.finalUrl || lu);
    const localRefs = pg.local ? pageRefs(pg.local.body, new URL(pg.path, localBase).href) : [];
    const localHosts = new Set(localRefs.map(r => r.host));
    const localText = pg.local ? pg.local.body.toLowerCase() : '';

    // Mixed content: an https page pulling http:// files.
    if (https) {
      const mixed = liveRefs.find(r => r.protocol === 'http:' && (r.active || r.kind === 'image') && r.kind !== 'inline-script');
      if (mixed && !seenHosts.has('mixed')) { seenHosts.set('mixed', 1); findings.push({ rule: 'LIVE-023', sev: 'Medium', area: 'live site', title: 'Secure page loads a file over plain http (' + mixed.kind + ')', where: lu + ' → ' + mixed.url.slice(0, 120), fix: 'Change the address to https://; browsers block or warn about it.' }); }
    }

    for (const r of liveRefs) {
      if (isOwn(r.host, liveHost) || HOST_ALWAYS.test(r.host)) continue;
      if (seenHosts.has(r.host)) continue;
      if (localHosts.has(r.host) || localText.includes(r.host)) continue; // the local copy has it too
      if (HOST_ADDED.test(r.host)) { seenHosts.set(r.host, 1); notes.push(r.host + ' is on the live pages only; hosting companies add it themselves (Cloudflare), so it is not counted.'); continue; }
      const named = o.projectHas ? o.projectHas(r.host) : null;
      if (named) { seenHosts.set(r.host, 1); notes.push(r.host + ' (' + r.kind + ') is on the live page but not the local one; the project names it in ' + named + ', so it is taken as a live-only setting.'); continue; }
      seenHosts.set(r.host, 1);
      const against = pg.local ? 'the local copy of this page does not have it, and no project file names it' : 'no project file names it';
      const what = { script: 'loads a script from', frame: 'shows a frame from', embed: 'embeds', object: 'embeds', form: 'sends a form to', base: 'sets every link to point at', redirect: 'redirects visitors to', stylesheet: 'loads a stylesheet from', preload: 'preloads code from', 'inline-script': r.active ? 'has an inline script that loads from' : 'has an inline script naming', link: 'links to', image: 'shows a picture from', hint: 'points at' }[r.kind] || 'refers to';
      const fp = sha(r.host);
      if (r.active) findings.push({ rule: 'CMP-001', sev: 'High', area: 'live vs local', title: 'Live page ' + what + ' ' + r.host + ': ' + against, where: lu, fp, evidence: r.url.slice(0, 200), fix: 'If you did not add this, the live site may have been changed by someone else: compare the live files with yours, restore them, and change the hosting/FTP passwords.' });
      else if (r.hidden) findings.push({ rule: 'CMP-002', sev: 'High', area: 'live vs local', title: 'Hidden link on the live page to ' + r.host + ': ' + against, where: lu, fp, evidence: r.url.slice(0, 200), fix: 'Hidden links to other sites are a sign of an SEO-spam injection. Compare the live files and database with yours and restore them.' });
      else findings.push({ rule: 'CMP-003', sev: 'Medium', area: 'live vs local', title: 'Live page ' + what + ' ' + r.host + ': ' + against, where: lu, fp, evidence: r.url.slice(0, 200), fix: 'Content you added on the live site (a blog post, a listing) explains this; otherwise the page was changed by someone else.' });
    }

    // Inline scripts written to hide what they do, on live only.
    const localNorm = new Set(pg.local ? inlineScripts(pg.local.body).map(s => normScript(s.text)) : []);
    for (const s of inlineScripts(lv.body)) {
      const m = OBFUSCATED.exec(s.text);
      if (!m || seenHosts.has('obf')) continue;
      if (localNorm.has(normScript(s.text))) continue;
      const bit = s.text.trim().slice(0, 60);
      if (!pg.local && o.projectHas && o.projectHas(bit.slice(0, 40))) continue;
      seenHosts.set('obf', 1);
      findings.push({ rule: 'CMP-004', sev: pg.local ? 'High' : 'Medium', area: 'live vs local', title: 'Inline script on the live page is written to hide what it does (' + m[0].slice(0, 24) + '), and ' + (pg.local ? 'the local copy does not have it' : 'no project file has it'), where: lu, fp: sha(normScript(s.text)), evidence: bit, fix: 'If you did not write it, remove it from the live files and look for how it got there (change hosting/FTP passwords).' });
    }

    // Same-site script files that both copies use: compare what they contain.
    if (pg.local) {
      const localSrc = new Set(localRefs.filter(r => r.kind === 'script').map(r => new URL(r.url).pathname));
      for (const r of liveRefs) {
        if (r.kind !== 'script' || !isOwn(r.host, liveHost)) continue;
        const p = new URL(r.url).pathname;
        if (localSrc.has(p) && !scriptPairs.some(x => x.path === p)) scriptPairs.push({ path: p, liveUrl: r.url, localUrl: new URL(p, localBase).href });
      }
    }
  }

  for (const sp of scriptPairs.slice(0, o.maxScripts == null ? 2 : o.maxScripts)) {
    const lv = await liveGet(sp.liveUrl);
    if (looksBlocked(lv)) return stop(sp.liveUrl + ' answered with a firewall or security-check page.');
    const lc = await localGet(sp.localUrl);
    if (lv.error || lc.error || lv.status !== 200 || lc.status !== 200) continue;
    const a = lv.body.replace(/\r\n/g, '\n').trim(), b = lc.body.replace(/\r\n/g, '\n').trim();
    if (a === b) { notes.push(sp.path + ': the live file is the same as the local one.'); continue; }
    const hostsIn = t => new Set([...t.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map(x => x[1].toLowerCase()));
    const lh = hostsIn(b);
    const extra = [...hostsIn(a)].filter(h => !lh.has(h) && !isOwn(h, liveHost) && !HOST_ALWAYS.test(h) && !(o.projectHas && o.projectHas(h)));
    if (extra.length) findings.push({ rule: 'CMP-005', sev: 'High', area: 'live vs local', title: 'Script ' + sp.path + ' on the live site is not the same as the local one, and it reaches ' + extra.slice(0, 3).join(', '), where: sp.liveUrl, fp: sha(sp.path + extra.join()), fix: 'Upload your own copy of the file again; if you did not change it, someone else did: change the hosting/FTP passwords.' });
    else if (OBFUSCATED.test(a) && !OBFUSCATED.test(b)) findings.push({ rule: 'CMP-005', sev: 'High', area: 'live vs local', title: 'Script ' + sp.path + ' on the live site has hidden (obfuscated) code the local one does not', where: sp.liveUrl, fp: sha(sp.path + 'obf'), fix: 'Upload your own copy again and find how it was changed (change the hosting/FTP passwords).' });
    else notes.push(sp.path + ': the live file differs from the local one (' + a.length + ' vs ' + b.length + ' characters): an older or newer upload.');
  }

  if (o.probes !== false) {
    const more = await siteChecks(o, { liveUrl, liveHost, https, home, liveGet, findings, notes });
    if (more) return stop(more);
  }

  // http:// should move to https://, and a few files must never be fetchable.
  if (o.probes !== false) {
    if (https) {
      const plain = await liveGet('http://' + liveUrl.host + '/', { follow: false });
      if (!plain.error && plain.status >= 200 && plain.status < 300 && !looksBlocked(plain)) findings.push({ rule: 'LIVE-021', sev: 'Medium', area: 'live site', title: 'http://' + liveUrl.host + '/ shows the site without moving to https', where: 'http://' + liveUrl.host + '/', fix: 'Redirect every http request to https (the host\'s "Force HTTPS" switch, or a rule in .htaccess).' });
      // A folder with its own .htaccess (an admin area) can drop the site's https redirect: ask for it over http too.
      else for (const p of (o.httpPaths || []).slice(0, 1)) {
        const r = await liveGet('http://' + liveUrl.host + p, { follow: false });
        const loc = String((r.headers || {}).location || '');
        if (!r.error && !looksBlocked(r) && (r.status < 300 || (r.status < 400 && /^http:/i.test(loc)) || r.status === 401)) findings.push({ rule: 'LIVE-021', sev: 'Medium', area: 'live site', title: 'http://' + liveUrl.host + p + ' is served over plain http (the https redirect does not reach it)', where: 'http://' + liveUrl.host + p, fix: 'Put the https redirect in that folder\'s own .htaccess too (a folder\'s RewriteEngine On switches off the parent\'s rules), or use the host\'s Force HTTPS.' });
      }
    }
    // An old copy of the site left in /old/ is still served, with its old faults (one request; a "not found" page,
    // or an app that answers every address with its home page, does not count).
    const old = await liveGet(new URL('/old/', liveUrl).href, { follow: false });
    if (looksBlocked(old)) return stop('/old/ answered with a firewall page; the remaining checks were skipped.');
    if (!old.error && old.status === 200 && /<html|<!doctype/i.test((old.body || '').slice(0, 800)) && old.body !== home.body && titleOf(old.body) !== titleOf(home.body) && !/not found|404|page doesn.t exist|no such page/i.test(titleOf(old.body) + ' ' + (old.body || '').slice(0, 3000)))
      findings.push({ rule: 'LIVE-019', sev: 'Medium', area: 'live site', title: 'An old copy of the site is still served at /old/ ("' + titleOf(old.body).slice(0, 60) + '")', where: new URL('/old/', liveUrl).href, fix: 'Delete the old copy on the server (with its old libraries and faults); keep backups outside the public folder.' });
    for (const p of LIVE_PROBES) {
      const r = await liveGet(new URL(p.path, liveUrl).href, { follow: false });
      if (looksBlocked(r)) return stop(p.path + ' answered with a firewall page; the remaining checks were skipped.');
      if (r.error || r.status !== 200) continue;
      const body = r.body || '';
      if (p.notHtml && /<html|<!doctype/i.test(body.slice(0, 500))) continue;
      if (!p.looks.test(body.slice(0, 20000))) continue;
      findings.push({ rule: p.id, sev: p.sev, area: 'live site', title: p.title, where: new URL(p.path, liveUrl).href, fix: 'Block or remove it on the server now; if it is .env or .git, change every password and key it holds.' });
    }
  }
  return { findings, notes, report };
}

// ---------- what the home page's own files, the sitemap, robots.txt and DNS say (training phase T5) ----------
// About ten more paced GETs at most. Returns a reason to stop (a firewall page answered), or nothing.
async function siteChecks(o, c) {
  const { liveUrl, liveHost, https, home, liveGet, findings, notes } = c;
  const add = (rule, sev, title, where, fix) => findings.push({ rule, sev, area: 'live site', title, where, fix });
  const blocked = (r, what) => (looksBlocked(r) ? what + ' answered with a firewall page; the remaining checks were skipped.' : null);
  const ok = r => r && !r.error && r.status >= 200 && r.status < 300;
  const homeUrl = home.finalUrl || liveUrl.href;
  const refs = pageRefs(home.body, homeUrl).filter(r => isOwn(r.host, liveHost));
  const h = home.headers || {};

  // 1. The home page's own stylesheet, scripts and an API address they call: the same security headers as the page?
  // (a CDN or a second server layer often answers files without them)
  const want = [['x-content-type-options', 'X-Content-Type-Options'], ...(https ? [['strict-transport-security', 'Strict-Transport-Security']] : [])].filter(([k]) => h[k]);
  const files = [...refs.filter(r => r.kind === 'stylesheet').slice(0, 1), ...refs.filter(r => r.kind === 'script').slice(0, 2)];
  const fetched = [];
  for (const r of files) {
    const res = await liveGet(r.url, { follow: false });
    const b = blocked(res, r.url); if (b) return b;
    if (ok(res)) fetched.push({ url: r.url, kind: r.kind, res });
  }
  const api = fetched.filter(f => f.kind === 'script').map(f => /\bfetch\s*\(\s*['"`](\/api\/[^'"`?#$]+)['"`]/.exec(f.res.body || '')).find(Boolean);
  if (api) {
    const res = await liveGet(new URL(api[1], liveUrl).href, { follow: false });
    const b = blocked(res, api[1]); if (b) return b;
    if (ok(res)) fetched.push({ url: new URL(api[1], liveUrl).href, kind: 'api', res });
  }
  const bare = fetched.map(f => ({ f, missing: want.filter(([k]) => !(f.res.headers || {})[k]).map(([, n]) => n) })).filter(x => x.missing.length);
  if (bare.length) add('LIVE-025', 'Medium', 'The home page sends ' + want.map(w => w[1]).join(' and ') + ', but ' + bare.map(x => x.f.kind).join(', ') + ' answer' + (bare.length === 1 ? 's' : '') + ' without ' + [...new Set(bare.flatMap(x => x.missing))].join(' and ') + ' (another server layer)',
    bare[0].f.url, 'Set the headers for the whole site (every file type and the API), not only for pages: in .htaccess outside any <FilesMatch>, or in the CDN\'s rules.');

  // 2. Outdated libraries, from the banners of the scripts just fetched.
  for (const f of fetched.filter(x => x.kind === 'script')) {
    for (const lib of oldLibraries(f.res.body)) add('LIVE-032', 'High', lib.name + ' ' + lib.version + ' is served (' + lib.why + '; fixed in ' + lib.fixed + ')', f.url, 'Update ' + lib.name + ' to ' + lib.fixed + ' or later, rebuild and upload the new file.');
  }

  // 3. Folder listings: the folders those files sit in.
  const folders = [...new Set(files.map(r => new URL(r.url).pathname.replace(/[^/]*$/, '')).filter(p => p !== '/'))].slice(0, 2);
  for (const p of folders) {
    const res = await liveGet(new URL(p, liveUrl).href, { follow: false });
    const b = blocked(res, p); if (b) return b;
    if (ok(res) && /<title>\s*Index of \//i.test(res.body || '')) add('LIVE-007', 'Medium', 'Folder listing is switched on for ' + p + ' (anyone can see every file in it)', new URL(p, liveUrl).href, 'Turn off directory listing (Options -Indexes in .htaccess).');
  }

  // 4. A made-up address must not answer 200 with a page (a "soft 404").
  const probe = '/myia-check-' + crypto.randomBytes(5).toString('hex') + '-not-here';
  const soft = await liveGet(new URL(probe, liveUrl).href, { follow: true });
  { const b = blocked(soft, probe); if (b) return b; }
  // a "not found" page sent with status 200 is a soft 404 too (search engines say so)
  if (ok(soft) && /<html|<!doctype/i.test((soft.body || '').slice(0, 800))) {
    const says = /not found|404|page doesn.t exist|no such page|can.t find/i.test(titleOf(soft.body) + ' ' + (soft.body || '').slice(0, 3000));
    add('LIVE-026', 'Medium', says ? 'A made-up address shows a "not found" page but with status 200 (search engines index it as a page)' : 'A made-up address answers 200 with a page (search engines index endless copies; broken links look fine)', new URL(probe, liveUrl).href, 'Answer 404 for addresses that do not exist (the server\'s ErrorDocument, or the app\'s not-found route with status 404).');
  }

  // 5. Meta description on the home page (no request).
  if (/<html|<!doctype/i.test((home.body || '').slice(0, 800)) && !/<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*\bcontent\s*=\s*["'][^"']{20,}/i.test(home.body || '') && !/<meta\b[^>]*\bcontent\s*=\s*["'][^"']{20,}["'][^>]*\bname\s*=\s*["']?description/i.test(home.body || ''))
    add('LIVE-029', 'Medium', 'The live home page has no meta description (search results show whatever text they find)', homeUrl, 'Add <meta name="description" content="..."> with one or two sentences saying what the site offers.');

  // 6. Canonical: the address the home page names as itself must answer.
  const canon = /<link\b(?=[^>]*\brel\s*=\s*["']?canonical)[^>]*\bhref\s*=\s*["']([^"']+)/i.exec(home.body || '');
  if (canon) {
    let cu = null; try { cu = new URL(canon[1], homeUrl); } catch {}
    if (cu && isOwn(cu.hostname, liveHost) && cu.pathname !== new URL(homeUrl).pathname) {
      const res = await liveGet(new URL(cu.pathname + cu.search, liveUrl).href, { follow: true });
      const b = blocked(res, cu.pathname); if (b) return b;
      if (!res.error && res.status >= 400) add('LIVE-031', 'Medium', 'The home page names ' + cu.pathname + ' as its canonical address, and that answers ' + res.status, homeUrl, 'Point the canonical link at the address that serves the page (usually the page itself).');
    }
  }

  // 7. Sitemap and robots.txt: what the sitemap asks to index, robots.txt must not hide; a listed page the project no
  // longer has but the host still serves is an orphan (its old code still runs).
  const sm = await liveGet(new URL('/sitemap.xml', liveUrl).href, { follow: true });
  { const b = blocked(sm, '/sitemap.xml'); if (b) return b; }
  const locs = ok(sm) && /<urlset|<sitemapindex/i.test(sm.body || '') ? [...(sm.body || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => { try { return new URL(m[1]); } catch { return null; } }).filter(u => u && isOwn(u.hostname, liveHost)) : [];
  const rb = await liveGet(new URL('/robots.txt', liveUrl).href, { follow: true });
  { const b = blocked(rb, '/robots.txt'); if (b) return b; }
  if (ok(rb) && locs.length && !/<html|<!doctype/i.test((rb.body || '').slice(0, 300))) {
    const dis = robotsDisallow(rb.body);
    const hit = locs.map(u => ({ u, rule: dis.find(d => u.pathname.startsWith(d)) })).find(x => x.rule);
    if (hit) add('LIVE-030', 'Medium', 'robots.txt "Disallow: ' + hit.rule + '" also hides ' + hit.u.pathname + ', which the sitemap asks to be indexed', new URL('/robots.txt', liveUrl).href, 'End the Disallow with a slash (Disallow: ' + hit.rule.replace(/\/?$/, '/') + ') or name the exact path, so it hides only what you mean.');
  }
  if (o.projectHas) {
    const gone = locs.filter(u => /\.(html?|php)$/i.test(u.pathname) && !o.projectHas(u.pathname.split('/').pop())).slice(0, 2);
    for (const u of gone) {
      const res = await liveGet(new URL(u.pathname, liveUrl).href, { follow: false });
      const b = blocked(res, u.pathname); if (b) return b;
      if (ok(res)) add('LIVE-027', 'Medium', u.pathname + ' still answers on the host (the sitemap lists it), but no project file has it: an old page with its old code', new URL(u.pathname, liveUrl).href, 'Delete the old file on the server (and take it out of the sitemap), or bring it back into the project if it is still wanted.');
    }
  }

  // 8. DMARC on the domain (a DNS lookup, not a request to the site).
  const dom = domainOf(liveHost);
  // reserved names (.example, .test, .invalid, .localhost) never reach a real DNS server
  if (dom && !LOCAL_HOST.test(dom) && !SHARED_HOSTS.test('.' + dom) && (o.dnsTxt || !/\.(example|test|invalid|localhost|local)$/i.test(dom))) {
    let txt = null;
    try {
      txt = o.dnsTxt ? await o.dnsTxt('_dmarc.' + dom) : (await dns.promises.resolveTxt('_dmarc.' + dom)).map(r => r.join('')).join('\n');
    } catch (e) { if (!/ENODATA|ENOTFOUND|NXDOMAIN/i.test(e.code || e.message)) { notes.push('DMARC was not checked: the DNS lookup for _dmarc.' + dom + ' failed (' + (e.code || e.message) + ').'); txt = undefined; } }
    if (txt !== undefined) {
      const rec = String(txt || '').split('\n').find(t => /^v=DMARC1/i.test(t.trim()));
      if (!rec) add('LIVE-028', 'Medium', dom + ' has no DMARC record, so anyone can send mail that claims to come from it', '_dmarc.' + dom, 'Add a TXT record at _dmarc.' + dom + ': v=DMARC1; p=quarantine; rua=mailto:<a mailbox you read> (start with p=none to watch first).');
      else if (!/\brua\s*=/i.test(rec)) notes.push('_dmarc.' + dom + ' has a policy but no rua= address, so you get no reports of mail sent in your name.');
    }
  }
  return null;
}
// The Disallow prefixes that apply to every crawler (User-agent: *).
function robotsDisallow(text) {
  const out = [];
  let star = false, inGroup = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!inGroup) star = false; inGroup = true; if (v === '*') star = true; continue; }
    inGroup = false;
    if (k === 'disallow' && star && v && v !== '/') out.push(v.replace(/\*.*$/, ''));
  }
  return out.filter(Boolean);
}

const isLocalHost = h => LOCAL_HOST.test(String(h || ''));

module.exports = { parseLiveUrl, isLocalHost, isPrivateIp, checkSite, judge, get, pageRefs, looksBlocked, headerFindings, compareLive, siteOf, isOwn, LIVE_PROBES, OBFUSCATED, titleOf, oldLibraries, robotsDisallow };
