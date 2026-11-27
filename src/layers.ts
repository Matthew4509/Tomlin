// Chat memory in layers, for a chat with a context of 16K or more: the card and rules on top, then the notebooks, the
// handoff it started from and this chat's own log (decisions, to-dos, what was learned, names and numbers), then the
// documents, then the latest messages word for word. Everything above the latest messages changes only at a fold: the
// moment the latest messages pass their size and the oldest third of them leaves. Between folds the start of the
// prompt is the same to the byte, so llama.cpp reads only the new message (a Qwen 3.5 hybrid reads it all again when
// the start changes: measured). How many messages stay word for word comes from this PC's read speed and the
// wait he accepts at a fold (Model settings), so a fold never reads more than that wait's worth.
// The log is his: a line goes in from "Add to log" under a message, and each can be changed or deleted in Memory. A
// model never writes one. Each chat keeps its log and a record of what was last sent in chats/<id>-log.json.
// The plain functions are tested in test/layers.test.ts.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatTurn } from './engine.ts';
import { bookNote, bookText, CHARS_PER_TOKEN, chatRoom, cleanNote, docRoom, fitLines, keywords, NOTEBOOK_MAX_LINES, pickLines, userFrom, type ChatContext, type ChatInput, type NoteLine, type Part } from './memory.ts';
import type { ChatLine, Store } from './store.ts';

/** The smallest context that gets layers: under it a chat is too small for them and works as before. */
export const LAYER_MIN_CTX = 16384;
/** Minutes a fold may spend reading (Model settings, per model): 1 to 15, 4 unless he changes it. */
export const FOLD_WAIT_DEFAULT = 4;
export const FOLD_WAIT_MAX = 15;
/** The log sent at most: about 2,000 tokens. */
export const LOG_MAX_TOKENS = 2000;
export const LOG_CHARS = LOG_MAX_TOKENS * CHARS_PER_TOKEN;
/** The latest messages kept word for word are never fewer than this many tokens (when the context has room). */
export const SHORT_MIN_TOKENS = 2000;
/** A message brought back with Find: at most this many characters of it. */
const RECALL_MAX = 4000;

export type LogKind = 'decision' | 'todo' | 'learned' | 'fact';
export const LOG_KINDS: Record<LogKind, string> = { decision: 'Decision', todo: 'To do', learned: 'Learned', fact: 'Name or number' };

export interface LogLine {
  id: string;
  kind: LogKind;
  text: string;
  at: string;
  /** A to-do ticked Done: when. */
  done?: string;
}

/** What the last fold put above the latest messages, sent the same every turn until the next fold. */
export interface Sent {
  /** The first message sent word for word (its time), or '' when that is past the last message (then `n` says where). */
  from: string;
  n: number;
  /** The notebooks, the opening handoff and the log, as sent. */
  upper: string;
  /** The log as it was at the fold (a change since waits for the next one). */
  logText: string;
  /** The fold summaries as they were at the fold (absent: none were sent). */
  sumText?: string;
  ctx: number;
  at: string;
  parts: Part[];
  /** "Send them now": the next turn takes the log and notebooks as they are, and keeps the same messages if they fit. */
  stale?: true;
}

export interface ChatLogFile {
  lines: LogLine[];
  sent: Sent | null;
  /** What the model summed up at each fold (oldest first), when the chat's "Sum up what a fold lets go" is on. */
  sums: SumBlock[];
}

// ---- Fold summaries: the model sums up what a fold lets go (off unless the chat's tick is on) ----

/**
 * One fold's summary: the messages that stopped being sent word for word, summed up by the model just before they
 * left. Kept apart from his log (a model never writes that), labelled as the model's, and his to change or delete.
 */
export interface SumBlock {
  id: string;
  /** When it was written. */
  at: string;
  /** The first and last message it sums up (their times), and how many. */
  from: string;
  to: string;
  n: number;
  text: string;
  /** The model that wrote it (as the chat's "ran on" line says it). */
  by: string;
}

/** The summaries sent at most: about 2,000 tokens, like the log. The oldest leave first (Memory still shows them). */
export const SUM_MAX_TOKENS = 2000;
export const SUM_CHARS = SUM_MAX_TOKENS * CHARS_PER_TOKEN;
/** One summary at most (characters) and the most the model may write for it (tokens). */
export const SUM_BLOCK_CHARS = 1500;
export const SUM_ANSWER_TOKENS = 700;
/** Most of the leaving messages the model reads for one summary: a share of the chat's room (characters). */
export const sumInputRoom = (room: number) => Math.max(3000, Math.floor(room * 0.6));
const SUM_TITLE = 'Earlier in this chat (summed up by the model at each fold, oldest first; the person may have changed these):';

export const SUM_ASK = 'These are older messages from a chat that are about to stop being sent word for word. Sum them up for the rest of the chat: what was asked, what was decided, what was done, and the names, numbers, file names and settings that matter. Short plain lines starting with "- ", at most about 12 lines. Only what these messages say: invent nothing, and say plainly when something was left unsure. Write the lines only, with no heading.';

/** The summaries as sent: newest kept, the oldest left out when they come to more than SUM_CHARS. */
export function sumsText(sums: SumBlock[]): { text: string; ids: string[]; dropped: number } {
  const kept: SumBlock[] = [];
  let n = SUM_TITLE.length;
  for (let i = sums.length - 1; i >= 0; i--) {
    const add = blockText(sums[i]).length + 1;
    if (n + add > SUM_CHARS) break;
    kept.unshift(sums[i]);
    n += add;
  }
  return { text: kept.length ? `${SUM_TITLE}\n${kept.map(blockText).join('\n')}` : '', ids: kept.map(s => s.id), dropped: sums.length - kept.length };
}
const blockText = (s: SumBlock) => `(${s.n} message${s.n === 1 ? '' : 's'}, ${s.from.slice(0, 10)}${s.to.slice(0, 10) !== s.from.slice(0, 10) ? ` to ${s.to.slice(0, 10)}` : ''})\n${s.text}`;

/**
 * The messages this fold lets go: from where the last fold started sending (the start when there was none) to where
 * this one starts. Empty when nothing leaves (the first turn, "Send them now" that keeps the same start, a start that moved back).
 * `summedTo`: when the newest summary ends (its `to`); nothing up to then is summed again, even when the last start's
 * message was deleted or the start moved back and forward (a different context on another PC).
 */
export function leaving(history: ChatLine[], was: Sent | null, now: number, summedTo?: string): ChatLine[] {
  const lines = sentLines(history);
  let from = was ? Math.max(0, startIn(lines, was)) : 0;
  if (summedTo) from = Math.max(from, lines.filter(l => l.at <= summedTo).length);
  return now > from ? lines.slice(from, now) : [];
}

/**
 * What the model is asked for one summary: the leaving messages as a transcript (the newest that fit `max`
 * characters), and the ask. `n`, `from`, `to`: the messages it covers; `skipped`: older ones left out for size.
 */
export function sumAsk(lines: ChatLine[], name: string, max: number): { turns: ChatTurn[]; n: number; from: string; to: string; skipped: number } | null {
  const rows = lines.map(l => ({ l, text: `${l.role === 'user' ? 'They' : name}: ${l.content.trim()}` }));
  const kept: typeof rows = [];
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (n + rows[i].text.length + 2 > max) break;
    kept.unshift(rows[i]);
    n += rows[i].text.length + 2;
  }
  // One message bigger than the room on its own: its start, so a long paste still gets summed up.
  if (!kept.length && rows.length) kept.push({ ...rows[rows.length - 1], text: `${rows[rows.length - 1].text.slice(0, Math.max(0, max - 20))}…` });
  if (!kept.length) return null;
  return {
    turns: [{ role: 'system', content: SUM_ASK }, { role: 'user', content: `${kept.map(r => r.text).join('\n\n')}\n\n(End of the messages. Sum them up now.)` }],
    n: kept.length,
    from: kept[0].l.at,
    to: kept[kept.length - 1].l.at,
    skipped: rows.length - kept.length,
  };
}

/** The model's summary made fit to keep: thinking and headings dropped, lines tidied, cut to SUM_BLOCK_CHARS. '' when nothing is left. */
export function cleanSum(text: string): string {
  const lines = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !/^#+\s/.test(l) && !/^(summary|here is|here's)\b.*:$/i.test(l))
    .map(l => (/^[-*•]\s*/.test(l) ? `- ${l.replace(/^[-*•]\s*/, '')}` : /^\d+[.)]\s+/.test(l) ? `- ${l.replace(/^\d+[.)]\s+/, '')}` : `- ${l}`));
  return fitSum(lines);
}

/** Whole lines up to SUM_BLOCK_CHARS; a first line longer than that on its own is cut, not lost. */
function fitSum(lines: string[]): string {
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > SUM_BLOCK_CHARS) {
      if (!out) out = `${l.slice(0, SUM_BLOCK_CHARS - 1)}…`;
      break;
    }
    out += `${out ? '\n' : ''}${l}`;
  }
  return out;
}

/** A summary as the user edited it: their own words kept (only blank lines and spaces at the ends taken out), cut to SUM_BLOCK_CHARS. */
export function cleanEditedSum(text: string): string {
  return fitSum(text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean));
}

/**
 * A read this big or bigger gives a true read speed. A small one (just the new message, about 300 tokens) carries
 * llama.cpp's start-up time, and measured as low as 2.9 tokens a second where the PC reads 7.5: the window then sat at
 * its minimum and folded every turn.
 */
export const BIG_READ_TOKENS = 1000;
export const isBigRead = (tokens: number | undefined): boolean => (tokens ?? 0) >= BIG_READ_TOKENS;

export interface ReadFigure {
  perSecond: number;
  tokens: number;
  at: string;
}

/** The big-read figure after a read: replaced by any big read (another driver or runner changes it), never by a small one. */
export function keepBig(was: ReadFigure | undefined, tokens: number, perSecond: number, at: string): ReadFigure | undefined {
  return isBigRead(tokens) && perSecond > 0 ? { perSecond: Math.round(perSecond * 10) / 10, tokens, at } : was;
}

/** The read speed the layers size from: the big-read figure, else the speed finder's measured read, else none (0). */
export function layerReadSpeed(reading: { big?: ReadFigure } | null | undefined, found: number | null | undefined): number {
  return reading?.big?.perSecond || (found && found > 0 ? found : 0);
}

export const cleanFoldWait =(v: unknown): number => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= FOLD_WAIT_MAX ? (v as number) : FOLD_WAIT_DEFAULT);

/** Layers for this chat: a context of 16K or more, not a Default hire (no memory is read), and its tick not off. */
export const layeredFor = (ctx: number, plain: boolean, off: boolean | undefined): boolean => !plain && !off && ctx >= LAYER_MIN_CTX;

/**
 * The latest messages kept word for word, in tokens: what this PC reads in the fold wait, less what sits above them
 * (it is read again at a fold too). At least 2,000, at most what the context has room for. No speed measured yet: 2,000.
 */
export function shortTokens(readPerSecond: number, foldMinutes: number, aboveTokens: number, roomTokens: number): number {
  const want = readPerSecond > 0 ? Math.floor(readPerSecond * foldMinutes * 60 - aboveTokens) : 0;
  return Math.max(0, Math.min(roomTokens, Math.max(SHORT_MIN_TOKENS, want)));
}

const GROUPS: Array<[string, (l: LogLine) => boolean]> = [
  ['Decisions', l => l.kind === 'decision'],
  ['To do', l => l.kind === 'todo' && !l.done],
  ['Done', l => l.kind === 'todo' && !!l.done],
  ['Learned', l => l.kind === 'learned'],
  ['Names and numbers', l => l.kind === 'fact'],
];
const LOG_TITLE = 'Chat log (the older part of this chat, kept by the person: what was decided, what is open or done, what was learned, names and numbers):';
/** Done to-dos and learned lines leave first when the log is over its size; the rest is never dropped silently. */
const droppable = (l: LogLine) => l.kind === 'learned' || (l.kind === 'todo' && !!l.done);

function render(lines: LogLine[]): string {
  const groups = GROUPS.flatMap(([title, is]) => {
    const sel = lines.filter(is);
    return sel.length ? [`${title}:\n${sel.map(l => `- ${l.text}`).join('\n')}`] : [];
  });
  return groups.length ? `${LOG_TITLE}\n${groups.join('\n')}` : '';
}

/** The log as sent: grouped by kind; over its size, the oldest done to-dos go first, then the oldest learned lines. */
export function logText(lines: LogLine[]): { text: string; ids: string[]; dropped: number } {
  let kept = [...lines];
  let dropped = 0;
  while (render(kept).length > LOG_CHARS) {
    const next = kept.find(l => l.kind === 'todo' && !!l.done) ?? kept.find(l => l.kind === 'learned');
    if (!next) break;
    kept = kept.filter(l => l !== next);
    dropped++;
  }
  return { text: render(kept), ids: kept.map(l => l.id), dropped };
}

/** Why a line of this kind cannot go in ('' when it can): the lines never dropped would come to more than the log holds. */
export function logFull(lines: LogLine[], kind: LogKind, text: string, done = false): string {
  const line: LogLine = { id: '', kind, text: cleanNote(text), at: '', ...(done ? { done: 'x' } : {}) };
  if (droppable(line)) return '';
  return render([...lines.filter(l => !droppable(l)), line]).length > LOG_CHARS
    ? `The chat log is full: its decisions, open to-dos and names and numbers come to about ${LOG_MAX_TOKENS.toLocaleString('en-GB')} tokens, all a fold carries. Tick finished to-dos Done, or delete lines you no longer need, then add this one.`
    : '';
}

export interface LayerInput extends ChatInput {
  log: LogLine[];
  /** What the last fold sent (null: none yet). */
  sent: Sent | null;
  /** This model's prompt read speed here, tokens a second (0: not measured yet). */
  readPerSecond: number;
  foldMinutes: number;
  now?: string;
  /** The fold summaries, when the chat's "Sum up what a fold lets go" is on (absent: off, none are sent). */
  sums?: SumBlock[];
}

export interface Layered extends ChatContext {
  layered: true;
  /** What sits above the latest messages this turn: the same object as given when there was no fold. */
  sent: Sent;
  /** This turn changed what sits above the latest messages (or is the first): save `sent`. */
  folded: boolean;
  /** The log changed since the last fold: the change goes in at the next one. */
  logWaiting: boolean;
  /** How many older messages are not sent word for word. */
  older: number;
  shortTokens: number;
  /** About how many tokens a fold reads (all below the card and rules), and how long that takes here (0: speed not known). */
  foldTokens: number;
  foldSeconds: number;
}

/** The messages a chat sends (none refused, failed or empty), as the builder counts them. */
export const sentLines = (lines: ChatLine[]) => lines.filter(l => !l.refused && !l.failed && l.content.trim());
/** Where the word-for-word messages began at the last fold, in `sentLines`; -1 when that message is gone. */
export const startIn = (history: ChatLine[], s: Sent) => (s.from ? history.findIndex(l => l.at === s.from) : s.n <= history.length ? s.n : -1);

const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const part = (key: string, label: string, text: string, state: Part['state'], note?: string): Part => ({ key, label, chars: text.length, tokens: tok(text.length), state, ...(note ? { note } : {}) });
const n = (x: number) => x.toLocaleString('en-GB');

/** The context for a turn of a layered chat (src/memory.ts buildChat is the one for other chats; same sizes and room). */
export function buildLayered(x: LayerInput): Layered {
  const ctx = Math.max(2048, x.ctx || 8192);
  const answerTokens = Math.min(x.maxAnswer, Math.floor(ctx / 4));
  const room = Math.floor(chatRoom(ctx, x.maxAnswer) * Math.min(1, Math.max(0.2, x.squeeze ?? 1)));
  // The rules sit with the card: neither changes in a chat, so both stay in the unchanged start.
  const head = [x.card, x.rules].filter(Boolean).join('\n\n');
  const history = sentLines(x.history);
  const sizes = history.map(l => l.content.length + 8);
  const from = (i: number) => sizes.slice(i).reduce((t, s) => t + s, 0) + x.message.length;
  const topic = `${x.message} ${[...x.history].reverse().find(l => l.role === 'user')?.content ?? ''}`;
  const log = logText(x.log);
  const sums = x.sums ? sumsText(x.sums) : null;

  /** The notebooks, the opening handoff and the log as they are now (what a fold puts in). */
  const fresh = (): { text: string; parts: Part[] } => {
    let free = room - head.length - x.message.length;
    const out: string[] = [];
    const parts: Part[] = [];
    const book = (key: string, label: string, title: string, lines: NoteLine[] | null) => {
      if (!lines) return;
      if (!lines.length) return void parts.push(part(key, label, '', 'none', 'empty'));
      const got = pickLines(lines, topic, Math.max(0, Math.min(free, Math.floor(room / 5))));
      if (!got.lines.length) return void parts.push(part(key, label, '', 'left out', `${lines.length} entr${lines.length > 1 ? 'ies' : 'y'}, no room`));
      const text = bookText(title, got.lines);
      out.push(text);
      free -= text.length + 2;
      parts.push(part(key, label, text, got.left || got.cut ? 'cut' : 'whole', bookNote(got, lines.length, 'the ones on the topic at the last fold')));
    };
    book('team', 'Team memory', 'Team notebook (facts the whole team keeps; the person wrote these):', x.team);
    book('own', `${x.name}'s memory`, 'Your notebook (what the person asked you to remember):', x.own);
    if (x.opening?.trim()) {
      const text = fitLines(`This chat carries on from an earlier one. The handoff written at its end:\n${x.opening.trim()}`, Math.max(400, Math.min(free, Math.floor(room / 4))));
      out.push(text);
      free -= text.length + 2;
      parts.push(part('opening', 'Handoff from the chat before', text, text.length < x.opening.length ? 'cut' : 'whole'));
    }
    if (log.text) {
      out.push(log.text);
      parts.push(part('log', 'Chat log', log.text, log.dropped ? 'cut' : 'whole', `${log.ids.length} line${log.ids.length === 1 ? '' : 's'}${log.dropped ? `; ${log.dropped} done or learned line${log.dropped === 1 ? '' : 's'} left out for size` : ''}`));
    } else parts.push(part('log', 'Chat log', '', 'none', 'empty: "Add to log" under a message puts a line here'));
    if (sums?.text) {
      out.push(sums.text);
      parts.push(part('sums', 'Summed up at the folds (by the model)', sums.text, sums.dropped ? 'cut' : 'whole', `${sums.ids.length} summar${sums.ids.length === 1 ? 'y' : 'ies'}${sums.dropped ? `; ${sums.dropped} older one${sums.dropped === 1 ? '' : 's'} left out for size` : ''}`));
    } else if (sums) parts.push(part('sums', 'Summed up at the folds (by the model)', '', 'none', 'none yet: the model sums up what the next fold lets go'));
    return { text: out.join('\n\n'), parts };
  };
  /** The documents, inside what the top leaves (two fifths of the room at most), as in buildChat. */
  const docsFor = (upper: number) => {
    const fit = Math.max(0, Math.min(room - head.length - upper - x.message.length, docRoom(room)));
    const whole = !!x.docsWhole && x.docsWhole.length <= fit;
    return { text: whole ? x.docsWhole! : x.docs ? x.docs.slice(0, fit) : '', whole };
  };
  const shortFor = (upper: number, docs: number) => shortTokens(x.readPerSecond, x.foldMinutes, tok(upper + docs), Math.floor(Math.max(0, room - head.length - upper - docs - 6) / CHARS_PER_TOKEN));
  const startOf = (s: Sent) => startIn(history, s);
  /** The first message from which the rest (and the new message) fit in `budget` characters; past the last when none does. */
  const firstFit = (budget: number) => {
    let i = history.length;
    for (let t = x.message.length; i > 0 && t + sizes[i - 1] <= budget; i--) t += sizes[i - 1];
    return i;
  };

  let sent = x.sent;
  let start = -1;
  if (sent && sent.ctx === ctx && !sent.stale) {
    // A record that starts on an answer (saved before folds kept to his messages) is not trusted: it folds again.
    const s = startOf(sent);
    if (s >= 0 && (s === history.length || history[s].role === 'user') && from(s) <= shortFor(sent.upper.length, docsFor(sent.upper.length).text.length) * CHARS_PER_TOKEN) start = s;
  }
  const folded = start < 0;
  if (folded) {
    const up = fresh();
    const limit = shortFor(up.text.length, docsFor(up.text.length).text.length) * CHARS_PER_TOKEN;
    // "Send them now" keeps the messages it had when they still fit; otherwise the whole chat when it fits, else the
    // oldest messages leave until the rest fills two thirds, so the next third is said before the next fold.
    let s = sent?.stale && sent.ctx === ctx ? startOf(sent) : -1;
    if (!(s >= 0 && from(s) <= limit)) {
      s = from(0) <= limit ? 0 : firstFit(Math.floor((limit * 2) / 3));
      if (s === history.length && history.length) s = firstFit(limit);
    }
    // The word-for-word part starts on one of his messages: a chat template may refuse an answer straight after the
    // system message ("roles must alternate", measured on Ministral). One answer more leaves instead.
    start = userFrom(history, s);
    // Saved where sending starts, so the next turn trusts it (a record on an answer would fold again every turn).
    sent = { from: history[start]?.at ?? '', n: start, upper: up.text, logText: log.text, ...(sums?.text ? { sumText: sums.text } : {}), ctx, at: x.now ?? new Date().toISOString(), parts: up.parts };
  }
  const top = sent!;
  const docs = docsFor(top.upper.length);
  const short = shortFor(top.upper.length, docs.text.length);
  const recent = history.slice(start);
  // His turns in a row (a message brought back with Find, then his message) go as one: some models refuse two.
  const talk: ChatTurn[] = [];
  for (const t of [...recent.map(l => ({ role: l.role, content: l.content })), ...(x.message ? [{ role: 'user' as const, content: x.message }] : [])]) {
    const last = talk.at(-1);
    if (last && last.role === 'user' && t.role === 'user') last.content += `\n\n${t.content}`;
    else talk.push({ ...t });
  }
  const system = [head, top.upper, docs.text].filter(Boolean).join('\n\n');
  const waiting = log.text !== top.logText || (sums?.text ?? '') !== (top.sumText ?? '');
  const parts: Part[] = [x.card ? part('card', 'Who they are', x.card, 'whole') : part('card', 'Who they are', '', 'none', 'Default role: no instructions are sent')];
  parts.push(...top.parts.map(p => ((p.key === 'log' || p.key === 'sums') && waiting ? { ...p, note: [p.note, 'your changes since the last fold go in at the next one'].filter(Boolean).join('; ') } : p)));
  if (docs.text) parts.push(docs.whole ? part('docs', 'Documents in this chat (whole)', docs.text, 'whole') : part('docs', 'Documents in this chat (the matching parts)', docs.text, docs.text.length < (x.docs?.length ?? 0) ? 'cut' : 'whole'));
  parts.push(start
    ? part('older', 'Older messages', '', 'left out', `${start} older message${start === 1 ? '' : 's'}, not sent word for word: the chat log keeps what matters${sums ? ', the fold summaries what the model saw in them,' : ''} and Find in this chat brings one back`)
    : part('older', 'Older messages', '', 'none', 'the whole chat is sent word for word'));
  const recentText = recent.map(l => l.content).join('\n');
  const speed = x.readPerSecond > 0 ? `, reading ${n(Math.round(x.readPerSecond))} tokens a second here` : ', read speed not measured yet';
  parts.push(part('recent', 'Recent messages', recentText, start ? 'cut' : recent.length ? 'whole' : 'none', `${recent.length} of ${history.length} message${history.length === 1 ? '' : 's'}, up to about ${n(short)} tokens (fold wait ${x.foldMinutes} min${speed})`));
  parts.push(part('message', 'Your new message', x.message, x.message ? 'whole' : 'none'));
  const used = system.length + recentText.length + x.message.length;
  const fill = Math.round(((head.length + top.upper.length + docs.text.length + from(0)) / room) * 100);
  const foldTokens = tok(top.upper.length + docs.text.length) + short;
  const foldSeconds = x.readPerSecond > 0 ? Math.round(foldTokens / x.readPerSecond) : 0;
  return { turns: [...(system ? [{ role: 'system' as const, content: system }] : []), ...talk], parts, ctx, answerTokens, room, used, fill, docsWhole: docs.whole, layered: true, sent: top, folded, logWaiting: waiting, older: start, shortTokens: short, foldTokens, foldSeconds };
}

// ---- Find in this chat: an older message brought back, word for word ----

export interface Found {
  at: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The older messages (before `before`, where the word-for-word part starts) that share the most words with what he
 * typed, best first, newest first among equals; the words typed together count more. No embeddings: any PC can do it.
 */
export function findInChat(lines: ChatLine[], q: string, before: number, max = 8): Found[] {
  const phrase = q.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!phrase || before <= 0) return [];
  const want = keywords(phrase);
  return lines.slice(0, before)
    .map((l, i) => ({ l, i, score: [...keywords(l.content)].filter(w => want.has(w)).length + (phrase.length >= 4 && l.content.toLowerCase().includes(phrase) ? 3 : 0) }))
    .filter(s => s.score > 0 && !s.l.refused && !s.l.failed && s.l.content.trim())
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, max)
    .map(s => ({ at: s.l.at, role: s.l.role, text: s.l.content.length > 1500 ? `${s.l.content.slice(0, 1500)}…` : s.l.content }));
}

/** A message brought back, as a line of his in the chat: it stays there, so nothing above it changes. */
export function recallLine(l: { role: 'user' | 'assistant'; content: string; at: string }, name: string, now = new Date().toISOString()): ChatLine {
  const text = l.content.length > RECALL_MAX ? `${l.content.slice(0, RECALL_MAX)}…` : l.content;
  return { role: 'user', content: `From earlier in this chat (${l.at.slice(0, 10)}), ${l.role === 'user' ? 'I wrote' : `${name} wrote`}:\n${text}`, at: now, recalled: true };
}

// ---- The log on disk ----

const ID = /^[a-f0-9]{12}$/;
const isKind = (k: unknown): k is LogKind => typeof k === 'string' && Object.hasOwn(LOG_KINDS, k);
const KIND_FAULT = 'Pick what kind of line it is: a decision, a to do, something learned, or a name or number.';

function cleanFile(raw: unknown): ChatLogFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines = Array.isArray(r.lines) ? r.lines.filter((l): l is LogLine => !!l && typeof l.id === 'string' && isKind(l.kind) && typeof l.text === 'string' && typeof l.at === 'string') : [];
  const s = (r.sent && typeof r.sent === 'object' ? r.sent : null) as Sent | null;
  const sent = s && typeof s.from === 'string' && Number.isInteger(s.n) && typeof s.upper === 'string' && typeof s.logText === 'string' && typeof s.ctx === 'number' && typeof s.at === 'string' && Array.isArray(s.parts) ? s : null;
  const sums = Array.isArray(r.sums) ? r.sums.filter((b): b is SumBlock => !!b && typeof b.id === 'string' && typeof b.at === 'string' && typeof b.from === 'string' && typeof b.to === 'string' && Number.isInteger(b.n) && typeof b.text === 'string' && typeof b.by === 'string') : [];
  return { lines, sent, sums };
}

export class ChatLogs {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  file(id: string): string {
    if (!ID.test(id)) throw new Error('Not a chat.');
    return `chats/${id}-log.json`;
  }

  async read(id: string): Promise<ChatLogFile> {
    return cleanFile(await this.store.readJson<unknown>(this.file(id), {}));
  }

  /** Reads, changes and saves a chat's log in one turn, so two quick changes both stay. */
  private async change<R>(id: string, fn: (now: ChatLogFile) => { next?: ChatLogFile; out: R }): Promise<R> {
    let out!: R;
    await this.store.updateJson<unknown>(this.file(id), {}, raw => {
      const r = fn(cleanFile(raw));
      out = r.out;
      return r.next;
    });
    return out;
  }

  async add(id: string, kind: LogKind, text: unknown): Promise<LogLine | { error: string }> {
    const clean = cleanNote(text);
    if (!isKind(kind)) return { error: KIND_FAULT };
    if (!clean) return { error: 'Type the line to keep first.' };
    return this.change<LogLine | { error: string }>(id, f => {
      const same = f.lines.find(l => l.kind === kind && l.text.toLowerCase() === clean.toLowerCase());
      if (same) return { out: same };
      if (f.lines.length >= NOTEBOOK_MAX_LINES) return { out: { error: `This chat log has ${NOTEBOOK_MAX_LINES} lines, the most it keeps. Delete some you no longer need, then add this one.` } };
      const full = logFull(f.lines, kind, clean);
      if (full) return { out: { error: full } };
      const line: LogLine = { id: randomBytes(5).toString('hex'), kind, text: clean, at: new Date().toISOString() };
      return { next: { ...f, lines: [...f.lines, line] }, out: line };
    });
  }

  /** A line changed: its words, its kind, or Done ticked on (true) or off (false). */
  async edit(id: string, lineId: unknown, patch: { text?: unknown; kind?: unknown; done?: boolean }): Promise<LogLine | { error: string }> {
    if (patch.kind !== undefined && !isKind(patch.kind)) return { error: KIND_FAULT };
    const text = patch.text === undefined ? null : cleanNote(patch.text);
    if (text === '') return { error: 'A line cannot be empty: press Delete to take it out.' };
    return this.change<LogLine | { error: string }>(id, f => {
      const was = f.lines.find(l => l.id === lineId);
      if (!was) return { out: { error: 'That line is not there any more. It may have been deleted in another window.' } };
      const line: LogLine = { ...was, ...(text !== null ? { text } : {}), ...(patch.kind !== undefined ? { kind: patch.kind as LogKind } : {}) };
      if (patch.done === true && !line.done) line.done = new Date().toISOString();
      if (patch.done === false || line.kind !== 'todo') delete line.done;
      const full = logFull(f.lines.filter(l => l !== was), line.kind, line.text, !!line.done);
      if (full) return { out: { error: full } };
      return { next: { ...f, lines: f.lines.map(l => (l === was ? line : l)) }, out: line };
    });
  }

  async remove(id: string, lineId: unknown): Promise<boolean> {
    return this.change<boolean>(id, f => {
      const rest = f.lines.filter(l => l.id !== lineId);
      return rest.length === f.lines.length ? { out: false } : { next: { ...f, lines: rest }, out: true };
    });
  }

  /** A fold's summary, kept (oldest first). At most NOTEBOOK_MAX_LINES on disk: the oldest go first there too. */
  async addSum(id: string, b: Omit<SumBlock, 'id' | 'at'>, now = new Date().toISOString()): Promise<SumBlock | null> {
    const text = cleanSum(b.text);
    if (!text) return null;
    const block: SumBlock = { ...b, text, id: randomBytes(5).toString('hex'), at: now };
    return this.change<SumBlock>(id, f => ({ next: { ...f, sums: [...f.sums, block].slice(-NOTEBOOK_MAX_LINES) }, out: block }));
  }

  /** A summary's words changed by him (kept as he wrote them, cut to size). */
  async editSum(id: string, sumId: unknown, text: unknown): Promise<SumBlock | { error: string }> {
    const clean = cleanEditedSum(String(text ?? ''));
    if (!clean) return { error: 'A summary cannot be empty: press Delete to take it out.' };
    return this.change<SumBlock | { error: string }>(id, f => {
      const was = f.sums.find(b => b.id === sumId);
      if (!was) return { out: { error: 'That summary is not there any more. It may have been deleted in another window.' } };
      const b = { ...was, text: clean };
      return { next: { ...f, sums: f.sums.map(x => (x === was ? b : x)) }, out: b };
    });
  }

  async removeSum(id: string, sumId: unknown): Promise<boolean> {
    return this.change<boolean>(id, f => {
      const rest = f.sums.filter(b => b.id !== sumId);
      return rest.length === f.sums.length ? { out: false } : { next: { ...f, sums: rest }, out: true };
    });
  }

  /** What a fold sent, kept for the turns after it. */
  async setSent(id: string, sent: Sent | null): Promise<void> {
    await this.change(id, f => ({ next: { ...f, sent }, out: null }));
  }

  /** "Send them now": the next turn takes the log and notebooks as they are. */
  async stale(id: string): Promise<boolean> {
    return this.change<boolean>(id, f => (f.sent ? { next: { ...f, sent: { ...f.sent, stale: true } }, out: true } : { out: false }));
  }

  /** A chat carried on from this one (the handoff) starts with the same log, and its own record of what was sent. */
  async copy(from: string, to: string): Promise<void> {
    const { lines } = await this.read(from);
    if (lines.length) await this.change(to, () => ({ next: { lines, sent: null, sums: [] }, out: null }));
  }

  /** The chat was emptied or deleted: its log goes with it. */
  async drop(id: string): Promise<void> {
    await rm(join(this.store.dir, this.file(id)), { force: true });
  }
}
