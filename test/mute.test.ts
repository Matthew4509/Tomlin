// Mute: quiet, not stopped (src/mute.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY, isKey, MuteStore, mutedBy, set, shouldTell, sweep, untilFor, untilText, view } from '../src/mute.ts';

const NOW = new Date(2026, 9, 4, 14, 0);

test('lengths: an hour, tomorrow morning at 8 (today at 8 before 5 am), until unmuted', () => {
  assert.equal(untilFor('hour', NOW), new Date(2026, 9, 4, 15, 0).toISOString());
  assert.equal(untilFor('morning', NOW), new Date(2026, 9, 5, 8, 0).toISOString());
  assert.equal(untilFor('morning', new Date(2026, 9, 4, 2, 30)), new Date(2026, 9, 4, 8, 0).toISOString());
  assert.equal(untilFor('forever', NOW), null);
});

test('words: "until 3 pm", "until tomorrow 8 am", a weekday further on, "until you unmute"', () => {
  assert.equal(untilText(new Date(2026, 9, 4, 15, 0).toISOString(), NOW), 'until 3 pm');
  assert.equal(untilText(new Date(2026, 9, 4, 15, 30).toISOString(), NOW), 'until 3:30 pm');
  assert.equal(untilText(new Date(2026, 9, 5, 8, 0).toISOString(), NOW), 'until tomorrow 8 am');
  assert.equal(untilText(new Date(2026, 9, 6, 0, 0).toISOString(), NOW), 'until Tue 12 am');
  assert.equal(untilText(null, NOW), 'until you unmute');
});

test('set and unmute one, Mute all covers every key, ended mutes are dropped', () => {
  let m = set(EMPTY, 'staff:rowan', 'hour', NOW);
  assert.ok(mutedBy(m, ['staff:rowan'], NOW));
  assert.equal(mutedBy(m, ['staff:sam'], NOW), null);
  assert.equal(mutedBy(m, ['staff:rowan'], new Date(2026, 9, 4, 15, 1)), null, 'an hour later it has ended');
  m = set(m, 'all', 'forever', NOW);
  assert.ok(mutedBy(m, ['room:abcd1234'], NOW));
  m = set(m, 'all', 'off', NOW);
  assert.equal(mutedBy(m, ['room:abcd1234'], NOW), null);
  m = set(m, 'staff:rowan', 'off', NOW);
  assert.deepEqual(m.items, {});
  assert.deepEqual(sweep(set(EMPTY, 'chat:565a83941eba', 'hour', NOW), new Date(2026, 9, 5)).items, {});
  assert.equal(EMPTY.all, null, 'the empty value is never changed');
});

test('the longest mute wins: until unmuted beats a time', () => {
  let m = set(EMPTY, 'chat:565a83941eba', 'hour', NOW);
  m = set(m, 'staff:rowan', 'forever', NOW);
  assert.equal(mutedBy(m, ['chat:565a83941eba', 'staff:rowan'], NOW)?.until, null);
  m = set(EMPTY, 'chat:565a83941eba', 'hour', NOW);
  m = set(m, 'staff:rowan', 'morning', NOW);
  assert.equal(mutedBy(m, ['chat:565a83941eba', 'staff:rowan'], NOW)?.until, new Date(2026, 9, 5, 8, 0).toISOString());
});

test('stuck still tells him while the tick is on; finished and question stay quiet', () => {
  let m = set(EMPTY, 'room:abcd1234', 'forever', NOW);
  assert.equal(shouldTell(m, ['room:abcd1234'], 'stuck', NOW), true);
  assert.equal(shouldTell(m, ['room:abcd1234'], 'finished', NOW), false);
  assert.equal(shouldTell(m, ['room:abcd1234'], 'question', NOW), false);
  m = { ...m, stuckTells: false };
  assert.equal(shouldTell(m, ['room:abcd1234'], 'stuck', NOW), false);
  assert.equal(shouldTell(EMPTY, ['room:abcd1234'], 'finished', NOW), true);
});

test('keys: only the five kinds, nothing else reaches the file', () => {
  for (const k of ['manager', 'staff:gemma', 'node:a1b2c3d4:clara', 'room:abcd1234', 'chat:565a83941eba']) assert.ok(isKey(k), k);
  for (const k of ['all', 'partner', 'staff:', 'chat:../x', 'room:a b', '', 7]) assert.ok(!isKey(k), String(k));
});

test('view gives each mute its words; the file survives a fresh read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-mute-'));
  try {
    const s = new MuteStore(dir);
    await s.save(set(set(await s.get(), 'all', 'hour', new Date()), 'staff:rowan', 'forever', new Date()));
    const again = new MuteStore(dir);
    const v = view(await again.get());
    assert.equal(v.items['staff:rowan'].text, 'until you unmute');
    assert.match(v.all!.text, /^until /);
    assert.equal(v.stuckTells, true);
    assert.ok(JSON.parse(await readFile(join(dir, 'mute.json'), 'utf8')).items['staff:rowan']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
