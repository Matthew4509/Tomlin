// Max mode's host side with one permission: a linked PC whose owner ticked "Allow to be used as part of a cluster" there
// (its hello says allow.lend) is borrowed from with no tick here; "Don't borrow from it" opts out; TOMLIN_MAX naming PCs
// overrides. And the fit rule (src/cluster/engine.ts borrowRule): a model that fits this PC well alone is not split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lendsCard, maxLent, maxLoad, maxPcs, setBorrow, type HelloLook } from '../src/jobrun/maxhost.ts';
import { borrowRule } from '../src/cluster/engine.ts';
import type { Remote } from '../src/store.ts';

const GB = 2 ** 30;
const a = { id: 'aaaa1111', name: 'Z820' } as Remote;
const b = { id: 'bbbb2222', name: 'Laptop' } as Remote;
const c = { id: 'cccc3333', name: 'HP 800', noBorrow: true } as Remote;
const memory = { cards: { count: 1 }, gpu: { total: 24.5 * GB, used: 0 }, ram: { total: 64 * GB, used: 0 } };
// The Z820 and the HP 800 allow it; the Laptop does not.
const hello = (id: string): HelloLook => ({ can: ['max'], memory, allow: { lend: id !== b.id } });

test('a linked PC that allows it is borrowed from with no tick here', () => {
  assert.deepEqual(maxPcs('', [a, b], hello).map(r => r.name), ['Z820']);
  assert.deepEqual(maxPcs('1', [a, b], hello).map(r => r.name), ['Z820'], '"1" only switches lending on and names none');
});

test('"Don\'t borrow from it", Backups only, no hello yet and an older hello leave a PC out', () => {
  assert.deepEqual(maxPcs('', [a, c], hello).map(r => r.name), ['Z820']);
  assert.deepEqual(maxPcs('', [{ ...a, backupsOnly: true }], hello), []);
  assert.deepEqual(maxPcs('', [a], () => null), []);
  assert.deepEqual(maxPcs('', [a], () => ({ can: ['max'], memory, allow: null })), []);
});

test('TOMLIN_MAX naming a PC overrides the permission and the opt-out', () => {
  assert.deepEqual(maxPcs('Laptop', [a, b], hello).map(r => r.name), ['Laptop']);
  assert.deepEqual(maxPcs('hp 800', [a, c], hello).map(r => r.name), ['HP 800']);
});

test('lent memory counts only for the PCs that allow it', () => {
  const was = process.env.TOMLIN_MAX_SHARE;
  try {
    // Card memory only (TOMLIN_MAX_SHARE=card).
    process.env.TOMLIN_MAX_SHARE = 'card';
    assert.equal(maxLent('', hello, [a, b]), 24 * GB);
    assert.equal(maxLent('', hello, [b]), 0);
    // The default (2.0.92): a PC's permission covers its RAM and cores too, so its RAM counts beside the card.
    delete process.env.TOMLIN_MAX_SHARE;
    assert.ok(maxLent('', hello, [a, b]) > 24 * GB);
    assert.equal(maxLent('', hello, [b]), 0);
  } finally {
    if (was === undefined) delete process.env.TOMLIN_MAX_SHARE;
    else process.env.TOMLIN_MAX_SHARE = was;
  }
});

test('the opt-out is set and cleared on that PC only, the old tick goes, and an unknown PC is refused', () => {
  const old = { ...b, borrowMax: true } as Remote;
  assert.deepEqual(setBorrow([a, old], 'bbbb2222', false)!.map(r => r.noBorrow === true), [false, true]);
  assert.equal('borrowMax' in setBorrow([a, old], 'bbbb2222', false)![1], false);
  assert.deepEqual(setBorrow([a, c], 'cccc3333', true)!.map(r => 'noBorrow' in r), [false, false]);
  assert.equal(setBorrow([a, b], 'nope', true), null);
});

test('a lending card is read from the hello', () => {
  assert.equal(lendsCard([a], hello), true);
  assert.equal(lendsCard([a], () => ({ can: ['max'], memory: { cards: { count: 0 } }, allow: { lend: true } })), false);
});

// The measured cases (3 and 14 Nov 2026), on a PC with a 12 GB card and 60 GB free RAM.
const pc = { card: 11 * GB, ram: 60 * GB };
test('borrowRule: never slower than one machine', () => {
  assert.equal(borrowRule({ ...pc, need: 8 * GB, moe: false }, true).borrow, false, 'fits the card');
  assert.equal(borrowRule({ ...pc, need: 24 * GB, moe: true }, true).borrow, false, 'Qwen3.5-35B: 11.2 alone, 7.0 split');
  assert.equal(borrowRule({ ...pc, need: 50 * GB, moe: true }, true).borrow, false, 'Qwen3-Next-80B: 10.9 alone, 4.6 split');
  assert.equal(borrowRule({ ...pc, need: 16 * GB, moe: false }, true).borrow, true, 'dense 24B too big for the card: 12.2 split, 4.2 alone');
  assert.equal(borrowRule({ ...pc, need: 16 * GB, moe: false }, false).borrow, false, 'dense, but no lending PC has a card');
  assert.equal(borrowRule({ ...pc, need: 90 * GB, moe: true }, false).borrow, true, 'does not fit this PC at all');
  assert.match(borrowRule({ ...pc, need: 90 * GB, moe: true }, false).words, /does not fit this PC alone \(needs 90\.0 GB, 71\.0 GB free/);
});

test('a load borrows from a PC that allows it when the model does not fit alone, and says why', async () => {
  const asked: string[] = [];
  const ask = async (pcs: Remote[]) => { asked.push(...pcs.map(p => p.name)); return { endpoints: ['127.0.0.1:1'], lent: ['Z820'], notes: [] }; };
  const got = await maxLoad('Qwen 80B', '', [a], ask, undefined, { alone: { ...pc, need: 90 * GB, moe: true }, hello });
  assert.deepEqual(asked, ['Z820']);
  assert.deepEqual(got?.lent, ['Z820']);
});

test('a model that fits this PC alone is not split: nobody is asked, and the note says why', async () => {
  let asked = false;
  const got = await maxLoad('Qwen3.5-35B', '', [a], async () => { asked = true; return { endpoints: ['127.0.0.1:1'], lent: ['Z820'], notes: [] }; }, undefined, { alone: { ...pc, need: 24 * GB, moe: true }, hello });
  assert.equal(asked, false);
  assert.deepEqual(got?.endpoints, []);
  assert.match(got?.notes[0] ?? '', /not used for Qwen3\.5-35B: it fits this PC's card and RAM/);
});

test('TOMLIN_MAX naming a PC still splits a model that fits (the speed tests force it)', async () => {
  const got = await maxLoad('Qwen3.5-35B', 'Z820', [a], async () => ({ endpoints: ['127.0.0.1:1'], lent: ['Z820'], notes: [] }), undefined, { alone: { ...pc, need: 24 * GB, moe: true }, hello });
  assert.deepEqual(got?.lent, ['Z820']);
});
