import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askLog, cleanLogDay, keptDays, lastLines, log, logAnswer, logFile, logLine, openLog } from '../src/log.ts';

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

test('a day asked of the log is a real date of the 7 kept, never a path or a pattern', () => {
  const now = new Date(2026, 10, 18, 9);
  assert.deepEqual(keptDays(now), ['2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12']);
  assert.equal(cleanLogDay(undefined, now), '2026-11-18');
  assert.equal(cleanLogDay('', now), '2026-11-18');
  assert.equal(cleanLogDay('2026-11-12', now), '2026-11-12');
  for (const bad of ['2026-11-11', '2026-11-19', '2026-11-18.log', '../2026-11-17', '..\\x', '2026-11-1*', '2026-13-01', '20261117', 20261117, ['2026-11-17'], { day: '2026-11-17' }, '2026-11-17\n']) {
    assert.equal(cleanLogDay(bad, now), null, String(bad));
  }
});

test('a linked PC asks for an earlier day and a word: the lines of that day holding it (any case), newest last', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-log-'));
  try {
    const now = new Date();
    const [today, yesterday] = keptDays(now);
    await writeFile(join(dir, `${yesterday}.log`), '01:00:00 INFO [max] Lending: this PC has 9.0 GB of its 16.0 GB of RAM free.\n01:01:00 WARN [runner] The model runner llama-server.exe stopped on its own after 3 min: exit code 1 (0x1).\n01:02:00 INFO [disk] Disk: C: has 3.0 GB free of 238 GB; weight cache 120 GB.\n');
    await writeFile(join(dir, `${today}.log`), '02:00:00 INFO [link] "Main" linked to this PC.\n');
    openLog(dir, now);
    const y = askLog({ day: yesterday }, now);
    assert.ok(!('error' in y));
    assert.equal(y.day, yesterday);
    assert.equal(y.lines.length, 3);
    assert.match(y.lines[2], /Disk: C:/);
    assert.deepEqual(y.days, [today, yesterday]);
    const found = askLog({ day: yesterday, find: 'RUNNER' }, now);
    assert.ok(!('error' in found));
    assert.deepEqual(found.lines, ['01:01:00 WARN [runner] The model runner llama-server.exe stopped on its own after 3 min: exit code 1 (0x1).']);
    const two = askLog({ day: yesterday, lines: 2 }, now);
    assert.ok(!('error' in two));
    assert.equal(two.lines.length, 2);
    // Nothing asked: today, as before; and lastLines (the older door's answer) still gives today's.
    const t = askLog({}, now);
    assert.ok(!('error' in t));
    assert.deepEqual([t.day, t.lines], [today, ['02:00:00 INFO [link] "Main" linked to this PC.']]);
    assert.deepEqual(lastLines(300, now).lines, t.lines);
    // A day not kept, or anything that is not a date, is refused with plain words.
    assert.match((askLog({ day: '../../secret' }, now) as { error: string }).error, /last 7 days/);
    assert.ok('error' in askLog({ day: '2020-01-01' }, now));
    // A day kept with no file: no lines.
    const empty = askLog({ day: keptDays(now)[5] }, now);
    assert.ok(!('error' in empty) && empty.lines.length === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the answer read on the asking PC: an older PC that ignores day and find still answers, searched here', () => {
  const now = logAnswer(200, { day: '2026-11-18', lines: ['a runner line', 'a disk line', 42], days: ['2026-11-18', '../x'] }, { day: '2026-11-18' });
  assert.deepEqual(now, { state: 'on', day: '2026-11-18', lines: ['a runner line', 'a disk line'], days: ['2026-11-18'] });
  // An older TOMLIN: no days in its answer, today's lines whatever was asked.
  const old = logAnswer(200, { day: '2026-11-18', lines: ['a Runner line', 'a disk line'] }, { day: '2026-11-15', find: 'runner' });
  assert.deepEqual(old, { state: 'on', day: '2026-11-18', lines: ['a Runner line'], days: [], todayOnly: true });
  assert.deepEqual(logAnswer(200, { day: '2026-11-18', lines: [] }, {}), { state: 'on', day: '2026-11-18', lines: [], days: [] });
  // A refusal keeps its words; nonsense is "off".
  assert.deepEqual(logAnswer(400, { error: 'that day is not kept here' }), { state: 'off', error: 'that day is not kept here' });
  assert.deepEqual(logAnswer(200, null), { state: 'off' });
  assert.deepEqual(logAnswer(500, { lines: [] }), { state: 'off' });
});
