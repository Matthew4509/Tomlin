// The queue: work lined up to run by itself (pictures, projects, chat messages), so the PCs can work alone for hours.
// One list for the network: each item runs on the PC its worker lives on, one item at a time on each PC, and items for
// different PCs run side by side. Pure: what may start, the order, moving and cancelling, and the lines Home shows when
// work comes back. The server (src/server/queue.ts) runs the items and keeps the list in data/queue.json.

export type QKind = 'picture' | 'project' | 'chat';
/** waiting: in line; running; done; needs: a project stopped at a step that needs him; failed; cancelled. */
export type QState = 'waiting' | 'running' | 'done' | 'needs' | 'failed' | 'cancelled';

export interface QItem {
  id: string;
  kind: QKind;
  state: QState;
  /** The line he reads: the picture's prompt, the project's name, or the message. */
  title: string;
  added: string;
  started?: string;
  ended?: string;
  /** The project it belongs to (a job id; '' for none) and its name as it was when added. */
  project: string;
  projectName?: string;
  /** Where it runs or ran: 'here' or 'pc:<id>' (a project also holds 'jobs': one project runs at a time). */
  lanes?: string[];
  /** That PC's name, for the list ("this PC" for here). */
  laneName?: string;
  // ---- A picture ----
  prompt?: string;
  /** The artist (a hire's id) who draws it; none: the first artist on the team. */
  as?: string;
  mode?: string;
  width?: number;
  height?: number;
  /** Drawn for this step (0-based) of its project: the step is marked done when it comes back. */
  step?: number;
  // ---- A project: its waiting steps, run one after another (the reviewer reads each when `review`) ----
  review?: boolean;
  /** The picture item (one of its steps) this project waits for before it goes on. */
  waitFor?: string;
  // ---- A chat message ----
  chat?: string;
  message?: string;
  think?: boolean;
  // ---- What came back ----
  /** What happened, in words written by code. */
  result?: string;
  /** The picture's file in the gallery. */
  output?: string;
  /** Where it was handed in to the project (workspace path), or why not. */
  handed?: string;
  error?: string;
  /** Not before this time (ms): put back because its PC was busy or off. */
  after?: number;
  /** Times it was put back. */
  tries?: number;
  /** Why it waits now (its PC was busy, or the app was restarted while it ran). */
  note?: string;
  /** Read on Home: its line leaves Waiting for you. */
  seen?: boolean;
}

export interface Queue {
  paused: boolean;
  items: QItem[];
}

export const EMPTY: Queue = { paused: false, items: [] };
/** The most lines kept (finished ones go first when it is full). */
export const MAX_ITEMS = 300;
/** The most items added in one go (a pasted list). */
export const MAX_ADD = 50;
const KINDS: QKind[] = ['picture', 'project', 'chat'];
const STATES: QState[] = ['waiting', 'running', 'done', 'needs', 'failed', 'cancelled'];
export const FINISHED: QState[] = ['done', 'needs', 'failed', 'cancelled'];
export const isFinished = (it: QItem) => FINISHED.includes(it.state);

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined);
const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : undefined);

/** One item as read from disk: anything unknown is left out, an item of no known kind is dropped. */
export function cleanItem(raw: unknown): QItem | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || !id(r.id) || !KINDS.includes(r.kind as QKind)) return null;
  const it: QItem = {
    id: r.id as string,
    kind: r.kind as QKind,
    state: STATES.includes(r.state as QState) ? (r.state as QState) : 'waiting',
    title: str(r.title, 300) ?? '',
    added: str(r.added, 40) ?? new Date(0).toISOString(),
    project: id(r.project) ?? '',
  };
  const keep: [keyof QItem, unknown][] = [
    ['started', str(r.started, 40)], ['ended', str(r.ended, 40)], ['projectName', str(r.projectName, 120)],
    ['lanes', Array.isArray(r.lanes) ? r.lanes.filter(x => typeof x === 'string' && /^(here|jobs|pc:[\w-]{1,40})$/.test(x)).slice(0, 3) : undefined],
    ['laneName', str(r.laneName, 80)], ['prompt', str(r.prompt, 2000)], ['as', id(r.as)], ['mode', str(r.mode, 20)],
    ['width', num(r.width, 64, 4096)], ['height', num(r.height, 64, 4096)], ['step', num(r.step, 0, 999)],
    ['review', r.review === true ? true : undefined], ['waitFor', id(r.waitFor)], ['chat', id(r.chat)], ['message', str(r.message, 20_000)],
    ['think', r.think === true ? true : undefined], ['result', str(r.result, 600)], ['output', str(r.output, 300)], ['handed', str(r.handed, 400)],
    ['error', str(r.error, 600)], ['after', num(r.after, 0, 1e15)], ['tries', num(r.tries, 0, 1000)], ['note', str(r.note, 300)],
    ['seen', r.seen === true ? true : undefined],
  ];
  for (const [k, v] of keep) if (v !== undefined) (it as unknown as Record<string, unknown>)[k] = v;
  return it;
}

export function cleanQueue(raw: unknown): Queue {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const items = (Array.isArray(r.items) ? r.items : []).map(cleanItem).filter((x): x is QItem => !!x);
  return { paused: r.paused === true, items };
}

/**
 * After a start: what was running when TOMLIN stopped runs again (its saved steps stay saved; a picture is drawn
 * again). Said on the line.
 */
export function afterRestart(q: Queue): Queue {
  return { ...q, items: q.items.map(it => (it.state === 'running' ? { ...it, state: 'waiting' as const, note: 'TOMLIN was closed while this ran: it runs again.' } : it)) };
}

/**
 * The items that may start now, in order. Each PC (lane) does one item at a time; an item that cannot start yet keeps its
 * place in its lanes, so a later one for the same PC never overtakes it. A project waiting for one of its pictures holds
 * no place. `lanesOf` gives each waiting item's lanes; `busy` is lanes in use by something outside the queue.
 */
export function toStart(q: Queue, lanesOf: (it: QItem) => string[], busy: Set<string>, now = Date.now()): QItem[] {
  if (q.paused) return [];
  const taken = new Set(busy);
  for (const it of q.items) if (it.state === 'running') for (const l of it.lanes ?? []) taken.add(l);
  const out: QItem[] = [];
  for (const it of q.items) {
    if (it.state !== 'waiting') continue;
    if (it.waitFor && q.items.some(x => x.id === it.waitFor && (x.state === 'waiting' || x.state === 'running'))) continue;
    const lanes = lanesOf(it);
    const free = lanes.every(l => !taken.has(l)) && !(it.after && it.after > now);
    for (const l of lanes) taken.add(l);
    if (free) out.push(it);
  }
  return out;
}

/** Moves a waiting item past the next waiting one above (-1) or below (+1). False when it cannot move. */
export function move(q: Queue, itemId: string, dir: -1 | 1): boolean {
  const i = q.items.findIndex(x => x.id === itemId);
  if (i < 0 || q.items[i].state !== 'waiting') return false;
  for (let j = i + dir; j >= 0 && j < q.items.length; j += dir) {
    if (q.items[j].state !== 'waiting') continue;
    const [it] = q.items.splice(i, 1);
    q.items.splice(j, 0, it);
    return true;
  }
  return false;
}

/** Room for `n` more: the oldest finished lines go first. False when the list is full of work still to do. */
export function makeRoom(q: Queue, n: number): boolean {
  while (q.items.length + n > MAX_ITEMS) {
    const i = q.items.findIndex(isFinished);
    if (i < 0) return false;
    q.items.splice(i, 1);
  }
  return true;
}

/** "this PC", or the linked PC's name. */
export const laneWords = (it: QItem) => it.laneName || (it.lanes?.some(l => l.startsWith('pc:')) ? 'a linked PC' : 'this PC');

const short = (s: string, max = 70) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
/** A line's end: a full stop, unless it ends with its own (a question keeps its question mark). */
const stop = (s: string) => (/[.?!…]$/.test(s) ? s : `${s}.`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line of Home's "Waiting for you" from the queue: what came back while he was away, grouped. */
export interface QueueLine {
  key: string;
  kind: 'needs' | 'photos' | 'documents' | 'reply' | 'failed';
  text: string;
  detail: string;
  action: string;
  /** The queue items it stands for (Seen marks them all). */
  ids: string[];
  job?: string;
  chat?: string;
  at: string;
}

/**
 * Home's lines for finished work not yet seen, in this order: a project that needs him, photos to review (per project),
 * documents to review (per project), replies to answer (per chat), and work that did not finish. Written by code.
 */
export function homeLines(q: Queue, chatTitle: (chatId: string) => string = () => ''): QueueLine[] {
  const fresh = q.items.filter(it => isFinished(it) && it.state !== 'cancelled' && !it.seen);
  const out: QueueLine[] = [];
  const newest = (xs: QItem[]) => xs.map(x => x.ended ?? x.added).sort().at(-1) ?? '';
  for (const it of fresh.filter(x => x.state === 'needs')) {
    out.push({ key: `q-needs:${it.id}`, kind: 'needs', text: `${it.projectName || 'A project'} needs you.`, detail: it.error || it.result || 'A step needs your review.', action: 'Open the job', ids: [it.id], job: it.project, at: newest([it]) });
  }
  const byProject = (xs: QItem[]) => {
    const groups = new Map<string, QItem[]>();
    for (const x of xs) groups.set(x.project, [...(groups.get(x.project) ?? []), x]);
    return [...groups.values()];
  };
  for (const g of byProject(fresh.filter(x => x.kind === 'picture' && x.state === 'done'))) {
    const name = g[0].projectName || '';
    const handed = g.filter(x => x.handed && !x.handed.startsWith('Not '));
    out.push({
      key: `q-photos:${g[0].project}`,
      kind: 'photos',
      text: `Review photos${name ? ` for ${name}` : ''}.`,
      detail: [`${plural(g.length, 'picture')} drawn: ${g.slice(0, 3).map(x => `"${short(x.prompt || x.title, 40)}"`).join(', ')}${g.length > 3 ? '…' : ''}`, name ? (handed.length === g.length ? `in ${name}'s specialists\\images` : `${handed.length} of ${g.length} in ${name}'s specialists\\images`) : 'in the gallery'].join(' · '),
      action: 'See them',
      ids: g.map(x => x.id),
      ...(g[0].project ? { job: g[0].project } : {}),
      at: newest(g),
    });
  }
  for (const g of byProject(fresh.filter(x => x.kind === 'project' && x.state === 'done'))) {
    out.push({ key: `q-docs:${g[0].project}`, kind: 'documents', text: `Review documents for ${g[0].projectName || 'a project'}.`, detail: g.map(x => x.result || 'Its steps ran.').join(' '), action: 'Open the job', ids: g.map(x => x.id), job: g[0].project, at: newest(g) });
  }
  const byChat = new Map<string, QItem[]>();
  for (const x of fresh.filter(y => y.kind === 'chat' && y.state === 'done')) byChat.set(x.chat ?? '', [...(byChat.get(x.chat ?? '') ?? []), x]);
  for (const [chat, g] of byChat) {
    const title = chatTitle(chat);
    out.push({ key: `q-reply:${chat}`, kind: 'reply', text: stop(`Reply and answer${title ? `: ${short(title, 50)}` : ''}`), detail: g.length > 1 ? `${plural(g.length, 'answer')} came back to your queued messages.` : g[0].result || 'An answer came back to your queued message.', action: 'Open the chat', ids: g.map(x => x.id), chat, at: newest(g) });
  }
  for (const it of fresh.filter(x => x.state === 'failed')) {
    out.push({ key: `q-failed:${it.id}`, kind: 'failed', text: stop(`Did not finish: ${short(it.title, 60)}`), detail: it.error || 'It stopped without saying why.', action: 'See the queue', ids: [it.id], ...(it.project ? { job: it.project } : {}), at: newest([it]) });
  }
  return out;
}

/** The queue's count line: what is waiting and running, and whether it is paused. */
export function countLine(q: Queue): string {
  const waiting = q.items.filter(x => x.state === 'waiting').length;
  const running = q.items.filter(x => x.state === 'running').length;
  if (!waiting && !running) return q.paused ? 'Paused · nothing in line' : 'Nothing in line';
  return [q.paused ? 'Paused' : '', running ? `${running} running` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(' · ');
}

/** True when a fault means the PC was busy or off for now (the item is put back and tried again), not that it failed. */
export function forNow(error: string): boolean {
  return /\bbusy\b|answering something else|drawing something else|still drawing|is drawing|could not be reached|not answering|is off\b|log off|being used by its owner|still loading|is answering now|unloaded before the picture started/i.test(error);
}

/**
 * A queued chat message's stage on its line, from what its answer says as it goes (the events a chat page is sent):
 * loading, asked, working it out, writing. Anything else leaves the stage as it was.
 */
export function chatStage(event: string, data: Record<string, unknown>, was: string): string {
  if (event === 'status' && typeof data.text === 'string' && data.text.trim()) return data.text.trim().replace(/…$|\.{3}$/, '').slice(0, 120);
  if (event === 'brain') return typeof data.ran === 'string' && data.ran ? `Asked: ${data.ran}`.slice(0, 120) : 'Asked';
  if (event === 'thinking') return typeof data.seconds === 'number' && data.seconds > 0 ? `Working it out (${Math.round(data.seconds)} s)` : 'Working it out';
  if (event === 'text') return 'Writing the answer';
  return was;
}
