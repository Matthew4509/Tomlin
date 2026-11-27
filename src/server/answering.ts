// Who is answering now (chats and job steps, each on its runner), and what a chat turn reads: its history and notebooks.
import { Pane } from '../pane.ts';
import { phasesByWho, type Phase } from '../home.ts';
import { type ChatLine, DEFAULT_RUN } from '../store.ts';
import { ANSWER_CEILING, streamChat } from '../engine.ts';
import { systemFor, toneOf } from '../persona.ts';
import { nowModel, staffSystem, isPlain, drawsPictures, worksAlone, type StaffMember } from '../staff.ts';
import { refsOf } from '../brains.ts';
import * as nodestaff from '../nodestaff.ts';
import * as memory from '../memory.ts';
import { scanText } from '../promptscan.ts';
import { parseBook } from '../notebookfile.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildLayered, cleanFoldWait, LAYER_MIN_CTX, layeredFor, layerReadSpeed, type Layered } from '../layers.ts';
import { HOST_NAME, type Routes, chatLogs, chats, json, notebooks, shortName, staff, staffId, store } from './core.ts';
import { chat, lastUsed, main, runOn, runnerSlots } from './panes.ts';
import { chatPeople, personFor, sendTarget } from './people.ts';
import { readSpeedsNow } from './thispc.ts';
import { chatQuery, namedChat, type ChatInfo } from '../chats.ts';

// ---- Chat ----

/**
 * The answers coming now, each under its chat (chatId '' for work that is not a chat: the blog writer, a speed test),
 * with the runner it uses (null while a hire's brain is found, or when it answers on another PC). Opening another chat
 * leaves an answer running; Stop in a chat, emptying it or deleting it ends that chat's answer only. Two chats answer
 * at once on two runners; on one runner the second waits for the first and says so (takeTurn), never stopping it.
 */
interface Answering {
  chatId: string;
  who: string;
  pane: Pane | null;
  /** What the work is when it is not a chat ("A speed test", "A program asking through /v1"), for the waiting note. */
  label?: string;
  /** Waiting for this runner (takeTurn), in the order asked: the first to ask goes first. */
  waitFor?: Pane;
  seq?: number;
  /** What the model does now, for Staff overview: reading what it was sent, thinking first, or writing the answer. */
  phase?: Phase;
}
const chatAnswers = new Map<AbortController, Answering>();
let asked = 0;
/** Job steps answering now, each on its own runner. A chat answer stops only a step on the same runner, and a step
 * stops only a chat answer on the same runner: two models loaded side by side answer at the same time. */
export const stepAnswers = new Map<AbortController, Pane>();
/** Ends the answers `pick` chooses (all of them when none is given). */
export function stopChats(pick: (a: Answering) => boolean = () => true) {
  for (const [ac, a] of chatAnswers) if (pick(a)) ac.abort();
}
/** True while this chat has an answer coming (or a hire's model being found for one). */
export const chatAnswering = (chatId: string) => [...chatAnswers.values()].some(a => a.chatId === chatId);
/** Ends whatever is answering on this runner: chat answers and any job step. */
export function stopOn(pane: Pane) {
  stopChats(a => a.pane === pane);
  for (const [ac, p] of stepAnswers) if (p === pane) ac.abort();
}
/** True while a chat or a job step is answering: on this runner when one is named, else anywhere. */
export function answeringBusy(pane?: Pane | null): boolean {
  // An answer waiting for a runner (or holding it before it starts) counts: that runner is not unloaded or swapped out.
  const chats = [...chatAnswers.values()].filter(a => a.pane !== null || a.waitFor);
  if (!pane) return chats.length > 0 || stepAnswers.size > 0;
  return chats.some(a => a.pane === pane || a.waitFor === pane) || [...stepAnswers.values()].includes(pane);
}

/**
 * The runner an answer will use, known before it starts (a hire's model found or loaded): kept for it from now, so
 * placing another model never swaps it out in between. It still takes its turn there (takeTurn), in the order reserved.
 */
export function reserve(ac: AbortController, pane: Pane) {
  const a = chatAnswers.get(ac);
  if (a && !a.pane) Object.assign(a, { waitFor: pane, seq: a.seq ?? ++asked });
}
/** An answer starts in a chat: listed at once, so Stop there reaches it while a hire's model is still found or loaded. */
export function startAnswer(ac: AbortController, chatId: string, who: string) {
  chatAnswers.set(ac, { chatId, who, pane: null });
}
export const endAnswer = (ac: AbortController) => void chatAnswers.delete(ac);
/** The answer moved on: reading what it was sent, thinking first, or writing (said only when it changes). */
export function setPhase(ac: AbortController, phase: Phase) {
  const a = chatAnswers.get(ac);
  if (a && a.phase !== phase) a.phase = phase;
}
/** What each person's answer is doing now, by `who` (src/home.ts phasesByWho): waiting for their runner, or the phase. */
export const answerPhases = () => phasesByWho([...chatAnswers.values()].map(a => ({ who: a.who, waiting: !!a.waitFor && !a.pane, phase: a.phase })));
/** The chat a chat file belongs to ("chats/<id>.json"), or '' for the old single-chat files. */
export const chatOfFile = (file: string) => /^chats\/([a-f0-9]{12})\.json$/.exec(file)?.[1] ?? '';
/** An answer takes its runner (null: it answers on another PC): a job step there stops (a chat outranks a step). */
export function takeChat(ac: AbortController, pane: Pane | null, chatId = '', who = '', label = '') {
  // A runner started with more than one slot (At once, src/slots.ts) writes a step beside a chat; with one, the step stops.
  if (pane && (runnerSlots.get(pane) ?? 1) <= 1) for (const [s, p] of stepAnswers) if (p === pane) s.abort();
  const was = chatAnswers.get(ac);
  chatAnswers.set(ac, { chatId: chatId || was?.chatId || '', who: who || was?.who || '', pane, ...(label || was?.label ? { label: label || was?.label } : {}) });
}

/** The waiting note's words for the work `o`. */
async function whoIsAnswering(o: Answering): Promise<string> {
  if (!o.chatId) return `${o.label || 'Other work'} is still running on this model`;
  const name = personFor(o.who, chatPeople())?.name ?? 'Someone';
  return `${name} is still answering in "${(await chats.get(o.chatId))?.title || 'another chat'}" on this model`;
}
/**
 * A chat's answer takes its runner in turn: while another chat answers on the same runner it waits, and the page is
 * told whose answer it waits for (one runner answers one chat at a time; the first is never stopped for the second).
 */
export async function takeTurn(ac: AbortController, pane: Pane, chatId: string, who: string, send: (event: string, data: unknown) => unknown): Promise<void> {
  const was = chatAnswers.get(ac);
  const seq = was?.waitFor === pane && was.seq ? was.seq : ++asked;
  chatAnswers.set(ac, { chatId: chatId || was?.chatId || '', who: who || was?.who || '', pane: null, ...(was?.label ? { label: was.label } : {}), waitFor: pane, seq });
  // Ahead of this answer: what answers on the runner now, and any answer that began waiting for it earlier.
  const first = () => [...chatAnswers.entries()].find(([k, a]) => k !== ac && a.chatId !== chatId && (a.pane === pane || (a.waitFor === pane && (a.seq ?? 0) < seq)))?.[1];
  let told = false;
  try {
    while (first() && !ac.signal.aborted) {
      if (!told) {
        told = true;
        send('status', { text: `${await whoIsAnswering(first()!)}. This answer starts when that one ends (or press Stop there to end it sooner).` });
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } finally {
    const now = chatAnswers.get(ac);
    if (now) {
      delete now.waitFor;
      delete now.seq;
    }
  }
  takeChat(ac, pane, chatId, who);
}

/** Whose notebooks a chat reads: the manager reads the team notebook; a hire reads it and their own. */
export function notebooksOf(who: string): { own: string | null; name: string } {
  const m = staffId(who) ? staff.get(who.slice(6)) : undefined;
  return m ? { own: `staff:${m.id}`, name: m.name.split(/\s+/)[0] } : { own: null, name: store.peek()?.managerName || HOST_NAME };
}

/** The context size each chat last answered with (so "What ... is reading" shows the right one before a model loads). */
export const lastContext = new Map<string, { ctx: number; at: number; model: string }>();

/** What a chat turn needs to be built in layers (src/layers.ts): the chat, its tick, the read speed, the fold wait. */
export interface LayerAsk {
  /** '' for a chat not made yet. */
  chatId: string;
  off?: boolean;
  readPerSecond: number;
  foldMinutes: number;
  /** "Sum up what a fold lets go" is on in this chat (off unless he ticks it). */
  sums?: boolean;
}

/**
 * The layer facts for a chat answered by `modelId`: the read speed from that model's big reads here (else the speed
 * finder's measured read; on a linked PC, its last big read in this chat) and the fold wait set for it in Model settings.
 */
export async function layerAsk(info: ChatInfo | null | undefined, modelId: string, away: boolean): Promise<LayerAsk> {
  const s = await store.settings();
  return { chatId: info?.id ?? '', off: info?.layersOff, readPerSecond: away ? info?.readSpeed ?? 0 : layerReadSpeed(readSpeedsNow()[modelId], s.run[modelId]?.found?.read), foldMinutes: cleanFoldWait(s.foldWait?.[modelId]), ...(info?.foldSums ? { sums: true } : {}) };
}

/** The one context builder for a chat turn with the manager or a hire: in layers when `layers` says so and it is 16K+. */
export async function chatContext(who: string, member: StaffMember | undefined, history: ChatLine[], message: string, ctx: number, opening?: string, docs?: string, docsWhole?: string, squeeze?: number, layers?: LayerAsk): Promise<memory.ChatContext | Layered> {
  const books = notebooksOf(who);
  // An answer a linked PC still owes, with nothing written yet, is not a turn: the model is not shown an empty answer.
  history = history.filter(l => !(l.waiting && !l.content.trim()));
  // A Default hire is sent as a plain chat window sends: no card, no notebooks, no "remember" rule (the chat, a handoff
  // it carries on from, and the documents added to it are still read).
  if (isPlain(member)) return memory.buildChat({ ctx, maxAnswer: ANSWER_CEILING, card: '', team: null, own: null, name: books.name, history, message, opening, docs, docsWhole, squeeze });
  const { tone } = await store.settings();
  const [team, own] = await Promise.all([notebooks.read('team'), books.own ? notebooks.read(books.own) : Promise.resolve<memory.NoteLine[] | null>(null)]);
  const card = member ? staffSystem(member, toneOf(member.tone ?? tone).prompt) : systemFor(who, tone, store.peek()?.managerName ?? '');
  const x = { ctx, maxAnswer: ANSWER_CEILING, card, rules: memory.SUGGEST_RULE, team, own, name: books.name, history, message, opening, docs, docsWhole, squeeze };
  if (layers && layeredFor(ctx, false, layers.off)) {
    const f = layers.chatId ? await chatLogs.read(layers.chatId) : { lines: [], sent: null, sums: [] };
    return buildLayered({ ...x, log: f.lines, sent: f.sent, readPerSecond: layers.readPerSecond, foldMinutes: layers.foldMinutes, ...(layers.sums ? { sums: f.sums } : {}) });
  }
  return memory.buildChat(x);
}

/**
 * "What ... is reading": the parts of the next turn of the chat the page names (src/chats.ts chatQuery), their sizes,
 * and what was cut or left out. Never the server's open chat: that is whichever window opened one last, and Pin uses
 * this to pick the notebook a line goes into.
 */
async function readingView(q: URLSearchParams): Promise<Record<string, unknown> & { status?: number }> {
  const named = namedChat(chatQuery(q));
  if ('error' in named) return { error: named.error, status: 400 };
  const at = await sendTarget(named, q.get('plain') ?? undefined);
  if ('error' in at) return at;
  const { who, chat: open } = at;
  const s = await store.settings();
  if (nodestaff.parseNodeWho(who)) return { error: 'This chat keeps its own memory, apart from Memory: there is nothing to show here.', status: 400 };
  const member = staffId(who) ? staff.get(who.slice(6)) : undefined;
  const last = open ? lastContext.get(open.id) : undefined;
  // Before the first answer in this run, the size is the one set for their model here (or the connected model's). The
  // host's chat with nothing loaded yet: the one set for the host's own model, which Connect loads.
  const own = member ? nowModel(member) ?? member.model ?? '' : '';
  const host = main().view.model ?? '';
  const ctx = last?.ctx ?? (own && !own.startsWith('remote:') ? (s.run[own]?.ctx ?? DEFAULT_RUN.ctx) : !member && !host && s.hostModel ? s.run[s.hostModel]?.ctx ?? DEFAULT_RUN.ctx : runOn(main()).ctx);
  const modelId = member ? own : host || s.hostModel;
  const ask = await layerAsk(open, modelId, modelId.startsWith('remote:'));
  const built = await chatContext(who, member, open ? await chats.lines(open.id) : [], '', ctx, open?.opening, undefined, undefined, undefined, ask);
  const books = notebooksOf(who);
  // The layers of this chat for Memory: on or off, and what a fold costs here. `can`: the tick does something here
  // (16K or more, not a Default hire).
  const layers = { on: !open?.layersOff, sums: !!open?.foldSums, can: layeredFor(ctx, isPlain(member), false), plain: isPlain(member), min: LAYER_MIN_CTX, layered: 'layered' in built, foldMinutes: ask.foldMinutes, readPerSecond: ask.readPerSecond, ...('layered' in built ? { older: built.older, shortTokens: built.shortTokens, foldTokens: built.foldTokens, foldSeconds: built.foldSeconds, waiting: built.logWaiting } : {}) };
  return { name: books.name, scope: books.own ?? 'team', book: books.own ? `${books.name}'s memory` : 'the team memory', ctx: built.ctx, answerTokens: built.answerTokens, room: built.room, used: built.used, parts: built.parts, model: last?.model ?? '', measured: !!last, chat: open?.id ?? '', layers, ...(member ? { always: await alwaysOnSmallest(member, built.room, built.ctx) } : {}) };
}

/**
 * G4: the hire's own "Always send" lines on the smallest model they use (their model and fallback on this PC, by the
 * context set for each): how many are not sent there. An Agent's run has the room its brief gives (agentBookRoom); a
 * chat, a fifth of the room, scaled from this model's.
 */
async function alwaysOnSmallest(member: StaffMember, room: number, ctx: number): Promise<{ model: string; ctx: number; room: number; agent: boolean; total: number; whole: number; part: number; left: number } | null> {
  const s = await store.settings();
  const local = refsOf(member).filter(r => !r.startsWith('remote:') && !r.startsWith('node:'));
  if (!local.length) return null;
  const sized = local.map(r => ({ ref: r, ctx: s.run[r]?.ctx ?? DEFAULT_RUN.ctx })).sort((a, b) => a.ctx - b.ctx);
  const small = sized[0];
  const bookRoom = worksAlone(member.role) ? memory.agentBookRoom(small.ctx) : Math.floor((room * (small.ctx / Math.max(1, ctx))) / 5);
  const fit = memory.alwaysFit(await notebooks.read(`staff:${member.id}`).catch(() => []), bookRoom);
  return fit.total ? { model: shortName(small.ref.split(/[\\/]/).pop()), ctx: small.ctx, room: bookRoom, agent: worksAlone(member.role), ...fit } : null;
}

/** Asks the connected chat model once, without the chat history (enhance prompt, alt text). */
export async function askOnce(system: string, message: string, maxTokens = 300, signal?: AbortSignal): Promise<string> {
  if (chat.view.state !== 'connected' || !chat.worker.base) throw new Error('No chat model is loaded: press Connect in the host\'s chat first.');
  lastUsed.chat = Date.now();
  const r = await streamChat(chat.worker.base, chat.view.model ?? '', [{ role: 'system', content: system }, { role: 'user', content: message }], () => undefined, signal ?? new AbortController().signal, maxTokens);
  return r.text.trim();
}

/** The picture specialist chosen in the Images window, if they are still on the team and still draw. */
export const imageSpecialist = async () => {
  const m = staff.get((await store.settings()).imageAs);
  return m && drawsPictures(m.role) ? m : null;
};

/**
 * Chats being answered now (Home's "Working now"): who, in which chat, since when. Each one leaves the list when its
 * answer ends, however it ends (done, fault, Stop, a closed tab).
 */
export const chatWork = new Map<object, { who: string; chatId: string; what: 'answer' | 'continue' | 'handoff' | 'picture'; startedAt: number }>();
/** When each person (by `who`) last finished something in a chat: Staff overview's office keeps them at the desk a while. */
export const lastWorked = new Map<string, number>();
export function workOn(res: { once(event: 'close', fn: () => void): unknown }, who: string, chatId: string, what: 'answer' | 'continue' | 'handoff' | 'picture'): void {
  const key = {};
  chatWork.set(key, { who, chatId, what, startedAt: Date.now() });
  res.once('close', () => {
    chatWork.delete(key);
    lastWorked.set(who, Date.now());
  });
}

/** A notebook as the Memory page shows it: every entry (withheld ones marked), its groups, what is wrong, how full. */
async function bookView(scope: string) {
  const book = await notebooks.book(scope);
  return { scope, lines: book.entries, groups: book.groups, problems: book.problems, full: memory.bookFull(book.entries), mtime: book.mtime };
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const answeringGet: Routes = {
  '/api/memory': async ({ res, url }) => {
    const scope = url.searchParams.get('scope') ?? '';
    if (!memory.isScope(scope) || (scope !== 'team' && !staff.get(scope.slice(6)))) return json(res, 404, { error: 'There is no such memory.' });
    return json(res, 200, await bookView(scope));
  },
  // The notebooks for the Memory page's left side: the team's, then each hire's, with how full each is.
  '/api/memory/books': async ({ res }) => {
    const one = async (scope: string, name: string, role: string, plain = false) => {
      const b = await notebooks.book(scope);
      return { scope, name, role, plain, full: memory.bookFull(b.entries), inbox: b.entries.filter(e => e.group === memory.INBOX_GROUP).length, problems: b.problems.length };
    };
    const books = [await one('team', 'Team', 'read by everyone')];
    for (const m of staff.list()) books.push(await one(`staff:${m.id}`, m.name, m.role, isPlain(m)));
    return json(res, 200, { books, folder: join(store.dir, 'memory') });
  },
  // The Text view: the file as it is on disk, and its time (sent back with Save, so a change made meanwhile is not lost).
  '/api/memory/text': async ({ res, url }) => {
    const scope = url.searchParams.get('scope') ?? '';
    if (!knownBook(scope)) return json(res, 404, { error: 'There is no such memory.' });
    return json(res, 200, { scope, ...(await notebooks.text(scope)), file: notebooks.fileOf(scope) });
  },
  // Search finds in every notebook: the entries whose text or group holds every word asked.
  '/api/memory/search': async ({ res, url }) => {
    const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return json(res, 200, { found: [] });
    const found: { scope: string; id: string; text: string; group: string }[] = [];
    for (const scope of ['team', ...staff.list().map(m => `staff:${m.id}`)]) {
      for (const e of (await notebooks.book(scope)).entries) {
        const hay = `${e.text}\n${e.group}`.toLowerCase();
        if (words.every(w => hay.includes(w))) found.push({ scope, id: e.id, text: e.text, group: e.group });
        if (found.length >= 100) break;
      }
    }
    return json(res, 200, { found });
  },
  '/api/memory/reading': async ({ res, url }) => {
    // ?chat=<id> (or ?chat=&who=<person>): what that chat reads, not the chat another window opened last.
    const { status, ...r } = await readingView(url.searchParams);
    return json(res, 'error' in r ? status ?? 400 : 200, r);
  },
};

/** POST requests answered here, by path (the body is read already). */
export const answeringPost: Routes = {
  '/api/memory': async ({ res, b }) => {
    // His notebooks: add, change or delete one line. A model never calls this; a suggestion waits in the Inbox for his Keep.
    const scope = String(b.scope ?? '');
    if (!memory.isScope(scope) || (scope !== 'team' && !staff.get(scope.slice(6)))) return json(res, 404, { error: 'There is no such memory. The person may have left the team.' });
    const from = b.from === 'pin' || b.from === 'suggested' ? b.from : 'owner';
    // Memory is sent on every turn, so a pasted "ignore your rules" is worse here than in one message: the same warning
    // as a chat message's (src/promptscan.ts), and nothing is kept until he has seen it and ticked that he understands.
    if ((b.action === 'add' || b.action === 'edit') && typeof b.text === 'string' && b.scanOk !== true) {
      const scan = scanText(memory.cleanEntry(b.text));
      if (scan.suspect) return json(res, 409, { error: 'This entry looks like it tries to give orders to a model.', scan: { reasons: scan.reasons, hits: scan.hits }, text: memory.cleanEntry(b.text) });
    }
    // Kept from the Inbox (moved out of it with its words as the model wrote them): read as a new entry is, since from now
    // on it is sent on every turn.
    if (b.action === 'edit' && b.text === undefined && b.group !== undefined && b.group !== memory.INBOX_GROUP && b.scanOk !== true) {
      const was = (await notebooks.book(scope)).entries.find(e => e.id === b.id);
      const scan = was && was.group === memory.INBOX_GROUP ? scanText(was.text) : null;
      if (scan?.suspect) return json(res, 409, { error: 'This suggested line looks like it tries to give orders to a model.', scan: { reasons: scan.reasons, hits: scan.hits }, text: was!.text });
    }
    if (b.action === 'text') {
      // The whole file from the Text view: what is new or changed in it gets the same warning, the rest was seen before.
      const before = new Set((await notebooks.book(scope)).entries.map(e => e.text));
      const fresh = typeof b.text === 'string' ? parseBook(b.text).entries.map(e => memory.cleanEntry(e.text)).filter(t => t && !before.has(t)).join('\n\n') : '';
      const scan = fresh && b.scanOk !== true && !b.check ? scanText(fresh, { long: false }) : null;
      if (scan?.suspect) return json(res, 409, { error: 'Something new in this text looks like it tries to give orders to a model.', scan: { reasons: scan.reasons, hits: scan.hits }, text: fresh });
      const t = await notebooks.saveText(scope, b.text, b.mtime, b.check === true);
      if ('error' in t) return json(res, t.changed ? 409 : 400, t);
      return json(res, 200, { read: t, ...(b.check === true ? {} : await bookView(scope)) });
    }
    if (b.action === 'order') {
      await notebooks.order(scope, b.ids, b.groups);
      return json(res, 200, await bookView(scope));
    }
    if (b.action === 'group') {
      const g = await notebooks.group(scope, b.do, b.name, b.to);
      if ('error' in g) return json(res, 400, g);
      return json(res, 200, await bookView(scope));
    }
    const r = b.action === 'delete' ? ((await notebooks.remove(scope, b.id)) ? { ok: true } : { error: 'That line is not there any more.' }) : b.action === 'edit' ? await notebooks.edit(scope, b.id, b.text, b.group, b.was) : await notebooks.add(scope, b.text, from, b.group);
    if ('error' in r) return json(res, 'changed' in r && r.changed ? 409 : 400, r);
    return json(res, 200, { line: r, ...(await bookView(scope)) });
  },
  // Open file (Notepad on this PC; without Notepad, Explorer with the file picked) or Open folder (Explorer at memory\).
  '/api/memory/open': async ({ res, b }) => {
    const scope = String(b.scope ?? 'team');
    if (!knownBook(scope)) return json(res, 404, { error: 'There is no such memory.' });
    // Made first when it is not there yet, so Notepad opens the notebook and not an empty "new file" question.
    await notebooks.book(scope);
    const file = notebooks.fileOf(scope);
    if (!existsSync(file)) await notebooks.saveText(scope, '', 0);
    const folder = join(store.dir, 'memory');
    if (process.platform !== 'win32') return json(res, 200, { ok: true, file, said: `The file is ${file}.` });
    if (b.folder === true) return json(res, (await openOnThisPc('explorer', [folder])) ? 200 : 500, { file, said: `Opened ${folder}.` });
    if (await openOnThisPc('notepad', [file])) return json(res, 200, { file, said: `Opened in Notepad. Save it there; TOMLIN reads it again before the next answer.` });
    await openOnThisPc('explorer', [`/select,${file}`]);
    return json(res, 200, { file, said: `Notepad is not on this PC, so the folder is open with the file picked: ${file}.` });
  },
};

/** A notebook that is there to show: the team's, or a hire still on the team. */
const knownBook = (scope: string) => memory.isScope(scope) && (scope === 'team' || !!staff.get(scope.slice(6)));

/** Starts a program on this PC (Notepad, Explorer) without waiting for it; false when Windows could not start it. */
async function openOnThisPc(program: string, args: string[]): Promise<boolean> {
  const cp = await import('node:child_process');
  return new Promise(done => {
    const child = cp.spawn(program, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', () => (child.unref(), done(true)));
    child.once('error', () => done(false));
  });
}
