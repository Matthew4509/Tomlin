import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadCount, rateOfLine } from '../src/diskwatch.ts';
import { DEFAULT_NET, DEFAULT_READ, LoadSpeeds, LoadTrack, MARGIN, START_SECONDS, estimateSeconds, learned, lentShare, planLoad, rawSeconds, type LoadPlan } from '../src/loadeta.ts';

const GiB = 2 ** 30;
const plan = (o: Partial<LoadPlan> = {}): LoadPlan => ({ bytes: 1e9, drive: 'D:', kind: 'ssd', read: 100e6, readFrom: 'measured', lentBytes: 0, lenders: [], net: DEFAULT_NET, netFrom: 'gigabit', mapped: false, card: true, ...o });

test('the estimate is the file over the read speed, plus the start, plus 2%', () => {
  const p = plan();
  assert.equal(rawSeconds(p), START_SECONDS + 10);
  assert.equal(MARGIN, 1.02);
  assert.equal(estimateSeconds(p), Math.ceil((START_SECONDS + 10) * 1.02));
  // A big one shows the 2% plainly: 1,000 s worked out is shown as 1,020 s.
  assert.equal(estimateSeconds(plan({ bytes: (1000 - START_SECONDS) * 100e6 })), 1020);
});

test('a hard disk is estimated slower than an SSD until it is measured', () => {
  const speeds = LoadSpeeds.empty();
  const hdd = planLoad({ bytes: 4 * GiB, drive: 'E:', kind: 'hdd', speeds, mapped: true, card: false });
  const ssd = planLoad({ bytes: 4 * GiB, drive: 'C:', kind: 'ssd', speeds, mapped: true, card: false });
  assert.equal(hdd.read, DEFAULT_READ.hdd);
  assert.equal(hdd.readFrom, 'drive kind');
  assert.ok(estimateSeconds(hdd) > 2.5 * estimateSeconds(ssd));
});

test('a measured drive speed beats the drive kind, and earlier timed loads count when nothing is kept', () => {
  const speeds = LoadSpeeds.empty();
  const fromEarlier = planLoad({ bytes: GiB, drive: 'D:', kind: 'hdd', speeds, earlier: { 'D:': 300e6 }, mapped: true, card: false });
  assert.equal(fromEarlier.read, 300e6);
  assert.equal(fromEarlier.readFrom, 'measured');
  speeds.keep(fromEarlier, { read: 200e6 });
  assert.equal(planLoad({ bytes: GiB, drive: 'D:', kind: 'hdd', speeds, earlier: { 'D:': 300e6 }, mapped: true, card: false }).read, 200e6);
});

test('DeepSeek-V4-Flash over three PCs on gigabit: the estimate lands near the 873 s it took', () => {
  // Run A (docs/cluster-native/deepseek3-2026-11-14.txt): 43 layers; 1 on this PC's card, 4 + 19 on the Z820, 7 on the
  // HP 800, the other 12 in this PC's RAM; read in (-lm none), from D:, which reads like a hard disk.
  const layers = 43;
  const share = lentShare(2, layers, { dev: ['Vulkan0', 'RPC0', 'RPC1', 'RPC3'], split: [1, 4, 19, 7] });
  assert.equal(share, 30 / 43);
  const p = planLoad({ bytes: 90.18 * GiB, drive: 'D:', kind: 'hdd', speeds: LoadSpeeds.empty(), lenders: ['Z820', 'HP 800'], lentShare: share, mapped: false, card: true });
  const est = estimateSeconds(p);
  assert.ok(Math.abs(est - 873) / 873 < 0.1, `estimate ${est} s against 873 s`);
});

test('a traced load on two PCs: 52 GB sent at 73 MB/s, then 31 GB read from D: at 130 MB/s, took 961 s', () => {
  const speeds = LoadSpeeds.empty();
  const p0 = planLoad({ bytes: 83e9, drive: 'D:', kind: 'hdd', speeds, earlier: { 'D:': 130e6 }, lenders: ['Z820'], lentShare: 52 / 83, mapped: false, card: true });
  speeds.keep(p0, { net: 73e6 });
  const p = planLoad({ bytes: 83e9, drive: 'D:', kind: 'hdd', speeds, earlier: { 'D:': 130e6 }, lenders: ['Z820'], lentShare: 52 / 83, mapped: false, card: true });
  assert.equal(p.net, 73e6);
  // One after the other: 712 s sending, 238 s reading this PC's part, plus the start; then 2% on top.
  assert.equal(rawSeconds(p), START_SECONDS + 52e9 / 73e6 + 31e9 / 130e6);
  const est = estimateSeconds(p);
  assert.ok(Math.abs(est - 961) / 961 < 0.05, `estimate ${est} s against 961 s`);
  // While it sends it says so; once the lenders' part is in, it reads this PC's own part.
  const track = new LoadTrack(p, 0);
  assert.match(track.view(100_000).doing, /sending to "Z820"/);
  assert.match(track.view(800_000).doing, /this PC's own part from D: \(hard disk\)/);
  track.text('.'.repeat(30), 10_000);
  track.text('.'.repeat(10), 300_000);
  const v = track.view(300_000);
  assert.match(v.doing, /sending/);
  // 40% in 290 s; the rest of the lenders' part at that speed, then this PC's part at the drive's speed.
  const rate = (0.4 * 83e9) / 290;
  assert.equal(v.leftSeconds, Math.round((((52 / 83 - 0.4) * 83e9) / rate + 31e9 / 130e6 + START_SECONDS / 2) * MARGIN));
  track.text('.'.repeat(30), 700_000);
  assert.match(track.view(700_000).doing, /own part/);
});

test('lenders share evenly when there is no layer split', () => {
  assert.equal(lentShare(0, 40), 0);
  assert.equal(lentShare(2, 40), 2 / 3);
  const p = planLoad({ bytes: 3e9, drive: 'D:', kind: 'ssd', speeds: LoadSpeeds.empty(), lenders: ['A', 'B'], mapped: false, card: true });
  assert.equal(p.lentBytes, 2e9);
  assert.equal(rawSeconds(p), START_SECONDS + 1e9 / DEFAULT_READ.ssd + 2e9 / DEFAULT_NET);
});

test('the runner\'s dots are counted, and its own speed corrects the time left', () => {
  const t0 = 1_000_000;
  const p = plan({ bytes: 10e9, read: 100e6 }); // 104 s worked out, 107 s shown
  const track = new LoadTrack(p, t0);
  const at0 = track.view(t0);
  assert.equal(at0.firstSeconds, estimateSeconds(p));
  assert.equal(at0.leftSeconds, at0.firstSeconds);
  assert.equal(at0.basis, 'time');
  assert.match(at0.doing, /Reading from D: \(SSD\) and placing it on the graphics card/);
  // Header lines, then dots that come in pieces (a line of them is not ended until the last one).
  track.text('llama_model_load: loaded meta data\nload_tensors: CUDA0 model buffer size = 9000 MiB\n', t0 + 2000);
  track.text('.....', t0 + 2000);
  for (let i = 1; i <= 5; i++) track.text('.....', t0 + 2000 + i * 1000);
  // 30 dots in 5 s: 3 GB in 5 s, twice the speed planned. The time left follows it (plus the 2%).
  const v = track.view(t0 + 7000);
  assert.equal(v.basis, 'runner');
  assert.equal(v.done, 0.3);
  assert.equal(v.rate, 600e6);
  const expectLeft = ((0.7 * 10e9) / 600e6 + START_SECONDS / 2) * MARGIN;
  assert.equal(v.leftSeconds, Math.round(expectLeft));
  assert.ok(v.totalSeconds < v.firstSeconds);
  // A speed is kept only once half of it is counted.
  assert.equal(track.measuredRate(), null);
  for (let i = 6; i <= 9; i++) track.text('.....', t0 + 2000 + i * 1000);
  assert.equal(track.measuredRate(), (0.5 * 10e9) / 9);
});

test('dots of a mapped load on the CPU are not taken for the disk; the memory it holds is', () => {
  const t0 = 0;
  const track = new LoadTrack(plan({ mapped: true, card: false }), t0);
  track.text('....................................................................................................\n', 1000);
  const v = track.view(5000, 0.5e9);
  assert.equal(v.basis, 'memory');
  assert.equal(v.done, 0.5);
  assert.equal(track.measuredRate(), null);
});

test('past the estimate with nothing to go by, it says it is late; the bar never goes back', () => {
  const track = new LoadTrack(plan(), 0);
  const late = track.view(60_000);
  assert.equal(late.leftSeconds, 0);
  assert.equal(late.late, true);
  assert.ok(late.done > 0.9);
  // Memory then reads lower than the time did: the bar stays where it was.
  assert.ok(track.view(61_000, 0.1e9).done >= late.done);
});

test('a second start counts its dots again', () => {
  const track = new LoadTrack(plan(), 0);
  track.text('..........\n', 1000);
  track.restart();
  track.text('.....', 2000);
  assert.equal(track.view(2000).basis, 'runner');
  track.text('.....', 6000);
  assert.equal(track.measuredRate(), null); // fewer than 20 dots: too few to keep
});

test('a finished load teaches the drive speed, or the link speed when PCs lent', () => {
  const alone = plan({ bytes: 4e9 });
  assert.deepEqual(learned(alone, START_SECONDS + 20, null), { read: 200e6 });
  assert.deepEqual(learned(alone, START_SECONDS + 20, 250e6), { read: 250e6 });
  assert.deepEqual(learned(alone, 3, null), {});
  // From Windows' memory at 40 GB/s: not kept.
  assert.deepEqual(learned(plan({ bytes: 40e9 }), START_SECONDS + 1.1, null), {});
  const lent = plan({ bytes: 10e9, read: 500e6, lentBytes: 6e9, lenders: ['Z820'] });
  // 60 s sending 6 GB, then 8 s reading this PC's 4 GB: 100 MB/s.
  assert.deepEqual(learned(lent, START_SECONDS + 68, null), { net: 100e6 });
});

test('speeds are kept in the data folder, blended, and the slowest link counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-loadeta-'));
  try {
    const a = await LoadSpeeds.load(dir);
    const p = plan({ lenders: ['Z820', 'HP 800'], lentBytes: 1 });
    a.keep(p, { read: 300e6 });
    a.keep(p, { read: 100e6 });
    a.keep(plan({ lenders: ['Z820'] }), { net: 80e6 });
    a.keep(plan({ lenders: ['HP 800'] }), { net: 110e6 });
    await a.saved();
    const b = await LoadSpeeds.load(dir);
    assert.equal(b.read('D:'), 200e6);
    assert.equal(b.net(['Z820', 'HP 800']), 80e6);
    assert.equal(b.net(['Nobody']), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the chat page shows the loading screen: its script is on the page, says the estimate, and has no text under 12px', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<script src="loading.js"></script>') > html.indexOf('<script src="app.js"></script>'));
  const js = await readFile(new URL('../public/loading.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(js), 'the script parses');
  assert.match(js, /Estimated time to load/);
  assert.match(js, /app\.onStatus\.push/);
  assert.doesNotMatch(js, /createElement\('style'\)/, 'the page allows no styles from scripts');
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.load-screen {'));
  assert.ok(block.length > 100, 'its look is in style.css');
  // The page's own text sizes (13px or more), never a size of its own.
  for (const m of block.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1], /var\(--fs-(xs|sm|md|lg|xl)\)/);
});

test('typeperf lines become bytes a second, added up into bytes read', () => {
  assert.equal(rateOfLine('"(PDH-CSV 4.0)","\\\\PC\\LogicalDisk(D:)\\Disk Read Bytes/sec"'), null);
  assert.equal(rateOfLine('"11/14/2026 21:59:37.188","125000000.000000"'), 125e6);
  assert.equal(rateOfLine('Exiting, please wait...'), null);
  const c = new ReadCount();
  c.add(100e6, 1000);
  c.add(100e6, 2000);
  c.add(50e6, 4000);
  assert.equal(c.bytes, 100e6 + 100e6 + 100e6);
});

test('the bytes read from the drive move the bar and correct the time left (llama-server prints no dots)', () => {
  const t0 = 0;
  const p = plan({ bytes: 4.5e9, read: 120e6, kind: 'hdd', mapped: true, card: true });
  const track = new LoadTrack(p, t0);
  // Nothing from the drive for the first 2 s (the runner starting), then 150 MB/s.
  for (let s = 3; s <= 12; s++) track.disk((s - 2) * 150e6, t0 + s * 1000);
  const v = track.view(t0 + 12_000);
  assert.equal(v.basis, 'disk');
  assert.equal(v.done, 1.5e9 / 4.5e9);
  assert.equal(v.rate, 150e6);
  assert.equal(v.leftSeconds, Math.round((3e9 / 150e6 + START_SECONDS / 2) * MARGIN));
  // The drive goes quiet (the rest is in Windows' memory): the first estimate and the clock count again.
  const quiet = track.view(t0 + 20_000);
  assert.equal(quiet.basis, 'time');
  assert.equal(quiet.leftSeconds, Math.max(0, estimateSeconds(p) - 20));
  assert.ok(quiet.done >= v.done);
  for (let s = 13; s <= 30; s++) track.disk((s - 2) * 150e6, t0 + s * 1000);
  assert.equal(Math.round(track.measuredRate()!), 150e6);
});

test('on a card, the memory Windows reports late is not taken for progress', () => {
  const track = new LoadTrack(plan({ bytes: 4.5e9, mapped: true, card: true }), 0);
  const v = track.view(31_000, 0.2e9);
  assert.equal(v.basis, 'time');
  assert.ok(v.leftSeconds < 60);
});

test("a model mostly in Windows' memory: 1 GB of 12 from the drive, then a trickle, is not put at many minutes more", () => {
  const p = plan({ bytes: 12.1e9, read: 152e6, kind: 'hdd', mapped: true, card: true });
  const track = new LoadTrack(p, 0);
  for (let s = 3; s <= 9; s++) track.disk((s - 2) * 140e6, s * 1000);
  for (let s = 10; s <= 87; s++) track.disk(980e6 + (s - 9) * 2e6, s * 1000);
  const v = track.view(87_000);
  assert.equal(v.basis, 'time');
  assert.ok(v.leftSeconds <= estimateSeconds(p), `left ${v.leftSeconds} s`);
  // Too little of it came from the drive to keep as the drive's speed.
  assert.equal(track.measuredRate(), null);
});

test('a load mostly from Windows\u2019 memory keeps no drive speed', () => {
  const p = plan({ bytes: 12.1e9 });
  assert.deepEqual(learned(p, 18.5, null, 1e9), {});
  assert.deepEqual(learned(p, START_SECONDS + 60, null, 11e9), { read: 12.1e9 / 60 });
  // Not counted (not Windows): the time alone, as before.
  assert.deepEqual(learned(p, START_SECONDS + 60, null, null), { read: 12.1e9 / 60 });
});

test('a start that is begun again keeps what it measured of the drive, to be kept for the next estimate', () => {
  const t0 = 1_000_000;
  const track = new LoadTrack(plan({ bytes: 10e9, card: true, mapped: false }), t0);
  assert.equal(track.lesson, null);
  for (let i = 1; i <= 10; i++) track.text('.....', t0 + i * 1000);
  track.restart();
  assert.equal(track.lesson, (0.5 * 10e9) / 9);
  // A second start that measured nothing does not lose it.
  track.restart();
  assert.equal(track.lesson, (0.5 * 10e9) / 9);
});
