// Usability: the Models list leaves out what cannot be downloaded and shows sizes up front,
// an artist's chat is named by the first thing asked, and a linked PC that refuses this one says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupGguf, hfFound, paramsFromName, usualModel } from '../src/download.ts';
import { pcState } from '../src/home.ts';
import { Chats, NEW_TITLE } from '../src/chats.ts';
import { Store } from '../src/store.ts';

const file = (path: string, gb: number) => ({ path, bytes: Math.round(gb * 2 ** 30), sha256: 'x' });

test('Hugging Face search: a repo with no model file of its own, or that is not a chat model, is left out', () => {
  const got = hfFound([
    { id: 'a/chat-GGUF', downloads: 30, siblings: [{ rfilename: 'chat-Q4_K_M.gguf' }], gguf: { total: 9e9, chat_template: '{{x}}' } },
    { id: 'b/empty-GGUF', downloads: 900, siblings: [{ rfilename: 'README.md' }], gguf: { total: 9e9, chat_template: '{{x}}' } },
    { id: 'c/vision-only-GGUF', downloads: 800, siblings: [{ rfilename: 'mmproj-F16.gguf' }], gguf: { total: 4e8 } },
    { id: 'd/picture-model-GGUF', downloads: 700, siblings: [{ rfilename: 'image-Q4_0.gguf' }], gguf: { total: 7e9 }, pipeline_tag: 'text-to-image' },
    { id: 'e/old-chat-GGUF', downloads: 20, siblings: [{ rfilename: 'old.Q4_K_M.gguf' }], gguf: { total: 7e9 }, pipeline_tag: 'text-generation' },
  ]);
  assert.deepEqual(got.map(x => x.repo), ['a/chat-GGUF', 'e/old-chat-GGUF']);
  assert.equal(got[0].params, 9e9);
});

test('Hugging Face search: a header that says far fewer parameters than the name is not believed', () => {
  const [x] = hfFound([{ id: 'f/Qwen3.8-27B-Thing-GGUF', downloads: 1, siblings: [{ rfilename: 'a-Q4_K_M.gguf' }], gguf: { total: 4.6e8, chat_template: 'x' } }]);
  assert.equal(x.params, 27e9);
});

test('parameters from a name: 9B, 0.8B, 270M; a mixture of experts counts its full size', () => {
  assert.equal(paramsFromName('Qwen3.5-9B-GGUF'), 9e9);
  assert.equal(paramsFromName('Qwen3.5-0.8B-GGUF'), 0.8e9);
  assert.equal(paramsFromName('gemma-3-270m-it-GGUF'), 270e6);
  assert.equal(paramsFromName('Qwen3.5-35B-A3B-GGUF'), 35e9);
  assert.equal(paramsFromName('Phi-4-mini-instruct-GGUF'), null);
});

test('the usual size is Q4_K_M, else the smallest of 4 bits or more; draft heads (mtp-) are not models', () => {
  const models = groupGguf([
    file('mtp-gemma-4-E4B-it-Q4_0.gguf', 0.06),
    file('gemma-4-E4B-it-Q2_K.gguf', 3.1),
    file('gemma-4-E4B-it-Q4_0.gguf', 4.3),
    file('gemma-4-E4B-it-Q4_K_M.gguf', 4.6),
    file('gemma-4-E4B-it-BF16.gguf', 14),
  ]);
  assert.ok(!models.some(m => m.name.startsWith('mtp-')));
  assert.equal(usualModel(models)?.name, 'gemma-4-E4B-it-Q4_K_M');
  assert.equal(usualModel(models.filter(m => !/q4_k_m/i.test(m.name)))?.name, 'gemma-4-E4B-it-Q4_0');
  // A big model in parts, in a folder of its own: one model, its parts together.
  const big = groupGguf([file('Q4_K_M/big-Q4_K_M-00001-of-00002.gguf', 40), file('Q4_K_M/big-Q4_K_M-00002-of-00002.gguf', 30)]);
  assert.equal(big.length, 1);
  assert.equal(big[0].files.length, 2);
  assert.equal(usualModel([]), null);
});

test('a linked PC that answers but refuses this one says what it said, not "not answering"', () => {
  assert.equal(pcState({ ok: false }).text, 'Off: not answering');
  const s = pcState({ ok: false, answered: true, error: 'This manager is not paired with this PC.' });
  assert.equal(s.state, 'off');
  assert.match(s.text, /^Not linked any more: This manager is not paired with this PC\. Link it again/);
});

test('an artist chat is named by the first thing asked, moves to the top, and keeps a name he gave it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-touch-'));
  try {
    const chats = new Chats(new Store(dir));
    const a = await chats.create('staff:clara', '2026-10-05T01:00:00.000Z');
    const b = await chats.create('manager', '2026-10-05T02:00:00.000Z');
    assert.equal((await chats.list())[0].id, b.id);
    await chats.touch(a.id, 'a red lighthouse on a rocky shore at dusk, 512x512', '2026-10-05T03:00:00.000Z');
    assert.equal((await chats.list())[0].id, a.id);
    assert.equal((await chats.get(a.id))?.title, 'a red lighthouse on a rocky shore at dusk…');
    await chats.touch(a.id, 'a blue boat');
    assert.equal((await chats.get(a.id))?.title, 'a red lighthouse on a rocky shore at dusk…');
    await chats.rename(b.id, 'Mine');
    await chats.touch(b.id, 'something');
    assert.equal((await chats.get(b.id))?.title, 'Mine');
    assert.equal(await chats.touch('f'.repeat(12), 'x'), null);
    assert.notEqual(NEW_TITLE, (await chats.get(a.id))?.title);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
