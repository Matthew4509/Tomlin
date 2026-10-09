// Every part the jobs and linking code needs from the server (JobDeps) is passed in. TypeScript is run without a type
// check here, so a missing one showed only when it was called: 2.0.31's node drew no picture (d.imageBusy was missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('every JobDeps part the jobs code needs is passed in by the server', () => {
  const iface = /export interface JobDeps \{\n([\s\S]*?)\n\}/.exec(src('jobrun.ts'))?.[1] ?? '';
  const needed = [...iface.matchAll(/^ {2}([a-zA-Z]+):/gm)].map(m => m[1]);
  assert.ok(needed.length > 30, `the interface was read (${needed.length} parts)`);
  const wiring = /^ {2}jobRoutes = createJobs\(\{\n([\s\S]*?)\n {2}\}\);/m.exec(src('server/jobs.ts'))?.[1] ?? '';
  const given = new Set([...wiring.matchAll(/^ {4}([a-zA-Z]+)\b/gm)].map(m => m[1]));
  assert.ok(given.size > 30, `the wiring was read (${given.size} parts)`);
  assert.deepEqual(needed.filter(n => !given.has(n)), []);
});
