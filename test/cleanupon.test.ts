// Two real PCs on this one (test/pcs.ts): Free up space on a linked PC lets models be ticked and removed, with no dead end.
// The window asks /api/cleanup for the list; a real block is one short line (its tick not set, off); the removal is the same
// POST /api/network/model-remove as the bin, with the node's PIN. The window's own steps (the PIN asked once, after the warning)
// are read from its script, which no test here runs in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const A = 'Qwen3-Coder-Next-80B-Q4_K_M.gguf';
const B = 'Gemma-3-4B-Q4_K_M.gguf';
const C = 'Keep-1B-Q4_K_M.gguf';

test('Free up space on a linked PC: one short line when something really blocks it, then tick, PIN, remove', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-cleanupon-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const chat = join(nodeDir, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    for (const f of [A, B, C]) writeFileSync(join(chat, f), 'G'.repeat(900));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 120_000);

    // Its tick is not set: the one real reason, in one line, with no how-to.
    const blocked = (await host.post('/api/cleanup', { pc })).body;
    assert.equal(blocked.canDelete, false);
    assert.equal(blocked.why, 'Tick "Accept models from linked PCs" on "Test node" (This PC) to remove models there.');
    assert.equal(blocked.rows.length, 3);

    // Ticked there: nothing blocks, no message, the models are listed to tick.
    assert.equal((await node.post('/api/share', { allow: { receive: true }, appPin: NODE_PIN })).status, 200);
    await until('the host to see the tick', async () => (await seen())?.allow?.receive === true, 120_000);
    const open = (await host.post('/api/cleanup', { pc })).body;
    assert.equal(open.canDelete, true, JSON.stringify(open.why));
    assert.equal(open.why, '');
    assert.deepEqual(open.rows.map((r: any) => r.block), ['', '', ''], 'none loaded or hidden');

    // The window's removal: the same door as the bin. A wrong PIN is asked again; the right one removes each ticked model.
    const remove = (id: string, nodePin?: string) => host.post('/api/network/model-remove', { pc, id, kind: 'chat', ...(nodePin ? { nodePin } : {}) });
    const wrong = await remove(A, '1357');
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.needNodePin, true);
    assert.ok(existsSync(join(chat, A)));
    for (const id of [A, B]) {
      const r = await remove(id, NODE_PIN);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.ok(!existsSync(join(chat, A)) && !existsSync(join(chat, B)) && existsSync(join(chat, C)));
    await until('the list to shrink', async () => (await host.post('/api/cleanup', { pc })).body.rows.length === 1, 120_000);

    // The node off: the one line says so.
    await node.stop();
    pcs.splice(pcs.indexOf(node), 1);
    const off = (await host.post('/api/cleanup', { pc })).body;
    assert.equal(off.canDelete, false);
    assert.equal(off.why, '"Test node" is off or not answering: its list is as last seen.');
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('the window: no dead-end text for a linked PC; the warning is agreed before the PIN is asked, and the PIN once for all ticked models', () => {
  const js = readFileSync(join(ROOT, 'public', 'cleanup.js'), 'utf8');
  assert.match(js, /\/api\/network\/model-remove/);
  assert.doesNotMatch(js, /A linked PC's models cannot be deleted from here/);
  const confirm = js.indexOf('const ok = await askHere($(\'#cleanup-ask\')');
  const pin = js.indexOf('nodePin = await askAppPin(\'\', st.data.name, doing)');
  assert.ok(confirm > 0 && pin > confirm, 'the PIN is asked after the warning');
  assert.equal(js.split('askAppPin(\'\', st.data.name, doing)').length - 1, 1, 'asked once, kept for the rest');
  assert.match(js, /staffed/);
  const server = readFileSync(join(ROOT, 'src', 'server', 'thispc.ts'), 'utf8');
  assert.doesNotMatch(server, /cannot have models deleted from this PC/);
});
