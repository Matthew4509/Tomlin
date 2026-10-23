import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HfList, isMoe, listed, nextPage, ordered, pick, type ListedModel } from '../src/hflist.ts';

test('Hugging Face list: keeps public chat models (or no task said) that people use', () => {
  const got = listed([
    { id: 'a/Qwen3.5-9B-GGUF', downloads: 500, likes: 3, pipeline_tag: 'text-generation' },
    { id: 'b/Mystery-GGUF', downloads: 50 },
    { id: 'c/all-MiniLM-L6-v2-GGUF', downloads: 9000, pipeline_tag: 'sentence-similarity' },
    { id: 'd/Gated-7B-GGUF', downloads: 900, gated: 'manual' },
    { id: 'e/Secret-GGUF', downloads: 900, private: true },
    { id: 'f/Rare-1B-GGUF', downloads: 3 },
    { id: 'no-owner', downloads: 100 },
    { id: 'g/Open-3B-GGUF', downloads: 20, gated: false, pipeline_tag: 'image-text-to-text' },
  ]);
  assert.deepEqual(got, [['a/Qwen3.5-9B-GGUF', 500, 3, 9e9], ['b/Mystery-GGUF', 50, 0, null], ['g/Open-3B-GGUF', 20, 0, 3e9]]);
  assert.deepEqual(listed({ error: 'x' }), []);
});

test('Hugging Face list: the next page is followed only on Hugging Face', () => {
  assert.equal(nextPage('<https://huggingface.co/api/models?limit=1000&cursor=abc>; rel="next"'), 'https://huggingface.co/api/models?limit=1000&cursor=abc');
  assert.equal(nextPage('<https://evil.example/api/models?x=1>; rel="next"'), null);
  assert.equal(nextPage(null), null);
});

const LIST: ListedModel[] = [
  ['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 900, 1, 27e9],
  ['unsloth/Qwen3.5-9B-GGUF', 800, 1, 9e9],
  ['x/Gemma-4-E4B-Uncensored-GGUF', 700, 1, 4e9],
  ['bartowski/Llama-3.2-3B-Instruct-GGUF', 600, 1, 3.2e9],
  ['someone/smallthinker-GGUF', 500, 1, null],
  ['allura-org/Qwen3-8B-Anko-GGUF', 400, 1, 8e9],
];
const repos = (l: ListedModel[]) => l.map(m => m[0]);

test('Hugging Face list: words at the start of a word, any order; "all" is every model', () => {
  assert.deepEqual(repos(pick(LIST, { q: 'qwen' })), ['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'unsloth/Qwen3.5-9B-GGUF', 'allura-org/Qwen3-8B-Anko-GGUF']);
  assert.deepEqual(repos(pick(LIST, { q: '3b llama' })), ['bartowski/Llama-3.2-3B-Instruct-GGUF']);
  assert.deepEqual(repos(pick(LIST, { q: '3.5' })), ['unsloth/Qwen3.5-9B-GGUF']);
  assert.equal(pick(LIST, { q: 'all' }).length, LIST.length);
  // "all" as a word is not inside "small" or "allura" when it is one of several words.
  assert.deepEqual(repos(pick(LIST, { q: 'thinker' })), []);
});

test('Hugging Face list: ticked terms are either-or, and the size in the name narrows it', () => {
  assert.deepEqual(repos(pick(LIST, { q: '', terms: ['abliterated', 'uncensored'] })), ['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'x/Gemma-4-E4B-Uncensored-GGUF']);
  assert.deepEqual(repos(pick(LIST, { q: 'gemma', terms: ['abliterated', 'uncensored'] })), ['x/Gemma-4-E4B-Uncensored-GGUF']);
  // A name with no size is kept: its size is checked when its sizes are read.
  assert.deepEqual(repos(pick(LIST, { q: '', maxB: 4 })), ['x/Gemma-4-E4B-Uncensored-GGUF', 'bartowski/Llama-3.2-3B-Instruct-GGUF', 'someone/smallthinker-GGUF']);
  assert.deepEqual(repos(pick(LIST, { q: 'qwen', minB: 9, maxB: 9 })), ['unsloth/Qwen3.5-9B-GGUF']);
});

test('Hugging Face list: a scan reads every page, keeps the first of a model seen twice, and a failed scan keeps the old list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hflist-'));
  try {
    const file = join(dir, 'hf-list.json');
    const pages: Record<string, { body: unknown[]; next?: string }> = {
      first: { body: [{ id: 'a/One-9B-GGUF', downloads: 900 }, { id: 'b/Two-GGUF', downloads: 500 }], next: 'https://huggingface.co/api/models?cursor=2' },
      'https://huggingface.co/api/models?cursor=2': { body: [{ id: 'b/Two-GGUF', downloads: 400 }, { id: 'c/Three-GGUF', downloads: 300 }, { id: 'd/Rare-GGUF', downloads: 2 }], next: 'https://huggingface.co/api/models?cursor=3' },
    };
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      const p = pages[url.includes('cursor=') ? url : 'first'];
      return new Response(JSON.stringify(p.body), { headers: p.next ? { link: `<${p.next}>; rel="next"` } : {} });
    }) as typeof fetch;
    const list = new HfList(file);
    assert.equal(await list.get(), null);
    list.scan(fake);
    for (let i = 0; i < 100 && (await list.status()).scanning; i++) await new Promise(r => setTimeout(r, 10));
    const st = await list.status();
    // The second page ended under 10 downloads: the third was never asked for.
    assert.equal(asked.length, 2);
    assert.equal(st.count, 3);
    assert.equal(st.error, '');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).models.map((m: ListedModel) => [m[0], m[1]]), [['a/One-9B-GGUF', 900], ['b/Two-GGUF', 500], ['c/Three-GGUF', 300]]);

    const broken = (async () => new Response('busy', { status: 429 })) as typeof fetch;
    list.scan(broken);
    for (let i = 0; i < 100 && (await list.status()).scanning; i++) await new Promise(r => setTimeout(r, 10));
    const after = await list.status();
    assert.equal(after.count, 3);
    assert.match(after.error, /Hugging Face answered 429.*list from before is kept/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hugging Face list: the copy shipped with TOMLIN is read until this PC has its own scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hflist-'));
  try {
    const own = join(dir, 'hf-list.json');
    const shipped = join(dir, 'hf-list.json.gz');
    await writeFile(shipped, gzipSync(JSON.stringify({ scannedAt: '2026-10-05T08:39:04.554Z', floor: 10, models: [['a/Shipped-GGUF', 50, 1, null]] })));
    assert.deepEqual(await new HfList(own, shipped).status(), { scannedAt: '2026-10-05T08:39:04.554Z', count: 1, scanning: null, error: '' });
    await writeFile(own, JSON.stringify({ scannedAt: '2026-11-01T00:00:00.000Z', floor: 10, models: [['b/Own-GGUF', 9, 0, null], ['c/Own-GGUF', 8, 0, null]] }));
    assert.equal((await new HfList(own, shipped).status()).count, 2);
    // Neither there (or the shipped one broken): no list, so the search asks Hugging Face live.
    await writeFile(shipped, 'not gzip');
    assert.equal(await new HfList(join(dir, 'none.json'), shipped).get(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Mixture-of-experts: a mixture of experts is known by its name, and ticking it keeps only those", () => {
  for (const n of ['unsloth/Qwen3-30B-A3B-GGUF', 'TheBloke/Mixtral-8x7B-Instruct-v0.1-GGUF', 'allenai/OLMoE-1B-7B-0924', 'bartowski/Phi-3.5-MoE-instruct-GGUF', 'unsloth/gpt-oss-20b-GGUF', 'ibm/granite-3.0-3b-a800m-instruct', 'LiquidAI/LFM2-8B-A1B-GGUF']) assert.ok(isMoe(n), n);
  for (const n of ['unsloth/Qwen3.5-9B-GGUF', 'unsloth/gemma-3n-E4B-it-GGUF', 'TheBloke/Llama-2-7B-AWQ', 'some/amoeba-7b']) assert.ok(!isMoe(n), n);
  const list: ListedModel[] = [['a/Qwen3-30B-A3B-GGUF', 50, 0, 30e9], ['b/Qwen3.5-9B-GGUF', 90, 0, 9e9], ['c/gpt-oss-20b-GGUF', 70, 0, 20e9]];
  assert.deepEqual(pick(list, { q: 'all', moe: true }).map(m => m[0]), ['a/Qwen3-30B-A3B-GGUF', 'c/gpt-oss-20b-GGUF']);
});

test('Size and A to Z order the whole list both ways; a name with no size goes last; unset keeps most downloaded', () => {
  const list: ListedModel[] = [['x/Big-70B', 10, 0, 70e9], ['y/alpha-1B', 30, 0, 1e9], ['z/Mystery', 50, 0, null], ['w/Mid-8B', 20, 0, 8e9]];
  const names = (o: string) => ordered(list, o).map(m => m[0]);
  assert.deepEqual(names('size-asc'), ['y/alpha-1B', 'w/Mid-8B', 'x/Big-70B', 'z/Mystery']);
  assert.deepEqual(names('size-desc'), ['x/Big-70B', 'w/Mid-8B', 'y/alpha-1B', 'z/Mystery']);
  assert.deepEqual(names('name-asc'), ['y/alpha-1B', 'x/Big-70B', 'w/Mid-8B', 'z/Mystery']);
  assert.deepEqual(names('name-desc'), ['z/Mystery', 'w/Mid-8B', 'x/Big-70B', 'y/alpha-1B']);
  assert.deepEqual(names(''), list.map(m => m[0]));
});
