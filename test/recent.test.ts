// "Recent chats" in the left panel (the design chosen): one list where a project is one entry (its newest chat shown,
// one press opens all its chats) and a chat in no project is its own entry; latest use first, pinned on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chats, recentEntries } from '../src/chats.ts';
import { Store } from '../src/store.ts';
import { cleanQuick } from '../src/project.ts';

const at = (h: number) => new Date(Date.UTC(2026, 9, 22, h)).toISOString();
const chat = (id: string, h: number, project = '', pinned = false) => ({ id, updated: at(h), ...(project ? { project } : {}), ...(pinned ? { pinned } : {}) });
const known = (p: string) => p === 'bakery' || p === 'shop';

test('a project is one entry: its newest chat shown, its chats newest first, its pinned ones on top', () => {
  const r = recentEntries([chat('blog', 9, 'bakery'), chat('html', 11, 'bakery'), chat('img', 10, 'bakery', true)], known, []);
  assert.equal(r.length, 1);
  const e = r[0];
  assert.equal(e.kind, 'project');
  if (e.kind !== 'project') return;
  assert.equal(e.project, 'bakery');
  assert.equal(e.newest, 'html', 'the most recent chat is the one shown');
  assert.deepEqual(e.chats, ['img', 'html', 'blog'], 'pinned first, then newest first');
  assert.equal(e.at, at(11));
});

test('projects and loose chats interleave by latest use, so 50 projects do not bury a recent loose chat', () => {
  const list = [chat('loose-new', 12), ...Array.from({ length: 50 }, (_, i) => chat(`p${i}`, i % 10, 'bakery')), chat('shop-1', 11, 'shop'), chat('loose-old', 1)];
  const r = recentEntries(list, known, []);
  assert.deepEqual(r.map(e => (e.kind === 'chat' ? e.id : e.project)), ['loose-new', 'shop', 'bakery', 'loose-old']);
  const bakery = r.find(e => e.kind === 'project' && e.project === 'bakery');
  assert.equal(bakery?.kind === 'project' ? bakery.chats.length : 0, 50, 'all of a project\'s chats are in its list');
});

test('pinned entries stay on top: a pinned project, a pinned loose chat, then the rest by latest use', () => {
  const list = [chat('a', 12), chat('b', 3, '', true), chat('j1', 1, 'bakery'), chat('s1', 10, 'shop')];
  const r = recentEntries(list, known, ['bakery']);
  assert.deepEqual(r.map(e => [e.kind === 'chat' ? e.id : e.project, e.pinned]), [['b', true], ['bakery', true], ['a', false], ['shop', false]]);
});

test('a chat whose project is gone (or never known) stands on its own', () => {
  const r = recentEntries([chat('x', 5, 'deleted-project'), chat('y', 6, 'bakery')], known, []);
  assert.deepEqual(r.map(e => e.kind), ['project', 'chat']);
  assert.equal(r[1].kind === 'chat' && r[1].id, 'x');
});

test('"+ New project…" from a chat: a name alone makes a project; Home still needs its prompt', () => {
  assert.deepEqual(cleanQuick({ name: '  Harbour   Bakery ' }, '2026-10-22-0900', true), { name: 'Harbour Bakery', folder: '2026-10-22-0900', about: '', prompt: '' });
  assert.ok('error' in cleanQuick({ name: 'Harbour Bakery' }, '2026-10-22-0900'), 'Home without a prompt is still refused');
  assert.ok('error' in cleanQuick({ name: '   ' }, '2026-10-22-0900', true), 'a name is needed');
});

test('pinned projects are kept on disk, once each, and can be unpinned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-recent-'));
  try {
    const chats = new Chats(new Store(dir));
    assert.deepEqual(await chats.pinnedProjects(), []);
    await chats.pinProject('bakery', true);
    await chats.pinProject('bakery', true);
    await chats.pinProject('shop', true);
    assert.deepEqual(await chats.pinnedProjects(), ['bakery', 'shop']);
    await chats.pinProject('bakery', false);
    assert.deepEqual(await new Chats(new Store(dir)).pinnedProjects(), ['shop'], 'read back from disk');
    await assert.rejects(() => chats.pinProject('../x', true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
