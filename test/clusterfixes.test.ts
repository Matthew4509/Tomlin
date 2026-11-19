// Cluster page fixes: (1) a PC that is off cannot be added, in the page and on the server; (2) "This PC takes part" is never on
// by itself (no cluster: nothing set; a new cluster: not chosen; only the owner's own press saves it); (5) the real examples
// file: every example has its hardware, model, settings, result and date. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWhy, cleanCluster, takesPartChosen, withHere, withMembers, withOn, without } from '../src/cluster/members.ts';
import { freePort, link, nodeHome, startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('a PC that is off, asleep or logged off cannot be added: one line says why, with when it was last seen', () => {
  assert.equal(addWhy('Z820', { ok: true }), '');
  assert.match(addWhy('Z820', { ok: false, seenAt: Date.UTC(2026, 10, 19, 8, 30) }), /^"Z820" is off, asleep or not answering \(last seen 2026-11-19 08:30\), so it cannot be added to the cluster\./);
  assert.match(addWhy('Z820', { ok: false }), /not answering, so it cannot be added/);
  assert.match(addWhy('HP 800', { ok: true, away: '2026-11-19T08:00:00Z' }), /logged off for now/);
});

test('"This PC takes part" is never on by itself', () => {
  // No cluster: nothing is chosen.
  assert.equal(takesPartChosen(undefined), false);
  assert.equal(takesPartChosen({ on: false, members: [] }), false);
  // Creating or joining a cluster does not choose it, and neither does switching it on.
  let c = withMembers({ on: false, members: [] }, ['a', 'b'], ['a', 'b']);
  assert.deepEqual(c, { on: false, members: ['a', 'b'] });
  assert.equal(takesPartChosen(c), false);
  c = withOn(c, true)!;
  assert.equal(takesPartChosen(c), false);
  // Only the owner's press saves it; the server falling back to it for them does not.
  assert.deepEqual(withHere(c, true, '', true), { on: true, members: ['a', 'b'], part: true });
  assert.equal(takesPartChosen(withHere(c, true, '', true)), true);
  assert.deepEqual(withHere(c, true), { on: true, members: ['a', 'b'] });
  // An explicit saved choice stays through a save, a member change and a read back; it goes with the cluster.
  const chosen = withHere(c, true, '', true)!;
  assert.deepEqual(cleanCluster(JSON.parse(JSON.stringify(chosen))), chosen);
  assert.equal(withMembers(chosen, ['a'], ['a', 'b']).part, true);
  assert.equal(without(withMembers(chosen, ['a'], ['a', 'b']), 'a').part, undefined, 'no cluster left: nothing set');
  // Staying out is its own explicit choice and never carries `part`.
  const out = withHere(chosen, false, 'a')!;
  assert.deepEqual(out, { on: true, members: ['a', 'b'], out: true, loader: 'a' });
  assert.equal(takesPartChosen(out), false);
});

test('the page leaves the switch Off with no cluster or no choice, and disables Add for a PC that is off', () => {
  const home = readFileSync(join(ROOT, 'public', 'home.js'), 'utf8');
  assert.match(home, /const chosenPart = cl\.members\.length > 0 && cl\.part === true && !cl\.out;/);
  assert.match(home, /checked: chosenPart/);
  assert.match(home, /disabled: !!off, title: off \|\| null/);
  assert.match(home, /Off: \$\{p\.seenAt \? `last seen/);
});

test('the server refuses to add a linked PC that is not answering, and says why', { timeout: 600_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-clusteroff-'));
  const pcs: Pc[] = [];
  try {
    const port = await freePort();
    const dir = join(top, 'node');
    nodeHome(dir, port, 'Node A', 'aaaa0001');
    const [node, host] = await Promise.all([startPc({ root: ROOT, home: dir }), startPc({ root: ROOT, home: join(top, 'host') })]);
    pcs.push(node, host);
    const id = await link(host, port);
    assert.equal(id, 'aaaa0001');
    // Answering: it is added, and "takes part" is not chosen.
    const ok = await host.post('/api/remotes', { action: 'cluster', members: [id] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const saved = () => JSON.parse(readFileSync(join(top, 'host', 'data', 'settings.json'), 'utf8')).cluster;
    assert.deepEqual(saved(), { on: false, members: [id] });
    assert.equal((await host.post('/api/remotes', { action: 'cluster', members: [] })).status, 200);
    // Off: refused, nothing saved.
    await node.stop();
    pcs.splice(pcs.indexOf(node), 1);
    const no = await host.post('/api/remotes', { action: 'cluster', members: [id] });
    assert.equal(no.status, 400, JSON.stringify(no.body));
    assert.match(no.body.error, /^"Node A" is off, asleep or not answering/);
    assert.deepEqual(saved(), { on: false, members: [] });
  } finally {
    for (const p of pcs) await p.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

interface Example {
  id: string; title: string; date: string; verified: boolean; source: string; caveat: string;
  hardware: { pc: string; cpu: string | null; ram: string; card: string; cardMemory: string }[];
  model: { name: string; quantisation: string; size: string };
  settings: { cluster: string; loadedBy: string; maxMode: string; layout: string };
  result: { tokensPerSecond: number | null; loadSeconds: number | null; failed?: boolean; what: string };
}

test('every real cluster example has hardware, model, settings, result, date and a named record', () => {
  const file = JSON.parse(readFileSync(join(ROOT, 'public', 'cluster-examples.json'), 'utf8')) as { examples: Example[]; missing: string[] };
  assert.ok(file.examples.length >= 5);
  assert.ok(file.missing.length >= 1, 'the cases with no measured example say so');
  const ids = new Set<string>();
  for (const x of file.examples) {
    assert.ok(!ids.has(x.id), `${x.id} twice`);
    ids.add(x.id);
    assert.match(x.date, /^\d{4}-\d{2}-\d{2}$/, `${x.id}: date`);
    assert.ok(x.hardware.length >= 1, `${x.id}: hardware`);
    for (const h of x.hardware) {
      for (const k of ['pc', 'ram', 'card', 'cardMemory'] as const) assert.ok(String(h[k] ?? '').trim(), `${x.id}: ${h.pc} has no ${k}`);
      assert.ok('cpu' in h, `${x.id}: ${h.pc} says its CPU or null`);
    }
    assert.ok(x.model.name && x.model.quantisation && x.model.size, `${x.id}: model, quantisation, size`);
    for (const k of ['cluster', 'loadedBy', 'maxMode', 'layout'] as const) assert.ok(String(x.settings[k] ?? '').trim(), `${x.id}: settings.${k}`);
    assert.ok(x.result.what, `${x.id}: result`);
    // A run that worked has its speed; one that failed says so and has none.
    if (x.result.failed) assert.equal(x.result.tokensPerSecond, null, `${x.id}: a failure has no speed`);
    else assert.ok(typeof x.result.tokensPerSecond === 'number' && x.result.tokensPerSecond > 0, `${x.id}: tokens a second`);
    assert.equal(x.verified, true, `${x.id}: only measured runs belong here`);
    assert.ok(x.caveat.trim(), `${x.id}: caveat`);
    // Its record is a file under docs/ (some records are kept out of git, so existence is not checked here).
    assert.match(x.source, /^docs\/[\w./-]+\.(md|txt)/, `${x.id}: source`);
    // Nothing personal or private: no Windows computer names, no user paths, no e-mail.
    assert.doesNotMatch(JSON.stringify(x), /DESKTOP-|C:\\|@[a-z0-9-]+\.(com|net|org)|Matthew/i, `${x.id}: personal text`);
  }
});
