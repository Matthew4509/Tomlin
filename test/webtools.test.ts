// The web tools (src/webtools.ts): addresses in a text, a search engine's answer read back, a page turned into words,
// and one answer's use of the tools: only addresses given in the chat are opened, a long page comes in parts, the room
// in the model's context is kept, and this PC or the home network is never reached.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as w from '../src/webtools.ts';

const DDG = [
  '<div class="result results_links results_links_deep result--ad "><a class="result__a" href="//duckduckgo.com/y.js?ad_provider=x">Buy now</a></div>',
  '<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fggml%2Dorg%2Fllama.cpp%2Freleases&amp;rut=d80f">Releases: <b>ggml-org/llama.cpp</b> - GitHub</a></h2>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">LLM inference in C/C++ &amp; more.</a></div>',
  '<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcuda%2D13%23top&amp;rut=1">CUDA 13 on Windows</a></h2>',
  '<a class="result__snippet" href="x">Setting up <b>llama.cpp</b> with CUDA 13.</a></div>',
].join('\n');

test('addresses in a text: http(s) only, without a #part, a closing full stop or an unopened bracket', () => {
  assert.deepEqual(w.urlsIn('See https://example.com/a. And (https://example.org/b) or https://en.wikipedia.org/wiki/Foo_(bar), http://x.io/p?q=1#top!'), ['https://example.com/a', 'https://example.org/b', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'http://x.io/p?q=1']);
  assert.deepEqual(w.urlsIn('mailto:a@b.com ftp://x.org file:///C:/x'), []);
  assert.equal(w.normalUrl('https://user:pw@example.com/'), null);
  assert.equal(w.normalUrl('HTTPS://Example.COM/a#b'), 'https://example.com/a');
  assert.equal(w.normalUrl('javascript:alert(1)'), null);
});

test('DuckDuckGo\'s results read back: ads left out, each address taken out of its redirect, tags and entities gone', () => {
  const r = w.parseDuckDuckGo(DDG);
  assert.deepEqual(r, [
    { title: 'Releases: ggml-org/llama.cpp - GitHub', url: 'https://github.com/ggml-org/llama.cpp/releases', snippet: 'LLM inference in C/C++ & more.' },
    { title: 'CUDA 13 on Windows', url: 'https://example.com/cuda-13', snippet: 'Setting up llama.cpp with CUDA 13.' },
  ]);
});

test('a page as words: the main part, headings and list items on lines of their own, no scripts or menus, its links made whole', () => {
  const html = `<html><head><title>Fast &amp; local</title><style>p{}</style></head><body><nav><a href="/menu">Menu</a></nav>
    <main><h1>Running models</h1><p>A model runs on your own PC.&nbsp;It is private.</p><script>steal()</script>
    <ul><li>CUDA 12.4</li><li>CUDA 13.4</li></ul><p>Read <a href="/docs/cuda#x">the CUDA notes</a> or <a href="mailto:a@b.c">mail</a> or <a href="https://other.org/x">another site</a>.</p>
    ${'<p>More words here to make the main part long enough to be the page.</p>'.repeat(8)}</main><footer>(c) 2026</footer></body></html>`;
  const p = w.pageText(html, 'https://example.com/guide/');
  assert.equal(p.title, 'Fast & local');
  assert.match(p.text, /^# Running models\nA model runs on your own PC\. It is private\.\n- CUDA 12\.4\n- CUDA 13\.4\nRead the CUDA notes or mail or another site \./);
  assert.ok(!/steal|Menu|\(c\) 2026|p\{\}/.test(p.text));
  assert.deepEqual(p.links, [{ text: 'the CUDA notes', url: 'https://example.com/docs/cuda' }, { text: 'another site', url: 'https://other.org/x' }]);
  assert.equal(w.decodeEntities('&#8212; &#x2014; &bogus; &#xD800;'), '— — &bogus; ');
});

test('search settings: only known values kept; Brave needs a key and SearXNG an address', () => {
  assert.deepEqual(w.cleanSearch({ provider: 'brave', key: ' BSA-abc_123456 ', url: 'not a url' }), { provider: 'brave', key: 'BSA-abc_123456' });
  assert.deepEqual(w.cleanSearch({ provider: 'searxng', url: 'http://192.168.0.5:8888/' }), { provider: 'searxng', url: 'http://192.168.0.5:8888' });
  assert.deepEqual(w.cleanSearch({ provider: 'google', key: 'x y' }), { provider: 'duckduckgo' });
  assert.deepEqual(w.cleanSearch({ provider: 'searxng', url: 'http://me:pw@host/' }), { provider: 'searxng' });
  assert.match(w.searchWhy({ provider: 'brave' }), /needs its key/);
  assert.match(w.searchWhy({ provider: 'searxng' }), /needs its address/);
  assert.equal(w.searchWhy({ provider: 'duckduckgo' }), '');
});

/** A stand-in for the web: answers by address, and keeps what it was asked. */
function web(pages: Record<string, { status?: number; type?: string; body: string }>) {
  const asked: { url: string; publicOnly: boolean; headers?: Record<string, string> }[] = [];
  const get: w.Fetcher = async (url, o) => {
    asked.push({ url, publicOnly: o.publicOnly, headers: o.headers });
    const p = pages[url] ?? pages[url.replace(/\?.*$/, '')];
    if (!p) return { status: 404, type: 'text/html', body: Buffer.from('nope'), url };
    return { status: p.status ?? 200, type: p.type ?? 'text/html; charset=utf-8', body: Buffer.from(p.body), url };
  };
  return { get, asked };
}

/** A pacer with no waits, so the tests below that are not about pacing run at once. */
const QUICK = new w.Pacer({ page: 0, jitter: 0, search: 0 });
const OPTS = { search: { provider: 'duckduckgo' as const }, perCall: 6000, total: 20000, pace: QUICK };
const never = new AbortController().signal;

test('only an address given in the chat is opened: one the person wrote, a search result, or a link on a page read', async () => {
  const site = web({
    'https://html.duckduckgo.com/html/': { body: DDG },
    'https://example.com/cuda-13': { body: '<title>CUDA 13</title><p>Install the CUDA 13.4 build.</p><a href="/next">Next page</a>' },
    'https://example.com/next': { body: '<p>The next page.</p>' },
    'https://mine.example/notes': { body: '<p>My notes.</p>' },
  });
  const t = new w.WebTurn(['Please read https://mine.example/notes.'], { ...OPTS, get: site.get });
  // Made up by the model (or by words on a page): refused, and nothing is fetched.
  assert.match(await t.run('open_page', '{"url":"https://evil.example/?chat=secret"}', never), /^Not opened: that address was not given in this chat/);
  assert.ok(!site.asked.some(a => a.url.includes('evil')));
  assert.match(await t.run('open_page', '{"url":"https://mine.example/notes"}', never), /My notes\./);
  const found = await t.run('web_search', '{"query":"llama.cpp cuda 13"}', never);
  assert.match(found, /^Results for "llama\.cpp cuda 13" \(DuckDuckGo\):\n1\. Releases: ggml-org\/llama\.cpp - GitHub\n {3}https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases/);
  assert.equal(site.asked.find(a => a.url.startsWith('https://html.duckduckgo.com/'))?.url, 'https://html.duckduckgo.com/html/?q=llama.cpp%20cuda%2013');
  // A search result, with or without a final slash.
  const page = await t.run('open_page', '{"url":"https://example.com/cuda-13/"}', never);
  assert.match(page, /^Page: CUDA 13\nAddress: https:\/\/example\.com\/cuda-13\n\nInstall the CUDA 13\.4 build\.\nNext page\n\nLinks on this page \(open_page can open these\):\n- Next page: https:\/\/example\.com\/next$/);
  // A link on a page read.
  assert.match(await t.run('open_page', '{"url":"https://example.com/next"}', never), /The next page\./);
  assert.ok(site.asked.every(a => a.publicOnly));
  assert.deepEqual(t.uses.map(u => [u.name, u.ok, u.said]), [
    ['open_page', false, 'not opened: not an address given in this chat'],
    ['open_page', true, 'mine.example, 2 words'],
    ['web_search', true, '2 results'],
    ['open_page', true, 'CUDA 13, 7 words'],
    ['open_page', true, 'example.com, 3 words'],
  ]);
});

test('a long page comes in parts; the room in the context runs out, and the model is told to answer; bad calls are told plainly', async () => {
  const long = Array.from({ length: 600 }, (_, i) => `<p>Sentence number ${i} about local models.</p>`).join('');
  const site = web({ 'https://example.com/long': { body: long } });
  const t = new w.WebTurn(['https://example.com/long'], { ...OPTS, perCall: 4000, total: 9000, get: site.get });
  const first = await t.run('open_page', '{"url":"https://example.com/long"}', never);
  assert.match(first, /^Page: \(no title\)\nAddress: https:\/\/example\.com\/long\nPart 1 of \d+: ask open_page with part 2 for the next part\.\n\nSentence number 0 /);
  const second = await t.run('open_page', '{"url":"https://example.com/long","part":2}', never);
  assert.match(second, /Part 2 of \d+/);
  assert.equal(site.asked.length, 1, 'the page is read once, its parts given from memory');
  // 9,000 characters in all: the third part does not fit whole, the fourth not at all.
  await t.run('open_page', '{"url":"https://example.com/long","part":3}', never);
  assert.match(await t.run('open_page', '{"url":"https://example.com/long","part":4}', never), /^There is no room left in this conversation for more from the web\. Answer now/);
  assert.match(await t.run('open_page', '{"url": nope}', never), /not valid JSON/);
  assert.match(await t.run('delete_files', '{}', never), /There is no tool called delete_files/);
  assert.match(await t.run('web_search', '{"query":""}', never), /Say what to search for/);
});

test('a PDF is read for its words, named from its address even when that address has a broken %-escape', async () => {
  // A one-page PDF with the words "Hello PDF" (a minimal file, written out here).
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 12 Tf 20 50 Td (Hello PDF) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const at: number[] = [];
  objects.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const site = web({ 'https://example.com/report%E0.pdf': { type: 'application/pdf', body: pdf } });
  const t = new w.WebTurn(['https://example.com/report%E0.pdf'], { ...OPTS, get: site.get });
  const out = await t.run('open_page', '{"url":"https://example.com/report%E0.pdf"}', never);
  assert.match(out, /^Page: report%E0\.pdf\n/);
  assert.match(out, /\[Page 1\]\nHello PDF/);
  assert.equal(t.uses[0].ok, true);
});

test('a page that cannot be read says why; a PDF\'s text and a plain-text page are read too', async () => {
  const site = web({
    'https://example.com/gone': { status: 404, body: '' },
    'https://example.com/locked': { status: 403, body: '' },
    'https://example.com/pic': { type: 'image/png', body: 'png' },
    'https://example.com/notes.txt': { type: 'text/plain', body: 'Plain words.\n' },
  });
  const t = new w.WebTurn(['https://example.com/gone https://example.com/locked https://example.com/pic https://example.com/notes.txt'], { ...OPTS, get: site.get });
  assert.match(await t.run('open_page', '{"url":"https://example.com/gone"}', never), /no page at that address \(404\)/);
  assert.match(await t.run('open_page', '{"url":"https://example.com/locked"}', never), /refused to show it \(403\)/);
  assert.match(await t.run('open_page', '{"url":"https://example.com/pic"}', never), /not a page with words to read \(image\/png\)/);
  // A fourth page in the next round (3 in one go is the most).
  assert.match(await t.run('open_page', '{"url":"https://example.com/notes.txt"}', never, 1), /Plain words\./);
  assert.deepEqual(t.uses.map(u => u.ok), [false, false, false, true]);
});

test('a search engine that holds back searches, refuses a key, or is not set up is said plainly to the model', async () => {
  const blocked = web({ 'https://html.duckduckgo.com/html/': { status: 202, body: '<div class="anomaly-modal">' } });
  const t = new w.WebTurn([], { ...OPTS, get: blocked.get });
  assert.match(await t.run('web_search', '{"query":"x"}', never), /^The search did not work: DuckDuckGo did not give results just now/);
  assert.equal(t.uses[0].ok, false);
  const brave = web({ 'https://api.search.brave.com/res/v1/web/search': { type: 'application/json', body: JSON.stringify({ web: { results: [{ title: 'A', url: 'https://a.example/', description: 'about <strong>A</strong>' }] } }) } });
  assert.deepEqual(await w.searchWeb('a', { provider: 'brave', key: 'BSA-12345678' }, never, brave.get), [{ title: 'A', url: 'https://a.example/', snippet: 'about A' }]);
  assert.equal(brave.asked[0].headers?.['X-Subscription-Token'], 'BSA-12345678');
  const sx = web({ 'http://192.168.0.5:8888/search': { type: 'application/json', body: JSON.stringify({ results: [{ title: 'B', url: 'https://b.example/x', content: 'about B' }] }) } });
  assert.deepEqual(await w.searchWeb('b', { provider: 'searxng', url: 'http://192.168.0.5:8888' }, never, sx.get), [{ title: 'B', url: 'https://b.example/x', snippet: 'about B' }]);
  assert.equal(sx.asked[0].publicOnly, false, 'your own SearXNG may be on your home network');
  await assert.rejects(w.searchWeb('c', { provider: 'brave' }, never, brave.get), /needs its key/);
});

const local = createServer((_req, res) => res.end('<p>this PC</p>'));
await new Promise<void>(r => local.listen(0, '127.0.0.1', r));
const port = (local.address() as AddressInfo).port;
after(() => local.close());

test('this PC and the home network are never reached by a page read, by address or by a name that points there', async () => {
  const opts = { signal: never, maxBytes: 1 << 20, publicOnly: true };
  await assert.rejects(w.fetchPublic(`http://127.0.0.1:${port}/`, opts), /this PC or a home network address/);
  await assert.rejects(w.fetchPublic(`http://localhost:${port}/`, opts), /points at this PC or a home network address/);
  await assert.rejects(w.fetchPublic('http://[::1]:9/', opts), /this PC or a home network address/);
  await assert.rejects(w.fetchPublic('http://192.168.0.77:8740/', opts), /this PC or a home network address/);
  await assert.rejects(w.fetchPublic('file:///C:/Windows/win.ini', opts), /file address/);
  // The same request, not limited to the public web (only your own SearXNG is asked so), does reach it.
  const r = await w.fetchPublic(`http://127.0.0.1:${port}/`, { ...opts, publicOnly: false });
  assert.equal(r.body.toString(), '<p>this PC</p>');
});

test('what crosses the link: Web on as a linked PC sends it (sizes kept in bounds), the uses it sends back, the status words', () => {
  assert.equal(w.cleanWebAsk(null), null);
  assert.equal(w.cleanWebAsk(['x']), null);
  assert.deepEqual(w.cleanWebAsk({ seed: ['see https://a.example/', 7, 'x'.repeat(30_000)], perCall: 99_999, total: 5 }), { seed: ['see https://a.example/', 'x'.repeat(20_000)], perCall: 12_000, total: 2000 });
  assert.deepEqual(w.cleanWebAsk({}), { seed: [], perCall: 4000, total: 12_000 });
  assert.deepEqual(w.cleanUse({ name: 'open_page', input: 'https://a.example/', ok: true, said: 'A, 10 words', extra: 1 }), { name: 'open_page', input: 'https://a.example/', ok: true, said: 'A, 10 words' });
  assert.equal(w.cleanUse({ name: 'delete_files', input: 'x', said: 'y' }), null);
  assert.equal(w.callWords('web_search', '{"query":"cuda 13"}'), 'Searching the web: “cuda 13”…');
  assert.equal(w.callWords('open_page', '{"url":"https://example.com/a","part":2}'), 'Reading example.com (part 2)…');
  assert.equal(w.callWords('open_page', 'not json'), 'Looking something up…');
});

test('a person\'s pace: the same site waits its turn and says so, another site does not, searches wait longer', async () => {
  const p = new w.Pacer({ page: 5000, jitter: 2000, search: 10_000 }, () => 0.5);
  assert.equal(p.pageGap(), 6000, '5 s and up to 2 s more');
  assert.equal(p.book('search', 10_000), 0);
  assert.ok(p.book('search', 10_000) > 9900, 'the next search waits 10 s');
  assert.equal(p.book('github.com', 6000), 0);
  assert.equal(p.book('example.com', 6000), 0, 'another site is not held up');
  p.hold('example.com', 30_000);
  assert.ok(p.book('example.com', 6000) > 29_900, 'a site that asked for a wait is waited for');
  assert.equal(w.siteOf('https://www.GitHub.com/a'), 'github.com');
  assert.equal(w.retryAfterMs('30'), 30_000);
  assert.equal(w.retryAfterMs(new Date(Date.now() + 20_000).toUTCString()) !== null, true);
  assert.equal(w.retryAfterMs(undefined), null);
  assert.equal(w.retryAfterMs('soon'), null);

  // Real waits, small: two pages on one site 1.5 s apart, with the waiting line and the reading line put back.
  const site = web({ 'https://example.com/a': { body: '<p>A.</p>' }, 'https://example.com/b': { body: '<p>B.</p>' }, 'https://other.example/c': { body: '<p>C.</p>' } });
  const said: string[] = [];
  const t = new w.WebTurn(['https://example.com/a https://example.com/b https://other.example/c'], { ...OPTS, get: site.get, pace: new w.Pacer({ page: 1500, jitter: 0, search: 0 }), onStatus: s => said.push(s) });
  const t0 = Date.now();
  await t.run('open_page', '{"url":"https://example.com/a"}', never);
  await t.run('open_page', '{"url":"https://other.example/c"}', never);
  assert.ok(Date.now() - t0 < 500, 'another site is read at once');
  await t.run('open_page', '{"url":"https://example.com/b"}', never);
  assert.ok(Date.now() - t0 >= 1400, 'the same site waited');
  assert.deepEqual(said, ['Waiting 2 s before the next page on example.com…', 'Reading example.com…']);

  // Stopping the answer stops a wait at once.
  const slow = new w.WebTurn(['https://example.com/a https://example.com/b'], { ...OPTS, get: site.get, pace: new w.Pacer({ page: 60_000, jitter: 0, search: 0 }) });
  await slow.run('open_page', '{"url":"https://example.com/a"}', never);
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error('stopped')), 50);
  await assert.rejects(slow.run('open_page', '{"url":"https://example.com/b"}', stop.signal), /stopped/);
});

test('3 pages in one go and 8 in an answer; parts of a page already read are not counted', async () => {
  const pages: Record<string, { body: string }> = {};
  for (let i = 1; i <= 10; i++) pages[`https://example.com/p${i}`] = { body: `<p>Page ${i}.</p>` };
  pages['https://example.com/long'] = { body: Array.from({ length: 400 }, (_, i) => `<p>Line ${i} of a long page.</p>`).join('') };
  const site = web(pages);
  const t = new w.WebTurn([Object.keys(pages).join(' ')], { ...OPTS, perCall: 3000, total: 200_000, get: site.get });
  const open = (u: string, round: number, part = 1) => t.run('open_page', JSON.stringify({ url: `https://example.com/${u}`, part }), never, round);
  for (const u of ['p1', 'p2', 'long']) assert.match(await open(u, 0), /^Page:/);
  assert.match(await open('long', 0, 2), /Part 2 of/, 'a further part is not a fetch');
  assert.match(await open('p3', 0), /^Not opened yet: 3 pages are being read in this go, the most at once/);
  for (const u of ['p3', 'p4', 'p5']) assert.match(await open(u, 1), /^Page:/);
  for (const u of ['p6', 'p7']) assert.match(await open(u, 2), /^Page:/);
  assert.match(await open('p8', 2), /^Not opened: 8 pages have been read for this answer, the most one answer reads\. Answer now/);
  assert.equal(site.asked.length, 8);
  assert.deepEqual(t.uses.filter(u => !u.ok).map(u => u.said), ['not opened: 3 pages asked for in one go already', 'not opened: 8 pages read in this answer already']);
});

test('a site that says too many requests or busy is waited for once, as long as it asks; a second no leaves it alone', async () => {
  const said: string[] = [];
  let n = 0;
  const statuses: Record<string, { status: number; retryAfter?: string }[]> = {
    'https://busy.example/a': [{ status: 429, retryAfter: '0' }, { status: 200 }],
    'https://down.example/a': [{ status: 503, retryAfter: '0' }, { status: 503, retryAfter: '0' }],
    'https://slow.example/a': [{ status: 429, retryAfter: '3600' }],
    'https://html.duckduckgo.com/html/': [{ status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }],
  };
  const get: w.Fetcher = async url => {
    n++;
    const key = url.replace(/\?.*$/, '');
    const s = statuses[key].shift() ?? { status: 200 };
    return { status: s.status, type: 'text/html', body: Buffer.from(s.status === 200 ? '<p>Fine now.</p>' : 'Slow down'), url, ...(s.retryAfter ? { retryAfter: s.retryAfter } : {}) };
  };
  const t = new w.WebTurn(['https://busy.example/a https://down.example/a https://down.example/b https://slow.example/a'], { ...OPTS, get, onStatus: s => said.push(s) });
  assert.match(await t.run('open_page', '{"url":"https://busy.example/a"}', never), /Fine now\./);
  assert.deepEqual(said, ['busy.example asked to slow down (429): waiting 1 s…', 'Reading busy.example…']);
  assert.match(await t.run('open_page', '{"url":"https://down.example/a"}', never), /^The page could not be read: down\.example said it is busy \(503\) and still said no after a wait, so it is not asked again in this answer\.$/);
  const before = n;
  assert.match(await t.run('open_page', '{"url":"https://down.example/b"}', never), /^Not opened: down\.example asked to slow down earlier in this answer/);
  assert.equal(n, before, 'nothing more is sent to it');
  assert.match(await t.run('open_page', '{"url":"https://slow.example/a"}', never), /slow\.example asked to slow down \(429\) and asked for a wait of over a minute/);
  assert.match(await t.run('web_search', '{"query":"x"}', never), /^The search did not work: DuckDuckGo asked to slow down \(429\) and still said no after a wait/);
  assert.match(await t.run('web_search', '{"query":"y"}', never), /^Not searched: DuckDuckGo asked to slow down earlier in this answer/);
});

test('a page that never closes a tag is read in one pass (it used to hold the server for minutes), as a browser would', () => {
  const kb = 300 * 1024;
  const cases: Record<string, string> = {
    comment: '<!-- x'.repeat(kb / 6),
    script: '<script>x'.repeat(kb / 9),
    svg: '<svg>x'.repeat(kb / 6),
    link: '<a href=https://e.example/x>w '.repeat(kb / 30),
    main: '<main>x'.repeat(kb / 7),
    nav: '<nav>x'.repeat(kb / 6),
    stray: '<x '.repeat(kb / 3),
    heading: '<h1 x'.repeat(kb / 5),
  };
  for (const [name, junk] of Object.entries(cases)) {
    const t0 = Date.now();
    w.pageText(`<p>Before the junk.</p>${junk}`, 'https://e.example/');
    assert.ok(Date.now() - t0 < 1000, `${name}: ${Date.now() - t0} ms`);
  }
  // What a browser shows: a script or comment that never closes takes the rest with it; a nav that never closes only
  // loses its tag; words before stay.
  assert.equal(w.pageText('<p>Kept.</p><script>var a = 1 < 2;<p>Gone', 'https://e.example/').text, 'Kept.');
  assert.equal(w.pageText('<p>Kept.</p><!-- note <p>Gone', 'https://e.example/').text, 'Kept.');
  assert.equal(w.pageText('<p>Kept.</p><nav><p>Still here.</p>', 'https://e.example/').text, 'Kept.\nStill here.');
  assert.equal(w.pageText('<p>1 < 2 and 3 > 2.</p>', 'https://e.example/').text, '1 < 2 and 3 > 2.');
  // A tag's name is whole: GitHub's <select-menu> is not a <select> (taking it for one lost a whole page).
  assert.equal(w.pageText('<select-menu><p>Menu words.</p></select-menu><p>The release notes.</p><a-b>x</a-b>', 'https://e.example/').text, 'Menu words.\nThe release notes.\nx');
  // Links still found, with an </abbr> inside not taken for the end of the link.
  assert.deepEqual(w.pageText('<p><a href="/one">One <abbr>A</abbr> link</a> and <a href=\'/two\'>Two</a></p>', 'https://e.example/').links, [{ text: 'One A link', url: 'https://e.example/one' }, { text: 'Two', url: 'https://e.example/two' }]);
  // A page is read up to 2 MB of its HTML.
  const big = w.pageText(`<p>Start.</p>${'<p>Filler words here.</p>'.repeat(200_000)}<p>Past the end.</p>`, 'https://e.example/');
  assert.ok(big.text.startsWith('Start.') && !big.text.includes('Past the end.'));
});
