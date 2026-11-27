// A stand-in for Kokoro (src/voice.ts kokoroEngine), for tests of the Voice routes: no model file, no ONNX Runtime. It
// gives back a quiet tone, 60 samples a symbol, notes every part it was asked to read, and can be told to fail.
import type { VoiceEngine } from '../src/voice.ts';

export class FakeVoiceEngine implements VoiceEngine {
  readonly rate = 24_000;
  /** Every part asked for, in order. */
  readonly asked: { tokens: number[]; voice: string; speed: number }[] = [];
  /** Set to make every say() fail with these words. */
  fail: string | null = null;

  async say(tokens: number[], voice: string, speed: number): Promise<Float32Array> {
    this.asked.push({ tokens, voice, speed });
    if (this.fail) throw new Error(this.fail);
    const out = new Float32Array(Math.round((tokens.length * 60) / speed));
    for (let i = 0; i < out.length; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / this.rate);
    return out;
  }
}
