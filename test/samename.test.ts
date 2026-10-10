// Two real PCs with one name (two machines both called "Worker PC", as his are): the second link says so, and linking
// the same PC again does not. The cards then show each one's address (public/home.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, NODE_CODE, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('linking a second PC with a name already in use says so', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-samename-'));
  const pcs: Pc[] = [];
  try {
    const portA = await freePort();
    const portB = await freePort();
    nodeHome(join(top, 'a'), portA, 'Worker PC', 'a1a1a1a1');
    nodeHome(join(top, 'b'), portB, 'Worker PC', 'b2b2b2b2');
    pcs.push(await startPc({ root: ROOT, home: join(top, 'a') }), await startPc({ root: ROOT, home: join(top, 'b') }));
    const host = await startPc({ root: ROOT, home: join(top, 'host') });
    pcs.push(host);

    await link(host, portA);
    const again = await host.post('/api/remotes', { action: 'add', url: `127.0.0.1:${portA}`, code: NODE_CODE });
    assert.equal(again.status, 200);
    assert.equal(again.body.sameName, undefined, 'the same PC linked again is not a second one');

    let second;
    for (let i = 0; i < 30; i++) {
      second = await host.post('/api/remotes', { action: 'add', url: `127.0.0.1:${portB}`, code: NODE_CODE });
      if (second.status === 200) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.equal(second!.status, 200, JSON.stringify(second!.body));
    assert.match(second!.body.sameName, /"Worker PC" at http:\/\/127\.0\.0\.1:\d+ has the same name/);
    assert.ok(second!.body.sameName.includes(`:${portA}`), 'it names the other one\'s address');

    const listed = (await host.get('/api/home/pcs')).body.pcs;
    assert.equal(listed.length, 2, 'both are kept');
    assert.deepEqual(listed.map((p: { name: string }) => p.name), ['Worker PC', 'Worker PC']);
  } finally {
    for (const pc of pcs) await pc.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
