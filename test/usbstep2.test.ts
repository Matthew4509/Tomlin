// Bootable USB, step 2: the ISO (for Rufus) and the extra parts (for Mint) are two downloads, each with its own button
// and bar, and both can run at once; Mint waits for the parts it copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../public/usb.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const srv = readFileSync(new URL('../src/server/usb.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('step 2: two downloads, each its own button and bar, each part named with its size', () => {
  assert.match(js, /usbStep\(2, 'Download the Linux ISO and the extra parts',/);
  assert.match(js, /Two downloads, each with its own button and bar, and both can run at once\./);
  assert.match(js, /text: v\.iso\.here \? 'Check it again' : `Download the ISO \(\$\{usbMb\(v\.iso\.bytes\)\}\)`, disabled: on\('iso'\),/);
  assert.match(js, /tk\.iso \? usbTaskBox\(tk\.iso\) : null,\s*el\('h4', \{ text: 'B\. The extra parts, for Mint \(step 4\)' \}\),/);
  assert.match(js, /`Download the extra parts \(\$\{usbMb\(partsMissing\.reduce/);
  assert.match(js, /tk\.parts \? usbTaskBox\(tk\.parts\) : null\);/);
  assert.match(js, /tk\.stick \? usbTaskBox\(tk\.stick\) : null,/);
  assert.doesNotMatch(js, /Get both/);
  for (const w of ['Node.js for Linux: runs TOMLIN on the stick', 'llama.cpp, Vulkan build: AMD, Intel and older NVIDIA cards', 'llama.cpp, CUDA build: NVIDIA RTX 20 series and newer']) assert.ok(js.includes(w), w);
  assert.match(js, /return `\$\{usbMb\(r\.speed\)\}\/s, \$\{time\} left`;/);
});

test('the server runs the ISO and the parts side by side; Mint waits for the parts, and the parts for Mint', () => {
  assert.match(srv, /const laneOf = \(k: Task\['kind'\]\): Lane => \(k === 'iso' \? 'iso' : k === 'parts' \? 'parts' : 'stick'\);/);
  assert.match(srv, /if \(running\(lane\)\) return \{ status: 409,/);
  assert.match(srv, /if \(kind === 'mint' && running\('parts'\)\) return \{ status: 409,/);
  assert.match(srv, /if \(kind === 'parts' && running\('stick'\) && tasks\.stick!\.kind === 'mint'\) return \{ status: 409,/);
  assert.match(srv, /tasks: Object\.fromEntries\(\(Object\.keys\(tasks\) as Lane\[\]\)\.map\(l => \[l, taskView\(tasks\[l\]\)\]\)\),/);
});
