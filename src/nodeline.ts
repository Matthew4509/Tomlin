// A node's line: every request from a linked PC for an answer or a picture (chat, text, coding and pictures together:
// a picture model and a chat model on one card fight over its memory) waits its turn here, first come, first served.
// The host's own links (no role) go before guests when "Host goes first" is on (the default), first come among each.
// A guest has one request in the line at a time. Each one waiting is told its place, with an estimate from how long
// that model's answers took here lately; one that waits longer than LINE_WAIT_MS is let go. Up to `slots` run at once
// (1 unless the owner turns "At once" up). A linked PC from before the line is told "busy" as before while anyone is
// in it. Also here: the caps on a guest's answer and prompt, and the rule for a guest's load (L3): it never takes the
// place of a model that is answering, or one the PC's owner used in the last OWNER_IDLE_MS. Plain functions, tested in
// test/nodeline.test.ts; the line at a real door in test/nodeline-door.test.ts.
import { randomBytes } from 'node:crypto';
import type { ToolBox } from './engine.ts';
import { cleanWire } from './jobrun/tooltalk.ts';

/** How long a request may wait in the line before it is let go (it is told so). */
export const LINE_WAIT_MS = 20 * 60_000;
export const STUCK_WORDS = 'waited 20 minutes in the line there without its turn coming, so it was let go. Ask again later.';
/** A guest's load waits while the model it would take the place of was used by the PC's owner this recently. */
export const OWNER_IDLE_MS = 5 * 60_000;

export interface LineEntry {
  id: string;
  /** The link it came on (its keep id): a guest's one request is counted by it. */
  link: string;
  name: string;
  guest: boolean;
  what: 'chat' | 'picture';
  model: string;
  /** When it joined. */
  at: number;
  /** When its turn came (it is running); absent while it waits. */
  started?: number;
}

export class NodeLine {
  private all: LineEntry[] = [];
  private o: { hostFirst: () => boolean; slots: (model: string) => number; now: () => number };
  /** `slots(model)`: how many answers on that chat model may run together (At once, src/slots.ts); 1 by default. */
  constructor(o: { hostFirst: () => boolean; slots: (model: string) => number; now?: () => number }) {
    this.o = { now: () => Date.now(), ...o };
  }
  /** Joins the line; a guest with a request in it already (waiting or running) is told so. */
  join(e: Omit<LineEntry, 'id' | 'at' | 'started'>): LineEntry | { error: string; place: number } {
    const mine = e.guest ? this.all.find(x => x.link === e.link) : undefined;
    if (mine) return { error: 'a guest has one request in the line at a time there: this one waits for the one before it', place: this.place(mine.id) };
    const entry: LineEntry = { ...e, id: randomBytes(6).toString('hex'), at: this.o.now() };
    this.all.push(entry);
    return entry;
  }
  /** Leaves the line: done, stopped, gone, or let go. */
  leave(id: string): void {
    this.all = this.all.filter(x => x.id !== id);
  }
  /** Its turn came: it runs now. */
  start(id: string): void {
    const e = this.all.find(x => x.id === id);
    if (e && !e.started) e.started = this.o.now();
  }
  /** The ones waiting, in the order their turns come. */
  waiting(): LineEntry[] {
    const w = this.all.filter(x => !x.started);
    if (!this.o.hostFirst()) return w;
    return [...w.filter(x => !x.guest), ...w.filter(x => x.guest)];
  }
  running(): LineEntry[] {
    return this.all.filter(x => !!x.started);
  }
  /** Its place among those waiting (1 = next), 0 when it is not waiting. */
  place(id: string): number {
    return this.waiting().findIndex(x => x.id === id) + 1;
  }
  /**
   * Whether it may start now: it is next, and nothing runs, or (At once) only answers on the same chat model run and a
   * slot of it is free. A picture, or another model, waits for the card to be free.
   */
  mayStart(id: string): boolean {
    if (this.place(id) !== 1) return false;
    const e = this.all.find(x => x.id === id)!;
    const run = this.running();
    if (!run.length) return true;
    if (e.what !== 'chat' || run.some(r => r.what !== 'chat' || r.model !== e.model)) return false;
    return run.length < Math.max(1, this.o.slots(e.model));
  }
  /** Ones that waited too long. */
  stuck(): LineEntry[] {
    return this.waiting().filter(x => this.o.now() - x.at > LINE_WAIT_MS);
  }
  /** A linked PC from before the line: busy while anyone is in it (it would otherwise jump the line). */
  busyForOld(): boolean {
    return this.all.length > 0;
  }
  /** Who is running and who is waiting, for the node's page. */
  view(names: (model: string) => string = m => m) {
    const now = this.o.now();
    const one = (x: LineEntry, since: number) => ({ name: x.name, guest: x.guest, what: x.what, model: names(x.model), seconds: Math.round((now - since) / 1000) });
    return { running: this.running().map(x => one(x, x.started!)), waiting: this.waiting().map(x => one(x, x.at)) };
  }
}

/** How long each model's answers (or pictures) took here lately: the last 10, by model. */
export class AnswerTimes {
  private by = new Map<string, number[]>();
  note(model: string, ms: number): void {
    if (!(ms > 0)) return;
    this.by.set(model, [...(this.by.get(model) ?? []), ms].slice(-10));
  }
  /** Their average (ms), or null when none was measured. */
  average(model: string): number | null {
    const t = this.by.get(model);
    return t?.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
  }
}

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/**
 * What one waiting is told: its place, and about how long, from that model's recent answers here (the ones ahead and
 * the ones running each take about that long); just the place when nothing was measured.
 */
export function lineWords(place: number, running: number, averageMs: number | null): string {
  const ahead = place - 1 + running;
  const s = averageMs === null ? null : Math.round((ahead * averageMs) / 1000);
  const about = s === null || ahead <= 0 ? '' : s < 90 ? `, about ${Math.max(1, s)} s` : `, about ${Math.round(s / 60)} min`;
  return `${ordinal(place)} in line${about}. It starts when its turn comes (or press Stop).`;
}

// ---- The caps on a guest's work here (the node's owner may change them; a guest is told them in its hello) ----

/** By default a guest's answer is up to 2000 tokens and its prompt (everything sent) up to 32,000 characters (about 8,000 tokens). */
export const GUEST_CAPS = { answer: 2000, prompt: 32000 } as const;
/**
 * What a guest may do here. `answer` and `prompt`: the sizes, 0 for no limit (a test cluster for people to try). `web`:
 * search and read pages through this PC. `tools`: let the model use the tools of the guest's own app. Both on unless
 * the owner turns them off, as before they could be.
 */
export interface GuestCaps { answer: number; prompt: number; web: boolean; tools: boolean }

export function cleanCaps(raw: unknown): GuestCaps {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number, dflt: number) => {
    if (v === 0 || v === '0' || v === 'none') return 0;
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x > 0 ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  return { answer: n(o.answer, 256, 32_000, GUEST_CAPS.answer), prompt: n(o.prompt, 1000, 200_000, GUEST_CAPS.prompt), web: o.web !== false, tools: o.tools !== false };
}

/** No limit on either size: a guest's tools are not held to rounds or room either. */
export const noLimits = (c: GuestCaps) => c.answer === 0 && c.prompt === 0;

/**
 * The room a guest's tools may give back (src/jobrun/node.ts boxFor): null for no guest limits at all; with a prompt
 * cap, what is left under it; with only the answer capped, all the room there is (the rounds and calls still count).
 */
export function guestRoomOf(c: GuestCaps, promptChars: number): number | null {
  if (noLimits(c)) return null;
  return c.prompt ? c.prompt - promptChars : Number.MAX_SAFE_INTEGER;
}

/** A guest's request with what the owner does not allow taken out: no web through this PC, no tools of its own. */
export function guestAllowed<T extends Record<string, unknown>>(body: T, c: GuestCaps): T {
  const out = { ...body };
  if (!c.web) delete out.web;
  if (!c.tools) delete out.tools;
  return out;
}

export const capAnswer = (asked: number, caps: GuestCaps) => (caps.answer ? Math.min(asked, caps.answer) : asked);

/** How long a guest's prompt is, in characters: the system words, the message, the turns and the tools it offers. */
export function promptSize(b: { system?: unknown; user?: unknown; turns?: unknown; tools?: unknown }): number {
  const turns = Array.isArray(b.turns) ? b.turns.reduce((n: number, t) => n + String((t as { content?: unknown })?.content ?? '').length, 0) : 0;
  // The tools it offers are put in front of the model too: counted as they would be taken over the link.
  const tools = cleanWire(b.tools)?.defs.reduce((n: number, d) => n + JSON.stringify(d).length, 0) ?? 0;
  return String(b.system ?? '').length + String(b.user ?? '').length + turns + tools;
}

/** Why a guest's prompt is too long here (null when it is not): every word sent counts. */
export function promptRefusal(b: { system?: unknown; user?: unknown; turns?: unknown; tools?: unknown }, caps: GuestCaps): string | null {
  if (!caps.prompt) return null;
  const size = promptSize(b);
  return size > caps.prompt ? `a guest's prompt there may be up to ${caps.prompt} characters, and this one is ${size}. Start a new chat, or send a shorter one.` : null;
}

/** A guest's answer may call tools for this many rounds at most, and this many times in all. */
export const GUEST_TOOL_ROUNDS = 4;
export const GUEST_TOOL_CALLS = 12;

/**
 * The tools of a guest's answer (its own, or the web tools here): no more than GUEST_TOOL_ROUNDS rounds and
 * GUEST_TOOL_CALLS calls, and what the tools give back counts against its prompt cap, as its prompt does (`room`: the
 * characters left under the cap once the prompt is counted). A result past the room is cut, and said so.
 */
export function guestBox(box: ToolBox, room: number): ToolBox {
  let left = Math.max(0, room);
  let calls = 0;
  return {
    ...box,
    rounds: Math.max(1, Math.min(box.rounds, GUEST_TOOL_ROUNDS)),
    run: async (name, args, signal, round) => {
      if (++calls > GUEST_TOOL_CALLS) return `A guest's answer here may call tools ${GUEST_TOOL_CALLS} times at most. Answer with what you have.`;
      if (left <= 0) return 'A guest\'s prompt here is full, so this tool was not run. Answer with what you have.';
      const got = String(await box.run(name, args, signal, round));
      if (got.length <= left) {
        left -= got.length;
        return got;
      }
      const part = got.slice(0, left);
      left = 0;
      return `${part}\n[The rest was left out: a guest's prompt here is full.]`;
    },
  };
}

export const capsWords = (c: GuestCaps) => [c.answer ? `answers up to ${c.answer} tokens` : 'answers of any length', c.prompt ? `prompts up to ${c.prompt} characters` : 'prompts of any length', c.web ? '' : 'no web', c.tools ? '' : 'no tools of its own'].filter(Boolean).join(', ');

// ---- Whether a request at the head of the line can start now ----

/**
 * A chat request at the head of the line: 'go', wait (and why: the model there is answering, there is no room yet, or
 * a guest's load would take the place of the owner's model in use), or refuse (it can never fit there). `placeError`:
 * what loading it here said, after models loaded for linked PCs made way; `loadedOrBusy`: something else is loaded or
 * running there, so room may come.
 */
export function chatTurn(f: { placeError: string | null; busy: boolean; loadedOrBusy: boolean; guest: boolean; replaces: { forLinked: boolean; busy: boolean; usedAt: number | null } | null; name: string; pc: string }, now = Date.now()): 'go' | { wait: string } | { refuse: string } {
  if (f.busy) return { wait: `${f.name} is answering someone else there.` };
  if (f.placeError) {
    if (f.loadedOrBusy) return { wait: `${f.name} waits for room there: another model is loaded or running.` };
    const need = /needs about ([\d.]+ ?[GMT]B)/.exec(f.placeError)?.[1];
    return { refuse: `${f.name} is too big for "${f.pc}" even with nothing else loaded there${need ? ` (it needs about ${need} with its context)` : ''}. Choose a smaller model or context.` };
  }
  const r = f.replaces;
  if (f.guest && r && !r.forLinked && (r.busy || (r.usedAt !== null && now - r.usedAt < OWNER_IDLE_MS))) return { wait: `${f.name} waits until the owner of "${f.pc}" has not used their model for ${OWNER_IDLE_MS / 60_000} minutes.` };
  return 'go';
}
