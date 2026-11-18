// Home with months of projects: 300 jobs on disk (every one kept, hidden or not). Home is polled every 3 s by each open
// window, and every poll read and parsed every job's plan to show the newest 30 (0.5 s a poll measured, on the
// server's one thread). A plan that did not change is not read again; one that did is.
// Judged by what Home shows, not by the clock: a plan rewritten behind Home's back with the same size and time still
// shows its old words (it was not read again), and one that really changed shows its new words. The poll time is
// printed, and only a gross slowdown fails it, so a busy PC cannot make the test fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Every plan's file time is this whole second, so a test can put a file's time back exactly.
const SEEDED = Date.UTC(2026, 0, 1) / 1000;
const prose = (n: number, k: number) => Array.from({ length: n }, (_, i) => `word${(i * 7 + k) % 997}`).join(' ');

function seedJobs(home: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `202610${String(1 + (i % 28)).padStart(2, '0')}-${String(1000 + i).slice(-4)}-${(0xa000 + i).toString(16)}`;
    const dir = join(home, 'data', 'workspace', 'jobs', id);
    mkdirSync(dir, { recursive: true });
    const steps = Array.from({ length: 12 }, (_, k) => ({ title: `Step ${k}`, role: 'coder', files: [`site${i}/page${k}.html`], brief: prose(250, k), check: prose(30, k), status: k < 6 ? 'done' : 'todo', summary: prose(50, k), wrote: [] }));
    const at = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ id, goal: prose(30, i), name: `Project ${i}`, created: at, updated: at, notes: prose(300, i), steps }, null, 2));
    utimesSync(join(dir, 'plan.json'), SEEDED, SEEDED);
    ids.push(id);
  }
  return ids;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('Home with 300 projects answers quickly once it has read them, and still shows a plan that changed', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-homejobs-'));
  let pc: Pc | null = null;
  try {
    const home = join(top, 'home');
    const ids = seedJobs(home, 300);
    pc = await startPc({ root: ROOT, home });
    const p = pc;
    const poll = async () => {
      const t0 = performance.now();
      const r = await p.get('/api/home');
      assert.equal(r.status, 200);
      return { ms: performance.now() - t0, body: r.body };
    };
    await poll();
    const times: number[] = [];
    for (let i = 0; i < 12; i++) times.push((await poll()).ms);
    const after0 = await poll();
    const p50 = median(times);
    const fastest = Math.min(...times);
    console.log(`Home with 300 projects: ${Math.round(p50)} ms a poll (median of 12), ${Math.round(fastest)} ms at the fastest`);
    // 407 ms before (every plan read each poll), about 90 ms after. Only a slowdown no busy PC explains fails here;
    // the proof that plans are not read again is the stale plan below.
    assert.ok(fastest < 3000, `Home took ${Math.round(fastest)} ms at its fastest of 12 polls with 300 projects`);
    const planOf = (id: string) => join(home, 'data', 'workspace', 'jobs', id, 'plan.json');
    // A plan Home has read is rewritten with new words of the same length, and its size and time are put back as they
    // were: to Home it did not change, so it must not be read again and the old words stay on Home.
    const quiet = ids[ids.length - 2];
    const quietPlan = JSON.parse(readFileSync(planOf(quiet), 'utf8'));
    const oldGoal = quietPlan.goal as string;
    // Home shortens a goal: its first 40 letters are looked for.
    const oldStart = oldGoal.slice(0, 40);
    assert.ok(JSON.stringify(after0.body).includes(oldStart), 'the second newest project is on Home by its goal');
    const stale = 'Rewritten behind Home without a new size or time'.padEnd(oldGoal.length, '.').slice(0, oldGoal.length);
    quietPlan.goal = stale;
    writeFileSync(planOf(quiet), JSON.stringify(quietPlan, null, 2));
    utimesSync(planOf(quiet), SEEDED, SEEDED);
    // The newest project's plan changes on disk (as a step saving it would): the next poll shows the new name.
    const file = planOf(ids[ids.length - 1]);
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    // (Home shows a part-done project by its goal.)
    plan.goal = 'A goal changed while Home was open';
    plan.updated = new Date().toISOString();
    writeFileSync(file, JSON.stringify(plan, null, 2));
    const after = await poll();
    const shown = JSON.stringify(after.body);
    assert.ok(shown.includes('A goal changed while Home was open'), 'the changed plan is read again');
    assert.ok(shown.includes(oldStart) && !shown.includes(stale.slice(0, 40)), 'a plan with the same size and time is not read again');
  } finally {
    await pc?.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 5 });
  }
});
