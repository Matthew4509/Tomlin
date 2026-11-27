// Last words (src/lastwords.ts): every end leaves a line in the log saying why, and an end from outside is placed by
// the next start. Runs small Node processes over a temp log folder (no TOMLIN is started).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitLine, MARK, silentEndLine } from '../src/lastwords.ts';

const src = (f: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', f)).href;

/** A Node process that opens the log in `dir`, starts the last words, then runs `then`. */
const script = (dir: string, then: string) => `
const { openLog } = await import(${JSON.stringify(src('log.ts'))});
const lw = await import(${JSON.stringify(src('lastwords.ts'))});
openLog(${JSON.stringify(dir)});
lw.startLastWords(${JSON.stringify(dir)}, '9.9.9');
${then}`;

const run = (dir: string, then: string) => spawnSync(process.execPath, ['--input-type=module', '-e', script(dir, then)], { encoding: 'utf8', timeout: 20000 });
const logText = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.log')).map(f => readFileSync(join(dir, f), 'utf8')).join('');

test('the end line: the code and what it means, or the reason given', () => {
  assert.equal(exitLine(0, null), 'TOMLIN stopped (code 0): closed.');
  assert.equal(exitLine(76, null), 'TOMLIN stopped (code 76): restarting into the new version.');
  assert.equal(exitLine(0, 'it was sent SIGINT'), 'TOMLIN stopped (code 0): it was sent SIGINT.');
});

test('a silent end is placed: the PC started again since, or it was ended from outside', () => {
  const m = { pid: 42, version: '2.0.88', started: new Date(2026, 10, 12, 18, 51).getTime(), alive: new Date(2026, 10, 13, 9, 49).getTime() };
  const off = silentEndLine(m, new Date(2026, 10, 13, 11, 27).getTime());
  assert.match(off, /process 42, started 2026-11-12 18:51\).*last seen alive at 2026-11-13 09:49/);
  assert.match(off, /Windows started again at 2026-11-13 11:27, so the PC was turned off/);
  const killed = silentEndLine(m, new Date(2026, 10, 12, 11, 55).getTime());
  assert.match(killed, /Windows kept running .*ended from outside: the TOMLIN program by the clock closed/);
});

test('every way it ends leaves its line: a code, a reason, a fault, an end from outside', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-lastwords-'));
  try {
    // A code it chose, then the mark is gone (nothing left for the next start to explain).
    assert.equal(run(dir, 'process.exit(75);').status, 75);
    assert.match(logText(dir), /INFO \[started\] TOMLIN 9\.9\.9 started \(process \d+\)\./);
    assert.match(logText(dir), /INFO \[stopped\] TOMLIN stopped \(code 75\): restarting to apply what was changed\./);
    assert.equal(existsSync(join(dir, MARK)), false);
    // A reason given (a signal's handler in src/server/core.ts uses endBecause).
    run(dir, "lw.endBecause('it was sent SIGTERM (test)');");
    assert.match(logText(dir), /INFO \[stopped\] TOMLIN stopped \(code 0\): it was sent SIGTERM \(test\)\./);
    // A fault nobody caught.
    assert.equal(run(dir, "setTimeout(() => { throw new Error('boom'); }, 10);").status, 1);
    assert.match(logText(dir), /WARN \[stopped\] TOMLIN stopped \(code 1\): a fault ended it/);
    // Ended from outside (as Task Manager, or the program by the clock closing, does): no line now, the mark stays...
    const child = spawn(process.execPath, ['--input-type=module', '-e', script(dir, "console.log('up'); setInterval(() => {}, 1000);")], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>(r => child.stdout.once('data', () => r()));
    const pid = child.pid!;
    const ended = new Promise(r => child.once('exit', r));
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
    await ended;
    assert.equal(JSON.parse(readFileSync(join(dir, MARK), 'utf8')).pid, pid);
    assert.doesNotMatch(logText(dir), new RegExp(`process ${pid}\\).*ended without`));
    // ...and the next start says what it can: this PC has kept running, so it was ended from outside.
    run(dir, 'process.exit(0);');
    assert.match(logText(dir), new RegExp(`WARN \\[stopped\\] The last run \\(TOMLIN 9\\.9\\.9, process ${pid}, .*ended from outside`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mark that cannot be read is left alone, and a broken one never stops the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-lastwords-'));
  try {
    writeFileSync(join(dir, MARK), 'not json');
    assert.equal(run(dir, 'process.exit(0);').status, 0);
    assert.doesNotMatch(logText(dir), /ended without/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a silent end names Node\'s own fault report when the run left one (out of memory), and ignores another run\'s (S1)', async () => {
  const { mkdtempSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fatalReportLine } = await import('../src/lastwords.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-reports-'));
  try {
    const m = { pid: 78480, version: '2.1.28', started: Date.parse('2026-11-26T09:13:00'), alive: Date.parse('2026-11-26T15:31:00') };
    assert.equal(fatalReportLine(dir, m), '', 'no report: nothing added');
    writeFileSync(join(dir, 'report.20261126.153110.78480.0.001.json'), JSON.stringify({ header: { event: 'Allocation failed - JavaScript heap out of memory', trigger: 'FatalError' } }));
    assert.equal(fatalReportLine(dir, m), ' Node itself ran out of memory ("Allocation failed - JavaScript heap out of memory"); its report is report.20261126.153110.78480.0.001.json in the logs folder.');
    // Another process's report from days before is not this run's.
    rmSync(join(dir, 'report.20261126.153110.78480.0.001.json'));
    const old = join(dir, 'report.20261120.101010.1234.0.001.json');
    writeFileSync(old, JSON.stringify({ header: { event: 'something else' } }));
    utimesSync(old, new Date('2026-11-20T10:10:10'), new Date('2026-11-20T10:10:10'));
    assert.equal(fatalReportLine(dir, m), '');
    const core = (await import('node:fs')).readFileSync(new URL('../src/server/core.ts', import.meta.url), 'utf8');
    assert.match(core, /process\.report\.reportOnFatalError = true;/);
    assert.match(core, /excludeEnv = true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
