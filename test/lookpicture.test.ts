// A hire's round picture (2.0.65): with no photo and no saved look, it shows the look made up for them (the same one
// Edit staff > Look shows, from their id and role), not their initials. "Show initials instead" is a choice of its own,
// kept on the hire (initials), so it still shows the initials; saving a look clears that choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Staff } from '../src/staff.ts';

const read = (f: string) => readFile(new URL(`../${f}`, import.meta.url), 'utf8');

test('a hire keeps "initials" as a choice of its own; a saved look clears it, and forgetting a look alone does not set it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-lookpic-'));
  try {
    const s = await Staff.load(dir);
    const m = await s.hire('Sam', 'coder', 'junior');
    assert.equal(m.look ?? null, null);
    assert.equal(m.initials ?? false, false, 'a new hire shows the made-up look');
    const off = await s.change(m.id, { look: null, initials: true });
    assert.equal(off?.initials, true);
    assert.equal(off?.look ?? null, null);
    const saved = await s.change(m.id, { look: {} });
    assert.ok(saved?.look, 'a whole look (each part its first choice)');
    assert.equal(saved?.initials, undefined, 'saving a look clears "initials"');
    const forgot = await s.change(m.id, { look: null });
    assert.equal(forgot?.initials, undefined, 'forgetting the look: the made-up one again, not the initials');
    assert.equal((await s.change(m.id, { initials: 'yes' }))?.initials, undefined, 'only true sets it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page draws the made-up look in the round picture when there is no photo, no saved look and no "initials"', async () => {
  const people = await read('src/server/people.ts');
  // Each hire to draw a made-up look for, with the role the look is made from (as Edit staff makes it).
  assert.match(people, /madeUp: Object\.fromEntries\(staff\.list\(\)\.filter\(m => !cleanLook\(m\.look\) && !m\.initials\)\.map\(m => \[`staff:\$\{m\.id\}`, m\.role\]\)\)/);
  const faces = await read('public/faces.js');
  assert.match(faces, /faceUi\.madeUp = d\.madeUp \?\? \{\};/);
  assert.match(faces, /app\.look\.fromId\(who\.slice\(6\), faceUi\.madeUp\[who\]\)/);
  const team = await read('public/team.js');
  assert.match(team, /look: null, initials: true/);
  assert.match(team, /shows this made-up look until you change it/);
  assert.doesNotMatch(team, /shows the initials until you press Save look/);
  // Edit staff makes the same look from the same id and role.
  assert.match(team, /const shown = m\.look \?\? app\.look\.fromId\(m\.id, m\.role\);/);
});
