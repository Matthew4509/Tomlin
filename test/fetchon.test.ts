// Two real PCs on this one (test/pcs.ts): Download to a linked PC asks that PC to download the model itself, through
// its worker door, and the host follows it as a transfer; a PC kept for backups only is refused before anything is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, transferEnd, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('two PCs: Download to a linked PC runs on that PC (no push tick needed) and ends with its own answer; a runner needs an NVIDIA card there; Backups only is refused', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-fetchon-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    // The node's old "Allow host to push models" tick is off: it is no longer read, so downloads and runners still come.
    const shareFile = join(nodeDir, 'data', 'share.json');
    writeFileSync(shareFile, JSON.stringify({ ...JSON.parse(readFileSync(shareFile, 'utf8')), allow: { pull: false, backup: false, push: false, update: false } }));
    pcs.push(await startPc({ root: ROOT, home: nodeDir }));
    const host = await startPc({ root: ROOT, home: join(top, 'host') });
    pcs.push(host);
    const pc = await link(host, workerPort);

    // The To list: the node can take a download.
    const net = (await host.get('/api/network')).body as { pcs: { id: string; fetch: string; fetchCode: string }[] };
    const row = net.pcs.find(x => x.id === pc)!;
    assert.equal(row.fetch, '', JSON.stringify(row));
    assert.equal(row.fetchCode, '');

    // A picture model the node's list does not have: the node itself answers, and the transfer says so.
    const started = await host.post('/api/network/fetch', { pc, kind: 'image', id: 'no-such-model', what: 'No such model' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const end = await transferEnd(host, started.body.transfer.id);
    assert.equal(end.state, 'failed', end.said);
    assert.match(end.said, /There is no model no-such-model/);

    // A runner: the node says in its hello whether it has an NVIDIA card. This PC's test node has the real hardware of
    // the PC running the tests; with no NVIDIA card it refuses with that reason, before anything is downloaded here.
    const runnerRow = (net.pcs.find(x => x.id === pc) as unknown as { runner: { nvidia: boolean; why: string } | null; runnerWhy: string });
    assert.ok(runnerRow.runner, `the node's hello names its runners: ${JSON.stringify(runnerRow)}`);
    if (!runnerRow.runner!.nvidia) {
      assert.match(runnerRow.runnerWhy, /no NVIDIA card of its own/);
      const no = await host.post('/api/network/runner', { pc, id: 'llama-cuda' });
      assert.equal(no.status, 409, JSON.stringify(no.body));
      assert.match(no.body.error, /no NVIDIA card of its own/);
    }
    const unknown = await host.post('/api/network/runner', { pc, id: 'llama-nothing' });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    // The picture runner is not sent between PCs (a node says how its chat runner is, not its picture one).
    assert.equal((await host.post('/api/network/runner', { pc, id: 'sd-cuda' })).status, 400);
    // This PC's own runner rows: the CUDA one says why it cannot help here (no NVIDIA card), and is not downloaded.
    const here = (await host.get('/api/runtimes')).body as { nvidia: boolean; runtimes: { id: string; device: string; installed: boolean; why: string; zips: boolean }[] };
    const cuda = here.runtimes.find(r => r.id === 'llama-cuda')!;
    assert.equal(cuda.device, 'cuda');
    assert.equal(here.runtimes.find(r => r.id === 'llama-cpu')!.why, '');
    if (!here.nvidia) {
      assert.match(cuda.why, /no NVIDIA card of its own/);
      const get = await host.post('/api/runtimes/get', { id: 'llama-cuda' });
      assert.equal(get.status, 409, JSON.stringify(get.body));
    }
    assert.equal((await host.post('/api/runtimes/get', { id: 'llama-cpu' })).status, 400);

    // Kept for backups only: refused here, with the reason, and nothing is started.
    const off = await host.post('/api/remotes', { action: 'backups-only', id: pc, on: true });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const refused = await host.post('/api/network/fetch', { pc, kind: 'image', id: 'no-such-model', what: 'No such model' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Backups only/);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
