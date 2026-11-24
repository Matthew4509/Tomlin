// "Find it on my network" scans a linked PC's saved port and then the usual one; "Where models are kept" draws this
// PC's drives from the Storage page's kept list instead of a fresh Windows reading each time. Nothing here scans a
// network or reads the real drives: the ports are worked out from addresses, and the drive reading is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as share from '../src/share.ts';
import { findPorts } from '../src/jobrun/linking.ts';
import { drivesHere } from '../src/jobrun/storage.ts';
import type { Drive } from '../src/modelhome.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const usual = share.DEFAULT_SHARE.port;

test('a PC saved on another port: that port first, then the usual one', () => {
  const other = usual === 9123 ? 9124 : 9123;
  assert.deepEqual(findPorts(`http://192.168.1.20:${other}`), [other, usual]);
});

test('a PC saved on the usual port, or at an address that cannot be read: the usual port once', () => {
  assert.deepEqual(findPorts(`http://192.168.1.20:${usual}`), [usual]);
  assert.deepEqual(findPorts('not an address'), [usual]);
});

test('Find it on my network scans each port in turn, never trying one address twice', () => {
  const src = read('src/jobrun/linking.ts');
  const route = src.slice(src.indexOf("b.action === 'find-again'"), src.indexOf("b.action === 'answer'"));
  assert.ok(route.length > 0, 'the route is there');
  assert.match(route, /for \(const port of findPorts\(r\.url\)\) \{/);
  assert.match(route, /for \(const x of await scan\(port\)\) if \(!found\.some\(y => y\.url === x\.url\)\) found\.push\(x\);/);
  assert.match(route, /if \(tried\.has\(url\)\) continue;/);
  assert.doesNotMatch(route, /const found = await scan\(port\);/, 'not the saved port alone');
});

const drive = (letter: string): Drive => ({ drive: `${letter}:`, label: '', removable: false, fs: 'NTFS', free: 1, total: 2 });

test('drives known: answered at once from the kept list, read again behind', async () => {
  let reads = 0;
  const kept = [drive('C'), drive('D')];
  // A reading that never ends: the answer must not wait on it.
  const got = await drivesHere(() => (reads++, new Promise<Drive[]>(() => undefined)), () => kept);
  assert.deepEqual(got, kept);
  assert.equal(reads, 1, 'read again behind, once');
});

test('nothing known yet: read now, and a reading that fails is an empty list', async () => {
  assert.deepEqual(await drivesHere(async () => [drive('E')], () => []), [drive('E')]);
  assert.deepEqual(await drivesHere(() => Promise.reject(new Error('no')), () => []), []);
});

test('Where models are kept uses the kept drive list, not a fresh reading each call', () => {
  const mh = read('src/server/modelhome.ts');
  const view = mh.slice(mh.indexOf('async function view()'), mh.indexOf('export async function chooseModelsHome'));
  assert.ok(view.length > 0, 'view is there');
  assert.match(view, /const all = await drivesHere\(\);/);
  assert.doesNotMatch(view, /await drives\(\)/);
  assert.match(mh, /import \{ drivesHere \} from '\.\.\/jobrun\/storage\.ts';/);
});
