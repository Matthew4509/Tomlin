// The guessing model's rest (REVIEW-2026-10-23-GUESSING-MODEL.md): the speed finder times a code prompt beside the
// prose one; a "longer guesses" row tries up to 8 words a guess (--spec-draft-n-max); and a guesser is matched to its
// model by their words lists as llama.cpp compares them, not by the start of their names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fr from '../src/finderrun.ts';
import { chatArgs } from '../src/llama.ts';
import { cleanRunWith, guessersFor, sameWordsList } from '../src/runset.ts';
import * as sf from '../src/speedfinder.ts';
import type { RunOptions } from '../src/store.ts';

const GB = 2 ** 30;
const BASE: RunOptions = { ctx: 8192, cache: 'f16', place: 'auto' };

test('each row is timed on a code prompt too, kept beside its prose speed; the prose speed still decides', async () => {
  const asked: string[] = [];
  const deps: fr.FinderDeps = {
    load: async () => ({ seconds: 5 }),
    ask: async kind => {
      asked.push(kind);
      return { text: 'same words', write: kind === 'code' ? 25 : 10, read: 40, firstWord: 0.5, accepted: null };
    },
    memory: async () => ({ cardBytes: GB, ramBytes: GB, borrowed: 0, cardFree: 2 * GB }),
    ramFit: () => 'ok',
    putBack: async () => undefined,
  };
  const run = await fr.runFinder({ rows: [{ id: 'a', name: 'Now', why: '', run: BASE }], deps });
  assert.equal(asked.filter(k => k === 'code').length, 1);
  assert.equal(run.rows[0].code, 25);
  assert.equal(run.rows[0].write, 10);
  const r = fr.request('code');
  assert.match(r.messages[0].content, /parseCsvLine/);
  assert.equal(r.max_tokens, sf.TOKENS.code);
  assert.equal(r.temperature, 0);
});

test('longer guesses: a row of up to 8 words a guess in Full, with the guess in use or the likeliest; the flag only where something guesses', () => {
  const G = { id: 'chat/Qwen3.5-0.8B.gguf', name: 'Qwen3.5-0.8B-Q4_K_M', bytes: 0.5e9 };
  const M = { id: 'chat/Qwen3.5-9B.gguf', name: 'Qwen3.5-9B-Q4_K_M', bytes: 5.6e9 };
  const pc: sf.PcFacts = { cards: [{ name: 'GTX 1060', total: 6 * GB, free: 5 * GB }], cores: 6, threads: 0, models: [G, M] };
  const m: sf.ModelFacts = { ...M, moe: false, layers: 32, expertsPerLayer: 0, rest: M.bytes, ctxBytes: 0.3e9, guesser: { ...G, ctxBytes: 0.05e9 } };
  const now = { run: BASE, spilled: false, cardBytes: 5.8e9 };
  const full = sf.setupsFor(pc, m, now, 'full');
  const long = full.rows.find(r => r.id === 'draft-long');
  assert.deepEqual(long?.run, { ...BASE, draft: G.id, draftMax: 8 });
  assert.ok(!sf.setupsFor(pc, m, now, 'quick').rows.some(r => r.id === 'draft-long'), 'Full only');
  // The built-in guesser, when the file has one, is the guess it lengthens.
  assert.deepEqual(sf.setupsFor(pc, { ...m, mtp: true, guesser: null }, now, 'full').rows.find(r => r.id === 'draft-long')?.run, { ...BASE, spec: 'mtp', draftMax: 8 });
  assert.match(sf.describeRun({ ...BASE, draft: G.id, draftMax: 8 }), /guesses of up to 8 words/);
  const a = chatArgs('m.gguf', 9000, 'cuda', 0, false, { ...BASE, draft: 'g.gguf', draftMax: 8 }, true);
  assert.equal(a[a.indexOf('--spec-draft-n-max') + 1], '8');
  assert.ok(!chatArgs('m.gguf', 9000, 'cuda', 0, false, { ...BASE, draftMax: 8 }, true).includes('--spec-draft-n-max'));
  const list = [G, M];
  assert.equal(cleanRunWith({ draft: G.id, draftMax: 8 }, M.id, list, [8192]).draftMax, 8);
  assert.equal(cleanRunWith({ draftMax: 8 }, M.id, list, [8192]).draftMax, undefined, 'nothing guesses: dropped');
  assert.equal(cleanRunWith({ draft: G.id, draftMax: 99 }, M.id, list, [8192]).draftMax, undefined);
});

test('a guesser is matched by its words list: the same list across a name change, never another list with a like name', () => {
  // Read from real files on this PC (src/gguf.ts ModelShape.vocab): the two Qwen3.5 sizes share one list; Gemma 2 and 3 do not.
  const QWEN = 'gpt2|248320|0|248046|972a47d69e9c9cba32dd';
  const GEMMA3 = 'llama|262144|2|106|184660abbad4d8483fdd';
  const GEMMA2 = 'llama|256000|2|1|52a6810c66660b7fcd38';
  assert.equal(sameWordsList(QWEN, QWEN), true);
  assert.equal(sameWordsList(GEMMA3, GEMMA2), false);
  assert.equal(sameWordsList(QWEN, 'gpt2|248400|0|248046|972a47d69e9c9cba32dd'), true, 'within 128 words in size');
  assert.equal(sameWordsList(QWEN, 'gpt2|249000|0|248046|972a47d69e9c9cba32dd'), false);
  assert.equal(sameWordsList(QWEN, 'gpt2|248320|1|248046|972a47d69e9c9cba32dd'), false, 'another start word');
  const big = { id: 'chat/Qwen3.6-35B-A3B.gguf', name: 'Qwen3.6-35B-A3B-Q4_K_M', bytes: 21e9, vocab: QWEN };
  const small = { id: 'chat/Qwen3.5-0.8B.gguf', name: 'Qwen3.5-0.8B-Q4_K_M', bytes: 0.5e9, vocab: QWEN };
  const g3 = { id: 'chat/gemma-3-27b.gguf', name: 'gemma-3-27b-it-Q4_K_M', bytes: 16e9, vocab: GEMMA3 };
  const g2 = { id: 'chat/gemma-2-2b.gguf', name: 'gemma-2-2b-it-Q4_K_M', bytes: 1.7e9, vocab: GEMMA2 };
  assert.deepEqual(guessersFor(big, [big, small, g3, g2]), [small.id], 'Qwen3.5 guesses for Qwen3.6: the same words list');
  assert.deepEqual(guessersFor(g3, [big, small, g3, g2]), [], 'gemma-2 never guesses for gemma-3: the runner would refuse it');
  // Lists not known (an older reading): by name, as before.
  const { vocab: _v, ...noList } = g2;
  assert.deepEqual(guessersFor({ ...g3, vocab: undefined }, [g3, noList]), [g2.id]);
});
