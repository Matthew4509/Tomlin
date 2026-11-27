// Fixes from the 26 Nov audit of the newest commits (A3, A4, A10): Give the key says so when it could not, the key is given
// again from a fresh hello after a PIN was typed, and the Updating linked PCs window never asks again while a read is out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('A3: Give the key answers 409 with why when that PC cannot hold one', () => {
  const s = read('src/jobrun/hostpins.ts');
  assert.match(s, /if \(!\(await giveKey\(r, nodePin, true\)\)\) return \{ status: 409, body: \{ error: `"\$\{r\.name\}" cannot hold an admin key: its TOMLIN is too old for one \(update it first\), or it is linked as a guest\.` \} \};/);
});

test('A4: after a PIN is typed, what that PC holds is asked fresh, not taken from a hello up to 30 s old', () => {
  const s = read('src/jobrun/hostpins.ts');
  assert.match(s, /await giveKey\(r, sent\.appPin, true\)\.catch\(\(\) => undefined\);/);
  assert.match(s, /const h = \(fresh \? null : lastHello\(r\.id\)\) \?\? \(await hello\(r, 5000\)\);/);
});

test('A5: the Admin PC row says once that admin access, turned off before, is on now', () => {
  assert.match(read('src/jobrun/hostpins.ts'), /lock: d\.appLockOn\(\), wasOff: k\.wasOff \} \};/);
  assert.match(read('public/home.js'), /v\.key\.wasOff \? 'Admin access was turned off on this PC before\. There is no switch for it now, so it is on while TOMLIN here is unlocked\./);
});

test('A10: the Updating linked PCs window skips a tick while the last read is still out', () => {
  const s = read('public/network.js');
  const r = s.slice(s.indexOf('async function updsRead()'), s.indexOf('app.openUpdates = async'));
  assert.match(r, /if \(updsBusy\) return;\s*updsBusy = true;/);
  assert.match(r, /\} finally \{\s*updsBusy = false;\s*\}/);
});

test('Stop on a linked PC ends its wait for the picture model at once, so a cancelled picture does not hold it "1st in line"', () => {
  const pic = read('src/server/pictures.ts');
  assert.match(pic, /export async function loadImage\(id: string, signal\?: AbortSignal\): Promise<boolean> \{/);
  assert.match(pic, /while \(Date\.now\(\) - t0 < loadWaitMs\(images\.pane\.view\.model === id && images\.pane\.view\.state === 'loading'\) && !signal\?\.aborted\) \{/);
  // 10 minutes, or an hour while the model is still loading (a 28 GB model on the Z820's hard disk took longer than 10).
  assert.match(pic, /export const loadWaitMs = \(stillLoading: boolean\): number => \(stillLoading \? 60 : 10\) \* 60_000;/);
  assert.match(read('src/jobrun/node.ts'), /if \(!\(await d\.loadImage\(model\.id, signal\)\)\) throw new Error\(signal\.aborted \? 'Stopped\.' :/);
});

test('a linked PC slow to answer (busy loading a large model) is asked once more before the queue calls it off', () => {
  const src = read('src/jobrun/links.ts');
  const fn = src.slice(src.indexOf('export async function pictureDrawer'), src.indexOf('export async function drawOn'));
  assert.match(fn, /hello\(r, 3000\)\.catch\(e => \(\(slow = !!\(e as \{ timedOut\?: boolean \}\)\.timedOut\), null\)\)\) \?\? \(slow \? await hello\(r, 20_000\)/);
  assert.match(fn, /is off or not answering/);
});
