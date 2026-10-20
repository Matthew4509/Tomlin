// Two real PCs on this one (test/pcs.ts): the host picks the Guessing model of one of a linked PC's chat models. The
// node's owner ticks "Allow host to test and change model run settings" first; the node checks every id against its
// own models and keeps the setting in its own settings, and its owner sees who changed it.
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

test('two PCs: the host sets a linked PC\'s Guessing model only with the node\'s own tick, only to one of its own same-family models', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-runset-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    // Three chat models on the node (sizes in proportion: the big one, its small same-family guesser, another family).
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

    // The host sees each chat model's guessing model (none) and the ones it could use; the tick is off.
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    const first = await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 30_000);
    assert.ok(first.can.includes('tune'), JSON.stringify(first.can));
    assert.equal(first.allow.tune, false);
    const big = first.models.find((m: any) => m.id === A3B);
    assert.equal(big.draft, '');
    assert.deepEqual(big.guessers, [Q08]);
    assert.deepEqual(first.models.find((m: any) => m.id === GEMMA).guessers, []);

    // Not ticked there: the node itself refuses, saying where its owner ticks it. Nothing changes there.
    const off = await host.post('/api/network/run-set', { pc, model: A3B, draft: Q08 });
    assert.equal(off.status, 403, JSON.stringify(off.body));
    assert.match(off.body.error, /does not let linked PCs change how its models run/);
    assert.match(off.body.error, /Allow host to test and change model run settings/);
    const runThere = async (id: string) => ((await node.get('/api/models')).body.chat as any[]).find(m => m.id === id).run;
    assert.equal((await runThere(A3B)).draft, undefined);

    // Its owner ticks it (with the app lock PIN, as every tick there).
    const tick = await node.post('/api/share', { allow: { pull: true, backup: true, update: true, tune: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    assert.equal(tick.body.allow.tune, true);

    // Set: kept in the node's own settings, everything else of that model's setup as it was.
    const before = await runThere(A3B);
    const set = await host.post('/api/network/run-set', { pc, model: A3B, draft: Q08 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.match(set.body.said, /Qwen3\.5-0\.8B/);
    const after = await runThere(A3B);
    assert.equal(after.draft, Q08);
    assert.deepEqual({ ...after, draft: undefined }, { ...before, draft: undefined });
    // The host sees it in the next hello.
    await until('the host to see the guessing model', async () => (await seen())?.models.find((m: any) => m.id === A3B)?.draft === Q08, 30_000);
    // The node's owner sees who changed it.
    const changes = (await node.get('/api/nodes')).body.share.runChanges as any[];
    assert.equal(changes[0].model, A3B);
    assert.equal(changes[0].draft, Q08);
    assert.ok(changes[0].by && changes[0].at, JSON.stringify(changes[0]));

    // Refused by the node, its setting left alone: another family, itself, a path, a model it does not have, flags.
    const refused = async (b: Record<string, unknown>, status: number, why: RegExp) => {
      const r = await host.post('/api/network/run-set', { pc, ...b });
      assert.equal(r.status, status, `${JSON.stringify(b)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, why);
      assert.equal((await runThere(A3B)).draft, Q08);
    };
    await refused({ model: A3B, draft: GEMMA }, 400, /same family/);
    await refused({ model: A3B, draft: A3B }, 400, /same family/);
    await refused({ model: A3B, draft: join(chat, Q08) }, 400, /same family/);
    await refused({ model: 'Nope-7B.gguf', draft: '' }, 404, /not on/);
    // A flag list sent along is not read: the ids alone decide (here a refused id, so nothing changes).
    await refused({ model: A3B, draft: GEMMA, args: ['--spec-type', 'draft-simple', '-md', 'C:\\x.gguf'] }, 400, /same family/);

    // None takes it off.
    const none = await host.post('/api/network/run-set', { pc, model: A3B, draft: '' });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.equal((await runThere(A3B)).draft, undefined);

    // Someone at the node presses "I need to use the pc": refused, said in plain words.
    const away = await node.post('/api/share', { away: true, appPin: NODE_PIN });
    assert.equal(away.status, 200, JSON.stringify(away.body));
    await until('the host to see the node away', async () => (await seen())?.away, 30_000);
    const busy = await host.post('/api/network/run-set', { pc, model: A3B, draft: Q08 });
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.match(busy.body.error, /being used by its owner/);
    assert.equal((await runThere(A3B)).draft, undefined);

    // A PC that is not linked.
    assert.equal((await host.post('/api/network/run-set', { pc: 'ffffffff', model: A3B, draft: Q08 })).status, 404);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
