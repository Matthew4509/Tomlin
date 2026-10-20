import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTER_GRACE, NVIDIA_SMI, chipOf, engineBusy, smiRows, totalFromName, unreadOf } from '../src/hardware.ts';

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
