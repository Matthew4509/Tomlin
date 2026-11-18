// What a node says about itself to its host: its processor (src/nodecpu.ts) in the hello, never to a guest, through
// /api/remotes to the Cluster page; lines that were only in the console window now also in the log; the Log part of a
// linked PC's window. Read from the files themselves where the part needs the whole server. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanCpu } from '../src/nodecpu.ts';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

test('a processor from a hello is checked; an older node sends none', () => {
  assert.deepEqual(cleanCpu({ name: ' AMD Ryzen 9 7950X 16-Core Processor ', cores: 16, threads: 32 }), { name: 'AMD Ryzen 9 7950X 16-Core Processor', cores: 16, threads: 32 });
  assert.deepEqual(cleanCpu({ name: '<b>x</b>', cores: 4, threads: 2 }), { name: 'b x /b', cores: 4, threads: 4 });
  for (const bad of [undefined, null, 'cpu', { cores: 0 }, { cores: 2.5 }, { cores: '8' }, { name: 'x' }]) assert.equal(cleanCpu(bad), null, JSON.stringify(bad));
});

test('the hello carries the processor, a guest gets none, and it reaches the page', () => {
  const node = read('src/jobrun/node.ts');
  assert.match(node, /const cpu = d\.cpu\?\.\(\) \?\? null;/);
  assert.equal((node.match(/runner: runnerHello\(\), cpu, lentTo/g) ?? []).length, 2, 'both hellos (away and not)');
  assert.match(node, /const asGuest = [\s\S]*?drives: \[\], modelsDrive: '', cpu: null,/);
  assert.match(read('src/server/jobs.ts'), /cpu: \(\) => cpuHere\(\),/);
  const links = read('src/jobrun/links.ts');
  assert.match(links, /cpu: cleanCpu\(data\.cpu\),/);
  assert.match(links, /modelsDrive: h\.modelsDrive, cpu: h\.cpu \?\? null,/);
});

test('the Cluster page: each node shows its cores, the pool adds those that say theirs and counts those that do not', () => {
  const home = read('public/home.js');
  const body = home.slice(home.indexOf('function drawCluster('), home.indexOf('const fig = '));
  assert.match(body, /cores: \(seen\.cpu \?\? p\.cpu\)\?\.cores \?\? null/);
  assert.match(body, /m\.cores === undefined \? '' : m\.cores \? `\$\{m\.cores\} cores` : 'cores not known'/);
  assert.match(body, /const cores = \(cl\.out \? 0 : hw\?\.cpu\?\.cores \?\? 0\) \+ members\.reduce\(\(n, p\) => n \+ \(memOf\(p\)\.cores \?\? 0\), 0\);/, 'this PC\'s cores count only while it takes part');
  assert.match(home, /fig\(cores \? `\$\{cores\} cores` : 'not known'/);
  assert.ok(!home.includes('the nodes do not report theirs yet'));
});

test('what a linked PC changed here goes in the log as well as the window', () => {
  const node = read('src/jobrun/node.ts');
  assert.match(node, /const noted = \(line: string\) => \{\n  console\.log\(line\);\n  log\.info\('node', line\);\n\};/);
  for (const words of ['turned this PC off', 'updated TOMLIN here to', 'The CUDA runner on this PC changed', 'A linked PC installed', 'deleted ${id} from this PC', 'set the runner for', 'Dropping ${r.view.modelName']) {
    const line = node.split('\n').find(l => l.includes(words)) ?? '';
    assert.match(line, /noted\(/, words);
  }
  assert.match(node, /log\.info\('link', `"\$\{name\}" linked to this PC/);
  assert.match(node, /log\.info\('link', `The link\$\{unlinked\.length > 1 \? 's' : ''\} to/);
  assert.match(node, /if \(p === '\/worker\/log'\) \{\n\s+const got = askLog\(\{ lines: body\.lines, day: body\.day, find: body\.find \}\);/);
});

test('a linked PC\'s window has a Log fold: a day of 7, a word, the lines as text only', () => {
  const pcs = read('public/pcs.js');
  const part = pcs.slice(pcs.indexOf('function logPart(v)'), pcs.indexOf('function draw(v)'));
  assert.ok(part, 'logPart is there');
  assert.match(part, /Array\.from\(\{ length: 7 \}/);
  assert.match(part, /out\.textContent = s\.text;/);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(part), 'never page code');
  assert.match(part, /\/api\/node\/log\?\$\{q\}/);
  assert.match(pcs, /if \(!v\.here\) \{\n\s+const lp = logPart\(v\);/);
  assert.match(pcs, /body\.replaceChildren\([^\n]*nameFold, fold, logFold \?\? ''/);
  assert.ok(!/\bLLM\b/.test(part));
  const css = read('public/style.css');
  assert.match(css, /\.pc-log-lines \{[^}]*font-size: var\(--fs-xs\);/);
});
