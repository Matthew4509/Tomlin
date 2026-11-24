// Many staff: a page asks for every hire's model at once, and each read of the model lists checks every model file on
// disk. 1,000 hires took Home 28 seconds and stopped the server answering anything else. The lists are read once per
// turn of the event loop (src/server/people.ts modelsHere), and hiring stops at 99 (src/staff.ts MAX_STAFF).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('a hire\'s model reads the model lists once per turn, not once per hire', () => {
  const js = read('src/server/people.ts');
  assert.match(js, /const here = modelsHere\(picture\);/);
  assert.match(js, /if \(!hereNow\) \{\n\s+hereNow = \{\};\n\s+setImmediate\(\(\) => \{ hereNow = null; \}\);/);
  assert.doesNotMatch(js.slice(js.indexOf('export function hireModelOf')), /^\s+\? images\.list\(\)\.filter\(x => x\.installed\)/m, 'not read again inside hireModelOf');
});

test('hiring stops at 99 staff, with words that say why and what to do', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Staff, MAX_STAFF } = await import('../src/staff.ts');
  assert.equal(MAX_STAFF, 99);
  const dir = mkdtempSync(join(tmpdir(), 'manystaff-'));
  try {
    const s = await Staff.load(dir);
    for (let i = 0; i < MAX_STAFF; i++) await s.hire(`Person ${i}`, 'default', 'default');
    assert.equal(s.list().length, 99);
    await assert.rejects(s.hire('One more', 'default', 'default'), /^Error: 99 staff is the most TOMLIN keeps\. Fire someone before hiring another\.$/);
    assert.equal(s.list().length, 99, 'nothing added');
    await s.fire(s.list()[0].id);
    await s.hire('One more', 'default', 'default');
    assert.equal(s.list().length, 99, 'one fired, one hired');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Getting started goes once there is a hire, a model and one chat a model answered', () => {
  const view = read('public/homeview.js');
  assert.match(view, /\$\('#home-start'\)\.hidden = !!\(u\.staff && \(u\.chatModels \|\| u\.imageModels \|\| u\.pcs\) && u\.answered\);/);
  const team = read('src/server/team.ts');
  assert.match(team, /setup: \{ answered: await answeredOnce\(\),/);
  assert.match(team, /l\.role === 'assistant' && !l\.failed && !l\.refused && !l\.waiting && !!l\.content\.trim\(\)/, 'a real answer: not failed, refused or waiting');
});

test('All chats draws 60 tiles, then 60 more as the end scrolls into view; dates use two formatters made once', () => {
  const js = read('public/chats.js');
  assert.match(js, /const ALL_PAGE = 60;/);
  assert.match(js, /\.\.\.hits\.slice\(0, allUi\.shown\)\.map\(tile\), more\]/);
  assert.match(js, /app\.openAllChats = \(\) => \{\n\s+allUi\.shown = ALL_PAGE;/);
  const home = read('public/home.js');
  assert.match(home, /return \(today \? TIME_ONLY : DAY_TIME\)\.format\(d\);/);
});

test('New chat opens at once with the people known, reads fresh after; a search box past 6 staff', () => {
  const js = read('public/chats.js');
  assert.match(js, /if \(!chatUi\.people\.length\) await loadChats\(\);\n\s+drawPeople\(\);\n\s+if \(!\$\('#new-chat'\)\.open\) \$\('#new-chat'\)\.showModal\(\);/);
  assert.match(js, /\$\('\.new-chat-find'\)\.hidden = chatUi\.people\.length <= 6;/);
  assert.match(read('public/index.html'), /<input id="new-chat-search" type="search"/);
});
