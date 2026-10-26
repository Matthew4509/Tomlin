// Chat previews: a picture of a project's running site beside its chats in a person's window, so a
// chat is known at a glance. The picture is the Bridge's own (its hidden Edge, src/bridge/snaps.js), matched to the
// project by folder only. One picture a "day": a day starts at the first use after a 5-hour gap (working till 2 am and
// back at 9 = new pictures at 9), and the first message sent that day in a chat of that project takes one in the
// background, never holding up the message, and only when that site is already running (no site or Edge is started
// for it). Opening the window shows the picture kept, yesterday's too. Kept in data/previews.json.
import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.ts';

/** A gap with no use this long starts a new "day": longer than an evening break, shorter than a night. */
export const GAP_MS = 5 * 3600_000;

/** `last`: the last use; `day`: when the current day began; `taken`: when each project's picture was last asked for. */
export interface DayState { last: number; day: number; taken: Record<string, number> }
export const freshDay = (): DayState => ({ last: 0, day: 0, taken: {} });

const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
export function cleanDay(raw: unknown): DayState {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const t = o.taken && typeof o.taken === 'object' ? o.taken as Record<string, unknown> : {};
  return { last: time(o.last), day: time(o.day), taken: Object.fromEntries(Object.entries(t).filter(([k, v]) => k && time(v)).map(([k, v]) => [k, v as number])) };
}

/** A use (a page opened, a message sent): after a 5-hour gap it starts a new day. */
export function used(s: DayState, now: number): DayState {
  return { ...s, last: now, day: now - s.last >= GAP_MS ? now : s.day };
}

/** This project's picture was not asked for yet today. */
export const wantsTake = (s: DayState, project: string) => !((s.taken[project] ?? 0) >= s.day && s.day > 0);

/** How a chat's row shows its project's picture: none (no project), hidden until Show preview (an artist's), or shown. */
export function previewMode(chat: { project?: string }, artist: boolean): 'none' | 'hidden' | 'show' {
  if (!chat.project) return 'none';
  return artist ? 'hidden' : 'show';
}

/**
 * Where the pictures come from (the Bridge part, src/server/bridge.ts): a project's folder on disk (null when it has
 * none), the picture kept for a folder and whether it has an icon (null when the Bridge does not know the folder), and
 * a new picture, taken only when the site is running.
 */
export interface Pictures {
  folderOf(project: string): Promise<string | null>;
  find(dir: string): { at: number | null; icon: boolean } | null;
  take(dir: string): Promise<{ ok: boolean; running: boolean }>;
}

export type TakeResult = 'taken' | 'not today' | 'no site' | 'not running' | 'failed' | 'busy';

export class Previews {
  private state: DayState | null = null;
  private saved = 0;
  private busy = new Set<string>();
  private file: string;
  private pictures: Pictures;
  private now: () => number;
  constructor(file: string, pictures: Pictures, now = () => Date.now()) {
    this.file = file;
    this.pictures = pictures;
    this.now = now;
  }

  private async load(): Promise<DayState> {
    if (!this.state) this.state = cleanDay(JSON.parse(await readFile(this.file, 'utf8').catch(() => 'null')));
    return this.state;
  }
  private async save(force = false): Promise<void> {
    // The last use is written at most once a minute: a restart is not a gap, and a page polling does not write each time.
    if (!force && this.now() - this.saved < 60_000) return;
    this.saved = this.now();
    await writeAtomic(this.file, JSON.stringify(this.state));
  }

  /** A use of TOMLIN now. */
  async use(): Promise<void> {
    const was = await this.load();
    this.state = used(was, this.now());
    await this.save(this.state.day !== was.day);
  }

  /** A message sent in a chat of this project: the day's picture, if it is not taken yet and the site is running. */
  async firstMessage(project: string): Promise<TakeResult> {
    const s = await this.load();
    if (!wantsTake(s, project)) return 'not today';
    if (this.busy.has(project)) return 'busy';
    this.busy.add(project);
    try {
      const dir = await this.pictures.folderOf(project);
      if (!dir) return 'no site';
      const r = await this.pictures.take(dir);
      // Not running: tried again on a later message that day (only a port is checked). Running but the picture did not
      // come out: not tried again until the next day, so Edge is not started on every message.
      if (!r.ok && !r.running) return 'not running';
      this.state = { ...(await this.load()), taken: { ...(await this.load()).taken, [project]: this.now() } };
      await this.save(true);
      return r.ok ? 'taken' : 'failed';
    } finally {
      this.busy.delete(project);
    }
  }

  /** Each project's kept picture (its time, or null) and whether it has an icon; projects with no site folder are left out. */
  async view(projects: string[]): Promise<Record<string, { at: number | null; icon: boolean }>> {
    const out: Record<string, { at: number | null; icon: boolean }> = {};
    for (const p of projects) {
      const dir = await this.pictures.folderOf(p);
      if (dir) out[p] = this.pictures.find(dir) ?? { at: null, icon: false };
    }
    return out;
  }
}
