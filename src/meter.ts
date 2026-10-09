// What each PC's models did, and what it cost. Every answer a chat model writes on this PC is counted from llama.cpp's
// own figures: the prompt tokens it read new, the prompt tokens it took from its cache (the start of the chat it had
// read last turn: no work, but an API still bills them, at its cached price), the tokens it wrote, and how long it worked. Only working time counts:
// a PC sitting idle is not charged to any project (a home network idles a lot, and that is not the work's cost).
// - Meter: this PC's totals (data/meter.json); a node tells them in its hello.
// - Ledger: per PC and per project (data/usage-ledger.json). On the host: its own work, and each linked PC's, which
//   that PC also logs per host and project (its rows "for-<link>"); the host takes that PC's own log as the final tally.
// - ByStaff: on the host, per hire (data/usage-staff.json), shown in their profile; tokens written and time worked per day.
// - ByModel: on the host, time worked and answers per day for each model of each PC (data/usage-models.json), for the
//   PC window's "Most-used models".
// - Uptime: on the host, whether each linked PC answered its once-a-minute check, per day (data/uptime.json).
// - costs(): power (watts while working × hours × price per kWh) against the same tokens on the Claude and ChatGPT APIs.
// Plain functions and small stores; tested in test/meter.test.ts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readData, writeAtomic } from './atomic.ts';

export interface Tally {
  /** Prompt tokens read new. */
  in: number;
  /** Prompt tokens taken from the cache (read on an earlier turn): no work here, billed by an API at its cached price. */
  cached: number;
  /** Tokens written. */
  out: number;
  /** How long the model worked: reading the prompt and writing. */
  ms: number;
  answers: number;
}
export const ZERO: Tally = { in: 0, cached: 0, out: 0, ms: 0, answers: 0 };

/** One answer's usage, as llama.cpp reports it. */
export interface Used {
  in: number;
  cached: number;
  out: number;
  ms: number;
}

const num = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);

/** A usage figure from anywhere (a linked PC's done line, a file): whole non-negative numbers, or null when empty. */
export function cleanUsed(raw: unknown): Used | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const u = { in: num(r.in), cached: num(r.cached), out: num(r.out), ms: num(r.ms) };
  return u.in || u.cached || u.out ? u : null;
}

export function cleanTally(raw: unknown): Tally {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { in: num(r.in), cached: num(r.cached), out: num(r.out), ms: num(r.ms), answers: num(r.answers) };
}

export const added = (t: Tally, u: Used | Tally): Tally => ({ in: t.in + u.in, cached: t.cached + (u.cached || 0), out: t.out + u.out, ms: t.ms + u.ms, answers: t.answers + ('answers' in u ? u.answers : 1) });

/** llama.cpp's timings for one answer as a usage figure (null when it gave none). */
export function usedFromTimings(t: { cache_n?: number; prompt_n?: number; predicted_n?: number; prompt_ms?: number; predicted_ms?: number } | null | undefined): Used | null {
  if (!t) return null;
  return cleanUsed({ in: t.prompt_n, cached: t.cache_n, out: t.predicted_n, ms: (Number(t.prompt_ms) || 0) + (Number(t.predicted_ms) || 0) });
}

/**
 * Whose work an answer is: a project here (a chat in a project, a job step), or (`forPc`) a linked PC this one works
 * for. `used` adds up what the answers under it used, so a node can say it on the done line.
 */
export interface Scope {
  project: string;
  forPc?: string;
  /** Work for a linked PC: its link (this PC logs the work for it under "for-<link>") and the project it said. */
  forLink?: string;
  forProject?: string;
  /** Run by the queue (src/queue.ts): nobody is waiting at the PC, so it may change what is loaded to do the work. */
  queue?: boolean;
  /** The hire whose answer this is (their id), counted per person (ByStaff). Unset: the host itself, or no one. */
  staff?: string;
  used: Tally;
}
export const scope = new AsyncLocalStorage<Scope>();
export const inScope = <T>(s: Omit<Scope, 'used'>, fn: () => Promise<T>): Promise<T> => scope.run({ ...s, used: { ...ZERO } }, fn);
/** From here on in this piece of work, answers are this hire's (a job hands its seats to one hire after another). */
export function workAs(staff: string | null | undefined): void {
  const s = scope.getStore();
  if (s) s.staff = staff || undefined;
}
/** A chat's "who" ("staff:<id>") as a hire's id, else undefined (the host). */
export const staffOfWho = (who: unknown): string | undefined => (typeof who === 'string' && /^staff:[\w-]{1,40}$/.test(who) ? who.slice(6) : undefined);

function cleanWritten(raw: unknown): Written {
  const out: Written = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [d, n] of Object.entries(raw)) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out[d] = num(n);
  return out;
}

/** The date in this PC's own time, "2026-10-07". */
export function dayOf(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A small JSON file kept in memory and written a few seconds after a change (an answer ends many times a minute). */
class Kept<T> {
  protected data: T;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;
  constructor(file: string, empty: T) {
    this.file = file;
    this.data = empty;
  }
  async load(clean: (raw: unknown) => T): Promise<this> {
    this.data = clean(await readData<unknown>(this.file, null).catch(() => null));
    return this;
  }
  protected changed(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void writeAtomic(this.file, JSON.stringify(this.data)).catch(() => undefined);
    }, 3000);
    this.timer.unref?.();
  }
  /** Written now (at shutdown, and in tests). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await writeAtomic(this.file, JSON.stringify(this.data));
  }
}

type MeterData = { since: string; total: Tally; days: Record<string, Tally> };
const DAYS_KEPT = 92;

/** This PC's own totals: everything its chat models did, for anyone, since it started counting. */
export class Meter extends Kept<MeterData> {
  constructor(file: string) {
    super(file, { since: new Date().toISOString(), total: { ...ZERO }, days: {} });
  }
  load(): Promise<this> {
    return super.load(raw => {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<MeterData>;
      const days = Object.fromEntries(Object.entries(r.days ?? {}).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k)).map(([k, v]) => [k, cleanTally(v)]));
      return { since: typeof r.since === 'string' && !Number.isNaN(Date.parse(r.since)) ? r.since : new Date().toISOString(), total: cleanTally(r.total), days };
    });
  }
  add(u: Used, now = new Date()): void {
    this.data.total = added(this.data.total, u);
    const day = dayOf(now);
    this.data.days[day] = added(this.data.days[day] ?? ZERO, u);
    for (const k of Object.keys(this.data.days).sort().slice(0, -DAYS_KEPT)) delete this.data.days[k];
    this.changed();
  }
  view(): { since: string; total: Tally } {
    return { since: this.data.since, total: { ...this.data.total } };
  }
}

type LedgerData = Record<string, Tally & { last: string }>;

/** On the host: usage per PC ('here' or a linked PC's id) and per project ('' = not in a project). */
export class Ledger extends Kept<LedgerData> {
  constructor(file: string) {
    super(file, {});
  }
  load(): Promise<this> {
    return super.load(raw => Object.fromEntries(Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>)
      .filter(([k]) => /^[\w-]{1,40}\|[\w-]{0,40}$/.test(k))
      .map(([k, v]) => [k, { ...cleanTally(v), last: String((v as { last?: unknown })?.last ?? '') }])));
  }
  add(pc: string, project: string, u: Used, now = new Date()): void {
    const k = `${pc}|${project}`;
    if (!/^[\w-]{1,40}\|[\w-]{0,40}$/.test(k)) return;
    this.data[k] = { ...added(this.data[k] ?? ZERO, u), last: now.toISOString() };
    this.changed();
  }
  /**
   * A linked PC's own log of the work it did for this one (its rows "for-<link>" there): it is the final tally, so its
   * rows take the place of what this PC counted from that PC's answers. Rows only this PC has are kept.
   */
  takeFrom(pc: string, rows: { project: string; tally: Tally; last?: string }[]): void {
    for (const r of rows) {
      const k = `${pc}|${r.project}`;
      if (!/^[\w-]{1,40}\|[\w-]{0,40}$/.test(k)) continue;
      this.data[k] = { ...cleanTally(r.tally), last: r.last ?? this.data[k]?.last ?? '' };
    }
    if (rows.length) this.changed();
  }
  /** Every PC's rows for one project. */
  forProject(project: string): { pc: string; tally: Tally }[] {
    return Object.entries(this.data).filter(([k]) => k.endsWith(`|${project}`) && !k.startsWith('for-')).map(([k, v]) => ({ pc: k.slice(0, k.indexOf('|')), tally: cleanTally(v) }));
  }
  /** One PC's rows, the most used first. */
  forPc(pc: string): { project: string; tally: Tally; last: string }[] {
    return Object.entries(this.data).filter(([k]) => k.startsWith(`${pc}|`)).map(([k, v]) => ({ project: k.slice(pc.length + 1), tally: cleanTally(v), last: v.last }))
      .sort((a, b) => b.tally.in + b.tally.cached + b.tally.out - (a.tally.in + a.tally.cached + a.tally.out));
  }
}

/** Tokens written per day ("2026-10-08" -> count), for the office's employee of the month and weekly leaderboard. */
type Written = Record<string, number>;
type ByStaffData = Record<string, Tally & { last: string; written?: Written; worked?: Written }>;
/** Days of tokens written kept per hire: enough for this month and last month's award. */
const WRITTEN_DAYS = 70;

/**
 * On the host: usage per hire (their staff id), whichever PC answered for them. Counted from each answer as it ends here
 * (a linked PC's done line included); a linked PC's own log does not correct it, so it can differ a little from the
 * per-PC figures. Pictures use no tokens and are not counted.
 */
export class ByStaff extends Kept<ByStaffData> {
  constructor(file: string) {
    super(file, {});
  }
  load(): Promise<this> {
    return super.load(raw => Object.fromEntries(Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>)
      .filter(([k]) => /^[\w-]{1,40}$/.test(k))
      .map(([k, v]) => [k, { ...cleanTally(v), last: String((v as { last?: unknown })?.last ?? ''), written: cleanWritten((v as { written?: unknown })?.written), worked: cleanWritten((v as { worked?: unknown })?.worked) }])));
  }
  add(staff: string | undefined, u: Used, now = new Date()): void {
    if (!staff || !/^[\w-]{1,40}$/.test(staff)) return;
    const was = this.data[staff];
    const written = { ...(was?.written ?? {}) };
    const worked = { ...(was?.worked ?? {}) };
    const day = dayOf(now);
    written[day] = (written[day] ?? 0) + u.out;
    worked[day] = (worked[day] ?? 0) + u.ms;
    for (const k of Object.keys(written).sort().slice(0, -WRITTEN_DAYS)) delete written[k];
    for (const k of Object.keys(worked).sort().slice(0, -WRITTEN_DAYS)) delete worked[k];
    this.data[staff] = { ...added(was ?? ZERO, u), last: now.toISOString(), written, worked };
    this.changed();
  }
  /** Time each hire worked (ms) from day `from` to day `to` (both included); counted from 2.0.44, so older work is not in it. */
  workedBetween(from: string, to: string): Record<string, number> {
    return Object.fromEntries(Object.entries(this.data).map(([id, v]) => [id, Object.entries(v.worked ?? {}).reduce((n, [d, ms]) => (d >= from && d <= to ? n + ms : n), 0)]));
  }
  /** Tokens each hire wrote from day `from` to day `to` (both "YYYY-MM-DD", included), most first; none left out. */
  writtenBetween(from: string, to: string): { id: string; out: number }[] {
    return Object.entries(this.data).map(([id, v]) => ({ id, out: Object.entries(v.written ?? {}).reduce((n, [d, c]) => (d >= from && d <= to ? n + c : n), 0) }))
      .sort((a, b) => b.out - a.out || a.id.localeCompare(b.id));
  }
  /** Every token every hire ever wrote here (fired ones too): the office shop's money (src/home.ts purseOf). */
  totalWritten(): number {
    return Object.values(this.data).reduce((n, v) => n + cleanTally(v).out, 0);
  }
  of(staff: string): { tally: Tally; last: string } {
    const r = this.data[staff];
    return { tally: cleanTally(r), last: r?.last ?? '' };
  }
}

type ByModelData = Record<string, Record<string, [number, number]>>;
/** Days kept per model: the PC window shows the last 7. */
const MODEL_DAYS = 30;
/** A PC ('here' or a linked PC's 8-letter id) and a model as that PC names it, as one key: "here|qwen3-8b-q4_k_m". */
const modelKey = (pc: string, model: string): string | null => {
  const m = String(model ?? '').trim().slice(0, 160);
  return /^(?:here|[0-9a-f]{8})$/.test(pc) && m && !/[\u0000-\u001f|]/.test(m) ? `${pc}|${m}` : null;
};

/** On the host: per PC and model, the time it worked (ms) and the answers it wrote, per day. Pictures are not counted. */
export class ByModel extends Kept<ByModelData> {
  constructor(file: string) {
    super(file, {});
  }
  load(): Promise<this> {
    return super.load(raw => {
      const out: ByModelData = {};
      for (const [k, days] of Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>)) {
        const bar = k.indexOf('|');
        if (bar < 1 || !modelKey(k.slice(0, bar), k.slice(bar + 1)) || !days || typeof days !== 'object') continue;
        out[k] = Object.fromEntries(Object.entries(days as Record<string, unknown>).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Array.isArray(v)).map(([d, v]) => [d, [num((v as unknown[])[0]), num((v as unknown[])[1])] as [number, number]]));
      }
      return out;
    });
  }
  add(pc: string, model: string, u: Used, now = new Date()): void {
    const k = modelKey(pc, model);
    if (!k) return;
    const days = (this.data[k] ??= {});
    const d = dayOf(now);
    const [ms, n] = days[d] ?? [0, 0];
    days[d] = [ms + u.ms, n + 1];
    for (const x of Object.keys(days).sort().slice(0, -MODEL_DAYS)) delete days[x];
    this.changed();
  }
  /** One PC's models over the last `days` days (today included), the most worked first; models that did nothing are left out. */
  top(pc: string, days = 7, now = new Date()): { model: string; ms: number; answers: number }[] {
    const from = dayOf(new Date(now.getTime() - (days - 1) * 86_400_000));
    return Object.entries(this.data).filter(([k]) => k.startsWith(`${pc}|`)).map(([k, v]) => {
      let ms = 0;
      let answers = 0;
      for (const [d, [a, b]] of Object.entries(v)) if (d >= from) {
        ms += a;
        answers += b;
      }
      return { model: k.slice(pc.length + 1), ms, answers };
    }).filter(x => x.answers > 0).sort((a, b) => b.ms - a.ms || b.answers - a.answers || a.model.localeCompare(b.model));
  }
}

type UptimeData = Record<string, Record<string, [number, number]>>;

/** On the host: each linked PC's once-a-minute checks, answered and asked, per day (30 days kept). */
export class Uptime extends Kept<UptimeData> {
  constructor(file: string) {
    super(file, {});
  }
  load(): Promise<this> {
    return super.load(raw => {
      const out: UptimeData = {};
      for (const [pc, days] of Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>)) {
        if (!/^[0-9a-f]{8}$/.test(pc) || !days || typeof days !== 'object') continue;
        out[pc] = Object.fromEntries(Object.entries(days as Record<string, unknown>).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Array.isArray(v)).map(([d, v]) => [d, [num((v as unknown[])[0]), num((v as unknown[])[1])] as [number, number]]));
      }
      return out;
    });
  }
  mark(pc: string, answered: boolean, now = new Date()): void {
    if (!/^[0-9a-f]{8}$/.test(pc)) return;
    const days = (this.data[pc] ??= {});
    const d = dayOf(now);
    const [ok, asked] = days[d] ?? [0, 0];
    days[d] = [ok + (answered ? 1 : 0), asked + 1];
    for (const k of Object.keys(days).sort().slice(0, -30)) delete days[k];
    this.changed();
  }
  /** Checks answered and asked over the last `days` days (today included). */
  share(pc: string, days = 7, now = new Date()): { ok: number; asked: number } {
    const from = dayOf(new Date(now.getTime() - (days - 1) * 86_400_000));
    let ok = 0;
    let asked = 0;
    for (const [d, [a, b]] of Object.entries(this.data[pc] ?? {})) if (d >= from) {
      ok += a;
      asked += b;
    }
    return { ok, asked };
  }
}

// ---- What it cost ----

/** An API to compare with: its name and its list price in US$ per million tokens read, read from its cache, and written. */
export interface ApiPrice {
  id: string;
  name: string;
  in: number;
  cached: number;
  out: number;
}

/**
 * List prices checked 7 Oct 2026, in US$ per million tokens: Anthropic's model table for Claude Opus 5.5 (cache reads
 * $0.20), and OpenAI's pricing page (developers.openai.com/api/docs/pricing) for GPT-6.1 Sol, its main ChatGPT model in
 * the API (cached input $0.10). They change: the window lets them be changed, and says when these were checked.
 */
export const API_PRICES: ApiPrice[] = [
  { id: 'claude', name: 'Claude Opus 5.5 API', in: 4, cached: 0.2, out: 20 },
  { id: 'chatgpt', name: 'ChatGPT API (GPT-6.1 Sol)', in: 2, cached: 0.1, out: 10 },
];
export const PRICES_CHECKED = '7 Oct 2026';

export function cleanPrices(raw: unknown): ApiPrice[] {
  const list = Array.isArray(raw) ? raw : [];
  return API_PRICES.map(p => {
    const r = list.find((x: Record<string, unknown>) => x?.id === p.id) as Record<string, unknown> | undefined;
    const price = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 10_000 ? Number(v) : d);
    return { id: p.id, name: String(r?.name ?? p.name).replace(/\s+/g, ' ').trim().slice(0, 60) || p.name, in: price(r?.in, p.in), cached: price(r?.cached, p.cached), out: price(r?.out, p.out) };
  });
}

/** A PC's power: how many watts it draws while a model works, and the price of a kWh (US$). Either may be unset. */
export interface Power {
  watts: number | null;
  kwh: number | null;
}
export function cleanPower(raw: unknown): Power {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const val = (v: unknown, max: number) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0 || Number(v) > max ? null : Number(v));
  return { watts: val(r.watts, 5000), kwh: val(r.kwh, 10) };
}
/**
 * What is wrong with power settings as sent (POST /api/pc/power), else null: an empty box means "not used", but a
 * number out of range is said, not quietly emptied.
 */
export function powerFault(raw: unknown): string | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bad = (v: unknown, max: number) => !(v === null || v === '' || v === undefined) && !(Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max);
  if (bad(r.watts, 5000)) return `The power draw must be more than 0 and at most 5,000 watts (it was "${String(r.watts).slice(0, 20)}"). Type the watts again, or leave the box empty to not count power.`;
  if (bad(r.kwh, 10)) return `The power price must be more than 0 and at most 10 per kWh (it was "${String(r.kwh).slice(0, 20)}"). Type the price again, or leave the box empty to not count power.`;
  return null;
}

export interface Costs {
  /** kWh used while the models worked (null without the watts). */
  kwh: number | null;
  /** That power at the price set (null without both). */
  power: number | null;
  /** Each API's cost, cached tokens at its cached price (as llama.cpp's cache and an API's prompt caching both do), and
   * `noCache`, every prompt token at the full input price. */
  apis: { id: string; name: string; cost: number; noCache: number }[];
  /** Power cost per million tokens (new, cached and written together, as an API counts them), null without both. */
  powerPerMillion: number | null;
}

/**
 * What `t` cost: the power (watts × working hours ÷ 1000 × price per kWh), and the same tokens at each API's list
 * price: new prompt tokens at the input price, cached ones at the cached price, written ones at the output price.
 * (Claude also bills writing to its cache at 1.25 times the input price; that is left out, so the Claude figure is a
 * little low.) `noCache` is the same with every prompt token at the full input price.
 */
export function costs(t: Tally, power: Power, apis: ApiPrice[]): Costs {
  const kwh = power.watts ? (power.watts * t.ms) / 3_600_000_000 : null;
  const cost = kwh !== null && power.kwh ? kwh * power.kwh : null;
  const tokens = t.in + t.cached + t.out;
  return {
    kwh,
    power: cost,
    apis: apis.map(a => ({ id: a.id, name: a.name, cost: (t.in / 1e6) * a.in + (t.cached / 1e6) * a.cached + (t.out / 1e6) * a.out, noCache: ((t.in + t.cached) / 1e6) * a.in + (t.out / 1e6) * a.out })),
    powerPerMillion: cost !== null && tokens > 0 ? (cost / tokens) * 1e6 : null,
  };
}
