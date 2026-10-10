// Two real PCs on this one: a host and a node, each its own server with its own home, linked with the setup code as a
// person would. Covers what the other tests only reached through stand-ins: the node's front door (home network only,
// no web pages, a known link, sealed messages, size limits, "I need to use the pc"), project backups through it (the
// 10-minute round, Back up now, the backups listed, brought back), and the host's /api/network/projects routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, sleep, startPc, transferEnd, unlock, until, NODE_PIN, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** One POST on a connection of its own (none kept for the next): its status and answer, or "reset" when it was cut. */
function rawPost(port: number, path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: any } | 'reset'> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
      res.on('error', () => resolve('reset'));
    });
    req.on('error', () => resolve('reset'));
    req.end(body);
  });
}

/** Every file under `dir`, by its path inside it (forward slashes), with its text. */
function filesIn(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** The folder "restored projects" made inside `home` (wherever the copy keeps it), newest first. */
function restoredIn(home: string): string[] {
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      if (e.name === 'restored projects') found.push(...readdirSync(p).map(x => join(p, x)));
      else if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(home, 0);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

test('two PCs: the node\'s front door, and project backups through it (the round, away, back up now, brought back)', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-doors-'));
  const pcs: Pc[] = [];
  try {
    // The node: app lock set, sharing on, every tick on (written as its owner would have set them).
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const node = await startPc({ root: ROOT, home: nodeDir });
    pcs.push(node);
    // The host: two made-up workspace files, and one Bridge project ticked "Copy to my other PCs".
    const hostDir = join(top, 'host');
    const ws = join(hostDir, 'data', 'workspace');
    mkdirSync(join(ws, 'site'), { recursive: true });
    writeFileSync(join(ws, 'site', 'index.html'), '<p>made-up site</p>\n');
    writeFileSync(join(ws, 'notes.txt'), 'first notes\n');
    const project = join(top, 'Lighthouse app');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'main.js'), 'console.log("made-up project");\n');
    writeFileSync(join(hostDir, 'data', 'bridge-backups.json'), JSON.stringify({ dirs: [project] }));
    // The round every 3 seconds instead of 10 minutes.
    const host = await startPc({ root: ROOT, home: hostDir, env: { PROJECT_ROUND_SECONDS: '3' } });
    pcs.push(host);

    // ---- Linking: the code shown on the node, typed on the host ----
    const pc = await link(host, workerPort);
    const door = `http://127.0.0.1:${workerPort}`;

    // ---- Linked again (a new code, an update): Backups only, set on this PC, stays ----
    const remoteOf = () => (JSON.parse(readFileSync(join(hostDir, 'data', 'settings.json'), 'utf8')).remotes as { id: string; backupsOnly?: boolean }[]).find(r => r.id === pc);
    assert.equal((await host.post('/api/remotes', { action: 'backups-only', id: pc, on: true })).status, 200);
    assert.equal(remoteOf()?.backupsOnly, true);
    assert.equal(await link(host, workerPort), pc, 'the same PC keeps its id');
    assert.equal(remoteOf()?.backupsOnly, true, 'linking the same PC again keeps Backups only');
    assert.equal((await host.post('/api/remotes', { action: 'backups-only', id: pc, on: false })).status, 200);

    // ---- The front door ----
    const whoami = await (await fetch(`${door}/worker/whoami`)).json() as Record<string, unknown>;
    assert.equal(whoami.app, 'smart-manager');
    assert.equal(whoami.name, 'Test node');
    assert.equal(JSON.stringify(whoami).includes('TEST'), false, 'the setup code is never told to whoever asks');
    // A web page (it sends Origin) gets nothing, not even who this is.
    assert.equal((await fetch(`${door}/worker/whoami`, { headers: { origin: 'http://example.test' } })).status, 403);
    // No link, or one the node does not know: 401.
    assert.equal((await fetch(`${door}/worker/hello`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${door}/worker/hello`, { method: 'POST', body: '{}', headers: { authorization: `Link ${'0'.repeat(64)}` } })).status, 401);
    // The host's real link (its token's fingerprint is all that crosses), but not sealed: refused, and so is a GET.
    const token = (JSON.parse(readFileSync(join(hostDir, 'data', 'settings.json'), 'utf8')).remotes as { id: string; token: string }[]).find(r => r.id === pc)!.token;
    const auth = { authorization: `Link ${createHash('sha256').update(token).digest('hex')}` };
    assert.equal((await fetch(`${door}/worker/hello`, { headers: auth })).status, 405);
    const plain = await fetch(`${door}/worker/hello`, { method: 'POST', body: '{"plain":true}', headers: auth });
    assert.equal(plain.status, 400, 'a message that is not sealed is refused');
    // Too large for its door (16 KB for most): refused before anything is opened, and the node carries on.
    const big = await fetch(`${door}/worker/stats`, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(40_000) }), headers: auth });
    assert.equal(big.status, 400);
    assert.match(((await big.json()) as { error: string }).error, /too large/);
    // The git doors have their own sizes: the ids asked about up to 1 MB, a backup's file list up to 32 MB.
    // Over its size the node stops reading: the sender gets the reason, or (still sending) its connection cut.
    const sized = async (p: string, bytes: number) => {
      const r = await rawPost(workerPort, p, JSON.stringify({ pad: 'x'.repeat(bytes) }), auth);
      return r === 'reset' ? 'too large (cut)' : String(r.body?.error);
    };
    assert.match(await sized('/worker/git-have', 2 << 20), /too large/);
    assert.doesNotMatch(await sized('/worker/git-commit', 2 << 20), /too large/, 'a 2 MB file list is within its door (refused only as not sealed)');
    assert.equal((await fetch(`${door}/worker/whoami`)).status, 200, 'still answering after a body too large');
    // A link request that is not a real one: refused, and still answering after.
    assert.equal((await fetch(`${door}/worker/pair`, { method: 'POST', body: JSON.stringify({ v: 2, pub: 'nope', nonce: 'n1' }) })).status, 403);
    assert.equal((await fetch(`${door}/worker/whoami`)).status, 200);
    // Through the host, sealed: the node says hello with its ticks.
    const listed = (await host.get('/api/remotes')).body.remotes.find((r: { id: string }) => r.id === pc);
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.ok(listed.can.includes('git'), JSON.stringify(listed.can));

    // ---- The 10-minute round (every 3 s here): the projects go to the node without anyone pressing anything ----
    const commits = async () => {
      const r = await host.get(`/api/network/projects?pc=${pc}`);
      return r.status === 200 ? (r.body.commits as unknown[]) : null;
    };
    const first = await until('the first round to back the projects up', async () => ((await commits())?.length ?? 0) >= 1 ? await commits() : null, 90_000);
    assert.equal(first!.length, 1);
    const done = (await host.get(`/api/network/projects?pc=${pc}`)).body.done;
    assert.equal(done.files, 3, `the workspace (2 files) and the ticked project (1): ${JSON.stringify(done)}`);
    // Nothing changed: the next rounds send nothing and make no new backup.
    await sleep(8000);
    assert.equal((await commits())!.length, 1, 'no new backup when nothing changed');
    // A change: the next round backs it up.
    writeFileSync(join(ws, 'notes.txt'), 'second notes\n');
    await until('a round to back the change up', async () => ((await commits())?.length ?? 0) >= 2, 60_000);

    // ---- "I need to use the pc" on the node: no backups go there, the host says why ----
    await unlock(node);
    const away = await node.post('/api/share', { away: true, appPin: NODE_PIN });
    assert.equal(away.status, 200, JSON.stringify(away.body));
    const refusedList = await host.get(`/api/network/projects?pc=${pc}`);
    assert.equal(refusedList.status, 502);
    assert.match(refusedList.body.error, /log off|using/, refusedList.body.error);
    await until('the host to see the node is away', async () => (await host.get('/api/remotes')).body.remotes.find((r: { id: string }) => r.id === pc)?.away);
    const refusedNow = await host.post('/api/network/projects', { pc });
    assert.equal(refusedNow.status, 409);
    assert.match(refusedNow.body.error, /being used by its owner/);
    writeFileSync(join(ws, 'notes.txt'), 'third notes, written while the node was away\n');
    await sleep(8000);
    // Back: the change made while away goes on the next round.
    const back = await node.post('/api/share', { back: true, appPin: NODE_PIN });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    await until('a round after the node is back', async () => ((await commits())?.length ?? 0) >= 3, 60_000);
    assert.equal((await commits())!.length, 3, 'nothing was sent while it was away');

    // ---- Back up now with nothing changed: says so, no new backup ----
    const now = await host.post('/api/network/projects', { pc });
    assert.equal(now.status, 200, JSON.stringify(now.body));
    const nowEnd = await transferEnd(host, now.body.transfer.id);
    assert.equal(nowEnd.state, 'done', nowEnd.said);
    assert.match(nowEnd.said, /Nothing changed/);
    assert.equal((await commits())!.length, 3);

    // ---- Brought back: the newest backup into "restored projects", nothing in the workspace replaced ----
    const restore = await host.post('/api/network/projects-back', { pc });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    const restored = await transferEnd(host, restore.body.transfer.id);
    assert.equal(restored.state, 'done', restored.said);
    const into = restoredIn(hostDir)[0];
    assert.ok(into, 'a restored projects folder was made');
    const got = filesIn(into);
    assert.equal(got['notes.txt'], 'third notes, written while the node was away\n');
    assert.equal(got['site/index.html'], '<p>made-up site</p>\n');
    const projectFile = Object.keys(got).find(p => p.endsWith('Lighthouse app/src/main.js'));
    assert.ok(projectFile, `the ticked project is in the backup: ${Object.keys(got).join(', ')}`);
    assert.equal(got[projectFile!], 'console.log("made-up project");\n');
    // Only that project, by the folder name it has in the backup.
    const only = projectFile!.split('/').slice(-3)[0];
    const one = await host.post('/api/network/projects-back', { pc, only });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal((await transferEnd(host, one.body.transfer.id)).state, 'done');
    assert.deepEqual(Object.keys(filesIn(restoredIn(hostDir)[0])), ['src/main.js']);
    // A linked PC that is not there: 404 on every route.
    assert.equal((await host.get('/api/network/projects?pc=nope')).status, 404);
    assert.equal((await host.post('/api/network/projects', { pc: 'nope' })).status, 404);
    assert.equal((await host.post('/api/network/projects-back', { pc: 'nope' })).status, 404);
    // ---- The same node at a new address (its router gave it another): linked again, it keeps its backups ----
    const keepsOf = () => (JSON.parse(readFileSync(join(nodeDir, 'data', 'share.json'), 'utf8')).paired as { keep: string }[]).map(x => x.keep);
    const before = keepsOf();
    const again = await until('the node to link at its new address', async () => {
      const a = await host.post('/api/remotes', { action: 'add', url: `localhost:${workerPort}`, code: 'TEST-NQDE' });
      return a.status === 200 ? a : null;
    }, 30_000, 1000);
    assert.equal(again.status, 200);
    assert.deepEqual(keepsOf(), before, 'the node took the old link over (same restore-point folder), not a second one');
    assert.equal(remoteOf()?.id, pc);
    // Neither server printed a fault.
    for (const p of pcs) assert.doesNotMatch(p.said(), /Uncaught|TypeError|ReferenceError/, p.said());
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
