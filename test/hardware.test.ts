import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTER_GRACE, NVIDIA_SMI, SmiReader, cardsName, cardsTogether, chipOf, engineBusy, gpusFrom, oneAtATime, smiRows, totalFromName, unreadOf } from '../src/hardware.ts';

test('NVIDIA cards together are named as they are: two the same as "2 ×", different ones each by name', () => {
  assert.equal(cardsName([{ name: 'NVIDIA GeForce RTX 3060' }]), 'NVIDIA GeForce RTX 3060');
  assert.equal(cardsName([{ name: 'NVIDIA GeForce RTX 3060' }, { name: 'NVIDIA GeForce RTX 3060' }]), '2 × NVIDIA GeForce RTX 3060');
  // His RTX 3090 + GTX 1060 plan: never "2 × RTX 3090".
  assert.equal(cardsName([{ name: 'NVIDIA GeForce RTX 3090' }, { name: 'NVIDIA GeForce GTX 1060 6GB' }]), 'NVIDIA GeForce RTX 3090 + NVIDIA GeForce GTX 1060 6GB');
  assert.equal(cardsName([{ name: 'RTX 3060' }, { name: 'GTX 1060' }, { name: 'RTX 3060' }]), '2 × RTX 3060 + GTX 1060');
  assert.equal(cardsName([]), '');
});

const col = (pid: number, chip: string, eng: number, type: string) => `\\\\PC\\GPU Engine(pid_${pid}_luid_0x00000000_${chip}_phys_0_eng_${eng}_engtype_${type})\\Utilization Percentage`;

test('the chip key is the same in the memory and the engine counters', () => {
  assert.equal(chipOf('luid_0x00000000_0x0000BD43_phys_0'), 'luid_0x00000000_0x0000bd43');
  assert.equal(chipOf('pid_9_luid_0x00000000_0x0000BD43_phys_0_eng_0_engtype_3D'), 'luid_0x00000000_0x0000bd43');
  assert.equal(chipOf('_Total'), null);
});

test('a chip is as busy as its busiest kind of engine, added up over every program; the models\' part is counted apart', () => {
  const values = new Map([
    [col(100, '0x0000BD43', 0, '3D'), 55.4], // the model
    [col(200, '0x0000BD43', 0, '3D'), 10], // the browser
    [col(100, '0x0000BD43', 2, 'Copy'), 70], // the model copying
    [col(300, '0x0000BD43', 1, 'VideoDecode'), 5],
    [col(400, '0x0000AAAA', 0, 'Compute_0'), 30], // another chip
    ['\\\\PC\\GPU Engine(_Total)\\Utilization Percentage', 99],
  ]);
  const chips = engineBusy(values, [100]);
  assert.deepEqual(chips.get('luid_0x00000000_0x0000bd43'), { all: 70, models: 70 });
  assert.deepEqual(chips.get('luid_0x00000000_0x0000aaaa'), { all: 30, models: 0 });
  assert.equal(chips.size, 2);
});

test('the busy figure never goes past 100 and nothing watched means no models\' part', () => {
  const values = new Map([[col(1, '0x1', 0, '3D'), 80], [col(2, '0x1', 0, '3D'), 45.6]]);
  assert.deepEqual(engineBusy(values).get('luid_0x00000000_0x1'), { all: 100, models: 0 });
  assert.equal(engineBusy(new Map()).size, 0);
});

test('a chip Windows gives no readings for shows as disconnected, but only once the counters have had time to start', () => {
  assert.equal(unreadOf(0, COUNTER_GRACE - 1, false), undefined, 'still starting');
  assert.equal(unreadOf(0, COUNTER_GRACE, false), 'all');
  assert.equal(unreadOf(0, COUNTER_GRACE, true), 'busy', 'nvidia-smi still gives the memory');
  assert.equal(unreadOf(1, COUNTER_GRACE * 10, false), undefined, 'any chip reported: read');
});

test('a card whose Windows report stops at 4 GB takes its size from its name; nvidia-smi is looked for where drivers put it', () => {
  const GB = 2 ** 30;
  // Win32_VideoController's AdapterRAM is 32-bit: a 6 GB GTX 1060 reads 4 GB (or a little under).
  assert.equal(totalFromName('NVIDIA GeForce GTX 1060 6GB', 4 * GB), 6 * GB);
  assert.equal(totalFromName('NVIDIA GeForce GTX 1060 6GB', 4 * GB - 1), 6 * GB);
  assert.equal(totalFromName('NVIDIA Quadro P2000', 4 * GB), 4 * GB); // no size in the name: kept
  assert.equal(totalFromName('NVIDIA GeForce GTX 1050 2GB', 2 * GB), 2 * GB); // under the cap: the report is right
  assert.equal(totalFromName('NVIDIA GeForce RTX 3060 12 GB', 4 * GB), 12 * GB);
  assert.equal(totalFromName('NVIDIA GeForce GTX 1060 6GB', null), null);
  // On PATH first, then System32 (newer drivers), then the NVSMI folder older drivers use.
  assert.equal(NVIDIA_SMI[0], 'nvidia-smi');
  assert.ok(NVIDIA_SMI.some(p => p.toLowerCase().endsWith('system32/nvidia-smi.exe') || p.toLowerCase().endsWith('system32\\nvidia-smi.exe')));
  assert.ok(NVIDIA_SMI.some(p => p.toLowerCase().replaceAll('\\', '/').endsWith('nvidia corporation/nvsmi/nvidia-smi.exe')));
});

test('nvidia-smi\'s answer: each card\'s name and memory, and the driver version (the same on every card)', () => {
  const rows = smiRows('NVIDIA GeForce GTX 1060 6GB, 6144, 312, 581.57\r\nNVIDIA GeForce GTX 1070, 8192, 0, 581.57\r\n');
  assert.deepEqual(rows, [
    { name: 'NVIDIA GeForce GTX 1060 6GB', total: 6144 * 2 ** 20, used: 312 * 2 ** 20, driver: '581.57' },
    { name: 'NVIDIA GeForce GTX 1070', total: 8192 * 2 ** 20, used: 0, driver: '581.57' },
  ]);
  // A driver field that is not a version is left out, not guessed.
  assert.equal(smiRows('Quadro P2000, 5120, 10, [N/A]')[0].driver, null);
});

// Audit C1 (26 Oct): Windows' AdapterRAM is 32-bit, so every card over 4 GB read as 4 GB (or 0, when the size wraps).
// The registry's qwMemorySize for the same device holds the true size. Lines as readHardware's PowerShell prints them:
// GPU|name|AdapterRAM|qwMemorySize (empty when the registry could not be read).
const GiB = 2 ** 30;
const CAP = 4293918720; // what AdapterRAM says for any card of 4 GB or more

test('every make of card gets its true memory from the registry; AdapterRAM stands only when nothing better says', () => {
  const g = gpusFrom([
    'CPU|8',
    `GPU|AMD Radeon RX 7900 XTX|${CAP}|${24 * GiB}`,
    `GPU|Intel(R) Arc(TM) A770 Graphics|${CAP}|${16 * GiB}`,
    `GPU|AMD Radeon RX 7800 XT|0|${16 * GiB}`, // 16 GB mod 2^32 = 0
    `GPU|AMD Radeon RX 6700 XT|${CAP}|`, // the registry could not be read: as before
    'GPU|Microsoft Basic Display Adapter||',
  ].join('\r\n'), [], []);
  assert.deepEqual(g.map(x => [x.name, x.vendor, x.integrated, x.total]), [
    ['AMD Radeon RX 7900 XTX', 'amd', false, 24 * GiB],
    ['Intel(R) Arc(TM) A770 Graphics', 'intel', false, 16 * GiB],
    ['AMD Radeon RX 7800 XT', 'amd', false, 16 * GiB],
    ['AMD Radeon RX 6700 XT', 'amd', false, CAP],
  ]);
});

test('chips built into the processor are built in whatever their make (780M, Arc iGPU, Vega, UHD): no memory of their own', () => {
  const g = gpusFrom([
    'GPU|AMD Radeon(TM) Graphics|536870912|536870912',
    'GPU|AMD Radeon(TM) 780M Graphics|536870912|',
    'GPU|Intel(R) Arc(TM) Graphics|134217728|',
    'GPU|Intel(R) UHD Graphics 630|1073741824|',
  ].join('\n'), [], []);
  assert.ok(g.every(x => x.integrated && x.total === null), JSON.stringify(g));
});

test('an NVIDIA card: nvidia-smi first, then the registry, then the size in its name; a stale registry entry never counts', () => {
  const smi = smiRows('NVIDIA GeForce GTX 1060 6GB, 6144, 312, 582.78');
  const withSmi = gpusFrom(`GPU|NVIDIA GeForce GTX 1060 6GB|${CAP}|${6 * GiB}`, smi, [61]);
  assert.deepEqual(withSmi.map(x => [x.total, x.cc]), [[6144 * 2 ** 20, 61]]);
  // No nvidia-smi: the registry, as measured on this PC (6442450944).
  assert.deepEqual(gpusFrom(`GPU|NVIDIA GeForce GTX 1060 6GB|${CAP}|6442450944`, [], []).map(x => [x.total, x.cc]), [[6 * GiB, 61]]);
  // Neither: the size in the name, as before.
  assert.equal(gpusFrom(`GPU|NVIDIA GeForce GTX 1060 6GB|${CAP}|`, [], [])[0].total, 6 * GiB);
  // A registry figure smaller than AdapterRAM is not believed over it.
  assert.equal(gpusFrom(`GPU|AMD Radeon RX 580|${CAP}|${2 * GiB}`, [], [])[0].total, CAP);
  // nvidia-smi lists a card Windows does not: still a card.
  assert.deepEqual(gpusFrom('', smi, [61]).map(x => [x.name, x.total]), [['NVIDIA GeForce GTX 1060 6GB', 6144 * 2 ** 20]]);
});

test('"[N/A]" memory from nvidia-smi (a TCC or MIG card) is unknown, never NaN, and adding up leaves it out', () => {
  const rows = smiRows('NVIDIA A100-SXM4-40GB, [N/A], [N/A], 582.78\nNVIDIA GeForce RTX 3060, 12288, 100, 582.78');
  assert.equal(rows[0].total, null);
  assert.equal(rows[0].used, null);
  assert.deepEqual(cardsTogether(rows), { count: 1, total: 12288 * 2 ** 20, used: 100 * 2 ** 20 });
  assert.equal(cardsTogether(smiRows('Tesla K80, [N/A], [N/A], 474.82')), null);
  // The card keeps what Windows says rather than NaN.
  assert.equal(gpusFrom(`GPU|NVIDIA A100-SXM4-40GB|${CAP}|${40 * GiB}`, rows.slice(0, 1), [80])[0].total, 40 * GiB);
});

test('the once-a-second reading never runs twice at once: a slow nvidia-smi is not piled up', async () => {
  let running = 0;
  let most = 0;
  let calls = 0;
  let release!: () => void;
  const tick = oneAtATime(async () => {
    calls++;
    running++;
    most = Math.max(most, running);
    await new Promise<void>(r => (release = r));
    running--;
  });
  const first = tick();
  void tick();
  void tick();
  assert.equal(calls, 1, 'the second and third ticks are skipped while the first runs');
  release();
  await first;
  const next = tick();
  assert.equal(calls, 2, 'once it is done, the next tick runs');
  release();
  await next;
  assert.equal(most, 1);
});

// Audit C5 (26 Oct): one slow nvidia-smi at start (an Optimus laptop's card asleep, an antivirus holding it) meant no
// NVIDIA readings all session. It is asked again once a minute, and says when it answers after not answering.
test('nvidia-smi that did not answer is asked again once a minute, not every second, and its return is noticed', async () => {
  let clock = 0;
  let calls = 0;
  let answer = false;
  const smi = new SmiReader(async () => {
    calls++;
    if (!answer) throw new Error('timed out');
    return 'NVIDIA GeForce GTX 1060 6GB, 6144, 300, 582.78\n';
  }, () => clock, ['a', 'b']);
  assert.deepEqual(await smi.rows(), []);
  assert.equal(calls, 2, 'every place tried once');
  clock += 1000;
  assert.deepEqual(await smi.rows(), []);
  assert.equal(calls, 2, 'not asked again a second later');
  answer = true;
  clock += 60_000;
  const rows = await smi.rows();
  assert.equal(rows.length, 1, 'asked again after a minute');
  assert.equal(smi.at, 'a');
  assert.equal(smi.takeBack(), true, 'it answered after not answering: the cards are read again');
  assert.equal(smi.takeBack(), false, 'said once');
  // Once it has answered, it is asked every time.
  await smi.rows();
  assert.equal(calls, 4);
});

test('a PC with no NVIDIA tool at all is never noticed as "back"', async () => {
  const smi = new SmiReader(async () => 'NVIDIA GeForce RTX 3060, 12288, 0, 582.78', () => 0, ['a']);
  assert.equal((await smi.rows()).length, 1);
  assert.equal(smi.takeBack(), false, 'answered the first time: nothing to read again');
});

// Audit C11: a card Windows lists but nvidia-smi does not (Code 43, a card the driver gave up on) is not a chat card.
test('when nvidia-smi answers, an NVIDIA card it does not list is left out; when it cannot answer, every card stays', () => {
  const cim = `GPU|NVIDIA GeForce RTX 3060|${CAP}|${12 * GiB}\nGPU|NVIDIA GeForce GTX 1060 6GB|${CAP}|${6 * GiB}\nGPU|AMD Radeon RX 6600|${CAP}|${8 * GiB}`;
  const smi = smiRows('NVIDIA GeForce RTX 3060, 12288, 100, 582.78');
  assert.deepEqual(gpusFrom(cim, smi, [86]).map(g => g.name), ['NVIDIA GeForce RTX 3060', 'AMD Radeon RX 6600']);
  assert.deepEqual(gpusFrom(cim, [], []).map(g => g.name), ['NVIDIA GeForce RTX 3060', 'NVIDIA GeForce GTX 1060 6GB', 'AMD Radeon RX 6600']);
});

// 26 Oct: whether each NVIDIA card is in compute-only (TCC) mode, asked of nvidia-smi on its own (an old driver that
// does not know the question must not take the memory reading with it), in nvidia-smi's order.
test('the driver mode of each NVIDIA card is read apart, and a TCC card is marked with its place in nvidia-smi\'s list', async () => {
  const smi = new SmiReader(async (_exe, args) => {
    if (args[0].includes('driver_model')) return 'WDDM\nTCC\n';
    return 'NVIDIA GeForce GTX 1060 6GB, 6144, 300, 573.48\nTesla P100-PCIE-16GB, 16384, 0, 573.48\n';
  }, () => 0, ['a']);
  const rows = await smi.rows();
  const modes = await smi.modes();
  assert.deepEqual(modes, ['WDDM', 'TCC']);
  const gpus = gpusFrom(`GPU|NVIDIA GeForce GTX 1060 6GB|${CAP}|${6 * GiB}`, rows, [61, 60], modes);
  assert.deepEqual(gpus.map(g => [g.name, g.tcc ?? false, g.smiIndex]), [['NVIDIA GeForce GTX 1060 6GB', false, 0], ['Tesla P100-PCIE-16GB', true, 1]]);
  // A driver that cannot say: no mode, nothing marked.
  const old = new SmiReader(async (_exe, args) => {
    if (args[0].includes('driver_model')) throw new Error('Field "driver_model.current" is not a valid field');
    return 'Tesla P100-PCIE-16GB, 16384, 0, 474.82\n';
  }, () => 0, ['a']);
  await old.rows();
  assert.deepEqual(await old.modes(), []);
  assert.equal(gpusFrom('', await old.rows(), [], [])[0].tcc, undefined);
});
