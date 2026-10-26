// Home with months of projects: 300 jobs on disk (every one kept, hidden or not). Home is polled every 3 s by each open
// window, and every poll read and parsed every job's plan to show the newest 30 (0.5 s a poll measured, on the
// server's one thread). A plan that did not change is not read again; one that did is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
    const p50 = median(times);
    console.log(`Home with 300 projects: ${Math.round(p50)} ms a poll (median of 12)`);
    // 407 ms before (every plan read each poll), about 90 ms after; the limit leaves room for a busy PC.
    assert.ok(p50 < 200,`Home took ${Math.round(p50)} ms a poll (median of 12) with 300 projects`);
    // The newest project's plan changes on disk (as a step saving it would): the next poll shows the new name.
    const newest = ids[ids.length - 1];
    const file = join(home, 'data', 'workspace', 'jobs', newest, 'plan.json');
    const plan = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
    // (Home shows a part-done project by its goal.)
    plan.goal = 'A goal changed while Home was open';
    plan.updated = new Date().toISOString();
    writeFileSync(file, JSON.stringify(plan, null, 2));
    const after = await poll();
    assert.ok(JSON.stringify(after.body).includes('A goal changed while Home was open'), 'the changed plan is read again');
  } finally {
    await pc?.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 5 });
  }
});
