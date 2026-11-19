// Two real PCs on this one (test/pcs.ts): in the PIN window of one linked PC the host types either that PC's own app
// lock PIN or the host PIN it holds. The host knows its own host PIN by its hash and sends it as the host PIN; anything
// else goes on as the PC's own PIN, as before.
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
const HOST_PIN = '24681012';

test('two PCs: the host PIN typed as a linked PC\'s PIN opens it once that PC holds it; its own PIN still does', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-either-'));
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
    const host = await startPc({ root: ROOT, home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    const hello = await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 30_000);
    // The host can only offer Shut down for a node that says it knows how: in its normal answer, not only when it is away.
    assert.ok(hello.can.includes('power-off'), JSON.stringify(hello.can));
    const tick = await node.post('/api/share', { allow: { receive: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    await until('the host to see the tick', async () => (await seen())?.allow?.receive === true, 30_000);
    const remove = (id: string, nodePin: string) => host.post('/api/network/model-remove', { pc, id, kind: 'chat', nodePin });

    // A host PIN set here but not given to the node yet: typed as the node's PIN it is refused there, nothing deleted.
    const set = await host.post('/api/network/host-pin', { action: 'set', kind: 'pin', pin: HOST_PIN, pin2: HOST_PIN });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const early = await remove(ONE, HOST_PIN);
    assert.equal(early.status, 403, JSON.stringify(early.body));
    assert.equal(early.body.needNodePin, true);
    assert.ok(existsSync(join(chat, ONE)));

    // Given to the node (with the node's own PIN, once); the host then hears that it holds it.
    const give = await host.post('/api/network/host-pin', { action: 'give', pc, hostPin: HOST_PIN, nodePin: NODE_PIN });
    assert.equal(give.status, 200, JSON.stringify(give.body));
    await until('the host to hear the node holds it', async () => ((await host.post('/api/network/host-pin', { action: 'view' })).body.pcs as any[]).some(x => x.id === pc && x.has), 30_000);

    // The host PIN typed as the node's PIN: taken.
    const byHost = await remove(ONE, HOST_PIN);
    assert.equal(byHost.status, 200, JSON.stringify(byHost.body));
    assert.ok(!existsSync(join(chat, ONE)));

    // A wrong one is still refused and asked again; the node's own PIN still works.
    const wrong = await remove(TWO, '13579135');
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
    assert.equal(wrong.body.needNodePin, true);
    assert.ok(existsSync(join(chat, TWO)));
    const byOwn = await remove(TWO, NODE_PIN);
    assert.equal(byOwn.status, 200, JSON.stringify(byOwn.body));
    assert.ok(!existsSync(join(chat, TWO)));
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test("a linked PC's PIN window names the node and says either PIN opens it", () => {
  const js = readFileSync(join(ROOT, 'public', 'home.js'), 'utf8');
  assert.ok(js.includes('`Enter pin for ${other}:`'));
  assert.ok(js.includes("'To update, enter either your admin pin, or the individual pin for the node.'"));
  assert.ok(js.includes("'To shut down, enter either your admin pin, or the individual pin for the node.'"));
});

test('the permissions page says who the admin is, what its PIN can do and that an update is trusted code', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const note = /id="node-admin-note"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  assert.match(note, /links to this one becomes its admin/);
  assert.match(note, /update it, turn it off or delete models/);
  assert.match(note, /trusted like an administrator/);
  assert.ok(html.indexOf('id="node-admin-note"') > html.indexOf('Sharing and cluster permissions:') && html.indexOf('id="node-admin-note"') < html.indexOf('id="allow-pull"'));
  const pin = /id="node-pin-either"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  assert.match(pin, /You can use the node password or the admin password/);
});
