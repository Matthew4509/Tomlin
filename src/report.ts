// "Report a problem": the text a person can send to the project's GitHub issues when something went wrong (a crash, a
// model that would not load, a tool that did not work). TOMLIN never sends it: the page shows the whole text first,
// the person can edit it, and the button only opens the new-issue page of the project in their browser (they sign in
// and press Submit there) or copies the text. Nothing here reads a chat's words, a prompt or a file's text; the log
// it quotes holds none (src/log.ts), and every line is scrubbed again here: user and PC names, paths under a user
// folder, addresses, keys, PINs and the query part of a link. Tested in test/report.test.ts.

/** The longest new-issue link that opens everywhere (browsers and GitHub take about 8,000 characters). */
export const MAX_URL = 7000;
/** The most log lines quoted. */
export const MAX_LOG_LINES = 60;
/** The most characters of the person's own note. */
export const MAX_NOTE = 2000;

const GENERIC = new Set(['user', 'users', 'admin', 'administrator', 'owner', 'guest', 'name', 'this', 'home']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with what points at a person or a PC taken out. `names`: words to hide wherever they stand (the Windows
 * user name, this PC's name, the names given to linked PCs); words under 3 letters are left, as they would damage
 * ordinary text.
 */
export function scrub(text: string, names: string[] = []): string {
  let t = String(text);
  // An address first: a name inside it would otherwise leave the rest of it behind.
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  // Names the person or the PC goes by (first, so the placeholders below are never taken for names; a name that is an
  // ordinary word, such as the account called User, would damage the text and is left, as the path rule hides it).
  for (const n of names) {
    const w = String(n ?? '').trim();
    if (w.length < 3 || GENERIC.has(w.toLowerCase())) continue;
    t = t.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(w)}(?![A-Za-z0-9])`, 'gi'), '<name>');
  }
  // Everything after the user folder's name in a Windows path keeps its shape; the name goes.
  // (a user folder's name can hold a space: taken whole when a slash follows, else up to the next space)
  t = t.replace(/([A-Za-z]:[\\/]+Users[\\/]+)(?:[^\\/"'<>|:*?\r\n]+(?=[\\/])|[^\\/\s"'<>|:*?]+)/gi, '$1<user>');
  // A link keeps its host and path; what follows ? or # can carry anything.
  t = t.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1');
  t = t.replace(/(\/(?:home|Users)\/)[^/\s"'<>|:*?]+/g, '$1<user>');
  // Keys and tokens by their shape.
  t = t.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<secret>');
  t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '<secret>');
  t = t.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <secret>');
  t = t.replace(/\b(pin|password|passcode|token|secret|key)(\s*[=:]\s*)("?)[^\s",;]{3,}\3/gi, '$1$2<secret>');
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/g, '<hash>');
  t = t.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<secret>');
  // Contact and network details.
  t = t.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '<mac>');
  t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ip => (ip.startsWith('127.') || ip === '0.0.0.0' ? ip : '<ip>'));
  return t;
}

/** What the page knows about this PC and the fault, all of it plain facts (no chat text). */
export interface ReportFacts {
  version: string;
  build?: string;
  os?: string;
  ram?: number | null;
  cards?: { name?: string; total?: number | null }[];
  driver?: string | null;
  /** The chat or picture runner builds and whether each is installed, as said on the Runners page. */
  runners?: string[];
  model?: string;
  /** What TOMLIN said went wrong, in its own words. */
  fault?: string;
  /** What the person typed under "What happened". */
  note?: string;
  log?: string[];
}

const GB = 2 ** 30;
const gb = (n: number | null | undefined) => (n ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB` : 'unknown');

export interface Report {
  title: string;
  body: string;
}

/** The report as text, already scrubbed. */
export function buildReport(f: ReportFacts, names: string[] = []): Report {
  const s = (x: string) => scrub(x, names);
  const note = s(String(f.note ?? '').slice(0, MAX_NOTE)).trim();
  const fault = s(String(f.fault ?? '')).trim();
  const lines = (f.log ?? []).slice(-MAX_LOG_LINES).map(l => s(l.slice(0, 600)));
  const first = (note || fault || 'Something went wrong').split(/\r?\n/)[0].slice(0, 90);
  const out: string[] = [];
  out.push('### What happened', '', note || '(not described)', '');
  if (fault) out.push('### What TOMLIN said', '', fault, '');
  out.push('### This PC', '');
  out.push(`- TOMLIN ${f.version}${f.build ? ` (build ${f.build})` : ''}`);
  if (f.os) out.push(`- ${s(f.os)}`);
  out.push(`- Memory: ${gb(f.ram)}`);
  const cards = (f.cards ?? []).filter(c => c.name);
  out.push(`- Graphics: ${cards.length ? cards.map(c => `${s(c.name ?? '')} (${gb(c.total)})`).join(', ') : 'none found'}`);
  if (f.driver) out.push(`- NVIDIA driver: ${s(f.driver)}`);
  for (const r of f.runners ?? []) out.push(`- Runner: ${s(r)}`);
  if (f.model) out.push(`- Model: ${s(f.model)}`);
  out.push('');
  if (lines.length) out.push('### Log (last lines, names and addresses removed)', '', '```', ...lines, '```', '');
  out.push('_Sent from TOMLIN\'s "Report a problem". The person read this text before sending it._');
  return { title: `Report: ${first}`, body: out.join('\n') };
}

export interface IssueLink {
  url: string;
  /** The text went past what a link carries, so the page says to paste the copied text in. */
  cut: boolean;
}

/** The project's new-issue page with the report in it, as long as a link can be; `cut` when the body was shortened. */
export function issueLink(repo: string, r: Report): IssueLink {
  const base = `https://github.com/${repo}/issues/new`;
  const make = (body: string) => `${base}?title=${encodeURIComponent(r.title)}&body=${encodeURIComponent(body)}`;
  let url = make(r.body);
  if (url.length <= MAX_URL) return { url, cut: false };
  const note = '\n\n_(Shortened: paste the rest of the copied report here.)_';
  let lo = 0;
  let hi = r.body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(r.body.slice(0, mid) + note).length <= MAX_URL) lo = mid;
    else hi = mid - 1;
  }
  url = make(r.body.slice(0, lo) + note);
  return { url, cut: true };
}
