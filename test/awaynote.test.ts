// A picture drawn on a linked PC that moved to that PC's CPU (its card ran out of memory) said so only there: the PC that
// asked kept "Loading … there" for minutes. The node's own view blanks the note of a picture drawn for another PC, so the
// note is read from the job itself. Run: node --test test/awaynote.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pictures = readFileSync(new URL('../src/server/pictures.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const images = readFileSync(new URL('../src/images.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the drawing PC sends the job\'s own note with the progress, and the asking PC shows it as the picture\'s note', () => {
  assert.match(pictures, /queued: j\.queued, note: images\.noteOf\(job\.id\) \}\)/);
  assert.match(pictures, /if \(typeof p\.note === 'string' && p\.note\.trim\(\)\) job\.note = `\$\{away\.name\} on "\$\{away\.r\.name\}": \$\{p\.note\.trim\(\)\.slice\(0, 400\)\}`;/);
});

test('noteOf reads the job, not the view that blanks a linked PC\'s note', () => {
  assert.match(images, /noteOf\(id: string\): string \| null \{\n\s+const j = \[this\.current, \.\.\.this\.jobs, this\.lastJob\]\.find\(x => x\?\.id === id\);/);
  // The view still blanks it (the node's own pane): the reason noteOf exists.
  assert.match(images, /note: null, forPc \} : \{\}\),/);
});
