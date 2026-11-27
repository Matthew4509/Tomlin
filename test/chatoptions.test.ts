// The chat box's foot: Options (bottom left, a menu that opens upward with Quick/Think, Web and Max), a paperclip for
// Add a document, then Stop and Send on the right; Memory is in the chat's top bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Options holds Quick/Think, Web and Max, then the paperclip; Stop and Send stay on the right', () => {
  const html = read('index.html');
  const foot = html.slice(html.indexOf('<div class="chat-actions">'), html.indexOf('</form>', html.indexOf('<div class="chat-actions">')));
  const order = ['id="chat-options-open"', 'id="think-pick"', 'id="web-pick"', 'id="max-pick"', 'id="doc-add"', 'class="chat-actions-gap"', 'id="chat-stop"', 'id="chat-send"'].map(k => foot.indexOf(k));
  assert.ok(order.every(i => i > 0), 'all there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
  const menu = foot.slice(foot.indexOf('id="chat-options-menu"'), foot.indexOf('id="doc-add"'));
  assert.ok(menu.includes('id="think-pick"') && menu.includes('id="web-pick"') && menu.includes('id="max-pick"'), 'the three switches are in the menu');
  assert.match(foot, /id="chat-options-menu" role="group" aria-label="Options for this chat" hidden>/);
  assert.match(foot, /<button class="btn quiet chat-clip" type="button" id="doc-add" title="[^"]+" aria-label="Add a document"><svg/);
  assert.doesNotMatch(foot, /id="notebook-open"/, 'Memory is not in the box');
  const bar = html.indexOf('id="chat-find-open"');
  assert.ok(html.indexOf('id="notebook-open"') > bar && html.indexOf('id="notebook-open"') - bar < 2000, 'Memory beside Find in the top bar');
  const css = read('style.css');
  assert.match(css, /\.chat-options-menu \{ position: absolute; left: 0; bottom: calc\(100% \+ 6px\);/, 'opens upward from the bottom left');
  assert.match(css, /#pane-chat\.read-only #chat-options,/);
});

test('the Options button names what is on, and the menu closes on Escape or a press elsewhere', () => {
  const app = read('app.js');
  assert.match(app, /const on = \[thinkOn\(\) \? 'Think' : '', webOn\(\) \? 'Web' : '', maxOn\(\) \? 'Max' : ''\]\.filter\(Boolean\);\n\s+optionsOpen\.textContent = \['Options', \.\.\.on\]\.join\(' · '\);/);
  assert.match(app, /new MutationObserver\(drawOptions\)\.observe\(optionsMenu, \{ subtree: true, attributes: true, attributeFilter: \['aria-pressed'\]/);
  assert.match(app, /e\.key === 'Escape' && !optionsMenu\.hidden/);
  assert.match(app, /!e\.target\.closest\('#chat-options'\)\) showOptions\(false\)/);
});

test('Memory in the top bar is an icon like its neighbours (the word was cut off there), named for screen readers', () => {
  assert.match(read('index.html'), /id="notebook-open" title="[^"]*" aria-label="Memory"><svg/);
});

test('Save, Copy and Memory are in This chat (the … menu), not shown in the chat\'s top bar', () => {
  const html = read('index.html');
  for (const id of ['chat-save', 'chat-copy', 'notebook-open']) assert.match(html, new RegExp(`class="[^"]*chat-in-menu[^"]*" type="button" id="${id}"`));
  assert.match(read('style.css'), /#pane-chat \.chat-tools \.chat-whole\.chat-in-menu \{ display: none; \}/);
  const menu = html.slice(html.indexOf('<dialog id="chat-menu"'), html.indexOf('</dialog>', html.indexOf('<dialog id="chat-menu"')));
  assert.match(menu, /<h3>The whole chat<\/h3>/);
  assert.match(menu, /id="chat-menu-save">Save<\/button><button class="btn" type="button" id="chat-menu-copy">Copy<\/button><button class="btn" type="button" id="chat-menu-memory">Memory<\/button>/);
  const js = read('chats.js');
  assert.match(js, /\$\('#chat-menu-save'\)\.addEventListener\('click', \(\) => \{\n\s+\$\('#chat-menu'\)\.close\(\);\n\s+\$\('#chat-save'\)\.click\(\);/);
  assert.match(js, /\$\('#chat-menu-memory'\)\.hidden = \$\('#notebook-open'\)\.hidden;/);
});
