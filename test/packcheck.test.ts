// The pack's key-file check (tools/pack.ts, src/installer.ts stagedMissing): a staged copy that lacks a file a copy
// cannot start without (a launcher, a runner, the server) stops the pack with the list, before anything is zipped.
// No pack is run: the check is run on temp folders, and the pack script is read to see it is called before tar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KEY_FILES, stagedMissing } from '../src/installer.ts';

const made: string[] = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A staged copy with every key file but those in `leave`. */
function staged(leave: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-packcheck-'));
  made.push(dir);
  for (const f of KEY_FILES.filter(k => !leave.includes(k))) {
    const p = join(dir, ...f.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'x');
  }
  return dir;
}

test('a whole staged copy packs: nothing is said', () => {
  assert.equal(stagedMissing(staged()), '');
});

test('a staged copy without its launcher and a runner stops the pack, naming each missing file', () => {
  const why = stagedMissing(staged(['tools/tray.cs', 'runtime/llama-cpu/llama-server.exe']));
  assert.match(why, /^Pack stopped: the zip would miss 2 key file\(s\)/);
  assert.match(why, /\n {2}tools\/tray\.cs\n {2}runtime\/llama-cpu\/llama-server\.exe$/);
});

test('an empty stage names every key file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-packcheck-'));
  made.push(dir);
  const why = stagedMissing(dir);
  for (const f of KEY_FILES) assert.ok(why.includes(`\n  ${f}`), f);
});

test('the pack checks what it staged before it zips, and stops (exit 1) when anything is missing', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'tools', 'pack.ts'), 'utf8');
  const check = src.indexOf('stagedMissing(join(stage, name))');
  const zip = src.indexOf('execFileSync(tar');
  assert.ok(check > 0 && zip > check, 'stagedMissing runs on the stage before tar');
  assert.match(src.slice(check, zip), /if \(missing\) \{[\s\S]*console\.error\(missing\);[\s\S]*process\.exit\(1\);/);
});
