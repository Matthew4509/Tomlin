// The layer split by speed (src/layersplit.ts) with the three real PCs, and the speed test's pure parts (src/speedtest.ts).
// DeepSeek-V4-Flash on 14 Nov 2026 (90 GiB, 43 layers, about 113 MB read a layer a word, i-quant experts).
// Measured that night with a timing relay, model work on its i-quants: the Z820's processor about 6.2 GB/s, the Z240's
// about 4.0. That is the other way round from their memory speeds, so the speed test measures model work per kind of
// quantisation, never the memory alone.
// A lender with 32 GB of RAM or less is left out when the model fits without it, and lends at most 55% of its free RAM
// when it is needed (the HP 800 stalled with 14 to 17 GB). A lender that stalled is given less next time.
// The HP 800's and the cards' speeds are not measured yet: those figures are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEND_AIM_KEEP, SMALL_PC_SHARE, lenderRamCap, type Lender, type Listed } from '../src/maxplace.ts';
import { lentBytes } from '../src/jobrun/maxhost.ts';
import { LEARN_DAYS, LEARN_SHARE, capOf, cleanCaps, learn } from '../src/jobrun/lendcaps.ts';
import { HOP_HERE, HOP_LENDER, planLayers, type SplitPlan } from '../src/layersplit.ts';
import { borrowRule } from '../src/cluster/engine.ts';
import { benchArgs, cleanFigures, cleanSpeed, forHello, kindsHere, measure, parseBench, pickBenchModel, speedFor, staleWhy, type BenchModel, type Figures, type MeasureDeps } from '../src/speedtest.ts';
import { familyOfType, partsOf, type QuantFamily } from '../src/gguf.ts';

const GB = 2 ** 30;
const dev = (name: string, what: string, totalGb: number, freeGb: number): Listed => ({ name, what, total: totalGb * GB, free: freeGb * GB });
// Speeds through weights, bytes a second.
const Z820_RAM = 6.2e9;
const Z240_RAM = 4.0e9;
const HP_RAM = 5e9;
const P2000 = 100e9;
const RTX3060 = 250e9;
const z820: Lender = { name: 'Z820', endpoint: '127.0.0.1:5001', hasCard: true, speed: { card: RTX3060, ram: Z820_RAM } };
const hp: Lender = { name: 'HP 800', endpoint: '127.0.0.1:5002', hasCard: false, speed: { card: 0, ram: HP_RAM } };
// This PC (Z240): P2000 5 GB, 48 GB RAM (38 free). Z820: RTX 3060 12 GB, 64 GB RAM (58 free). HP 800: lends its RAM, 24 GB (20.3 free).
const LISTED: Listed[] = [dev('CUDA0', 'Quadro P2000', 5, 4.3), dev('RPC0', z820.endpoint, 12, 11.2), dev('RPC1', z820.endpoint, 64, 58), dev('RPC2', hp.endpoint, 24, 20.3), dev('CPU', 'i7-6700K', 48, 38)];
const host = { free: 38 * GB, speed: { card: P2000, ram: Z240_RAM } };
const DEEPSEEK = { layers: 43, bytes: 90 * GB, kv: 2 * GB, read: 113e6 };
const per = (m: { layers: number; bytes: number; kv: number }) => (m.bytes + m.kv) / (m.layers + 1);
const made = (p: ReturnType<typeof planLayers>): SplitPlan => {
  assert.ok(!('why' in p), JSON.stringify(p));
  return p as SplitPlan;
};
const on = (p: SplitPlan, name: string) => p.split[p.dev.indexOf(name)] ?? 0;
const hereOf = (p: SplitPlan, m: { layers: number }) => m.layers + 1 - p.ngl;
/** Seconds a word by the same arithmetic as the planner, for any split. */
const cost = (counts: { n: number; speed: number; lender: boolean }[], read: number) =>
  counts.filter(c => c.n > 0).reduce((s, c) => s + (c.n * read) / c.speed + (c.lender ? HOP_LENDER : HOP_HERE), 0);

test('DeepSeek by speed: the cards and then the Z820\'s processor are full, the HP 800 is left out, this PC\'s RAM takes the rest', () => {
  const p = made(planLayers(DEEPSEEK, LISTED, [z820, hp], host));
  assert.equal(p.how, 'speed');
  const pl = per(DEEPSEEK);
  const room = (freeGb: number, keep: number) => Math.floor(Math.max(0, freeGb * GB - keep) / pl);
  // The cards and the Z820's processor (faster than this PC's on i-quants) hold as many layers as their room lets them.
  assert.equal(on(p, 'RPC0'), room(11.2, 1.5 * GB), '3060');
  assert.equal(on(p, 'CUDA0'), room(4.3, 1.5 * GB), 'P2000');
  assert.equal(on(p, 'RPC1'), room(58, LEND_AIM_KEEP + 0.5 * GB), 'Z820 RAM');
  // The HP 800 (24 GB) is not needed: the others hold the model with 4 GB free each, so it lends nothing.
  assert.equal(on(p, 'RPC2'), 0);
  assert.ok(p.notes.some(n => n.startsWith('"HP 800"\'s RAM is left out: a PC with this little RAM is not a safe lender')), p.notes.join(' | '));
  // This PC's RAM, the slowest, takes the rest.
  const rest = DEEPSEEK.layers + 1 - on(p, 'RPC0') - on(p, 'CUDA0') - on(p, 'RPC1');
  assert.equal(hereOf(p, DEEPSEEK), rest);
  assert.equal(p.ngl, p.split.reduce((a, b) => a + b, 0));
  assert.deepEqual(Object.keys(p.ramHeld), ['Z820']);
  // No slower than the split by room on the same rules (no figures sent).
  const old = made(planLayers(DEEPSEEK, LISTED, [{ ...z820, speed: null }, { ...hp, speed: null }], { free: host.free }));
  assert.equal(old.how, 'room');
  const timeOf = (x: SplitPlan) => cost([
    { n: on(x, 'CUDA0'), speed: P2000, lender: false }, { n: on(x, 'RPC0'), speed: RTX3060, lender: true }, { n: on(x, 'RPC1'), speed: Z820_RAM, lender: true },
    { n: on(x, 'RPC2'), speed: HP_RAM, lender: true }, { n: hereOf(x, DEEPSEEK), speed: Z240_RAM, lender: false },
  ], DEEPSEEK.read);
  assert.ok(timeOf(p) <= timeOf(old), `${timeOf(p)} against ${timeOf(old)}`);
  assert.ok(Math.abs(p.perWord! - timeOf(p)) < 1e-9, 'the estimate is the same arithmetic');
  // Plain words: what each device got and how fast it is.
  assert.match(p.words, /^layers by speed: /);
  assert.match(p.words, /"Z820"'s RAM \(6\.2 GB\/s, as many as it holds\)/);
  assert.match(p.words, /this PC's RAM \(4\.0 GB\/s\)$/);
  assert.match(p.words, /"Z820"'s card \(250\.0 GB\/s, as many as it holds\)/);
});

test('when the model needs the 24 GB HP 800, it lends at most 55% of its free RAM, not free less 4.5 GB', () => {
  // This PC with 20 GB free: the HP 800 is needed.
  const p = made(planLayers(DEEPSEEK, LISTED, [z820, hp], { ...host, free: 20 * GB }));
  const held = on(p, 'RPC2') * per(DEEPSEEK);
  assert.ok(on(p, 'RPC2') > 0, 'it is used');
  assert.ok(held <= 20.3 * GB * SMALL_PC_SHARE, `${(held / GB).toFixed(1)} GB`);
  // 14 Nov: 7 layers (about 14.4 GB) worked once and then stalled it; 8 (about 17 GB) stalled it.
  assert.ok(held < 14 * GB, `${(held / GB).toFixed(1)} GB is under what stalled it`);
  assert.equal(p.ramHeld['HP 800'], held);
  assert.ok(p.notes.some(n => n.startsWith('"HP 800"\'s RAM holds') && n.includes('lends at most 55% of its free RAM')), p.notes.join(' | '));
  // The same in the split by room, and in what Max mode counts as lent before a load (maxhost lentBytes).
  const room = made(planLayers(DEEPSEEK, LISTED, [{ ...z820, speed: null }, { ...hp, speed: null }], { free: 20 * GB }));
  assert.ok(on(room, 'RPC2') * per(DEEPSEEK) <= 20.3 * GB * SMALL_PC_SHARE);
  const hello = (totalGb: number, freeGb: number) => ({ can: ['max'], memory: { cards: { count: 0 }, ram: { total: totalGb * GB, used: (totalGb - freeGb) * GB } } });
  assert.equal(lentBytes([hello(24, 20.3)]), 20.3 * GB * SMALL_PC_SHARE);
  assert.equal(lentBytes([hello(64, 58)]), 58 * GB - LEND_AIM_KEEP - 0.5 * GB, 'a big PC keeps the old rule');
  assert.equal(lenderRamCap(20.3 * GB, 24 * GB), 20.3 * GB * SMALL_PC_SHARE);
  assert.equal(lenderRamCap(58 * GB, 64 * GB), 58 * GB - LEND_AIM_KEEP - 0.5 * GB);
});

test('a lender that stalled is given less next time: the learned cap holds in the split', () => {
  // The Z820 stalled holding 55 GB: about 41 GB from now on.
  const caps = learn({}, 'e2c4ba37', 55 * GB, 'did not answer for 30 seconds', Date.parse('2026-11-14T21:22:00Z'));
  const cap = capOf(caps, 'e2c4ba37', Date.parse('2026-11-15T09:00:00Z'))!;
  assert.equal(cap, Math.floor(55 * GB * LEARN_SHARE));
  const p = made(planLayers(DEEPSEEK, LISTED, [{ ...z820, capRam: cap }, hp], host));
  assert.ok(on(p, 'RPC1') * per(DEEPSEEK) <= cap, 'within the learned cap');
  assert.ok(p.notes.some(n => n.startsWith('"Z820"\'s RAM holds') && n.includes('stopped answering with more before')), p.notes.join(' | '));
});

test('the learned cap: lowered by each stall, never raised, gone after 30 days, and a damaged file is none', () => {
  const t0 = Date.parse('2026-11-14T21:22:00Z');
  let caps = learn({}, 'hp', 14.4 * GB, 'stalled', t0);
  assert.equal(capOf(caps, 'hp', t0), Math.floor(14.4 * GB * LEARN_SHARE));
  // A later stall with less held lowers it; one with more held does not raise it.
  caps = learn(caps, 'hp', 8 * GB, 'stalled again', t0 + 1000);
  assert.equal(capOf(caps, 'hp', t0 + 2000), Math.floor(8 * GB * LEARN_SHARE));
  caps = learn(caps, 'hp', 20 * GB, 'stalled', t0 + 3000);
  assert.equal(capOf(caps, 'hp', t0 + 4000), Math.floor(8 * GB * LEARN_SHARE));
  assert.equal(capOf(caps, 'hp', t0 + (LEARN_DAYS + 1) * 864e5), null);
  assert.equal(capOf(caps, 'other', t0), null);
  assert.deepEqual(learn(caps, 'hp', 0, 'held nothing in RAM', t0), caps, 'a lender that held no RAM layers learns nothing');
  assert.deepEqual(cleanCaps({ hp: { bytes: 'x', at: 'y' }, ok: { bytes: 5, at: '2026-11-14T00:00:00Z', why: 'w' } }), { ok: { bytes: 5, at: '2026-11-14T00:00:00Z', why: 'w' } });
  assert.deepEqual(cleanCaps('broken'), {});
});

test('a slow device the model does not need is left out, and the note says why', () => {
  // 40 GB: the cards and the Z820's processor hold it all, so this PC's slower processor gets nothing.
  const m = { layers: 43, bytes: 40 * GB, kv: 1 * GB, read: 60e6 };
  const p = made(planLayers(m, LISTED, [z820, hp], host));
  assert.equal(p.how, 'speed');
  assert.equal(hereOf(p, m), 0, 'this PC\'s RAM is not used');
  assert.ok(p.notes.some(n => /^This PC's RAM is left out \(4\.0 GB\/s\): slower, and the model does not need its room\.$/.test(n)), p.notes.join(' | '));
  assert.ok(on(p, 'RPC0') > 0 && on(p, 'RPC1') > 0);
  // With the speeds the other way round (a K-quant model, say, where this PC is faster), the Z820's RAM is the one left out.
  const k = made(planLayers(m, LISTED, [{ ...z820, speed: { card: RTX3060, ram: 5e9 } }, hp], { ...host, speed: { card: P2000, ram: 9e9 } }));
  assert.equal(on(k, 'RPC1'), 0);
  assert.ok(k.notes.some(n => n.startsWith('"Z820"\'s RAM is left out (5.0 GB/s): slower')), k.notes.join(' | '));
});

test('a fast device with room for one small layer is not worth the network hop', () => {
  // A lender whose card holds one layer: 1 layer of 5 MB at 250 GB/s saves less than its 2 ms hop over 4 GB/s RAM here.
  const tiny: Lender = { name: 'Tiny', endpoint: '127.0.0.1:5003', hasCard: true, speed: { card: RTX3060, ram: 1e9 } };
  const m = { layers: 40, bytes: 8 * GB, kv: 0.5 * GB, read: 5e6 };
  const pl = per(m);
  const listed: Listed[] = [dev('CUDA0', 'card', 5, 1.5 + (2 * pl) / GB), dev('RPC0', tiny.endpoint, 4, 1.5 + (1.2 * pl) / GB), dev('RPC1', tiny.endpoint, 8, 1)];
  const p = made(planLayers(m, listed, [tiny], host));
  assert.equal(on(p, 'RPC0'), 0);
  assert.ok(p.notes.some(n => n.includes('"Tiny"\'s card is left out') && n.includes('not worth the hop')), p.notes.join(' | '));
});

test('an older TOMLIN that sends no figures: the split by room, exactly as before, and the note names it', () => {
  const older = { ...hp, speed: undefined };
  // This PC with 20 GB free: the model needs the HP 800, so its missing figures matter.
  const p = made(planLayers(DEEPSEEK, LISTED, [z820, older], { ...host, free: 20 * GB }));
  const before = made(planLayers(DEEPSEEK, LISTED, [{ ...z820, speed: undefined }, older], { free: 20 * GB }));
  assert.equal(p.how, 'room');
  assert.deepEqual([p.dev, p.split, p.ngl], [before.dev, before.split, before.ngl]);
  assert.match(p.byRoom ?? '', /"HP 800"/);
  assert.match(p.byRoom ?? '', /older TOMLIN/);
  assert.ok(p.notes.some(n => n.startsWith('Layers dealt by room, not speed: ')), p.notes.join(' | '));
  // When the model does not need it (this PC with 38 GB free), the older PC is left out and the split goes by speed.
  assert.equal(made(planLayers(DEEPSEEK, LISTED, [z820, older], host)).how, 'speed');
  // This PC without figures (its test not run yet) also keeps the split by room.
  const noHost = made(planLayers(DEEPSEEK, LISTED, [z820, hp], { free: host.free }));
  assert.equal(noHost.how, 'room');
  assert.match(noHost.byRoom ?? '', /this PC/);
  // A newer lender with no figure for this model's kind (null): by room, and the words say which kind is missing.
  const noKind = made(planLayers({ ...DEEPSEEK, kind: 'iq' }, LISTED, [z820, { ...hp, speed: null }], { ...host, free: 20 * GB }));
  assert.equal(noKind.how, 'room');
  assert.match(noKind.byRoom ?? '', /^no speed figure for i-quant models \(IQ2, IQ3 and the like\) yet from "HP 800"/);
  assert.doesNotMatch(noKind.byRoom ?? '', /older TOMLIN/);
});

test('a model that fits one PC stays on it: not borrowed (borrowRule), and by speed it stays on this PC\'s card', () => {
  // A 4 GB dense model on the Z240 (P2000, 3.3 GB free on the card for it): fits the card only with a smaller one.
  assert.equal(borrowRule({ need: 3 * GB, card: 3.3 * GB, ram: 38 * GB, moe: false }, true).borrow, false);
  // A 30 GB mixture-of-experts model fits the Z240's card and RAM: not split.
  assert.equal(borrowRule({ need: 30 * GB, card: 3.3 * GB, ram: 38 * GB, moe: true }, true).borrow, false);
  // DeepSeek (90 GiB) does not fit the Z240 alone: borrowed.
  assert.equal(borrowRule({ need: 100 * GB, card: 3.3 * GB, ram: 38 * GB, moe: true }, true).borrow, true);
  // Forced to plan with lenders anyway (TOMLIN_MAX names them): a model this PC's card holds, read by layers of
  // the same speed as a lender's RAM, stays here.
  const p = made(planLayers({ layers: 24, bytes: 2 * GB, kv: 0.2 * GB }, LISTED, [{ ...z820, speed: { card: P2000, ram: Z820_RAM } }, hp], host));
  assert.deepEqual(p.dev, ['CUDA0']);
  assert.equal(p.ngl, 25);
});

test('the refusal and its words are the same by speed as by room', () => {
  const p = planLayers({ layers: 48, bytes: 200 * GB, kv: 3 * GB }, LISTED, [z820, hp], host);
  assert.ok('why' in p && p.refuse === true);
});

// ---- The speed test's pure parts ----

test('a hello carries model work per kind of quantisation; none from an older TOMLIN or a misreading', () => {
  const said = { at: '2026-11-14T22:40:00.000Z', kinds: { iq: { card: 250e9, ram: 6.2e9 }, k: { card: 0, ram: 9e9 }, junk: { ram: 5e9 } } };
  assert.deepEqual(cleanSpeed(said), { at: '2026-11-14T22:40:00.000Z', kinds: { iq: { card: 250e9, ram: 6.2e9 }, k: { card: 0, ram: 9e9 } } });
  assert.equal(cleanSpeed(undefined), null);
  assert.equal(cleanSpeed({ card: 1e9, ram: 5e9 }), null, 'the first form, with no kinds');
  assert.equal(cleanSpeed({ kinds: { iq: { ram: 'fast' } } }), null);
  assert.equal(cleanSpeed({ kinds: { iq: { ram: 1e15 } } }), null, 'past any real memory');
  assert.equal(cleanSpeed({ kinds: { iq: { ram: 6e9, card: -3 } } })?.kinds.iq?.card, 0);
  // The figure for a model of one kind, and none for a kind not measured.
  const s = cleanSpeed(said);
  assert.deepEqual(speedFor(s, 'iq'), { card: 250e9, ram: 6.2e9 });
  assert.equal(speedFor(s, 'legacy'), null);
  assert.equal(speedFor(s, null), null);
  assert.equal(speedFor(null, 'iq'), null);
  // The hello carries the figures, not the names of the PC's parts or models, and never the memory pass.
  const f: Figures = { at: 'x', kinds: { iq: { card: 1e11, ram: 4e9, model: 'small-IQ2_XS.gguf' } }, pass: 20e9, cpu: 'i7-6700K', cardName: 'Quadro P2000' };
  assert.deepEqual(forHello(f), { at: 'x', kinds: { iq: { card: 1e11, ram: 4e9 } } });
  assert.equal(forHello({ ...f, kinds: {} }), null, 'only the memory pass: nothing to place by');
  assert.equal(forHello(null), null);
  // A file saved by the first form of the test (no kinds) is measured again.
  assert.equal(cleanFigures({ at: 'x', card: 1, ram: 1, how: 'bench' }), null);
  assert.deepEqual(cleanFigures(f), f);
});

test('the test runs again when its figures are missing, a month old, the parts changed, or a model of a new kind is here', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const f: Figures = { at: '2026-11-10T12:00:00Z', kinds: { k: { card: 1e11, ram: 1e10, model: 'a.gguf' } }, pass: 0, cpu: 'Xeon E5-2640', cardName: 'RTX 3060' };
  const hw = { cpu: 'Xeon E5-2640', cardName: 'RTX 3060', kinds: ['k'] as QuantFamily[] };
  assert.equal(staleWhy(f, hw, now), '');
  assert.match(staleWhy(null, hw, now), /no speed figures/);
  assert.match(staleWhy({ ...f, at: '2026-10-01T00:00:00Z' }, hw, now), /days old/);
  assert.match(staleWhy(f, { ...hw, cardName: 'RTX 5060' }, now), /card changed/);
  assert.match(staleWhy(f, { ...hw, cpu: 'Xeon E5-2670' }, now), /processor changed/);
  assert.match(staleWhy(f, { ...hw, kinds: ['iq', 'k'] }, now), /small iq model is here now/);
});

const bm = (path: string, gb: number, kind: QuantFamily | null, readGb = gb): BenchModel => ({ path, bytes: gb * GB, kind, read: readGb * GB });

test('the test model for each kind: a small one of that kind, by the bytes it reads a word', () => {
  const ms: BenchModel[] = [
    bm('C:/m/big-Q4_K_M.gguf', 20, 'k'),
    bm('C:/m/q4-3b-Q4_K_M.gguf', 2, 'k'),
    bm('C:/m/q4-1b-Q4_K_M.gguf', 1.1, 'k'),
    bm('C:/m/tiny-Q4_K_M.gguf', 0.4, 'k'),
    // A mixture-of-experts i-quant model: 12 GB on disk, 1.4 GB read a word. Usable for the test.
    bm('C:/m/a3b-IQ2_XS.gguf', 12, 'iq', 1.4),
    bm('C:/m/unknown-moe.gguf', 3, 'iq', 0),
  ];
  assert.equal(pickBenchModel(ms, 'k')?.path, 'C:/m/q4-1b-Q4_K_M.gguf');
  assert.equal(pickBenchModel(ms, 'iq')?.path, 'C:/m/a3b-IQ2_XS.gguf');
  assert.equal(pickBenchModel(ms.filter(m => m.bytes < GB), 'k')?.path, 'C:/m/tiny-Q4_K_M.gguf');
  assert.equal(pickBenchModel(ms, 'legacy'), null);
  assert.deepEqual(kindsHere(ms), ['iq', 'k']);
  assert.deepEqual(benchArgs('m.gguf', 0), ['-m', 'm.gguf', '-p', '0', '-n', '32', '-r', '2', '-ngl', '0', '-o', 'json']);
});

test('llama-bench\'s JSON gives words a second; anything else gives none', () => {
  assert.equal(parseBench('load_backend: loaded CUDA\n[{"n_prompt":0,"n_gen":32,"avg_ts":41.5,"stddev_ts":0.2}]\n'), 41.5);
  assert.equal(parseBench(''), 0);
  assert.equal(parseBench('error: failed to load model'), 0);
  assert.equal(parseBench('[{"n_gen":0,"avg_ts":900}]'), 0);
});

const fake = (o: Partial<MeasureDeps> & { out?: Record<string, string> }): MeasureDeps => ({
  bench: 'C:/r/llama-bench.exe',
  models: [bm('C:/m/q4-1b-Q4_K_M.gguf', 1, 'k'), bm('C:/m/a3b-IQ2_XS.gguf', 12, 'iq', 1.5)],
  card: true,
  cardFree: 4 * GB,
  cpu: 'i7-6700K',
  cardName: 'Quadro P2000',
  // The answer by model and device: "<file>|<ngl>".
  run: async (_exe, args) => o.out?.[`${args[1].split('/').pop()}|${args[args.indexOf('-ngl') + 1]}`] ?? '',
  pass: async () => 20e9,
  now: () => new Date('2026-11-14T22:40:00Z'),
  ...o,
});
const ts = (n: number) => `[{"n_gen":32,"avg_ts":${n}}]`;

test('the test: words a second times the bytes read a word, per kind, on the processor and on the card', async () => {
  const { figures, words } = await measure(fake({ out: { 'q4-1b-Q4_K_M.gguf|0': ts(12), 'q4-1b-Q4_K_M.gguf|99': ts(80), 'a3b-IQ2_XS.gguf|0': ts(2) } }));
  assert.deepEqual(figures.kinds.k, { ram: 12 * GB, card: 80 * GB, model: 'q4-1b-Q4_K_M.gguf' });
  // The i-quant model does not fit the 4 GB card: processor only.
  assert.deepEqual(figures.kinds.iq, { ram: 3 * GB, card: 0, model: 'a3b-IQ2_XS.gguf' });
  assert.equal(figures.pass, 20e9);
  assert.equal(figures.at, '2026-11-14T22:40:00.000Z');
  assert.match(words, /iq: processor 3\.2 GB\/s, the card had too little free memory for it/);
  assert.match(words, /k: processor 12\.9 GB\/s, card 85\.9 GB\/s/);
  assert.match(words, /not used to place layers/);
});

test('the test: no small model or no llama-bench gives no figures to place by, only the memory pass, told', async () => {
  const none = await measure(fake({ models: [] }));
  assert.deepEqual(none.figures.kinds, {});
  assert.equal(none.figures.pass, 20e9);
  assert.match(none.words, /no small model here/);
  assert.equal(forHello(none.figures), null);
  const noBench = await measure(fake({ bench: null }));
  assert.deepEqual(noBench.figures.kinds, {});
  // A PC that lends no card is not tested on one.
  let asked = 0;
  await measure(fake({ card: false, run: async () => (asked++, ts(12)) }));
  assert.equal(asked, 2, 'one run a kind, on the processor');
});

test('the kind of quantisation of a tensor type: i-quants, K-quants, the older quants, floats', () => {
  // IQ2_XS 17, IQ3_XXS 18, IQ1_M 29, IQ4_XS 23; Q4_K 12, Q6_K 14; Q4_0 2, Q8_0 8; F16 1, BF16 30; MXFP4 39.
  assert.deepEqual([17, 18, 29, 23].map(familyOfType), ['iq', 'iq', 'iq', 'iq']);
  assert.deepEqual([12, 14].map(familyOfType), ['k', 'k']);
  assert.deepEqual([2, 8].map(familyOfType), ['legacy', 'legacy']);
  assert.deepEqual([1, 30].map(familyOfType), ['float', 'float']);
  assert.equal(familyOfType(39), 'other');
});

test('a split model file is read over all its parts (DeepSeek-V4-Flash: the first part holds only the header)', () => {
  assert.deepEqual(partsOf('D:/m/DeepSeek-V4-Flash-UD-Q2_K_XL-00001-of-00003.gguf'), [
    'D:/m/DeepSeek-V4-Flash-UD-Q2_K_XL-00001-of-00003.gguf',
    'D:/m/DeepSeek-V4-Flash-UD-Q2_K_XL-00002-of-00003.gguf',
    'D:/m/DeepSeek-V4-Flash-UD-Q2_K_XL-00003-of-00003.gguf',
  ]);
  assert.deepEqual(partsOf('C:/m/Qwen3.5-2B-Q4_K_M.gguf'), ['C:/m/Qwen3.5-2B-Q4_K_M.gguf']);
});
