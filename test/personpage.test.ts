// The person page: a face on a PC card in Home's left panel opens that person's page in the middle panel (their PC and
// its state word, their model, New chat, Edit staff, their recent chats), not a chat. The Staff list keeps its window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('a face on a PC card opens the person page, a click right after a drag does nothing, drag still moves', () => {
  const home = read('home.js');
  const face = home.slice(home.indexOf("class: 'desk-face'"), home.indexOf('deskDrop(li, x);'));
  assert.match(face, /app\.openPersonPage\(s\.who \?\? `staff:\$\{s\.id\}`, s\.name, \{/);
  assert.match(face, /pcId: x\.id, word: x\.word/);
  assert.match(face, /Date\.now\(\) - \(homeUi\.dragEnd \?\? 0\) < 400/);
  assert.match(face, /deskDrag\(b, s\);/);
  assert.match(home, /homeUi\.dragEnd = Date\.now\(\);/);
  // The Staff list still opens the window.
  assert.match(home, /onClick: \(\) => \(app\.openPerson \? app\.openPerson\(s\.who \?\? `staff:\$\{s\.id\}`, s\.name\) : talkTo\(s\)\)/);
  // Its own view, focused at its heading, and not kept for a reload.
  assert.match(home, /person: '#person-page'/);
  assert.match(home, /view !== 'person' && view !== 'memory' && view !== 'agents' && !PAGE_VIEWS\.includes\(view\)\) store\('view', view\)/);
});

test('the page and the window build their rows with one function; the page has its own Show preview', () => {
  const chats = read('chats.js');
  assert.match(chats, /function personChatRows\(list, who, name, \{ preview, open, empty \}\)/);
  assert.equal(chats.match(/personChatRows\(\$\('#person-chats-list'\)/g)?.length, 1, 'the window uses it');
  assert.equal(chats.match(/personChatRows\(list, who, name, \{\n/g)?.length, 1, 'the page uses it');
  assert.equal(chats.match(/class: 'btn primary person-chat-resume'/g)?.length, 1, 'rows are built in one place');
  assert.match(chats, /const RECENT_SHOWN = 12;/);
  assert.match(chats, /No chats with \$\{name\} yet\./);
  assert.match(chats, /artist \? 'New chat \(draw\)' : 'New chat'/);
  assert.match(chats, /preview: \(\) => pageUi\.preview/);
  assert.match(chats, /preview: \(\) => personShowPreview/);
});

test('the top bar follows the person page PC at once, and the chat PC again back in the chat', () => {
  const chats = read('chats.js');
  assert.match(chats, /meters\.person = \{ pc: info\.pcId \?\? '', who \};/);
  assert.match(chats, /view === 'person' && meters\.person \? meters\.person : meters\.chat/);
  assert.match(chats, /if \(view !== 'chat' && view !== 'person'\) return app\.showBarPc\?\.\(null\);/);
  assert.match(chats, /\$\('#person-page'\)\.getClientRects\(\)\.length/);
});

test('the page is its own section, hidden unless on screen, its rules in one block after the window rows', () => {
  const html = read('index.html');
  for (const id of ['person-page', 'person-page-title', 'person-page-face', 'person-page-role', 'person-page-where', 'person-page-start', 'person-page-edit', 'person-page-show', 'person-page-list', 'person-page-fault']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // The window is still there as it was.
  assert.match(html, /<dialog id="person-chats" class="person-chats"/);
  const css = read('style.css');
  const at = css.indexOf('/* Person page (middle panel) */');
  assert.ok(at > css.lastIndexOf('.person-chat > .person-chat-sep:nth-child(2)'), 'after the .person-chat rules');
  assert.match(css, /\.shell:not\(\[data-view="person"\]\) > #person-page \{ display: none; \}/);
});
