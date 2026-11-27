// Make a sheet: each view the queue draws goes into its character's or location's folder, so its best views can be
// ticked as references (the user test of 27 Nov 2026 found them only in the gallery, with no way to add them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queue = readFileSync(new URL('../src/server/queue.ts', import.meta.url), 'utf8');
const cards = readFileSync(new URL('../src/server/cards.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/charsets.js', import.meta.url), 'utf8');

test('a drawn sheet view is copied into its card, and the chat it was asked from is kept on the picture', () => {
  assert.match(cards, /export async function pictureToCard\(/);
  assert.match(queue, /pictureToCard\(it\.project, it\.card\.kind, it\.card\.name, got\.pic\.id\)/);
  assert.match(queue, /gallery\.update\(got\.pic\.id, \{ kept: true, \.\.\.\(it\.chat \? \{ chat: it\.chat \} : \{\}\) \}\)/);
});

test('Make a sheet sends its card, its chat, a style and a quality', () => {
  assert.match(page, /card: \{ kind: c\.kind, name: c\.name \}/);
  assert.match(page, /chat: app\.chatId/);
  assert.match(page, /mode, quality, project: ui\.project/);
});

test('the Add row offers this chat\'s newest pictures and every chat\'s (test/pictures1128-page.test.ts L5)', () => {
  assert.match(page, /ui\.recent = addRows\(mine, all\);/);
});
