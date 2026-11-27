// The pictures walk of 27 Nov 2026 (REVIEW-2026-11-27-PICTURES-VIDEO-WALK.md), the page side: Character sets in a chat
// with no project make one right there (F4); the Add row offers this chat's pictures and older ones (L5); a picture in
// progress shows only in its own artist's chat, and an artist's chat with pictures says so (L9); "No sample yet" is said
// once above the style tiles (F16); pictures added as a list are kept with the chat and say so (L6); the first tab of
// the Images window is Pictures (F14). Functions are taken out of the page's scripts and run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Function `name` of a page script, cut out by its braces and made callable here. */
function take<T>(js: string, name: string): T {
  const at = js.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `no function ${name}`);
  let depth = 0;
  let end = js.indexOf('{', at);
  for (let i = end; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return new Function(`${js.slice(at, end)}; return ${name};`)() as T;
}

const charsets = read('charsets.js');
const images = read('images.js');
const chats = read('chats.js');
const stylepick = read('stylepick.js');
const queue = read('queue.js');
const index = read('index.html');

test('F4: Character sets in a chat with no project offer "Make a project for these characters" and the panel\'s choice', () => {
  const words = take<(top: boolean, name: string) => string>(charsets, 'noFolderWords');
  assert.match(words(false, 'This project'), /this chat is in none\. Make a project for these characters, or put this chat in one you have\./);
  assert.doesNotMatch(words(false, 'This project'), /panel on the right/);
  // A project kept at the top of the workspace: what to do, in plain words.
  assert.match(words(true, 'Whole workspace'), /^Whole workspace is kept at the top of the workspace, so it has no folder of its own for characters and locations\. Make a project for these characters/);
  // In the tab itself: a name box and the button, which makes the project and puts this chat in it; and the panel's list.
  assert.match(charsets, /el\('input', \{ id: 'cs-pname', type: 'text'/);
  assert.match(charsets, /text: 'Make a project for these characters'/);
  assert.match(charsets, /api\('\/api\/projects\/create', \{ name, fromChat: true \}\)/);
  assert.match(charsets, /await putInProject\(chat, made\.id\);/);
  assert.match(charsets, /text: 'Pick a project you have'[^\n]*onclick: openProjectChoice/);
  assert.match(charsets, /fold\.open = true;\n\s+\$\('#tab-project'\)\?\.click\(\);/);
  // A 409 (kept at the top) shows the same, not only the fault line.
  assert.match(charsets, /ui\.top = e\.status === 409;/);
  assert.match(charsets, /if \(!ui\.project \|\| ui\.top\) \{/);
});

test('L5: the Add row offers this chat\'s pictures and the older ones from no chat (or other chats), both', () => {
  const addRows = take<(mine: { id: string }[], all: { id: string }[]) => { title: string; pictures: { id: string }[] }[]>(charsets, 'addRows');
  const mine = [{ id: 'a' }, { id: 'b' }];
  const all = [{ id: 'a' }, { id: 'old1' }, { id: 'b' }, { id: 'old2' }];
  const rows = addRows(mine, all);
  assert.deepEqual(rows.map(r => r.pictures.map(p => p.id)), [['a', 'b'], ['old1', 'old2']]);
  assert.match(rows[0].title, /this chat's newest pictures/);
  assert.match(rows[1].title, /older pictures/);
  // No pictures in this chat: one row, every chat's newest.
  assert.deepEqual(addRows([], all).map(r => r.pictures.length), [4]);
  assert.deepEqual(addRows([], []), []);
  // Both are asked every time the editor opens.
  assert.match(charsets, /const \[mine, all\] = await Promise\.all\(\[app\.chatId \? newest\(app\.chatId\) : \[\], newest\(''\)\]\);/);
});

test('L9: a picture in progress shows in its own chat, or (queued, no chat) in its own artist\'s chats only', () => {
  const here = take<(j: object, chatId: string, who: string) => boolean>(images, 'progressHere');
  // Drawn from Moss's chat: only there.
  assert.equal(here({ chat: 'c-moss', as: 'moss' }, 'c-moss', 'staff:moss'), true);
  assert.equal(here({ chat: 'c-moss', as: 'moss' }, 'c-ivy', 'staff:ivy'), false);
  // Queued (no chat): Moss's chats, not Ivy's.
  assert.equal(here({ chat: null, as: 'moss' }, 'c-moss2', 'staff:moss'), true);
  assert.equal(here({ chat: null, as: 'moss' }, 'c-ivy', 'staff:ivy'), false);
  assert.equal(here({ chat: null, as: null }, 'c-ivy', 'staff:ivy'), false);
  // This PC's own pane (no chat open), and a picture drawn for a linked PC, show it.
  assert.equal(here({ chat: 'c-moss', as: 'moss' }, '', ''), true);
  assert.equal(here({ forPc: 'Worker PC' }, 'c-ivy', 'staff:ivy'), true);
  assert.match(images, /progress\.hidden = !here;/);
  // The server says whose picture it is.
  assert.match(readFileSync(new URL('../src/images.ts', import.meta.url), 'utf8'), /as: j\.opts\.as \?\? null,/);
});

test('L9: an artist\'s chat with pictures and no message says how many pictures, not "No message yet"', () => {
  const mini = take<(c: object) => string>(chats, 'chatMini');
  assert.equal(mini({ preview: 'a fox in snow', pictures: 3 }), 'a fox in snow');
  assert.equal(mini({ preview: '', pictures: 3 }), '3 pictures, no message');
  assert.equal(mini({ preview: '', pictures: 1 }), '1 picture, no message');
  assert.equal(mini({ preview: '' }), 'No message yet');
  assert.match(chats, /el\('span', \{ class: 'allchats-mini', text: chatMini\(c\) \}\)/);
});

test('F16: "No sample yet" is said once above the style tiles, never under each tile', () => {
  const missing = take<(data: object, model: string | null, name: string) => string>(stylepick, 'missingLine');
  const styles = [{ id: 'auto', name: 'Auto', mode: 'auto' }, { id: 'photo', name: 'Photo', mode: 'blog' }, { id: 'anime', name: 'Anime', mode: 'custom' }, { id: 'ink', name: 'Chinese ink', mode: 'custom' }];
  assert.equal(missing({ styles, samples: {} }, null, 'the model loaded on their PC'), 'No style samples yet for the model loaded on their PC: the tiles show a ? until Make the style samples draws them.');
  // Some have one (this model's or another's): the rest are named.
  assert.equal(missing({ styles, samples: { dream: { photo: {} }, other: { anime: {} } } }, 'dream', 'DreamShaper 8'), 'No sample yet for DreamShaper 8 in Chinese ink (the tiles with a ?).');
  assert.equal(missing({ styles, samples: { dream: { photo: {}, anime: {}, ink: {} } } }, 'dream', 'DreamShaper 8'), '');
  // The tile itself has no "No sample yet" line any more.
  assert.doesNotMatch(stylepick, /const note = [^\n]*No sample yet/);
  assert.match(images, /const none = stylePick\.missing\(m\.model, m\.modelName\);/);
  assert.match(index, /<p class="hint style-none" id="img-style-none" hidden><\/p>/);
  assert.match(charsets, /stylePick\.missing\(artistModel\(\)\.model, artistModel\(\)\.modelName\)/);
});

test('L6: pictures added to the queue (one, or a list) go with the chat on screen, and the list says how many', () => {
  assert.match(queue, /\.\.\.\(app\.chatId \? \{ chat: app\.chatId \} : \{\}\) \};/);
  const said = take<(n: number, forWhat: string, inChat: boolean) => string>(queue, 'listAdded');
  assert.equal(said(3, 'for the gallery', true), '3 pictures added to the queue for the gallery. They come into this chat as they are drawn; Home says when they are back.');
  assert.equal(said(1, 'for Story', false), '1 picture added to the queue for Story. Home says when it is back.');
  // Said under the Draw box too, where it is seen with Advanced closed.
  assert.match(queue, /line\.textContent = said;\n\s+imgNote\(said\);/);
});

test('F14: the Images window\'s first tab is Pictures, not Blog photos', () => {
  assert.match(index, /data-kind="blog" aria-selected="true">Pictures<\/button>/);
  assert.doesNotMatch(index, />Blog photos</);
});
