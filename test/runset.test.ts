// Run settings a linked PC may change on a node (src/runset.ts): the node's own tick, which of its models may guess
// for which, what a host may ask (model ids only), and what the node's hello says about each model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rs from '../src/runset.ts';
import * as carry from '../src/carry.ts';
import * as nodestaff from '../src/nodestaff.ts';

const GB = 2 ** 30;
const A3B = { id: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', name: 'Qwen3.5-35B-A3B-Q4_K_M', bytes: 22 * GB };
const Q4B = { id: 'Qwen3.5-4B-Q4_K_M.gguf', name: 'Qwen3.5-4B-Q4_K_M', bytes: 2.7 * GB };
const Q2B = { id: 'Qwen3.5-2B-Q4_K_M.gguf', name: 'Qwen3.5-2B-Q4_K_M', bytes: 1.3 * GB };
const Q08 = { id: 'Qwen3.5-0.8B-Q4_K_M.gguf', name: 'Qwen3.5-0.8B-Q4_K_M', bytes: 0.53 * GB };
const GEMMA = { id: 'gemma-3-1b-it-Q4_K_M.gguf', name: 'gemma-3-1b-it-Q4_K_M', bytes: 0.8 * GB };
const OLLAMA = { id: 'ollama:qwen3.5:0.8b', name: 'Qwen3.5-0.8B', bytes: 0.5 * GB };
const LIST = [Q08, GEMMA, OLLAMA, Q2B, Q4B, A3B];

test('the node tick "Allow host to test and change model run settings" is its own, off until ticked, and part of Allow all', () => {
  assert.equal(rs.TUNE_TICK, 'Allow host to test and change model run settings');
  assert.equal(carry.NO_ALLOW.tune, false);
  assert.equal(carry.cleanAllow({}).tune, false);
  assert.equal(carry.cleanAllow({ tune: 'yes' }).tune, false);
  assert.equal(carry.cleanAllow({ tune: true }).tune, true);
  // A node that had "Allow all" before this tick: Allow all shows unticked until the new one is ticked too.
  assert.equal(carry.allowsAll({ pull: true, backup: true, update: true, tune: false }), false);
  assert.equal(carry.allowsAll({ pull: true, backup: true, update: true, tune: true }), true);
});

test('a guessing model is another chat model of the same family on that PC, at most half the size; never Ollama, never another family', () => {
  assert.deepEqual(rs.guessersFor(A3B, LIST), [Q08.id, Q2B.id, Q4B.id]);
  assert.deepEqual(rs.guessersFor(Q4B, LIST), [Q08.id, Q2B.id]);
  assert.deepEqual(rs.guessersFor(Q2B, LIST), [Q08.id]);
  assert.deepEqual(rs.guessersFor(Q08, LIST), []);
  // Gemma has a different words list: it never guesses for Qwen, and no Qwen guesses for it.
  assert.deepEqual(rs.guessersFor(GEMMA, LIST), []);
  // An Ollama model is run by Ollama, not by this PC's runner: it neither guesses nor has a guesser.
  assert.deepEqual(rs.guessersFor(OLLAMA, LIST), []);
  assert.ok(!rs.guessersFor(A3B, LIST).includes(OLLAMA.id));
});

test('what a host may ask: one of the node\'s chat models and one of its guessers (or none), by id; anything else refused', () => {
  const ok = rs.runSetAsk({ model: A3B.id, draft: Q08.id }, LIST);
  assert.deepEqual(ok, { model: A3B, draft: Q08.id });
  // None: the guessing model is taken off.
  assert.deepEqual(rs.runSetAsk({ model: A3B.id, draft: '' }, LIST), { model: A3B, draft: '' });
  // Flags or a path sent along are never read: only the two ids come back.
  const extra = rs.runSetAsk({ model: A3B.id, draft: Q08.id, args: ['--rpc', 'x'], path: 'C:\\evil.gguf', ctx: 1 }, LIST);
  assert.deepEqual(extra, { model: A3B, draft: Q08.id });

  const refused = (b: Record<string, unknown>) => {
    const r = rs.runSetAsk(b, LIST);
    assert.ok('error' in r, `refused: ${JSON.stringify(b)}`);
    return r as { status: number; error: string };
  };
  assert.equal(refused({ model: 'Nope-7B.gguf', draft: '' }).status, 404);
  assert.match(refused({ model: 'Nope-7B.gguf', draft: '' }).error, /not on/);
  assert.equal(refused({ model: OLLAMA.id, draft: '' }).status, 400);
  const gemma = refused({ model: A3B.id, draft: GEMMA.id });
  assert.equal(gemma.status, 400);
  assert.match(gemma.error, /same family/);
  assert.equal(refused({ model: A3B.id, draft: A3B.id }).status, 400);
  assert.equal(refused({ model: Q2B.id, draft: Q4B.id }).status, 400);
  assert.equal(refused({ model: A3B.id, draft: 'C:\\models\\Qwen3.5-0.8B-Q4_K_M.gguf' }).status, 400);
  assert.equal(refused({ model: A3B.id, draft: 7 }).status, 400);
  assert.equal(refused({ model: A3B.id }).status, 400);
  assert.equal(refused({ draft: Q08.id }).status, 400);
});

test('the host asks only a node that is on, not in use by its owner, and new enough; the tick itself is the node\'s to check', () => {
  const pc = (o: Record<string, unknown> = {}) => ({ name: 'Worker PC', ok: true, away: null, can: ['models', 'tune'], allow: { ...carry.NO_ALLOW, tune: true }, ...o }) as Parameters<typeof rs.tuneWhy>[0];
  assert.equal(rs.tuneWhy(pc()), '');
  assert.match(rs.tuneWhy(pc({ ok: false })), /off or not answering/);
  assert.match(rs.tuneWhy(pc({ away: '2026-10-21T03:00:00Z' })), /being used by its owner/);
  assert.match(rs.tuneWhy(pc({ can: ['models'] })), /older TOMLIN.*update it/);
  // Not ticked: still asked, so the node itself answers why (its own words, from its own tick).
  assert.equal(rs.tuneWhy(pc({ allow: carry.NO_ALLOW })), '');
  assert.match(rs.tuneRefused('Worker PC'), /"Worker PC" does not let linked PCs change how its models run/);
  assert.ok(rs.tuneRefused('Worker PC').includes(`"${rs.TUNE_TICK}"`));
});

test('a node\'s hello says each chat model\'s guessing model and the ones it could use; a host keeps only clean ids', () => {
  const shared = nodestaff.sharedList({
    models: [{ ...A3B, kind: 'chat' }, { ...Q08, kind: 'chat' }, { id: 'dreamshaper', name: 'DreamShaper 8', bytes: GB, kind: 'image' }],
    ctxOf: () => 8192,
    loaded: () => false,
    busy: () => false,
    runOf: id => (id === A3B.id ? { draft: Q08.id, guessers: [Q08.id] } : { draft: '', guessers: [] }),
  });
  assert.equal(shared[0].draft, Q08.id);
  assert.deepEqual(shared[0].guessers, [Q08.id]);
  assert.equal(shared[1].draft, '');
  assert.deepEqual(shared[1].guessers, []);
  assert.equal(shared[2].draft, undefined, 'a picture model has no guessing model');
  assert.equal(shared[2].guessers, undefined);

  const kept = nodestaff.cleanShared(JSON.parse(JSON.stringify(shared)));
  assert.equal(kept[0].draft, Q08.id);
  assert.deepEqual(kept[0].guessers, [Q08.id]);
  assert.equal(kept[2].guessers, undefined);
  // An older node says nothing of it: nothing is made up.
  const old = nodestaff.cleanShared([{ id: A3B.id, name: A3B.name, bytes: 1, ctx: 8192 }]);
  assert.equal(old[0].draft, undefined);
  assert.equal(old[0].guessers, undefined);
  // Bad ids are dropped, and the list is capped.
  const bad = nodestaff.cleanShared([{ id: A3B.id, name: 'x', draft: 'a\u0000b', guessers: [Q08.id, 5, 'x\ny', ...Array.from({ length: 60 }, (_, k) => `m${k}.gguf`)] }]);
  assert.equal(bad[0].draft, '');
  assert.equal(bad[0].guessers![0], Q08.id);
  assert.ok(!bad[0].guessers!.includes('x\ny'));
  assert.ok(bad[0].guessers!.length <= 40);
});
