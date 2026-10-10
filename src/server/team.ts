// The staff: the roster, Home, waking someone, speed tests and auditions.
import { existsSync } from 'node:fs';
import { askText } from '../share.ts';
import { join } from 'node:path';
import { streamChat, type ChatTurn } from '../engine.ts';
import * as brains from '../brains.ts';
import sharp from 'sharp';
import { nickname } from '../nicknames.ts';
import { LEVEL_CHOICES, LEVELS, ROLES, IMAGE_TIERS, levelOfSize, paramsB, sizeB, modelsOf, nowModel, staffSystem, cleanAnswer, levelOf, roleOf, isPlain, matchModel, matchImageModel, runChecks, type Audition, type StaffMember } from '../staff.ts';
import { staffState as homeState, activityOf, awardBehind, awardPeriods, buy, cleanAwards, cleanBought, doingOf, DOING_WORDS, purseOf, shopView, undoAward, winnerOf, type Award } from '../home.ts';
import { readData, updateData } from '../atomic.ts';
import * as mute from '../mute.ts';
import * as nodestaff from '../nodestaff.ts';
import * as memory from '../memory.ts';
import { hereKey, pcKey, TEST_PROMPT, TEST_TOKENS, type Summary as SpeedSummary } from '../speed.ts';
import { HOST_ON, type Routes, byStaff, chats, faces, faultWords, hidden, json, mutes, notifier, pcProfiles, publicSettings, shortName, speeds, staff, staffId, store } from './core.ts';
import { shownName } from '../pcprofile.ts';
import { chat, chatList, chatPlace, connectChat, images, lastUsed, main, runnerFor, runners } from './panes.ts';
import { answerPhases, answeringBusy, endAnswer, lastWorked, reserve, stopOn, takeChat } from './answering.ts';
import { answeringNow, offHost, setWho, whoList } from './people.ts';
import { jobRoutes } from './jobs.ts';
import { queueHome } from './queue.ts';
import { staffUsage } from './costs.ts';
import { memoryNow } from './thispc.ts';
import { chatNeed } from '../calc.ts';

// ---- Staff ----

/** The roster for the page: each hire with every installed chat model laid against their level (suggestion, never a limit). */
async function staffView() {
  const models = chatList();
  const done = staff.auditions();
  const s = await store.settings();
  // Each paired PC as a brain (asked now, a few seconds at most): the chat models it lets linked PCs use, by name (they
  // load there when asked); and what it has loaded, for an older PC, a PC that shares none, or a hire already on it.
  const pcs = s.remotes.length ? await jobRoutes.remoteStatus() : [];
  const inUse = (ref: string) => staff.list().some(m => m.model === ref || m.fallback === ref);
  const pcBrains = (image: boolean) => pcs.flatMap(r => {
    // A "Backups only" PC takes no staff: it is not offered at all.
    if (r.backupsOnly) return [];
    const loaded = r.ok ? (image ? r.image?.name ?? null : r.model ?? null) : null;
    const now = !r.ok ? 'off now' : image && !r.can?.includes('draw') ? 'its TOMLIN is too old to draw for this PC' : loaded ? `now ${shortName(loaded)}${image && r.image?.styles.length ? `, draws ${r.image.styles.join(', ')}` : ''}` : 'nothing loaded now';
    const old = { id: `remote:${r.id}`, name: `On "${r.name}": the model it has loaded (${now})`, ok: !!loaded, nick: loaded ? nickname(loaded) : '', audition: null as ReturnType<typeof summary>, hidden: false, label: loaded ? shortName(loaded) : 'The model it has loaded', bytes: 0, loaded: !!loaded, busy: false };
    // While it is off, the list it sent last (kept), so a hire on one of them still shows by name. Chat models for chat
    // hires, picture models for artists (an older node shares chat models only).
    const shared = ((r.ok ? r.models : s.remotes.find(x => x.id === r.id)?.models) ?? []).filter(x => (x.kind === 'image') === image);
    const busyWord = image ? ' (drawing now)' : ' (answering now)';
    const named = shared.map(x => ({ id: brains.remoteRef(r.id, x.id), name: `${shortName(x.name) || x.name} on "${r.name}"${!r.ok ? ' (off now)' : x.busy ? busyWord : x.loaded ? ' (loaded there)' : ' (loads there when asked)'}`, ok: r.ok, nick: nickname(x.name), audition: null as ReturnType<typeof summary>, hidden: x.hidden === true, label: shortName(x.name) || x.name, bytes: x.bytes || 0, loaded: r.ok && !!x.loaded, busy: r.ok && !!x.busy }));
    return [...named, ...(!named.length || inUse(old.id) ? [old] : [])];
  });
  const usage = Object.fromEntries(await Promise.all(staff.list().map(async m => [m.id, await staffUsage(m.id)] as const)));
  // For the Hire staff window: each PC's memory, and each model's PC, size, the memory it needs, whether it fits there,
  // and the level its size suggests (the level picker starts there; it can be changed).
  const mem = memoryNow();
  const memOf = (raw: unknown) => {
    const m = raw as { ram?: { total?: number }; gpu?: { total?: number; shared?: boolean } | null } | null | undefined;
    return { ram: m?.ram?.total ?? 0, vram: m?.gpu && !m.gpu.shared ? m.gpu.total ?? 0 : 0 };
  };
  const pcMem = new Map(pcs.map(r => [r.id, memOf(r.ok ? r.memory : null)]));
  /** Whether a model needing `need` bytes fits a linked PC: on its card, else in its RAM (3 GB kept for Windows); null = not known. */
  const fitThere = (pc: string, need: number) => {
    const m = pcMem.get(pc);
    if (!m?.ram || !need) return null;
    return need <= m.vram || need <= m.ram - 3 * 2 ** 30 ? 'ok' : need <= m.ram ? 'tight' : 'no';
  };
  const chatLevel = (name: string, bytes: number) => (bytes || paramsB(name) !== null ? levelOfSize(sizeB(name, bytes)).id : null);
  const imageLevel = (bytes: number) => (bytes ? LEVELS.find(l => bytes / 2 ** 30 <= IMAGE_TIERS[l.id].maxGB)?.id ?? null : null);
  const remoteChoice = (image: boolean) => (b: ReturnType<typeof pcBrains>[number]) => {
    const pc = brains.parseRef(b.id).kind === 'remote' ? (brains.parseRef(b.id) as { pc: string }).pc : '';
    const need = image ? b.bytes : b.bytes ? Math.round(chatNeed(b.bytes)) : 0;
    return { id: b.id, name: b.name, nick: b.nick, ok: b.ok, hidden: b.hidden, pc, label: b.label, bytes: b.bytes, need, fit: fitThere(pc, need), loaded: b.loaded, busy: b.busy, level: image ? imageLevel(b.bytes) : chatLevel(b.label, b.bytes) };
  };
  return {
    sharing: jobRoutes.shareView().on,
    pcs: pcs.map(r => ({ id: r.id, name: r.name, ok: r.ok, away: r.ok && !!r.away, ...pcMem.get(r.id)! })),
    here: memOf(mem),
    roles: ROLES.map(({ id, name, hint, examples, kind }) => ({ id, name, hint, examples, kind: kind ?? 'chat' })),
    levels: LEVEL_CHOICES.map(({ id, name, size, suggest }) => ({ id, name, size, suggest, imageSuggest: IMAGE_TIERS[id].suggest, imageSize: IMAGE_TIERS[id].size })),
    connected: chat.view.state === 'connected' ? chat.view.model : null,
    // For Hire staff (public/hire.js): every model a new hire can start on, with the short name the name box offers (src/nicknames.ts).
    hireChoices: {
      chat: [...models.map(x => ({ id: x.id, name: shortName(x.name) || x.name, nick: nickname(x.name), hidden: hidden.has(x.id), pc: '', label: shortName(x.name) || x.name, bytes: x.bytes, need: Math.round(chatNeed(x.bytes)), fit: x.fit.level, loaded: runnerFor(x.id)?.view.state === 'connected', busy: false, level: chatLevel(x.name, x.bytes) })), ...pcBrains(false).map(remoteChoice(false))],
      image: [...images.list().filter(x => x.installed).map(x => ({ id: x.id, name: x.name, nick: nickname(x.name), hidden: hidden.has(x.id), pc: '', label: x.name, bytes: x.bytes, need: x.bytes, fit: x.fit.level, loaded: images.pane.view.model === x.id && images.pane.view.state === 'connected', busy: false, level: imageLevel(x.bytes) })), ...pcBrains(true).map(remoteChoice(true))],
    },
    connectedAll: runners.filter(p => p.view.state === 'connected').map(p => p.view.model),
    connectedImage: images.pane.view.state === 'connected' ? images.pane.view.model : null,
    staff: staff.list().map(m => roleOf(m.role).kind
      ? {
        ...m,
        kind: 'image',
        pcBrains: pcBrains(true),
        styles: brains.STYLES.map(st => ({ id: st, name: brains.STYLE_NAME[st] })),
        models: images.list().map(x => ({ id: x.id, name: x.name, bytes: x.bytes, fit: x.fit.level, installed: x.installed, hidden: hidden.has(x.id), unit: 'GB', ...matchImageModel(m, x.bytes), audition: summary(done[roleOf(m.role).id + ':' + x.id]) }))
          .sort((a, b) => Number(b.installed) - Number(a.installed) || b.rank - a.rank || a.bytes - b.bytes),
      }
      : {
        ...m,
        kind: 'chat',
        pcBrains: pcBrains(false).map(b => ({ ...b, audition: summary(done[`${roleOf(m.role).id}:${b.id}`]) })),
        speed: speedOfRef(nowModel(m) ?? m.model),
        usage: usage[m.id],
        models: models.map(x => ({ id: x.id, name: x.name, bytes: x.bytes, fit: x.fit.level, hidden: hidden.has(x.id), unit: 'B', ...matchModel(m, x), audition: summary(done[roleOf(m.role).id + ':' + x.id]) }))
          .sort((a, b) => b.rank - a.rank || a.bytes - b.bytes),
      }),
  };
}
const summary = (a: Audition | undefined) => (a ? { score: a.score, of: a.of, seconds: a.seconds, at: a.at, model: a.model } : null);

/** A hire whose preferred brain is on a paired PC: that PC's state as it last answered (Home asks it every poll). */
function remoteState(ref: string | null | undefined, image: boolean): { state: 'on' | 'asleep' | 'off' | 'none'; text: string; modelName: string; pc: string; owner?: boolean; busy?: boolean } | null {
  const b = brains.parseRef(ref);
  if (b.kind !== 'remote') return null;
  const r = store.peek()?.remotes.find(x => x.id === b.pc);
  if (!r) return { state: 'none', text: 'Its PC is no longer paired', modelName: '', pc: '' };
  const h = jobRoutes.lastHello(r.id);
  const loaded = image ? h?.image?.name : h?.model;
  if (!h || Date.now() - h.at > 5 * 60_000) return { state: 'off', text: `On "${r.name}": not heard from lately`, modelName: b.model ? shortName(jobRoutes.sharedName(r.id, b.model)) : '', pc: r.name };
  if (b.model) {
    const name = shortName(jobRoutes.sharedName(r.id, b.model));
    const sh = h.models.find(x => x.id === b.model && (x.kind === 'image') === image);
    if (h.away) return { state: 'off', text: `"${r.name}": its owner is using it for now`, modelName: name, pc: r.name, owner: true };
    if (!sh) return { state: 'none', text: `"${r.name}" no longer lets other PCs use ${name}`, modelName: name, pc: r.name };
    if (sh.busy) return { state: 'on', text: `${name} on "${r.name}" is ${image ? 'drawing' : 'answering'} for someone else now: yours waits for it`, modelName: name, pc: r.name, busy: true };
    return sh.loaded ? { state: 'on', text: `On, on "${r.name}"`, modelName: name, pc: r.name } : { state: 'asleep', text: `Asleep: ${name} loads on "${r.name}" when asked`, modelName: name, pc: r.name };
  }
  return loaded ? { state: 'on', text: `On, on "${r.name}"`, modelName: shortName(loaded), pc: r.name } : { state: 'asleep', text: `Asleep: "${r.name}" has no model loaded`, modelName: '', pc: r.name };
}

/** The speed figures for a chat brain ref: a model here, a linked PC's loaded model, or (none) the model connected here. */
function speedOfRef(ref: string | null | undefined): SpeedSummary | null {
  const b = brains.parseRef(ref ?? '');
  if (b.kind === 'here') return speeds.get(hereKey(b.id));
  if (b.kind === 'remote') {
    const model = b.model ? jobRoutes.sharedName(b.pc, b.model) : jobRoutes.lastHello(b.pc)?.model;
    return model ? speeds.get(pcKey(b.pc, model)) : null;
  }
  const id = chat.view.state === 'connected' ? chat.view.model : store.peek()?.chat.model;
  return id ? speeds.get(hereKey(id)) : null;
}

// ---- Test speed: one fixed example prompt on a person's model (here or on a linked PC), timed ----

let speedTesting = false;
/**
 * Runs the example prompt on what `who` answers with: the host ('manager'), a hire ('staff:<id>', their first choice),
 * a linked PC's loaded model ('remote:<pc>') or a model here ('model:<id>').
 * A model here that is not loaded is loaded for it (the press asks for that). Kept as that model's test: the baseline.
 */
async function speedTest(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const who = String(b.who ?? '');
  if (speedTesting) return { status: 409, body: { error: 'A speed test is running already. Wait for it to finish, then press Test speed again.' } };
  if (answeringBusy()) return { status: 409, body: { error: 'A model is answering something now. Wait for it to finish (or press Stop), then press Test speed again.' } };
  speedTesting = true;
  const ac = new AbortController();
  // Listed as work (no runner yet): Stop reaches it, and once its model is known it holds that runner (below).
  takeChat(ac, null, '', '', 'A speed test');
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ac.abort();
  }, 15 * 60_000);
  let first = 0;
  let t0 = Date.now();
  const onText = (t: string) => { if (!first && t.trim()) first = (Date.now() - t0) / 1000; };
  const turns: ChatTurn[] = [{ role: 'system', content: 'You are a helpful assistant. Answer in plain sentences.' }, { role: 'user', content: TEST_PROMPT }];
  try {
    const m = staffId(who) ? staff.get(who.slice(6)) : undefined;
    if (staffId(who) && (!m || roleOf(m.role).kind)) return { status: 404, body: { error: 'There is no such chat hire.' } };
    const s = await store.settings();
    const ref = m ? nowModel(m) ?? m.model ?? '' : who === 'manager' ? (chat.view.state === 'connected' ? chat.view.model ?? '' : s.chat.model) : who.startsWith('remote:') ? who : who.startsWith('model:') ? who.slice(6) : null;
    if (ref === null) return { status: 400, body: { error: 'Test speed for whom?' } };
    const as = m ?? ({ id: 'speed-test', name: 'The speed test', role: 'coder', level: 'junior', model: ref || null } as StaffMember);
    const rb = brains.parseRef(ref);
    if (rb.kind === 'remote') speeds.testing.add(`pc:${rb.pc}|`);
    if (rb.kind === 'here') speeds.testing.add(hereKey(rb.id));
    const got = await jobRoutes.hireBrain(as, () => undefined, ac.signal, ref);
    const id = got.here ? got.pane?.view.model ?? chat.view.model ?? '' : '';
    if (id) speeds.testing.add(hereKey(id));
    // A chat started meanwhile on the same runner waits for the test, so the figure is the model's alone. Reserved, not
    // taken: the model's own answer takes the runner (and stops what answers on it), and taken it was the test itself.
    if (got.here) reserve(ac, got.pane ?? main());
    // The first word is timed from here: loading the model first is not part of it.
    t0 = Date.now();
    await got.brain.chat(turns, TEST_TOKENS, onText, ac.signal);
    const pc = rb.kind === 'remote' ? rb.pc : '';
    return keepTest(got.here ? hereKey(id) : pcKey(pc, got.model), shortName(got.model), got.pc === 'this PC' ? 'this PC' : got.pc, got.brain.last ?? null, first);
  } catch (e) {
    // A model that cannot answer now says why in plain words (not as a hire's backup question).
    const reasons = (e as { reasons?: string[] }).reasons;
    if (reasons?.length) return { status: 409, body: { error: `Nothing to test now: ${reasons.join('; ')}.` } };
    return { status: 500, body: { error: late ? 'The test took over 15 minutes and was stopped.' : ac.signal.aborted ? 'The test was stopped.' : `The test stopped: ${(e as Error).message}` } };
  } finally {
    clearTimeout(timer);
    endAnswer(ac);
    speeds.testing.clear();
    speedTesting = false;
  }
}
function keepTest(key: string, name: string, where: string, s: { write: number; tokens: number; read?: number } | null, first: number): { status: number; body: unknown } {
  if (!s) return { status: 500, body: { error: `${where === 'this PC' ? 'The model' : `"${where}"`} did not report its speed${where === 'this PC' ? '' : ' (its TOMLIN may be older than this one: update it)'}. Nothing was kept.` } };
  if (!speeds.add(key, name, where, { ...s, first }, 'test')) return { status: 500, body: { error: 'The answer was too short to measure. Try again.' } };
  return { status: 200, body: { key, summary: speeds.get(key) } };
}

/** The last time each hire was seen working here (a project step, a loading model): with lastWorked, how long idle. */
const seenWorking = new Map<string, number>();
const WORKING: ReadonlySet<string> = new Set(['arriving', 'waiting', 'researching', 'thinking', 'typing', 'drawing', 'working']);

/** Home: the staff list with each person's state, and what the jobs need from the person. Every line is written by code. */
async function homeView() {
  const s = await store.settings();
  const chats = chatList();
  const pictures = images.list();
  const chatSeconds = (id: string) => s.loadSeconds[`chat:${id}`] ?? Math.round((chats.find(m => m.id === id)?.bytes ?? 0) / (150 * 2 ** 20)) + 4;
  const imageSeconds = (id: string) => s.loadSeconds[`image:${id}`] ?? Math.round((pictures.find(m => m.id === id)?.bytes ?? 0) / (200 * 2 ** 20)) + 4;
  // Each person's state from the runner holding their model (two or more chat models can be loaded), else the main one.
  const chatPane = (id: string | null | undefined) => { const v = (runnerFor(id) ?? main()).view; return { state: v.state, model: v.model ?? null }; };
  const imagePane = { state: images.pane.view.state, model: images.pane.view.model ?? null };
  const people = staff.list().map(m => ({ id: m.id, name: m.name, role: m.role }));
  const jobs = await jobRoutes.homeJobs(people);
  const answering = await answeringNow();
  const talking = new Set(answering.map(a => a.who));
  const drawing = new Set(answering.filter(a => a.what === 'picture').map(a => a.who));
  const phases = answerPhases();
  // The PC each hire sits on, by the name you gave it (src/pcprofile.ts).
  const profiles = await pcProfiles.all();
  const rows = staff.list().map(m => {
    const role = roleOf(m.role);
    const image = !!role.kind;
    const now = nowModel(m) ?? m.model;
    const entry = image ? pictures.find(x => x.id === now) : chats.find(x => x.id === now);
    const away = remoteState(m.model, image);
    const st = away ?? homeState(now, image ? imagePane : chatPane(now), image ? !!(entry && 'installed' in entry && entry.installed) : !!entry, now ? (image ? imageSeconds(now) : chatSeconds(now)) : 0);
    const busy = jobs.working?.staffId === m.id;
    const where = brains.parseRef(m.model);
    const doing = doingOf({ state: st.state, away: !!away?.owner, remoteBusy: !!away?.busy, phase: phases.get(`staff:${m.id}`) ?? null, picture: drawing.has(`staff:${m.id}`), job: busy });
    if (WORKING.has(doing)) seenWorking.set(m.id, Date.now());
    const last = Math.max(lastWorked.get(`staff:${m.id}`) ?? 0, seenWorking.get(m.id) ?? 0);
    return {
      id: m.id,
      name: m.name,
      role: role.name,
      roleId: role.id,
      level: levelOf(m.level).name,
      kind: image ? 'image' : 'chat',
      model: m.model ?? null,
      modelName: away ? away.modelName : shortName(entry?.name),
      pc: away?.pc ? (where.kind === 'remote' ? shownName(profiles[where.pc], away.pc) : away.pc) : null,
      // On a PC set to Backups only: it takes no work, so nobody offers this hire a task (Home's pickers).
      backupsOnly: where.kind === 'remote' && s.remotes.some(x => x.id === where.pc && x.backupsOnly === true),
      ...st,
      busy: busy ? jobs.working!.text : null,
      // The dot on their icon, and the PC they sit on in the left panel ('' = this PC).
      activity: activityOf({ state: st.state, busy: busy || talking.has(`staff:${m.id}`) || !!away?.busy, away: !!away?.owner }),
      // What they are doing now, for the office in Staff overview (public/office.js).
      doing,
      doingText: doing === 'working' ? `Working: ${jobs.working!.text}` : DOING_WORDS[doing],
      // Seconds since they last worked (null: not since TOMLIN started): the office keeps them at the desk a while.
      idleFor: WORKING.has(doing) ? 0 : last ? Math.round((Date.now() - last) / 1000) : null,
      pcId: where.kind === 'remote' ? where.pc : '',
      speed: image ? null : speedOfRef(now),
      active: image ? s.imageAs === m.id : s.who === `staff:${m.id}`,
    };
  });
  // The manager is whoever answers in the chat when no hire is chosen.
  const managerModel = s.hostModel || s.chat.model || null;
  const manager = {
    ...homeState(managerModel, chatPane(managerModel), !!chats.find(x => x.id === managerModel), managerModel ? chatSeconds(managerModel) : 0),
    modelName: shortName(chats.find(x => x.id === managerModel)?.name),
    speed: managerModel ? speeds.expect(hereKey(managerModel)) : null,
    active: !staffId(s.who) && !nodestaff.parseNodeWho(s.who),
  };
  // The queue (src/server/queue.ts): what came back while he was away comes first in Waiting for you; a project in the
  // queue is the queue's to run, so its own "paused" or "ready" line waits until the queue is done with it.
  const queue = await queueHome();
  const inQueue = new Set(queue.projects);
  // Said once: a project the queue finished is "Review documents for …", not also the job's own line.
  for (const l of queue.lines) if (l.kind === 'documents' && l.job) inQueue.add(l.job);
  const queueItems = queue.lines.map(l => ({ ...l, queue: true, goal: '', staffId: null }));
  return {
    // The host is off for now: no row for it.
    manager: HOST_ON ? manager : null,
    staff: rows,
    answering,
    ...jobs,
    // A linked PC's lock screen asked "I need to use the pc, please log out for N hours": first, it is someone waiting.
    waiting: [...jobRoutes.pcAsks().map(x => ({ kind: 'pcask', pc: x.pc, name: x.name, hours: x.hours, at: x.at, text: `"${x.name}": ${askText(x.hours)}.`, job: null, goal: '', staffId: null })), ...queueItems, ...jobs.waiting.filter(x => !inQueue.has(x.job))],
    paused: jobs.paused.filter(x => !inQueue.has(x.job)),
    queue: { count: queue.count, paused: queue.paused, waiting: queue.waiting, running: queue.running },
    setup: { chatModels: chats.length, imageModels: pictures.filter(x => x.installed).length, staff: rows.length, ...(await jobRoutes.linkCount().then(c => ({ pcs: c.working, pcsBroken: c.broken }))), node: jobRoutes.shareView().on },
  };
}

// ---- Waking someone who is asleep: their model loads, and the page follows it ("Loading Gemma 3 1B · 6 s of about 12 s") ----

const waking = new Map<string, { at: number; expect: number; model: string; name: string; pc: string; failed?: string }>();

async function wake(who: string, model: string): Promise<{ status: number; body: unknown }> {
  const m = staffId(who) ? staff.get(who.slice(6)) : undefined;
  if (!m) return { status: 404, body: { error: 'There is no such person on the team.' } };
  const image = !!roleOf(m.role).kind;
  const list = modelsOf(m);
  const pick = model || nowModel(m) || '';
  if (!pick || !list.includes(pick)) return { status: 400, body: { error: `Pick one of ${m.name}'s models (give them more in their profile).` } };
  const s = await store.settings();
  if (image) {
    if (images.busy()) return { status: 409, body: { error: 'The Images pane is drawing. Wait for it to finish, then wake them.' } };
    const r = await images.connect(pick, s.image.asked, s.image.threads);
    if ('error' in r) return { status: 400, body: { error: r.error } };
  } else {
    // Their model loads beside a kept one when the pair fits, else swaps out one that is not kept (src/runners.ts).
    const at = chatPlace(pick);
    if ('error' in at) return { status: 409, body: { error: at.error } };
    if (!at.already && at.replaces && answeringBusy(runnerFor(at.replaces))) return { status: 409, body: { error: 'The chat model is answering something. Wait for it to finish (or press Stop), then wake them.' } };
    const r = await connectChat(pick, s.chat.asked, s.chat.threads);
    if (r && typeof r === 'object' && 'error' in r) return { status: 400, body: { error: String((r as { error: unknown }).error) } };
  }
  if (pick !== m.model) await staff.change(m.id, { active: pick });
  else if (m.active) await staff.change(m.id, { active: null });
  const bytes = image ? images.list().find(x => x.id === pick)?.bytes ?? 0 : chatList().find(x => x.id === pick)?.bytes ?? 0;
  const expect = Math.round(s.loadSeconds[`${image ? 'image' : 'chat'}:${pick}`] ?? bytes / (150 * 2 ** 20) + 4);
  waking.set(who, { at: Date.now(), expect, model: pick, name: shortName((image ? images.list().find(x => x.id === pick)?.name : chatList().find(x => x.id === pick)?.name) ?? pick), pc: 'this PC' });
  return { status: 200, body: await wakeView(who) };
}

/** How waking is going: loading (seconds so far, the guess), on, or failed with why. */
async function wakeView(who: string) {
  const w = waking.get(who);
  if (!w) return { state: 'none' };
  const elapsed = Math.round((Date.now() - w.at) / 1000);
  const base = { model: w.name, pc: w.pc, elapsed, expect: w.expect };
  const m = staffId(who) ? staff.get(who.slice(6)) : undefined;
  const pane = m && roleOf(m.role).kind ? images.pane.view : (runnerFor(w.model) ?? runners.find(p => p.view.model === w.model) ?? main()).view;
  if (pane.model === w.model && pane.state === 'connected') return { ...base, state: 'on' };
  if (pane.state === 'failed' && pane.model === w.model) return { ...base, state: 'failed', text: pane.error ?? 'The model did not load.' };
  // Just after Wake up the pane may still show the model before; only later does another model mean it was replaced.
  if (pane.model !== w.model && pane.state !== 'loading') return elapsed < 6 ? { ...base, state: 'loading' } : { ...base, state: 'failed', text: 'Another model was loaded instead.' };
  return { ...base, state: 'loading' };
}

let auditing = false;
/** Three fixed jobs for the role, asked of the connected model; shows the answers and plain checks, and keeps the score. */
async function audition(id: string, ref?: unknown) {
  const member = staff.get(id);
  if (!member) return { status: 404, body: { error: 'There is no such person on the team.' } };
  if (roleOf(member.role).kind) return imageAudition(member);
  if (typeof ref === 'string' && ref) return brainAudition(member, ref);
  if (chat.view.state !== 'connected' || !chat.worker.base) return { status: 409, body: { error: 'Connect a chat model first: the audition runs on the model that is connected.' } };
  if (auditing) return { status: 409, body: { error: 'An audition is already running. Wait for it to finish.' } };
  auditing = true;
  // Only what answers on this runner stops (other chats and other runners carry on); Stop in a chat reaches the
  // audition too, and a chat started meanwhile waits for it.
  stopOn(main());
  const ac = new AbortController();
  takeChat(ac, main(), '', '', 'An audition');
  const role = roleOf(member.role);
  const model = chat.view.model ?? '';
  const started = Date.now();
  const results: Array<{ ask: string; answer: string; seconds: number; checks: Array<{ label: string; pass: boolean }> }> = [];
  try {
    for (let i = 0; i < role.audition.length; i++) {
      const t0 = Date.now();
      lastUsed.chat = t0;
      let answer = '';
      try {
        if (ac.signal.aborted) return { status: 409, body: { error: 'The audition was stopped.' } };
        const r = await streamChat(chat.worker.base, model, [{ role: 'system', content: staffSystem(member) }, { role: 'user', content: role.audition[i].ask }], () => undefined, AbortSignal.any([ac.signal, AbortSignal.timeout(180_000)]), 400, { plain: isPlain(member) });
        answer = isPlain(member) ? r.text : cleanAnswer(r.text);
      } catch (error) {
        answer = '';
        if (chat.view.state !== 'connected') return { status: 409, body: { error: 'The model was disconnected during the audition.' } };
        void error;
      }
      results.push({ ask: role.audition[i].ask, answer, seconds: Math.round((Date.now() - t0) / 100) / 10, checks: runChecks(role, i, answer) });
    }
  } finally {
    auditing = false;
    endAnswer(ac);
    lastUsed.chat = Date.now();
  }
  const all = results.flatMap(r => r.checks);
  const a: Audition = { model, at: new Date().toISOString(), score: all.filter(c => c.pass).length, of: all.length, seconds: Math.round((Date.now() - started) / 100) / 10, results };
  await staff.recordAudition(role.id, a);
  return { status: 200, body: a };
}

/**
 * The same three jobs on one of a hire's brains (here or on a paired PC), for "Switch brain": the preferred and the
 * fallback are auditioned one after the other and shown side by side. A model here may be loaded for it.
 */
async function brainAudition(member: StaffMember, ref: string) {
  if (auditing) return { status: 409, body: { error: 'An audition is already running. Wait for it to finish.' } };
  auditing = true;
  const role = roleOf(member.role);
  const ac = new AbortController();
  const started = Date.now();
  const results: Audition['results'] = [];
  try {
    const t = await jobRoutes.hireBrain(member, () => undefined, ac.signal, ref);
    // Counted as answering on its runner (here) so Stop reaches it and a chat there waits; another PC's model: listed only.
    const pane = t.here ? t.pane ?? main() : null;
    if (pane) stopOn(pane);
    takeChat(ac, pane, '', '', 'An audition');
    for (let i = 0; i < role.audition.length; i++) {
      if (ac.signal.aborted) return { status: 409, body: { error: 'The audition was stopped.' } };
      const t0 = Date.now();
      let answer = '';
      try {
        const said = await t.brain.chat([{ role: 'system', content: staffSystem(member) }, { role: 'user', content: role.audition[i].ask }], 400, () => undefined, AbortSignal.any([ac.signal, AbortSignal.timeout(180_000)]), { plain: isPlain(member) });
        answer = isPlain(member) ? said : cleanAnswer(said);
      } catch {
        answer = '';
      }
      results.push({ ask: role.audition[i].ask, answer, seconds: Math.round((Date.now() - t0) / 100) / 10, checks: runChecks(role, i, answer) });
    }
    const all = results.flatMap(r => r.checks);
    const a: Audition = { model: `${shortName(t.model)} ${brains.ranOn(t.pc, t.model).replace(/ \S+$/, '')}`, at: new Date().toISOString(), score: all.filter(c => c.pass).length, of: all.length, seconds: Math.round((Date.now() - started) / 100) / 10, results };
    // Kept under the brain chosen (a model id here, or the paired PC), so the team card shows it beside that choice.
    await staff.recordAudition(role.id, { ...a, model: ref });
    return { status: 200, body: { ...a, ref } };
  } catch (error) {
    return { status: 409, body: { error: (error as Error).message } };
  } finally {
    auditing = false;
    endAnswer(ac);
    lastUsed.chat = Date.now();
  }
}

/**
 * A picture specialist's audition: three fixed jobs drawn on the connected picture model with their way of working.
 * The program can only mark some things (finished, cut out, has detail); the pictures are shown for the person to judge.
 */
async function imageAudition(member: NonNullable<ReturnType<typeof staff.get>>) {
  if (images.pane.view.state !== 'connected') return { status: 409, body: { error: 'Connect a picture model in the Images window first: the audition draws on the model that is connected.' } };
  if (auditing) return { status: 409, body: { error: 'An audition is already running. Wait for it to finish.' } };
  auditing = true;
  const role = roleOf(member.role);
  const model = images.pane.view.model ?? '';
  const started = Date.now();
  const results: Audition['results'] = [];
  try {
    for (const job of role.pictures ?? []) {
      const t0 = Date.now();
      const checks: Array<{ label: string; pass: boolean }> = [];
      let output: string | undefined;
      const j = await images.generate({ prompt: job.ask, drafts: 1, source: 'chat', as: member.id });
      if ('id' in j) {
        await j.done;
        const pic = j.results[0];
        output = pic?.output;
        checks.push({ label: 'finished', pass: !!pic });
        const full = pic ? await images.gallery.file(pic.output) : null;
        if (full) {
          const img = sharp(full);
          const { width, height } = await img.metadata();
          const px = await img.clone().ensureAlpha().raw().toBuffer();
          let clear = 0;
          for (let i = 3; i < px.length; i += 4) if (px[i] < 16) clear++;
          const stats = await img.clone().removeAlpha().stats();
          const spread = stats.channels.reduce((n, c) => n + c.stdev, 0) / stats.channels.length;
          if (role.recipe?.mode === 'icon') checks.push({ label: 'background cut out', pass: clear / Math.max(1, (width ?? 1) * (height ?? 1)) > 0.12 });
          checks.push({ label: 'has detail (not blank)', pass: spread > 18 });
        }
      } else checks.push({ label: 'finished', pass: false });
      results.push({ ask: job.ask, answer: '', seconds: Math.round((Date.now() - t0) / 100) / 10, checks, picture: output });
    }
  } finally {
    auditing = false;
  }
  const all = results.flatMap(r => r.checks);
  const a: Audition = { model, at: new Date().toISOString(), score: all.filter(c => c.pass).length, of: all.length, seconds: Math.round((Date.now() - started) / 100) / 10, results };
  await staff.recordAudition(role.id, a);
  return { status: 200, body: a };
}

// ---- Routes ----

/** GET requests answered here, by path. */
// ---- The office's rewards (public/office.js): this month's and this week's tokens written per hire, and the awards ----

const officeFile = () => join(store.dir, 'office.json');
/** Each hire on the team with the tokens they wrote from `from` to today, most first. */
function board(from: string, today: string) {
  const names = new Map(staff.list().map(m => [m.id, m.name]));
  const rows = byStaff.writtenBetween(from, today).filter(r => names.has(r.id)).map(r => ({ ...r, name: names.get(r.id)! }));
  // Everyone on the team is on the board, a hire who wrote nothing yet with 0.
  for (const [id, name] of names) if (!rows.some(r => r.id === id)) rows.push({ id, name, out: 0 });
  return rows;
}
async function officeView() {
  const p = awardPeriods();
  const kept = await readData(officeFile(), {});
  const bought = cleanBought(kept);
  const awards = cleanAwards(kept);
  const monthBoard = board(p.monthFrom, p.today);
  return {
    // `behind`: who leads now when this month's award went to someone else earlier in the month (null otherwise).
    month: { key: p.month, name: p.monthName, board: monthBoard, behind: awardBehind(awards, p.month, monthBoard) },
    week: { from: p.weekFrom, board: board(p.weekFrom, p.today) },
    awards,
    purse: purseOf(byStaff.totalWritten(), bought),
    shop: shopView(bought),
  };
}

export const teamGet: Routes = {
  '/api/staff': async ({ res }) => json(res, 200, await staffView()),
  '/api/office': async ({ res }) => json(res, 200, await officeView()),
  '/api/staff/wake': async ({ res, url }) => json(res, 200, await wakeView(url.searchParams.get('who') ?? '')),
  '/api/home': async ({ res, url }) => {
    notifier.seen(url.searchParams.get('front') === '1');
    return json(res, 200, { ...(await homeView()), mute: mute.view(await mutes.get()), notify: { ...notifier.recent(), settings: await notifier.settings() } });
  },
};

/** POST requests answered here, by path (the body is read already). */
export const teamPost: Routes = {
  '/api/office/award': async ({ res }) => {
    // Employee of the month: whoever wrote the most tokens this month so far (awarded again, it is decided again).
    const p = awardPeriods();
    const w = winnerOf(board(p.monthFrom, p.today));
    if (!w) return json(res, 400, { error: `Nobody has written anything in ${p.monthName} yet, so there is no employee of the month. Talk to a hire first, then award it.` });
    if ('tied' in w) return json(res, 400, { error: `${w.tied.map(r => r.name).join(' and ')} have written the same (${w.tied[0].out.toLocaleString('en-GB')} tokens each) in ${p.monthName}, so there is no one winner yet. Award it again once one of them is ahead.` });
    const won = w.won;
    const award: Award = { month: p.month, id: won.id, name: won.name, out: won.out, at: new Date().toISOString() };
    await updateData(officeFile(), {}, raw => ({ ...(raw && typeof raw === 'object' ? raw : {}), awards: cleanAwards({ awards: [...cleanAwards(raw), award] }) }));
    return json(res, 200, { award, ...(await officeView()) });
  },
  '/api/office/award/undo': async ({ res }) => {
    // Undo award: this month's award is taken off (the frame goes back to the month before's, or empty).
    const p = awardPeriods();
    let undone = null as Award | null;
    await updateData(officeFile(), {}, raw => {
      const was = raw && typeof raw === 'object' ? raw : {};
      const u = undoAward(cleanAwards(was), p.month);
      if (!u) return undefined;
      undone = u.undone;
      return { ...was, awards: u.awards };
    });
    if (!undone) return json(res, 400, { error: `There is no award for ${p.monthName} to undo. It may have been undone already in another window.` });
    return json(res, 200, { undone, ...(await officeView()) });
  },
  '/api/office/buy': async ({ res, b }) => {
    // The office shop: paid from the team's tokens written (src/home.ts buy says no when short or owned already).
    let said = { error: 'The shop did not answer. Try again.' } as ReturnType<typeof buy>;
    await updateData(officeFile(), {}, raw => {
      const was = raw && typeof raw === 'object' ? raw : {};
      const bought = cleanBought(was);
      said = buy(b.item, byStaff.totalWritten(), bought);
      return 'bought' in said ? { ...was, bought: [...bought, said.bought] } : undefined;
    });
    if ('error' in said) return json(res, 400, { error: said.error });
    return json(res, 200, { bought: said.bought, ...(await officeView()) });
  },
  '/api/staff': async ({ res, b }) => {
    try {
      if (b.action === 'hire') {
        // Someone who left before leavers were listed may still have chats or a notebook under their id: a new
        // hire of the same name gets a fresh id, not theirs.
        const had = new Set((await chats.list()).map(c => c.who));
        // The model picked in Hire staff (they start on it): one of this PC's, or a linked PC's loaded one.
        if (typeof b.model === 'string' && b.model) {
          const ref = brains.parseRef(b.model);
          const image = !!roleOf(b.role).kind;
          const ok = ref.kind === 'remote' ? (await store.settings()).remotes.some(r => r.id === ref.pc) : ref.kind === 'here' && (image ? images.has(ref.id) : chatList().some(x => x.id === ref.id));
          if (!ok) return json(res, 400, { error: `That is not a ${image ? 'picture' : 'chat'} model on this PC or a linked PC. Pick again from the list.` });
        }
        await staff.hire(b.name, b.role, b.level, b.model,id => had.has(`staff:${id}`) || existsSync(join(store.dir, memory.scopeFile(`staff:${id}`))), b.look);
        // The chat keeps whoever it had, and "Draw as" whoever it had: the window that hired opens the new hire's chat,
        // or picks a new artist to draw, itself (another window's choice is not changed under it). Only with the host
        // off and the host still chosen does the first hire who chats become the one chosen.
        await offHost();
      } else if (b.action === 'change') {
        const was = staff.get(String(b.id));
        // A different kind of role (chat or picture) cannot keep the other kind's model.
        const change = was && b.role !== undefined && !!roleOf(b.role).kind !== !!roleOf(was.role).kind ? { ...b, model: null, fallback: null, style: null, group: [], active: null } : b;
        const image = !!roleOf(change.role ?? was?.role).kind;
        const remotes = (await store.settings()).remotes;
        for (const k of ['model', 'fallback'] as const) {
          const v = change[k];
          if (v === undefined || v === null || v === '') continue;
          const ref = brains.parseRef(v);
          const ok = ref.kind === 'remote' ? remotes.some(r => r.id === ref.pc) : ref.kind === 'here' && (image ? images.has(ref.id) : chatList().some(m => m.id === ref.id));
          if (!ok) return json(res, 400, { error: `That is not a ${image ? 'picture' : 'chat'} model on this PC or a linked PC. Pick again from the list.` });
        }
        // The related models a hire may also use are models on this PC (a node lends only its own).
        if (change.group !== undefined) {
          const list = Array.isArray(change.group) ? change.group : [];
          if (list.some(id => typeof id !== 'string' || !(image ? images.has(id) : chatList().some(m => m.id === id)))) return json(res, 400, { error: `Only ${image ? 'picture' : 'chat'} models on this PC can be in the list. Download it first, then tick it.` });
        }
        if (!(await staff.change(String(b.id), change))) return json(res, 404, { error: 'There is no such person on the team.' });
      } else if (b.action === 'fire') {
        if (!(await staff.fire(String(b.id)))) return json(res, 404, { error: 'There is no such person on the team.' });
        // Someone hired later with the same name starts without this one's photo.
        await faces.clear(`staff:${String(b.id)}`);
        if ((await store.settings()).who === 'staff:' + b.id) await setWho('standard');
        if ((await store.settings()).imageAs === b.id) await store.saveSettings({ imageAs: '' });
      } else return json(res, 400, { error: 'Unknown staff action.' });
    } catch (error) {
      return json(res, 400, { error: faultWords(error) });
    }
    return json(res, 200, { ...(await staffView()), who: whoList(), settings: publicSettings(await store.settings()) });
  },
  '/api/staff/wake': async ({ res, b }) => {
    const r = await wake(String(b.who ?? ''), String(b.model ?? ''));
    return json(res, r.status, r.body);
  },
  '/api/staff/backup': async ({ res, b }) => {
    // "Backup when a PC is off": once, until the first choice answers again, or always (it becomes the fallback).
    const m = staff.get(String(b.id ?? ''));
    if (!m) return json(res, 404, { error: 'That person is no longer on the team.' });
    const ref = String(b.ref ?? '');
    if (!(await jobRoutes.backupChoices(m)).choices.some(c => c.ref === ref)) return json(res, 400, { error: 'That backup cannot answer now (the PC went off, or the model no longer fits). Pick another.' });
    const how = b.for === 'always' ? 'always' : b.for === 'back' ? 'back' : 'once';
    await staff.change(m.id, how === 'always' ? { fallback: ref, cover: null } : { cover: { ref, once: how === 'once' } });
    return json(res, 200, { ok: true, staff: staff.get(m.id) });
  },
  '/api/speed/test': async ({ res, b }) => {
    const r = await speedTest(b);
    return json(res, r.status, r.body);
  },
  '/api/staff/audition': async ({ res, b }) => {
    const r = await audition(String(b.id), b.ref);
    return json(res, r.status, r.body);
  },
};
