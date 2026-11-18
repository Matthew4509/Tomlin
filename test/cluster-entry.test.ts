// The cluster entry (src/cluster/members.ts): a saved set of linked PCs with one on/off switch. On: only its members are
// borrowed from, held for the cluster; off: nothing is borrowed; no set saved: the old rule. A member that cannot lend
// is named, and two PCs both called "Worker PC" are told apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_MEMBERS, cleanCluster, hasCluster, heldFor, isMember, onlyLinked, withMembers, withOn, without } from '../src/cluster/members.ts';
import { lendersOf } from '../src/jobrun/maxplaced.ts';
import { clusterGaps, maxPcs, memberWhy, type HelloLook } from '../src/jobrun/maxhost.ts';
import type { Remote } from '../src/store.ts';

const GB = 2 ** 30;
const memory = { cards: { count: 1 }, gpu: { total: 8 * GB, used: 0 }, ram: { total: 64 * GB, used: 0 } };
const z = { id: 'z820', name: 'Z820', computer: 'Z820' } as Remote;
const h1 = { id: 'hp1', name: 'Worker PC', computer: 'HP800-A' } as Remote;
const h2 = { id: 'hp2', name: 'Worker PC', computer: 'HP800-B' } as Remote;
const lone = { id: 'lone', name: 'Laptop' } as Remote;
const all = [z, h1, h2, lone];
// Everyone allows it but the Laptop.
const hello = (id: string): HelloLook => ({ can: ['max'], memory, allow: { lend: id !== 'lone' } });

test('a saved value reads back clean: ids only, no repeats, at most the limit, on only with a member', () => {
  assert.deepEqual(cleanCluster(undefined), { on: false, members: [] });
  assert.deepEqual(cleanCluster({ on: true, members: [] }), { on: false, members: [] });
  assert.deepEqual(cleanCluster({ on: true, members: ['a', 'a', 3, '', 'b'] }), { on: true, members: ['a', 'b'] });
  assert.equal(cleanCluster({ on: true, members: Array.from({ length: 20 }, (_, i) => `p${i}`) }).members.length, MAX_MEMBERS);
  assert.deepEqual(cleanCluster({ on: 'yes', members: ['a'] }), { on: false, members: ['a'] });
});

test('members are rebuilt from linked PCs only; the switch needs a member; an unlinked PC leaves the set', () => {
  const set = withMembers({ on: false, members: [] }, ['hp1', 'gone', 'hp2', 'z820'], ['z820', 'hp1', 'hp2']);
  assert.deepEqual(set.members, ['hp1', 'hp2', 'z820']);
  assert.equal(withOn({ on: false, members: [] }, true), null);
  assert.deepEqual(withOn(set, true), { on: true, members: ['hp1', 'hp2', 'z820'] });
  assert.deepEqual(withOn({ on: true, members: ['hp1'] }, false), { on: false, members: ['hp1'] });
  assert.deepEqual(without({ on: true, members: ['hp1'] }, 'hp1'), { on: false, members: [] }, 'the last one leaving switches it off');
  assert.deepEqual(without({ on: true, members: ['hp1', 'z820'] }, 'hp1'), { on: true, members: ['z820'] });
  // Rebuilding an empty set while it is on leaves it off.
  assert.equal(withMembers({ on: true, members: ['hp1'] }, [], ['hp1']).on, false);
});

test('held means in the set and switched on; a set exists once it has a member', () => {
  const on = { on: true, members: ['hp1'] };
  const off = { on: false, members: ['hp1'] };
  assert.ok(heldFor(on, 'hp1') && !heldFor(on, 'z820') && !heldFor(off, 'hp1') && !heldFor(undefined, 'hp1'));
  assert.ok(isMember(off, 'hp1') && !isMember(off, 'z820'));
  assert.ok(hasCluster(off) && !hasCluster({ on: false, members: [] }) && !hasCluster(undefined));
});

test('with a cluster on, only its members are borrowed from, in its order, whatever the old opt-out says', () => {
  const cluster = { on: true, members: ['hp2', 'z820'] };
  const optedOut = [{ ...z, noBorrow: true } as Remote, h1, h2, lone];
  assert.deepEqual(maxPcs('', optedOut, hello, cluster).map(r => r.id), ['hp2', 'z820'], 'the HP 800 left out of the set is not borrowed; the Z820 opt-out is replaced by the set');
});

test('with a cluster off nothing is borrowed; with none saved the old rule stands', () => {
  assert.deepEqual(maxPcs('', all, hello, { on: false, members: ['hp1', 'hp2'] }), []);
  assert.deepEqual(maxPcs('', all, hello, { on: false, members: [] }).map(r => r.id), ['z820', 'hp1', 'hp2']);
  assert.deepEqual(maxPcs('', all, hello, undefined).map(r => r.id), ['z820', 'hp1', 'hp2']);
});

test('TOMLIN_MAX naming a PC still overrides the cluster', () => {
  assert.deepEqual(maxPcs('Laptop', all, hello, { on: false, members: ['hp1'] }).map(r => r.id), ['lone']);
});

test('a member that cannot lend is named: not answering, no Max mode, not allowed, Backups only', () => {
  assert.match(memberWhy(z, null), /not answering/);
  assert.match(memberWhy(z, { can: [], memory, allow: { lend: true } }), /no Max mode/);
  assert.match(memberWhy(z, { can: ['max'], memory, allow: { lend: false } }), /Allow to be used as part of a cluster/);
  assert.match(memberWhy({ ...z, backupsOnly: true }, hello('z820')), /Backups only/);
  assert.equal(memberWhy(z, hello('z820')), '');
});

test('the gaps name each member left out, the twin "Worker PC"s told apart by their computers', () => {
  const quiet = (id: string): HelloLook => (id === 'hp2' ? null : hello(id));
  const lines = clusterGaps(all, quiet, { on: true, members: ['z820', 'hp1', 'hp2'] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"Worker PC \(HP800-B\)"/);
  assert.match(lines[0], /not answering/);
  assert.deepEqual(clusterGaps(all, hello, { on: true, members: ['z820', 'hp1', 'hp2'] }), []);
  assert.deepEqual(clusterGaps(all, quiet, { on: false, members: ['hp2'] }), [], 'off says nothing');
  assert.deepEqual(clusterGaps(all, quiet, undefined), []);
  assert.match(clusterGaps(all, hello, { on: true, members: ['nope'] })[0], /no longer linked/);
});

test('a set is kept to the PCs still linked, and goes off when none is left', () => {
  const set = { on: true, members: ['z820', 'hp1', 'hp2'] };
  assert.equal(onlyLinked(set, ['z820', 'hp1', 'hp2', 'lone']), set, 'nothing to prune: the same set');
  assert.deepEqual(onlyLinked(set, ['hp1', 'lone']), { on: true, members: ['hp1'] });
  assert.deepEqual(onlyLinked(set, ['lone']), { on: false, members: [] });
});

test('a lender is found by the id its load gave, not by a name two PCs may share or a cluster that changed', () => {
  const GBn = 2 ** 30;
  const caps = { hp2: { bytes: 7 * GBn, at: new Date().toISOString(), why: 'stalled' } };
  // Two lenders both called "Worker PC": told apart by id, so the second one's learned cap is its own.
  const got = lendersOf({ endpoints: ['127.0.0.1:1', '127.0.0.1:2'], lent: ['Worker PC (HP800-A)', 'Worker PC (HP800-B)'], ids: ['hp1', 'hp2'] }, caps);
  assert.equal(got[0].capRam, undefined);
  assert.equal(got[1].capRam, 7 * GBn);
  assert.deepEqual(got.map(l => l.name), ['Worker PC (HP800-A)', 'Worker PC (HP800-B)']);
});

test('the page\'s keepFocus leaves out a part that is not drawn (null), so the Cluster section and the PC list still draw', () => {
  const src = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = /function keepFocus\(box, kids\) \{[\s\S]*?\n\}/.exec(src)![0];
  const keepFocus = new Function('document', 'CSS', `${fn}; return keepFocus;`)({ activeElement: null }, { escape: (x: string) => x }) as (box: unknown, kids: unknown[]) => void;
  let drawn: unknown[] = [];
  const box = { innerHTML: '', contains: () => false, replaceChildren: (...k: unknown[]) => { drawn = k; }, querySelector: () => null };
  const a = { outerHTML: '<p>a</p>' };
  const b = { outerHTML: '<p>b</p>' };
  assert.doesNotThrow(() => keepFocus(box, [a, null, b, null]));
  assert.deepEqual(drawn, [a, b]);
  // Nothing drawn but nulls: an empty box, not a fault.
  assert.doesNotThrow(() => keepFocus(box, [null]));
  assert.deepEqual(drawn, []);
});
