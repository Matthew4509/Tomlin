// A host changes a linked PC's sharing permissions from its own Network page (src/permset.ts): only with that PC's tick
// "Allow host to test and change model run settings", its PIN (or the host PIN) for each change, never that tick itself,
// never from a guest link; each change said on that PC's screen and log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, link, NODE_PIN, nodeHome, startPc, unlock, until, type Pc } from './pcs.ts';
import { PERM_CAN, PERM_DOOR, PERM_KEYS, PERM_WORDS, cleanPermSet, permSetSide, permWords, type PermKey, type PermSet } from '../src/permset.ts';
import { GUEST_DOORS } from '../src/guestpass.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const none = Object.fromEntries(PERM_KEYS.map(k => [k, false])) as Record<PermKey, boolean>;

/** A node with the given tick, PIN "2468", and permissions kept in memory. */
function node(o: { tune?: boolean; saveFails?: boolean } = {}) {
  const perms = { ...none };
  const notes: string[] = [];
  const tries: unknown[] = [];
  const door = permSetSide({
    allowed: () => o.tune !== false,
    pcName: () => 'Worker PC',
    pinCheck: async (pin, _who, host) => {
      tries.push(host ? { host: host.pin } : pin);
      return (host ? host.pin : pin) === '2468' ? { ok: true } : { status: 403, error: 'says that PIN is wrong' };
    },
    current: () => ({ ...perms }),
    apply: async (set: PermSet, said: string) => {
      if (o.saveFails) throw new Error('the disk is full');
      Object.assign(perms, set);
      if (said) notes.push(said);
    },
  });
  return { door, perms, notes, tries };
}
const host = { key: 'k1', name: 'Main PC', link: 'abc' };

test('only known permissions, each on or off; "tune" and anything else is refused', () => {
  assert.deepEqual(cleanPermSet({ lend: true, plainLinks: false }), { lend: true, plainLinks: false });
  assert.match(cleanPermSet({ tune: true }) as string, /changed only at that PC itself/);
  assert.match(cleanPermSet({ peer: true }) as string, /not a permission another PC can change/);
  assert.match(cleanPermSet({ lend: 'yes' }) as string, /must be on or off/);
  assert.equal(typeof cleanPermSet({}), 'string');
  assert.equal(typeof cleanPermSet(null), 'string');
  assert.equal(typeof cleanPermSet([true]), 'string');
  assert.ok(!(PERM_KEYS as readonly string[]).includes('tune'));
  for (const k of PERM_KEYS) assert.ok(PERM_WORDS[k], k);
});

test('the words name what changed and who changed it; nothing changed says nothing', () => {
  assert.equal(permWords(none, { lend: true, plainLinks: true }, 'Main PC'), `"Main PC" changed this PC's permissions: Allow to be used as part of a cluster on, Allow unencrypted cluster links on.`);
  assert.equal(permWords(none, { lend: false }, 'Main PC'), '');
});

test('without the owner\'s tick the door answers nothing else (it would only serve to try PINs)', async () => {
  const n = node({ tune: false });
  const a = await n.door({ set: { plainLinks: true }, appPin: '2468' }, host);
  assert.equal(a.status, 403);
  assert.match(String(a.json.error), /Allow host to test and change model run settings/);
  assert.equal(n.tries.length, 0, 'no PIN was checked');
  assert.equal(n.perms.plainLinks, false);
});

test('a wrong PIN changes nothing and asks again; the right one (or the host PIN) changes it and says so there', async () => {
  const n = node();
  const wrong = await n.door({ set: { plainLinks: true }, appPin: '1111' }, host);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.needPin, true);
  assert.equal(n.perms.plainLinks, false);
  const right = await n.door({ set: { plainLinks: true }, appPin: '2468' }, host);
  assert.equal(right.status, 200);
  assert.equal(n.perms.plainLinks, true);
  assert.match(String(right.json.said), /^Changed "Worker PC"'s permissions: Allow unencrypted cluster links on\.$/);
  assert.deepEqual(n.notes, [`"Main PC" changed this PC's permissions: Allow unencrypted cluster links on.`]);
  const byHost = await n.door({ set: { lend: true }, hostPin: '2468' }, host);
  assert.equal(byHost.status, 200);
  assert.deepEqual(n.tries.at(-1), { host: '2468' });
  assert.equal(n.perms.lend, true);
});

test('a bad request is refused before any PIN is checked; a failed save says so', async () => {
  const n = node();
  const bad = await n.door({ set: { tune: false }, appPin: '2468' }, host);
  assert.equal(bad.status, 400);
  assert.equal(n.tries.length, 0);
  const f = node({ saveFails: true });
  const a = await f.door({ set: { lend: true }, appPin: '2468' }, host);
  assert.equal(a.status, 500);
  assert.match(String(a.json.error), /could not save its permissions: the disk is full/);
});

test('the node has the door, says it can, and a guest link never reaches it', () => {
  const nodeTs = read('src', 'jobrun', 'node.ts');
  assert.match(nodeTs, /if \(p === PERM_DOOR\) \{\s*const a = await permNode\(body/);
  assert.equal((nodeTs.match(/'power-off', PERM_CAN, 'peers'/g) ?? []).length, 2, 'both hellos say perm-set');
  // The PIN check, except on a Bootable USB node with no app lock, where the admin key's link stands for it.
  assert.match(nodeTs, /allowed: \(\) => carry\.cleanAllow\(shareState\.allow\)\.tune,\s*pcName: \(\) => shareState\.name,\s*pinCheck: usbAdminCheck\(\(pin, who, host\) => d\.updatePinCheck\(pin, who, 'perms', host\)\)/);
  assert.match(nodeTs, /if \(usbStick && !d\.appLockOn\(\) && shareState\.paired\.some\(x => x\.byKey === true && keepOf\(x\) === who\)\)/);
  assert.match(nodeTs, /permChanges\.unshift\(\{ said, at/);
  assert.match(nodeTs, /runChanges, permChanges, lend/);
  assert.ok(!GUEST_DOORS.includes(PERM_DOOR));
  assert.equal(PERM_CAN, 'perm-set');
});

test('the host asks through its route, with the PIN or the host PIN, and refuses a PC without the tick or the door', () => {
  const copies = read('src', 'jobrun', 'copies.ts');
  assert.match(copies, /export async function permSetOn\(/);
  assert.match(copies, /if \(h\.allow\?\.tune !== true\) return \{ status: 409/);
  assert.match(copies, /h\.can\.includes\(PERM_CAN\)/);
  assert.match(copies, /wireFor\(r\)\.ask\(PERM_DOOR, \{ \.\.\.sent, set: b\.set \}\)/);
  assert.match(read('src', 'jobrun.ts'), /case '\/api\/network\/perm-set': reply\(await permSetOn\(b\)\); return true;/);
  assert.match(read('src', 'hostpin.ts'), /doing === 'perms' \? 'change its permissions'/);
});

test('Network here: a fold of that PC\'s switches in its own words, the unencrypted one asked twice, its page saying who changed what', () => {
  const home = read('public', 'home.js');
  for (const k of PERM_KEYS) assert.ok(home.includes(`['${k}', '${PERM_WORDS[k]}']`), k);
  assert.match(home, /permsPart\(p\),/);
  assert.match(home, /if \(!p\.ok \|\| !p\.can\?\.includes\('perm-set'\)\) return null;/);
  assert.match(home, /if \(k === 'plainLinks' && on && !confirm\(/);
  assert.match(home, /api\('\/api\/network\/perm-set'/);
  assert.match(home, /sh\.permChanges \?\? \[\]/);
  // The tick that allows it says so, on that PC.
  assert.match(read('public', 'index.html'), /id="allow-tune-tip">[^<]*lets the host change the other switches here[^<]*This switch itself can only be changed at this PC\./);
});

test('two PCs: the host turns on the node\'s unencrypted links from its own page, only with the tick and that PC\'s PIN', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-perms-'));
  const pcs: Pc[] = [];
  try {
    const workerPort = await freePort();
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    const noOllama = join(top, 'no-ollama');
    mkdirSync(noOllama);
    const node = await startPc({ root: fileURLToPath(new URL('..', import.meta.url)), home: nodeDir, env: { OLLAMA: noOllama } });
    pcs.push(node);
    const host = await startPc({ root: fileURLToPath(new URL('..', import.meta.url)), home: join(top, 'host'), env: { OLLAMA: noOllama } });
    pcs.push(host);
    const pc = await link(host, workerPort);
    await unlock(node);
    const seen = async () => ((await host.get('/api/nodes/others')).body.pcs as any[]).find(x => x.id === pc);
    const hello = await until('the node\'s hello', async () => ((await seen())?.ok ? seen() : null), 30_000);
    assert.ok(hello.can.includes('perm-set'), JSON.stringify(hello.can));
    const plainThere = () => JSON.parse(readFileSync(join(nodeDir, 'data', 'share.json'), 'utf8')).plainLinks === true;
    const change = (set: Record<string, unknown>, nodePin?: string) => host.post('/api/network/perm-set', { pc, set, ...(nodePin ? { nodePin } : {}) });

    // Without the node's tick: refused here, nothing changed there.
    const early = await change({ plainLinks: true }, NODE_PIN);
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.match(early.body.error, /Allow host to test and change model run settings/);
    assert.equal(plainThere(), false);

    // Its owner ticks it at the node; the host hears it.
    const tick = await node.post('/api/share', { allow: { tune: true }, appPin: NODE_PIN });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    await until('the host to see the tick', async () => (await seen())?.allow?.tune === true, 30_000);

    // No PIN, then a wrong one: asked for, nothing changed.
    const bare = await change({ plainLinks: true });
    assert.equal(bare.status, 403, JSON.stringify(bare.body));
    assert.equal(bare.body.needNodePin, true);
    const wrong = await change({ plainLinks: true }, '13579135');
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
    assert.equal(plainThere(), false);

    // The tick itself is never changed from here, even with the right PIN.
    const tune = await change({ tune: false }, NODE_PIN);
    assert.equal(tune.status, 400, JSON.stringify(tune.body));

    // The node's own PIN: changed there, said there, and the host sees it.
    const ok = await change({ plainLinks: true }, NODE_PIN);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.said, /Allow unencrypted cluster links on/);
    assert.equal(plainThere(), true);
    const view = (await node.get('/api/nodes')).body.share;
    assert.match(view.permChanges[0].said, /changed this PC's permissions: Allow unencrypted cluster links on\./);
    assert.equal(view.allow.tune, true, 'the tick stays as its owner left it');
    await until('the host to see it allowed there', async () => (await seen())?.plainOk === true, 30_000);
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
