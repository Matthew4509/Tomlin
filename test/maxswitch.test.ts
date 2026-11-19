// The chat's Max switch (src/maxmode.ts): Max mode is for a model that FITS on one PC and borrows from linked PCs to raise
// its tokens a second; Cluster is for a model that will NOT fit one PC. The inputs are the ones a person meets: a model
// of each family in the models folders, a chat with no linked PC, a linked PC that is off, one that does not allow it,
// an older TOMLIN, and a build mismatch. Each case says what the page shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLUSTER_RUNS_IT, MAX_TIP, MaxSpeeds, afterAnswer, cardModelName, fitsOnePc, maxEngine, maxGate, maxNote, maxReload, maxRoute, reloadCardText, reloadWhy, speedKey, swapOutFor, type GatePc } from '../src/maxmode.ts';
import { borrowRule } from '../src/cluster/engine.ts';
import { loanBusyWhy, maxCandidates, maxLoad, maxPcs, streamClosed, streamOpened } from '../src/jobrun/maxhost.ts';
import type { Option } from '../src/runnermatch.ts';
import type { Remote } from '../src/store.ts';
import { testEnv } from './env.ts';

const GB = 2 ** 30;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const opt = (build: string): Option => ({ build, device: 'cuda', pin: `cuda12-${build}`, have: true, tested: true });
const host = [opt('b11284')];
const z820 = (o: Partial<GatePc> = {}): GatePc => ({ id: 'e2c4ba37', name: 'Z820', hello: { can: ['max', 'turns'], allow: { lend: true } }, options: [opt('b11284')], ...o });

test('one rule tells Max mode from Cluster, and the automatic borrowing uses the same one', () => {
  assert.equal(fitsOnePc({ need: 20 * GB, card: 8 * GB, ram: 24 * GB }), true);
  assert.equal(fitsOnePc({ need: 32 * GB, card: 8 * GB, ram: 24 * GB }), true, 'exactly fits');
  assert.equal(fitsOnePc({ need: 33 * GB, card: 8 * GB, ram: 24 * GB }), false);
  // borrowRule's "does not fit" step is fitsOnePc, not a copy of it.
  assert.match(borrowRule({ need: 40 * GB, card: 8 * GB, ram: 24 * GB, moe: true }, false).words, /does not fit this PC alone/);
  assert.equal(borrowRule({ need: 20 * GB, card: 8 * GB, ram: 24 * GB, moe: true }, true).borrow, false, 'a mixture-of-experts model that fits is not split by the automatic borrowing');
  // On the line: borrowRule's "does not fit" turns exactly where fitsOnePc does.
  assert.equal(borrowRule({ need: 32 * GB, card: 8 * GB, ram: 24 * GB, moe: true }, false).borrow, false);
  assert.equal(borrowRule({ need: 32 * GB + 1, card: 8 * GB, ram: 24 * GB, moe: true }, false).borrow, true);
  // It is not all the borrowing: a dense model that fits this PC but spills its card is lent a card, switch or not.
  assert.equal(fitsOnePc({ need: 14 * GB, card: 8 * GB, ram: 24 * GB }), true);
  assert.equal(borrowRule({ need: 14 * GB, card: 8 * GB, ram: 24 * GB, moe: false }, true).borrow, true);
});

const remote = (id: string, o: Partial<Remote> = {}) => ({ id, name: id, url: 'http://x', token: 't', key: 'k', ...o }) as Remote;
const lenderHello = (card: boolean) => () => ({ can: ['max', 'turns'], memory: card ? { cards: { count: 1 } } : null, allow: { lend: true } });

test('Max on never loads a model worse than Max off: a model the switch does not take goes the automatic way', async () => {
  const gate = maxGate({ pcs: [z820()], linked: 1, host });
  const dense = maxEngine({ model: 'Mistral-Small-24B', moe: false, cuda: true, measured: {} });
  const moe = maxEngine({ model: 'Qwen3-30B-A3B', moe: true, cuda: true, measured: {} });
  const slower = maxEngine({ model: 'Qwen3-30B-A3B', moe: true, cuda: true, measured: { alone: 9, max: 4 } });
  assert.equal(maxRoute({ asked: true, fits: true, gate, engine: moe }), 'experts');
  for (const [why, r] of [
    ['dense', maxRoute({ asked: true, fits: true, gate, engine: dense })],
    ['measured slower', maxRoute({ asked: true, fits: true, gate, engine: slower })],
    ['no CUDA', maxRoute({ asked: true, fits: true, gate, engine: maxEngine({ model: 'm', moe: true, cuda: false, measured: {} }) })],
    ['gate shut', maxRoute({ asked: true, fits: true, gate: maxGate({ pcs: [], linked: 0, host }), engine: null })],
    ['switch off', maxRoute({ asked: false, fits: true, gate, engine: moe })],
    ['does not fit', maxRoute({ asked: true, fits: false, gate, engine: moe })],
  ] as const) assert.equal(r, 'auto', why);
  // The automatic way, run: a dense 24B that spills an 8 GB card, a lender with a card. With the switch on it is the
  // same load as with it off: maxLoad with the alone facts asks the lender (the lent card), as the switch-off load does.
  const alone = { need: 14 * GB, card: 8 * GB, ram: 24 * GB, moe: false };
  const asked: string[][] = [];
  const ask = async (pcs: Remote[]) => (asked.push(pcs.map(p => p.id)), { endpoints: ['127.0.0.1:1'], lent: ['Z820'], ids: ['z'], notes: [] });
  const got = await maxLoad('Mistral-Small-24B', '', [remote('z')], ask, host, { alone, hello: lenderHello(true) });
  assert.deepEqual(asked, [['z']], 'the lent card is asked for');
  assert.deepEqual(got?.lent, ['Z820']);
  // A mixture-of-experts model that fits: the automatic way keeps it alone (the switch takes it by expert parallel instead).
  const moeAlone = await maxLoad('Qwen3-30B-A3B', '', [remote('z')], ask, host, { alone: { ...alone, moe: true }, hello: lenderHello(true) });
  assert.deepEqual(moeAlone?.endpoints, []);
  assert.equal(asked.length, 1);
});

test('"Reload with linked PCs": every check first; the model is unloaded only when the Max load can start', async () => {
  const gate = maxGate({ pcs: [z820()], linked: 1, host });
  const moe = maxEngine({ model: 'Qwen3-30B-A3B', moe: true, cuda: true, measured: {} });
  let unloaded = 0;
  const unload = async () => void unloaded++;
  const run = (o: Partial<Parameters<typeof maxReload>[0]>) => maxReload({ model: 'qwen.gguf', answering: false, why: () => '', impact: () => null, unload, ...o });
  // Another model here holds the lenders (one Max loan at a time): refused, nothing unloaded.
  streamOpened('Z820');
  try {
    const busy = loanBusyWhy('Qwen3-30B-A3B');
    // (The test before gave the lenders to Mistral-Small-24B last, so it is named as the holder.)
    assert.match(busy, /^Max mode lends the linked PCs to one model at a time, and (a model here still uses|Mistral-Small-24B is still loaded with Max mode and uses) "Z820"/);
    const r = await run({ why: () => reloadWhy({ fitsAlone: true, gate, engine: moe, loanBusy: busy }) });
    assert.equal(r?.status, 409);
    assert.match(String(r?.body.error), /one model at a time.*qwen\.gguf stays loaded as it is\.$/);
    assert.equal(unloaded, 0);
  } finally {
    streamClosed('Z820');
  }
  assert.equal(loanBusyWhy('Qwen3-30B-A3B'), '');
  // The gate shut, the model too big, or the engine not expert parallel: refused in words, nothing unloaded.
  for (const why of [
    reloadWhy({ fitsAlone: true, gate: maxGate({ pcs: [z820({ hello: null })], linked: 1, host }), engine: null, loanBusy: '' }),
    reloadWhy({ fitsAlone: false, gate, engine: moe, loanBusy: '' }),
    reloadWhy({ fitsAlone: true, gate, engine: maxEngine({ model: 'Mistral', moe: false, cuda: true, measured: {} }), loanBusy: '' }),
  ]) {
    assert.ok(why);
    assert.equal((await run({ why: () => why }))?.status, 409);
  }
  assert.equal(unloaded, 0);
  // Answering now, or a linked PC using the model (asked first): nothing unloaded.
  assert.equal((await run({ answering: true }))?.status, 409);
  const impact = await run({ impact: () => '"Z820" is using qwen on this PC' });
  assert.deepEqual(impact, { status: 409, body: { error: '"Z820" is using qwen on this PC', impact: '"Z820" is using qwen on this PC' } });
  assert.equal(unloaded, 0);
  // Everything passed: unloaded once, and the load goes ahead.
  assert.equal(reloadWhy({ fitsAlone: true, gate, engine: moe, loanBusy: '' }), '');
  assert.equal(await run({}), null);
  assert.equal(unloaded, 1);
});

test('two chat models loaded: the one asked about counts its own memory back, so it still fits one PC', () => {
  const looks = [
    { model: 'small.gguf', name: 'small', state: 'connected', ram: 3 * GB, usedAt: 1 },
    { model: 'gpt-oss-20b.gguf', name: 'gpt-oss', state: 'connected', ram: 13 * GB, usedAt: 9 },
  ];
  // Without it: the least recently used idle model is what a load swaps out (as before).
  assert.equal(swapOutFor(looks)?.model, 'small.gguf');
  // The model that just answered is asked about: its own 13 GB is its, not used memory.
  assert.equal(swapOutFor(looks, 'gpt-oss-20b.gguf')?.model, 'gpt-oss-20b.gguf');
  assert.equal(swapOutFor(looks, 'not-loaded.gguf')?.model, 'small.gguf');
  // 6 GB free now on a 32 GB PC with an 8 GB card: with the small model counted back it "does not fit"; with its own, it does.
  const need = needOf(11.3);
  assert.equal(fitsOnePc({ need, card: 0, ram: 6 * GB + swapOutFor(looks)!.ram }), false);
  assert.equal(fitsOnePc({ need, card: 0, ram: 6 * GB + swapOutFor(looks, 'gpt-oss-20b.gguf')!.ram }), true);
});

/**
 * Every chat model in the main PC’s models folders (a list of file names and sizes read from them) and GLM as it is typed, with its file size and whether its header says
 * mixture of experts. Needs are worked out as the load does: file and cache, a tenth more, 0.8 GB for the runner.
 */
const FAMILIES: { name: string; gb: number; moe: boolean }[] = [
  { name: 'Qwen3.5-0.8B-Q4_K_M', gb: 0.5, moe: false },
  { name: 'Qwen3.5-2B-Q4_K_M', gb: 1.2, moe: false },
  { name: 'Qwen3VL-8B-Instruct-Q4_K_M', gb: 5, moe: false },
  { name: 'gemma-2-2b-it-Q4_K_M', gb: 1.6, moe: false },
  { name: 'gemma-3n-E4B-it-Q4_K_M', gb: 4.2, moe: false },
  { name: 'Mistral-Small-3.2-24B-Instruct-2506-IQ4_XS', gb: 11.9, moe: false },
  { name: 'gpt-oss-20b-MXFP4', gb: 11.3, moe: true },
  { name: 'gemma-4-26B-A4B-it-UD-Q4_K_XL', gb: 15.8, moe: true },
  { name: 'Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL', gb: 16.5, moe: true },
  { name: 'GLM-4.7-Flash-UD-Q4_K_XL', gb: 17.5, moe: true },
  { name: 'Qwen3-Coder-Next-UD-Q3_K_XL', gb: 33.8, moe: true },
  { name: 'Qwen3-Next-80B-A3B-Instruct-UD-Q4_K_XL', gb: 42.9, moe: true },
  { name: 'Qwen3.8-Flash-Next-UD-Q3_K_XL', gb: 83.3, moe: true },
  { name: 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL', gb: 90.1, moe: true },
];
const needOf = (gb: number) => (gb + 1) * GB * 1.1 + 0.8 * GB;

/** What the page shows for a model with the switch on, one lender allowed on the same build, loaded here alone, nothing measured. */
function pageSays(m: { name: string; gb: number; moe: boolean }, pc: { card: number; ram: number }, cuda = true): string {
  const fits = fitsOnePc({ need: needOf(m.gb), card: pc.card, ram: pc.ram });
  // Greyed switch: the model's side is read first (public/app.js maxWhy).
  if (!fits) return `greyed: ${CLUSTER_RUNS_IT}`;
  const gate = maxGate({ pcs: [z820()], linked: 1, host });
  const engine = maxEngine({ model: m.name, moe: m.moe, cuda, measured: {} });
  const r = afterAnswer({ on: true, away: '', fitsAlone: true, loaded: { asked: false, lent: [], engine: null, words: '' }, gate, engine, perSecond: 10, measured: {}, model: m.name, seconds: 600 });
  return r.card ? `card: ${r.card}` : `note: ${r.note}`;
}

test('each model family in the models folders: what the page shows on a 32 GB PC with an 8 GB card', () => {
  const pc = { card: 8 * GB, ram: 24 * GB };
  const said = Object.fromEntries(FAMILIES.map(m => [m.name, pageSays(m, pc)]));
  for (const name of ['Qwen3.5-0.8B-Q4_K_M', 'Qwen3.5-2B-Q4_K_M', 'Qwen3VL-8B-Instruct-Q4_K_M', 'gemma-2-2b-it-Q4_K_M', 'gemma-3n-E4B-it-Q4_K_M', 'Mistral-Small-3.2-24B-Instruct-2506-IQ4_XS']) {
    assert.match(said[name], /^note: Max mode: not used for .+: it is a dense model, and Max mode uses only expert parallel, which needs a mixture-of-experts model\.$/, name);
  }
  for (const name of ['gpt-oss-20b-MXFP4', 'gemma-4-26B-A4B-it-UD-Q4_K_XL', 'Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL', 'GLM-4.7-Flash-UD-Q4_K_XL']) {
    assert.match(said[name], /^card: Max mode is on, but .+ is loaded on this PC alone\. A Max load starts it again with "Z820" lending \(expert parallel\): about 10 min \(earlier loads over the link took 3 to 16 minutes\)\. It is the first Max load of this model on these PCs, so its speed is measured against this PC alone\. Nothing loads by itself\.$/, name);
  }
  for (const name of ['Qwen3-Coder-Next-UD-Q3_K_XL', 'Qwen3-Next-80B-A3B-Instruct-UD-Q4_K_XL', 'Qwen3.8-Flash-Next-UD-Q3_K_XL', 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL']) {
    assert.equal(said[name], 'greyed: This model does not fit one PC: Cluster runs it', name);
  }
});

test('the same models on a 128 GB PC with a 12 GB card: the big mixture-of-experts models fit there, so they are Max mode models', () => {
  const pc = { card: 11 * GB, ram: 110 * GB };
  for (const name of ['Qwen3-Next-80B-A3B-Instruct-UD-Q4_K_XL', 'Qwen3.8-Flash-Next-UD-Q3_K_XL', 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL']) {
    assert.match(pageSays(FAMILIES.find(m => m.name === name)!, pc), /^card: Max mode is on/, name);
  }
  // No CUDA card here: expert parallel cannot run, said plainly.
  assert.match(pageSays(FAMILIES.find(m => m.name === 'GLM-4.7-Flash-UD-Q4_K_XL')!, pc, false), /^note: Max mode: not used for GLM-4\.7-Flash-UD-Q4_K_XL: expert parallel needs an NVIDIA graphics card \(CUDA\) on this PC\.$/);
});

test('the greyed reasons, in the order a person meets them, each naming the PC', () => {
  // A chat with no linked PC.
  assert.equal(maxGate({ pcs: [], linked: 0, host }).why, 'No linked PC to borrow from: link one under Network, and tick "Allow to be used as part of a cluster" on it');
  assert.equal(maxGate({ pcs: [], linked: 2, host }).why, 'Every linked PC is set to "Don\'t borrow from it" or Backups only here (Network, Linked PCs)');
  assert.equal(maxGate({ pcs: [], linked: 2, clusterOff: true, host }).why, 'The cluster saved here is switched off (Network), and Max mode borrows its members: switch it on first');
  // A linked PC that is off (no hello).
  assert.equal(maxGate({ pcs: [z820({ hello: null })], linked: 1, host }).why, 'No linked PC is on now ("Z820" is off, asleep, or not running TOMLIN)');
  assert.equal(maxGate({ pcs: [z820({ hello: null }), z820({ id: 'b', name: 'HP 800', hello: null })], linked: 2, host }).why, 'No linked PC is on now ("Z820" and "HP 800" are off, asleep, or not running TOMLIN)');
  // On, but its owner has not ticked lending.
  assert.equal(maxGate({ pcs: [z820({ hello: { can: ['max'], allow: { lend: false } } })], linked: 1, host }).why, '"Z820" does not allow lending: tick "Allow to be used as part of a cluster" on it');
  assert.equal(maxGate({ pcs: [z820({ hello: { can: ['max'], allow: null } })], linked: 1, host }).why, '"Z820" does not allow lending: tick "Allow to be used as part of a cluster" on it', 'an older hello with no ticks');
  // An older TOMLIN with no Max mode.
  assert.equal(maxGate({ pcs: [z820({ hello: { can: ['turns'], allow: { lend: true } } })], linked: 1, host }).why, '"Z820" runs a TOMLIN without Max mode: update it there');
  // A build mismatch: the PC that blocks is named.
  const clash = maxGate({ pcs: [z820({ options: [opt('b12250')] })], linked: 1, host });
  assert.match(clash.why, /^No single llama\.cpp build runs safely on this PC and "Z820", so nothing is borrowed from it\. "Z820" blocks it: it can only run b12250/);
  assert.deepEqual(clash.names, []);
  // One off, one on and matching: Max runs with the one that is on.
  const ok = maxGate({ pcs: [z820({ id: 'b', name: 'HP 800', hello: null }), z820()], linked: 2, host });
  assert.deepEqual(ok, { why: '', names: ['Z820'], ids: ['e2c4ba37'], build: 'b11284' });
  // This PC has no runner it can use safely.
  assert.match(maxGate({ pcs: [z820()], linked: 1, host: [] }).why, /^This PC has no llama\.cpp runner it can use safely/);
});

test('the PCs the gate checks are the PCs the load borrows from (one list, not two)', () => {
  const r = (id: string, o: Partial<Remote> = {}) => ({ id, name: id, url: 'http://x', token: 't', key: 'k', ...o }) as Remote;
  const remotes = [r('a'), r('b', { noBorrow: true }), r('c', { backupsOnly: true })];
  assert.deepEqual(maxCandidates(remotes, undefined).map(x => x.id), ['a']);
  const cluster = { on: true, members: ['b', 'c'] } as unknown as Parameters<typeof maxCandidates>[1];
  assert.deepEqual(maxCandidates(remotes, cluster).map(x => x.id), ['b'], 'a cluster member lends even with "Don\'t borrow from it" (the cluster replaces it); Backups only never');
  assert.deepEqual(maxCandidates(remotes, { on: false, members: ['b'] } as unknown as Parameters<typeof maxCandidates>[1]), []);
  const allow = (id: string) => ({ can: ['max'], memory: null, allow: { lend: id !== 'a' } });
  assert.deepEqual(maxPcs('', remotes, allow, undefined).map(x => x.id), [], '"a" has not ticked lending');
  assert.deepEqual(maxPcs('', remotes, () => ({ can: ['max'], memory: null, allow: { lend: true } }), undefined).map(x => x.id), ['a']);
});

test('what Max does for a model that fits: expert parallel until a measurement says alone is faster; never the layer split', () => {
  assert.equal(maxEngine({ model: 'm', moe: true, cuda: true, measured: {} }).trial, true);
  assert.equal(maxEngine({ model: 'm', moe: true, cuda: true, measured: { alone: 8 } }).use, 'experts', 'alone measured, Max not yet: the first Max load measures it');
  const slower = maxEngine({ model: 'Qwen3-Next-80B', moe: true, cuda: true, measured: { alone: 8.67, max: 3.7 } });
  assert.equal(slower.use, 'alone');
  assert.equal(slower.words, 'Max mode: not used for this model, it was faster alone (8.7 against 3.7 tok/s)');
  assert.equal(maxEngine({ model: 'm', moe: true, cuda: true, measured: { alone: 5, max: 5 } }).use, 'alone', 'a tie is not a boost');
  const faster = maxEngine({ model: 'm', moe: true, cuda: true, measured: { alone: 1.2, max: 2.45 } });
  assert.deepEqual([faster.use, faster.trial], ['experts', false]);
  assert.equal(faster.words, 'Max mode: expert parallel, last measured 2.5 tok/s (this PC alone: 1.2 tok/s)');
});

test('the line under an answer: honest numbers, no "faster" unless measured; the card only when a Max load could help', () => {
  const gate = maxGate({ pcs: [z820()], linked: 1, host });
  const base = { on: true, away: '', fitsAlone: true as boolean | null, loaded: null, gate, engine: null, perSecond: 2.45, measured: {}, model: 'DeepSeek-V4-Flash', seconds: null };
  // Written with lenders by expert parallel.
  const ep = afterAnswer({ ...base, loaded: { asked: true, lent: ['Z820'], engine: 'experts', words: '' }, measured: { alone: 1.84 } });
  assert.equal(ep.note, 'Max mode: "Z820" lent (expert parallel), 2.5 tok/s; this PC alone: 1.8 tok/s, last measured.');
  assert.equal(ep.card, undefined);
  assert.equal(maxNote({ lent: ['Z820', 'HP 800'], perSecond: 3 }), 'Max mode: "Z820" and "HP 800" lent (expert parallel), 3 tok/s; this PC alone: not measured yet.');
  for (const n of [ep.note, maxNote({ lent: ['Z820'], perSecond: 9, alone: 1 })]) assert.doesNotMatch(n, /faster|boost|quicker/i);
  // Switch off: nothing said (unless lenders worked on it).
  assert.deepEqual(afterAnswer({ ...base, on: false }), { note: '' });
  // A hire's model on a linked PC.
  assert.equal(afterAnswer({ ...base, away: 'Z820' }).note, 'Max mode: not used: this answer ran on "Z820", and Max mode borrows for a model loaded on this PC.');
  // A model that does not fit one PC.
  assert.equal(afterAnswer({ ...base, fitsAlone: false }).note, 'Max mode: not used: This model does not fit one PC: Cluster runs it.');
  // Loaded by the automatic borrowing (layer split).
  assert.match(afterAnswer({ ...base, loaded: { asked: false, lent: ['Z820'], engine: 'layers', words: '' } }).note, /^Max mode: not used: this load borrows "Z820" with a layer split/);
  // No linked PC on now.
  const off = maxGate({ pcs: [z820({ hello: null })], linked: 1, host });
  assert.equal(afterAnswer({ ...base, gate: off }).note, 'Max mode: not used: No linked PC is on now ("Z820" is off, asleep, or not running TOMLIN).');
  // Measured slower: the note says so, never faster.
  const slower = maxEngine({ model: 'm', moe: true, cuda: true, measured: { alone: 8.67, max: 3.7 } });
  assert.equal(afterAnswer({ ...base, engine: slower }).note, 'Max mode: not used for this model, it was faster alone (8.7 against 3.7 tok/s).');
  // A Max load that ended alone: said, not offered again.
  assert.match(afterAnswer({ ...base, engine: maxEngine({ model: 'm', moe: true, cuda: true, measured: {} }), loaded: { asked: true, lent: [], engine: null, words: 'Max mode: not used for m: expert parallel could not start.' } }).note, /could not start/);
  // Loaded alone, expert parallel possible: the card.
  const loaded = { asked: false, lent: [], engine: null, words: '' };
  const trial = maxEngine({ model: 'm', moe: true, cuda: true, measured: {} });
  const card = afterAnswer({ ...base, engine: trial, loaded, seconds: 7 * 60 });
  assert.equal(card.note, '');
  assert.match(card.card!, /about 7 min \(earlier loads over the link took 3 to 16 minutes\)/);
  assert.match(reloadCardText({ model: 'm', lenders: ['Z820'], seconds: null, trial: false }), /: earlier loads over the link took 3 to 16 minutes\. Nothing loads by itself\.$/);
  assert.doesNotMatch(reloadCardText({ model: 'm', lenders: ['Z820'], seconds: null, trial: false }), /a few minutes/, 'no estimate next to a different range');
  // The model is named as the chat header names it: no quantisation, no .gguf, no part number.
  assert.equal(cardModelName('Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL'), 'Qwen3-Coder-30B-A3B-Instruct-UD');
  assert.equal(cardModelName('gpt-oss-20b-MXFP4.gguf'), 'gpt-oss-20b-MXFP4');
  assert.equal(cardModelName('Qwen3.8-Flash-Next-UD-Q3_K_XL-00001-of-00004.gguf'), 'Qwen3.8-Flash-Next-UD');
  assert.equal(cardModelName('m'), 'm');
  assert.match(reloadCardText({ model: 'Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL', lenders: ['HP 800'], seconds: null, trial: true }), /^Max mode is on, but Qwen3-Coder-30B-A3B-Instruct-UD is loaded on this PC alone\./);
  // Offered once for the load: the next answers (after "Not now", or with no press) get one short line, no card.
  for (let i = 0; i < 3; i++) {
    const next = afterAnswer({ ...base, engine: trial, loaded, seconds: 7 * 60, model: 'm' });
    assert.equal(next.card, undefined);
    assert.equal(next.note, 'Max mode: on, but m runs on this PC alone for this load (unload it, then send, and it loads with the linked PCs).');
  }
  // A new load is a new record: offered again once.
  assert.ok(afterAnswer({ ...base, engine: trial, loaded: { ...loaded, offered: undefined }, seconds: 60 }).card);
  // An expert load measured slower than alone: the line says how to run alone again (nothing reloads by itself).
  const slowEp = afterAnswer({ ...base, loaded: { asked: true, lent: ['Z820'], engine: 'experts', words: '' }, perSecond: 3, measured: { alone: 9, max: 3.1 } });
  assert.equal(slowEp.note, 'Max mode: "Z820" lent (expert parallel), 3 tok/s; this PC alone: 9 tok/s, last measured. This PC alone was faster: unload the model and load it again, and Max mode runs it alone.');
});

test('the speeds Max mode decides by: kept per model and per set of PCs; short answers not counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-maxspeeds-'));
  try {
    const file = join(dir, 'max-speeds.json');
    // Each write is waited for below (they run in the background in the app): a fixed pause was too short under load.
    const writes: Promise<void>[] = [];
    const s = new MaxSpeeds(() => file, (f, text) => {
      const p = (writes.at(-1) ?? Promise.resolve()).then(() => writeFile(f, text));
      writes.push(p);
      return p;
    });
    s.record('m', [], 8.67, 400);
    s.record('m', ['z', 'a'], 3.7, 400);
    s.record('m', ['b'], 9, 40);
    assert.deepEqual(s.get('m', ['a', 'z']), { alone: 8.7, max: 3.7 }, 'the set of PCs, in any order');
    assert.deepEqual(s.get('m', ['b']), { alone: 8.7 }, 'a 40-word-piece answer is not a measurement');
    assert.deepEqual(s.get('other', []), {});
    assert.equal(speedKey('m', ['z', 'a']), 'm|a,z');
    await Promise.all(writes);
    const again = new MaxSpeeds(() => file, async () => undefined);
    assert.deepEqual(again.get('m', ['z', 'a']), { alone: 8.7, max: 3.7 }, 'read back from the file');
    // One noisy answer does not decide: the middle of the last answers does.
    const n = new MaxSpeeds(() => join(dir, 'none.json'), async () => undefined);
    for (const v of [9, 9.2, 8.8]) n.record('q', [], v, 300);
    n.record('q', [], 1.5, 300);
    assert.equal(n.get('q', []).alone, 8.9, 'a slow answer once (another program busy) does not switch Max mode on or off by itself');
    for (const v of [4, 4, 4, 4]) n.record('q', [], v, 300);
    assert.equal(n.get('q', []).alone, 4, 'only the last five answers are kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the switch on the page: beside Web, its tip the server's definition, its reason in words under the chat box", () => {
  // The page's own text, kept in step with the server's words (the switch's behaviour is run on the real server below).
  const html = src('public/index.html');
  const web = html.indexOf('id="web-pick"');
  const max = html.indexOf('id="max-pick"');
  assert.ok(web > 0 && max > web && max - web < 1200, 'right after Web in the chat box');
  assert.equal(/id="max-pick" aria-pressed="false" title="([^"]+)">Max: off<\/button>/.exec(html)?.[1], MAX_TIP, 'the tooltip is the definition, as the server words it');
  assert.doesNotMatch(MAX_TIP, /raises|boosts|faster/, 'nothing about its speed is measured yet');
  assert.match(html, /<p class="hint max-why" id="max-why" role="status" hidden><\/p>/, 'the reason in words, not only in the tip');
  // Pressing the greyed switch says why once (the line under the box), not again as a note in the chat.
  const press = /if \(why && !maxOn\(\)\) \{[\s\S]*?\n  \}/.exec(src('public/app.js'))?.[0] ?? '';
  assert.match(press, /maxPressed = true;/);
  assert.doesNotMatch(press, /chatNote/, 'the reason is not said a second time in the chat');
  assert.ok(src('public/app.js').includes(`'${CLUSTER_RUNS_IT}'`), "the page greys a model that does not fit with the server's words");
  // The Help says it is not yet run on two PCs and gives no made-up speeds.
  const help = src('public/help/cluster.html');
  assert.match(help, /not yet run on two PCs/);
  assert.doesNotMatch(help, /\d+(\.\d+)? against \d+(\.\d+)? tok\/s/);
});

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('on a real server with no linked PC: the switch is greyed with the reason, and the flag is kept on the chat', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tomlin-maxswitch-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, [join(ROOT, 'src', 'server.ts')], {
    env: testEnv({ TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);
    const status = (await (await fetch(`${base}/api/status`)).json()) as { max: { why: string; lenders: string[] } };
    assert.deepEqual(status.max, { why: 'No linked PC to borrow from: link one under Network, and tick "Allow to be used as part of a cluster" on it', lenders: [] });
    // A chat with a made-up hire (the host is off in a bare home).
    assert.equal((await post('/api/staff', { action: 'hire', name: 'Maya', role: 'writer', level: 'junior' })).status, 200);
    const made = await post('/api/chats/new', { who: 'staff:maya' });
    assert.equal(made.status, 200, await made.clone().text());
    const id = ((await made.json()) as { chat: { id: string } }).chat.id;
    const chatOf = async () => ((await (await fetch(`${base}/api/chat?id=${id}`)).json()) as { chat: { max?: boolean } }).chat;
    assert.equal((await chatOf()).max, undefined, 'off until switched on');
    assert.equal((await post('/api/chat/max', { chatId: id, on: true })).status, 200);
    assert.equal((await chatOf()).max, true, 'shown again when the chat is opened');
    assert.equal((await post('/api/chat/max', { chatId: id, on: false })).status, 200);
    assert.equal((await chatOf()).max, false);
    assert.equal((await post('/api/chat/max', { chatId: 'no-such-chat', on: true })).status, 200, 'a chat not made yet keeps it at its first message');
    // A Max load asked for a model that is not here: refused in words, nothing loads.
    const load = await post('/api/models/made-up.gguf/load', { max: true });
    assert.equal(load.status, 404);
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true });
  }
});
