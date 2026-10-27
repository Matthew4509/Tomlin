// "Model runner" explained wherever a person meets it (2.0.63: a new node's install asked about the Visual C++ Runtime
// "TOMLIN's model runners need", which means nothing to someone new to running models). One phrase (src/vcrt.ts RUNNER_WORDS, singular RUNNER_WORD) in the installer's question, Start TOMLIN.cmd,
// the panes' faults, the no-runner lines, Help and the welcome page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNNER_FILE_HELP, RUNNER_WORD, RUNNER_WORDS, VCRT_HELP } from '../src/vcrt.ts';
import { missingCardRunner } from '../src/runtimes.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('one plain phrase for what a model runner is, singular and plural', () => {
  assert.equal(RUNNER_WORDS, 'the small programs that load a model and make it write or draw');
  assert.equal(RUNNER_WORD, 'the small program that loads a model and makes it write or draw');
});

test('every line that names the model runners to a person says what they are', () => {
  // The panes' faults.
  assert.match(VCRT_HELP, /^The model runner \(the small program that loads a model and makes it write or draw\) could not start/);
  assert.match(RUNNER_FILE_HELP, /^The model runner \(the small program that loads a model and makes it write or draw\) could not start/);
  // A card with no runner for it.
  const card = missingCardRunner('llama', [{ name: 'Radeon RX 7600', integrated: false }], () => false);
  assert.match(card, /the small program that loads a model and makes it write or draw/);
  assert.match(card, /runs on the CPU/);
  // No runner at all (a copy with runtime/ missing).
  assert.match(read('src/pane.ts'), /No model runner \(\$\{RUNNER_WORD\}\) is installed/);
  // The installer's Visual C++ Runtime question, and Start TOMLIN.cmd's lines (parentheses escaped for cmd inside its blocks).
  assert.match(read('tools/install.ts'), /TOMLIN's model runners \(\$\{RUNNER_WORDS\}\) need it/);
  assert.match(read('tools/install.ts'), /older than TOMLIN's model runners \(\$\{RUNNER_WORDS\}\) need/);
  const start = read('Start TOMLIN.cmd');
  assert.equal(start.split('The model runners ^(the small programs that load a model and make it write or draw^) are missing').length, 3, 'both missing-runner lines');
  assert.match(start, /which the model runners \^\(the small programs that load a model and make it write or draw\^\) need/);
  // Help and the welcome page.
  assert.match(read('public/index.html'), /<b>The runners<\/b> are the small programs that load a model and make it write \(chat\) or draw \(pictures\); a model on its own is only a file/);
  assert.match(read('Welcome to TOMLIN.html'), /the model runners \(the small programs that load a model and make it write or draw\)/);
});
