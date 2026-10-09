// Who is answering now (chats and job steps, each on its runner), and what a chat turn reads: its history and notebooks.
import { Pane } from '../pane.ts';
import { phasesByWho, type Phase } from '../home.ts';
import { type ChatLine, DEFAULT_RUN } from '../store.ts';
import { ANSWER_CEILING, streamChat } from '../engine.ts';
import { systemFor, toneOf } from '../persona.ts';
import { nowModel, staffSystem, roleOf, isPlain, type StaffMember } from '../staff.ts';
import * as nodestaff from '../nodestaff.ts';
import * as memory from '../memory.ts';
import { HOST_NAME, type Routes, chats, json, notebooks, staff, staffId, store } from './core.ts';
import { chat, lastUsed, main, runOn } from './panes.ts';
import { chatPeople, personFor, sendTarget } from './people.ts';
import { chatQuery, namedChat } from '../chats.ts';

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
  if (pane) for (const [s, p] of stepAnswers) if (p === pane) s.abort();
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

/** The one context builder for a chat turn with the manager or a hire. */
export async function chatContext(who: string, member: StaffMember | undefined, history: ChatLine[], message: string, ctx: number, opening?: string, docs?: string): Promise<memory.ChatContext> {
  const books = notebooksOf(who);
  // An answer a linked PC still owes, with nothing written yet, is not a turn: the model is not shown an empty answer.
  history = history.filter(l => !(l.waiting && !l.content.trim()));
  // A Default hire is sent as a plain chat window sends: no card, no notebooks, no "remember" rule (the chat, a handoff
  // it carries on from, and the documents added to it are still read).
  if (isPlain(member)) return memory.buildChat({ ctx, maxAnswer: ANSWER_CEILING, card: '', team: null, own: null, name: books.name, history, message, opening, docs });
  const { tone } = await store.settings();
  const [team, own] = await Promise.all([notebooks.read('team'), books.own ? notebooks.read(books.own) : Promise.resolve<memory.NoteLine[] | null>(null)]);
  const card = member ? staffSystem(member, toneOf(member.tone ?? tone).prompt) : systemFor(who, tone, store.peek()?.managerName ?? '');
  return memory.buildChat({ ctx, maxAnswer: ANSWER_CEILING, card, rules: memory.SUGGEST_RULE, team, own, name: books.name, history, message, opening, docs });
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
  // Before the first answer in this run, the size is the one set for their model here (or the connected model's).
  const own = member ? nowModel(member) ?? member.model ?? '' : '';
  const ctx = last?.ctx ?? (own && !own.startsWith('remote:') ? (s.run[own]?.ctx ?? DEFAULT_RUN.ctx) : runOn(main()).ctx);
  const built = await chatContext(who, member, open ? await chats.lines(open.id) : [], '', ctx, open?.opening);
  const books = notebooksOf(who);
  return { name: books.name, scope: books.own ?? 'team', book: books.own ? `${books.name}'s memory` : 'the team memory', ctx: built.ctx, answerTokens: built.answerTokens, room: built.room, used: built.used, parts: built.parts, model: last?.model ?? '', measured: !!last };
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
  return m && roleOf(m.role).kind ? m : null;
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

// ---- Routes ----

/** GET requests answered here, by path. */
export const answeringGet: Routes = {
  '/api/memory': async ({ res, url }) => {
    const scope = url.searchParams.get('scope') ?? '';
    if (!memory.isScope(scope) || (scope !== 'team' && !staff.get(scope.slice(6)))) return json(res, 404, { error: 'There is no such memory.' });
    return json(res, 200, { scope, lines: await notebooks.read(scope) });
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
    // His notebooks: add, change or delete one line. A model never calls this; a suggestion is saved only on his Save.
    const scope = String(b.scope ?? '');
    if (!memory.isScope(scope) || (scope !== 'team' && !staff.get(scope.slice(6)))) return json(res, 404, { error: 'There is no such memory. The person may have left the team.' });
    const from = b.from === 'pin' || b.from === 'suggested' ? b.from : 'owner';
    const r = b.action === 'delete' ? ((await notebooks.remove(scope, b.id)) ? { ok: true } : { error: 'That line is not there any more.' }) : b.action === 'edit' ? await notebooks.edit(scope, b.id, b.text) : await notebooks.add(scope, b.text, from);
    if ('error' in r) return json(res, 400, r);
    return json(res, 200, { line: r, lines: await notebooks.read(scope) });
  },
};
