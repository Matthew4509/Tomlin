// A Bridge audit runs beside TOMLIN, not on its server thread: while a slow scan reads a project, /api/status (and so
// chat, nodes and the office) still answers; a second scan of the same project is turned away with a clear message
// until the first ends. BRIDGE_TEST_AUDIT_SPIN_MS makes each scan hold its thread for that long, as a big project does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});
const SPIN = 3000;

test('a slow Bridge audit does not hold up /api/status, and one project is scanned once at a time', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-audit-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  mkdirSync(join(home, 'data', 'workspace', 'slow-site'), { recursive: true });
  writeFileSync(join(home, 'data', 'workspace', 'slow-site', 'index.html'), '<p>made-up site</p>');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '', BRIDGE_TEST_AUDIT_SPIN_MS: String(SPIN) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);
    const key = /name="bridge-key" content="([0-9a-f]+)"/.exec(await (await fetch(`${base}/bridge/`)).text())?.[1];
    assert.ok(key, 'the Bridge page carries its key');
    const kpost = (p: string, body: unknown) => fetch(`${base}/bridge${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': key! }, body: JSON.stringify(body) });
    const listed = (await (await fetch(`${base}/bridge/api/projects`, { headers: { 'x-bridge-key': key! } })).json()) as { projects: { id: string; folder: string }[] };
    const site = listed.projects.find(x => x.folder === 'slow-site');
    assert.ok(site, JSON.stringify(listed.projects.map(x => x.folder)));

    const first = kpost('/api/audit', { id: site.id }).catch((e: Error) => e);
    await new Promise(r => setTimeout(r, 400));
    // A server thread held by the audit lets idle connections time out under the request: reported, not thrown.
    const t0 = Date.now();
    const status = await fetch(`${base}/api/status`).catch((e: Error) => e);
    const waited = Date.now() - t0;
    assert.ok(!(status instanceof Error), `/api/status failed after ${waited} ms behind the audit: ${status instanceof Error ? (status.cause as Error)?.message ?? status.message : ''}`);
    assert.equal(status.status, 200);
    assert.ok(waited < 1200, `/api/status waited ${waited} ms behind the audit`);

    const again = await kpost('/api/audit', { id: site.id });
    const againText = await again.text();
    assert.equal(again.status, 409, againText);
    assert.match(againText, /already being scanned/, againText);

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
    server.kill();
    await new Promise(r => server.once('exit', r));
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
