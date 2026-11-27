// The queue (src/queue.ts): pictures, projects and chat messages lined up to run by themselves, so the PCs work alone
// for hours. Kept in data/queue.json; each PC does one item at a time, items for different PCs run side by side. What
// comes back waits on Home ("Review photos for …", "Review documents for …", "Reply and answer"), written by code.
import { randomBytes } from 'node:crypto';
import { stepCount } from '../jobs.ts';
import { join } from 'node:path';
import { readData, updateData } from '../atomic.ts';
import * as brains from '../brains.ts';
import * as Q from '../queue.ts';
import type { QItem, Queue } from '../queue.ts';
import { MESSAGE_MAX } from '../memory.ts';
import { drawsPictures, roleOf } from '../staff.ts';
import { log } from '../log.ts';
import { HOME, type Routes, chats, json, notifier, staff, staffId, store } from './core.ts';
import { expandForProject, pictureToCard, withAvoid } from './cards.ts';
import { images } from './panes.ts';
import { answeringBusy, imageSpecialist } from './answering.ts';
import { jobRoutes } from './jobs.ts';
import { awayBusy, queuedPicture } from './pictures.ts';
import { isArtistWho } from './people.ts';
import { ridOf } from '../outbox.ts';
import { promptWhy, typedWhy } from '../images.ts';
import { seedWhy } from '../drawrefs.ts';
import { handInOnce } from './places.ts';
import { picturePrompt, stepArtist } from '../picturestep.ts';
import { queuedMessage } from './chat.ts';
import { pickedStyle, SAMPLE_PROMPT, sampleItems, sampleStyles } from '../styles.ts';
import { keepSample, sampleSide } from './stylesamples.ts';
import { inUse } from '../pcbusy.ts';

const FILE = join(HOME.data, 'queue.json');
/** Runs an agent's item (set by src/server/agents.ts at start, which imports this file). */
export const queueHooks: { agent: null | ((runId: string, signal: AbortSignal, st: { stage: string }) => Promise<{ state: 'done' | 'failed'; result?: string; error?: string }>) } = { agent: null };
/** Why the queue holds an agent's run on this PC now (a person is using it: src/pcbusy.ts), or '' when it does not. */
export const agentHold = { why: '' };
/** The list as saved last (every change goes through `change`, which saves it). */
let now: Queue = Q.EMPTY;
/** The items running now: Stop or Cancel reaches each through its controller (the reason says which). */
const live = new Map<string, { ac: AbortController; why: 'cancel' | 'stop' | null; stage: string; step?: number; steps?: number; eta?: number | null; since: number }>();

async function change(fn: (q: Queue) => void): Promise<Queue> {
  now = await updateData<Queue>(FILE, Q.EMPTY, raw => {
    const q = Q.cleanQueue(raw);
    fn(q);
    return q;
  });
  return now;
}
const find = (q: Queue, id: string) => q.items.find(x => x.id === id);
const newId = () => randomBytes(6).toString('hex');

// ---- Where each item runs ----

/** The artist who draws a picture item: the one named, else the first artist on the team. */
async function artistOf(it: QItem) {
  return it.as ? staff.get(it.as) ?? null : await imageSpecialist() ?? null;
}

/** The lanes (PCs) an item needs now, and that PC's name: worked out from the hire's first brain, nothing asked or loaded. */
async function lanesOf(it: QItem): Promise<{ lanes: string[]; name: string }> {
  const pcName = async (lane: string) => {
    if (lane === 'here') return 'this PC';
    // Two linked PCs with one name ("Worker PC") are told apart (src/brains.ts pcLabels), as the staff cards do.
    const all = (await store.settings()).remotes;
    const r = all.find(x => `pc:${x.id}` === lane);
    return r ? brains.pcLabels(all)[r.id] ?? r.name : 'a linked PC';
  };
  const ofRefs = async (refs: string[]) => {
    const lane = refs[0] ? jobRoutes.laneOfRef(refs[0]) : 'here';
    return { lanes: [lane], name: await pcName(lane) };
  };
  if (it.kind === 'picture') {
    const a = await artistOf(it);
    return ofRefs(a ? brains.refsOf(a) : []);
  }
  if (it.kind === 'agent') {
    const m = it.as ? staff.get(it.as) : undefined;
    return ofRefs(m ? brains.refsOf(m) : []);
  }
  if (it.kind === 'chat') {
    const info = it.chat ? await chats.get(it.chat) : null;
    const m = info && staffId(info.who) ? staff.get(info.who.slice(6)) : undefined;
    return ofRefs(m ? brains.refsOf(m) : []);
  }
  // A project: one at a time (one job action runs at a time), on the PC of its next step's worker.
  // Back from its picture: the step after it decides (the picture's step is marked done as it goes on).
  const pic = it.waitFor ? find(now, it.waitFor) : undefined;
  const lane = await jobRoutes.nextLane(it.project, pic?.state === 'done' ? pic.step ?? -1 : -1).catch(() => null);
  return { lanes: lane ? ['jobs', lane] : ['jobs'], name: lane ? await pcName(lane) : 'this PC' };
}

/** Lanes in use by work outside the queue: a job action from the Jobs window, a picture or a chat answer he started. */
function busyOutside(): Set<string> {
  const busy = new Set<string>();
  const ours = [...now.items].some(x => x.state === 'running' && x.kind === 'project');
  if (jobRoutes.actionBusy() && !ours) busy.add('jobs');
  const ourHere = now.items.some(x => x.state === 'running' && x.lanes?.includes('here'));
  if (!ourHere && (images.busy() || answeringBusy())) busy.add('here');
  for (const pc of awayBusy()) busy.add(`pc:${pc}`);
  return busy;
}

// ---- Running ----

let pumping = false;
/** Starts what may start now. Called every few seconds and after every change. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const q = Q.cleanQueue(await readData(FILE, Q.EMPTY));
    now = q;
    if (q.paused) return;
    const lanes = new Map<string, { lanes: string[]; name: string }>();
    for (const it of q.items) if (it.state === 'waiting') lanes.set(it.id, await lanesOf(it));
    const busy = busyOutside();
    // N1: an agent's run for this PC waits while a person uses it (a game, another program on the card, keys pressed
    // lately), unless Settings say agents may run then. Looked at only while one is waiting and this PC is free.
    const agentHere = q.items.some(it => it.state === 'waiting' && it.kind === 'agent' && (lanes.get(it.id)?.lanes ?? []).includes('here'));
    const look = agentHere && !busy.has('here') && !q.items.some(x => x.state === 'running' && x.lanes?.includes('here'));
    const use = look ? await inUse({ node: jobRoutes.shareOn() }) : { busy: false, why: '' };
    if (look || !agentHere) agentHold.why = use.busy ? use.why : '';
    const start = Q.toStart(q, it => lanes.get(it.id)?.lanes ?? ['here'], busy, Date.now(), it => use.busy && it.kind === 'agent' && (lanes.get(it.id)?.lanes ?? []).includes('here'));
    for (const it of start) {
      const at = lanes.get(it.id)!;
      // Started only if it is still waiting and the queue is not paused, as saved now: a Cancel or Stop pressed while
      // this pass was looking is never run over.
      let started = false;
      await change(x => {
        const y = find(x, it.id);
        if (y && y.state === 'waiting' && !x.paused) {
          Object.assign(y, { state: 'running', started: new Date().toISOString(), lanes: at.lanes, laneName: at.name, note: undefined, error: undefined });
          started = true;
        }
      });
      if (started) void run(it.id);
    }
  } catch (e) {
    log.error('queue', e);
  } finally {
    pumping = false;
  }
}

/** Whether hire `staffId` is drawing a queued picture now (their dot says Busy, not Available). */
export const drawingFor = (staffId: string): boolean => now.items.some(it => it.state === 'running' && it.kind === 'picture' && it.as === staffId && live.has(it.id));

/** Runs one item to its end, and writes what came of it. */
async function run(id: string): Promise<void> {
  const it = find(now, id);
  if (!it) return;
  const ac = new AbortController();
  const state = { ac, why: null as 'cancel' | 'stop' | null, stage: 'Starting', since: Date.now() };
  live.set(id, state);
  let out: Partial<QItem> & { state: QItem['state'] };
  try {
    out = it.kind === 'picture' ? await runPicture(it, ac.signal, state) : it.kind === 'project' ? await runProject(it, ac.signal, state) : it.kind === 'agent' ? await runAgentItem(it, ac.signal, state) : await runChat(it, ac.signal, state);
  } catch (e) {
    out = { state: 'failed', error: (e as Error).message };
  } finally {
    live.delete(id);
  }
  // Stop (pause) puts it back to run again on Resume; Cancel ends it; busy or off for now: tried again in a while.
  if (state.why === 'stop') out = { state: 'waiting', note: 'Stopped: it runs again when you press Resume.' };
  else if (state.why === 'cancel') out = { state: 'cancelled' };
  // An agent's run is never put back by the queue: its run says how it ended (src/server/agents.ts).
  else if (it.kind !== 'agent') out = Q.againLater(out, it.tries);
  const ended = Q.isFinished(out as QItem) ? new Date().toISOString() : undefined;
  await change(q => {
    const y = find(q, id);
    if (y) Object.assign(y, out, ended ? { ended } : {});
  });
  if (out.state === 'done' || out.state === 'needs' || out.state === 'failed') void tellIfAllDone();
  void pump();
}

/** One picture: drawn by its artist (here or on their PC), kept in the gallery and handed in to its project. */
async function runPicture(it: QItem, signal: AbortSignal, st: { stage: string; step?: number; steps?: number; eta?: number | null }): Promise<Partial<QItem> & { state: QItem['state'] }> {
  // The request id is the item and what it asks: the same item tried again (after a lost link or a restart) collects the
  // picture its PC kept; an item changed since asks for a new one.
  const chosen = { ...(it.quality ? { quality: it.quality } : {}), ...(it.seed !== undefined ? { seed: it.seed } : {}) };
  const refs = it.refs?.length ? { refs: it.refs } : {};
  // A style and a sample are in the request id only when set: an item from before them keeps its id.
  const look = { ...(it.look ? { look: it.look } : {}), ...(it.sample ? { plain: true } : {}) };
  const rid = ridOf({ queue: it.id, prompt: it.prompt ?? it.title, as: it.as ?? '', mode: it.mode ?? '', width: it.width ?? 0, height: it.height ?? 0, ...(it.negative ? { negative: it.negative } : {}), ...chosen, ...refs, ...look });
  const got = await queuedPicture({ prompt: it.prompt ?? it.title, as: it.as, mode: it.mode, width: it.width, height: it.height, rid, negative: it.negative, ...chosen, ...refs, ...look }, signal, p => {
    if (typeof p.text === 'string') st.stage = p.text;
    if (typeof p.step === 'number') st.step = p.step;
    if (typeof p.steps === 'number') st.steps = p.steps;
    if (typeof p.state === 'string') st.stage = p.state === 'drawing' ? 'Drawing' : p.state === 'decoding' ? 'Finishing the picture' : p.state === 'starting' ? 'Starting' : st.stage;
    if (p.etaSeconds !== undefined) st.eta = typeof p.etaSeconds === 'number' ? p.etaSeconds : null;
  });
  if ('error' in got) return { state: 'failed', error: got.error };
  // Where it was drawn, named as the rest of the queue names that PC (two linked PCs called "Worker PC" told apart).
  const where = got.where !== 'this PC' && it.laneName && it.laneName !== 'this PC' ? `"${it.laneName}"` : got.where;
  // A style sample is kept only in data\stylesamples (below), never in the gallery or on Home as a picture to review.
  if (it.sample) return sampleDone(it, got, where);
  // Kept, and shown in the chat it was asked from (Make a sheet in an artist's chat).
  await images.gallery.update(got.pic.id, { kept: true, ...(it.chat ? { chat: it.chat } : {}) });
  // Handed in once: a picture collected after a restart keeps the copy it was given then.
  const handed = it.project ? await handInOnce(it.project, got.pic) : null;
  // A sheet's view goes into its character's or location's folder, so its best views can be ticked as references. A
  // card renamed, removed or full meanwhile only leaves a note: the picture is still in the gallery and the project.
  const carded = it.card && it.project ? await pictureToCard(it.project, it.card.kind, it.card.name, got.pic.id) : null;
  const cardNote = carded && 'error' in carded ? ` Not added to ${it.card!.name}: ${carded.error}` : carded ? ` Added to ${it.card!.name}.` : '';
  // A picture for a project's step: the project marks the step done itself when it goes on (runProject).
  return {
    state: 'done',
    output: got.pic.output,
    result: `Drawn by ${got.by} on ${where} in ${Math.round(got.pic.seconds)} s.${got.note ? ` ${got.note}` : ''}${cardNote}`,
    ...(handed ? { handed: 'path' in handed ? handed.path : `Not handed in: ${handed.error}` } : {}),
  };
}

/**
 * A style sample drawn: kept for the model that drew it, with the record the picture itself gives (src/styles.ts), and
 * its gallery picture deleted, so each model's samples never add a row of foxes to the gallery and Home. One that could
 * not be kept as a sample stays in Drafts, so what came back is not lost; its line says why. The line is marked seen:
 * the style tiles show the samples, so Home has nothing to review.
 */
async function sampleDone(it: QItem, got: Exclude<Awaited<ReturnType<typeof queuedPicture>>, { error: string }>, where: string): Promise<Partial<QItem> & { state: QItem['state'] }> {
  const sampled = it.look ? await keepSample(it.look, got.pic, got.drawn) : { error: 'it has no style.' };
  const drawn = `Drawn by ${got.by} on ${where} in ${Math.round(got.pic.seconds)} s.${got.note ? ` ${got.note}` : ''}`;
  if ('error' in sampled) return { state: 'done', output: got.pic.output, seen: true, result: `${drawn} Not kept as a style sample: ${sampled.error} It is in Drafts.` };
  await images.gallery.remove(got.pic.id).catch(() => undefined);
  return { state: 'done', seen: true, result: `${drawn} Kept as the ${sampled.styleName} sample for ${sampled.record.modelName}.` };
}

/**
 * A project: its waiting steps run one after another (LETS GO!!! with nobody watching). Steps whose checks pass are
 * saved; a step that needs him parks the project; a picture step is added to the queue and the project waits for it.
 */
async function runProject(it: QItem, signal: AbortSignal, st: { stage: string }): Promise<Partial<QItem> & { state: QItem['state'] }> {
  let saved = 0;
  // Back from waiting for one of its pictures: done, the step is marked done here (nothing else changes the plan now);
  // not done (it failed, or was cancelled), the project waits for him with the reason.
  if (it.waitFor) {
    const pic = find(now, it.waitFor);
    const n = pic?.step ?? 0;
    if (pic?.state !== 'done') return { state: 'needs', waitFor: undefined, error: `Step ${n + 1}'s picture ${pic?.state === 'cancelled' ? 'was cancelled' : `did not come out${pic?.error ? ` (${pic.error.replace(/\.$/, '')})` : ''}`}. Draw it in an artist's chat and press Mark done in the job, then add the project to the queue again.` };
    // Already done: the project is running again after a Stop, a restart or a busy PC, and this was seen to the first time.
    const job = await jobRoutes.loadJob(it.project);
    if (!job || job.steps[n]?.status === 'todo') {
      const marked = await jobRoutes.changeJob({ id: it.project, action: 'mark', n, status: 'done', summary: `${pic.result ?? 'Drawn by the queue.'}${pic.handed && !pic.handed.startsWith('Not ') ? ` ${pic.handed}` : ''}` });
      if (marked.status !== 200) return { state: 'failed', waitFor: undefined, error: `Step ${n + 1}'s picture came back, but the step could not be marked done: ${String((marked.body as { error?: unknown }).error ?? marked.status)}` };
    }
    // Off the saved line too: this project no longer waits for that picture, whatever happens to it next.
    const id = it.id;
    await change(q => { const x = find(q, id); if (x) x.waitFor = undefined; });
    it = { ...it, waitFor: undefined };
  }
  // Saved on Home with no plan yet: planned first (with nobody to read the plan, it runs as made; his review comes after).
  if (!(await jobRoutes.loadJob(it.project))) {
    st.stage = 'Making the plan';
    const p = await jobRoutes.planQueued(it.project, signal, (event, data) => {
      const x = data as { text?: string };
      if (event === 'stage' && typeof x.text === 'string') st.stage = x.text;
    });
    if ('busy' in p) return { state: 'failed', error: 'Another project is working now (busy)' };
    if ('error' in p) return { state: 'needs', error: `The plan was not made: ${p.error}` };
    if (signal.aborted) return { state: 'failed', error: 'Stopped.' };
  }
  let onStep = '';
  const r = await jobRoutes.runQueued(it.project, it.review === true, signal, (event, data) => {
    const x = data as { text?: string; n?: number; title?: string };
    if (event === 'step' && typeof x.n === 'number') st.stage = onStep = `Step ${x.n + 1}: ${String(x.title ?? '').replace(/^\d+\s*[-.:]\s*/, '')}`;
    if (event === 'stage' && typeof x.text === 'string') st.stage = onStep ? `${onStep} · ${x.text}` : x.text;
    if (event === 'saved') saved++;
  });
  if ('busy' in r) return { state: 'failed', error: 'Another project is working now (busy)' };
  const job = await jobRoutes.loadJob(it.project);
  const total = job?.steps.length ?? 0;
  const count = stepCount(job?.steps ?? []);
  const far = count.words;
  if (r.kind === 'finished') return { state: 'done', result: `${count.skipped ? count.words : `All ${total} step${total === 1 ? '' : 's'} done`}${saved ? `, ${saved} saved by the queue` : ''}.` };
  if (r.kind === 'picture') {
    // Drawn by the hire with the step's role (the artist, or the designer for an icon), not whoever the Images window
    // draws as; the picture model is given what the picture shows, not the planner's brief about files and pages.
    const as = stepArtist(r.role, staff.list().map(m => ({ id: m.id, role: m.role, draws: drawsPictures(m.role) })), (await imageSpecialist())?.id);
    const prompt = picturePrompt(r.title, r.brief);
    const pic: QItem = { id: newId(), kind: 'picture', state: 'waiting', title: prompt, prompt, ...(as ? { as } : {}), added: new Date().toISOString(), project: it.project, projectName: it.projectName, step: r.n };
    // Straight after the project, so its picture is next in line for the artist's PC.
    await change(q => {
      const i = q.items.findIndex(x => x.id === it.id);
      q.items.splice(i + 1, 0, pic);
    });
    return { state: 'waiting', waitFor: pic.id, note: `Waiting for step ${r.n + 1}'s picture (${far}).` };
  }
  // A step that came back and needs his review: the job's own line on Home asks him (with its Review button), so the
  // queue's line is marked seen. A step that stopped on a fault: the queue's line says so.
  if (r.kind === 'stopped' && r.needs) return { state: 'needs', error: r.reason, result: far, seen: true };
  if (r.kind === 'stopped') return Q.forNow(r.reason) ? { state: 'failed', error: r.reason } : { state: 'needs', error: r.reason, result: far };
  return { state: 'failed', error: r.text };
}

/** A chat message: answered in its chat with no page open; the answer waits there for him. */
async function runChat(it: QItem, signal: AbortSignal, st: { stage: string }): Promise<Partial<QItem> & { state: QItem['state'] }> {
  // Its line says how far the answer is (loading, asked, working it out, writing), not "Starting" until it ends.
  const r = await queuedMessage(it.chat ?? '', it.message ?? it.title, it.think === true, signal, it.added, (event, data) => {
    st.stage = Q.chatStage(event, data, st.stage);
  }, it.id);
  if ('error' in r) return { state: 'failed', error: r.error };
  return { state: 'done', result: `${r.who} answered (${r.ran}).` };
}

/**
 * An agent's run (src/server/agents.ts): its line on Home is the agent's own, so the queue's line is marked seen. Not put
 * back when its PC is busy: the run waits in line, and is skipped after its job's "Wait at most".
 */
async function runAgentItem(it: QItem, signal: AbortSignal, st: { stage: string }): Promise<Partial<QItem> & { state: QItem['state'] }> {
  if (!queueHooks.agent || !it.agentRun) return { state: 'failed', error: 'Agents are not started on this PC.', seen: true };
  const r = await queueHooks.agent(it.agentRun, signal, st);
  return r.state === 'done' ? { state: 'done', result: r.result ?? 'Done.', seen: true } : { state: 'failed', error: r.error ?? 'It did not finish.', seen: true };
}

/** One Windows notification when the whole list is through (he may be away from the PC). */
async function tellIfAllDone(): Promise<void> {
  if (now.items.some(x => x.state === 'waiting' || x.state === 'running')) return;
  const lines = Q.homeLines(now);
  if (!lines.length) return;
  await notifier.tell('finished', `The queue is done: ${lines.map(l => l.text.replace(/\.$/, '')).join('; ')}.`, 'home:').catch(() => undefined);
}

// ---- Adding ----

/** An item from the page, checked: its kind's own fields, the project it belongs to. Null with the reason when it cannot go in. */
async function itemFrom(raw: Record<string, unknown>): Promise<QItem | { error: string }> {
  const base = { id: newId(), state: 'waiting' as const, added: new Date().toISOString() };
  const projectId = typeof raw.project === 'string' && /^[\w-]{1,40}$/.test(raw.project) ? raw.project : '';
  const job = projectId ? await jobRoutes.loadJob(projectId) : null;
  // A project saved on Home with no plan yet: the queue plans it first.
  const unplanned = projectId && !job ? await jobRoutes.projectInfo(projectId) : null;
  if (projectId && !job && !unplanned) return { error: 'That project is not in this workspace any more.' };
  const projectName = job ? job.name || job.goal.slice(0, 80) : unplanned ? unplanned.name || unplanned.goal.slice(0, 80) : undefined;
  if (raw.kind === 'picture') {
    // Too long as typed, or a seed the runner cannot read: refused as the Images window refuses them, never cut or swapped.
    const typedLong = typedWhy(String(raw.prompt ?? '').replace(/\s+/g, ' ').trim());
    if (typedLong) return { error: typedLong };
    const badSeed = seedWhy(raw.seed);
    if (badSeed) return { error: badSeed };
    // @names: the project's characters and locations add their words (src/cards.ts).
    const e = await expandForProject(String(raw.prompt ?? ''), projectId);
    if (e.used.length) raw = { ...raw, prompt: e.prompt, negative: withAvoid(raw.negative, e.avoid) };
    const prompt = String(raw.prompt ?? '').replace(/\s+/g, ' ').trim();
    if (!prompt) return { error: 'Type what to draw first.' };
    const tooLong = promptWhy(prompt);
    if (tooLong) return { error: tooLong };
    const as = typeof raw.as === 'string' && raw.as ? raw.as : undefined;
    if (as && !(staff.get(as) && roleOf(staff.get(as)!.role).kind)) return { error: 'That artist is not on the team any more. Pick another.' };
    const size = (v: unknown) => (typeof v === 'number' && v >= 64 && v <= 4096 ? Math.round(v) : undefined);
    const negative = typeof raw.negative === 'string' ? raw.negative.replace(/\s+/g, ' ').trim().slice(0, 1000) || undefined : undefined;
    // A sheet's view names its card, and the chat it was asked from: both must still be there.
    const card = raw.card === undefined ? undefined : Q.cleanItem({ id: 'x', kind: 'picture', card: raw.card })?.card;
    if (raw.card !== undefined && (!card || !projectId)) return { error: 'That character or location is not in this project any more.' };
    const chat = typeof raw.chat === 'string' && raw.chat && (await chats.get(raw.chat)) ? raw.chat : undefined;
    // Draft, Mid or High and the seed, as the Images window had them (cleanItem keeps only good ones).
    // A style picked (src/styles.ts) names its mode; a sample is one only with a style, and its prompt is the samples' own.
    const look = pickedStyle(raw.style);
    if (raw.sample === true && (!look || prompt !== SAMPLE_PROMPT)) return { error: 'A style sample is drawn from the sample prompt, with a style.' };
    return Q.cleanItem({ ...base, kind: 'picture', title: raw.sample === true && look ? `${look.name} sample: ${prompt}` : prompt, prompt, as, mode: look && look.mode !== 'auto' ? look.mode : typeof raw.mode === 'string' && raw.mode !== 'auto' ? raw.mode : undefined, ...(look ? { look: look.id } : {}), ...(raw.sample === true ? { sample: true } : {}), width: size(raw.width), height: size(raw.height), negative, quality: raw.quality, seed: raw.seed, project: projectId, projectName, ...(e.refsAt.length ? { refs: e.refsAt } : {}), ...(card ? { card } : {}), ...(chat ? { chat } : {}) })!;
  }
  if (raw.kind === 'project') {
    if (!projectId) return { error: 'Pick the project to run.' };
    if (job && !job.steps.some(s => s.status === 'todo')) return { error: `Every step of ${projectName} is done already.` };
    if (now.items.some(x => x.kind === 'project' && x.project === projectId && (x.state === 'waiting' || x.state === 'running'))) return { error: `${projectName} is in the queue already.` };
    return Q.cleanItem({ ...base, kind: 'project', title: projectName, project: projectId, projectName, review: raw.review === true })!;
  }
  if (raw.kind === 'chat') {
    const chatId = typeof raw.chat === 'string' ? raw.chat : '';
    const info = await chats.get(chatId);
    if (!info) return { error: 'That chat is not here any more.' };
    const message = String(raw.message ?? '').replace(/\r/g, '').trim();
    if (!message) return { error: 'Type the message first.' };
    if (message.length > MESSAGE_MAX) return { error: `That message is too long (over ${MESSAGE_MAX.toLocaleString('en-GB')} characters). Add it as a document instead, or split it.` };
    const planned = info.project ? await jobRoutes.loadJob(info.project) : null;
    const saved = info.project && !planned ? await jobRoutes.projectInfo(info.project) : null;
    const inProject = planned ? { id: planned.id, name: planned.name, goal: planned.goal } : saved ? { id: info.project!, name: saved.name, goal: saved.goal } : null;
    return Q.cleanItem({ ...base, kind: 'chat', title: message.replace(/\s+/g, ' ').slice(0, 200), chat: chatId, message, think: raw.think === true, project: inProject ? inProject.id : '', projectName: inProject ? inProject.name || inProject.goal.slice(0, 80) : undefined })!;
  }
  return { error: 'TOMLIN does not know that kind of work for the queue.' };
}

/** Adds one item or many (a pasted list is one action: all go in, or none, with the reason). */
export async function addToQueue(list: Record<string, unknown>[]): Promise<{ status: number; body: unknown }> {
  if (!list.length) return { status: 400, body: { error: 'Nothing to add.' } };
  if (list.length > Q.MAX_ADD) return { status: 400, body: { error: `At most ${Q.MAX_ADD} at a time: split the list.` } };
  const items: QItem[] = [];
  for (const [i, raw] of list.entries()) {
    const got = await itemFrom(raw);
    if ('error' in got) return { status: 400, body: { error: list.length > 1 ? `Line ${i + 1}: ${got.error} Nothing was added.` : got.error } };
    items.push(got);
  }
  let full = false;
  await change(q => {
    if (!Q.makeRoom(q, items.length)) full = true;
    else q.items.push(...items);
  });
  if (full) return { status: 409, body: { error: `The queue holds ${Q.MAX_ITEMS} lines and they are all still to do. Wait for some to finish, or cancel some.` } };
  // An artist's chat still unnamed takes its name from the first picture queued in it, as Draw names it (chats.touch).
  const named = new Set<string>();
  for (const it of items) {
    if (it.kind !== 'picture' || !it.chat || named.has(it.chat)) continue;
    named.add(it.chat);
    const c = await chats.get(it.chat).catch(() => null);
    if (c && isArtistWho(c.who)) await chats.touch(c.id, it.prompt ?? it.title).catch(() => null);
  }
  void pump();
  return { status: 200, body: { added: items.length, ...(await view()) } };
}

/** An agent's run, added to the queue (src/server/agents.ts checks the job first). */
export async function addAgentItem(o: { title: string; agentRun: string; as: string }): Promise<{ id: string } | { error: string }> {
  const it = Q.cleanItem({ id: newId(), kind: 'agent', state: 'waiting', added: new Date().toISOString(), title: o.title.slice(0, 200), project: '', agentRun: o.agentRun, as: o.as });
  if (!it) return { error: 'The run could not be put in the queue.' };
  let full = false;
  await change(q => {
    if (!Q.makeRoom(q, 1)) full = true;
    else q.items.push(it);
  });
  if (full) return { error: `The queue holds ${Q.MAX_ITEMS} lines and they are all still to do.` };
  void pump();
  return { id: it.id };
}

/** Cancels an agent's queue item: Stop on the Agents page, or a run that waited too long. */
export async function cancelAgentItem(id: string): Promise<void> {
  const l = live.get(id);
  if (l) {
    l.why = 'cancel';
    l.ac.abort();
    return;
  }
  await change(q => {
    const y = find(q, id);
    if (y && y.state === 'waiting') Object.assign(y, { state: 'cancelled', ended: new Date().toISOString(), seen: true });
  });
}

/**
 * The lane a hire's work goes to when the queue is using it now: what the queue runs there, for "busy: add to the
 * queue". Null when the queue is not using that PC.
 */
export function queueOn(refs: string[]): { lane: string; title: string; pc: string } | null {
  const lane = refs[0] ? jobRoutes.laneOfRef(refs[0]) : 'here';
  const it = now.items.find(x => x.state === 'running' && x.lanes?.includes(lane));
  return it ? { lane, title: it.title, pc: Q.laneWords(it) } : null;
}

// ---- What the page reads ----

async function view() {
  const items = now.items.map(it => {
    const l = live.get(it.id);
    return {
      id: it.id, kind: it.kind, state: it.state, title: it.title, project: it.project, projectName: it.projectName ?? '', pc: it.laneName || it.lanes?.length ? Q.laneWords(it) : '',
      added: it.added, started: it.started ?? null, ended: it.ended ?? null, result: it.result ?? '', error: it.error ?? '', note: it.note ?? '', handed: it.handed ?? '', output: it.output ?? '', chat: it.chat ?? '',
      waitFor: it.waitFor ?? '', review: it.review === true, card: it.card ?? null, ...(it.sample ? { sample: true } : {}), here: (it.lanes ?? []).includes('here'), tries: it.tries ?? 0,
      ...(l ? { stage: l.stage, step: l.step ?? null, steps: l.steps ?? null, eta: l.eta ?? null, seconds: Math.round((Date.now() - l.since) / 1000) } : {}),
    };
  });
  return { paused: now.paused, count: Q.countLine(now), items };
}

/** Home's lines from the queue: what came back (Waiting for you) and what runs now (Working now). */
export async function queueHome() {
  const titles = new Map<string, string>();
  for (const it of now.items) if (it.chat && !titles.has(it.chat)) titles.set(it.chat, (await chats.get(it.chat))?.title ?? '');
  const v = await view();
  return { lines: Q.homeLines(now, c => titles.get(c) ?? ''), running: v.items.filter(x => x.state === 'running'), count: v.count, paused: v.paused, waiting: v.items.filter(x => x.state === 'waiting').length, projects: [...new Set(now.items.filter(x => x.state === 'waiting' || x.state === 'running').map(x => x.project).filter(Boolean))] };
}

// ---- Routes ----

export const queueGet: Routes = {
  '/api/queue': async ({ res }) => json(res, 200, await view()),
  // The projects work can be queued for: planned ones, and ones saved on Home with no plan yet; newest first.
  '/api/queue/projects': async ({ res }) => {
    const planned = (await jobRoutes.listJobs()).filter(j => !j.hidden && !j.damaged).map(j => ({ id: j.id, name: j.name || j.goal.slice(0, 80), at: j.updated }));
    const saved = (await jobRoutes.unplanned()).map(p => ({ id: p.id, name: p.name || p.goal.slice(0, 80) || 'A project', at: p.at }));
    return json(res, 200, { projects: [...planned, ...saved].sort((a, b) => b.at.localeCompare(a.at)) });
  },
};

export const queuePost: Routes = {
  '/api/stylesamples/make': async ({ res, b }) => {
    // {as}: one picture per style for this artist, on their model and PC, through the queue; each is kept as that
    // style's sample for the model that draws it. Only one set at a time for an artist.
    const as = typeof b.as === 'string' ? b.as : '';
    const m = as ? staff.get(as) : undefined;
    if (!m || !drawsPictures(m.role)) return json(res, 400, { error: 'Pick an artist on the team: their model draws the samples. Hire one first if there is none.' });
    if (!brains.refsOf(m).length) return json(res, 400, { error: `${m.name} has no picture model yet: give them one under Staff, then make the samples.` });
    if (now.items.some(x => x.sample && x.as === as && (x.state === 'waiting' || x.state === 'running'))) return json(res, 409, { error: `${m.name.split(/\s+/)[0]}'s style samples are in the queue already.` });
    const r = await addToQueue(sampleItems(as, sampleSide(m)));
    return json(res, r.status, r.status === 200 ? { ...(r.body as object), said: `${sampleStyles().length} style samples for ${m.name.split(/\s+/)[0]} are in the queue. Each is kept as it is drawn.` } : r.body);
  },
  '/api/queue/add': async ({ res, b }) => {
    // {items: [...]} (a pasted list) or one item's fields.
    const r = await addToQueue(Array.isArray(b.items) ? (b.items as Record<string, unknown>[]).filter(x => x && typeof x === 'object') : [b]);
    return json(res, r.status, r.body);
  },
  '/api/queue/move': async ({ res, b }) => {
    let moved = false;
    await change(q => { moved = Q.move(q, String(b.id ?? ''), b.dir === 'up' ? -1 : 1); });
    return json(res, moved ? 200 : 409, moved ? await view() : { error: 'Only a line still waiting moves, and only past another waiting line.' });
  },
  '/api/queue/cancel': async ({ res, b }) => {
    const id = String(b.id ?? '');
    const l = live.get(id);
    if (l) {
      l.why = 'cancel';
      l.ac.abort();
    } else {
      await change(q => {
        const y = find(q, id);
        // A project waiting for this picture then runs, sees it cancelled, and waits for him with the reason.
        if (y && y.state === 'waiting') Object.assign(y, { state: 'cancelled', ended: new Date().toISOString() });
      });
    }
    return json(res, 200, await view());
  },
  '/api/queue/again': async ({ res, b }) => {
    // An agent's run is started again from the Agents page, which checks its job first.
    if (find(now, String(b.id ?? ''))?.kind === 'agent') return json(res, 409, { error: "Start an agent's job again with Run now on the Agents page." });
    // A line that did not finish (or was cancelled) goes back in line, at the end.
    let ok = false;
    await change(q => {
      const i = q.items.findIndex(x => x.id === String(b.id ?? '') && (x.state === 'failed' || x.state === 'cancelled'));
      if (i < 0) return;
      const [y] = q.items.splice(i, 1);
      for (const k of ['error', 'result', 'ended', 'started', 'after', 'tries', 'note', 'seen', 'lanes', 'laneName'] as const) delete y[k];
      q.items.push({ ...y, state: 'waiting' });
      ok = true;
    });
    if (ok) void pump();
    return json(res, ok ? 200 : 409, ok ? await view() : { error: 'Only a line that did not finish, or was cancelled, goes back in line.' });
  },
  '/api/queue/pause': async ({ res, b }) => {
    // Stop: what runs now stops and goes back in line, and nothing new starts until Resume.
    const paused = b.paused !== false;
    await change(q => { q.paused = paused; });
    if (paused) for (const l of live.values()) { l.why = 'stop'; l.ac.abort(); }
    else void pump();
    return json(res, 200, await view());
  },
  '/api/queue/clear': async ({ res, b }) => {
    // Finished lines (and, with all, every line still waiting); what runs now is left running.
    // A finished picture a waiting project is still to carry on from stays too: its step is marked done from it.
    await change(q => {
      const needed = new Set(q.items.filter(x => x.state === 'waiting' && x.waitFor).map(x => x.waitFor));
      q.items = q.items.filter(x => x.state === 'running' || (b.all !== true && (x.state === 'waiting' || needed.has(x.id))));
    });
    return json(res, 200, await view());
  },
  '/api/queue/seen': async ({ res, b }) => {
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).filter((x): x is string => typeof x === 'string').slice(0, Q.MAX_ITEMS));
    await change(q => { for (const x of q.items) if (ids.has(x.id)) x.seen = true; });
    return json(res, 200, await view());
  },
};

/** At start: what was running when TOMLIN stopped goes back in line; then the queue is looked at every 3 s. */
export async function startQueue(): Promise<void> {
  await change(q => Object.assign(q, Q.afterRestart(q)));
  setInterval(() => void pump(), 3000).unref();
  void pump();
}
