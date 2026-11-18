// Faults found walking Home, the chat, Staff, Jobs, Files, the queue and the office at 1200 px and 400 px wide, kept
// fixed: the phone's list view throws no error and takes the focus, nothing shows under Hire staff's foot, the Home
// card and the office head fit a narrow window, and the words name buttons that are there.
// Run: node --test test/walk-pages-a.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('public/style.css');

/** home.js's focusPage, run with a page stood in whose $ throws on an empty selector, as document.querySelector does. */
function focusPageOn(view: string) {
  const home = read('public/home.js');
  const start = home.indexOf('function focusPage(view) {');
  const end = home.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, 'home.js has focusPage');
  const focused: string[] = [];
  const node = (id: string) => ({ id, offsetParent: {}, matches: () => true, hasAttribute: () => true, setAttribute: () => undefined, focus: () => focused.push(id) });
  const ctx: Record<string, unknown> = {
    PAGE_VIEWS: ['staff', 'jobs', 'files'],
    PAGE_OF: { home: '#home' },
    asPage: { dlg: null },
    document: { querySelectorAll: () => [] },
    setTimeout: (f: () => void) => f(),
    $: (sel: string) => {
      if (!sel) throw new SyntaxError("Failed to execute 'querySelector' on 'Document': The provided selector is empty.");
      return node(sel);
    },
  };
  runInNewContext(`${home.slice(start, end)}\nthis.focusPage = focusPage;`, ctx);
  (ctx.focusPage as (v: string) => void)(view);
  return focused;
}

test('the list view on a phone ("‹ Chats and staff") throws no error and puts the keyboard on New chat', () => {
  assert.deepEqual(focusPageOn('rail'), ['#rail-new']);
  assert.deepEqual(focusPageOn('chat'), ['#chat-input']);
  // A view with no page of its own is left alone, never asked for with an empty selector.
  assert.deepEqual(focusPageOn('nowhere'), []);
});

test('Hire staff: Cancel and Hire staff reach the window edges and foot, so nothing scrolled shows under them', () => {
  assert.match(css, /\n\.hs-go \{[^}]*margin: 12px -16px -16px; padding: 12px 16px 10px;[^}]*position: sticky; bottom: -16px;/);
  assert.match(css, /#setup-page > dialog\.as-page \.hs-go \{ margin: 12px 0 0; padding: 12px 0 10px; bottom: 0;/);
  assert.match(css, /dialog#hire-dlg \{[^}]*padding: 16px;/, 'the window padding the foot reaches over');
});

test('a window with no padding of its own has 16px, as its top band and foot expect (no 2px scroll)', () => {
  assert.match(css, /\ndialog \{ padding: 16px; \}/);
  assert.match(css, /\.dlg-top \{[^}]*margin: -16px -16px 8px;/);
});

test('narrow windows: the Home card never runs past its edge, the greeting is not squeezed, the office head wraps', () => {
  assert.match(css, /\n\.home-ask \{[^}]*display: grid; grid-template-columns: minmax\(0, 1fr\);/, 'a long staff name in the drop-down cannot widen the card');
  const phone = css.slice(css.indexOf('/* Phone: the same look with less padding */'));
  assert.match(phone, /\.home-main > \.home-head \{ flex-wrap: wrap; \}/);
  assert.match(phone, /\.home-main > \.home-head > \.back \{ flex-basis: 100%;/);
  assert.match(css, /\.office-full-head \{ display: flex; flex-wrap: wrap;/, '"To spend: 0 tokens" is not one word per line');
});

test('the words name what is on screen', () => {
  const homeview = read('public/homeview.js');
  assert.doesNotMatch(homeview, /press Setup staff/, 'there is no Setup staff button');
  assert.match(homeview, /Hire staff first: press Hire staff under the prompt/);
  assert.match(homeview, /title: `Hire \$\{\/\^\[aeiou\]\/i\.test\(r\.name\) \? 'an' : 'a'\} \$\{r\.name\.toLowerCase\(\)\}/, 'an artist, not a artist');
  const project = read('public/project.js');
  assert.doesNotMatch(project, /'Next saves the Scope card/, 'the last step\'s button is Save project');
  assert.match(project, /'Save project puts the Scope card and the design brief in the job folder\.'/);
  const queue = read('public/queue.js');
  assert.doesNotMatch(queue, /text: 'Nothing in line\. Add pictures/, 'the count above already says Nothing in line');
  const chat = read('src/server/chat.ts');
  assert.match(chat, /const noModelWords = \(\) => \(chatList\(\)\.length\n/);
  assert.match(chat, /'No chat model is on this PC yet: get one under Settings, Models, then press Connect at the top of this chat and send again\.'/);
  assert.equal(chat.match(/noModelWords\(\)/g)?.length, 2, 'a new message and Continue both say it');
});

test('a press that does nothing says why or moves the keyboard: empty Add, empty New file, See the queue', () => {
  const memory = read('public/memory.js');
  assert.match(memory, /if \(!add\.value\.trim\(\)\) return add\.focus\(\);/);
  const files = read('public/files.js');
  assert.match(files, /fileFault\('Type a name for the new file first, for example notes\.md\.'\);\n\s*return \$\('#file-new'\)\.focus\(\);/);
  const queue = read('public/queue.js');
  assert.match(queue, /head\.focus\(\{ preventScroll: true \}\);/);
});
