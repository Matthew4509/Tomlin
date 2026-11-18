// Tools over the link: a chat model on a linked PC may use the tools of the PC that asked (files, web, research, the
// subagent check ...). The model's loop (ask, read its calls, ask again) runs on the PC that holds the model, as it
// does for the web tools; what is different is who RUNS a call. The model's PC does not run it: it sends the call back
// on the open answer as a "tool" event, the asking PC runs it (with its own permissions, folder and cards) and posts
// the result to /worker/tool-result, and the loop goes on. So the model's PC never sees a folder, a page or a
// permission of the asking PC except the one result it was given.
//
// Host side (the PC that asked): toWire, hostHandler. Model's side (the node): cleanWire, nodeBox, ToolWaits.
// Tested in test/tooltalk.test.ts; the whole path with a real model in docs/handoffs/tests-2026-11-10-real-models.
import type { ToolBox } from '../engine.ts';

/** How long the model's PC waits for the asking PC to run one call (a permission card waits up to 10 minutes). */
export const TOOL_WAIT_MS = 15 * 60_000;
/** The most tools one answer may offer, and the biggest definition, argument and result taken over the link. */
export const MAX_DEFS = 48;
export const MAX_DEF_CHARS = 12_000;
export const MAX_ARGS_CHARS = 20_000;
export const MAX_RESULT_CHARS = 200_000;
export const MAX_ROUNDS = 24;

/** What goes over: the definitions the model is shown, how many rounds of calls, and which may run side by side. */
export interface WireTools {
  defs: unknown[];
  rounds: number;
  parallel: string[];
}

const nameOf = (def: unknown): string | null => {
  const f = (def as { function?: { name?: unknown } } | null)?.function;
  return typeof f?.name === 'string' && /^[A-Za-z_][\w-]{0,63}$/.test(f.name) ? f.name : null;
};

/** The asking PC's tool box as it goes over the link. */
export function toWire(box: Pick<ToolBox, 'defs' | 'rounds' | 'parallel'>): WireTools {
  const names = box.defs.map(nameOf).filter((n): n is string => !!n);
  return { defs: box.defs, rounds: box.rounds, parallel: box.parallel ? names.filter(n => box.parallel!(n)) : [] };
}

/** What the model's PC accepts from the wire: well-formed function definitions only, capped. Null: no tools asked. */
export function cleanWire(v: unknown): WireTools | null {
  const w = v as Partial<WireTools> | null | undefined;
  if (!w || typeof w !== 'object' || !Array.isArray(w.defs)) return null;
  const defs: unknown[] = [];
  const seen = new Set<string>();
  for (const d of w.defs) {
    const n = nameOf(d);
    if (!n || seen.has(n) || (d as { type?: unknown }).type !== 'function' || JSON.stringify(d).length > MAX_DEF_CHARS) continue;
    seen.add(n);
    defs.push(d);
    if (defs.length >= MAX_DEFS) break;
  }
  if (!defs.length) return null;
  const parallel = (Array.isArray(w.parallel) ? w.parallel : []).filter((n): n is string => typeof n === 'string' && seen.has(n));
  return { defs, rounds: Math.max(1, Math.min(MAX_ROUNDS, Math.floor(Number(w.rounds) || 1))), parallel };
}

/** Calls the model's PC has sent and is waiting on, by "link|rid|id". */
export class ToolWaits {
  private waits = new Map<string, (result: string) => void>();

  /** Waits for the result of one call: it comes, or the answer is stopped, or the time runs out. */
  wait(key: string, signal: AbortSignal, ms = TOOL_WAIT_MS): Promise<string> {
    return new Promise<string>(resolve => {
      const end = (text: string) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waits.delete(key);
        resolve(text);
      };
      const onAbort = () => end('The answer was stopped before this tool finished.');
      const timer = setTimeout(() => end('The tool did not give a result in time (the PC that asked did not answer).'), ms);
      this.waits.set(key, end);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** A result arrived: true when a call was waiting for it. */
  give(key: string, result: string): boolean {
    const end = this.waits.get(key);
    if (!end) return false;
    end(String(result).slice(0, MAX_RESULT_CHARS));
    return true;
  }

  get size(): number {
    return this.waits.size;
  }
}

/**
 * The model's PC: a tool box whose calls go back to the asking PC. `prefix` is "link|rid|", so one asking PC's answers
 * never meet another's. Calls by a name that was not offered are answered here, in words, and not sent.
 */
export function nodeBox(wire: WireTools, send: (event: string, data: Record<string, unknown>) => void, waits: ToolWaits, prefix: string): ToolBox {
  const offered = new Set(wire.defs.map(nameOf));
  const parallel = new Set(wire.parallel);
  let n = 0;
  return {
    defs: wire.defs,
    rounds: wire.rounds,
    parallel: name => parallel.has(name),
    run: async (name, args, signal, round) => {
      if (!offered.has(name)) return `There is no tool called "${name}".`;
      const id = `${round}-${++n}`;
      const wait = waits.wait(prefix + id, signal);
      send('tool', { id, name, args: String(args).slice(0, MAX_ARGS_CHARS), round });
      return wait;
    },
  };
}

/** The most calls the model's PC may have this PC run for one answer, whatever it says. */
export const MAX_HOST_CALLS = 64;

/**
 * The tools this PC offers to a PC it is only a guest on: none that reads or writes this PC's files, notes, screen or
 * commands (that PC's owner is not this PC's owner), only the web, sums and a finding shown to the person here.
 */
export const GUEST_SIDE_TOOLS: readonly string[] = ['web_search', 'open_page', 'calculate', 'suggest_finding'];

/** A tool box cut down to the tools named in `keep` (null: none left to offer). Calls by other names are refused here. */
export function onlyTools<T extends Pick<ToolBox, 'defs' | 'run'>>(box: T, keep: readonly string[]): T | null {
  const defs = box.defs.filter(d => keep.includes(nameOf(d) ?? ''));
  if (!defs.length) return null;
  return { ...box, defs, run: (name, args, signal, round) => (keep.includes(name) ? box.run(name, args, signal, round) : Promise.resolve(`There is no tool called "${name}".`)) };
}

/**
 * The asking PC: runs each call the model's PC sends, once (a connection that came back may send the same call again:
 * the result already got is posted again), and posts the result. Never throws: a tool that fails gives its words.
 * Only a tool it offered (by name), no more than MAX_HOST_CALLS calls, and no more rounds than it offered: the rounds
 * are counted here (each new round number the other PC gives is one more), never taken from the number it sends.
 */
export function hostHandler(box: Pick<ToolBox, 'run' | 'onCall' | 'defs' | 'rounds'>, signal: AbortSignal, post: (id: string, result: string) => Promise<unknown>): (data: Record<string, unknown>) => void {
  const calls = new Map<string, Promise<string>>();
  const offered = new Set(box.defs.map(nameOf).filter((n): n is string => !!n));
  /** The round numbers the other PC has used, in the order they came: a call's round here is its place in this list. */
  const rounds: string[] = [];
  let ran = 0;
  return data => {
    const id = typeof data.id === 'string' ? data.id.slice(0, 40) : '';
    const name = typeof data.name === 'string' ? data.name : '';
    if (!id || !name) return;
    const args = typeof data.args === 'string' ? data.args : '';
    let call = calls.get(id);
    if (!call) {
      // Every new call is counted, whatever its name or round: past twice the cap, the other PC is sending without end
      // (calls by names never offered, or in ever new rounds), and a new one gets no answer at all.
      if (calls.size >= MAX_HOST_CALLS * 2) return;
      const said = String(data.round ?? '').slice(0, 20);
      if (!rounds.includes(said)) rounds.push(said);
      const round = rounds.indexOf(said);
      if (++ran > MAX_HOST_CALLS) call = Promise.resolve(`This PC runs no more than ${MAX_HOST_CALLS} tool calls for one answer. Answer with what you have.`);
      else if (!offered.has(name)) call = Promise.resolve(`There is no tool called "${name}".`);
      else if (round >= Math.max(1, box.rounds)) call = Promise.resolve(`This PC runs tools for no more than ${Math.max(1, box.rounds)} rounds in one answer. Answer with what you have.`);
      if (call) {
        calls.set(id, call);
        void call.then(result => post(id, result)).catch(() => undefined);
        return;
      }
      try {
        box.onCall?.(name, args);
      } catch {
        // Saying what it is doing is never allowed to stop the call.
      }
      call = box.run(name, args, signal, round).then(
        r => String(r).slice(0, MAX_RESULT_CHARS),
        e => `The tool failed: ${(e as Error).message}`,
      );
      calls.set(id, call);
    }
    void call.then(result => post(id, result)).catch(() => undefined);
  };
}
