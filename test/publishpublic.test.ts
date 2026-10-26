import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ACCEPTED, DROP, keyShaped, publicContext } from '../tools/publish-public.ts';

// Every folder made here is removed when the file ends.
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tomlin-publish-'));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('the public copy is checked against the other projects beside it, not tool or scratch folders', () => {
  const projects = tmp();
  for (const d of ['Mine', 'harbour bakery', '.claude', '.agents', '--help', '_unpack-log']) mkdirSync(join(projects, d));
  writeFileSync(join(projects, 'notes.md'), 'a file, not a project');
  const list = join(projects, 'private.json');
  writeFileSync(list, JSON.stringify({ details: [{ id: 'a', label: 'a made-up email', value: 'zebedee@example.org' }] }));
  const ctx = publicContext(join(projects, 'Mine'), list);
  assert.deepEqual(ctx.others, ['harbour bakery']);
  assert.deepEqual(ctx.own, ['Mine', 'TOMLIN']);
  assert.equal(ctx.privateCount, 1);
  assert.ok(ctx.details.some(d => d.label === 'a made-up email'));
  assert.ok(ctx.details.some(d => d.label === 'your home folder'));
  // A short user name is looked for only as part of the home folder (audit D21); a longer one on its own as well.
  assert.equal(ctx.details.some(d => d.label === 'your user name on this PC'), userInfo().username.length >= 6);
  assert.equal(publicContext(join(projects, 'Mine'), join(projects, 'none.json')).privateCount, 0);
});

test('key-shaped strings are found in text files, not in pictures', () => {
  const d = tmp();
  // Spelled in parts so this file is not a hit itself.
  const key = 'gh' + 'p_' + 'A'.repeat(36);
  writeFileSync(join(d, 'a.js'), `const x = 1;\nconst token = '${key}';\n`);
  writeFileSync(join(d, 'b.png'), key);
  writeFileSync(join(d, 'c.ts'), 'export const fine = "sk-not-a-key";\n');
  assert.deepEqual(keyShaped(d, ['a.js', 'b.png', 'c.ts']), ['a.js line 2']);
});

test('the working notes never go public, and every accepted finding says why', () => {
  for (const d of ['docs', 'PLAN.md', 'TOKEN-LOG.md']) assert.ok(DROP.includes(d), d);
  for (const a of ACCEPTED) {
    assert.match(a.rule, /^DISC-00\d$/);
    assert.ok(a.why.length > 10, a.file);
  }
});
