// Two real PCs on this one (test/pcs.ts): the speed finder asked from a host runs on the node, under the node's own
// tick; what it would try is shown first; a test that cannot load leaves the node's settings as they were; Go with this
// config takes only a row of that node's own last test. Figures depend on this PC's hardware, so only what does not is
// checked here (the rules themselves are in test/speedfinder.test.ts and test/finderrun.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const A3B = 'Qwen3.5-35B-A3B-Q4_K_M.gguf';
const Q08 = 'Qwen3.5-0.8B-Q4_K_M.gguf';
const GEMMA = 'gemma-3-1b-it-Q4_K_M.gguf';

test('two PCs: the speed finder on a linked PC, only with its tick; preview first; a failed test changes nothing there', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-finder-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const chat = join(nodeDir, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, A3B), 'G'.repeat(4000));
    writeFileSync(join(chat, Q08), 'G'.repeat(500));
    writeFileSync(join(chat, GEMMA), 'G'.repeat(300));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);
    const tune = (b: Record<string, unknown>) => host.post('/api/network/tune', { pc, ...b });

    // Not ticked there: every step refused by the node itself, with where to tick.
    const off = await tune({ action: 'preview', model: A3B, size: 'quick' });
    assert.equal(off.status, 403, JSON.stringify(off.body));
    assert.match(off.body.error, /Allow host to test and change model run settings/);
    assert.equal((await tune({ action: 'start', model: A3B, size: 'quick' })).status, 403);
    // An unknown step is refused on this PC, before anything is asked.
    assert.equal((await tune({ action: 'flags', model: A3B })).status, 400);

    const tick = await node.post('/api/share', { allow: { pull: true, backup: true, update: true, tune: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));

    // The preview: row a first, the time for each size, what is left out and why.
    const p = await tune({ action: 'preview', model: A3B, size: 'quick' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.rows[0].id, 'a');
    assert.match(p.body.rows[0].name, /^Now: /);
    assert.ok(p.body.minutes.quick >= 1 && p.body.minutes.full >= p.body.minutes.quick, JSON.stringify(p.body.minutes));
    assert.equal(p.body.ctx, 8192);
    assert.ok(!p.body.contexts.includes(8192), 'the model\'s own context is not offered as another size');
    // Gemma has no smaller model of its family there: said, not tried.
    const g = await node.get(`/api/speed/find?model=${encodeURIComponent(GEMMA)}&size=full`);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.ok(g.body.left.some((l: { name: string; why: string }) => l.name === 'Guessing model' && /not tried/.test(l.why)), JSON.stringify(g.body.left));
    assert.equal((await node.get('/api/speed/find?model=Nope.gguf')).status, 404);

    // Go with this config before any test: refused (only a row of that PC's own last test is taken).
    const early = await tune({ action: 'apply', model: A3B, row: 'a' });
    assert.equal(early.status, 400, JSON.stringify(early.body));
    assert.match(early.body.error, /not from this PC's last test/);
    assert.equal((await tune({ action: 'undo', model: A3B })).status, 400);

    // A test of a file that cannot load: it ends, says why, and the node's saved setup is as it was.
    const runThere = async () => ((await node.get('/api/models')).body.chat as any[]).find(m => m.id === A3B).run;
    const before = await runThere();
    const started = await tune({ action: 'start', model: A3B, size: 'quick' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.job.by.length > 0, true);
    const end = await until('the test to end', async () => {
      const s = await tune({ action: 'state' });
      const r = s.body.job?.run;
      return r && r.state !== 'running' ? s.body.job : null;
    }, 240_000, 1000);
    assert.notEqual(end.run.state, 'done', JSON.stringify(end.run));
    assert.ok(end.run.said || end.run.rows.some((r: { state: string }) => r.state === 'failed'), JSON.stringify(end.run));
    assert.deepEqual(await runThere(), before);
    // Its rows are kept as that node's last test: a failed row cannot be chosen.
    const failedRow = end.run.rows.find((r: { state: string }) => r.state !== 'done');
    if (failedRow) assert.equal((await tune({ action: 'apply', model: A3B, row: failedRow.id })).status, 400);

    // Someone at the node presses "I need to use the pc": a new test is refused.
    assert.equal((await node.post('/api/share', { away: true, appPin: NODE_PIN })).status, 200);
    await until('the host to see the node away', async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc)?.away, 30_000);
    const away = await tune({ action: 'start', model: A3B, size: 'quick' });
    assert.equal(away.status, 409, JSON.stringify(away.body));
    assert.match(away.body.error, /being used by its owner/);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
