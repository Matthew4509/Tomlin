// Two real PCs on this one (test/pcs.ts): the host deletes a model from a linked PC over the link, so a PC nobody sits at
// can be kept tidy. The node's owner ticks "Accept models from linked PCs" (the tick that lets the host send models there)
// first, and its app lock PIN is typed on the host (as for an update); the node checks the id against its own models and
// refuses a hidden one with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIG = 'Qwen3.5-35B-A3B-Q4_K_M.gguf';
const SMALL = 'Qwen3.5-0.8B-Q4_K_M.gguf';
const KEEP = 'gemma-3-1b-it-Q4_K_M.gguf';

test('two PCs: the host deletes a linked PC\'s model only with the node\'s own tick, only a model on its list, never a hidden one', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-modelremove-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const chat = join(nodeDir, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    for (const f of [BIG, SMALL, KEEP]) writeFileSync(join(chat, f), 'G'.repeat(500));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);

    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    const first = await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 30_000);
    assert.ok(first.can.includes('model-remove'), JSON.stringify(first.can));

    // Not ticked there: refused, naming the tick; nothing is deleted.
    const off = await host.post('/api/network/model-remove', { pc, id: BIG, kind: 'chat' });
    assert.equal(off.status, 409, JSON.stringify(off.body));
    assert.match(off.body.error, /Accept models from linked PCs/);
    assert.ok(existsSync(join(chat, BIG)));

    // Its owner ticks it (with the app lock PIN, as every tick there).
    const tick = await node.post('/api/share', { allow: { receive: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    await until('the host to see the tick', async () => (await seen())?.allow?.receive === true, 30_000);

    // Ticked, but no PIN or a wrong one: refused by the node, which asks the host page for it; nothing is deleted.
    const noPin = await host.post('/api/network/model-remove', { pc, id: BIG, kind: 'chat' });
    assert.equal(noPin.status, 403, JSON.stringify(noPin.body));
    assert.equal(noPin.body.needNodePin, true);
    assert.match(noPin.body.error, /app lock/);
    const wrongPin = await host.post('/api/network/model-remove', { pc, id: BIG, kind: 'chat', nodePin: '1357' });
    assert.equal(wrongPin.status, 403, JSON.stringify(wrongPin.body));
    assert.equal(wrongPin.body.needNodePin, true);
    assert.ok(existsSync(join(chat, BIG)));
    const del = (b: Record<string, unknown>) => host.post('/api/network/model-remove', { pc, kind: 'chat', nodePin: NODE_PIN, ...b });

    // A model the node does not have, and a path or odd id: refused, nothing touched.
    for (const id of ['Nope-7B.gguf', join(chat, SMALL), '..\\..\\x.gguf']) {
      const r = await del({ id });
      assert.equal(r.status, 404, `${id}: ${JSON.stringify(r.body)}`);
    }
    for (const f of [BIG, SMALL, KEEP]) assert.ok(existsSync(join(chat, f)), f);

    // A hidden model stays until its owner unhides it.
    const hide = await node.post('/api/models/hide', { id: KEEP, kind: 'chat', hidden: true });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    const hiddenTry = await del({ id: KEEP });
    assert.equal(hiddenTry.status, 409, JSON.stringify(hiddenTry.body));
    assert.match(hiddenTry.body.error, /hidden/);
    assert.ok(existsSync(join(chat, KEEP)));

    // The real thing: the file is gone from the node's disk, the other models stay, and the host sees the shorter list.
    const gone = await del({ id: BIG });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.match(gone.body.said, /deleted/);
    assert.ok(!existsSync(join(chat, BIG)));
    assert.ok(existsSync(join(chat, SMALL)));
    await until('the host to see the shorter list', async () => !(await seen())?.models.some((m: any) => m.id === BIG), 30_000);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
