// "At once" on a node: how many answers one chat model may write together for linked PCs. 1 (the default) is the line,
// one at a time, and starts the runner exactly as before (no slot flag: llama.cpp's own default). 2, 3 or 4 start
// llama-server with that many slots (--parallel N, continuous batching), each keeping the context the model is set to,
// so the runner gets N times the context, and with --no-kv-unified each slot holds only its own request's words. Only
// as many as fit in memory with that context, only on a runner build that takes --parallel, and not with Max mode or
// expert parallel (their own split of the memory): fewer is said on the page. Whether it is faster is not measured here
// (tools/slotspeed.ts measures it on a real PC). Plain functions, tested in test/slots.test.ts.
import { spawnSync } from 'node:child_process';

/** 1, 2, 3 or 4; anything else is 1. */
export const cleanAtOnce = (v: unknown): number => {
  const n = Number(v);
  return [1, 2, 3, 4].includes(n) ? n : 1;
};

/** The most slots, up to `want`, whose memory (`need(n)`: the model and n contexts) fits in `free`; at least 1. */
export function slotsThatFit(want: number, need: (n: number) => number, free: number): number {
  for (let n = Math.max(1, want); n > 1; n--) if (need(n) <= free) return n;
  return 1;
}

/** What a runner build takes, from its --help: slots (--parallel), and a context of their own each (--no-kv-unified). */
export function parallelSupport(help: string): { parallel: boolean; split: boolean } {
  return { parallel: /--parallel\b/.test(help), split: /--no-kv-unified\b/.test(help) };
}

/** Each runner build's --help, read once (it prints at once and starts nothing). */
const helps = new Map<string, string>();
export function runnerHelp(exe: string): string {
  let h = helps.get(exe);
  if (h === undefined) {
    try {
      const r = spawnSync(exe, ['--help'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      h = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    } catch {
      h = '';
    }
    helps.set(exe, h);
  }
  return h;
}

/**
 * The slots a load starts with, and what to say when it is fewer than asked. `plain`: an ordinary load (not Max mode
 * or expert parallel). `need(n)`: the memory with n contexts; `free`: what is free for it.
 */
export function slotPlan(o: { want: number; support: { parallel: boolean; split: boolean }; need: (n: number) => number; free: number; plain: boolean }): { n: number; note: string } {
  if (o.want <= 1) return { n: 1, note: '' };
  if (!o.plain) return { n: 1, note: `At once is ${o.want}, but this model loads with Max mode or expert parallel, which share out the memory their own way: it answers one at a time.` };
  if (!o.support.parallel) return { n: 1, note: `At once is ${o.want}, but this PC's llama.cpp runner cannot run more than one answer together: it answers one at a time. A newer runner (Network, Runner) can.` };
  const n = slotsThatFit(o.want, o.need, o.free);
  return { n, note: n < o.want ? `${n === 1 ? 'One' : n} at once (${o.want} asked): each one keeps the model's whole context, and only ${n} fit${n === 1 ? 's' : ''} in the memory free now.` : '' };
}

/** How many a model should load with: set by the node (src/jobrun/node.ts) from its At once; 1 when this PC is not a node. */
export const slotWant: { want: (model: string) => number } = { want: () => 1 };
