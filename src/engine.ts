// Talking to the model: how each family of model is asked, and the streaming client for llama.cpp's server (its
// OpenAI-style /v1/chat/completions). The plain functions are tested in test/engine.test.ts.
import { usedFromTimings, type Used } from './meter.ts';

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
export function thinksOf(model: string): Thinks {
  if (/qwen3/i.test(model)) return /instruct-2507/i.test(model) ? 'never' : /thinking/i.test(model) ? 'always' : 'switch';
  if (/deepseek-r1|\bqwq\b|magistral|thinking|reasoning|[-_.]r1[-_.]/i.test(model)) return 'always';
  return 'never';
}

/**
 * `think`: Think was chosen for this message. A Qwen model is then asked to think, with the Qwen team's sampling for
 * thinking (temperature 0.6, top_p 0.95, top_k 20; the presence penalty stays against loops in small models).
 */
export function chatStyle(model: string, think = false): ChatStyle {
  if (/qwen3/i.test(model) && think && thinksOf(model) === 'switch') return { sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 1.5, chat_template_kwargs: { enable_thinking: true } }, systemInFirstMessage: false };
  if (/qwen3/i.test(model)) return { sampling: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5, chat_template_kwargs: { enable_thinking: false } }, systemInFirstMessage: false };
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
export const THINK_ROOM = 4096;

/**
 * The working may run to about this many characters (a word-piece is 3 to 4 of them): past it, it is stopped and the
 * answer asked for with the working so far, so the allowance is never spent on working alone.
 */
export const THINK_CHARS = THINK_ROOM * 3;

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
 * A small model can fall into a loop, writing the same paragraph again and again until its allowance runs out.
 * Returns the answer cut before the repeat once a finished paragraph comes round a second time, or a sentence a third
 * time; null while it is not repeating.
 */
export function repeatCut(text: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const paras = text.split(/\n\s*\n/);
  const seen = new Set<string>();
  for (let i = 0; i < paras.length - 1; i++) {
    const p = norm(paras[i]);
    if (p.length < 30) continue;
    if (seen.has(p)) return paras.slice(0, i).join('\n\n').trimEnd();
    seen.add(p);
  }
  const counts = new Map<string, number>();
  const secondAt = new Map<string, number>();
  for (const m of text.matchAll(/[^.!?\n]+[.!?]/g)) {
    const s = norm(m[0]);
    if (s.length < 25) continue;
    const n = (counts.get(s) ?? 0) + 1;
    counts.set(s, n);
    if (n === 2) secondAt.set(s, m.index);
    // A third time shows the loop; the answer is kept up to where the second began.
    if (n === 3) return text.slice(0, secondAt.get(s)).trimEnd();
  }
  return null;
}

export interface Streamed {
  text: string;
  tokens: number;
  perSecond: number;
  /** Tokens of the prompt read a second (0 when the model did not say). */
  read: number;
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
}

export type ThoughtStop = 'loop' | 'long' | 'hurry';

/**
 * How a chat is asked. `plain`: a Default hire (plainStyle). `think`: Think was chosen. `onThought`: the working so far.
 * `hurry`: Answer now, pressed while it is still working: the working stops and the answer is asked for.
 */
export interface AskOpts {
  plain?: boolean;
  think?: boolean;
  onThought?: (thought: string, seconds: number) => void;
  hurry?: AbortSignal;
  /** Asked again after its working was stopped: not asked a third time. */
  final?: boolean;
  /** On a linked PC: the request id the answer is kept under there if the connection is lost (src/outbox.ts). */
  rid?: string;
}

/** A model server that cannot continue a cut answer from where it stopped (no prefill for this model's template). */
export class NoPrefill extends Error {}

/** When a model cannot continue its own cut answer (no prefill), it is asked to go on instead. */
export const CONTINUE_ASK = 'Your last answer was cut off by its length limit. Carry on from exactly where it stopped: do not repeat anything, do not greet or explain, start with the next character (inside a code block, carry on the code).';

/**
 * Asks llama.cpp's server at `base` and calls `onText` with the whole visible answer so far after each piece. Stops
 * when `signal` aborts (the caller aborts for the person's Stop button, a loop, or the limits). `plain`: a Default
 * hire, asked with plainStyle. A model's working before its answer (llama.cpp sends it apart, as reasoning_content, or
 * it comes inside <think> tags) is never shown as the answer: it goes to `onThought`.
 */
export async function streamChat(base: string, model: string, turns: ChatTurn[], onText: (text: string) => void, signal: AbortSignal, maxTokens = MAX_ANSWER, opts: AskOpts = {}): Promise<Streamed> {
  const style = opts.plain ? plainStyle(model, opts.think) : chatStyle(model, opts.think);
  // Its own stop as well as the caller's: working that goes round in circles is stopped here (below).
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal.addEventListener('abort', stop);
  // Stopped before it began (the page closed while the turn waited): no 'abort' event comes for that, so it stops now.
  if (signal.aborted) ac.abort();
  // Answer now: set once the stream is open (below).
  let hurry: (() => void) | null = null;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: turnsFor(turns, style), stream: true, max_tokens: maxTokens, ...style.sampling }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const said = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 400 && turns.at(-1)?.role === 'assistant' && /prefill/i.test(said)) throw new NoPrefill(said);
      throw new Error(`The model server answered ${res.status}: ${said}`);
    }
    let raw = '';
    let reasoning = '';
    const t0 = Date.now();
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
      if (thought.length > THINK_CHARS) halt('long');
      else if (thinkingLoops(thought)) halt('loop');
    };
    let tokens = 0;
    let perSecond = 0;
    let read = 0;
    let cut = false;
    let timings: Parameters<typeof usedFromTimings>[0] = null;
    // Each streamed piece is one token from llama.cpp: counted with the clock, for the speed when its own timings never
    // come (they ride on the last chunk, which an answer ended early by the repeat check, Stop or Answer now never gets).
    let pieces = 0;
    let firstAt = 0;
    let lastAt = 0;
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let msg: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>; timings?: { predicted_n?: number; predicted_per_second?: number; prompt_n?: number; prompt_per_second?: number; prompt_ms?: number; predicted_ms?: number } };
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }
          const thinking = msg.choices?.[0]?.delta?.reasoning_content;
          if (thinking || msg.choices?.[0]?.delta?.content) {
            pieces++;
            lastAt = Date.now();
            firstAt ||= lastAt;
          }
          if (thinking) {
            reasoning += thinking;
            const so = thoughtSoFar();
            opts.onThought?.(so, Math.round((Date.now() - t0) / 1000));
            watch(so);
          }
          const piece = msg.choices?.[0]?.delta?.content;
          if (piece) {
            raw += piece;
            const shown = visibleText(raw);
            // Still inside <think> tags: the working grows, nothing of the answer yet.
            if (!shown && /<think>/.test(raw)) {
              const so = thoughtSoFar();
              opts.onThought?.(so, Math.round((Date.now() - t0) / 1000));
              watch(so);
            }
            if (shown && !thoughtEnd) thoughtEnd = Date.now();
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
          }
        }
      }
    } catch (error) {
      if (!stopped || signal.aborted) throw error;
    }
    if (!perSecond) {
      const fallback = streamedSpeed(pieces, firstAt, lastAt);
      if (fallback) ({ perSecond, tokens } = fallback);
    }
    if (perSecond > 0 && !readings.quiet.has(model)) readings.answered?.(model, { write: perSecond, tokens, ...(read > 0 ? { read } : {}) });
    // Counted however it ended (done, cut, stopped): the work was done all the same.
    const used = usedFromTimings(timings);
    if (used) readings.used?.(model, used);
    const all = thoughtSoFar();
    const thought = all.length > THOUGHT_KEPT ? `…${all.slice(-THOUGHT_KEPT)}` : all;
    const thoughtSeconds = all ? Math.round(((thoughtEnd || Date.now()) - t0) / 1000) : 0;
    // The working was stopped: the answer is asked for once more, without thinking (a model that always thinks thinks
    // anyway, so it is asked only when he pressed Answer now), with the working so far, which is kept with the answer.
    // (Set inside the stream's callbacks, which the type checker does not follow.)
    const why = stopped as ThoughtStop | null;
    if (why && !signal.aborted && !opts.final && (thinksOf(model) === 'switch' || why === 'hurry')) {
      const again = await streamChat(base, model, withWorking(turns, all), onText, signal, Math.max(512, maxTokens - THINK_ROOM), { plain: opts.plain, final: true });
      return { ...again, thought, thoughtSeconds, thoughtStopped: why };
    }
    return { text: why ? '' : visibleText(raw), tokens, perSecond, read, cut: cut && !why, thought, thoughtSeconds, ...(why ? { thoughtStopped: why } : {}) };
  } finally {
    signal.removeEventListener('abort', stop);
    if (hurry) opts.hurry?.removeEventListener('abort', hurry);
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
