// PowerShell quoting (src/psquote.ts): a folder path that holds a curly single quote stays one string, and what
// follows the quote is never run. Checked with Windows PowerShell itself on a made-up folder in the temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { psQuote } from '../src/psquote.ts';

const run = promisify(execFile);
const ps = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60_000 }).then(r => r.stdout.trim());

test('every kind of single quote is written twice; nothing else changes', () => {
  assert.equal(psQuote('C:\\Users\\me\\Plain'), "'C:\\Users\\me\\Plain'");
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  for (const c of ['\u2018', '\u2019', '\u201A', '\u201B']) assert.equal(psQuote(`a${c}b`), `'a${c}${c}b'`);
});

test('the four PowerShell helpers use it', () => {
  for (const f of ['src/firewall.ts', 'src/installer.ts', 'src/repair.ts', 'src/server/install.ts']) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(text, /const q = psQuote;/, f);
    assert.doesNotMatch(text, /replace\(\/'\/g, "''"\)/, `${f}: no quoting of its own left`);
  }
});

test('a folder path with a curly quote stays one string in Windows PowerShell, and the words after it are not run', { skip: process.platform !== 'win32' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'psquote-'));
  try {
    const flag = join(base, 'ran.txt');
    // A folder name as a phone or Word writes it, then words that would make a file if they were run.
    const name = `Don\u2019t; New-Item -ItemType File -Path ran.txt; \u2018x\u201B\u201A`;
    const dir = join(base, name);
    mkdirSync(dir);
    const said = await ps(`Set-Location -LiteralPath ${psQuote(base)}; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${psQuote(dir)})); Test-Path -LiteralPath ${psQuote(dir)}`);
    const [b64, found] = said.split(/\r?\n/);
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), dir, 'the path came through whole');
    assert.equal(found, 'True');
    assert.equal(existsSync(flag), false, 'nothing after the quote was run');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
