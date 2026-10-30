// Saved data on disk, attacked: files of the wrong shape, a byte-order mark, a chat deleted while it is being saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readData } from '../src/atomic.ts';
import { Store, type ChatLine } from '../src/store.ts';
import { Chats } from '../src/chats.ts';

async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sm-bd-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('settings.json of the wrong shape (null, remotes not a list, a null remote) still starts, with the rest kept', async () => {
  for (const body of ['null', '{"remotes":{},"managerName":"Bob"}', '{"remotes":[null,{"id":"a","name":"Lap","url":"http://x","token":"t"}],"managerName":"Bob"}']) {
    await inTemp(async dir => {
      await writeFile(join(dir, 'settings.json'), body);
      const s = await new Store(dir).settings();
      assert.ok(Array.isArray(s.remotes), body);
      if (body !== 'null') assert.equal(s.managerName, 'Bob', body);
      if (body.includes('Lap')) assert.deepEqual(s.remotes.map(r => r.name), ['Lap']);
    });
  }
});

test('a JSON file that starts with a byte-order mark (saved by Notepad or PowerShell) is read, not set aside', async () => {
  await inTemp(async dir => {
    await writeFile(join(dir, 'settings.json'), '\uFEFF{"managerName":"Bob","workspace":"D:\\\\work"}');
    const s = await new Store(dir).settings();
    assert.equal(s.managerName, 'Bob');
    assert.equal(s.workspace, 'D:\\work');
    assert.deepEqual(await readdir(dir), ['settings.json']);
    assert.deepEqual(await readData(join(dir, 'settings.json'), null), { managerName: 'Bob', workspace: 'D:\\work' });
  });
});

test('a chat list entry missing its times or with a title that is not words still lists, and keeps every chat', async () => {
  await inTemp(async dir => {
    await mkdir(join(dir, 'chats'));
    await writeFile(join(dir, 'chats', 'index.json'), JSON.stringify([
      { id: 'aaaaaaaaaaaa', who: 'manager', title: 'Old one', created: '2026-01-01T00:00:00.000Z', messages: 2 },
      { id: 'bbbbbbbbbbbb', who: 'manager', title: 5, messages: 1 },
      { id: 'cccccccccccc', who: 'manager', title: 'Fine', created: '2026-02-01T00:00:00.000Z', updated: '2026-02-01T00:00:00.000Z', messages: 1 },
    ]));
    const chats = new Chats(new Store(dir));
    const list = await chats.list();
    assert.deepEqual(list.map(c => c.id).sort(), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
    assert.ok(list.every(c => typeof c.title === 'string' && typeof c.updated === 'string' && typeof c.created === 'string'));
    await chats.create('manager');
    assert.equal((await chats.list()).length, 4);
  });
});

test('a chat deleted while a save of it is still being written stays deleted (its file does not come back)', async () => {
  await inTemp(async dir => {
    const store = new Store(dir);
    const chats = new Chats(store);
    store.onChatSaved = (f, l) => chats.saved(f, l);
    const c = await chats.create('manager');
    const file = chats.file(c.id);
    // A long chat, so its save is still being written when Delete comes.
    const big: ChatLine[] = Array.from({ length: 4000 }, (_, i) => ({ role: 'user', content: `line ${i} ${'x'.repeat(4000)}`, at: '' }));
    const saving = store.changeChat(file, () => big);
    await new Promise(r => setImmediate(r));
    store.chatEmptied(file);
    assert.equal(await chats.remove(c.id), true);
    await saving;
    assert.equal(existsSync(join(dir, file)), false);
    assert.equal(await chats.get(c.id), null);
  });
});
