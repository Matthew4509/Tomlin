// Chat previews (his idea, 22 Oct): a picture of a project's running site beside its chats in a person's window. One
// picture a "day" (a day starts at the first use after a 5-hour gap), taken in the background by the first message
// sent that day in a chat of that project, only when its site is already running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS, Previews, cleanDay, freshDay, previewMode, used, wantsTake, type Pictures } from '../src/previews.ts';

const H = 3600_000;
const T0 = Date.UTC(2026, 9, 22, 9);

test('a day starts at the first use after a 5-hour gap, not at midnight', () => {
  assert.equal(GAP_MS, 5 * H);
  let s = used(freshDay(), T0);
  assert.equal(s.day, T0, 'the first use ever starts a day');
  // Working till 2 am: midnight passes with uses every hour, so no new day.
  for (let h = 1; h <= 17; h++) s = used(s, T0 + h * H);
  assert.equal(s.day, T0);
  // Back at 9 am after 7 hours: a new day.
  const back = T0 + 24 * H;
  s = used(s, back);
  assert.equal(s.day, back);
  assert.equal(s.last, back);
  // A 4-hour break is not a new day.
  s = used(s, back + 4 * H);
  assert.equal(s.day, back);
});

test('one picture per project per day: none twice the same day, one the next', () => {
  let s = used(freshDay(), T0);
  assert.equal(wantsTake(s, 'bakery'), true);
  s = { ...s, taken: { bakery: T0 + 60_000 } };
  assert.equal(wantsTake(s, 'bakery'), false, 'already taken today');
  assert.equal(wantsTake(s, 'shop'), true, 'another project still takes its own');
  s = used(s, T0 + 12 * H);
  assert.equal(wantsTake(s, 'bakery'), true, 'a new day takes a new one');
});

test('a kept day that is not a day is read as a fresh one', () => {
  assert.deepEqual(cleanDay(null), freshDay());
  assert.deepEqual(cleanDay({ last: 'x', day: -1, taken: { a: 5, b: 'no', '': 3 } }), { last: 0, day: 0, taken: { a: 5 } });
});

test('which chats get a picture: a project chat yes, a consult chat never, an artist chat only after Show preview', () => {
  assert.equal(previewMode({ project: 'bakery' }, false), 'show');
  assert.equal(previewMode({}, false), 'none', 'no project: no preview, no space kept');
  assert.equal(previewMode({ project: '' }, true), 'none');
  assert.equal(previewMode({ project: 'bakery' }, true), 'hidden', 'an artist chat: off until Show preview');
});

/** A stand-in for the Bridge: one site folder per project, running or not, and every take counted. */
function fakePictures(running: Set<string>) {
  const takes: string[] = [];
  const at = new Map<string, number>();
  const pics: Pictures = {
    folderOf: async p => (p === 'nosite' ? null : `C:\\ws\\${p}`),
    find: dir => ({ at: at.get(dir) ?? null, icon: dir.endsWith('bakery') }),
    take: async dir => {
      if (![...running].some(p => dir.endsWith(p))) return { ok: false, running: false };
      takes.push(dir);
      at.set(dir, T0 + takes.length);
      return { ok: true, running: true };
    },
  };
  return { pics, takes };
}

test('the first message of the day takes one picture in the background; a second chat of that project takes none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-previews-'));
  try {
    const { pics, takes } = fakePictures(new Set(['bakery']));
    let now = T0;
    const p = new Previews(join(dir, 'previews.json'), pics, () => now);
    await p.use();
    assert.equal(await p.firstMessage('bakery'), 'taken');
    assert.equal(await p.firstMessage('bakery'), 'not today', 'a second message (or chat) the same day');
    assert.deepEqual(takes, ['C:\\ws\\bakery']);
    // The next day (after a night), one more.
    now += 10 * H;
    await p.use();
    assert.equal(await p.firstMessage('bakery'), 'taken');
    assert.equal(takes.length, 2);
    // Kept on disk: a restart is not a gap and knows today's picture was taken.
    const again = new Previews(join(dir, 'previews.json'), pics, () => now + 60_000);
    await again.use();
    assert.equal(await again.firstMessage('bakery'), 'not today');
    const kept = JSON.parse(await readFile(join(dir, 'previews.json'), 'utf8'));
    assert.equal(kept.day, now);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no picture when the site is not running (tried again on a later message) or the project has no site folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-previews-'));
  try {
    const running = new Set<string>();
    const { pics, takes } = fakePictures(running);
    const p = new Previews(join(dir, 'previews.json'), pics, () => T0);
    await p.use();
    assert.equal(await p.firstMessage('shop'), 'not running');
    assert.equal(await p.firstMessage('nosite'), 'no site');
    assert.equal(takes.length, 0, 'never starts a site for a picture');
    running.add('shop');
    assert.equal(await p.firstMessage('shop'), 'taken', 'started later that day: the next message takes it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a picture that fails to come out is not tried again that day (no Edge started on every message)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-previews-'));
  try {
    let tries = 0;
    const pics: Pictures = { folderOf: async () => 'C:\\ws\\bakery', find: () => null, take: async () => { tries++; return { ok: false, running: true }; } };
    const p = new Previews(join(dir, 'previews.json'), pics, () => T0);
    await p.use();
    assert.equal(await p.firstMessage('bakery'), 'failed');
    assert.equal(await p.firstMessage('bakery'), 'not today');
    assert.equal(tries, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the window reads each project\'s picture time and icon; a project with no site folder has none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-previews-'));
  try {
    const { pics } = fakePictures(new Set(['bakery']));
    const p = new Previews(join(dir, 'previews.json'), pics, () => T0);
    await p.use();
    await p.firstMessage('bakery');
    assert.deepEqual(await p.view(['bakery', 'shop', 'nosite']), { bakery: { at: T0 + 1, icon: true }, shop: { at: null, icon: false } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wired in: a message in a project chat asks for the picture without waiting, the window draws it, artists get Show preview', () => {
  const chat = readFileSync(new URL('../src/server/chat.ts', import.meta.url), 'utf8');
  assert.match(chat, /void previewsTake\(openChat0\.project\)/);
  const people = readFileSync(new URL('../src/server/people.ts', import.meta.url), 'utf8');
  assert.match(people, /'\/api\/previews\/picture'/);
  assert.match(people, /previews: await previewsView\(/);
  const page = readFileSync(new URL('../public/chats.js', import.meta.url), 'utf8');
  assert.match(page, /Show preview/);
  assert.match(page, /picture from /);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="person-chats-show"/);
  assert.match(html, /id="preview-big"/);
});
