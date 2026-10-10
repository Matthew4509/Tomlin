// Memory and context. Files on disk are the memory; a model's context is rebuilt fresh every turn from them and thrown
// away, so a brain swap, a seat change or a smaller model loses nothing but load time.
// Two kinds of notebook, plain JSON files in the data folder, each line viewable, editable and deletable by him:
//   memory/team.json             the team notebook, read by everyone (the manager's own notebook too)
//   memory/staff-<id>.json       one per hire, read only by that hire (in chats and in the job steps they run)
// Who writes a line: him ("remember: ..." or the Pin on a message), or a model's suggestion he pressed Save on. A model
// never writes or rewrites a line by itself (small models mis-report what they did).
// The plain functions are tested in test/memory.test.ts.
import { randomBytes } from 'node:crypto';
import type { ChatTurn } from './engine.ts';
import type { ChatLine, Store } from './store.ts';

export interface NoteLine {
  id: string;
  text: string;
  at: string;
  /** 'owner' typed it (remember: or Add), 'pin' from a message, 'suggested' a model's line he saved. */
  from: 'owner' | 'pin' | 'suggested';
}

/** The longest chat message, in characters (about 300K word-pieces): more than the biggest context reads in one message. */
export const MESSAGE_MAX = 1_000_000;
export const NOTE_MAX = 300;
export const NOTEBOOK_MAX_LINES = 200;
/** Characters per token for chat prose, on the safe side (English prose is nearer 4). */
export const CHARS_PER_TOKEN = 3;

const oneLine = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A notebook's name: 'team' or 'staff:<id>'. */
export const isScope = (s: unknown): s is string => s === 'team' || (typeof s === 'string' && /^staff:[a-z0-9-]{1,40}$/.test(s));
export const scopeFile = (scope: string) => (scope === 'team' ? 'memory/team.json' : `memory/staff-${scope.slice(6)}.json`);

/** One line to keep: one line of text, at most 300 characters; empty when there is nothing. */
export const cleanNote = (text: unknown) => oneLine(text, NOTE_MAX);

/**
 * "remember: the shop closes on Mondays" -> this person's notebook; "remember for the team: ..." -> the team notebook.
 * Also "Remember that ..." at the start of a message, unless it asks something ("Remember that film? What was it called?"
 * is a question to answer, not a line to keep). A comma does not count ("Remember, you said..." is talk). Null when the
 * message is not one.
 */
export function rememberCommand(message: string): { team: boolean; text: string } | null {
  const m = /^\s*remember\s*(for\s+(?:the\s+)?(?:whole\s+)?team\s*)?(?::|\s-\s|\bthat\b(?![^?]*\?))\s*([\s\S]+)$/i.exec(message);
  if (!m) return null;
  const text = cleanNote(m[2]);
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

/**
 * The notebook lines to send, inside `max` characters. All of them, in order, when they fit; otherwise the lines that
 * share the most words with the topic (no embeddings, so any PC can do it), newest first among equals, then back in
 * notebook order. Returns the lines kept and how many were left out.
 */
export function pickLines(lines: NoteLine[], topic: string, max: number): { lines: NoteLine[]; left: number } {
  const size = (ls: NoteLine[]) => ls.reduce((n, l) => n + l.text.length + 3, 0);
  if (size(lines) <= max) return { lines, left: 0 };
  const want = keywords(topic);
  const scored = lines.map((l, i) => ({ l, i, score: [...keywords(l.text)].filter(w => want.has(w)).length }));
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  const kept: typeof scored = [];
  let n = 0;
  for (const s of scored) {
    if (n + s.l.text.length + 3 > max) continue;
    kept.push(s);
    n += s.l.text.length + 3;
  }
  kept.sort((a, b) => a.i - b.i);
  return { lines: kept.map(s => s.l), left: lines.length - kept.length };
}

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
    if (!got.lines.length) return void parts.push(part(key, label, '', 'left out', `${lines.length} line${lines.length > 1 ? 's' : ''}, no room`));
    const text = `${title}\n${got.lines.map(l => `- ${l.text}`).join('\n')}`;
    sections.push(text);
    left -= text.length + 2;
    parts.push(part(key, label, text, got.left ? 'cut' : 'whole', got.left ? `${got.lines.length} of ${lines.length} lines, the ones on this topic` : `${lines.length} line${lines.length > 1 ? 's' : ''}`));
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
  const start = keptFrom(history.map(l => l.content.length + 8), left - sumRoom);
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
    const text = `${title}\n${got.lines.map(l => `- ${l.text}`).join('\n')}`;
    out.push(text);
    left -= text.length + 2;
    parts.push(part(key, label, text, got.left ? 'cut' : 'whole', `${got.lines.length} of ${lines.length} lines`));
  };
  book('team', 'Team memory', 'Team notebook (standing facts from the person):', team);
  book('own', ownLabel, 'Your notebook (what the person asked you to remember):', own);
  return { text: out.join('\n\n'), parts };
}

// ---- The notebooks on disk ----

export class Notebooks {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async read(scope: string): Promise<NoteLine[]> {
    if (!isScope(scope)) return [];
    const list = await this.store.readJson<NoteLine[]>(scopeFile(scope), []);
    return Array.isArray(list) ? list.filter(l => l && typeof l.id === 'string' && typeof l.text === 'string') : [];
  }

  /** Reads, changes and saves a notebook in one turn, so two quick saves (Pin, then a suggestion kept) both stay. */
  private async change<R>(scope: string, fn: (lines: NoteLine[]) => { lines?: NoteLine[]; out: R }): Promise<R> {
    let out!: R;
    await this.store.updateJson<NoteLine[]>(scopeFile(scope), [], raw => {
      const lines = Array.isArray(raw) ? raw.filter(l => l && typeof l.id === 'string' && typeof l.text === 'string') : [];
      const r = fn(lines);
      out = r.out;
      return r.lines;
    });
    return out;
  }

  /** A new line at the end; an exact repeat of a line already there is not added twice. */
  async add(scope: string, text: unknown, from: NoteLine['from']): Promise<NoteLine | { error: string }> {
    const clean = cleanNote(text);
    if (!isScope(scope)) return { error: 'There is no such memory.' };
    if (!clean) return { error: 'Type the line to keep first.' };
    return this.change<NoteLine | { error: string }>(scope, lines => {
      const same = lines.find(l => l.text.toLowerCase() === clean.toLowerCase());
      if (same) return { out: same };
      if (lines.length >= NOTEBOOK_MAX_LINES) return { out: { error: `This memory is full (${NOTEBOOK_MAX_LINES} lines). Delete some lines you no longer need, then add this one.` } };
      const line: NoteLine = { id: randomBytes(5).toString('hex'), text: clean, at: new Date().toISOString(), from };
      return { lines: [...lines, line], out: line };
    });
  }

  async edit(scope: string, id: unknown, text: unknown): Promise<NoteLine | { error: string }> {
    const clean = cleanNote(text);
    if (!clean) return { error: 'A line cannot be empty: press Delete to take it out.' };
    if (!isScope(scope)) return { error: 'There is no such memory.' };
    return this.change<NoteLine | { error: string }>(scope, lines => {
      const l = lines.find(x => x.id === id);
      if (!l) return { out: { error: 'That line is not there any more. It may have been deleted in another window.' } };
      l.text = clean;
      return { lines, out: l };
    });
  }

  async remove(scope: string, id: unknown): Promise<boolean> {
    if (!isScope(scope)) return false;
    return this.change<boolean>(scope, lines => {
      const rest = lines.filter(x => x.id !== id);
      return rest.length === lines.length ? { out: false } : { lines: rest, out: true };
    });
  }
}
