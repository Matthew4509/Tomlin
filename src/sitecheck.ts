// A website check done page by page, by code. The web tools of a chat leave it to the model to open pages, and a small
// model fills its context after a page or two. Here the code walks the site itself (same site only, at a person's pace,
// a page cap), gives the model ONE page's words at a time with a fixed question in a fresh context, reads the raw HTML
// itself for what words cannot show (scripts, hidden links, redirects, odd addresses), and puts it all in one report with
// the tokens, the time and the gaps between page reads. The model judges words; the code reports what it found.
// The routes are in src/server/sitecheck.ts; tested in test/sitecheck.test.ts with a fake fetcher and a fake model.
import { Pacer, fetchPublic, normalUrl, pageText, politeFetcher, siteOf, type Fetcher, type Fetched } from './webtools.ts';

// ---- What the raw HTML shows ----

export interface ScriptInfo {
  src: string;
  host: string;
  /** From another site than the page. */
  thirdParty: boolean;
  /** A third-party host that many sites use (statistics, fonts, video, maps...). */
  known: boolean;
}

export interface HtmlFindings {
  /** Scripts loaded from an address. */
  scripts: ScriptInfo[];
  inlineScripts: number;
  /** What an inline script does that is worth a look (hiding its text, building code, sending the visitor away). */
  inlineFlags: { what: string; sample: string }[];
  iframes: { src: string; host: string; hidden: boolean; thirdParty: boolean }[];
  /** Where a <meta refresh> sends the visitor. */
  metaRefresh: string[];
  /** Links inside something that is not shown to a visitor (display none, off the screen, size 0). */
  hiddenLinks: number;
  /** Other sites linked, with how many links each. */
  externalLinks: Record<string, number>;
  shorteners: string[];
  /** Links to a program or installer. */
  downloads: string[];
  forms: { action: string; host: string; thirdParty: boolean }[];
  /** Every http(s) link on the page (made absolute, no #part), for walking the site. */
  links: string[];
}

/** Hosts that many ordinary sites load things from. Not a promise that a script from them is safe. */
const KNOWN_HOSTS = /(^|\.)(google-analytics\.com|googletagmanager\.com|google\.com|google\.com\.au|gstatic\.com|googleapis\.com|googleusercontent\.com|doubleclick\.net|facebook\.net|facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtube-nocookie\.com|ytimg\.com|vimeo\.com|cloudflare\.com|cloudflareinsights\.com|jsdelivr\.net|unpkg\.com|jquery\.com|bootstrapcdn\.com|fontawesome\.com|typekit\.net|wp\.com|wordpress\.com|gravatar\.com|recaptcha\.net|hotjar\.com|stripe\.com|paypal\.com|squarespace\.com|squarespace-cdn\.com|sqspcdn\.com|wixstatic\.com|wix\.com|shopify\.com|mailchimp\.com|list-manage\.com|calendly\.com|zdassets\.com|zendesk\.com|intercom\.io|bing\.com|clarity\.ms|tiktok\.com|pinterest\.com)$/i;

/** Address shorteners: a link through one hides where it goes. */
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in', 's.id', 'v.gd', 't.ly', 'bl.ink', 'soo.gd', 'clck.ru']);

const DOWNLOAD = /\.(exe|msi|scr|bat|cmd|vbs|jar|apk|dmg|pkg|ps1|iso|lnk)(\?|#|$)/i;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|(?:left|top|right|bottom|text-indent|margin-left)\s*:\s*-\s*\d{3,}|font-size\s*:\s*0(?:px|pt|em|%)?\s*(?:;|"|'|$)|(?:height|width)\s*:\s*0(?:px)?\s*;[^"']*overflow\s*:\s*hidden|opacity\s*:\s*0\s*(?:;|"|'|$)/i;

/** What an inline script does that is worth a look; each is a pattern and the plain words for it. */
const SCRIPT_SIGNS: { re: RegExp; what: string }[] = [
  { re: /\beval\s*\(/, what: 'runs text as code (eval)' },
  { re: /\batob\s*\(/, what: 'decodes hidden text (atob)' },
  { re: /String\s*\.\s*fromCharCode/, what: 'builds text from character codes (fromCharCode)' },
  { re: /\bunescape\s*\(/, what: 'decodes escaped text (unescape)' },
  { re: /new\s+Function\s*\(/, what: 'builds code from text (new Function)' },
  { re: /document\s*\.\s*write\s*\(/, what: 'writes into the page while it loads (document.write)' },
  { re: /[A-Za-z0-9+/]{200,}={0,2}/, what: 'holds a very long encoded-looking string' },
  { re: /(?:\\x[0-9a-fA-F]{2}){12,}/, what: 'holds text written as hex escapes' },
  { re: /\b_0x[0-9a-f]{4,}\b/, what: 'uses obfuscator-style names (_0x...)' },
  { re: /(?:window\s*\.\s*|document\s*\.\s*|top\s*\.\s*)?location(?:\s*\.\s*(?:href|replace|assign))?\s*(?:=|\()\s*['"`]https?:/, what: 'sends the visitor to another address' },
  { re: /coinhive|cryptonight|coin-hive|webminer|minero\.cc/i, what: 'mentions a coin miner' },
];

function attr(tag: string, name: string): string {
  const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const absolute = (href: string, base: string): string | null => {
  const h = href.replace(/&amp;/gi, '&').trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data|sms|whatsapp):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/** The raw HTML of a page read for what its words do not show. `pageUrl` is where it came from (after redirects). */
export function inspectHtml(html: string, pageUrl: string): HtmlFindings {
  if (html.length > 2_000_000) html = html.slice(0, 2_000_000);
  const here = siteOf(pageUrl);
  const lower = html.toLowerCase();
  const out: HtmlFindings = { scripts: [], inlineScripts: 0, inlineFlags: [], iframes: [], metaRefresh: [], hiddenLinks: 0, externalLinks: {}, shorteners: [], downloads: [], forms: [], links: [] };
  const seenLinks = new Set<string>();
  const seenFlags = new Set<string>();
  const hostFlags = (u: string) => {
    const host = hostOf(u);
    return { host, thirdParty: !!host && host !== here, known: KNOWN_HOSTS.test(host) };
  };
  const tagRe = /<(script|iframe|meta|form|a|div|span|p|section|ul|li|td|nav|img)\b[^>]*>/gi;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    const name = m[1].toLowerCase();
    const tag = m[0];
    if (name === 'script') {
      const src = attr(tag, 'src');
      const close = lower.indexOf('</script', tagRe.lastIndex);
      const body = src || close < 0 ? '' : html.slice(tagRe.lastIndex, Math.min(close, tagRe.lastIndex + 300_000));
      if (src) {
        const abs = absolute(src, pageUrl) ?? src;
        const f = hostFlags(abs);
        if (out.scripts.length < 100) out.scripts.push({ src: abs.slice(0, 300), host: f.host, thirdParty: f.thirdParty, known: f.known });
      } else if (body.trim()) {
        out.inlineScripts++;
        for (const sign of SCRIPT_SIGNS) {
          if (seenFlags.has(sign.what) || out.inlineFlags.length >= 20) continue;
          const hit = sign.re.exec(body);
          if (hit) {
            seenFlags.add(sign.what);
            out.inlineFlags.push({ what: sign.what, sample: body.slice(Math.max(0, hit.index - 20), hit.index + 80).replace(/\s+/g, ' ').trim().slice(0, 100) });
          }
        }
      }
      if (close > 0) tagRe.lastIndex = close;
      continue;
    }
    if (name === 'iframe') {
      const abs = absolute(attr(tag, 'src'), pageUrl);
      if (abs && out.iframes.length < 50) {
        const style = `${attr(tag, 'style')} ${attr(tag, 'width')} ${attr(tag, 'height')}`;
        const f = hostFlags(abs);
        out.iframes.push({ src: abs.slice(0, 300), host: f.host, hidden: HIDDEN_STYLE.test(style) || /(^|\s)0(px)?(\s|$)/.test(`${attr(tag, 'width')} ${attr(tag, 'height')}`) || /\bhidden\b/i.test(tag), thirdParty: f.thirdParty });
      }
      continue;
    }
    if (name === 'meta') {
      if (/http-equiv\s*=\s*["']?refresh/i.test(tag)) {
        const to = /url\s*=\s*['"]?([^'";>]+)/i.exec(attr(tag, 'content'))?.[1] ?? attr(tag, 'content');
        const abs = absolute(to, pageUrl);
        out.metaRefresh.push((abs ?? to).slice(0, 300));
      }
      continue;
    }
    if (name === 'form') {
      const action = absolute(attr(tag, 'action'), pageUrl);
      if (action && out.forms.length < 30) {
        const f = hostFlags(action);
        out.forms.push({ action: action.slice(0, 300), host: f.host, thirdParty: f.thirdParty });
      }
      continue;
    }
    if (name === 'a') {
      const abs = absolute(attr(tag, 'href'), pageUrl);
      if (abs) {
        const noHash = abs.split('#')[0];
        if (!seenLinks.has(noHash) && out.links.length < 2000) {
          seenLinks.add(noHash);
          out.links.push(noHash);
        }
        const host = hostOf(abs);
        if (host && host !== here) {
          out.externalLinks[host] = (out.externalLinks[host] ?? 0) + 1;
          if (SHORTENERS.has(host) && !out.shorteners.includes(abs)) out.shorteners.push(abs.slice(0, 300));
        }
        if (DOWNLOAD.test(abs) && !out.downloads.includes(abs)) out.downloads.push(abs.slice(0, 300));
        if (HIDDEN_STYLE.test(attr(tag, 'style')) && host && host !== here) out.hiddenLinks++;
      }
      continue;
    }
    // A block that is not shown to a visitor, with links to other sites inside it (hidden text links are a common spam
    // injection): the next stretch of the page is looked at for them.
    if (HIDDEN_STYLE.test(attr(tag, 'style'))) {
      const stretch = lower.slice(tagRe.lastIndex, tagRe.lastIndex + 3000);
      const re = /<a\b[^>]*href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/g;
      for (let a = re.exec(stretch); a; a = re.exec(stretch)) {
        const host = hostOf(a[1]);
        if (host && host !== here) out.hiddenLinks++;
      }
    }
  }
  return out;
}

/** What the code found on a page that a person should look at, in plain words (empty when nothing). */
export function pageFlags(f: HtmlFindings, finalUrl: string, askedUrl: string): string[] {
  const out: string[] = [];
  const site = siteOf(askedUrl);
  if (siteOf(finalUrl) !== site) out.push(`The address led to another site: ${finalUrl}`);
  for (const s of f.scripts) if (s.thirdParty && !s.known) out.push(`A script comes from ${s.host || 'an unknown address'}, not a well-known host: ${s.src}`);
  for (const i of f.inlineFlags) out.push(`An inline script ${i.what}: "${i.sample}"`);
  for (const i of f.iframes) if (i.hidden || (i.thirdParty && !KNOWN_HOSTS.test(i.host))) out.push(`${i.hidden ? 'A hidden frame loads' : 'A frame loads'} ${i.src}`);
  for (const r of f.metaRefresh) out.push(`The page redirects by itself (meta refresh) to ${r}`);
  if (f.hiddenLinks > 0) out.push(`${f.hiddenLinks} link${f.hiddenLinks === 1 ? '' : 's'} to other sites sit in something a visitor cannot see`);
  for (const s of f.shorteners) out.push(`A link goes through an address shortener: ${s}`);
  for (const d of f.downloads) out.push(`A link is a program or installer: ${d}`);
  for (const fm of f.forms) if (fm.thirdParty && !KNOWN_HOSTS.test(fm.host)) out.push(`A form sends what is typed to ${fm.host}: ${fm.action}`);
  return out;
}

// ---- Walking the site ----

/** What the model is asked about each page (the page's words follow it). */
export const PAGE_SYSTEM = 'You check one web page for the person who owns the website. Read only the page text you are given. Be brief and exact.';
export const PAGE_QUESTION = [
  'Check this page text for the website owner. Look for:',
  '1. anything rude, offensive, adult, gambling, pills, loans or other spam that does not belong on this kind of site;',
  '2. signs the site was hacked: defaced text, text in a language that does not fit, stuffed keywords, strange paragraphs of links;',
  '3. links or contact details that look wrong for this business.',
  'Reply with the first line "VERDICT: OK" or "VERDICT: CHECK", then at most three short lines saying why. Quote the exact words of anything you flag.',
].join('\n');
export const SUMMARY_QUESTION = 'Below are the findings from checking a website page by page: what a reader of each page found, and what a program found in the pages\' code. Say in at most five short lines whether anything needs the owner\'s attention and what. Start with "VERDICT: OK" or "VERDICT: CHECK".';

export interface SiteAnswer {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** The model did not report its tokens: they are a guess (3 characters a token). */
  estimated?: boolean;
}
export type SiteAsk = (system: string, user: string, signal: AbortSignal) => Promise<SiteAnswer>;

export interface PageResult {
  url: string;
  finalUrl: string;
  status: number;
  /** Why the page was not read, when it was not. */
  error?: string;
  title: string;
  words: number;
  /** The page's words were longer than the model's room, and cut. */
  cut: boolean;
  /** Seconds since the check began when the page was asked for from the site. */
  at: number;
  /** Seconds this PC waited its turn at the site (the pace) before asking. */
  waitedSeconds: number;
  fetchSeconds: number;
  askSeconds: number;
  tokensIn: number;
  tokensOut: number;
  verdict: 'ok' | 'check' | 'unclear' | 'skipped';
  said: string;
  /** What the code found in the page's HTML. */
  flags: string[];
  html: Pick<HtmlFindings, 'inlineScripts' | 'externalLinks'> & { scripts: ScriptInfo[] };
}

export interface SiteReport {
  site: string;
  start: string;
  startedAt: string;
  seconds: number;
  /** The check was stopped before it finished. */
  stopped: boolean;
  pages: PageResult[];
  /** Same-site addresses found and not visited (the page cap, or they were not pages). */
  notVisited: string[];
  totals: { pagesRead: number; pagesFailed: number; tokensIn: number; tokensOut: number; askSeconds: number; fetchSeconds: number; waitedSeconds: number };
  /** Seconds between one page being asked for and the next one's. */
  gaps: { min: number; max: number; typical: number; list: number[] };
  /** The code's findings over all pages. */
  code: { thirdPartyScripts: Record<string, number>; flags: { url: string; flag: string }[]; externalLinks: Record<string, number> };
  summary: (SiteAnswer & { verdict: PageResult['verdict']; seconds: number }) | null;
  /** Things not checked, in plain words. */
  notChecked: string[];
}

export interface SiteProgress {
  state: 'fetching' | 'asking' | 'waiting' | 'summary' | 'done';
  url: string;
  done: number;
  max: number;
  words: string;
}

export interface SiteCheckOpts {
  start: string;
  /** Pages read at most (15 unless given; never more than 60). */
  maxPages?: number;
  get?: Fetcher;
  pace?: Pacer;
  ask: SiteAsk;
  /** The model's context, in tokens: a page is cut to fit it. */
  ctx: number;
  signal?: AbortSignal;
  onProgress?: (p: SiteProgress) => void;
  now?: () => number;
  /** Read /sitemap.xml once to find pages the links do not reach (on unless false). */
  sitemap?: boolean;
  /** One more question to the model about everything found (on unless false). */
  summary?: boolean;
}

export const MOST_PAGES = 60;
const NOT_PAGES = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|gz|css|js|mjs|json|xml|txt|mp3|mp4|mov|avi|woff2?|ttf|eot|map|docx?|xlsx?|pptx?)(\?|$)/i;
const CHARS_PER_TOKEN = 3;

/** The page text that fits: the room left in the context for the page after the question and the answer. */
export function pageRoom(ctx: number): number {
  return Math.max(1500, (Math.max(2048, ctx) - 1500) * CHARS_PER_TOKEN);
}

const key = (u: string) => u.split('#')[0].replace(/\/+$/, '');
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function verdictOf(text: string): PageResult['verdict'] {
  const m = /VERDICT\s*:?\s*\**\s*(OK|CHECK)\b/i.exec(text);
  return m ? (m[1].toUpperCase() === 'OK' ? 'ok' : 'check') : 'unclear';
}

/** The sitemap's same-site addresses (<loc> entries); a sitemap of sitemaps is not followed. */
export function sitemapUrls(xml: string, site: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const u = normalUrl(m[1].replace(/&amp;/g, '&'));
    if (u && siteOf(u) === site && !NOT_PAGES.test(u) && out.length < 500) out.push(u);
  }
  return out;
}

/**
 * Checks a website page by page. Never throws for a page that fails (it is recorded); a stop returns the report so far.
 */
export async function checkSite(o: SiteCheckOpts): Promise<SiteReport> {
  const start = normalUrl(o.start);
  if (!start) throw new Error('That is not a web address. Give the full address, starting https:// or http://.');
  const now = o.now ?? Date.now;
  const t0 = now();
  const secs = (ms: number) => round1(ms / 1000);
  const signal = o.signal ?? new AbortController().signal;
  const site = siteOf(start);
  const max = Math.max(1, Math.min(MOST_PAGES, Math.floor(o.maxPages ?? 15)));
  const pace = o.pace;
  const marks = { start: 0 };
  const base = o.get ?? fetchPublic;
  const timed: Fetcher = async (u, f) => {
    marks.start = now();
    return base(u, f);
  };
  const slowed = new Set<string>();
  let current = start;
  const say = (words: string) => o.onProgress?.({ state: 'waiting', url: current, done: pages.length, max, words });
  const fetcher = politeFetcher('page', site, 'Reading a page', { pace, get: timed, say, slowed });
  const pages: PageResult[] = [];
  const queued = new Set<string>([key(start)]);
  const queue: string[] = [start];
  const found = new Set<string>();
  const notChecked: string[] = [];
  const code: SiteReport['code'] = { thirdPartyScripts: {}, flags: [], externalLinks: {} };
  const room = pageRoom(o.ctx);

  const fetchOne = async (url: string): Promise<{ r: Fetched; waited: number; fetchMs: number; at: number } | { error: string; at: number }> => {
    const asked = now();
    marks.start = asked;
    try {
      const r = await fetcher(url, { signal, maxBytes: 4 << 20, publicOnly: true });
      const began = marks.start;
      return { r, waited: Math.max(0, began - asked), fetchMs: Math.max(0, now() - began), at: began - t0 };
    } catch (e) {
      if (signal.aborted) throw e;
      return { error: (e as Error).message.replace(/\.$/, ''), at: asked - t0 };
    }
  };

  if (o.sitemap !== false) {
    current = `${new URL(start).origin}/sitemap.xml`;
    const sm = await fetchOne(current).catch(() => null);
    if (sm && 'r' in sm && sm.r.status >= 200 && sm.r.status < 300) {
      for (const u of sitemapUrls(sm.r.body.toString('utf8'), site)) found.add(u);
    }
  }

  while (pages.length < max && !signal.aborted) {
    // Pages the links do not reach, from the sitemap, once the links are used up.
    if (!queue.length) {
      for (const l of found) {
        const k = key(l);
        if (!queued.has(k)) {
          queued.add(k);
          queue.push(l);
        }
      }
    }
    const url = queue.shift();
    if (!url) break;
    current = url;
    o.onProgress?.({ state: 'fetching', url, done: pages.length, max, words: `Reading ${url}` });
    let got;
    try {
      got = await fetchOne(url);
    } catch {
      break;
    }
    const row: PageResult = { url, finalUrl: url, status: 0, title: '', words: 0, cut: false, at: 0, waitedSeconds: 0, fetchSeconds: 0, askSeconds: 0, tokensIn: 0, tokensOut: 0, verdict: 'skipped', said: '', flags: [], html: { inlineScripts: 0, scripts: [], externalLinks: {} } };
    pages.push(row);
    if ('error' in got) {
      row.error = got.error;
      row.at = secs(got.at);
      row.said = `Not read: ${got.error}.`;
      continue;
    }
    const { r } = got;
    row.at = secs(got.at);
    row.waitedSeconds = secs(got.waited);
    row.fetchSeconds = secs(got.fetchMs);
    row.status = r.status;
    row.finalUrl = r.url;
    if (r.status < 200 || r.status >= 300) {
      row.error = `the site answered ${r.status}`;
      row.said = `Not read: ${row.error}.`;
      continue;
    }
    const type = r.type.toLowerCase();
    if (!/html|xml/.test(type) && type) {
      row.error = `not a page with words (${type.split(';')[0]})`;
      row.said = `Not read: ${row.error}.`;
      continue;
    }
    const html = r.body.toString('utf8');
    const f = inspectHtml(html, r.url);
    row.html = { inlineScripts: f.inlineScripts, scripts: f.scripts, externalLinks: f.externalLinks };
    row.flags = pageFlags(f, r.url, url);
    for (const s of f.scripts) if (s.thirdParty) code.thirdPartyScripts[s.host || 'unknown'] = (code.thirdPartyScripts[s.host || 'unknown'] ?? 0) + 1;
    for (const [h, n] of Object.entries(f.externalLinks)) code.externalLinks[h] = (code.externalLinks[h] ?? 0) + n;
    for (const flag of row.flags) code.flags.push({ url: r.url, flag });
    // Links to follow: this site only, pages only; a redirect to another site is not followed.
    if (siteOf(r.url) === site) {
      for (const l of f.links) {
        const k = key(l);
        if (siteOf(l) === site && !NOT_PAGES.test(l) && !queued.has(k)) {
          queued.add(k);
          if (queue.length + pages.length < MOST_PAGES * 4) queue.push(l);
        }
      }
    }
    const pt = pageText(html, r.url);
    row.title = pt.title;
    row.words = pt.text.split(/\s+/).filter(Boolean).length;
    if (!pt.text.trim()) {
      row.said = 'The page has no words to read.';
      row.verdict = 'unclear';
      continue;
    }
    row.cut = pt.text.length > room;
    const text = row.cut ? `${pt.text.slice(0, room)}\n[the rest of the page is cut here]` : pt.text;
    o.onProgress?.({ state: 'asking', url, done: pages.length, max, words: `Asking the model about ${url}` });
    const asked = now();
    try {
      const a = await o.ask(PAGE_SYSTEM, `${PAGE_QUESTION}\n\nPage: ${r.url}\nTitle: ${pt.title || '(none)'}\n\n${text}`, signal);
      row.askSeconds = secs(now() - asked);
      row.tokensIn = a.tokensIn;
      row.tokensOut = a.tokensOut;
      row.said = a.text.trim();
      row.verdict = verdictOf(a.text);
    } catch (e) {
      if (signal.aborted) break;
      row.askSeconds = secs(now() - asked);
      row.said = `The model did not answer: ${(e as Error).message.replace(/\.$/, '')}.`;
      row.verdict = 'unclear';
    }
  }

  const stopped = signal.aborted;
  const notVisited = [...queue, ...[...found].filter(u => !pages.some(p => key(p.url) === key(u)) && !queue.includes(u))].filter((u, i, all) => all.indexOf(u) === i).slice(0, 200);
  let summary: SiteReport['summary'] = null;
  const read = pages.filter(p => !p.error);
  if (!stopped && o.summary !== false && read.length) {
    o.onProgress?.({ state: 'summary', url: start, done: pages.length, max, words: 'Asking the model for an overall view' });
    const lines = [
      ...read.map(p => `- ${p.finalUrl}: ${p.verdict.toUpperCase()}${p.verdict === 'ok' ? '' : ` — ${p.said.replace(/\s+/g, ' ').slice(0, 220)}`}`),
      '',
      code.flags.length ? 'Found in the pages\' code:' : 'Nothing odd was found in the pages\' code.',
      ...code.flags.slice(0, 25).map(c => `- ${c.url}: ${c.flag}`),
    ].join('\n');
    const asked = now();
    try {
      const a = await o.ask(PAGE_SYSTEM, `${SUMMARY_QUESTION}\n\n${lines.slice(0, room)}`, signal);
      summary = { ...a, verdict: verdictOf(a.text), seconds: secs(now() - asked) };
    } catch {
      summary = null;
    }
  }

  const starts = pages.filter(p => p.status > 0 || p.error).map(p => p.at);
  const gapList = starts.slice(1).map((t, i) => round1(t - starts[i]));
  if (stopped) notChecked.push('The check was stopped before it finished.');
  if (queue.length || notVisited.length) notChecked.push(`${notVisited.length} more page${notVisited.length === 1 ? '' : 's'} found on the site were not read (the limit is ${max} pages).`);
  const failed = pages.filter(p => p.error);
  if (failed.length) notChecked.push(`${failed.length} page${failed.length === 1 ? '' : 's'} could not be read (${failed.slice(0, 3).map(p => `${p.url}: ${p.error}`).join('; ')}${failed.length > 3 ? '; …' : ''}).`);
  if (pages.some(p => p.cut)) notChecked.push('A long page was cut to fit the model\'s context, so its last part was not read.');
  notChecked.push('The code reads each page\'s HTML for scripts, frames, hidden links and redirects, but it does not run the scripts or read files they load, and it does not read robots.txt.');
  const tot = (f: (p: PageResult) => number) => round1(pages.reduce((n, p) => n + f(p), 0));
  return {
    site,
    start,
    startedAt: new Date(t0).toISOString(),
    seconds: secs(now() - t0),
    stopped,
    pages,
    notVisited,
    totals: {
      pagesRead: read.length,
      pagesFailed: failed.length,
      tokensIn: pages.reduce((n, p) => n + p.tokensIn, 0) + (summary?.tokensIn ?? 0),
      tokensOut: pages.reduce((n, p) => n + p.tokensOut, 0) + (summary?.tokensOut ?? 0),
      askSeconds: tot(p => p.askSeconds) + (summary?.seconds ?? 0),
      fetchSeconds: tot(p => p.fetchSeconds),
      waitedSeconds: tot(p => p.waitedSeconds),
    },
    gaps: { min: gapList.length ? Math.min(...gapList) : 0, max: gapList.length ? Math.max(...gapList) : 0, typical: median(gapList), list: gapList },
    code,
    summary,
    notChecked,
  };
}

/** The report as text a person reads (what the page shows; also what Save puts in a file). */
export function reportText(r: SiteReport): string {
  const t = r.totals;
  const n = (x: number) => x.toLocaleString('en-GB');
  const lines: string[] = [];
  lines.push(`Website check: ${r.start}`);
  lines.push(`${n(t.pagesRead)} page${t.pagesRead === 1 ? '' : 's'} read${t.pagesFailed ? `, ${n(t.pagesFailed)} that could not be read` : ''}, in ${r.seconds} s${r.stopped ? ' (stopped early)' : ''}.`);
  lines.push(`Tokens: ${n(t.tokensIn)} read by the model (a start of the question it already remembered from the page before is not counted), ${n(t.tokensOut)} written. Model time ${round1(t.askSeconds)} s; site time ${round1(t.fetchSeconds)} s; waiting at the pace ${round1(t.waitedSeconds)} s.`);
  lines.push(`Between one page and the next: ${r.gaps.min} to ${r.gaps.max} s, typically ${r.gaps.typical} s.`);
  lines.push('');
  const check = r.pages.filter(p => p.verdict === 'check');
  lines.push(r.summary ? `Overall (the model, from everything below): ${r.summary.text.trim()}` : `Overall: ${check.length ? `${check.length} page${check.length === 1 ? '' : 's'} flagged by the reader` : 'no page flagged by the reader'}; ${r.code.flags.length ? `${r.code.flags.length} thing${r.code.flags.length === 1 ? '' : 's'} flagged in the code` : 'nothing flagged in the code'}.`);
  lines.push('');
  lines.push('Found in the code (by the program, not the model):');
  if (r.code.flags.length) for (const c of r.code.flags) lines.push(`- ${c.url}: ${c.flag}`);
  else lines.push('- Nothing odd.');
  const hosts = Object.entries(r.code.thirdPartyScripts);
  if (hosts.length) lines.push(`Scripts loaded from other sites: ${hosts.map(([h, c]) => `${h} (${c})`).join(', ')}.`);
  const ext = Object.entries(r.code.externalLinks).sort((a, b) => b[1] - a[1]);
  if (ext.length) lines.push(`Other sites linked: ${ext.slice(0, 20).map(([h, c]) => `${h} (${c})`).join(', ')}${ext.length > 20 ? ', …' : ''}.`);
  lines.push('');
  lines.push('Page by page:');
  for (const p of r.pages) {
    lines.push(`${p.verdict === 'check' ? '! ' : '- '}${p.finalUrl}${p.title ? ` ("${p.title}")` : ''}`);
    lines.push(`    ${p.error ? `Not read: ${p.error}.` : `${p.verdict.toUpperCase()}; ${n(p.words)} words${p.cut ? ' (cut)' : ''}; model ${p.askSeconds} s, ${n(p.tokensIn)} tokens in, ${n(p.tokensOut)} out; asked for at ${p.at} s after waiting ${p.waitedSeconds} s`}`);
    if (!p.error && p.said) lines.push(`    ${p.said.replace(/\s*\n\s*/g, ' / ').slice(0, 400)}`);
  }
  if (r.notChecked.length) {
    lines.push('');
    lines.push('Not checked:');
    for (const x of r.notChecked) lines.push(`- ${x}`);
  }
  return lines.join('\n');
}

