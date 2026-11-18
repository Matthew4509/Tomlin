import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeepAwake, holdScript, nodeBusy } from '../src/keepawake.ts';

function rig(grace = 60_000) {
  const log: string[] = [];
  const k = new KeepAwake(() => {
    log.push('hold');
    return { release: () => log.push('release') };
  }, grace);
  return { k, log };
}

test('a node asks Windows to stay awake once while it is in use, however often it is checked', () => {
  const { k, log } = rig();
  k.set(true, 0);
  k.set(true, 1000);
  k.set(true, 2000);
  assert.deepEqual(log, ['hold']);
  assert.equal(k.holding, true);
});

test('a short gap between two requests does not let go, a long idle does', () => {
  const { k, log } = rig(60_000);
  k.set(true, 0);
  k.set(false, 10_000);
  k.set(false, 50_000);
  assert.deepEqual(log, ['hold']);
  k.set(true, 55_000);
  k.set(false, 60_000);
  k.set(false, 100_000);
  assert.deepEqual(log, ['hold'], 'the grace starts again after the last use');
  k.set(false, 121_000);
  assert.deepEqual(log, ['hold', 'release']);
  assert.equal(k.holding, false);
  k.set(true, 130_000);
  assert.deepEqual(log, ['hold', 'release', 'hold']);
});

test('where Windows cannot be asked (another system), nothing is held and nothing breaks', () => {
  const k = new KeepAwake(null, 0);
  k.set(true, 0);
  k.set(false, 1);
  assert.equal(k.holding, false);
});

test('the Windows call keeps the system awake (not the screen) and ends with the process', () => {
  const s = holdScript();
  assert.match(s, /SetThreadExecutionState/);
  assert.match(s, /0x80000001/);
  assert.doesNotMatch(s, /0x80000002/, 'the screen is left to turn off');
});

test('a node is in use when a linked PC has a model loaded there or a request is running', () => {
  assert.equal(nodeBusy({ linkedModels: 0, requests: 0 }), false);
  assert.equal(nodeBusy({ linkedModels: 1, requests: 0 }), true);
  assert.equal(nodeBusy({ linkedModels: 0, requests: 2 }), true);
});
