// The To Do (Home's right panel, its third tab): what you mean to work on, put there by hand. Three parts, Today, This
// week and This month; each row a project, a size (a quick 15 min, or 1, 2, 4 or 8 hours) and an optional note. A
// project is one of TOMLIN's own (job:<id>, Home and Jobs) or a project folder on the Projects page (folder:<id>,
// the Bridge). Nothing drops off by itself: a row stays until it is ticked done (an unfinished Today row is still there
// tomorrow, marked with the day it came in) or removed. Today's sizes add up against your day (8 h to start).
// Quick checks: a project can be checked every week or every month; each day up to 1 (or 2) that are due come into
// Today by themselves, the longest overdue first, so none is skipped; ticking one sets its next date.
// Kept in data\todo.json, written only when something changes (a first read writes nothing); a damaged file is set
// aside, never written over (src/atomic.ts). Nothing here touches a project's files. The pure parts take a state and
// today's date ("YYYY-MM-DD"), so the tests set the day.
// Tested in test/todo.test.ts.
import { randomBytes } from 'node:crypto';
import { updateData } from './atomic.ts';

export const ZONES = ['today', 'week', 'month'] as const;
export type Zone = typeof ZONES[number];
const ZONE_NAMES: Record<Zone, string> = { today: 'Today', week: 'This week', month: 'This month' };
/** Minutes: Quick, 1 h, 2 h, 4 h, 8 h. */
export const SIZES = [15, 60, 120, 240, 480];
const EVERY = ['week', 'month'] as const;
type Every = typeof EVERY[number];
const MAX_ITEMS = 500;
const NOTE_MAX = 120;
/** Done rows are kept this long (the longest "done earlier" list is this month), then dropped. */
const DONE_KEEP_DAYS = 35;
/** The rows done before today: listed for this week, this month, or hidden (done today always shows). */
const DONE_SHOW = ['week', 'month', 'hide'] as const;
type DoneShow = typeof DONE_SHOW[number];

export interface Item {
  id: string;
  project: string;
  name: string;
  size: number;
  note: string;
  zone: Zone;
  kind: 'task' | 'check';
  added: string;
  /** The day it came into Today (null in the other parts). */
  today: string | null;
  done: boolean;
  doneAt: string | null;
  /** A quick check: the day it came into Today by itself. */
  pulledOn?: string;
  /** A quick check ticked: when it was due before the tick (an untick puts it back). */
  prevNext?: string;
}
export interface Check { every: Every; next: string; name: string }
export interface Settings { dayHours: number; checksPerDay: 1 | 2; doneShow: DoneShow }
export interface State { items: Item[]; checks: Record<string, Check>; settings: Settings }
export type Result = { ok: true; item?: Item; check?: Check | null; settings?: Settings } | { ok: false; fault: string; reason: string; wayOut: string };

const DEFAULT_SETTINGS: Settings = { dayHours: 8, checksPerDay: 1, doneShow: 'week' };

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00`));
const isId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8,16}$/.test(s);
/** A TOMLIN project (job:) or a project folder (folder:), by its id: never a path. */
export const isProject = (s: unknown): s is string => typeof s === 'string' && /^(job|folder):[\w.-]{1,80}$/.test(s) && !s.includes('..');
const newId = () => randomBytes(5).toString('hex');

/** A date as "YYYY-MM-DD" in this PC's time. */
export function dayOf(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const toDate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
/** The next check date: a week on, or the same day next month (the 31st becomes the month's last day). */
export function nextDate(from: string, every: Every): string {
  const d = toDate(from);
  if (every === 'week') { d.setDate(d.getDate() + 7); return dayOf(d); }
  const want = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(want, last));
  return dayOf(d);
}
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
/** Monday of the week a date is in. */
export function weekStart(day: string): string { const d = toDate(day); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayOf(d); }

/** Text from the page, made safe to keep and show: one line, no control or direction characters, at most `max`. */
export function cleanText(s: unknown, max: number): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Whatever was read, kept to the shapes above: anything else (a row edited by hand, a stray key) is dropped. */
export function normalize(raw: unknown): State {
  const s: State = { items: [], checks: {}, settings: { ...DEFAULT_SETTINGS } };
  if (!isPlain(raw)) return s;
  const seen = new Set<string>();
  for (const it of Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : []) {
    if (!isPlain(it) || !isId(it.id) || seen.has(it.id) || !isProject(it.project) || !ZONES.includes(it.zone as Zone) || !SIZES.includes(it.size as number)) continue;
    seen.add(it.id);
    s.items.push({
      id: it.id, project: it.project, name: cleanText(it.name, 100) || it.project, size: it.size as number, note: cleanText(it.note, NOTE_MAX),
      zone: it.zone as Zone, kind: it.kind === 'check' ? 'check' : 'task', added: isDate(it.added) ? it.added : dayOf(),
      today: isDate(it.today) ? it.today : null, done: it.done === true, doneAt: isDate(it.doneAt) ? it.doneAt : null,
      ...(isDate(it.pulledOn) ? { pulledOn: it.pulledOn } : {}), ...(isDate(it.prevNext) ? { prevNext: it.prevNext } : {}),
    });
  }
  if (isPlain(raw.checks)) {
    for (const [k, c] of Object.entries(raw.checks)) {
      if (!isProject(k) || !isPlain(c) || !EVERY.includes(c.every as Every) || !isDate(c.next)) continue;
      s.checks[k] = { every: c.every as Every, next: c.next, name: cleanText(c.name, 100) || k };
    }
  }
  if (isPlain(raw.settings)) {
    const h = Number(raw.settings.dayHours);
    if (Number.isFinite(h) && h >= 1 && h <= 16) s.settings.dayHours = Math.round(h * 4) / 4;
    if (raw.settings.checksPerDay === 1 || raw.settings.checksPerDay === 2) s.settings.checksPerDay = raw.settings.checksPerDay;
    if (DONE_SHOW.includes(raw.settings.doneShow as DoneShow)) s.settings.doneShow = raw.settings.doneShow as DoneShow;
  }
  return s;
}

const fault = (f: string, reason = '', wayOut = ''): Result => ({ ok: false, fault: f, reason, wayOut });
const findItem = (s: State, id: unknown) => (isId(id) ? s.items.find(x => x.id === id) ?? null : null);
const gone = () => fault('That row is not on the To Do any more.', '', 'Reload the page.');

export interface AddAsk { project?: unknown; name?: unknown; size?: unknown; note?: unknown; zone?: unknown }

/** Add a row. Today's rows remember the day they came into Today. */
export function add(s: State, o: AddAsk, today: string): Result {
  if (!isProject(o.project)) return fault('No project was named.', '', 'Pick a project, then Add.');
  const zone = ZONES.includes(o.zone as Zone) ? o.zone as Zone : 'today';
  const size = SIZES.includes(Number(o.size)) ? Number(o.size) : 60;
  if (s.items.length >= MAX_ITEMS) return fault('The To Do is full.', `It keeps ${MAX_ITEMS} rows.`, 'Remove some done or old rows, then Add again.');
  const item: Item = { id: newId(), project: o.project, name: cleanText(o.name, 100) || o.project, size, note: cleanText(o.note, NOTE_MAX), zone, kind: 'task', added: today, today: zone === 'today' ? today : null, done: false, doneAt: null };
  s.items.push(item);
  return { ok: true, item };
}

/** Change a row's size or note. */
export function set(s: State, id: unknown, o: { size?: unknown; note?: unknown }): Result {
  const it = findItem(s, id);
  if (!it) return gone();
  if (o.size !== undefined) {
    if (!SIZES.includes(Number(o.size))) return fault('That is not one of the sizes.', 'Quick (15 min), 1 h, 2 h, 4 h or 8 h.');
    it.size = Number(o.size);
  }
  if (o.note !== undefined) it.note = cleanText(o.note, NOTE_MAX);
  return { ok: true, item: it };
}

/** Move a row to a part, before another row (`before`) or at the part's end. */
export function move(s: State, id: unknown, zone: unknown, before: unknown, today: string): Result {
  const it = findItem(s, id);
  if (!it) return gone();
  if (!ZONES.includes(zone as Zone)) return fault('That is not a part of the To Do.', 'Today, This week or This month.');
  if (it.zone !== zone) { it.zone = zone as Zone; it.today = zone === 'today' ? today : null; }
  s.items.splice(s.items.indexOf(it), 1);
  const at = before && before !== id ? s.items.findIndex(x => x.id === before) : -1;
  if (at >= 0) s.items.splice(at, 0, it);
  else s.items.push(it);
  return { ok: true, item: it };
}

/** Tick (or untick) a row. A quick check ticked sets its project's next check; unticked, it goes back. */
export function done(s: State, id: unknown, on: boolean, today: string): Result {
  const it = findItem(s, id);
  if (!it) return gone();
  if (on === it.done) return { ok: true, item: it };
  it.done = on;
  it.doneAt = on ? today : null;
  const c = it.kind === 'check' ? s.checks[it.project] : null;
  if (c && on) { it.prevNext = c.next; c.next = nextDate(today, c.every); }
  if (c && !on && it.prevNext) { c.next = it.prevNext; delete it.prevNext; }
  return { ok: true, item: it };
}

/** Take a row off. A quick check still to do goes to its next date, or it would come straight back at the next look. */
export function remove(s: State, id: unknown, today: string = dayOf()): Result {
  const it = findItem(s, id);
  if (!it) return gone();
  const c = it.kind === 'check' && !it.done && Object.hasOwn(s.checks, it.project) ? s.checks[it.project] : null;
  if (c && c.next <= today) c.next = nextDate(today, c.every);
  s.items.splice(s.items.indexOf(it), 1);
  return { ok: true };
}

/** A project's quick check: every 'week' or 'month' (the first one due today), or 'off'. */
export function setCheck(s: State, project: unknown, every: unknown, name: unknown, today: string): Result {
  if (!isProject(project)) return fault('No project was named.');
  if (every === 'off') { delete s.checks[project]; return { ok: true, check: null }; }
  if (!EVERY.includes(every as Every)) return fault('A quick check is every week or every month.');
  const had = Object.hasOwn(s.checks, project) ? s.checks[project] : null;
  s.checks[project] = { every: every as Every, next: had ? had.next : today, name: cleanText(name, 100) || had?.name || project };
  return { ok: true, check: s.checks[project] };
}

export function setSettings(s: State, o: { dayHours?: unknown; checksPerDay?: unknown; doneShow?: unknown }): Result {
  if (o.dayHours !== undefined) {
    const h = Number(o.dayHours);
    if (!Number.isFinite(h) || h < 1 || h > 16) return fault('A day is 1 to 16 hours.', '', 'Pick the hours you work in a day.');
    s.settings.dayHours = Math.round(h * 4) / 4;
  }
  if (o.checksPerDay !== undefined) {
    if (o.checksPerDay !== 1 && o.checksPerDay !== 2) return fault('Quick checks come 1 or 2 a day.');
    s.settings.checksPerDay = o.checksPerDay;
  }
  if (o.doneShow !== undefined) {
    if (!DONE_SHOW.includes(o.doneShow as DoneShow)) return fault('Earlier done rows show for this week, this month, or not at all.');
    s.settings.doneShow = o.doneShow as DoneShow;
  }
  return { ok: true, settings: s.settings };
}

/**
 * Today's quick checks: those due (their date today or earlier) come into Today, the longest overdue first, until
 * today has had its 1 (or 2). A project whose check is already on the To Do and not done is not added again (it stays
 * where it is, still due), nor one whose project is gone (`has`). Returns how many came in.
 */
export function pullChecks(s: State, today: string, has: (project: string) => boolean = () => true): number {
  const inToday = s.items.filter(x => x.kind === 'check' && x.pulledOn === today).length;
  let room = s.settings.checksPerDay - inToday;
  if (room <= 0) return 0;
  const open = new Set(s.items.filter(x => x.kind === 'check' && !x.done).map(x => x.project));
  const due = Object.entries(s.checks).filter(([k, c]) => c.next <= today && !open.has(k) && has(k))
    .sort((a, b) => a[1].next.localeCompare(b[1].next) || a[1].name.localeCompare(b[1].name));
  let n = 0;
  for (const [k, c] of due) {
    if (room-- <= 0 || s.items.length >= MAX_ITEMS) break;
    s.items.push({ id: newId(), project: k, name: c.name, size: 15, note: '', zone: 'today', kind: 'check', added: today, today, done: false, doneAt: null, pulledOn: today });
    n++;
  }
  return n;
}

/** Done rows older than DONE_KEEP_DAYS go. Returns how many went. */
export function tidy(s: State, today: string): number {
  const before = s.items.length;
  s.items = s.items.filter(x => !x.done || !x.doneAt || daysBetween(x.doneAt, today) <= DONE_KEEP_DAYS);
  return before - s.items.length;
}

const sizeText = (m: number) => (m < 60 ? 'Quick' : `${m / 60} h`);
const hm = (m: number) => (m > 0 && m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m / 60} h`);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface Row {
  id: string; project: string; type: 'job' | 'folder'; name: string; gone: boolean; size: number; sizeText: string;
  note: string; kind: 'task' | 'check'; done: boolean; doneAt: string | null; from: string | null; check: Every | null;
}
export type View = ReturnType<typeof view>;

/**
 * What the page shows: the three parts with their open rows, Done today (always), the rows done earlier (this week,
 * this month, or none, as doneShow says), Today's total against the day (what is left plus what was done today), and
 * the quick checks. `projects`: { ref: name } of the projects there are now (a row whose project is gone keeps its
 * name and says so).
 */
export function view(s: State, today: string, projects: Record<string, string> = {}) {
  const has = (k: string) => Object.hasOwn(projects, k);
  const row = (it: Item): Row => ({
    id: it.id, project: it.project, type: it.project.startsWith('job:') ? 'job' : 'folder', name: has(it.project) ? projects[it.project] : it.name,
    gone: !has(it.project), size: it.size, sizeText: sizeText(it.size), note: it.note, kind: it.kind, done: it.done, doneAt: it.doneAt,
    from: it.zone === 'today' && !it.done && it.today && it.today < today ? `${WEEKDAY[toDate(it.today).getDay()]} ${toDate(it.today).getDate()}` : null,
    check: it.kind === 'check' && Object.hasOwn(s.checks, it.project) ? s.checks[it.project].every : null,
  });
  const zones = ZONES.map(z => ({ zone: z, name: ZONE_NAMES[z], items: s.items.filter(x => x.zone === z && !x.done).map(row) }));
  const leftMin = s.items.filter(x => x.zone === 'today' && !x.done).reduce((t, x) => t + x.size, 0);
  const doneTodayRows = s.items.filter(x => x.done && x.doneAt === today);
  const doneMin = doneTodayRows.reduce((t, x) => t + x.size, 0);
  const todayMin = leftMin + doneMin;
  const dayMin = Math.round(s.settings.dayHours * 60);
  const newest = (a: Item, b: Item) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '');
  const show = s.settings.doneShow;
  const from = show === 'month' ? `${today.slice(0, 8)}01` : weekStart(today);
  const before = (x: Item, since: string) => x.done && !!x.doneAt && x.doneAt < today && x.doneAt >= since;
  const earlier = show === 'hide' ? [] : s.items.filter(x => before(x, from)).sort(newest).map(row);
  const hiddenEarlier = show === 'hide' ? s.items.filter(x => before(x, weekStart(today))).length : 0;
  const checks = Object.entries(s.checks).map(([k, c]) => ({ project: k, name: has(k) ? projects[k] : c.name, every: c.every, next: c.next, due: c.next <= today }))
    .sort((a, b) => a.next.localeCompare(b.next));
  const over = todayMin - dayMin;
  return {
    today, zones, doneToday: doneTodayRows.map(row),
    doneEarlier: { show, name: show === 'month' ? 'Done earlier this month' : 'Done earlier this week', items: earlier, hidden: hiddenEarlier },
    checks, settings: s.settings, sizes: SIZES.map(m => ({ min: m, text: m < 60 ? 'Quick · 15 min' : sizeText(m) })),
    total: { todayMin, leftMin, doneMin, dayMin, text: `Today ${hm(todayMin)} of ${hm(dayMin)}${over > 0 ? `: ${hm(over)} over` : ''}${doneMin ? ` · ${hm(doneMin)} done` : ''}` },
    open: zones[0].items.length,
  };
}

/** The To Do's file: each call reads it, changes it in one turn and saves it only when something changed. */
export class TodoStore {
  readonly file: string;
  private readonly today: () => string;
  constructor(file: string, today: () => string = () => dayOf()) {
    this.file = file;
    this.today = today;
  }
  /** Runs a change; saved only when it worked (`fn` answers ok, or a number above 0). */
  private async change<R>(fn: (s: State, today: string) => R, worked: (r: R) => boolean): Promise<R> {
    let out!: R;
    await updateData<unknown>(this.file, null, raw => {
      const s = normalize(raw);
      out = fn(s, this.today());
      return worked(out) ? { version: 1, ...s } : undefined;
    });
    return out;
  }
  private act(fn: (s: State, today: string) => Result): Promise<Result> {
    return this.change(fn, r => r.ok);
  }
  /** The view; due quick checks come in and old done rows go first (saved only when one did). */
  async view(projects: Record<string, string>, has?: (project: string) => boolean): Promise<View> {
    let v!: View;
    await this.change((s, t) => { const n = pullChecks(s, t, has) + tidy(s, t); v = view(s, t, projects); return n; }, n => n > 0);
    return v;
  }
  add(o: AddAsk) { return this.act((s, t) => add(s, o, t)); }
  set(id: unknown, o: { size?: unknown; note?: unknown }) { return this.act(s => set(s, id, o)); }
  move(id: unknown, zone: unknown, before: unknown) { return this.act((s, t) => move(s, id, zone, before, t)); }
  done(id: unknown, on: boolean) { return this.act((s, t) => done(s, id, on, t)); }
  remove(id: unknown) { return this.act((s, t) => remove(s, id, t)); }
  setCheck(project: unknown, every: unknown, name: unknown) { return this.act((s, t) => setCheck(s, project, every, name, t)); }
  setSettings(o: { dayHours?: unknown; checksPerDay?: unknown; doneShow?: unknown }) { return this.act(s => setSettings(s, o)); }
}
