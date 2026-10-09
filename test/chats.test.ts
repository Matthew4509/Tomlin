// Chats: one file per conversation, listed newest first, titled from the first message; the old one-file-per-person
// chats move in once; deleting a chat takes its pictures with it, or leaves them under "All chats".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chats, NEW_TITLE, chatQuery, cleanTitle, describe, namedChat, oldChats, subjectFor, titleFrom, whoKind, type ChatInfo } from '../src/chats.ts';
import { Store, type ChatLine } from '../src/store.ts';
import { Gallery, type Picture } from '../src/gallery.ts';

const line = (role: 'user' | 'assistant', content: string, at = '2026-10-03T10:00:00.000Z'): ChatLine => ({ role, content, at });

test('a title comes from the first message: one line, cut at a word', () => {
  assert.equal(titleFrom('  Write a blog\n post about tuning a piano '), 'Write a blog post about tuning a piano');
  const long = titleFrom('Write a 500 word blog post about why a piano goes out of tune in winter and summer');
  assert.ok(long.endsWith('…') && long.length <= 49, long);
  assert.ok(!/\s…$/.test(long));
  assert.equal(titleFrom('   '), NEW_TITLE);
});

test('the title is set by the first message he typed, and never changed after he names it', () => {
  const c = { id: 'a'.repeat(12), who: 'manager', title: NEW_TITLE, created: 't0', updated: 't0', messages: 0 };
  const one = describe(c, [line('user', 'Piano blog'), line('assistant', 'Sure')], 't1');
  assert.deepEqual([one.title, one.messages, one.updated], ['Piano blog', 2, 't1']);
  assert.equal(describe(one, [line('user', 'Something else')], 't2').title, 'Piano blog');
  assert.equal(describe({ ...c, title: 'Mine', named: true }, [line('user', 'Piano blog')]).title, 'Mine');
  // A refused message is not a title.
  assert.equal(describe(c, [{ ...line('user', 'bad words'), refused: true }]).title, NEW_TITLE);
});

test('who a chat is with', () => {
  assert.equal(whoKind('standard'), 'manager');
  assert.equal(whoKind('friend'), 'manager');
  assert.equal(whoKind('staff:rowan'), 'staff:rowan');
  // The private chat was taken out: its old "who" reads as the manager, and its old one-file chat never moves in.
  assert.equal(whoKind('partner'), 'manager');
  assert.deepEqual(oldChats(['chat.json', 'chat-staff-rowan.json', 'chat-partner.json', 'settings.json', 'chat-staff-../x.json']).map(x => x.who), ['manager', 'staff:rowan']);
});

test('a new subject: the same name with the same person opens that chat; an empty open chat takes the name; else a new chat', () => {
  const at = '2026-10-05T10:00:00.000Z';
  const info = (id: string, who: string, title: string, messages = 0, named = false): ChatInfo => ({ id, who, title, created: at, updated: at, messages, ...(named ? { named } : {}) });
  const list = [info('a1', 'staff:dana', 'Blog photos', 4, true), info('b2', 'staff:dana', NEW_TITLE), info('c3', 'staff:rowan', 'Icons', 2, true), info('d4', 'staff:rowan', NEW_TITLE)];
  assert.deepEqual(subjectFor(list, 'staff:dana', 'blog PHOTOS', 'b2'), { chat: list[0], existed: true });
  // Another person's subject of that name is theirs: not opened from here.
  assert.equal(subjectFor(list, 'staff:dana', 'Icons', 'c3'), null);
  assert.deepEqual(subjectFor(list, 'staff:dana', 'Logo ideas', 'b2'), { chat: list[1], existed: false });
  // The empty chat open now is someone else's, or has lines: a new chat is made.
  assert.equal(subjectFor(list, 'staff:dana', 'Logo ideas', 'd4'), null);
  assert.equal(subjectFor(list, 'staff:rowan', 'Logo ideas', 'c3'), null);
  // A subject belongs to its project: the same name with the same person in another project is another chat.
  const inShop = [{ ...info('e5', 'staff:dana', 'Blog photos', 3, true), project: 'shop' }, ...list];
  assert.deepEqual(subjectFor(inShop, 'staff:dana', 'Blog photos', '', 'shop'), { chat: inShop[0], existed: true });
  assert.deepEqual(subjectFor(inShop, 'staff:dana', 'Blog photos', ''), { chat: list[0], existed: true });
  assert.equal(subjectFor(inShop, 'staff:dana', 'Blog photos', '', 'garden'), null);
  assert.equal(cleanTitle('  icons\n for   the  shop '), 'icons for the shop');
  assert.equal(cleanTitle('x'.repeat(100)).length, 80);
  assert.equal(cleanTitle(undefined), '');
});

test('chats: make, list newest first, save, rename, delete; the old files move in once and stay where they were', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-chats-'));
  try {
    const store = new Store(dir);
    await store.saveChat([line('user', 'Hello manager', '2026-10-01T09:00:00.000Z'), line('assistant', 'Hi', '2026-10-01T09:00:05.000Z')], 'chat.json');
    await store.saveChat([line('user', 'Fix my code', '2026-10-02T09:00:00.000Z')], 'chat-staff-rowan.json');
    await store.saveChat([], 'chat-partner.json');
    const chats = new Chats(store);
    store.onChatSaved = (f, l) => chats.saved(f, l);
    const moved = await chats.moveOld(await readdir(dir));
    assert.deepEqual(moved.map(c => [c.who, c.title, c.messages]).sort(), [['manager', 'Hello manager', 2], ['staff:rowan', 'Fix my code', 1]]);
    assert.ok(existsSync(join(dir, 'chat.json')), 'the old file is left alone');
    // A second start moves nothing again.
    assert.deepEqual(await new Chats(store).moveOld(await readdir(dir)), []);
    assert.deepEqual((await chats.list()).map(c => c.title), ['Fix my code', 'Hello manager']);

    const piano = await chats.create('manager');
    await store.saveChat([line('user', 'Piano blog post', new Date().toISOString())], chats.file(piano.id));
    assert.equal((await chats.list())[0].title, 'Piano blog post');
    assert.equal((await chats.latestFor('manager'))?.id, piano.id);
    assert.equal((await chats.lines(piano.id)).length, 1);
    assert.equal((await chats.rename(piano.id, '  Piano   blog  '))?.title, 'Piano blog');
    assert.equal(await chats.rename(piano.id, '   '), null);

    // A fresh reader sees the same list (it is on disk).
    assert.deepEqual((await new Chats(store).list()).map(c => c.title), ['Piano blog', 'Fix my code', 'Hello manager']);
    assert.ok(await chats.remove(piano.id));
    assert.ok(!existsSync(join(dir, 'chats', `${piano.id}.json`)));
    assert.equal(await chats.get(piano.id), null);
    assert.throws(() => chats.file('../settings'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chats the removed private chat left in the list are never listed or opened; their files stay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-chats-left-'));
  try {
    const store = new Store(dir);
    const at = '2026-10-04T10:00:00.000Z';
    await mkdir(join(dir, 'chats'), { recursive: true });
    await writeFile(join(dir, 'chats', 'index.json'), JSON.stringify([
      { id: 'aaaaaaaaaaaa', who: 'staff:rowan', title: 'Fix my code', created: at, updated: at, messages: 1 },
      { id: 'bbbbbbbbbbbb', who: 'partner', title: 'Hers', created: at, updated: at, messages: 2 },
    ]));
    await writeFile(join(dir, 'chats', 'bbbbbbbbbbbb.json'), '[]');
    const chats = new Chats(store);
    assert.deepEqual((await chats.list()).map(c => c.id), ['aaaaaaaaaaaa']);
    assert.equal(await chats.get('bbbbbbbbbbbb'), null);
    assert.equal(await chats.latestFor('partner'), null);
    // Writing the list again (a new chat) keeps her row in the file, untouched.
    await chats.create('staff:rowan');
    assert.ok(existsSync(join(dir, 'chats', 'bbbbbbbbbbbb.json')));
    assert.match(await readFile(join(dir, 'chats', 'index.json'), 'utf8'), /bbbbbbbbbbbb/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const pic = (id: string, chat?: string): Picture => ({
  id, at: '2026-10-03T10:00:00.000Z', prompt: `picture ${id}`, modelPrompt: '', negative: '', mode: 'blog', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1,
  sampler: 'lcm', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1,
  draft: false, original: `2026-10/${id}-o.png`, output: `2026-10/${id}.png`, format: 'png', bytes: 1, kept: true, ...(chat ? { chat } : {}),
});

test('each chat shows only its own pictures; deleting a chat deletes them or leaves them under All chats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-chatpics-'));
  try {
    await mkdir(join(dir, '2026-10'), { recursive: true });
    const g = new Gallery(dir);
    for (const p of [pic('p1', 'piano0000001'), pic('p2', 'piano0000001'), pic('s1', 'storage00001'), pic('old')]) {
      await writeFile(join(dir, p.output), 'x');
      await writeFile(join(dir, p.original), 'x');
      await g.add(p);
    }
    assert.deepEqual((await g.list(0, 60, 'all', '', 'piano0000001')).pictures.map(p => p.id).sort(), ['p1', 'p2']);
    assert.deepEqual((await g.list(0, 60, 'all', '', 'storage00001')).pictures.map(p => p.id), ['s1']);
    assert.equal((await g.list(0, 60, 'all')).total, 4, 'no chat given: every picture');
    assert.deepEqual(await g.countByChat(), { piano0000001: 2, storage00001: 1 });

    assert.equal(await g.forgetChat('storage00001', false), 1);
    assert.equal((await g.list(0, 60, 'all', '', 'storage00001')).total, 0);
    assert.equal((await g.list(0, 60, 'all')).total, 4, 'kept pictures stay under All chats');

    assert.equal(await g.forgetChat('piano0000001', true), 2);
    assert.ok(!existsSync(join(dir, '2026-10', 'p1.png')));
    assert.equal((await g.list(0, 60, 'all')).total, 2);
    // Read again from disk: the same.
    assert.equal((await new Gallery(dir).list(0, 60, 'all')).total, 2);
    assert.equal((await new Gallery(dir).get('s1'))?.chat, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a setting left on the removed private chat opens as Standard; its pictures are never listed or served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-left-'));
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ who: 'partner' }));
    assert.equal((await new Store(dir).settings()).who, 'standard');
    const g = new Gallery(join(dir, 'images'));
    await mkdir(join(dir, 'images', '2026-10'), { recursive: true });
    for (const p of [pic('plain'), { ...pic('hers'), private: true }]) {
      await writeFile(join(dir, 'images', p.output), 'x');
      await g.add(p);
    }
    assert.deepEqual((await g.list(0, 60, 'all')).pictures.map(p => p.id), ['plain']);
    assert.equal(await g.file('2026-10/hers.png'), null);
    assert.ok(await g.file('2026-10/plain.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every send names its chat: an id, or a person for a new chat; one naming nothing is refused', () => {
  assert.deepEqual(namedChat({ chatId: 'c1', who: 'staff:maya' }), { id: 'c1' });
  assert.deepEqual(namedChat({ chatId: '', who: 'staff:maya' }), { who: 'staff:maya' });
  // The host's plain ways of talking are all the host's chat.
  assert.deepEqual(namedChat({ chatId: '', who: 'friend' }), { who: 'manager' });
  assert.ok('error' in namedChat({}), 'no chatId at all');
  assert.ok('error' in namedChat({ chatId: 7 }));
  assert.ok('error' in namedChat({ chatId: '' }), 'a new chat with nobody named');
  assert.ok('error' in namedChat({ chatId: 'x'.repeat(81) }));
  // Continue, Empty and the like need a chat that exists already.
  assert.ok('error' in namedChat({ chatId: '', who: 'staff:maya' }, false));
  assert.deepEqual(namedChat({ chatId: 'c1' }, false), { id: 'c1' });
});

test('a chat named in an address reads as one named in a body; an address naming none is refused', () => {
  assert.deepEqual(namedChat(chatQuery(new URLSearchParams('chat=c1'))), { id: 'c1' });
  assert.deepEqual(namedChat(chatQuery(new URLSearchParams('chat=&who=staff%3Amaya'))), { who: 'staff:maya' });
  assert.deepEqual(chatQuery(new URLSearchParams('chat=&who=manager&plain=friend')), { chatId: '', who: 'manager', plain: 'friend' });
  // No ?chat at all: the server's open chat is whichever window opened one last, so nothing is guessed.
  assert.ok('error' in namedChat(chatQuery(new URLSearchParams(''))));
  assert.ok('error' in namedChat(chatQuery(new URLSearchParams('who=staff%3Amaya'))));
});
