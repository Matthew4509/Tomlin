import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipOf, engineBusy } from '../src/hardware.ts';

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
