// "Where else is this model": the sentence said before a model is deleted or moved (src/modelcopies.ts). A place that cannot
// be read is "not checked", never "no copy"; "the only copy" is said only when every place was read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetPc } from '../src/carry.ts';
import { copiesOf, deleteWords, placeOf } from '../src/modelcopies.ts';
import type { SharedModel } from '../src/nodestaff.ts';

const GB = 2 ** 30;
const sm = (id: string, bytes = 20 * GB, kind: 'chat' | 'image' = 'chat'): SharedModel => ({ id, name: id, kind, bytes, ctx: 8192, loaded: false, busy: false });
const pc = (name: string, o: Partial<NetPc> = {}): NetPc => ({ id: name.toLowerCase().replace(/\W/g, ''), name, ok: true, away: null, can: ['models', 'carry'], allow: null, models: [], ...o });
const M = { kind: 'chat' as const, id: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', bytes: 20 * GB };

test('copies: found on other PCs (named), with the file name compared without case and the size the same', () => {
  const c = copiesOf(M, [pc('Z820', { models: [sm('qwen3.5-35b-a3b-q4_k_m.gguf')] }), pc('HP 800', { models: [sm(M.id)] }), pc('Study', { models: [sm('Other.gguf')] })]);
  assert.equal(c.held, 2);
  assert.equal(c.only, false);
  assert.equal(c.words, 'Other copies: on Z820 and HP 800.');
  assert.equal(deleteWords(c, true), 'Other copies: on Z820 and HP 800.');
});

test('copies: a Backups only PC is read from the list kept apart, and named as backup', () => {
  const b = pc('Backup PC', { backupsOnly: true, models: [], held: [sm(M.id)] });
  assert.equal(placeOf(M, b).state, 'has');
  const c = copiesOf(M, [b, pc('Z820', { models: [sm(M.id)] }), pc('A'), pc('B', { models: [sm(M.id)] })]);
  assert.equal(c.words, 'Other copies: on backup Backup PC, Z820 and B.');
  // Four places that hold it: the first two, then a count.
  const many = copiesOf(M, ['A', 'B', 'C', 'D'].map(n => pc(n, { models: [sm(M.id)] })));
  assert.equal(many.words, 'Other copies: on A, B and 2 other PCs.');
});

test('copies: "only copy" is said only when every PC was read; a PC that is off, old, or Backups only and off is "not checked" with why', () => {
  const read = [pc('Z820', { models: [sm('Other.gguf')] })];
  const alone = copiesOf(M, read);
  assert.equal(alone.only, true);
  assert.equal(alone.words, 'This is the only copy TOMLIN found.');
  assert.match(deleteWords(alone, true), /removes it for good\. Move it to another PC instead to keep one\.$/);
  assert.doesNotMatch(deleteWords(alone, false), /Move it/);

  const off = pc('HP 800', { ok: false, models: [sm('Other.gguf')] });
  const never = pc('Study', { ok: false, models: [] });
  const old = pc('Laptop', { can: ['carry'] });
  const bakOff = pc('Backup PC', { ok: false, backupsOnly: true });
  const bakOld = pc('Backup 2', { backupsOnly: true, can: ['carry'] });
  const c = copiesOf(M, [...read, off, never, old, bakOff, bakOld]);
  assert.equal(c.only, false, 'something was not checked');
  assert.equal(c.unchecked, true);
  assert.match(c.words, /^No other copy found\. Not checked: /);
  assert.match(c.words, /HP 800 \(it is off \(its list from the last time it answered did not have this model\)\)/);
  assert.match(c.words, /Study \(it is off and has not told this PC which models it holds\)/);
  assert.match(c.words, /Laptop \(it runs an older TOMLIN that does not say which models it holds\)/);
  assert.match(c.words, /Backup PC \(it is a Backups only PC and it is off\)/);
  assert.match(c.words, /Backup 2 \(it runs a TOMLIN that does not say which models it holds\)/);
  assert.match(deleteWords(c, true), /may remove the last copy\. Move it to another PC instead to keep one\.$/);
});

test('copies: an off PC whose last list had it counts, marked as last seen; the same name with another size is not a copy', () => {
  const c = copiesOf(M, [pc('HP 800', { ok: false, models: [sm(M.id)] }), pc('Z820', { models: [sm(M.id, 12 * GB)] })]);
  assert.equal(c.held, 1);
  assert.equal(c.places.find(p => p.name === 'Z820')!.state, 'different');
  assert.equal(c.words, 'Other copies: on HP 800 (off now, as last seen). Z820 has a file of the same name with another size: not counted as a copy.');
  // Only the different one: not a copy, but every PC was read, so it is still the only copy.
  const d = copiesOf(M, [pc('Z820', { models: [sm(M.id, 12 * GB)] })]);
  assert.equal(d.only, true);
  assert.equal(d.words, 'This is the only copy TOMLIN found. Z820 has a file of the same name with another size: not counted as a copy.');
});

test('copies: no linked PC at all says so; a picture model is matched by its id, not a file name', () => {
  assert.equal(copiesOf(M, []).words, 'This is the only copy: no other PC is linked to this one.');
  const img = { kind: 'image' as const, id: 'flux-schnell', bytes: 5 * GB };
  const c = copiesOf(img, [pc('Z820', { models: [sm('flux-schnell', 5 * GB, 'image')] }), pc('HP', { models: [sm('flux-schnell', 5 * GB, 'chat')] })]);
  assert.equal(c.words, 'Other copies: on Z820.');
});

test('copies: a model on a linked PC counts this PC as a place (and leaves that PC out of the list)', () => {
  const z = pc('Z820', { models: [sm(M.id)] });
  const here = { name: 'This PC', models: [{ kind: 'chat' as const, id: M.id, bytes: M.bytes }] };
  const c = copiesOf(M, [z, pc('HP 800', { models: [] })], { skip: z.id, here });
  assert.equal(c.words, 'Other copies: on This PC.');
  const none = copiesOf(M, [z, pc('HP 800', { models: [] })], { skip: z.id, here: { name: 'This PC', models: [] } });
  assert.equal(none.words, 'This is the only copy TOMLIN found.');
  assert.match(deleteWords(none, false), /^This is the only copy TOMLIN found\. Deleting it removes it for good\.$/);
});
