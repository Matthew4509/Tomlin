// A project's page: its chats by kind of work, and its work read from its folder by kind (src/projectwork.ts), opened
// from Home's Recent projects tiles and the Project tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORK_MOST, partOf, playPage, sortWork } from '../src/projectwork.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const f = (path: string, at = '2026-11-26T10:00:00.000Z', bytes = 10) => ({ path, at, bytes });

test('each file goes under its kind by where it is in the project folder; admin notes and tool files are left out', () => {
  assert.equal(partOf('index.html'), 'code');
  assert.equal(partOf('src/game.js'), 'code');
  assert.equal(partOf('specialists/images/2026-11-26-1530 bird.png'), 'pictures');
  assert.equal(partOf('specialists/writer/2026-11-26-1530 store page.md'), 'writing');
  assert.equal(partOf('specialists/videos/2026-11-26-1610 trailer.mp4'), 'videos');
  assert.equal(partOf('chats/2026-11-26-1530 Game loop.txt'), 'chats');
  assert.equal(partOf('Specialists\\Images\\a.png'), 'pictures');
  assert.equal(partOf('admin notes/2026-11-26 idea.md'), null);
  assert.equal(partOf('.gitignore'), null);
  assert.equal(partOf('node_modules/x/index.js'), null);
  assert.equal(partOf('.git/HEAD'), null);
});

test('newest first, a picture\'s source notes left out, at most WORK_MOST of each with how many more', () => {
  const w = sortWork([
    f('game.js', '2026-11-26T09:00:00.000Z'), f('index.html', '2026-11-26T11:00:00.000Z'),
    f('specialists/images/bird.png'), f('specialists/images/bird.png.source.json'),
    ...Array.from({ length: WORK_MOST + 5 }, (_, i) => f(`specialists/writer/${i}.md`)),
  ]);
  assert.deepEqual(w.code.map(x => x.path), ['index.html', 'game.js']);
  assert.deepEqual(w.pictures.map(x => x.path), ['specialists/images/bird.png']);
  assert.equal(w.writing.length, WORK_MOST);
  assert.equal(w.more.writing, 5);
  assert.equal(w.more.code, 0);
});

test('Play it: index.html at the top, or the only page at the top; none in a sub-folder only', () => {
  assert.equal(playPage([f('style.css'), f('index.html'), f('about.html')]), 'index.html');
  assert.equal(playPage([f('game.html'), f('game.js')]), 'game.html');
  assert.equal(playPage([f('a.html'), f('b.html')]), null);
  assert.equal(playPage([f('site/index.html')]), null);
});

test('the server lists a project\'s own folder only, and opens only folders it names', () => {
  const s = read('src/server/places.ts');
  const work = s.slice(s.indexOf("'/api/project/work'"), s.indexOf("'/api/project/handed'"));
  assert.match(work, /const folder = await projectFolder\(id\);/);
  assert.match(work, /if \(!folder\) return json\(res, 200, \{ id, name, folder: '', top: true,/);
  assert.match(work, /await ws\.filesUnder\(root, folder\)/);
  const open = s.slice(s.indexOf("'/api/project/open-folder'"), s.indexOf("'/api/images/open-folder'"));
  assert.match(open, /b\.part in PART_DIRS \? b\.part : null/);
  assert.match(open, /await ws\.inside\(root, `\$\{rel\}\/x`, false\)/);
  assert.doesNotMatch(open, /b\.path|b\.dir/);
});

test('the page: chats by kind, Code with View code and Play it, pictures as previews, writing, videos; opened from the tiles and the Project tab', () => {
  const html = read('public/index.html');
  assert.match(html, /<dialog id="pp-dlg" aria-labelledby="pp-title">/);
  assert.match(html, /<h3 id="pp-chats-title">Chats<\/h3><div id="pp-chats"><\/div>/);
  assert.match(html, /<h3 id="pp-work-title">Work<\/h3><div id="pp-work"><\/div>/);
  assert.ok(html.indexOf('<script src="projectpage.js"></script>') > html.indexOf('<script src="projecttab.js"></script>'));
  const js = read('public/projectpage.js');
  assert.match(js, /app\.projectGroups\?\.\(chatUi\.list \?\? \[\], p\.id\)/);
  assert.match(js, /part\('Code', /);
  assert.match(js, /part\('Pictures', 'specialists\\\\images\\\\'/);
  assert.match(js, /part\('Writing', 'specialists\\\\writer\\\\'/);
  assert.match(js, /part\('Videos', 'specialists\\\\videos\\\\'/);
  assert.match(js, /app\.openFileAt\?\.\(f\.path\)/);
  assert.match(js, /`\/preview\/\$\{ui\.preview\.key\}\//);
  assert.match(js, /app\.newChatIn\?\.\(p\.id\)/);
  assert.match(read('public/homeview.js'), /if \(app\.openProjectPage\) return app\.openProjectPage\(t\.id\);/);
  assert.match(read('public/projecttab.js'), /text: 'Project page'[^\n]*onclick: \(\) => app\.openProjectPage\?\.\(p\.id\)/);
  assert.match(read('public/chats.js'), /drawNewChatProject\(pickUi\.next \?\? chatUi\.open\?\.project \?\? ''\);/);
  assert.match(read('public/files.js'), /app\.openFileAt = async path => \{/);
  // 12px at the least.
  const css = read('public/style.css');
  const pp = css.slice(css.indexOf('dialog#pp-dlg {'), css.indexOf('dialog#upds-dlg {'));
  for (const m of pp.matchAll(/font-size: (\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
});
