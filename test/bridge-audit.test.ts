// A Bridge audit runs beside TOMLIN, not on its server thread: while a slow scan reads a project, /api/status (and so
// chat, nodes and the office) still answers; a second scan of the same project is turned away with a clear message
// until the first ends. BRIDGE_TEST_AUDIT_SPIN_MS makes each scan hold its thread for that long, as a big project does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './env.ts';
import { startLine } from './pcs.ts';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});
const SPIN = 40_000;
// /api/status held behind the scan would wait for all of SPIN. One that answers in well under it was not held. With
// every core busy and other tests running beside it, one answer took 20 s that had nothing to do with the scan (18 Nov
// 2026), so the scan holds its thread for 40 s and only a wait of 30 s or more counts as held.
const HELD_IF = 30_000;

test('a slow Bridge audit does not hold up /api/status, and one project is scanned once at a time', { timeout: 1_800_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-audit-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  mkdirSync(join(home, 'data', 'workspace', 'slow-site'), { recursive: true });
  writeFileSync(join(home, 'data', 'workspace', 'slow-site', 'index.html'), '<p>made-up site</p>');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: testEnv({ TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '', BRIDGE_TEST_AUDIT_SPIN_MS: String(SPIN) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await startLine(server, () => said), 'up', said);
    const key = /name="bridge-key" content="([0-9a-f]+)"/.exec(await (await fetch(`${base}/bridge/`)).text())?.[1];
    assert.ok(key, 'the Bridge page carries its key');
    // Each ask has no time limit of its own: fetch gives up on an answer after 300 s, and on a busy PC a scan took longer.
    const kpost = (p: string, body: unknown) => new Promise<Response>((resolve, reject) => {
      const text = JSON.stringify(body);
      const req = request(`${base}/bridge${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-bridge-key': key! } }, res => {
        const got: Buffer[] = [];
        res.on('data', d => got.push(d));
        res.on('end', () => resolve(new Response(Buffer.concat(got), { status: res.statusCode ?? 0 })));
      });
      req.on('error', reject);
      req.end(text);
    });
    const listed = (await (await fetch(`${base}/bridge/api/projects`, { headers: { 'x-bridge-key': key! } })).json()) as { projects: { id: string; folder: string }[] };
    const site = listed.projects.find(x => x.folder === 'slow-site');
    assert.ok(site, JSON.stringify(listed.projects.map(x => x.folder)));

    const first = kpost('/api/audit', { id: site.id }).catch((e: Error) => e);
    let over = false;
    void first.then(() => (over = true));
    // /api/status is asked again and again for as long as the scan runs, so some of the asks fall inside it however
    // long the scan takes to start on a busy PC. Had the scan held the server thread, one of them would wait for most of it.
    let worst = 0;
    let asked = 0;
    let againText = '';
    while (!over) {
      // A server thread held by the audit lets idle connections time out under the request: reported, not thrown.
      const t0 = Date.now();
      const status = await fetch(`${base}/api/status`).catch((e: Error) => e);
      const waited = Date.now() - t0;
      assert.ok(!(status instanceof Error), `/api/status failed after ${waited} ms behind the audit: ${status instanceof Error ? (status.cause as Error)?.message ?? status.message : ''}`);
      assert.equal(status.status, 200);
      await status.arrayBuffer();
      worst = Math.max(worst, waited);
      asked++;
      if (!againText) {
        // While the first scan runs, a second scan of the same project is turned away.
        const again = await kpost('/api/audit', { id: site.id });
        againText = await again.text();
        assert.equal(again.status, 409, againText);
        assert.match(againText, /already being scanned/, againText);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(againText, 'a second scan was asked for while the first ran');
    assert.ok(worst < HELD_IF, `/api/status waited ${worst} ms behind the audit (asked ${asked} times during a ${SPIN} ms scan)`);

    const done = await first;
    assert.ok(!(done instanceof Error), `the scan's own request failed: ${done instanceof Error ? (done.cause as Error)?.message ?? done.message : ''}`);
    const doneBody = (await done.json()) as { ok: boolean; audit: { ranAt: string; filesScanned: number } };
    assert.equal(done.status, 200, JSON.stringify(doneBody));
    assert.ok(doneBody.ok && doneBody.audit.ranAt && doneBody.audit.filesScanned >= 1, JSON.stringify(doneBody));
    const saved = (await (await fetch(`${base}/bridge/api/audit?id=${encodeURIComponent(site.id)}`, { headers: { 'x-bridge-key': key! } })).json()) as { audit: { ranAt: string } };
    assert.equal(saved.audit.ranAt, doneBody.audit.ranAt, 'the finished audit is the one saved');

    // The scan has ended, so the project can be scanned again.
    const third = await kpost('/api/audit', { id: site.id });
    assert.equal(third.status, 200, await third.clone().text());
  } finally {
    // Waited for only while it runs: a server that already stopped (at start, say) sends no second exit, and waiting for
    // one held the test until its time ran out with the real fault unsaid.
    if (server.exitCode === null && server.signalCode === null) {
      const gone = new Promise(r => server.once('exit', r));
      server.kill();
      await gone;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
