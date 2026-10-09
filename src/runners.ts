// Chat runners on this PC: more than one chat model can be loaded at once, each in its own llama-server. A loaded model
// stays until someone drops it (the top bar) or another model needs its place: a new model goes beside the loaded ones
// when it fits in the memory free now, else in place of the least recently used one that is not answering; otherwise it
// is refused in plain words. Pure: the server gives what each runner holds and what is free, and this says where the
// model goes.

const GB = 2 ** 30;
const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;

/** The most chat models loaded at once (memory is the real limit; this stops a runaway). */
export const MAX_RUNNERS = 4;

/** One runner as it stands: the model it holds (null when empty), its state, the memory it holds, whether it answers now. */
export interface RunnerLook {
  model: string | null;
  name: string;
  state: string;
  /** Memory it holds now (bytes; 0 when empty). */
  ram: number;
  /** When it last answered (ms), for choosing which model goes first when one has to make room. */
  usedAt: number;
  /** Answering something now (never swapped out from under its answer). */
  busy?: boolean;
}

export type Place =
  | { index: number; already: true }
  | { index: number; already: false; replaces: string | null; level: 'ok' | 'tight' }
  | { error: string };

const live = (r: RunnerLook) => !!r.model && (r.state === 'connected' || r.state === 'loading');

/**
 * Where model `id` goes: the runner that has it already; else, when nothing is loaded, the first runner; else beside
 * the loaded ones (an empty runner, or a new one up to MAX_RUNNERS) when it fits in what is free; else in place of the
 * least recently used model that is loaded and not answering (its memory counts as free). `need`: memory the model
 * needs with its context; `free`: memory free now.
 */
export function place(id: string, name: string, need: number, free: number, rs: RunnerLook[], max = MAX_RUNNERS): Place {
  const has = rs.findIndex(r => live(r) && r.model === id);
  if (has >= 0) return { index: has, already: true };
  if (!rs.some(live)) {
    if (need > free + 2 * GB) return { error: tooBig(name, need, free, null) };
    return { index: 0, already: false, replaces: null, level: need <= free ? 'ok' : 'tight' };
  }
  const empty = rs.findIndex(r => !live(r));
  const slot = empty >= 0 ? empty : rs.length < max ? rs.length : -1;
  if (slot >= 0 && need <= free) return { index: slot, already: false, replaces: null, level: 'ok' };
  // A model that is loading is not swapped out from under its own load, nor one answering now.
  const swap = rs.map((r, i) => ({ r, i })).filter(x => live(x.r) && x.r.state === 'connected' && !x.r.busy).sort((a, b) => a.r.usedAt - b.r.usedAt)[0];
  if (swap) {
    const room = free + swap.r.ram;
    if (need > room + 2 * GB) return { error: tooBig(name, need, room, swap.r.name) };
    return { index: swap.i, already: false, replaces: swap.r.model, level: need <= room ? 'ok' : 'tight' };
  }
  if (slot >= 0 && need <= free + 2 * GB) return { index: slot, already: false, replaces: null, level: 'tight' };
  const others = rs.filter(live);
  const loading = others.filter(r => r.state === 'loading');
  if (loading.length) return { error: `${namesOf(loading)} ${loading.length > 1 ? 'are' : 'is'} still loading. Wait for it to finish, then load ${name}.` };
  if (slot < 0 || others.every(r => r.busy)) return { error: `${namesOf(others)} ${others.length > 1 ? 'are' : 'is'} answering now, and ${name} needs ${others.length > 1 ? 'the place of one of them' : 'its place'}. Wait for the answer to finish (or press Stop), then try again.` };
  return { error: tooBig(name, need, free, null) };
}

function tooBig(name: string, need: number, room: number, swapped: string | null): string {
  return `${name} needs about ${gb(need)} with its context, and only ${gb(room)} is free${swapped ? ` once ${swapped} is unloaded` : ''}. Close other programs (or drop a model with Drop in the top bar), or choose a smaller model or context.`;
}

/** "A", "A and B", "A, B and C". */
export function namesOf(rs: { name: string }[]): string {
  const n = rs.map(r => r.name);
  return n.length < 2 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

/**
 * The runner a chat with no model of its own answers on (the manager, enhance, alt text): the one holding `main` (the
 * model picked in the chat pane), else the first loaded one, else the first runner.
 */
export function mainIndex(rs: RunnerLook[], main: string | null): number {
  const m = main ? rs.findIndex(r => live(r) && r.model === main) : -1;
  if (m >= 0) return m;
  const first = rs.findIndex(r => r.state === 'connected');
  if (first >= 0) return first;
  const any = rs.findIndex(live);
  return any >= 0 ? any : 0;
}
