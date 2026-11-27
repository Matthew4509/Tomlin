// Which hires work on a model, and as what, said before it is deleted (src/assigned.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignedTo, assignedWarning, assignedWords, staffLines, type Hire } from '../src/assigned.ts';

const BIG = 'Qwen3.5-35B.gguf';
const SMALL = 'Gemma-4B.gguf';
const hires: Hire[] = [
  { name: 'Ann', model: BIG, fallback: SMALL },
  { name: 'Bo', model: SMALL, fallback: BIG },
  { name: 'Cy', model: BIG },
  { name: 'Di', model: 'remote:0a1b2c3d:Far.gguf', fallback: BIG },
  { name: 'Ed', model: SMALL, group: [BIG], active: BIG },
  { name: 'Flo', model: SMALL },
];

test('who is on a model: first choice, backup, on it now; a hire not on it is left out', () => {
  const on = assignedTo(hires, BIG);
  assert.deepEqual(on.map(a => [a.name, a.as.join('+'), a.spare]), [['Ann', 'first choice', true], ['Bo', 'backup', false], ['Cy', 'first choice', false], ['Di', 'backup', false], ['Ed', 'on it now', false]]);
  assert.deepEqual(assignedTo(hires, 'Nothing.gguf'), []);
  // A backup picked while their PC was off counts as a backup.
  assert.deepEqual(assignedTo([{ name: 'Gus', model: 'remote:0a1b2c3d', cover: { ref: SMALL } }], SMALL).map(a => a.as), [['backup']]);
});

test('a linked PC\'s model is named by its remote ref', () => {
  const on = assignedTo(hires, 'remote:0a1b2c3d:Far.gguf');
  assert.deepEqual(on.map(a => [a.name, a.as, a.spare]), [['Di', ['first choice'], true]]);
});

test('the note names each hire and how; no backup is said', () => {
  const on = assignedTo(hires, BIG);
  assert.equal(assignedWords(on), 'In use by staff Ann, Bo, Cy, Di and Ed.');
  assert.equal(assignedWords([]), '');
  assert.equal(assignedWords(assignedTo(hires, SMALL).slice(0, 1), '"Z820"'), 'In use by staff Ann on "Z820".');
});

test('the warning says what happens to each: no model, the backup answers, or a lost backup', () => {
  assert.equal(assignedWarning(assignedTo(hires, BIG)), 'Deleting it affects staff: Cy and Ed would have no model until you give them another; Ann would answer on their backup; Bo and Di would lose their backups.');
  assert.equal(assignedWarning([]), '');
  assert.equal(assignedWarning(assignedTo(hires, SMALL).filter(a => a.name === 'Flo')), 'Deleting it affects staff: Flo would have no model until you give them another.');
});

test('the lines for a linked PC\'s model: this PC\'s hires and that PC\'s own; an older PC is "not checked", never guessed', () => {
  const mine = assignedTo(hires, 'remote:0a1b2c3d:Far.gguf');
  const theirs = [{ name: 'Kit', as: ['first choice'], spare: false }] as never;
  const both = staffLines({ mine, theirs, pcName: 'Z820' });
  assert.equal(both.note, 'In use by staff Di. In use by staff Kit on "Z820".');
  assert.match(both.warning, /^Deleting it affects staff: Di would answer on their backup\. Deleting it affects staff on "Z820": Kit would have no model/);
  const old = staffLines({ mine: [], theirs: null, pcName: 'Z820' });
  assert.equal(old.note, 'Staff on "Z820": not checked (it runs an older TOMLIN that does not say).');
  assert.equal(old.warning, '');
  assert.deepEqual(staffLines({ mine: [] }), { note: '', warning: '' });
});
