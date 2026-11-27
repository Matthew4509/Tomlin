// Text to speech for voice-overs, all on this PC: Kokoro 82M (Apache-2.0, ONNX, the files in registry/kokoro-82m.json)
// run on the CPU with ONNX Runtime, as background removal is (src/rembg.ts). Lines typed are put in words and sound
// symbols (src/phonemes.ts), read a sentence at a time with short pauses between, and written as a WAV file (mono,
// 16-bit, 24 kHz) by the plain code here. The engine is behind VoiceEngine, so tests use a pretend one. Plain parts:
// test/voice.test.ts; the server side is src/server/voice.ts.
import { readFile } from 'node:fs/promises';
import { phonemize, sayInWords } from './phonemes.ts';
import { VCRT_URL, vcrtMissing } from './vcrt.ts';

/** The voice model's id in the registry (registry/kokoro-82m.json, a helper on the Models page). */
export const VOICE_MODEL_ID = 'kokoro-82m';
/** Kokoro's samples a second. */
export const VOICE_RATE = 24_000;
/** The most text one Speak reads. */
export const TEXT_MAX = 5000;
/** Kokoro reads at most 510 symbols at once; a sentence longer than this is read in parts. */
export const SYMBOLS_MAX = 400;
/** Seconds of quiet after a sentence, after a line, and between the parts of one long sentence. */
export const PAUSE = { sentence: 0.25, line: 0.6, part: 0.05 };

/** The voices downloaded with the model (American English), by Kokoro's ids. */
export const VOICES: { id: string; name: string }[] = [
  { id: 'af_heart', name: 'Heart (woman)' },
  { id: 'af_bella', name: 'Bella (woman)' },
  { id: 'af_nicole', name: 'Nicole (woman, soft)' },
  { id: 'af_sarah', name: 'Sarah (woman)' },
  { id: 'am_michael', name: 'Michael (man)' },
  { id: 'am_adam', name: 'Adam (man)' },
  { id: 'am_fenrir', name: 'Fenrir (man, deep)' },
  { id: 'am_puck', name: 'Puck (man, bright)' },
];
/** How fast it reads: 1 is Kokoro's own pace. */
export const SPEEDS: { id: number; name: string }[] = [{ id: 0.8, name: 'Slow' }, { id: 0.9, name: 'A little slow' }, { id: 1, name: 'Normal' }, { id: 1.1, name: 'A little fast' }, { id: 1.25, name: 'Fast' }];

export const voiceName = (id: string): string => VOICES.find(v => v.id === id)?.name ?? id;

/** {text, voice, speed} as the page sent them, checked: the text trimmed, a voice in the list, a speed in the list. */
export function cleanSpeak(b: Record<string, unknown>): { text: string; voice: string; speed: number } | { error: string } {
  const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return { error: 'Type a line to read first.' };
  if (text.length > TEXT_MAX) return { error: `That is too long to read at once (over ${TEXT_MAX} letters). Split it into a few parts.` };
  const voice = VOICES.find(v => v.id === b.voice)?.id ?? VOICES[0].id;
  const speed = SPEEDS.find(s => s.id === Number(b.speed))?.id ?? 1;
  return { text, voice, speed };
}

/** The lines typed, blank ones left out. */
export const linesOf = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(Boolean);

/** A line split into sentences, each keeping its end mark ("Hi there. How are you?" is two). */
export function sentences(line: string): string[] {
  return (line.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? []).map(s => s.trim()).filter(s => /[A-Za-z0-9]/.test(s));
}

/** A sentence's symbols in parts of at most `max`: split after a comma or other mark first, then between words. */
export function pieces(symbols: string, max = SYMBOLS_MAX): string[] {
  if (symbols.length <= max) return symbols ? [symbols] : [];
  const out: string[] = [];
  let rest = symbols;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = Math.max(...[', ', '; ', ': ', '— '].map(m => head.lastIndexOf(m)));
    cut = cut > max / 3 ? cut + 1 : head.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface SpeechPart {
  /** Kokoro's symbols for this part. */
  symbols: string;
  /** Seconds of quiet after it. */
  pause: number;
}

/** What to read, in order: every line's sentences in parts, with the pause after each (none after the last). */
export function speechPlan(text: string): SpeechPart[] {
  const plan: SpeechPart[] = [];
  for (const line of linesOf(text)) {
    const said = sentences(sayInWords(line));
    said.forEach((s, i) => {
      const parts = pieces(phonemize(s));
      parts.forEach((symbols, k) => plan.push({ symbols, pause: k < parts.length - 1 ? PAUSE.part : i < said.length - 1 ? PAUSE.sentence : PAUSE.line }));
    });
  }
  if (plan.length) plan[plan.length - 1].pause = 0;
  return plan;
}

// Kokoro's symbols and their numbers (its tokenizer.json at the pinned revision; 0 is the start and end mark).
const SYMBOLS = ";:,.!?\u2014\u2026\u0022()\u201c\u201d \u0303\u02a3\u02a5\u02a6\u02a8\u1d5d\uab67AIOQSTWY\u1d4aabcdefhijklmnopqrstuvwxyz\u0251\u0250\u0252\u00e6\u03b2\u0254\u0255\u00e7\u0256\u00f0\u02a4\u0259\u025a\u025b\u025c\u025f\u0261\u0265\u0268\u026a\u029d\u026f\u0270\u014b\u0273\u0272\u0274\u00f8\u0278\u03b8\u0153\u0279\u027e\u027b\u0281\u027d\u0282\u0283\u0288\u02a7\u028a\u028b\u028c\u0263\u0264\u03c7\u028e\u0292\u0294\u02c8\u02cc\u02d0\u02b0\u02b2\u2193\u2192\u2197\u2198\u1d7b";
const IDS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 33, 35, 36, 39, 41, 42, 43, 44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 75, 76, 77, 78, 80, 81, 82, 83, 85, 86, 87, 90, 92, 99, 101, 102, 103, 110, 111, 112, 113, 114, 115, 116, 118, 119, 120, 123, 125, 126, 128, 129, 130, 131, 132, 133, 135, 136, 138, 139, 140, 142, 143, 147, 148, 156, 157, 158, 162, 164, 169, 171, 172, 173, 177];
const ID_OF = new Map([...SYMBOLS].map((c, i) => [c, IDS[i]]));

/** Kokoro's numbers for a part's symbols; a symbol it does not know is left out. */
export const tokensOf = (symbols: string): number[] => [...symbols].map(c => ID_OF.get(c)).filter((n): n is number => n !== undefined);

/** Numbers a voice file holds for each length of part (510 rows of 256). */
export const STYLE_SIZE = 256;
export const STYLE_ROWS = 510;

/** The voice's row for a part of `n` symbols (Kokoro's voice files hold one row per length). */
export function styleOf(voice: Float32Array, n: number): Float32Array {
  const row = Math.min(Math.max(n, 0), STYLE_ROWS - 1);
  return voice.subarray(row * STYLE_SIZE, (row + 1) * STYLE_SIZE);
}

/** Samples (-1 to 1) as a WAV file: mono, 16-bit PCM, at `rate` a second. */
export function wavFile(samples: Float32Array, rate = VOICE_RATE): Buffer {
  const data = samples.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); // bytes a second
  b.writeUInt16LE(2, 32); // bytes a sample
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    b.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return b;
}

/** What reads a part aloud: Kokoro here, a pretend one in tests. */
export interface VoiceEngine {
  /** Samples a second of what say() gives back. */
  rate: number;
  /** One part's samples (-1 to 1), from its numbers (without the start and end marks), in `voice` at `speed`. */
  say(tokens: number[], voice: string, speed: number): Promise<Float32Array>;
}

/** Every part read in turn, with its pause after it, as one run of samples. Stops between parts when `signal` aborts. */
export async function speak(plan: SpeechPart[], engine: VoiceEngine, voice: string, speed: number, signal?: AbortSignal): Promise<Float32Array> {
  const bits: Float32Array[] = [];
  let total = 0;
  for (const p of plan) {
    if (signal?.aborted) throw new Error('Stopped.');
    const tokens = tokensOf(p.symbols);
    if (!tokens.length) continue;
    const said = await engine.say(tokens, voice, speed);
    const quiet = new Float32Array(Math.round(p.pause * engine.rate));
    bits.push(said, quiet);
    total += said.length + quiet.length;
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const b of bits) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

type OrtSession = { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>; inputNames: readonly string[]; outputNames: readonly string[]; release?: () => Promise<void> };

/**
 * Kokoro on this PC: the model file and where each voice's file is. The model loads on the first part and is let go
 * after a minute with nothing to read, so it holds no memory between voice-overs.
 */
export function kokoroEngine(files: { model: string; voice: (id: string) => string | null }): VoiceEngine {
  let ort: typeof import('onnxruntime-node') | null = null;
  let session: OrtSession | null = null;
  let idle: NodeJS.Timeout | null = null;
  const voices = new Map<string, Float32Array>();
  const open = async () => {
    if (!ort) {
      try {
        ort = await import('onnxruntime-node');
      } catch (e) {
        if (vcrtMissing().length) throw new Error(`The voice could not start: this PC does not have the Microsoft Visual C++ Runtime. Install it from Microsoft (${VCRT_URL}), then try again.`);
        throw e;
      }
    }
    session ??= (await ort.InferenceSession.create(files.model, { executionProviders: ['cpu'] })) as never;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      void session?.release?.();
      session = null;
    }, 60_000);
    idle.unref();
    return { o: ort, s: session! };
  };
  const voiceOf = async (id: string) => {
    const had = voices.get(id);
    if (had) return had;
    const path = files.voice(id);
    if (!path) throw new Error(`The voice ${voiceName(id)} is not on this PC. Download the voice model again on the Models page.`);
    const raw = await readFile(path);
    if (raw.length !== STYLE_ROWS * STYLE_SIZE * 4) throw new Error(`The file of the voice ${voiceName(id)} is not whole. Download the voice model again on the Models page.`);
    const v = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    voices.set(id, v);
    return v;
  };
  return {
    rate: VOICE_RATE,
    async say(tokens, voice, speed) {
      const style = styleOf(await voiceOf(voice), tokens.length);
      const { o, s } = await open();
      const ids = [0, ...tokens, 0];
      const name = (re: RegExp, i: number) => s.inputNames.find(n => re.test(n)) ?? s.inputNames[i];
      const out = await s.run({
        [name(/ids|input/i, 0)]: new o.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        [name(/style|ref/i, 1)]: new o.Tensor('float32', Float32Array.from(style), [1, STYLE_SIZE]),
        [name(/speed/i, 2)]: new o.Tensor('float32', Float32Array.of(speed), [1]),
      });
      return Float32Array.from(out[s.outputNames[0]].data);
    },
  };
}
