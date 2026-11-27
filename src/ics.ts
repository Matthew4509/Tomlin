// A calendar's iCal (.ics) text read into events, for an agent's Calendar tool (N6 of the 27 Nov agents plan): the
// secret iCal address Google, Outlook and Apple give is fetched by TOMLIN, never by the model, and only the events of
// the next few days are handed on, as plain lines. Read-only: nothing here writes to a calendar or answers an invite.
// Read: VEVENT's DTSTART, DTEND (or DURATION), SUMMARY, LOCATION, all-day dates, and RRULE for daily, weekly, monthly
// and yearly repeats (INTERVAL, COUNT, UNTIL, weekly BYDAY), with EXDATE. Any other repeat gives its first date only,
// and says so. Times are shown on this PC's clock: a UTC time ("Z") and a time with a TZID that Intl knows are turned
// into this PC's time; a TZID it does not know (Outlook's Windows names) is taken as this PC's own time. A repeat is
// walked on the clock it was written in (its TZID, or UTC), so a weekly call made in New York keeps its New York day and
// hour across either place's summer time. Plain parts, tested in test/ics.test.ts.

export interface CalEvent {
  /** Start and end in ms (an all-day event: local midnight to midnight). */
  start: number;
  end: number;
  allDay: boolean;
  summary: string;
  location: string;
  /** A repeat this reader does not follow (only its first date is given). */
  odd?: boolean;
  rule?: { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; count?: number; until?: number; byDay?: number[] };
  except: number[];
  /** The clock its start was written on: 'UTC', a TZID Intl knows, or none (this PC's own clock). */
  zone?: string;
}

/** The text's lines with folded lines joined (a line that starts with a space or tab carries on the one above). */
export function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** A property line as name, parameters and value: "DTSTART;TZID=Europe/London:20261127T090000". */
export function propOf(line: string): { name: string; params: Record<string, string>; value: string } | null {
  // The value starts at the first ":" not inside a quoted parameter.
  let q = false;
  let at = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) { at = i; break; }
  }
  if (at < 0) return null;
  const [name, ...ps] = line.slice(0, at).split(';');
  const params: Record<string, string> = {};
  for (const p of ps) {
    const e = p.indexOf('=');
    if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) };
}

/** iCal's escapes: \n, \, \; \\ . */
export const unescapeText = (s: string): string => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).replace(/\s+/g, ' ').trim();

/** The offset in ms of time zone `tz` at UTC time `utc` (local = utc + offset), or null when Intl does not know it. */
function offsetOf(tz: string, utc: number): number | null {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(utc)).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return asUtc - Math.floor(utc / 1000) * 1000;
  } catch {
    return null;
  }
}

/** A date-time value read: "20261127T090000Z" (UTC), "20261127T090000" with a TZID or none, "20261127" (a date). */
export function timeOf(value: string, tz?: string): { ms: number; date: boolean; zone?: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (m[4] === undefined) return { ms: new Date(y, mo, d).getTime(), date: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return { ms: Date.UTC(y, mo, d, h, mi, s), date: false, zone: 'UTC' };
  if (tz && offsetOf(tz, Date.UTC(y, mo, d)) !== null) return { ms: msOn(tz, y, mo, d, h, mi, s), date: false, zone: tz };
  return { ms: new Date(y, mo, d, h, mi, s).getTime(), date: false };
}

/** A wall time on a clock ('UTC', a TZID Intl knows, or undefined for this PC's) as ms. Days and months may overflow. */
function msOn(zone: string | undefined, y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  if (!zone) return new Date(y, mo, d, h, mi, s).getTime();
  const wall = Date.UTC(y, mo, d, h, mi, s);
  if (zone === 'UTC') return wall;
  // Guess the wall time as UTC, then take the zone's offset off (twice, for a change of offset).
  const o1 = offsetOf(zone, wall);
  if (o1 === null) return new Date(y, mo, d, h, mi, s).getTime();
  return wall - (offsetOf(zone, wall - o1) ?? o1);
}

/** The wall time of `ms` on a clock: year, month, day, weekday, hours, minutes, seconds. */
function wallOn(zone: string | undefined, ms: number): { y: number; mo: number; d: number; dow: number; h: number; mi: number; s: number } {
  if (!zone) { const t = new Date(ms); return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), dow: t.getDay(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() }; }
  const t = new Date(ms + (zone === 'UTC' ? 0 : offsetOf(zone, ms) ?? 0));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

/** "PT1H30M", "P1D", "-PT15M" as ms, or null. */
export function durationOf(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const n = (x?: string) => Number(x ?? 0);
  const ms = (((n(m[2]) * 7 + n(m[3])) * 24 + n(m[4])) * 60 + n(m[5])) * 60_000 + n(m[6]) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** The events in a calendar's text (at most `most`). Never throws: a VEVENT it cannot read is left out. */
export function readIcs(text: string, most = 5000): CalEvent[] {
  const out: CalEvent[] = [];
  let cur: Record<string, { params: Record<string, string>; value: string }[]> | null = null;
  for (const line of unfold(text)) {
    const t = line.trim();
    if (/^BEGIN:VEVENT$/i.test(t)) { cur = {}; continue; }
    if (/^END:VEVENT$/i.test(t)) {
      if (cur) {
        const e = eventOf(cur);
        if (e) out.push(e);
        if (out.length >= most) break;
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = propOf(line);
    if (p) (cur[p.name] ??= []).push({ params: p.params, value: p.value });
  }
  return out;
}

function eventOf(c: Record<string, { params: Record<string, string>; value: string }[]>): CalEvent | null {
  const ds = c.DTSTART?.[0];
  if (!ds) return null;
  if (/^cancelled$/i.test(c.STATUS?.[0]?.value ?? '')) return null;
  const start = timeOf(ds.value, ds.params.TZID);
  if (!start) return null;
  const allDay = start.date || ds.params.VALUE === 'DATE';
  const de = c.DTEND?.[0];
  const endT = de ? timeOf(de.value, de.params.TZID) : null;
  const dur = c.DURATION?.[0] ? durationOf(c.DURATION[0].value) : null;
  const end = endT?.ms ?? (dur !== null ? start.ms + dur : allDay ? new Date(start.ms).setDate(new Date(start.ms).getDate() + 1) : start.ms);
  const except: number[] = [];
  for (const x of c.EXDATE ?? []) for (const v of x.value.split(',')) { const t = timeOf(v, x.params.TZID); if (t) except.push(t.ms); }
  const e: CalEvent = { start: start.ms, end: Math.max(end, start.ms), allDay, summary: unescapeText(c.SUMMARY?.[0]?.value ?? '') || '(no title)', location: unescapeText(c.LOCATION?.[0]?.value ?? ''), except, ...(start.zone && !allDay ? { zone: start.zone } : {}) };
  const rr = c.RRULE?.[0]?.value;
  if (rr) {
    const parts = Object.fromEntries(rr.split(';').map(kv => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v ?? '']));
    const freq = parts.FREQ?.toUpperCase();
    // BYDAY on a monthly rule ("the second Tuesday"), BYMONTHDAY lists, BYSETPOS and the like are not followed.
    const w = wallOn(e.zone, start.ms);
    const plainMonthly = freq === 'MONTHLY' && !parts.BYDAY && !parts.BYSETPOS && (!parts.BYMONTHDAY || Number(parts.BYMONTHDAY) === w.d);
    // A yearly one on its own date (a birthday): BYMONTH and BYMONTHDAY only when they are the start's own.
    const plainYearly = freq === 'YEARLY' && !parts.BYDAY && !parts.BYSETPOS && !parts.BYWEEKNO && !parts.BYYEARDAY && (!parts.BYMONTH || Number(parts.BYMONTH) === w.mo + 1) && (!parts.BYMONTHDAY || Number(parts.BYMONTHDAY) === w.d);
    if ((freq === 'DAILY' && !parts.BYDAY && !parts.BYMONTH) || (freq === 'WEEKLY' && !parts.BYSETPOS) || plainMonthly || plainYearly) {
      const byDay = freq === 'WEEKLY' && parts.BYDAY ? parts.BYDAY.split(',').map(d => DAYS[d.replace(/^[+-]?\d+/, '').toUpperCase()]).filter(d => d !== undefined) : undefined;
      const until = parts.UNTIL ? timeOf(parts.UNTIL)?.ms : undefined;
      e.rule = { freq: freq as 'DAILY', interval: Math.max(1, Math.min(1000, Number(parts.INTERVAL) || 1)), ...(parts.COUNT ? { count: Math.max(1, Math.min(10_000, Number(parts.COUNT) || 1)) } : {}), ...(until !== undefined ? { until: allDay ? until + 86_399_999 : until } : {}), ...(byDay?.length ? { byDay } : {}) };
    } else e.odd = true;
  }
  return e;
}

/** Local midnight `days` days on from `ms`'s day (by the calendar, not by 24 hours). */
const dayAt = (ms: number, days = 0): number => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(); };

/** Each time an event happens that overlaps [from, to), in order, at most `most`. */
export function occurrences(e: CalEvent, from: number, to: number, most = 200): { start: number; end: number }[] {
  const len = e.end - e.start;
  const out: { start: number; end: number }[] = [];
  const add = (s: number) => {
    if (s + Math.max(len, 1) > from && s < to && !e.except.includes(s)) out.push({ start: s, end: s + len });
  };
  if (!e.rule) {
    add(e.start);
    return out;
  }
  const r = e.rule;
  const w = wallOn(e.zone, e.start);
  const at = (mo: number, d: number) => msOn(e.zone, w.y, mo, d, w.h, w.mi, w.s);
  // A 31st in a month without one, or 29 February in a year without one, is not there (iCal's rule).
  const real = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo, d)).getUTCDate() === d;
  const days = r.freq === 'WEEKLY' ? [...new Set(r.byDay ?? [w.dow])].sort((a, b) => a - b) : [];
  // Each step is a day, a week, a month or a year after the first. Walked from a little before `from`, never through
  // every step since it began (an old daily repeat, or a feed made to hold the app): with COUNT, the ones skipped are
  // counted without being made, which is exact where every step holds the same number of them.
  const stepDays = r.freq === 'DAILY' ? r.interval : r.freq === 'WEEKLY' ? 7 * r.interval : r.freq === 'MONTHLY' ? 31 * r.interval : 366 * r.interval;
  const even = r.freq === 'DAILY' || r.freq === 'WEEKLY' || (r.freq === 'MONTHLY' && w.d <= 28) || (r.freq === 'YEARLY' && !(w.mo === 1 && w.d === 29));
  const weekOne = r.freq === 'WEEKLY' ? days.filter(d => d >= w.dow).length : 1;
  const perStep = r.freq === 'WEEKLY' ? days.length : 1;
  const skip = Math.max(0, Math.floor((from - e.start) / (stepDays * 86_400_000)) - 2);
  const first = r.count === undefined || even ? skip : 0;
  let n = first === 0 ? 0 : weekOne + (first - 1) * perStep;
  for (let i = first; i < first + 20_000 && out.length < most; i++) {
    let starts: number[] = [];
    if (r.freq === 'DAILY') starts = [at(w.mo, w.d + i * r.interval)];
    else if (r.freq === 'MONTHLY') {
      const k = w.mo + i * r.interval;
      starts = real(w.y, k, w.d) ? [at(k, w.d)] : [];
    } else if (r.freq === 'YEARLY') {
      const y = w.y + i * r.interval;
      starts = real(y, w.mo, w.d) ? [msOn(e.zone, y, w.mo, w.d, w.h, w.mi, w.s)] : [];
    } else {
      const weekStart = w.d - w.dow + i * 7 * r.interval;
      starts = days.map(d => at(w.mo, weekStart + d)).filter(s => s >= e.start);
    }
    let past = false;
    for (const s of starts) {
      if (r.until !== undefined && s > r.until) { past = true; break; }
      if (r.count !== undefined && n >= r.count) { past = true; break; }
      n++;
      add(s);
      if (s >= to) { past = true; break; }
    }
    if (past) break;
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, '0');
const hm = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const dayWords = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The events from the start of today for `days` days (1-7), as lines on this PC's clock, at most `most`:
 * "Fri 27 Nov 09:00-10:00 Dentist (Main St)"; "Sat 28 Nov all day Market". A repeat it does not follow is marked.
 */
export function calendarLines(events: CalEvent[], now: number, days: number, most = 60): { lines: string[]; more: number } {
  const from = dayAt(now);
  const to = dayAt(now, Math.max(1, Math.min(7, Math.round(days) || 1)));
  const all: { start: number; end: number; e: CalEvent }[] = [];
  for (const e of events) for (const o of occurrences(e, from, to)) all.push({ ...o, e });
  all.sort((a, b) => a.start - b.start || Number(b.e.allDay) - Number(a.e.allDay));
  const lines = all.slice(0, most).map(({ start, end, e }) => {
    const when = e.allDay ? `${dayWords(start)} all day` : `${dayWords(start)} ${hm(start)}-${dayAt(end - 1) !== dayAt(start) ? `${dayWords(end)} ` : ''}${hm(end)}`;
    return `${when} ${e.summary.slice(0, 160)}${e.location ? ` (${e.location.slice(0, 80)})` : ''}${e.odd ? ' [it repeats in a way TOMLIN does not follow: only its first date is shown]' : ''}`;
  });
  return { lines, more: Math.max(0, all.length - most) };
}

/** A calendar address as typed: webcal:// read as https://; https only. '' when it is not one. */
export function cleanCalendarUrl(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.trim().replace(/^webcals?:\/\//i, 'https://') : '';
  try {
    const u = new URL(t);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

/** A secret address shown masked: its site and the end of it ("calendar.google.com/…ics"). */
export function maskCalendar(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}/…${u.pathname.slice(-4)}`;
  } catch {
    return '…';
  }
}
