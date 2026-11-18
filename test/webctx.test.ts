// The context a chat gets when Web is on (src/webctx.ts): the most that fits, never above what the model was trained for,
// never lower than it runs with, and a plain word when it cannot be raised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_SIZES, WEB_CTX, planWebContext, webCtxFarWhy, webCtxFarWords, webCtxWords } from '../src/webctx.ts';

const fitsAll = () => true;

test('web context: 8,192 is raised to 32,768 when it fits', () => {
  const p = planWebContext({ current: 8192, contexts: CONTEXT_SIZES, trained: 262144, fits: fitsAll });
  assert.deepEqual(p, { ctx: WEB_CTX, change: true, limit: '' });
});

test('web context: the largest size that fits is taken, and the person is told it is less than asked', () => {
  const p = planWebContext({ current: 8192, contexts: CONTEXT_SIZES, trained: 262144, fits: c => c <= 16384 });
  assert.equal(p.ctx, 16384);
  assert.equal(p.change, true);
  assert.match(p.limit, /16,384 tokens is the most that fits here \(32,768 was asked for\)/);
});

test('web context: never above what the model was trained for', () => {
  const p = planWebContext({ current: 4096, contexts: CONTEXT_SIZES, trained: 8192, fits: fitsAll });
  assert.equal(p.ctx, 8192);
  const none = planWebContext({ current: 8192, contexts: CONTEXT_SIZES, trained: 8192, fits: fitsAll });
  assert.equal(none.change, false);
  assert.match(none.limit, /trained for 8,192 tokens at most/);
});

test('web context: nothing fits, or it is big enough already, and the context is left alone', () => {
  const tight = planWebContext({ current: 8192, contexts: CONTEXT_SIZES, trained: null, fits: () => false });
  assert.equal(tight.change, false);
  assert.equal(tight.ctx, 8192);
  assert.match(tight.limit, /stays at 8,192 tokens.*would not fit in the memory free here/);
  const big = planWebContext({ current: 65536, contexts: CONTEXT_SIZES, trained: 262144, fits: () => false });
  assert.deepEqual(big, { ctx: 65536, change: false, limit: '' });
  const exact = planWebContext({ current: WEB_CTX, contexts: CONTEXT_SIZES, trained: null, fits: fitsAll });
  assert.equal(exact.change, false);
});

test('web context: a smaller want is respected (a node asked for 16,384)', () => {
  const p = planWebContext({ current: 8192, contexts: CONTEXT_SIZES, trained: null, fits: fitsAll, want: 16384 });
  assert.equal(p.ctx, 16384);
});

test('web context: the words for the person', () => {
  assert.match(webCtxWords(8192, 32768), /started again with a context of 32,768 tokens \(it was 8,192\).*not changed.*until the model is unloaded/);
  assert.match(webCtxFarWords(8192, 32768, 'Worker PC'), /"Worker PC" was asked to run this model with a context of 32,768 tokens.*keeps that as the model's context setting/);
  assert.equal(webCtxFarWhy('Worker PC', true, true, 8192), '');
  assert.equal(webCtxFarWhy('Worker PC', false, true, 65536), '');
  assert.match(webCtxFarWhy('Worker PC', false, true, 8192), /Allow host to test and change model run settings/);
  assert.match(webCtxFarWhy('Worker PC', true, false, 8192), /update it there/);
});
