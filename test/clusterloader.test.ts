// The cluster with this PC left out (src/cluster/loader.ts and the set's new fields in src/cluster/members.ts): the
// switch's saved form, who is held, which member loads the model and why another cannot, in plain words. Pure. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCluster, heldFor, onlyLinked, takesPart, withHere, withMembers, withOn, without } from '../src/cluster/members.ts';
import { chooseLoader, cleanClusterHello, loaderGaps, loaderModelWhy, loaderWhy, strongestFirst, wireOf, type LoaderFacts } from '../src/cluster/loader.ts';
import { maxCandidates } from '../src/jobrun/maxhost.ts';
import { maxGate } from '../src/maxmode.ts';
import type { Remote } from '../src/store.ts';

const GB = 2 ** 30;
const A = 'aaaa0001';
const B = 'bbbb0002';
const C = 'cccc0003';

test('the saved set: this PC out only with a loader that is a member; old sets read back as before', () => {
  assert.deepEqual(cleanCluster({ on: true, members: [A, B] }), { on: true, members: [A, B] }, 'an old set has no new field');
  assert.deepEqual(cleanCluster({ on: true, members: [A, B], out: true, loader: B }), { on: true, members: [A, B], out: true, loader: B });
  assert.deepEqual(cleanCluster({ on: true, members: [A, B], out: true, loader: C }), { on: true, members: [A, B] }, 'a loader not in the set: this PC takes part again');
  assert.deepEqual(cleanCluster({ on: true, members: [A, B], out: true }), { on: true, members: [A, B] }, 'out with no loader');
  assert.deepEqual(cleanCluster({ on: true, members: [A, B], out: 'yes', loader: A }), { on: true, members: [A, B] }, 'only true counts');
  assert.deepEqual(cleanCluster({ members: [A], loader: A }), { on: false, members: [A] }, 'a loader alone means nothing');
  assert.equal(takesPart(cleanCluster({ members: [A, B] })), true);
  assert.equal(takesPart(undefined), true);
  assert.equal(takesPart(cleanCluster({ members: [A, B], out: true, loader: A })), false);
});

test('the switch: out needs a member as loader; back in drops both fields; members and on/off keep it', () => {
  const set = cleanCluster({ on: true, members: [A, B] });
  assert.equal(withHere(set, false, C), null, 'a loader that is not a member is refused');
  const out = withHere(set, false, B)!;
  assert.deepEqual(out, { on: true, members: [A, B], out: true, loader: B });
  assert.deepEqual(withHere(out, true), { on: true, members: [A, B] });
  assert.deepEqual(withOn(out, false), { on: false, members: [A, B], out: true, loader: B });
  assert.deepEqual(withMembers(out, [A, B, C], [A, B, C]), { on: true, members: [A, B, C], out: true, loader: B });
  assert.deepEqual(withMembers(out, [A, C], [A, B, C]), { on: true, members: [A, C] }, 'the loader taken out: this PC takes part again');
  assert.deepEqual(without(out, B), { on: true, members: [A] });
  assert.deepEqual(onlyLinked(out, [A]), { on: true, members: [A] });
  assert.deepEqual(onlyLinked(out, [A, B]), out);
});

test('held: every member of a switched-on cluster, but not the loader when this PC is out (the chats go to it)', () => {
  const inSet = cleanCluster({ on: true, members: [A, B] });
  assert.equal(heldFor(inSet, A), true);
  assert.equal(heldFor(inSet, B), true);
  const out = withHere(inSet, false, B)!;
  assert.equal(heldFor(out, A), true, 'a lender to the loader is held');
  assert.equal(heldFor(out, B), false, 'the loader answers chats');
  assert.equal(heldFor(withOn(out, false)!, A), false);
});

test('this PC out: it borrows from no PC itself, and the Max switch says why', () => {
  const remotes = [{ id: A, name: 'Z820' }, { id: B, name: 'HP 800' }] as Remote[];
  const inSet = cleanCluster({ on: true, members: [A, B] });
  assert.deepEqual(maxCandidates(remotes, inSet).map(r => r.id), [A, B]);
  assert.deepEqual(maxCandidates(remotes, withHere(inSet, false, A)!), []);
  const gate = maxGate({ pcs: [], linked: 2, clusterOut: true, host: [] });
  assert.match(gate.why, /stays out of the cluster/);
});

test('a hello\'s cluster part read back; the network from the adapter\'s name', () => {
  assert.equal(cleanClusterHello(undefined), null, 'an older TOMLIN sends none');
  assert.equal(cleanClusterHello({ via: 'Ethernet' }), null);
  assert.deepEqual(cleanClusterHello({ borrows: [A, A, 'not-an-id', 7, B], via: 'Ethernet 2<script>' }), { borrows: [A, B], via: 'Ethernet 2script' });
  assert.equal(wireOf('Ethernet'), 'wired');
  assert.equal(wireOf('Ethernet 2'), 'wired');
  assert.equal(wireOf('Wi-Fi'), 'wifi');
  assert.equal(wireOf('WiFi 2'), 'wifi');
  assert.equal(wireOf('Wireless Network Connection'), 'wifi');
  assert.equal(wireOf('vEthernet (WSL)'), 'wired');
  assert.equal(wireOf(''), 'unknown');
  assert.equal(wireOf('Local Area Connection* 3'), 'unknown');
});

const pc = (o: Partial<LoaderFacts> & { id: string; name: string }): LoaderFacts => ({ answering: true, away: false, guest: false, backupsOnly: false, card: 0, ram: 32 * GB, cluster: { borrows: [], via: 'Ethernet' }, ...o });

test('strongest first: the most card memory, then the most RAM, then a wired one', () => {
  const list = [pc({ id: A, name: 'small', card: 0, ram: 24 * GB }), pc({ id: B, name: 'big RAM', card: 0, ram: 128 * GB }), pc({ id: C, name: 'card', card: 12 * GB, ram: 16 * GB })];
  assert.deepEqual(strongestFirst(list).map(x => x.name), ['card', 'big RAM', 'small']);
  const tie = [pc({ id: A, name: 'not known', cluster: { borrows: [], via: '' } }), pc({ id: B, name: 'wired' })];
  assert.deepEqual(strongestFirst(tie).map(x => x.name), ['wired', 'not known']);
});

test('why a member cannot load the model: each reason in plain words', () => {
  const b = pc({ id: B, name: 'HP 800' });
  assert.deepEqual(loaderWhy(pc({ id: A, name: 'Z820', answering: false }), [b]), ['it is not answering (off, asleep, or TOMLIN is not running there)']);
  assert.match(loaderWhy(pc({ id: A, name: 'Z820', away: true }), [b])[0], /I need to use the pc/);
  assert.match(loaderWhy(pc({ id: A, name: 'Z820', guest: true }), [b])[0], /only a guest there/);
  assert.match(loaderWhy(pc({ id: A, name: 'Z820', backupsOnly: true }), [b])[0], /Backups only/);
  assert.match(loaderWhy(pc({ id: A, name: 'Z820', cluster: null }), [b])[0], /update TOMLIN there/);
  const wifi = loaderWhy(pc({ id: A, name: 'Z820', cluster: { borrows: [B], via: 'Wi-Fi' } }), [b]);
  assert.equal(wifi.length, 1);
  assert.match(wifi[0], /on Wi-Fi \("Wi-Fi"\).*wired network/);
  const z = pc({ id: A, name: 'Z820', cluster: { borrows: [], via: 'Ethernet' } });
  const noLink = loaderWhy(z, [z, b]);
  assert.equal(noLink.length, 1);
  assert.match(noLink[0], /would not borrow from "HP 800": on "Z820" itself, that PC must be linked under Network/);
  assert.deepEqual(loaderWhy(pc({ id: A, name: 'Z820', cluster: { borrows: [B], via: 'Ethernet' } }), [z, b]), []);
});

test('the loader: the strongest that can; refused, naming every member and why, when none can', () => {
  const z = pc({ id: A, name: 'Z820', card: 0, ram: 128 * GB, cluster: { borrows: [B, C], via: 'Ethernet' } });
  const hp = pc({ id: B, name: 'HP 800', card: 0, ram: 24 * GB, cluster: { borrows: [], via: 'Ethernet' } });
  const lap = pc({ id: C, name: 'Laptop', card: 8 * GB, ram: 16 * GB, cluster: { borrows: [A, B], via: 'Wi-Fi' } });
  const got = chooseLoader([hp, lap, z]);
  assert.ok('loader' in got);
  assert.equal(got.loader.name, 'Z820');
  assert.equal(got.notes.length, 1, 'the strongest (by card) is named and why it is passed over');
  assert.match(got.notes[0], /"Laptop" is the strongest but cannot load the model \(it is on Wi-Fi/);
  const none = chooseLoader([hp, lap]);
  assert.ok('why' in none);
  assert.match(none.why, /no PC in the cluster can load the model for the others\. "Laptop": .*Wi-Fi.*"HP 800": it would not borrow from "Laptop"/);
  const one = chooseLoader([z]);
  assert.ok('why' in one && /at least two PCs/.test(one.why));
  const unknownWire = chooseLoader([pc({ id: A, name: 'Z820', cluster: { borrows: [B], via: '' } }), hp]);
  assert.ok('loader' in unknownWire);
  assert.match(unknownWire.notes.join(' '), /could not be told from its network adapter's name/);
});

test('a loader already chosen, looked at again; the model must be on its own disk', () => {
  const z = pc({ id: A, name: 'Z820', cluster: { borrows: [B], via: 'Ethernet' } });
  const hp = pc({ id: B, name: 'HP 800' });
  assert.deepEqual(loaderGaps(z, [z, hp]), []);
  assert.match(loaderGaps({ ...z, answering: false }, [z, hp])[0], /^"Z820", which loads the model for the cluster, cannot now: it is not answering/);
  assert.match(loaderGaps(undefined, [hp])[0], /no longer in the cluster/);
  assert.match(loaderGaps(z, [z])[0], /only PC in the cluster/);
  assert.match(loaderModelWhy('Z820', []), /No chat model is on "Z820" yet.*send one there first/);
  assert.match(loaderModelWhy('Z820', [{ id: 'pic.safetensors', kind: 'image' }]), /No chat model/);
  assert.equal(loaderModelWhy('Z820', [{ id: 'big.gguf', kind: 'chat' }]), '');
  assert.equal(loaderModelWhy('Z820', [{ id: 'big.gguf', kind: 'chat' }], 'big.gguf'), '');
  assert.match(loaderModelWhy('Z820', [{ id: 'big.gguf', kind: 'chat' }], 'other.gguf'), /not on "Z820"/);
});
