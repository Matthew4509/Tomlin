// Expert parallel's own layout (src/cluster/eplayout.ts): the rules from the real runs on the Z240 + Z820, worked out per load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardLayers, planEp, EP_CARD_KEEP, type EpHost, type EpLender, type EpModel } from '../src/cluster/eplayout.ts';
import { partsFrom, type TensorParts } from '../src/gguf.ts';

const GIB = 2 ** 30;
const MIB = 2 ** 20;

/** DeepSeek-V4-Flash UD-Q2_K_XL as nonexpert-bytes.mjs read it: 43 layers of 132 to 154 MiB outside the experts, a 284 MiB output. */
const deepseekParts = (): TensorParts => ({
  layerRest: Array.from({ length: 43 }, (_, i) => (132 + (i % 3) * 11) * MIB),
  expertLayer: (84 * GIB) / 43,
  output: 284 * MIB,
  tokenTable: 0.55 * GIB,
  tables: [],
  other: 0.05 * GIB,
});
const DEEPSEEK: EpModel = { name: 'DeepSeek-V4-Flash', parts: deepseekParts(), experts: 256, used: 6, hidden: 4096, kv: 0.6 * GIB };

/** Qwen3.8-Flash-Next UD-Q3_K_XL: about 3.4 GiB outside the experts with the output, the 26.8 GiB n-gram table, 512 experts with 10 chosen. */
const QWEN38: EpModel = {
  name: 'Qwen3.8-Flash-Next',
  parts: { layerRest: Array.from({ length: 48 }, (_, i) => (62 + (i % 4) * 4) * MIB), expertLayer: (51 * GIB) / 48, output: 0.3 * GIB, tokenTable: 0.6 * GIB, tables: [{ name: 'per_layer_token_embd.weight', bytes: 26.8 * GIB }], other: 0.05 * GIB },
  experts: 512,
  used: 10,
  hidden: 2048,
  kv: 0.2 * GIB,
};

/** This PC (the Z240): the P2000 with about 4.2 GB free, 48 GB of RAM; about 4 GB/s through i-quants on its processor. */
const z240 = (o: Partial<EpHost> = {}): EpHost => ({ name: 'Main PC', ramFree: 40 * GIB, ramTotal: 48 * GIB, ramSpeed: 4e9, card: { name: 'CUDA0', what: 'Quadro P2000', total: 5 * GIB, free: 4.2 * GIB }, cardSpeed: 80e9, ...o });
/** The Z820 lending its RAM (RPC1; its 3060 is RPC0 and is never used for the non-expert part); about 6.2 GB/s. */
const z820 = (o: Partial<EpLender> = {}): EpLender => ({ name: 'Big PC', endpoint: '127.0.0.1:50073', ram: { name: 'RPC1', what: '127.0.0.1:50073', total: 64 * GIB, free: 58 * GIB }, ramFree: 58 * GIB, ramTotal: 64 * GIB, ramSpeed: 6.2e9, ...o });

test('the card holds layers by its free memory and never past it, output pinned first', () => {
  const p = deepseekParts();
  const c = cardLayers(p, 0, 4.2 * GIB);
  assert.equal(c.output, true);
  assert.ok(c.bytes <= 4.2 * GIB - EP_CARD_KEEP, 'within the card');
  // One more layer would not fit.
  assert.ok(c.bytes + p.layerRest[43 - c.ngl - 1] > 4.2 * GIB - EP_CARD_KEEP);
  // The real runs' best was -ngl 25 to 30 on this card.
  assert.ok(c.ngl >= 22 && c.ngl <= 30, `ngl ${c.ngl}`);
  assert.deepEqual(cardLayers(p, 0, 0.2 * GIB), { ngl: 0, output: false, bytes: 0 });
});

test('DeepSeek on the Z240 + Z820: the layout of the best run (EP8), worked out with no tuning', () => {
  const got = planEp(DEEPSEEK, z240(), [z820()]);
  assert.ok(!('why' in got), 'why' in got ? got.why : '');
  if ('why' in got) return;
  assert.deepEqual(got.dev, ['CUDA0', 'RPC1'], 'the card here and the Z820\'s RAM; never the Z820\'s card');
  assert.deepEqual(got.split, [1, 0]);
  assert.equal(got.batch, 128);
  assert.ok(got.override.includes('^output\\.weight=CUDA0'));
  assert.equal(got.env.GGML_CUDA_NO_PINNED, '1');
  // Every expert in exactly one run, this PC first, the faster Z820 taking more (EP1/EP8: 0-95 here, 96-255 there).
  assert.match(got.env.LLAMA_EXPERT_SPLIT, /^CPU=0-(\d+);RPC1=(\d+)-255$/);
  const here = got.shares[0].to;
  assert.ok(here >= 70 && here <= 128, `${here} experts here`);
  assert.equal(got.shares[1].from, here);
  assert.deepEqual(got.rpc, ['127.0.0.1:50073']);
  assert.ok(got.msPerWord && got.msPerWord > 0);
  assert.match(got.words, /expert parallel/);
});

test('Qwen3.8: the 26.8 GiB n-gram table goes to the PC with room, as in Q-EP2', () => {
  const got = planEp(QWEN38, z240(), [z820()]);
  assert.ok(!('why' in got), 'why' in got ? got.why : '');
  if ('why' in got) return;
  assert.equal(got.tables['per_layer_token_embd.weight'], 'Big PC');
  assert.ok(got.override.includes('per_layer_token_embd\\.weight=RPC1[127.0.0.1:50073]'));
  // All 48 layers' non-expert part fits the P2000, as measured.
  assert.equal(got.ngl, 48);
  assert.match(got.env.LLAMA_EXPERT_SPLIT, /^CPU=0-\d+;RPC1=\d+-511$/);
});

test('a patched lender takes :skip; a stock one the zero expert (no mode)', () => {
  const stock = planEp(DEEPSEEK, z240(), [z820()]);
  const patched = planEp(DEEPSEEK, z240(), [z820({ patched: true })]);
  assert.ok(!('why' in stock) && !('why' in patched));
  if ('why' in stock || 'why' in patched) return;
  assert.doesNotMatch(stock.env.LLAMA_EXPERT_SPLIT, /:skip/);
  assert.match(patched.env.LLAMA_EXPERT_SPLIT, /RPC1=\d+-255:skip$/);
});

test('no speed figures: the experts are shared by room and the note says so', () => {
  const got = planEp(DEEPSEEK, z240({ ramSpeed: 0 }), [z820()]);
  assert.ok(!('why' in got));
  if ('why' in got) return;
  assert.equal(got.msPerWord, null);
  assert.equal(got.shares.reduce((n, s) => n + s.to - s.from, 0), 256);
  assert.ok(got.notes.some(n => /speed test/.test(n)));
});

test('refused: a dense model, no card here, no lender, or not enough RAM between them', () => {
  const dense = { ...DEEPSEEK, name: 'Dense-24B', experts: 0, used: 0, parts: { ...deepseekParts(), expertLayer: 0 } };
  assert.match((planEp(dense, z240(), [z820()]) as { why: string }).why, /not a mixture-of-experts/);
  assert.match((planEp(DEEPSEEK, z240({ card: null }), [z820()]) as { why: string }).why, /no graphics card/);
  assert.match((planEp(DEEPSEEK, z240(), []) as { why: string }).why, /no lending PC/);
  const small = z820({ ramFree: 20 * GIB, ramTotal: 32 * GIB });
  assert.match((planEp(DEEPSEEK, z240(), [small]) as { why: string }).why, /cannot hold/);
});

test('three PCs: the experts spread over all three, every one in exactly one run', () => {
  const hp = z820({ name: 'HP 800', endpoint: '127.0.0.1:50080', ram: { name: 'RPC2', what: '127.0.0.1:50080', total: 32 * GIB, free: 26 * GIB }, ramFree: 26 * GIB, ramTotal: 32 * GIB, ramSpeed: 8e9 });
  const got = planEp(DEEPSEEK, z240(), [z820(), hp]);
  assert.ok(!('why' in got));
  if ('why' in got) return;
  assert.deepEqual(got.dev, ['CUDA0', 'RPC1', 'RPC2']);
  assert.equal(got.shares.length, 3);
  let at = 0;
  for (const s of got.shares) {
    assert.equal(s.from, at);
    at = s.to;
  }
  assert.equal(at, 256);
});

test('a tensor list is read into layers, experts, output and big tables', () => {
  // Type 0 is F32: 4 bytes a value.
  const parts = partsFrom([
    { name: 'token_embd.weight', dims: [4, 10], type: 0 },
    { name: 'blk.0.attn_q.weight', dims: [4, 4], type: 0 },
    { name: 'blk.0.ffn_up_exps.weight', dims: [4, 4, 8], type: 0 },
    { name: 'blk.1.attn_q.weight', dims: [4, 8], type: 0 },
    { name: 'blk.1.ffn_up_exps.weight', dims: [4, 4, 8], type: 0 },
    { name: 'output.weight', dims: [4, 10], type: 0 },
    { name: 'per_layer_token_embd.weight', dims: [2 ** 28, 1], type: 0 },
  ])!;
  assert.deepEqual(parts.layerRest, [64, 128]);
  assert.equal(parts.expertLayer, 512);
  assert.equal(parts.output, 160);
  assert.equal(parts.tokenTable, 160);
  assert.deepEqual(parts.tables, [{ name: 'per_layer_token_embd.weight', bytes: GIB }]);
  assert.equal(partsFrom([{ name: 'blk.0.attn_q.weight', dims: [4, 4], type: 0 }]), null, 'a dense model has no expert parts');
});

test('the tensor list of a model with Q2_0 tensors is read (Qwen3.8-Flash-Next UD-Q3_K_XL has two): one unknown type dropped the whole list', () => {
  const parts = partsFrom([
    { name: 'token_embd.weight', dims: [2560, 248320], type: 23 },
    { name: 'per_layer_token_embd.weight', dims: [160, 320001536], type: 20 },
    { name: 'blk.0.attn_q.weight', dims: [2560, 4096], type: 42 },
    { name: 'blk.0.ffn_up_exps.weight', dims: [2560, 512, 512], type: 18 },
    { name: 'blk.1.attn_q.weight', dims: [2560, 4096], type: 41 },
    { name: 'blk.1.ffn_up_exps.weight', dims: [2560, 512, 512], type: 40 },
  ]);
  assert.ok(parts, 'read, not null');
  assert.equal(parts.layerRest[0], (2560 * 4096 / 64) * 18, 'Q2_0: 18 bytes a block of 64');
  assert.equal(parts.layerRest[1], (2560 * 4096 / 128) * 18, 'Q1_0: 18 bytes a block of 128');
  assert.equal(parts.tables[0].name, 'per_layer_token_embd.weight');
});

test('with two lenders, the n-gram table on the second goes to its own buffer type (RPC1[address]), not its global device name', () => {
  const hp = (o: Partial<EpLender> = {}): EpLender => ({ name: 'Small PC', endpoint: '127.0.0.1:50072', ram: { name: 'RPC1', what: '127.0.0.1:50072', total: 16 * GIB, free: 12 * GIB }, buffer: 'RPC1[127.0.0.1:50072]', ramFree: 12 * GIB, ramTotal: 16 * GIB, ramSpeed: 3e9, ...o });
  const big = z820({ ram: { name: 'RPC3', what: '127.0.0.1:50073', total: 64 * GIB, free: 58 * GIB }, buffer: 'RPC1[127.0.0.1:50073]' });
  const got = planEp(QWEN38, z240(), [hp(), big]);
  assert.ok(!('why' in got), 'why' in got ? got.why : '');
  if ('why' in got) return;
  const rule = got.override.find(x => x.startsWith('per_layer_token_embd'));
  if (rule) assert.equal(rule, 'per_layer_token_embd\\.weight=RPC1[127.0.0.1:50073]');
  assert.ok(!got.override.some(x => /=RPC3\[/.test(x)), got.override.join(' '));
  // -dev and the expert split keep the global names.
  assert.ok(got.dev.includes('RPC3'));
});
