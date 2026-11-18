// Web on: the model that answers on this PC is started again with a larger context when the one it runs with is too
// small for web pages (src/webctx.ts decides). The new context is this load's only (nothing is saved): the person's own
// setting for the model stays, and an unload and load again goes back to it.
import type { Pane } from '../pane.ts';
import { planWebContext, webCtxWords } from '../webctx.ts';
import { CONTEXTS, chatList, connectChat, contextBytes, fit, runOn } from './panes.ts';
import { answeringBusy } from './answering.ts';
import { store } from './core.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Waits until `runner` has `id` connected; an error text when it failed or took over 15 minutes. */
async function loaded(runner: Pane, id: string, signal: AbortSignal): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    await sleep(400);
    if (signal.aborted) return 'Stopped.';
    const v = runner.view;
    if (v.state === 'connected' && v.model === id) return '';
    if (v.state === 'failed') return v.error ?? 'the runner stopped.';
    if (v.model !== id && v.state === 'connected') return 'another model was loaded in its place.';
    if (Date.now() - t0 > 15 * 60_000) return 'it took over 15 minutes to load.';
  }
}

/**
 * Makes sure the model in `runner` runs with enough context for the web. Returns the runner to answer on (the same
 * one, or the one the model was started again in) and says in plain words, through `say`, what was changed or why not.
 * A model that is answering something else, or not connected, is left as it is.
 */
export async function widenForWeb(runner: Pane, say: (text: string) => void, signal: AbortSignal, ask: { asked: 'auto' | 'cpu' | 'gpu'; threads: number }): Promise<Pane> {
  const id = runner.view.model;
  if (!id || runner.view.state !== 'connected') return runner;
  const entry = chatList().find(m => m.id === id);
  if (!entry) return runner;
  const run = runOn(runner);
  const plan = planWebContext({
    current: run.ctx,
    contexts: CONTEXTS,
    trained: entry.trained,
    fits: ctx => fit(entry.bytes + contextBytes(id, { ...run, ctx }), 'chat', run.cards).level === 'ok',
  });
  if (!plan.change) {
    if (plan.limit) say(plan.limit);
    return runner;
  }
  if (answeringBusy(runner)) {
    say(`Web is on, but another answer is using ${entry.name} now, so it is not started again with a larger context (${plan.ctx.toLocaleString('en-GB')} tokens). Pages will fill the ${run.ctx.toLocaleString('en-GB')} it has after a page or two.`);
    return runner;
  }
  say(`Web is on: starting ${entry.name} again with a context of ${plan.ctx.toLocaleString('en-GB')} tokens, to leave room for pages…`);
  await runner.disconnect();
  const got = await connectChat(id, ask.asked, ask.threads, false, { ...run, ctx: plan.ctx });
  const why = 'error' in got ? got.error : await loaded(got.runner, id, signal);
  if (!why && 'runner' in got) {
    say([webCtxWords(run.ctx, plan.ctx), plan.limit].filter(Boolean).join(' '));
    return got.runner;
  }
  // Did not load with the larger context: back to how it ran, and said.
  say(`${entry.name} did not start with ${plan.ctx.toLocaleString('en-GB')} tokens (${why.replace(/\.$/, '')}). Starting it again as it was…`);
  const back = await connectChat(id, ask.asked, ask.threads, false, run);
  const backWhy = 'error' in back ? back.error : await loaded(back.runner, id, signal);
  if (backWhy || !('runner' in back)) throw new Error(`${entry.name} could not be started again: ${(backWhy || 'it did not load').replace(/\.$/, '')}. Press Connect beside the model to load it.`);
  say(`Web is on, but ${entry.name} stays at ${run.ctx.toLocaleString('en-GB')} tokens, so pages will fill it after a page or two.`);
  return back.runner;
}

/** The chat settings widenForWeb needs to start a model again. */
export async function loadAsk(): Promise<{ asked: 'auto' | 'cpu' | 'gpu'; threads: number }> {
  const s = await store.settings();
  return { asked: s.chat.asked, threads: s.chat.threads };
}
