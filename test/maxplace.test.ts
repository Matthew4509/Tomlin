// Max mode "all" with a mixture-of-experts model (src/maxplace.ts): the RAM policy (spread so each PC keeps 4 GB free, go
// down to 2 GB if it must, refuse below that), reading the device list, dealing the layers out by the room each PC has
// now, and the arguments llama-server gets for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chatArgs } from '../src/llama.ts';
import { LEND_AIM_KEEP, LEND_REFUSE_KEEP, lendRamCap, parseListed, placement, planExperts, type Lender, type Listed, type ModelBytes } from '../src/maxplace.ts';

const GB = 2 ** 30;
const MIB = 2 ** 20;
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const dev = (name: string, what: string, totalGb: number, freeGb: number): Listed => ({ name, what, total: totalGb * GB, free: freeGb * GB });

// llama-server --rpc 127.0.0.1:50871 --list-devices, as printed on 12 Nov 2026 (b11284).
const SAMPLE = `ggml_cuda_init: found 1 CUDA devices
Available devices:
  CUDA0: Quadro P2000 (5119 MiB, 4201 MiB free)
  RPC0: 127.0.0.1:50871 (5119 MiB, 4201 MiB free)
  RPC1: 127.0.0.1:50871 (49072 MiB, 36099 MiB free)
  CPU: Intel(R) Core(TM) i7-6700K CPU @ 4.00GHz (49072 MiB, 36218 MiB free)
`;

test('the device list is read: the host card, each lender card and RAM in order', () => {
  const l = parseListed(SAMPLE);
  assert.deepEqual(l.map(x => x.name), ['CUDA0', 'RPC0', 'RPC1', 'CPU']);
  assert.equal(l[1].what, '127.0.0.1:50871');
  assert.equal(l[2].total, 49072 * MIB);
  assert.equal(l[2].free, 36099 * MIB);
  assert.deepEqual(parseListed(''), []);
});

test('the cap: a PC keeps 4 GB free and 0.5 GB goes to the runner; the floor is 2 GB', () => {
  assert.equal(LEND_AIM_KEEP, 4 * GB);
  assert.equal(LEND_REFUSE_KEEP, 2 * GB);
  assert.equal(lendRamCap(56 * GB), 51.5 * GB);
  assert.equal(lendRamCap(17 * GB), 12.5 * GB);
  assert.equal(lendRamCap(3 * GB), 0);
  assert.equal(lendRamCap(0), 0);
  assert.equal(lendRamCap(56 * GB, LEND_REFUSE_KEEP), 53.5 * GB);
});

// Qwen3-Next-80B Q3 in round numbers: 48 layers, 30 GB of experts, 3 GB of the rest, a little cache.
const BIG: ModelBytes = { layers: 48, expertLayer: 0.625 * GB, rest: 3 * GB, kv: 0.4 * GB };
const z820: Lender = { name: 'Z820', endpoint: '127.0.0.1:5001', hasCard: true };
const hp: Lender = { name: 'HP 800', endpoint: '127.0.0.1:5002', hasCard: true };
const host = (free = 30) => ({ free: free * GB });
// What each lender's RAM has free now (the live list), by lender name.
const listed = (free: Record<string, number>, ...ls: Lender[]): Listed[] => {
  const out: Listed[] = [dev('CUDA0', 'Quadro P2000', 5, 4.2)];
  let i = 0;
  for (const l of ls) {
    const big = l === z820;
    out.push(dev(`RPC${i++}`, l.endpoint, big ? 12 : 4, big ? 11.2 : 3.6), dev(`RPC${i++}`, l.endpoint, big ? 64 : 24, free[l.name]));
  }
  out.push(dev('CPU', 'Intel', 48, 30));
  return out;
};
const FREE = { Z820: 56, 'HP 800': 17 };
const plan = (m: ModelBytes, free: Record<string, number>, h = host(), ls: Lender[] = [z820, hp]) => planExperts(m, listed(free, ...ls), ls, h);
type Made = Exclude<ReturnType<typeof plan>, { why: string }>;
const made = (p: ReturnType<typeof plan>): Made => {
  assert.ok(!('why' in p), JSON.stringify(p));
  return p as Made;
};

test('a model one lender can hold stays on that lender: attention on its card, every expert in its RAM', () => {
  const p = made(plan(BIG, FREE));
  assert.deepEqual(p.rpc, ['127.0.0.1:5001']);
  assert.deepEqual(p.dev, ['RPC0', 'RPC1']);
  // The output counts as one more layer, so 49 in all; the RAM device takes none.
  assert.deepEqual(p.split, [49, 0]);
  assert.equal(p.override.length, 1);
  assert.equal(p.override[0], `blk\\.(${Array.from({ length: 48 }, (_, i) => i).join('|')})\\.ffn_.*_exps\\.=RPC1[127.0.0.1:5001]`);
  // 30 GB on a PC with 56 GB free leaves it with more than 4 GB free.
  assert.ok(56 * GB - 30 * GB > LEND_AIM_KEEP);
});

test('a bigger model is spread over the lenders by the room each has, each lender gets its layers together, devices numbered over the lenders in use', () => {
  const m: ModelBytes = { ...BIG, expertLayer: 1.2 * GB };
  const p = made(plan(m, FREE));
  assert.deepEqual(p.rpc, ['127.0.0.1:5001', '127.0.0.1:5002']);
  assert.deepEqual(p.dev, ['RPC0', 'RPC1', 'RPC2', 'RPC3']);
  assert.equal(p.split.reduce((a, b) => a + b, 0), 49);
  assert.deepEqual([p.split[1], p.split[3]], [0, 0]);
  // 51.5 GB against 12.5 GB of room: the Z820 holds about four layers in five.
  assert.ok(p.split[0] > p.split[2] * 3 && p.split[2] > 0);
  assert.equal(p.override.length, 2);
  assert.match(p.override[0], /=RPC1\[127\.0\.0\.1:5001\]$/);
  // Device RPC3 for -dev, but buffer type RPC1[its address] for -ot: llama.cpp numbers buffer types within each server
  // (22 Nov 2026: "RPC3[...]" stopped the runner at once with "unknown buffer type").
  assert.match(p.override[1], /=RPC1\[127\.0\.0\.1:5002\]$/);
  // The layers a rule names are the ones llama.cpp gives that lender's card: the first n, then the next m.
  const first = p.split[0];
  assert.ok(p.override[0].startsWith('blk\\.(0|1|'));
  assert.ok(p.override[1].startsWith(`blk\\.(${first}|${first + 1}|`));
  // Each keeps at least 4 GB free.
  assert.ok(56 * GB - p.split[0] * m.expertLayer >= LEND_AIM_KEEP && 17 * GB - p.split[2] * m.expertLayer >= LEND_AIM_KEEP);
});

test('a PC that is short of RAM now gets fewer experts and one with room gets more (the free RAM is read at every load)', () => {
  const m: ModelBytes = { ...BIG, expertLayer: 1.2 * GB };
  const roomy = made(plan(m, { Z820: 56, 'HP 800': 17 }));
  const short = made(plan(m, { Z820: 56, 'HP 800': 7 }));
  const full = made(plan(m, { Z820: 56, 'HP 800': 22 }));
  assert.ok(short.split[2] < roomy.split[2], `${short.split} ${roomy.split}`);
  assert.ok(full.split[2] > roomy.split[2], `${full.split} ${roomy.split}`);
  for (const p of [roomy, short, full]) assert.equal(p.split.reduce((a, b) => a + b, 0), 49);
  // A lender with little free is named in plain words.
  assert.deepEqual(short.notes, ['"HP 800" has only 7.0 GB free: it holds less this time.']);
  assert.deepEqual(roomy.notes, []);
});

test('when the lenders cannot hold it all this PC takes the rest, its experts in its own RAM, still keeping 4 GB free', () => {
  const m: ModelBytes = { ...BIG, expertLayer: 1.5 * GB };
  const p = made(plan(m, FREE, host(30)));
  assert.equal(p.dev[p.dev.length - 1], 'CUDA0');
  assert.match(p.override[p.override.length - 1], /=CPU$/);
  assert.equal(p.split.reduce((a, b) => a + b, 0), 49);
  assert.ok(!p.notes.some(n => /tight/.test(n)));
});

test('memory tight: it goes down to 2 GB free on a PC and says so; short of that the load is refused before it starts, naming the PC', () => {
  const tight = made(plan({ ...BIG, expertLayer: 1.4 * GB }, FREE, host(6)));
  assert.equal(tight.split.reduce((a, b) => a + b, 0), 49);
  assert.ok(tight.notes.some(n => /Memory is tight/.test(n)));
  // Spread by the room each has, the Z820 and the HP 800 keep a little and this PC, with the least, is left with under 2 GB.
  const no = plan({ ...BIG, expertLayer: 1.6 * GB }, FREE, host(6));
  assert.ok('why' in no && no.refuse === true, JSON.stringify(no));
  if ('why' in no) assert.match(no.why, /^this PC would be left with \d+\.\d GB free; this model needs \d+\.\d GB more room across your PCs than is free now/);
  // The same model with more room on this PC is placed (the other two are as they were).
  made(plan({ ...BIG, expertLayer: 1.6 * GB }, FREE, host(30)));
  // Nothing placeable is not a refusal: the layer split stays.
  const dense = planExperts({ ...BIG, expertLayer: 0 }, listed(FREE, z820), [z820], host());
  assert.ok('why' in dense && dense.refuse !== true);
});

test('a lender that lends its card only is left out; one with no card keeps whole layers', () => {
  const cardOnly: Listed[] = [dev('CUDA0', 'x', 5, 4), dev('RPC0', z820.endpoint, 12, 11)];
  const none = planExperts({ ...BIG, expertLayer: 4 * GB }, cardOnly, [z820], host(6));
  assert.ok('why' in none && /lends its card only/.test(none.why), JSON.stringify(none));
  const cpuBox: Lender = { name: 'Box', endpoint: '127.0.0.1:5003', hasCard: false };
  const b = made(planExperts(BIG, [dev('CUDA0', 'x', 5, 4), dev('RPC0', cpuBox.endpoint, 64, 56)], [cpuBox], host()));
  assert.deepEqual(b.dev, ['RPC0']);
  assert.deepEqual(b.split, [49]);
  assert.deepEqual(b.override, []);
});

test('this PC card is the one it is set to use, not a built-in chip listed first', () => {
  const l = [dev('Vulkan0', 'Intel UHD', 8, 7), dev('Vulkan1', 'RTX', 12, 11), ...listed(FREE, z820).slice(1)];
  const m: ModelBytes = { ...BIG, expertLayer: 1.5 * GB };
  const p = made(planExperts(m, l, [z820], { free: 30 * GB, cards: ['Vulkan1'] }));
  assert.ok(p.dev.includes('Vulkan1') && !p.dev.includes('Vulkan0'));
  assert.ok('why' in planExperts(m, l, [z820], { free: 30 * GB, cards: ['Vulkan7'] }));
});

test('the placement reads the devices once and keeps the layer split when it cannot', async () => {
  const deps = (out: string, model: ModelBytes | null) => ({ list: async () => out, model: async () => model, host: host() });
  const got = await placement('x.exe', [z820], deps(`Available devices:\n  CUDA0: P (5119 MiB, 4201 MiB free)\n  RPC0: ${z820.endpoint} (12288 MiB, 11000 MiB free)\n  RPC1: ${z820.endpoint} (65536 MiB, 57000 MiB free)\n`, BIG));
  assert.ok(!('why' in got), JSON.stringify(got));
  assert.ok('why' in await placement('x.exe', [z820], deps('', BIG)));
  assert.ok('why' in await placement('x.exe', [z820], deps(SAMPLE, null)));
});

const RUN = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const, moe: true };
const PLACED = { device: 'cuda' as const, dev: ['RPC0', 'RPC1'], split: [49, 0], override: ['blk\\.(0|1)\\.ffn_.*_exps\\.=RPC1[127.0.0.1:5001]'] };

test('llama-server gets the devices, the split and one override rule list; the layer count is explicit and the experts-in-RAM flag is not added', () => {
  const a = chatArgs('m.gguf', 8800, 'cuda', 4, false, { ...RUN, place: 'ram', rpc: ['127.0.0.1:5001'], maxPlace: PLACED }, true);
  const at = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(at('-ngl'), '999');
  assert.equal(at('--rpc'), '127.0.0.1:5001');
  assert.equal(at('-dev'), 'RPC0,RPC1');
  assert.equal(at('-ts'), '49,0');
  assert.equal(at('-lm'), 'none');
  // Without lenders the file stays mapped (llama.cpp's default).
  assert.ok(!chatArgs('m.gguf', 8800, 'cuda', 4, false, RUN, true).includes('-lm'));
  assert.equal(at('-ot'), PLACED.override[0]);
  assert.ok(!a.includes('--cpu-moe') && !a.includes('--n-cpu-moe'));
  // Another runner than the one it was worked out for, or no lenders: today's arguments.
  const other = chatArgs('m.gguf', 8800, 'vulkan', 4, false, { ...RUN, rpc: ['127.0.0.1:5001'], maxPlace: PLACED }, true);
  assert.ok(!other.includes('-ts') && !other.includes('-ot') && !other.includes('-ngl'));
  const none = chatArgs('m.gguf', 8800, 'cuda', 4, false, { ...RUN, maxPlace: PLACED }, true);
  assert.ok(!none.includes('-ts'));
  assert.deepEqual(chatArgs('m.gguf', 8800, 'cuda', 4, false, { ...RUN, rpc: ['127.0.0.1:5001'] }, true).filter(x => ['-ts', '-ot', '-dev', '-ngl'].includes(x)), []);
});

test('the load wires the placement in, refuses before anything starts, and falls back to the layer split; the cap is one function', () => {
  const panes = read('src/server/panes.ts');
  assert.match(panes, /maxPlaced\(\{ path, name,/);
  assert.match(panes, /if \(placed\?\.refuse\) return \{ error: placed\.refuse \}/);
  assert.match(panes, /started\.maxPlace \?/);
  assert.match(read('src/jobrun/maxhost.ts'), /lenderRamCap\(/);
  assert.match(read('src/jobrun/maxplaced.ts'), /TOMLIN_MAX_PLACE/);
});
