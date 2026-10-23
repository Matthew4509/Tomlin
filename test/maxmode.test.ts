// Max mode on two real PCs on this one (test/pcs.ts), with a real small model: the node lends only with its tick and
// while nobody is using it; the host's chat runner then holds the model through the sealed stream (the RPC server on
// the node holds the layers) and answers; someone coming back to the node ends the loan at once. Whether someone is
// at the node is read from a file here (TOMLIN_TEST_PRESENCE_FILE), not from Windows. Skipped when the model is not
// on this PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const Q08 = 'Qwen3.5-0.8B-Q4_K_M.gguf';

function realModel(): string | null {
  try {
    const dir = readFileSync(join(ROOT, 'models-folder.txt'), 'utf8').trim();
    const p = join(dir, Q08);
    return dir && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** The RPC server's memory on this PC (bytes, all of them added), from Windows' own list. */
function rpcMemory(): number {
  const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq ggml-rpc-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return [...out.matchAll(/"([\d.,\s]+) K"/g)].reduce((n, m) => n + Number(m[1].replace(/\D/g, '')) * 1024, 0);
}

const model = realModel();

test('two PCs: Max mode lends the node\'s memory only while nobody uses it, answers through it, and ends when someone comes back', { timeout: 300_000, skip: model ? false : `${Q08} is not on this PC` }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-max-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const presence = join(top, 'presence.txt');
    // Someone is using the node: a key press a second ago.
    writeFileSync(presence, '1000 0');
    const node = await startPc({ root: ROOT, home: nodeDir, env: { TEST_PRESENCE_FILE: presence } });
    pcs.push(node);
    const hostDir = join(top, 'host');
    mkdirSync(join(hostDir, 'models', 'chat'), { recursive: true });
    linkSync(model!, join(hostDir, 'models', 'chat', Q08));
    const host = await startPc({ root: ROOT, home: hostDir, env: { MAX: 'Test node' } });
    pcs.push(host);
    await link(host, workerPort);
    await unlock(node);
    const lendNow = async () => (await node.get('/api/jobs/setup')).body.share.lend;
    const load = async () => {
      const r = await host.post(`/api/models/${encodeURIComponent(Q08)}/load`, { device: 'cpu' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      return until('the model to load on the host', async () => {
        const p = (await host.get('/api/status')).body.panes.chat;
        return p.state === 'connected' || p.state === 'failed' ? p : null;
      }, 180_000, 500);
    };
    const unload = () => host.post(`/api/models/${encodeURIComponent(Q08)}/unload`, {});
    const ask = () => fetch(`${host.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Say the word "orange" and nothing else.' }], max_tokens: 40, temperature: 0, chat_template_kwargs: { enable_thinking: false } }) });

    // 1. Not ticked there: the host loads on its own and says why the node did not lend.
    let p = await load();
    assert.equal(p.state, 'connected', JSON.stringify(p));
    assert.match(p.note ?? '', /Max mode: .*Lend card memory to linked PCs \(Max mode\)/);
    await unload();

    // 2. Ticked, but someone is using the node.
    const tick = await node.post('/api/share', { allow: { pull: false, backup: false, update: false, tune: false, lend: true }, lendIdle: 5, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    assert.equal(tick.body.lend.idle, 5);
    p = await load();
    assert.equal(p.state, 'connected');
    assert.match(p.note ?? '', /Max mode: someone is using "Test node" \(last used 0 min ago\)\. It lends once Windows is locked there, or after 5 minutes/);
    await unload();

    // 3. Nobody there for 10 minutes: it lends, the host loads through it and answers.
    writeFileSync(presence, '600000 0');
    const before = rpcMemory();
    p = await load();
    assert.equal(p.state, 'connected', JSON.stringify(p));
    assert.match(p.note ?? '', /Max mode: borrowing the card memory of "Test node"/);
    const lent = await lendNow();
    assert.ok(lent.to, JSON.stringify(lent));
    assert.ok(lent.streams >= 1, `llama-server holds a stream to the node: ${JSON.stringify(lent)}`);
    // The node's RPC server holds the model's layers (the 0.8B file is about 0.5 GB).
    const held = rpcMemory() - before;
    assert.ok(held > 300 * 2 ** 20, `the RPC server holds ${Math.round(held / 2 ** 20)} MB`);
    const a = await ask();
    assert.equal(a.status, 200);
    const answer = (await a.json()) as { choices: { message: { content: string } }[] };
    assert.match(answer.choices[0].message.content, /orange/i);
    // One PC borrows at a time: the node refuses a second one (here, the same host under another link would be needed;
    // the rule itself is in test/maxlend.test.ts).

    // 4. Someone comes back to the node: the loan ends within seconds and the host's runner can no longer answer on it.
    writeFileSync(presence, '300 0');
    const ended = await until('the loan to end', async () => {
      const l = await lendNow();
      return !l.to && l.ended ? l : null;
    }, 15_000, 300);
    assert.equal(ended.ended.why, 'someone started using it');
    assert.ok(rpcMemory() < 50 * 2 ** 20, 'the RPC server was ended');
    const after = await ask().catch(() => null);
    assert.ok(!after || after.status !== 200, 'no answer comes from a model whose layers were taken back');
    const stopped = await until('the host to say the model stopped', async () => {
      const c = (await host.get('/api/status')).body.panes.chat;
      // Its last lines come in just after it ends: the words are put right then.
      return c.state === 'failed' && /Max mode/.test(c.error) ? c : null;
    }, 15_000, 300);
    assert.match(stopped.error, /a PC lending its card for Max mode took it back/, stopped.detail);
  } finally {
    for (const pc of pcs) await pc.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 5 });
  }
});
