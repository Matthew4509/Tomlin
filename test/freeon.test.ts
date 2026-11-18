// Two real PCs on this one (test/pcs.ts): the host asks a linked PC to let go of the models it loaded for linked PCs, now.
// The node's owner ticks "Allow host to test and change model run settings" first; with nothing loaded there is nothing to
// let go and it says so; while its owner is using it, it says so; a PC that is not linked is not found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('two PCs: the host frees a linked PC\'s memory only with the node\'s own tick, and never while its owner uses it', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-free-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const chat = join(nodeDir, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, 'Qwen3.5-0.8B-Q4_K_M.gguf'), 'G'.repeat(500));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 30_000);

    // Not ticked there: the node itself refuses, saying where its owner ticks it.
    const off = await host.post('/api/network/free', { pc });
    assert.equal(off.status, 403, JSON.stringify(off.body));
    assert.match(off.body.error, /Allow host to test and change model run settings/);

    // Ticked: nothing is loaded for a linked PC, so there is nothing to let go, and it says so in words.
    const tick = await node.post('/api/share', { allow: { pull: true, backup: true, update: true, tune: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    const none = await host.post('/api/network/free', { pc });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.match(none.body.said, /Nothing to let go/);
    assert.deepEqual(none.body.freed, []);
    assert.deepEqual(none.body.busy, []);

    // Someone at the node presses "I need to use the pc": refused, said in plain words.
    const away = await node.post('/api/share', { away: true, appPin: NODE_PIN });
    assert.equal(away.status, 200, JSON.stringify(away.body));
    await until('the host to see the node away', async () => (await seen())?.away, 30_000);
    const busy = await host.post('/api/network/free', { pc });
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.match(busy.body.error, /being used by its owner/);

    // A PC that is not linked.
    assert.equal((await host.post('/api/network/free', { pc: 'ffffffff' })).status, 404);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
