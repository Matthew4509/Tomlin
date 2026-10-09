// Self-test for the live checks added in scanner training T5 (lib/live.js siteChecks): each is run against a made-up
// site served on this PC, once where it must fire and once fixed, written differently from the museum's copies
// (test/museum/cases-5-live.js). DNS answers come from a stand-in; nothing leaves this PC.
// Run: node test/live-more.test.js   (no packages).
'use strict';
const http = require('http');
const assert = require('assert');
const { compareLive, oldLibraries, robotsDisallow } = require('../../src/bridge/live');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

const SAFE = { 'Content-Security-Policy': "default-src 'self'", 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': 'max-age=63072000', 'X-Frame-Options': 'DENY' };
const DESC = '<meta name="description" content="Bike repairs and spare parts in the old tram shed, open six days a week.">';
const html = (body, head = DESC) => '<!doctype html><html lang="en"><head><title>Spokes</title>' + head + '</head><body>' + body + '</body></html>';
const pg = (body, head) => ({ headers: SAFE, body: html(body, head) });

function serve(routes) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const r = routes[req.url.split('?')[0]] || routes['*'];
      if (!r) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Missing</title>'); }
      res.writeHead(r.status || 200, { 'Content-Type': 'text/html; charset=utf-8', ...(r.headers || {}) });
      res.end(r.body || '');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
async function run(routes, dns = { '_dmarc.spokes-repair.net': 'v=DMARC1; p=reject; rua=mailto:dmarc@spokes-repair.net' }, has = () => 'src/index.html') {
  const s = await serve(routes);
  try {
    return await compareLive({ liveUrl: 'https://www.spokes-repair.net/', resolve: () => ({ host: '127.0.0.1', port: s.address().port }), gapMs: 0, minGapMs: 0, maxPages: 1,
      projectHas: has, dnsTxt: name => (name in dns ? dns[name] : null) });
  } finally { s.close(); }
}
const rules = r => r.findings.map(f => f.rule);

// [rule, fires, stays quiet, extra args]
const CASES = [
  ['LIVE-025', { '/': pg('<link rel="stylesheet" href="/css/s.css">'), '/css/s.css': { headers: { 'Content-Type': 'text/css' }, body: 'a{}' } },
    { '/': pg('<link rel="stylesheet" href="/css/s.css">'), '/css/s.css': { headers: { ...SAFE, 'Content-Type': 'text/css' }, body: 'a{}' } }],
  ['LIVE-025', { '/': pg('<script src="/js/main.js"></script>'), '/js/main.js': { headers: SAFE, body: "fetch('/api/hours')" }, '/api/hours': { headers: { 'Content-Type': 'application/json' }, body: '{}' } },
    { '/': pg('<script src="/js/main.js"></script>'), '/js/main.js': { headers: SAFE, body: "fetch('/api/hours')" }, '/api/hours': { headers: { ...SAFE, 'Content-Type': 'application/json' }, body: '{}' } }],
  ['LIVE-032', { '/': pg('<script src="/lib/jq.js"></script>'), '/lib/jq.js': { headers: SAFE, body: '/*! jQuery v3.4.1 | (c) OpenJS Foundation */' } },
    { '/': pg('<script src="/lib/jq.js"></script>'), '/lib/jq.js': { headers: SAFE, body: '/*! jQuery v3.7.1 | (c) OpenJS Foundation */' } }],
  ['LIVE-007', { '/': pg('<script src="/static/x.js"></script>'), '/static/x.js': { headers: SAFE, body: '1' }, '/static/': { headers: SAFE, body: '<title>Index of /static</title>' } },
    { '/': pg('<script src="/static/x.js"></script>'), '/static/x.js': { headers: SAFE, body: '1' }, '/static/': { status: 404, headers: SAFE, body: 'no' } }],
  ['LIVE-026', { '/': pg('<p>Hi</p>'), '*': pg('<p>Page not found</p>') }, { '/': pg('<p>Hi</p>') }],
  ['LIVE-029', { '/': pg('<p>Hi</p>', '') }, { '/': pg('<p>Hi</p>') }],
  ['LIVE-031', { '/': pg('<p>Hi</p>', DESC + '<link rel="canonical" href="https://www.spokes-repair.net/start">') },
    { '/': pg('<p>Hi</p>', DESC + '<link rel="canonical" href="https://www.spokes-repair.net/start">'), '/start': pg('<p>Hi</p>') }],
  ['LIVE-030', { '/': pg('<p>Hi</p>'), '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /s\n' },
      '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<urlset><url><loc>https://www.spokes-repair.net/services</loc></url></urlset>' } },
    { '/': pg('<p>Hi</p>'), '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /s/\n' },
      '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<urlset><url><loc>https://www.spokes-repair.net/services</loc></url></urlset>' } }],
  ['LIVE-027', { '/': pg('<p>Hi</p>'), '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<urlset><url><loc>https://www.spokes-repair.net/winter-sale.html</loc></url></urlset>' }, '/winter-sale.html': pg('<p>Sale</p>') },
    { '/': pg('<p>Hi</p>'), '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<urlset><url><loc>https://www.spokes-repair.net/winter-sale.html</loc></url></urlset>' } }, null, n => (n === 'winter-sale.html' ? null : 'src/index.html')],
  ['LIVE-018', { '/': pg('<p>Hi</p>'), '/composer.json': { headers: { 'Content-Type': 'application/json' }, body: '{"require":{"php":">=8.1"}}' } }, { '/': pg('<p>Hi</p>') }],
  ['LIVE-028', { '/': pg('<p>Hi</p>') }, { '/': pg('<p>Hi</p>') }, {}],
];

(async () => {
  for (const [rule, bad, good, dns, has] of CASES) {
    const b = await run(bad, dns || undefined, has || undefined), g = await run(good, rule === 'LIVE-028' ? undefined : dns || undefined, has || undefined);
    check(rule + ' fires', () => assert(rules(b).includes(rule), 'got ' + rules(b).join(',') + ' ' + b.notes.join(' | ')));
    check(rule + ' stays quiet on the fixed site', () => assert(!rules(g).includes(rule), 'flagged: ' + g.findings.filter(f => f.rule === rule).map(f => f.title).join('; ')));
  }
  // the LIVE-027 fire case: a page the project still has (projectHas finds it) is not an orphan
  {
    const r = await run({ '/': pg('<p>Hi</p>'), '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<urlset><url><loc>https://www.spokes-repair.net/about.html</loc></url></urlset>' }, '/about.html': pg('<p>About</p>') });
    check('LIVE-027: a sitemap page the project has is not an orphan', () => assert(!rules(r).includes('LIVE-027')));
  }
  // a header the home page lacks too is the home page's finding (LIVE-003), not a per-file one
  {
    const { 'X-Content-Type-Options': _, ...noSniff } = SAFE;
    const r = await run({ '/': { headers: noSniff, body: html('<link rel="stylesheet" href="/css/s.css">') }, '/css/s.css': { headers: { ...noSniff, 'Content-Type': 'text/css' }, body: 'a{}' } });
    check('LIVE-025 stays quiet when the home page lacks the header too (LIVE-003 says it)', () => assert(!rules(r).includes('LIVE-025') && rules(r).includes('LIVE-003'), rules(r).join(',')));
  }
  // a firewall page on one of the extra requests stops the rest
  {
    const r = await run({ '/': pg('<script src="/js/a.js"></script>'), '/js/a.js': { status: 403, headers: SAFE, body: '<html><title>Attention Required! | Cloudflare</title></html>' } });
    check('a firewall answer to an extra request stops the compare', () => assert(r.report.stopped && /firewall/.test(r.report.stopped), JSON.stringify(r.report.stopped)));
  }
  // the readers on their own
  check('robots: only the * group counts; "Disallow: /" and comments are ignored', () => {
    assert.deepStrictEqual(robotsDisallow('User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /tmp # temp\nDisallow: /\nDisallow:\n'), ['/tmp']);
    assert.deepStrictEqual(robotsDisallow('User-agent: Bingbot\nUser-agent: *\nDisallow: /x*\n'), ['/x']);
  });
  check('libraries: below the fix is reported, at or above is not', () => {
    assert.strictEqual(oldLibraries('/*! lodash 4.17.20 */')[0].name, 'lodash');
    assert.strictEqual(oldLibraries('/*! lodash 4.17.21 */').length, 0);
    assert.strictEqual(oldLibraries('/*! Bootstrap v4.3.1 */').length, 0);
    assert.strictEqual(oldLibraries('/*! Bootstrap v3.3.7 */')[0].fixed, '3.4.1');
    assert.strictEqual(oldLibraries('/*! Bootstrap v5.0.0 */').length, 0);
    assert.strictEqual(oldLibraries('var s = "axios v0.1.0"; '.padStart(5000, ' ')).length, 0, 'a version far past the banner is not read');
  });
  // a site on a reserved test domain never asks a real DNS server
  {
    const s = await serve({ '/': pg('<p>Hi</p>') });
    const r = await compareLive({ liveUrl: 'https://shop.example/', resolve: () => ({ host: '127.0.0.1', port: s.address().port }), gapMs: 0, minGapMs: 0, maxPages: 1 });
    s.close();
    check('no DMARC lookup for a reserved .example domain', () => assert(!rules(r).includes('LIVE-028') && !r.notes.some(n => /DMARC/.test(n))));
  }
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
