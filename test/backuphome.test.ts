// Where the backups other PCs send are kept (src/server/backuphome.ts), on two real PCs (test/pcs.ts): a node and a host.
// The folder is chosen on the node; a restore point the host sends then lands there, not in the usual folder; the node's
// hello says the room on that drive; a folder is refused when it is not a folder of its own (a whole drive, a relative
// path, inside the program, data or models folder); and once backups are kept in a folder it cannot be left behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, transferEnd, unlock, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the backups folder is chosen, used for what other PCs send, and kept from being left behind', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-backuphome-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort, 'Backup PC');
    const node = await startPc({ root: ROOT, home: nodeDir });
    pcs.push(node);
    await unlock(node);
    const host = await startPc({ root: ROOT, home: join(top, 'host') });
    pcs.push(host);

    // The usual folder to begin with: in the home, nothing kept yet.
    const first = (await node.get('/api/backups/where')).body;
    assert.equal(first.isUsual, true);
    assert.equal(first.dir, join(nodeDir, 'backups from other PCs'));
    assert.equal(first.kept, 0);
    assert.equal(typeof first.free, 'number');

    // What is refused: never a folder of its own.
    const bad = async (dir: string, why: RegExp) => {
      const r = await node.post('/api/backups/where', { dir });
      assert.equal(r.status, 400, `${dir}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, why, dir);
    };
    await bad('D:\\', /whole drive/);
    await bad('backups\\here', /whole path/);
    await bad(join(nodeDir, 'data', 'sub'), /own program, data, backups or models folder/);
    await bad(join(nodeDir, 'models', 'chat'), /own program, data, backups or models folder/);
    await bad('\\\\server\\share\\backups', /network/i);
    assert.equal((await node.get('/api/backups/where')).body.isUsual, true, 'nothing changed');

    // A folder on "another drive" (a folder of its own here): chosen, made, written to.
    const chosen = join(top, 'Tomlin', 'backups');
    const set = await node.post('/api/backups/where', { dir: chosen });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.dir, chosen);
    assert.equal(set.body.isUsual, false);
    assert.match(set.body.said, /kept in .* from now on/);
    assert.ok(existsSync(chosen));
    assert.ok(!existsSync(join(chosen, '.tomlin-write-test')), 'the write test is tidied away');

    // A restore point sent by a host lands in the chosen folder, one folder for that PC, and nowhere else.
    const nodeOnHost = await link(host, workerPort);
    const sent = await host.post('/api/network/backup', { pc: nodeOnHost });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((await transferEnd(host, sent.body.transfer.id)).state, 'done');
    const kept = readdirSync(chosen, { withFileTypes: true }).filter(e => e.isDirectory());
    assert.equal(kept.length, 1, 'one folder for the host that sent it');
    assert.ok(readdirSync(join(chosen, kept[0].name)).some(f => /\.zip$/.test(f)), 'its restore point');
    assert.ok(!existsSync(join(nodeDir, 'backups from other PCs')) || readdirSync(join(nodeDir, 'backups from other PCs')).length === 0, 'none in the usual folder');
    assert.equal((await node.get('/api/backups/where')).body.kept, 1);

    // Backups are kept there now: the folder cannot be changed (they would be left behind, out of sight).
    const away = await node.post('/api/backups/where', { dir: join(top, 'Other', 'backups') });
    assert.equal(away.status, 409, JSON.stringify(away.body));
    assert.match(away.body.error, /1 linked PC keeps backups in .* Moving backups to another folder is not built yet/);
    const usual = await node.post('/api/backups/where', { dir: null });
    assert.equal(usual.status, 409, 'the usual folder is another folder too');
    assert.equal((await node.get('/api/backups/where')).body.dir, chosen);

    // The choice is one small file in the home, read again when the app starts.
    await node.stop();
    pcs.splice(pcs.indexOf(node), 1);
    const again = await startPc({ root: ROOT, home: nodeDir });
    pcs.push(again);
    await unlock(again);
    assert.equal((await again.get('/api/backups/where')).body.dir, chosen);
    assert.equal((await again.get('/api/backups/where')).body.kept, 1);
  } finally {
    for (const p of pcs) await p.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('with nothing kept, the usual folder can be chosen again, and a folder is made when it is not there', { timeout: 120_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-backuphome2-'));
  let pc: Pc | null = null;
  try {
    const workerPort = await freePort();
    nodeHome(join(top, 'node'), workerPort, 'Backup PC');
    mkdirSync(join(top, 'elsewhere'), { recursive: true });
    pc = await startPc({ root: ROOT, home: join(top, 'node') });
    await unlock(pc);
    const deep = join(top, 'elsewhere', 'a', 'b', 'backups');
    assert.equal((await pc.post('/api/backups/where', { dir: `"${deep}"` })).status, 200, 'quotes as pasted from Explorer are taken off');
    assert.ok(existsSync(deep));
    const back = await pc.post('/api/backups/where', { dir: null });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.isUsual, true);
    assert.match(back.body.said, /usual folder again/);
  } finally {
    await pc?.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 5 });
  }
});
