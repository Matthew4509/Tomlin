// Run and probe (6 Nov 2026): after the last step a job can start the project it made, ask for every page and form
// its own pages point to, run its own tests, and turn what fails into fix steps. Opt-in per run (code from the
// workspace only runs when the person asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStart, detectTest, judgeProbes, linkTargets, portsOf, probeFixStep, startAndProbe, type Target } from '../src/verify.ts';
import type { Job } from '../src/jobs.ts';

const job = (): Job => ({ id: '20261106-1200-abcd', goal: 'a blog', created: '', updated: '', notes: '', steps: [
  { title: 'Server', role: 'coder', files: ['app.py'], brief: 'x', check: '', status: 'done', summary: '', wrote: [] },
] });

test('linkTargets: forms with their method, links and fetches; no placeholders, outside addresses or fragments', () => {
  const t = linkTargets({
    'templates.py': `<form method="post" action="/admin/login"> <form action="/search"> <a href="/post/{slug}">x</a> <a href="/about?x=1#top">a</a>
      <a href="https://example.com/x">e</a> <a href="#top">t</a> <a href="mailto:a@b.c">m</a> <a href="/post/<slug>">s</a> fetch("/api/items")`,
  });
  assert.deepEqual(t.map(x => `${x.method} ${x.path}`).sort(), ['GET /about', 'GET /api/items', 'GET /search', 'POST /admin/login']);
});

test('linkTargets: the same target once, and no more than 40', () => {
  const many = Array.from({ length: 80 }, (_, i) => `<a href="/p${i}">x</a>`).join('');
  assert.equal(linkTargets({ 'a.html': many + many }).length, 40);
});

test('detectStart: a Python web file, a Node server, an npm start; nothing for a plain script', () => {
  assert.deepEqual(detectStart(['app.py', 'db.py'], { 'app.py': 'from wsgiref.simple_server import make_server\nmake_server("", 8000, application).serve_forever()' })?.args, ['app.py']);
  assert.equal(detectStart(['app.py'], { 'app.py': 'print("hello")' }), null);
  assert.deepEqual(detectStart(['server.js'], { 'server.js': 'app.listen(3000)' })?.args, ['server.js']);
  assert.equal(detectStart(['package.json', 'x.js'], { 'package.json': '{"scripts":{"start":"node x.js"}}', 'x.js': '' })?.label, 'npm start');
  assert.equal(detectStart([], {}), null);
});

test('detectTest: unittest for test_*.py, npm test for a test script, node --test for *.test.js', () => {
  assert.equal(detectTest(['app.py', 'test_app.py'], {}), 'unittest');
  assert.equal(detectTest(['package.json'], { 'package.json': '{"scripts":{"test":"jest"}}' }), 'npm-test');
  assert.equal(detectTest(['a.test.js'], {}), 'node-test');
  assert.equal(detectTest(['app.py'], {}), null);
});

test('portsOf: ports written in the code first, then the usual ones, each once', () => {
  const p = portsOf({ 'app.py': 'make_server("", 8123, app)\nPORT = 9001' });
  assert.deepEqual(p.slice(0, 2), [8123, 9001]);
  assert.ok(p.includes(8000) && p.includes(3000));
  assert.equal(new Set(p).size, p.length);
});

test('judgeProbes: a 404 on something the pages point to, a 5xx and no answer are faults; 200, 3xx, 4xx other than 404 are not', () => {
  const r = judgeProbes([
    { method: 'POST', path: '/admin/login', status: 404 }, { method: 'GET', path: '/x', status: 500 }, { method: 'GET', path: '/y', status: null },
    { method: 'GET', path: '/', status: 200 }, { method: 'POST', path: '/admin', status: 302 }, { method: 'POST', path: '/admin/import', status: 400 }, { method: 'GET', path: '/admin', status: 401 },
  ]);
  assert.equal(r.length, 3);
  assert.match(r[0], /POST \/admin\/login.*404/);
  assert.match(r[1], /\/x.*500/);
  assert.match(r[2], /\/y.*no answer/i);
});

test('probeFixStep: a coder step on the files that name the failing paths, with the faults in the brief', () => {
  const s = probeFixStep(job(), ['POST /admin/login answers 404.'], ['app.py', 'templates.py', 'db.py', 'test_app.py'], { 'templates.py': '<form action="/admin/login">', 'app.py': 'if path == "/admin":', 'db.py': '', 'test_app.py': '' });
  assert.equal(s.role, 'coder');
  assert.equal(s.status, 'todo');
  assert.ok(s.files.includes('templates.py') && s.files.includes('app.py'));
  assert.ok(s.files.length <= 4);
  assert.match(s.brief, /\/admin\/login/);
  assert.match(s.title, /run/i);
});

test('startAndProbe: starts a real tiny app, finds its port, and reports the page it does not serve; kills it after', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
  const code = (login: boolean) => `import os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nclass H(BaseHTTPRequestHandler):\n  def log_message(self, *a): pass\n  def _go(self):\n    ok = self.path == "/" or ${login ? 'self.path == "/login"' : 'False'}\n    self.send_response(200 if ok else 404); self.end_headers(); self.wfile.write(b"hi")\n  do_GET = _go\n  do_POST = _go\nHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8765"))), H).serve_forever()\n`;
  await writeFile(join(dir, 'app.py'), code(false));
  const start = { label: 'python app.py', exe: 'python', args: ['app.py'] };
  const targets: Target[] = [{ method: 'GET', path: '/' }, { method: 'POST', path: '/login' }];
  const bad = await startAndProbe(dir, start, targets, [8765]);
  if (bad.error && /spawn|ENOENT/.test(bad.error)) return t.skip('python is not installed');
  assert.equal(bad.started, true, bad.error ?? bad.output);
  assert.deepEqual(judgeProbes(bad.results).map(x => x.replace(/\s+/g, ' ')).length, 1);
  await writeFile(join(dir, 'app.py'), code(true));
  const good = await startAndProbe(dir, start, targets, [8765]);
  assert.equal(good.started, true);
  assert.deepEqual(judgeProbes(good.results), []);
  // it was killed: the port answers nobody now
  const gone = await fetch(`http://127.0.0.1:${good.port}/`).then(() => false, () => true);
  assert.equal(gone, true, 'the app is still running');
});

test('startAndProbe: an app that stops at once says so with its output', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
  await writeFile(join(dir, 'app.py'), 'raise SystemExit("boom: cannot start")\n');
  const r = await startAndProbe(dir, { label: 'python app.py', exe: 'python', args: ['app.py'] }, [{ method: 'GET', path: '/' }], [8766]);
  if (r.error && /spawn|ENOENT/.test(r.error)) return t.skip('python is not installed');
  assert.equal(r.started, false);
  assert.match(r.output, /boom/);
});

// ---- The two-tries rule (the starter prompt, 6 Nov: "if the same fix fails twice, stop. Explain the cause and what you've tried, and wait for me") ----
import { STEP_TRIES, VERIFY_ROUNDS } from '../src/jobs.ts';
import { haltReport, verifyDecision } from '../src/verify.ts';

test('the rule: a step is tried twice, and a finished job is repaired twice, then it stops', () => {
  assert.equal(STEP_TRIES, 2);
  assert.equal(VERIFY_ROUNDS, 2);
});

test('verifyDecision: nothing wrong is ok; a first or changed fault is fixed; the same fault again, or the last round, halts', () => {
  const a = ['POST /admin/login answers 404.'], b = ['GET /x answers 500.'];
  assert.equal(verifyDecision([], 0, undefined), 'ok');
  assert.equal(verifyDecision(a, 0, undefined), 'fix');
  assert.equal(verifyDecision(b, 1, a), 'fix', 'a different fault after a fix is progress');
  assert.equal(verifyDecision(a, 1, a), 'halt', 'the same fault after a fix');
  assert.equal(verifyDecision(b, VERIFY_ROUNDS, a), 'halt', 'no rounds left');
  assert.equal(verifyDecision([...a].reverse(), 1, a), 'halt', 'order does not matter');
});

test('haltReport: the faults, what was tried, and a question for the person; short', () => {
  const r = haltReport(['POST /admin/login answers 404.', 'test_app: 4 failed'], ['Fix what running the project showed: changed app.py and templates.py']);
  assert.match(r, /POST \/admin\/login answers 404/);
  assert.match(r, /changed app\.py/);
  assert.match(r, /tried/i);
  assert.match(r, /what I need from you|tell me/i);
  assert.ok(r.length < 1500);
  assert.match(haltReport(['x'], []), /nothing yet|no fix/i);
});

// ---- A repair that makes things worse is undone (found on the first self-repair of the blog, 6 Nov: round 2 removed the server start) ----
import { isWorse } from '../src/verify.ts';

test('isWorse: more faults, or a project that no longer starts, is worse; fewer or the same is not', () => {
  const a = ['POST /admin/login answers 404.', 'python -m unittest fails: x'];
  assert.equal(isWorse(a, ['POST /admin/login answers 404.']), false, 'fewer');
  assert.equal(isWorse(a, [...a].reverse()), false, 'the same');
  assert.equal(isWorse(a, [...a, 'GET /x answers 500.']), true, 'more');
  assert.equal(isWorse(['GET /x answers 500.', 'GET /y answers 500.'], ['The project did not start (python app.py): boom']), true, 'a project that does not start is worse even with fewer lines');
  assert.equal(isWorse(['The project did not start (python app.py): boom'], ['The project did not start (python app.py): other']), false, 'it did not start before either');
  assert.equal(isWorse([], []), false);
});

test('probeFixStep: the brief asks for small edits, names the paths, and says what must stay', () => {
  const s = probeFixStep(job(), ['POST /admin/login answers 404: x.', 'GET /y answers 500: y.'], ['app.py', 'templates.py'], { 'templates.py': '<form action="/admin/login">', 'app.py': 'if path == "/admin":' });
  assert.match(s.brief, /few lines/i);
  assert.match(s.brief, /do not remove|keep every/i);
  assert.match(s.brief, /\/admin\/login/);
  assert.match(s.brief, /session|cookie|redirect/i, 'it says what a working login needs');
});

test('probeFixStep: files are kept to what a whole-file answer can hold, the server file first', () => {
  const big = 'x'.repeat(9000);
  const files = ['app.py', 'templates.py', 'feed.py', 'db.py'];
  const texts = { 'app.py': 'from wsgiref import simple_server\nif path == "/admin/login":\n' + big, 'templates.py': '<form action="/admin/login">' + big, 'feed.py': big, 'db.py': big };
  const s = probeFixStep(job(), ['POST /admin/login answers 404: x.'], files, texts);
  assert.equal(s.files[0], 'app.py');
  assert.ok(s.files.reduce((n, f) => n + (texts[f as keyof typeof texts]?.length ?? 0), 0) <= 16000, s.files.join(','));
  assert.deepEqual(s.files, ['app.py']);
});
