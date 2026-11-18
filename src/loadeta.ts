// How long a chat model takes to load, and how far it has got: for the loading screen in the chat (public/loading.js).
// The estimate is worked out, not guessed: the model's file size (every part) over this PC's read speed for the drive it
// is on, plus, for a load that borrows linked PCs, the bytes each of them is sent over the network at the link's speed.
// The speeds are measured: each finished load keeps its drive's speed (and the link's, for a borrowed load) in
// data/loadspeeds.json, so the next estimate is better; until a drive has one, the kind of drive says (a hard disk is
// much slower than an SSD). What is shown is the estimate plus 2%. While it loads, the runner's own progress (llama.cpp
// prints a dot for each 1% of the weights it has read in) or the memory the runner holds corrects it.
import { join } from 'node:path';
import { readData, writeAtomic } from './atomic.ts';

/** The shown estimate is the worked-out one plus 2%. */
export const MARGIN = 1.02;
/** Seconds a start takes besides reading the weights: the runner starting, the header, the context memory. */
export const START_SECONDS = 4;
/** Read speeds (bytes a second) until a drive has a measured one. */
export const DEFAULT_READ: Record<DriveKind, number> = { hdd: 120 * 1e6, ssd: 450 * 1e6, unknown: 150 * 2 ** 20 };
/** A gigabit link as it really runs. */
export const DEFAULT_NET = 112 * 1e6;
/** Speeds outside these are taken for a mistake (a file already in Windows' memory reads at many GB a second). */
const MIN_RATE = 5 * 1e6;
const MAX_RATE = 4 * 1e9;

export type DriveKind = 'hdd' | 'ssd' | 'unknown';

/** What a load is: worked out once, when it starts. */
export interface LoadPlan {
  /** The model file, every part, plus a guessing model's file. */
  bytes: number;
  /** "D:" (or a share's root). */
  drive: string;
  kind: DriveKind;
  /** Bytes a second read from that drive, and where the figure comes from. */
  read: number;
  readFrom: 'measured' | 'drive kind';
  /** The bytes sent to the linked PCs lending for it (0 for a load on this PC alone), and their names. */
  lentBytes: number;
  lenders: string[];
  /** Bytes a second over the network to them, and where the figure comes from. */
  net: number;
  netFrom: 'measured' | 'gigabit';
  /**
   * The weights stay in the file, mapped (llama.cpp's default on one PC): on the CPU they are then read as first used,
   * so the runner's dots run ahead of the disk and its memory is the better measure.
   */
  mapped: boolean;
  /** The runner puts weights on a graphics card. */
  card: boolean;
}

/** What the loading screen shows, worked out again at every look. */
export interface LoadView {
  bytes: number;
  drive: string;
  kind: DriveKind;
  lenders: string[];
  lentBytes: number;
  /** The first estimate, plus 2% (seconds). */
  firstSeconds: number;
  /** The estimate now, plus 2%: seconds so far plus seconds left. */
  totalSeconds: number;
  leftSeconds: number;
  spentSeconds: number;
  /** 0-1. */
  done: number;
  /** Where `done` comes from: the runner's own count, the bytes read from the drive, the memory it holds, or the clock. */
  basis: 'runner' | 'disk' | 'memory' | 'time';
  /** Bytes a second it is going at now, when measured. */
  rate: number | null;
  /** Read and network speeds the estimate used. */
  read: number;
  readFrom: LoadPlan['readFrom'];
  net: number;
  netFrom: LoadPlan['netFrom'];
  /** What it is doing, in words. */
  doing: string;
  /** Past the estimate with no progress to go by. */
  late: boolean;
}

/** Seconds the load should take, before the 2%. */
export function rawSeconds(p: Pick<LoadPlan, 'bytes' | 'read' | 'lentBytes' | 'net'>): number {
  // One after the other, as a traced load ran: first the lenders' part, read and sent (at the slower of the drive and
  // the link), then this PC's own part from the drive. DeepSeek-V4-Flash on two PCs: 52 GB sent at 73 MB/s (710 s),
  // then 31 GB read from D: at 130 MB/s (240 s), then 10 s of warm-up.
  const lent = Math.max(0, Math.min(p.bytes, p.lentBytes));
  const send = lent > 0 && p.net > 0 ? lent / Math.min(p.net, p.read > 0 ? p.read : p.net) : 0;
  const read = p.read > 0 ? (p.bytes - lent) / p.read : 0;
  return START_SECONDS + send + read;
}

/** The part of the weights sent to the lenders (0-1): their part is loaded first. */
const lentPart = (p: Pick<LoadPlan, 'bytes' | 'lentBytes'>) => (p.bytes > 0 ? Math.max(0, Math.min(1, p.lentBytes / p.bytes)) : 0);

/** The estimate shown: the worked-out seconds plus 2%, rounded up to a whole second. */
export function estimateSeconds(p: Pick<LoadPlan, 'bytes' | 'read' | 'lentBytes' | 'net'>): number {
  return Math.ceil(rawSeconds(p) * MARGIN);
}

/**
 * The part of the weights sent to lending PCs. `maxPlace`: Max mode's layer split (the devices and the layers each
 * takes; RPC devices are the lent ones; layers left off every device stay in this PC's RAM). Without one, the lenders
 * and this PC are taken to share it evenly.
 */
export function lentShare(lenders: number, layers: number, place?: { dev: string[]; split: number[] }): number {
  if (lenders <= 0) return 0;
  if (place && layers > 0 && place.split.length === place.dev.length) {
    const lent = place.dev.reduce((t, d, i) => t + (/^RPC\d+$/i.test(d) ? place.split[i] || 0 : 0), 0);
    if (lent >= 0) return Math.min(1, lent / layers);
  }
  return lenders / (lenders + 1);
}

/** "D: (hard disk)", "D: (SSD)", "D:". */
export function driveWords(drive: string, kind: DriveKind): string {
  return kind === 'hdd' ? `${drive} (hard disk)` : kind === 'ssd' ? `${drive} (SSD)` : drive;
}

const names = (n: string[]) => (n.length <= 1 ? n.map(x => `"${x}"`).join('') : `${n.slice(0, -1).map(x => `"${x}"`).join(', ')} and "${n[n.length - 1]}"`);

/**
 * One load, followed from its start. `text` takes what the runner prints, as it comes (its dots are not whole lines);
 * `view` says where it is.
 */
export class LoadTrack {
  readonly plan: LoadPlan;
  readonly startedAt: number;
  private readonly first: number;
  /**
   * The part of the weights in (0-1), from the runner's dots (llama.cpp's own tools print one for each 1%;
   * llama-server b11284 prints none) or from the bytes read from the model's drive (src/diskwatch.ts), whichever is
   * further; when it first moved and when it last did.
   */
  private dots = 0;
  private diskBytes = 0;
  /** The drive's count over the last seconds: [when, bytes]. */
  private recent: [number, number][] = [];
  private frac = 0;
  private src: 'runner' | 'disk' = 'disk';
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  /** When the lenders' part was all in and this PC's own part began (a load with lenders). */
  private ownFrom: number | null = null;
  /** The best fraction reached: the bar never goes back. */
  private best = 0;

  constructor(plan: LoadPlan, startedAt = Date.now()) {
    this.plan = plan;
    this.startedAt = startedAt;
    this.first = estimateSeconds(plan);
  }

  /** What the start before a restart measured of the drive (bytes a second), for the speeds kept; read once by src/server/panes.ts. */
  lesson: number | null = null;

  /** A new start on another device (or a second try): the count begins again; the clock does not. */
  restart(): void {
    this.lesson = this.measuredRate() ?? this.lesson;
    this.dots = 0;
    this.diskBytes = 0;
    this.recent = [];
    this.frac = 0;
    this.firstAt = null;
    this.lastAt = null;
    this.ownFrom = null;
  }

  /** The runner's count and the drive's measure the weights read (not so for mapped weights on the CPU: they are read as first used). */
  private counts(): boolean {
    return !(this.plan.mapped && !this.plan.card);
  }

  private moved(frac: number, src: 'runner' | 'disk', now: number, began = now): void {
    if (!this.counts() || frac <= this.frac) return;
    this.frac = Math.min(1, frac);
    this.src = src;
    this.firstAt ??= began;
    this.lastAt = now;
    if (this.ownFrom === null && this.plan.lentBytes > 0 && this.frac >= lentPart(this.plan)) this.ownFrom = now;
  }

  /** What the runner printed: a run of dots on a line of its own counts 1% each (a guessing model's run is not added). */
  text(piece: string, now = Date.now()): void {
    if (this.dots >= 100) return;
    for (const seg of piece.split(/\r\n|\r|\n/)) {
      if (!/^\.+$/.test(seg)) continue;
      this.dots = Math.min(100, this.dots + seg.length);
      this.moved(this.dots / 100, 'runner', now);
    }
  }

  /** The bytes read from the model's drive since this start began (src/diskwatch.ts, about once a second). */
  disk(bytes: number, now = Date.now()): void {
    if (!(bytes > this.diskBytes) || !(this.plan.bytes > 0)) return;
    // The first second's bytes were read over the second before it was told.
    const began = this.firstAt === null ? now - 1000 : now;
    this.diskBytes = bytes;
    this.recent.push([now, bytes]);
    if (this.recent.length > 30) this.recent.shift();
    this.moved(Math.min(0.99, bytes / this.plan.bytes), 'disk', now, began);
  }

  /** `held`: the memory the runner holds now (RAM and card), when the sampler has it. `stage`: the runner's own words. */
  view(now = Date.now(), held?: number, stage?: string | null): LoadView {
    const p = this.plan;
    const spent = Math.max(0, (now - this.startedAt) / 1000);
    // Memory only for mapped weights on the CPU (they come in as the runner first uses them); on a card Windows tells
    // a new runner's card memory late, and a card load read 5% that way when it was nearly done.
    const fromMemory = !this.counts() && held && p.bytes > 0 ? Math.min(0.99, held / p.bytes) : 0;
    let basis: LoadView['basis'] = 'time';
    let measured = 0;
    let since = this.startedAt;
    if (this.frac > 0 && !this.driveQuiet(now)) {
      basis = this.src;
      measured = this.frac;
      since = this.firstAt ?? this.startedAt;
    } else if (fromMemory > 0.02) {
      basis = 'memory';
      measured = fromMemory;
    }
    const byTime = Math.min(0.97, spent / Math.max(1, this.first));
    // Seconds left by the first estimate (it already holds the 2%).
    const leftByPlan = Math.max(0, this.first - spent);
    let left = leftByPlan;
    let rate: number | null = null;
    const last = basis === 'memory' ? now : this.lastAt ?? now;
    const going = Math.max(0.001, (last - since) / 1000);
    if (measured >= 1) {
      // Every weight is in: what is left is the start's own part (context memory, warm-up).
      left = Math.min(leftByPlan, START_SECONDS * MARGIN) || 0;
    } else if (measured > 0.01 && going >= 3) {
      const f = basis === 'memory' ? 0 : lentPart(p);
      let leftByRate: number;
      if (f > 0 && measured < f) {
        // Still sending: the rest of the lenders' part at the speed it goes now, then this PC's part from the drive.
        rate = (measured * p.bytes) / going;
        leftByRate = ((f - measured) * p.bytes) / rate + ((1 - f) * p.bytes) / p.read + START_SECONDS / 2;
      } else if (f > 0) {
        // This PC's own part: its speed from when it began (the drive's figure until there are 3 s of it).
        const own = this.ownFrom ? (last - this.ownFrom) / 1000 : 0;
        rate = own >= 3 && measured > f ? ((measured - f) * p.bytes) / own : p.read;
        leftByRate = ((1 - measured) * p.bytes) / rate + START_SECONDS / 2;
      } else {
        rate = (measured * p.bytes) / going;
        leftByRate = ((1 - measured) * p.bytes) / rate + START_SECONDS / 2;
      }
      // The more it has read, the more its own speed counts over the first estimate. Seconds since the last count are
      // taken off (the drive gave nothing then: the rest may already be in Windows' memory).
      const w = Math.min(1, measured / 0.1);
      const quiet = Math.max(0, (now - last) / 1000);
      left = Math.max(0, w * leftByRate * MARGIN - quiet) + (1 - w) * leftByPlan;
    }
    const done = basis === 'time' ? byTime : Math.min(0.99, measured);
    this.best = Math.max(this.best, done);
    const late = basis === 'time' && spent > this.first;
    return {
      bytes: p.bytes,
      drive: p.drive,
      kind: p.kind,
      lenders: p.lenders,
      lentBytes: p.lentBytes,
      firstSeconds: this.first,
      totalSeconds: Math.round(spent + left),
      leftSeconds: Math.round(left),
      spentSeconds: Math.round(spent),
      done: this.best,
      basis,
      rate: rate && Number.isFinite(rate) ? Math.round(rate) : null,
      read: p.read,
      readFrom: p.readFrom,
      net: p.net,
      netFrom: p.netFrom,
      doing: this.doing(basis === 'time' ? -1 : measured, spent, stage),
      late,
    };
  }

  /**
   * The drive has read little for 5 s while the load goes on: the rest is coming from Windows' memory (a file read
   * lately), so the drive is not what it waits for, and its count is no measure. A load that read 1 GB of 12 from the
   * drive, then nothing, was put at 756 s more; it was done 4 s later.
   */
  private driveQuiet(now: number): boolean {
    if (this.src !== 'disk' || this.frac >= 1 || this.firstAt === null || now - this.firstAt < 5000) return false;
    const old = this.recent.find(([t]) => t >= now - 5000) ?? this.recent[this.recent.length - 1];
    const [t0, b0] = old ?? [now, this.diskBytes];
    const s = Math.max(5, (now - t0) / 1000);
    return (this.diskBytes - b0) / s < 0.2 * this.plan.read;
  }

  /** `measured`: the part in (-1: not known, the clock says which part it should be on). */
  private doing(measured: number, spent: number, stage?: string | null): string {
    const p = this.plan;
    const from = driveWords(p.drive, p.kind);
    if (measured >= 1) return stage && !/^Reading the model file|^Starting/.test(stage) ? stage : 'Setting aside memory for the conversation';
    if (p.lenders.length && p.lentBytes > 0) {
      const sendEnds = START_SECONDS + p.lentBytes / Math.min(p.net, p.read);
      const sending = measured < 0 ? spent < sendEnds : measured < lentPart(p);
      return sending ? `Reading from ${from} and sending to ${names(p.lenders)}` : `Reading this PC's own part from ${from}`;
    }
    if (p.card) return `Reading from ${from} and placing it on the graphics card`;
    return `Reading from ${from} into memory`;
  }

  /** Bytes read from the model's drive by this start (null: not counted, as on a PC that is not Windows). */
  driveBytes(): number | null {
    return this.watched ? this.diskBytes : null;
  }

  /** The drive's count is running for this start. */
  watched = false;

  /**
   * Bytes a second the weights came in at, from the runner's count or the drive's (null: too short, or under half
   * of it counted: the rest came from Windows' memory, not the drive).
   */
  measuredRate(): number | null {
    if (!this.counts() || this.firstAt === null || this.lastAt === null || this.frac < 0.5) return null;
    const s = (this.lastAt - this.firstAt) / 1000;
    if (s < 2) return null;
    return (this.frac * this.plan.bytes) / s;
  }
}

// ---- The speeds kept per drive and per lending PC ----

interface Figure {
  /** Bytes a second. */
  rate: number;
  /** Loads measured. */
  n: number;
  at: string;
}

export interface SpeedFile {
  drives: Record<string, Figure>;
  links: Record<string, Figure>;
}

const okRate = (r: unknown): r is number => typeof r === 'number' && Number.isFinite(r) && r >= MIN_RATE && r <= MAX_RATE;
/** The new figure counts half: one load from Windows' memory (or a busy disk) does not set it alone. */
const blend = (old: Figure | undefined, rate: number): Figure => ({ rate: Math.round(old ? old.rate * 0.5 + rate * 0.5 : rate), n: (old?.n ?? 0) + 1, at: new Date().toISOString() });

/**
 * What a finished load says of the speeds: the drive's read speed (a load on this PC alone) or the link's (a borrowed
 * load, once the drive's part is taken off). `seconds`: from Connect to the runner answering. `dotRate`: the runner's
 * own measure, when it gave one (a load on this PC alone).
 */
export function learned(plan: LoadPlan, seconds: number, dotRate: number | null, fromDrive?: number | null): { read?: number; net?: number } {
  const work = seconds - START_SECONDS;
  if (!(work > 1) || !(plan.bytes > 0)) return {};
  // Under half of it came off the drive (the rest was in Windows' memory): the time says nothing of the drive or the
  // link. gpt-oss-20b loaded in 18.5 s that way, and would have put D: at 490 MB/s.
  if (typeof fromDrive === 'number' && fromDrive < plan.bytes / 2) return {};
  if (!plan.lenders.length || !(plan.lentBytes > 0)) {
    const read = dotRate ?? plan.bytes / work;
    return okRate(read) ? { read } : {};
  }
  const sending = work - (plan.bytes - plan.lentBytes) / plan.read;
  const net = sending > 1 ? plan.lentBytes / sending : NaN;
  return okRate(net) ? { net } : {};
}

export class LoadSpeeds {
  private readonly file: string;
  private all: SpeedFile = { drives: {}, links: {} };
  private saving: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  /** The speeds kept in `dir`, read in the background (a load started in the first moment uses the drive's kind). */
  static open(dir: string): LoadSpeeds {
    const s = new LoadSpeeds(join(dir, 'loadspeeds.json'));
    s.ready = LoadSpeeds.fill(s);
    return s;
  }

  /** Read once open() has read the file. */
  ready: Promise<void> = Promise.resolve();

  static async load(dir: string): Promise<LoadSpeeds> {
    const s = LoadSpeeds.open(dir);
    await s.ready;
    return s;
  }

  private static async fill(s: LoadSpeeds): Promise<void> {
    const got = await readData<Partial<SpeedFile> | null>(s.file, null).catch(() => null);
    const clean = (o: unknown): Record<string, Figure> => {
      const out: Record<string, Figure> = {};
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, Figure>)) if (v && okRate(v.rate)) out[k.slice(0, 80)] = { rate: v.rate, n: Number(v.n) || 1, at: String(v.at ?? '') };
      return out;
    };
    // Kept from the file, with anything measured meanwhile on top.
    s.all = { drives: { ...clean(got?.drives), ...s.all.drives }, links: { ...clean(got?.links), ...s.all.links } };
  }

  /** In memory only (tests). */
  static empty(): LoadSpeeds {
    return new LoadSpeeds('');
  }

  read(drive: string): number | null {
    return this.all.drives[drive]?.rate ?? null;
  }

  /** The slowest of the lenders' links (the load waits for the last one). */
  net(lenders: string[]): number | null {
    const known = lenders.map(n => this.all.links[n]?.rate).filter(okRate);
    return known.length ? Math.min(...known) : null;
  }

  /** Keeps what a finished load measured. */
  keep(plan: LoadPlan, got: { read?: number; net?: number }): void {
    if (got.read) this.all.drives[plan.drive] = blend(this.all.drives[plan.drive], got.read);
    if (got.net) for (const n of plan.lenders) this.all.links[n] = blend(this.all.links[n], got.net);
    if (!this.file || (!got.read && !got.net)) return;
    const data = JSON.stringify(this.all);
    this.saving = this.saving.then(() => writeAtomic(this.file, data)).catch(() => undefined);
  }

  /** Done once every save asked for so far is written. */
  saved(): Promise<void> {
    return this.saving;
  }

  figures(): SpeedFile {
    return this.all;
  }
}

/** The plan for a load, from what is known now. `earlier`: drive speeds from this PC's timed loads (modelhome.driveReadSpeeds). */
export function planLoad(o: {
  bytes: number;
  drive: string;
  kind: DriveKind;
  speeds: LoadSpeeds;
  earlier?: Record<string, number>;
  lenders?: string[];
  lentShare?: number;
  mapped: boolean;
  card: boolean;
}): LoadPlan {
  const kept = o.speeds.read(o.drive);
  const before = o.earlier?.[o.drive];
  const read = kept ?? (okRate(before) ? before : null);
  const lenders = o.lenders ?? [];
  const net = lenders.length ? o.speeds.net(lenders) : null;
  return {
    bytes: o.bytes,
    drive: o.drive,
    kind: o.kind,
    read: read ?? DEFAULT_READ[o.kind],
    readFrom: read ? 'measured' : 'drive kind',
    lentBytes: lenders.length ? Math.round(o.bytes * (o.lentShare ?? lenders.length / (lenders.length + 1))) : 0,
    lenders,
    net: net ?? DEFAULT_NET,
    netFrom: net ? 'measured' : 'gigabit',
    mapped: o.mapped,
    card: o.card,
  };
}
