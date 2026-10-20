// Two real PCs on this one (test/pcs.ts): a restore point kept on the node holds none of the host's keys to its
// linked PCs, its sharing code or its PIN; it comes back whole; and one changed on the node is refused, never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, transferEnd, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Every .zip under `dir`, at any depth. */
function zipsIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.zip')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('two PCs: a restore point kept on the node carries no keys, comes back whole, and a changed one is refused', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-restorepoint-'));
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
    const token = (JSON.parse(readFileSync(join(hostDir, 'data', 'settings.json'), 'utf8')).remotes as { id: string; token: string }[]).find(r => r.id === pc)!.token;
    assert.match(token, /\w{16}/);
    // The host has a PIN too, and a sharing code of its own.
    writeFileSync(join(hostDir, 'data', 'app-lock.json'), '{"salt":"HOST-SALT","hash":"HOST-PIN-HASH"}');

    const sent = await host.post('/api/network/backup', { pc });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const end = await transferEnd(host, sent.body.transfer.id);
    assert.equal(end.state, 'done', end.said);

    // On the node's disk: the chats and settings, but not one of the host's secrets.
    const kept = zipsIn(nodeDir);
    assert.equal(kept.length, 1, kept.join(', '));
    const names = execFileSync(TAR, ['-t', '-f', kept[0]], { encoding: 'utf8' }).split(/\r?\n/).map(n => n.replace(/^\.\//, ''));
    assert.ok(names.includes('settings.json'));
    assert.ok(!names.includes('app-lock.json') && !names.includes('share.json'), names.join(', '));
    const everything = execFileSync(TAR, ['-x', '-O', '-f', kept[0]], { encoding: 'latin1', maxBuffer: 64 << 20 });
    assert.ok(!everything.includes(token), 'the host\'s key to the node is not in the restore point');
    assert.ok(!everything.includes('HOST-PIN-HASH'), 'nor its PIN');

    // Brought back: whole, so it is kept (the host's own copy is moved aside first, so this one really comes back).
    const listed = await host.get(`/api/network/backups?pc=${pc}`);
    const one = listed.body.backups[0] as { name: string; bytes: number };
    const mine = join(hostDir, 'backups', one.name);
    rmSync(mine);
    const back = await host.post('/api/network/bring', { pc, name: one.name, bytes: one.bytes });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const backEnd = await transferEnd(host, back.body.transfer.id);
    assert.equal(backEnd.state, 'done', backEnd.said);
    assert.equal(statSync(mine).size, one.bytes);

    // Changed on the node (same size, other bytes): refused, and nothing is left in the host's backups for it.
    rmSync(mine);
    const bytes = readFileSync(kept[0]);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(kept[0], bytes);
    const bad = await host.post('/api/network/bring', { pc, name: one.name, bytes: one.bytes });
    assert.equal(bad.status, 200, JSON.stringify(bad.body));
    const badEnd = await transferEnd(host, bad.body.transfer.id);
    assert.equal(badEnd.state, 'failed', badEnd.said);
    assert.match(badEnd.said, /not the one this PC sent/);
    assert.equal(readdirSync(join(hostDir, 'backups')).some(n => n.startsWith(one.name)), false);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
