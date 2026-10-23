import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cssBalance, isModule, runTests, syntaxCheck, testEnv, tidyError, tidyTestOutput } from '../src/checks.ts';

test('syntax checks catch broken TypeScript and module JavaScript (which node --check alone passes)', async () => {
  const r = await syntaxCheck([
    { path: 'src/a.ts', text: 'import x from "node:fs";\nconst a: number = ;\n' },
    { path: 'src/b.ts', text: 'import x from "node:fs";\nclass A { constructor(private y: number) {} }\n' },
    { path: 'src/ok.ts', text: 'import x from "node:fs";\nexport const a: number = 1;\n' },
    { path: 'web/m.js', text: 'import x from "./y.js";\nconst a = ;\n' },
    { path: 'web/app.js', text: 'const el = document.getElementById("a");\nfunction f( {\n' },
    { path: 'web/ok.js', text: 'document.getElementById("a").textContent = "hi";\n' },
    { path: 'data.json', text: '{"a": 1,}' },
    { path: 'style.css', text: '.a { color: red;\n.b { x: 1 }' },
    { path: 'notes.md', text: '# not checked' },
  ]);
  const by = Object.fromEntries(r.map(x => [x.path, x]));
  assert.equal(by['src/a.ts'].ok, false);
  assert.match(by['src/b.ts'].message, /parameter property/);
  assert.equal(by['src/ok.ts'].ok, true);
  assert.equal(by['web/m.js'].ok, false);
  assert.match(by['web/m.js'].message, /web\/m\.js|Unexpected token/);
  assert.equal(by['web/app.js'].ok, false);
  assert.doesNotMatch(by['web/app.js'].message, /sm-check-|\.cjs/);
  assert.equal(by['web/ok.js'].ok, true);
  assert.equal(by['data.json'].ok, false);
  assert.equal(by['style.css'].ok, false);
  assert.equal(by['notes.md'], undefined);
});

test('python and php files are checked when the tool is on this PC', { skip: process.platform !== 'win32' }, async () => {
  const r = await syntaxCheck([{ path: 'tool.py', text: 'def f(:\n  pass\n' }, { path: 'ok.py', text: 'print(1)\n' }, { path: 'x.php', text: '<?php echo 1 ?>' }]);
  for (const x of r) if (x.path === 'tool.py') assert.equal(x.ok, false); else assert.equal(x.ok, true, `${x.path} ${x.message}`);
});

test('module code is told from plain scripts; CSS brackets are counted outside comments and strings', () => {
  assert.equal(isModule('import x from "y"'), true);
  assert.equal(isModule('export const a = 1'), true);
  assert.equal(isModule('const imported = 1; // import x'), false);
  assert.equal(cssBalance('a { content: "}"; } /* { */ @media (x) { b { c: d } }'), '');
  assert.match(cssBalance('a { b: c;\n'), /Line 1: "\{" is never closed/);
  assert.match(cssBalance('a { b: c; } }'), /no matching/);
  assert.equal(tidyError('C:\\t\\sm-check-1\\f0.cjs:2\nfunction f( {\n            ^\n\nSyntaxError: Unexpected token\n    at wrapSafe (x)\nNode.js v24', 'C:\\t\\sm-check-1', 'web/app.js'), 'web/app.js:2\nfunction f( {\nSyntaxError: Unexpected token');
});

test('test output loses its stack lines and the workspace folder path, and keeps its start', () => {
  const root = 'C:\\Users\\me\\ws';
  const out = `✖ adds\n  500 !== 5\n      at TestContext.<anonymous> (file:///C:/Users/me/ws/tip.test.mjs:5:45)\n      at Test.run (node:internal/test_runner/test:1306:25)\nError in C:\\Users\\me\\ws\\tip.mjs\n\n\n\nend`;
  assert.equal(tidyTestOutput(out, root), '✖ adds\n  500 !== 5\nError in tip.mjs\n\nend');
});

test('tests run in the folder from the fixed list only, and report a failure with its output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-tests-'));
  try {
    assert.ok('error' in (await runTests('rm -rf', dir)));
    await writeFile(join(dir, 'a.test.mjs'), 'import test from "node:test"; import assert from "node:assert"; test("adds", () => assert.equal(1 + 1, 3));');
    const r = await runTests('node-test', dir);
    assert.ok(!('error' in r) && !r.ok && /adds/.test(r.output), JSON.stringify(r));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Run tests gets only what the test tools need: no keys, tokens, passwords or TOMLIN settings reach the code a model wrote', () => {
  const env = testEnv({
    Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\T', USERPROFILE: 'C:\\Users\\x', APPDATA: 'C:\\A', PYTHONPATH: 'C:\\py', npm_config_cache: 'C:\\npm', LANG: 'en_AU.UTF-8',
    OPENAI_API_KEY: 'sk-1', GITHUB_TOKEN: 'ghp', TOMLIN_RELEASE_KEY: 'C:\\key.pem', AWS_SECRET_ACCESS_KEY: 'x', npm_config__authToken: 'npm_1', PIP_INDEX_PASSWORD: 'p', CPANEL_PASSWORD: 'p', SOME_APP_SETTING: 'x', NODE_OPTIONS: '--inspect',
  });
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'LANG', 'PYTHONPATH', 'Path', 'SystemRoot', 'TEMP', 'USERPROFILE', 'npm_config_cache']);
});

test('a script with top-level await and no import passes, as Node runs it (tools/max-speed.ts was failed); a broken one still fails', async () => {
  const r = await syntaxCheck([
    { path: 'tools/speed.ts', text: 'const port: number = Number(process.argv[2]) || 8740;\nconst s = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { a?: number };\nconsole.log(s.a);\n' },
    { path: 'tools/plain.js', text: 'const r = await fetch("http://127.0.0.1:1/");\nconsole.log(r.status);\n' },
    { path: 'tools/broken.ts', text: 'const a: number = await f(;\n' },
    { path: 'web/app.js', text: 'function f( {\n' },
  ]);
  const by = Object.fromEntries(r.map(x => [x.path, x]));
  assert.equal(by['tools/speed.ts'].ok, true, by['tools/speed.ts'].message);
  assert.equal(by['tools/plain.js'].ok, true, by['tools/plain.js'].message);
  assert.equal(by['tools/broken.ts'].ok, false);
  assert.equal(by['web/app.js'].ok, false);
  assert.doesNotMatch(by['web/app.js'].message, /sm-check-|\.cjs|\.mjs/);
});
