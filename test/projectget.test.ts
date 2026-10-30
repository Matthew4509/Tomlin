// A project whose project.json is damaged still opens: its scope and design are what the person wrote, and project.json
// only adds the one-line statement. Before, the read threw and the page got a 500. Also a source check on the speed
// finder: its saves go through updateData, so two at once cannot share one .tmp file or lose each other's result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('a damaged project.json does not stop the project opening', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-project-'));
  // With no folder chosen, the workspace is the one in the data folder.
  const workspace = join(home, 'data', 'workspace');
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const cases: Record<string, string> = { '20261030-1200-0001': '{"answers":{"statement":"cut off', '20261030-1200-0002': 'null', '20261030-1200-0003': '[1,2]' };
  for (const [id, meta] of Object.entries(cases)) {
    mkdirSync(join(workspace, 'jobs', id), { recursive: true });
    writeFileSync(join(workspace, 'jobs', id, 'scope.md'), '# Made-up scope');
    writeFileSync(join(workspace, 'jobs', id, 'design.md'), '# Made-up design');
    writeFileSync(join(workspace, 'jobs', id, 'project.json'), meta);
  }
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);
    for (const id of Object.keys(cases)) {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects/get?id=${id}`);
      const j = await r.json() as { scope?: string; design?: string; statement?: string };
      assert.equal(r.status, 200, `${id}: ${JSON.stringify(j)}`);
      assert.equal(j.scope, '# Made-up scope', id);
      assert.equal(j.design, '# Made-up design', id);
      assert.equal(j.statement, '', id);
    }
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});

test('the speed finder saves its results in one turn, with no .tmp file of its own', () => {
  const src = readFileSync(new URL('../src/server/finder.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.tmp`/);
  assert.match(src, /updateData<[^>]*>*\(FILE,/);
});
