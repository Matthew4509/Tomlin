// My PC window: a Permissions row (on or off and which are on; Change opens This PC at the ticks), and "This PC settings"
// in place of "Its settings (Network)". The menu's Permissions is "Chat permissions" (what a chat's model may do), its
// page title too, so it is not taken for the PC sharing permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const pcs = read('pcs.js');

test('the window has a Permissions row that opens the ticks on This PC, in the window only', () => {
  assert.match(pcs, /const perms = dlg\.open \? el\('div', \{ class: 'pc-perms-row' \}, el\('b', \{ text: 'Permissions' \}\), el\('span', \{ class: 'hint', id: 'pc-perms-said', text: permsWords\(sh\) \}\),/);
  assert.match(pcs, /text: 'Change', title: 'Opens This PC at the sharing and cluster permissions', onclick: \(\) => \{ dlg\.close\(\); app\.openSharePermissions\?\.\(\); \}/);
  assert.match(pcs, /here\.el\.replaceChildren\(\.\.\.\[title, roles, perms,/);
  // The ticks open on This PC.
  const home = read('home.js');
  const handler = home.slice(home.indexOf('app.openSharePermissions = async () => {'), home.indexOf('\n};', home.indexOf('app.openSharePermissions = async () => {')));
  assert.match(handler, /await openThisPc\(\);/);
  assert.doesNotMatch(handler, /openNodes\(\)|netSection/);
});

test('behaviour: the Permissions row says off for a PC that is not a node, else which ticks are on', () => {
  const src = pcs.slice(pcs.indexOf('  const PERM_WORDS = '), pcs.indexOf('  app.permsWords = permsWords;'));
  const permsWords = new Function(`${src}; return permsWords;`)() as (sh: unknown) => string;
  assert.equal(permsWords({ on: false, allow: { pull: true } }), 'Off: this PC is not a node, so linked PCs may do nothing here.');
  assert.equal(permsWords(null), 'Off: this PC is not a node, so linked PCs may do nothing here.');
  assert.equal(permsWords({ on: true, allow: { pull: true, backup: true, off: true, lend: false } }), 'On: 3 of 9 (share models, backups, turn this PC off).');
  assert.equal(permsWords({ on: true, allow: { off: false } }), 'On as a node, but every permission is off.');
});

test('"This PC settings" in the window; the menu line and its page are "Chat permissions"', () => {
  assert.match(html, /<button class="btn quiet" type="button" id="pc-more">This PC settings<\/button>/);
  assert.doesNotMatch(html, /Its settings \(Network\)/);
  assert.match(html, /data-setup="perms" data-about="Choose what a chat&#39;s model may do on its own\."><svg[^\n]*<\/svg>Chat permissions<\/button>/);
  assert.match(html, /id="settings-perms" data-crumb="Chat permissions"/);
  assert.match(html, /<h2 id="settings-perms-title">Chat permissions<\/h2>/);
  assert.match(read('chatview.js'), /Change it in Settings, Chat permissions\./);
});

test('Chat permissions is not Agents: one line on the page sends standing jobs\' tools to the Agents page', () => {
  assert.doesNotMatch(html, /Agent permissions/);
  assert.match(html, /<p class="hint perms-agents-line" id="perms-agents-line">Agents' standing jobs have their own tools, approved per job on the <button class="link" type="button" id="perms-agents-open">Agents<\/button> page\.<\/p>/);
  assert.match(read('agents.js'), /\$\('#perms-agents-open'\)\?\.addEventListener\('click', \(\) => app\.openAgents\(\{ back: 'perms' \}\)\);/);
  for (const f of ['../src/codetools.ts', '../src/screentools.ts', '../src/webtools.ts', '../public/help/topics.js', '../public/help/index.html']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /Agent permissions/, f);
});
