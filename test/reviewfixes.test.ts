// Four faults from the full walk of 10 November (docs/REVIEW-2026-11-10-FULL-WALK.md, B1 to B4): the permission card
// named "James" as "Jame"; a step that failed on a linked PC could not be run again (the kept fault came back); loading
// the picture model already loaded ended the picture being drawn; a failed answer left the card's buttons grey.
// Read from the files' own text (these places sit inside the running server and the page). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); // read as git keeps it (LF), whatever the checkout wrote

test('the permission card names the hire by their first name, cut at a space (not at the letter s)', () => {
  const chat = read('src/server/chat.ts');
  const line = chat.split('\n').find(l => l.includes("send('permit'")) ?? '';
  assert.match(line, /who: member \? member\.name\.split\(\/\\s\+\/\)\[0\]/);
  assert.doesNotMatch(chat, /\.split\(\/s\+\/\)/, 'no split on the letter s anywhere in the file');
  assert.equal('James Lee'.split(/\s+/)[0], 'James');
});

test('a fault a linked PC reports is taken from its outbox, so asking again runs the work again', () => {
  const links = read('src/jobrun/links.ts');
  const lost = links.indexOf('lostAt ||= Date.now();');
  const from = links.lastIndexOf('if (signal.aborted) throw new Error(\'Stopped.\');', lost);
  assert.ok(from > 0 && lost > from, 'the place where a read fails is found');
  const caught = links.slice(from, lost);
  // Before the fault is thrown on, that PC is told it has been read: it keeps it no longer (src/outbox.ts take).
  const said = caught.indexOf('The worker said');
  const taken = caught.indexOf("'/worker/taken'");
  assert.ok(said > 0, 'a fault from that PC is told apart from a lost connection');
  assert.ok(taken > said, 'and is taken before it is thrown on');
  assert.ok(caught.indexOf('throw e', taken) > taken);
});

test('loading a picture model while a picture is being drawn is refused, the loaded model too', () => {
  const panes = read('src/server/panes.ts');
  const line = panes.split('\n').find(l => l.includes('A picture is being drawn.')) ?? '';
  assert.match(line, /if \(pane === 'image' && images\.busy\(\)\) return json\(res, 409/);
  assert.doesNotMatch(line, /!held/);
  // Unload stays possible while drawing (it cancels the picture): the check sits after it.
  assert.ok(panes.indexOf("load[2] === 'unload'") < panes.indexOf('A picture is being drawn.'));
});

test('a permission answer that fails leaves the buttons pressable again', () => {
  const page = read('public/chatview.js');
  const from = page.indexOf("await api('/api/chat/permit', { chatId: streams.get(key)?.liveId ?? chatId, answer: a });\n              said.textContent");
  assert.ok(from > 0, 'the files and web card is found');
  const fails = page.slice(page.indexOf('} catch (err) {', from), page.indexOf('};', from));
  assert.match(fails, /said\.textContent = err\.message;/);
  assert.match(fails, /for \(const b of card\.querySelectorAll\('\.permit-answers button'\)\) b\.disabled = false;/);
});
