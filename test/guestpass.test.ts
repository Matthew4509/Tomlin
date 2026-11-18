// Guest passes (src/guestpass.ts): the pass record, the one function every door of a node asks about a linked PC, and
// how a new link joins the list. Plain functions; the doors themselves are tried on a real node in guestdoors.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gp from '../src/guestpass.ts';
import * as link from '../src/link.ts';

const NOW = Date.parse('2026-06-01T10:00:00Z');
const DAY = 86_400_000;
const NODE = { id: 'a1b2c3d4', name: 'Made-up node' };

/** A pass as kept, made by hand (a key of 32 made-up bytes). */
function pass(over: Partial<gp.GuestPass> = {}): gp.GuestPass {
  return { id: 'p1p1p1p1', label: 'Made-up laptop', key: Buffer.alloc(32, 7).toString('base64url'), length: 'week', created: new Date(NOW - DAY).toISOString(), expires: new Date(NOW + 6 * DAY).toISOString(), nodes: [NODE.id], models: ['chat-a', 'pic-b'], uses: 1, lastSeen: null, rev: 1, ...over };
}
const guest = (over: Record<string, unknown> = {}): Link => ({ name: 'Made-up laptop', hash: 'f'.repeat(64), at: new Date(NOW - DAY).toISOString(), key: 'k', role: 'guest' as const, passId: 'p1p1p1p1', expires: new Date(NOW + 6 * DAY).toISOString(), ...over });
type Link = gp.LinkRole & { name: string; hash: string; at: string; key: string };
const host = (over: Record<string, unknown> = {}): Link => ({ name: 'Main PC', hash: 'e'.repeat(64), at: new Date(NOW - DAY).toISOString(), key: 'k', ...over });
const state = (passes: gp.GuestPass[]) => ({ id: NODE.id, name: NODE.name, passes });

test('a pass code is the setup code\'s shape and alphabet: 8 characters, no 0 O 1 I L', () => {
  for (let i = 0; i < 200; i++) assert.match(gp.newPassCode(), /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
});

test('a pass made keeps only the slow key of its code, never the code; the lengths are 1 day, 1 week, no limit', async () => {
  for (const [length, ms] of [['day', DAY], ['week', 7 * DAY], ['none', null]] as const) {
    const made = await gp.makePass({ label: '  Sam\'s <b>laptop</b>  ', length, models: ['chat-a', 'chat-a', 7, 'pic-b'] }, NODE.id, NOW);
    assert.ok(!('error' in made), JSON.stringify(made));
    if ('error' in made) return;
    const kept = JSON.stringify(made.pass);
    const bare = made.code.replace('-', '');
    assert.ok(!kept.includes(made.code) && !kept.includes(bare), 'no clear code in the record');
    assert.equal(made.pass.key, (await link.pairKey(made.code, '')).toString('base64url'), 'the key the link is proven with (scrypt)');
    assert.equal(made.pass.expires, ms === null ? null : new Date(NOW + ms).toISOString());
    assert.equal(made.pass.length, length);
    assert.equal(made.pass.label, "Sam's blaptopb");
    assert.deepEqual(made.pass.models, ['chat-a', 'pic-b']);
    assert.deepEqual(made.pass.nodes, [NODE.id]);
    assert.equal(made.pass.uses, 0);
    assert.match(made.pass.id, /^[0-9a-f]{8}$/);
  }
  assert.ok('error' in (await gp.makePass({ label: 'x', length: 'month', models: [] }, NODE.id, NOW)), 'only the three lengths');
  assert.ok('error' in (await gp.makePass({ label: '', length: 'day', models: [] }, NODE.id, NOW)), 'a label is needed');
});

test('a pass is live until it ends or is removed', () => {
  assert.equal(gp.passLive(pass(), NOW), true);
  assert.equal(gp.passLive(pass({ expires: null }), NOW + 3650 * DAY), true, 'no limit');
  assert.equal(gp.passLive(pass({ expires: new Date(NOW).toISOString() }), NOW), false, 'ended at this very moment');
  assert.equal(gp.passLive(pass({ revoked: true, key: '' }), NOW), false);
  assert.equal(gp.passLive(pass({ key: '' }), NOW), false, 'no key, nothing to prove it with');
});

test('every door a linked PC can call: a guest gets only its models, its own answers and pulling updates; anything else, or unknown, is refused', () => {
  const s = state([pass()]);
  for (const door of gp.GUEST_DOORS) assert.equal(gp.doorRefusal(s, guest(), door, NOW), null, door);
  for (const door of [...gp.HOST_ONLY_DOORS, '/worker/tune-start', '/worker/carry-anything', '/worker/made-up-new-door', '/worker/update-offer', '/worker/update-put']) {
    const no = gp.doorRefusal(s, guest(), door, NOW);
    assert.equal(no?.status, 403, door);
    assert.equal(no?.guest, 'refused', door);
  }
  assert.deepEqual([...gp.GUEST_DOORS].sort(), ['/worker/draw', '/worker/hello', '/worker/result', '/worker/run', '/worker/stats', '/worker/stop', '/worker/taken', '/worker/tool-result', '/worker/update-get', '/worker/update-list', '/worker/usage'].sort());
  for (const door of gp.GUEST_DOORS) assert.ok(!gp.HOST_ONLY_DOORS.includes(door), `${door} is in one list only`);
  // The host PIN's doors (src/hostpin.ts) are a host's only: a guest can never give or take one.
  for (const door of ['/worker/host-pin-set', '/worker/host-pin-drop']) assert.ok(gp.HOST_ONLY_DOORS.includes(door), door);
});

test('a link with no role is today\'s link: every door is as before', () => {
  const s = state([]);
  for (const door of [...gp.GUEST_DOORS, ...gp.HOST_ONLY_DOORS, '/worker/made-up-new-door']) assert.equal(gp.doorRefusal(s, host(), door, NOW), null, door);
  assert.equal(gp.modelAllowed(s, host(), 'anything'), true);
});

test('an expired pass or link gives nothing at any door, hello too; it keeps its record', () => {
  const ended = new Date(NOW - 1000).toISOString();
  for (const [p, g] of [[pass({ expires: ended }), guest()], [pass(), guest({ expires: ended })]] as const) {
    // (Collecting work already done stays open for a while, and an expired link may ask its host: their own tests below.)
    for (const door of [...gp.GUEST_DOORS, ...gp.HOST_ONLY_DOORS].filter(x => !gp.COLLECT_DOORS.includes(x) && x !== gp.ASK_DOOR)) {
      const no = gp.doorRefusal(state([p]), g, door, NOW);
      assert.equal(no?.status, 403, door);
      assert.equal(no?.guest, 'expired', door);
      assert.equal(no?.expired, ended);
      assert.match(no!.error, /guest pass .*ended/);
    }
  }
});

test('a removed pass, a missing pass, another node or a role this copy does not know: refused', () => {
  assert.equal(gp.doorRefusal(state([pass({ revoked: true, key: '' })]), guest(), '/worker/hello', NOW)?.status, 401);
  assert.equal(gp.doorRefusal(state([]), guest(), '/worker/hello', NOW)?.status, 401);
  assert.equal(gp.doorRefusal(state([pass({ nodes: ['99999999'] })]), guest(), '/worker/hello', NOW)?.guest, 'scope');
  assert.equal(gp.doorRefusal(state([pass()]), guest({ role: 'owner' }), '/worker/hello', NOW)?.status, 403, 'fails closed');
});

test('a guest uses only the models its pass names', () => {
  const s = state([pass()]);
  assert.equal(gp.modelAllowed(s, guest(), 'chat-a'), true);
  assert.equal(gp.modelAllowed(s, guest(), 'pic-b'), true);
  assert.equal(gp.modelAllowed(s, guest(), 'chat-z'), false);
  assert.equal(gp.modelAllowed(s, guest(), ''), false);
  assert.equal(gp.modelAllowed(state([]), guest(), 'chat-a'), false);
});

test('a guest link never pushes out a host link; three links per pass at most, the oldest goes', () => {
  const hosts = Array.from({ length: 10 }, (_, i) => host({ name: `Host ${i}`, hash: String(i).repeat(64) }));
  // Hosts as before: ten at most, the oldest goes.
  const h = gp.addLink(hosts, host({ name: 'Host new' }));
  assert.equal(h.paired.length, 10);
  assert.equal(h.dropped, 'Host 0');
  // Guests beside ten hosts: no host goes.
  let list: Link[] = hosts;
  for (let i = 0; i < 5; i++) {
    const r = gp.addLink(list, guest({ name: `Guest ${i}` }));
    list = r.paired;
    assert.equal(r.dropped, i < 3 ? '' : `Guest ${i - 3}`);
  }
  assert.equal(list.filter(x => x.role === undefined).length, 10);
  assert.deepEqual(list.filter(x => x.role !== undefined).map(x => x.name), ['Guest 2', 'Guest 3', 'Guest 4']);
  // Another pass's links are not touched; a host link joining ignores the guests.
  const other = gp.addLink(list, guest({ name: 'Other guest', passId: 'p2p2p2p2' }));
  assert.equal(other.paired.filter(x => x.role !== undefined).length, 4);
  const hostAgain = gp.addLink(other.paired, host({ name: 'Host newer' }));
  assert.equal(hostAgain.paired.filter(x => x.role !== undefined).length, 4);
  assert.equal(hostAgain.paired.filter(x => x.role === undefined).length, 10);
  // With no guests, exactly as before.
  assert.deepEqual(gp.addLink(hosts.slice(0, 3), host({ name: 'Four' })).paired.map(x => x.name), ['Host 0', 'Host 1', 'Host 2', 'Four']);
});

test('Remove: the pass keeps no key, its links go, and it leaves the list', () => {
  const p = pass();
  const r = gp.revokePass([p, pass({ id: 'p2p2p2p2' })], [host(), guest(), guest({ passId: 'p2p2p2p2', name: 'Other' })], 'p1p1p1p1', NOW);
  assert.equal(r.passes[0].revoked, true);
  assert.equal(r.passes[0].key, '');
  // Its links stay for the window to collect work already done, then go.
  assert.deepEqual(gp.dropEnded(r.paired, NOW + gp.COLLECT_MS).map(x => x.name), ['Main PC', 'Other']);
  assert.deepEqual(gp.passView(r.passes, NOW).map(x => x.id), ['p2p2p2p2']);
});

test('what the page is shown has no key; an expired pass is marked', () => {
  const v = gp.passView([pass(), pass({ id: 'p3p3p3p3', expires: new Date(NOW - 1).toISOString() })], NOW);
  assert.ok(!JSON.stringify(v).includes(pass().key));
  assert.deepEqual(v.map(x => x.expired), [false, true]);
  assert.deepEqual(Object.keys(v[0]).sort(), ['created', 'expired', 'expires', 'from', 'id', 'label', 'lastSeen', 'length', 'models', 'nodeModels', 'nodes', 'renewals', 'uses']);
});

test('passes read from share.json: broken ones are dropped, removed ones kept without a key', () => {
  const kept = gp.cleanPasses([pass(), { id: 'zz' }, null, 'x', pass({ id: 'p4p4p4p4', revoked: true, key: 'still' }), pass({ id: 'p5p5p5p5', expires: 'not a date' })]);
  assert.deepEqual(kept.map(x => x.id), ['p1p1p1p1', 'p4p4p4p4']);
  assert.equal(kept[1].key, '');
  assert.deepEqual(gp.cleanPasses(undefined), []);
});

test('last seen is written at most once a minute', () => {
  const p = pass();
  assert.equal(gp.touchSeen(p, NOW), true);
  assert.equal(p.lastSeen, new Date(NOW).toISOString());
  assert.equal(gp.touchSeen(p, NOW + 30_000), false);
  assert.equal(gp.touchSeen(p, NOW + 61_000), true);
});

// ---- Phase 2: a host's passes copied to the nodes it is linked to (a backup node too) ----

const A = 'aaaa1111';
const B = 'bbbb2222';
const HOST_KEEP = 'feedfeedfeedfeed';
/** A pass made on a host for this PC and two nodes, each with its own models. */
const hostPass = (over: Partial<gp.GuestPass> = {}) => pass({ id: 'h1h1h1h1', nodes: [NODE.id, A, B], models: ['chat-a'], nodeModels: { [NODE.id]: ['chat-a'], [A]: ['a-chat'], [B]: [] }, uses: 4, lastSeen: new Date(NOW).toISOString(), ...over });
const adminLink = (over: Record<string, unknown> = {}): Link & { keep: string } => ({ ...host(), keep: HOST_KEEP, ...over });

test('a table generation only goes up, and goes on from the clock after a fresh start', () => {
  assert.equal(gp.nextGen(undefined, NOW), NOW);
  assert.equal(gp.nextGen(NOW + 5000, NOW), NOW + 5001, 'a clock set back does not go back');
  assert.ok(gp.nextGen(NOW, NOW + 10) > NOW);
});

test('what a node is sent: only the passes for it, as that node sees them (its models only), never a code; removed ones too', async () => {
  const made = await gp.makePass({ label: 'Office guest', length: 'day', models: [] }, NODE.id, NOW);
  assert.ok(!('error' in made));
  if ('error' in made) return;
  const own = { ...made.pass, nodes: [NODE.id, A], nodeModels: { [A]: ['a-chat'] } };
  const given = pass({ id: 'g1g1g1g1', nodes: [A], by: 'someone-else-key' });
  const gone = hostPass({ id: 'r9r9r9r9', revoked: true, key: '', rev: 3 });
  const sent = gp.syncSet([own, given, gone, hostPass({ id: 'x1x1x1x1', nodes: [NODE.id, B] })], A);
  assert.deepEqual(sent.map(x => x.id), [own.id, 'r9r9r9r9'], 'a pass given to this PC by another host is never passed on');
  assert.deepEqual(sent[0].nodes, [A]);
  assert.deepEqual(sent[0].models, ['a-chat']);
  assert.equal(sent[0].nodeModels, undefined);
  assert.equal(sent[0].uses, 0, 'uses and last seen stay where they happen');
  assert.equal(sent[1].revoked, true);
  assert.equal(sent[1].key, '');
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes(made.code) && !wire.includes(made.code.replace('-', '')), 'no clear code in the message');
});

test('a node takes a host\'s passes in order: newer generations and revisions only, repeats change nothing', () => {
  const sent = gp.syncSet([hostPass()], A);
  const first = gp.mergeFrom([], sent, { by: HOST_KEEP, gen: 10, nodeId: A });
  assert.equal(first.stale, false);
  assert.equal(first.passes.length, 1);
  assert.equal(first.passes[0].by, HOST_KEEP);
  assert.deepEqual(first.passes[0].models, ['a-chat']);
  // The same again: nothing new.
  const again = gp.mergeFrom(first.passes, sent, { by: HOST_KEEP, gen: 10, lastGen: 10, nodeId: A });
  assert.deepEqual(again.passes, first.passes);
  // Removed on the host (rev 2), then an older copy (gen 9, rev 1) arrives late: it is not brought back.
  const removed = gp.syncSet([hostPass({ revoked: true, key: '', rev: 2 })], A);
  const r = gp.mergeFrom(first.passes, removed, { by: HOST_KEEP, gen: 11, lastGen: 10, nodeId: A });
  assert.equal(r.passes[0].revoked, true);
  assert.equal(r.passes[0].key, '');
  const late = gp.mergeFrom(r.passes, sent, { by: HOST_KEEP, gen: 9, lastGen: 11, nodeId: A });
  assert.equal(late.stale, true);
  assert.equal(late.passes[0].revoked, true);
  // Even in a newer generation, a lower revision never brings a removed pass back.
  const lower = gp.mergeFrom(r.passes, sent, { by: HOST_KEEP, gen: 12, lastGen: 11, nodeId: A });
  assert.equal(lower.passes[0].revoked, true);
});

test('a pass the host no longer sends this node ends here; the node\'s own uses and last seen are kept', () => {
  const first = gp.mergeFrom([], gp.syncSet([hostPass()], A), { by: HOST_KEEP, gen: 10, nodeId: A });
  first.passes[0].uses = 7;
  const updated = gp.mergeFrom(first.passes, gp.syncSet([hostPass({ rev: 2, label: 'Renamed' })], A), { by: HOST_KEEP, gen: 11, lastGen: 10, nodeId: A });
  assert.equal(updated.passes[0].label, 'Renamed');
  assert.equal(updated.passes[0].uses, 7);
  const dropped = gp.mergeFrom(updated.passes, [], { by: HOST_KEEP, gen: 12, lastGen: 11, nodeId: A });
  assert.equal(dropped.passes[0].revoked, true);
});

test('a node keeps only whole records for itself: another node\'s, a broken one, or one that would take over another host\'s or its own pass is dropped', () => {
  const mine = pass({ id: 'm1m1m1m1', nodes: [A] });
  const other = pass({ id: 'o1o1o1o1', nodes: [A], by: 'otherhostkey0000' });
  const incoming: unknown[] = [
    { ...gp.syncSet([hostPass()], A)[0] },
    { ...gp.syncSet([hostPass({ id: 'n1n1n1n1' })], B)[0] },
    { ...gp.syncSet([hostPass({ id: 'k1k1k1k1' })], A)[0], key: 'not a key' },
    { ...gp.syncSet([hostPass({ id: 'k2k2k2k2' })], A)[0], expires: 'soon' },
    { ...mine, label: 'Taken over', rev: 9 },
    { ...other, label: 'Taken over', rev: 9 },
    'junk', null,
  ];
  const r = gp.mergeFrom([mine, other], incoming, { by: HOST_KEEP, gen: 10, nodeId: A });
  assert.deepEqual(r.passes.map(x => [x.id, x.label]), [['m1m1m1m1', 'Made-up laptop'], ['o1o1o1o1', 'Made-up laptop'], ['h1h1h1h1', 'Made-up laptop']]);
  assert.equal(r.taken, 1);
  assert.deepEqual(gp.mergeFrom([], 'not a list', { by: HOST_KEEP, gen: 10, nodeId: A }).passes, []);
});

test('a pass given by a host counts only while that host is still linked here as an admin; its models are its own', () => {
  const given = gp.mergeFrom([], gp.syncSet([hostPass()], A), { by: HOST_KEEP, gen: 10, nodeId: A }).passes;
  const at = (paired: Link[]) => ({ id: A, name: 'Office node', passes: given, paired });
  const g = guest({ passId: 'h1h1h1h1' });
  assert.equal(gp.doorRefusal(at([adminLink(), g]), g, '/worker/hello', NOW), null);
  assert.equal(gp.modelAllowed(at([adminLink(), g]), g, 'a-chat'), true);
  assert.equal(gp.modelAllowed(at([adminLink(), g]), g, 'chat-a'), false, 'the host\'s own models are not this node\'s');
  assert.equal(gp.doorRefusal(at([g]), g, '/worker/hello', NOW)?.status, 401, 'its host was unlinked here');
  assert.equal(gp.doorRefusal(at([adminLink({ role: 'guest' }), g]), g, '/worker/hello', NOW)?.status, 401, 'a guest link is no giver');
});

test('expiry is kept by the node\'s own clock, with no host to ask', () => {
  const given = gp.mergeFrom([], gp.syncSet([hostPass({ expires: new Date(NOW + 1000).toISOString() })], A), { by: HOST_KEEP, gen: 10, nodeId: A }).passes;
  const st = { id: A, name: 'Office node', passes: given, paired: [adminLink()] };
  const g = guest({ passId: 'h1h1h1h1', expires: null });
  assert.equal(gp.doorRefusal(st, g, '/worker/hello', NOW), null);
  assert.equal(gp.doorRefusal(st, g, '/worker/hello', NOW + 1000)?.guest, 'expired');
});

test('a node keeps 200 passes from one host at most', () => {
  const many = Array.from({ length: 250 }, (_, i) => gp.syncSet([hostPass({ id: `z${String(i).padStart(7, '0')}` })], A)[0]);
  assert.equal(gp.mergeFrom([], many, { by: HOST_KEEP, gen: 10, nodeId: A }).passes.length, 200);
});

test('a host linked again under a new link takes over the passes its old, removed link gave; a host still linked keeps its own', () => {
  const old = gp.mergeFrom([], gp.syncSet([hostPass()], A), { by: 'oldlinkoldlink00', gen: 10, nodeId: A }).passes;
  const sent = gp.syncSet([hostPass({ label: 'From the new link' })], A);
  const kept = gp.mergeFrom(old, sent, { by: HOST_KEEP, gen: 11, nodeId: A, gone: () => false });
  assert.equal(kept.passes[0].by, 'oldlinkoldlink00', 'another host still linked here keeps its pass');
  const taken = gp.mergeFrom(old, sent, { by: HOST_KEEP, gen: 11, nodeId: A, gone: by => by === 'oldlinkoldlink00' });
  assert.equal(taken.passes[0].by, HOST_KEEP);
  assert.equal(taken.passes[0].label, 'From the new link');
});

test('the pair door tries only passes it could honor: live, for this node, from a host still linked here', () => {
  const given = gp.mergeFrom([], gp.syncSet([hostPass()], A), { by: HOST_KEEP, gen: 10, nodeId: A }).passes;
  assert.equal(gp.passUsable({ id: A, name: 'Office node', passes: given, paired: [adminLink()] }, given[0], NOW), true);
  assert.equal(gp.passUsable({ id: A, name: 'Office node', passes: given, paired: [] }, given[0], NOW), false);
  assert.equal(gp.passUsable({ id: B, name: 'Backup node', passes: given, paired: [adminLink()] }, given[0], NOW), false);
});

// ---- Phase 3: an ended pass, the access request, collecting work, and the guest's pull ----

const ENDED = new Date(NOW - 60_000).toISOString();
const expiredState = (over: Partial<gp.GuestPass> = {}) => state([pass({ expires: ENDED, ...over })]);
const ask = (over: Partial<gp.PassAsk> = {}): gp.PassAsk => ({ id: 'q1q1q1q1', link: 'f'.repeat(64), name: 'Made-up laptop', passId: 'p1p1p1p1', expired: ENDED, text: 'hi, its me', at: new Date(NOW - 1000).toISOString(), ...over });

test('a request is plain text of 200 characters at most: markup, control characters and extra spaces go', () => {
  assert.equal(gp.cleanAskText('  hi <b>its</b> me\u0000\n\n please <script>alert(1)</script> '), 'hi its me please alert(1)');
  assert.equal(gp.cleanAskText('x'.repeat(500)).length, gp.ASK_TEXT_MAX);
  assert.equal(gp.ASK_TEXT_MAX, 200);
  assert.equal(gp.cleanAskText(undefined), '');
});

test('only an expired link may ask; a live, removed or blocked one may not', () => {
  const g = guest({ expires: null });
  assert.equal(gp.doorRefusal(expiredState(), g, '/worker/pass-ask', NOW), null);
  assert.equal(gp.doorRefusal(state([pass()]), g, '/worker/pass-ask', NOW)?.guest, 'refused', 'a live pass has nothing to ask');
  assert.equal(gp.doorRefusal(state([pass({ revoked: true, key: '' })]), g, '/worker/pass-ask', NOW)?.status, 401, 'removed: no request');
  assert.equal(gp.doorRefusal(state([]), g, '/worker/pass-ask', NOW)?.status, 401);
  assert.equal(gp.doorRefusal(expiredState(), guest({ expires: null, blocked: true }), '/worker/pass-ask', NOW)?.guest, 'blocked');
  assert.equal(gp.doorRefusal(expiredState(), host(), '/worker/pass-ask', NOW), null, 'a link with no role: as every door (the door itself refuses it)');
  // Nothing else from an expired link.
  for (const door of ['/worker/hello', '/worker/run', '/worker/update-list']) assert.equal(gp.doorRefusal(expiredState(), g, door, NOW)?.guest, 'expired', door);
});

test('one request waiting per link, 10 minutes between requests, 5 a day', () => {
  const link = 'f'.repeat(64);
  assert.equal(gp.askWhy([], link, NOW), '');
  assert.match(gp.askWhy([ask()], link, NOW), /already waiting/);
  assert.match(gp.askWhy([ask({ answer: 'denied', answeredAt: new Date(NOW).toISOString() })], link, NOW + 60_000), /minutes/);
  assert.equal(gp.askWhy([ask({ answer: 'denied', answeredAt: new Date(NOW).toISOString() })], link, NOW + 11 * 60_000), '');
  const five = Array.from({ length: 5 }, (_, i) => ask({ id: `q${i}q${i}q${i}q${i}`, at: new Date(NOW - (i + 1) * 3600_000).toISOString(), answer: 'denied', answeredAt: new Date(NOW - (i + 1) * 3600_000).toISOString() }));
  assert.match(gp.askWhy(five, link, NOW), /5 requests/);
  assert.equal(gp.askWhy([ask({ link: 'e'.repeat(64) })], link, NOW), '', 'another link\'s does not count');
});

test('Approve renews the same link (its own end date counts from then on); Deny keeps a reason; Block silences the link', () => {
  const g = guest({ expires: ENDED });
  const paired = [host(), g];
  const asks = [ask()];
  const renewed = gp.answerAsk(asks, paired, 'q1q1q1q1', { answer: 'renew', length: 'week' }, NOW);
  assert.ok(!('error' in renewed));
  if ('error' in renewed) return;
  const link = renewed.paired.find(x => x.role === 'guest')!;
  assert.equal(link.hash, g.hash, 'the same link: the guest types nothing');
  assert.equal(link.expires, new Date(NOW + 7 * DAY).toISOString());
  assert.equal(link.renewed, true);
  assert.equal(renewed.asks[0].answer, 'renewed');
  // The renewed link counts past its pass's own end.
  assert.equal(gp.doorRefusal(expiredState(), link, '/worker/hello', NOW + DAY), null);
  assert.equal(gp.doorRefusal(expiredState(), link, '/worker/hello', NOW + 8 * DAY)?.guest, 'expired');
  // Removing the pass still ends it.
  assert.equal(gp.doorRefusal(state([pass({ revoked: true, key: '' })]), link, '/worker/hello', NOW + DAY)?.status, 401);
  const denied = gp.answerAsk(asks, paired, 'q1q1q1q1', { answer: 'deny', reason: 'Not <i>this</i> week' }, NOW);
  assert.ok(!('error' in denied) && denied.asks[0].answer === 'denied' && denied.asks[0].reason === 'Not this week');
  const blocked = gp.answerAsk(asks, paired, 'q1q1q1q1', { answer: 'block' }, NOW);
  assert.ok(!('error' in blocked) && blocked.paired.find(x => x.role === 'guest')!.blocked === true && blocked.asks[0].answer === 'blocked');
  assert.ok('error' in gp.answerAsk(asks, paired, 'nope0000', { answer: 'deny' }, NOW));
  assert.ok('error' in gp.answerAsk([ask({ answer: 'denied' })], paired, 'q1q1q1q1', { answer: 'renew', length: 'day' }, NOW), 'answered once only');
  assert.ok('error' in gp.answerAsk(asks, paired, 'q1q1q1q1', { answer: 'renew', length: 'month' }, NOW));
});

test('what a guest is told with its refusal: its request\'s state and reason, and whether it may ask', () => {
  const g = guest({ expires: ENDED });
  assert.deepEqual(gp.askState([], g), { canAsk: true, ask: null });
  assert.deepEqual(gp.askState([ask()], g), { canAsk: false, ask: { state: 'waiting', at: ask().at, reason: '' } });
  assert.deepEqual(gp.askState([ask({ answer: 'denied', reason: 'No' })], g).ask, { state: 'denied', at: ask().at, reason: 'No' });
  assert.equal(gp.askState([], guest({ blocked: true })).canAsk, false);
});

test('a guest whose pass ended collects work already done for 2 hours, and nothing new runs', () => {
  assert.equal(gp.COLLECT_MS, 2 * 3600_000);
  const g = guest({ expires: null });
  for (const door of gp.COLLECT_DOORS) {
    assert.equal(gp.doorRefusal(expiredState(), g, door, NOW), null, `${door}: just expired`);
    assert.equal(gp.doorRefusal(expiredState(), g, door, Date.parse(ENDED) + gp.COLLECT_MS + 1)?.guest, 'expired', `${door}: after the window`);
    // Removed (its link stamped when it ended): the same window.
    const removed = guest({ endedAt: new Date(NOW - 1000).toISOString() });
    assert.equal(gp.doorRefusal(state([pass({ revoked: true, key: '' })]), removed, door, NOW), null, `${door}: just removed`);
    assert.equal(gp.doorRefusal(state([pass({ revoked: true, key: '' })]), removed, door, NOW + gp.COLLECT_MS)?.status, 401);
  }
  assert.deepEqual([...gp.COLLECT_DOORS].sort(), ['/worker/result', '/worker/stop', '/worker/taken']);
  for (const door of ['/worker/run', '/worker/draw', '/worker/hello']) assert.equal(gp.doorRefusal(expiredState(), g, door, NOW)?.guest, 'expired', door);
});

test('a host unlinked here ends its passes now: their guests get the collect window, then nothing', () => {
  const given = gp.mergeFrom([], gp.syncSet([hostPass()], A), { by: HOST_KEEP, gen: 10, nodeId: A }).passes;
  const g = guest({ passId: 'h1h1h1h1' });
  const r = gp.endGiver(given, [adminLink(), g], HOST_KEEP, NOW);
  assert.equal(r.passes[0].revoked, true);
  assert.equal(r.paired.find(x => x.role === 'guest')!.endedAt, new Date(NOW).toISOString());
  const st = { id: A, name: 'Office node', passes: r.passes, paired: r.paired };
  const ended = r.paired.find(x => x.role === 'guest')!;
  assert.equal(gp.doorRefusal(st, ended, '/worker/result', NOW + 1000), null);
  assert.equal(gp.doorRefusal(st, ended, '/worker/hello', NOW + 1000)?.status, 401);
});

test('Remove keeps the guest link only for the collect window, stamped, and drops it after', () => {
  const r = gp.revokePass([pass()], [host(), guest()], 'p1p1p1p1', NOW);
  assert.equal(r.paired.length, 2);
  assert.equal(r.paired[1].endedAt, new Date(NOW).toISOString());
  assert.deepEqual(gp.dropEnded(r.paired, NOW + gp.COLLECT_MS - 1).map(x => x.name), ['Main PC', 'Made-up laptop']);
  assert.deepEqual(gp.dropEnded(r.paired, NOW + gp.COLLECT_MS).map(x => x.name), ['Main PC']);
});

test('a guest network\'s update: only a newer version, and over a home network only when the owner picks it', () => {
  const home = { id: 'home0001', role: undefined };
  const office = { id: 'offi0001', role: 'guest' as const };
  assert.equal(gp.guestPullWhy(office, [office], '2.0.97', '2.0.96', false), '');
  assert.match(gp.guestPullWhy(office, [office], '2.0.96', '2.0.96', false), /newer/, 'the same version with other files is not taken from a guest network');
  assert.match(gp.guestPullWhy(office, [office], '2.0.95', '2.0.96', false), /newer/);
  assert.match(gp.guestPullWhy(office, [home, office], '2.0.97', '2.0.96', false), /choose/);
  assert.equal(gp.guestPullWhy(office, [home, office], '2.0.97', '2.0.96', true), '');
  assert.equal(gp.guestPullWhy(home, [home, office], '2.0.96', '2.0.96', false), '', 'an admin link: as before');
});

test('what Search says about a PC it found: admin, guest with its end, pass expired, or enter the code', () => {
  assert.equal(gp.foundState(undefined, NOW).state, 'new');
  assert.equal(gp.foundState(undefined, NOW).text, 'Network found: enter the code');
  assert.equal(gp.foundState({ role: undefined }, NOW).text, 'You are already connected (admin)');
  assert.equal(gp.foundState({ role: 'guest', expires: new Date(NOW + 3 * DAY).toISOString() }, NOW).text, 'Connected as guest, expires in 3 days');
  assert.equal(gp.foundState({ role: 'guest', expires: new Date(NOW + 3600_000).toISOString() }, NOW).text, 'Connected as guest, expires in 1 hour');
  assert.equal(gp.foundState({ role: 'guest', expires: null }, NOW).text, 'Connected as guest, no end date');
  assert.equal(gp.foundState({ role: 'guest', passEnd: { state: 'expired', at: ENDED } }, NOW).text, 'Pass expired: ask the host');
  assert.equal(gp.foundState({ role: 'guest', passEnd: { state: 'removed', at: ENDED } }, NOW).state, 'new', 'removed: as a network never joined');
});

// ---- Phase 3 follow-up: Renew for (days, or never expires), and the host's list shows a renewed link's end ----

test('Renew for: 1, 2 or 3 days, 1 or 2 weeks, 30 or 90 days, or Never expires; nothing else', () => {
  assert.deepEqual(gp.RENEW_LENGTHS.map(x => x.id), ['day', '2days', '3days', 'week', '2weeks', '30days', '90days', 'never']);
  assert.deepEqual(gp.RENEW_LENGTHS.map(x => x.label), ['1 day', '2 days', '3 days', '1 week', '2 weeks', '30 days', '90 days', 'Never expires']);
  const g = guest({ expires: ENDED });
  for (const [id, days] of [['day', 1], ['2days', 2], ['3days', 3], ['week', 7], ['2weeks', 14], ['30days', 30], ['90days', 90]] as const) {
    const r = gp.answerAsk([ask()], [host(), g], 'q1q1q1q1', { answer: 'renew', length: id }, NOW);
    assert.ok(!('error' in r), id);
    if ('error' in r) return;
    assert.equal(r.paired[1].expires, new Date(NOW + days * DAY).toISOString(), id);
    assert.equal(r.ask.length, id);
  }
  for (const id of ['never', 'none']) {
    const r = gp.answerAsk([ask()], [host(), g], 'q1q1q1q1', { answer: 'renew', length: id }, NOW);
    assert.ok(!('error' in r), id);
    if ('error' in r) return;
    assert.equal(r.paired[1].expires, null, `${id}: no end`);
    assert.equal(r.ask.length, 'never');
    assert.equal(gp.doorRefusal(expiredState(), r.paired[1], '/worker/hello', NOW + 1000 * DAY), null, 'still open years on');
  }
  for (const bad of ['month', '', 7, null]) assert.ok('error' in gp.answerAsk([ask()], [host(), g], 'q1q1q1q1', { answer: 'renew', length: bad }, NOW), String(bad));
});

test('the host notes each renewal on its pass; its list shows the renewed guest\'s new end, not only the expired pass', () => {
  const until = new Date(NOW + 7 * DAY).toISOString();
  const p = pass({ expires: ENDED });
  const noted = gp.noteRenewal([p], 'p1p1p1p1', { pc: A, pcName: 'Office node', name: 'Made-up laptop', until }, NOW);
  const v = gp.passView(noted, NOW)[0];
  assert.equal(v.expired, true, 'the pass itself still ended');
  assert.deepEqual(v.renewals, [{ pcName: 'Office node', name: 'Made-up laptop', until, live: true }]);
  // The same guest renewed again: one line, the newer end.
  const again = gp.noteRenewal(noted, 'p1p1p1p1', { pc: A, pcName: 'Office node', name: 'Made-up laptop', until: null }, NOW + 1000);
  assert.deepEqual(gp.passView(again, NOW).at(0)!.renewals, [{ pcName: 'Office node', name: 'Made-up laptop', until: null, live: true }]);
  // One that has ended again is shown as ended.
  assert.equal(gp.passView(noted, NOW + 8 * DAY)[0].renewals[0].live, false);
  // Never sent to a node, and kept through share.json.
  assert.equal(JSON.stringify(gp.syncSet([{ ...noted[0], nodes: [A] }], A)).includes('renewals'), false);
  assert.deepEqual(gp.cleanPasses(noted)[0].renewals, noted[0].renewals);
  assert.deepEqual(gp.noteRenewal([p], 'nope0000', { pc: A, pcName: 'x', name: 'y', until }, NOW), [p], 'no such pass: nothing changes');
});
