// Two real PCs on this one (test/pcs.ts): every model on a node can be used by the PCs linked to it. Nothing has to be
// ticked first (a node made before kept a list of ticked models; that list is no longer read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, nodeHome, startPc, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('two PCs: a model on the node that nobody ticked is listed for the linked PC', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-shareall-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    // The node's own models folder, with one made-up model in it (a few bytes: listed, never loaded here).
    const models = join(nodeDir, 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 'Tiny-Test-Q4_K_M.gguf'), 'GGUF stand-in');
    const modelsFile = join(nodeDir, 'models-here.txt');
    writeFileSync(modelsFile, models);
    pcs.push(await startPc({ root: ROOT, home: nodeDir, env: { MODELS_FILE: modelsFile } }));
    const host = await startPc({ root: ROOT, home: join(top, 'host') });
    pcs.push(host);
    const pc = await link(host, workerPort);

    // share.json says models: [] (nothing ticked), and the model is listed all the same.
    const seen = await until('the node\'s models on the host', async () => {
      const r = await host.get('/api/nodes/others');
      const row = (r.body?.pcs ?? []).find((x: { id: string }) => x.id === pc);
      return row?.models?.length ? row.models : null;
    }, 60_000, 1000);
    assert.ok(seen.some((m: { id: string; name: string }) => m.name === 'Tiny-Test-Q4_K_M' && m.id.endsWith('Tiny-Test-Q4_K_M.gguf')), JSON.stringify(seen));
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
