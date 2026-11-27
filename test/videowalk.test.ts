// What the walk of the video screens found (phase 6 of the Videographer plan), held in the page's own files as
// test/videographer.test.ts does: the Make a clip button, the box's words and head in a Videographer's chat, the chat
// list after a clip, Send to with no linked PC, the network block in Hire staff for a Videographer, and first names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('Edit staff and All staff have Make a clip: the page opens a Videographer\'s latest chat (or a new one)', () => {
  const chats = read('public/chats.js');
  assert.match(chats, /app\.openVideographer = openLatestWith;/);
  assert.match(chats, /app\.openArtist = openLatestWith;/);
  // team.js shows the button only when app.openVideographer is there.
  assert.match(read('public/team.js'), /videoRole && !app\.openVideographer \? null/);
});

test('a Videographer\'s chat asks what the clip should show, even when nobody who chats is hired', () => {
  const view = read('public/homeview.js');
  const clip = view.indexOf("app.isClipChat?.() ? 'What should the clip show?");
  const nobody = view.indexOf("app.nobodyToTalkTo ? 'Hire someone first");
  assert.ok(clip > 0 && nobody > 0 && clip < nobody, 'the clip words come before "Hire someone first"');
});

test('a Videographer\'s chat head has no Connect, state or model settings: a clip loads its own model', () => {
  assert.match(read('public/clips.js'), /\$\('#pane-chat'\)\.classList\.toggle\('clip-chat', on\);/);
  const css = read('public/style.css');
  assert.match(css, /#pane-chat\.clip-chat > \.pane-head > \.state, #pane-chat\.clip-chat > \.pane-head \.connect, #pane-chat\.clip-chat > \.pane-head \.pane-settings \{ display: none; \}/);
  // The theme that renames Send still says what the button makes in a clip chat.
  assert.match(css, /#chat-form\.clip-chat #chat-send::after \{ content: "Absolutely, make the clip"; \}/);
});

test('the chat list is read again after Make clip, so the chat takes its name from the prompt', () => {
  assert.match(read('public/clips.js'), /\n\s+await app\.afterSend\?\.\(r\.chat, chatId, who\);/);
});

test('Send to on a video model says why when no other PC is linked', () => {
  const models = read('public/models.js');
  assert.match(models, /if \(!pcs\.length\) return mp\.net \? el\('p', \{ class: 'hint mp-send-none', text: 'Send to: no other PC is linked to this one yet\./);
});

test('Hire staff: the memory line fits the kind, and a Videographer on a linked PC can be sent a video model from here', () => {
  const html = read('public/index.html');
  assert.match(html, /<p class="hint" id="hs-models-hint">/);
  const hire = read('public/hire.js');
  assert.match(hire, /video: 'Graphics memory needed is an estimate\.'/);
  assert.match(hire, /\$\('#hs-models-hint'\)\.textContent = MEM_HINT\[kind\(\)\];/);
  // Keys as src/carry.ts modelKey makes them: video:<id>.
  assert.match(hire, /k === 'image' \|\| k === 'video' \? `\$\{k\}:\$\{id\}`/);
  // The linked PC's own reason it cannot take a video model now.
  assert.match(hire, /kind\(\) === 'video' \? net\?\.sendVideo \?\? net\?\.send : net\?\.send/);
  // Every one of this PC's video models is offered (a linked PC does not say which it has).
  assert.match(hire, /new Set\(video \? \[\] : onPc\(target\)\.map\(choiceKey\)\)/);
  assert.match(hire, /'Not on that PC: send it there'/);
  assert.match(hire, /'That PC does not say: update it to know'/);
});

test('a first name is the name up to the first space (a name with an s in it is not cut)', () => {
  for (const f of ['public/hire.js', 'public/team.js']) assert.doesNotMatch(read(f), /\.split\(\/s\+\/\)/, f);
  const first = (name: string) => name.split(/\s+/)[0];
  assert.equal(first('Susan Bell'), 'Susan');
});
