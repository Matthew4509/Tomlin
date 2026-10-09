// What each PC's models did, and what it cost (src/meter.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_PRICES, ByModel, ByStaff, cleanPower, cleanPrices, cleanUsed, costs, inScope, Ledger, Meter, powerFault, scope, staffOfWho, Uptime, usedFromTimings, workAs, ZERO } from '../src/meter.ts';

test('an answer\'s usage comes from llama.cpp\'s timings: tokens read new and from its cache, written, and the time it worked', () => {
  assert.deepEqual(usedFromTimings({ prompt_n: 1200, predicted_n: 300, prompt_ms: 4000.4, predicted_ms: 25000.2 }), { in: 1200, cached: 0, out: 300, ms: 29001 });
  // As llama.cpp b11284 answered the same prompt the second time (7 Oct 2026): 402 of 407 tokens from its cache.
  assert.deepEqual(usedFromTimings({ cache_n: 402, prompt_n: 5, prompt_ms: 762.188, predicted_n: 20, predicted_ms: 5370.746 }), { in: 5, cached: 402, out: 20, ms: 6133 });
  assert.equal(usedFromTimings(undefined), null);
  assert.equal(usedFromTimings({ prompt_ms: 5 }), null, 'no tokens: nothing to count');
  assert.deepEqual(cleanUsed({ in: '10', out: -3, ms: 'x' }), { in: 10, cached: 0, out: 0, ms: 0 });
});

test('the meter keeps this PC\'s totals and each day, and comes back after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meter-'));
  try {
    const m = await new Meter(join(dir, 'meter.json')).load();
    m.add({ in: 1000, cached: 0, out: 200, ms: 10_000 }, new Date(2026, 9, 6, 12));
    m.add({ in: 500, cached: 900, out: 100, ms: 5000 }, new Date(2026, 9, 7, 9));
    await m.flush();
    const again = await new Meter(join(dir, 'meter.json')).load();
    assert.deepEqual(again.view().total, { in: 1500, cached: 900, out: 300, ms: 15_000, answers: 2 });
    assert.match(await readFile(join(dir, 'meter.json'), 'utf8'), /"2026-10-07"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the host\'s ledger keeps usage per PC and per project; odd keys are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meter-'));
  try {
    const l = await new Ledger(join(dir, 'ledger.json')).load();
    l.add('0a1b2c3d', '20261007-1100-ab12', { in: 2000, cached: 0, out: 400, ms: 30_000 });
    l.add('0a1b2c3d', '20261007-1100-ab12', { in: 1000, cached: 0, out: 100, ms: 10_000 });
    l.add('0a1b2c3d', '', { in: 10, cached: 0, out: 5, ms: 100 });
    l.add('here', '20261007-1100-ab12', { in: 1, cached: 0, out: 1, ms: 1 });
    l.add('../x', 'y', { in: 1, cached: 0, out: 1, ms: 1 });
    const rows = l.forPc('0a1b2c3d');
    assert.deepEqual(rows.map(r => [r.project, r.tally.in, r.tally.out, r.tally.answers]), [['20261007-1100-ab12', 3000, 500, 2], ['', 10, 5, 1]]);
    // That PC's own log is the final tally: its rows take the place of what was counted here; rows only here stay.
    l.takeFrom('0a1b2c3d', [{ project: '20261007-1100-ab12', tally: { in: 2500, cached: 4000, out: 450, ms: 35_000, answers: 2 } }]);
    assert.deepEqual(l.forPc('0a1b2c3d').map(r => [r.project, r.tally.in, r.tally.cached]), [['20261007-1100-ab12', 2500, 4000], ['', 10, 0]]);
    // A project's tally over every PC (a node's "for-" rows are its work for others, not a PC here).
    l.add('for-a1b2c3d4e5f60718', '20261007-1100-ab12', { in: 9, cached: 0, out: 9, ms: 9 });
    assert.deepEqual(l.forProject('20261007-1100-ab12').map(r => r.pc).sort(), ['0a1b2c3d', 'here']);
    await l.flush();
    assert.equal((await new Ledger(join(dir, 'ledger.json')).load()).forPc('here').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uptime counts the checks a PC answered, over the last days only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meter-'));
  try {
    const u = await new Uptime(join(dir, 'uptime.json')).load();
    const now = new Date(2026, 9, 7, 12);
    for (let i = 0; i < 9; i++) u.mark('0a1b2c3d', true, now);
    u.mark('0a1b2c3d', false, now);
    u.mark('0a1b2c3d', false, new Date(2026, 8, 1));
    assert.deepEqual(u.share('0a1b2c3d', 7, now), { ok: 9, asked: 10 });
    assert.deepEqual(u.share('ffffffff', 7, now), { ok: 0, asked: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the cost: power while working against the same tokens on the APIs', () => {
  // One hour of work at 120 W is 0.12 kWh; at US$0.30 a kWh, 3.6 cents.
  const t = { in: 900_000, cached: 0, out: 100_000, ms: 3_600_000, answers: 40 };
  const c = costs(t, { watts: 120, kwh: 0.3 }, API_PRICES);
  assert.ok(Math.abs(c.kwh! - 0.12) < 1e-9);
  assert.ok(Math.abs(c.power! - 0.036) < 1e-9);
  // Claude Opus 5.5: 0.9 M × $4 + 0.1 M × $20 = $5.60; ChatGPT (GPT-6.1 Sol): 0.9 × $2 + 0.1 × $10 = $2.80.
  assert.deepEqual(c.apis.map(a => [a.id, Number(a.cost.toFixed(2))]), [['claude', 5.6], ['chatgpt', 2.8]]);
  // Cached prompt tokens at the cached price: 0.1 M new + 0.8 M cached + 0.1 M written on Claude = 0.4 + 0.16 + 2 = $2.56;
  // without caching every prompt token is new: $5.60 again.
  const cachedT = { ...t, in: 100_000, cached: 800_000 };
  const cc = costs(cachedT, { watts: 120, kwh: 0.3 }, API_PRICES);
  assert.equal(Number(cc.apis[0].cost.toFixed(2)), 2.56);
  assert.equal(Number(cc.apis[0].noCache.toFixed(2)), 5.6);
  assert.equal(Number(cc.apis[1].cost.toFixed(2)), 1.28);
  assert.ok(Math.abs(c.powerPerMillion! - 0.036) < 1e-9);
  // Without the watts or the price, power is not guessed.
  assert.equal(costs(t, { watts: null, kwh: 0.3 }, API_PRICES).power, null);
  assert.equal(costs(t, { watts: 120, kwh: null }, API_PRICES).power, null);
  assert.equal(costs({ ...ZERO }, { watts: 120, kwh: 0.3 }, API_PRICES).powerPerMillion, null);
});

test('prices and power settings are cleaned; the defaults stand for anything odd', () => {
  assert.deepEqual(cleanPower({ watts: '95', kwh: '' }), { watts: 95, kwh: null });
  assert.deepEqual(cleanPower({ watts: -1, kwh: 99 }), { watts: null, kwh: null });
  // As sent by the page: empty boxes are fine, a number out of range is said with the range.
  assert.equal(powerFault({ watts: '95', kwh: '' }), null);
  assert.equal(powerFault({ watts: null, kwh: 0.3 }), null);
  assert.match(powerFault({ watts: 9000 })!, /at most 5,000 watts/);
  assert.match(powerFault({ watts: 'lots' })!, /"lots"/);
  assert.match(powerFault({ watts: 100, kwh: 0 })!, /more than 0 and at most 10 per kWh/);
  assert.match(powerFault({ kwh: 99 })!, /at most 10 per kWh/);
  const p = cleanPrices([{ id: 'chatgpt', name: '  GPT-6 Astra ', in: 10, out: 50 }, { id: 'claude', in: 'x' }]);
  assert.deepEqual(p.find(x => x.id === 'chatgpt'), { id: 'chatgpt', name: 'GPT-6 Astra', in: 10, cached: 0.1, out: 50 });
  assert.deepEqual(p.find(x => x.id === 'claude'), API_PRICES[0]);
});

test('a scope adds up the answers under it, and says whose work it is', async () => {
  const got = await inScope({ project: 'p1' }, async () => {
    await new Promise(r => setTimeout(r, 1));
    const s = scope.getStore()!;
    s.used.in += 5;
    return { project: s.project, used: s.used.in };
  });
  assert.deepEqual(got, { project: 'p1', used: 5 });
  assert.equal(scope.getStore(), undefined);
});

test('each hire\'s answers add up under their id: a job hands the seat on, a chat names its hire; odd ids are not kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bystaff-'));
  try {
    const b = await new ByStaff(join(dir, 'usage-staff.json')).load();
    const one = { in: 100, cached: 20, out: 30, ms: 1000 };
    await inScope({ project: 'p1', staff: staffOfWho('staff:wren') }, async () => {
      b.add(scope.getStore()!.staff, one);
      workAs('iris');
      b.add(scope.getStore()!.staff, one);
      workAs(null);
      b.add(scope.getStore()!.staff, one);
    });
    b.add('../x', one);
    assert.deepEqual(b.of('wren').tally, { in: 100, cached: 20, out: 30, ms: 1000, answers: 1 });
    assert.equal(b.of('iris').tally.answers, 1);
    assert.equal(b.of('nobody').tally.answers, 0);
    assert.equal(staffOfWho('partner'), undefined);
    assert.equal(staffOfWho('manager'), undefined);
    await b.flush();
    const again = await new ByStaff(join(dir, 'usage-staff.json')).load();
    assert.equal(again.of('wren').tally.out, 30);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'usage-staff.json'), 'utf8')).hasOwnProperty('../x'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('time worked per hire per day: the last 7 days add up, older days and other hires stay out, and it survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bystaff-'));
  try {
    const file = join(dir, 'usage-staff.json');
    const b = await new ByStaff(file).load();
    b.add('ann', { in: 10, cached: 0, out: 5, ms: 60_000 }, new Date(2026, 9, 8, 12));
    b.add('ann', { in: 10, cached: 0, out: 5, ms: 30_000 }, new Date(2026, 9, 2, 12));
    b.add('ann', { in: 10, cached: 0, out: 5, ms: 999_000 }, new Date(2026, 8, 20, 12));
    b.add('bob', { in: 1, cached: 0, out: 1, ms: 1000 }, new Date(2026, 9, 8, 9));
    assert.deepEqual(b.workedBetween('2026-10-02', '2026-10-08'), { ann: 90_000, bob: 1000 });
    await b.flush();
    const again = await new ByStaff(file).load();
    assert.equal(again.workedBetween('2026-10-02', '2026-10-08').ann, 90_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('most-used models: per PC and model, the last 7 days only, most worked first, and nothing for another PC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bymodel-'));
  try {
    const file = join(dir, 'usage-models.json');
    const m = await new ByModel(file).load();
    const now = new Date(2026, 9, 8, 12);
    const u = (ms: number) => ({ in: 1, cached: 0, out: 1, ms });
    m.add('here', 'qwen3-8b', u(5000), now);
    m.add('here', 'qwen3-8b', u(5000), new Date(2026, 9, 3, 12));
    m.add('here', 'gemma-3-1b', u(20_000), now);
    m.add('here', 'gemma-3-1b', u(90_000), new Date(2026, 8, 28, 12));
    m.add('c0ffee42', 'Qwen3.5-9B', u(1000), now);
    // Bad keys are refused: an unknown PC, an empty model, a model with the key's separator in it.
    m.add('elsewhere', 'x', u(1), now);
    m.add('here', '', u(1), now);
    m.add('here', 'a|b', u(1), now);
    assert.deepEqual(m.top('here', 7, now), [{ model: 'gemma-3-1b', ms: 20_000, answers: 1 }, { model: 'qwen3-8b', ms: 10_000, answers: 2 }]);
    assert.deepEqual(m.top('c0ffee42', 7, now), [{ model: 'Qwen3.5-9B', ms: 1000, answers: 1 }]);
    await m.flush();
    const again = await new ByModel(file).load();
    assert.deepEqual(again.top('here', 7, now).map(x => x.model), ['gemma-3-1b', 'qwen3-8b']);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), ['c0ffee42|Qwen3.5-9B', 'here|gemma-3-1b', 'here|qwen3-8b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
