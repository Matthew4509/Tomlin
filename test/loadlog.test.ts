import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askerWords, LoadLog } from '../src/loadlog.ts';
import { cleanRunner } from '../src/runnerpush.ts';

test('who asked: a linked PC by name and link, a job, or the owner', () => {
  assert.equal(askerWords(undefined), 'its own owner');
  assert.equal(askerWords({ forPc: 'Main PC', forLink: 'abcdef1234567890' }), 'linked PC "Main PC" (link abcdef12)');
  assert.equal(askerWords({ forPc: 'Main PC', forLink: 'abcdef1234567890', forProject: 'job-7' }), 'linked PC "Main PC" (link abcdef12), for job-7');
  assert.equal(askerWords({}), 'its own owner');
});

test('the load log keeps the last few loads, newest last, with the file asked for and the file loaded', () => {
  const log = new LoadLog(3);
  for (let i = 1; i <= 5; i++) log.add({ model: `m${i}`, asker: 'its own owner' });
  log.add({ model: 'Qwen3.6-35B-A3B-Q4_K_S.gguf', wanted: '*/Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf', asker: 'linked PC "Main PC" (link abcdef12)' });
  const r = log.recent(3);
  assert.equal(r.length, 3);
  assert.equal(r[2].model, 'Qwen3.6-35B-A3B-Q4_K_S.gguf');
  assert.equal(r[2].line, 'Loaded Qwen3.6-35B-A3B-Q4_K_S.gguf (asked for */Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf, not on this PC) for linked PC "Main PC" (link abcdef12).');
  assert.equal(r[0].line, 'Loaded m4 for its own owner.');
});

test('a hello carries the load lines, cleaned', () => {
  const h = cleanRunner({ nvidia: false, cuda: 'none', last: null, loads: [{ at: '2026-11-11T10:00:00.000Z', line: 'Loaded x for y.' }, { line: 5 }, 'bad'] });
  assert.deepEqual(h!.loads, [{ at: '2026-11-11T10:00:00.000Z', line: 'Loaded x for y.' }]);
});
