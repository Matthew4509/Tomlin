// A linked PC's log, read from the main PC: the last lines of the node's log today, through its sealed front door, so a
// test across two PCs (Max mode, 2 Nov) can be checked from one. Two real PCs on this one (test/pcs.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

test('the main PC reads a linked PC\'s log: its last lines today, as many as asked, and 404 for a PC not linked', { timeout: 180_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-nodelog-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    pcs.push(await startPc({ root: ROOT, home: nodeDir }));
    const host = await startPc({ root: ROOT, home: join(top, 'host') });
    pcs.push(host);
    const pc = await link(host, workerPort);
    // Lines as the node's own log writes them.
    mkdirSync(join(nodeDir, 'data', 'logs'), { recursive: true });
    const file = join(nodeDir, 'data', 'logs', `${today}.log`);
    for (let i = 1; i <= 5; i++) appendFileSync(file, `01:0${i}:00 INFO [max] made-up line ${i}\n`);

    const all = await host.get(`/api/node/log?pc=${pc}`);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.state, 'on');
    assert.equal(all.body.name, 'Test node');
    assert.equal(all.body.day, today);
    assert.ok(all.body.lines.includes('01:05:00 INFO [max] made-up line 5'), JSON.stringify(all.body.lines.slice(-5)));

    const two = await host.get(`/api/node/log?pc=${pc}&lines=2`);
    assert.deepEqual(two.body.lines, ['01:04:00 INFO [max] made-up line 4', '01:05:00 INFO [max] made-up line 5']);

    assert.equal((await host.get('/api/node/log?pc=nope')).status, 404);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
