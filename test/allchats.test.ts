// All chats (See all in Recent chats): a page with search, Project and Staff filters and a tile for each chat; each
// chat keeps its first message's first 100 characters for the tile's hover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chats, describe, previewOf, PREVIEW_CHARS } from '../src/chats.ts';
import { Store } from '../src/store.ts';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('a chat keeps its first message, its first 100 characters on one line (a refused one is skipped)', () => {
  const long = `Write   a\nshort note ${'x'.repeat(200)}`;
  assert.equal(previewOf([{ role: 'user', content: 'bad', refused: true } as never, { role: 'user', content: long } as never]), `Write a short note ${'x'.repeat(200)}`.slice(0, PREVIEW_CHARS));
  assert.equal(previewOf([]), '');
  const info = describe({ id: 'a', who: 'manager', title: 'Untitled chat', created: '2026-11-25T00:00:00Z', updated: '2026-11-25T00:00:00Z', messages: 0 }, [{ role: 'user', content: 'hi there' } as never]);
  assert.equal(info.preview, 'hi there');
});

test('chats saved before previews were kept get theirs from their file, once', async () => {
  const dir = await mkdtempP(join(tmpdir(), 'tomlin-allchats-'));
  try {
    const store = new Store(dir);
    const chats = new Chats(store);
    const c = await chats.create('manager');
    const lines = [{ role: 'user', content: 'How big is a forklift?' }, { role: 'assistant', content: 'About...' }] as never[];
    await store.saveChat(lines, chats.file(c.id));
    await chats.saved(chats.file(c.id), lines);
    const kept = (await chats.list()).find(x => x.id === c.id)!;
    assert.equal(kept.preview, 'How big is a forklift?');
    delete kept.preview;
    await chats.fillPreviews();
    assert.equal((await new Chats(new Store(dir)).list()).find(x => x.id === c.id)!.preview, 'How big is a forklift?', 'filled and written');
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
});

test('See all opens the All chats page: search, Project, Staff, then tiles that open the chat and show the first message on hover', () => {
  const html = read('index.html');
  const page = html.slice(html.indexOf('id="allchats-page"'), html.indexOf('</section>', html.indexOf('id="allchats-page"')));
  assert.match(page, /<h2 id="allchats-title">All chats<\/h2>/);
  assert.match(page, /id="allchats-search" type="search"/);
  assert.match(page, /<span>Project<\/span><select id="allchats-project"><\/select>/);
  assert.match(page, /<span>Staff<\/span><select id="allchats-staff"><\/select>/);
  const js = read('chats.js');
  assert.match(js, /\$\('#rail-recent-all'\)\.addEventListener\('click', \(\) => app\.openAllChats\(\)\);/);
  // No message: "No message yet", or an artist's chat's pictures (chatMini, test/pictures1128-page.test.ts).
  assert.match(js, /title: c\.preview \? `\$\{c\.preview\}\$\{c\.preview\.length >= 100 \? '…' : ''\}` : chatMini\(c\)/);
  assert.match(js, /el\('span', \{ class: 'allchats-name', text: model \? `\$\{c\.name\} · \$\{model\}` : c\.name \}\)/);
  assert.match(js, /b\.addEventListener\('click', \(\) => openChat\(c\.id\)\);/);
  assert.match(read('home.js'), /allchats: '#allchats-page'/);
  assert.match(read('style.css'), /\.shell:not\(\[data-view="allchats"\]\) > #allchats-page/);
});

test('All chats has a Role filter: a whole kind (Text / coding, Images, Video) or one role, only those some chat has', () => {
  const html = read('index.html');
  assert.match(html, /<span>Role<\/span><select id="allchats-role"><\/select>/);
  const js = read('chats.js');
  assert.match(js, /const ROLE_KINDS = \[\['chat', 'Text \/ coding'\], \['image', 'Images'\], \['video', 'Video'\]\];/);
  assert.match(js, /if \(!roleMatches\(c, allUi\.role\)\) return false;/);
  assert.match(js, /\$\('#allchats-role'\)\.addEventListener\('change'/);
  // The match itself, run as the page runs it.
  const src = js.slice(js.indexOf('function roleMatches'), js.indexOf('\n}\n', js.indexOf('function roleMatches')) + 2);
  const roleMatches = new Function(`${src}; return roleMatches;`)() as (c: object, pick: string) => boolean;
  const writer = { roleId: 'writer', roleKind: 'chat' };
  const artist = { roleId: 'artist', roleKind: 'image' };
  const unknown = { roleId: '', roleKind: '' };
  assert.equal(roleMatches(writer, '*'), true);
  assert.equal(roleMatches(unknown, '*'), true, 'a chat whose role is not known shows under All roles');
  assert.equal(roleMatches(writer, 'kind:chat'), true);
  assert.equal(roleMatches(artist, 'kind:chat'), false);
  assert.equal(roleMatches(artist, 'kind:image'), true);
  assert.equal(roleMatches(writer, 'role:writer'), true);
  assert.equal(roleMatches(writer, 'role:coder'), false);
  assert.equal(roleMatches(unknown, 'kind:chat'), false);
});

test('New chat picks its project first (the open chat\'s to start with, + New project… makes one); Tools has no Create new subject', () => {
  const html = read('index.html');
  const dlg = html.slice(html.indexOf('<dialog id="new-chat"'), html.indexOf('</dialog>', html.indexOf('<dialog id="new-chat"')));
  assert.ok(dlg.indexOf('id="new-chat-where"') < dlg.indexOf('id="new-chat-people"'), 'Project sits above the people');
  assert.doesNotMatch(html, /Create new subject|id="subjects-new"|id="subject-name"/);
  const js = read('chats.js');
  assert.match(js, /drawNewChatProject\(pickUi\.next \?\? chatUi\.open\?\.project \?\? ''\);/);
  assert.match(js, /const r = await api\('\/api\/chats\/new', \{ who, plain: plainWho\(\), project \}\);/);
  assert.doesNotMatch(js, /subjects-new|subjectsSay/);
});

test('New chat\'s Project fold: closed by default with its line saying where the chat goes; tiles cut to 20 characters, Default first, + New project with a mini description', () => {
  const html = read('index.html');
  assert.match(html, /<details class="new-chat-where" id="new-chat-where">/);
  assert.match(html, /<span id="new-chat-where-sum">Project: Default<\/span>/);
  assert.match(html, /id="new-chat-pabout"/);
  assert.match(html, /id="project-new-about"/, 'the chat top bar\'s New project window asks for the description too');
  const js = read('chats.js');
  assert.match(js, /const projectShort = \(name, max = 20\) =>/);
  assert.match(js, /tile\('', 'Default',/);
  assert.match(js, /tile\(NEW_PROJECT, '\+ New project',/);
  assert.match(js, /api\('\/api\/projects\/create', \{ name: \$\('#new-chat-pname'\)\.value, about: \$\('#new-chat-pabout'\)\.value, fromChat: true \}\)/);
  assert.match(js, /\$\('#new-chat-where'\)\.open = store\('new-chat-where'\) === '1';/);
  assert.match(read('style.css'), /\.new-chat-projects \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});

test('Save on the whole chat goes to the workspace (its project), not the Downloads folder', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /api\('\/api\/chats\/save-whole', \{ id: app\.chatId, text \}\)/);
  assert.doesNotMatch(app, /in your Downloads folder/);
});

test('Delete on a chat that is already gone says so and offers only Close (no Delete left to press)', () => {
  const js = read('chats.js');
  assert.match(js, /if \(err\.status === 404\) return deletedAlready\(\);/);
  assert.match(js, /el\('h2', \{ id: 'del-title', text: 'Already deleted' \}\)/);
  assert.match(js, /return app\.chatNote\?\.\(`"\$\{c\.title\}" was already deleted\.`\);/);
});
