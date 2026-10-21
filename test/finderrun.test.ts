// The speed finder's run (src/finderrun.ts) against a stand-in runner: each try loaded in memory only, a failed start
// a failed row (the next try still runs), the sweep's best N carried to the rows that follow it, the PC put back at
// the end, after Stop and after a failure, the 45-minute limit, and the requests every row is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fr from '../src/finderrun.ts';
import * as sf from '../src/speedfinder.ts';
import type { RunOptions } from '../src/store.ts';

const GB = 2 ** 30;
const BASE: RunOptions = { ctx: 8192, cache: 'f16', place: 'auto' };
const OOM = 'ggml_vulkan: Device memory allocation of size 2147483648 failed.';

/** A stand-in runner: speeds by setup, a start that fails for some, and a record of everything asked. */
function fake(o: { speed?: (r: RunOptions) => number; fails?: (r: RunOptions) => string; clock?: { t: number }; stepMs?: number; text?: (r: RunOptions) => string } = {}) {
  const loads: RunOptions[] = [];
  let now: RunOptions | null = null;
  const asked: string[] = [];
  const putBack: string[] = [];
  const deps: fr.FinderDeps = {
    async load(run) {
      loads.push(run);
      if (o.clock) o.clock.t += o.stepMs ?? 0;
      const f = o.fails?.(run);
      if (f) return { error: f };
      now = run;
      return { seconds: 8 };
    },
    async ask(kind) {
      asked.push(kind);
      const w = o.speed ? o.speed(now!) : 10;
      return { text: o.text ? o.text(now!) : 'the same words every time', write: w, read: 40, firstWord: 0.5, accepted: now!.draft ? 0.6 : null };
    },
    async memory() {
      return { cardBytes: 3 * GB, ramBytes: 1 * GB, borrowed: 0, cardFree: 1.5 * GB };
    },
    ramFit: () => 'ok',
    async putBack() {
      putBack.push('back');
    },
  };
  return { deps, loads, asked, putBack };
}

const rows = (...extra: sf.Setup[]): sf.Setup[] => [{ id: 'a', name: 'Now', why: '', run: BASE }, ...extra];
const setup = (id: string, run: Partial<RunOptions>, o: Partial<sf.Setup> = {}): sf.Setup => ({ id, name: id, why: '', run: { ...BASE, ...run }, ...o });

test('each try is loaded as asked (nothing saved), warmed, measured; the PC is put back at the end; the fastest is recommended', async () => {
  const f = fake({ speed: r => (r.fa === 'on' ? 12 : r.spec === 'ngram' ? 10.2 : 10) });
  const run = await fr.runFinder({ rows: rows(setup('fa-on', { fa: 'on' }), setup('ngram', { spec: 'ngram' })), deps: f.deps });
  // Warmed once (the file read into memory), then every row.
  assert.deepEqual(f.loads, [BASE, BASE, { ...BASE, fa: 'on' }, { ...BASE, spec: 'ngram' }]);
  assert.deepEqual(f.asked.slice(0, 2), ['warm', 'warm'], 'the warm-once answer, then the row\'s own warm-up');
  assert.equal(f.asked.filter(k => k === 'read').length, 3, 'the read prompt once a row');
  assert.ok(f.asked.filter(k => k === 'write').length >= 6, 'the write prompt at least twice a row');
  assert.deepEqual(f.putBack, ['back']);
  assert.equal(run.state, 'done');
  assert.deepEqual(run.rows.map(r => r.state), ['done', 'done', 'done']);
  assert.equal(run.rows[1].write, 12);
  assert.equal(run.best, 'fa-on');
  assert.equal(run.keep, false);
  // Copy-ahead wrote the same words: checked and passed.
  assert.equal(run.rows[2].sameWords, true);
});

test('a start that runs out of memory is a failed row with the runner\'s own words; the next try still runs', async () => {
  const f = fake({ fails: r => (r.place === 'card' ? OOM : '') });
  const run = await fr.runFinder({ rows: rows(setup('card', { place: 'card' }), setup('fa-on', { fa: 'on' })), deps: f.deps });
  assert.equal(run.rows[1].state, 'failed');
  assert.match(run.rows[1].why, /allocation of size 2147483648 failed/);
  assert.equal(run.rows[2].state, 'done');
  assert.deepEqual(f.putBack, ['back']);
  assert.notEqual(run.best, 'card');
});

test('the sweep: a failed step ends the steps after it, and the rows that follow it take the best step\'s N plus theirs', async () => {
  const f = fake({ speed: r => (r.place === 'layers' ? 20 - (r.moeCpu ?? 0) / 10 : 10), fails: r => (r.place === 'layers' && r.moeCpu === 33 ? OOM : '') });
  const run = await fr.runFinder({
    rows: rows(
      setup('layers-37', { place: 'layers', moeCpu: 37 }, { sweep: 0 }),
      setup('layers-35', { place: 'layers', moeCpu: 35 }, { sweep: 1 }),
      setup('layers-33', { place: 'layers', moeCpu: 33 }, { sweep: 2 }),
      setup('layers-31', { place: 'layers', moeCpu: 31 }, { sweep: 3 }),
      setup('draft-card', { place: 'layers', moeCpu: 39, draft: 'small.gguf' }, { follows: 'sweep', plus: 2 }),
    ),
    deps: f.deps,
  });
  const by = (id: string) => run.rows.find(r => r.id === id)!;
  assert.equal(by('layers-33').state, 'failed');
  assert.equal(by('layers-31').state, 'not tried');
  assert.match(by('layers-31').why, /the step before did not fit/);
  // Best step: 35 (fastest that loaded), so the draft row runs at 35 + 2.
  assert.equal(by('draft-card').run.moeCpu, 37);
  assert.ok(f.loads.some(r => r.draft === 'small.gguf' && r.moeCpu === 37));
});

test('Stop keeps the rows done and puts the PC back; a fault puts it back too; the time limit keeps the rows done', async () => {
  let stop = false;
  const f = fake({ speed: () => {
    stop = true;
    return 10;
  } });
  const stopped = await fr.runFinder({ rows: rows(setup('fa-on', { fa: 'on' }), setup('ngram', { spec: 'ngram' })), deps: f.deps, stopped: () => stop });
  assert.equal(stopped.state, 'stopped');
  assert.ok(stopped.rows.some(r => r.state === 'not tried' && /stopped/i.test(r.why)));
  assert.deepEqual(f.putBack, ['back']);

  const broken = fake();
  broken.deps.memory = async () => {
    throw new Error('the sampler went away');
  };
  const failed = await fr.runFinder({ rows: rows(setup('fa-on', { fa: 'on' })), deps: broken.deps });
  assert.equal(failed.state, 'failed');
  assert.match(failed.said, /the sampler went away/);
  // Nothing was measured: nothing is recommended (not even what it has now).
  assert.equal(failed.best, null);
  assert.deepEqual(broken.putBack, ['back']);

  const clock = { t: 0 };
  const slow = fake({ clock, stepMs: 20 * 60_000 });
  const timed = await fr.runFinder({ rows: rows(setup('fa-on', { fa: 'on' }), setup('ngram', { spec: 'ngram' }), setup('fa-off', { fa: 'off' })), deps: slow.deps, clock: () => clock.t });
  assert.ok(timed.rows.some(r => r.state === 'not tried' && /time limit/.test(r.why)), JSON.stringify(timed.rows.map(r => [r.id, r.state, r.why])));
  assert.ok(timed.rows.filter(r => r.state === 'done').length >= 1);
  assert.deepEqual(slow.putBack, ['back']);
});

test('a speed trick that writes other words is marked and never recommended; Full measures row a again at the end', async () => {
  const f = fake({ speed: r => (r.spec === 'ngram' ? 30 : 10), text: r => (r.spec === 'ngram' ? 'other words entirely here' : 'the same words every time') });
  const run = await fr.runFinder({ rows: rows(setup('ngram', { spec: 'ngram' })), deps: f.deps, again: true });
  assert.equal(run.rows[1].sameWords, false);
  assert.equal(run.best, 'a');
  assert.match(run.why.ngram, /different words/);
  assert.equal(f.loads.filter(r => r === BASE || JSON.stringify(r) === JSON.stringify(BASE)).length, 3, 'warm once, row a, row a again');
  assert.equal(run.drift, false);
});

test('every row is asked the same way: temperature 0, a fixed seed, thinking off, the prompt read again each time', () => {
  for (const kind of ['warm', 'write', 'read'] as const) {
    const b = fr.request(kind);
    assert.equal(b.temperature, 0);
    assert.equal(b.seed, 42);
    assert.equal(b.cache_prompt, false);
    assert.equal(b.stream, false);
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  }
  assert.equal(fr.request('warm').max_tokens, sf.TOKENS.warm);
  assert.equal(fr.request('write').max_tokens, sf.TOKENS.write);
  assert.equal(fr.request('read').max_tokens, sf.TOKENS.copy);
  // The read prompt is long enough to time reading (about 800 tokens: 550 words or more) and asks for a copy.
  const words = fr.READ_PROMPT.split(/\s+/).length;
  assert.ok(words >= 550, String(words));
  assert.match(fr.READ_PROMPT, /Copy the first paragraph back/);
  // llama-server's own timings are read: writing, reading, first word, guesses kept.
  assert.deepEqual(fr.timingsOf({ choices: [{ message: { content: 'hi' } }], timings: { prompt_n: 800, prompt_ms: 4000, prompt_per_second: 200, predicted_n: 150, predicted_per_second: 15.5, draft_n: 100, draft_n_accepted: 62 } }), { text: 'hi', write: 15.5, read: 200, firstWord: 4, accepted: 0.62 });
});

test('the rows can be picked once the model is loaded as it is now (what its start held on the card)', async () => {
  const f = fake();
  let seen: unknown = null;
  const run = await fr.runFinder({ rows: rows(), plan: mem => {
    seen = mem;
    return rows(setup('fa-on', { fa: 'on' }));
  }, deps: f.deps });
  assert.deepEqual(seen, { cardBytes: 3 * GB, ramBytes: 1 * GB, borrowed: 0, cardFree: 1.5 * GB });
  assert.deepEqual(run.rows.map(r => r.id), ['a', 'fa-on']);
  assert.equal(run.rows[1].state, 'done');
});

test('Stop pressed during an answer (the answer is cut off): the run ends as stopped, not failed, and the PC is put back', async () => {
  let stop = false;
  const f = fake();
  const ask = f.deps.ask;
  let n = 0;
  f.deps.ask = async kind => {
    if (++n === 5) {
      stop = true;
      throw new Error('This operation was aborted');
    }
    return ask(kind);
  };
  const run = await fr.runFinder({ rows: rows(setup('fa-on', { fa: 'on' })), deps: f.deps, stopped: () => stop });
  assert.equal(run.state, 'stopped');
  assert.equal(run.said, '');
  assert.deepEqual(f.putBack, ['back']);
});
