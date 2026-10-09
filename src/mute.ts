// Mute: quiet, not stopped. A muted chat, staff member or job room keeps working; mute only takes away the number
// badge (a grey dot shows instead), the page sound and the Windows notification (src/notify.ts). "Mute all"
// covers everything. One tick, on by default, still tells him when a job is stuck waiting for him.
// Kept in data/mute.json. Plain functions, tested in test/mute.test.ts; the server keeps the file, the page draws it.
import { join } from 'node:path';
import { readData, writeAtomic } from './atomic.ts';

/** One mute: when it ends (an ISO time), or null = until he unmutes. */
export interface Mute {
  until: string | null;
  at: string;
}

export interface Mutes {
  all: Mute | null;
  /** By key: "manager", "staff:<id>", "node:<pc>:<hire>", "room:<job id>", "chat:<chat id>". */
  items: Record<string, Mute>;
  /** "Still tell me when a job is stuck waiting for me" (on by default). */
  stuckTells: boolean;
}

export type Length = 'hour' | 'morning' | 'forever';
export type Event = 'finished' | 'question' | 'stuck';

export const EMPTY: Mutes = { all: null, items: {}, stuckTells: true };
const KEY = /^(manager|staff:[\w-]{1,64}|node:[\w-]{1,64}:[\w-]{1,64}|room:[\w-]{1,80}|chat:[\w-]{1,80})$/;

export const isKey = (key: unknown): key is string => typeof key === 'string' && KEY.test(key);
export const isLength = (x: unknown): x is Length => x === 'hour' || x === 'morning' || x === 'forever';

/** When a mute of this length, started now, ends. "Tomorrow morning" is 8 am the next day (8 am today before 5 am). */
export function untilFor(length: Length, now = new Date()): string | null {
  if (length === 'forever') return null;
  if (length === 'hour') return new Date(now.getTime() + 3_600_000).toISOString();
  const d = new Date(now);
  if (d.getHours() >= 5) d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

export const live = (m: Mute | null | undefined, now = new Date()): m is Mute => !!m && (m.until === null || Date.parse(m.until) > now.getTime());

/** The mutes still running (ended ones are dropped). */
export function sweep(m: Mutes, now = new Date()): Mutes {
  return {
    all: live(m.all, now) ? m.all : null,
    items: Object.fromEntries(Object.entries(m.items).filter(([k, v]) => isKey(k) && live(v, now))),
    stuckTells: m.stuckTells !== false,
  };
}

/** Sets (or, with length 'off', ends) one mute; key 'all' is Mute all. */
export function set(m: Mutes, key: string, length: Length | 'off', now = new Date()): Mutes {
  const next = sweep(m, now);
  const mute = length === 'off' ? null : { until: untilFor(length, now), at: now.toISOString() };
  if (key === 'all') return { ...next, all: mute };
  const items = { ...next.items };
  if (mute) items[key] = mute;
  else delete items[key];
  return { ...next, items };
}

/** The mute that covers any of these keys (Mute all first, then the one that lasts longest), or null. */
export function mutedBy(m: Mutes, keys: (string | null | undefined)[], now = new Date()): Mute | null {
  const found = [m.all, ...keys.filter(Boolean).map(k => m.items[k!])].filter((x): x is Mute => live(x, now));
  if (!found.length) return null;
  return found.find(x => x.until === null) ?? found.sort((a, b) => Date.parse(b.until!) - Date.parse(a.until!))[0];
}

/** Whether an event about these keys should reach him: never when muted, except "stuck" while the tick is on. For notifications. */
export function shouldTell(m: Mutes, keys: (string | null | undefined)[], event: Event, now = new Date()): boolean {
  if (event === 'stuck' && m.stuckTells) return true;
  return !mutedBy(m, keys, now);
}

const clock = (d: Date) => {
  const h = d.getHours() % 12 || 12;
  const mm = d.getMinutes();
  return `${h}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${d.getHours() < 12 ? 'am' : 'pm'}`;
};

/** "until 3 pm", "until tomorrow 8 am", "until Tue 8 am", "until you unmute" (this PC's clock: the page runs on it too). */
export function untilText(until: string | null, now = new Date()): string {
  if (until === null) return 'until you unmute';
  const d = new Date(until);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  const when = days <= 0 ? '' : days === 1 ? 'tomorrow ' : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} `;
  return `until ${when}${clock(d)}`;
}

/** What the page draws: each mute with its words ("until 3 pm"). */
export function view(m: Mutes, now = new Date()) {
  const s = sweep(m, now);
  const out = (x: Mute) => ({ until: x.until, text: untilText(x.until, now) });
  return { all: s.all ? out(s.all) : null, items: Object.fromEntries(Object.entries(s.items).map(([k, v]) => [k, out(v)])), stuckTells: s.stuckTells };
}

/** The file, read once and written whole through a temporary file. */
export class MuteStore {
  private cache: Mutes | null = null;
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async get(): Promise<Mutes> {
    if (!this.cache) {
      const raw = (await readData<Partial<Mutes> | null>(join(this.dir, 'mute.json'), null)) ?? {};
      this.cache = sweep({ all: raw.all ?? null, items: raw.items ?? {}, stuckTells: raw.stuckTells !== false });
    }
    return this.cache;
  }

  /** The mutes already read (null before the first read), for code that cannot wait. */
  peek(): Mutes | null {
    return this.cache;
  }

  async save(m: Mutes): Promise<Mutes> {
    this.cache = sweep(m);
    await writeAtomic(join(this.dir, 'mute.json'), JSON.stringify(this.cache, null, 1));
    return this.cache;
  }
}
