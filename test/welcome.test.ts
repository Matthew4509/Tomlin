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

test('Help: it is a folder of pages (test/help.test.ts checks them); every Help button in the app has a place there', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const help = html.slice(html.indexOf('id="help"'), html.indexOf('</section>', html.indexOf('id="help"')));
  assert.match(help, /<iframe id="help-frame"/);
  // The page server serves public/help/ and WebP among its types (src/server/core.ts staticFile).
  assert.match(readFileSync(join(ROOT, 'src', 'server', 'core.ts'), 'utf8'), /'\.webp': 'image\/webp'/);
  assert.ok(existsSync(join(ROOT, 'public', 'help', 'index.html')));
});
