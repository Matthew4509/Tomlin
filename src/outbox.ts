// Work that survives the host. A node finishes what a linked PC asked even when that PC goes away (it was closed, went
// to sleep or lost the network): each answer, project step or picture asked with a request id ("rid") runs to its end
// on the node, and what it
// wrote waits in an outbox on the node's own disk, sealed with that link's keys, until the linked PC collects it or
// three days pass. Asking again with the same id joins the answer still running, or gets the finished one at once:
// the work is never done twice. The host keeps a list of the answers it is still owed (`Owed`) and puts each one into
// its chat when it comes in: at Reconnect, at every start, and once a minute.
// The node's side is the Outbox class; the host's side is `owedLine` and `settle`. Tested in test/outbox.test.ts.
import { randomBytes, createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.ts';
import type { ChatLine } from './store.ts';

/** How long a finished answer waits on the node for its PC to collect it. */
export const KEEP_MS = 3 * 24 * 3600_000;

const RID = /^[a-f0-9]{16,64}$/;
const OWNER = /^[a-f0-9]{6,32}$/;
export const cleanRid = (x: unknown): string | null => (typeof x === 'string' && RID.test(x) ? x : null);
export const newRid = () => randomBytes(12).toString('hex');
/** The id of a request from what it asks: the same step asked again (the host started again) finds the same answer. */
export const ridOf = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);

/** What an answer came to, as kept: its words, and the done line (model, speed, working) or the fault. */
export interface Kept {
  state: 'done' | 'error';
  text: string;
  /** The last line as sent: the done line of an answer, or the picture itself (png, model, seconds) of a drawing. */
  done?: Record<string, unknown>;
  /** The event that ended it when it was not "done": "picture" for a drawing (2.0.89 on). */
  event?: 'picture';
  error?: string;
  /** A fault's record sent with its error (a runner crash: the crash notice), kept so a late collection still shows it. */
  fault?: unknown;
  at: string;
}

/** The events that end a piece of work and are kept: an answer's done line, a drawing's picture, or a fault. */
const FINAL = new Set(['done', 'picture', 'error']);

/** A kept piece of work as the events it was first sent as: its words (an answer), then its last line or its fault. */
export function replayOf(k: Kept): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (k.text) out.push(['text', { text: k.text }]);
  if (k.state === 'done') out.push([k.event ?? 'done', k.done ?? {}]);
  else out.push(['error', { text: k.error ?? 'it stopped part-way.', ...(k.fault ? { fault: k.fault } : {}) }]);
  return out;
}

/** One page or PC following an answer: its events, and the end of its stream. */
export interface Follower {
  send: (event: string, data: unknown) => void;
  end: () => void;
}

/** Seals what is kept on the disk with the link's keys (src/link.ts), and opens it again. */
export interface Lock {
  seal: (plain: Buffer, label: string) => Buffer;
  open: (raw: Buffer, label: string) => Buffer | null;
}

/** The events a late follower is given first: the newest of each (each holds all of it so far). */
const LATEST = new Set(['text', 'status', 'thinking']);

interface Running {
  said: Map<string, unknown>;
  followers: Set<Follower>;
  ac: AbortController;
  text: string;
  stopped: boolean;
}

/** How much one link may have kept here at once: answers and bytes. Past it, that link's oldest go first. */
export interface KeptCap {
  count: number;
  bytes: number;
}
/** A host's own link: generous. */
export const HOST_KEPT: KeptCap = { count: 500, bytes: 500 * 2 ** 20 };
/** A guest's link: small (a guest has one request in the line at a time, and collects as it goes). */
export const GUEST_KEPT: KeptCap = { count: 20, bytes: 20 * 2 ** 20 };

export class Outbox {
  private readonly running = new Map<string, Running>();
  private readonly dir: string;
  private readonly capOf: (owner: string) => KeptCap;
  /** `capOf`: how much the link `owner` may have kept here (HOST_KEPT unless said). */
  constructor(dir: string, capOf: (owner: string) => KeptCap = () => HOST_KEPT) {
    this.dir = dir;
    this.capOf = capOf;
  }

  private key = (owner: string, rid: string) => `${owner}-${rid}`;
  private file = (owner: string, rid: string) => join(this.dir, `${owner}-${rid}.box`);

  /** Answers running now (for a node's "busy" and its restart guard). */
  get size(): number {
    return this.running.size;
  }

  isRunning(owner: string, rid: string): boolean {
    return this.running.has(this.key(owner, rid));
  }

  /**
   * Starts an answer (or a drawing) that runs to its end even when everyone following it leaves. `work` writes through
   * `send`; a done, picture or error event ends it, and what it came to is kept (sealed) until taken. Stop (`stop`) ends it and keeps
   * nothing.
   */
  start(owner: string, rid: string, lock: Lock, first: Follower, work: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>): void {
    if (!OWNER.test(owner) || !RID.test(rid)) throw new Error('not a request this PC can keep.');
    const k = this.key(owner, rid);
    const r: Running = { said: new Map(), followers: new Set([first]), ac: new AbortController(), text: '', stopped: false };
    this.running.set(k, r);
    let kept = null as Kept | null;
    /** The done (or error) line: sent only once the answer is on the disk, so "taken" can never come before it. */
    let last = null as { event: string; data: unknown } | null;
    const tell = (event: string, data: unknown) => {
      for (const f of r.followers) {
        try {
          f.send(event, data);
        } catch {
          r.followers.delete(f);
        }
      }
    };
    const send = (event: string, data: unknown) => {
      if (last) return;
      const d = (data ?? {}) as Record<string, unknown>;
      if (LATEST.has(event)) r.said.set(event, data);
      if (event === 'text') r.text = String(d.text ?? '');
      if (event === 'done') kept = { state: 'done', text: r.text, done: d, at: new Date().toISOString() };
      if (event === 'picture') kept = { state: 'done', text: '', done: d, event: 'picture', at: new Date().toISOString() };
      if (event === 'error') kept = { state: 'error', text: r.text, error: String(d.text ?? 'it stopped part-way'), ...(d.fault && typeof d.fault === 'object' ? { fault: d.fault } : {}), at: new Date().toISOString() };
      if (FINAL.has(event)) last = { event, data };
      else tell(event, data);
    };
    void (async () => {
      try {
        await work(send, r.ac.signal);
      } catch (e) {
        send('error', { text: (e as Error).message });
      }
      if (!last) send('error', { text: 'it stopped before it finished.' });
      try {
        if (!r.stopped) await this.keep(owner, rid, lock, kept!);
        // Stop came while it was being written: nothing of it is kept.
        if (r.stopped) await this.take(owner, rid);
      } catch {
        // The disk refused: the answer is still sent to whoever follows it.
      } finally {
        tell(last!.event, last!.data);
        this.running.delete(k);
        for (const f of r.followers) f.end();
      }
    })();
  }

  /** Follows an answer still running: what it said so far, then the rest. False when none is running by that id. */
  join(owner: string, rid: string, f: Follower): boolean {
    const r = this.running.get(this.key(owner, rid));
    if (!r) return false;
    // A status from before the words began ("loaded in 5 s") is old news once they have.
    for (const [event, data] of r.said) if (!(event === 'status' && r.said.has('text'))) f.send(event, data);
    r.followers.add(f);
    return true;
  }

  /** Where an answer is: still running (with its words so far), finished (kept), or not here at all. */
  async where(owner: string, rid: string, lock: Lock): Promise<{ state: 'working'; text: string } | Kept | null> {
    const r = this.running.get(this.key(owner, rid));
    if (r) return { state: 'working', text: r.text };
    return this.kept(owner, rid, lock);
  }

  /**
   * The PC that asked comes back for work asked with this id: it follows the work still running, or is given the kept
   * result at once (`replay`). `follow` is made only when the work is running (it starts the reply). False when neither is here: the work is to be started (or refused) as new. Checked
   * before anything else on the door, so a busy or away node still hands back what it already did.
   */
  async collect(owner: string, rid: string, lock: Lock, follow: () => Follower, replay: (k: Kept) => void): Promise<boolean> {
    if (this.isRunning(owner, rid)) return this.join(owner, rid, follow());
    const had = await this.kept(owner, rid, lock);
    if (!had) return false;
    replay(had);
    return true;
  }

  /** Something is here for that id: running, or kept and not yet taken. */
  async holds(owner: string, rid: string, lock: Lock): Promise<boolean> {
    return this.isRunning(owner, rid) || !!(await this.kept(owner, rid, lock));
  }

  async kept(owner: string, rid: string, lock: Lock): Promise<Kept | null> {
    if (!OWNER.test(owner) || !RID.test(rid)) return null;
    const raw = await readFile(this.file(owner, rid)).catch(() => null);
    const plain = raw ? lock.open(raw, `outbox|${rid}`) : null;
    if (!plain) return null;
    try {
      const k = JSON.parse(plain.toString('utf8')) as Kept;
      return k.state === 'done' || k.state === 'error' ? k : null;
    } catch {
      return null;
    }
  }

  private async keep(owner: string, rid: string, lock: Lock, k: Kept): Promise<void> {
    await writeAtomic(this.file(owner, rid), lock.seal(Buffer.from(JSON.stringify(k)), `outbox|${rid}`));
    await this.trim(owner, `${owner}-${rid}.box`).catch(() => undefined);
  }

  /** One link's kept answers over its cap (count or bytes): its oldest are removed first; the one just kept stays. */
  private async trim(owner: string, newest: string): Promise<void> {
    const cap = this.capOf(owner);
    const mine: { name: string; at: number; bytes: number }[] = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.startsWith(`${owner}-`) || !name.endsWith('.box') || !RID.test(name.slice(owner.length + 1, -4))) continue;
      const s = await stat(join(this.dir, name)).catch(() => null);
      if (s) mine.push({ name, at: name === newest ? Infinity : s.mtimeMs, bytes: s.size });
    }
    mine.sort((a, b) => a.at - b.at);
    let count = mine.length;
    let bytes = mine.reduce((n, x) => n + x.bytes, 0);
    for (const x of mine) {
      if (count <= cap.count && bytes <= cap.bytes) break;
      if (x.name === newest) break;
      await rm(join(this.dir, x.name), { force: true }).catch(() => undefined);
      count--;
      bytes -= x.bytes;
    }
  }

  /** The PC has it now: the kept answer is removed. */
  async take(owner: string, rid: string): Promise<void> {
    if (OWNER.test(owner) && RID.test(rid)) await rm(this.file(owner, rid), { force: true });
  }

  /** Stop pressed on the PC that asked: the answer ends, and nothing of it is kept. */
  async stop(owner: string, rid: string): Promise<boolean> {
    const r = this.running.get(this.key(owner, rid));
    if (r) {
      r.stopped = true;
      r.ac.abort();
    }
    await this.take(owner, rid);
    return !!r;
  }

  /**
   * The same PC linked again and proved it held the old keys: every answer kept for `owner` is opened with the old keys
   * and sealed again with the new ones, so it can still be collected. Each keeps its time on the disk (its three days run
   * from when it was kept, not from now). One that does not open with the old keys is left as it was. Returns how many.
   */
  async reseal(owner: string, from: Lock, to: Lock): Promise<number> {
    if (!OWNER.test(owner)) return 0;
    let done = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const rid = name.startsWith(`${owner}-`) && name.endsWith('.box') ? name.slice(owner.length + 1, -4) : '';
      if (!RID.test(rid)) continue;
      const file = join(this.dir, name);
      const s = await stat(file).catch(() => null);
      const raw = await readFile(file).catch(() => null);
      const plain = raw ? from.open(raw, `outbox|${rid}`) : null;
      if (!s || !plain) continue;
      try {
        await writeAtomic(file, to.seal(plain, `outbox|${rid}`));
        await utimes(file, s.atime, s.mtime).catch(() => undefined);
        done++;
      } catch {
        // Left sealed with the old keys: that answer is lost to the new link, the others still move.
      }
    }
    return done;
  }

  /** Answers kept longer than three days (their PC never came back for them) are removed. */
  async sweep(now = Date.now()): Promise<number> {
    let gone = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.box')) continue;
      const at = (await stat(join(this.dir, name)).catch(() => null))?.mtimeMs ?? now;
      if (now - at > KEEP_MS) {
        await rm(join(this.dir, name), { force: true }).catch(() => undefined);
        gone++;
      }
    }
    return gone;
  }
}

// ---- The host's side: the answers it is still owed ----

/** An answer a linked PC is still writing for a chat here (kept in data/owed.json until it comes in). */
export interface Owed {
  rid: string;
  /** The linked PC (its id) and its name when it was asked. */
  pc: string;
  name: string;
  chatId: string;
  /** Where it was made ("Qwen 3 4B on Worker PC"), for the line under the answer. */
  ran: string;
  at: string;
}

export function cleanOwed(raw: unknown): Owed[] {
  return (Array.isArray(raw) ? raw : []).flatMap((x: Record<string, unknown>) => {
    const rid = cleanRid(x?.rid);
    const chatId = typeof x?.chatId === 'string' && /^[a-f0-9]{12}$/.test(x.chatId) ? x.chatId : null;
    if (!rid || !chatId || typeof x.pc !== 'string') return [];
    return [{ rid, pc: x.pc.slice(0, 40), name: String(x.name ?? '').slice(0, 40), chatId, ran: String(x.ran ?? '').slice(0, 200), at: String(x.at ?? '') }];
  });
}

/**
 * How long an owed answer is asked for while its PC does not answer: the node keeps a finished answer KEEP_MS, so a
 * day more than that after it was asked, it cannot be there any more. Without an end, a PC that never came back was
 * asked once a minute for ever, and the chat said "still working on it" for ever.
 */
export const OWED_GIVE_UP_MS = KEEP_MS + 24 * 3600_000;

/** An owed answer whose PC has not answered for so long that the answer cannot be collected any more. */
export function owedExpired(o: Pick<Owed, 'at'>, now = Date.now()): boolean {
  const at = Date.parse(o.at);
  return Number.isFinite(at) && now - at > OWED_GIVE_UP_MS;
}

/** Why an owed answer was given up (owedExpired), as the note under it says. */
export const owedExpiredWhy = (name: string) => `${name || 'That PC'} did not answer for over ${Math.round(OWED_GIVE_UP_MS / (24 * 3600_000))} days, and it keeps a finished answer for ${Math.round(KEEP_MS / (24 * 3600_000))} days only, so this answer cannot be collected any more. Send your message again.`;

/** The line that stands in a chat for an answer still owed: the words so far (or none), and who is writing it. */
export function owedLine(o: Owed, text = ''): ChatLine {
  return { role: 'assistant', content: text, at: o.at || new Date().toISOString(), ran: o.ran, waiting: { rid: o.rid, pc: o.pc, name: o.name } };
}

/** The chat with a stand-in line for `o`: added at the end when the host stopped before it could write one. */
export function withOwedLine(lines: ChatLine[], o: Owed): ChatLine[] | undefined {
  return lines.some(l => l.waiting?.rid === o.rid) ? undefined : [...lines, owedLine(o)];
}

/**
 * What the node said about an owed answer, put into the chat: the whole answer in place of its stand-in line, the
 * words so far while it still works, or why it cannot come (with the words so far kept). Undefined when nothing changes.
 */
export function settle(lines: ChatLine[], rid: string, said: { state: 'working'; text: string } | Kept | { state: 'gone'; why: string }): ChatLine[] | undefined {
  const i = lines.findIndex(l => l.waiting?.rid === rid);
  if (i < 0) return undefined;
  const was = lines[i];
  let line: ChatLine;
  if (said.state === 'working') {
    if (!said.text || said.text === was.content) return undefined;
    line = { ...was, content: said.text };
  } else if (said.state === 'done') {
    const d = said.done ?? {};
    const speed = d.speed as { write?: unknown } | null | undefined;
    const t = d.thought as { text?: unknown; seconds?: unknown } | null | undefined;
    const { waiting: _w, note: _n, ...rest } = was;
    line = { ...rest, content: said.text, at: new Date().toISOString(), ...(Number(speed?.write) > 0 ? { perSecond: Number(speed!.write) } : {}), ...(t && typeof t.text === 'string' && t.text ? { thought: { text: t.text.slice(-40_000), seconds: Math.max(0, Math.round(Number(t.seconds) || 0)) } } : {}), ...(d.cut === true ? { cut: true } : {}), note: `Collected from ${was.waiting!.name} after the connection was lost.` };
  } else {
    const { waiting: _w, ...rest } = was;
    const text = (said.state === 'error' ? said.text : '') || was.content;
    line = { ...rest, content: text ? `${text.trimEnd()} …` : '', note: said.state === 'gone' ? said.why : `${was.waiting!.name} stopped part-way: ${said.error}. Send your message again.` };
  }
  return [...lines.slice(0, i), line, ...lines.slice(i + 1)];
}
