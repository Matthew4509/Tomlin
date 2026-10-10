import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PARTS } from '../src/update.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const page = readFileSync(join(ROOT, 'Welcome to TOMLIN.html'), 'utf8');

test('the welcome page ships at the top of the zip and works offline: nothing from the internet, every picture beside it', () => {
  assert.ok(PARTS.includes('Welcome to TOMLIN.html'));
  // No script, stylesheet, font or picture from anywhere else: it is opened from the unzipped folder.
  assert.doesNotMatch(page, /<script\b/i);
  assert.doesNotMatch(page, /\b(?:src|href)="(?:https?:)?\/\//i);
  assert.doesNotMatch(page, /@import|url\(\s*['"]?https?:/i);
  const pictures = [...page.matchAll(/\bsrc="([^"]+)"/g)].map(m => m[1]);
  assert.ok(pictures.length >= 5);
  for (const src of pictures) {
    assert.match(src, /^public\/help-[\w-]+\.webp$/, src);
    assert.ok(existsSync(join(ROOT, src)), src);
  }
  // Every in-page link goes somewhere on the page.
  for (const [, id] of page.matchAll(/href="#([\w-]+)"/g)) assert.match(page, new RegExp(`id="${id}"`), id);
});

test('Help: every picture it shows is in public/, and every "On this page" link has its section', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const help = html.slice(html.indexOf('id="help"'), html.indexOf('</section>', html.indexOf('id="help"')));
  const pictures = [...help.matchAll(/<img src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(pictures.length >= 10);
  // The page server serves flat names from public/ only (src/server/core.ts staticFile), WebP among its types.
  for (const src of pictures) assert.ok(/^[\w.-]+\.webp$/.test(src) && existsSync(join(ROOT, 'public', src)), src);
  assert.match(readFileSync(join(ROOT, 'src', 'server', 'core.ts'), 'utf8'), /'\.webp': 'image\/webp'/);
  for (const [, id] of help.matchAll(/data-help="([\w-]+)"/g)) assert.match(html, new RegExp(`id="${id}"`), id);
});
