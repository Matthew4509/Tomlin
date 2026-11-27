// A picture on a 4-core node drawing on its CPU stopped part-way twice (26 Nov 2026): the asking PC heard nothing for
// over a minute, closed the link, and the node stopped the picture, with nothing in either log saying why.
// Run: node --test test/linkdrop.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpuBusy, cardWords } from '../src/worklog.ts';
import { pictureThreads } from '../src/images.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the picture runner leaves one thread free, never fewer than one: a 2-core laptop with 4 threads keeps 3', () => {
  assert.equal(pictureThreads(8), 7);
  assert.equal(pictureThreads(4), 3);
  assert.equal(pictureThreads(2), 1);
  assert.equal(pictureThreads(1), 1);
  assert.match(read('src/images.ts'), /'-t', String\(threads > 0 \? threads : pictureThreads\(\)\)\)/);
});

test('the picture runner works below normal priority; chat runners are left as they were', () => {
  const w = read('src/worker.ts');
  assert.match(w, /if \(this\.pane === 'image' && child\.pid\) \{\n\s+try \{\n\s+setPriority\(child\.pid, constants\.priority\.PRIORITY_BELOW_NORMAL\);/);
});

test('a picture asked from the Images window on another PC has a request id and is asked for again for 6 hours', () => {
  const p = read('src/server/pictures.ts');
  assert.match(p, /export const KEEP_DRAWING_MS = 6 \* 3600_000;/);
  assert.match(p, /\.\.\.drawChoices\(asked\), \.\.\.\(away\.model \? \{ model: away\.model \} : \{\}\), \.\.\.\(refImages\.length \? \{ refImages \} : \{\}\), rid: newRid\(\), keepMs: KEEP_DRAWING_MS \}/);
  const links = read('src/jobrun/links.ts');
  assert.match(links, /const \{ rid: askedRid, keepMs, refImages, \.\.\.rest \} = ask;/);
  assert.match(links, /\.\.\.\(keepMs \? \{ giveUpMs: keepMs \} : \{\}\) \}\)/);
});

test('the node logs each picture for another PC: start, a move to the CPU, the end, a fault and why it stopped', () => {
  const n = read('src/jobrun/node.ts');
  assert.match(n, /log\.info\('picture', `\$\{what\}: started/);
  assert.match(n, /log\.warn\('picture', `\$\{what\}: \$\{\(lastNote = p\.note\)\}`\)/);
  assert.match(n, /log\.info\('picture', `\$\{what\}: done in/);
  assert.match(n, /log\.error\('picture', `\$\{what\}: failed after/);
  assert.match(n, /: stopped after \$\{Math\.round/);
  assert.match(n, /const stopReadings = startReadings\(what, line => log\.info\('picture', line\)\);/);
  assert.match(read('src/jobrun/pictureback.ts'), /log\.warn\('picture', `The link to "\$\{o\.name\}" was cut while it drew/);
});

test('a reading: how busy the CPU was between two samples, and the card in words', () => {
  const t = (user: number, idle: number) => ({ model: '', speed: 0, times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  assert.equal(cpuBusy([t(0, 0), t(0, 0)], [t(75, 25), t(25, 75)]), 50);
  assert.equal(cpuBusy([], []), 0);
  assert.equal(cardWords('71, 1290, 0x0000000000000000\n'), 'card 71 °C, 1290 MHz, throttle: none');
  assert.equal(cardWords('88, 900, 0x0000000000000020'), 'card 88 °C, 900 MHz, throttle: 0x0000000000000020');
  assert.equal(cardWords('NVIDIA-SMI has failed'), null);
});
