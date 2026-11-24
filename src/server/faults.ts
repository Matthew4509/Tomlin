// The crash notice's server side (src/faults.ts has the record and its rules): every chat runner fault on this PC is kept
// in the run history with what to try next, every whole answer counts for the runner that wrote it, a chat whose runner
// crashed gets the fault to show (local, or from a linked PC over the link), and the page reads the history here.
// Nothing changes a runner on its own: the notice offers, and only a yes there sets the Runner setting (runnerSetHere) or
// runs Test now (testStart), here or, through the same doors, on a linked PC.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { answered } from '../engine.ts';
import { cleanFault, fallbackPick, faultHook, makeFault, modelFileGone, orderTries, runnerTesting, RunHistory, tryOptions, type FaultRecord, type TryOption } from '../faults.ts';
import { log } from '../log.ts';
import { onExit } from '../exithook.ts';
import { Pane, type PaneFault } from '../pane.ts';
import { crashedHere, pinOfRunner, pinWhy, type Device, type HeldRunner } from '../runtimes.ts';
import { runnerSetAsk } from '../runset.ts';
import { HOME, chatModels, hardware, json, runtimes, store, type Routes } from './core.ts';
import { shareState } from '../jobrun/node.ts';
import { checkBusy, tryRunner, unsafeWhy, type Row } from './runnercheck.ts';
import { finderBusy } from './finder.ts';
import { answeringBusy } from './answering.ts';
import { chatList, connectChat, main, maxRunOf, maxSpeeds, runOf, runnerFor, runners } from './panes.ts';
import { MaxSpeeds } from '../maxmode.ts';

export const history = new RunHistory(join(HOME.data, 'run-history.json')).loadSync();
// Successes are written a few seconds late, together: those still waiting are written as TOMLIN closes (a restart
// right after an answer lost them, and a runner could stay marked as failing).
onExit(() => history.saveNow());

/** This PC by the name it goes by on the network, as linked PCs see it. */
export const thisPc = (): string => (shareState.name && shareState.name !== 'Worker PC' ? shareState.name : 'This PC');

/** Why this PC should not try runner `id` ('' when it can). */
const whyNot = (id: string): string => pinWhy(runtimes.pins[id], hardware.gpus, hardware.nvidiaDriver ?? null, thisPc(), Object.values(runtimes.pins)) || unsafeWhy(id, thisPc());

/** This PC's chat runners as things to try: only card runners when it has a card, and the CPU one. */
export function pinsHere(): Omit<TryOption, 'kind'>[] {
  const hasCard = hardware.gpus.some(g => !g.integrated);
  return Object.entries(runtimes.pins)
    .filter(([, p]) => p.engine === 'llama' && (p.device === 'cpu' || hasCard))
    .map(([id, p]) => ({ pin: id, name: p.name, device: p.device, build: runtimes.buildOfPin(id), installed: runtimes.installedPin(id), bytes: runtimes.bytesPin(id), why: p.device === 'cpu' ? '' : whyNot(id) }));
}

/**
 * The fault with what to try, in the order the guided flow suggests them (this PC's run history: failed with this model
 * here skipped, worked here with other models first), and this model's record on each runner, as the notice shows it.
 */
export function withTries(f: FaultRecord): FaultRecord {
  const s = store.peek();
  // The model's file was gone (an unplugged drive): no runner is offered, as no runner would help.
  if (f.gone) return { ...f, tries: [], history: history.rows(f.pc, f.model) };
  const shaky = history.shaky(f.pc, f.model);
  return { ...f, tries: orderTries(tryOptions({ runner: f.runner, device: f.device }, pinsHere(), shaky), { shaky, worked: history.workedOn(f.pc) }), history: history.rows(f.pc, f.model), ...(s && runOf(s, f.model).fallback ? { fallback: true } : {}) };
}

/**
 * A runner crash with automatic fallback on for that model (the person said yes in a notice): the model is held to the
 * next runner that can run it, from its next load, and the fault says so. Nothing when fallback is off, or the fault was
 * a load (Auto already tries the next device then), or no runner is left.
 */
async function fallBack(f: FaultRecord): Promise<Pick<FaultRecord, 'fallbackSaid' | 'fellBack'>> {
  const s = await store.settings();
  const run = runOf(s, f.model);
  if (f.kind !== 'crash' || !run.fallback || f.gone) return {};
  // A crash under Test now or the runner check is that test's result, not a crash in use: the test says "Nothing was
  // changed", so nothing is moved (it was moving the model to another runner, untested, while the test said so).
  if (testBusy() || checkBusy()) return {};
  const shaky = history.shaky(f.pc, f.model);
  if (f.runner) shaky.add(f.runner);
  const next = fallbackPick(tryOptions({ runner: f.runner, device: f.device }, pinsHere(), shaky), shaky);
  if (!next) return { fallbackSaid: `Automatic fallback is on for ${f.modelName}, but no other runner that has not crashed with it lately can run it on "${f.pc}", so it was left as it was.` };
  await store.saveSettings({ run: { [f.model]: { ...run, runner: next.pin as HeldRunner } } });
  log.info('runner', `${f.modelName}: fell back to ${next.name} after a crash on ${f.runnerName || 'its runner'} (automatic fallback, agreed in the crash notice).`);
  return { fellBack: next.pin, fallbackSaid: `As you agreed, TOMLIN moved ${f.modelName} on "${f.pc}" to ${next.name}: its next answer starts there. Choose "Use this runner" on another to change it, or set Runner to Auto in its gear.` };
}

/** Faults this PC kept lately, so a chat that saw its runner go can find the one it was answering on. */
export async function keepFault(p: PaneFault): Promise<FaultRecord> {
  const gone = modelFileGone(p.model, chatModels, existsSync);
  const f = makeFault({ pc: thisPc(), model: p.model, modelName: p.modelName, runner: p.pin, runnerName: runtimes.pins[p.pin]?.name ?? '', device: p.device as Device | '', kind: p.kind, tail: p.tail, ...(gone ? { gone } : {}) });
  log.error('runner fault', `${f.modelName} on ${f.runnerName || 'an unknown runner'}: ${f.fault}`);
  const fb = await fallBack(f).catch(e => ({ fallbackSaid: `The automatic fallback could not be saved: ${(e as Error).message}` }));
  const ep = p.kind === 'crash' && !f.gone ? epCrashKept(p, f.modelName) : '';
  return history.failure({ ...f, ...fb, ...(ep ? { fallbackSaid: [fb.fallbackSaid, ep].filter(Boolean).join(' ') } : {}) });
}

/**
 * A runner that crashed while it held its model by expert parallel (Max mode or Cluster's borrowing): the crash is kept
 * for that model and build (src/maxmode.ts MaxSpeeds.epCrashed), so expert parallel is not used for it again until Max is
 * switched on again or a newer expert runner is installed, and no load of it starts by itself until the person loads it.
 * Gives the words for the notice ('' when the runner was not an expert-parallel one).
 */
export function epCrashKept(p: Pick<PaneFault, 'model' | 'pin'>, name: string, pane = runners.find(x => x.view.model === p.model)): string {
  if (!pane || maxRunOf(pane)?.engine !== 'experts') return '';
  const c = maxSpeeds.epCrashed(p.model, { name, build: runtimes.buildOfPin(p.pin), stamp: runtimes.expertStamp(), when: 'loaded' });
  const words = `${MaxSpeeds.crashWords(c).replace(/^Max mode: e/, 'E')}. ${name} is not loaded again by itself: load it when you want it, and it loads without expert parallel.`;
  log.info('max', words);
  return words;
}

/** Set once, when the server starts: faults and whole answers on this PC go to the run history. */
export function watchRunners(): void {
  faultHook.find = (model, since) => faultFor(model, since);
  Pane.onFault = p => void keepFault(p).catch(e => console.error('Could not keep the runner fault:', e));
  answered.on = (base, perSecond) => {
    const pane = [...Pane.chats].find(x => x.worker.base === base);
    const v = pane?.view;
    if (v?.model && v.pin) history.success(thisPc(), v.model, v.pin, perSecond);
  };
}

/**
 * The fault behind an answer that just failed on this PC's runner for `model`: the runner's exit is told half a second
 * after it ends, so this waits up to `wait` ms for it. Null when the runner did not crash (the answer failed otherwise).
 */
export async function faultFor(model: string | null | undefined, since: number, wait = 1500): Promise<FaultRecord | null> {
  if (!model) return null;
  for (const t0 = Date.now(); ; ) {
    const f = history.recent({ since: since - 1000, model, pc: thisPc(), limit: 1 })[0];
    if (f) return withTries(f);
    if (Date.now() - t0 >= wait) return null;
    await new Promise(r => setTimeout(r, 150));
  }
}

/** A fault a linked PC sent with its answer: checked, kept here too (so this PC's list of faults has it), and given back. */
export async function faultFrom(raw: unknown, pc: string): Promise<FaultRecord | null> {
  const f = cleanFault(raw);
  if (!f) return null;
  // The PC's name is the one this PC knows it by, not what it called itself.
  const named = { ...f, pc };
  await history.failure(named).catch(() => undefined);
  return named;
}

export const faultsGet: Routes = {
  // The recent faults (any PC), newest first.
  '/api/faults': ({ res, url }) => json(res, 200, { faults: history.recent({ limit: Math.min(100, Number(url.searchParams.get('limit')) || 20) }) }),
  // One model's record on one PC (this PC unless named): one row per runner.
  '/api/run-history': ({ res, url }) => {
    const model = url.searchParams.get('model') ?? '';
    const pc = url.searchParams.get('pc') || thisPc();
    return json(res, 200, { pc, model, rows: history.rows(pc, model).map(r => ({ ...r, name: runtimes.pins[r.runner]?.name ?? r.runner })) });
  },
};

// ---- The Runner setting here (the crash notice's "Use this runner", after a yes) ----

/** Holds one of this PC's models to a runner, or back to Auto (''), as a linked PC's ask does there (src/jobrun/node.ts). */
export async function runnerSetHere(b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const ask = runnerSetAsk(b, chatList().map(m => ({ id: m.id, name: m.name, bytes: m.bytes })), runtimes.pins, id => runtimes.installedPin(id), whyNot);
  if ('error' in ask) return { status: ask.status, body: { error: ask.error } };
  const s = await store.settings();
  const { runner: was, fallback: wasFallback, ...rest } = runOf(s, ask.model.id);
  const runner = ask.runner === null ? was : ask.runner || undefined;
  const fallback = ask.fallback ?? wasFallback;
  await store.saveSettings({ run: { [ask.model.id]: { ...rest, ...(runner ? { runner } : {}), ...(fallback ? { fallback: true } : {}) } } });
  if (ask.runner === null) {
    log.info('runner', `${ask.model.name}: automatic runner fallback ${fallback ? 'on' : 'off'}.`);
    return { status: 200, body: { said: `${ask.model.name}: ${fallback ? 'after a crash it moves to the next runner on its own, and says so' : 'after a crash the notice asks again'}.` } };
  }
  const name = ask.runner ? runtimes.pins[ask.runner]?.name ?? ask.runner : 'Auto';
  log.info('runner', `${ask.model.name}: runner set to ${name}.`);
  // Loaded and not answering: let go, so its next answer starts on the new runner (a loaded model keeps the old one).
  const p = runnerFor(ask.model.id);
  const letGo = !!p && p.view.state === 'connected' && !answeringBusy(p);
  if (letGo) await p!.disconnect();
  const when = letGo ? 'It was loaded and not answering, so it was let go: its next answer starts it on this runner.' : p ? 'It is answering now: it uses this runner from its next load.' : 'It uses this runner from its next load.';
  return { status: 200, body: { said: `${ask.model.name}: runner ${name}. ${when}`, letGo } };
}

// ---- Test now: one model on one runner, here ----

interface TestJob {
  model: string;
  name: string;
  pin: string;
  runnerName: string;
  by: string;
  started: string;
  state: 'running' | 'passed' | 'failed' | 'stopped';
  now: string;
  why: string;
  write: number | null;
  seconds: number | null;
  said: string;
  stop: boolean;
}
let test: TestJob | null = null;

export const testBusy = (): string => (test?.state === 'running' ? `a runner test of ${test.name} on ${test.runnerName} is running here` : '');
runnerTesting.busy = testBusy;

const testView = () => (test ? { model: test.model, name: test.name, pin: test.pin, runner: test.runnerName, by: test.by, started: test.started, state: test.state, now: test.now, why: test.why, write: test.write, seconds: test.seconds, said: test.said } : null);

/** What Test now does, in words: the notice says it before it asks. */
export const TEST_WORDS = 'TOMLIN loads the model on that runner only, asks a short question, has it write a short answer, then gives it a long prompt (about 3,000 tokens, the kind that crashed runners before). It passes when every answer comes back and the runner is still running. Chats there wait meanwhile, and the models that were loaded are loaded again afterwards. Nothing is changed: you choose afterwards whether to use it.';

/** Starts Test now: `b.model` on `b.runner` (its id or short name), on this PC. Only an installed runner this PC can use. */
export async function testStart(b: Record<string, unknown>, by: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (test?.state === 'running') return { status: 409, body: { error: 'A runner test is running already. Wait for it, or stop it.' } };
  const busy = checkBusy() || finderBusy();
  if (busy) return { status: 409, body: { error: `Not now: ${busy}.` } };
  if (answeringBusy()) return { status: 409, body: { error: 'Something is answering on this PC now. Wait for it to finish, then test.' } };
  const entry = chatModels.list().find(m => m.id === b.model);
  if (!entry || entry.where === 'ollama') return { status: 404, body: { error: 'That model is not one of this PC\'s own chat models.' } };
  const pin = pinOfRunner(typeof b.runner === 'string' ? (b.runner as HeldRunner) : undefined);
  const p = runtimes.pins[pin];
  if (!p || p.engine !== 'llama') return { status: 400, body: { error: 'That is not a chat runner this PC pins.' } };
  if (!runtimes.installedPin(pin)) return { status: 409, body: { error: `${p.name} is not installed on this PC. Install it first (Models, Model runners: a ${(runtimes.bytesPin(pin) / 2 ** 30).toFixed(1)} GB download), then test it.` } };
  // Its own failed test is no reason not to test it again; no code for the card, or a known crash here, is.
  const why = pinWhy(p, hardware.gpus, hardware.nvidiaDriver ?? null, thisPc(), Object.values(runtimes.pins)) || crashedHere(p, hardware.gpus, hardware.nvidiaDriver ?? null);
  if (why) return { status: 409, body: { error: why } };
  const s = await store.settings();
  const name = entry.file.split('/').pop()!.replace(/\.gguf$/i, '');
  const me: TestJob = { model: entry.id, name, pin, runnerName: p.name, by, started: new Date().toISOString(), state: 'running', now: 'Starting…', why: '', write: null, seconds: null, said: '', stop: false };
  test = me;
  const before = runners.filter(x => x.view.model && x.view.state === 'connected').map(x => ({ model: x.view.model!, main: x === main() }));
  void (async () => {
    const t0 = Date.now();
    const row: Row = { pin, name: p.name, device: p.device, state: 'trying', why: '', write: null, seconds: null };
    try {
      me.now = `Loading ${name} on ${p.name}…`;
      await tryRunner(row, { id: entry.id, bytes: entry.bytes }, s.chat.threads, () => me.stop);
      me.write = row.write;
      me.seconds = row.seconds;
      if (me.stop || row.state === 'not tried') {
        me.state = 'stopped';
        me.said = 'Stopped. Nothing was changed.';
      } else if (row.state === 'passed') {
        me.state = 'passed';
        history.success(thisPc(), entry.id, pin, row.write);
        me.said = `Passed: ${name} ran on ${p.name}${row.write ? ` at ${row.write} tokens a second` : ''}. Nothing was changed: choose "Use this runner" to keep it for this model.`;
      } else {
        me.why = row.why;
        // A crash is kept by the runner's own exit; a test that failed without one is kept here. Kept before the state
        // says failed, so the guided notice that reads the run history next already skips this runner.
        if (!history.recent({ since: t0, model: entry.id, pc: thisPc() }).some(f => f.runner === pin)) await history.failure(makeFault({ pc: thisPc(), model: entry.id, modelName: name, runner: pin, runnerName: p.name, device: p.device, kind: 'load', tail: row.why }));
        me.state = 'failed';
        me.said = `Failed: ${row.why} Nothing was changed.`;
      }
    } catch (e) {
      me.state = 'stopped';
      me.said = `The test stopped: ${(e as Error).message}`;
    }
    me.now = 'Putting the PC back as it was…';
    try {
      for (const x of runners.filter(r => r.view.model === me.model)) await x.disconnect();
      for (const was of before) {
        if (!runnerFor(was.model)) {
          const c = await connectChat(was.model, s.chat.asked, s.chat.threads, was.main);
          if ('error' in c) me.said += ` "${was.model}" could not be loaded again: ${c.error}`;
        }
      }
    } catch (e) {
      me.said += ` It could not be put back as it was: ${(e as Error).message}`;
    }
    me.now = '';
  })();
  return { status: 202, body: { test: testView() } };
}

export function testStop() {
  if (test?.state === 'running') test.stop = true;
  return { test: testView() };
}

/** A linked PC's Test now (the tune doors, behind that PC owner's run-settings tick). */
export async function testTuneDoor(action: string, b: Record<string, unknown>, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  if (action === 'start') {
    const r = await testStart(b, by);
    return { status: r.status, json: r.body };
  }
  if (action === 'state') return { status: 200, json: { test: testView() } };
  if (action === 'stop') return { status: 200, json: testStop() };
  return { status: 404, json: { error: 'No such runner test door.' } };
}

export const faultsPost: Routes = {
  '/api/runner-set': async ({ res, b }) => {
    const r = await runnerSetHere(b);
    return json(res, r.status, r.body);
  },
  '/api/runner-test': async ({ res, b }) => {
    const r = await testStart(b, 'this PC');
    return json(res, r.status, r.body);
  },
  '/api/runner-test/stop': ({ res }) => json(res, 200, testStop()),
};

faultsGet['/api/runner-test'] = ({ res }) => json(res, 200, { test: testView(), words: TEST_WORDS });
// The latest fault of one model on this PC with what to try next: the gear's Test now shows the guided notice after a fail.
faultsGet['/api/runner-next'] = ({ res, url }) => {
  const f = history.recent({ model: url.searchParams.get('model') ?? '', pc: thisPc(), limit: 1 })[0];
  return json(res, 200, { fault: f ? { ...withTries(f), here: true } : null });
};
// This PC's chat runners for the gear's Runner list: installed or not, and why one cannot run here.
faultsGet['/api/runner-pins'] = ({ res }) => json(res, 200, { pins: pinsHere() });
