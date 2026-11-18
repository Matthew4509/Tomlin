// The expert-parallel prototype end to end on this PC (src/cluster/moe.ts, src/cluster/harness.ts): a lead and two
// expert workers over TCP on 127.0.0.1 give the same answer as one PC, their work overlaps, and a worker that goes quiet
// ends the word in plain words. No llama.cpp, no linked PC, nothing listening beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forward, partial, route, sharedPart, testLayer, type MoeLayer } from '../src/cluster/moe.ts';
import { echoServer, ExpertWorker, Lead, probe, spread, wordAlone } from '../src/cluster/harness.ts';

const OPTS = { hidden: 32, ff: 16, experts: 24, used: 6, shared: true };
const layers = (n: number): MoeLayer[] => Array.from({ length: n }, (_, i) => testLayer(7 + i, OPTS));
const input = () => Float32Array.from({ length: OPTS.hidden }, (_, i) => Math.cos(i * 0.7));
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-4) => {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol * (1 + Math.abs(b[i])), `value ${i}: ${a[i]} vs ${b[i]}`);
};

test('the router picks the best experts and their weights add up to 1', () => {
  const [l] = layers(1);
  const picks = route(l, input());
  assert.equal(picks.length, 6);
  assert.equal(new Set(picks.map(p => p.id)).size, 6);
  assert.ok(Math.abs(picks.reduce((a, p) => a + p.weight, 0) - 1) < 1e-12);
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i].weight <= picks[i - 1].weight);
});

test('the experts summed in parts, in any split, give the one-PC answer', () => {
  const [l] = layers(1);
  const x = input();
  const whole = forward(l, x);
  const picks = route(l, x);
  for (const cut of [[0, 24], [0, 8, 24], [0, 5, 13, 24], [0, 1, 2, 3, 24]]) {
    const sum = sharedPart(l, x);
    for (let p = 0; p + 1 < cut.length; p++) {
      const part = partial(l, x, picks, id => id >= cut[p] && id < cut[p + 1]);
      for (let i = 0; i < sum.length; i++) sum[i] += part[i];
    }
    close(sum, whole, 1e-12);
  }
});

async function cluster(n: number, delay = 0) {
  const ls = layers(n);
  const a = new ExpertWorker(ls, 8, 16, delay);
  const b = new ExpertWorker(ls, 16, 24, delay);
  const lead = new Lead(ls, 0, 8);
  await lead.join('Worker A', await a.listen(), 8, 16);
  await lead.join('Worker B', await b.listen(), 16, 24);
  return { ls, a, b, lead, end: async () => { lead.close(); await a.close(); await b.close(); } };
}

test('a lead and two workers over TCP give the one-PC answer, word after word', async () => {
  const c = await cluster(6);
  try {
    let x: Float32Array = input();
    let away = 0;
    for (let w = 0; w < 4; w++) {
      const got = await c.lead.word(x);
      close(got.out, wordAlone(c.ls, x));
      assert.equal(got.timings.length, 6);
      away += got.timings.reduce((n, t) => n + t.away, 0);
      x = got.out;
    }
    assert.ok(away > 0, 'some chosen experts were on the workers');
  } finally {
    await c.end();
  }
});

test('the workers work at the same time: both are asked before either answers', async () => {
  // Each worker waits 40 ms per chosen expert it holds. Done one after the other, the second would be asked only after
  // the first answered; at the same time, both are asked first. Checked from the workers' own records, not a clock on a
  // busy PC (14 Nov 2026: a timing version failed under the full suite at 195 ms against 200).
  const c = await cluster(1, 40);
  try {
    // An input whose layer picks experts on both workers.
    let x = input();
    const both = (v: Float32Array) => {
      const ps = route(c.ls[0], v);
      return ps.some(p => p.id >= 8 && p.id < 16) && ps.some(p => p.id >= 16);
    };
    for (let i = 0; i < 200 && !both(x); i++) x = Float32Array.from(x, (v, j) => v + Math.sin(i * 1.7 + j));
    assert.ok(both(x), 'an input that uses both workers');
    const picks = route(c.ls[0], x);
    const { timing } = await c.lead.layer(0, x);
    assert.equal(timing.away, picks.filter(p => p.id >= 8).length);
    const at = (w: typeof c.a, kind: 'asked' | 'answered') => w.events.find(e => e.kind === kind)!.at;
    const lastAsked = Math.max(at(c.a, 'asked'), at(c.b, 'asked'));
    const firstAnswer = Math.min(at(c.a, 'answered'), at(c.b, 'answered'));
    assert.ok(lastAsked < firstAnswer, `the second worker was asked at ${lastAsked.toFixed(1)}, after the first answered at ${firstAnswer.toFixed(1)}`);
  } finally {
    await c.end();
  }
});

test('a worker that goes quiet ends the word in plain words, not a hang', async () => {
  const c = await cluster(2);
  c.lead.waitMs = 300;
  c.b.quiet = true;
  try {
    // Find an input whose first layer picks an expert on worker B.
    let x: Float32Array = input();
    for (let i = 0; i < 50 && !route(c.ls[0], x).some(p => p.id >= 16); i++) x = Float32Array.from(x, (v, j) => v + Math.sin(i + j));
    await assert.rejects(c.lead.word(x), /"Worker B" did not answer layer 0 within 0 seconds \(it went quiet/);
  } finally {
    await c.end();
  }
});

test('a worker that closes ends the word with its name', async () => {
  const c = await cluster(2);
  await c.b.close();
  try {
    let x: Float32Array = input();
    for (let i = 0; i < 50 && !route(c.ls[0], x).some(p => p.id >= 16); i++) x = Float32Array.from(x, (v, j) => v + Math.cos(i * j));
    await assert.rejects(c.lead.word(x), /"Worker B" (closed the connection|could not be reached)/);
  } finally {
    await c.end();
  }
});

test('an expert nobody holds is named', () => {
  const ls = layers(1);
  const lead = new Lead(ls, 0, 8);
  assert.throws(() => lead.owner(20), /no PC in the cluster holds expert 20/);
  assert.equal(lead.owner(3), -1);
});

test('the network probe times layer-sized frames there and back (here over 127.0.0.1)', async () => {
  const server = await echoServer(0, '127.0.0.1');
  try {
    const port = (server.address() as { port: number }).port;
    const times = await probe('127.0.0.1', port, 2560, 50);
    assert.equal(times.length, 50);
    const s = spread(times);
    assert.ok(s.median > 0 && s.median <= s.p90 && s.p90 <= s.p99);
    assert.ok(s.median < 50, `loopback median ${s.median} ms`);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('the probe ends in words when the stream closes early, instead of waiting for ever', async () => {
  const { createServer } = await import('node:net');
  const server = createServer(s => s.once('data', () => s.destroy()));
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(probe('127.0.0.1', port, 64, 5), /closed before every frame came back/);
  } finally {
    server.close();
  }
});
