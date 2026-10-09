// Work that survives the host. A node finishes what a linked PC asked even when that PC goes away (it was closed, went
// to sleep or lost the network): each answer asked with a request id ("rid") runs to its end on the node, and what it
// wrote waits in an outbox on the node's own disk, sealed with that link's keys, until the linked PC collects it or
// three days pass. Asking again with the same id joins the answer still running, or gets the finished one at once:
// the work is never done twice. The host keeps a list of the answers it is still owed (`Owed`) and puts each one into
// its chat when it comes in: at Reconnect, at every start, and once a minute.
// The node's side is the Outbox class; the host's side is `owedLine` and `settle`. Tested in test/outbox.test.ts.
import { randomBytes, createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
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
  done?: Record<string, unknown>;
  error?: string;
  at: string;
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

export class Outbox {
  private readonly running = new Map<string, Running>();
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
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
   * Starts an answer that runs to its end even when everyone following it leaves. `work` writes through `send`;
   * a done or error event ends it, and what it came to is kept (sealed) until taken. Stop (`stop`) ends it and keeps
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
      if (event === 'error') kept = { state: 'error', text: r.text, error: String(d.text ?? 'it stopped part-way'), at: new Date().toISOString() };
      if (event === 'done' || event === 'error') last = { event, data };
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
