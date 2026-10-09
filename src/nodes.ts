// Nodes: this PC and the PCs it is linked with, and how their memory is used. Plain functions, tested in
// test/nodes.test.ts; the server gathers the facts. Every number here is measured (the memory sampler) or read from
// files; nothing is guessed by a model.

const GB = 2 ** 30;
const gb = (n: number) => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;

/** What a loaded model holds right now (from the sampler: its process's working set and graphics memory). */
export interface Held {
  name: string;
  ram: number;
  gpu: number;
}

/** 'kept' and 'needed' are what PCs before 2.0.30 send for their models (a linked PC's bar is drawn as it came). */
export type SegmentKind = 'models' | 'kept' | 'needed' | 'other' | 'free';

export interface Segment {
  kind: SegmentKind;
  label: string;
  bytes: number;
  /** Part of the whole bar, 0 to 1. */
  share: number;
}

/**
 * One memory bar: the models loaded, everything else on the PC, and what is free. Each part is named in words as well as
 * shaded, so colour is never the only sign.
 */
export function memoryBar(total: number, used: number, held: { name: string; bytes: number }[]): { segments: Segment[]; text: string } {
  const t = Math.max(1, total);
  const u = Math.min(t, Math.max(0, used));
  const models = held.filter(h => h.bytes > 0);
  // Models are part of "used"; a model counted larger than all use (graphics memory borrowed from RAM) is capped.
  const m = Math.min(u, models.reduce((a, h) => a + h.bytes, 0));
  const segments: Segment[] = [
    { kind: 'models', label: models.length ? `Models loaded: ${models.map(h => h.name).join(', ')}` : 'Models loaded', bytes: m, share: m / t },
    { kind: 'other', label: 'Other programs and Windows', bytes: u - m, share: (u - m) / t },
    { kind: 'free', label: 'Free', bytes: t - u, share: (t - u) / t },
  ];
  const words = segments.filter(s => s.bytes > 0 || s.kind === 'free').map(s => `${s.kind === 'models' ? 'models loaded' : s.kind === 'other' ? 'other programs' : 'free'} ${gb(s.bytes)}`);
  return { segments: segments.filter(s => s.bytes > 0), text: `${words.join(' · ')} (of ${gb(t)})` };
}

/** About what a model needs loaded, from its file size: the same rule as the fit check before Connect. */
export const needOf = (bytes: number) => bytes * 1.1 + 0.8 * GB;

