// The speed finder's plain parts (src/speedfinder.ts): which setups are tried for a model on a PC, which one is
// recommended, whether a speed trick wrote the same words, and how long a test takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sf from '../src/speedfinder.ts';

const GB = 2 ** 30;
const MB = 2 ** 20;
const Q08 = { id: 'Qwen3.5-0.8B-Q4_K_M.gguf', name: 'Qwen3.5-0.8B-Q4_K_M', bytes: 0.53 * GB };
const Q4B = { id: 'Qwen3.5-4B-Q4_K_M.gguf', name: 'Qwen3.5-4B-Q4_K_M', bytes: 2.7 * GB };
const A3B = { id: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', name: 'Qwen3.5-35B-A3B-Q4_K_M', bytes: 22 * GB };
const G12 = { id: 'gemma-3-12b-it-Q4_K_M.gguf', name: 'gemma-3-12b-it-Q4_K_M', bytes: 7.3 * GB };
const G1 = { id: 'gemma-3-1b-it-Q4_K_M.gguf', name: 'gemma-3-1b-it-Q4_K_M', bytes: 0.8 * GB };
const BASE = { ctx: 8192, cache: 'f16' as const, place: 'auto' as const };

const worker = (models = [Q08, Q4B, A3B, G12]): sf.PcFacts => ({ cards: [{ name: 'NVIDIA GeForce GTX 1060 6GB', total: 6 * GB, free: 1.7 * GB }], cores: 4, threads: 0, models });
const guesser = { ...Q08, ctxBytes: 0.1 * GB };
const ids = (r: { rows: sf.Setup[] }) => r.rows.map(x => x.id);

test('Worker PC, Qwen3.5 4B wholly on the card: a guessing model, flash attention, copy-ahead; nothing about placement or threads', () => {
  const m: sf.ModelFacts = { ...Q4B, moe: false, layers: 32, expertsPerLayer: 0, rest: Q4B.bytes, ctxBytes: 0.3 * GB, guesser };
  const now: sf.NowFacts = { run: BASE, spilled: false, cardBytes: 3.2 * GB };
  const quick = sf.setupsFor(worker(), m, now, 'quick');
  assert.deepEqual(ids(quick), ['a', 'draft-card', 'fa-on', 'ngram']);
  assert.deepEqual(quick.rows[0].run, BASE, 'row a is the setup saved now');
  assert.deepEqual(quick.rows[1].run, { ...BASE, draft: Q08.id });
  assert.deepEqual(ids(sf.setupsFor(worker(), m, now, 'full')), ['a', 'draft-card', 'fa-on', 'ngram', 'fa-off', 'draft-long']);
  // No 0.8B on that PC: said, not tried, never downloaded.
  const none = sf.setupsFor(worker([Q4B, A3B]), { ...m, guesser: null }, now, 'quick');
  assert.deepEqual(ids(none), ['a', 'fa-on', 'ngram']);
  assert.match(none.left.find(l => l.name === 'Guessing model')!.why, /needs a smaller qwen3\.5 model on this PC.*not tried/i);
  // A guesser that is not on that PC (or another family) is never used.
  assert.ok(!ids(sf.setupsFor(worker([Q4B, A3B]), m, now, 'full')).includes('draft-card'));
  assert.ok(!ids(sf.setupsFor(worker(), { ...m, guesser: { ...G1, ctxBytes: 0 } }, now, 'full')).includes('draft-card'));
});

test('Worker PC, Qwen3.5 35B-A3B with experts left in RAM: card margin, the expert sweep from the sizes, then the guessing model beside it', () => {
  const per = (22 - 1.5) * GB / 40;
  // The 0.8B's own cache at the A3B's 65,536 context is large (0.3 GB): the draft rows give it a q8_0 cache (0.16 GB).
  const big = { ...Q08, ctxBytes: 0.3 * GB };
  const m: sf.ModelFacts = { ...A3B, moe: true, layers: 40, expertsPerLayer: per, rest: 1.5 * GB, ctxBytes: 1.3 * GB, guesser: big };
  const now: sf.NowFacts = { run: { ...BASE, ctx: 65536 }, spilled: true, cardBytes: 3.8 * GB };
  // Card room: 1.7 free + 3.8 held - 0.5 margin - 1.5 the rest - 1.3 cache - 0.5 working = 1.7 GB, 3 layers of experts.
  assert.equal(sf.firstSweep(worker(), m, now), 37);
  // The guessing model's file, cache and 0.3 GB working memory push k layers back to RAM: (0.53 + 0.16 + 0.3) / 0.51 = 2.
  assert.equal(sf.draftLayers(m), 2);
  const quick = sf.setupsFor(worker(), m, now, 'quick');
  assert.deepEqual(ids(quick), ['a', 'margin-512', 'layers-37', 'draft-card']);
  assert.deepEqual(quick.rows[1].run, { ...now.run, fitMargin: 512 });
  assert.deepEqual(quick.rows[2].run, { ...now.run, place: 'layers', moeCpu: 37 });
  // The draft row follows the sweep: its N is the best sweep row's plus k, worked out when the sweep is done.
  assert.deepEqual(quick.rows[3].run, { ...now.run, place: 'layers', moeCpu: 39, draft: Q08.id, draftCache: 'q8_0' });
  assert.equal(quick.rows[3].follows, 'sweep');
  assert.equal(quick.rows[3].plus, 2);
  const full = sf.setupsFor(worker(), m, now, 'full');
  assert.deepEqual(ids(full), ['a', 'margin-512', 'layers-37', 'draft-card', 'margin-256', 'layers-35', 'draft-ram', 'threads-4']);
  assert.equal(full.rows.find(r => r.id === 'margin-256')!.tight, true);
  assert.deepEqual(full.rows.find(r => r.id === 'draft-ram')!.run, { ...now.run, place: 'layers', moeCpu: 37, draft: Q08.id, draftOn: 'ram', draftCache: 'q8_0' });
  assert.equal(full.rows.find(r => r.id === 'draft-ram')!.plus, 0);
  assert.ok(full.rows.filter(r => r.sweep !== undefined).length <= 3, 'never more than 3 sweep tries');
  // Without the 0.8B, Quick tries threads instead.
  assert.deepEqual(ids(sf.setupsFor(worker([A3B]), { ...m, guesser: null }, now, 'quick')), ['a', 'margin-512', 'layers-37', 'threads-4']);
  // Experts already all in RAM: no margin row (that is Auto's), the sweep and every-expert rows stay out where they change nothing.
  const ram = sf.setupsFor(worker(), m, { ...now, run: { ...now.run, place: 'ram' } }, 'full');
  assert.ok(!ids(ram).includes('margin-512') && !ids(ram).includes('experts-ram'));
});

test('a dense model that spills off the card: smaller cache, every layer on the card, threads; a CPU-only PC: threads and copy-ahead', () => {
  const m: sf.ModelFacts = { ...G12, moe: false, layers: 48, expertsPerLayer: 0, rest: G12.bytes, ctxBytes: 0.8 * GB, guesser: null };
  const now: sf.NowFacts = { run: BASE, spilled: true, cardBytes: 4.6 * GB };
  assert.deepEqual(ids(sf.setupsFor(worker(), m, now, 'quick')), ['a', 'card', 'q8', 'threads-4']);
  assert.deepEqual(ids(sf.setupsFor(worker(), m, now, 'full')), ['a', 'card', 'q8', 'threads-4', 'fa-on', 'fa-off', 'ngram', 'threads-3']);
  assert.deepEqual(sf.setupsFor(worker(), m, now, 'full').rows.find(r => r.id === 'q8')!.run, { ...BASE, cache: 'q8_0' });

  const laptop: sf.PcFacts = { cards: [], cores: 2, threads: 0, models: [Q08, Q4B] };
  const small: sf.ModelFacts = { ...Q4B, moe: false, layers: 32, expertsPerLayer: 0, rest: Q4B.bytes, ctxBytes: 0.3 * GB, guesser };
  const cpu = { run: BASE, spilled: false, cardBytes: 0 };
  assert.deepEqual(ids(sf.setupsFor(laptop, small, cpu, 'quick')), ['a', 'threads-2', 'threads-1', 'ngram']);
  assert.deepEqual(ids(sf.setupsFor(laptop, small, cpu, 'full')), ['a', 'threads-2', 'threads-1', 'ngram', 'draft-ram', 'draft-long']);
  // Threads already set to the cores: that row would change nothing.
  assert.ok(!ids(sf.setupsFor({ ...laptop, threads: 2 }, small, cpu, 'full')).includes('threads-2'));
});

test('Quick at most 4 rows and Full at most 8, row a first; never a smaller context or q4_0 unless asked; other contexts only when ticked', () => {
  const m: sf.ModelFacts = { ...A3B, moe: true, layers: 40, expertsPerLayer: 0.5 * GB, rest: 1.5 * GB, ctxBytes: 1.3 * GB, guesser };
  const now: sf.NowFacts = { run: { ...BASE, ctx: 65536 }, spilled: true, cardBytes: 3.8 * GB };
  for (const size of ['quick', 'full'] as const) {
    const r = sf.setupsFor(worker(), m, now, size);
    assert.ok(r.rows.length <= (size === 'quick' ? 4 : 8));
    assert.equal(r.rows[0].id, 'a');
    for (const row of r.rows) {
      assert.equal(row.run.ctx, 65536, row.id);
      assert.notEqual(row.run.cache, 'q4_0', row.id);
    }
  }
  // Context sizes the user ticked to test: added after the rest (the model's own size is not tried twice).
  const asked = sf.setupsFor(worker(), m, now, 'quick', [16384, 65536]);
  assert.deepEqual(ids(asked), ['a', 'margin-512', 'layers-37', 'draft-card', 'ctx-16384']);
  assert.deepEqual(asked.rows.at(-1)!.run, { ...now.run, ctx: 16384 });
  // The rows Quick leaves out are listed with why.
  assert.ok(sf.setupsFor(worker(), m, now, 'quick').left.some(l => /Full/.test(l.why)));
});

const row = (o: Partial<sf.Result>): sf.Result => ({ id: 'x', ok: true, write: 10, read: 40, cardFree: 1 * GB, spilled: false, ramFit: 'ok', sameWords: null, cache: 'f16', changes: 1, ...o });

test('recommended: the fastest row that passes every check, and only when more than 5% faster than what you have', () => {
  const a = row({ id: 'a', changes: 0 });
  // 12% faster: recommended.
  assert.equal(sf.recommend([a, row({ id: 'b', write: 11.2 })]).best, 'b');
  // 4% faster: within the noise, so keep what you have.
  const keep = sf.recommend([a, row({ id: 'b', write: 10.4 })]);
  assert.equal(keep.best, 'a');
  assert.equal(keep.keep, true);
  assert.match(sf.KEEP_TEXT, /Keep what you have: nothing tried was clearly faster/);
  // Within 5% of each other: the faster reader wins, then more card left free.
  assert.equal(sf.recommend([a, row({ id: 'b', write: 12, read: 30 }), row({ id: 'c', write: 11.8, read: 50 })]).best, 'c');
  assert.equal(sf.recommend([a, row({ id: 'b', write: 12, cardFree: 0.6 * GB }), row({ id: 'c', write: 12, cardFree: 1.2 * GB })]).best, 'c');
  // Never recommended, however fast, each with its reason on the row.
  const cases: Array<[Partial<sf.Result>, RegExp]> = [
    [{ ok: false }, /did not finish/],
    [{ cardFree: 0.2 * GB }, /leaves only 0\.2 GB of the card free/],
    [{ spilled: true }, /spilled/],
    [{ ramFit: 'tight' }, /RAM/],
    [{ sameWords: false }, /different words/],
    [{ read: 15 }, /reads at under half/],
    [{ cache: 'q4_0' }, /q4_0/],
  ];
  for (const [o, why] of cases) {
    const r = sf.recommend([a, row({ id: 'b', write: 20, ...o })]);
    assert.equal(r.best, 'a', JSON.stringify(o));
    assert.match(r.why.b, why);
  }
  // A CPU row has no card figure: the card rules do not apply.
  assert.equal(sf.recommend([row({ id: 'a', cardFree: null, changes: 0 }), row({ id: 'b', write: 12, cardFree: null })]).best, 'b');
});

test('same words: the first 100 words equal and 90% overall', () => {
  const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `w${i + from}`).join(' ');
  assert.equal(sf.sameWords(words(150), words(150)), true);
  // A difference after the first 100, under 10% of the whole: still the same answer.
  const late = words(150).split(' ');
  for (let i = 140; i < 150; i++) late[i] = 'x';
  assert.equal(sf.sameWords(words(150), late.join(' ')), true);
  // An early difference fails.
  const early = words(150).split(' ');
  early[5] = 'x';
  assert.equal(sf.sameWords(words(150), early.join(' ')), false);
  // Far apart later: fails.
  const far = words(300).split(' ');
  for (let i = 150; i < 300; i++) far[i] = 'x';
  assert.equal(sf.sameWords(words(300), far.join(' ')), false);
  // Short answers: all of the shorter one must match.
  assert.equal(sf.sameWords('a b c', 'a b c'), true);
  assert.equal(sf.sameWords('a b c', 'a b d'), false);
});

test('how long a test takes, from the PC\'s own load time and speeds', () => {
  // Qwen3.5 4B on the Worker PC: about 1 minute a row, Quick about 5, Full about 9-12.
  const fourB = { loadSeconds: 8, write: 17, read: 500, bytes: 2.7 * GB };
  const q = sf.estimateMinutes(4, fourB);
  const f = sf.estimateMinutes(8, fourB);
  assert.ok(q >= 4 && q <= 6, String(q));
  assert.ok(f >= 8 && f <= 12, String(f));
  // The 35B-A3B: slower to load, write and read: Quick over 10 minutes.
  assert.ok(sf.estimateMinutes(4, { loadSeconds: 45, write: 12.5, read: 20, bytes: 22 * GB }) >= 10);
  assert.ok(sf.estimateMinutes(4, { loadSeconds: 0, write: 0, read: 0, bytes: 5 * MB }) >= 1, 'no figures yet: still a sensible guess');
});

test('a PC with both card runners (CUDA and Vulkan): the other runner is tried, first in Quick; one runner or none: never', () => {
  const m: sf.ModelFacts = { ...Q4B, moe: false, layers: 32, expertsPerLayer: 0, rest: Q4B.bytes, ctxBytes: 0.3 * GB, guesser };
  const now: sf.NowFacts = { run: BASE, spilled: false, cardBytes: 3.2 * GB };
  const both = { ...worker(), runners: ['cuda', 'vulkan'] as ('cuda' | 'vulkan')[] };
  // Unset = Auto, which starts on CUDA when it is there: the try is Vulkan.
  const quick = sf.setupsFor(both, m, now, 'quick');
  assert.deepEqual(ids(quick), ['a', 'runner-vulkan', 'draft-card', 'fa-on']);
  assert.deepEqual(quick.rows[1].run, { ...BASE, runner: 'vulkan' });
  assert.match(quick.rows[1].name, /Vulkan runner/);
  // Saved on Vulkan: the try is CUDA.
  const onVulkan = sf.setupsFor(both, m, { ...now, run: { ...BASE, runner: 'vulkan' } }, 'quick');
  assert.equal(onVulkan.rows[1].id, 'runner-cuda');
  assert.deepEqual(onVulkan.rows[1].run, { ...BASE, runner: 'cuda' });
  // Only one runner installed, or no card: no runner row.
  assert.ok(!ids(sf.setupsFor({ ...worker(), runners: ['vulkan'] }, m, now, 'full')).some(x => x.startsWith('runner-')));
  assert.ok(!ids(sf.setupsFor({ ...worker(), cards: [], runners: ['cuda', 'vulkan'] }, m, now, 'full')).some(x => x.startsWith('runner-')));
  assert.match(sf.describeRun({ ...BASE, runner: 'vulkan' }), /Vulkan runner/);
});
