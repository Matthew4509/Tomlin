// Home: Recent projects as small tiles (name, then a mini description or the newest chat's subject) above the
// Project planner, which is the list that was called Recent projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Recent projects tiles sit above Project planner, which keeps the projects list under it', () => {
  const html = read('public/index.html');
  const tiles = html.indexOf('id="home-projects-box"');
  const planner = html.indexOf('id="home-ready-box"');
  assert.ok(tiles > 0 && tiles < planner);
  assert.match(html, /<h3 id="home-projects-title">Recent projects<\/h3>\s*<div class="proj-tiles" id="home-projects"><\/div>/);
  assert.match(html, /<h3 id="home-ready-title">Project planner<\/h3>\s*<div class="home-list" id="home-ready"><\/div>/);
});

test('a tile is a project with chats: its name, its description or its newest chat\'s subject; it opens that chat on the Project tab', () => {
  const js = read('public/homeview.js');
  const fn = js.slice(js.indexOf('function projectTiles()'), js.indexOf('app.drawProjectTiles = drawProjectTiles;'));
  assert.match(fn, /about: p\.about \|\| p\.goal \|\| newest\.get\(p\.id\)\.title \|\| ''/);
  assert.match(fn, /\.slice\(0, TILES_MOST\)/);
  assert.match(fn, /await app\.openChat\(t\.chat\);\s*\$\('#tab-project'\)\?\.click\(\);/);
  assert.match(read('public/chats.js'), /app\.drawProjectTiles\?\.\(\);/);
  const css = read('public/style.css');
  assert.match(css, /\.proj-tile-about \{ font-size: 12px;/);
});

test('the greeting has no "(you always do)", and a chat in Default says it is in Default', () => {
  assert.doesNotMatch(read('public/themewords.js'), /you always do/);
  assert.match(read('public/projecttab.js'), /This chat is in Default: no project of its own/);
});
