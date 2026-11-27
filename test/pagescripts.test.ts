import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syntaxCheck } from '../src/checks.ts';

// Every script the pages load must parse: one broken script (a stray quote in a string) stops that whole file, so
// whatever it sets up (the PC window, a panel) silently does nothing when pressed.
test('every page script (public/*.js, public/bridge/js/*.js) parses', async () => {
  const root = join(import.meta.dirname, '..');
  const files: { path: string; text: string }[] = [];
  for (const dir of ['public', 'public/bridge/js']) {
    for (const name of await readdir(join(root, dir))) {
      if (name.endsWith('.js')) files.push({ path: `${dir}/${name}`, text: await readFile(join(root, dir, name), 'utf8') });
    }
  }
  assert.ok(files.length > 10);
  const bad = (await syntaxCheck(files)).filter(r => !r.ok);
  assert.deepEqual(bad.map(r => `${r.path}: ${r.message}`), []);
});
