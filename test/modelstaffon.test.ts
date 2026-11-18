// Two real PCs on this one (test/pcs.ts): staff on a model are named before it is deleted, on this PC's list and on a linked PC's,
// including the linked PC's own hires; the bin over the link (/api/network/model-remove) is asked with the same message; and
// when the model is gone the hire says so and suggests, without doing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GONE = 'Gone-Model-7B-Q4_K_M.gguf';
const OTHER = 'Other-3B-Q4_K_M.gguf';

test('two PCs: staff on a model are named in the lists and the confirm, a linked PC\'s own hires too; a gone model is said and suggested, nothing is changed', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-modelstaff-'));
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
    for (const f of [GONE, OTHER]) writeFileSync(join(nodeChat, f), 'G'.repeat(700));
    // The host holds the same model, so it can be suggested as a way back.
    writeFileSync(join(hostChat, GONE), 'G'.repeat(700));
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
    assert.equal((await node.post('/api/share', { allow: { receive: true }, appPin: NODE_PIN })).status, 200);
    await until('the host to see the tick', async () => (await seen())?.allow?.receive === true, 30_000);

    // Pat works on the node's model from the host; Cy works on it on the node itself.
    const pat = await host.post('/api/staff', { action: 'hire', name: 'Pat Example', role: 'manager', model: `remote:${pc}:${GONE}` });
    assert.equal(pat.status, 200, JSON.stringify(pat.body));
    const cy = await node.post('/api/staff', { action: 'hire', name: 'Cy Node', role: 'default', level: 'default', model: GONE });
    assert.equal(cy.status, 200, JSON.stringify(cy.body));
    await until('the node to say Cy is on the model', async () => ((await seen())?.models ?? []).find((m: any) => m.id === GONE)?.assigned?.length === 1, 30_000);

    // The linked PC's list: both are named, with how.
    const window = (await host.get(`/api/pc?id=${pc}`)).body.models.find((m: any) => m.id === GONE);
    assert.equal(window.staffNote, 'Assigned to staff: Pat Example (first choice, no backup). Assigned to staff on "Test node": Cy Node (first choice, no backup).');
    assert.equal((await host.get(`/api/pc?id=${pc}`)).body.models.find((m: any) => m.id === OTHER).staffNote, '', 'a model nobody works on says nothing');

    // The bin over the link is asked with the same message, with the copies in it.
    const ask = (await host.post('/api/network/copies', { pc, models: [{ kind: 'chat', id: GONE }] })).body.copies[`chat:${GONE}`];
    assert.match(ask.ask, /^Assigned to staff: Pat Example \(first choice, no backup\)\. Assigned to staff on "Test node": Cy Node \(first choice, no backup\)\. Deleting it affects staff: Pat Example would have no model until you give them another\. Deleting it affects staff on "Test node": Cy Node would have no model until you give them another\. Other copies: on This PC\./);
    assert.equal(ask.summary, 'Assigned to staff: Pat Example (first choice, no backup). Assigned to staff on "Test node": Cy Node (first choice, no backup). Other copies: on This PC.');

    // On this PC's own list the model it holds has nobody (Pat is on the node's copy).
    const mine = (await host.get('/api/nodes')).body.models.find((m: any) => m.id === GONE);
    assert.equal(mine.staffNote, '');

    // Delete it on the node through the bin (the node's PIN, as always).
    const del = await host.post('/api/network/model-remove', { pc, id: GONE, kind: 'chat', nodePin: NODE_PIN });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(!existsSync(join(nodeChat, GONE)));
    await until('the host to see it gone', async () => !((await seen())?.models ?? []).some((m: any) => m.id === GONE), 30_000);

    // Pat's next chat: the page is told the model is gone, with suggestions; nothing was copied, sent or switched.
    const sent = await fetch(`${host.base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: '', who: `staff:${pat.body.staff?.id ?? 'pat-example'}`, message: 'Hello Pat' }) });
    const text = await sent.text();
    const event = /event: backup\ndata: (.*)/.exec(text);
    assert.ok(event, text.slice(-600));
    const data = JSON.parse(event[1]) as { gone: boolean; why: string; suggest: string[]; name: string };
    assert.equal(data.gone, true);
    assert.equal(data.name, 'Pat Example');
    assert.match(data.why, /is no longer on "Test node"/);
    assert.match(data.suggest[0], /^The same model, .*Gone-Model-7B.*, is on this PC: pick it as Pat's first choice in Team, or send a copy back to "Test node"/);
    assert.ok(!existsSync(join(nodeChat, GONE)), 'nothing was sent back');
    const after = (await host.get('/api/staff')).body.staff.find((m: any) => m.name === 'Pat Example');
    assert.equal(after.model, `remote:${pc}:${GONE}`, 'and nobody was switched');
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
