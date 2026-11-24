// The Bridge part's fault log stays under its cap (src/bridge/logcap.js). Made-up lines in a temp dir only.
// Run: node test/bridge/logcap.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');
const { appendCapped, BRIDGE_LOG_MAX } = require('../../src/bridge/logcap');

test('the fault log rolls over at its cap: one older file kept, never more than twice the cap on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomlin-logcap-'));
  try {
    const line = 'x'.repeat(99) + '\n';
    for (let i = 0; i < 100; i++) appendCapped(dir, 'bridge-errors.log', line, 2000);
    const files = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(files, ['bridge-errors.log', 'bridge-errors.old.log']);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 2000, f);
    // A huge line is cut, not written whole.
    appendCapped(dir, 'big.log', 'y'.repeat(50000) + '\n');
    assert.ok(fs.statSync(path.join(dir, 'big.log')).size <= 8001);
    assert.strictEqual(BRIDGE_LOG_MAX, 5 * 1024 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a roll-over that fails (the file held by another program) still keeps the log going, within the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomlin-logcap-'));
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  try {
    const line = 'x'.repeat(99) + '\n';
    for (let i = 0; i < 100; i++) appendCapped(dir, 'bridge-errors.log', line, 2000);
    appendCapped(dir, 'bridge-errors.log', 'the newest fault\n', 2000);
    const text = fs.readFileSync(path.join(dir, 'bridge-errors.log'), 'utf8');
    assert.ok(text.length <= 2000);
    assert.ok(text.endsWith('the newest fault\n'));
  } finally {
    fs.renameSync = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a long line is never cut through the middle of a character made of two units', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomlin-logcap-'));
  try {
    appendCapped(dir, 'emoji.log', 'a' + '\u{1F600}'.repeat(5000) + '\n');
    const text = fs.readFileSync(path.join(dir, 'emoji.log'), 'utf8');
    assert.ok(!text.includes('�'));
    assert.strictEqual(text, 'a' + '\u{1F600}'.repeat(3999) + '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
