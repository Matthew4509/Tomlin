// Friction found by using the app: Enter in a search, a saved message out of sight, a failure wiped by a refresh, words
// about ticks that do not exist, where a new install opens, the Backups page's empty list, and stopping use of a linked
// PC (who it affects, a failed removal, and hires going back on it when it is linked again). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Staff, parkedOnly, restored, whenReleased } from '../src/staff.ts';
import { codeIn, freePort, link, nodeHome, startPc, type Pc } from './pcs.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('Enter in Hire staff\'s model search only filters: it never hires', () => {
  assert.match(read('public/hire.js'), /\$\('#hs-search'\)\.addEventListener\('keydown', e => \{\s*if \(e\.key === 'Enter'\) e\.preventDefault\(\);/);
});

test('a message in the PC window is scrolled into sight', () => {
  const say = /function say\(text, fault = false\) \{[\s\S]*?\n  \}/.exec(read('public/pcs.js'))![0];
  assert.match(say, /scrollIntoView/);
});

test('Update all\'s failures stay until the next press, whatever refreshes the page', () => {
  const home = read('public/home.js');
  assert.match(home, /let updateAllFaults = '';/);
  assert.match(home, /b\.onclick = async \(\) => \{\s*b\.disabled = true;\s*updateAllFaults = '';/);
  assert.match(home, /updateAllFaults = failed\.length \?/);
  // What the refresh writes keeps them.
  const lines = [...home.matchAll(/\$\('#node-update-all-line'\)\.textContent = (.*)/g)].map(m => m[1]);
  assert.ok(lines.length, 'the line is drawn');
  for (const l of lines) assert.match(l, /updateAllFaults/, l);
});

test('no words send a person to ticks that do not exist', () => {
  for (const f of ['public/hire.js', 'public/pcs.js', 'public/home.js', 'public/team.js', 'public/index.html']) {
    assert.doesNotMatch(read(f), /tick the models|tick them on|models ticked/, f);
  }
  assert.match(read('public/hire.js'), /has no \$\{thing\} yet/);
  assert.match(read('public/pcs.js'), /\$\{v\.name\} has no models yet/);
});

test('a brand-new install opens on Home\'s setup steps; someone who left a chat open comes back to it', () => {
  assert.match(read('public/home.js'), /setView\(phone\.matches \? 'rail' : store\('view'\) === 'chat' \? 'chat' : 'home'\);/);
});

test('the Backups page offers the projects made in TOMLIN, in the same list as the Projects page', () => {
  assert.match(read('public/bridge/index.html'), /id="bk-home-projects"/);
  assert.match(read('public/bridge/js/projects.js'), /function drawHomeProjects\(box, after\)/);
  const backups = read('public/bridge/js/backups.js');
  assert.match(backups, /drawHomeProjects\(\$\('bk-home-projects'\)/);
  assert.match(backups, /loadHomeProjects\(\)/);
  assert.match(backups, /Add one from Made in TOMLIN/);
});

test('Stop using a PC names who it affects, and says when it failed', () => {
  const home = read('public/home.js');
  const remove = /text: 'Remove', onclick: async \(\) => \{[\s\S]*?\n      \} \}\)\)\);/.exec(home)![0];
  assert.match(remove, /action: 'on-it'/);
  assert.match(remove, /Release for now/);
  assert.match(remove, /Remove for good/);
  assert.match(remove, /forGood/);
  assert.doesNotMatch(remove, /catch\(\(\) => undefined\)/, 'a failed removal is not swallowed');
  assert.match(remove, /sayHere\(box, err\.message\)/);
});

// ---- What happens to a hire ----

test('releasing a PC: the hire moves to their second model, and the place is remembered', () => {
  const ref = 'remote:0a1b2c3d:big.gguf';
  const onIt = (r?: string | null) => !!r && r.startsWith('remote:0a1b2c3d');
  assert.deepEqual(whenReleased({ model: ref, fallback: 'small.gguf' }, '0a1b2c3d', onIt), { model: 'small.gguf', fallback: null, parked: [{ pc: '0a1b2c3d', model: ref, fallback: 'small.gguf', left: 'small.gguf' }] });
  assert.deepEqual(whenReleased({ model: ref }, '0a1b2c3d', onIt), { model: null, fallback: null, parked: [{ pc: '0a1b2c3d', model: ref, fallback: null, left: null }] });
  assert.deepEqual(whenReleased({ model: 'small.gguf', fallback: ref }, '0a1b2c3d', onIt), { model: 'small.gguf', fallback: null, parked: [{ pc: '0a1b2c3d', model: 'small.gguf', fallback: ref, left: 'small.gguf' }] });
  assert.equal(whenReleased({ model: 'small.gguf' }, '0a1b2c3d', onIt), null, 'not on it: nothing changes');
  // For good: the same move, and nothing remembered.
  assert.deepEqual(whenReleased({ model: ref, fallback: 'small.gguf' }, '0a1b2c3d', onIt, true), { model: 'small.gguf', fallback: null, parked: [] });
});

test('linked again: the hire goes back, unless the person has since picked another model', () => {
  const ref = 'remote:0a1b2c3d:big.gguf';
  const place = { pc: '0a1b2c3d', model: ref, fallback: 'small.gguf', left: 'small.gguf' };
  assert.deepEqual(restored({ model: 'small.gguf', fallback: null, parked: [place] }, '0a1b2c3d'), { model: ref, fallback: 'small.gguf', parked: [] });
  assert.deepEqual(restored({ model: null, parked: [{ ...place, fallback: null, left: null }] }, '0a1b2c3d'), { model: ref, fallback: null, parked: [] });
  assert.deepEqual(restored({ model: 'picked-since.gguf', fallback: null, parked: [place] }, '0a1b2c3d'), { parked: [] }, 'their later choice stays');
  assert.equal(restored({ model: 'small.gguf', parked: [place] }, 'ffffffff'), null, 'another PC changes nothing');
  assert.equal(restored({ model: 'small.gguf' }, '0a1b2c3d'), null);
});

test('a remembered place survives a restart, and a damaged one is dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-parked-'));
  try {
    const place = { pc: '0a1b2c3d', model: 'remote:0a1b2c3d:big.gguf', fallback: null, left: null };
    const staff = await Staff.load(dir);
    const { id } = await staff.hire('Made Up', 'manager', 'junior');
    await staff.change(id, { parked: [place] });
    assert.deepEqual((await Staff.load(dir)).get(id)!.parked, [place]);
    await staff.change(id, { parked: 'nonsense' });
    assert.deepEqual((await Staff.load(dir)).get(id)!.parked, []);
    assert.deepEqual(parkedOnly([place, { pc: 5 }, null, 'x', { pc: '0a1b2c3d' }]), [place]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('two PCs: release keeps each hire\'s place through a relink, remove for good does not', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-release-'));
  const workerPort = await freePort();
  const pcs: Pc[] = [];
  try {
    pcs.push(await startPc({ root: ROOT, home: join(top, 'host') }));
    const nodeDir = join(top, 'node');
    nodeHome(nodeDir, workerPort);
    pcs.push(await startPc({ root: ROOT, home: nodeDir }));
    const [host] = pcs;
    const pc = await link(host, workerPort);
    const ref = `remote:${pc}:made-up-model.gguf`;
    const hired = await host.post('/api/staff', { action: 'hire', name: 'Pat Example', role: 'manager', model: ref });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    const hire = () => host.get('/api/staff').then(r => r.body.staff.find((m: { name: string }) => m.name === 'Pat Example'));

    // Who it affects, by name.
    assert.deepEqual((await host.post('/api/remotes', { action: 'on-it', id: pc })).body.hires, ['Pat Example']);
    assert.equal((await host.post('/api/remotes', { action: 'on-it', id: 'ffffffff' })).status, 404);
    assert.equal((await host.post('/api/remotes', { action: 'remove', id: 'ffffffff' })).status, 404, 'a removal that did nothing says so');

    assert.equal((await host.post('/api/remotes', { action: 'remove', id: pc })).status, 200);
    assert.equal((await hire()).model, null);
    await link(host, workerPort, codeIn(nodeDir));
    assert.equal((await hire()).model, ref, 'back on it');
    assert.deepEqual((await hire()).parked, []);

    assert.equal((await host.post('/api/remotes', { action: 'remove', id: pc, forGood: true })).status, 200);
    assert.equal((await hire()).model, null);
    await link(host, workerPort, codeIn(nodeDir));
    assert.equal((await hire()).model, null, 'removed for good: not put back');
  } finally {
    for (const p of pcs) await p.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
