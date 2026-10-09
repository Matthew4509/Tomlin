// Who answers: a model on this PC, a linked PC's, or a hire's own brains with their fallback and backup.
import { CONTINUE_ASK, NoPrefill, streamChat, repeatCut, type AskOpts, type ChatTurn } from '../engine.ts';
import * as brains from '../brains.ts';
import { nowModel, type StaffMember } from '../staff.ts';
import type { Pane } from '../pane.ts';
import { scope } from '../meter.ts';
import { d, sleep } from './shared.ts';
import { hello, lastModel, remoteBrain, sharedName, sharedWhy } from './links.ts';
import type { Brain, ChatSeat, HireBrain } from '../jobrun.ts';

// ---- Who answers ----

/** A model on this PC: `runner` (the one holding a hire's or a step's model), else the main runner. */
export function localBrain(label: string, runner?: Pane): Brain {
  const seat = (): ChatSeat => runner ?? d.chat;
  const chat = async (turns: ChatTurn[], maxTokens: number, onText: (t: string) => void, signal: AbortSignal, opts: AskOpts = {}) => {
    const r = seat();
    if (r.view.state !== 'connected' || !r.worker.base) throw new Error('The chat model is not connected any more (it was disconnected, or the PC ran out of memory).');
    const ac = new AbortController();
    const stop = () => ac.abort();
    signal.addEventListener('abort', stop);
    d.claim(ac, runner);
    d.touch(runner);
    let shown = '';
    let repeated = false;
    brain.last = null;
    brain.thought = null;
    brain.cut = false;
    try {
      const ask = (t: ChatTurn[]) => streamChat(r.worker.base!, r.view.model ?? '', t, text => {
        const cut = repeatCut(text);
        shown = cut ?? text;
        onText(shown);
        if (cut !== null) {
          repeated = true;
          ac.abort();
        }
      }, ac.signal, maxTokens, opts);
      let got;
      try {
        got = await ask(turns);
      } catch (error) {
        // Continue (from a linked PC) on a model that cannot go on from inside its answer: it is asked to carry on.
        if (!(error instanceof NoPrefill)) throw error;
        got = await ask([...turns, { role: 'user', content: CONTINUE_ASK }]);
      }
      brain.cut = got.cut && !repeated;
      if (got.perSecond > 0) brain.last = { write: got.perSecond, tokens: got.tokens, ...(got.read > 0 ? { read: got.read } : {}) };
      if (got.thought) brain.thought = { text: got.thought, seconds: got.thoughtSeconds, ...(got.thoughtStopped ? { stopped: got.thoughtStopped } : {}) };
    } catch (error) {
      if (signal.aborted) throw new Error('Stopped.');
      if (!ac.signal.aborted) throw new Error(`The model stopped part-way: ${(error as Error).message}.`);
      // The repeat cut keeps what came before the repeating; anything else that ended it (the chat window took
      // the model) leaves half an answer, which must not pass as a whole one.
      if (!repeated) throw new Error('The chat window took over the model part-way through. Run the step again when the chat has finished.');
    } finally {
      signal.removeEventListener('abort', stop);
      d.release(ac);
      d.touch(runner);
    }
    if (signal.aborted) throw new Error('Stopped.');
    return shown;
  };
  const brain: Brain = {
    label,
    ctx: runner ? d.runOn(runner).ctx : d.runNow().ctx,
    chat,
    ask: (system, user, maxTokens, onText, signal) => chat([{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, onText, signal),
    last: null,
  };
  return brain;
}

/**
 * The queue's own work here may change what is loaded (it does one thing at a time on each PC): a chat model that does not fit can have the
 * picture model unloaded first, when it is not drawing. Never for work a linked PC sent (the node decides that).
 */
function imageMayGo(): boolean {
  const sc = scope.getStore();
  return !!sc?.queue && !sc.forPc && d.imagePane.view.state === 'connected' && !d.imageBusy();
}

/** Whether a brain can answer now, or could be loaded here, without loading anything. */
export async function candidate(ref: string): Promise<brains.Candidate> {
  const s = await d.store.settings();
  const b = brains.parseRef(ref);
  if (b.kind === 'remote') {
    const r = s.remotes.find(x => x.id === b.pc);
    if (!r) return { ref, ready: false, loadable: false, why: 'its PC is no longer linked' };
    try {
      const h = await hello(r, 3000);
      // One of the models it lets linked PCs use: it answers, loading it there first when it is not loaded.
      if (b.model) {
        const why = sharedWhy(r, h, b.model);
        return why ? { ref, ready: false, loadable: false, why } : { ref, ready: true, loadable: false, why: '' };
      }
      return h.model ? { ref, ready: true, loadable: false, why: '' } : { ref, ready: false, loadable: false, why: `"${r.name}" has no chat model loaded` };
    } catch {
      return { ref, ready: false, loadable: false, why: `"${r.name}" is off or not answering` };
    }
  }
  if (b.kind !== 'here') return { ref, ready: false, loadable: false, why: '' };
  const entry = d.chatList().find(m => m.id === b.id);
  if (!entry) return { ref, ready: false, loadable: false, why: 'its model is not on this PC any more' };
  if (d.runnerFor(b.id)?.view.state === 'connected') return { ref, ready: true, loadable: false, why: '' };
  // Beside the loaded models when it fits, else in place of the least recently used one not answering (src/runners.ts).
  const at = d.place(b.id);
  if ('error' in at && imageMayGo()) return { ref, ready: false, loadable: true, why: `${entry.name} is not loaded (the picture model makes way for it)` };
  if ('error' in at) return { ref, ready: false, loadable: false, why: at.error.replace(/\.$/, '') };
  return { ref, ready: false, loadable: true, why: `${entry.name} is not loaded` };
}

/**
 * The brain for a ref: a paired PC's loaded model, a model on this PC (loaded now if another one is in memory), or
 * with no ref the connected one. `forWhat` names who it is for in the messages ("the coder", "Rowan").
 */
export async function brainForRef(want: string, forWhat: string, change: string, stage: (text: string) => void, signal: AbortSignal): Promise<{ brain: Brain; pc: string; model: string; here: boolean; pane?: Pane }> {
  const s = await d.store.settings();
  const b = brains.parseRef(want);
  if (b.kind === 'remote') {
    const r = s.remotes.find(x => x.id === b.pc);
    if (!r) throw new Error(`The PC chosen for ${forWhat} is no longer paired. Choose again ${change}.`);
    let h;
    try {
      h = await hello(r);
    } catch (e) {
      throw new Error(`The linked PC "${r.name}" did not answer at ${r.url}: ${(e as Error).message}. Check that TOMLIN is running there with "Enable this PC as a node" ticked (Nodes and memory), or choose another model for ${forWhat}.`);
    }
    if (b.model) {
      const why = sharedWhy(r, h, b.model);
      if (why) throw new Error(`${why[0].toUpperCase()}${why.slice(1)}. Choose another model for ${forWhat} ${change}.`);
      const sh = h.models.find(x => x.id === b.model)!;
      stage(`${forWhat[0].toUpperCase()}${forWhat.slice(1)} is ${sh.name} on the PC "${r.name}"${sh.loaded ? '' : ' (it loads there first)'}.`);
      return { brain: remoteBrain(r, h, sh, stage), pc: r.name, model: sh.name, here: false };
    }
    if (!h.model) throw new Error(`The linked PC "${r.name}" has no chat model connected. On that PC, pick a model and press Connect, then try again.`);
    stage(`${forWhat[0].toUpperCase()}${forWhat.slice(1)} is ${h.model} on the PC "${r.name}".`);
    return { brain: remoteBrain(r, h), pc: r.name, model: h.model, here: false };
  }
  const here = (label: string, model: string, runner?: Pane) => ({ brain: localBrain(label, runner), pc: 'this PC', model, here: true, pane: runner });
  if (b.kind === 'none') {
    if (d.chat.view.state !== 'connected') throw new Error(`No chat model is connected. Connect one, or choose a model for ${forWhat} ${change}.`);
    return here(d.chat.view.modelName ?? 'the connected model', d.chat.view.modelName ?? '');
  }
  const id = b.id;
  const entry = d.chatList().find(m => m.id === id);
  if (!entry) throw new Error(`The model chosen for ${forWhat} is not in the models folder any more. Choose again ${change}.`);
  const on = d.runnerFor(id);
  if (on?.view.state === 'connected') return here(entry.name, entry.name, on);
  // Two or more chat models can be loaded: beside the kept ones when the pair fits, else in place of one not kept.
  let at = d.place(id);
  if ('error' in at && imageMayGo()) {
    stage(`Unloading the picture model to make room for ${entry.name}…`);
    await d.imagePane.disconnect();
    await sleep(1500);
    at = d.place(id);
  }
  if ('error' in at) throw new Error(`${at.error.replace(/\.$/, '')} (for ${forWhat}).`);
  const swapped = !at.already && at.replaces ? d.runnerFor(at.replaces) : null;
  if (swapped && d.busy(swapped)) throw new Error('That model is still answering. Wait for it to finish (or press Stop), then try again.');
  const expected = s.loadSeconds[`chat:${id}`] ?? Math.round(entry.bytes / (150 * 2 ** 20)) + 4;
  const from = swapped ? swapped.view.modelName : null;
  if (!at.already) stage(`${from ? `Unloading ${from}, then loading` : 'Loading'} ${entry.name} for ${forWhat} (about ${expected} s)…`);
  const got = await d.connectChat(id, s.chat.asked, s.chat.threads);
  if ('error' in got) throw new Error(`${got.error.replace(/\.$/, '')} (for ${forWhat}).`);
  const runner = got.runner;
  const t0 = Date.now();
  for (;;) {
    await sleep(400);
    if (signal.aborted) {
      if (runner.view.state === 'loading') await runner.disconnect();
      throw new Error('Stopped.');
    }
    const v = runner.view;
    if (v.state === 'connected' && v.model === id) break;
    if (v.state === 'failed') throw new Error(`${entry.name} did not load for ${forWhat}: ${v.error ?? 'the runner stopped.'}`);
    // While the old model is unloading the runner still names it: only another model connected (or nothing at all
    // for a while) means someone else took the runner.
    if (v.model !== id && (v.state === 'connected' || (v.state === 'disconnected' && Date.now() - t0 > 30_000))) throw new Error(`Another model was loaded in place of ${entry.name} while it was loading. Try again.`);
    if (Date.now() - t0 > 15 * 60_000) throw new Error(`${entry.name} took over 15 minutes to load. Try a smaller model.`);
  }
  stage(`${entry.name} loaded in ${runner.view.loadSeconds ?? Math.round((Date.now() - t0) / 1000)} s.`);
  return here(entry.name, entry.name, runner);
}

/**
 * A hire's own brain: the preferred one if it can answer now, else the fallback if it can, else whichever of them
 * this PC can load. A hire with no model given answers on the connected model, as before. Nothing is loaded on a
 * paired PC.
 */
export async function hireBrain(m: StaffMember, stage: (text: string) => void, signal: AbortSignal, only?: string): Promise<HireBrain> {
  // A switch made by a paired PC (one of the hire's own models) counts here too, until "Back to the default".
  const own = brains.refsOf({ model: nowModel(m) ?? m.model, fallback: m.fallback });
  // A backup picked while their PC was off comes after the first choice and before the fallback.
  const refs = only !== undefined ? [only].filter(Boolean) : brains.withCover(own, m.cover);
  const first = m.name.split(/\s+/)[0];
  if (!refs.length) return { ...(await brainForRef('', first, 'in Team', stage, signal)), ref: '', note: '', intern: false };
  const cands = await Promise.all(refs.map(candidate));
  const pick = brains.pickBrain(cands);
  // None can answer: the chat offers "Pick a backup" (the error carries who it is for).
  if ('error' in pick) throw Object.assign(new Error(`${refs.length > 1 ? `Neither of ${first}'s models can` : `${first}'s model cannot`} answer now: ${pick.error.join('; ')}. Pick a backup for ${first} in their chat, connect it, or switch ${first}'s brain.`), { backup: only === undefined ? m.id : undefined, reasons: pick.error });
  const got = await brainForRef(pick.use.ref, first, 'in Team', stage, signal);
  const covered = only === undefined && !!m.cover && pick.use.ref === m.cover.ref && pick.use.ref !== own[0];
  // The first choice answers again: a backup "until it is back" is done. A backup "just this time" is used once.
  if (only === undefined && m.cover && (pick.use.ref === own[0] || (covered && m.cover.once))) await d.staff.change(m.id, { cover: null }).catch(() => undefined);
  const intern = pick.use.ref !== own[0] && brains.isIntern(ownModelName(m), got.model);
  const as = intern ? ' as an intern (a smaller model: check what it writes)' : '';
  const note = covered ? `${first}'s own PC could not answer (${cands[0].why}), so the backup on ${got.pc} did${as}.` : pick.use.ref === refs[0] ? '' : `${first}'s first choice could not answer (${cands[0].why}), so the fallback did${as}.`;
  if (note) stage(note);
  return { ...got, ref: pick.use.ref, note, intern };
}

/** The model a hire's first choice runs, by name: the model here, or what that PC had loaded when it last answered. */
function ownModelName(m: StaffMember): string {
  const b = brains.parseRef(brains.refsOf({ model: nowModel(m) ?? m.model, fallback: m.fallback })[0] ?? '');
  return b.kind === 'here' ? d.chatList().find(x => x.id === b.id)?.name ?? b.id : b.kind === 'remote' ? (b.model ? sharedName(b.pc, b.model) : lastModel.get(b.pc) ?? '') : '';
}

/**
 * Where a hire could answer while their own brains cannot ("Backup when a PC is off"): this PC's chat models that fit,
 * and every linked PC that is on with a chat model loaded. Only hellos are asked; nothing is loaded anywhere.
 */
export async function backupChoices(m: StaffMember): Promise<{ own: string; choices: brains.BackupChoice[]; others: { pc: string; why: string }[] }> {
  const s = await d.store.settings();
  const mine = brains.refsOf({ model: nowModel(m) ?? m.model, fallback: m.fallback });
  const own = ownModelName(m);
  const choices: brains.BackupChoice[] = [];
  const others: { pc: string; why: string }[] = [];
  for (const x of d.chatList()) {
    if (mine.includes(x.id)) continue;
    const c = await candidate(x.id);
    if (c.ready || c.loadable) choices.push({ ref: x.id, pc: 'This PC', model: x.name, ready: c.ready, same: brains.sameModel(own, x.name), intern: brains.isIntern(own, x.name) });
  }
  await Promise.all(s.remotes.map(async r => {
    const ref = `remote:${r.id}`;
    if (r.backupsOnly) return void others.push({ pc: r.name, why: 'it is set to Backups only' });
    try {
      const h = await hello(r, 3000);
      if (h.away) return void others.push({ pc: r.name, why: 'its owner is using it for now' });
      // The models it lets linked PCs use: one not loaded there loads first (ready is false: it takes a while).
      for (const x of h.models) {
        const at = brains.remoteRef(r.id, x.id);
        if (!mine.includes(at)) choices.push({ ref: at, pc: r.name, model: x.name, ready: x.loaded, same: brains.sameModel(own, x.name), intern: brains.isIntern(own, x.name) });
      }
      if (h.models.length || mine.includes(ref)) return;
      if (!h.model) others.push({ pc: r.name, why: 'on, with no chat model loaded (its owner connects one there, or ticks the models other PCs may use)' });
      else choices.push({ ref, pc: r.name, model: h.model, ready: true, same: brains.sameModel(own, h.model), intern: brains.isIntern(own, h.model) });
    } catch {
      others.push({ pc: r.name, why: 'off or not answering' });
    }
  }));
  return { own, choices: brains.orderChoices(choices), others };
}
