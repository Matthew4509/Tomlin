// Every card setup we can think of, run through the real decision code (no card needed): 22 NVIDIA cards from Maxwell
// to Blackwell, alone, in every pair and every three, with an AMD card or a chip in the processor beside them, on the
// drivers each one really runs. Checked: the CUDA build Auto starts, a model held to one card or one runner, the same
// card found again in the CUDA and Vulkan lists whatever order each runner lists them in, the speed finder's runner
// rows, and the cards' name. The pins are this version's own runtimes.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFits, ccFromName, codeFor, cudaOrder, pinWhy, type GpuFacts, type RunnerName, type RuntimePin } from '../src/runtimes.ts';
import { cardsOf, type RunnerDevice } from '../src/devices.ts';
import { cardsName } from '../src/hardware.ts';
import { setupsFor, type ModelFacts, type NowFacts, type PcFacts } from '../src/speedfinder.ts';

const GB = 2 ** 30;
const PINS = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'runtimes.json'), 'utf8')) as { runtimes: Record<string, RuntimePin> }).runtimes;
const CUDA_IDS = Object.keys(PINS).filter(id => PINS[id].engine === 'llama' && PINS[id].device === 'cuda');
const RUNNER_OF: Record<string, RunnerName> = { 'llama-cuda': 'cuda', 'llama-cuda13': 'cuda13' };

/** Real cards: the name nvidia-smi gives, the true compute level, memory. */
const CATALOG: { name: string; cc: number; gb: number }[] = [
  { name: 'NVIDIA GeForce GTX 750 Ti', cc: 50, gb: 2 },
  { name: 'NVIDIA GeForce GTX 980', cc: 52, gb: 4 },
  { name: 'Quadro M4000', cc: 52, gb: 8 },
  { name: 'Tesla P100-PCIE-16GB', cc: 60, gb: 16 },
  { name: 'NVIDIA GeForce GTX 1060 6GB', cc: 61, gb: 6 },
  { name: 'Quadro P2000', cc: 61, gb: 5 },
  { name: 'NVIDIA TITAN V', cc: 70, gb: 12 },
  { name: 'NVIDIA GeForce GTX 1660 SUPER', cc: 75, gb: 6 },
  { name: 'NVIDIA GeForce RTX 2060', cc: 75, gb: 6 },
  { name: 'Tesla T4', cc: 75, gb: 16 },
  { name: 'Quadro RTX 5000', cc: 75, gb: 16 },
  { name: 'NVIDIA A100-PCIE-40GB', cc: 80, gb: 40 },
  { name: 'NVIDIA GeForce RTX 3060', cc: 86, gb: 12 },
  { name: 'NVIDIA GeForce RTX 3090', cc: 86, gb: 24 },
  { name: 'NVIDIA RTX A4000', cc: 86, gb: 16 },
  { name: 'NVIDIA GeForce RTX 4060 Ti', cc: 89, gb: 16 },
  { name: 'NVIDIA GeForce RTX 4090', cc: 89, gb: 24 },
  { name: 'NVIDIA RTX 5000 Ada Generation', cc: 89, gb: 32 },
  { name: 'NVIDIA H100 PCIe', cc: 90, gb: 80 },
  { name: 'NVIDIA GeForce RTX 5080', cc: 120, gb: 16 },
  { name: 'NVIDIA GeForce RTX 5090', cc: 120, gb: 32 },
  { name: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition', cc: 120, gb: 96 },
];
type Card = (typeof CATALOG)[number];

/** Drivers people really run (null: it could not be read). */
const DRIVERS = ['470.14', '551.61', '560.94', '572.83', '582.78', '591.44', null] as const;
/** The drivers a card runs on: Maxwell, Pascal and Volta end with the 580 branch; Ada and Hopper start at 520, Blackwell at 570. */
const runsOn = (c: Card, d: string | null) => {
  if (d === null) return true;
  const v = Number(d);
  if (c.cc < 75 && v >= 590) return false;
  if (c.cc >= 120 && v < 570) return false;
  if (c.cc >= 89 && v < 520) return false;
  return true;
};
const gpu = (c: Card): GpuFacts => ({ name: c.name, vendor: 'nvidia', integrated: false, total: c.gb * GB, cc: c.cc });
const AMD: GpuFacts = { name: 'AMD Radeon RX 7800 XT', vendor: 'amd', integrated: false, total: 16 * GB, cc: null };
const IGPU: GpuFacts = { name: 'Intel(R) UHD Graphics 630', vendor: 'intel', integrated: true, total: 0, cc: null };

/** Every set of 1 to 3 cards (a card may appear twice: two of the same kind). */
function* cardSets(): Generator<Card[]> {
  for (let a = 0; a < CATALOG.length; a++) {
    yield [CATALOG[a]];
    for (let b = a; b < CATALOG.length; b++) {
      yield [CATALOG[a], CATALOG[b]];
      for (let c = b; c < CATALOG.length; c += 3) yield [CATALOG[a], CATALOG[b], CATALOG[c]];
    }
  }
}
/** Each card set on each driver all its cards run on. */
function* setups(): Generator<{ cards: Card[]; driver: string | null }> {
  for (const cards of cardSets()) for (const driver of DRIVERS) if (cards.every(c => runsOn(c, driver))) yield { cards, driver };
}
const covers = (id: string, cards: Card[]) => cards.every(c => codeFor(PINS[id], c.cc) !== 'none');
/** The driver a build needs for these cards, worked out here apart from the code under test. */
const needs = (id: string, cards: Card[]) => {
  const c = PINS[id].cuda!;
  return cards.every(k => codeFor(PINS[id], k.cc) === 'native') ? c.driver : c.jitDriver ?? c.driver;
};
const atLeast = (v: string, min: string) => {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};
const label = (s: { cards: Card[]; driver: string | null }) => `${s.cards.map(c => c.name.replace(/^NVIDIA (GeForce )?/, '')).join(' + ')} on driver ${s.driver ?? '(unread)'}`;

test('the card name alone gives a safe compute level: never above the true one, and the same generation', () => {
  for (const c of CATALOG) {
    const got = ccFromName(c.name);
    assert.ok(got !== null, `${c.name}: no level from its name`);
    assert.ok(got! <= c.cc && Math.floor(got! / 10) === Math.floor(c.cc / 10), `${c.name}: ${got} from the name, ${c.cc} in truth`);
  }
});

test('Auto, every card on every driver: the CUDA build it starts has code for every card, a driver new enough, and native code when one has it', () => {
  let checked = 0;
  const noCuda: string[] = [];
  for (const s of setups()) {
    for (const extra of [[], [AMD], [IGPU]] as GpuFacts[][]) {
      const gpus = [...s.cards.map(gpu), ...extra];
      const order = cudaOrder(PINS, 'llama', gpus, s.driver);
      checked++;
      if (s.driver && !atLeast(s.driver, '551.61')) {
        assert.deepEqual(order, [], `${label(s)}: too old a driver, no CUDA build`);
        continue;
      }
      const pick = order[0];
      const coverable = CUDA_IDS.filter(id => covers(id, s.cards) && (!s.driver || atLeast(s.driver, needs(id, s.cards))));
      if (!coverable.length) {
        noCuda.push(label(s));
        continue;
      }
      assert.ok(pick, `${label(s)}: no CUDA build picked, though ${coverable.join(', ')} would run`);
      assert.ok(covers(pick, s.cards), `${label(s)}: Auto picked ${pick}, which has no code for one of the cards`);
      if (s.driver) assert.ok(atLeast(s.driver, needs(pick, s.cards)), `${label(s)}: ${pick} needs driver ${needs(pick, s.cards)}`);
      const big = [...s.cards].sort((a, b) => b.gb - a.gb)[0];
      if (coverable.some(id => codeFor(PINS[id], big.cc) === 'native')) assert.equal(codeFor(PINS[pick], big.cc), 'native', `${label(s)}: ${pick} compiles at start, though a build has native code for the ${big.name}`);
    }
  }
  assert.ok(checked > 5000, `${checked} setups checked`);
  // With the two builds pinned now, every card from Maxwell on has a build on every driver it runs on.
  assert.deepEqual(noCuda, []);
});

test('known setups pick the build expected: Pascal 12.4, Blackwell 13.4, a Pascal + Blackwell PC 12.4 for both', () => {
  const pick = (names: string[], driver: string) => cudaOrder(PINS, 'llama', names.map(n => gpu(CATALOG.find(c => c.name.includes(n))!)), driver)[0];
  assert.equal(pick(['GTX 1060'], '582.78'), 'llama-cuda');
  assert.equal(pick(['RTX 5080'], '582.78'), 'llama-cuda13');
  assert.equal(pick(['RTX 3060'], '582.78'), 'llama-cuda', 'both native: the first pinned');
  assert.equal(pick(['GTX 1060', 'RTX 5080'], '582.78'), 'llama-cuda', 'only 12.4 has code for both');
  assert.equal(pick(['RTX 2060'], '582.78'), 'llama-cuda', '13.4 would compile at start and needs driver 615 for that');
  assert.match(pinWhy(PINS['llama-cuda13'], [gpu(CATALOG[4])], '582.78', 'This PC', Object.values(PINS)), /no code for it: it needs an RTX 20 or GTX 16 series \(Turing\) card or newer\. The CUDA 12\.4 runner works there instead/);
});

test('a model held to some cards: the build must have code for every card it is held to (not just for some card on the PC)', () => {
  const pascal = gpu(CATALOG.find(c => c.cc === 61)!);
  const blackwell = gpu(CATALOG.find(c => c.cc === 120)!);
  // The PC as a whole can use 13.4 (for the RTX 5080)...
  assert.equal(pinWhy(PINS['llama-cuda13'], [pascal, blackwell], '582.78'), '');
  // ...but a model held to the GTX 1060 cannot run on it.
  assert.equal(buildFits(PINS['llama-cuda13'], [pascal], '582.78'), false);
  assert.equal(buildFits(PINS['llama-cuda13'], [blackwell], '582.78'), true);
  assert.equal(buildFits(PINS['llama-cuda'], [pascal, blackwell], '582.78'), true);
  assert.equal(buildFits(PINS['llama-cuda13'], [pascal, blackwell], '582.78'), false, 'spread over both: one card has no code');
  // Every card alone, on every driver it runs on: the build Auto picks for that card alone fits it.
  for (const s of setups()) {
    if (s.driver && !atLeast(s.driver, '551.61')) continue;
    for (const c of s.cards) {
      const id = cudaOrder(PINS, 'llama', [gpu(c)], s.driver)[0];
      assert.ok(id && buildFits(PINS[id], [gpu(c)], s.driver), `${label(s)}: a model held to the ${c.name} gets ${id}`);
    }
  }
});

/** A runner's device list as llama-server --list-devices gives it, in the order given. */
const listOf = (prefix: 'CUDA' | 'Vulkan', cards: Card[], order: number[]): RunnerDevice[] =>
  order.map((k, i) => ({ id: `${prefix}${i}`, desc: cards[k].name, total: cards[k].gb * GB * (prefix === 'Vulkan' ? 0.97 : 1), free: cards[k].gb * GB }));
const perms = (n: number): number[][] => (n === 1 ? [[0]] : n === 2 ? [[0, 1], [1, 0]] : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]);

test('the same card is found in the CUDA and the Vulkan list, whatever order each runner lists them in: two of a kind stay two', () => {
  let checked = 0;
  for (const cards of cardSets()) {
    for (const cudaOrderOf of perms(cards.length)) {
      for (const vkOrder of perms(cards.length)) {
        const found = cardsOf([listOf('CUDA', cards, cudaOrderOf), listOf('Vulkan', cards, vkOrder)]);
        checked++;
        assert.equal(found.length, cards.length, `${cards.map(c => c.name).join(' + ')}: ${found.length} cards found`);
        for (const f of found) {
          assert.equal(f.ids.filter(id => id.startsWith('CUDA')).length, 1, `${f.label}: one CUDA id (${f.ids})`);
          assert.equal(f.ids.filter(id => id.startsWith('Vulkan')).length, 1, `${f.label}: one Vulkan id (${f.ids})`);
          // Both names point at a card of this kind and size.
          const cu = cudaOrderOf[Number(f.ids.find(id => id.startsWith('CUDA'))!.slice(4))];
          const vk = vkOrder[Number(f.ids.find(id => id.startsWith('Vulkan'))!.slice(6))];
          assert.equal(cards[cu].name, cards[vk].name);
          assert.equal(cards[cu].gb, cards[vk].gb);
        }
      }
    }
  }
  assert.ok(checked > 3000, `${checked} orders checked`);
});

test('two cards of one name but not one size (RTX 3060 8 GB and 12 GB) are two cards, each matched by size', () => {
  const a = { name: 'NVIDIA GeForce RTX 3060', cc: 86, gb: 12 };
  const b = { name: 'NVIDIA GeForce RTX 3060', cc: 86, gb: 8 };
  const found = cardsOf([listOf('CUDA', [a, b], [0, 1]), listOf('Vulkan', [a, b], [1, 0])]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(f => [Math.round(f.total / GB), f.ids.sort()]), [[12, ['CUDA0', 'Vulkan1']], [8, ['CUDA1', 'Vulkan0']]]);
});

test('an AMD card beside an NVIDIA card: one card each, the AMD one with a Vulkan name only; the chip in the processor left out', () => {
  const nv = CATALOG.find(c => c.name.includes('RTX 3060'))!;
  const lists = [
    [{ id: 'CUDA0', desc: nv.name, total: nv.gb * GB, free: 0 }],
    [{ id: 'Vulkan0', desc: AMD.name!, total: 16 * GB, free: 0 }, { id: 'Vulkan1', desc: nv.name, total: nv.gb * GB * 0.97, free: 0 }, { id: 'Vulkan2', desc: IGPU.name!, total: 2 * GB, free: 0 }],
  ];
  const found = cardsOf(lists, [IGPU.name!]);
  assert.deepEqual(found.map(f => [f.label, f.ids]), [[AMD.name, ['Vulkan0']], [nv.name, ['CUDA0', 'Vulkan1']]]);
});

/** The speed finder's facts for a PC with these cards and runners. */
function finderPc(cards: Card[], runners: RunnerName[]): PcFacts {
  const sorted = [...cards].sort((a, b) => b.gb - a.gb);
  return {
    cards: sorted.map((c, i) => ({ name: c.name, total: c.gb * GB, free: c.gb * GB, ids: [`CUDA${i}`, `Vulkan${i}`], runners: runners.filter(r => r === 'vulkan' || codeFor(PINS[r === 'cuda' ? 'llama-cuda' : 'llama-cuda13'], c.cc) !== 'none') })),
    cores: 8,
    threads: 0,
    models: [{ id: 'm', name: 'Qwen3.5-4B-Q4_K_M', bytes: 2.7 * GB }],
    runners,
  };
}
const MODEL: ModelFacts = { id: 'm', name: 'Qwen3.5-4B-Q4_K_M', bytes: 2.7 * GB, moe: false, layers: 32, expertsPerLayer: 0, rest: 2.7 * GB, ctxBytes: 0.5 * GB, guesser: null };
const NOW: NowFacts = { run: { ctx: 8192, cache: 'f16', place: 'auto' }, spilled: false, cardBytes: 3 * GB };

test('the speed finder never tries a CUDA build on a card it has no code for: it holds that row to the cards it can run, or leaves it out and says why', () => {
  let rowsChecked = 0;
  for (const cards of cardSets()) {
    if (!cards.every(c => runsOn(c, '582.78'))) continue;
    // The runners this PC can use, in Auto's order (cudaOrder decides which CUDA builds), then Vulkan.
    const usable = cudaOrder(PINS, 'llama', cards.map(gpu), '582.78').map(id => RUNNER_OF[id]).filter(Boolean);
    const runners = [...usable, 'vulkan'] as RunnerName[];
    const pc = finderPc(cards, runners);
    for (const size of ['quick', 'full'] as const) {
      const { rows, left } = setupsFor(pc, MODEL, NOW, size);
      for (const row of rows) {
        const r = row.run.runner;
        if (!r || r === 'vulkan') continue;
        rowsChecked++;
        const on = row.run.cards?.length ? pc.cards.filter(c => c.ids!.some(id => row.run.cards!.includes(id))) : pc.cards;
        for (const c of on) assert.ok(c.runners!.includes(r), `${cards.map(k => k.name).join(' + ')} (${size}): row "${row.name}" runs ${r} on the ${c.name}, which it has no code for`);
      }
      // A build with code for none of the cards: not a row, and said why.
      for (const r of runners.filter(x => x !== 'vulkan')) {
        if (pc.cards.every(c => !c.runners!.includes(r))) assert.ok(!rows.some(x => x.run.runner === r) && left.some(l => l.name.startsWith(r === 'cuda' ? 'CUDA 12' : 'CUDA 13')), `${r}: no code for any card here`);
      }
    }
  }
  assert.ok(rowsChecked > 100, `${rowsChecked} runner rows checked`);
});

test('a mixed PC (GTX 1060 + RTX 5080) is offered CUDA 13 on the RTX 5080 only', () => {
  const cards = [CATALOG.find(c => c.name.includes('GTX 1060'))!, CATALOG.find(c => c.name.includes('RTX 5080'))!];
  const pc = finderPc(cards, ['cuda', 'cuda13', 'vulkan']);
  const row = setupsFor(pc, MODEL, NOW, 'full').rows.find(r => r.run.runner === 'cuda13');
  assert.ok(row, 'a CUDA 13 row');
  assert.deepEqual(row!.run.cards, ['CUDA0', 'Vulkan0'], 'held to the RTX 5080 (the biggest, listed first)');
  assert.match(row!.name, /CUDA 13 runner .*only on the NVIDIA GeForce RTX 5080/);
});

test('a model saved to a runner this PC cannot use (CUDA 13 on a GTX 1060): the finder\'s "Now" row says it runs on Auto\'s, and tries Vulkan against that', () => {
  const pc = finderPc([CATALOG.find(c => c.name.includes('GTX 1060'))!], ['cuda', 'vulkan']);
  const { rows } = setupsFor(pc, MODEL, { ...NOW, run: { ...NOW.run, runner: 'cuda13' } }, 'quick');
  assert.match(rows[0].name, /^Now: Auto, cache f16 \(set to the CUDA 13 runner, which cannot run here: Auto's runner is used\)$/);
  assert.ok(rows.some(r => r.name === 'Vulkan runner (instead of CUDA 12)'), rows.map(r => r.name).join(' | '));
});

test('the cards\' name says what is there, for every set', () => {
  for (const cards of cardSets()) {
    const name = cardsName(cards);
    const kinds = new Set(cards.map(c => c.name));
    if (kinds.size === 1 && cards.length > 1) assert.equal(name, `${cards.length} × ${cards[0].name}`);
    else for (const k of kinds) assert.ok(name.includes(k), `${name} names ${k}`);
    assert.ok(!(kinds.size > 1 && /^\d+ × /.test(name) && name.split(' + ').length === 1), `${name}: different cards named as one kind`);
  }
});
