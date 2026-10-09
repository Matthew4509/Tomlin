import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, logFile, logLine, openLog } from '../src/log.ts';

test('a log line: time, level, where, the message on one line', () => {
  const at = new Date(2026, 9, 5, 9, 4, 7);
  assert.equal(logLine('error', 'chat', 'The model stopped.\nline two', at), '09:04:07 ERROR [chat] The model stopped. | line two\n');
  assert.equal(logLine('warn', 'job', 'x'.repeat(3000), at).length, '09:04:07 WARN [job] '.length + 2000 + 1);
});

test('the log keeps a week: older day files are deleted when it opens; entries go to today\'s file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-log-'));
  try {
    for (const d of ['2026-09-27', '2026-09-28', '2026-09-29', '2026-10-04']) await writeFile(join(dir, `${d}.log`), 'old\n');
    await writeFile(join(dir, 'notes.txt'), 'not a log');
    openLog(dir, new Date(2026, 9, 5, 12));
    assert.deepEqual((await readdir(dir)).sort(), ['2026-09-29.log', '2026-10-04.log', 'notes.txt']);
    openLog(dir);
    log.error('request', new Error('boom'));
    const text = await readFile(logFile()!, 'utf8');
    assert.match(text, /ERROR \[request\] Error: boom \| +at /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
