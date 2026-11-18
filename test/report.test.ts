import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_URL, buildReport, issueLink, scrub } from '../src/report.ts';

test('scrub takes out the user name in a path, addresses, keys, PINs and the query of a link', () => {
  const t = scrub('open C:\\Users\\Jane Q\\AppData\\x failed at /home/jane/y and C:/Users/jane/z; mail jane@example.com from 192.168.1.20 (127.0.0.1 stays) mac AA:BB:CC:DD:EE:FF key sk-abcdefghijklmnop1234 pin=4821 https://site.test/a/b?token=abc&u=1#frag');
  assert.doesNotMatch(t, /Jane|jane|example\.com|192\.168|AA:BB|sk-abc|4821|token=|frag/);
  assert.match(t, /C:\\Users\\<user>\\AppData\\x/);
  assert.match(t, /127\.0\.0\.1/);
  assert.match(t, /https:\/\/site\.test\/a\/b\b/);
});

test('scrub hides the names it is given as whole words, and leaves short words and other text alone', () => {
  const t = scrub('Z820 answered; the Z820-lab stayed; at home the hostname DESKTOP-ABC1 ran. It is ok.', ['Z820', 'DESKTOP-ABC1', 'ok']);
  assert.equal(t, '<name> answered; the <name>-lab stayed; at home the hostname <name> ran. It is ok.');
});

test('scrub takes out long hashes and tokens but not ordinary words', () => {
  const t = scrub(`sha ${'a1'.repeat(32)} and ${'Zx9'.repeat(15)} and llama-b10750-bin-win-cuda-12.4-x64.zip`);
  assert.match(t, /sha <hash> and <secret> and llama-b10750-bin-win-cuda-12\.4-x64\.zip/);
});

test('a report holds the plain facts, the note, the fault and the log, all scrubbed, and never a chat word', () => {
  const r = buildReport({
    version: '2.0.84',
    build: 'abc123',
    os: 'Windows 10.0.22631',
    ram: 64 * 2 ** 30,
    cards: [{ name: 'NVIDIA Quadro P2000', total: 5 * 2 ** 30 }],
    driver: '560.94',
    runners: ['llama.cpp b11284, CUDA 12.4: installed'],
    model: 'Qwen3.5-35B-A3B-Q2.gguf',
    fault: 'illegal memory access on Z820',
    note: 'It stopped when I read C:\\Users\\Jane\\Desktop\\a.txt',
    log: ['09:00:00 ERROR [llama] crash for jane@example.com', '09:00:01 WARN [x] from 10.0.0.5'],
  }, ['Z820', 'Jane']);
  assert.match(r.title, /^Report: It stopped when I read /);
  assert.match(r.body, /TOMLIN 2\.0\.84 \(build abc123\)/);
  assert.match(r.body, /Memory: 64 GB/);
  assert.match(r.body, /Quadro P2000 \(5\.0 GB\)/);
  assert.match(r.body, /illegal memory access on <name>/);
  assert.doesNotMatch(r.body, /Jane|jane|example\.com|10\.0\.0\.5|Z820/);
  assert.match(r.body, /```\n09:00:00 ERROR/);
});

test('a report with nothing typed still reads clearly, and keeps only the last 60 log lines', () => {
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const r = buildReport({ version: '2.0.84', log });
  assert.match(r.body, /\(not described\)/);
  assert.equal(r.title, 'Report: Something went wrong');
  assert.doesNotMatch(r.body, /line 39\b/);
  assert.match(r.body, /line 40\b/);
  assert.match(r.body, /line 99\b/);
});

test('the issue link carries the report; one too long for a link is shortened with a line that says so', () => {
  const short = issueLink('Matthew4509/Tomlin', { title: 'Report: x', body: 'hello there' });
  assert.equal(short.cut, false);
  assert.equal(short.url, 'https://github.com/Matthew4509/Tomlin/issues/new?title=Report%3A%20x&body=hello%20there');
  const long = issueLink('Matthew4509/Tomlin', { title: 'Report: x', body: 'é\n'.repeat(5000) });
  assert.equal(long.cut, true);
  assert.ok(long.url.length <= MAX_URL);
  assert.match(decodeURIComponent(long.url), /Shortened: paste the rest of the copied report here/);
});

test('Help has Report a problem, its window, the route, and the editor of the report is scrubbed again', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="report-open">Report a problem</);
  assert.match(html, /<dialog id="report-dlg"/);
  assert.match(html, /This sends nothing by itself/);
  const route = readFileSync(new URL('../src/server/settings.ts', import.meta.url), 'utf8');
  assert.match(route, /'\/api\/report'/);
  assert.match(route, /scrub\(edited\.body/);
  const js = readFileSync(new URL('../public/chatview.js', import.meta.url), 'utf8');
  assert.match(js, /app\.openReport = /);
  assert.match(js, /window\.open\(r\.url, '_blank', 'noopener'\)/);
});
