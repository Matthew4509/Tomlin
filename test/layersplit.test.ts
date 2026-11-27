// The layer split by room (src/layersplit.ts): every PC keeps its free RAM, this PC's cards first, then the lenders, and the
// start limit that follows the file size (src/loadlimit.ts). Both came from 13 Nov 2026: an 89 GB Max mode load needed 16
// minutes against a flat 10, and llama.cpp's fit filled a 24 GB lender to the point its runner crashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatArgs } from '../src/llama.ts';
import { LEND_AIM_KEEP, LEND_REFUSE_KEEP, type Lender, type Listed } from '../src/maxplace.ts';
import { FIT_KEEP_WITH_LENDERS, planLayers, type SplitPlan } from '../src/layersplit.ts';
import { MIN_START_SECONDS, MAX_START_SECONDS, startSeconds, timeUpLine, timeUpWords } from '../src/loadlimit.ts';
import { whyItFailed } from '../src/llama.ts';

const GB = 2 ** 30;
const dev = (name: string, what: string, totalGb: number, freeGb: number): Listed => ({ name, what, total: totalGb * GB, free: freeGb * GB });
const z820: Lender = { name: 'Z820', endpoint: '127.0.0.1:5001', hasCard: true };
const hp: Lender = { name: 'HP 800', endpoint: '127.0.0.1:5002', hasCard: true };
// This PC: a 12 GB card, 40 GB of free RAM. Z820: a 12 GB card and 64 GB of RAM (56 free). HP 800: a 4 GB card, 24 GB of RAM (17 free).
const LISTED: Listed[] = [dev('CUDA0', 'RTX 3060', 12, 11), dev('RPC0', z820.endpoint, 12, 11.2), dev('RPC1', z820.endpoint, 64, 56), dev('RPC2', hp.endpoint, 4, 3.6), dev('RPC3', hp.endpoint, 24, 17), dev('CPU', 'Ryzen', 48, 40)];
const host = { free: 40 * GB };
const made = (p: ReturnType<typeof planLayers>): SplitPlan => {
  assert.ok(!('why' in p), JSON.stringify(p));
  return p as SplitPlan;
};

test('a model this PC\'s card holds stays on it: no layer goes to a lender', () => {
  const p = made(planLayers({ layers: 24, bytes: 4 * GB, kv: 0.5 * GB }, LISTED, [z820, hp], host));
  assert.deepEqual(p.dev, ['CUDA0']);
  assert.deepEqual(p.split, [25]);
  assert.equal(p.ngl, 25);
});

test('an 89 GB model: every PC keeps 4 GB free, and the big PC is used, not the small one first', () => {
  const m = { layers: 48, bytes: 89.5 * GB, kv: 3 * GB };
  const p = made(planLayers(m, LISTED, [z820, hp], host));
  const per = (m.bytes + m.kv) / (m.layers + 1);
  assert.equal(p.dev.length, p.split.length);
  const count = (name: string) => p.split[p.dev.indexOf(name)] ?? 0;
  // Nothing on a lender goes past what leaves it the aimed-for free RAM.
  assert.ok(count('RPC3') * per <= 17 * GB - LEND_AIM_KEEP, 'HP 800 RAM');
  assert.ok(count('RPC1') * per <= 56 * GB - LEND_AIM_KEEP, 'Z820 RAM');
  assert.ok(count('RPC1') > count('RPC3') * 2, 'the Z820 takes the most');
  // Layers off this PC's processor are the sum of the devices; the rest stay in this PC's RAM.
  assert.equal(p.ngl, p.split.reduce((a, b) => a + b, 0));
  assert.ok(p.ngl <= 49);
  assert.ok((49 - p.ngl) * per <= 40 * GB - LEND_AIM_KEEP, 'this PC\'s RAM');
});

test('the floor: a tight set goes down to 2 GB free and says so', () => {
  const tight: Listed[] = [dev('CUDA0', 'card', 12, 11), dev('RPC0', z820.endpoint, 64, 40)];
  const p = made(planLayers({ layers: 48, bytes: 70 * GB, kv: 3 * GB }, tight, [{ ...z820, hasCard: false }], { free: 30 * GB }));
  assert.ok(p.notes.some(n => n.includes(`${(LEND_REFUSE_KEEP / GB).toFixed(1)} GB`)), p.notes.join(' '));
});

test('a lender with one device and no word yet on a card (hasCard null) is kept free like RAM, not filled like a card', () => {
  // A 24 GB PC with no card, 20 GB free, whose hello said nothing of cards: before, it was filled to 1.5 GB free.
  // (This PC has 30 GB free, so the model needs it: a small PC the model does not need is left out.)
  const listed: Listed[] = [dev('CUDA0', 'card', 12, 11), dev('RPC0', hp.endpoint, 24, 20)];
  const m = { layers: 48, bytes: 40 * GB, kv: 2 * GB };
  const per = (m.bytes + m.kv) / (m.layers + 1);
  const unknown = made(planLayers(m, listed, [{ ...hp, hasCard: null }], { free: 30 * GB }));
  const knownRam = made(planLayers(m, listed, [{ ...hp, hasCard: false }], { free: 30 * GB }));
  const onHp = (p: SplitPlan) => p.split[p.dev.indexOf('RPC0')] ?? 0;
  assert.equal(onHp(unknown), onHp(knownRam), 'the same as a PC known to have no card');
  assert.ok(onHp(unknown) > 0, 'it is still used');
  assert.ok(onHp(unknown) * per <= 20 * GB - LEND_AIM_KEEP, 'it keeps the aimed-for free RAM');
  // As a card (the old reading of "not known") it took more, down to 1.5 GB free.
  assert.ok(made(planLayers(m, listed, [{ ...hp, hasCard: true }], { free: 30 * GB })).split[1] > onHp(unknown));
});

test('a model the PCs cannot hold without going under the floor is refused before it starts', () => {
  const p = planLayers({ layers: 48, bytes: 200 * GB, kv: 3 * GB }, LISTED, [z820, hp], host);
  assert.ok('why' in p && p.refuse === true);
  assert.match((p as { why: string }).why, /more room than the PCs have free/);
});

test('no lender devices: no plan (no refusal); no card on this PC: still a plan, the lenders kept to the RAM policy', () => {
  const none = planLayers({ layers: 48, bytes: 10 * GB, kv: 1 * GB }, [dev('CUDA0', 'card', 12, 11)], [z820], host);
  assert.ok('why' in none && !none.refuse);
  // A PC with no card (its processor's runner lists the lenders and CPU only): never left to llama.cpp's own fit.
  const noCard = planLayers({ layers: 48, bytes: 10 * GB, kv: 1 * GB }, [dev('RPC0', z820.endpoint, 64, 56), dev('CPU', 'cpu', 32, 20)], [{ ...z820, hasCard: false }], host);
  assert.ok(!('why' in noCard), 'why' in noCard ? noCard.why : '');
  assert.deepEqual(noCard.dev, ['RPC0']);
  // A 24 GB lender with no card is given its share of free RAM only, never ~16 GB of a 30 GB model.
  const small = planLayers({ layers: 40, bytes: 30 * GB, kv: 2 * GB }, [dev('RPC0', '127.0.0.1:5002', 24, 20.5), dev('CPU', 'Xeon', 64, 50)], [{ name: 'HP 800', endpoint: '127.0.0.1:5002', hasCard: false }], { free: 50 * GB });
  if (!('why' in small)) assert.ok((small.ramHeld['HP 800'] ?? 0) <= 20.5 * GB * 0.6, `HP 800 holds ${((small.ramHeld['HP 800'] ?? 0) / GB).toFixed(1)} GB`);
  else assert.equal(small.refuse, true);
});

test('a PC with no card runs a split by room on its processor: -ngl is the lenders\' layers, not 0', () => {
  const args = chatArgs('m.gguf', 8080, 'cpu', 0, false, { ctx: 8192, cache: 'f16', place: 'auto', rpc: ['127.0.0.1:5001'], maxPlace: { device: 'cpu', dev: ['RPC0'], split: [30], override: [], ngl: 30 } });
  assert.equal(args[args.indexOf('-ngl') + 1], '30');
  assert.equal(args[args.indexOf('-dev') + 1], 'RPC0');
  assert.ok(!args.includes('-fitt'), 'not llama.cpp\'s own fit');
});

test('llama-server gets the layers off the processor, not 999, for a split by room', () => {
  const args = chatArgs('m.gguf', 8080, 'cuda', 0, false, { ctx: 8192, cache: 'f16', place: 'auto', rpc: ['127.0.0.1:5001'], maxPlace: { device: 'cuda', dev: ['CUDA0', 'RPC1'], split: [5, 20], override: [], ngl: 25 } }, true);
  assert.equal(args[args.indexOf('-ngl') + 1], '25');
  assert.equal(args[args.indexOf('-dev') + 1], 'CUDA0,RPC1');
  assert.equal(args[args.indexOf('-ts') + 1], '5,20');
  assert.ok(!args.includes('-ot'));
});

test('llama.cpp\'s own fit with lenders leaves 4 GB free on a device, not its 1 GB', () => {
  assert.equal(FIT_KEEP_WITH_LENDERS, 4096);
  const args = chatArgs('m.gguf', 8080, 'cuda', 0, false, { ctx: 8192, cache: 'f16', place: 'auto', rpc: ['127.0.0.1:5001'], fitMargin: FIT_KEEP_WITH_LENDERS }, true);
  assert.equal(args[args.indexOf('-fitt') + 1], '4096');
});

test('the start limit follows the file: 89 GB gets past the 16 minutes it needed, a small one keeps 10', () => {
  assert.equal(startSeconds(2 * GB, false, {}), MIN_START_SECONDS);
  assert.ok(startSeconds(89.5 * GB, true, {}) > 16 * 60 * 2);
  assert.ok(startSeconds(89.5 * GB, false, {}) > 16 * 60);
  assert.equal(startSeconds(5000 * GB, true, {}), MAX_START_SECONDS);
  assert.equal(startSeconds(89.5 * GB, true, { TOMLIN_LOAD_SECONDS: '7200' }), 7200);
  assert.ok(startSeconds(89.5 * GB, true, { TOMLIN_LOAD_SECONDS: 'x' }) > 600);
});

test('a start that ran out of time says so in plain words, and is not a Max mode fault', () => {
  const tail = ['Remote RPC server crashed', timeUpLine(2400)].join('\n');
  assert.match(timeUpWords(tail) ?? '', /still starting after 40 minutes/);
  assert.match(whyItFailed(tail), /was not started again/);
  assert.equal(timeUpWords('some other tail'), null);
});
