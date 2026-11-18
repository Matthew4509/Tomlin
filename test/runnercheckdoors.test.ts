// The runner test's doors on a real copy of TOMLIN (its own temp home, no runner unpacked, no model): the copy starts with
// the new parts wired in, says why it cannot test, keeps a Skip, and the runner list carries each runner's test result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('a copy with no card runner and no model says why the runner test cannot run, keeps a Skip, and lists no Max mode ask', { timeout: 120_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-rcheck-'));
  const pc = await startPc({ root: ROOT, home: join(top, 'pc') });
  try {
    const v = (await pc.get('/api/runner-check')).body;
    assert.equal(v.due, false);
    assert.match(v.cannot, /No graphics runner is unpacked on this PC yet|no chat model on this PC that fits the card/);
    // With no model to test nothing runs; a copy that ships a Vulkan runner lists it (the plan is the order that would be tried).
    assert.ok((v.plan as { pin: string; name: string; device: string }[]).every(p => p.pin && p.name && p.device === 'vulkan'));
    assert.equal(v.job, null);
    assert.match(v.skipWarning, /slower, or can crash/);

    const start = await pc.post('/api/runner-check/start', {});
    assert.equal(start.status, 409);
    assert.match(start.body.error, /No graphics runner|no chat model/);

    const m = (await pc.get('/api/runner-match')).body;
    assert.deepEqual(m.needs, []);
    assert.equal(m.build, null);

    const runtimes = (await pc.get('/api/runtimes')).body.runtimes as { id: string; check: unknown }[];
    assert.ok(runtimes.length > 0 && runtimes.every(r => 'check' in r && r.check === null));

    const skipped = (await pc.post('/api/runner-check/skip', {})).body;
    assert.equal(skipped.skipped, true);
    const file = join(top, 'pc', 'data', 'runner-check.json');
    assert.ok(existsSync(file), 'the Skip is kept for this card and driver');
    assert.equal(Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, { state: string }>)[0].state, 'skipped');
    assert.equal((await pc.post('/api/runner-check/stop', {})).status, 200);
  } finally {
    await pc.stop();
    rmSync(top, { recursive: true, force: true });
  }
});

test('the page has the dialog, its script and the warning beside the Skip button', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'public', 'runnercheck.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(html, /<dialog id="runner-check-dlg"/);
  assert.match(html, /<script src="runnercheck\.js"><\/script>/);
  assert.match(js, /class: 'rcheck-warn'/);
  assert.match(js, /text: 'Skip'/);
  assert.match(js, /text: 'Start the test'/);
  assert.match(js, /\/api\/runner-check\/skip/);
  // Nothing installs before a button is pressed: the ask calls the existing doors from a click only.
  assert.match(js, /\/api\/runtimes\/get/);
  assert.match(js, /\/api\/network\/runner/);
  assert.doesNotMatch(css.match(/\.rcheck-warn[^}]*}/)?.[0] ?? '', /font-size:\s+(?!var\()/, 'a size from the page scale, never below 12 px');
  assert.doesNotMatch(js, /#[0-9a-f]{6}\b/i, 'no colour in hex in the script');
});
