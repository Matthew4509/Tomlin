// The one exit hook (src/exithook.ts): every module and every held runner adds a step to one list, so the process
// carries one 'exit' listener (eleven of their own set off MaxListenersExceededWarning at every start). Each case runs
// in a small Node process of its own, so a real exit is what runs the steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hook = pathToFileURL(join(import.meta.dirname, '..', 'src', 'exithook.ts')).href;

/** Runs `body` (with onExit, offExit, runExitSteps, exitStepCount in scope) in a Node process; its output and warnings. */
function run(body: string): { out: string; err: string; status: number | null } {
  const code = `import { onExit, offExit, runExitSteps, exitStepCount } from ${JSON.stringify(hook)};\n${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

test('steps added run at exit, once each, in the order they were added, with the exit code', () => {
  const r = run(`
onExit(c => process.stdout.write('a' + c + ' '));
onExit(c => process.stdout.write('b' + c + ' '));
onExit(c => process.stdout.write('c' + c + ' '));
process.exitCode = 3;`);
  assert.equal(r.out, 'a3 b3 c3 ');
  assert.equal(r.status, 3);
});

test('a step taken off does not run; taking it off twice, or one never added, changes nothing', () => {
  const r = run(`
const b = () => process.stdout.write('b ');
onExit(() => process.stdout.write('a '));
const drop = onExit(b);
const c = () => process.stdout.write('c ');
onExit(c);
drop();
drop();
offExit(() => {});
offExit(c);
process.stdout.write(exitStepCount() + ' ');`);
  assert.equal(r.out, '1 a ');
});

test('the steps run once: run by hand first, the real exit does not run them again', () => {
  const r = run(`
onExit(() => process.stdout.write('a '));
runExitSteps(0);
runExitSteps(0);`);
  assert.equal(r.out, 'a ');
});

test('a step that throws does not stop the ones after it, and the process ends as it would have', () => {
  const r = run(`
onExit(() => process.stdout.write('a '));
onExit(() => { throw new Error('broken step'); });
onExit(() => process.stdout.write('c '));`);
  assert.equal(r.out, 'a c ');
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.err, /broken step/);
});

test('fifty steps (modules and runners) still make one exit listener and no MaxListeners warning', () => {
  const r = run(`
const drops = [];
for (let i = 0; i < 50; i++) drops.push(onExit(() => {}));
process.stdout.write(process.listenerCount('exit') + ' ');
for (const d of drops) d();
for (let i = 0; i < 50; i++) onExit(() => {});
process.stdout.write(process.listenerCount('exit') + ' ' + exitStepCount());`);
  assert.equal(r.out, '1 1 50');
  assert.doesNotMatch(r.err, /MaxListenersExceeded/);
});

test('loaded twice (the bridge by require, the app by import), it is still one list and one listener', () => {
  const r = run(`
import { createRequire } from 'node:module';
const again = createRequire(import.meta.url)(${JSON.stringify(join(import.meta.dirname, '..', 'src', 'exithook.ts'))});
onExit(() => process.stdout.write('a '));
again.onExit(() => process.stdout.write('b '));
process.stdout.write(process.listenerCount('exit') + ' ');`);
  assert.equal(r.out, '1 a b ');
});

test('no module under src adds an exit listener of its own, apart from the hook and the cluster test runners that take theirs off', () => {
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'src'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' }).stdout.split(/\r?\n/).filter(f => /\.(ts|js)$/.test(f));
  assert.ok(files.length > 50);
  const own = files.filter(f => !/exithook\.ts$|cluster[\\/]testdoornode\.ts$/.test(f) && /process\.(on|once)\('exit'/.test(readFileSync(join(import.meta.dirname, '..', f), 'utf8')));
  assert.deepEqual(own, []);
});

test('panes made without a runner held add no exit step at all', () => {
  const worker = pathToFileURL(join(import.meta.dirname, '..', 'src', 'worker.ts')).href;
  const r = run(`
const { Worker } = await import(${JSON.stringify(worker)});
const before = exitStepCount();
for (let i = 0; i < 20; i++) new Worker(i % 2 ? 'chat' : 'image');
process.stdout.write((exitStepCount() - before) + ' ' + (process.listenerCount('exit') <= 1));`);
  assert.equal(r.out, '0 true', r.err);
  assert.doesNotMatch(r.err, /MaxListenersExceeded/);
});

test('a runner adds its exit step only while it holds a process, and takes it off when it ends', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'worker.ts'), 'utf8');
  assert.doesNotMatch(src, /process\.(on|once)\('exit'/);
  assert.match(src, /this\.child = child;\s+this\.holdExit\(\);/);
  assert.equal(src.match(/this\.letExit\(\);/g)?.length, 2);
});
