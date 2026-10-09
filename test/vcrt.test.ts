// The Microsoft Visual C++ Runtime on a clean PC (src/vcrt.ts): which files are missing, a runner that ends for want
// of one (Windows' 0xC0000135) told in plain words, the installer's offer (dry run), and its signature and exit-code
// helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dllLine, dllNotFound, RUNNER_FILE_HELP, RUNNER_FILE_LINE, VCRT_DLLS, VCRT_HELP, VCRT_LINE, VCRT_URL, vcrtFault, vcrtMissing, vcrtTooOld } from '../src/vcrt.ts';
import { whyItFailed } from '../src/llama.ts';
import { Worker } from '../src/worker.ts';
import * as inst from '../src/installer.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const onWindows = process.platform === 'win32';
const tmp = () => mkdtempSync(join(tmpdir(), 'sm-vcrt-'));

test('the files a clean Windows lacks are named; none on another system', () => {
  const t = tmp();
  try {
    assert.deepEqual(vcrtMissing(t, 'win32'), VCRT_DLLS);
    for (const f of VCRT_DLLS.slice(0, 3)) writeFileSync(join(t, f), '');
    assert.deepEqual(vcrtMissing(t, 'win32'), VCRT_DLLS.slice(3));
    for (const f of VCRT_DLLS) writeFileSync(join(t, f), '');
    assert.deepEqual(vcrtMissing(t, 'win32'), []);
    assert.deepEqual(vcrtMissing(join(t, 'none'), 'linux'), []);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the runners need msvcp140 14.40 or later', () => {
  assert.equal(vcrtTooOld('14.38.33135.0'), true);
  assert.equal(vcrtTooOld('14.29.30139.0'), true);
  assert.equal(vcrtTooOld('14.40.33810.0'), false);
  assert.equal(vcrtTooOld('14.51.36247.0'), false);
  assert.equal(vcrtTooOld(''), false, 'no version read: not called old');
});

test("Windows' DLL-not-found exit code, either way Node reports it", () => {
  assert.equal(dllNotFound(3221225781), true);
  assert.equal(dllNotFound(-1073741515), true);
  assert.equal(dllNotFound(1), false);
  assert.equal(dllNotFound(null), false);
});

test('a runner that ends for want of the runtime is told plainly, with the way out', () => {
  assert.equal(vcrtFault(`some line\n${VCRT_LINE}`), true);
  assert.equal(whyItFailed(VCRT_LINE), VCRT_HELP);
  assert.ok(VCRT_HELP.includes(VCRT_URL));
  assert.match(VCRT_HELP, /Connect again/);
  assert.match(whyItFailed('failed to allocate'), /ran out of free memory/, 'other faults unchanged');
  assert.equal(whyItFailed(RUNNER_FILE_LINE), RUNNER_FILE_HELP);
});

test('the same Windows fault blames the runtime only when the runtime is missing', () => {
  const t = tmp();
  try {
    assert.equal(dllLine(t), VCRT_LINE);
    for (const f of VCRT_DLLS) writeFileSync(join(t, f), '');
    assert.equal(dllLine(t), RUNNER_FILE_LINE, 'runtime there: a file of the runner itself is missing');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('a runner Windows cannot start (exit 0xC0000135) leaves the runtime line in its tail', { skip: !onWindows }, async () => {
  const empty = tmp();
  const was = process.env.TOMLIN_VCRT_DIR;
  process.env.TOMLIN_VCRT_DIR = empty;
  try {
    await launchBoth();
  } finally {
    if (was === undefined) delete process.env.TOMLIN_VCRT_DIR;
    else process.env.TOMLIN_VCRT_DIR = was;
    rmSync(empty, { recursive: true, force: true });
  }
});

async function launchBoth() {
  const w = new Worker('chat');
  const r = await w.launch({ exe: 'cmd.exe', args: () => ['/c', 'exit', '-1073741515'], ready: async () => false, device: 'cpu', timeoutSeconds: 10 });
  assert.equal(r, 'failed');
  assert.ok(vcrtFault(w.tail()), w.tail());
  const other = await w.launch({ exe: 'cmd.exe', args: () => ['/c', 'exit', '3'], ready: async () => false, device: 'cpu', timeoutSeconds: 10 });
  assert.equal(other, 'failed');
  assert.equal(vcrtFault(w.tail()), false, 'any other ending says nothing about the runtime');
}

test("the installer's helpers: Microsoft's signature only, the redistributable's exit codes, quoting", () => {
  assert.equal(inst.signedByMicrosoft('Valid|Microsoft Corporation\r\n'), true);
  assert.equal(inst.signedByMicrosoft('Valid|OpenJS Foundation'), false);
  assert.equal(inst.signedByMicrosoft('NotSigned|'), false);
  assert.equal(inst.signedByMicrosoft('HashMismatch|Microsoft Corporation'), false);
  for (const ok of [0, 3010, 1638]) assert.equal(inst.redistResult(ok), null);
  assert.match(inst.redistResult(1602)!, /cancelled/);
  assert.match(inst.redistResult(1603)!, /code 1603/);
  const s = inst.elevatedRunScript("C:\\Users\\O'Neil\\vc.exe", ['/install', '/passive']);
  assert.match(s, /-FilePath 'C:\\Users\\O''Neil\\vc\.exe'/);
  assert.match(s, /-ArgumentList '\/install','\/passive' -Verb RunAs -Wait -PassThru; \$p\.ExitCode$/);
});

test("a signature check on this copy's own Node.js: valid, but not Microsoft's, so it would not be run", { skip: !onWindows }, () => {
  const said = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', inst.signatureScript(join(root, 'runtime', 'node', 'node.exe'))], { encoding: 'utf8' }).trim();
  assert.match(said, /^Valid\|/);
  assert.equal(inst.signedByMicrosoft(said), false);
});

test('the installer offers the runtime when it is missing (dry run), and skips it on --no-vcrt', { skip: !onWindows }, () => {
  const t = tmp();
  try {
    const env = { ...process.env, TOMLIN_INSTALL_ROOT: join(t, 'Programs', 'Smart Manager'), TOMLIN_START_MENU_DIR: join(t, 'menu'), TOMLIN_DESKTOP_DIR: join(t, 'desk'), TOMLIN_STARTUP_DIR: join(t, 'startup'), TOMLIN_UNINSTALL_KEY: 'none', TOMLIN_HOME: join(t, 'home'), TOMLIN_PORT: '8787', TOMLIN_VCRT_DIR: join(t, 'empty-system32') };
    const run = (more: string[]) => execFileSync(process.execPath, [join(root, 'tools', 'install.ts'), 'install', '--yes', '--dry-run', '--no-firewall', '--no-autostart', ...more], { env, encoding: 'utf8', timeout: 120_000 });
    const out = run([]);
    assert.match(out, /does not have the Microsoft Visual C\+\+ Runtime \(vcruntime140\.dll, /);
    assert.match(out, /Download it from Microsoft \(about 19 MB\) and install it now\? Windows asks for permission\. Yes/);
    assert.ok(out.includes(`(would) download ${VCRT_URL} and install it`));
    const skipped = run(['--no-vcrt']);
    assert.match(skipped, /Skipped\. Install it later from Microsoft/);
    assert.ok(!skipped.includes('(would) download'));
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
