// A job's events file at its cap keeps the newest events, and a note not yet passed on is never lost
// (src/jobrun/jobfiles.ts). Made-up events in a temp dir only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useDeps } from '../src/jobrun/shared.ts';
import { addEvent, loadEvents } from '../src/jobrun/jobfiles.ts';
import { pendingNotes } from '../src/home.ts';

const top = await mkdtemp(join(tmpdir(), 'sm-jobevents-'));
after(() => rm(top, { recursive: true, force: true }));
await mkdir(top, { recursive: true });
useDeps({ workspaceDir: async () => top } as never);

const coder = [{ staffId: null, name: 'coder', role: 'coder' }];
const fail = (i: number) => ({ type: 'failed' as const, n: i, role: 'coder', error: 'x'.repeat(200) });

test('at the cap the newest events are kept, an early note still waiting is kept, and a used one stops being sent', async () => {
  const id = 'jcap0001';
  const max = 20_000;
  await addEvent(id, { type: 'plan', steps: 3, worker: 'w' }, max);
  await addEvent(id, { type: 'note', id: 'early', text: 'still waiting', to: coder }, max);
  for (let i = 0; i < 300; i++) await addEvent(id, fail(i), max);
  await addEvent(id, { type: 'note', id: 'late', text: 'posted after the cap', to: coder }, max);
  const file = join(top, 'jobs', id, 'events.jsonl');
  assert.ok((await stat(file)).size <= max);
  let events = await loadEvents(id);
  assert.equal(events[0].type, 'plan');
  assert.deepEqual(pendingNotes(events, 'coder').map(n => n.id), ['early', 'late']);
  for (let i = 300; i < 400; i++) await addEvent(id, fail(i), max);
  await addEvent(id, { type: 'result', n: 0, role: 'coder', files: [], flags: 0, worker: 'w', tries: 1, notes: ['early', 'late'] }, max);
  events = await loadEvents(id);
  assert.deepEqual(pendingNotes(events, 'coder'), []);
  assert.equal(events.at(-1)?.type, 'result');
  assert.ok((await readFile(file, 'utf8')).includes('"n":399'));
});

test('events written at once all land, in order', async () => {
  const id = 'jcap0002';
  await Promise.all(Array.from({ length: 200 }, (_, i) => addEvent(id, fail(i), 10_000)));
  const ns = (await loadEvents(id)).map(e => (e as { n: number }).n);
  assert.equal(ns.at(-1), 199);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
});
