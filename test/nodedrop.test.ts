// A node lets go of what it loaded for linked PCs (node tests, 2 November): a model the speed finder reloads stays
// counted as theirs, so it still drops; a picture model moved to the CPU part-way through a picture too; chat models
// loaded for linked PCs make room on the card for a picture; a link cut part-way is said in plain words. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAT_DROP_MS, chatVerdict, cutWords, pictureRoom, pictureVerdict } from '../src/nodestaff.ts';

const MIN = 60_000;
const GB = 2 ** 30;

test('a chat model the speed finder is testing stays counted, even while it is unloaded between tries', () => {
  assert.equal(chatVerdict({ state: 'disconnected', lending: false, busyHere: false, testing: true, idleMs: 0 }), 'keep');
  assert.equal(chatVerdict({ state: 'connected', lending: false, busyHere: false, testing: true, idleMs: 30 * MIN }), 'keep');
  assert.equal(chatVerdict({ state: 'connected', lending: false, busyHere: false, testing: false, idleMs: CHAT_DROP_MS + 1 }), 'drop', 'then drops as before');
  assert.equal(chatVerdict({ state: 'disconnected', lending: false, busyHere: false, testing: false, idleMs: 0 }), 'gone');
  assert.equal(chatVerdict({ state: 'connected', lending: false, busyHere: true, testing: false, idleMs: 0 }), 'theirs');
});

test('a picture model moved to the CPU while drawing for a linked PC is still theirs, so it still drops', () => {
  const v = { id: 'qwen-image', model: 'qwen-image', busyHere: false, idleMs: 0, dropMs: 10 * MIN };
  assert.equal(pictureVerdict({ ...v, state: 'disconnected', drawing: true }), 'keep', 'restarting on the CPU part-way');
  assert.equal(pictureVerdict({ ...v, state: 'connected', drawing: false, idleMs: 11 * MIN }), 'drop');
  assert.equal(pictureVerdict({ ...v, state: 'connected', drawing: false, model: 'other' }), 'gone');
});

test('the node looks after them by these rules, and the finder says what it is testing', () => {
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8');
  assert.match(node, /chatVerdict\(/);
  assert.match(node, /pictureVerdict\(/);
  assert.match(node, /testing: d\.finderTesting\?\.\(\) === id/);
  assert.match(readFileSync(new URL('../src/server/finder.ts', import.meta.url), 'utf8'), /export const finderTesting = /);
});

test('a picture needs room on the card beside the chat models loaded there', () => {
  assert.equal(pictureRoom({ cardTotal: 4 * GB, heldByOthers: 2.5 * GB, need: 2.9 * GB }), false);
  assert.equal(pictureRoom({ cardTotal: 4 * GB, heldByOthers: 0, need: 2.9 * GB }), true);
  assert.equal(pictureRoom({ cardTotal: null, heldByOthers: 2.5 * GB, need: 2.9 * GB }), true, 'no card known: not refused');
});

test('chat models loaded for linked PCs make room for every picture asked of the node, not only queued ones', () => {
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8');
  const shared = /async function drawShared[\s\S]*?\n\}/.exec(node)?.[0] ?? '';
  assert.match(shared, /const made = await chatsMakeWay\(model\.id\)/);
  assert.match(/async function chatsMakeWay[\s\S]*?\n\}/.exec(node)?.[0] ?? '', /d\.pictureRoom\(model\)/);
});

test('a link cut part-way is said in plain words, not "terminated"', () => {
  assert.match(cutWords('Worker PC', 'terminated'), /"Worker PC" stopped sending part-way/);
  assert.match(cutWords('Worker PC', 'fetch failed'), /link closed/);
  assert.equal(cutWords('Worker PC', '"Worker PC" said: it was stopped.'), '"Worker PC" said: it was stopped.', 'its own words pass through');
  assert.match(readFileSync(new URL('../src/jobrun/links.ts', import.meta.url), 'utf8'), /cutWords\(r\.name/);
});
