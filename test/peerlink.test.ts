// Peers (src/peerlink.ts): the introduction a host makes for two PCs linked to it, the half each PC is sent, how a PC
// takes a host's set, and the one check every request from a peer asks. Plain functions; no door uses them yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pl from '../src/peerlink.ts';
import { GUEST_DOORS, HOST_ONLY_DOORS } from '../src/guestpass.ts';
import { keysOf } from '../src/link.ts';
import { hashToken } from '../src/share.ts';

const NOW = Date.parse('2026-06-01T10:00:00Z');
const DAY = 86_400_000;
const A: pl.PeerEnd = { id: 'aaaaaaaa', name: 'Made-up loader', addrs: ['192.168.0.20', '10.0.0.5'] };
const B: pl.PeerEnd = { id: 'bbbbbbbb', name: 'Made-up lender', addrs: ['192.168.0.21'] };
const C: pl.PeerEnd = { id: 'cccccccc', name: 'Made-up third', addrs: ['192.168.0.22'] };
const HOST = 'host-keep-1';
const LAN = '192.168.0.20';

function intro(over: { scopes?: unknown; expires?: string | null; passId?: string } = {}, from = A, to = B): pl.Intro {
  const made = pl.makeIntro(from, to, { scopes: ['copy', 'cluster'], ...over }, NOW);
  assert.ok(!('error' in made), JSON.stringify(made));
  return made as pl.Intro;
}
/** B's table after the host's set for it was taken. */
function taken(intros: pl.Intro[], node = B.id, local: pl.PeerTable = pl.NO_PEERS, gen = 1, lastGen?: number) {
  return pl.mergePeers(local, pl.peerSet(intros, node), { by: HOST, gen, lastGen, nodeId: node });
}
const state = (over: Partial<pl.PeerState> = {}): pl.PeerState => ({ id: B.id, name: B.name, allowPeers: true, paired: [{ hash: 'e'.repeat(64), keep: HOST }], ...over });

test('an introduction: a fresh token and 64 key bytes, two different linked PCs, at least one scope', () => {
  const x = intro();
  assert.match(x.id, /^[0-9a-f]{8}$/);
  assert.match(x.token, /^[0-9a-f]{64}$/);
  assert.equal(keysOf(x.key)?.length, 64);
  assert.deepEqual(x.scopes, ['copy', 'cluster']);
  assert.equal(x.expires, null);
  assert.equal(x.rev, 1);
  assert.notEqual(intro().token, x.token, 'never the same token twice');
  assert.ok('error' in pl.makeIntro(A, A, { scopes: ['copy'] }, NOW), 'not to itself');
  assert.ok('error' in pl.makeIntro(A, B, { scopes: ['made-up'] }, NOW), 'a scope that is not one');
  assert.ok('error' in pl.makeIntro(A, B, { scopes: [] }, NOW));
  assert.ok('error' in pl.makeIntro({ ...A, id: 'not an id' }, B, { scopes: ['copy'] }, NOW));
  assert.ok('error' in pl.makeIntro(A, B, { scopes: ['copy'], expires: 'soon' }, NOW));
});

test('an address that is not on a home network is never kept for a peer', () => {
  const x = intro({}, A, { ...B, addrs: ['192.168.0.21', '8.8.8.8', 'example.com', '10.1.2.3'] });
  assert.deepEqual(x.to.addrs, ['192.168.0.21', '10.1.2.3']);
});

test('each PC is sent only its half: the caller the token, the answerer only its hash; a third PC nothing', () => {
  const x = intro();
  const a = pl.peerSet([x], A.id);
  const b = pl.peerSet([x], B.id);
  assert.equal(a.in.length, 0);
  assert.equal(a.out.length, 1);
  assert.equal(a.out[0].token, x.token);
  assert.equal(a.out[0].pc, B.id);
  assert.deepEqual(a.out[0].addrs, B.addrs);
  assert.equal(b.out.length, 0);
  assert.equal(b.in.length, 1);
  assert.equal(b.in[0].hash, hashToken(x.token));
  assert.equal(b.in[0].pc, A.id);
  assert.ok(!JSON.stringify(b).includes(x.token), 'the answerer never holds the token');
  assert.deepEqual(pl.peerSet([x], C.id), { in: [], out: [] });
  assert.equal(a.out[0].key, b.in[0].key, 'one key, both ends');
});

test('a removed introduction is sent with nothing secret in it', () => {
  const x = intro();
  const [gone] = pl.revokeIntro([x], x.id);
  assert.equal(gone.revoked, true);
  assert.equal(gone.rev, 2);
  const text = JSON.stringify([pl.peerSet([gone], A.id), pl.peerSet([gone], B.id)]);
  assert.ok(!text.includes(x.token) && !text.includes(x.key) && !text.includes(hashToken(x.token)));
});

test('a PC takes a host\'s set: kept as given by that host, found by the token\'s hash', () => {
  const x = intro();
  const got = taken([x]);
  assert.equal(got.stale, false);
  assert.equal(got.taken, 1);
  assert.equal(got.peers.in[0].by, HOST);
  assert.equal(pl.peerByHash(got.peers, hashToken(x.token))?.pc, A.id);
  assert.equal(pl.peerByHash(got.peers, 'f'.repeat(64)), undefined);
  assert.equal(pl.peerByHash(got.peers, ''), undefined);
  assert.equal(pl.peerByHash(got.peers, undefined), undefined);
});

test('an older generation changes nothing; an older revision never brings a removed peer back', () => {
  const x = intro();
  const first = taken([x], B.id, pl.NO_PEERS, 5);
  const gone = pl.revokeIntro([x], x.id);
  const second = taken(gone, B.id, first.peers, 6, 5);
  assert.equal(second.peers.in[0].revoked, true);
  assert.equal(second.peers.in[0].hash, '');
  assert.equal(second.peers.in[0].key, '');
  assert.equal(taken([x], B.id, second.peers, 4, 6).stale, true, 'an older generation');
  const again = taken([x], B.id, second.peers, 7, 6);
  assert.equal(again.peers.in[0].revoked, true, 'revision 1 does not replace revision 2');
  assert.equal(again.taken, 0);
});

test('a peer its host no longer sends ends here', () => {
  const x = intro();
  const y = intro({}, C, B);
  const first = taken([x, y]);
  assert.equal(first.peers.in.filter(p => !p.revoked).length, 2);
  const next = taken([x], B.id, first.peers, 2, 1);
  const lost = next.peers.in.find(p => p.id === y.id)!;
  assert.equal(lost.revoked, true);
  assert.equal(lost.hash, '');
  assert.equal(next.peers.in.find(p => p.id === x.id)!.revoked, undefined);
});

test('another host never takes over or ends a peer it did not give, unless that host\'s link is gone', () => {
  const x = intro();
  const first = taken([x]);
  const forged = { in: [{ ...pl.peerSet([x], B.id).in[0], hash: 'd'.repeat(64), rev: 9 }], out: [] };
  const other = pl.mergePeers(first.peers, forged, { by: 'other-host', gen: 1, nodeId: B.id, gone: () => false });
  assert.equal(other.peers.in[0].hash, hashToken(x.token));
  assert.equal(other.peers.in[0].by, HOST);
  assert.equal(other.taken, 0);
  const empty = pl.mergePeers(first.peers, { in: [], out: [] }, { by: 'other-host', gen: 2, nodeId: B.id });
  assert.equal(empty.peers.in[0].revoked, undefined, 'an empty set from another host ends nothing');
  const orphan = pl.mergePeers(first.peers, forged, { by: 'other-host', gen: 3, nodeId: B.id, gone: by => by === HOST });
  assert.equal(orphan.peers.in[0].by, 'other-host');
});

test('a record that is not whole, or that names this PC as its own peer, is dropped', () => {
  const x = intro();
  const half = pl.peerSet([x], B.id).in[0];
  const bad = [
    { ...half, id: 'ZZ' }, { ...half, pc: B.id }, { ...half, hash: 'short' }, { ...half, key: 'AAAA' }, { ...half, scopes: [] },
    { ...half, scopes: ['made-up'] }, { ...half, expires: 'soon' }, { ...half, created: 'x' }, null, 'text', 7,
  ];
  const got = pl.mergePeers(pl.NO_PEERS, { in: bad, out: bad }, { by: HOST, gen: 1, nodeId: B.id });
  assert.deepEqual(got.peers, { in: [], out: [] });
  assert.deepEqual(pl.cleanPeers(undefined), { in: [], out: [] });
  assert.deepEqual(pl.cleanPeers({ in: 'x', out: 5 }), { in: [], out: [] });
});

test('what a PC saved reads back the same', () => {
  const x = intro({ expires: new Date(NOW + DAY).toISOString(), passId: 'p1p1p1p1' });
  const b = taken([x]).peers;
  const a = taken([x], A.id).peers;
  assert.deepEqual(pl.cleanPeers(JSON.parse(JSON.stringify(b))), b);
  assert.deepEqual(pl.cleanPeers(JSON.parse(JSON.stringify(a))), a);
  assert.equal(a.out[0].token, x.token);
});

test('removed here by the owner: gone at once, and the host cannot put it back', () => {
  const x = intro();
  const first = taken([x]);
  const cut = pl.removeHere(first.peers, x.id);
  assert.equal(cut.in[0].removedHere, true);
  assert.equal(cut.in[0].hash, '');
  assert.equal(pl.peerByHash(cut, hashToken(x.token)), undefined);
  const back = taken([{ ...x, rev: 50 }], B.id, cut, 2, 1);
  assert.equal(back.peers.in[0].removedHere, true);
  assert.equal(back.peers.in[0].hash, '');
  assert.equal(back.taken, 0);
});

test('a host\'s link removed here ends every peer it gave, and no other', () => {
  const x = intro();
  const first = taken([x]);
  assert.equal(pl.endPeerGiver(first.peers, 'other-host').in[0].revoked, undefined);
  const cut = pl.endPeerGiver(first.peers, HOST);
  assert.equal(cut.in[0].revoked, true);
  assert.equal(cut.in[0].key, '');
});

test('the check: a live peer reaches the doors of its scopes and the ping, and nothing else', () => {
  const peer = taken([intro({ scopes: ['copy'] })]).peers.in[0];
  for (const door of [...pl.PEER_DOORS.copy, pl.PEER_HELLO]) assert.equal(pl.peerRefusal(state(), peer, door, LAN, NOW), null, door);
  for (const door of [...pl.PEER_DOORS.runner, ...pl.PEER_DOORS.cluster, '/worker/made-up-new-door']) {
    const no = pl.peerRefusal(state(), peer, door, LAN, NOW);
    assert.equal(no?.status, 403, door);
    assert.equal(no?.peer, 'refused', door);
  }
});

test('a peer with every scope still reaches no guest door and no host-only door outside its lists', () => {
  const peer = taken([intro({ scopes: ['copy', 'runner', 'cluster'] })]).peers.in[0];
  const open = [...pl.PEER_DOORS.copy, ...pl.PEER_DOORS.runner, ...pl.PEER_DOORS.cluster, pl.PEER_HELLO];
  for (const door of open) assert.ok(HOST_ONLY_DOORS.includes(door), `${door} is a door a linked PC has`);
  for (const door of [...GUEST_DOORS, ...HOST_ONLY_DOORS].filter(d => !open.includes(d))) assert.equal(pl.peerRefusal(state(), peer, door, LAN, NOW)?.peer, 'refused', door);
  for (const door of ['/worker/update-put', '/worker/power-off', '/worker/passes-put', '/worker/host-pin-set', '/worker/run', '/worker/backup-get', '/worker/git-put', '/worker/runner-remove', '/worker/model-remove']) assert.equal(pl.peerRefusal(state(), peer, door, LAN, NOW)?.status, 403, door);
});

test('the check: no record, a removed one, or its host no longer linked here as an admin: 401', () => {
  const peer = taken([intro()]).peers.in[0];
  const door = pl.PEER_DOORS.copy[0];
  assert.equal(pl.peerRefusal(state(), undefined, door, LAN, NOW)?.status, 401);
  assert.equal(pl.peerRefusal(state(), { ...peer, revoked: true }, door, LAN, NOW)?.status, 401);
  assert.equal(pl.peerRefusal(state(), { ...peer, key: '' }, door, LAN, NOW)?.status, 401);
  assert.equal(pl.peerRefusal(state({ paired: [] }), peer, door, LAN, NOW)?.peer, 'removed');
  assert.equal(pl.peerRefusal(state({ paired: [{ hash: 'e'.repeat(64), keep: 'other-host' }] }), peer, door, LAN, NOW)?.peer, 'removed');
  assert.equal(pl.peerRefusal(state({ paired: [{ hash: 'e'.repeat(64), keep: HOST, role: 'guest' }] }), peer, door, LAN, NOW)?.peer, 'removed', 'a guest link gives no peers');
});

test('the check: the owner\'s tick off, an address outside the home network, or its end passed', () => {
  const door = pl.PEER_DOORS.copy[0];
  const peer = taken([intro({ expires: new Date(NOW + DAY).toISOString() })]).peers.in[0];
  assert.equal(pl.peerRefusal(state(), peer, door, LAN, NOW), null);
  assert.equal(pl.peerRefusal(state({ allowPeers: false }), peer, door, LAN, NOW)?.peer, 'off');
  assert.equal(pl.peerRefusal(state({ allowPeers: false }), peer, pl.PEER_HELLO, LAN, NOW)?.peer, 'off', 'the ping too');
  for (const from of ['8.8.8.8', '', undefined]) assert.equal(pl.peerRefusal(state(), peer, door, from, NOW)?.peer, 'network', String(from));
  assert.equal(pl.peerRefusal(state(), peer, door, '::ffff:10.0.0.5', NOW), null);
  assert.equal(pl.peerRefusal(state(), peer, door, LAN, NOW + DAY)?.peer, 'ended', 'at its very end');
  assert.equal(pl.peerRefusal(state(), peer, pl.PEER_HELLO, LAN, NOW + 2 * DAY)?.peer, 'ended');
});

test('the check: a peer made for a guest pass ends with that pass', () => {
  const door = pl.PEER_DOORS.cluster[0];
  const peer = taken([intro({ scopes: ['cluster'], passId: 'p1p1p1p1' })]).peers.in[0];
  const pass = { id: 'p1p1p1p1', expires: new Date(NOW + DAY).toISOString(), nodes: [B.id] };
  assert.equal(pl.peerRefusal(state({ passes: [pass] }), peer, door, LAN, NOW), null);
  assert.equal(pl.peerRefusal(state({ passes: [] }), peer, door, LAN, NOW)?.status, 401, 'the pass is not here');
  assert.equal(pl.peerRefusal(state({ passes: [{ ...pass, revoked: true }] }), peer, door, LAN, NOW)?.status, 401);
  assert.equal(pl.peerRefusal(state({ passes: [{ ...pass, nodes: [C.id] }] }), peer, door, LAN, NOW)?.peer, 'scope');
  assert.equal(pl.peerRefusal(state({ passes: [pass] }), peer, door, LAN, NOW + DAY)?.peer, 'ended');
  assert.equal(pl.peerRefusal(state({ passes: [{ ...pass, expires: null }] }), peer, door, LAN, NOW + 400 * DAY), null, 'a pass with no end');
});

test('a peer\'s last use is saved the first time, then once a minute at most', () => {
  const peer = taken([intro()]).peers.in[0];
  assert.equal(pl.touchPeer(peer, NOW), true);
  assert.equal(pl.touchPeer(peer, NOW + 30_000), false);
  assert.equal(pl.touchPeer(peer, NOW + 61_000), true);
});

test('one PC keeps 100 peers from one host at most, the live ones first', () => {
  const many = Array.from({ length: pl.MAX_PEERS + 5 }, () => intro({}, C, B));
  const got = taken(many);
  assert.equal(got.peers.in.length, pl.MAX_PEERS);
});
