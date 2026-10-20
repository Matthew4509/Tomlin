import { test } from 'node:test';
import assert from 'node:assert/strict';
test('Hugging Face search: keeps public owner/name repos, most downloaded first, marks gated ones', async () => {
  const { hfFound } = await import('../src/download.ts');
  const got = hfFound([
    { id: 'a/small-GGUF', downloads: 10, likes: 1 },
    { id: 'b/big-GGUF', downloads: 900, likes: 5, gated: 'auto' },
    { id: 'c/secret', private: true, downloads: 5000 },
    { id: 'no-owner', downloads: 1 },
    { modelId: 'd/old-style', downloads: 50 },
  ]);
  assert.deepEqual(got.map(x => x.repo), ['b/big-GGUF', 'd/old-style', 'a/small-GGUF']);
  assert.equal(got[0].gated, true);
  assert.equal(got[1].gated, false);
  assert.deepEqual(hfFound({ error: 'x' }), []);
});
test('Hugging Face search: the next page is the cursor in the Link header, none on the last page', async () => {
  const { nextCursor } = await import('../src/download.ts');
  assert.equal(nextCursor('<https://huggingface.co/api/models?filter=gguf&limit=40&cursor=eyJhIjoxfQ%3D%3D>; rel="next"'), 'eyJhIjoxfQ==');
  assert.equal(nextCursor('<https://huggingface.co/api/models?cursor=abc&limit=40>; rel="next"'), 'abc');
  assert.equal(nextCursor(null), null);
  assert.equal(nextCursor(''), null);
});
test('Hugging Face search: a page cursor is kept only when it has one good place per search', async () => {
  const { cursorPlaces } = await import('../src/download.ts');
  const real = 'eyIkb3IiOlt7ImRvd25sb2FkcyI6NjM4MTl9XX0+/=';
  assert.deepEqual(cursorPlaces([real, false], 2), [real, false]);
  assert.deepEqual(cursorPlaces([real], 1), [real]);
  assert.deepEqual(cursorPlaces(null, 2), [null, null]);
  assert.deepEqual(cursorPlaces([real], 2), [null, null]);
  assert.deepEqual(cursorPlaces(['a&search=x'], 1), [null]);
  assert.deepEqual(cursorPlaces(real, 1), [null]);
});

test('a small draft head (mtp in the name, far fewer bits than the model has parameters) is not offered as a size', async () => {
  const { wholeModels } = await import('../src/download.ts');
  const m = (name: string, gb: number) => ({ name, files: [], bytes: gb * 2 ** 30 });
  // antirez/deepseek-v4: a 284B model whose smallest q8-named file is its 3.5 GB multi-token-prediction head.
  const deepseek = [m('DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32', 3.5), m('DeepSeek-V4-Flash-Q2_K', 90), m('DeepSeek-V4-Flash-Q4_K_M', 160)];
  assert.deepEqual(wholeModels(deepseek, 284e9).map(x => x.name), ['DeepSeek-V4-Flash-Q2_K', 'DeepSeek-V4-Flash-Q4_K_M']);
  // A whole model that carries MTP layers (its name says MTP, its size is a whole 9B model): kept.
  const fable = [m('Qwen3.5-9B-MAX-MTP-Q4_K_M', 6.4)];
  assert.deepEqual(wholeModels(fable, 9e9).map(x => x.name), ['Qwen3.5-9B-MAX-MTP-Q4_K_M']);
  // A small model in a repo of several (no mtp in its name): kept, whatever the header's total says.
  assert.equal(wholeModels([m('Tiny-1B-Q4_K_M', 0.7), m('Big-8B-Q4_K_M', 4.9)], 8e9).length, 2);
  // An importance-matrix file (imatrix_unsloth.gguf, 0.0 GB) and a FastMTP draft beside a 27B model: left out; a whole
  // model with IMATRIX in its name is kept by its size.
  const q27 = [m('imatrix_unsloth', 0.01), m('Qwen3.8-27B-FastMTP-32K', 0.8), m('Qwen3.8-27B-NEO-IMATRIX-Q4_K_M', 15.3)];
  assert.deepEqual(wholeModels(q27, 27.3e9).map(x => x.name), ['Qwen3.8-27B-NEO-IMATRIX-Q4_K_M']);
  // ggml-org/Qwen3.8-27B-GGUF's DFlash drafts (dflash-...-BF16 3.6 GB), and any file under half a bit a parameter.
  const dflash = [m('dflash-Qwen3.8-27B-BF16', 3.6), m('eagle3-Qwen3.8-27B', 0.9), m('odd-helper', 1.2), m('Qwen3.8-27B-Q4_K_M', 15.6)];
  assert.deepEqual(wholeModels(dflash, 26.9e9).map(x => x.name), ['Qwen3.8-27B-Q4_K_M']);
  // Parameters not known, or nothing would be left: every one is kept.
  assert.equal(wholeModels(deepseek, null).length, 3);
  assert.equal(wholeModels([deepseek[0]], 284e9).length, 1);
});

test('a repo whose GGUF header has no chat template (and no chat task) is not a chat model', async () => {
  const { chatMeta } = await import('../src/download.ts');
  // DeepBeepMeep/Wan2.1 (video) and Serveurperso/MiniMax-Music3: no task, no chat template.
  assert.equal(chatMeta({ gguf: { total: 4.84e9, architecture: 'qwen35' } }), false);
  assert.equal(chatMeta({ gguf: { total: 4.2e9, chat_template: '{% for m in messages %}' }, pipeline_tag: 'image-text-to-text' }), true);
  // A chat task with no template read: kept. No header read at all: not known, kept.
  assert.equal(chatMeta({ gguf: { total: 1e9 }, pipeline_tag: 'text-generation' }), true);
  assert.equal(chatMeta({}), true);
});

test('a GGUF header far smaller than the name says (a draft file read first) is not believed', async () => {
  const { paramsOf } = await import('../src/download.ts');
  assert.equal(paramsOf('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP', 1.9e9), 27e9);
  assert.equal(paramsOf('unsloth/Qwen3.5-9B-GGUF', 8.95e9), 8.95e9);
  assert.equal(paramsOf('antirez/deepseek-v4', 284e9), 284e9);
  assert.equal(paramsOf('someone/no-size-in-name', null), null);
});
