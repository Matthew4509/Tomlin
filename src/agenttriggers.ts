// When an agent's standing job runs (src/recipe.ts "When:"): the triggers, read from plain words, and the next time each
// one fires on this PC's own clock. Pure parts, tested in test/agenttriggers.test.ts; the server looks at them every
// half minute (src/server/agents.ts) and a trigger only ever adds an "agent" item to the queue, which runs one item at a
// time on each PC.
//
// Kinds:
// - daily: at a time on some days of the week (every day, weekdays, or named days: "weekly" is one day);
// - hours: every N hours, at N-hour marks counted from midnight (every 6 hours: 00:00, 06:00, 12:00, 18:00);
// - once: at a date and time;
// - file: when a new file lands in a folder of the agent's results (looked at every minute, not watched);
// - after: when another standing job's run has finished (named by the job, the agent, or "<agent>'s <job>");
// - page: when one of the recipe's pages changes, looked at every N minutes by TOMLIN's own code (src/pagewatch.ts):
//   no model is loaded until a page has changed;
// - hand: only when Run now is pressed.
// Times are wall-clock times on the agent's PC: a daylight-saving change moves nothing (07:00 stays 07:00), a time
// that does not exist that night (02:30 when the clocks go forward) runs at the first minute after it, and a time that
// comes twice (when they go back) runs once.

export type Trigger =
  | { kind: 'daily'; at: string; days: number[] }
  | { kind: 'hours'; hours: number }
  | { kind: 'once'; at: string }
  | { kind: 'file'; folder: string }
  | { kind: 'after'; job: string }
  | { kind: 'page'; everyMinutes: number }
  | { kind: 'hand' };

/** A page watch looks at most this often, and at least once a day (minutes). */
export const PAGE_MINUTES = { least: 30, most: 24 * 60, default: 120 };

/** "2 hours", "90 minutes", "an hour", "30 mins" as minutes, or null. */
function minutesOf(raw: string): number | null {
  const m = /^(an?\s+|\d{1,4}\s*)?(minutes?|mins?|hours?|hrs?|h)$/i.exec(raw.trim());
  if (!m) return null;
  const n = !m[1] || /^an?\s+$/i.test(m[1]) ? 1 : Number(m[1]);
  return /^h/i.test(m[2]) ? n * 60 : n;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** "7", "7:30", "07:30", "7am", "7.30 pm" as "HH:MM", or null. */
export function timeOf(raw: string): string | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const half = m[3]?.toLowerCase().replace(/\./g, '');
  if (half) {
    if (h < 1 || h > 12) return null;
    if (half === 'pm' && h < 12) h += 12;
    if (half === 'am' && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** The days named in "Monday and Thursday", "mon, wed, fri", "weekdays", "every day"; null when a word is not a day. */
function daysOf(raw: string): number[] | null {
  const t = raw.trim().toLowerCase();
  if (/^(day|days|every day|daily)$/.test(t)) return ALL_DAYS;
  if (/^(weekday|weekdays|week day|week days|working day|working days)$/.test(t)) return WEEKDAYS;
  const out: number[] = [];
  for (const w of t.split(/\s*(?:,|\band\b|&|\/)\s*/).filter(Boolean)) {
    // "mon", "tues", "Thursdays": a day's name or its start, three letters or more.
    const one = w.replace(/(day)s$/, '$1');
    const n = one.length >= 3 ? DAY_NAMES.findIndex(d => d.toLowerCase().startsWith(one)) : -1;
    if (n < 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out.sort((a, b) => a - b) : null;
}

/**
 * One "When:" line read as a trigger, or the reason it could not be. Examples it reads: "Every weekday at 07:00",
 * "Every day at 7:30 pm", "Daily at 6", "Every Monday and Thursday at 09:00", "Weekly on Friday at 17:00",
 * "Every 6 hours", "Every hour", "Once on 2026-12-01 at 08:00", "When a file lands in inbox", "After Robin's
 * price check", "By hand" (or "Run now", "Only when I press Run now").
 */
export function parseTrigger(raw: string): Trigger | { error: string } {
  const t = raw.trim().replace(/\s+/g, ' ').replace(/[.]$/, '');
  if (!t) return { error: 'An empty "When" line.' };
  if (/^(by hand|manual(ly)?|run now|only when i press run now|only by hand|never by itself)$/i.test(t)) return { kind: 'hand' };
  let m = /^(?:every|each)\s+(\d{1,2})\s+hours?$/i.exec(t) ?? (/^(?:every|each)\s+hour$/i.test(t) ? ['', '1'] : null) ?? (/^hourly$/i.test(t) ? ['', '1'] : null);
  if (m) {
    const hours = Number(m[1]);
    if (hours < 1 || hours > 24) return { error: `"${t}": every 1 to 24 hours.` };
    return { kind: 'hours', hours };
  }
  m = /^once\s+(?:on\s+)?(\d{4})-(\d{2})-(\d{2})(?:\s+at\s+(.+))?$/i.exec(t);
  if (m) {
    const at = timeOf(m[4] ?? '00:00');
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!at || date.getMonth() !== Number(m[2]) - 1 || date.getDate() !== Number(m[3])) return { error: `"${t}": write the date as 2026-12-01 and the time as 08:00.` };
    return { kind: 'once', at: `${m[1]}-${m[2]}-${m[3]}T${at}` };
  }
  m = /^when\s+(?:a\s+)?(?:new\s+)?file\s+(?:lands|arrives|comes|is put|is added)\s+in\s+(?:the\s+)?(?:folder\s+)?["“]?(.+?)["”]?$/i.exec(t);
  if (m) {
    const folder = cleanFolderName(m[1]);
    return folder ? { kind: 'file', folder } : { error: `"${t}": name a folder inside the agent's results, such as "inbox".` };
  }
  m = /^when\s+(?:a|the|one of the|any)?\s*pages?\s+(?:changes?|is changed|are changed)(?:\s*\(?\s*(?:looked at\s+|look\s+|checked\s+)?every\s+(.+?)\s*\)?)?$/i.exec(t);
  if (m) {
    const minutes = m[1] ? minutesOf(m[1]) : PAGE_MINUTES.default;
    if (minutes === null) return { error: `"${t}": write how often to look as "every 2 hours" or "every 30 minutes".` };
    if (minutes < PAGE_MINUTES.least || minutes > PAGE_MINUTES.most) return { error: `"${t}": a page is looked at every ${PAGE_MINUTES.least} minutes at the most often, and at least once a day.` };
    return { kind: 'page', everyMinutes: minutes };
  }
  m = /^after\s+(.+?)(?:\s+(?:runs|has run|finishes|has finished|is done))?$/i.exec(t);
  if (m) {
    const job = m[1].trim().slice(0, 80);
    return job ? { kind: 'after', job } : { error: `"${t}": name the job whose run it follows.` };
  }
  m = /^(?:(?:every|each)\s+(.+?)|daily|weekdays|weekly\s+on\s+(.+?)|on\s+(.+?))\s+at\s+(.+)$/i.exec(t);
  if (m) {
    const at = timeOf(m[4]);
    if (!at) return { error: `"${t}": write the time as 07:00 or 7 am.` };
    const word = m[1] ?? m[2] ?? m[3] ?? (/^weekdays/i.test(t) ? 'weekdays' : 'day');
    const days = daysOf(word);
    if (!days) return { error: `"${t}": "${word}" is not a day TOMLIN knows. Write every day, every weekday, or the days by name.` };
    return { kind: 'daily', at, days };
  }
  return { error: `"${t}" is not a "When" TOMLIN can read. Write, for example: Every weekday at 07:00; Every 6 hours; Once on 2026-12-01 at 08:00; When a file lands in inbox; When a page changes (every 2 hours); After Robin's price check; By hand.` };
}

/**
 * Whether an "After" trigger names a finished run: by the job's name, by its agent's name (any of their jobs), or as
 * "<agent's first name>'s <job>", letters only, any case.
 */
export function afterMatches(job: string, ran: { name: string; agentName: string }): boolean {
  const k = nameKey;
  const want = k(job);
  const first = k(ran.agentName.split(/\s+/)[0] ?? '');
  return !!want && [k(ran.name), k(ran.agentName), first, `${first} ${k(ran.name)}`, `${k(ran.agentName)} ${k(ran.name)}`].includes(want);
}

/** A job's name as it is matched: letters and digits only, any case, "Robin's" read as "Robin". */
export const nameKey = (s: string): string => s.toLowerCase().replace(/['’]s(?![a-z])/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** A folder name inside the agent's results: plain words, no path, no dots at the start. '' when it is not one. */
export function cleanFolderName(raw: string): string {
  const t = raw.trim().replace(/^["“']|["”']$/g, '').trim();
  if (!t || t.length > 60 || /[\\/:*?"<>|]/.test(t) || /^\.|\.$/.test(t)) return '';
  return t;
}

const two = (n: number) => String(n).padStart(2, '0');

/** A trigger written back as words (what the form and the recipe text show). */
export function triggerWords(t: Trigger): string {
  if (t.kind === 'hand') return 'By hand';
  if (t.kind === 'hours') return t.hours === 1 ? 'Every hour' : `Every ${t.hours} hours`;
  if (t.kind === 'once') return `Once on ${t.at.slice(0, 10)} at ${t.at.slice(11, 16)}`;
  if (t.kind === 'file') return `When a file lands in ${t.folder}`;
  if (t.kind === 'after') return `After ${t.job}`;
  if (t.kind === 'page') return `When a page changes (every ${t.everyMinutes % 60 === 0 ? (t.everyMinutes === 60 ? 'hour' : `${t.everyMinutes / 60} hours`) : `${t.everyMinutes} minutes`})`;
  const d = t.days.join();
  const days = d === ALL_DAYS.join() ? 'day' : d === WEEKDAYS.join() ? 'weekday' : t.days.map(n => DAY_NAMES[n]).join(' and ');
  return `Every ${days} at ${t.at}`;
}

/** A trigger as saved, checked (anything unknown is dropped). */
export function cleanTrigger(raw: unknown): Trigger | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.kind === 'hand') return { kind: 'hand' };
  if (o.kind === 'hours' && Number.isInteger(o.hours) && (o.hours as number) >= 1 && (o.hours as number) <= 24) return { kind: 'hours', hours: o.hours as number };
  if (o.kind === 'once' && typeof o.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.at)) return { kind: 'once', at: o.at };
  if (o.kind === 'file' && typeof o.folder === 'string' && cleanFolderName(o.folder)) return { kind: 'file', folder: cleanFolderName(o.folder) };
  if (o.kind === 'after' && typeof o.job === 'string' && o.job.trim()) return { kind: 'after', job: o.job.trim().slice(0, 80) };
  if (o.kind === 'page' && Number.isInteger(o.everyMinutes) && (o.everyMinutes as number) >= PAGE_MINUTES.least && (o.everyMinutes as number) <= PAGE_MINUTES.most) return { kind: 'page', everyMinutes: o.everyMinutes as number };
  if (o.kind === 'daily' && typeof o.at === 'string' && timeOf(o.at) && Array.isArray(o.days)) {
    const days = [...new Set(o.days.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    if (days.length) return { kind: 'daily', at: timeOf(o.at)!, days };
  }
  return null;
}

/** Whether a trigger fires by the clock (daily, hours, once): the others fire on an event. */
export const timed = (t: Trigger): boolean => t.kind === 'daily' || t.kind === 'hours' || t.kind === 'once';

/** Local midnight of the day `ms` falls in, moved `days` days on (by the calendar, not by 24 hours). */
function dayStart(ms: number, days = 0): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** The local date-time `day` at hh:mm (a time the clocks skip that night comes out at the first minute after it). */
function at(day: Date, hh: number, mm: number): number {
  const ms = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm).getTime();
  const d = new Date(ms);
  if (d.getHours() === hh && d.getMinutes() === mm) return ms;
  // Skipped: the date comes out the length of the jump past it (01:30 is read as 02:30). Back to the first minute after
  // the jump, the last one whose minute before it is still before hh:mm on the clock.
  const want = hh * 60 + mm;
  const wall = (x: number) => { const w = new Date(x); return w.getDate() === day.getDate() ? w.getHours() * 60 + w.getMinutes() : -1; };
  let x = ms;
  for (let i = 0; i < 180 && wall(x - 60_000) > want; i++) x -= 60_000;
  return x;
}

/**
 * The next time a clock trigger fires strictly after `after` (ms), on this PC's clock; null for one that does not fire by
 * the clock, or a Once that is past.
 */
export function nextTime(t: Trigger, after: number): number | null {
  if (t.kind === 'once') {
    const [d, hm] = t.at.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [hh, mm] = hm.split(':').map(Number);
    const ms = new Date(y, mo - 1, da, hh, mm).getTime();
    return ms > after ? ms : null;
  }
  if (t.kind === 'daily') {
    const [hh, mm] = t.at.split(':').map(Number);
    for (let i = 0; i <= 8; i++) {
      const day = dayStart(after, i);
      if (!t.days.includes(day.getDay())) continue;
      const ms = at(day, hh, mm);
      if (ms > after) return ms;
    }
    return null;
  }
  if (t.kind === 'hours') {
    for (let i = 0; i <= 1; i++) {
      const day = dayStart(after, i);
      for (let h = 0; h < 24; h += t.hours) {
        const ms = at(day, h, 0);
        if (ms > after) return ms;
      }
    }
    return null;
  }
  return null;
}

/** "Mon 1 Dec, 07:00" (on this PC's clock), for the Agents page. */
export function whenWords(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = dayStart(now).getTime();
  const that = dayStart(ms).getTime();
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (that === today) return `today at ${time}`;
  if (that === dayStart(now, 1).getTime()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })} at ${time}`;
}

/**
 * What is due now for one standing job's clock triggers. `next[i]` is when trigger i fires next (saved, so a PC that
 * was off still knows); unset, it is worked out from now and nothing fires (a trigger just made does not fire at once).
 * A time that passed while the PC was off fires once, however many times it was missed. Returns whether any fired and
 * the next times to save.
 */
export function dueNow(triggers: Trigger[], next: (number | null)[], now: number): { fire: boolean; missed: boolean; next: (number | null)[] } {
  let fire = false;
  let missed = false;
  const out = triggers.map((t, i) => {
    if (!timed(t)) return null;
    const was = next[i];
    if (was === undefined || was === null) return was === null && t.kind === 'once' ? null : nextTime(t, now);
    if (was > now) {
      // A repeating time further off than its next one from now was saved on a clock that ran ahead and was put
      // right since: it comes back to this clock (a daily one is never more than 8 days away).
      const soonest = t.kind === 'once' ? null : nextTime(t, now);
      return soonest !== null && was > soonest ? soonest : was;
    }
    fire = true;
    // More than one time passed since it was due (the PC was off, or asleep): still once.
    const after = nextTime(t, was);
    if (after !== null && after <= now) missed = true;
    return nextTime(t, now);
  });
  return { fire, missed, next: out };
}

/**
 * A file trigger's look at its folder: the files new since the last look, at most `most` (the rest wait for the next
 * look). `seen` unset: the first look, which only notes what is there (files already in the folder when the job was
 * made do not each start a run). Returns the files to run for and the list to keep.
 */
export function filesDue(seen: string[] | undefined, there: string[], most = 5): { run: string[]; seen: string[] } {
  if (!seen) return { run: [], seen: [...there].sort().slice(0, 2000) };
  const had = new Set(seen);
  const fresh = there.filter(f => !had.has(f)).sort().slice(0, most);
  // Files taken out of the folder are forgotten, so the same name put back later is new again.
  const still = seen.filter(f => there.includes(f));
  return { run: fresh, seen: [...still, ...fresh].slice(-2000) };
}
