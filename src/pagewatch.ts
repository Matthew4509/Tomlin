// A page watch (N2 of the 27 Nov agents plan): the "When a page changes (every 2 hours)" trigger. TOMLIN's own code
// looks at the recipe's pages, one at a time and politely (the POLITE pacer; If-None-Match and If-Modified-Since when
// the site gave them), keeps each page's text as plain lines with the noise taken out, and starts a run only when the
// lines changed. No model is loaded for a look. The first look only stores; a page that fails three looks in a row is
// said once. What changed goes into the run's brief, fenced as page text (untrusted). Plain parts tested in
// test/pagewatch.test.ts; the look takes its fetcher, so the tests use made-up pages.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.ts';
import { guardData } from './promptscan.ts';
import { fetchPublic, normalUrl, pageText, politeFetcher, siteOf, type Fetcher, type Pacer } from './webtools.ts';

/** At most this many pages for a page watch. */
export const WATCH_PAGES = 5;
/** A page's kept lines, at most (characters). */
export const KEEP_CHARS = 200_000;
/** What changed on one page, at most, in a run's brief. */
export const CHANGE_LINES = 40;
export const CHANGE_CHARS = 4000;
/** Looks in a row that failed before it is said (once). */
export const FAILS_SAID = 3;
const PAGE_BYTES = 2 << 20;

/** What is kept of one page between looks (small: the lines themselves are in their own file). */
export interface PageState {
  url: string;
  /** sha1 of the kept lines; '' before the first look that read the page. */
  hash: string;
  /** Last look (ms). */
  at: number;
  /** When its lines last changed (ms), 0 for never seen to change. */
  changedAt: number;
  etag?: string;
  lastModified?: string;
  /** Looks in a row that failed. */
  fails: number;
  /** The failing was said already (on Home, once). */
  said?: boolean;
  /** The last look's result in words, for the Agents page. */
  last: string;
}

export function cleanPageState(raw: unknown): PageState | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const url = typeof o.url === 'string' ? normalUrl(o.url) : null;
  if (!url) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    url, hash: typeof o.hash === 'string' && /^[0-9a-f]{0,40}$/.test(o.hash) ? o.hash : '', at: n(o.at), changedAt: n(o.changedAt), fails: Math.min(1000, Math.floor(n(o.fails))), last: typeof o.last === 'string' ? o.last.slice(0, 200) : '',
    ...(typeof o.etag === 'string' && o.etag ? { etag: o.etag.slice(0, 200) } : {}),
    ...(typeof o.lastModified === 'string' && o.lastModified ? { lastModified: o.lastModified.slice(0, 100) } : {}),
    ...(o.said === true ? { said: true } : {}),
  };
}

// ---- The noise taken out of a page: what changes on every load ----

const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\b/gi;
const AGO = /\b(?:(?:updated|posted|published|edited|refreshed|last seen)\s+)?(?:(?:\d+|an?|a few)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago|yesterday|today)\b/gi;
// A date: "Saturday", "28 November 2026", "Nov 28, 2026", "28/11/2026", "2026-11-28". A page that shows the day it is
// changes every day with nothing on it changing.
const WEEKDAY = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b,?/gi;
const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?';
const DAY_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?![a-z]),?(?:\\s+\\d{4}\\b)?`, 'gi');
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b,?(?:\\s+\\d{4}\\b)?`, 'gi');
const NUM_DATE = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/g;
const JUST_NOW = /\b(?:updated\s+)?just now\b/gi;
const HEX = /\b[0-9a-f]{20,}\b/gi;
const TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;
const SESSION = /\b(?:session|sid|token|nonce|csrf|request)[ _-]?(?:id)?\s*[:=]\s*\S+/gi;

/** A page's text as the lines a watch compares: the noise out, spaces collapsed, empty and repeated lines dropped. */
export function normalLines(text: string): string[] {
  const out: string[] = [];
  let size = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(SESSION, ' ').replace(HEX, ' ').replace(TOKEN, ' ').replace(AGO, ' ').replace(JUST_NOW, ' ').replace(NUM_DATE, ' ').replace(DAY_MONTH, ' ').replace(MONTH_DAY, ' ').replace(WEEKDAY, ' ').replace(CLOCK, ' ').replace(/\s+/g, ' ').trim();
    // A line that was only a time, a date stamp's leftovers or punctuation says nothing.
    if (!line || !/[\p{L}\p{N}]{2,}/u.test(line)) continue;
    if (out.at(-1) === line) continue;
    if (size + line.length > KEEP_CHARS) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

export const hashLines = (lines: string[]): string => createHash('sha1').update(lines.join('\n')).digest('hex');

/** The lines gone and the lines new between two looks (in page order), cut to CHANGE_LINES and CHANGE_CHARS in all. */
export function changedLines(before: string[], after: string[]): { gone: string[]; added: string[]; more: boolean } {
  const had = new Set(before);
  const has = new Set(after);
  const gone = before.filter(l => !has.has(l));
  const added = after.filter(l => !had.has(l));
  const outGone: string[] = [];
  const outAdded: string[] = [];
  let chars = 0;
  let n = 0;
  // Turn about, new first, so a long list of either still shows some of both.
  for (let i = 0; i < Math.max(gone.length, added.length); i++) {
    for (const [list, into] of [[added, outAdded], [gone, outGone]] as const) {
      const l = list[i];
      if (l === undefined) continue;
      const t = l.length > 400 ? `${l.slice(0, 399)}…` : l;
      if (n >= CHANGE_LINES || chars + t.length > CHANGE_CHARS) return { gone: outGone, added: outAdded, more: true };
      into.push(t);
      chars += t.length;
      n++;
    }
  }
  return { gone: outGone, added: outAdded, more: false };
}

/** Whether a change counts: with "Watch for" words, a changed line must hold one of them (any case). */
export function watchHit(c: { gone: string[]; added: string[] }, words: string[]): boolean {
  if (!c.gone.length && !c.added.length) return false;
  if (!words.length) return true;
  const ws = words.map(w => w.toLowerCase());
  return [...c.gone, ...c.added].some(l => ws.some(w => l.toLowerCase().includes(w)));
}

/** "price, in stock" as words to watch for: at most 10, each 2 to 40 characters. */
export function watchWords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : typeof raw === 'string' ? raw.split(/[,;\n]/) : [];
  const out: string[] = [];
  for (const w of list.map(x => x.trim().replace(/^["“']|["”']$/g, '').trim().slice(0, 40))) if (w.length >= 2 && !out.some(o => o.toLowerCase() === w.toLowerCase())) out.push(w);
  return out.slice(0, 10);
}

/** What changed on the pages, as the run's brief gives it: page text, fenced when it looks like orders for an AI. */
export function changesBlock(pages: { url: string; gone: string[]; added: string[]; more: boolean }[]): string {
  const parts = pages.map(p => [
    `Page: ${p.url}`,
    p.added.length ? `New or changed lines:\n${p.added.map(l => `+ ${l}`).join('\n')}` : '',
    p.gone.length ? `Lines no longer there:\n${p.gone.map(l => `- ${l}`).join('\n')}` : '',
    p.more ? '[more changed than is shown here: open the page to see it all]' : '',
  ].filter(Boolean).join('\n'));
  return guardData('the watched pages', parts.join('\n\n')).text;
}

/** Whether a watch is due: never looked, or its minutes have passed since the oldest look. */
export const watchDue = (states: PageState[], pages: string[], everyMinutes: number, now: number): boolean =>
  pages.some(p => { const s = states.find(x => x.url === p); return !s || now - s.at >= everyMinutes * 60_000; });

// ---- One look at one page ----

export interface LookResult {
  state: PageState;
  /** Lines to keep (null: unchanged, or the look failed, so the kept file stays as it is). */
  lines: string[] | null;
  /** What changed since the last look (null: nothing, the first look, or it failed). */
  change: { gone: string[]; added: string[]; more: boolean } | null;
  /** The look failed three times in a row just now (said once). */
  failSay?: string;
}

const hm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Looks at one page: `was` its state (undefined for the first look), `before` its kept lines. Never throws: a page that
 * does not open counts a fail.
 */
export async function lookPage(url: string, was: PageState | undefined, before: string[], o: { get?: Fetcher; pace?: Pacer; signal?: AbortSignal; now?: number }): Promise<LookResult> {
  const now = o.now ?? Date.now();
  const s: PageState = was ? { ...was } : { url, hash: '', at: 0, changedAt: 0, fails: 0, last: '' };
  s.at = now;
  const get = politeFetcher('page', siteOf(url), 'Looking at a watched page', { get: o.get ?? fetchPublic, pace: o.pace, slowed: new Set() });
  const failed = (why: string): LookResult => {
    s.fails++;
    s.last = `Looked ${hm(now)}: it did not open (${why}).`;
    const say = s.fails >= FAILS_SAID && !s.said;
    if (say) s.said = true;
    return { state: s, lines: null, change: null, ...(say ? { failSay: `${url} did not open in ${s.fails} looks in a row (${why}). It is still looked at as often as before.` } : {}) };
  };
  try {
    const headers: Record<string, string> = {};
    if (s.hash && s.etag) headers['If-None-Match'] = s.etag;
    if (s.hash && s.lastModified) headers['If-Modified-Since'] = s.lastModified;
    const r = await get(url, { signal: o.signal ?? AbortSignal.timeout(60_000), maxBytes: PAGE_BYTES, publicOnly: true, headers });
    if (r.status === 304 && s.hash) {
      s.fails = 0;
      s.said = undefined;
      s.last = `Looked ${hm(now)}: no change.`;
      return { state: clean(s), lines: null, change: null };
    }
    if (r.status < 200 || r.status >= 300) return failed(`the site answered ${r.status}`);
    if (!/html|text\/plain|xml/.test(r.type) && r.type) return failed(`it is not a web page (${r.type.split(';')[0]})`);
    const text = /html|xml/.test(r.type) || !r.type ? pageText(r.body.toString('utf8'), r.url).text : r.body.toString('utf8');
    const lines = normalLines(text);
    // A page that answers with nothing on it (a site mid-update, a blocked look) is a look that failed, not the page
    // now: kept, it would start a run, and the page coming back would start another.
    if (!lines.length) return failed('the page came back empty');
    const hash = hashLines(lines);
    s.fails = 0;
    s.said = undefined;
    if (r.etag) s.etag = r.etag; else delete s.etag;
    if (r.lastModified) s.lastModified = r.lastModified; else delete s.lastModified;
    if (!s.hash) {
      s.hash = hash;
      s.last = `Looked ${hm(now)}: kept as it is now (the first look starts no run).`;
      return { state: clean(s), lines, change: null };
    }
    if (hash === s.hash) {
      s.last = `Looked ${hm(now)}: no change.`;
      return { state: clean(s), lines: null, change: null };
    }
    const change = changedLines(before, lines);
    s.hash = hash;
    s.changedAt = now;
    s.last = `Looked ${hm(now)}: changed.`;
    return { state: clean(s), lines, change: change.gone.length || change.added.length ? change : null };
  } catch (e) {
    return failed(((e as Error).message || 'no answer').replace(/\.$/, '').slice(0, 160));
  }
}

const clean = (s: PageState): PageState => cleanPageState(s)!;

// ---- The kept lines, one file per job ----

export const linesDir = (dataDir: string): string => join(dataDir, 'agent-pages');

export async function readLines(dataDir: string, job: string): Promise<Record<string, string[]>> {
  try {
    const o = JSON.parse(await readFile(join(linesDir(dataDir), `${job}.json`), 'utf8')) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(o)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    return out;
  } catch {
    return {};
  }
}

export async function writeLines(dataDir: string, job: string, all: Record<string, string[]>): Promise<void> {
  await mkdir(linesDir(dataDir), { recursive: true });
  await writeAtomic(join(linesDir(dataDir), `${job}.json`), JSON.stringify(all));
}

export const dropLines = (dataDir: string, job: string): Promise<void> => rm(join(linesDir(dataDir), `${job}.json`), { force: true });
