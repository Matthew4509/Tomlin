// The model's own built-in guesser (MTP, an `<arch>.nextn_predict_layers` head): found from the file's header, kept as a
// run setting only for a file that has one and never beside a guessing model (the runner refuses to start a file
// without a head), started with --spec-type draft-mtp, tried by the speed finder, set from a linked PC under the same
// tick as the guessing model, and its fault said plainly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeOf } from '../src/gguf.ts';
import { chatArgs, whyItFailed } from '../src/llama.ts';
import { BUILT_IN, cleanRunWith, runSetAsk } from '../src/runset.ts';
import * as sf from '../src/speedfinder.ts';

const head = (extra: Record<string, number>) => new Map<string, number | string>([['general.architecture', 'qwen35moe'], ['qwen35moe.block_count', 41], ['qwen35moe.attention.head_count', 16], ['qwen35moe.attention.head_count_kv', 2], ['qwen35moe.embedding_length', 2048], ['qwen35moe.context_length', 262144], ['qwen35moe.expert_count', 256], ...Object.entries(extra).map(([k, v]) => [`qwen35moe.${k}`, v] as [string, number])]);

test('a head is found from the header alone; a file without one has no mtp', () => {
  assert.equal(shapeOf(head({ nextn_predict_layers: 1 }))?.mtp, 1);
  assert.equal(shapeOf(head({}))?.mtp, undefined);
  assert.equal(shapeOf(head({ nextn_predict_layers: 0 }))?.mtp, undefined);
});

const A = { id: 'chat/Qwen3.6-35B-A3B-MTP-Q4_K_M.gguf', name: 'Qwen3.6-35B-A3B-MTP-Q4_K_M', bytes: 21e9, mtp: true };
const B = { id: 'chat/Qwen3.5-35B-A3B-Q4_K_M.gguf', name: 'Qwen3.5-35B-A3B-Q4_K_M', bytes: 22e9 };
const SMALL = { id: 'chat/Qwen3.6-0.8B-Q4_K_M.gguf', name: 'Qwen3.6-0.8B-Q4_K_M', bytes: 0.5e9 };
const LIST = [A, B, SMALL];

test('the built-in guesser is kept only for a file with a head, and never beside a guessing model', () => {
  assert.equal(cleanRunWith({ spec: 'mtp' }, A.id, LIST, [8192]).spec, 'mtp');
  assert.equal(cleanRunWith({ spec: 'mtp' }, B.id, LIST, [8192]).spec, undefined, 'a file without a head would not start');
  const both = cleanRunWith({ spec: 'mtp', draft: SMALL.id }, A.id, LIST, [8192]);
  assert.equal(both.spec, undefined);
  assert.equal(both.draft, SMALL.id);
  assert.equal(cleanRunWith({ spec: 'ngram' }, B.id, LIST, [8192]).spec, 'ngram');
});

test('started with --spec-type draft-mtp, and a file without a head is named plainly when the runner refuses it', () => {
  const a = chatArgs('m.gguf', 9000, 'cuda', 0, false, { ctx: 8192, cache: 'f16', place: 'auto', spec: 'mtp' }, true);
  assert.deepEqual(a.slice(a.indexOf('--spec-type')), ['--spec-type', 'draft-mtp']);
  assert.ok(!chatArgs('m.gguf', 9000, 'cuda', 0, false, { ctx: 8192, cache: 'f16', place: 'auto' }, true).includes('draft-mtp'));
  assert.match(whyItFailed("llama_init_from_model: context type MTP requested but model doesn't contain MTP layers\nfailed to create MTP context"), /built-in guesser \(MTP\), but this file has none/);
});

test('the speed finder tries the built-in guesser first among the guessing tricks, and says when a file has none', () => {
  const pc: sf.PcFacts = { cards: [{ name: 'RTX 5080', total: 16 * 2 ** 30, free: 15 * 2 ** 30 }], cores: 16, threads: 0, models: LIST };
  const facts = (m: typeof A | typeof B): sf.ModelFacts => ({ ...m, moe: false, layers: 41, expertsPerLayer: 0, rest: m.bytes, ctxBytes: 0.3e9, guesser: null });
  const now = { run: { ctx: 8192, cache: 'f16' as const, place: 'auto' as const }, spilled: false, cardBytes: 6e9 };
  const q = sf.setupsFor(pc, facts(A), now, 'quick');
  assert.equal(q.rows[1].id, 'mtp');
  assert.deepEqual(q.rows[1].run, { ...now.run, spec: 'mtp' });
  assert.match(sf.describeRun(q.rows[1].run), /built-in guesser \(MTP\)/);
  // Saved already: not tried again.
  assert.ok(!sf.setupsFor(pc, facts(A), { ...now, run: { ...now.run, spec: 'mtp' } }, 'quick').rows.some(r => r.id === 'mtp'));
  const none = sf.setupsFor(pc, facts(B), now, 'full');
  assert.ok(!none.rows.some(r => r.id === 'mtp'));
  assert.ok(none.left.some(l => l.name === 'Built-in guesser (MTP)' && /this file has none/.test(l.why)));
});

test('a linked PC may set the built-in guesser only for a file with a head', () => {
  assert.deepEqual(runSetAsk({ model: A.id, draft: BUILT_IN }, LIST), { model: A, draft: BUILT_IN });
  const no = runSetAsk({ model: B.id, draft: BUILT_IN }, LIST);
  assert.ok('error' in no && /has no built-in guesser/.test(no.error));
});
