// Two real PCs on this one (test/pcs.ts): with Web on, the host asks a linked PC to run a model with a larger context.
// The node's owner ticks "Allow host to test and change model run settings" first; the node works the size out itself
// (the most that fits, up to what was asked), keeps it as that model's context setting, and says so in words. Also the
// website check's routes on one PC, with no model connected and no site opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODEL = 'Qwen3.5-35B-A3B-Q4_K_M.gguf';

test('two PCs: the host widens a linked PC\'s context for the web only with the node\'s own tick', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-webctx-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const chat = join(nodeDir, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, MODEL), 'G'.repeat(4000));
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
    assert.ok(first.can.includes('ctx-set'), JSON.stringify(first.can));
    assert.equal(first.models.find((m: any) => m.id === MODEL).ctx, 8192);
    const ctxThere = async () => ((await node.get('/api/models')).body.chat as any[]).find(m => m.id === MODEL).run.ctx;

    // Tick off: nothing changes there, and the words name the tick.
    const off = await host.post('/api/network/web-context', { pc, model: MODEL });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.match(off.body.note, /Allow host to test and change model run settings/);
    assert.equal(await ctxThere(), 8192);
    const tick = await node.post('/api/share', { allow: { tune: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    await until('the host to see the tick', async () => (await seen())?.allow?.tune === true, 30_000);

    // Tick on: the model there is set to 32,768 and the host is told in words.
    const on = await host.post('/api/network/web-context', { pc, model: MODEL });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.ctx, 32768, JSON.stringify(on.body));
    assert.match(on.body.words, /asked to run this model with a context of 32,768 tokens \(it was 8,192\)/);
    assert.equal(await ctxThere(), 32768);
    // Already large: nothing more to do.
    await until('the host to see the new context', async () => (await seen())?.models.find((m: any) => m.id === MODEL)?.ctx === 32768, 30_000);
    const again = await host.post('/api/network/web-context', { pc, model: MODEL });
    assert.match(again.body.note, /large enough/);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('website check routes: a bad address is refused, a check with no model ends with the reason, an unknown one is not there', { timeout: 120_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-sitecheck-'));
  let pc: Pc | null = null;
  try {
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    pc = await startPc({ root: ROOT, home: join(top, 'pc'), env: { OLLAMA: noOllama } });
    const bad = await pc.post('/api/sitecheck', { url: 'not a link' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /not a web address/);
    assert.equal((await pc.get('/api/sitecheck?id=nope')).status, 404);
    assert.equal((await pc.post('/api/sitecheck/stop', { id: 'nope' })).status, 404);
    // No chat model is connected: the check says why and ends, before any page is asked for.
    const started = await pc.post('/api/sitecheck', { url: 'http://127.0.0.1:9/' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const end = await until('the check to end', async () => {
      const j = (await pc!.get(`/api/sitecheck?id=${started.body.id}`)).body;
      return j.state === 'failed' ? j : null;
    }, 30_000);
    assert.match(end.error, /No chat model is connected/);
    assert.equal(end.report, null);
    const now = (await pc.get('/api/sitecheck')).body;
    assert.equal(now.running, null);
    assert.equal(now.last, started.body.id);
  } finally {
    if (pc) await pc.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
