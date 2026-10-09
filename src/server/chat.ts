// A chat turn: a message, Continue and the handoff, documents in a chat, Send to.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../log.ts';
import { cleanDocName, Docs, docSection, findParts, MAX_DOC_BYTES, MAX_DOCS, readDoc, sourcesLine } from '../docs.ts';
import type { ChatLine } from '../store.ts';
import { ANSWER_CEILING, CONTINUE_ASK, everyFew, NoPrefill, repeatCut, streamChat, THINK_ROOM, thinksOf, withWorking, type ThoughtStop } from '../engine.ts';
import * as brains from '../brains.ts';
import { pictureAsk } from '../chatpic.ts';
import { cleanAnswer, roleOf, isPlain, type StaffMember } from '../staff.ts';
import { checkMessage, REFUSAL } from '../filter.ts';
import type { ChatInfo } from '../chats.ts';
import * as nodestaff from '../nodestaff.ts';
import * as memory from '../memory.ts';
import { cleanFrom, cleanWritten, markSent, promptFor } from '../sendto.ts';
import { HOME, HOST_OFF, HOST_ON, type Route, type Routes, SECURITY_HEADERS, chats, json, notebooks, staff, staffId, store } from './core.ts';
import { chat, lastUsed, main, runOn, runnerUsed } from './panes.ts';
import { answeringBusy, askOnce, chatAnswering, chatContext, endAnswer, lastContext, notebooksOf, reserve, setPhase, startAnswer, stopChats, takeChat, takeTurn, workOn } from './answering.ts';
import { artistPointer, chatPeople, chatPersonHere, chatToSend, openChat, sendTarget, type SendTarget } from './people.ts';
import { namedChat } from '../chats.ts';
import { jobRoutes } from './jobs.ts';
import { newRid, owedLine, type Owed } from '../outbox.ts';
import { addOwed, dropOwed, notLive } from './owed.ts';
import { saveToOf } from './places.ts';
import { inScope, staffOfWho } from '../meter.ts';
import { queueOn } from './queue.ts';

/** A new message, answered in the chat it names (`to`): never in whichever chat another window opened last. */
async function chatMessage(res: ServerResponse, message: string, to: SendTarget, from = '', agree = false, think = false, now = false): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...SECURITY_HEADERS });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const { who } = to;
  const member = staffId(who) ? staff.get(who.slice(6)) : undefined;
  // A hire who lived on a linked PC is retired (linked PCs lend only their models): the old chat is kept to read.
  if (nodestaff.parseNodeWho(who)) {
    send('error', { text: nodestaff.RETIRED_NODE_HIRE });
    return void res.end();
  }
  // The host is off for now: someone on the staff answers instead.
  if (!HOST_ON && !member) {
    send('error', { text: HOST_OFF });
    return void res.end();
  }
  // A hire given their own brain answers on it (here or on a linked PC); anyone else on the model connected here.
  const own = !!member && brains.refsOf(member).length > 0;
  if (member && roleOf(member.role).kind) {
    send('error', { text: `${member.name} draws in the pictures pane: type what to draw in the box under the pictures.` });
    return void res.end();
  }
  // A picture asked for here is not drawn from this chat any more (the chat model's rewrite of the ask drifted from
  // what was asked): the app answers, without a model, with who draws and where.
  const ask = pictureAsk(message);
  if (ask) {
    const was0 = to.chat;
    if (was0 && !chatPersonHere(was0.who)) {
      send('error', { text: 'The person in this chat is no longer on the team, so it can be read but not carried on. Press "New chat" to talk to someone else.' });
      return void res.end();
    }
    const reply = artistPointer();
    const at = new Date().toISOString();
    const into = await chatToSend(to);
    send('chat', { chat: into.id });
    const file0 = chats.file(into.id);
    await store.changeChat(file0, lines => [...lines, { role: 'user', content: message, at, ...(from ? { from } : {}) }, { role: 'assistant', content: reply, at, ran: 'written by the app, no model' }]);
    send('done', { text: reply, perSecond: 0, ran: 'written by the app, no model', note: '', saved: true });
    return void res.end();
  }
  // "remember: ..." needs no model.
  const noModel = !!memory.rememberCommand(message);
  const hostModel = !member ? (await store.settings()).hostModel : '';
  if (!own && !noModel && (chat.view.state !== 'connected' || !chat.worker.base || (!!hostModel && chat.view.model !== hostModel))) {
    send('error', { text: 'No chat model is loaded: press Connect beside the model at the top of this chat, then send again.' });
    return void res.end();
  }
  // A chat with someone who has left the team can be read, not carried on.
  const was = to.chat;
  if (was && !chatPersonHere(was.who)) {
    send('error', { text: was.who.startsWith('node:') ? nodestaff.RETIRED_NODE_HIRE : was.who === 'manager' ? HOST_OFF : 'The person in this chat is no longer on the team, so it can be read but not carried on. Press "New chat" to talk to someone else.' });
    return void res.end();
  }
  // This PC is a node and a linked PC is using the model this answer would run on (or the one it would push out): asked
  // first, "Using this can impact connected users", and sent only once he ticks I agree. Nothing is saved before that.
  if (!agree && !noModel && jobRoutes.shareOn()) {
    const first = member ? brains.parseRef(brains.refsOf(member)[0] ?? '') : null;
    const id = first ? (first.kind === 'here' ? first.id : first.kind === 'remote' ? null : chat.view.model ?? null) : hostModel || chat.view.model || null;
    const impact = jobRoutes.impactOf(id);
    if (impact) {
      send('impact', { text: impact });
      return void res.end();
    }
  }
  const openChat0 = await chatToSend(to);
  const openId = openChat0.id;
  // The chat it went into (a new one is made just above): the page reads it back by this id.
  send('chat', { chat: openId });
  const file = chats.file(openId);
  // The hire's PC is busy with the queue (src/server/queue.ts): asked first, "busy: add to the queue" (or send now anyway).
  const queued = member && !now && !memory.rememberCommand(message) ? queueOn(brains.refsOf(member)) : null;
  if (queued) {
    send('queue', { text: `${member!.name.split(/\s+/)[0]}'s PC (${queued.pc}) is busy with the queue: "${queued.title.slice(0, 80)}". Add this message to the queue? It is answered in this chat when that PC is free.`, chat: openId });
    return void res.end();
  }
  // Quick or Think, as chosen in this chat's box: kept on the chat, so it is chosen again when the chat opens.
  if (!!openChat0.think !== think) await chats.mark(openId, { think });
  const books = notebooksOf(who);
  // "remember: ..." is written to the notebook by code, at once; no model is asked.
  const cmd = memory.rememberCommand(message);
  if (cmd) {
    const scope = cmd.team || !books.own ? 'team' : books.own;
    const r = await notebooks.add(scope, cmd.text, 'owner');
    const where = scope === 'team' ? 'the team memory' : `${books.name}'s memory`;
    // A Default hire reads no notebooks, so the reply does not promise that they will.
    const reader = isPlain(member) ? `${books.name} has the Default role and reads no memory; it is kept there for when you give ${books.name} a role.` : `${scope === 'team' ? 'Everyone on the team' : books.name} will read it from now on, in chats and in job steps.`;
    const reply = 'error' in r ? r.error : `Saved in ${where}: "${r.text}". ${reader} See, change or delete it under Memory.`;
    const at = new Date().toISOString();
    await store.changeChat(file, lines => [...lines, { role: 'user', content: message, at, ...(from ? { from } : {}) }, { role: 'assistant', content: reply, at, ran: 'written by the app, no model' }]);
    send('done', { text: reply, perSecond: 0, ran: 'written by the app, no model', note: '', saved: !('error' in r) });
    return void res.end();
  }
  return answerTurn(res, send, { who, member, own, file, openId, mode: 'message', message, from, think });
}

/**
 * A message from the queue (src/server/queue.ts), answered with no page open: the same turn as one typed in that chat,
 * saved there; a page that opens the chat follows it. Waits (busy) while that chat is answering something else.
 */
export async function queuedMessage(chatId: string, message: string, think: boolean, signal: AbortSignal, since = '', onEvent: (event: string, data: Record<string, unknown>) => void = () => undefined): Promise<{ who: string; ran: string } | { error: string }> {
  const info = await chats.get(chatId);
  if (!info) return { error: 'That chat is not here any more.' };
  if (!chatPersonHere(info.who)) return { error: 'The person in that chat is no longer on the team, so it can be read but not carried on.' };
  const member = staffId(info.who) ? staff.get(info.who.slice(6)) : undefined;
  if (member && roleOf(member.role).kind) return { error: `${member.name} draws pictures: add a picture to the queue instead.` };
  if (!member && !HOST_ON) return { error: HOST_OFF };
  const own = !!member && brains.refsOf(member).length > 0;
  if (!own && (chat.view.state !== 'connected' || !chat.worker.base)) return { error: 'No chat model is loaded for that chat: connect one, then add the message again.' };
  if (chatAnswering(chatId)) return { error: 'That chat is busy answering something else' };
  const verdict = checkMessage(message, { recent: [] });
  if (!verdict.ok) return { error: REFUSAL[verdict.reason] };
  const name = member ? member.name.split(/\s+/)[0] : chatPeople().find(p => p.who === info.who)?.name ?? 'The host';
  // Run again (TOMLIN was closed while it ran): the message may be in the chat already. With an answer (or an
  // answer still owed by a linked PC, collected by itself) after it, it is done; with none, it is sent again in its place.
  const file = chats.file(chatId);
  const history = await store.chat(file);
  const had = history.findLastIndex(l => l.role === 'user' && l.from === 'the queue' && l.content === message && l.at >= since);
  if (had >= 0 && history.slice(had + 1).some(l => l.role === 'assistant' && (l.content.trim() || l.waiting))) return { who: name, ran: 'before TOMLIN was closed' };
  if (had >= 0) await store.changeChat(file, lines => lines.filter((l, k) => k !== had && !(k > had && l.role === 'assistant' && !l.content.trim())));
  // The turn writes to a page; here nobody is reading, so what it says is kept to learn how it ended.
  let buf = '';
  let end: { event: string; data: Record<string, unknown> } | null = null;
  const sink = {
    destroyed: false,
    writableEnded: false,
    on: () => sink,
    once: () => sink,
    writeHead: () => sink,
    write: (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: ([\w-]+)/m.exec(block)?.[1] ?? '';
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>;
        if (['done', 'error', 'backup'].includes(ev)) end = { event: ev, data };
        else onEvent(ev, data);
      }
      return true;
    },
    end: () => {
      sink.writableEnded = true;
      return sink;
    },
  };
  // Cancel or Stop in the queue ends the answer as Stop in the chat does.
  const stop = () => stopChats(a => a.chatId === chatId);
  signal.addEventListener('abort', stop, { once: true });
  try {
    await answerTurn(sink as unknown as ServerResponse, () => undefined, { who: info.who, member, own, file, openId: chatId, mode: 'message', message, from: 'the queue', think });
  } finally {
    signal.removeEventListener('abort', stop);
  }
  const got = end as { event: string; data: Record<string, unknown> } | null;
  if (!got) return { error: 'The answer ended without a word.' };
  if (got.event === 'done') return { who: name, ran: String(got.data.ran ?? '') };
  if (got.event === 'backup') return { error: `${name}'s PC is off or not answering (${String(got.data.why ?? '')})` };
  return { error: String(got.data.text ?? 'The answer did not come.') };
}

/** Said under an answer whose working was stopped before it began (engine.ts ThoughtStop). */
const STOPPED_WORKING: Record<ThoughtStop, string> = {
  loop: 'Its working went round in circles, so it was stopped and the answer asked for with the working so far.',
  long: 'Its working ran past its room, so it was stopped and the answer asked for with the working so far.',
  hurry: 'Answer now: the working was stopped and the answer asked for with the working so far.',
};

/** What the model is asked when a chat has grown large: the handoff that opens the next chat. */
const HANDOFF_ASK = 'This chat has grown large, so the work carries on in a new chat that will read only what you write now. Write a handoff for it: what we are working on and why; what is decided; what is done (file names, names, numbers, settings); what is still open, and the next step. Short plain sentences and short lists, at most about 400 words. Only facts from this chat: invent nothing, and say plainly when something was left unsure.';

/**
 * One turn of a chat with the manager or a hire, on this PC or a linked one:
 * - message: his new message is saved and answered;
 * - continue: the last answer was cut by its length limit; the model carries it on (it is given the cut answer as the
 *   start of its own, so it goes on mid-sentence or mid-code) and the rest is joined onto the same line;
 * - handoff: the chat has grown large; the model writes a handoff (not saved in this chat) and a new chat with the same
 *   person opens with it as its opening note.
 */
async function answerTurn(res: ServerResponse, send: (event: string, data: unknown) => unknown, t: TurnAsk): Promise<void> {
  // A closed or reloaded page no longer stops the answer (2.0.31): it carries on and is saved in the chat, and a page
  // that opens this chat follows it from where it is (/api/chat/follow). Stop, emptying or deleting the chat end it.
  const live = new LiveAnswer(t.openId, res);
  try {
    // Every model answer under it counts for the chat's project (src/meter.ts), a chat in Default for none, and for the
    // hire it is with.
    const info = await chats.get(t.openId);
    await inScope({ project: info?.project ?? '', staff: staffOfWho(info?.who) }, () => answerTurnBody(res, live.send, t, live));
  } finally {
    live.finish();
  }
}

/** `think`: Think was chosen for this message (the model works it out first, when it can). */
type TurnAsk = { who: string; member: StaffMember | undefined; own: boolean; file: string; openId: string; mode: 'message' | 'continue' | 'handoff'; message: string; from?: string; think?: boolean };

/**
 * An answer being written in a chat, kept going for whoever follows it: the page that asked, and a page that opens the
 * chat after a reload. What it has said is kept short (the newest text, status and progress replace the ones before;
 * each holds all of it so far), so a page that comes in late is shown where the answer is now, then follows it.
 */
export const liveAnswers = new Map<string, LiveAnswer>();
class LiveAnswer {
  private said: { event: string; data: unknown }[] = [];
  private readonly followers = new Set<ServerResponse>();
  private readonly ends: (() => void)[] = [];
  /** Finished: a page that comes to follow it now is given what was said, and its stream ends at once. */
  private done = false;
  readonly chatId: string;
  /** Answer now (POST /api/chat/answer-now): stops the working and asks for the answer. */
  readonly hurry = new AbortController();
  constructor(chatId: string, first: ServerResponse) {
    this.chatId = chatId;
    this.followers.add(first);
    first.on('close', () => this.followers.delete(first));
    liveAnswers.set(chatId, this);
  }
  send = (event: string, data: unknown) => {
    if (['text', 'status', 'progress', 'thinking'].includes(event)) this.said = this.said.filter(e => e.event !== event);
    this.said.push({ event, data });
    for (const r of this.followers) if (!r.destroyed && !r.writableEnded) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  /** A page follows it: what was said so far, then the rest as it comes; its stream ends with the answer. */
  follow(res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...SECURITY_HEADERS });
    for (const e of this.said) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    if (this.done) return void res.end();
    this.followers.add(res);
    res.on('close', () => this.followers.delete(res));
  }
  once(_event: 'close', fn: () => void) {
    this.ends.push(fn);
  }
  finish() {
    this.done = true;
    for (const fn of this.ends.splice(0)) fn();
    for (const r of this.followers) if (!r.writableEnded) r.end();
    if (liveAnswers.get(this.chatId) === this) liveAnswers.delete(this.chatId);
  }
}

async function answerTurnBody(res: ServerResponse, send: (event: string, data: unknown) => unknown, t: TurnAsk, live: LiveAnswer): Promise<void> {
  const { who, member, own, file, openId, mode, message } = t;
  // The chat this answer is in, said first: a new chat's id is known from here, so Stop reaches it while a model loads.
  send('chat', { chat: openId });
  const books = notebooksOf(who);
  // A Default hire: asked with the model's own settings, and the answer is kept as it came.
  const plain = isPlain(member);
  const tidy = (text: string) => (member && !plain ? cleanAnswer(text) : text);
  stopChats(a => a.chatId === openId);
  // The answer stopped here saves what it had written first (up to 10 s), so lines never land out of order, and this
  // turn reads the chat as it is after it.
  for (let i = 0; i < 100 && chatAnswering(openId); i++) await new Promise(r => setTimeout(r, 100));
  const history = await store.chat(file);
  // Emptied or deleted while this answer is written (Clear, Delete): nothing of it is saved into the chat after that.
  const mark = store.chatMark(file);
  const ac = new AbortController();
  startAnswer(ac, openId, who);
  // However it ends (done, fault, Stop), the answer leaves the list when it ends; a closed or reloaded page does not end it.
  live.once('close', () => endAnswer(ac));
  workOn(live, who, openId, mode === 'message' ? 'answer' : mode);
  lastUsed.chat = Date.now();
  const now = new Date().toISOString();
  const mine: ChatLine = { role: 'user', content: message, at: now, ...(t.from ? { from: t.from } : {}) };
  if (mode === 'message') await store.changeChat(file, lines => [...lines, mine], mark);
  // A fault that ends a new message's turn before any answer was written: shown now and kept under the message, so a
  // reload still says why there is no answer (never sent to a model). Continue and the handoff leave the chat as it was.
  const fault = async (text: string) => {
    if (mode === 'message') await store.changeChat(file, lines => [...lines, { role: 'assistant', content: text, at: new Date().toISOString(), failed: true }], mark);
    send('error', { text });
  };
  // Finding the hire's brain may load their model here (Stop still works while it loads).
  let target: Awaited<ReturnType<typeof jobRoutes.hireBrain>> | null = null;
  if (own) {
    try {
      target = await jobRoutes.hireBrain(member!, text => send('status', { text }), ac.signal);
    } catch (error) {
      // Neither of their brains can answer (their PC is off): the page asks for a backup and sends the message again,
      // so the message is taken back out of the chat for now.
      const hire = (error as { backup?: string }).backup;
      if (hire && !ac.signal.aborted && mode === 'message') {
        await store.changeChat(file, lines => lines.filter(l => l !== mine && !(l.role === 'user' && l.at === now && l.content === message)), mark);
        const reasons = (error as { reasons?: string[] }).reasons ?? [];
        send('backup', { hire, name: member!.name, why: reasons.join('; '), off: reasons.some(r => /is off|not answering|log off|using it/.test(r)), ...(await jobRoutes.backupChoices(member!)) });
        return void res.end();
      }
      if (ac.signal.aborted) send('error', { text: 'Stopped.' });
      else await fault((error as Error).message);
      return void res.end();
    } finally {
      if (ac.signal.aborted) endAnswer(ac);
    }
  }
  // A hire's model on this PC answers in its own runner (two or more chat models can be loaded); anyone else on the main one.
  const runner = target?.here ? target.pane ?? main() : main();
  if (!target || target.here) reserve(ac, runner);
  const ran = target ? `${brains.ranOn(target.pc, target.model)}${target.intern ? ' · intern' : ''}` : brains.ranOn('this PC', runner.view.modelName ?? '');
  const info = await chats.get(openId);
  const ctx = target ? target.brain.ctx : runOn(runner).ctx;
  // Documents in this chat (PLAN F10 G6): the parts that match this message (and the one before it), found by code.
  const docs = mode === 'message' ? await docStore.all(openId) : [];
  const asked = `${message} ${[...history].reverse().find(l => l.role === 'user')?.content ?? ''}`;
  const found = docs.length ? findParts(docs, pagesAskedFirst(message, asked), memory.docRoom(memory.chatRoom(ctx, ANSWER_CEILING)) - 600) : [];
  const sources = found.length ? sourcesLine(found) : '';
  // The context is rebuilt for this turn, sized to the model that answers (src/memory.ts), and thrown away after.
  const built = await chatContext(who, member, history, mode === 'message' ? message : mode === 'handoff' ? HANDOFF_ASK : '', ctx, info?.opening, found.length ? docSection(found) : undefined);
  lastContext.set(openId, { ctx: built.ctx, at: Date.now(), model: ran });
  let turns = built.turns;
  // Continue: the cut answer is the last turn, so the model goes on from inside it.
  const before = mode === 'continue' ? history.at(-1)?.content ?? '' : '';
  if (mode === 'continue' && (turns.at(-1)?.role !== 'assistant' || turns.at(-1)?.content !== before)) {
    send('error', { text: 'This answer is too long to carry on with this model\'s context. Ask for the rest in a new message (for example "write the rest, from the last line you wrote").' });
    return void res.end();
  }
  // Think (only for a new message): the model works it out first, when it can; that working counts against the same
  // limit as the answer, so it is given more room. A model that always thinks gets the room whatever was chosen.
  const answering = target ? `${target.model} ${target.ref}` : runner.view.model ?? '';
  const thinks = thinksOf(answering);
  const olderPc = !!target && !target.here && !jobRoutes.canThink(target.ref);
  const thinkNow = !!t.think && mode === 'message' && thinks !== 'never' && !olderPc;
  const thinkNote = t.think && mode === 'message' && !thinkNow
    ? olderPc ? `"${target!.pc}" runs an older TOMLIN that cannot think first, so this was answered straight away.` : `${target?.model || runner.view.modelName || 'This model'} cannot think first, so it answered straight away (Qwen 3 and 3.5 can).`
    : '';
  const answerTokens = mode === 'handoff' ? Math.min(built.answerTokens, 1200) : built.answerTokens + (thinkNow || thinks === 'always' ? THINK_ROOM : 0);
  // The working so far, as it was last sent (Answer now on a linked PC's model asks again with it).
  const working = { text: '', seconds: 0 };
  const sendThought = everyFew(1000, (text: string, seconds: number) => send('thinking', { text, seconds }));
  const askOpts = { plain, think: thinkNow, hurry: live.hurry.signal, onThought: (text: string, seconds: number) => {
    setPhase(ac, 'thinking');
    Object.assign(working, { text, seconds });
    sendThought(text, seconds);
  } };
  let thought: { text: string; seconds: number; stopped?: ThoughtStop } | null = null;
  // The chat it is in: a new chat gets its id with its first message, and Stop and Answer now need it.
  send('brain', { ran, note: target?.note ?? '', chat: openId });
  if (target && !target.here) takeChat(ac, null, openId, who);
  else await takeTurn(ac, runner, openId, who, send);
  if (ac.signal.aborted) {
    endAnswer(ac);
    if (mode === 'message' || mode === 'continue') send('error', { text: 'Stopped before it started: nothing was written.' });
    else send('error', { text: 'Stopped: the chat is as it was.' });
    return void res.end();
  }
  let shown = '';
  let looped = false;
  /** The chat was emptied or deleted while this was written: nothing is saved, and the page is told why. */
  const gone = () => {
    send('error', { text: 'This chat was emptied (or deleted) while the answer was being written, so the answer was not kept.' });
    return void res.end();
  };
  let perSecond = 0;
  let cut = false;
  // A new message to a linked PC that keeps answers: owed from now until it is in this chat, so a lost connection (or
  // this PC stopping) does not lose it; the node finishes it and it is collected (src/server/owed.ts).
  let owe: Owed | null = null;
  let stillOwed = false;
  const show = (text: string) => {
    if (text) setPhase(ac, 'writing');
    send('text', { text: before + text });
  };
  // llama.cpp streams a continued answer's start back first: only what comes after it is new.
  const fresh = (text: string) => (before && text.startsWith(before) ? text.slice(before.length) : text);
  try {
    if (target && !target.here) {
      // On a paired PC: the whole conversation goes over, the answer streams back (that PC cuts a repeating answer and
      // working that goes round in circles). Answer now, pressed while it works: that ask is dropped and the answer
      // asked for again, without thinking, with the working so far.
      const inner = new AbortController();
      const drop = () => inner.abort();
      ac.signal.addEventListener('abort', drop);
      // Only while it is still working: once the answer has begun, Answer now changes nothing.
      live.hurry.signal.addEventListener('abort', () => { if (!shown.trim()) drop(); });
      const at = brains.parseRef(target.ref);
      if (mode === 'message' && at.kind === 'remote' && jobRoutes.canKeep(target.ref)) {
        owe = { rid: newRid(), pc: at.pc, name: target.pc, chatId: openId, ran, at: new Date().toISOString() };
        await addOwed(owe);
      }
      try {
        shown = fresh(await target.brain.chat(turns, answerTokens, text => show((shown = fresh(text))), inner.signal, { ...askOpts, ...(owe ? { rid: owe.rid } : {}) }));
        thought = target.brain.thought ?? null;
        // Stopped at its length limit (a linked PC says so from 2.0.43): Continue is offered, as for a model here.
        cut = target.brain.cut === true;
      } catch (error) {
        if (ac.signal.aborted || !live.hurry.signal.aborted || shown.trim()) throw error;
        const so = { ...working };
        send('status', { text: 'Asking for the answer now, with the working so far…' });
        if (owe) {
          await dropOwed(owe.rid);
          owe = { ...owe, rid: newRid() };
          await addOwed(owe);
        }
        shown = fresh(await target.brain.chat(withWorking(turns, so.text), Math.max(512, answerTokens - THINK_ROOM), text => show((shown = fresh(text))), ac.signal, { plain, ...(owe ? { rid: owe.rid } : {}) }));
        cut = target.brain.cut === true;
        thought = so.text ? { text: so.text, seconds: so.seconds, stopped: 'hurry' } : null;
      } finally {
        ac.signal.removeEventListener('abort', drop);
      }
      perSecond = target.brain.last?.write ?? 0;
    } else {
      if (runner.view.state !== 'connected' || !runner.worker.base) throw new Error('the chat model was disconnected');
      const ask = () => streamChat(runner.worker.base!, runner.view.model ?? '', turns, text => {
        const loop = repeatCut(text);
        shown = fresh(loop ?? text);
        show(shown);
        if (loop !== null) {
          looped = true;
          ac.abort();
        }
      }, ac.signal, answerTokens, askOpts);
      let r;
      try {
        r = await ask();
      } catch (error) {
        if (!(error instanceof NoPrefill)) throw error;
        turns = [...turns, { role: 'user', content: CONTINUE_ASK }];
        r = await ask();
      }
      perSecond = r.perSecond;
      cut = r.cut && !looped;
      if (r.thought) thought = { text: r.thought, seconds: r.thoughtSeconds, ...(r.thoughtStopped ? { stopped: r.thoughtStopped } : {}) };
    }
  } catch (error) {
    // The connection to the linked PC was lost and did not come back in two minutes: it is still writing the answer.
    // What came so far stays in the chat with Reconnect under it; the rest is collected (at Reconnect, every start,
    // and once a minute) and put in its place.
    if (!ac.signal.aborted && owe && jobRoutes.lostOf(error)) {
      endAnswer(ac);
      const line = { ...owedLine(owe, shown), at: new Date().toISOString() };
      stillOwed = !!(await store.changeChat(file, lines => [...lines, line], mark));
      if (!stillOwed) return gone();
      notLive(owe.rid);
      log.error('chat', `message on ${ran}: lost the connection part-way; the answer is owed (${owe.rid}).`);
      send('done', { text: shown, perSecond: 0, ran, waiting: line.waiting, saved: true, note: '' });
      return void res.end();
    }
    if (!ac.signal.aborted) {
      const why = target && !target.here ? awayFault(target.pc, error) : `The model stopped part-way: ${(error as Error).message}. Try again; if it keeps happening, disconnect and connect again.`;
      log.error('chat', `${mode} on ${ran}: ${why}`);
      endAnswer(ac);
      // What was already written stays in the chat, with the fault under it (a handoff is not kept: the chat is unchanged).
      if (shown.trim() && mode === 'message') await keepCutAnswer(file, shown, ran, send, why, mark);
      else if (shown.trim() && mode === 'continue') await keepContinued(file, before, shown, ran, send, why, false, 0, null, mark);
      else await fault(why);
      return void res.end();
    }
  } finally {
    endAnswer(ac);
    runnerUsed.set(runner, Date.now());
    // Came in whole, stopped, or failed there: nothing is owed any more.
    if (owe && !stillOwed) await dropOwed(owe.rid);
  }
  const note = [looped ? 'The answer began repeating itself, so it was stopped there.' : ac.signal.aborted ? 'Stopped.' : target?.note ?? '', thinkNote, thought?.stopped && shown.trim() ? STOPPED_WORKING[thought.stopped] : ''].filter(Boolean).join(' ');
  if (mode === 'continue') {
    if (mark !== store.chatMark(file)) return gone();
    const marked = await chats.mark(openId, { fill: built.fill + Math.round((shown.length / built.room) * 100) });
    await keepContinued(file, before, shown, ran, send, note, cut, perSecond, largeOf(marked), mark);
    return void res.end();
  }
  if (mode === 'handoff') {
    const text = tidy(shown).trim();
    if (!text || ac.signal.aborted) {
      send('error', { text: ac.signal.aborted ? 'Stopped: the chat is as it was.' : 'No handoff came back. Try again, or press Ignore and carry on here.' });
      return void res.end();
    }
    const next = await chats.carryOn(info!, text);
    await docStore.copy(openId, next.id);
    await chats.mark(openId, { askedLarge: 100 });
    await store.saveSettings({ chatId: next.id });
    send('done', { text, perSecond, ran, handoff: next.id, note });
    return void res.end();
  }
  shown = tidy(shown);
  // All of the allowance went on working it out, or the working went round in circles (a model that always thinks):
  // nothing to keep but the message, and a way out. Stopped before the answer began: said so, nothing kept.
  if (!shown.trim() && thought && !ac.signal.aborted) {
    await fault(thought.stopped === 'loop' ? `Its working went round in circles (${thought.seconds} s) and no answer was written. Ask again more simply, or one part at a time.` : `It spent its whole allowance working it out (${thought.seconds} s) and wrote no answer. Send it again with Quick, or ask for one part at a time.`);
    return void res.end();
  }
  if (!shown.trim() && ac.signal.aborted && !looped) {
    send('error', { text: 'Stopped before the answer began: your message is kept, no answer was written.' });
    return void res.end();
  }
  // A "REMEMBER: ..." line is only a suggestion: it comes off the answer and he decides (Save / No).
  const sug = memory.takeSuggestion(shown);
  shown = sug.answer;
  const line: ChatLine = { role: 'assistant', content: shown, at: new Date().toISOString(), perSecond, ran, ...(cut ? { cut } : {}), ...(sources ? { sources } : {}), ...(thought ? { thought } : {}) };
  // A stand-in for this answer (owed, src/server/owed.ts) never stays beside the answer itself.
  const rid = owe?.rid;
  if (shown.trim() && !(await store.changeChat(file, lines => [...lines.filter(l => !rid || l.waiting?.rid !== rid), line], mark))) return gone();
  // How full the chat is now (with this answer): the page offers a handoff from 75%.
  const marked = await chats.mark(openId, { fill: built.fill + Math.round((shown.length / built.room) * 100) });
  send('done', { text: shown, perSecond, ran, cut, sources, thought, large: largeOf(marked), suggest: sug.suggest, scope: books.own ?? 'team', book: books.own ? `${books.name}'s memory` : 'the team memory', note });
  res.end();
}

/** A page named in this message counts; one named only in the message before does not pull that page in again. */
function pagesAskedFirst(message: string, both: string): string {
  return /\b(?:pages?|pp?\.?)\s*\d/i.test(message) ? message : both.replace(/\b(?:pages?|pp?\.?)\s*\d{1,4}/gi, '');
}

// ---- Documents in a chat (PLAN F10 G6, src/docs.ts) ----
export const docStore = new Docs(HOME.data);

/** A dropped file's bytes, up to `max` (the request is refused past it). */
async function rawBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error(`The file is over ${max / 1048576} MB, more than a chat reads.`);
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function addDoc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The chat it goes into, named in the headers (the body is the file): x-chat, or x-chat '' and x-who for a new chat.
  const header = (k: string) => {
    const v = req.headers[k];
    if (typeof v !== 'string') return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return '';
    }
  };
  const target = await namedTarget({ chatId: header('x-chat'), who: header('x-who'), plain: header('x-plain') }, true);
  if ('error' in target) return json(res, target.status, { error: target.error });
  const { who } = target;
  if (nodestaff.parseNodeWho(who)) return json(res, 400, { error: 'Documents go into a chat with TOMLIN or a hire on this PC. Open one of those chats, then add the file.' });
  let name = 'document';
  try {
    name = cleanDocName(decodeURIComponent(String(req.headers['x-name'] ?? '')));
  } catch {
    // An odd name is kept as "document".
  }
  let bytes: Uint8Array;
  try {
    bytes = await rawBody(req, MAX_DOC_BYTES);
  } catch (e) {
    return json(res, 413, { error: `${name} was not added: ${(e as Error).message}` });
  }
  const was = target.chat;
  if (was && !chatPersonHere(was.who)) return json(res, 400, { error: 'The person in this chat is no longer on the team. Press "New chat" first.' });
  const open = await chatToSend(target);
  if ((await docStore.list(open.id)).length >= MAX_DOCS) return json(res, 400, { error: `This chat already has ${MAX_DOCS} documents. Remove one (the x beside its name), then add ${name}.` });
  let doc;
  try {
    doc = await readDoc(name, bytes);
  } catch (e) {
    return json(res, 400, { error: `${name} could not be added: ${(e as Error).message}.` });
  }
  if (!doc.parts.length) return json(res, 400, { error: `${name} has no text to read${doc.kind === 'pdf' ? ': it looks like scanned pages (pictures of text). Use a PDF with real text, or one saved with text recognition (OCR)' : ''}.` });
  await docStore.add(open.id, doc);
  const empty = doc.kind === 'pdf' ? doc.pages - new Set(doc.parts.map(p => p.page)).size : 0;
  return json(res, 200, { chat: open.id, docs: await docStore.list(open.id), said: `${name} is in this chat: ${doc.kind === 'pdf' ? `${doc.pages} page${doc.pages === 1 ? '' : 's'}` : `${doc.pages.toLocaleString('en-GB')} lines`}, ${doc.chars.toLocaleString('en-GB')} characters.${empty ? ` ${empty} page${empty === 1 ? ' has' : 's have'} no text (pictures only) and cannot be read.` : ''} Ask about it; each answer is given the parts that match your words, and says which pages.` });
}

/** The "getting large" bar's facts for a chat, when it should show: fill past 75% (or 90% after one Ignore). */
function largeOf(c: ChatInfo | null): { fill: number } | null {
  if (!c?.fill) return null;
  const asked = c.askedLarge ?? 0;
  return (c.fill >= 75 && asked < 75) || (c.fill >= 90 && asked < 90) ? { fill: c.fill } : null;
}

/** The end of a continued answer joined onto the line it carries on, with Continue offered again if it was cut again. */
async function keepContinued(file: string, before: string, more: string, ran: string, send: (event: string, data: unknown) => unknown, note: string, cut: boolean, perSecond = 0, large: { fill: number } | null = null, mark?: number): Promise<void> {
  const text = before + more;
  await store.changeChat(file, lines => {
    const last = lines.at(-1);
    if (!(last?.role === 'assistant' && last.content === before)) return undefined;
    const line: ChatLine = { ...last, content: text, at: new Date().toISOString(), ran, ...(perSecond ? { perSecond } : {}) };
    if (cut) line.cut = true;
    else delete line.cut;
    return [...lines.slice(0, -1), line];
  }, mark);
  send('done', { text, perSecond, ran, cut, continued: true, large, note });
}

/** Continue a cut answer, or write the handoff when a chat grew large (a chat with the manager or a hire only). */
async function chatMore(res: ServerResponse, mode: 'continue' | 'handoff', at: SendTarget): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...SECURITY_HEADERS });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const { who, chat: open } = at;
  const member = staffId(who) ? staff.get(who.slice(6)) : undefined;
  const fault = (text: string) => {
    send('error', { text });
    res.end();
  };
  if (!open || nodestaff.parseNodeWho(who)) return fault('This chat cannot do that: open a chat with TOMLIN or a hire.');
  if (!chatPersonHere(open.who)) return fault('The person in this chat is no longer on the team, so it can be read but not carried on.');
  const own = !!member && brains.refsOf(member).length > 0;
  if (!own && (chat.view.state !== 'connected' || !chat.worker.base)) return fault('No chat model is loaded: press Connect beside the model at the top of this chat, then send again.');
  const file = chats.file(open.id);
  const history = await store.chat(file);
  if (mode === 'continue' && !(history.at(-1)?.role === 'assistant' && history.at(-1)?.cut)) return fault('There is nothing to continue: the last answer was finished. Type a message instead.');
  return answerTurn(res, send, { who, member, own, file, openId: open.id, mode, message: '' });
}

/**
 * A chat with a hire who lives on a paired PC. The conversation is kept here; the recent part goes over each turn, that
 * PC adds who the hire is and answers on the hire's model. With a picture hire every message is a picture to draw there.
 */
/** An answer cut off part-way: the words written so far are saved and shown, with why it stopped under them. */
async function keepCutAnswer(file: string, text: string, ran: unknown, send: (event: string, data: unknown) => unknown, note: string, mark?: number): Promise<void> {
  const content = `${text.trimEnd()} …`;
  await store.changeChat(file, lines => [...lines, { role: 'assistant', content, at: new Date().toISOString(), ...(ran ? { ran } : {}) } as ChatLine], mark);
  send('done', { text: content, perSecond: 0, ...(ran ? { ran } : {}), note });
}

/** A paired PC's fault in plain words: which PC, what went wrong, and what to do. Messages that already say so pass through. */
function awayFault(pc: string, error: unknown): string {
  const said = (error as Error).message;
  // The connection cut part-way (that PC restarted its link, went to sleep, or lost the network): Node's own words for it
  // ("terminated", "fetch failed", "other side closed") mean nothing to a person reading them.
  if (/^(terminated|fetch failed|other side closed|socket hang up)\b|ECONNRESET|UND_ERR_SOCKET/i.test(said)) return `${pc} cut the link part-way (it restarted its link, went to sleep or lost the network). Press Send again once it is back.`;
  if (!/^The worker (said|went quiet|stopped)/.test(said)) return said;
  const why = said.replace(/^The worker said: /, '').replace(/^The worker /, 'it ').replace(/\.$/, '');
  return `${pc} stopped answering part-way (${why}). Check that PC is on and TOMLIN is still open there, then press Send again.`;
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const chatGet: Routes = {
  '/api/chat': async ({ res, url }) => {
    // ?id=<chat>: that chat as it is now (a window reading back the chat it sent to); none: the chat open now.
    const id = url.searchParams.get('id');
    const open = id === null ? await openChat() : await chats.get(id);
    return json(res, 200, { lines: open ? await chats.lines(open.id) : [], chat: open ? { ...open, here: chatPersonHere(open.who), large: largeOf(open), docs: await docStore.list(open.id), live: liveAnswers.has(open.id), saveTo: await saveToOf(open) } : null });
  },
};

/** The chat a chat action names ({chatId}), found; with the reason (and its status) when it cannot be used. */
async function namedTarget(b: Record<string, unknown>, newAllowed = false): Promise<SendTarget | { error: string; status: number }> {
  const named = namedChat(b, newAllowed);
  return 'error' in named ? { error: named.error, status: 400 } : sendTarget(named, b.plain);
}

const moreOrHandoff: Route = async ({ res, p, b }) => {
  const at = await namedTarget(b);
  if ('error' in at) return json(res, at.status, { error: at.error });
  if (chatAnswering(at.chat!.id)) return json(res, 409, { error: 'This chat is still being answered. Wait for it, or press Stop, then try again.' });
  return chatMore(res, p === '/api/chat/continue' ? 'continue' : 'handoff', at);
};

/** POST requests answered here, by path (the body is read already). */
export const chatPost: Routes = {
  '/api/prompt/write': async ({ res, b }) => {
    // "Write it as a prompt for…" in the Send to card: the words, turned by the chat model into what that person's
    // role works from (the instruction is chosen by code from the role: src/sendto.ts). Nothing is sent from here.
    const text = String(b.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'There are no words to turn into a prompt. Type some in the box first.' });
    const person = chatPeople().find(x => x.who === b.who);
    if (!person) return json(res, 404, { error: 'Pick who it is for first: they may have left the team.' });
    if (chat.view.state !== 'connected' || !chat.worker.base) return json(res, 409, { error: 'Writing a prompt needs a chat model loaded, and none is. Connect one in the host\'s chat, or change the words yourself and press Send.' });
    if (answeringBusy(main())) return json(res, 409, { error: 'The chat model is answering something. Wait for it to finish (or press Stop), then try again.' });
    const f = promptFor(person.roleId);
    try {
      const prompt = cleanWritten(await askOnce(f.system, text.slice(0, 6000), f.tokens), f.oneLine);
      if (!prompt) return json(res, 500, { error: 'The chat model wrote nothing usable. Try again, or change the words yourself.' });
      return json(res, 200, { prompt, label: f.label });
    } catch (error) {
      return json(res, 502, { error: `The chat model stopped part-way: ${(error as Error).message}. Try again, or change the words yourself.` });
    }
  },
  '/api/chats/sent': async ({ res, b }) => {
    // The answer something was sent from gets "Sent to …" under it (the message that arrived carries "Sent from …").
    const c = await chats.get(b.chat);
    if (!c) return json(res, 404, { error: 'That chat is not there any more.' });
    const file = chats.file(c.id);
    let marked = false;
    await store.changeChat(file, lines => {
      const r = markSent(lines, String(b.text ?? ''), String(b.to ?? ''));
      marked = r.marked;
      return r.marked ? r.lines : undefined;
    });
    return json(res, 200, { marked });
  },
  '/api/chat': async ({ res, b }) => {
    const message = String(b.message ?? '').trim();
    if (!message) return json(res, 400, { error: 'Type a message first.' });
    if (message.length > 20_000) return json(res, 400, { error: 'That message is too long (over 20,000 characters). Shorten it or split it.' });
    // {chatId}: the chat it goes into; {chatId: '', who}: a new chat with that person, made by this message.
    const at = await namedTarget(b, true);
    if ('error' in at) return json(res, at.status, { error: at.error });
    return chatMessage(res, message, at, cleanFrom(b.from), b.agree === true, b.think === true, b.now === true);
  },
  '/api/chat/continue': moreOrHandoff,
  '/api/chat/handoff': moreOrHandoff,
  '/api/chat/doc/remove': async ({ res, b }) => {
    // {chatId, id}: that document out of that chat.
    const at = await namedTarget(b);
    if ('error' in at) return json(res, at.status, { error: at.error });
    const open = at.chat!;
    if (!(await docStore.remove(open.id, String(b.id ?? '')))) return json(res, 404, { error: 'That document is not in this chat any more.' });
    return json(res, 200, { docs: await docStore.list(open.id) });
  },
  '/api/chat/large': async ({ res, b }) => {
    // {chatId}: Ignore on that chat's "getting large" bar: asked again at 90%, then not again.
    const at = await namedTarget(b);
    if ('error' in at) return json(res, at.status, { error: at.error });
    const open = at.chat!;
    await chats.mark(open.id, { askedLarge: (open.fill ?? 0) >= 90 ? 90 : 75 });
    return json(res, 200, { ok: true });
  },
  '/api/chat/answer-now': async ({ res, b }) => {
    // {chatId}: Answer now, pressed while that chat's answer is still being worked out.
    const live = liveAnswers.get(String(b.chatId ?? ''));
    if (!live) return json(res, 404, { error: 'That answer has finished already.' });
    live.hurry.abort();
    return json(res, 200, { ok: true });
  },
  '/api/chat/think': async ({ res, b }) => {
    // {chatId, on}: Quick or Think chosen in a chat's box, kept on that chat (a chat not made yet keeps it at its first message).
    const c = await chats.get(b.chatId);
    if (c) await chats.mark(c.id, { think: b.on === true });
    return json(res, 200, { ok: true });
  },
  '/api/chat/follow': async ({ res, b }) => {
    // {chatId}: follow the answer being written there (a page opened or reloaded while it was coming).
    const live = typeof b.chatId === 'string' ? liveAnswers.get(b.chatId) : undefined;
    if (!live) return json(res, 404, { error: 'That answer has finished: it is in the chat now.' });
    live.follow(res);
    return;
  },
  '/api/chat/stop': async ({ res, b }) => {
    // {chatId}: that chat's answer only ('' = the blog writer and other work that is not a chat). One that names nothing
    // stops nothing: it used to stop every answer, someone else's in another window too.
    if (typeof b.chatId !== 'string') return json(res, 400, { error: 'Stop names no chat, so nothing was stopped (the page may be from an older TOMLIN). Reload the page, then press Stop again.' });
    stopChats(a => a.chatId === b.chatId);
    return json(res, 200, { ok: true });
  },
  '/api/chat/clear': async ({ res, b }) => {
    // {chatId}: that chat emptied ('' = a chat with no messages yet: nothing to empty).
    if (b.chatId === '') return json(res, 200, { ok: true });
    const at = await namedTarget(b);
    if ('error' in at) return json(res, at.status, { error: at.error });
    const open = at.chat;
    if (open) stopChats(a => a.chatId === open.id);
    if (open) {
      // An answer still running here saves nothing after this (its turn checks the mark).
      store.chatEmptied(chats.file(open.id));
      await store.saveChat([], chats.file(open.id));
      await chats.mark(open.id, { fill: 0, askedLarge: 0 });
    }
    return json(res, 200, { ok: true });
  },
};
