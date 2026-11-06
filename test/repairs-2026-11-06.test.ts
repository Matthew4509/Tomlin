// Repairs after the 6 Nov build tests (Phase 3, continued): a fix may not remove tests to make them pass, and run and
// probe also covers a plain web page (index.html + scripts) with no server of its own, like the Flappy Bird and fitness
// builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { droppedTests } from '../src/jobs.ts';
import { detectStart, pageTargets, startAndProbe } from '../src/verify.ts';

test('droppedTests: fewer Python or JavaScript tests after a change is reported; the same or more is not', () => {
  const py = 'class T(unittest.TestCase):\n    def test_a(self): pass\n    def test_b(self): pass\n    def test_c(self): pass\n';
  assert.deepEqual(droppedTests(py, py), null);
  assert.deepEqual(droppedTests(py, py.replace('    def test_b(self): pass\n', '')), { before: 3, after: 2 });
  assert.equal(droppedTests(py, py + '    def test_d(self): pass\n'), null);
  const js = "describe('x', () => {\n  it('a', () => {});\n  it('b', () => {});\n  test('c', () => {});\n});\n";
  assert.deepEqual(droppedTests(js, "describe('x', () => {\n  it('a', () => {});\n});\n"), { before: 3, after: 1 });
  // A file with no tests, or a new file, is not a test file: nothing to compare.
  assert.equal(droppedTests('def run():\n    pass\n', ''), null);
  assert.equal(droppedTests('', py), null);
  // Words in comments or strings that look like a call are not tests: "it(" inside "submit(" does not count.
  assert.equal(droppedTests('submit(); exit(0);', ''), null);
});

test('detectStart: a plain web page with no server of its own is served as static files by Node', () => {
  const s = detectStart(['index.html', 'game.js', 'style.css'], { 'index.html': '<script src="game.js"></script>' });
  assert.ok(s);
  assert.equal(s.exe, process.execPath);
  assert.match(s.label, /static/i);
  // A project with its own server still uses it.
  const py = detectStart(['index.html', 'app.py'], { 'app.py': 'from wsgiref.simple_server import make_server' });
  assert.equal(py?.label, 'python app.py');
  // No page at the top: nothing to start.
  assert.equal(detectStart(['notes.txt'], {}), null);
});

test('pageTargets: the page itself and the scripts, styles, images and links it loads, relative or absolute; not outside ones', () => {
  const t = pageTargets({
    'index.html': '<link rel="stylesheet" href="css/style.css"><script src="./app.js"></script><img src="img/bird.png"><a href="about.html">About</a><script src="https://cdn.example.com/x.js"></script><a href="#top">Top</a>',
    'app.js': 'console.log(1)',
  });
  const paths = t.map(x => x.path).sort();
  assert.deepEqual(paths, ['/', '/about.html', '/app.js', '/css/style.css', '/img/bird.png']);
  assert.ok(t.every(x => x.method === 'GET'));
});

test('static run and probe: a page that loads a missing script is reported as a 404; the files it has answer 200', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { 'index.html': '<html><body><canvas id="c"></canvas><script src="game.js"></script><script src="missing.js"></script></body></html>', 'game.js': 'let x = 1;' };
  for (const [p, text] of Object.entries(files)) await writeFile(join(dir, p), text);
  const start = detectStart(Object.keys(files), files);
  assert.ok(start);
  const r = await startAndProbe(dir, start, pageTargets(files), [18_640, 18_641]);
  assert.equal(r.started, true, r.output || r.error);
  const by = Object.fromEntries(r.results.map(x => [x.path, x.status]));
  assert.equal(by['/'], 200);
  assert.equal(by['/game.js'], 200);
  assert.equal(by['/missing.js'], 404);
});

test('the Jobs page has a "Run and check it" tick, and LETS GO sends it as verify', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/jobs.js', import.meta.url), 'utf8');
  assert.match(html, /<label class="check" id="job-verify-row"><input type="checkbox" id="job-verify"> Run and check it/);
  assert.match(js, /'\/api\/jobs\/run', \{[^}]*verify: \$\('#job-verify'\)\.checked/);
});

test('static server: a path that climbs out of the folder is not served', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<p>hi</p>');
  const start = detectStart(['index.html'], { 'index.html': '<p>hi</p>' });
  assert.ok(start);
  const r = await startAndProbe(dir, start, [{ method: 'GET', path: '/..%2f..%2fwindows%2fwin.ini' }, { method: 'GET', path: '/%2e%2e/%2e%2e/etc/passwd' }], [18_642]);
  assert.equal(r.started, true, r.output || r.error);
  for (const x of r.results) assert.notEqual(x.status, 200);
});
