// What a chat model can do, for the Models page labels and filter: reads pictures, has a place for tools, or neither (General).
// Fake Hugging Face data and tiny fake GGUF files only; no network. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capsFromHf, capsPass, cleanKinds, hasVisionFile, modelCaps, templateHasTools, visionFileFor } from '../src/capabilities.ts';

/** A tiny GGUF file: string header values only, no tensors. */
function gguf(values: Array<[string, string]>): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(values.length), ...values.flatMap(([k, v]) => [str(k), u32(8), str(v)])]);
}

const QWEN_STYLE = '{%- if tools %}\n<|im_start|>system\n{{- "# Tools" }}\n{%- for tool in tools %}{{ tool | tojson }}{%- endfor %}{%- endif %}\n{%- for message in messages %}{{ message.content }}{%- endfor %}';
const PLAIN_STYLE = "{% for message in messages %}{{ '<start_of_turn>' + message['role'] + '\\n' + message['content'] + '<end_of_turn>\\n' }}{% endfor %}";

test('a chat template has a place for tools when it uses the tools list, tool calls, a tool role, or the special words', () => {
  assert.equal(templateHasTools(QWEN_STYLE), true);
  assert.equal(templateHasTools('{% for m in messages %}{% if m.tool_calls %}x{% endif %}{% endfor %}'), true);
  assert.equal(templateHasTools("{% if message.role == 'tool' %}{{ message.content }}{% endif %}"), true);
  assert.equal(templateHasTools('[AVAILABLE_TOOLS] [{"name":"x"}] [/AVAILABLE_TOOLS]'), true);
  assert.equal(templateHasTools('<|python_tag|>'), true);
  assert.equal(templateHasTools(PLAIN_STYLE), false);
  assert.equal(templateHasTools(''), false);
  assert.equal(templateHasTools(undefined), false);
  assert.equal(templateHasTools(42), false);
});

test('Hugging Face: pictures from the task or a vision file in the repo, tools from the chat template', () => {
  assert.deepEqual(capsFromHf({ pipeline_tag: 'text-generation', files: ['m-Q4_K_M.gguf'], chat_template: PLAIN_STYLE }), { images: false, tools: false });
  assert.deepEqual(capsFromHf({ pipeline_tag: 'image-text-to-text', files: ['m-Q4_K_M.gguf'], chat_template: PLAIN_STYLE }), { images: true, tools: false });
  assert.deepEqual(capsFromHf({ pipeline_tag: 'text-generation', files: ['m-Q4_K_M.gguf', 'mmproj-F16.gguf'], chat_template: QWEN_STYLE }), { images: true, tools: true });
  // A vision file inside a folder counts too; a file merely containing the letters elsewhere does not.
  assert.equal(hasVisionFile(['Q4/m.gguf', 'vision/mmproj-BF16.gguf']), true);
  assert.equal(hasVisionFile(['m-Q4_K_M.gguf', 'README.md', 'mmproj.txt']), false);
  assert.deepEqual(capsFromHf({}), { images: false, tools: false });
});

test('the filter: any one ticked kind passes; none ticked passes all; an unknown model passes none of the ticked kinds', () => {
  const pics = { images: true, tools: false };
  const both = { images: true, tools: true };
  const tools = { images: false, tools: true };
  const plain = { images: false, tools: false };
  assert.deepEqual([pics, both, tools, plain].map(c => capsPass(c, ['images'])), [true, true, false, false]);
  assert.deepEqual([pics, both, tools, plain].map(c => capsPass(c, ['tools'])), [false, true, true, false]);
  assert.deepEqual([pics, both, tools, plain].map(c => capsPass(c, ['general'])), [false, false, false, true]);
  assert.deepEqual([pics, both, tools, plain].map(c => capsPass(c, ['images', 'tools'])), [true, true, true, false]);
  assert.deepEqual([pics, both, tools, plain].map(c => capsPass(c, [])), [true, true, true, true]);
  assert.equal(capsPass(null, []), true);
  assert.equal(capsPass(null, ['general']), false);
  assert.equal(capsPass(undefined, ['images']), false);
});

test('the kinds the page sends are cleaned: only the three words, each once, in a fixed order', () => {
  assert.deepEqual(cleanKinds(['tools', 'images', 'tools', 'evil', 7]), ['images', 'tools']);
  assert.deepEqual(cleanKinds(['general']), ['general']);
  assert.deepEqual(cleanKinds('images'), []);
  assert.deepEqual(cleanKinds(undefined), []);
});

test('a vision file beside a model: named for it, or a general name when the folder holds no other model', () => {
  assert.equal(visionFileFor('Qwen3.5-9B-Q4_K_M.gguf', ['Qwen3.5-9B-Q4_K_M.gguf', 'mmproj-Qwen3.5-9B-F16.gguf']), true);
  assert.equal(visionFileFor('gemma-3-4b-it-Q4_K_M.gguf', ['gemma-3-4b-it-Q4_K_M.gguf', 'mmproj-F16.gguf']), true);
  // A general name beside several models says nothing about which one it belongs to.
  assert.equal(visionFileFor('a-Q4_K_M.gguf', ['a-Q4_K_M.gguf', 'b-Q4_K_M.gguf', 'mmproj-F16.gguf']), false);
  // One named for another model is not this one's.
  assert.equal(visionFileFor('Llama-3.2-3B-Q4_K_M.gguf', ['Llama-3.2-3B-Q4_K_M.gguf', 'mmproj-Qwen3.5-9B-F16.gguf']), false);
  assert.equal(visionFileFor('m.gguf', ['m.gguf']), false);
});

test('a model file on this PC: tools from its chat template, pictures from its architecture, its name or a vision file beside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-caps-'));
  try {
    const put = async (name: string, values: Array<[string, string]>) => {
      await writeFile(join(dir, name), gguf(values));
      return join(dir, name);
    };
    assert.deepEqual(await modelCaps(await put('Qwen3.5-9B-Q4_K_M.gguf', [['general.architecture', 'qwen35'], ['tokenizer.chat_template', QWEN_STYLE]])), { images: false, tools: true });
    assert.deepEqual(await modelCaps(await put('gemma-2-2b-it-Q4_K_M.gguf', [['general.architecture', 'gemma2'], ['tokenizer.chat_template', PLAIN_STYLE]])), { images: false, tools: false });
    assert.deepEqual(await modelCaps(await put('model-a.gguf', [['general.architecture', 'qwen2vl'], ['tokenizer.chat_template', PLAIN_STYLE]])), { images: true, tools: false });
    assert.deepEqual(await modelCaps(await put('Llama-3.2-11B-Vision-Q4_K_M.gguf', [['general.architecture', 'llama'], ['tokenizer.chat_template', QWEN_STYLE]])), { images: true, tools: true });
    // A model with no chat template at all has no place for tools.
    assert.deepEqual(await modelCaps(await put('base-Q4_K_M.gguf', [['general.architecture', 'llama']])), { images: false, tools: false });
    // Not a model, or gone: unknown.
    await writeFile(join(dir, 'junk.gguf'), 'not a model');
    assert.equal(await modelCaps(join(dir, 'junk.gguf')), null);
    assert.equal(await modelCaps(join(dir, 'missing.gguf')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Models page: three ticks beside Mixture-of-experts, badges on rows, the ticks sent with the search, and an honest tip', async () => {
  const page = await readFile(new URL('../public/models.js', import.meta.url), 'utf8');
  assert.match(page, /const CAP_NAME = \{ images: 'Reads pictures', tools: 'Uses tools', general: 'General chat' \}/);
  assert.match(page, /'data-cap': id/);
  assert.match(page, /caps: \[\.\.\.mp\.caps\]/);
  assert.match(page, /\[\.\.\.mp\.caps\]\.sort\(\)/);
  assert.match(page, /\.\.\.capBadges\(capsOfItem\(x\)\)/);
  assert.match(page, /text: 'Pictures'/);
  assert.match(page, /text: 'Tools'/);
  assert.match(page, /TOMLIN does not send pictures to a chat model yet/);
  assert.match(page, /a small model may still not use tools well/);
  assert.match(page, /caps: c\.caps \?\? null/);
  // All models clears them, and the list leaves out what is not a chat model while one is ticked.
  assert.match(page, /mp\.caps\.clear\(\)/);
  assert.match(page, /\(filtering \|\| mp\.caps\.size\) && x\.kind !== 'chat'/);
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.mp-cap \{[^}]*font-size: var\(--fs-xs\)/);
});

test('the server: the search takes the ticked kinds, the installed list carries each model\'s capabilities, a repo\'s sizes carry them too', async () => {
  const hf = await readFile(new URL('../src/server/hf.ts', import.meta.url), 'utf8');
  assert.match(hf, /const kinds = cleanKinds\(b\.caps\)/);
  assert.equal((hf.match(/capsPass\(x\.caps, kinds\)/g) ?? []).length, 3);
  assert.match(hf, /vision: kinds\.length === 1 && kinds\[0\] === 'images' && hasVisionFlags\(list\.models\)/);
  assert.match(hf, /chat: l\.chat, caps: l\.caps,/);
  const panes = await readFile(new URL('../src/server/panes.ts', import.meta.url), 'utf8');
  assert.match(panes, /caps: capsOf\.get\(m\.id\) \?\? null/);
});
