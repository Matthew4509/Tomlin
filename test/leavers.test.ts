import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialsOf, leftPerson, nameFromId } from '../src/leavers.ts';
import { Staff } from '../src/staff.ts';

test('a leaver kept by name shows as "Name (left the team)" with their initials and role', () => {
  assert.deepEqual(leftPerson('cy-holt', { name: 'Cy Holt', role: 'pm' }), { name: 'Cy Holt (left the team)', avatar: 'CH', role: 'Project manager · left the team' });
});

test('someone who left before names were kept gets a name from their id, so two leavers can be told apart', () => {
  assert.equal(nameFromId('coding-test-20'), 'Coding Test 20');
  assert.equal(nameFromId('cy-holt'), 'Cy Holt');
  assert.notEqual(leftPerson('coding-test-19').name, leftPerson('coding-test-20').name);
  assert.equal(leftPerson('coding-test-19').name, 'Coding Test 19 (left the team)');
  assert.equal(leftPerson('coding-test-19').avatar, 'CT');
  assert.equal(nameFromId(''), 'Someone');
  assert.equal(initialsOf(''), '?');
});

test('firing keeps who they were (name, role, look), and a new hire of the same name still gets a fresh id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-leavers-'));
  try {
    const s = await Staff.load(dir);
    await s.hire('Bea Marsh', 'writer', 'any');
    assert.equal(s.leaver('bea-marsh'), undefined);
    assert.ok(await s.fire('bea-marsh'));
    assert.equal(await s.fire('bea-marsh'), false);
    const again = await Staff.load(dir);
    assert.deepEqual(again.leaver('bea-marsh'), { name: 'Bea Marsh', role: 'writer' });
    const next = await again.hire('Bea Marsh', 'writer', 'any');
    assert.equal(next.id, 'bea-marsh-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
