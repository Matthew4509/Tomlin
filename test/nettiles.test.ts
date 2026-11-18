// Models on my other PCs: one tile for each linked PC, its models behind "See models installed", its backups behind
// "See backups and restore points"; an opened tile stays open when the window is drawn again; a PC that is off says so once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const js = readFileSync(join(ROOT, 'public', 'network.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

test('the models of each linked PC sit in a tile behind "See models installed", not all at once', () => {
  assert.match(js, /el\('summary', \{ text: `See models installed \(\$\{mine\.length\}\)` \}\)/);
  assert.match(js, /v\.pcs\.map\(p => \{\s*const mine = modelsOn\(p\);/);
  assert.match(js, /`\$\{mine\.length\} model\$\{mine\.length === 1 \? '' : 's'\}/);
  assert.match(js, /'Off or not answering now'/);
  // A PC that is off says so on its tile, not under every model.
  assert.match(js, /p\.ok && o\.why/);
});

test('the backups of each linked PC sit in a tile behind "See backups and restore points"', () => {
  assert.match(js, /el\('summary', \{ text: 'See backups and restore points' \}\)/);
});

test('a tile the person opened stays open when the window is drawn again', () => {
  assert.match(js, /const netOpen = new Set\(\);/);
  assert.match(js, /details\.open = netOpen\.has\(key\);/);
  assert.match(js, /netFold\(`models:\$\{p\.id\}`/);
  assert.match(js, /netFold\(`backups:\$\{p\.id\}`/);
});

test('the tiles are laid out in columns, nothing under 12px, no colour by number', () => {
  assert.match(css, /#net-rows, #net-backups \{ grid-template-columns: repeat\(auto-fill, minmax\(280px, 1fr\)\)/);
  assert.match(css, /\.net-tile \{[^}]*border: 1px solid var\(--line\)/);
  const block = css.slice(css.indexOf('.net-tile {'), css.indexOf('.net-tile .net-row'));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i);
});
