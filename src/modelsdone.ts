// What the models have done (W2-23): This PC's "Models on this PC" shows, for the last days, each chat model's answers
// and time worked, each picture model's pictures and their seconds by size, and each video model's clips and their time
// for 5 seconds, from what TOMLIN keeps already (data/usage-models.json, the gallery, the Videos shelf). Nothing is
// measured for it: a model not used yet still has its speed test.

/** A picture as the gallery keeps it: only what is summed here. */
export interface DonePicture { at: string; modelName: string; seconds: number; generated?: { width: number; height: number } | null; removed?: boolean }
/** A clip as the Videos shelf keeps it. */
export interface DoneClip { at: string; model: string; seconds: number; quality: string; tookMs: number; pc?: string; removed?: boolean }
/** A chat model's use on one PC: time worked and answers over the days asked (meter.ts ByModel.top). */
export interface DoneChat { pc: string; model: string; ms: number; answers: number }

export interface ModelsDone {
  days: number;
  today: { pictures: number; clips: number; drawMs: number };
  chat: { name: string; pc: string; answers: number; secondsEach: number }[];
  pictures: { name: string; count: number; sizes: { px: number; count: number; seconds: number }[] }[];
  clips: { name: string; pc: string; count: number; quality: string; minutesFor5s: number }[];
}

const DAY = 24 * 3600 * 1000;
const sameDay = (iso: string, now: Date) => new Date(iso).toDateString() === now.toDateString();
/** A model's file name in words: no folder, no ".gguf", no "-00001-of-00004". */
export const modelWords = (id: string) => id.replace(/^.*[\\/]/, '').replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '');

/** The last `days` days of work, newest kinds first; `names` gives a video model's words by its id. */
export function modelsDone(o: { pictures: DonePicture[]; clips: DoneClip[]; chat: DoneChat[]; videoNames?: Record<string, string>; now?: Date; days?: number }): ModelsDone {
  const now = o.now ?? new Date();
  const days = o.days ?? 7;
  const since = now.getTime() - days * DAY;
  const recent = <T extends { at: string; removed?: boolean }>(xs: T[]) => xs.filter(x => !x.removed && Date.parse(x.at) >= since);
  const pics = recent(o.pictures).filter(p => p.seconds > 0);
  const clips = recent(o.clips).filter(c => c.tookMs > 0);

  const byPic = new Map<string, Map<number, number[]>>();
  for (const p of pics) {
    const px = p.generated?.width ?? 0;
    const sizes = byPic.get(p.modelName) ?? new Map<number, number[]>();
    sizes.set(px, [...(sizes.get(px) ?? []), p.seconds]);
    byPic.set(p.modelName, sizes);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const pictures = [...byPic].map(([name, sizes]) => ({
    name,
    count: [...sizes.values()].reduce((n, xs) => n + xs.length, 0),
    sizes: [...sizes].sort((a, b) => a[0] - b[0]).map(([px, xs]) => ({ px, count: xs.length, seconds: Math.round(avg(xs) * 10) / 10 })),
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const byClip = new Map<string, DoneClip[]>();
  for (const c of clips) {
    const key = `${c.model}|${c.pc ?? 'this PC'}|${c.quality}`;
    byClip.set(key, [...(byClip.get(key) ?? []), c]);
  }
  const clipRows = [...byClip].map(([key, cs]) => {
    const [model, pc, quality] = key.split('|');
    // Minutes for 5 seconds of clip: each clip's time scaled to 5 s, then the average.
    return { name: o.videoNames?.[model] ?? model, pc, count: cs.length, quality, minutesFor5s: Math.round(avg(cs.map(c => (c.tookMs / 60000) * (5 / Math.max(1, c.seconds)))) * 10) / 10 };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const chat = o.chat.filter(c => c.answers > 0).map(c => ({ name: modelWords(c.model), pc: c.pc, answers: c.answers, secondsEach: Math.round(c.ms / c.answers / 100) / 10 }))
    .sort((a, b) => b.answers - a.answers || a.name.localeCompare(b.name));

  const todayPics = pics.filter(p => sameDay(p.at, now));
  const todayClips = clips.filter(c => sameDay(c.at, now));
  const drawMs = Math.round(todayPics.reduce((n, p) => n + p.seconds * 1000, 0) + todayClips.reduce((n, c) => n + c.tookMs, 0));
  return { days, today: { pictures: todayPics.length, clips: todayClips.length, drawMs }, chat, pictures, clips: clipRows };
}
