// Which pictures make good starts for video. Two kinds of word, never mixed up:
// Expected: what each picture style (src/styles.ts) is likely to do in a clip. Video models such as Wan are trained on
// real video, so a photo-like start keeps its look, while a drawn one is pulled toward real life (faces change).
// Seen: counted from clips made here. Each clip made from a start picture is noted in data/pairing.json with the facts
// that picture gives (the picture model and the style that drew it; unknown when it does not say) and the video model
// that made it. A clip counts as kept when the person pressed Keep on it in a shot list, or when it is still on the
// Videos shelf a day after it was made; it counts as not kept when another take of its shot was kept, or when it was
// deleted within that day. A clip made again from the same start with the same video model is counted as made again.
// Nothing here guesses: "Seen" is only said with clips counted. Plain functions; the file is kept by src/server/pairing.ts.
import { isModelKey, pickedStyle, STYLES } from './styles.ts';

export type VideoFit = 'good' | 'drifts' | 'depends';

export interface Expected {
  fit: VideoFit;
  /** One short plain line why. */
  reason: string;
}

/** What each style is expected to do as a clip's start picture (not seen: from how video models are trained). */
export const EXPECTED: Record<string, Expected> = {
  auto: { fit: 'depends', reason: 'Depends on the look drawn: Auto picks the style from the words typed.' },
  photo: { fit: 'good', reason: 'Video models learn from real video, so a photo keeps its look.' },
  cinematic: { fit: 'good', reason: 'A film still is what video models learn from, so it keeps its look.' },
  cdrama: { fit: 'good', reason: 'Realistic people in a real room: video models keep that look.' },
  anime: { fit: 'drifts', reason: 'Flat drawn colour is pulled toward real life, so faces may change.' },
  ink: { fit: 'drifts', reason: 'Ink lines and washes are pulled toward a real-life look as the clip goes on.' },
  cartoon: { fit: 'drifts', reason: 'A drawn cartoon is pulled toward real life, so faces may change.' },
  watercolour: { fit: 'drifts', reason: 'Soft paint is pulled toward a real-life look as the clip goes on.' },
  surreal: { fit: 'drifts', reason: 'A painted dream is pulled toward real life: odd shapes and light may not hold.' },
  pixel: { fit: 'drifts', reason: 'Square pixels smear and are pulled toward a smooth real-life look.' },
  icon: { fit: 'drifts', reason: 'A flat graphic is pulled toward a real-life look, and its edges smear.' },
};

/** The line under a style tile. */
export const FIT_LABEL: Record<VideoFit, string> = { good: 'Good start for video', drifts: 'Changes look in video', depends: 'Depends on the look drawn' };

/** A style's expected fit; one not in the table (a style added later) depends on the look drawn. */
export const expectedOf = (style: unknown): Expected => EXPECTED[pickedStyle(style)?.id ?? 'auto'] ?? EXPECTED.auto;

/** The styles expected to hold in a clip, by name. */
export const goodStyles = (): string[] => STYLES.filter(s => EXPECTED[s.id]?.fit === 'good').map(s => s.name);

const nameOfStyle = (id: string): string => STYLES.find(s => s.id === id)?.name ?? id;

/** The words joined: "a, b and c". */
export const listWords = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The warning under a start picture in a style that drifts ('' for any other, or a style not known). */
export function driftWarning(style: unknown): string {
  const s = pickedStyle(style);
  if (!s || EXPECTED[s.id]?.fit !== 'drifts') return '';
  return `This picture is in ${s.name}: video models tend to pull it toward real life, so faces may change. A Photo or Cinematic still holds better.`;
}

// ---- What a start picture says about itself ----

/** The facts a start picture gives: what drew it and in which style (null: not known). `key`: the same start again. */
export interface StartFacts {
  key: string | null;
  /** The picture model's id in TOMLIN's list, and its name. */
  pictureModel: string | null;
  pictureName: string | null;
  style: string | null;
}

/** A model's name for the lines: without its kind in brackets, and without "on <PC>" for a linked PC's picture. */
export function shortModelName(name: unknown, device?: unknown): string | null {
  let n = typeof name === 'string' ? name.trim() : '';
  const on = typeof device === 'string' ? device.trim() : '';
  if (on.startsWith('on ') && n.endsWith(` ${on}`)) n = n.slice(0, -on.length - 1);
  n = n.replace(/\s*\(.*\)$/, '').trim();
  return n ? n.slice(0, 120) : null;
}

/** The parts of a gallery picture (src/gallery.ts Picture) its facts are read from. */
export interface PictureFacts {
  id: string;
  model?: string;
  modelName?: string;
  device?: string;
  style?: string;
}

/** A gallery picture's facts: its model (an id only when drawn here; a linked PC's picture by name), its style if it says. */
export function factsOfPicture(p: PictureFacts): StartFacts {
  return {
    key: `gallery:${p.id}`,
    pictureModel: p.model && p.model !== 'remote' && isModelKey(p.model) ? p.model : null,
    pictureName: shortModelName(p.modelName, p.device),
    style: pickedStyle(p.style)?.id ?? null,
  };
}

/** A style sample's facts: its record names the model and the style. */
export function factsOfSample(model: string, style: string, modelName?: string): StartFacts {
  return { key: `sample:${model}/${style}`, pictureModel: isModelKey(model) ? model : null, pictureName: shortModelName(modelName) ?? (isModelKey(model) ? model : null), style: pickedStyle(style)?.id ?? null };
}

/** A start picture that says nothing about how it was drawn (a file, a clip's frame). */
export const unknownFacts = (key: string | null): StartFacts => ({ key, pictureModel: null, pictureName: null, style: null });

// ---- The notes kept ----

export interface ClipNote {
  clip: string;
  at: string;
  /** The start picture's key (the same start again), or null. */
  start: string | null;
  pictureModel: string | null;
  pictureName: string | null;
  style: string | null;
  /** The video model's id. */
  video: string;
  /** Made from a start this video model had made a clip from already. */
  again: boolean;
  /** Keep pressed on it in a shot list. */
  kept?: boolean;
  /** Another take of its shot was kept. */
  passed?: boolean;
  /** When it was deleted from the Videos shelf. */
  deletedAt?: string;
}

export interface PairingFile {
  version: 1;
  clips: ClipNote[];
  /** The counts of older notes that no longer fit (over MAX_NOTES), so the counts never shrink as the notes go. */
  past?: SeenRow[];
}

/** How long a clip has to stay on the shelf to count as kept. */
export const KEEP_MS = 24 * 3_600_000;
/** The newest notes kept one by one: older ones are folded into the counts kept with them (`past`). */
export const MAX_NOTES = 5000;

export const emptyPairing = (): PairingFile => ({ version: 1, clips: [] });

/**
 * Whether a file read back is the shape this TOMLIN writes (version 1, its notes in a list). One that is not (from
 * another version, or edited by hand) is set aside before a note is written, never written over.
 */
export function isPairingShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return Array.isArray(r.clips) && (r.version === undefined || r.version === 1) && (r.past === undefined || Array.isArray(r.past));
}

const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);

/** The key a note or a row is counted under: its picture model (its id, else its name), style and video model. */
const rowKey = (r: { pictureModel: string | null; pictureName: string | null; style: string | null; video: string }): string =>
  JSON.stringify([r.pictureModel ?? '', r.pictureModel ? '' : r.pictureName ?? '', r.style ?? '', r.video]);

/** Rows added together by their key. */
function addRows(into: Map<string, SeenRow>, rows: readonly SeenRow[]): Map<string, SeenRow> {
  for (const x of rows) {
    const key = rowKey(x);
    const r = into.get(key) ?? { pictureModel: x.pictureModel, pictureName: x.pictureName, style: x.style, video: x.video, made: 0, counted: 0, kept: 0, again: 0 };
    r.made += x.made;
    r.counted += x.counted;
    r.kept += x.kept;
    r.again += x.again;
    if (!r.pictureName && x.pictureName) r.pictureName = x.pictureName;
    into.set(key, r);
  }
  return into;
}

/** Over MAX_NOTES notes: the oldest are folded into the past counts (as they stand at `now`), never dropped from them. */
function folded(f: PairingFile, now: number): PairingFile {
  if (f.clips.length <= MAX_NOTES) return f;
  const old = f.clips.slice(0, f.clips.length - MAX_NOTES);
  const past = [...addRows(addRows(new Map(), f.past ?? []), seenRows({ version: 1, clips: old }, now)).values()];
  return { version: 1, clips: f.clips.slice(-MAX_NOTES), past };
}

/** The past counts as read back: a row that does not fit is dropped, and a row never says more kept than counted. */
function cleanPast(raw: unknown): SeenRow[] {
  if (!Array.isArray(raw)) return [];
  const out: SeenRow[] = [];
  for (const x of raw.slice(0, MAX_NOTES)) {
    const n = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    const video = strOrNull(n?.video, 80);
    const made = count(n?.made);
    if (!n || !video || !made) continue;
    const counted = Math.min(count(n.counted), made);
    out.push({
      pictureModel: isModelKey(n.pictureModel) ? n.pictureModel : null, pictureName: strOrNull(n.pictureName, 120), style: pickedStyle(n.style)?.id ?? null, video,
      made, counted, kept: Math.min(count(n.kept), counted), again: Math.min(count(n.again), made),
    });
  }
  return out;
}

/** The file as read back: anything that does not fit is dropped; notes over MAX_NOTES are folded into the past counts. */
export function cleanPairing(raw: unknown, now = Date.now()): PairingFile {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const out = emptyPairing();
  if (!r || !Array.isArray(r.clips)) return out;
  const past = cleanPast(r.past);
  if (past.length) out.past = past;
  for (const x of r.clips) {
    const n = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    const clip = strOrNull(n?.clip, 40);
    const at = strOrNull(n?.at, 40);
    const video = strOrNull(n?.video, 80);
    if (!n || !clip || !at || !video || Number.isNaN(Date.parse(at))) continue;
    const deletedAt = strOrNull(n.deletedAt, 40);
    out.clips.push({
      clip, at, start: strOrNull(n.start, 400), pictureModel: isModelKey(n.pictureModel) ? n.pictureModel : null, pictureName: strOrNull(n.pictureName, 120),
      style: pickedStyle(n.style)?.id ?? null, video, again: n.again === true,
      ...(n.kept === true ? { kept: true } : {}), ...(n.passed === true ? { passed: true } : {}), ...(deletedAt && !Number.isNaN(Date.parse(deletedAt)) ? { deletedAt } : {}),
    });
  }
  return folded(out, now);
}

/** A clip made from a start picture, noted with that picture's facts (a clip noted already is left as it is). */
export function withClip(f: PairingFile, facts: StartFacts, clip: { id: string; at: string; model: string }, now = Date.now()): PairingFile {
  if (f.clips.some(n => n.clip === clip.id)) return f;
  const again = !!facts.key && f.clips.some(n => n.start === facts.key && n.video === clip.model);
  const note: ClipNote = { clip: clip.id, at: clip.at, start: facts.key, pictureModel: facts.pictureModel, pictureName: facts.pictureName, style: facts.style, video: clip.model, again };
  return folded({ ...f, clips: [...f.clips, note] }, now);
}

/** Keep pressed on a shot's take: that clip kept, the shot's other takes not. Null when none of them is noted. */
export function withKept(f: PairingFile, kept: string, takes: string[]): PairingFile | null {
  const others = new Set(takes.filter(t => t !== kept));
  if (!f.clips.some(n => n.clip === kept || others.has(n.clip))) return null;
  return {
    ...f,
    clips: f.clips.map(n => {
      if (n.clip !== kept && !others.has(n.clip)) return n;
      const m = { ...n };
      delete m.kept;
      delete m.passed;
      return n.clip === kept ? { ...m, kept: true } : { ...m, passed: true };
    }),
  };
}

/** Clips deleted from the shelf. Null when none of them is noted. */
export function withDeleted(f: PairingFile, ids: string[], now: Date): PairingFile | null {
  const gone = new Set(ids);
  if (!f.clips.some(n => gone.has(n.clip) && !n.deletedAt)) return null;
  return { ...f, clips: f.clips.map(n => (gone.has(n.clip) && !n.deletedAt ? { ...n, deletedAt: now.toISOString() } : n)) };
}

export type Outcome = 'kept' | 'not kept' | 'too soon';

/**
 * What a clip's note says now: kept, not kept, or too soon to tell (under a day old and still on the shelf). A note dated
 * over a day ahead of now was made while the clock ran fast and was set right since: how long it has been on the shelf
 * cannot be told from its date, and it is still there, so it counts as kept (deleted, it counts as not kept, above).
 */
export function outcomeOf(n: ClipNote, now: number): Outcome {
  if (n.kept) return 'kept';
  if (n.passed) return 'not kept';
  const at = Date.parse(n.at);
  if (n.deletedAt) return Date.parse(n.deletedAt) - at < KEEP_MS ? 'not kept' : 'kept';
  if (at - now > KEEP_MS) return 'kept';
  return now - at >= KEEP_MS ? 'kept' : 'too soon';
}

/** The counts for one picture model, style and video model. `counted`: the clips old enough to tell (kept or not). */
export interface SeenRow {
  pictureModel: string | null;
  pictureName: string | null;
  style: string | null;
  video: string;
  made: number;
  counted: number;
  kept: number;
  again: number;
}

/** Every note counted (with the past counts of older notes), per picture model (its id, else its name), style and video model. */
export function seenRows(f: PairingFile, now: number): SeenRow[] {
  const rows = addRows(new Map<string, SeenRow>(), f.past ?? []);
  for (const n of f.clips) {
    const key = rowKey(n);
    const r = rows.get(key) ?? { pictureModel: n.pictureModel, pictureName: n.pictureName, style: n.style, video: n.video, made: 0, counted: 0, kept: 0, again: 0 };
    const o = outcomeOf(n, now);
    r.made++;
    if (o !== 'too soon') r.counted++;
    if (o === 'kept') r.kept++;
    if (n.again) r.again++;
    if (!r.pictureName && n.pictureName) r.pictureName = n.pictureName;
    rows.set(key, r);
  }
  return [...rows.values()];
}

// ---- The lines shown ----

const norm = (name: unknown): string => (typeof name === 'string' ? name.replace(/\s*\(.*\)$/, '').trim().toLowerCase() : '');

/** A row is of the picture model `key` (its id in TOMLIN's list) or named `name` (a linked PC's picture names its model only). */
export function rowOfPicture(r: SeenRow, key: string, name: string): boolean {
  if (r.pictureModel) return r.pictureModel === key;
  return !!r.pictureName && !!norm(name) && norm(r.pictureName) === norm(name);
}

const clipsWord = (n: number): string => `${n} clip${n === 1 ? '' : 's'}`;
/** "Seen: kept 2 of 3 clips with Wan 2.2 5B" (and how many were made again). Only for clips counted. */
export function seenWords(kept: number, counted: number, video: string, again = 0): string {
  return `Seen: kept ${kept} of ${clipsWord(counted)} with ${video}${againWords(again)}`;
}
/** "; 2 made again from the same picture", or nothing. */
const againWords = (n: number): string => (n ? `; ${n} made again from the same picture` : '');

/** Totals of some rows. */
function sum(rows: SeenRow[]): { made: number; counted: number; kept: number; again: number } {
  return rows.reduce((t, r) => ({ made: t.made + r.made, counted: t.counted + r.counted, kept: t.kept + r.kept, again: t.again + r.again }), { made: 0, counted: 0, kept: 0, again: 0 });
}

export interface FitView {
  fit: VideoFit;
  /** The line under the tile. */
  label: string;
  /** Expected, or Seen when clips were counted. */
  tag: 'Expected' | 'Seen';
  /** The hover: the reason, then Expected or what was seen. */
  hover: string;
}

/**
 * A style tile's video line for the picture model `key` / `name`: the expected fit, with what was seen for that model
 * and style per video model. `videoName`: a video model's name from its id.
 */
export function styleFit(style: string, key: string, name: string, rows: SeenRow[], videoName: (id: string) => string): FitView {
  const e = expectedOf(style);
  const s = pickedStyle(style);
  const mine = s ? rows.filter(r => r.style === s.id && r.counted > 0 && rowOfPicture(r, key, name)) : [];
  const byVideo = new Map<string, SeenRow[]>();
  for (const r of mine) byVideo.set(r.video, [...(byVideo.get(r.video) ?? []), r]);
  const seen = [...byVideo].map(([v, rs]) => {
    const t = sum(rs);
    return seenWords(t.kept, t.counted, videoName(v), t.again);
  });
  return { fit: e.fit, label: FIT_LABEL[e.fit], tag: seen.length ? 'Seen' : 'Expected', hover: `${e.reason} ${seen.length ? `${seen.join('. ')}.` : 'Expected, not seen yet.'}` };
}

export interface PairLine {
  text: string;
  tag: 'Expected' | 'Seen';
  hover: string;
}

/** The styles that held in some rows: more kept than not, by name. */
function heldStyles(rows: SeenRow[]): string[] {
  const by = new Map<string, SeenRow[]>();
  for (const r of rows) if (r.style) by.set(r.style, [...(by.get(r.style) ?? []), r]);
  return [...by].filter(([, rs]) => {
    const t = sum(rs);
    return t.kept > 0 && t.kept * 2 >= t.counted;
  }).map(([id]) => nameOfStyle(id));
}

/** Per style, kept of counted: "Photo kept 2 of 2, style not known kept 1 of 1". */
function perStyle(rows: SeenRow[]): string {
  const by = new Map<string, SeenRow[]>();
  for (const r of rows) by.set(r.style ?? '', [...(by.get(r.style ?? '') ?? []), r]);
  return [...by].map(([id, rs]) => {
    const t = sum(rs);
    return `${id ? nameOfStyle(id) : 'style not known'} kept ${t.kept} of ${t.counted}`;
  }).join(', ');
}

/** The picture model's line for one video model: "<picture> goes well with <video> (styles ...)", Expected or Seen. */
export function pictureLine(model: { key: string; name: string }, video: { id: string; name: string }, rows: SeenRow[]): PairLine {
  const picture = { key: model.key, name: shortModelName(model.name) ?? model.key };
  const mine = rows.filter(r => r.video === video.id && r.counted > 0 && rowOfPicture(r, picture.key, picture.name));
  const expected = `${picture.name} goes well with ${video.name} (styles ${listWords(goodStyles())})`;
  if (!mine.length) return { text: expected, tag: 'Expected', hover: 'Expected, not seen yet: video models learn from real video, so photo-like pictures keep their look and drawn ones change.' };
  const t = sum(mine);
  const held = heldStyles(mine);
  const unknownKept = mine.filter(r => !r.style).reduce((n, r) => n + r.kept, 0);
  const text = held.length ? `${picture.name} goes well with ${video.name} (styles ${listWords(held)})`
    : unknownKept > 0 && t.kept * 2 >= t.counted ? `${picture.name} goes well with ${video.name} (styles not known)`
    : `${picture.name} has not gone well with ${video.name} yet`;
  return { text, tag: 'Seen', hover: `${seenWords(t.kept, t.counted, video.name)} (${perStyle(mine)})${againWords(t.again)}.` };
}

/** The video model's line: "Starts best from pictures in <styles>, drawn by <picture models seen>", Expected or Seen. */
export function videoLine(video: { id: string; name: string }, rows: SeenRow[]): PairLine {
  const mine = rows.filter(r => r.video === video.id && r.counted > 0);
  const expected = listWords(goodStyles());
  if (!mine.length) return { text: `Starts best from pictures in ${expected}`, tag: 'Expected', hover: 'Expected, not seen yet: no clips made from a picture with it have been counted.' };
  const t = sum(mine);
  const held = heldStyles(mine);
  const by = [...new Set(mine.filter(r => r.kept > 0).map(r => r.pictureName ?? r.pictureModel ?? '').filter(Boolean))];
  const styles = held.length ? listWords(held) : expected;
  const text = `Starts best from pictures in ${styles}${by.length ? `, drawn by ${listWords(by)}` : ''}`;
  return { text, tag: 'Seen', hover: `${seenWords(t.kept, t.counted, video.name)} (${perStyle(mine)})${againWords(t.again)}.${held.length ? '' : ' The styles are expected: none of the clips kept says its style.'}` };
}
