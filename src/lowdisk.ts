// One low-disk floor for the whole app, and a warning. Each writer keeps its own room free as it writes (2 GB for
// downloads, copies and backups, 6 GB for a loan, 10 GB for project backups, 20 GB for the weight cache), but until
// this nothing said a drive was nearly full except during a loan, and a node nobody opens filled its drive unseen.
// Every few minutes the free space of the drive TOMLIN's data is on and of the drive its models are on is read: under
// LOW_DISK a line goes in the log (a louder one under VERY_LOW_DISK), one more when it has room again, and a
// notification at most once a day for each drive. Started by src/diskcare.ts; tested in test/lowdisk.test.ts.
import { statfs } from 'node:fs/promises';
import { driveOf } from './cleanup.ts';
import { readData, writeAtomic } from './atomic.ts';

const GB = 2 ** 30;
/** Under this much free on a drive TOMLIN writes to, it says so. */
export const LOW_DISK = 10 * GB;
/** Under this much it says so louder: Windows and every program on the PC start to fail. */
export const VERY_LOW_DISK = 5 * GB;
/** Room again: this much more than the floor (so a drive hovering at the floor is not said every few minutes). */
export const ROOM_AGAIN = LOW_DISK + GB;
/** A notification for one drive at most this often. */
export const TELL_EVERY_MS = 24 * 3600_000;
/** How often the drives are read. */
export const CHECK_EVERY_MS = 5 * 60_000;

export type Level = 'ok' | 'low' | 'very low';

export interface DriveState {
  level: Level;
  /** When a notification last went for this drive (ms; 0: never). */
  toldAt: number;
}

const gb = (n: number) => `${(Math.max(0, n) / GB).toFixed(1)} GB`;

/**
 * One reading of one drive: the state after it, the log line it calls for (null: none) and the notification words
 * (null: none due). `drive`: "C:" or a share's name; `what`: what TOMLIN keeps there ("your data and models"). Pure.
 */
export function diskStep(was: DriveState, free: number, drive: string, what: string, now: number): { state: DriveState; line: { loud: boolean; text: string } | null; tell: string | null } {
  const level: Level = free < VERY_LOW_DISK ? 'very low' : free < LOW_DISK ? 'low' : was.level !== 'ok' && free < ROOM_AGAIN ? was.level : 'ok';
  let line: { loud: boolean; text: string } | null = null;
  if (level === 'very low' && was.level !== 'very low') line = { loud: true, text: `Drive ${drive} is nearly full: only ${gb(free)} free. TOMLIN keeps ${what} there. Windows and programs start to fail when a drive is full: free up space on it now.` };
  else if (level === 'low' && was.level === 'ok') line = { loud: false, text: `Drive ${drive} has ${gb(free)} free, under the ${gb(LOW_DISK)} TOMLIN keeps free. TOMLIN keeps ${what} there. Free up some space on it.` };
  else if (level === 'ok' && was.level !== 'ok') line = { loud: false, text: `Drive ${drive} has room again: ${gb(free)} free.` };
  let tell: string | null = null;
  let toldAt = was.toldAt;
  // A time more than a day ahead was kept while the clock was wrong: it holds nothing back (else a clock set back by
  // years kept every notification back for years).
  if (level !== 'ok' && Math.abs(now - was.toldAt) >= TELL_EVERY_MS) {
    tell = `Drive ${drive} is nearly full: ${gb(free)} free. TOMLIN keeps ${what} there. Free up some space on it, or downloads, backups and lending will stop.`;
    toldAt = now;
  }
  return { state: { level, toldAt }, line, tell };
}

/** The drives to watch, one entry each: places on one drive are joined ("your data and models"). */
export function drivesOf(places: { path: string; what: string }[]): { drive: string; path: string; what: string }[] {
  const out: { drive: string; path: string; what: string }[] = [];
  for (const p of places) {
    if (!p.path) continue;
    const drive = driveOf(p.path) || p.path;
    const had = out.find(d => d.drive.toLowerCase() === drive.toLowerCase());
    if (!had) out.push({ drive, path: p.path, what: p.what });
    else if (!had.what.includes(p.what)) had.what = `${had.what} and ${p.what}`;
  }
  return out;
}

/** Free bytes for the drive `path` is on, or null when it cannot be read (a drive unplugged). */
export const freeOn = (path: string): Promise<number | null> => statfs(path).then(s => s.bavail * s.bsize, () => null);

export interface WatchDeps {
  /** Where TOMLIN writes, read each time (the models folder can be moved while it runs). */
  places: () => { path: string; what: string }[];
  free?: (path: string) => Promise<number | null>;
  /** A line for the log; `loud`: an error line, not a warning. */
  say: (loud: boolean, text: string) => void;
  /** A notification (the caller checks Mute). */
  tell: (text: string) => Promise<void> | void;
  /** Where the time of the last notification for each drive is kept, so a restart does not say it again the same day. */
  file?: string;
}

export class LowDiskWatch {
  private states = new Map<string, DriveState>();
  private loaded = false;
  private d: WatchDeps;

  constructor(d: WatchDeps) {
    this.d = d;
  }

  /** Reads every drive once; a log line and a notification when due. Never throws. */
  async check(now = Date.now()): Promise<void> {
    try {
      if (!this.loaded && this.d.file) {
        const raw = await readData<unknown>(this.d.file, {}).catch(() => ({}));
        // A file that holds no times (null, a list) reads as none: it must never stop the drives being read.
        const kept = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, number>;
        for (const [drive, toldAt] of Object.entries(kept)) if (Number.isFinite(toldAt)) this.states.set(drive, { level: 'ok', toldAt });
      }
      this.loaded = true;
      let told = false;
      for (const { drive, path, what } of drivesOf(this.d.places())) {
        const free = await (this.d.free ?? freeOn)(path);
        if (free === null) continue;
        const key = drive.toLowerCase();
        const r = diskStep(this.states.get(key) ?? { level: 'ok', toldAt: 0 }, free, drive, what, now);
        this.states.set(key, r.state);
        if (r.line) this.d.say(r.line.loud, r.line.text);
        if (r.tell) {
          told = true;
          await Promise.resolve(this.d.tell(r.tell)).catch(() => undefined);
        }
      }
      if (told && this.d.file) await writeAtomic(this.d.file, JSON.stringify(Object.fromEntries([...this.states].map(([k, s]) => [k, s.toldAt])))).catch(() => undefined);
    } catch {
      // A reading that failed is tried again at the next one.
    }
  }

  /** The level each drive was at, last read (for tests and the log). */
  level(drive: string): Level {
    return this.states.get(drive.toLowerCase())?.level ?? 'ok';
  }

  /** Reads now and every `everyMs`; gives the way to stop. */
  start(everyMs = CHECK_EVERY_MS): () => void {
    void this.check();
    const t = setInterval(() => void this.check(), everyMs);
    t.unref();
    return () => clearInterval(t);
  }
}

/** Under this much free on the drive the gallery is on, the picture pane says so (a reminder only: pictures still save). */
export const PICTURE_ROOM = 2 * GB;

/** The picture pane's reminder ('' when there is room, or the free space could not be read). `drive`: "C:", or '' when not known. */
export function pictureRoomLine(free: number | null, drive: string): string {
  if (free === null || free >= PICTURE_ROOM) return '';
  return `${drive ? `Drive ${drive}` : 'The drive the gallery is on'} has ${gb(free)} free. Pictures still save; free up space soon.`;
}
