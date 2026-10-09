// The short name Hire staff offers for a model (src/nicknames.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { freeNickname, nickname } from '../src/nicknames.ts';

test('a model gets its family name, as its makers spell it, past uploaders and file words', () => {
  const cases: Array<[string, string]> = [
    // Names typed as people say them.
    ['qwen 35b a3b moe', 'Qwen'],
    ['Gemini wwqwaetqwe', 'Gemini'],
    // Files as they are named on disk.
    ['*/Qwen3.5-0.8B-Q4_K_M.gguf', 'Qwen'],
    ['gemma-3-1b-it-Q4_K_M.gguf', 'Gemma'],
    ['Qwen3.5-35B-A3B', 'Qwen'],
    // Uploaders and makers in front, and words that only describe the file.
    ['google_gemma-3-12b-it-Q4_K_M.gguf', 'Gemma'],
    ['Meta-Llama-3.1-8B-Instruct', 'Llama'],
    ['Huihui-Qwen3.8-abliterated', 'Qwen'],
    ['TheDrummer_Cydonia-24B', 'Cydonia'],
    ['Ternary-Bonsai-8B', 'Bonsai'],
    // Spelling and short forms.
    ['DeepSeek-R1-Distill-Qwen-7B', 'DeepSeek'],
    ['deepseek-v4.1-flash', 'DeepSeek'],
    ['GLM-5.3-Flash', 'GLM'],
    ['gpt-oss-20b', 'GPT'],
    ['MN-12B-Mag-Mell', 'Nemo'],
    ['embeddinggemma-300m', 'Gemma'],
    ['POCKET-35B', 'Pocket'],
    // Picture models.
    ['DreamShaper 8 LCM (SD 1.5, fast, illustration)', 'DreamShaper'],
    ['Realistic Vision 6 + LCM (SD 1.5, fast)', 'Realistic'],
    ['Qwen-Image 2.1 (7B, Q4, best quality, slow)', 'Qwen'],
    // Nothing that could be a name.
    ['12345.gguf', ''],
    ['', ''],
  ];
  for (const [name, want] of cases) assert.equal(nickname(name), want, name);
});

test('a name already on the team gets the next number', () => {
  assert.equal(freeNickname('Qwen3-8B', []), 'Qwen');
  assert.equal(freeNickname('Qwen3-8B', ['qwen', 'Sam']), 'Qwen 2');
  assert.equal(freeNickname('Qwen3-8B', ['Qwen', 'Qwen 2']), 'Qwen 3');
  assert.equal(freeNickname('12345', ['Qwen']), '');
});

test('the shipped Hugging Face list: the most downloaded families all get a real name', () => {
  const list = JSON.parse(gunzipSync(readFileSync(new URL('../registry/hf-list.json.gz', import.meta.url))).toString()) as { models: [string, number][] };
  const by = new Map<string, number>();
  let total = 0;
  for (const [repo, dl] of list.models) {
    total += dl;
    const n = nickname(repo.split('/')[1]);
    by.set(n, (by.get(n) ?? 0) + dl);
  }
  // Under 2% of the downloads come out with no name at all.
  assert.ok((by.get('') ?? 0) / total < 0.02);
  const top = [...by].filter(([n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
  for (const n of ['Qwen', 'Gemma', 'Llama', 'DeepSeek', 'GLM', 'Mistral']) assert.ok(top.includes(n), `${n} in ${top.join(', ')}`);
  // No word that only describes a file is ever a name.
  for (const bad of ['Gguf', 'Abliterated', 'Uncensored', 'Instruct', 'Model', 'Mtp']) assert.ok(!by.has(bad), bad);
});
