// The first-run runner test on this PC (src/runnercheck.ts has its rules and what it keeps): each graphics runner that is
// unpacked, in the order Auto would use them, loads the smallest chat model that fits the card and answers three
// questions; the first that passes is kept. It reuses the speed finder's prompts and timings and its way of working: one at a
// time, the answer counted as the runner's work (so nothing is swapped out under it), and the PC put back as it was.
// A linked PC asks for it through the tune doors (checkTuneDoor), behind the same tick as the speed finder.
import { alive } from '../hardware.ts';
import { startSeconds } from '../loadlimit.ts';
import { timingsOf } from '../finderrun.ts';
import { runnerFetch } from '../engine.ts';
import { runnerHeaders } from '../runnerkeys.ts';
import { checkDue, checkWord, EXPLAIN, failedWhy, judge, pickModel, questionBody, SKIP_WARNING, summary, type Answer, type Question } from '../runnercheck.ts';
import { crashedHere, cudaOrder, type Device } from '../runtimes.ts';
import { chatModels, hardware, hwKey, json, runnerChecks, runtimes, store, type Routes } from './core.ts';
import { connectChat, main, runnerFor, runners } from './panes.ts';
import { answeringBusy, endAnswer, takeChat } from './answering.ts';
import { finderBusy } from './finder.ts';
import { matchView } from '../jobrun/maxhost.ts';

const stateOf = (r: Row): Row['state'] => r.state;
const nameOf = (file: string) => file.split('/').pop()!.replace(/\.gguf$/i, '');

/** Why this PC must not use runner `id`: known to crash on its card, or its own test failed ('' when neither). */
export function unsafeWhy(id: string, pc = 'This PC'): string {
  const crash = crashedHere(runtimes.pins[id], hardware.gpus, hardware.nvidiaDriver ?? null);
  if (crash) return `"${pc}" must not use this runner: ${crash}.`;
  const r = runnerChecks.rec(hwKey())?.results[id];
  return r?.state === 'failed' ? `"${pc}" must not use this runner: ${failedWhy(r)}` : '';
}

/** The unpacked graphics runners to try, in Auto's order (a failed one is tried again; one known to crash here is not). */
export function trialPins(): { pin: string; device: Device; name: string }[] {
  const cards = hardware.gpus.filter(g => !g.integrated && (g.total ?? 0) > 0);
  if (!cards.length) return [];
  const driver = hardware.nvidiaDriver ?? null;
  const cuda = hardware.gpus.some(g => g.vendor === 'nvidia' && !g.integrated) ? cudaOrder(runtimes.pins, 'llama', hardware.gpus, driver).filter(id => !crashedHere(runtimes.pins[id], hardware.gpus, driver)) : [];
  const vulkan = runtimes.idsOf('llama', 'vulkan');
  return [...cuda.map(pin => ({ pin, device: 'cuda' as Device })), ...vulkan.map(pin => ({ pin, device: 'vulkan' as Device }))]
    .filter(x => runtimes.installedPin(x.pin))
    .map(x => ({ ...x, name: runtimes.pins[x.pin].name }));
}

const biggestCard = () => Math.max(0, ...hardware.gpus.filter(g => !g.integrated).map(g => g.total ?? 0));
const modelFor = () => pickModel(chatModels.list().map(m => ({ id: m.id, bytes: m.bytes, where: m.where })), biggestCard());

export interface Row {
  pin: string;
  name: string;
  device: Device;
  state: 'waiting' | 'trying' | 'passed' | 'failed' | 'not needed' | 'not tried';
  why: string;
  write: number | null;
  seconds: number | null;
}

let job: { model: string; name: string; by: string; started: string; state: 'running' | 'done' | 'stopped'; now: string; rows: Row[]; kept: string | null; said: string; stop: boolean } | null = null;
let answer: AbortController | null = null;

export const checkBusy = (): string => (job?.state === 'running' ? `a runner test of ${job.name} is running here${job.by !== 'this PC' ? ` (asked by "${job.by}")` : ''}` : '');
export const checkTesting = (): string | null => (job?.state === 'running' ? job.model : null);

/** Where the test stands: offered, and the word the hello carries. */
export function checkState() {
  const rec = runnerChecks.rec(hwKey());
  const pins = trialPins();
  const model = modelFor();
  const due = checkDue({ cardRunners: pins.length, hasModel: !!model, rec }) && job?.state !== 'running';
  return { due, rec, pins, model, word: checkWord({ due, rec }) };
}

function view() {
  const s = checkState();
  const name = s.model ? nameOf(chatModels.list().find(m => m.id === s.model!.id)?.file ?? s.model.id) : null;
  return {
    due: s.due,
    // Nothing to test with: no chat model that fits the card, or no card runner unpacked.
    cannot: !s.pins.length ? 'No graphics runner is unpacked on this PC yet. Download one under Models, Model runners, then this test can run.' : !s.model ? 'There is no chat model on this PC that fits the card, so there is nothing to test with. Download a small one under Models, then this test can run.' : '',
    model: name,
    plan: s.pins.map(p => ({ pin: p.pin, name: p.name, device: p.device })),
    explain: name ? EXPLAIN(name, s.pins.length) : '',
    skipWarning: SKIP_WARNING,
    skipped: s.rec?.state === 'skipped',
    last: s.rec ? { at: s.rec.at, state: s.rec.state, keep: s.rec.keep ?? null, results: Object.entries(s.rec.results).map(([pin, r]) => ({ pin, name: runtimes.pins[pin]?.name ?? pin, ...r })) } : null,
    job: job ? { model: job.name, by: job.by, started: job.started, state: job.state, now: job.now, rows: job.rows, kept: job.kept, said: job.said } : null,
  };
}

/** Loads the model on exactly one runner and asks the three questions. Never throws. */
export async function tryRunner(row: Row, model: { id: string; bytes: number }, threads: number, stopped: () => boolean): Promise<void> {
  const holder = runnerFor(model.id);
  if (holder) await holder.disconnect();
  const answers: Answer[] = [];
  let fault = '';
  const c = await connectChat(model.id, 'auto', threads, false, undefined, { pin: row.pin });
  if ('error' in c) {
    row.state = 'failed';
    row.why = c.error;
    return;
  }
  const t0 = Date.now();
  // As long as the start itself may take (src/loadlimit.ts: past 15 minutes for big files), and a minute more.
  const tries = Math.ceil((startSeconds(model.bytes, false) + 60) * 2);
  for (let t = 0; t < tries && c.runner.view.state === 'loading' && !stopped(); t++) await new Promise(r => setTimeout(r, 500));
  row.seconds = c.runner.view.loadSeconds ?? Math.round((Date.now() - t0) / 100) / 10;
  if (stopped()) {
    row.state = 'not tried';
    return;
  }
  if (c.runner.view.state === 'connected' && c.runner.worker.base) {
    for (const q of ['warm', 'write', 'long'] as Question[]) {
      if (stopped()) break;
      const ac = new AbortController();
      answer = ac;
      takeChat(ac, c.runner, '', '', 'The runner test');
      const timer = setTimeout(() => ac.abort(), 10 * 60_000);
      try {
        const res = await runnerFetch(`${c.runner.worker.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...runnerHeaders(c.runner.worker.base) }, body: JSON.stringify(questionBody(q)), signal: ac.signal });
        if (!res.ok) throw new Error(`the runner answered ${res.status}`);
        const t = timingsOf(await res.json());
        answers.push({ text: t.text, write: t.write });
        if (q === 'write') row.write = t.write || null;
      } catch (e) {
        if (!stopped()) fault = `the runner stopped answering on the ${q === 'long' ? 'long' : q === 'write' ? 'second' : 'first'} question (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 120)})`;
        break;
      } finally {
        clearTimeout(timer);
        endAnswer(ac);
        answer = null;
      }
    }
  }
  if (stopped()) {
    row.state = 'not tried';
    return;
  }
  const pid = c.runner.view.pid;
  const verdict = judge({ want: row.device, state: fault ? 'failed' : c.runner.view.state, device: c.runner.view.device ?? null, error: fault || c.runner.view.error || null, answers, asked: 3, alive: !!pid && alive(pid) });
  row.state = verdict.ok ? 'passed' : 'failed';
  row.why = verdict.why;
}

export async function start(by: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (job?.state === 'running') return { status: 409, body: { error: 'The runner test is running already. Wait for it, or stop it.' } };
  const busy = finderBusy();
  if (busy) return { status: 409, body: { error: `Not now: ${busy}.` } };
  const v = checkState();
  if (!v.pins.length) return { status: 409, body: { error: view().cannot } };
  if (!v.model) return { status: 409, body: { error: view().cannot } };
  if (answeringBusy()) return { status: 409, body: { error: 'Something is answering on this PC now. Wait for it to finish, then start the test.' } };
  const s = await store.settings();
  const entry = chatModels.list().find(m => m.id === v.model!.id)!;
  const hw = hwKey();
  const me = { model: v.model.id, name: nameOf(entry.file), by, started: new Date().toISOString(), state: 'running' as 'running' | 'done' | 'stopped', now: 'Starting…', rows: v.pins.map(p => ({ pin: p.pin, name: p.name, device: p.device, state: 'waiting' as Row['state'], why: '', write: null, seconds: null })), kept: null as string | null, said: '', stop: false };
  job = me;
  // What is loaded now: put back afterwards (the test may swap one out to make room, as the speed finder does).
  const before = runners.filter(p => p.view.model && p.view.state === 'connected').map(p => ({ model: p.view.model!, main: p === main() }));
  void (async () => {
    try {
      for (const row of me.rows) {
        if (me.stop) {
          row.state = 'not tried';
          continue;
        }
        if (me.kept) {
          row.state = 'not needed';
          continue;
        }
        row.state = 'trying';
        me.now = `Trying ${row.name}…`;
        await tryRunner(row, v.model!, s.chat.threads, () => me.stop);
        const after = stateOf(row);
        if (after === 'passed') {
          me.kept = row.pin;
          await runnerChecks.result(hw, row.pin, { state: 'passed', at: new Date().toISOString(), why: '', device: row.device, write: row.write, seconds: row.seconds }, true);
        } else if (after === 'failed') {
          await runnerChecks.result(hw, row.pin, { state: 'failed', at: new Date().toISOString(), why: row.why, device: row.device, write: null, seconds: row.seconds }, false);
        }
      }
      if (!me.stop) await runnerChecks.done(hw);
      me.state = me.stop ? 'stopped' : 'done';
      me.said = me.stop ? 'Stopped. Nothing was changed.' : summary(me.rows.map(r => ({ name: r.name, state: r.state, why: r.why })), me.kept ? runtimes.pins[me.kept].name : null);
    } catch (e) {
      me.state = 'stopped';
      me.said = `The test stopped: ${(e as Error).message}`;
    }
    me.now = 'Putting the PC back as it was…';
    try {
      for (const p of runners.filter(r => r.view.model === me.model)) await p.disconnect();
      for (const b of before) {
        if (!runnerFor(b.model)) {
          const c = await connectChat(b.model, s.chat.asked, s.chat.threads, b.main);
          if ('error' in c) me.said += ` "${b.model}" could not be loaded again: ${c.error}`;
        }
      }
    } catch (e) {
      me.said += ` It could not be put back as it was: ${(e as Error).message}`;
    }
    me.now = '';
  })();
  return { status: 202, body: { job: view().job } };
}

export function stop() {
  if (job) job.stop = true;
  answer?.abort();
  return view();
}

/** The Skip button: nothing is tried, and nothing is offered again for this card and driver. */
export async function skip() {
  await runnerChecks.skip(hwKey());
  return view();
}

/** A linked PC's ask (the tune doors, behind that PC owner's run-settings tick). */
export async function checkTuneDoor(action: string, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  if (action === 'start') {
    const r = await start(by);
    return { status: r.status, json: r.body };
  }
  if (action === 'state') return { status: 200, json: view() };
  if (action === 'stop') return { status: 200, json: stop() };
  return { status: 404, json: { error: 'No such runner test door.' } };
}

/** What Max mode still needs before other PCs can lend: a runner to install, with its size and where it comes from. */
function matchNow() {
  const m = matchView();
  return {
    build: m?.build ?? null,
    line: m?.line ?? '',
    at: m?.at ?? null,
    needs: (m?.needs ?? []).map(n => ({ ...n, bytes: runtimes.bytesPin(n.pin), name: n.name, runner: runtimes.pins[n.pin]?.name ?? n.pin, source: runtimes.pins[n.pin]?.parts[0]?.url.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/.*$/, '$1') ?? '' })),
  };
}

export const runnerCheckGet: Routes = {
  '/api/runner-check': ({ res }) => json(res, 200, view()),
  '/api/runner-match': ({ res }) => json(res, 200, matchNow()),
};

export const runnerCheckPost: Routes = {
  '/api/runner-check/start': async ({ res }) => {
    const r = await start('this PC');
    return json(res, r.status, r.body);
  },
  '/api/runner-check/stop': ({ res }) => json(res, 200, stop()),
  '/api/runner-check/skip': async ({ res }) => json(res, 200, await skip()),
};

