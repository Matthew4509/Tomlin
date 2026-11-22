// The cluster test's CPU socket pin (src/cluster/testdoornode.ts pinScript), run for real on Windows against a short-lived
// child: socket 0 always exists; a socket past this PC's last is refused in plain words, and nothing is changed then.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pinScript } from '../src/cluster/testdoornode.ts';

const run = (script: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });

test('the socket pin keeps a process on socket 0, and refuses a socket this PC does not have', { skip: process.platform !== 'win32' }, () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const ok = run(pinScript(child.pid!, 0));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /pinned \d+/);
    const no = run(pinScript(child.pid!, 7));
    assert.notEqual(no.status, 0);
    assert.match(no.stderr + no.stdout, /CPU sockets 0 to \d+ only|has no cores/);
  } finally {
    child.kill();
  }
});

test('the socket pin script carries only the numbers it was given', () => {
  const s = pinScript(1234, 1);
  assert.match(s, /Get-Process -Id 1234\)/);
  assert.match(s, /GetNumaNodeProcessorMask\(1, /);
});
