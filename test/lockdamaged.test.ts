// A damaged app lock file keeps TOMLIN shut: a real copy started on a home whose app-lock.json is cut off answers
// every shut door with 423 (no cookie, no PIN opens it), while the page still learns it is locked and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPc } from './pcs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a damaged app lock file keeps every door shut', { timeout: 120_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-lockdamaged-'));
  let pc;
  try {
    mkdirSync(join(top, 'data'), { recursive: true });
    writeFileSync(join(top, 'data', 'app-lock.json'), '{"salt":"ab');
    pc = await startPc({ root: ROOT, home: top });
    const view = await pc.get('/api/applock');
    assert.equal(view.body.on, true);
    assert.equal(view.body.open, false);
    assert.ok(view.body.damaged, 'the page is told the lock file is damaged');
    assert.equal((await pc.get('/api/chats')).status, 423);
    assert.equal((await pc.get('/api/models')).status, 423);
    assert.equal((await pc.post('/api/notes', { text: 'x' })).status, 423);
    assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '0000' })).status, 423, 'no PIN opens a damaged lock');
  } finally {
    await pc?.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
