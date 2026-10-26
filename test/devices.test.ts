// Card choice (src/devices.ts): reading each runner's cards, matching one card across runners, keeping only runner
// names in a setting, the runner's arguments, and the speed finder's card rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtIn, builtInListed, cardLabels, cardsOf, cleanCardIds, idsFor, parseDevices, parseSdDevices, pictureOffload, pickSdDevice, startCards } from '../src/devices.ts';
import { chatArgs } from '../src/llama.ts';
import { cleanRunWith } from '../src/runset.ts';
import * as sf from '../src/speedfinder.ts';

const GB = 2 ** 30;
const CUDA = `ggml_cuda_init: found 2 CUDA devices:
Available devices:
  CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB, 11200 MiB free)
  CUDA1: Quadro K1200 (4095 MiB, 3900 MiB free)
`;
// Vulkan counts them in another order, a little differently, and lists the chip built into the processor too.
const VULKAN = `Available devices:
  Vulkan0: Quadro K1200 (4096 MiB, 3800 MiB free)
  Vulkan1: NVIDIA GeForce RTX 3060 (12288 MiB, 11000 MiB free)
  Vulkan2: Intel(R) HD Graphics 530 (8137 MiB, 7474 MiB free)
`;

test('a runner\'s device list is read as it prints it; anything else is left out', () => {
  const d = parseDevices(CUDA);
  assert.deepEqual(d.map(x => x.id), ['CUDA0', 'CUDA1']);
  assert.equal(d[0].desc, 'NVIDIA GeForce RTX 3060');
  assert.equal(d[0].total, 12287 * 2 ** 20);
  assert.deepEqual(parseDevices('Available devices:\n  RPC0: 127.0.0.1:50631 (16275 MiB, 4085 MiB free)\n'), [], 'a lent card is Max mode\'s, not this PC\'s');
  assert.deepEqual(parseDevices(''), []);
});

test('one card is one card across runners (by name and size, in each runner\'s order); the built-in chip is left out', () => {
  const cards = cardsOf([parseDevices(CUDA), parseDevices(VULKAN)]);
  assert.deepEqual(cards.map(c => [c.label, c.ids]), [['NVIDIA GeForce RTX 3060', ['CUDA0', 'Vulkan1']], ['Quadro K1200', ['CUDA1', 'Vulkan0']]]);
  // Two cards of the same kind stay two.
  const twin = cardsOf([parseDevices('  CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB, 1 MiB free)\n  CUDA1: NVIDIA GeForce RTX 3060 (12287 MiB, 1 MiB free)'), parseDevices('  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 1 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 3060 (12288 MiB, 1 MiB free)')]);
  assert.deepEqual(twin.map(c => c.ids), [['CUDA0', 'Vulkan0'], ['CUDA1', 'Vulkan1']]);
  // This laptop: the Intel chip only, so no card to choose.
  assert.deepEqual(cardsOf([parseDevices('  Vulkan0: Intel(R) HD Graphics 520 (8137 MiB, 7474 MiB free)')]), []);
  // A built-in chip the hardware list names.
  assert.deepEqual(cardsOf([parseDevices('  Vulkan0: AMD Radeon 780M (4096 MiB, 1 MiB free)')], ['AMD Radeon 780M']), []);
  assert.deepEqual(cardLabels(cards, ['Vulkan0']), ['Quadro K1200']);
});

test('a setting keeps runner names only; each runner gets its own', () => {
  assert.deepEqual(cleanCardIds(['CUDA0', 'Vulkan1', 'CUDA0', 'RPC0', '-ngl 99', 'cuda0', 3]), ['CUDA0', 'Vulkan1']);
  assert.deepEqual(cleanCardIds('CUDA0'), []);
  assert.deepEqual(idsFor('cuda', ['CUDA0', 'Vulkan1']), ['CUDA0']);
  assert.deepEqual(idsFor('vulkan', ['CUDA0', 'Vulkan1']), ['Vulkan1']);
  assert.deepEqual(idsFor('cpu', ['CUDA0']), []);
  const list = [{ id: 'big.gguf', name: 'Qwen3-30B-A3B-Q4_K_M', bytes: 18 * GB }, { id: 'small.gguf', name: 'Qwen3-0.6B-Q8_0', bytes: 0.6 * GB }];
  const r = cleanRunWith({ cards: ['CUDA0', 'Vulkan1'], draft: 'small.gguf', draftCard: ['CUDA1', 'Vulkan0'] }, 'big.gguf', list, [8192]);
  assert.deepEqual(r.cards, ['CUDA0', 'Vulkan1']);
  assert.deepEqual(r.draftCard, ['CUDA1', 'Vulkan0']);
  assert.equal(cleanRunWith({ draftCard: ['CUDA1'] }, 'big.gguf', list, [8192]).draftCard, undefined, 'no guessing model: no card for it');
  assert.equal(cleanRunWith({ draft: 'small.gguf', draftOn: 'ram', draftCard: ['CUDA1'] }, 'big.gguf', list, [8192]).draftCard, undefined, 'in RAM: no card');
  assert.equal(cleanRunWith({ cards: [] }, 'big.gguf', list, [8192]).cards, undefined, 'none: Auto');
});

test('the runner is started on the chosen cards (and Max mode\'s lent ones), the guessing model on its own', () => {
  const run = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const, cards: ['CUDA0', 'Vulkan1'], draft: 'g.gguf', draftCard: ['CUDA1', 'Vulkan0'] };
  const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
  const cuda = chatArgs('m.gguf', 9000, 'cuda', 4, false, run, true);
  assert.equal(flag(cuda, '-dev'), 'CUDA0');
  assert.equal(flag(cuda, '-devd'), 'CUDA1');
  const vk = chatArgs('m.gguf', 9000, 'vulkan', 4, false, run, true);
  assert.equal(flag(vk, '-dev'), 'Vulkan1');
  assert.equal(flag(vk, '-devd'), 'Vulkan0');
  // Max mode: the lent cards are devices too, named in --rpc order, so a card list must name them as well.
  const max = chatArgs('m.gguf', 9000, 'cuda', 4, false, { ...run, rpc: ['127.0.0.1:1', '127.0.0.1:2'] }, true);
  assert.equal(flag(max, '-dev'), 'CUDA0,RPC0,RPC1');
  // Auto, the CPU, or the guessing model in RAM: no card named.
  assert.equal(flag(chatArgs('m.gguf', 9000, 'cuda', 4, false, { ctx: 8192, cache: 'f16', place: 'auto' }, true), '-dev'), null);
  assert.equal(flag(chatArgs('m.gguf', 9000, 'cpu', 4, false, run), '-dev'), null);
  assert.equal(flag(chatArgs('m.gguf', 9000, 'cuda', 4, false, { ...run, draftOn: 'ram' }, true), '-devd'), null);
  // A card only the other runner knows: Auto for this one.
  assert.equal(flag(chatArgs('m.gguf', 9000, 'cuda', 4, false, { ...run, cards: ['Vulkan1'] }, true), '-dev'), null);
});

test('speed finder on a two-card PC: the biggest card alone first, the guessing model on the second card in Full', () => {
  const Q30 = { id: 'Qwen3-30B-A3B-Q4_K_M.gguf', name: 'Qwen3-30B-A3B-Q4_K_M', bytes: 17 * GB };
  const Q06 = { id: 'Qwen3-0.6B-Q8_0.gguf', name: 'Qwen3-0.6B-Q8_0', bytes: 0.6 * GB };
  const pc: sf.PcFacts = {
    cards: [{ name: 'NVIDIA GeForce RTX 3060', total: 12 * GB, free: 11 * GB, ids: ['CUDA0', 'Vulkan1'] }, { name: 'Quadro K1200', total: 4 * GB, free: 4 * GB, ids: ['CUDA1', 'Vulkan0'] }],
    cores: 4, threads: 0, models: [Q30, Q06],
  };
  const m: sf.ModelFacts = { ...Q30, moe: true, layers: 48, expertsPerLayer: 0.33 * GB, rest: 1.2 * GB, ctxBytes: 0.8 * GB, guesser: { ...Q06, ctxBytes: 0.1 * GB } };
  const now: sf.NowFacts = { run: { ctx: 8192, cache: 'f16', place: 'auto' }, spilled: true, cardBytes: 10 * GB };
  const quick = sf.setupsFor(pc, m, now, 'quick');
  assert.equal(quick.rows[1].id, 'cards-one');
  assert.equal(quick.rows[1].name, 'Only the NVIDIA GeForce RTX 3060');
  assert.deepEqual(quick.rows[1].run.cards, ['CUDA0', 'Vulkan1']);
  // Full: straight after it, even for a mixture-of-experts model that spills (its rows fill Full otherwise).
  const full = sf.setupsFor(pc, m, now, 'full');
  assert.deepEqual(ids(full).slice(0, 3), ['a', 'cards-one', 'draft-second']);
  const d = full.rows[2];
  assert.equal(d.name, 'Guessing model Qwen3-0.6B-Q8_0 on the Quadro K1200');
  assert.deepEqual(d.run.cards, ['CUDA0', 'Vulkan1']);
  assert.deepEqual(d.run.draftCard, ['CUDA1', 'Vulkan0']);
  assert.equal(d.run.draft, Q06.id);
  assert.ok(!ids(quick).includes('draft-second'), 'Full only');
  // Held to one card already: every card again is the row, and row a says where it is held.
  const held = sf.setupsFor(pc, m, { ...now, run: { ...now.run, cards: ['CUDA0', 'Vulkan1'] } }, 'quick');
  assert.equal(held.rows[1].id, 'cards-all');
  assert.equal(held.rows[1].run.cards, undefined);
  assert.match(held.rows[0].name, /only on the NVIDIA GeForce RTX 3060/);
  // One card (or cards with no runner names known): no card rows, as before.
  assert.ok(!ids(sf.setupsFor({ ...pc, cards: [pc.cards[0]] }, m, now, 'full')).some(x => x.startsWith('cards-')));
  assert.ok(!ids(sf.setupsFor({ ...pc, cards: pc.cards.map(({ ids: _i, ...c }) => c) }, m, now, 'full')).some(x => x.startsWith('cards-')));
});

const ids = (r: { rows: sf.Setup[] }) => r.rows.map(x => x.id);

test('speed finder planned again once the model is loaded keeps the card rows (it used to see one card with no names)', () => {
  const Q30 = { id: 'Qwen3-30B-A3B-Q4_K_M.gguf', name: 'Qwen3-30B-A3B-Q4_K_M', bytes: 17 * GB };
  const Q06 = { id: 'Qwen3-0.6B-Q8_0.gguf', name: 'Qwen3-0.6B-Q8_0', bytes: 0.6 * GB };
  const cards = [{ name: 'NVIDIA GeForce RTX 3090', total: 24 * GB, free: 23 * GB, ids: ['CUDA0', 'Vulkan1'] }, { name: 'NVIDIA GeForce GTX 1060 6GB', total: 6 * GB, free: 6 * GB, ids: ['CUDA1', 'Vulkan0'] }];
  const pc: sf.PcFacts = { cards, cores: 8, threads: 0, models: [Q30, Q06] };
  const m: sf.ModelFacts = { ...Q30, moe: true, layers: 48, expertsPerLayer: 0.33 * GB, rest: 1.2 * GB, ctxBytes: 0.8 * GB, guesser: { ...Q06, ctxBytes: 0.1 * GB } };
  const now: sf.NowFacts = { run: { ctx: 8192, cache: 'f16', place: 'auto' }, spilled: false, cardBytes: 18 * GB };
  const first = ids(sf.setupsFor(pc, m, now, 'full'));
  // After loading, the biggest card's room is read again (5 GB left on it now).
  const replanned = sf.cardsNow(cards, { name: 'NVIDIA GeForce RTX 3090', total: 24 * GB, free: 5 * GB });
  assert.equal(replanned.length, 2);
  assert.equal(replanned[0].free, 5 * GB);
  assert.deepEqual(replanned[0].ids, ['CUDA0', 'Vulkan1']);
  const again = ids(sf.setupsFor({ ...pc, cards: replanned }, m, now, 'full'));
  for (const id of ['cards-one', 'draft-second']) assert.ok(first.includes(id) && again.includes(id), `${id}: ${again.join(', ')}`);
  assert.deepEqual(sf.cardsNow(cards, null), [], 'no card read now: the CPU only, as before');
});

// Audit C2/C3 (26 Oct): the names chips built into the processor have now. Each was read as a card before.
const BUILT_IN_NAMES = ['AMD Radeon(TM) Graphics', 'AMD Radeon(TM) 780M Graphics', 'AMD Radeon(TM) 890M Graphics', 'AMD Radeon 780M Graphics', 'AMD Radeon(TM) 8060S Graphics',
  'AMD Radeon 610M', 'AMD Radeon(TM) Vega 8 Graphics', 'Radeon Vega 11 Graphics', 'AMD Radeon(TM) R7 Graphics', 'Intel(R) Arc(TM) Graphics', 'Intel(R) Arc(TM) 140V GPU (16GB)', 'Intel(R) Arc(TM) 130T GPU',
  'Intel(R) UHD Graphics 630', 'Intel(R) HD Graphics 520', 'Intel(R) Iris(R) Xe Graphics', 'Qualcomm(R) Adreno(TM) X1-85 GPU', 'Microsoft Basic Render Driver'];
const CARD_NAMES = ['AMD Radeon RX 7900 XTX', 'AMD Radeon RX 6700 XT', 'AMD Radeon PRO W7900', 'AMD Radeon VII', 'AMD Radeon (TM) R9 390 Series', 'Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Arc(TM) B580 Graphics',
  'Intel(R) Arc(TM) Pro A60 Graphics', 'NVIDIA GeForce RTX 4060 Laptop GPU', 'NVIDIA GeForce GTX 1060 6GB', 'Quadro P2000'];

test('one rule names the chips built into the processor (AMD 780M/890M, Arc iGPUs, Vega, UHD/Iris, Adreno), never a card', () => {
  for (const n of BUILT_IN_NAMES) assert.equal(builtIn(n), true, n);
  for (const n of CARD_NAMES) assert.equal(builtIn(n), false, n);
});

// A Ryzen 7 7840HS laptop with an RTX 4060: Vulkan lists the built-in 780M first, with its big shared heap.
const LAPTOP_VK = `Available devices:
  Vulkan0: AMD Radeon 780M Graphics (16384 MiB, 15800 MiB free)
  Vulkan1: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 7600 MiB free)
`;
const LAPTOP_CUDA = '  CUDA0: NVIDIA GeForce RTX 4060 Laptop GPU (8187 MiB, 7700 MiB free)\n';

test('a laptop with a 780M and an RTX 4060: one card, the built-in chip never the "biggest card"', () => {
  const lists = [parseDevices(LAPTOP_CUDA), parseDevices(LAPTOP_VK)];
  assert.deepEqual(cardsOf(lists).map(c => [c.label, c.ids]), [['NVIDIA GeForce RTX 4060 Laptop GPU', ['CUDA0', 'Vulkan1']]]);
  assert.deepEqual(cardsOf([parseDevices('  Vulkan0: Intel(R) Arc(TM) 140V GPU (16GB) (16384 MiB, 15000 MiB free)\n')]), [], 'Core Ultra with Arc built in: no card');
  assert.equal(builtInListed(lists), true);
  assert.equal(builtInListed([parseDevices(CUDA)]), false);
});

test('Vulkan with a built-in chip beside a card: the start names the cards (-dev), so layers never spread onto the chip', () => {
  const lists = [parseDevices(LAPTOP_CUDA), parseDevices(LAPTOP_VK)];
  const cards = cardsOf(lists);
  const run = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const };
  const named = startCards(undefined, cards, builtInListed(lists));
  assert.deepEqual(idsFor('vulkan', named), ['Vulkan1']);
  const args = chatArgs('m.gguf', 9000, 'vulkan', 8, false, { ...run, cards: named }, true);
  assert.equal(args[args.indexOf('-dev') + 1], 'Vulkan1');
  // A model's own card choice stands; no built-in chip listed: llama.cpp picks, as before.
  assert.deepEqual(startCards(['CUDA0'], cards, true), ['CUDA0']);
  assert.equal(startCards(undefined, cardsOf([parseDevices(CUDA)]), false), undefined);
  assert.equal(startCards(undefined, [], true), undefined, 'only the built-in chip: nothing named (Auto runs on the CPU)');
});

test('four RTX 3090s: four cards, and a model held to all four names all four', () => {
  const four = (p: string, mib: number) => [0, 1, 2, 3].map(i => `  ${p}${i}: NVIDIA GeForce RTX 3090 (${mib} MiB, ${mib - 500} MiB free)`).join('\n');
  const cards = cardsOf([parseDevices(four('CUDA', 24575)), parseDevices(four('Vulkan', 24576))]);
  assert.equal(cards.length, 4);
  const held = cards.flatMap(c => c.ids);
  const args = chatArgs('m.gguf', 9000, 'cuda', 8, false, { ctx: 8192, cache: 'f16', place: 'auto', cards: held }, true);
  assert.equal(args[args.indexOf('-dev') + 1], 'CUDA0,CUDA1,CUDA2,CUDA3');
});

// Audit C8 (26 Oct): the finder's first card took the hardware list's biggest card's name and size with the runner
// list's biggest card's names. An NVIDIA 8 GB + AMD 16 GB desktop could get one card's name with the other's ids.
test('the speed finder\'s cards come from the runners\' own list, each with its own names; the room read now goes to the card it was read on', () => {
  const known = cardsOf([parseDevices('  CUDA0: NVIDIA GeForce RTX 4060 (8187 MiB, 7000 MiB free)'), parseDevices('  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 16000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4060 (8188 MiB, 7000 MiB free)')]);
  const runnersFor = (c: { ids: string[] }) => (c.ids.some(id => id.startsWith('CUDA')) ? ['cuda', 'vulkan'] : ['vulkan']) as ('cuda' | 'vulkan')[];
  // The bar reads the NVIDIA card (nvidia-smi): 2 GB used on it.
  const cards = sf.finderCards(known, { name: 'NVIDIA GeForce RTX 4060', total: 8 * GB, free: 6 * GB }, runnersFor);
  assert.deepEqual(cards.map(c => [c.name, c.ids, c.runners, Math.round(c.free / GB)]), [
    ['AMD Radeon RX 7800 XT', ['Vulkan0'], ['vulkan'], 16],
    ['NVIDIA GeForce RTX 4060', ['CUDA0', 'Vulkan1'], ['cuda', 'vulkan'], 6],
  ]);
  // The room read now names no card the runners list: it goes to the biggest, as before.
  assert.equal(Math.round(sf.finderCards(known, { name: 'Some card', total: 16 * GB, free: 3 * GB }, runnersFor)[0].free / GB), 3);
  // No runner list yet: the card read now, without names, as before; none read: the CPU only.
  assert.deepEqual(sf.finderCards([], { name: 'X', total: 8 * GB, free: 6 * GB }, runnersFor), [{ name: 'X', total: 8 * GB, free: 6 * GB }]);
  assert.deepEqual(sf.finderCards(known, null, runnersFor), []);
});

// Audit C6/C7 (26 Oct): the picture runner (sd-server) picked its own graphics chip, a built-in one included, and every
// picture model was put to wait in RAM (--offload-to-cpu) whenever the card's size was not known.
const SD_LIST = `load_backend: loaded Vulkan backend from C:\TOMLIN\runtime\sd-vulkan\ggml-vulkan.dll
load_backend: loaded CPU backend from C:\TOMLIN\runtime\sd-vulkan\ggml-cpu-haswell.dll
Vulkan0\tAMD Radeon 780M Graphics
Vulkan1\tNVIDIA GeForce RTX 4060 Laptop GPU
CPU\tAMD Ryzen 7 7840HS w/ Radeon 780M Graphics`;

test('the picture runner\'s own device list is read as it prints it (name, tab, description)', () => {
  assert.deepEqual(parseSdDevices(SD_LIST), [
    { name: 'Vulkan0', desc: 'AMD Radeon 780M Graphics' },
    { name: 'Vulkan1', desc: 'NVIDIA GeForce RTX 4060 Laptop GPU' },
    { name: 'CPU', desc: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics' },
  ]);
  assert.deepEqual(parseSdDevices('load_backend: loaded CPU backend from x\nCPU\tIntel(R) Core(TM) i7-6700K CPU @ 4.00GHz'), [{ name: 'CPU', desc: 'Intel(R) Core(TM) i7-6700K CPU @ 4.00GHz' }]);
});

test('pictures run on the biggest real card when the runner sees more than one graphics chip; with one, its own pick stands', () => {
  const gpus = [{ name: 'AMD Radeon(TM) 780M Graphics', total: null, integrated: true }, { name: 'NVIDIA GeForce RTX 4060 Laptop GPU', total: 8 * GB, integrated: false }];
  assert.equal(pickSdDevice(parseSdDevices(SD_LIST), gpus), 'Vulkan1', 'the card, not the built-in chip listed first');
  // Two cards: the biggest by the hardware list.
  const two = parseSdDevices('Vulkan0\tNVIDIA GeForce RTX 3060\nVulkan1\tAMD Radeon RX 7900 XTX\nCPU\tx');
  assert.equal(pickSdDevice(two, [{ name: 'NVIDIA GeForce RTX 3060', total: 12 * GB, integrated: false }, { name: 'AMD Radeon RX 7900 XTX', total: 24 * GB, integrated: false }]), 'Vulkan1');
  // One graphics device, or only built-in chips: nothing named.
  assert.equal(pickSdDevice(parseSdDevices('CUDA0\tNVIDIA GeForce GTX 1060 6GB\nCPU\tx'), []), null);
  assert.equal(pickSdDevice(parseSdDevices('Vulkan0\tAMD Radeon(TM) Graphics\nCPU\tx'), []), null);
  assert.equal(pickSdDevice([], []), null);
});

test('a picture model waits in RAM only when it is known to be bigger than the card; an unknown size is left to the runner\'s own fit', () => {
  assert.equal(pictureOffload(6 * GB, 24 * GB), false, 'a 6 GB model on a 24 GB card (it was offloaded when AMD cards read 4 GB)');
  assert.equal(pictureOffload(6 * GB, 6 * GB), true, 'over 85% of the card');
  assert.equal(pictureOffload(6 * GB, null), false, 'not known: sd-server --auto-fit places it by the free memory it reads');
});
