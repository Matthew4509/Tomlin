// "This PC takes part" off, through the real routes: a host and two nodes, each its own server with its own home, linked
// with setup codes. The switch is refused, naming why, while no node could load the model for the others (node A has no
// link of its own to node B); once A links B itself and B allows lending, A says so in its hello, the switch is taken,
// A loads the model and is not held (the chats go to it), B is held, and the host borrows from nobody. Nothing here runs
// a model: that needs real PCs. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeIn, freePort, link, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('this PC out of its cluster: refused with why until a node can load the model, then the node loads it and is not held', { timeout: 600_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-clusterout-'));
  const pcs: Pc[] = [];
  try {
    const aPort = await freePort();
    const bPort = await freePort();
    const aDir = join(top, 'node-a');
    const bDir = join(top, 'node-b');
    nodeHome(aDir, aPort, 'Node A', 'aaaa0001');
    nodeHome(bDir, bPort, 'Node B', 'bbbb0002');
    // B's owner allows it to be used as part of a cluster (as ticked there before it starts).
    const bShare = join(bDir, 'data', 'share.json');
    const b0 = JSON.parse(readFileSync(bShare, 'utf8'));
    writeFileSync(bShare, JSON.stringify({ ...b0, allow: { ...b0.allow, lend: true } }));
    const [a, b, host] = await Promise.all([startPc({ root: ROOT, home: aDir }), startPc({ root: ROOT, home: bDir }), startPc({ root: ROOT, home: join(top, 'host') })]);
    pcs.push(a, b, host);
    const aId = await link(host, aPort);
    const bId = await link(host, bPort);
    assert.equal(aId, 'aaaa0001');
    assert.equal(bId, 'bbbb0002');
    const post = (body: Record<string, unknown>) => host.post('/api/remotes', { action: 'cluster', ...body });
    const saved = () => JSON.parse(readFileSync(join(top, 'host', 'data', 'settings.json'), 'utf8')).cluster;
    assert.equal((await post({ members: [aId, bId], on: true })).status, 200);
    assert.deepEqual(saved(), { on: true, members: [aId, bId] });

    // Neither node has a link of its own to the other: refused, each named with why, and nothing changes.
    const no = await post({ takesPart: false });
    assert.equal(no.status, 400, JSON.stringify(no.body));
    assert.match(no.body.error, /^This PC cannot stay out of the cluster yet: no PC in the cluster can load the model for the others\./);
    assert.match(no.body.error, /"Node A": it would not borrow from "Node B": on "Node A" itself, that PC must be linked under Network/);
    assert.deepEqual(saved(), { on: true, members: [aId, bId] });

    // A links B itself, with B's setup code as it shows now (a new one after the host linked it), as its owner would at A.
    await unlock(a);
    await link(a, bPort, codeIn(bDir));
    // A's hello to the host now says it would borrow from B (B allows it), and which adapter the host reached it on.
    await until('A to say it would borrow from B', async () => {
      const seen = ((await host.get('/api/nodes/others')).body.pcs as { id: string; ok: boolean }[]).find(x => x.id === aId);
      if (!seen?.ok) return null;
      const r = await post({ takesPart: false });
      return r.status === 200 ? r : null;
    }, 120_000, 2000);
    assert.deepEqual(saved(), { on: true, members: [aId, bId], out: true, loader: aId });

    // A is not held (the cluster's chats go to it); B is held (it lends to A); the page has A's name.
    const list = (await host.get('/api/home/pcs')).body;
    const row = (id: string) => list.pcs.find((x: { id: string }) => x.id === id);
    assert.equal(row(aId).heldByCluster, false, 'the loader takes the chats');
    assert.equal(row(bId).heldByCluster, true, 'a lender to the loader is held');
    assert.equal(list.cluster.out, true);
    assert.equal(list.cluster.loader, aId);
    assert.equal(list.cluster.loaderName, 'Node A');
    assert.deepEqual(list.cluster.loaderModels, []);
    assert.match(list.cluster.loaderNoModel, /No chat model is on "Node A" yet/);
    assert.deepEqual(list.cluster.gaps, [], 'nothing stops A now');

    // Off and on again keeps it; members changed around A keep A; switched back, the old set as it was.
    assert.equal((await post({ on: false })).status, 200);
    assert.deepEqual(saved(), { on: false, members: [aId, bId], out: true, loader: aId });
    assert.equal((await post({ on: true })).status, 200);
    assert.equal((await post({ takesPart: true })).status, 200);
    assert.deepEqual(saved(), { on: true, members: [aId, bId] });
    assert.equal((await host.get('/api/home/pcs')).body.pcs.find((x: { id: string }) => x.id === aId).heldByCluster, true);

    // Out again, then B leaves the set: one node cannot be a cluster this PC stays out of, so it takes part again, said.
    assert.equal((await post({ takesPart: false })).status, 200);
    const left = await post({ members: [aId] });
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.match(left.body.note ?? '', /This PC takes part in the cluster again/);
    assert.deepEqual(saved(), { on: true, members: [aId] });
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
