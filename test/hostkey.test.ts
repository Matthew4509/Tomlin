// Two real PCs on this one (test/pcs.ts): no host PIN is typed. The node's own PIN is typed once for a delete, the host
// gives it the host key in the same step, and the next delete from the host needs no PIN at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ONE = 'Qwen3.5-35B-A3B-Q4_K_M.gguf';
const TWO = 'Qwen3.5-0.8B-Q4_K_M.gguf';
const HOST_LOCK = '1357';

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
    // The host has an app lock of its own (admin access is off without one: anyone at that PC could use it), opened.
    const hostDir = join(top, 'host');
    mkdirSync(join(hostDir, 'data'), { recursive: true });
    writeFileSync(join(hostDir, 'data', 'app-lock.json'), JSON.stringify({ salt: 'beef', hash: scryptSync(HOST_LOCK, 'beef', 32).toString('hex'), idleMinutes: 0 }));
    const host = await startPc({ root: ROOT, home: hostDir, env: { OLLAMA: noOllama } });
    pcs.push(host);
    assert.equal((await host.post('/api/applock', { action: 'unlock', pin: HOST_LOCK })).status, 200, 'the host opens');
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
    assert.match(v.key.id, /^[0-9a-f]{12}$/);
    const keyFile = readFileSync(join(hostDir, 'data', 'host-key.json'), 'utf8');
    const secret = JSON.parse(keyFile).key as string;
    // The node keeps only a hash of it, and shows it as a key.
    const heldFile = readFileSync(join(nodeDir, 'data', 'host-pins.json'), 'utf8');
    assert.doesNotMatch(heldFile, new RegExp(secret));
    assert.match(heldFile, /"keyId"/);

    // 2.1.31: there is no switch to turn it off and no typed host PIN to set: those are refused, and the key stays.
    for (const action of ['key-off', 'key-on', 'set', 'give', 'off', 'check']) assert.equal((await host.post('/api/network/host-pin', { action })).status, 400, action);
    assert.equal((await view()).key.made, true);

    // The next delete still needs no PIN.
    const second = await remove(TWO);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.ok(!existsSync(join(chat, TWO)));

  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
