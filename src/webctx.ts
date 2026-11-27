// The context a chat needs when the web tools are on. A page read by the web tools takes a thousand tokens or two, so at
// the 8,192 tokens most models start with, two pages fill it and the answer ends with "no room left". With Web on, the
// model is therefore started (or asked to start) with a larger context, as large as the memory allows, up to WEB_CTX.
// This file only decides and words it; src/server/webctx.ts reloads a model here, and a linked PC is asked through the
// run-settings tick (/worker/ctx-set in src/jobrun/node.ts). Tested in test/webctx.test.ts.

/** The context sizes offered (tokens), smallest first. */
export const CONTEXT_SIZES = [4096, 8192, 16384, 32768, 65536, 131072, 262144];

/** The context (tokens) asked for when Web is on, when the model and the memory allow it. */
export const WEB_CTX = 32768;

export interface WebCtxIn {
  /** The context the model runs with now. */
  current: number;
  /** The sizes offered (src/server/panes.ts CONTEXTS), in order. */
  contexts: number[];
  /** The longest context the model was trained for (null when not known). */
  trained: number | null;
  /** Whether the model would still fit in memory with this context. */
  fits: (ctx: number) => boolean;
  /** What to aim for (WEB_CTX unless given). */
  want?: number;
}

export interface WebCtxPlan {
  /** The context to run with (the current one when nothing changes). */
  ctx: number;
  /** True when the model has to be started again with `ctx`. */
  change: boolean;
  /** Why it stays smaller than wanted, in plain words ('' when it reaches what was asked for or needs no change). */
  limit: string;
}

const tokens = (n: number) => n.toLocaleString('en-GB');

/**
 * The context to use with Web on: the largest size offered that is at most `want`, at most what the model was trained
 * for and still fits. Never lower than the current one.
 */
export function planWebContext(i: WebCtxIn): WebCtxPlan {
  const want = i.want ?? WEB_CTX;
  if (i.current >= want) return { ctx: i.current, change: false, limit: '' };
  const longest = i.trained && i.trained > 0 ? i.trained : Infinity;
  const options = [...i.contexts].sort((a, b) => b - a).filter(c => c > i.current && c <= want && c <= longest);
  const pick = options.find(c => i.fits(c));
  if (pick === undefined) {
    const why = options.length === 0
      ? `the model was trained for ${tokens(longest)} tokens at most`
      : `${tokens(options[options.length - 1])} tokens would not fit in the memory free here`;
    return { ctx: i.current, change: false, limit: `The context stays at ${tokens(i.current)} tokens because ${why}. Web pages will fill it after a page or two.` };
  }
  return { ctx: pick, change: true, limit: pick < want ? `${tokens(pick)} tokens is the most that fits here (${tokens(want)} was asked for).` : '' };
}

/** What the person is told when the model is started again with a larger context for the web. */
export function webCtxWords(from: number, to: number, where = 'here'): string {
  return `Web is on, so the model on ${where} was started again with a context of ${tokens(to)} tokens (it was ${tokens(from)}), to leave room for pages. Your saved setting is not changed${where === 'here' ? '; the larger context lasts until the model is unloaded' : ''}.`;
}

/** The same for a linked PC, which keeps the new context as its setting for that model (its owner ticked the run-settings tick). */
export function webCtxFarWords(from: number, to: number, pc: string): string {
  return `Web is on, so "${pc}" was asked to run this model with a context of ${tokens(to)} tokens (it was ${tokens(from)}), to leave room for pages. It keeps that as the model's context setting there, which its owner can change under Models.`;
}

/** Why a linked PC's context was not widened for the web ('' when it was, or there was no need). */
export function webCtxFarWhy(pc: string, tuneOn: boolean, canAsk: boolean, current: number): string {
  if (current >= WEB_CTX) return '';
  if (!canAsk) return `"${pc}" runs a TOMLIN that cannot change its context for the web: update it there. Its context stays at ${tokens(current)} tokens, so pages will fill it after a page or two.`;
  if (!tuneOn) return `"${pc}" keeps this model at ${tokens(current)} tokens, so pages will fill it after a page or two. To change that from here, its owner ticks "Allow host to test and change model run settings" on This PC there.`;
  return '';
}
