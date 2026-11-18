// The wrong-model-for-tools notice, the words when Web is off, and the permit card's time limit (src/toolsnotice.ts), and
// where the chat and the page use them. Nothing starts TOMLIN or a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asksForWeb, permitTimedOut, PERMIT_WAIT_MS, toolsNotice, webOffWords } from '../src/toolsnotice.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test('the notice names the PC and the model, offers models with the Tools mark (loaded first), and swaps nothing', () => {
  const n = toolsNotice({ pc: 'Z820', model: 'gemma-2-9b', offers: [{ id: 'a', name: 'Qwen3.5-9B', loaded: false }, { id: 'b', name: 'Qwen3.5-35B-A3B', loaded: true }, { id: 'c', name: 'gemma-2-9b', loaded: true }] });
  assert.match(n.text, /^gemma-2-9b on "Z820" has no Tools mark/);
  assert.deepEqual(n.offers.map(o => o.name), ['Qwen3.5-35B-A3B', 'Qwen3.5-9B']);
  assert.match(n.how, /does not change the model in the middle of a chat/);
  const none = toolsNotice({ pc: 'This PC', model: 'm', offers: [] });
  assert.match(none.text, /^m on this PC/);
  assert.match(none.how, /No chat model on this PC has the Tools mark/);
});

test('Web off: a link, a web address or "search the web" is said under the answer; an ordinary message is not', () => {
  assert.equal(asksForWeb('What does https://some-site.com/page say?'), 'https://some-site.com/page');
  assert.equal(asksForWeb('Have a look at www.some-site.com.'), 'www.some-site.com');
  assert.equal(asksForWeb('Can you search the web for llama.cpp b12250?'), 'the web');
  assert.equal(asksForWeb('What is the capital of France?'), '');
  // A bare domain, as typed in a chat: it needs Web on too.
  assert.equal(asksForWeb('please scan shop.com.au for rude words'), 'shop.com.au');
  assert.equal(asksForWeb('Read some-site.org/page.'), 'some-site.org/page');
  assert.equal(asksForWeb('is llama.cpp b12250 faster? see package.json and index.html'), '');
  assert.equal(asksForWeb('mail me at someone@example.com'), '');
  // Words and code that only look like addresses open nothing.
  for (const text of ['I use ASP.NET daily', 'try socket.io for it', 'the Slack.app icon', 'a song.au file', 'version v1.2.co is out', 'at the end.Co of it', 'it.Com was odd', 'call this.app.listen(3000)', 'write to me.co@gmail.com', 'Fix it.Then run it', 'see https://example.com.', 'and www.example.com, too']) assert.equal(asksForWeb(text), '', text);
  assert.equal(asksForWeb('is shop.com.au safe? yes.'), 'shop.com.au');
  // A placeholder address inside an example (a coding request that shows a link) opens nothing.
  assert.equal(asksForWeb('handle [links](https://example.com) and http://localhost:8080/x in the converter'), '');
  assert.equal(asksForWeb('read https://example.com.au/page please'), 'https://example.com.au/page');
  assert.match(webOffWords('scan shop.com.au'), /^Web is off in this chat, so shop.com.au was not opened/);
  assert.match(webOffWords('read https://some-site.com'), /^Web is off in this chat, so https:\/\/some-site\.com was not opened/);
  assert.match(webOffWords('look it up online please'), /nothing was looked up on the web/);
  assert.equal(webOffWords('Write a poem about bread.'), '');
});

test('an unanswered permit card: a time limit, a plain message, then a no', () => {
  assert.equal(PERMIT_WAIT_MS, 5 * 60_000);
  assert.match(permitTimedOut('web'), /^No answer came to the question about the web within 5 minutes, so it was taken as a no/);
  assert.match(permitTimedOut('files', 60_000), /within 1 minute,/);
});

test('the chat sends them and the page draws them', () => {
  const chat = read('src/server/chat.ts');
  assert.match(chat, /setTimeout\(\(\) => \{\s+const words = permitTimedOut\(kind\);[\s\S]{0,200}send\('permit-end'[\s\S]{0,40}done\('no'\);\s+\}, PERMIT_WAIT_MS\)/);
  assert.match(chat, /webOffWords\(message\)/);
  assert.match(chat, /send\('tools', toolsNotice\(/);
  const view = read('public/chatview.js');
  assert.match(view, /ev === 'permit-end'/);
  assert.match(view, /ev === 'tools' && app\.toolsNotice/);
  assert.match(view, /If nobody answers within/);
  const crash = read('public/crash.js');
  assert.match(crash, /app\.toolsNotice = /);
  assert.match(crash, /app\.permitEnded = /);
});
