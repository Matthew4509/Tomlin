// A pack never carries a test runner's cache from node_modules: vitest's manifest holds the building PC's folder paths
// and its worktrees' names. Both slash kinds, as the pack sees Windows paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from '../src/update.ts';

const win = (p: string) => p.replaceAll('/', String.fromCharCode(92));

test('test runner caches in node_modules are left out of a pack, the packages beside them are not', () => {
  for (const p of ['/node_modules/.vitest-cache/_manifest-Tomlin.json', '/node_modules/.vitest-cache', '/node_modules/.vite/deps/x.js', '/node_modules/.cache/x']) {
    assert.equal(SKIP.test(p), true, p);
    assert.equal(SKIP.test(win(p)), true, win(p));
  }
  for (const p of ['/node_modules/sharp/lib/index.js', '/node_modules/vitest/package.json', '/src/server.ts', '/public/app.js']) {
    assert.equal(SKIP.test(p), false, p);
    assert.equal(SKIP.test(win(p)), false, win(p));
  }
});
