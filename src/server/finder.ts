// The speed finder on this PC (src/speedfinder.ts its rules, src/finderrun.ts its run): what a test would try and how
// long it takes, the test itself (one at a time), its last result per model in data/speed-finder.json, and Go with this
// config / Undo. A linked PC asks for the same through the node doors /worker/tune-* (src/jobrun/node.ts), only when
// this PC's owner ticked "Allow host to test and change model run settings".
import { freemem } from 'node:os';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheBytes, expertWeights, modelShape } from '../gguf.ts';
import { runFinder, request, timingsOf, type FinderRun } from '../finderrun.ts';
import { cardsNow, estimateMinutes, setupsFor, type ModelFacts, type NowFacts, type PcFacts, type Setup } from '../speedfinder.ts';
import { guessersFor, type Listed } from '../runset.ts';
import { runnerHeaders } from '../runnerkeys.ts';
import { hereKey } from '../speed.ts';
import { shortBuild } from '../update.ts';
import type { RunOptions } from '../store.ts';
import { lastStart } from '../worker.ts';
import { BUILD, HOME, type Routes, chatModels, hardware, json, sampler, speeds, store } from './core.ts';
import { CONTEXTS, cardRunners, chatCards, cleanRun, connectChat, readCards, runOf, runOn, runnerFor, runners, runnersForCard } from './panes.ts';
import { answeringBusy, endAnswer, takeChat } from './answering.ts';
import { SMALLER_NAME, getSmaller, offerView, smallerOffer, type SmallerOffer } from './smaller.ts';

const GB = 2 ** 30;
const FILE = join(HOME.data, 'speed-finder.json');
const nameOf = (file: string) => file.split('/').pop()!.replace(/\.gguf$/i, '');

/** This PC's chat models as the finder sees them (Ollama's are run by Ollama, not tested here). */
const listed = (): Listed[] => chatModels.list().filter(m => m.where !== 'ollama').map(m => ({ id: m.id, name: nameOf(m.file), bytes: m.bytes }));

/** The card chat uses here (the biggest), with its free memory now; null on the CPU. */
function cardNow(): { name: string; total: number; free: number } | null {
  const c = [...chatCards()].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
  if (!c?.total) return null;
  const used = sampler.latest.gpu && !sampler.latest.gpu.shared ? sampler.latest.gpu.used : 0;
  return { name: c.name, total: c.total, free: Math.max(0, c.total - used) };
}

async function factsFor(id: string, run: RunOptions): Promise<{ pc: PcFacts; model: ModelFacts } | null> {
  const list = listed();
  const m = list.find(x => x.id === id);
  const path = chatModels.path(id);
  if (!m || !path) return null;
  const shape = await modelShape(path);
  const w = await expertWeights(path);
  const moe = (shape?.experts ?? 0) > 0;
  const layers = w?.layers || shape?.layers || 0;
  // Sizes from the file's tensor list; without it, most of a mixture-of-experts file is its experts.
  const perLayer = moe && layers ? w?.perLayer || Math.round((m.bytes * 0.9) / layers) : 0;
  const rest = moe ? (w?.perLayer ? w.rest : Math.round(m.bytes * 0.1)) : m.bytes;
  const g = guessersFor(m, list).map(x => list.find(y => y.id === x)!).sort((a, b) => a.bytes - b.bytes)[0];
  const gShape = g ? await modelShape(chatModels.path(g.id) ?? '') : null;
  const card = cardNow();
  // Every card the runners can use (biggest first, as cardNow's): the finder's card rows choose among them.
  const known = card ? await readCards() : [];
  const s = await store.settings();
  return {
    // Each card with the runners that have code for it: a CUDA build is tried only on cards it can run.
    pc: { cards: card ? [{ ...card, ids: known[0]?.ids ?? [], ...(known[0] ? { runners: runnersForCard(known[0]) } : {}) }, ...known.slice(1).map(c => ({ name: c.label, total: c.total, free: c.total, ids: c.ids, runners: runnersForCard(c) }))] : [], cores: hardware.cores, threads: s.chat.threads, models: list, runners: cardRunners() },
    model: { ...m, moe, ...((shape?.mtp ?? 0) > 0 ? { mtp: true } : {}), layers, expertsPerLayer: perLayer, rest, ctxBytes: shape ? cacheBytes(shape, run.ctx, run.cache) : 0, guesser: g ? { ...g, ctxBytes: gShape ? cacheBytes(gShape, run.ctx, 'f16') : 0 } : null },
  };
}

/** Row a as the PC has it now: what the loaded model holds on the card, or worked out from its sizes when not loaded. */
function nowFacts(f: { pc: PcFacts; model: ModelFacts }, run: RunOptions, cardBytes: number | null): NowFacts {
  const card = f.pc.cards[0];
  if (!card) return { run, spilled: false, cardBytes: 0 };
  if (cardBytes !== null) return { run, spilled: cardBytes < f.model.bytes * 0.95, cardBytes };
  return { run, spilled: f.model.bytes + f.model.ctxBytes > card.total - GB, cardBytes: 0 };
}

/** What the runner holding `id` has in RAM, on the card, and borrowed from RAM by the card. */
function held(id: string): { cardBytes: number; ramBytes: number; borrowed: number } | null {
  const p = runnerFor(id);
  const use = p?.view.state === 'connected' && p.view.pid ? sampler.latest.processes[p.view.pid] : undefined;
  return use ? { cardBytes: use.gpuDedicated, ramBytes: use.ram, borrowed: use.gpuShared } : null;
}

// ---- What a test would try ----

/** The smaller file of the same model that would sit wholly on the card (src/server/smaller.ts), or why there is none. */
async function smallerFor(id: string, f: { pc: PcFacts; model: ModelFacts }, run: RunOptions, now: NowFacts, size: 'quick' | 'full'): Promise<{ offer: SmallerOffer | null; why: string }> {
  const loaded = runnerFor(id)?.view.state === 'connected';
  const g = run.draft && run.draftOn !== 'ram' ? f.model.guesser : null;
  try {
    return await smallerOffer({
      name: f.model.name.replace(/-\d{5}-of-\d{5}$/i, ''),
      bytes: f.model.bytes,
      card: f.pc.cards[0] ?? null,
      held: loaded ? held(id)?.cardBytes ?? null : null,
      spilled: now.spilled,
      moe: f.model.moe,
      cacheBytes: f.model.ctxBytes,
      extra: g ? g.bytes + g.ctxBytes + 0.3 * GB : 0,
      measured: speeds.expect(hereKey(id)),
      size,
    });
  } catch (e) {
    return { offer: null, why: `it could not be worked out (${(e as Error).message})` };
  }
}

/** What the test would try for `id` (Quick or Full), how long each takes, what is left out and why. */
export async function preview(id: string, size: 'quick' | 'full', contexts: number[] = []) {
  const s = await store.settings();
  const run = runOf(s, id);
  const f = await factsFor(id, run);
  if (!f) return { status: 404, body: { error: 'That model is not on this PC any more (deleted or moved?).' } };
  const loaded = runnerFor(id);
  const on = loaded?.view.state === 'connected' && JSON.stringify(runOn(loaded)) === JSON.stringify(run) ? held(id) : null;
  const now = nowFacts(f, run, on?.cardBytes ?? null);
  const plan = setupsFor(f.pc, f.model, now, size, contexts.filter(n => CONTEXTS.includes(n)));
  const figures = { loadSeconds: s.loadSeconds[`chat:${id}`] ?? 0, write: speeds.expect(hereKey(id)) ?? 0, read: speeds.get(hereKey(id))?.average?.read ?? 0, bytes: f.model.bytes };
  const quick = setupsFor(f.pc, f.model, now, 'quick').rows.length;
  const full = setupsFor(f.pc, f.model, now, 'full').rows.length + 1;
  const last = (await saved())[id];
  const smaller = await smallerFor(id, f, run, now, size);
  return {
    status: 200,
    body: {
      model: id,
      name: f.model.name,
      rows: plan.rows.map(({ id: rid, name, why, tight }) => ({ id: rid, name, why, tight: tight === true })),
      left: smaller.why ? [...plan.left, { name: SMALLER_NAME, why: smaller.why }] : plan.left,
      // A download, not a try: offered on its own, and nothing is downloaded until its own Download button is pressed.
      smaller: smaller.offer ? offerView(smaller.offer) : null,
      minutes: { quick: estimateMinutes(quick, figures), full: estimateMinutes(full, figures) },
      ctx: run.ctx,
      found: run.found ?? null,
      contexts: CONTEXTS.filter(n => n !== run.ctx),
      card: f.pc.cards[0]?.name ?? null,
      last: last ? lastView(last) : null,
      undo: last?.before ? { at: last.appliedAt ?? last.at } : null,
      running: job ? { model: job.model, name: job.name, by: job.by } : null,
    },
  };
}

// ---- The test ----

interface Kept {
  at: string;
  size: 'quick' | 'full';
  run: FinderRun;
  /** The setup before Go with this config, for Undo. */
  before?: RunOptions;
  appliedAt?: string;
  applied?: string;
}

let job: { model: string; name: string; size: 'quick' | 'full'; by: string; started: string; run: FinderRun | null; stop: boolean } | null = null;
/** The measuring answer running now: Stop ends it at once. */
let answer: AbortController | null = null;

async function saved(): Promise<Record<string, Kept>> {
  try {
    const j = JSON.parse(await readFile(FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
async function keep(id: string, k: Kept): Promise<void> {
  const all = await saved();
  all[id] = k;
  await writeFile(`${FILE}.tmp`, JSON.stringify(all, null, 2));
  await rename(`${FILE}.tmp`, FILE);
}

const lastView = (k: Kept) => ({ at: k.at, size: k.size, run: k.run, applied: k.applied ?? null });

/** True while a test runs here: chats and linked PCs wait, with this said. */
export const finderBusy = () => (job && !job.run?.now?.startsWith('Putting') && (!job.run || job.run.state === 'running') ? `a speed test of ${job.name} is running here${job.by !== 'this PC' ? ` (asked by "${job.by}")` : ''}` : '');

export function jobView() {
  return job ? { model: job.model, name: job.name, size: job.size, by: job.by, started: job.started, run: job.run } : null;
}

/** Starts a test of `id` (one at a time on a PC). `by`: this PC, or the linked PC that asked. */
export async function start(id: string, size: 'quick' | 'full', contexts: number[], by: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (job && (!job.run || job.run.state === 'running')) return { status: 409, body: { error: `Busy: a speed test of ${job.name} is running here already${job.by !== 'this PC' ? ` (asked by "${job.by}")` : ''}. Wait for it, or stop it.` } };
  const s = await store.settings();
  const saved0 = runOf(s, id);
  const f = await factsFor(id, saved0);
  if (!f) return { status: 404, body: { error: 'That model is not on this PC any more (deleted or moved?).' } };
  const holder = runnerFor(id);
  if (holder && answeringBusy(holder)) return { status: 409, body: { error: `${f.model.name} is answering something now. Wait for it to finish, then start the test.` } };
  const wasLoaded = holder?.view.state === 'connected';
  const asked = s.chat.asked;
  const threads = s.chat.threads;
  const ctxs = contexts.filter(n => CONTEXTS.includes(n));
  const me = { model: id, name: f.model.name, size, by, started: new Date().toISOString(), run: null as FinderRun | null, stop: false };
  job = me;
  const stopped = () => me.stop;
  const loaded = () => {
    const p = runnerFor(id);
    return p?.view.state === 'connected' && p.worker.base ? p : null;
  };
  void runFinder({
    rows: setupsFor(f.pc, f.model, nowFacts(f, saved0, null), size, ctxs).rows,
    // Once it is loaded as it is now, the rows are picked from what it really holds on the card.
    plan: mem => setupsFor({ ...f.pc, cards: cardsNow(f.pc.cards, cardNow()) }, f.model, nowFacts(f, saved0, mem.cardBytes), size, ctxs).rows as Setup[],
    again: size === 'full',
    stopped,
    onChange: r => {
      me.run = r;
    },
    deps: {
      async load(run) {
        const p = runnerFor(id);
        if (p && answeringBusy(p)) throw new Error('someone started answering on this model, so the test stopped rather than cut them off');
        if (p) await p.disconnect();
        const c = await connectChat(id, asked, threads, false, run);
        if ('error' in c) return { error: c.error };
        const t0 = Date.now();
        for (let t = 0; t < 1800 && c.runner.view.state === 'loading' && !me.stop; t++) await new Promise(r => setTimeout(r, 500));
        if (c.runner.view.state !== 'connected') return { error: c.runner.view.error ?? 'It did not load this way.' };
        return { seconds: c.runner.view.loadSeconds ?? Math.round((Date.now() - t0) / 100) / 10 };
      },
      async ask(kind) {
        const p = loaded();
        if (!p) throw new Error('the model was let go during the test');
        const ac = new AbortController();
        answer = ac;
        takeChat(ac, p, '', '', 'The speed finder');
        const timer = setTimeout(() => ac.abort(), 15 * 60_000);
        try {
          const res = await fetch(`${p.worker.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...runnerHeaders(p.worker.base!) }, body: JSON.stringify(request(kind)), signal: ac.signal });
          if (!res.ok) throw new Error(`the model answered ${res.status}`);
          return timingsOf(await res.json());
        } finally {
          clearTimeout(timer);
          endAnswer(ac);
          answer = null;
        }
      },
      async memory() {
        // A fresh reading of what it holds (the sampler reads every second).
        await new Promise(r => setTimeout(r, 2500));
        const h = held(id) ?? { cardBytes: 0, ramBytes: 0, borrowed: 0 };
        return { ...h, cardFree: cardNow()?.free ?? null };
      },
      ramFit: () => (freemem() >= 2 * GB ? 'ok' : freemem() >= 0.5 * GB ? 'tight' : 'no'),
      async putBack() {
        // Every runner with this model, a try that failed to start too (its "failed" would stay in the top bar).
        for (const p of runners.filter(r => r.view.model === id)) await p.disconnect();
        if (wasLoaded) {
          const c = await connectChat(id, asked, threads);
          if ('error' in c) throw new Error(c.error);
        }
      },
    },
  }).then(async r => {
    me.run = r;
    await keep(id, { ...((await saved())[id] ?? {}), at: new Date().toISOString(), size, run: r }).catch(e => console.error(`The speed test could not be kept: ${(e as Error).message}`));
  }).catch(e => {
    console.error(`The speed test stopped: ${(e as Error).message}`);
  });
  return { status: 202, body: { job: jobView() } };
}

export function stop(): { job: ReturnType<typeof jobView> } {
  if (job) job.stop = true;
  answer?.abort();
  return { job: jobView() };
}

/** Go with this config: the row from this PC's last test of `id`, saved as its setup (the one before kept for Undo). */
export async function apply(id: string, rowId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const k = (await saved())[id];
  const row = k?.run.rows.find(r => r.id === rowId);
  if (!k || !row) return { status: 400, body: { error: 'That setup is not from this PC\'s last test of this model. Run the test again.' } };
  if (row.state !== 'done') return { status: 400, body: { error: `"${row.name}" did not finish its test, so it cannot be chosen.` } };
  const s = await store.settings();
  const before = runOf(s, id);
  const card = cardNow();
  const chosen = cleanRun({ ...row.run, found: { at: k.at, build: shortBuild(BUILD), runner: lastStart?.runner ?? lastStart?.device ?? 'cpu', card: card ? `${card.name} ${Math.round(card.total / GB)} GB` : 'CPU', write: row.write ?? 0, read: row.read ?? 0 } }, id);
  await store.saveSettings({ run: { [id]: chosen } });
  if (row.write) speeds.add(hereKey(id), nameOf(chatModels.list().find(m => m.id === id)?.file ?? id), 'this PC', { write: row.write, tokens: 220, ...(row.read ? { read: row.read } : {}), ...(row.firstWord ? { first: row.firstWord } : {}) }, 'test');
  await keep(id, { ...k, before, appliedAt: new Date().toISOString(), applied: rowId });
  const loaded = await reload(id);
  return { status: 200, body: { said: `Saved: ${row.name}.${loaded}`, run: chosen } };
}

/** Download the smaller file on offer (the finder window's Download button, its size shown). */
export async function downloadSmaller(id: string, b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const s = await store.settings();
  const run = runOf(s, id);
  const f = await factsFor(id, run);
  if (!f) return { status: 404, body: { error: 'That model is not on this PC any more (deleted or moved?).' } };
  const on = runnerFor(id)?.view.state === 'connected' && JSON.stringify(runOn(runnerFor(id)!)) === JSON.stringify(run) ? held(id) : null;
  const sm = await smallerFor(id, f, run, nowFacts(f, run, on?.cardBytes ?? null), b.size === 'full' ? 'full' : 'quick');
  return getSmaller(b, sm.offer);
}

/** Undo: the setup from before Go with this config. */
export async function undo(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const k = (await saved())[id];
  if (!k?.before) return { status: 400, body: { error: 'There is nothing to undo for this model.' } };
  await store.saveSettings({ run: { [id]: cleanRun(k.before, id) } });
  const { before: _b, appliedAt: _a, applied: _x, ...rest } = k;
  await keep(id, rest);
  const loaded = await reload(id);
  return { status: 200, body: { said: `Back to the setup it had before.${loaded}` } };
}

/** A model loaded and not answering is loaded again with its new setup; one answering uses it from its next load. */
async function reload(id: string): Promise<string> {
  const p = runnerFor(id);
  if (!p || p.view.state !== 'connected') return '';
  if (answeringBusy(p)) return ' It is answering now: it uses this from its next load.';
  const s = await store.settings();
  await p.disconnect();
  const c = await connectChat(id, s.chat.asked, s.chat.threads);
  return 'error' in c ? ` It could not be loaded again: ${c.error}` : ' Loading it again with this setup.';
}

// ---- Routes ----

const sizeOf = (v: unknown) => (v === 'full' ? 'full' : 'quick');
const ctxList = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(n => CONTEXTS.includes(n)).slice(0, 6) : String(v ?? '').split(',').map(Number).filter(n => CONTEXTS.includes(n)).slice(0, 6));

/** The finder as a linked PC asks for it (the node doors): only ids and sizes cross, never a setup or a path. */
export async function tuneDoor(action: string, b: Record<string, unknown>, by: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const id = typeof b.model === 'string' ? b.model : '';
  if (action === 'preview') {
    const r = await preview(id, sizeOf(b.size), ctxList(b.contexts));
    return { status: r.status, json: r.body };
  }
  if (action === 'start') {
    const r = await start(id, sizeOf(b.size), ctxList(b.contexts), by);
    return { status: r.status, json: r.body };
  }
  if (action === 'state') return { status: 200, json: { job: jobView() } };
  if (action === 'stop') return { status: 200, json: stop() };
  if (action === 'apply') {
    const r = await apply(id, String(b.row ?? ''));
    return { status: r.status, json: r.body };
  }
  if (action === 'undo') {
    const r = await undo(id);
    return { status: r.status, json: r.body };
  }
  if (action === 'smaller') {
    const r = await downloadSmaller(id, b);
    return { status: r.status, json: r.body };
  }
  return { status: 404, json: { error: 'No such speed test door.' } };
}

export const finderGet: Routes = {
  '/api/speed/find': async ({ res, url }) => {
    const r = await preview(url.searchParams.get('model') ?? '', sizeOf(url.searchParams.get('size')), ctxList(url.searchParams.get('contexts')));
    return json(res, r.status, r.body);
  },
  '/api/speed/find/state': async ({ res }) => json(res, 200, { job: jobView() }),
};

export const finderPost: Routes = {
  '/api/speed/find/start': async ({ res, b }) => {
    const r = await start(String(b.model ?? ''), sizeOf(b.size), ctxList(b.contexts), 'this PC');
    return json(res, r.status, r.body);
  },
  '/api/speed/find/stop': async ({ res }) => json(res, 200, stop()),
  '/api/speed/find/apply': async ({ res, b }) => {
    const r = await apply(String(b.model ?? ''), String(b.row ?? ''));
    return json(res, r.status, r.body);
  },
  '/api/speed/find/undo': async ({ res, b }) => {
    const r = await undo(String(b.model ?? ''));
    return json(res, r.status, r.body);
  },
  '/api/speed/find/smaller': async ({ res, b }) => {
    const r = await downloadSmaller(String(b.model ?? ''), b);
    return json(res, r.status, r.body);
  },
};
