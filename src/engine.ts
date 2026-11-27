// Talking to the model: how each family of model is asked, and the streaming client for llama.cpp's server (its
// OpenAI-style /v1/chat/completions). The plain functions are tested in test/engine.test.ts.
import { usedFromPieces, usedFromTimings, type Used } from './meter.ts';
import { runnerHeaders } from './runnerkeys.ts';
import { withRules } from './rules.ts';
import { withPictures, type PicTurn } from './askpics.ts';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The longest answer, in word-pieces (about 1,500 words), unless the caller asks for another. */
export const MAX_ANSWER = 2048;

/** The most a chat answer may take, whatever the context (about 12,000 words, or a 1,000-line file). */
export const ANSWER_CEILING = 16384;

/**
 * How long a chat answer may run with a context of `ctx` word-pieces: a quarter of it, up to 16K. At the 8K default
 * that is the same 2,048 as before; at 32K it is 8,192 (a 400-line file in one answer). An answer the limit cuts can be
 * continued (the Continue button).
 */
export function answerRoom(ctx: number): number {
  return Math.max(512, Math.min(ANSWER_CEILING, Math.floor((ctx || 8192) / 4)));
}

/**
 * Where reading speeds go: llama.cpp reports how fast it read the prompt with every answer. The server sets this to
 * keep the figure per model on this PC (the context picker shows the time to read a full context from it).
 */
export const readings: {
  seen: ((model: string, tokens: number, perSecond: number) => void) | null;
  /** Every finished answer's speed (src/speed.ts keeps them per model); `quiet` models are being measured some other way. */
  answered: ((model: string, speed: { write: number; tokens: number; read?: number }) => void) | null;
  /** Every answer's usage on this PC (tokens read, written, and the time it worked): src/meter.ts counts it. */
  used: ((model: string, u: Used) => void) | null;
  quiet: Set<string>;
} = { seen: null, answered: null, used: null, quiet: new Set() };

/**
 * How each family of model is asked, from its file name (fine-tunes keep their base model's name in theirs).
 * - Qwen 3 and 3.5: thinking off (it otherwise writes its reasoning first, hidden from the person, and on a slow CPU
 *   that eats the whole allowance); the Qwen team's sampling for answers without thinking (presence penalty 1.5
 *   against endless repetition).
 * - Gemma: trained with no system role, so the instructions go at the top of the first message; Google's top_p, a
 *   little cooler, and a light presence penalty against loops.
 * - Mistral family: its card's low temperature makes chat flat, so a middle value; it takes a system role. It stops at
 *   the next [INST], in case it runs on in the plain format (used when its own template cannot be read).
 * - Anything else: plain, middle-of-the-road settings.
 */
export interface ChatStyle {
  sampling: Record<string, unknown>;
  systemInFirstMessage: boolean;
}

/**
 * Whether a model works an answer out before writing it (Think), from its file name:
 * - 'switch': Qwen 3 and 3.5 think only when asked (Think); Quick asks them not to.
 * - 'always': reasoning models (DeepSeek R1 and its distills, QwQ, Magistral, "Thinking" builds) think whatever is asked.
 * - 'never': the rest, and Qwen 3's "Instruct-2507" builds, answer straight away.
 */
export type Thinks = 'switch' | 'always' | 'never';
/** GLM 4.5 to 4.9 and GLM 5 and later, from the file name ("GLM-4.7-Flash-UD-Q4_K_XL.gguf"). GLM-4 and 4.1 do not think. */
const isGlmHybrid = (model: string): boolean => /(?<![a-z0-9])glm[-_ ]?(?:4[.-][5-9](?![a-z0-9])|[5-9](?:\.\d|[-_. ]))/i.test(model);
/**
 * GLM 5 and later ("GLM-5.3-UD-IQ2_M"). GLM-5.3's template has no off switch: it always opens the working and takes only
 * reasoning_effort (low or high; anything else, enable_thinking included, is Max, which ran 10 minutes an answer).
 */
const isGlm5 = (model: string): boolean => /(?<![a-z0-9])glm[-_ ]?[5-9](?:\.\d|[-_. ])/i.test(model);
/**
 * DeepSeek V3.1 and later (V4-Flash included) are hybrid: their template thinks only when enable_thinking (or thinking)
 * is true, but llama-server sets enable_thinking true unless told, so without the switch they always thought.
 */
const isDeepSeekHybrid = (model: string): boolean => /deepseek[-_ ]?v(?:3[.-][1-9]|[4-9])(?![0-9])/i.test(model);
export function thinksOf(model: string): Thinks {
  // GLM 5 and later cannot be stopped (see isGlm5): filed with the always-thinkers, so the working always has room.
  if (isGlm5(model)) return 'always';
  // GLM 4.5 to 4.9 (4.7-Flash included) are hybrid: they think first by default and take enable_thinking to stop.
  // Filed as "never" they got no room for the working, and once it was cut at its limit nothing asked for the answer.
  if (isGlmHybrid(model) || isDeepSeekHybrid(model)) return 'switch';
  if (/qwen3/i.test(model)) return /instruct-2507/i.test(model) ? 'never' : /thinking/i.test(model) ? 'always' : 'switch';
  // gpt-oss reasons before every answer and has no off switch (only reasoning_effort): filed with the always-thinkers,
  // so it is given the working's room whatever was chosen.
  if (/deepseek-r1|\bqwq\b|magistral|thinking|reasoning|gpt-oss|[-_.]r1[-_.]/i.test(model)) return 'always';
  return 'never';
}

/**
 * `think`: Think was chosen for this message. A Qwen model is then asked to think, with the Qwen team's sampling for
 * thinking (temperature 0.6, top_p 0.95, top_k 20; the presence penalty stays against loops in small models).
 */
export function chatStyle(model: string, think = false): ChatStyle {
  if (/qwen3/i.test(model) && think && thinksOf(model) === 'switch') return { sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 1.5, chat_template_kwargs: { enable_thinking: true } }, systemInFirstMessage: false };
  if (/qwen3/i.test(model)) return { sampling: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5, chat_template_kwargs: { enable_thinking: false } }, systemInFirstMessage: false };
  // GLM 5 and later: the least working on Quick, and high (not the template's Max) on Think. enable_thinking is kept for a
  // GLM 5 whose template does take it.
  if (isGlm5(model)) return { sampling: { temperature: 0.7, top_p: 0.9, presence_penalty: 0.5, chat_template_kwargs: { enable_thinking: think, reasoning_effort: think ? 'high' : 'low' } }, systemInFirstMessage: false };
  if (isGlmHybrid(model)) return { sampling: { temperature: 0.7, top_p: 0.9, presence_penalty: 0.5, chat_template_kwargs: { enable_thinking: think } }, systemInFirstMessage: false };
  if (isDeepSeekHybrid(model)) return { sampling: { temperature: 0.7, top_p: 0.9, presence_penalty: 0.5, chat_template_kwargs: { enable_thinking: think, thinking: think } }, systemInFirstMessage: false };
  if (/gemma/i.test(model)) return { sampling: { temperature: 0.8, top_p: 0.95, presence_penalty: 0.5 }, systemInFirstMessage: true };
  if (/mistral|ministral|nemo/i.test(model)) return { sampling: { temperature: 0.7, top_p: 0.95, presence_penalty: 0.5, stop: ['[INST]', '</s>'] }, systemInFirstMessage: false };
  return { sampling: { temperature: 0.7, top_p: 0.9, presence_penalty: 0.5 }, systemInFirstMessage: false };
}

/**
 * A Default hire's model is asked as a plain chat window asks it: no sampling of ours (the model server's and the
 * model's own defaults). Two things stay: Qwen 3's thinking is off unless Think was chosen (thinking spends a lot of
 * the answer allowance on a slow PC before the first word), and Mistral's stop words (a guard, not a style). Gemma still takes any system text in
 * its first message, as its template needs.
 */
export function plainStyle(model: string, think = false): ChatStyle {
  const style = chatStyle(model, think);
  const keep: Record<string, unknown> = {};
  if ('chat_template_kwargs' in style.sampling) keep.chat_template_kwargs = style.sampling.chat_template_kwargs;
  if ('stop' in style.sampling) keep.stop = style.sampling.stop;
  return { sampling: keep, systemInFirstMessage: style.systemInFirstMessage };
}

/** The turns as `style` needs them: for a model with no system role, the system text leads the first message. */
export function turnsFor(given: ChatTurn[], style: ChatStyle): ChatTurn[] {
  // Two turns in a row from the same side (an answer that was stopped before its first word leaves two of his
  // messages together) are joined: some models' templates (Gemma) refuse anything but strict turn-taking.
  const turns: ChatTurn[] = [];
  // An empty system line (a Default hire's) is not sent at all, as a plain chat window sends none.
  for (const t of given.filter(x => x.role !== 'system' || x.content.trim())) {
    const last = turns.at(-1);
    if (last && last.role === t.role && t.role !== 'system') turns[turns.length - 1] = { ...last, content: `${last.content}\n\n${t.content}` };
    else turns.push(t);
  }
  if (!style.systemInFirstMessage || turns[0]?.role !== 'system') return turns;
  const [system, ...rest] = turns;
  const first = rest.findIndex(t => t.role === 'user');
  if (first < 0) return rest;
  return rest.map((t, i) => (i === first ? { role: 'user' as const, content: `${system.content}\n\n${t.content}` } : t));
}

/** Some models write their reasoning between <think> tags first; people see only the answer. */
export function visibleText(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/, '').trimStart();
}

/** The reasoning inside <think> tags in `raw` (when the model server did not take it out itself), finished or not. */
export function thinkingText(raw: string): string {
  return [...raw.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].map(m => m[1].trim()).filter(Boolean).join('\n\n');
}

/** The most thinking kept with an answer (characters): a long one is cut at the start, where it began. */
export const THOUGHT_KEPT = 40_000;

/**
 * The extra a Think answer may run to, in word-pieces, on top of the answer's own allowance: the working comes first
 * and counts against the same limit, so without it a small allowance ends before the answer starts.
 */
export const THINK_ROOM = 6144;

/**
 * The working may run to about this many characters (a word-piece is 3 to 4 of them): past it, it is stopped and the
 * answer asked for with the working so far, so the allowance is never spent on working alone.
 */
export const THINK_CHARS = THINK_ROOM * 3;

/**
 * The sizes of working room a message can be given, smallest first: the first is the default. When the working fills its
 * room, the page offers the next ones up (a drop-down), and asks again with the one picked.
 */
export const THINK_SIZES = [THINK_ROOM, 12288, 24576, 49152] as const;

/** `n` as one of THINK_SIZES (anything else, or nothing, is the default room). */
export const thinkRoomOf = (n: unknown): number => THINK_SIZES.find(s => s === n) ?? THINK_ROOM;

/**
 * The working's room once the context is counted: `asked` (one of THINK_SIZES) cut to what the context leaves after the
 * prompt (`usedChars`, about 3 characters a word-piece) and the answer's own allowance, and never under 512. `free` is that
 * leftover itself: the bigger sizes on the card must fit in it, or the context fills before the answer starts.
 */
export function thinkRoomFit(asked: number, ctx: number, usedChars: number, answerTokens: number): { room: number; free: number } {
  const free = Math.max(0, ctx - Math.ceil(usedChars / 3) - answerTokens);
  return { room: Math.min(asked, Math.max(512, free)), free };
}

/** A size in words for a button: 6144 is "6k". */
export const thinkSizeWords = (room: number): string => `${Math.round(room / 1024)}k`;

/**
 * How the answer is asked for once the working was stopped (the `final` ask). A model that reasons before every answer
 * (gpt-oss) cannot be told to stop; it is told to reason as little as it takes (reasoning_effort low), or it worked a
 * second time with no one watching, up to the whole room again, and the answer asked for never came.
 */
export function finalStyle(model: string, style: ChatStyle): ChatStyle {
  if (!/gpt-oss/i.test(model) && !isGlm5(model)) return style;
  return { ...style, sampling: { ...style.sampling, chat_template_kwargs: { ...(style.sampling.chat_template_kwargs as object | undefined), reasoning_effort: 'low' } } };
}

/**
 * Working that goes round in circles: a paragraph or sentence again (repeatCut), or the same line of 40 characters or
 * more a third time (small models write their working as lists, each "Wait, looking at..." line again).
 */
export function thinkingLoops(text: string): boolean {
  if (repeatCut(text) !== null) return true;
  const seen = new Map<string, number>();
  for (const line of text.split('\n')) {
    const l = line.replace(/^[\s*\-\d.)]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (l.length < 40) continue;
    const n = (seen.get(l) ?? 0) + 1;
    if (n >= 3) return true;
    seen.set(l, n);
  }
  return false;
}

/**
 * The conversation asked again for the answer alone, once working was stopped (in circles, too long, or Answer now):
 * the working so far goes with the last message, so the answer uses it instead of starting over.
 */
export function withWorking(turns: ChatTurn[], thought: string): ChatTurn[] {
  const at = turns.map(t => t.role).lastIndexOf('user');
  if (at < 0 || !thought.trim()) return turns;
  const tail = thought.length > 3000 ? `…${thought.slice(-3000)}` : thought;
  return turns.map((t, i) => (i === at ? { ...t, content: `${t.content}\n\nYour working so far (use it; do not repeat it):\n${tail}\n\nNow write only the answer.` } : t));
}

/** `fn` at most once every `ms` (the working so far is sent whole each time, so not after every word-piece). */
export function everyFew<A extends unknown[]>(ms: number, fn: (...a: A) => void): (...a: A) => void {
  let last = 0;
  return (...a: A) => {
    if (Date.now() - last < ms) return;
    last = Date.now();
    fn(...a);
  };
}

/**
 * The answer so far, sent on as it grows but not at every word-piece: each event carries all of it, and a linked PC
 * seals every one while the main PC opens and reads every one (an 8K-token answer sent per word-piece was 306 MB over
 * the link). At most every 150 ms, and less often as it grows (its length / 40 ms: 1.4 s at 56,000 characters, 2 s at
 * most). flush() sends what is waiting: called before done or an error, so the last words are never lost.
 */
export function paced(send: (text: string) => void, now: () => number = Date.now): { push: (text: string) => void; flush: () => void } {
  let last = -Infinity;
  let pending: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  const gap = (length: number) => Math.min(2000, Math.max(150, length / 40));
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    last = now();
    send(text);
  };
  return {
    push(text) {
      pending = text;
      const wait = last + gap(text.length) - now();
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
    flush,
  };
}

/** The character ranges of the fenced code blocks (an unclosed one runs to the end of the text). */
function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let open = -1;
  for (const m of text.matchAll(/^[ \t]*```.*$/gm)) {
    if (open < 0) open = m.index;
    else {
      out.push([open, m.index + m[0].length]);
      open = -1;
    }
  }
  if (open >= 0) out.push([open, text.length]);
  return out;
}

/**
 * A small model can fall into a loop, writing the same paragraph again and again until its allowance runs out.
 * Returns the answer cut before the repeat once a finished paragraph comes round a second time, or a sentence a third
 * time; null while it is not repeating. Prose only: code repeats itself by nature (ctx.fillRect, pipes.forEach ... were
 * "sentences" that came a third time, and a game's page was cut mid-file as a loop, 17 Nov 2026), so a fenced block is
 * checked on its own by repeatedCode: the same eight lines three times.
 */
export function repeatCut(text: string): string | null {
  const run = sameRunCut(text);
  if (run !== null) return run;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const code = codeRanges(text);
  const inCode = (i: number) => code.some(([x, y]) => i >= x && i < y);
  let at = 0;
  const paras = text.split(/\n\s*\n/);
  const seen = new Set<string>();
  const starts: number[] = [];
  for (const p of paras) {
    const i = text.indexOf(p, at);
    starts.push(i);
    at = i + p.length;
  }
  for (let i = 0; i < paras.length - 1; i++) {
    const p = norm(paras[i]);
    if (p.length < 30 || inCode(starts[i]) || p.includes('```')) continue;
    if (seen.has(p)) return paras.slice(0, i).join('\n\n').trimEnd();
    seen.add(p);
  }
  const counts = new Map<string, number>();
  const secondAt = new Map<string, number>();
  // Each run of words is taken whole and kept only when a full stop, ! or ? ends it. The pattern with the stop required
  // tried again from every letter of a long run with none (a list, a run of x's): 40,000 such characters took 4 s a look,
  // and the whole app stood still while an answer like that streamed.
  for (const m of text.matchAll(/[^.!?\n]+[.!?]?/g)) {
    if (!/[.!?]$/.test(m[0]) || inCode(m.index)) continue;
    const s = norm(m[0]);
    if (s.length < 25) continue;
    const n = (counts.get(s) ?? 0) + 1;
    counts.set(s, n);
    if (n === 2) secondAt.set(s, m.index);
    // A third time shows the loop; the answer is kept up to where the second began.
    if (n === 3) return text.slice(0, secondAt.get(s)).trimEnd();
  }
  return repeatedCode(text, code);
}

/** The same eight lines (160 characters or more) a third time inside a code block: cut where the second began. */
function repeatedCode(text: string, code: [number, number][]): string | null {
  const WINDOW = 8;
  for (const [x, y] of code) {
    const lines: { s: string; at: number }[] = [];
    let at = x;
    for (const line of text.slice(x, y).split('\n')) {
      lines.push({ s: line.trim(), at });
      at += line.length + 1;
    }
    const seen = new Map<string, { n: number; second: number }>();
    for (let i = 0; i + WINDOW <= lines.length; i++) {
      const w = lines.slice(i, i + WINDOW).map(l => l.s).join('\n');
      if (w.length < 160) continue;
      const e = seen.get(w) ?? { n: 0, second: 0 };
      e.n++;
      if (e.n === 2) e.second = lines[i].at;
      seen.set(w, e);
      if (e.n === 3) return text.slice(0, e.second).trimEnd();
    }
  }
  return null;
}

/** How long the end of an answer must be one short piece over and over (see sameRunCut). */
export const SAME_RUN = 1200;

/**
 * The end of the answer is one piece of 1 to 16 characters written again and again for SAME_RUN characters or more
 * ("xxxx…" with no sentence, paragraph or line to repeat, so the checks above never see it; a 2B model wrote 52,000
 * x's). Cut where that run began, keeping its first 80 characters so the reader sees what happened. Only the end is
 * looked at: a run still growing is the loop, and the look costs the same however long the answer is.
 */
function sameRunCut(text: string): string | null {
  const n = text.length;
  if (n < SAME_RUN + 16) return null;
  for (let unit = 1; unit <= 16; unit++) {
    let i = n - SAME_RUN;
    while (i < n && text[i] === text[i - unit]) i++;
    if (i < n) continue;
    let start = n - SAME_RUN;
    while (start - unit > 0 && text[start - 1] === text[start - 1 + unit]) start--;
    return text.slice(0, start + 80).trimEnd();
  }
  return null;
}

/**
 * repeatCut for an answer as it streams: looked at again once the text has grown by a sixteenth since the last look
 * (200 characters at least), not at every word-piece. Each look reads the whole answer, so looking every word-piece cost
 * 10 s of CPU over an 8K-token answer and 35 s over a 16K one (measured); this is linear. A loop is cut at the same place,
 * a little later in the stream.
 */
export function repeatWatch(): (text: string) => string | null {
  let at = 0;
  return text => {
    if (text.length - at < Math.max(200, at / 16)) return null;
    at = text.length;
    return repeatCut(text);
  };
}

export interface Streamed {
  text: string;
  tokens: number;
  perSecond: number;
  /** Tokens of the prompt read a second (0 when the model did not say). */
  read: number;
  /** How many tokens of the prompt it read this turn (what was cached not counted; 0 when it did not say). */
  readTokens?: number;
  /** True when the answer stopped because it reached its length limit (not because it was finished). */
  cut: boolean;
  /** What the model worked out before its answer ('' when it did not think), and for how many seconds. */
  thought: string;
  thoughtSeconds: number;
  /**
   * Why the working was stopped before the answer: it went round in circles ('loop'), ran past its room ('long'), or
   * Answer now was pressed ('hurry'). The answer was then asked for with the working so far, when the model can be
   * asked not to think; a model that always thinks ends with no answer.
   */
  thoughtStopped?: ThoughtStop;
  /** Seconds from the ask to the first word-piece (reading the prompt, loading, thinking); 0 when none came. */
  firstWord?: number;
  /** The longest quiet between two word-pieces, in seconds (0 when under one). */
  longestGap?: number;
  /** Set when the model went quiet for this many seconds part-way and the answer was ended there (it is offered Continue). */
  stalled?: number;
}

/** An answer that has begun and then gets no word-piece for this long is ended and offered Continue: a hung runner, not a slow one. */
export const STALL_MS = 10 * 60_000;
/** Before the first word, a runner that sends nothing at all is waited on this many times STALL_MS, then ended. */
export const QUIET_START = 6;

export type ThoughtStop = 'loop' | 'long' | 'hurry';

/**
 * How a chat is asked. `plain`: a Default hire (plainStyle). `think`: Think was chosen. `onThought`: the working so far.
 * `hurry`: Answer now, pressed while it is still working: the working stops and the answer is asked for.
 */
export interface AskOpts {
  plain?: boolean;
  think?: boolean;
  /** The working's room in word-pieces, one of THINK_SIZES (the default when not given). */
  thinkRoom?: number;
  onThought?: (thought: string, seconds: number) => void;
  hurry?: AbortSignal;
  /** Asked again after its working was stopped: not asked a third time. */
  final?: boolean;
  /** On a linked PC: the request id the answer is kept under there if the connection is lost (src/outbox.ts). */
  rid?: string;
  /** How far the model is through reading the prompt, before the first word (a long chat takes minutes on a slow PC). */
  onReading?: (r: Reading) => void;
  /** Tools the model may call while it answers (a chat with Web on: src/webtools.ts). */
  tools?: ToolBox;
  /** Web on, for an answer a linked PC writes: its web tools run there (src/jobrun/links.ts remoteBrain). */
  web?: { seed: string[]; perCall: number; total: number };
  /** Inside a round of tool calls: the calls and what they gave so far, sent after the turns (set by streamChat). */
  toolTurns?: Record<string, unknown>[];
  /** Quiet allowed between two word-pieces once the answer has begun, in ms (STALL_MS when not given; for tests). */
  stallMs?: number;
  /** Which round of tool calls this is, 0 the first (set by streamChat). */
  round?: number;
  /** Pictures for a model here started with its vision add-on, each on the message it came with (src/askpics.ts). */
  pictures?: PicTurn[];
}

/**
 * Tools for one answer: their definitions (OpenAI's form, which llama-server takes) and running one by name with the
 * arguments the model wrote. `rounds`: how many rounds of calls before the answer is asked for with the tools off.
 */
export interface ToolBox {
  defs: unknown[];
  /** `round`: which round of calls this is, 0 the first. */
  run: (name: string, args: string, signal: AbortSignal, round: number) => Promise<string>;
  /** Told as each call starts, with its name and the arguments as the model wrote them. */
  onCall?: (name: string, args: string) => void;
  /** Whether a call by this name may run beside the others in its round (unset: one after another). */
  parallel?: (name: string) => boolean;
  /** A long answer's tool turns made smaller before the next ask (src/researchtools.ts foldToolTurns). Unset: sent whole. */
  fold?: (turns: Record<string, unknown>[]) => Record<string, unknown>[];
  rounds: number;
}

/**
 * Reading the prompt, from llama.cpp's progress (return_progress): `total` word-pieces in the prompt, `cached` already
 * read on an earlier turn (not read again), `done` read so far (the cached ones included), `ms` spent on it.
 */
export interface Reading {
  total: number;
  cached: number;
  done: number;
  ms: number;
}

/** A Reading from anything (a linked PC's line): null when it is not one. */
export function cleanReading(x: unknown): Reading | null {
  const r = x as Record<string, unknown> | null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : -1);
  const total = n(r?.total), cached = n(r?.cached ?? r?.cache), done = n(r?.done ?? r?.processed), ms = n(r?.ms ?? r?.time_ms);
  return total > 0 && cached >= 0 && done >= 0 && ms >= 0 ? { total, cached: Math.min(cached, total), done: Math.min(done, total), ms } : null;
}

/** A model server that cannot continue a cut answer from where it stopped (no prefill for this model's template). */
export class NoPrefill extends Error {}

/**
 * The chat came to more word-pieces than the model's context holds, as llama.cpp counted them (the app's count is a
 * guess of 3 characters each; JSON and lock files are nearer 2).
 */
export class ContextFull extends Error {
  readonly tokens: number;
  readonly ctx: number;
  constructor(tokens: number, ctx: number) {
    super(`the chat came to ${tokens.toLocaleString('en-GB')} word-pieces, more than the ${ctx.toLocaleString('en-GB')} this model's context holds`);
    this.tokens = tokens;
    this.ctx = ctx;
  }
}

/** llama.cpp's "exceeds the available context size" answer as a ContextFull; null for any other. */
export function contextFull(said: string): ContextFull | null {
  try {
    const e = (JSON.parse(said) as { error?: { type?: string; n_prompt_tokens?: number; n_ctx?: number } }).error;
    return e?.type === 'exceed_context_size_error' && Number(e.n_prompt_tokens) > 0 && Number(e.n_ctx) > 0 ? new ContextFull(Number(e.n_prompt_tokens), Number(e.n_ctx)) : null;
  } catch {
    return null;
  }
}

/** When a model cannot continue its own cut answer (no prefill), it is asked to go on instead. */
export const CONTINUE_ASK = 'Your last answer was cut off by its length limit. Carry on from exactly where it stopped: do not repeat anything, do not greet or explain, start with the next character (inside a code block, carry on the code).';

/**
 * Continue on a model of a linked PC: the turns end with the person's ask to carry on, never with the cut answer. A linked
 * PC takes only a conversation that ends with the person's message (src/brains.ts cleanTurns), so a Continue sent as it is
 * was refused ("the conversation sent was not in the expected form", Z820 on 2.0.95, 17 Nov 2026). Other turns pass as they are.
 */
export function withContinueAsk<T extends { role: string; content: string }>(turns: T[]): T[] {
  return turns.at(-1)?.role === 'assistant' ? [...turns, { role: 'user', content: CONTINUE_ASK } as T] : turns;
}

/**
 * Asks llama.cpp's server at `base` and calls `onText` with the whole visible answer so far after each piece. Stops
 * when `signal` aborts (the caller aborts for the person's Stop button, a loop, or the limits). `plain`: a Default
 * hire, asked with plainStyle. A model's working before its answer (llama.cpp sends it apart, as reasoning_content, or
 * it comes inside <think> tags) is never shown as the answer: it goes to `onThought`.
 */
/**
 * A request to a model runner as JSON, every text made whole: a length limit that cut an emoji in two (a note, a log
 * line, a page part, a step summary) leaves half of it, and llama-server refuses the whole request over one lone half
 * (a 500, measured), and every later turn that carries that text with it.
 */
export const runnerJson = (body: unknown): string => JSON.stringify(body, (_k, v: unknown) => (typeof v === 'string' ? v.toWellFormed() : v));

/**
 * fetch for a model runner, with no time limit on its reply. Node's fetch gives up when no headers come for 300 s, or
 * no bytes between two pieces for 300 s, and a runner sends none while it works: llama-server while it reads a prompt
 * (a progress line once a 2048-token batch, at best), the picture runner until its job is queued. A slow CPU reading a
 * long prompt went past that and the answer failed. The limit is lifted with the agent Node's own fetch uses (made
 * with no time limits); on a Node without it, plain fetch. Stop still ends it: that is the request's signal.
 */
let patient: object | false | null = null;
export async function runnerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (patient === null) {
    // Node sets up its fetch agent on the first fetch: a data: address costs nothing.
    await fetch('data:,').catch(() => undefined);
    const agent = (globalThis as unknown as Record<symbol, { constructor?: new (o: object) => object } | undefined>)[Symbol.for('undici.globalDispatcher.1')];
    try {
      patient = agent?.constructor ? new agent.constructor({ headersTimeout: 0, bodyTimeout: 0 }) : false;
    } catch {
      patient = false;
    }
  }
  return fetch(url, patient ? ({ ...init, dispatcher: patient } as RequestInit) : init);
}

/** Told of every answer that came back whole, with the runner's address and its writing speed (the run history). */
export const answered: { on: ((base: string, perSecond: number | null) => void) | null } = { on: null };

/**
 * What a runner's refusal says, in words: a web page (a proxy's or a server's "503 Service Unavailable" page) loses its
 * markup, scripts and styles, so the person is not shown raw HTML. At most 200 characters.
 */
export function plainReply(body: string): string {
  if (!/<(!doctype|html|head|body|title|p|h\d|div|pre)\b/i.test(body)) return body.slice(0, 200);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '';
  const text = body
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '‹')
    .replace(/&gt;/gi, '›')
    .replace(/\s+/g, ' ')
    .trim();
  const said = text || title.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return (said || 'a web page with no words in it').slice(0, 200);
}

export async function streamChat(base: string, model: string, turns: ChatTurn[], onText: (text: string) => void, signal: AbortSignal, maxTokens = MAX_ANSWER, opts: AskOpts = {}): Promise<Streamed> {
  const chosen = opts.plain ? plainStyle(model, opts.think) : chatStyle(model, opts.think);
  const style = opts.final ? finalStyle(model, chosen) : chosen;
  // Its own stop as well as the caller's: working that goes round in circles is stopped here (below).
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal.addEventListener('abort', stop);
  // Stopped before it began (the page closed while the turn waited): no 'abort' event comes for that, so it stops now.
  if (signal.aborted) ac.abort();
  // Answer now: set once the stream is open (below).
  let hurry: (() => void) | null = null;
  // Tools: offered while rounds are left; the last round says none may be called, so the model answers in words.
  const round = opts.round ?? 0;
  const tools = opts.tools ? { tools: opts.tools.defs, tool_choice: round >= opts.tools.rounds ? 'none' : 'auto' } : {};
  try {
    const res = await runnerFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...runnerHeaders(base) },
      // return_progress: llama.cpp says how far it has read the prompt, once a batch, before the first word. Asked
      // always, not only when it is shown: a line now and then keeps the stream from going quiet on a long prompt.
      body: runnerJson({ messages: [...withPictures(turnsFor(withRules(turns), style), opts.pictures ?? []), ...(opts.toolTurns ?? [])], stream: true, max_tokens: maxTokens, ...style.sampling, ...tools, return_progress: true }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const all = await res.text().catch(() => '');
      const said = plainReply(all);
      if (res.status === 400 && turns.at(-1)?.role === 'assistant' && /prefill/i.test(said)) throw new NoPrefill(said);
      const full = contextFull(all);
      if (full) throw full;
      throw new Error(`The model server answered ${res.status}: ${said}`);
    }
    let raw = '';
    let reasoning = '';
    // Timed by a clock that only goes forward, not the PC's clock: one put right part way never looks like a stall.
    const clock = () => performance.now();
    const t0 = clock();
    let thoughtEnd = 0;
    const thoughtSoFar = () => [reasoning.trim(), thinkingText(raw)].filter(Boolean).join('\n\n');
    // A small model can think in a loop ("Wait, looking at the first turn..." again and again) until the whole allowance
    // is spent, minutes on a slow PC: checked as the working grows, before the answer has begun. So is its length, and
    // Answer now (`hurry`) stops it whenever he presses it.
    let stopped: ThoughtStop | null = null;
    const halt = (why: ThoughtStop) => {
      if (stopped || thoughtEnd) return;
      stopped = why;
      ac.abort();
    };
    hurry = () => halt('hurry');
    opts.hurry?.addEventListener('abort', hurry);
    let checkedAt = 0;
    const watch = (thought: string) => {
      if (thoughtEnd || thought.length - checkedAt < 200) return;
      checkedAt = thought.length;
      if (thought.length > (opts.thinkRoom ?? THINK_ROOM) * 3) halt('long');
      else if (thinkingLoops(thought)) halt('loop');
    };
    let tokens = 0;
    let perSecond = 0;
    let read = 0;
  let readTokens = 0;
    let cut = false;
    let timings: Parameters<typeof usedFromTimings>[0] = null;
    // Each streamed piece is one token from llama.cpp: counted with the clock, for the speed when its own timings never
    // come (they ride on the last chunk, which an answer ended early by the repeat check, Stop or Answer now never gets).
    let pieces = 0;
    let firstAt = 0;
    let lastAt = 0;
    let longestGap = 0;
    // A model that has begun writing and then goes quiet for STALL_MS is ended, not waited on for ever. Before the first
    // word a runner that sends nothing at all (no reading progress either) for QUIET_START times that long (an hour) is
    // ended too: the stream was opened and then nothing came. A slow read of a long prompt sends its progress, and a
    // slow start that is only slow is given far longer than a stall.
    let stalled = 0;
    let heardAt = t0;
    let silent = false;
    const stallMs = opts.stallMs ?? STALL_MS;
    const watchdog = setInterval(() => {
      if (stalled) return;
      if (lastAt && clock() - lastAt >= stallMs) {
        stalled = Math.max(1, Math.round((clock() - lastAt) / 1000));
        ac.abort();
      } else if (!lastAt && clock() - heardAt >= stallMs * QUIET_START) {
        stalled = Math.max(1, Math.round((clock() - heardAt) / 1000));
        silent = true;
        ac.abort();
      }
    }, Math.max(20, Math.min(5000, Math.floor(stallMs / 4))));
    watchdog.unref();
    // Tool calls, as they stream in: each by its index, its name once, its arguments in pieces.
    const calls: { id: string; name: string; args: string }[] = [];
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      // A line end after the stream, so its last line is read even when the server sent none after it.
      const body = res.body as unknown as AsyncIterable<Uint8Array>;
      const stream = (async function* () { yield* body; yield new TextEncoder().encode('\n'); })();
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          heardAt = clock();
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let msg: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; timings?: { predicted_n?: number; predicted_per_second?: number; prompt_n?: number; prompt_per_second?: number; prompt_ms?: number; predicted_ms?: number } };
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }
          const reading = (msg as { prompt_progress?: unknown }).prompt_progress;
          if (reading && opts.onReading) {
            const r = cleanReading(reading);
            if (r) opts.onReading(r);
          }
          const thinking = msg.choices?.[0]?.delta?.reasoning_content;
          for (const c of msg.choices?.[0]?.delta?.tool_calls ?? []) {
            const k = Number.isInteger(c.index) && c.index! >= 0 && c.index! < 16 ? c.index! : calls.length;
            calls[k] ??= { id: '', name: '', args: '' };
            if (c.id) calls[k].id = c.id;
            if (c.function?.name && !calls[k].name) calls[k].name = c.function.name;
            if (c.function?.arguments) calls[k].args += c.function.arguments;
          }
          if (thinking || msg.choices?.[0]?.delta?.content || msg.choices?.[0]?.delta?.tool_calls?.length) {
            pieces++;
            const now = clock();
            if (lastAt) longestGap = Math.max(longestGap, now - lastAt);
            lastAt = now;
            firstAt ||= lastAt;
          }
          if (thinking) {
            reasoning += thinking;
            const so = thoughtSoFar();
            opts.onThought?.(so, Math.round((clock() - t0) / 1000));
            watch(so);
          }
          const piece = msg.choices?.[0]?.delta?.content;
          if (piece) {
            raw += piece;
            const shown = visibleText(raw);
            // Still inside <think> tags: the working grows, nothing of the answer yet.
            if (!shown && /<think>/.test(raw)) {
              const so = thoughtSoFar();
              opts.onThought?.(so, Math.round((clock() - t0) / 1000));
              watch(so);
            }
            if (shown && !thoughtEnd) thoughtEnd = clock();
            onText(shown);
          }
          if (msg.choices?.[0]?.finish_reason === 'length') cut = true;
          if (msg.timings) {
            timings = msg.timings;
            tokens = msg.timings.predicted_n ?? tokens;
            perSecond = msg.timings.predicted_per_second ?? perSecond;
            const { prompt_n: n, prompt_per_second: ps } = msg.timings;
            if (n && ps && msg.choices?.[0]?.finish_reason) readings.seen?.(model, n, ps);
            if (ps) read = ps;
            if (n) readTokens = n;
          }
        }
      }
    } catch (error) {
      if (!(stopped || stalled) || signal.aborted) throw error;
    } finally {
      clearInterval(watchdog);
    }
    if (silent && !signal.aborted) {
      const m = Math.round(stalled / 60);
      throw new Error(`The model server sent nothing for ${m >= 1 ? `${m} minute${m === 1 ? '' : 's'}` : `${stalled} second${stalled === 1 ? '' : 's'}`} after it began, so the answer was stopped. Press Send again, or reconnect the model if it happens again.`);
    }
    if (stalled) cut = true;
    if (!perSecond) {
      const fallback = streamedSpeed(pieces, firstAt, lastAt);
      if (fallback) ({ perSecond, tokens } = fallback);
    }
    if (perSecond > 0 && !readings.quiet.has(model)) readings.answered?.(model, { write: perSecond, tokens, ...(read > 0 ? { read } : {}) });
    // Counted however it ended (done, cut, stopped): the work was done all the same.
    const used = usedFromTimings(timings) ?? usedFromPieces(pieces, firstAt, lastAt);
    if (used) readings.used?.(model, used);
    const all = thoughtSoFar();
    const thought = all.length > THOUGHT_KEPT ? `…${all.slice(-THOUGHT_KEPT)}` : all;
    const thoughtSeconds = all ? Math.round(((thoughtEnd || clock()) - t0) / 1000) : 0;
    // The working was stopped: the answer is asked for once more, without thinking (a model that always thinks thinks
    // anyway, so it is asked only when he pressed Answer now), with the working so far, which is kept with the answer.
    // (Set inside the stream's callbacks, which the type checker does not follow.)
    const why = stopped as ThoughtStop | null;
    // The model asked for tools: each one is run, and it is asked again with what they gave (the answer so far is
    // written afresh), until it answers in words or the rounds are used up.
    const asked = calls.filter(c => c?.name);
    if (asked.length && opts.tools && round < opts.tools.rounds && !why && !signal.aborted) {
      // The words before the calls ("I will look that up") are not the answer: the next round writes it.
      onText('');
      const ids = asked.map((c, i) => c.id || `call_${round}_${i}`);
      // Arguments that are not a JSON object (cut by the length limit, or a small model's broken JSON) are sent back as
      // {}: llama-server refuses the whole next ask over them (a 500, measured). The tool itself still gets what was written.
      const said: Record<string, unknown>[] = [{ role: 'assistant', content: visibleText(raw), tool_calls: asked.map((c, i) => ({ id: ids[i], type: 'function', function: { name: c.name, arguments: jsonObject(c.args) ? c.args : '{}' } })) }];
      // Calls the tools say may run side by side (web pages: each site keeps its own pace, so two sites take turns) start
      // at once; the others run one after another, in order. The results go back in the order they were asked.
      const tools = opts.tools;
      const one = async (c: (typeof asked)[number]): Promise<string> => {
        tools.onCall?.(c.name, c.args);
        try {
          return await tools.run(c.name, c.args, signal, round);
        } catch (e) {
          if (signal.aborted) throw e;
          return `The tool did not work: ${(e as Error).message}`;
        }
      };
      const side = asked.map(c => (tools.parallel?.(c.name) ? one(c) : null));
      // A side-by-side call that fails while another is awaited is caught when its turn comes (not left unhandled).
      for (const p of side) p?.catch(() => undefined);
      for (const [i, c] of asked.entries()) said.push({ role: 'tool', tool_call_id: ids[i], content: await (side[i] ?? one(c)) });
      const next = await streamChat(base, model, turns, onText, signal, maxTokens, { ...opts, toolTurns: tools.fold ? tools.fold([...(opts.toolTurns ?? []), ...said]) : [...(opts.toolTurns ?? []), ...said], round: round + 1 });
      return { ...next, thought: [thought, next.thought].filter(Boolean).join('\n\n'), thoughtSeconds: thoughtSeconds + next.thoughtSeconds };
    }
    if (why && !signal.aborted && !opts.final && (thinksOf(model) === 'switch' || why === 'hurry')) {
      // What the tools gave goes with it (Answer now in a later round must not lose the pages read), calls off.
      const web = opts.tools && opts.toolTurns?.length ? { tools: opts.tools, toolTurns: opts.toolTurns, round: opts.tools.rounds } : {};
      const again = await streamChat(base, model, withWorking(turns, all), onText, signal, Math.max(512, maxTokens - (opts.thinkRoom ?? THINK_ROOM)), { plain: opts.plain, final: true, ...web, ...(opts.pictures ? { pictures: opts.pictures } : {}) });
      return { ...again, thought, thoughtSeconds, thoughtStopped: why };
    }
    // An answer that came back whole: the run history counts it for the runner at `base` (src/server/faults.ts).
    if (!signal.aborted) answered.on?.(base, perSecond ?? null);
    return { text: why ? '' : visibleText(raw), tokens, perSecond, read, readTokens, cut: cut && !why, thought, thoughtSeconds, ...(why ? { thoughtStopped: why } : {}), ...(firstAt ? { firstWord: Math.round((firstAt - t0) / 1000) } : {}), ...(longestGap >= 1000 ? { longestGap: Math.round(longestGap / 1000) } : {}), ...(stalled ? { stalled } : {}) };
  } finally {
    signal.removeEventListener('abort', stop);
    if (hurry) opts.hurry?.removeEventListener('abort', hurry);
  }
}

/** True when `text` is a JSON object (what llama-server takes as a tool call's arguments). */
function jsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Tokens a second from the streamed pieces (one token each) between the first and the last: used only when llama.cpp's
 * own timings did not come. Null for too few pieces or too short a time to mean anything.
 */
export function streamedSpeed(pieces: number, firstAt: number, lastAt: number): { perSecond: number; tokens: number } | null {
  const seconds = (lastAt - firstAt) / 1000;
  if (pieces < 8 || seconds < 0.5) return null;
  return { perSecond: (pieces - 1) / seconds, tokens: pieces };
}
