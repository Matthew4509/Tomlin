// The first-run runner test (src/runnercheck.ts), the runners a PC says it can run (hello runner.can), and the Max mode
// choice of one llama.cpp build from them (src/jobrun/maxhost.ts), with stand-in hellos. Nothing starts a real runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDue, checkWord, hardwareKey, judge, LONG_PROMPT, pickModel, questionBody, RunnerChecks, SKIP_WARNING } from '../src/runnercheck.ts';
import { crashedHere, cudaOrder, testedHere, type GpuFacts, type RuntimePin } from '../src/runtimes.ts';
import { cleanRunner } from '../src/runnerpush.ts';
import { programFor, type RpcProgram } from '../src/maxlend.ts';
import { matchView, maxLoad, optionsOf, rpcFor } from '../src/jobrun/maxhost.ts';
import { useDeps } from '../src/jobrun/shared.ts';
import { seen } from '../src/jobrun/links.ts';
import type { JobDeps } from '../src/jobrun.ts';
import type { Remote } from '../src/store.ts';
import type { Member, Option } from '../src/runnermatch.ts';

const GB = 2 ** 30;
const PINS = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'runtimes.json'), 'utf8')) as { runtimes: Record<string, RuntimePin> }).runtimes;
const gpu = (name: string, cc: number, gb: number): GpuFacts => ({ name, vendor: 'nvidia', integrated: false, total: gb * GB, cc });
const RTX3060 = gpu('NVIDIA GeForce RTX 3060', 86, 12);
const P2000 = gpu('Quadro P2000', 61, 5);
const tmp = () => mkdtempSync(join(tmpdir(), 'tl-rcheck-'));

test('the record is for this card and driver: another card or a new driver asks again', () => {
  assert.equal(hardwareKey([RTX3060], '560.94'), 'NVIDIA GeForce RTX 3060 | 560.94');
  assert.equal(hardwareKey([P2000, { ...RTX3060, name: 'A' }], null), 'A + Quadro P2000 | no driver');
  assert.equal(hardwareKey([{ name: 'Intel HD', vendor: 'intel', integrated: true, total: 1 * GB }], '1'), ' | 1', 'a chip built into the processor is not a card');
});

test('the test is offered with a card runner, a model and no answer yet; a stopped test is offered again', () => {
  const rec = (state: 'done' | 'skipped' | 'partial') => ({ hw: 'x', state, at: '', results: {} });
  assert.equal(checkDue({ cardRunners: 1, hasModel: true, rec: null }), true);
  assert.equal(checkDue({ cardRunners: 0, hasModel: true, rec: null }), false, 'no card runner unpacked');
  assert.equal(checkDue({ cardRunners: 2, hasModel: false, rec: null }), false, 'nothing to test with');
  assert.equal(checkDue({ cardRunners: 1, hasModel: true, rec: rec('done') }), false);
  assert.equal(checkDue({ cardRunners: 1, hasModel: true, rec: rec('skipped') }), false);
  assert.equal(checkDue({ cardRunners: 1, hasModel: true, rec: rec('partial') }), true);
});

test('the hello says how the test stands', () => {
  const res = (state: 'passed' | 'failed') => ({ state, at: '', why: '', device: 'cuda', write: null, seconds: null });
  assert.equal(checkWord({ due: true, rec: null }), 'due');
  assert.equal(checkWord({ due: false, rec: null }), 'none');
  assert.equal(checkWord({ due: false, rec: { hw: '', state: 'skipped', at: '', results: {} } }), 'skipped');
  assert.equal(checkWord({ due: false, rec: { hw: '', state: 'done', at: '', results: { a: res('failed'), b: res('passed') } } }), 'passed');
  assert.equal(checkWord({ due: false, rec: { hw: '', state: 'done', at: '', results: { a: res('failed') } } }), 'failed');
});

test('the smallest model that fits the card is the one used, never one Ollama runs', () => {
  const m = [{ id: 'big', bytes: 9 * GB }, { id: 'small', bytes: 1 * GB }, { id: 'mid', bytes: 3 * GB }, { id: 'o', bytes: 0.5 * GB, where: 'ollama' }, { id: 'tiny', bytes: 10 * 2 ** 20 }];
  assert.equal(pickModel(m, 12 * GB)?.id, 'small');
  assert.equal(pickModel(m, 2 * GB), null, 'nothing fits a 2 GB card with room for its context');
  assert.equal(pickModel([], 12 * GB), null);
});

test('three questions, the last one long; answers are short', () => {
  const warm = questionBody('warm');
  const write = questionBody('write');
  const long = questionBody('long');
  assert.equal(warm.max_tokens, 32);
  assert.equal(write.max_tokens, 120);
  assert.equal(long.max_tokens, 60);
  assert.ok(LONG_PROMPT.length > 9000, 'about 3,000 tokens: the old runners crashed on long prompts');
  assert.equal(long.messages[0].content, LONG_PROMPT);
  assert.equal(write.temperature, 0);
  assert.equal(long.stream, false);
});

test('a runner passes only when it ran on its device, answered every question, and is still running', () => {
  const answers = [{ text: 'a', write: 10 }, { text: 'b', write: 12 }, { text: 'c', write: 11 }];
  const ok = { want: 'cuda' as const, state: 'connected', device: 'cuda', error: null, answers, asked: 3, alive: true };
  assert.deepEqual(judge(ok), { ok: true, why: '' });
  assert.match(judge({ ...ok, device: 'cpu' }).why, /ran on the CPU instead of the NVIDIA card \(CUDA\)/);
  assert.match(judge({ ...ok, state: 'failed', error: 'The CUDA runner found no card it can use on this PC.' }).why, /found no card/);
  assert.match(judge({ ...ok, state: 'failed', error: null }).why, /did not load/);
  assert.match(judge({ ...ok, answers: answers.slice(0, 2) }).why, /stopped before it had answered all 3 questions/);
  assert.match(judge({ ...ok, answers: [{ text: ' ', write: 1 }, ...answers.slice(1)] }).why, /answered with nothing/);
  assert.match(judge({ ...ok, alive: false }).why, /stopped on its own after it answered/);
  assert.equal(judge({ ...ok, want: 'vulkan', device: 'vulkan' }).ok, true);
});

test('the skip warning says what skipping risks, in plain words', () => {
  assert.match(SKIP_WARNING, /slower, or can crash/);
  assert.match(SKIP_WARNING, /Models, Model runners/);
});

test('what the test found is kept per card and driver: a failure leaves a runner out, the first pass is kept', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'runner-check.json');
    const c = await new RunnerChecks(file).load();
    const hw = 'card | 1';
    const r = (state: 'passed' | 'failed', why = '') => ({ state, at: new Date().toISOString(), why, device: 'cuda', write: null, seconds: null });
    await c.result(hw, 'llama-cuda', r('failed', 'it crashed'), false);
    assert.equal(c.rec(hw)?.state, 'partial');
    assert.equal(checkDue({ cardRunners: 1, hasModel: true, rec: c.rec(hw) }), true);
    await c.result(hw, 'llama-cuda3', r('passed'), true);
    await c.done(hw);
    const again = await new RunnerChecks(file).load();
    assert.deepEqual([...again.failed(hw)], ['llama-cuda']);
    assert.deepEqual([...again.passed(hw)], ['llama-cuda3']);
    assert.equal(again.keep(hw), 'llama-cuda3');
    assert.equal(again.rec(hw)?.state, 'done');
    assert.equal(again.rec('other | 1'), null);
    await again.result(hw, 'llama-cuda', r('passed'), false);
    assert.equal(again.failed(hw).size, 0, 'a pass clears an earlier failure');
    await again.skip('third | 1');
    assert.equal((await new RunnerChecks(file).load()).rec('third | 1')?.state, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto leaves out a runner that failed here and starts with the one the test kept', () => {
  const base = cudaOrder(PINS, 'llama', [P2000], '581.57');
  assert.deepEqual(base, ['llama-cuda', 'llama-cuda2', 'llama-cuda3']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [P2000], '581.57', { avoid: new Set(['llama-cuda']) }), ['llama-cuda2', 'llama-cuda3']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [P2000], '581.57', { first: 'llama-cuda3' }), ['llama-cuda3', 'llama-cuda', 'llama-cuda2']);
  assert.deepEqual(cudaOrder(PINS, 'llama', [P2000], '581.57', { first: 'llama-cuda13' }), base, 'a kept runner this PC cannot use changes nothing');
});

test('b11284 and b10750 CUDA are known to crash on the RTX 3060 class and come last there; b12250 was tried on it', () => {
  assert.match(crashedHere(PINS['llama-cuda'], [RTX3060], '560.94'), /illegal memory access on long prompts \(seen on GeForce RTX 3060 12 GB, driver 560.94 or newer\)/);
  assert.ok(crashedHere(PINS['llama-cuda2'], [RTX3060], '572.16'));
  assert.equal(crashedHere(PINS['llama-cuda3'], [RTX3060], '560.94'), '');
  assert.equal(crashedHere(PINS['llama-cuda'], [RTX3060], '551.61'), '', 'an older driver than the one it crashed with is not held against it');
  assert.equal(crashedHere(PINS['llama-cuda'], [P2000], '581.57'), '', 'other cards are not held against it');
  assert.equal(crashedHere(PINS['llama-cuda'], [RTX3060, P2000], '581.57'), '', 'a mixed rig is not');
  assert.equal(testedHere(PINS['llama-cuda3'], [RTX3060], '560.94'), true);
  assert.equal(testedHere(PINS['llama-cuda'], [RTX3060], '560.94'), false);
  const order = cudaOrder(PINS, 'llama', [RTX3060], '581.57');
  assert.equal(order[0], 'llama-cuda3');
  assert.deepEqual(order.slice(-2), ['llama-cuda', 'llama-cuda2']);
});

test('a hello carries the runners a PC can run safely; anything that is not a build, device and runner is dropped', () => {
  const r = cleanRunner({ nvidia: true, check: 'due', can: [
    { build: 'b12250', device: 'cuda', pin: 'llama-cuda3', have: true, tested: true },
    { build: 'b11284', device: 'vulkan', pin: 'llama-vulkan', have: false, tested: false },
    { build: '../x', device: 'cuda', pin: 'llama-cuda', have: true, tested: false },
    { build: 'b11284', device: 'tpu', pin: 'llama-cuda', have: true, tested: false },
    { build: 'b11284', device: 'cuda', pin: '../../evil', have: true, tested: false },
    7,
  ] });
  assert.deepEqual(r?.can, [
    { build: 'b12250', device: 'cuda', pin: 'llama-cuda3', have: true, tested: true },
    { build: 'b11284', device: 'vulkan', pin: 'llama-vulkan', have: false, tested: false },
  ]);
  assert.equal(r?.check, 'due');
  assert.equal(cleanRunner({ nvidia: true })?.can, undefined);
  assert.equal(cleanRunner({ nvidia: true, check: 'maybe' })?.check, undefined);
  assert.equal(cleanRunner({ nvidia: true, can: new Array(40).fill({ build: 'b11284', device: 'cpu', pin: 'llama-cpu', have: true, tested: false }) })?.can?.length, 12);
});

test('a lender asked for a build gets that build or nothing', () => {
  const p = (build: string): RpcProgram => ({ exe: `rpc-${build}`, device: 'cuda', threads: 0, build });
  const all = [p('b12250'), p('b11284')];
  assert.equal(programFor(all, 'b11284')?.exe, 'rpc-b11284');
  assert.equal(programFor(all, 'b10750'), null, 'never another build in its place');
  assert.equal(programFor(all, '')?.exe, 'rpc-b12250', 'an older TOMLIN asks for none: the first');
  assert.equal(programFor([], ''), null);
});

// ---- The host's choice, from stand-in hellos ----

const opt = (build: string, device: Option['device'], pin: string, have = true, tested = false): Option => ({ build, device, pin, have, tested });
const remote = (id: string, name: string): Remote => ({ id, name, url: 'http://127.0.0.1:1', token: 'x' });
const hello = (id: string, runner: unknown) => seen.set(id, { runner, at: Date.now() } as never);
const buildOfPin = (pin: string) => ({ 'llama-cuda': 'b11284', 'llama-cuda2': 'b10750', 'llama-cuda3': 'b12250', 'llama-vulkan': 'b11284', 'llama-cpu': 'b11284' })[pin] ?? '';
useDeps({ runner: { runtimes: { buildOfPin } }, store: { peek: () => ({ remotes: [] }) } } as unknown as JobDeps);

test('what a hello can run becomes options; the reasons a build is out are kept by build', () => {
  const got = optionsOf({ nvidia: true, driver: '560.94', why: '', cuda: 'none', said: '', last: null, pins: { 'llama-cuda': { state: 'none', why: '"Z820" must not use this runner: it crashed.' } }, can: [opt('b12250', 'cuda', 'llama-cuda3')] }, buildOfPin);
  assert.deepEqual(got.options, [opt('b12250', 'cuda', 'llama-cuda3')]);
  assert.deepEqual(got.no, { b11284: 'must not use this runner: it crashed' });
  assert.equal(optionsOf(null, buildOfPin).options, null);
  assert.deepEqual(optionsOf({ nvidia: false, driver: null, why: '', cuda: 'none', said: '', last: null, rpc: ['b11284'] }, buildOfPin).options?.map(o => o.build), ['b11284']);
});

test('Max mode: the Z820, the HP 800 and this PC settle on b11284 with nothing to install, and the load says nothing', async () => {
  const host = [opt('b11284', 'cuda', 'llama-cuda'), opt('b11284', 'vulkan', 'llama-vulkan'), opt('b11284', 'cpu', 'llama-cpu')];
  hello('z', { can: [opt('b12250', 'cuda', 'llama-cuda3', true, true), opt('b11284', 'vulkan', 'llama-vulkan'), opt('b11284', 'cpu', 'llama-cpu')], pins: { 'llama-cuda': { state: 'none', why: '"Z820" must not use this runner: it crashed.' } } });
  hello('h', { can: [opt('b11284', 'vulkan', 'llama-vulkan'), opt('b11284', 'cpu', 'llama-cpu')] });
  // Both lenders are unreachable in this test (no link keys): the choice is what is checked.
  const got = await rpcFor([remote('z', 'Z820'), remote('h', 'HP 800')], host);
  assert.equal(matchView()?.build, 'b11284');
  assert.deepEqual(matchView()?.needs, []);
  assert.equal(got.needs, undefined);
  assert.ok(got.notes.every(n => /linked before links were encrypted/.test(n)), got.notes.join(' | '));
});

test('Max mode: a build still to install is asked for, and nothing is borrowed meanwhile', async () => {
  hello('z', { can: [opt('b12250', 'cuda', 'llama-cuda3', true, true)] });
  const got = await rpcFor([remote('z', 'Z820')], [opt('b12250', 'cuda', 'llama-cuda3', false)]);
  assert.equal(got.build, 'b12250');
  assert.deepEqual(got.endpoints, []);
  assert.deepEqual(got.needs?.map(n => [n.name, n.host, n.pin]), [['This PC', true, 'llama-cuda3']]);
  assert.match(got.notes.join(' '), /b12250 is not installed on "This PC \(this PC\)" yet: installing it is asked first/);
  assert.deepEqual(matchView()?.needs.map(n => n.pin), ['llama-cuda3']);
});

test('Max mode: no build in common names the PC that blocks it, in one plain line', async () => {
  hello('z', { can: [opt('b12250', 'cuda', 'llama-cuda3', true, true)], pins: { 'llama-cuda': { state: 'none', why: '"Z820" must not use this runner: it crashed with an illegal memory access.' } } });
  const got = await rpcFor([remote('z', 'Z820')], [opt('b11284', 'cuda', 'llama-cuda'), opt('b11284', 'cpu', 'llama-cpu')]);
  assert.equal(got.build, undefined);
  assert.deepEqual(got.endpoints, []);
  assert.equal(got.notes.length, 1);
  assert.match(got.notes[0], /^Max mode: No single llama\.cpp build runs safely on this PC and "Z820", so nothing is borrowed from it\. "Z820" blocks it: it can only run b12250 \(must not use this runner: it crashed with an illegal memory access\), and this PC and the PCs kept can run b11284\.$/);
});

test('Max mode: a model held to one runner offers only that one, and maxLoad hands the choice on', async () => {
  hello('z', { can: [opt('b12250', 'cuda', 'llama-cuda3', true, true), opt('b11284', 'vulkan', 'llama-vulkan')] });
  const seenHost: Option[][] = [];
  const max = await maxLoad('A model', 'Z820', [remote('z', 'Z820')], async (_pcs, host) => {
    seenHost.push(host ?? []);
    return { endpoints: ['127.0.0.1:5'], lent: ['Z820'], notes: [], build: 'b12250' };
  }, [opt('b12250', 'cuda', 'llama-cuda3')]);
  assert.deepEqual(seenHost, [[opt('b12250', 'cuda', 'llama-cuda3')]]);
  assert.equal(max?.build, 'b12250');
  assert.equal(await maxLoad('A model', '', [], rpcFor), null, 'no Max mode named: nothing asked');
});

test('the members the host builds from are the shape pickBuild takes', () => {
  const m: Member = { id: 'z', name: 'Z820', host: false, options: [opt('b12250', 'cuda', 'llama-cuda3')] };
  assert.equal(m.options?.length, 1);
});
