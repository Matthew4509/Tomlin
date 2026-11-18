// The cluster entry through the real routes: a host and a node, each its own server with its own home, linked with the setup
// code. Covers what the pure tests cannot reach: the saved set, the switch, the held PC in the list, a PC that cannot lend
// being named, Backups only and unlinking taking a PC out of the set. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the cluster: set, switch on and off, held in the list, named when it cannot lend, left by Backups only and by unlinking', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-cluster-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    pcs.push(await startPc({ root: ROOT, home: nodeDir }));
    const hostDir = join(top, 'host');
    const host = await startPc({ root: ROOT, home: hostDir });
    pcs.push(host);
    const pc = await link(host, workerPort);
    const saved = () => JSON.parse(readFileSync(join(hostDir, 'data', 'settings.json'), 'utf8')).cluster as { on: boolean; members: string[] };
    const post = (b: Record<string, unknown>) => host.post('/api/remotes', { action: 'cluster', ...b });

    // Nothing saved yet: no cluster, and switching a cluster with nobody in it on is refused in plain words.
    assert.deepEqual((await host.get('/api/home/pcs')).body.cluster, { on: false, members: [], gaps: [] });
    const empty = await post({ on: true });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /no PC in it yet/);

    // The set is rebuilt from linked PCs only; an unknown id is dropped.
    assert.equal((await post({ members: [pc, 'nope'] })).status, 200);
    assert.deepEqual(saved(), { on: false, members: [pc] });
    assert.equal((await host.get('/api/home/pcs')).body.pcs[0].heldByCluster, false, 'off: the PC is not held');

    // On: held in the list, and the PC that does not allow lending (its owner ticked nothing there) is named, not silent.
    const on = await post({ on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(saved().on, true);
    assert.match(on.body.note ?? '', /left out/, 'a member that cannot lend is named when the cluster is switched on');
    const list = (await host.get('/api/home/pcs')).body;
    assert.equal(list.cluster.on, true);
    assert.equal(list.pcs[0].heldByCluster, true);
    assert.equal(list.pcs[0].inCluster, true);
    assert.ok(list.cluster.gaps.length >= 1 && /Cluster member/.test(list.cluster.gaps[0]), JSON.stringify(list.cluster));

    // Off again: kept, not held.
    assert.equal((await post({ on: false })).status, 200);
    assert.deepEqual(saved(), { on: false, members: [pc] });
    assert.equal((await host.get('/api/home/pcs')).body.pcs[0].heldByCluster, false);

    // Backups only and the cluster exclude each other: setting it takes the PC out of the set, and the set refuses it.
    assert.equal((await post({ members: [pc], on: true })).status, 200);
    assert.equal((await host.post('/api/remotes', { action: 'backups-only', id: pc, on: true })).status, 200);
    assert.deepEqual(saved(), { on: false, members: [] }, 'Backups only took it out and the empty cluster is off');
    const refused = await post({ members: [pc] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Backups only/);
    assert.equal((await host.post('/api/remotes', { action: 'backups-only', id: pc, on: false })).status, 200);

    // Unlinking a member takes it out of the set, whatever path saved the PCs.
    assert.equal((await post({ members: [pc] })).status, 200);
    assert.equal((await host.post('/api/remotes', { action: 'remove', id: pc })).status, 200);
    assert.deepEqual(saved(), { on: false, members: [] });

    for (const p of pcs) assert.doesNotMatch(p.said(), /Uncaught|TypeError|ReferenceError/, p.said());
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
