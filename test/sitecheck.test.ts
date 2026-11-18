// The page-by-page website check (src/sitecheck.ts), with a fake site and a fake model: no real address is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, type Fetcher } from '../src/webtools.ts';
import { checkSite, inspectHtml, pageFlags, pageRoom, reportText, sitemapUrls, verdictOf, type SiteAsk } from '../src/sitecheck.ts';

const html = (body: string, head = '') => `<!doctype html><html><head><title>T</title>${head}</head><body><main>${body}</main></body></html>`;
const long = (word: string) => `${word} `.repeat(120);

test('site check: the code reads scripts, frames, redirects, hidden links, shorteners, downloads and forms', () => {
  const page = html(
    `<p>Hello</p>
     <a href="https://bit.ly/abc">short</a>
     <a href="/files/setup.exe">get it</a>
     <a href="/about">About</a>
     <a href="https://www.facebook.com/x">Facebook</a>
     <div style="position:absolute;left:-9999px"><a href="https://pills.example/buy">cheap</a></div>
     <iframe src="https://ads.example/frame" width="0" height="0"></iframe>
     <form action="https://collect.example/post" method="post"><input></form>
     <script>var x = eval(atob("aGVsbG8="));</script>
     <script src="https://www.googletagmanager.com/gtag/js"></script>
     <script src="https://evil.example/x.js"></script>
     <script src="/local.js"></script>`,
    '<meta http-equiv="refresh" content="0; url=https://elsewhere.example/">',
  );
  const f = inspectHtml(page, 'https://shop.example/');
  assert.equal(f.inlineScripts, 1);
  assert.deepEqual(f.inlineFlags.map(i => i.what).sort(), ['decodes hidden text (atob)', 'runs text as code (eval)']);
  const by = Object.fromEntries(f.scripts.map(s => [s.host || 'local', s]));
  assert.equal(by['googletagmanager.com'].known, true);
  assert.equal(by['evil.example'].thirdParty, true);
  assert.equal(by['evil.example'].known, false);
  assert.equal(by['shop.example'].thirdParty, false);
  assert.equal(f.iframes[0].hidden, true);
  assert.deepEqual(f.metaRefresh, ['https://elsewhere.example/']);
  assert.equal(f.hiddenLinks, 1);
  assert.deepEqual(f.shorteners, ['https://bit.ly/abc']);
  assert.deepEqual(f.downloads, ['https://shop.example/files/setup.exe']);
  assert.equal(f.forms[0].thirdParty, true);
  assert.ok(f.links.includes('https://shop.example/about'));
  assert.equal(f.externalLinks['facebook.com'], 1);
  const flags = pageFlags(f, 'https://shop.example/', 'https://shop.example/').join('\n');
  assert.match(flags, /evil\.example/);
  assert.doesNotMatch(flags, /googletagmanager/);
  assert.match(flags, /hidden frame/);
  assert.match(flags, /redirects by itself/);
  assert.match(flags, /address shortener/);
  assert.match(flags, /program or installer/);
  assert.match(flags, /form sends what is typed to collect\.example/);
  assert.match(flags, /something a visitor cannot see/);
});

test('site check: a plain page has nothing flagged', () => {
  const f = inspectHtml(html('<p>Piano tuning</p><a href="/contact">Contact</a><script src="/app.js"></script><script>console.log(1)</script>'), 'https://shop.example/');
  assert.deepEqual(pageFlags(f, 'https://shop.example/', 'https://shop.example/'), []);
  assert.equal(inspectHtml('<p>x</p>', 'https://shop.example/').links.length, 0);
});

test('site check: a long encoded string and a send-away redirect in a script are named', () => {
  const f = inspectHtml(`<script>var d = "${'QUJD'.repeat(80)}"; window.location = "https://spam.example/";</script>`, 'https://shop.example/');
  assert.ok(f.inlineFlags.some(i => /long encoded/.test(i.what)));
  assert.ok(f.inlineFlags.some(i => /sends the visitor to another address/.test(i.what)));
});

/** A small site: / links to /a, /b, a PDF and an outside site; /a links to /c; /b is missing; /c redirects off site. */
function site(): { get: Fetcher; asked: string[] } {
  const asked: string[] = [];
  const pages: Record<string, string> = {
    'https://shop.example/': html(`<h1>Home</h1><p>${long('welcome')}</p><a href="/a">A</a><a href="/b">B</a><a href="/doc.pdf">PDF</a><a href="https://other.example/">Other</a><a href="/d">D</a>`),
    'https://shop.example/a': html(`<h1>Page A</h1><p>${long('alpha')}</p><a href="/c">C</a><script src="https://evil.example/m.js"></script>`),
    'https://shop.example/d': html(`<h1>Page D</h1><p>${long('delta')}</p>`),
  };
  const get: Fetcher = async url => {
    asked.push(url);
    if (url.endsWith('/sitemap.xml')) return { status: 200, type: 'application/xml', body: Buffer.from('<urlset><loc>https://shop.example/e</loc><loc>https://other.example/x</loc></urlset>'), url };
    if (url === 'https://shop.example/c') return { status: 200, type: 'text/html', body: Buffer.from(html('moved')), url: 'https://moved.example/c' };
    if (url === 'https://shop.example/e') return { status: 200, type: 'text/html', body: Buffer.from(html(`<h1>Page E</h1><p>${long('echo')}</p>`)), url };
    const body = pages[url];
    if (!body) return { status: 404, type: 'text/html', body: Buffer.from('not found'), url };
    return { status: 200, type: 'text/html; charset=utf-8', body: Buffer.from(body), url };
  };
  return { get, asked };
}

const quick = () => new Pacer({ page: 0, jitter: 0, search: 0 }, () => 0);

test('site check: walks the site page by page, one page to the model each time, with tokens and timing', async () => {
  const { get, asked } = site();
  const prompts: string[] = [];
  const ask: SiteAsk = async (_system, user) => {
    prompts.push(user);
    return { text: /Page D/.test(user) ? 'VERDICT: CHECK\nThe words "cheap pills" are on this page.' : 'VERDICT: OK\nNothing odd.', tokensIn: 500, tokensOut: 20 };
  };
  const r = await checkSite({ start: 'https://shop.example/', get, pace: quick(), ask, ctx: 32768, maxPages: 10 });
  const urls = r.pages.map(p => p.url);
  // Home first, then its links in order, then the sitemap's page; the PDF and the other site are not visited.
  assert.deepEqual(urls, ['https://shop.example/', 'https://shop.example/a', 'https://shop.example/b', 'https://shop.example/d', 'https://shop.example/c', 'https://shop.example/e']);
  assert.ok(!asked.includes('https://other.example/'));
  assert.ok(!asked.some(u => u.endsWith('.pdf')));
  assert.equal(asked.filter(u => u.endsWith('/sitemap.xml')).length, 1);
  // The missing page is recorded, not fatal; the page that left the site is not read.
  const b = r.pages.find(p => p.url.endsWith('/b'))!;
  assert.equal(b.status, 404);
  assert.match(b.error ?? '', /404/);
  const c = r.pages.find(p => p.url.endsWith('/c'))!;
  assert.equal(c.finalUrl, 'https://moved.example/c');
  assert.ok(c.flags.some(x => /led to another site/.test(x)));
  // Each question holds only its own page's words.
  const pagePrompts = prompts.filter(p => /^Check this page text/.test(p));
  assert.equal(pagePrompts.length, 5);
  for (const p of pagePrompts) {
    const names = ['welcome', 'alpha', 'delta', 'echo'].filter(w => p.includes(`${w} ${w}`));
    assert.ok(names.length <= 1, `one page per question: ${names.join(',')}`);
  }
  assert.equal(r.pages.find(p => p.url.endsWith('/d'))!.verdict, 'check');
  assert.equal(r.pages[0].verdict, 'ok');
  // Tokens: 5 pages and one overall question.
  assert.equal(r.totals.tokensIn, 500 * 6);
  assert.equal(r.totals.tokensOut, 20 * 6);
  assert.equal(r.totals.pagesRead, 5);
  assert.equal(r.totals.pagesFailed, 1);
  assert.ok(r.summary);
  assert.equal(prompts.filter(p => /^Below are the findings/.test(p)).length, 1);
  assert.match(prompts.at(-1)!, /cheap pills/);
  assert.match(prompts.at(-1)!, /evil\.example/);
  // The code's findings are in the report.
  assert.equal(r.code.thirdPartyScripts['evil.example'], 1);
  assert.ok(r.code.flags.some(f => /evil\.example/.test(f.flag)));
  assert.ok(r.code.externalLinks['other.example'] >= 1);
  // Gaps: one between each pair of pages asked for.
  assert.equal(r.gaps.list.length, 5);
  const text = reportText(r);
  assert.match(text, /Website check: https:\/\/shop\.example\//);
  assert.match(text, /5 pages read, 1 that could not be read/);
  assert.match(text, /3,000 read by the model \(.*not counted\), 120 written/);
  assert.match(text, /Found in the code \(by the program, not the model\)/);
  assert.match(text, /! https:\/\/shop\.example\/d/);
  assert.match(text, /Not checked:/);
});

test('site check: the page cap, the pace between pages, and what was not read', async () => {
  const { get } = site();
  const ask: SiteAsk = async () => ({ text: 'VERDICT: OK', tokensIn: 10, tokensOut: 2 });
  const r = await checkSite({ start: 'https://shop.example/', get, pace: new Pacer({ page: 150, jitter: 0, search: 0 }, () => 0), ask, ctx: 8192, maxPages: 2, summary: false, sitemap: false });
  assert.equal(r.pages.length, 2);
  assert.equal(r.summary, null);
  assert.ok(r.notVisited.length >= 2);
  assert.match(r.notChecked.join(' '), /more pages found on the site were not read \(the limit is 2 pages\)/);
  // The second page waited its turn at the site.
  assert.ok(r.pages[1].waitedSeconds >= 0.1, String(r.pages[1].waitedSeconds));
  assert.ok(r.gaps.min >= 0.1, String(r.gaps.min));
});

test('site check: a long page is cut to the model\'s room and said so; a failing model is recorded', async () => {
  const body = html(`<p>${'word '.repeat(20_000)}</p>`);
  const get: Fetcher = async url => ({ status: 200, type: 'text/html', body: Buffer.from(body), url });
  let n = 0;
  const seen: number[] = [];
  const ask: SiteAsk = async (_s, user) => {
    seen.push(user.length);
    if (++n === 1) throw new Error('the model stopped');
    return { text: 'no verdict line here', tokensIn: 5, tokensOut: 5 };
  };
  const r = await checkSite({ start: 'https://shop.example/', get, pace: quick(), ask, ctx: 4096, maxPages: 1, summary: false, sitemap: false });
  assert.equal(r.pages[0].cut, true);
  assert.ok(seen[0] < pageRoom(4096) + 1200, String(seen[0]));
  assert.match(r.pages[0].said, /did not answer: the model stopped/);
  assert.equal(r.pages[0].verdict, 'unclear');
  assert.match(r.notChecked.join(' '), /cut to fit the model's context/);
});

test('site check: stopping returns the report so far', async () => {
  const { get } = site();
  const stop = new AbortController();
  const ask: SiteAsk = async () => {
    stop.abort();
    return { text: 'VERDICT: OK', tokensIn: 1, tokensOut: 1 };
  };
  const r = await checkSite({ start: 'https://shop.example/', get, pace: quick(), ask, ctx: 8192, signal: stop.signal, sitemap: false });
  assert.equal(r.stopped, true);
  assert.equal(r.pages.length, 1);
  assert.equal(r.summary, null);
  assert.match(r.notChecked.join(' '), /stopped before it finished/);
});

test('site check: a bad address is refused, and the small parts', async () => {
  await assert.rejects(checkSite({ start: 'not a link', ask: async () => ({ text: '', tokensIn: 0, tokensOut: 0 }), ctx: 8192 }), /not a web address/);
  assert.equal(verdictOf('VERDICT: OK\nfine'), 'ok');
  assert.equal(verdictOf('**VERDICT: CHECK**'), 'check');
  assert.equal(verdictOf('looks fine to me'), 'unclear');
  assert.deepEqual(sitemapUrls('<loc>https://shop.example/x</loc><loc>https://other.example/y</loc><loc>https://shop.example/p.pdf</loc>', 'shop.example'), ['https://shop.example/x']);
  assert.ok(pageRoom(32768) > pageRoom(8192));
  assert.ok(pageRoom(512) >= 1500);
});
