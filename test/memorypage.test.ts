// The memory editor page (public/memorypage.js), read from the page's own files: a page in the middle panel, not a
// window; reached from the chat's Memory window and the person page; no browser pop-ups; 12px or more; suggestions
// wait in the Inbox. Walked in the browser on a scratch copy as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the editor is its own page in the middle panel, hidden unless on screen, and not kept over a reload', () => {
  const html = read('index.html');
  assert.match(html, /<section class="nodes memory-page" id="memory-page" data-crumb="Memory" aria-labelledby="memory-page-title">/);
  assert.ok(html.indexOf('<script src="memorypage.js"></script>') > html.indexOf('<script src="memory.js"></script>'));
  const css = read('style.css');
  assert.match(css, /\.shell:not\(\[data-view="memory"\]\) > #memory-page \{ display: none; \}/);
  const home = read('home.js');
  assert.match(home, /view !== 'memory'/);
  assert.match(home, /memory: '#memory-page'/);
});

test('ways in: the chat Memory window, the person page, and the Inbox under an answer', () => {
  const html = read('index.html');
  assert.match(html, /id="notebook-editor">Open the memory editor</);
  assert.match(html, /id="person-page-memory">Memory</);
  const page = read('memorypage.js');
  assert.match(page, /\$\('#notebook-editor'\)\.addEventListener/);
  assert.match(page, /\$\('#person-page-memory'\)\.addEventListener/);
  assert.match(read('memory.js'), /app\.openMemory\?\.\(data\.scope, \{ inbox: true, back: 'chat' \}\)/);
});

test('no browser pop-ups, no text under 12px, and a model never writes memory: its line waits in the Inbox', () => {
  const page = read('memorypage.js');
  assert.doesNotMatch(page, /\b(prompt|confirm|alert)\(/);
  const css = read('style.css');
  const block = css.slice(css.indexOf('/* Memory editor'));
  for (const m of block.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
  assert.match(page, /never sent to a model until you keep it/);
  // Keep moves it out of the Inbox; only then is it read.
  assert.match(page, /text: 'Keep', onclick: \(\) => change\(\{ action: 'edit', id: l\.id, group: 'Notes' \}\)/);
  // The chat's Memory window lists only what is read.
  assert.match(read('memory.js'), /const lines = all\.filter\(l => l\.group !== 'Inbox'\);/);
});

test('Memory has a way in of its own: a line under Staff and models (Settings and the left menu), at the team notebook', () => {
  const html = read('index.html');
  const staff = html.slice(html.indexOf('id="rail-group-staff"'), html.indexOf('id="rail-group-network"'));
  assert.match(staff, /data-setup="memory" data-about="The notebooks your staff read, the team's and each hire's\."><svg[^\n]*<\/svg>Memory<\/button>/);
  assert.match(read('homeview.js'), /else if \(b\.dataset\.setup === 'memory'\) app\.openMemory\?\.\('team'\);/);
});

test('behaviour: how full a notebook is, in words: "under 1%" for a little, never "1%" for one entry', () => {
  const page = read('memorypage.js');
  const src = page.slice(page.indexOf('  const share = f =>'), page.indexOf('  app.memFullWords = fullWords;'));
  const fullWords = new Function(`${src}; return fullWords;`)() as (f: object) => string;
  const f = (entries: number, chars: number) => ({ entries, chars, maxEntries: 200, maxChars: 100_000 });
  assert.equal(fullWords(f(1, 33)), 'under 1%');
  assert.equal(fullWords(f(0, 0)), '0%');
  assert.equal(fullWords(f(2, 100)), '1%');
  assert.equal(fullWords(f(100, 100)), '50%');
  assert.equal(fullWords(f(300, 0)), '100%');
  assert.match(page, /text: `\$\{num\(b\.full\.entries\)\} entr\$\{b\.full\.entries === 1 \? 'y' : 'ies'\} · \$\{fullWords\(b\.full\)\} full` \}/);
});

test('with nobody hired, What the model gets says so (not "the person this chat was to be with")', () => {
  const page = read('memorypage.js');
  assert.match(page, /const NOBODY = 'Nobody is hired yet: the team notebook is read by everyone you hire\.';/);
  assert.match(page, /const text = scope !== 'team' \? e\.message : !hires\.length \? NOBODY : !hires\.some\(b => !b\.plain\) \? NOBODY_READS : e\.message;/);
});
