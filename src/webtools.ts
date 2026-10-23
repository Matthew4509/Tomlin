// Web tools for a chat (the Web switch beside Quick and Think): a model that can call tools may search the web and read
// pages while it answers. Search goes to DuckDuckGo (no key), or to Brave Search with a key, or to a SearXNG of your
// own (Settings, Web search). A page is opened only at an address the chat already holds: one in a message the person
// wrote or a document they added, a search result, or a link on a page read in this answer. So words on a page cannot
// make the model send what is in the chat to an address it makes up. A page on this PC or the home network is never
// opened, whatever name points at it (checked when the connection is made, as the Bridge does for live sites). Plain
// parts, tested in test/webtools.test.ts; the model's side (calls and results) is in src/engine.ts streamChat.
import { createRequire } from 'node:module';
import { lookup, type LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { pdfPages } from './docs.ts';

const live = createRequire(import.meta.url)('./bridge/live.js') as { isPrivateIp: (a: string) => boolean };

/** What a tool call is, in the OpenAI form llama-server takes (`tools` on /v1/chat/completions). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const WEB_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Gives up to 8 results, each with its title, address and a short extract. Use it for anything recent, or that you are not sure of, then open the best results with open_page to read them.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, as you would type it into a search engine.' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Read a web page (or a PDF) as plain text. Only an address from a search result, a link on a page you read, or one the person wrote can be opened, written exactly as it was given. A long page comes in parts: ask for part 2, 3 and so on.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'The full address, starting https:// or http://.' }, part: { type: 'integer', description: 'Which part of a long page (1 when not given).' } }, required: ['url'] },
    },
  },
];

/** Which search engine the web tools use (Settings, Web search). */
export interface SearchSetting {
  provider: 'duckduckgo' | 'brave' | 'searxng';
  /** Brave Search's key (kept on this PC only). */
  key?: string;
  /** The address of a SearXNG of your own, e.g. http://192.168.0.5:8888. */
  url?: string;
}

/** A setting as saved or sent, with only known values (a key or address that is not one is dropped). */
export function cleanSearch(raw: unknown): SearchSetting {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const provider = o.provider === 'brave' || o.provider === 'searxng' ? o.provider : 'duckduckgo';
  const key = typeof o.key === 'string' && /^[\w-]{8,200}$/.test(o.key.trim()) ? o.key.trim() : '';
  let url = '';
  try {
    const u = typeof o.url === 'string' && o.url.trim() ? new URL(o.url.trim()) : null;
    if (u && (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) url = u.href.replace(/\/+$/, '');
  } catch {
    url = '';
  }
  return { provider, ...(key ? { key } : {}), ...(url ? { url } : {}) };
}

/** Why the chosen search engine cannot be used ('' when it can): a Brave key or a SearXNG address that is missing. */
export function searchWhy(s: SearchSetting): string {
  if (s.provider === 'brave' && !s.key) return 'Brave Search needs its key: add it in Settings, Web search (or choose DuckDuckGo there).';
  if (s.provider === 'searxng' && !s.url) return 'SearXNG needs its address: add it in Settings, Web search (or choose DuckDuckGo there).';
  return '';
}

export const PROVIDER_NAME: Record<SearchSetting['provider'], string> = { duckduckgo: 'DuckDuckGo', brave: 'Brave Search', searxng: 'SearXNG' };

// ---- Addresses ----

/** An address as the allowed list keeps it: http(s) only, no #part, no user or password; null when it is not one. */
export function normalUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** The web addresses written in a text (a trailing full stop, comma or bracket is not part of one). */
export function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    let u = m[0].replace(/[.,;:!?]+$/, '');
    // A closing bracket that has no opening one in the address belongs to the sentence.
    while (/[)\]]$/.test(u) && (u.match(/[([]/g)?.length ?? 0) < (u.match(/[)\]]/g)?.length ?? 0)) u = u.slice(0, -1);
    const n = normalUrl(u);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The same page with and without a final slash (the model often drops or adds one). */
const variants = (u: string) => [u, u.endsWith('/') ? u.slice(0, -1) : `${u}/`];

// ---- Reading a page from the public web ----

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TOMLIN/2';

export interface Fetched {
  status: number;
  type: string;
  body: Buffer;
  /** Where it ended up, after redirects. */
  url: string;
  /** The site's Retry-After, as it sent it (with a 429 or 503). */
  retryAfter?: string;
}

export type Fetcher = (url: string, o: { signal: AbortSignal; maxBytes: number; publicOnly: boolean; headers?: Record<string, string> }) => Promise<Fetched>;

/** A name looked up for a page: refused when any of its addresses is this PC or a private network (at connect time). */
function publicLookup(host: string, opts: { all?: boolean; family?: number }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err, '');
    const bad = list.find(x => live.isPrivateIp(x.address));
    if (bad) return cb(Object.assign(new Error(`${host} points at this PC or a home network address (${bad.address}), which the web tools never open`), { code: 'BLOCKED' }), '');
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** One GET, with no redirects followed: bodies cut at `maxBytes` (decompressed, so a small zip bomb cannot blow up). */
function getOnce(url: URL, o: { signal: AbortSignal; maxBytes: number; publicOnly: boolean; headers?: Record<string, string> }): Promise<Fetched & { location?: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (o.publicOnly && /^[\d.]+$|:/.test(host) && live.isPrivateIp(host)) return reject(new Error(`${url.hostname} is this PC or a home network address, which the web tools never open`));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET', hostname: host, port: url.port || undefined, path: `${url.pathname}${url.search}`, agent: false, servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      timeout: 20_000, signal: o.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en', Connection: 'close', ...(o.headers ?? {}) },
      ...(o.publicOnly ? { lookup: publicLookup as never } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        if (n <= o.maxBytes) chunks.push(c);
        n += c.length;
        if (n > o.maxBytes * 4) res.destroy();
      });
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        let body = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const cap = { maxOutputLength: o.maxBytes };
        try {
          if (enc.includes('gzip')) body = zlib.gunzipSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH, ...cap });
          else if (enc.includes('br')) body = zlib.brotliDecompressSync(body, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH, ...cap });
          else if (enc.includes('deflate')) body = zlib.inflateSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH, ...cap });
        } catch {
          // Too big once unpacked, or broken: what came is read as it is (and judged unreadable below if it is not text).
        }
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '').toLowerCase(), body: body.subarray(0, o.maxBytes), url: url.href, ...(res.headers.location ? { location: String(res.headers.location) } : {}), ...(res.headers['retry-after'] ? { retryAfter: String(res.headers['retry-after']) } : {}) });
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('timeout', () => req.destroy(new Error('it took more than 20 seconds to answer')));
    req.on('error', reject);
    req.end();
  });
}

/** A GET that follows up to 5 redirects, each address checked the same way (http and https only). */
export const fetchPublic: Fetcher = async (url, o) => {
  let at = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (at.protocol !== 'http:' && at.protocol !== 'https:') throw new Error(`it led to a ${at.protocol.replace(':', '')} address, which the web tools do not open`);
    const r = await getOnce(at, o);
    if (r.status >= 300 && r.status < 400 && r.location) {
      at = new URL(r.location, at);
      continue;
    }
    return { status: r.status, type: r.type, body: r.body, url: r.url, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) };
  }
  throw new Error('it redirected more than 5 times');
};

// ---- A page as plain text ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', deg: '°', pound: '£', euro: '€', times: '×' };

/** HTML's &name; and &#n; written as the characters they stand for. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export interface PageText {
  title: string;
  text: string;
  links: { text: string; url: string }[];
}

/** A page's HTML is read up to this many characters (the model is given a few thousand of them at most). */
const HTML_MOST = 2_000_000;

// Each step below goes through the page once, and a tag's name is read whole (<select-menu> is not a <select>). A pattern that searches for a closing tag from every opening one takes
// the square of the page's size when the tags never close (minutes for a megabyte, all on the server's one thread).

/** Comments taken out; one that never closes takes the rest of the page with it, as a browser reads it. */
function dropComments(s: string): string {
  const out: string[] = [];
  let at = 0;
  for (let i = s.indexOf('<!--'); i >= 0; i = s.indexOf('<!--', at)) {
    out.push(s.slice(at, i), ' ');
    const end = s.indexOf('-->', i + 4);
    if (end < 0) return out.join('');
    at = end + 3;
  }
  out.push(s.slice(at));
  return out.join('');
}

/**
 * Every "<" that starts no tag written as &lt; (so it is read as the character, as a browser shows "1 < 2"): one not
 * followed by a letter, "/", "!" or "?", or with another "<" (or the end) before its ">". No pattern then reads past
 * the next tag.
 */
function strayLt(s: string): string {
  const out: string[] = [];
  let at = 0;
  let gt = s.indexOf('>');
  for (let i = s.indexOf('<'); i >= 0; ) {
    if (gt >= 0 && gt < i) gt = s.indexOf('>', i + 1);
    if (gt < 0) {
      out.push(s.slice(at, i), s.slice(i).replace(/</g, '&lt;'));
      return out.join('');
    }
    const next = s.indexOf('<', i + 1);
    if ((next >= 0 && next < gt) || !/[a-zA-Z/!?]/.test(s[i + 1] ?? '')) {
      out.push(s.slice(at, i), '&lt;');
      at = i + 1;
    }
    i = next;
  }
  out.push(s.slice(at));
  return out.join('');
}

/** Where `</name>` starts at or after `from` in a lowercased page (not `</names…>`), or -1. */
function closeOf(lower: string, name: string, from: number): number {
  const tag = `</${name}`;
  for (let c = lower.indexOf(tag, from); c >= 0; c = lower.indexOf(tag, c + tag.length)) if (!/[a-z0-9-]/.test(lower[c + tag.length] ?? '')) return c;
  return -1;
}

/**
 * The page without each <name …>…</name> block. One that never closes takes the rest of the page with it when
 * `rest` (a script or a style, as a browser reads it); otherwise only its opening tag goes and its words stay.
 */
function dropBlocks(s: string, names: string[], rest: boolean): string {
  const lower = s.toLowerCase();
  const open = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'g');
  const unclosed = new Set<string>();
  const out: string[] = [];
  let at = 0;
  for (let m = open.exec(lower); m; m = open.exec(lower)) {
    out.push(s.slice(at, m.index), ' ');
    const end = unclosed.has(m[1]) ? -1 : closeOf(lower, m[1], open.lastIndex);
    if (end < 0) {
      if (rest) return out.join('');
      // Searched once: no later block of that name closes either.
      unclosed.add(m[1]);
      const gt = lower.indexOf('>', m.index);
      at = gt < 0 ? s.length : gt + 1;
    } else {
      const gt = lower.indexOf('>', end);
      at = gt < 0 ? s.length : gt + 1;
    }
    open.lastIndex = at;
  }
  out.push(s.slice(at));
  return out.join('');
}

/** What is inside the first <name …>…</name> of these names that closes (the first one only), or null. */
function blockIn(s: string, names: string[]): string | null {
  const lower = s.toLowerCase();
  const m = new RegExp(`<(${names.join('|')})(?=[\\s/>])`).exec(lower);
  if (!m) return null;
  const gt = lower.indexOf('>', m.index);
  const end = gt < 0 ? -1 : closeOf(lower, m[1], gt);
  return end < 0 ? null : s.slice(gt + 1, end);
}

/**
 * A web page's words, the way a person reads it: scripts, styles, menus and footers left out, the main part (<main> or
 * <article>) when it has one, headings and list items on lines of their own; its links (http and https only, at most 40).
 */
export function pageText(html: string, base: string): PageText {
  if (html.length > HTML_MOST) html = html.slice(0, HTML_MOST);
  const title = decodeEntities(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let s = dropBlocks(strayLt(dropComments(html)), ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'title', 'canvas', 'select', 'button'], true);
  const main = blockIn(s, ['main', 'article']);
  if (main !== null && main.replace(/<[^>]+>/g, '').trim().length > 400) s = main;
  else s = dropBlocks(s, ['nav', 'footer', 'aside', 'header'], false);
  const links: PageText['links'] = [];
  const lower = s.toLowerCase();
  const open = /<a(?=[\s/>])/g;
  for (let m = open.exec(lower); m && links.length < 40; m = open.exec(lower)) {
    const gt = s.indexOf('>', m.index);
    const close = gt < 0 ? -1 : closeOf(lower, 'a', gt);
    // No </a> after this one: none after any later one either.
    if (close < 0) break;
    open.lastIndex = close;
    const h = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(s.slice(m.index, gt + 1));
    if (!h) continue;
    const href = decodeEntities(h[2] ?? h[3] ?? h[4] ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    let abs: string | null = null;
    try {
      abs = normalUrl(new URL(href, base).href);
    } catch {
      abs = null;
    }
    const text = decodeEntities(s.slice(gt + 1, Math.min(close, gt + 2000)).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (abs && text && !links.some(l => l.url === abs)) links.push({ text, url: abs });
  }
  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|tr|table|ul|ol|li|blockquote|pre|dd|dt|figure|figcaption)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(s)
    .split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, all) => l && !(l === all[i - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, links };
}

// ---- Search ----

export interface Result {
  title: string;
  url: string;
  snippet: string;
}

/** DuckDuckGo's plain results page (html.duckduckgo.com), ads left out; each address taken out of its uddg= redirect. */
export function parseDuckDuckGo(html: string): Result[] {
  const out: Result[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    else if (href.startsWith('//')) href = `https:${href}`;
    const url = normalUrl(href);
    if (!url || /^https?:\/\/(?:[^/]+\.)?duckduckgo\.com\//i.test(url)) continue;
    const snippet = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(b)?.[1] ?? '';
    const clean = (x: string) => decodeEntities(x.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!out.some(r => r.url === url)) out.push({ title: clean(a[2]).slice(0, 200), url, snippet: clean(snippet).slice(0, 400) });
    if (out.length >= 8) break;
  }
  return out;
}

/** Searches with the chosen engine. Throws, in plain words, when it gave no answer it could read. */
export async function searchWeb(query: string, s: SearchSetting, signal: AbortSignal, get: Fetcher = fetchPublic): Promise<Result[]> {
  const q = encodeURIComponent(query);
  const why = searchWhy(s);
  if (why) throw new Error(why);
  if (s.provider === 'brave') {
    const r = await get(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=8`, { signal, maxBytes: 2 << 20, publicOnly: true, headers: { Accept: 'application/json', 'X-Subscription-Token': s.key! } });
    if (r.status === 401 || r.status === 403) throw new Error('Brave Search refused the key: check it in Settings, Web search');
    if (r.status !== 200) throw new Error(`Brave Search answered ${r.status}`);
    const j = JSON.parse(r.body.toString('utf8')) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (j.web?.results ?? []).map(x => ({ title: String(x.title ?? '').slice(0, 200), url: normalUrl(String(x.url ?? '')) ?? '', snippet: decodeEntities(String(x.description ?? '').replace(/<[^>]+>/g, '')).slice(0, 400) })).filter(x => x.url).slice(0, 8);
  }
  if (s.provider === 'searxng') {
    // Your own SearXNG may well be on your home network: it is the one place the web tools reach there.
    const r = await get(`${s.url}/search?q=${q}&format=json`, { signal, maxBytes: 2 << 20, publicOnly: false, headers: { Accept: 'application/json' } });
    if (r.status === 403) throw new Error('SearXNG refused to answer in JSON: turn on the json format in its settings.yml (search, formats)');
    if (r.status !== 200) throw new Error(`SearXNG answered ${r.status}`);
    const j = JSON.parse(r.body.toString('utf8')) as { results?: { title?: string; url?: string; content?: string }[] };
    return (j.results ?? []).map(x => ({ title: String(x.title ?? '').slice(0, 200), url: normalUrl(String(x.url ?? '')) ?? '', snippet: String(x.content ?? '').slice(0, 400) })).filter(x => x.url).slice(0, 8);
  }
  const r = await get(`https://html.duckduckgo.com/html/?q=${q}`, { signal, maxBytes: 2 << 20, publicOnly: true });
  const html = r.body.toString('utf8');
  if (r.status !== 200 || /anomaly-modal|captcha/i.test(html)) throw new Error('DuckDuckGo did not give results just now (it sometimes holds back searches that come quickly one after another). Try again in a minute, or choose another search engine in Settings, Web search');
  return parseDuckDuckGo(html);
}

// ---- Going at a person's pace ----

/**
 * How hard this PC may ask the web. A site's firewall can ban an address for a burst of requests, and every PC at home
 * shares one address, so the tools go about as fast as a person clicking through: a page on a site 5 s after the last
 * one there (plus up to 2 s at random), a search 10 s after the last search, other sites without a wait. A site that
 * says "too many requests" or "busy" (429, 503) is waited for once, as long as it asks up to a minute (10 s when it does
 * not say). An answer opens at most 3 pages in one go and 8 in all.
 */
export const PACE = { page: 5000, jitter: 2000, search: 10_000, waitMost: 60_000, waitDefault: 10_000, pagesPerRound: 3, pagesPerAnswer: 8 };

/** When each site (and the search engine) may next be asked, for every chat, job step and linked PC's ask made here. */
export class Pacer {
  private readonly next = new Map<string, number>();
  readonly gaps: { page: number; jitter: number; search: number };
  private readonly random: () => number;

  constructor(gaps: { page: number; jitter: number; search: number } = PACE, random = Math.random) {
    this.gaps = gaps;
    this.random = random;
  }

  /** Books the next turn at `key` and returns the ms to wait before it (0: now); the one after waits `gap` more. */
  book(key: string, gap: number): number {
    const now = Date.now();
    if (this.next.size > 500) for (const [k, t] of this.next) if (t < now) this.next.delete(k);
    const at = Math.max(now, this.next.get(key) ?? 0);
    this.next.set(key, at + gap);
    return at - now;
  }

  /** Nothing more is asked of `key` for `ms` from now (after a slow answer, or when a site asked for a wait). */
  hold(key: string, ms: number): void {
    const t = Date.now() + ms;
    if ((this.next.get(key) ?? 0) < t) this.next.set(key, t);
  }

  /** The wait after a page on a site: 5 s and up to 2 s more, so the reads do not tick like a clock. */
  pageGap(): number {
    return this.gaps.page + Math.round(this.random() * this.gaps.jitter);
  }
}

/** This PC's pacer: one for the whole server, so two chats reading the same site wait for each other. */
export const POLITE = new Pacer();

/** The site an address belongs to, for pacing: its name, without a leading www. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The ms a Retry-After asks for (seconds, or a date); null when there is none or it cannot be read. */
export function retryAfterMs(v: string | undefined, now = Date.now()): number | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/** Waits `ms`; stopping the answer stops the wait. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('stopped'));
    const stop = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('stopped'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

// ---- One answer's use of the tools ----

/** Rounds of tool calls in one answer before it is asked for with the tools off (a search, two pages, one more). */
export const WEB_ROUNDS = 4;

/** What a tool call is doing, for the answer's place while it runs: "Searching the web: “cuda 13”…", "Reading example.com…". */
export function callWords(name: string, args: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(args) as Record<string, unknown>;
  } catch {
    // the words below do without it
  }
  if (name === 'web_search') return `Searching the web${typeof a.query === 'string' && a.query ? `: “${a.query.slice(0, 120)}”` : ''}…`;
  if (name === 'open_page' && typeof a.url === 'string') {
    try {
      return `Reading ${new URL(a.url).hostname}${Number(a.part) > 1 ? ` (part ${Number(a.part)})` : ''}…`;
    } catch {
      return 'Reading a page…';
    }
  }
  return 'Looking something up…';
}

/**
 * Web on, for an answer a linked PC writes: the addresses the person gave (their messages and the documents' parts read
 * now) and the room in the context, for the web tools that run there.
 */
export interface WebAsk {
  seed: string[];
  perCall: number;
  total: number;
}

/** A WebAsk as a linked PC sent it, each field checked (sizes kept within bounds); null when it is not one. */
export function cleanWebAsk(raw: unknown): WebAsk | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const seed = (Array.isArray(o.seed) ? o.seed : []).filter((x): x is string => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 20_000));
  const num = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.max(lo, Math.min(hi, Math.floor(Number(v)))) : d);
  return { seed, perCall: num(o.perCall, 1500, 12_000, 4000), total: num(o.total, 2000, 60_000, 12_000) };
}

/** One tool call, as the chat shows and keeps it under the answer. */
export interface ToolUse {
  name: 'web_search' | 'open_page';
  /** The query, or the address. */
  input: string;
  ok: boolean;
  /** What came of it, in a few words: "8 results", "Example Domain, 1,234 words", or why not. */
  said: string;
}

/** What was used, in a line: "searched “cuda 13” (8 results); read Releases, 802 words". */
export function webWords(uses: ToolUse[]): string {
  return uses.map(u => (u.name === 'web_search' ? `searched “${u.input}” (${u.said})` : u.ok ? `read ${u.said}` : `did not read ${u.input} (${u.said})`)).join('; ').slice(0, 600);
}

/** A use as saved in a chat line or sent from a linked PC, each field checked; null when it is not one. */
export function cleanUse(x: unknown): ToolUse | null {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  if ((o.name !== 'web_search' && o.name !== 'open_page') || typeof o.input !== 'string' || typeof o.said !== 'string') return null;
  return { name: o.name, input: o.input.slice(0, 300), ok: o.ok === true, said: o.said.slice(0, 200) };
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export interface WebTurnOpts {
  search: SearchSetting;
  /** Characters one result may give the model (a long page is cut into parts this size). */
  perCall: number;
  /** Characters every result of this answer may give together (the model's context is limited). */
  total: number;
  get?: Fetcher;
  /** This PC's pacer unless given (tests give one with no waits). */
  pace?: Pacer;
  /** A line for the answer's place while the tools wait ("Waiting 6 s before the next page on github.com…"). */
  onStatus?: (words: string) => void;
}

/**
 * One answer's web tools: the addresses it may open (seeded from the person's messages and documents, grown by search
 * results and the links on pages read), the pages already read (for their next parts), and what was used.
 */
export class WebTurn {
  /** Each address that may be opened (with and without a final slash), and the address as it was given. */
  readonly allowed = new Map<string, string>();
  readonly uses: ToolUse[] = [];
  private readonly pages = new Map<string, PageText & { url: string }>();
  private given = 0;
  /** Pages fetched in this answer, and in its current round of calls (parts of a page already read are not counted). */
  private pagesRead = 0;
  private roundPages = 0;
  private round = 0;
  /** Sites (and 'search') that asked to slow down and still said no after the wait: not asked again in this answer. */
  private readonly slowed = new Set<string>();
  private readonly o: WebTurnOpts;

  constructor(seed: string[], o: WebTurnOpts) {
    this.o = o;
    for (const t of seed) for (const u of urlsIn(t)) this.allow(u);
  }

  private allow(u: string): void {
    const n = normalUrl(u);
    if (n) for (const v of variants(n)) if (!this.allowed.has(v)) this.allowed.set(v, n);
  }

  private use(u: ToolUse): void {
    this.uses.push(u);
  }

  /** What a tool gives the model, cut to the room left; with nothing left, says so (the model then answers). */
  private give(text: string): string {
    const room = Math.min(this.o.perCall, this.o.total - this.given);
    if (room < 300) return 'There is no room left in this conversation for more from the web. Answer now with what you have found, and say what you could not check.';
    const out = text.length > room ? `${text.slice(0, room)}\n[cut here: no more room]` : text;
    this.given += out.length;
    return out;
  }

  /**
   * Runs a tool by name with the arguments the model wrote (JSON); a fault is told to the model, not thrown. `round`:
   * which round of calls this is (0 the first), for the pages-in-one-go limit.
   */
  async run(name: string, rawArgs: string, signal: AbortSignal, round = 0): Promise<string> {
    if (round !== this.round) {
      this.round = round;
      this.roundPages = 0;
    }
    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return 'Those arguments were not valid JSON. Call the tool again with JSON such as {"query": "..."} or {"url": "https://..."}.';
    }
    if (name === 'web_search') return this.search(String(args.query ?? '').trim(), signal);
    if (name === 'open_page') return this.open(String(args.url ?? '').trim(), Math.max(1, Math.floor(Number(args.part) || 1)), signal);
    return `There is no tool called ${name}. The tools are web_search and open_page.`;
  }

  private async search(query: string, signal: AbortSignal): Promise<string> {
    if (!query) return 'Say what to search for: {"query": "..."}.';
    const q = query.slice(0, 300);
    if (this.slowed.has('search')) {
      this.use({ name: 'web_search', input: q, ok: false, said: 'not searched: the search engine asked to slow down earlier in this answer' });
      return `Not searched: ${PROVIDER_NAME[this.o.search.provider]} asked to slow down earlier in this answer, so no more searches are made until the next one. Answer with what you have, and say what you could not check.`;
    }
    try {
      const found = await searchWeb(q, this.o.search, signal, this.polite('search', PROVIDER_NAME[this.o.search.provider], callWords('web_search', JSON.stringify({ query: q }))));
      for (const r of found) this.allow(r.url);
      this.use({ name: 'web_search', input: q, ok: true, said: `${found.length} result${found.length === 1 ? '' : 's'}` });
      if (!found.length) return `No results for "${q}". Try other words.`;
      return this.give([`Results for "${q}" (${PROVIDER_NAME[this.o.search.provider]}):`, ...found.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`), 'Open a page with open_page, its address written exactly as above.'].join('\n'));
    } catch (e) {
      if (signal.aborted) throw e;
      const why = (e as Error).message.replace(/\.$/, '');
      this.use({ name: 'web_search', input: q, ok: false, said: why.slice(0, 200) });
      return `The search did not work: ${why}.`;
    }
  }

  private async open(raw: string, part: number, signal: AbortSignal): Promise<string> {
    const asked = normalUrl(raw);
    if (!asked) {
      this.use({ name: 'open_page', input: raw.slice(0, 300), ok: false, said: 'not a web address' });
      return 'That is not a web address. Give the full address, starting https:// or http://.';
    }
    // Opened as it was given (the model may add or drop a final slash, which can be another page).
    const url = this.allowed.get(asked);
    if (!url) {
      this.use({ name: 'open_page', input: asked, ok: false, said: 'not opened: not an address given in this chat' });
      return 'Not opened: that address was not given in this chat. A page can be opened only at an address from a search result, a link on a page you read, or one the person wrote. Search for it first with web_search.';
    }
    let page = this.pages.get(url);
    if (!page) {
      const site = siteOf(url);
      const no = this.slowed.has(site)
        ? ['the site asked to slow down earlier in this answer', `Not opened: ${site} asked to slow down earlier in this answer, so it is not asked again until the next one. Use what you have, or a page on another site.`]
        : this.pagesRead >= PACE.pagesPerAnswer
          ? [`${PACE.pagesPerAnswer} pages read in this answer already`, `Not opened: ${PACE.pagesPerAnswer} pages have been read for this answer, the most one answer reads. Answer now with what you have, and say what you could not check.`]
          : this.roundPages >= PACE.pagesPerRound
            ? [`${PACE.pagesPerRound} pages asked for in one go already`, `Not opened yet: ${PACE.pagesPerRound} pages are being read in this go, the most at once. Read those first; if you still need this one, ask for it again.`]
            : null;
      if (no) {
        this.use({ name: 'open_page', input: url, ok: false, said: `not opened: ${no[0]}` });
        return no[1];
      }
      this.pagesRead++;
      this.roundPages++;
      try {
        page = await this.read(url, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        const why = (e as Error).message.replace(/\.$/, '');
        this.use({ name: 'open_page', input: url, ok: false, said: why.slice(0, 200) });
        return `The page could not be read: ${why}.`;
      }
      this.pages.set(url, page);
      for (const l of page.links) this.allow(l.url);
    }
    const size = Math.max(1000, this.o.perCall - 1200);
    const parts = Math.max(1, Math.ceil(page.text.length / size));
    const n = Math.min(part, parts);
    const text = page.text.slice((n - 1) * size, n * size);
    this.use({ name: 'open_page', input: url, ok: true, said: `${page.title || new URL(page.url).hostname}${parts > 1 ? `, part ${n} of ${parts}` : ''}, ${words(text).toLocaleString('en-GB')} words` });
    const links = n === parts && page.links.length ? ['', 'Links on this page (open_page can open these):', ...page.links.slice(0, 25).map(l => `- ${l.text}: ${l.url}`)] : [];
    return this.give([`Page: ${page.title || '(no title)'}`, `Address: ${page.url}`, parts > 1 ? `Part ${n} of ${parts}${n < parts ? `: ask open_page with part ${n + 1} for the next part` : ''}.` : '', '', text || '(The page has no text to read: it may be built by scripts, or be a picture.)', ...links].filter((l, i) => l !== '' || i > 2).join('\n'));
  }

  /**
   * A fetch at a person's pace (PACE): waits its turn at the site (or the search engine), saying so while it waits, and
   * waits once more when the site answers 429 or 503; a second no, or a wait of over a minute, is thrown as a reason
   * (the site is then left alone for the rest of the answer). `name`: the site as said; `words`: the line put back
   * after a wait.
   */
  private polite(kind: 'page' | 'search', name: string, words: string): Fetcher {
    const pace = this.o.pace ?? POLITE;
    const get = this.o.get ?? fetchPublic;
    const say = (w: string) => this.o.onStatus?.(w);
    return async (url, o) => {
      const key = kind === 'search' ? 'search' : siteOf(url);
      const turn = async () => {
        const gap = kind === 'search' ? pace.gaps.search : pace.pageGap();
        const wait = pace.book(key, gap);
        if (wait >= 1000) say(`Waiting ${Math.ceil(wait / 1000)} s before the next ${kind === 'search' ? 'search' : `page on ${name}`}…`);
        if (wait > 0) await pause(wait, o.signal);
        if (wait >= 1000) say(words);
        try {
          return await get(url, o);
        } finally {
          // The gap counts from the end of a slow answer too.
          pace.hold(key, gap);
        }
      };
      const r = await turn();
      if (r.status !== 429 && r.status !== 503) return r;
      const what = r.status === 429 ? `asked to slow down (${r.status})` : `said it is busy (${r.status})`;
      const asked = retryAfterMs(r.retryAfter);
      if (asked === null || asked <= PACE.waitMost) {
        const ms = asked ?? PACE.waitDefault;
        pace.hold(key, ms);
        say(`${name} ${what}: waiting ${Math.max(1, Math.ceil(ms / 1000))} s…`);
        await pause(ms, o.signal);
        say(words);
        const again = await turn();
        if (again.status !== 429 && again.status !== 503) return again;
      }
      this.slowed.add(key);
      throw new Error(`${name} ${what}${asked !== null && asked > PACE.waitMost ? ' and asked for a wait of over a minute' : ' and still said no after a wait'}, so it is not asked again in this answer`);
    };
  }

  /** A page fetched and turned into text: HTML, plain text, JSON, XML or a PDF (its text; a scanned one has none). */
  private async read(url: string, signal: AbortSignal): Promise<PageText & { url: string }> {
    const r = await this.polite('page', siteOf(url), callWords('open_page', JSON.stringify({ url })))(url, { signal, maxBytes: 12 << 20, publicOnly: true });
    if (r.status === 404 || r.status === 410) throw new Error(`there is no page at that address (${r.status})`);
    if (r.status === 401 || r.status === 403) throw new Error(`the site refused to show it (${r.status}): it may need a sign-in, or not let programs read it`);
    if (r.status < 200 || r.status >= 300) throw new Error(`the site answered ${r.status}`);
    if (r.type.includes('application/pdf') || r.body.subarray(0, 5).toString('latin1') === '%PDF-') {
      const pages = await pdfPages(new Uint8Array(r.body));
      const text = pages.map((p, i) => (p.trim() ? `[Page ${i + 1}]\n${p.trim()}` : '')).filter(Boolean).join('\n\n');
      const file = new URL(r.url).pathname.split('/').pop() || 'PDF';
      let title = file;
      try {
        title = decodeURIComponent(file);
      } catch {
        // A name with a broken %-escape is shown as it is.
      }
      return { title, text, links: [], url: r.url };
    }
    const body = r.body.toString('utf8');
    if (/^text\/plain|json|xml|csv|markdown/.test(r.type) && !/html/.test(r.type)) return { title: '', text: body.trim(), links: [], url: r.url };
    if (r.type && !/html/.test(r.type)) throw new Error(`it is not a page with words to read (${r.type.split(';')[0]})`);
    return { ...pageText(body, r.url), url: r.url };
  }
}
