// Two real PCs on this one (test/pcs.ts): no host PIN is typed. The node's own PIN is typed once for a delete, the host
// gives it the host key in the same step, and the next delete from the host needs no PIN at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ONE = 'Qwen3.5-35B-A3B-Q4_K_M.gguf';
const TWO = 'Qwen3.5-0.8B-Q4_K_M.gguf';

test('two PCs: the host key goes to a node with its own PIN once, then deletes need no PIN; turning it off takes it away', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-hostkey-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const chat = join(nodeDir, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    for (const f of [ONE, TWO]) writeFileSync(join(chat, f), 'G'.repeat(500));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const hostDir = join(top, 'host');
    const host = await startPc({ root: ROOT, home: hostDir, env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    await until("the node's hello", async () => ((await seen())?.ok ? seen() : null), 30_000);
    assert.equal((await node.post('/api/share', { allow: { receive: true }, appPin: NODE_PIN })).status, 200);
    await until('the host to see the tick', async () => (await seen())?.allow?.receive === true, 30_000);
    const remove = (id: string, nodePin?: string) => host.post('/api/network/model-remove', { pc, id, kind: 'chat', ...(nodePin === undefined ? {} : { nodePin }) });
    const view = async () => (await host.post('/api/network/host-pin', { action: 'view' })).body as any;

    // Nothing typed and no key held: the node's own PIN is asked, as before, and nothing is deleted.
    const none = await remove(ONE);
    assert.equal(none.status, 403, JSON.stringify(none.body));
    assert.equal(none.body.needNodePin, true);
    assert.ok(existsSync(join(chat, ONE)));

    // Its own PIN, typed once: the delete is done and the host key goes with it.
    const first = await remove(ONE, NODE_PIN);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const v = await until('the host to hear the node holds the key', async () => {
      const x = await view();
      return x.pcs.some((p: any) => p.id === pc && p.keyHeld) ? x : null;
    }, 30_000);
    assert.equal(v.key.on, true);
    assert.match(v.key.id, /^[0-9a-f]{12}$/);
    assert.equal(v.on, false, 'no typed host PIN was ever set');
    const keyFile = readFileSync(join(hostDir, 'data', 'host-key.json'), 'utf8');
    const secret = JSON.parse(keyFile).key as string;
    // The node keeps only a hash of it, and shows it as a key.
    const heldFile = readFileSync(join(nodeDir, 'data', 'host-pins.json'), 'utf8');
    assert.doesNotMatch(heldFile, new RegExp(secret));
    assert.match(heldFile, /"keyId"/);

    // The next delete needs no PIN.
    const second = await remove(TWO);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.ok(!existsSync(join(chat, TWO)));

    // Turned off: the node forgets the key, and the node's own PIN is asked again.
    const off = await host.post('/api/network/host-pin', { action: 'key-off' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const held = () => Object.keys(JSON.parse(readFileSync(join(nodeDir, 'data', 'host-pins.json'), 'utf8') || '{}')).length;
    await until('the node to drop the key', async () => held() === 0, 30_000);
    const again = await remove(ONE);
    assert.equal(again.status, 403, JSON.stringify(again.body));
    assert.equal((await view()).key.on, false);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
