// The user test of 27 Nov 2026 (The Difference, two characters in a home): what a person could not do or could not
// tell, each held here so it stays fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('a node tells its video models in the hello, as their own list, never to a guest', () => {
  const node = read('src/jobrun/node.ts');
  assert.match(node, /const videosNow = \(\): string\[\] => VIDEO_MODELS\.filter\(m => !!d\.carry\.videoFiles\(m\.id\)\)\.map\(m => m\.id\);/);
  assert.equal(node.match(/videos: guest \? \[\] : videosNow\(\)/g)?.length, 2);
  // Read with only safe ids kept; absent from an older TOMLIN.
  assert.match(read('src/jobrun/links.ts'), /Array\.isArray\(data\.videos\) \? \{ videos:/);
});

test('a Videographer on a linked PC is Asleep, not Offline, when that PC has (or does not say) the video model', () => {
  const team = read('src/server/team.ts');
  assert.match(team, /remoteState\(m\.model, true, true\)/);
  assert.match(team, /if \(video && b\.model\) \{/);
  assert.match(team, /loads on "\$\{r\.name\}" when a clip is made/);
  // Hire staff and Move say whether that PC has it.
  assert.match(team, /here: pc \? videosThere\(pc, x\.id\) : x\.installed/);
});

test('Models on my other PCs lists each PC\'s video models', () => {
  const net = read('public/network.js');
  assert.match(net, /const videoRows = p => \(p\.videos \?\? \[\]\)/);
  assert.match(read('src/jobrun/copies.ts'), /videos: videoList\(pc\.id\)/);
});

test('an artist or videographer chat can be put in a project from the side panel', () => {
  const tab = read('public/projecttab.js');
  assert.match(tab, /el\('option', \{ value: '', text: 'Pick a project…' \}\)/);
  assert.match(tab, /head\.dispatchEvent\(new Event\('change'\)\)/);
  // Character sets follows the chat into its project at once.
  assert.match(read('public/chats.js'), /void app\.charSets\?\.load\(\);/);
});

test('the queue names linked PCs apart, and a hire drawing a queued picture is Busy', () => {
  const queue = read('src/server/queue.ts');
  assert.match(queue, /brains\.pcLabels\(all\)\[r\.id\] \?\? r\.name/);
  assert.match(queue, /export const drawingFor = /);
  assert.match(read('src/server/team.ts'), /\|\| drawingFor\(m\.id\) \|\|/);
});

test('Hire staff: Pictures and video starts on Artist; a picture\'s … menu closes with Escape', () => {
  assert.match(read('public/hire.js'), /id === 'image' \? d\(\)\.roles\.find\(r => r\.id === 'artist'\) : null/);
  assert.match(read('public/images.js'), /e\.key === 'Escape' && more\.open/);
});
