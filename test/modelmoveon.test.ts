// Two real PCs on this one (test/pcs.ts): "where else is this model" before a delete, and Move: a model of the host is sent to
// the node, checked there byte for byte, and only then removed from the host. Whatever goes wrong first leaves the host's
// file where it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, transferEnd, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOVE = 'Move-Me-7B-Q4_K_M.gguf';
const DUP = 'Both-3B-Q4_K_M.gguf';
const BAD = 'Differs-1B-Q4_K_M.gguf';
const HID = 'Hidden-2B-Q4_K_M.gguf';
const text = (c: string, n = 700) => c.repeat(n);

test('two PCs: copies are named before a delete, and Move removes the model here only after the node\'s copy matches byte for byte', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-modelmove-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    const hostDir = join(top, 'host');
    nodeHome(nodeDir, workerPort);
    const nodeChat = join(nodeDir, 'models', 'chat');
    const hostChat = join(hostDir, 'models', 'chat');
    mkdirSync(nodeChat, { recursive: true });
    mkdirSync(hostChat, { recursive: true });
    for (const f of [MOVE, DUP, BAD, HID]) writeFileSync(join(hostChat, f), text('G'));
    writeFileSync(join(nodeChat, DUP), text('G'));
    // Same name and size, other bytes: the send sees "there already", and only the check can tell.
    writeFileSync(join(nodeChat, BAD), text('X'));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: ROOT, home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: ROOT, home: hostDir, env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);

    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 30_000);
    const copies = async (models: { kind: string; id: string }[], on = 'here') => (await host.post('/api/network/copies', { pc: on, models })).body;

    // Before the tick: the check reads the node's list, and says what Move needs.
    const before = await copies([{ kind: 'chat', id: MOVE }, { kind: 'chat', id: DUP }]);
    assert.equal(before.copies[`chat:${MOVE}`].words, 'This is the only copy TOMLIN found.');
    assert.match(before.copies[`chat:${MOVE}`].ask, /removes it for good\. Move it to another PC instead to keep one\.$/);
    assert.equal(before.copies[`chat:${DUP}`].words, 'Other copies: on Test node.');
    assert.deepEqual(before.targets, []);
    assert.match(before.refused[0].why, /Accept models from linked PCs/);
    const off = await host.post('/api/network/move', { pc, kind: 'chat', model: MOVE });
    assert.equal(off.status, 409, JSON.stringify(off.body));
    assert.match(off.body.error, /Accept models from linked PCs/);
    assert.ok(existsSync(join(hostChat, MOVE)));

    const tick = await node.post('/api/share', { allow: { receive: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    await until('the host to see the tick', async () => (await seen())?.allow?.receive === true, 30_000);
    const after = await copies([{ kind: 'chat', id: MOVE }]);
    assert.deepEqual(after.targets.map((t: any) => t.id), [pc]);

    // From the node's side: a model of the node's, held on this PC too.
    const fromNode = await copies([{ kind: 'chat', id: DUP }], pc);
    assert.equal(fromNode.copies[`chat:${DUP}`].words, 'Other copies: on This PC.');
    assert.deepEqual(fromNode.targets, [], 'a model on a linked PC is not moved from here');

    // A hidden model, and one that is not here: refused at once, before anything is copied.
    const hide = await host.post('/api/models/hide', { id: HID, kind: 'chat', hidden: true });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    const hidden = await host.post('/api/network/move', { pc, kind: 'chat', model: HID });
    assert.equal(hidden.status, 409, JSON.stringify(hidden.body));
    assert.match(hidden.body.error, /hidden/);
    assert.equal((await host.post('/api/network/move', { pc, kind: 'chat', model: 'Nope.gguf' })).status, 404);
    assert.ok(!existsSync(join(nodeChat, HID)) && !existsSync(join(nodeChat, `${HID}.part`)));

    // The same name and size with other bytes there: the check finds it, and nothing is removed here.
    const bad = await host.post('/api/network/move', { pc, kind: 'chat', model: BAD });
    assert.equal(bad.status, 200, JSON.stringify(bad.body));
    const badEnd = await transferEnd(host, bad.body.transfer.id);
    assert.equal(badEnd.state, 'failed', JSON.stringify(badEnd));
    assert.match(badEnd.said, /is not the same as this PC's file .*nothing was removed from this PC/);
    assert.ok(existsSync(join(hostChat, BAD)), 'the original stays');
    assert.equal(readFileSync(join(nodeChat, BAD), 'utf8'), text('X'), 'and the other PC\'s file is not touched');

    // The real move: copied, checked, then gone here.
    const go = await host.post('/api/network/move', { pc, kind: 'chat', model: MOVE });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    const end = await transferEnd(host, go.body.transfer.id);
    assert.equal(end.state, 'done', JSON.stringify(end));
    assert.match(end.said, /checked byte for byte, and removed from this PC/);
    assert.equal(readFileSync(join(nodeChat, MOVE), 'utf8'), text('G'));
    assert.ok(!existsSync(join(hostChat, MOVE)), 'removed here only after the check');
    assert.ok(existsSync(join(hostChat, DUP)));
    // One copy stays on the network, and the check now says where.
    const now = await copies([{ kind: 'chat', id: MOVE }], pc);
    assert.equal(now.copies[`chat:${MOVE}`].words, 'This is the only copy TOMLIN found.');
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
