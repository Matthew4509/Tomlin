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
  const info = describe({ id: 'a', who: 'manager', title: 'New chat', created: '2026-11-25T00:00:00Z', updated: '2026-11-25T00:00:00Z', messages: 0 }, [{ role: 'user', content: 'hi there' } as never]);
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
  assert.match(js, /title: c\.preview \? `\$\{c\.preview\}\$\{c\.preview\.length >= 100 \? '…' : ''\}` : 'No message yet'/);
  assert.match(js, /el\('span', \{ class: 'allchats-name', text: model \? `\$\{c\.name\} · \$\{model\}` : c\.name \}\)/);
  assert.match(js, /b\.addEventListener\('click', \(\) => openChat\(c\.id\)\);/);
  assert.match(read('home.js'), /allchats: '#allchats-page'/);
  assert.match(read('style.css'), /\.shell:not\(\[data-view="allchats"\]\) > #allchats-page/);
});
