// Same model, smaller file, fits the card, on a real copy: the finder's preview offers it only for a model that spills
// over its card (a tiny test file never does), and its download route downloads nothing without his press ({yes: true})
// and the offer as the window showed it. The sums are in test/quantfit.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NINE = 'Qwen3.5-9B-Q4_K_M.gguf';

test('a model that does not spill gets no smaller-file offer, and the download needs his yes and the offer shown', { timeout: 120_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-smaller-'));
  let pc: Pc | null = null;
  try {
    const home = join(top, 'pc');
    const chat = join(home, 'models', 'chat');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, NINE), 'G'.repeat(4000));
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    pc = await startPc({ root: ROOT, home, env: { OLLAMA: noOllama } });
    const p = await pc.get(`/api/speed/find?model=${encodeURIComponent(NINE)}&size=quick`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.smaller, null, 'a 4 KB file sits on any card: nothing to offer');
    assert.ok(!p.body.left.some((l: { name: string }) => l.name === 'Same model, smaller file, fits the card'), 'not even a "not tried" line when it does not spill');
    const no = await pc.post('/api/speed/find/smaller', { model: NINE, repo: 'unsloth/Qwen3.5-9B-GGUF', rev: 'main', name: 'Qwen3.5-9B-UD-IQ3_XXS', bytes: 4015932448 });
    assert.equal(no.status, 400);
    assert.match(no.body.error, /Nothing was downloaded: the download starts only from its Download button/);
    const notOffered = await pc.post('/api/speed/find/smaller', { model: NINE, yes: true, repo: 'unsloth/Qwen3.5-9B-GGUF', rev: 'main', name: 'Qwen3.5-9B-UD-IQ3_XXS', bytes: 4015932448 });
    assert.equal(notOffered.status, 409);
    assert.match(notOffered.body.error, /Nothing was downloaded/);
    const state = await pc.get('/api/chatmodels/get');
    assert.equal(state.body, null, 'no download was started');
  } finally {
    await pc?.stop();
    rmSync(top, { recursive: true, force: true });
  }
});

test('wired in: every finished chat-model download writes where it came from; a linked PC passes the press on', () => {
  const hf = readFileSync(join(ROOT, 'src', 'server', 'hf.ts'), 'utf8');
  assert.match(hf, /state = 'done';\s*\n\s*await keepSource\(m\.name, \{ repo, rev, bytes: m\.bytes/);
  const copies = readFileSync(join(ROOT, 'src', 'jobrun', 'copies.ts'), 'utf8');
  assert.match(copies, /'undo', 'smaller'\]\.includes\(action\)/);
  assert.match(copies, /yes: b\.yes === true/);
  const page = readFileSync(join(ROOT, 'public', 'finder.js'), 'utf8');
  assert.match(page, /finderAsk\('smaller', \{ yes: true/);
  assert.match(page, /The file you use now is kept/);
});
