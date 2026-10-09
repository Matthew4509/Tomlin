// Museum, section 7 of the training plan: faults only the live site shows (phase T5). Each copy carries "site": the
// pages a made-up live site answers ({ path: { status, headers, body } }, '*' for every other path), and "local" when
// the local copy runs too. The benchmark serves them on this PC and points the live check at them; nothing goes out.
'use strict';

const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000',
};
const page = (body, extra) => ({ headers: { ...HEADERS, ...(extra || {}) }, body: '<!doctype html><html lang="en"><head><title>Shop</title><meta name="description" content="Hand-made shelves and benches from recycled timber, built to order in our workshop and delivered within two weeks of your order."></head><body>' + body + '</body></html>' });
const HOME = '<h1>Shop</h1><a href="/about.html">About</a>';
const files = { 'index.html': '<!doctype html><title>Shop</title><h1>Shop</h1><a href="/about.html">About</a>\n', 'about.html': '<!doctype html><title>About</title><p>Who we are.</p>\n' };
const site = (routes, more) => ({ ...files, ...(more || {}), site: { live: { '/about.html': page('<p>Who we are.</p>'), ...routes } } });

module.exports = [
  {
    id: 'live-csp-missing', bucket: 'L', phase: 'done', faults: 10, examples: ['SP-026', 'PD-024'],
    title: 'The live site sends no Content-Security-Policy',
    rule: '^LIVE-00[128]$',
    bad: site({ '/': { headers: { 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': 'max-age=31536000', 'X-Frame-Options': 'SAMEORIGIN' }, body: page(HOME).body } }),
    good: site({ '/': page(HOME) }),
  },
  {
    id: 'live-hsts-missing', bucket: 'L', phase: 'done', faults: 5, examples: ['SC-015', 'CS-021'],
    title: 'The live site on https sends no Strict-Transport-Security',
    rule: '^LIVE-020$',
    bad: site({ '/': { headers: { 'Content-Security-Policy': HEADERS['Content-Security-Policy'], 'X-Content-Type-Options': 'nosniff' }, body: page(HOME).body } }),
    good: site({ '/': page(HOME) }),
  },
  {
    id: 'live-script-not-in-project', bucket: 'L', phase: 'done', faults: 1, examples: ['IP-023'],
    title: 'The live page loads a script from a host that neither the local copy nor any project file has',
    rule: '^CMP-',
    bad: { ...files, site: { live: { '/': page(HOME + '<script src="https://cdn.ad-network.example/tag.js"></script>'), '/about.html': page('<p>Who we are.</p>') }, local: { '/': page(HOME), '/about.html': page('<p>Who we are.</p>') } } },
    good: { ...files, site: { live: { '/': page(HOME), '/about.html': page('<p>Who we are.</p>') }, local: { '/': page(HOME), '/about.html': page('<p>Who we are.</p>') } } },
  },
  {
    id: 'live-headers-by-file-type', bucket: 'L', phase: 'T5', faults: 10, examples: ['SP-026', 'SC-015', 'SC-026', 'CS-021'],
    title: 'The home page has its security headers, but the stylesheet and the API answer without them (another server layer)',
    bad: site({ '/': page(HOME + '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>'),
      '/assets/app.css': { headers: { 'Content-Type': 'text/css' }, body: 'body{margin:0}' }, '/assets/app.js': { headers: { 'Content-Type': 'text/javascript' }, body: 'fetch("/api/status")' },
      '/api/status': { headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' } }),
    good: site({ '/': page(HOME + '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>'),
      '/assets/app.css': { headers: { ...HEADERS, 'Content-Type': 'text/css' }, body: 'body{margin:0}' }, '/assets/app.js': { headers: { ...HEADERS, 'Content-Type': 'text/javascript' }, body: 'fetch("/api/status")' },
      '/api/status': { headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: '{"ok":true}' } }),
  },
  {
    id: 'live-soft-404', bucket: 'L', phase: 'T5', faults: 3, examples: ['IP-260', 'PD-109'],
    title: 'Every made-up address answers 200 with the home page (search engines index endless copies; broken links look fine)',
    bad: site({ '/': page(HOME), '*': page(HOME) }),
    good: site({ '/': page(HOME) }),
  },
  {
    id: 'live-folder-listing', bucket: 'L', phase: 'T5', faults: 2, examples: ['SP-044'],
    title: 'A folder the page loads scripts from lists its files (only the home page is checked for a listing today)',
    at: '/js/',
    bad: site({ '/': page(HOME + '<script src="/js/app.js"></script>'), '/js/app.js': { headers: HEADERS, body: 'console.log(1)' },
      '/js/': { headers: HEADERS, body: '<html><head><title>Index of /js</title></head><body><h1>Index of /js</h1><a href="app.js">app.js</a><a href="admin-tools.js">admin-tools.js</a></body></html>' } }),
    good: site({ '/': page(HOME + '<script src="/js/app.js"></script>'), '/js/app.js': { headers: HEADERS, body: 'console.log(1)' },
      '/js/': { status: 403, headers: HEADERS, body: 'Forbidden' } }),
  },
  {
    id: 'live-package-json', bucket: 'L', phase: 'T5', faults: 1, examples: ['CS-021'],
    title: 'package.json can be downloaded from the live site (the localhost check asks for it; the live one does not)',
    at: 'package.json',
    bad: site({ '/': page(HOME), '/package.json': { headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: '{"name":"shop","dependencies":{"express":"4.17.1"}}' } }),
    good: site({ '/': page(HOME) }),
  },
  {
    id: 'live-orphan-file', bucket: 'L', phase: 'T5', faults: 5, examples: ['SP-044', 'IN-033', 'CS-031'],
    title: 'A page the release no longer has still answers on the host (the sitemap lists it), with its old code',
    bad: site({ '/': page(HOME), '/sitemap.xml': { headers: { ...HEADERS, 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><urlset><url><loc>https://shop.museum-site.example/</loc></url><url><loc>https://shop.museum-site.example/old-pricing.php</loc></url></urlset>' },
      '/old-pricing.php': page('<p>Old prices</p>') }),
    good: site({ '/': page(HOME), '/sitemap.xml': { headers: { ...HEADERS, 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><urlset><url><loc>https://shop.museum-site.example/</loc></url></urlset>' } }),
  },
  {
    id: 'live-dmarc', bucket: 'L', phase: 'T5', faults: 10, examples: ['SP-044', 'IN-033', 'CS-031'],
    title: 'The domain has no DMARC policy, so anyone can send mail as it (no check reads DNS yet)',
    bad: { ...site({ '/': page(HOME) }), site: { live: { '/': page(HOME) }, dns: {} } },
    good: { ...site({ '/': page(HOME) }), site: { live: { '/': page(HOME) }, dns: { '_dmarc.museum-site.example': 'v=DMARC1; p=quarantine; rua=mailto:reports@museum-site.example' } } },
  },
  {
    id: 'live-no-description', bucket: 'L', phase: 'T5', faults: 14, examples: ['JP-090', 'PD-102', 'IP-268'],
    title: 'The live home page has no meta description (search results show whatever text they find)',
    bad: site({ '/': { headers: HEADERS, body: '<!doctype html><html lang="en"><head><title>Shop</title></head><body>' + HOME + '</body></html>' } }),
    good: site({ '/': page(HOME) }),
  },
  {
    id: 'live-robots-prefix', bucket: 'L', phase: 'T5', faults: 3, examples: ['IP-266', 'PD-109'],
    title: 'robots.txt "Disallow: /p" also hides /pricing and /products, which the sitemap asks to be indexed',
    bad: site({ '/': page(HOME), '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /p\n' }, '/pricing': page('<p>Prices</p>'),
      '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><urlset><url><loc>https://shop.museum-site.example/pricing</loc></url></urlset>' } }),
    good: site({ '/': page(HOME), '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private/\n' }, '/pricing': page('<p>Prices</p>'),
      '/sitemap.xml': { headers: { 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><urlset><url><loc>https://shop.museum-site.example/pricing</loc></url></urlset>' } }),
  },
  {
    id: 'live-canonical-404', bucket: 'L', phase: 'T5', faults: 2, examples: ['PD-110'],
    title: 'The home page names a canonical address that answers 404',
    bad: site({ '/': page(HOME + '<link rel="canonical" href="https://shop.museum-site.example/home.html">') }),
    good: site({ '/': page(HOME + '<link rel="canonical" href="https://shop.museum-site.example/">') }),
  },
  {
    id: 'live-outdated-library', bucket: 'L', phase: 'T5', faults: 2, examples: ['IP-258'],
    title: 'The served bundle carries a library version with known holes (read from its banner)',
    at: 'vendor.js',
    bad: site({ '/': page(HOME + '<script src="/assets/vendor.js"></script>'), '/assets/vendor.js': { headers: { ...HEADERS, 'Content-Type': 'text/javascript' }, body: '/*! axios v0.21.1 | (c) the axios authors */var axios={};' } }),
    good: site({ '/': page(HOME + '<script src="/assets/vendor.js"></script>'), '/assets/vendor.js': { headers: { ...HEADERS, 'Content-Type': 'text/javascript' }, body: '/*! axios v1.7.7 | (c) the axios authors */var axios={};' } }),
  },
];
