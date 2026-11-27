// Memory and context. Files on disk are the memory; a model's context is rebuilt fresh every turn from them and thrown
// away, so a brain swap, a seat change or a smaller model loses nothing but load time.
// Two kinds of notebook, plain Markdown files in the data folder that he can open in Notepad (src/notebookfile.ts has
// the layout), each entry also viewable, editable and deletable in the app:
//   memory/team.md               the team notebook, read by everyone (the manager's own notebook too)
//   memory/staff-<id>.md         one per hire, read only by that hire (in chats and in the job steps they run)
// Beside each, <name>.meta.json keeps who wrote each entry and when (lost, the entries still load, as his), and
// <name>.md.bak the file as it was before the last change. The JSON notebooks of 2.1.27 and before move in once.
// Who writes a line: him ("remember: ..." or the Pin on a message), or a model's suggestion he pressed Save on. A model
// never writes or rewrites a line by itself (small models mis-report what they did).
// The plain functions are tested in test/memory.test.ts.
import { randomBytes } from 'node:crypto';
import { copyFile, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { inFileTurn, readData, writeAtomic } from './atomic.ts';
import type { ChatTurn } from './engine.ts';
import { cleanGroup, DEFAULT_GROUP, entryHash, parseBook, PIN_GROUP, writeBook, type FileEntry } from './notebookfile.ts';
import { looksSecret } from './rules.ts';
import type { ChatLine, Store } from './store.ts';

export { DEFAULT_GROUP, PIN_GROUP } from './notebookfile.ts';

export interface NoteLine {
  id: string;
  text: string;
  at: string;
  /** 'owner' typed it (remember: or Add), 'pin' from a message, 'suggested' a model's line he saved. */
  from: 'owner' | 'pin' | 'suggested';
  /** The "## " group it sits under in the file (DEFAULT_GROUP when none). */
  group?: string;
}

/** An entry as the editor shows it: also those never sent (a key or a password in it). */
export interface BookEntry extends NoteLine {
  group: string;
  /** Kept in the file but never sent to a model: it looks like it holds a key or a password. */
  withheld?: boolean;
}

/** A whole notebook as read from its file. */
export interface Book {
  groups: string[];
  entries: BookEntry[];
  /** Plain words for what in the file is not sent as written (withheld, longer than an entry may be). */
  problems: string[];
  /** The file's size in characters, and when it was last changed (ms; 0 when there is no file yet). */
  chars: number;
  mtime: number;
}

/** The longest chat message, in characters (about 300K word-pieces): more than the biggest context reads in one message. */
export const MESSAGE_MAX = 1_000_000;
/** One line of a chat log (src/layers.ts), folded to one line. */
export const NOTE_MAX = 300;
/** The most a chat log keeps (src/layers.ts) and the most entries a notebook keeps. */
export const NOTEBOOK_MAX_LINES = 200;
/** Characters per token for chat prose, on the safe side (English prose is nearer 4). */
export const CHARS_PER_TOKEN = 3;

const oneLine = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A notebook's name: 'team' or 'staff:<id>'. */
export const isScope = (s: unknown): s is string => s === 'team' || (typeof s === 'string' && /^staff:[a-z0-9-]{1,40}$/.test(s));
/** The notebook's file in the data folder (Markdown, the truth). */
export const scopeFile = (scope: string) => (scope === 'team' ? 'memory/team.md' : `memory/staff-${scope.slice(6)}.md`);
/** Where 2.1.27 and before kept it (moved into the .md once, then renamed .json.bak). */
export const oldScopeFile = (scope: string) => scopeFile(scope).replace(/\.md$/, '.json');
const metaFile = (scope: string) => scopeFile(scope).replace(/\.md$/, '.meta.json');

/** One line to keep, folded to one line, at most 300 characters (chat log lines); empty when there is nothing. */
export const cleanNote = (text: unknown) => oneLine(text, NOTE_MAX);

/** The longest notebook entry, in characters (the same as a snippet): a pasted style guide or price list fits whole. */
export const ENTRY_MAX = 4000;
/** The most a notebook holds: NOTEBOOK_MAX_LINES entries or this many characters, whichever comes first. */
export const NOTEBOOK_MAX_CHARS = 100_000;
/** The group sent on every turn (inside the notebook's room), whatever the topic. */
export const ALWAYS_GROUP = 'Always send';

/**
 * The room (characters) one notebook has in an agent's run on a model of `ctx` tokens: a fifth of the room, at least
 * 1,500 characters, shared by the agent's own notebook and the team's (src/server/agents.ts memoryFor).
 */
export const agentBookRoom = (ctx: number): number => Math.floor(Math.max(1500, Math.floor(ctx * 4 * 0.2)) / 2);

/**
 * G4: how many of a notebook's "Always send" lines fit in `room` characters: sent whole, sent in part, and left out.
 * Worked out as pickLines picks them (Always send first).
 */
export function alwaysFit(lines: NoteLine[], room: number): { total: number; whole: number; part: number; left: number } {
  const always = lines.filter(l => (l.group ?? DEFAULT_GROUP) === ALWAYS_GROUP);
  if (!always.length) return { total: 0, whole: 0, part: 0, left: 0 };
  const got = pickLines(always, '', room);
  const whole = got.lines.filter(l => always.some(a => a.id === l.id && a.text === l.text)).length;
  const part = got.lines.length - whole;
  return { total: always.length, whole, part, left: always.length - whole - part };
}
/** A model's suggested lines wait here for him (Keep or Drop): never sent to a model. */
export const INBOX_GROUP = 'Inbox';

/** `s` cut to at most `max` UTF-16 units, never through the middle of an emoji. */
export const cutSafe = (s: string, max: number) => {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
};

/**
 * One entry to keep, its lines kept: each line's end trimmed, runs of spaces inside a line folded to one (indents at
 * the start stay), at most one blank line in a row, the whole trimmed. Not cut: '' for nothing, and the caller refuses
 * one over ENTRY_MAX with a plain message (see entryFault).
 */
export const cleanEntry = (text: unknown): string =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, '').replace(/(\S)[ \t]{2,}/g, '$1 '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Why an entry cannot be kept as it is, or null. */
export function entryFault(clean: string): string | null {
  if (clean.length > ENTRY_MAX) return `An entry keeps at most ${ENTRY_MAX.toLocaleString('en-GB')} characters, and this one has ${clean.length.toLocaleString('en-GB')}. Shorten it, or split it into two entries.`;
  if (looksSecret(clean)) return 'Not kept: this looks like it holds a password, key or token, and memory is sent to a model on every turn. Leave that part out.';
  return null;
}

/**
 * "remember: the shop closes on Mondays" -> this person's notebook; "remember for the team: ..." -> the team notebook.
 * Also "Remember that ..." at the start of a message, unless it asks something ("Remember that film? What was it called?"
 * is a question to answer, not a line to keep). A comma does not count ("Remember, you said..." is talk). Null when the
 * message is not one.
 */
export function rememberCommand(message: string): { team: boolean; text: string } | null {
  const m = /^\s*remember\s*(for\s+(?:the\s+)?(?:whole\s+)?team\s*)?(?::|\s-\s|\bthat\b(?![^?]*\?))\s*([\s\S]+)$/i.exec(message);
  if (!m) return null;
  // The whole rest of the message, its lines kept (a pasted block stays one entry); too long is refused when it is added.
  const text = cleanEntry(m[2]);
  return text ? { team: !!m[1], text } : null;
}

/** Added to a chat's system message: the model may SUGGEST one line; he decides. */
export const SUGGEST_RULE = 'If the person tells you a lasting fact worth keeping (a name, a preference, a standing rule), you may end your answer with one extra line: REMEMBER: the fact in one short sentence. Only for facts the person told you, never for your own ideas. You do not save it; the person decides.';

/** A "REMEMBER: ..." line at the end of an answer, taken out: the answer without it, and the suggested line. */
export function takeSuggestion(answer: string): { answer: string; suggest: string | null } {
  const m = /\n?[ \t]*\**REMEMBER\**\s*:\s*(.+?)\s*$/i.exec(answer.replace(/\s+$/, ''));
  if (!m) return { answer, suggest: null };
  const suggest = cleanNote(m[1].replace(/^\**|\**$/g, ''));
  return { answer: answer.slice(0, m.index).replace(/\s+$/, ''), suggest: suggest.length >= 6 ? suggest : null };
}

const STOP = new Set('about after again also because been before being could does doing from have here into just like made make more most much need only other over same should some such than that their them then there these they this those very want what when where which while will with would your yours write please thanks thank'.split(' '));
/** The words a line is about: lower case, four letters or more, without the common ones. */
export const keywords = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []).map(w => w.replace(/'s$/, '')).filter(w => !STOP.has(w)));

/** An entry as it is sent: a bullet, the lines under it indented. */
const entryText = (l: NoteLine) => `- ${l.text.replace(/\n/g, '\n  ')}`;
const entrySize = (l: NoteLine) => entryText(l).length + 1;
const groupOf = (l: NoteLine) => l.group || DEFAULT_GROUP;
/** Room an entry must have left to be sent in part rather than left out. */
const CUT_MIN = 200;

/**
 * The notebook lines to send, inside `max` characters. All of them, in order, when they fit; otherwise the "Always
 * send" group first, then the lines that share the most words with the topic (no embeddings, so any PC can do it; the
 * words of an entry's group count too, so "Style guide" is found when the message says "style"), newest first among
 * equals, then back in notebook order. A long entry on the topic with no room for all of it is sent in part (its first
 * lines and a note), never dropped without a word. Returns the lines kept, how many were left out and how many cut.
 */
export function pickLines(lines: NoteLine[], topic: string, max: number): { lines: NoteLine[]; left: number; cut: number } {
  const size = (ls: NoteLine[]) => ls.reduce((n, l) => n + entrySize(l), 0);
  if (size(lines) <= max) return { lines, left: 0, cut: 0 };
  const want = keywords(topic);
  const scored = lines.map((l, i) => ({ l, i, always: groupOf(l) === ALWAYS_GROUP, score: [...keywords(`${l.text} ${groupOf(l) === DEFAULT_GROUP ? '' : groupOf(l)}`)].filter(w => want.has(w)).length }));
  scored.sort((a, b) => Number(b.always) - Number(a.always) || b.score - a.score || b.i - a.i);
  const kept: typeof scored = [];
  let n = 0;
  let cut = 0;
  for (const s of scored) {
    const need = entrySize(s.l);
    if (n + need <= max) {
      kept.push(s);
      n += need;
      continue;
    }
    const room = max - n;
    if ((s.always || s.score > 0) && room >= CUT_MIN) {
      // The first lines that fit, made smaller until the bullet and the indents of its lines fit too.
      let part = { ...s.l, text: fitLines(s.l.text, room - 3) };
      for (let i = 0, max = room - 3; i < 6 && entrySize(part) > room && max > 40; i++) {
        max -= entrySize(part) - room + 8;
        part = { ...s.l, text: fitLines(s.l.text, max) };
      }
      if (entrySize(part) <= room) {
        kept.push({ ...s, l: part });
        n += entrySize(part);
        cut++;
      }
    }
  }
  kept.sort((a, b) => a.i - b.i);
  return { lines: kept.map(s => s.l), left: lines.length - kept.length, cut };
}

/** A notebook's part of the system message: the title, then the entries, under their group's name when there are several. */
export function bookText(title: string, lines: NoteLine[]): string {
  const groups = [...new Set(lines.map(groupOf))];
  if (groups.length <= 1) return `${title}\n${lines.map(entryText).join('\n')}`;
  return `${title}\n${groups.map(g => `${g}:\n${lines.filter(l => groupOf(l) === g).map(entryText).join('\n')}`).join('\n')}`;
}

/** What a notebook part's note says: how many entries went, and how many in part. */
export const bookNote = (got: { lines: NoteLine[]; left: number; cut: number }, all: number, topic = 'the ones on this topic') =>
  got.left || got.cut ? `${got.lines.length} of ${all} entries, ${topic}${got.cut ? `; ${got.cut} sent in part (too long for the room)` : ''}` : `${all} entr${all > 1 ? 'ies' : 'y'}`;

/**
 * The older part of a chat (what no longer fits whole), condensed by code, not by a model: each message's first
 * sentence, cut short. The newest part of it is kept when even that is too long. The raw chat stays on disk.
 */
export function olderSummary(lines: ChatLine[], name: string, max: number): string {
  if (!lines.length || max < 80) return '';
  const first = (t: string) => {
    const one = t.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
    const s = /^(.{12,}?[.!?])(\s|$)/.exec(one)?.[1] ?? one;
    return s.length > 110 ? `${s.slice(0, 107).replace(/\s+\S*$/, '')}…` : s;
  };
  const rows = lines.filter(l => !l.refused && !l.failed && l.content.trim()).map(l => `- ${l.role === 'user' ? 'They' : name}: ${l.picture ? `[a picture: ${first(l.picture.prompt)}]` : first(l.content)}`);
  const out: string[] = [];
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (n + rows[i].length + 1 > max) break;
    out.unshift(rows[i]);
    n += rows[i].length + 1;
  }
  const dropped = rows.length - out.length;
  return `${dropped ? `(${dropped} older message${dropped > 1 ? 's' : ''} before this not shown)\n` : ''}${out.join('\n')}`;
}

/** One part of a packet as "What X is reading" shows it. */
export interface Part {
  key: string;
  label: string;
  chars: number;
  /** Rough tokens (characters / 3). */
  tokens: number;
  /** 'whole', 'cut' (part of it), 'none' (nothing to send) or 'left out' (no room). */
  state: 'whole' | 'cut' | 'none' | 'left out';
  note?: string;
}

export interface ChatContext {
  turns: ChatTurn[];
  parts: Part[];
  /** The context size in tokens, the room left for the answer, and the characters the rest may use. */
  ctx: number;
  answerTokens: number;
  room: number;
  used: number;
  /**
   * How full the chat is, in percent of the room: the card, notebooks, opening note, the WHOLE chat so far and the new
   * message, as if nothing were cut. Past 100 the older messages are only summarised; the page offers a handoff at 75.
   */
  fill: number;
  /** The documents went in whole (not the matching parts). */
  docsWhole?: boolean;
}

export interface ChatInput {
  /** The receiving model's context in tokens (4,096 to 262,144). */
  ctx: number;
  /** Most the answer may be, in tokens; the builder reserves this first (a quarter of a small context at most). */
  maxAnswer: number;
  /** 1. Who they are (the persona card / system prompt): always sent. */
  card: string;
  /** Short rules after the card (the REMEMBER rule); always sent. */
  rules?: string;
  /** 2. Team notebook lines; 3. this person's own notebook lines ([] for the manager; null: none is read, a Default hire). */
  team: NoteLine[] | null;
  own: NoteLine[] | null;
  /** The name the older-chat summary uses for the answers. */
  name: string;
  /** The chat so far (without the new message), and the new message. */
  history: ChatLine[];
  message: string;
  /** A handoff from the chat before, written by the model when that chat grew large: read before the summary. */
  opening?: string;
  /** The parts of the chat's documents that match the message (src/docs.ts), already sized to docRoom(). */
  docs?: string;
  /** Every document whole (src/docs.ts wholeSection): sent instead of `docs` when it fits the documents' room. */
  docsWhole?: string;
  /**
   * The share of the room to fill (0.2 to 1): less than all when the model counted more word-pieces than the guess of
   * 3 characters each (JSON, another alphabet) and refused the chat as too long (src/engine.ts ContextFull).
   */
  squeeze?: number;
}

/** The characters a chat turn may fill (all but the answer), for a context of `ctx` tokens. */
/**
 * The context a chat is built for when a linked PC answers it: the context set there, made smaller until the whole chat
 * (its room, and the standing and project rules added on top, RULES_ON_TOP) fits the most characters that PC takes in one
 * request (`chars`, src/brains.ts chatCharsFor). So a long chat is folded and cut as usual, never sent and refused.
 */
export const RULES_ON_TOP = 6_500;
export function linkCtx(ctx: number, chars: number, maxAnswer: number): number {
  let c = Math.max(2048, ctx || 8192);
  while (c > 2048 && chatRoom(c, maxAnswer) + RULES_ON_TOP > chars) c = Math.max(2048, Math.floor(c * 0.95));
  return c;
}

export function chatRoom(ctx: number, maxAnswer: number): number {
  const c = Math.max(2048, ctx || 8192);
  return Math.max(1500, (c - Math.min(maxAnswer, Math.floor(c / 4)) - 64) * CHARS_PER_TOKEN);
}

/** How much of that room the documents' parts may take: two fifths, so the conversation is never squeezed out. */
export const docRoom = (room: number) => Math.floor(room * 0.4);

const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const part = (key: string, label: string, text: string, state: Part['state'], note?: string): Part => ({ key, label, chars: text.length, tokens: tok(text.length), state, ...(note ? { note } : {}) });

/**
 * The one context builder for a chat turn. Room for the answer is set aside first, then the parts are filled in this
 * order until the model's context runs out: 1 the card, 2 the team notebook, 3 their own notebook (the lines on the
 * topic when not all fit), 6 a summary of the older chat, 7 the recent messages, newest first. (4 job notes and 5 files
 * belong to job steps: see jobPacket.) A small model gets the same order with fewer of the low rows.
 * The notebooks may take at most a fifth of the room each, so the conversation itself is never squeezed out.
 */
export function buildChat(x: ChatInput): ChatContext {
  const ctx = Math.max(2048, x.ctx || 8192);
  const answerTokens = Math.min(x.maxAnswer, Math.floor(ctx / 4));
  const room = Math.floor(chatRoom(ctx, x.maxAnswer) * Math.min(1, Math.max(0.2, x.squeeze ?? 1)));
  const parts: Part[] = [];
  const topic = `${x.message} ${[...x.history].reverse().find(l => l.role === 'user')?.content ?? ''}`;
  let left = room - x.card.length - (x.rules?.length ?? 0) - x.message.length;
  // A Default hire has no card: nothing about who they are is sent.
  parts.push(x.card ? part('card', 'Who they are', x.card, 'whole') : part('card', 'Who they are', '', 'none', 'Default role: no instructions are sent'));
  const sections: string[] = x.card ? [x.card] : [];
  const book = (key: string, label: string, title: string, lines: NoteLine[] | null) => {
    if (!lines) return;
    if (!lines.length) return void parts.push(part(key, label, '', 'none', 'empty'));
    const got = pickLines(lines, topic, Math.max(0, Math.min(left, Math.floor(room / 5))));
    if (!got.lines.length) return void parts.push(part(key, label, '', 'left out', `${lines.length} entr${lines.length > 1 ? 'ies' : 'y'}, no room`));
    const text = bookText(title, got.lines);
    sections.push(text);
    left -= text.length + 2;
    parts.push(part(key, label, text, got.left || got.cut ? 'cut' : 'whole', bookNote(got, lines.length)));
  };
  book('team', 'Team memory', 'Team notebook (facts the whole team keeps; the person wrote these):', x.team);
  book('own', `${x.name}'s memory`, `Your notebook (what the person asked you to remember):`, x.own);
  // The handoff this chat started from: at most a quarter of the room (it was written to fit far less).
  if (x.opening?.trim()) {
    const text = fitLines(`This chat carries on from an earlier one. The handoff written at its end:\n${x.opening.trim()}`, Math.max(400, Math.min(left, Math.floor(room / 4))));
    sections.push(text);
    left -= text.length + 2;
    parts.push(part('opening', 'Handoff from the chat before', text, text.length < x.opening.length ? 'cut' : 'whole'));
  }
  // The chat's documents: whole when they fit, otherwise the parts that match this message (src/docs.ts).
  const docsFit = Math.max(0, Math.min(left, docRoom(room)));
  const docsWhole = !!x.docsWhole && x.docsWhole.length <= docsFit;
  // With the card: whole, the same every turn; the matching parts, the same while the questions match the same parts.
  // (Put with the new message instead, they changed the chat from that message on the turn after, since the chat on
  // disk keeps the message without them: Qwen 3.5, a hybrid model, then read everything again every turn. Measured.)
  if (docsWhole || x.docs) {
    const text = docsWhole ? x.docsWhole! : x.docs!.slice(0, docsFit);
    sections.push(text);
    left -= text.length + 2;
    parts.push(docsWhole ? part('docs', 'Documents in this chat (whole)', text, 'whole') : part('docs', 'Documents in this chat (the matching parts)', text, text.length < x.docs!.length ? 'cut' : 'whole'));
  }
  // The recent messages, inside what is left after a place for the summary.
  const history = x.history.filter(l => !l.refused && !l.failed && l.content.trim());
  const fixed = room - left;
  const sumRoom = Math.min(Math.floor(room / 6), 1500);
  // The start is chosen with the new message counted as the newest line of the chat, as it will be on the next turn:
  // counted apart, a long message (a paste) moved the start once on its own turn and again on the next, and each move
  // was a full re-read (two of about 30 minutes each at 119K on the Z820, measured 22 Nov). What is kept still fits:
  // the message's size is added to the room as well as to the lines.
  const sizes = history.map(l => l.content.length + 8);
  const mine = x.message ? x.message.length + 8 : 0;
  const at = Math.min(history.length, keptFrom(mine ? [...sizes, mine] : sizes, left - sumRoom + mine));
  // On one of his messages: a chat template may refuse an answer straight after the system message (measured).
  const start = userFrom(history, at);
  const recent = history.slice(start);
  const older = history.slice(0, start);
  if (older.length) {
    // Sized by the summary's own place, not by what the recent messages left: the same older messages give the same
    // summary every turn.
    const sum = olderSummary(older, x.name, sumRoom - 100);
    if (sum) {
      const text = `Earlier in this chat (a short summary written by the app; the full chat is kept on disk):\n${sum}`;
      sections.push(text);
      left -= text.length + 2;
      parts.push(part('summary', 'Summary of the older chat', text, 'cut', `${older.length} older message${older.length > 1 ? 's' : ''}, first sentence each`));
    } else parts.push(part('summary', 'Summary of the older chat', '', 'left out', `${older.length} older messages, no room`));
  } else parts.push(part('summary', 'Summary of the older chat', '', 'none', 'the whole chat fits'));
  if (x.rules) sections.push(x.rules);
  const recentText = recent.map(l => l.content).join('\n');
  parts.push(part('recent', 'Recent messages', recentText, older.length ? 'cut' : recent.length ? 'whole' : 'none', `${recent.length} of ${history.length} message${history.length === 1 ? '' : 's'}`));
  parts.push(part('message', 'Your new message', x.message, x.message ? 'whole' : 'none'));
  const system = sections.join('\n\n');
  const turns: ChatTurn[] = [...(system ? [{ role: 'system' as const, content: system }] : []), ...recent.map(l => ({ role: l.role, content: l.content })), ...(x.message ? [{ role: 'user' as const, content: x.message }] : [])];
  const used = system.length + recentText.length + x.message.length;
  const whole = fixed + history.reduce((n, l) => n + l.content.length + 8, 0);
  return { turns, parts, ctx, answerTokens, room, used, fill: Math.round((whole / room) * 100), docsWhole };
}

/**
 * Where the messages a turn sends begin, from each message's size (oldest first) and the room they may fill: all of
 * them when they fit. When they do not, the start moves on in steps of about a third of the room, at the first message
 * that begins in each third, not by one message every turn: the start of the prompt then stays the same until a third
 * of the room more has been said (in a 250K context, dozens of turns), and llama.cpp reads only what is new (a 250K
 * chat read again from the top is an hour or more on a laptop). The step is skipped when it would leave out more than
 * a third more than needed (one very long message): then only what must go goes.
 */
export function keptFrom(sizes: number[], room: number): number {
  const fit = (r: number) => {
    let i = sizes.length;
    for (let n = 0; i > 0 && n + sizes[i - 1] <= r; i--) n += sizes[i - 1];
    return i;
  };
  const need = fit(room);
  if (need === 0) return 0;
  const step = Math.max(1, Math.floor(room / 3));
  let at = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (i >= need && (i === 0 || Math.floor((at - sizes[i - 1]) / step) < Math.floor(at / step))) return at - sumTo(sizes, need) <= step ? i : need;
    at += sizes[i];
  }
  return need;
}

const sumTo = (sizes: number[], i: number) => sizes.slice(0, i).reduce((t, s) => t + s, 0);

/**
 * The first of his messages at or after `i` (past the last line when there is none): where the messages sent word for
 * word may start. Some chat templates (Ministral's, measured) refuse an answer straight after the system message.
 */
export function userFrom(history: ChatLine[], i: number): number {
  while (i < history.length && history[i].role !== 'user') i++;
  return i;
}

// ---- Job steps: the packet a worker gets ----

/**
 * The front of every job packet: the Scope card and the design brief first (when the job came from Start project),
 * then the team notebook and the hire's own notebook. Sized to the receiving model: at most `frontCap(ctx)` characters;
 * when the cards are longer, each keeps its first lines (statement and F1-F5 come first on the card; type and sizes on
 * the brief).
 */
export function frontCap(ctx: number): number {
  return ctx <= 4096 ? 1000 : ctx <= 8192 ? 2600 : ctx <= 16384 ? 5000 : 10000;
}

/** The first lines of a text that fit in `max` characters, with a note when lines were left out. */
export function fitLines(text: string, max: number): string {
  if (text.length <= max) return text;
  // Room for the note at the end; the first line is always kept (cut short when it alone is too long).
  const room = Math.max(20, max - 70);
  const lines = text.split('\n');
  const out = [lines[0].slice(0, room)];
  let n = out[0].length;
  for (const l of lines.slice(1)) {
    if (n + l.length + 1 > room) break;
    out.push(l);
    n += l.length + 1;
  }
  return `${out.join('\n')}\n[… ${lines.length - out.length} more line${lines.length - out.length === 1 ? '' : 's'} left out: no room in this model]`;
}

export interface Front {
  text: string;
  parts: Part[];
}

export function jobFront(ctx: number, cards: { scope: string; design: string } | null, team: NoteLine[], own: NoteLine[] | null, topic: string, ownLabel = 'Their memory'): Front {
  const cap = frontCap(ctx);
  const parts: Part[] = [];
  const out: string[] = [];
  let left = cap;
  if (cards) {
    // The cards come first and keep most of the room: whole when both fit in nine tenths of it, else the scope gets
    // a little more than the design brief.
    const whole = cards.scope.length + cards.design.length + 2 <= cap * 0.9;
    const scope = whole ? cards.scope : fitLines(cards.scope, Math.max(300, Math.floor(cap * 0.5)));
    const design = whole ? cards.design : fitLines(cards.design, Math.max(200, Math.floor(cap * 0.9) - scope.length - 2));
    out.push(scope, design);
    left -= scope.length + design.length + 4;
    parts.push(part('scope', 'Scope card', scope, scope.length < cards.scope.length ? 'cut' : 'whole'));
    parts.push(part('design', 'Design brief', design, design.length < cards.design.length ? 'cut' : 'whole'));
  }
  const book = (key: string, label: string, title: string, lines: NoteLine[] | null) => {
    if (!lines) return;
    if (!lines.length) return void parts.push(part(key, label, '', 'none', 'empty'));
    const got = pickLines(lines, topic, Math.max(0, left - title.length - 2));
    if (!got.lines.length) return void parts.push(part(key, label, '', 'left out', 'no room'));
    const text = bookText(title, got.lines);
    out.push(text);
    left -= text.length + 2;
    parts.push(part(key, label, text, got.left || got.cut ? 'cut' : 'whole', bookNote(got, lines.length, 'the ones on the step')));
  };
  book('team', 'Team memory', 'Team notebook (standing facts from the person):', team);
  book('own', ownLabel, 'Your notebook (what the person asked you to remember):', own);
  return { text: out.join('\n\n'), parts };
}


// ---- The notebooks on disk ----

interface Meta {
  id: string;
  at: string;
  from: NoteLine['from'];
}

const FROMS = new Set(['owner', 'pin', 'suggested']);
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** A text file, or null when it is not there. A file held a moment by a scanner (or Notepad saving) is tried again. */
async function readText(file: string): Promise<string | null> {
  for (let i = 1; ; i++) {
    try {
      const t = await readFile(file, 'utf8');
      return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return null;
      if (i >= 15 || !BUSY.has(code)) throw e;
      await new Promise(r => setTimeout(r, 40 * i));
    }
  }
}

/** The most lines an agent's Inbox holds waiting for Keep or Drop; they are counted apart from the kept lines. */
export const INBOX_MOST = 30;

/**
 * How full a notebook is: its kept entries and characters, against the most it keeps. Lines waiting in the Inbox are
 * left out (they have a limit of their own), so a model's proposals never fill the notebook against the person's lines.
 */
export const bookFull = (entries: { text: string; group?: string }[]) => {
  const kept = entries.filter(e => e.group !== INBOX_GROUP);
  return { entries: kept.length, chars: kept.reduce((n, e) => n + e.text.length, 0), maxEntries: NOTEBOOK_MAX_LINES, maxChars: NOTEBOOK_MAX_CHARS };
};

/** Why one more entry of `size` characters does not fit in group `group`, or null. */
function fullFault(entries: { text: string; group?: string }[], size: number, group?: string): string | null {
  if (group === INBOX_GROUP) {
    const waiting = entries.filter(e => e.group === INBOX_GROUP).length;
    return waiting >= INBOX_MOST ? `The Inbox is full (${INBOX_MOST} lines waiting). Keep or drop some, then add this one.` : null;
  }
  const f = bookFull(entries);
  if (f.entries >= f.maxEntries) return `This memory is full (${f.maxEntries} entries). Delete some you no longer need, then add this one.`;
  if (f.chars + size > f.maxChars) return `This memory is full (${f.maxChars.toLocaleString('en-GB')} characters). Delete or shorten some entries, then add this one.`;
  return null;
}

/** The entries of a parsed file with their ids and "who, when" from the sidecar (lost: his, at the file's time). */
export function withMeta(parsed: FileEntry[], meta: Record<string, Meta>, mtime: number): BookEntry[] {
  const used = new Set<string>();
  const when = new Date(mtime || Date.now()).toISOString();
  return parsed.map(e => {
    const h = entryHash(e.text);
    const m = meta[h];
    let id = m && typeof m.id === 'string' && /^[a-z0-9-]{1,40}$/.test(m.id) && !used.has(m.id) ? m.id : `h${h.slice(0, 10)}`;
    // The same text twice (a copy pasted in Notepad): the second gets an id of its own, the same on every read.
    for (let n = 2; used.has(id); n++) id = `h${h.slice(0, 10)}-${n}`;
    used.add(id);
    const entry: BookEntry = { id, text: e.text, at: m && typeof m.at === 'string' ? m.at : when, from: m && FROMS.has(m.from) ? m.from : 'owner', group: e.group };
    if (looksSecret(e.text)) entry.withheld = true;
    return entry;
  });
}

/** Plain words for what in a notebook is not sent as it stands. */
export function bookProblems(entries: BookEntry[]): string[] {
  const out: string[] = [];
  const where = (e: BookEntry) => `"${oneLine(e.text, 50)}${e.text.length > 50 ? '…' : ''}" (${e.group})`;
  for (const e of entries) {
    if (e.withheld) out.push(`${where(e)} looks like it holds a password, key or token: it stays in the file but is never sent to a model.`);
    else if (e.text.length > ENTRY_MAX) out.push(`${where(e)} is longer than ${ENTRY_MAX.toLocaleString('en-GB')} characters: it is sent in part when there is not room for all of it.`);
  }
  const f = bookFull(entries);
  if (f.entries > f.maxEntries || f.chars > f.maxChars) out.push(`This memory is over its size (${f.maxEntries} entries or ${f.maxChars.toLocaleString('en-GB')} characters): nothing more can be added until some go.`);
  return out;
}

export class Notebooks {
  private store: Store;
  private titleOf: (scope: string) => string;

  /** `titleOf`: the "# " line the file starts with, for people ("Memory: Fern (artist)"). */
  constructor(store: Store, titleOf?: (scope: string) => string) {
    this.store = store;
    this.titleOf = titleOf ?? (s => (s === 'team' ? 'Memory: the team' : `Memory: ${s.slice(6)}`));
  }

  /** The notebook's file, in full (for Open file). */
  fileOf(scope: string): string {
    return join(this.store.dir, scopeFile(scope));
  }

  /** The entries a model may be sent: none withheld, none waiting in the Inbox. */
  async read(scope: string): Promise<NoteLine[]> {
    if (!isScope(scope)) return [];
    const b = await this.book(scope);
    return b.entries.filter(e => !e.withheld && e.group !== INBOX_GROUP).map(({ withheld: _, ...e }) => e);
  }

  /** The whole notebook as the editor shows it. */
  async book(scope: string): Promise<Book> {
    if (!isScope(scope)) return { groups: [], entries: [], problems: [], chars: 0, mtime: 0 };
    return inFileTurn(this.fileOf(scope), () => this.load(scope));
  }

  /** The file as it is on disk ('' before the first entry): the editor's Text view. */
  async text(scope: string): Promise<{ text: string; mtime: number }> {
    if (!isScope(scope)) return { text: '', mtime: 0 };
    return inFileTurn(this.fileOf(scope), async () => {
      const b = await this.load(scope);
      return { text: (await readText(this.fileOf(scope))) ?? '', mtime: b.mtime };
    });
  }

  /** Reads the file (moving a 2.1.27 JSON notebook in first, once). Only inside the file's turn. */
  private async load(scope: string): Promise<Book> {
    const file = this.fileOf(scope);
    let text = await readText(file);
    if (text === null) text = await this.moveOld(scope);
    if (text === null) return { groups: [], entries: [], problems: [], chars: 0, mtime: 0 };
    const mtime = await stat(file).then(s => s.mtimeMs, () => 0);
    const meta = await readData<Record<string, Meta>>(join(this.store.dir, metaFile(scope)), {});
    const parsed = parseBook(text);
    const entries = withMeta(parsed.entries, meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}, mtime);
    return { groups: parsed.groups, entries, problems: bookProblems(entries), chars: text.length, mtime };
  }

  /**
   * The JSON notebook of 2.1.27 and before, written out as the .md (pins under "Pinned", the rest under "Notes"), read
   * back and checked, then renamed .json.bak. Null when there is none. Left as it was when the check fails.
   */
  private async moveOld(scope: string): Promise<string | null> {
    const old = join(this.store.dir, oldScopeFile(scope));
    const raw = await readData<unknown>(old, null);
    if (!Array.isArray(raw)) return null;
    const lines = raw.filter((l): l is NoteLine => !!l && typeof l.id === 'string' && typeof l.text === 'string' && !!cleanEntry(l.text));
    const entries: BookEntry[] = lines.map(l => ({ id: l.id, text: cleanEntry(l.text), at: typeof l.at === 'string' ? l.at : new Date().toISOString(), from: FROMS.has(l.from) ? l.from : 'owner', group: l.from === 'pin' ? PIN_GROUP : DEFAULT_GROUP }));
    const groups = [...new Set(entries.map(e => e.group))];
    const text = writeBook(this.titleOf(scope), groups, entries);
    const back = parseBook(text).entries.map(e => e.text);
    const want = [...entries].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group)).map(e => e.text);
    if (back.length !== want.length || back.some((t, i) => t !== want[i])) {
      console.error(`${oldScopeFile(scope)} could not be moved into ${scopeFile(scope)} (it did not read back the same): it is read as it was.`);
      return null;
    }
    await this.write(scope, groups, entries, false);
    await rename(old, `${old}.bak`).catch(e => console.error(`${oldScopeFile(scope)} was moved into ${scopeFile(scope)} but could not be renamed .json.bak: ${(e as Error).message}`));
    return text;
  }

  /** Writes the file and its sidecar; the file as it was is kept as <name>.md.bak. Only inside the file's turn. */
  private async write(scope: string, groups: string[], entries: BookEntry[], keepBak: boolean): Promise<void> {
    const file = this.fileOf(scope);
    if (keepBak) await copyFile(file, `${file}.bak`).catch(() => undefined);
    await writeAtomic(file, writeBook(this.titleOf(scope), groups, entries));
    const meta: Record<string, Meta> = {};
    for (const e of entries) meta[entryHash(e.text)] ??= { id: e.id, at: e.at, from: e.from };
    await writeAtomic(join(this.store.dir, metaFile(scope)), JSON.stringify(meta, null, 1));
  }

  /** Reads, changes and saves a notebook in one turn, so two quick saves (Pin, then a suggestion kept) both stay. */
  private async change<R>(scope: string, fn: (b: Book) => { groups?: string[]; entries?: BookEntry[]; out: R }): Promise<R> {
    return inFileTurn(this.fileOf(scope), async () => {
      const b = await this.load(scope);
      const r = fn(b);
      if (r.entries || r.groups) {
        const groups = r.groups ?? b.groups;
        await this.write(scope, groups, r.entries ?? b.entries, b.mtime > 0);
      }
      return r.out;
    });
  }

  /** A new entry at the end of its group; an exact repeat of one already there is not added twice. */
  async add(scope: string, text: unknown, from: NoteLine['from'], group?: unknown): Promise<NoteLine | { error: string }> {
    const clean = cleanEntry(text);
    if (!isScope(scope)) return { error: 'There is no such memory.' };
    if (!clean) return { error: 'Type the line to keep first.' };
    const fault = entryFault(clean);
    if (fault) return { error: fault };
    const g = group === undefined || group === null || group === '' ? (from === 'pin' ? PIN_GROUP : DEFAULT_GROUP) : cleanGroup(group);
    return this.change<NoteLine | { error: string }>(scope, b => {
      const same = b.entries.find(l => l.text.toLowerCase() === clean.toLowerCase());
      if (same) return { out: same };
      const full = fullFault(b.entries, clean.length, g);
      if (full) return { out: { error: full } };
      const line: BookEntry = { id: randomBytes(5).toString('hex'), text: clean, at: new Date().toISOString(), from, group: g };
      const groups = b.groups.includes(g) ? b.groups : [...b.groups, g];
      return { groups, entries: [...b.entries, line], out: line };
    });
  }

  /** Changes an entry's text, its group (a move), or both. */
  /**
   * `was`: the text the window showed. When the line no longer holds it (another window, or Notepad, changed it since),
   * nothing is written and the answer says so (`changed`), so one window never silently wipes another's edit.
   */
  async edit(scope: string, id: unknown, text: unknown, group?: unknown, was?: unknown): Promise<NoteLine | { error: string; changed?: true }> {
    const clean = text === undefined ? null : cleanEntry(text);
    if (clean === '') return { error: 'A line cannot be empty: press Delete to take it out.' };
    if (!isScope(scope)) return { error: 'There is no such memory.' };
    const fault = clean === null ? null : entryFault(clean);
    if (fault) return { error: fault };
    return this.change<NoteLine | { error: string; changed?: true }>(scope, b => {
      const l = b.entries.find(x => x.id === id);
      if (!l) return { out: { error: 'That line is not there any more. It may have been deleted in another window, or changed in Notepad.' } };
      if (typeof was === 'string' && cleanEntry(was) !== l.text) return { out: { error: `That line was changed in another window (or in Notepad) since you opened it. It now says: "${l.text.slice(0, 200)}". Your change was not saved: open it again and make your change there.`, changed: true } };
      if (clean !== null && clean.length > l.text.length) {
        const full = fullFault(b.entries.filter(x => x !== l), clean.length);
        if (full && !full.includes('entries')) return { out: { error: full } };
      }
      if (clean !== null) {
        l.text = clean;
        delete l.withheld;
      }
      let groups = b.groups;
      if (group !== undefined) {
        const g = cleanGroup(group);
        if (!groups.includes(g)) groups = [...groups, g];
        // Moved: it goes to the end of its new group.
        if (g !== l.group) {
          // Kept out of the Inbox (or moved into it): it must fit where it goes.
          if (g === INBOX_GROUP || l.group === INBOX_GROUP) {
            const full = fullFault(b.entries.filter(x => x !== l), clean?.length ?? l.text.length, g);
            if (full) return { out: { error: full } };
          }
          l.group = g;
          b.entries = [...b.entries.filter(x => x !== l), l];
        }
      }
      return { groups, entries: b.entries, out: l };
    });
  }

  /**
   * The whole file from the editor's Text view, read back by code as it would be from Notepad, then written in the
   * file's own layout. `mtime`: the file's time when the page read it; the file changed since (in Notepad, another
   * window) is refused, so neither is written over. `check`: only say what it reads as, keep nothing.
   */
  async saveText(scope: string, text: unknown, mtime: unknown, check = false): Promise<{ groups: string[]; entries: number; problems: string[] } | { error: string; changed?: boolean }> {
    if (!isScope(scope)) return { error: 'There is no such memory.' };
    if (typeof text !== 'string') return { error: 'There is no text to keep.' };
    if (text.length > NOTEBOOK_MAX_CHARS * 2) return { error: `That is ${text.length.toLocaleString('en-GB')} characters; a memory keeps ${NOTEBOOK_MAX_CHARS.toLocaleString('en-GB')}. Take some out first.` };
    return inFileTurn(this.fileOf(scope), async () => {
      const b = await this.load(scope);
      if (typeof mtime === 'number' && Math.abs(b.mtime - mtime) > 1) return { error: 'This memory was changed since you opened it (in Notepad, or another window). Copy your text somewhere, press Cancel to see it as it is now, then make your change again.', changed: true };
      const parsed = parseBook(text);
      const entries = withMeta(parsed.entries.map(e => ({ ...e, text: cleanEntry(e.text) })).filter(e => e.text), Object.fromEntries(b.entries.map(e => [entryHash(e.text), { id: e.id, at: e.at, from: e.from }])), Date.now());
      // Entries written new in the box are his, from now (not from when the file was last changed).
      const now = new Date().toISOString();
      const known = new Set(b.entries.map(e => entryHash(e.text)));
      for (const e of entries) if (!known.has(entryHash(e.text))) e.at = now;
      const out = { groups: parsed.groups, entries: entries.length, problems: bookProblems(entries) };
      if (!check) await this.write(scope, parsed.groups, entries, b.mtime > 0);
      return out;
    });
  }

  /** Puts the entries in this order (ids; any left out keep their place after them) and the groups in `groups` order. */
  async order(scope: string, ids: unknown, groups?: unknown): Promise<boolean> {
    if (!isScope(scope) || !Array.isArray(ids)) return false;
    return this.change<boolean>(scope, b => {
      const by = new Map(b.entries.map(e => [e.id, e]));
      const first = ids.map(id => by.get(String(id))).filter((e): e is BookEntry => !!e);
      const seen = new Set(first);
      const next = Array.isArray(groups) ? [...new Set([...groups.map(cleanGroup), ...b.groups])].filter(g => b.groups.includes(g)) : b.groups;
      return { groups: next, entries: [...first, ...b.entries.filter(e => !seen.has(e))], out: true };
    });
  }

  /** A new group (empty until an entry goes in), a group renamed, or an empty group taken out. */
  async group(scope: string, action: unknown, name: unknown, to?: unknown): Promise<{ groups: string[] } | { error: string }> {
    if (!isScope(scope)) return { error: 'There is no such memory.' };
    const g = cleanGroup(name);
    return this.change<{ groups: string[] } | { error: string }>(scope, b => {
      if (action === 'add') {
        if (b.groups.some(x => x.toLowerCase() === g.toLowerCase())) return { out: { error: `There is a group called "${g}" already.` } };
        return { groups: [...b.groups, g], out: { groups: [...b.groups, g] } };
      }
      if (!b.groups.includes(g)) return { out: { error: `There is no group called "${g}" any more.` } };
      if (action === 'rename') {
        const n = cleanGroup(to);
        if (n.toLowerCase() !== g.toLowerCase() && b.groups.some(x => x.toLowerCase() === n.toLowerCase())) return { out: { error: `There is a group called "${n}" already.` } };
        const groups = b.groups.map(x => (x === g ? n : x));
        for (const e of b.entries) if (e.group === g) e.group = n;
        return { groups, entries: b.entries, out: { groups } };
      }
      if (action === 'remove') {
        if (b.entries.some(e => e.group === g)) return { out: { error: `"${g}" still has entries in it. Move or delete them first.` } };
        const groups = b.groups.filter(x => x !== g);
        return { groups, out: { groups } };
      }
      return { out: { error: 'Unknown action.' } };
    });
  }

  async remove(scope: string, id: unknown): Promise<boolean> {
    if (!isScope(scope)) return false;
    return this.change<boolean>(scope, b => {
      const rest = b.entries.filter(x => x.id !== id);
      return rest.length === b.entries.length ? { out: false } : { entries: rest, out: true };
    });
  }
}
