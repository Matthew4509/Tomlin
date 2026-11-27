// A finished agent run told outside TOMLIN (N3 of the 27 Nov agents plan): one line to his phone through ntfy (a server
// he names: his own, or ntfy.sh), and a silent Windows notification. TOMLIN's code sends, never the model: there is no
// send tool for an agent (src/agenttools.ts), and a recipe asking to send is refused (src/recipe.ts NEVER). What is
// sent is the run's one-line summary with the agent's and the job's names, at most 200 characters, never the report,
// a page, a file or memory; a line that looks like a key is replaced. At most 30 sends an hour in all, one retry each.
// The topic is a secret: it is kept in data/agent-secrets.json (never in a restore point sent to another PC, never in
// a log), shown masked, and sent in the body, never in an address. Plain parts tested in test/agentnotify.test.ts.
import { join } from 'node:path';
import { readData, updateData } from './atomic.ts';
import { looksSecret } from './rules.ts';
import { saysNothingNew } from './agentrun.ts';

export interface PhoneSettings {
  on: boolean;
  /** The ntfy server, "https://ntfy.sh" or his own ("http://192.168.1.20:8080"). */
  server: string;
  /** "Only when something changed": a run whose summary is "nothing new" is not sent. */
  onlyChanged: boolean;
}

export const PHONE_DEFAULTS: PhoneSettings = { on: false, server: '', onlyChanged: true };
export const LINE_MOST = 200;
export const SENDS_HOUR = 30;

/** The server address as typed, checked: https anywhere, or http on his own network; '' when it is not one. */
export function cleanServer(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!t) return '';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    if (u.username || u.password || u.search || u.hash) return '';
    if (u.protocol === 'https:') return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    // Plain http only to a server on this PC or the home network (a self-hosted ntfy), never across the internet.
    const h = u.hostname.replace(/^\[|\]$/g, '');
    const home = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i.test(h) || /\.(lan|local|home|internal|home\.arpa)$/i.test(h) || !h.includes('.');
    if (u.protocol === 'http:' && home) return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    return '';
  } catch {
    return '';
  }
}

/** An ntfy topic: letters, digits, _ and -, 1 to 64 (ntfy's own rule). */
export const cleanTopic = (raw: unknown): string => (typeof raw === 'string' && /^[\w-]{1,64}$/.test(raw.trim()) ? raw.trim() : '');

export const maskTopic = (t: string): string => (t ? `${t.slice(0, 2)}${'•'.repeat(Math.max(3, t.length - 4))}${t.slice(-2)}` : '');

export function cleanPhone(raw: unknown): PhoneSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { on: o.on === true, server: cleanServer(o.server), onlyChanged: o.onlyChanged !== false };
}

/**
 * A line with every path on this PC taken out ("C:\Users\…", "\\server\share\…", "/home/…"): a failed run's raw error
 * can carry one, with the PC's user name in it, and the line leaves this PC.
 */
export const noPaths = (s: string): string =>
  s.replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home)\/)[^"'\n]*\1/g, 'a file on this PC').replace(/(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w.])\/(?:Users|home)\/)\S*/g, 'a file on this PC');

/**
 * The one line sent for a run, or null when nothing is sent (nothing new, with "Only when something changed"; a run
 * he stopped). A summary that looks like it holds a key is not sent: a plain line says to open TOMLIN instead.
 */
export function phoneLine(o: { agentName: string; job: string; state: string; line: string }, onlyChanged: boolean): string | null {
  if (o.state === 'stopped') return null;
  const summary = noPaths(o.line.replace(/^Summary:\s*/i, '')).replace(/\s+/g, ' ').trim();
  if (onlyChanged && o.state === 'done' && saysNothingNew(summary)) return null;
  const first = o.agentName.split(/\s+/)[0] || o.agentName;
  const lead = `${first}'s ${/^[A-Z][a-z]/.test(o.job) ? o.job[0].toLowerCase() + o.job.slice(1) : o.job}`;
  const plain = `${lead} finished. Open TOMLIN to read it.`;
  if (looksSecret(summary) || looksSecret(o.job)) return plain.slice(0, LINE_MOST);
  const said = o.state === 'failed' ? summary.replace(/^Failed:\s*/i, 'did not finish: ') : o.state === 'skipped' ? summary : summary;
  const line = `${lead}: ${said || 'finished'}`;
  return line.length > LINE_MOST ? `${line.slice(0, LINE_MOST - 1).trimEnd()}…` : line;
}

/** The send cap: whether one more may go now, given when the last ones went. */
export function roomToSend(sent: number[], now: number, most = SENDS_HOUR): boolean {
  return sent.filter(t => now - t < 3600_000).length < most;
}

export type Post = (url: string, body: string, signal: AbortSignal) => Promise<{ status: number }>;

const realPost: Post = async (url, body, signal) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal, redirect: 'error' });
  await r.arrayBuffer().catch(() => undefined);
  return { status: r.status };
};

/** One send: the topic in the JSON body (ntfy's publish-as-JSON, at the server's root), one retry. Never throws. */
export async function sendLine(server: string, topic: string, line: string, post: Post = realPost): Promise<{ ok: boolean; why?: string }> {
  const body = JSON.stringify({ topic, title: 'TOMLIN', message: line, tags: ['robot'] });
  let why = '';
  for (let i = 0; i < 2; i++) {
    try {
      const r = await post(`${server}/`, body, AbortSignal.timeout(15_000));
      if (r.status >= 200 && r.status < 300) return { ok: true };
      why = `the server answered ${r.status}`;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) {
      // The topic is never in the words: only what went wrong.
      why = ((e as Error).message || 'no answer').replace(/\.$/, '').slice(0, 120);
    }
  }
  return { ok: false, why };
}

// ---- Kept on disk: the settings, the secrets (apart), and the sends of the last hour ----

export interface Secrets {
  topic?: string;
  /** N6: the secret calendar addresses. */
  calendars?: string[];
}

let dir = '';
export const setDir = (dataDir: string): void => { dir = dataDir; };
export const SECRETS_FILE = 'agent-secrets.json';
const phoneFile = () => join(dir, 'agent-phone.json');
const secretsFile = () => join(dir, SECRETS_FILE);

export const readPhone = async (): Promise<PhoneSettings> => cleanPhone(dir ? await readData(phoneFile(), {}).catch(() => ({})) : {});
/**
 * A change read, made and written in one turn of the file, so two saves at once both stay. A file another program holds
 * fails the save (nothing is written over it); a damaged one is set aside first (src/atomic.ts).
 */
export async function savePhone(p: Partial<PhoneSettings>): Promise<PhoneSettings> {
  return updateData<PhoneSettings>(phoneFile(), PHONE_DEFAULTS, now => cleanPhone({ ...cleanPhone(now), ...p }));
}

function cleanSecrets(raw: unknown): Secrets {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const topic = cleanTopic(o.topic);
  const calendars = Array.isArray(o.calendars) ? o.calendars.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
  return { ...(topic ? { topic } : {}), ...(calendars.length ? { calendars } : {}) };
}
export async function readSecrets(): Promise<Secrets> {
  return cleanSecrets(dir ? await readData<unknown>(secretsFile(), {}).catch(() => ({})) : {});
}
/**
 * Saves a change to the secrets: what to change, or a function given the secrets as they are now that gives the change
 * (undefined for none). Both run in the file's turn, so an add made from what is there is never lost to another add at
 * the same moment. A file that cannot be read (another program holds it) is never written over: the save fails, and
 * every calendar address stays.
 */
export async function saveSecrets(change: Secrets | ((now: Secrets) => Secrets | undefined)): Promise<Secrets> {
  let out: Secrets = {};
  await updateData<unknown>(secretsFile(), {}, raw => {
    const now = cleanSecrets(raw);
    out = now;
    const c = typeof change === 'function' ? change(now) : change;
    if (!c) return undefined;
    const next = { ...now, ...c };
    if (!next.topic) delete next.topic;
    if (!next.calendars?.length) delete next.calendars;
    out = next;
    return next;
  }, 0);
  return out;
}

const sent: number[] = [];

/** Tells his phone about a finished run, if he asked for it (Settings, and the job's own tick). Never throws. */
export async function tellPhone(run: { agentName: string; job: string; state: string; line: string }, post: Post = realPost, now = Date.now()): Promise<{ sent: boolean; why?: string }> {
  const p = await readPhone();
  if (!p.on || !p.server) return { sent: false, why: 'off' };
  const { topic } = await readSecrets();
  if (!topic) return { sent: false, why: 'no topic' };
  const line = phoneLine(run, p.onlyChanged);
  if (!line) return { sent: false, why: 'nothing to send' };
  if (!roomToSend(sent, now)) return { sent: false, why: `${SENDS_HOUR} an hour is the most` };
  sent.push(now);
  while (sent.length > SENDS_HOUR * 2) sent.shift();
  const r = await sendLine(p.server, topic, line, post);
  return r.ok ? { sent: true } : { sent: false, why: r.why };
}

/** The Test button: one line, sent now (counted in the cap like any other). */
export async function testPhone(post: Post = realPost): Promise<{ ok: boolean; said: string }> {
  const p = await readPhone();
  const { topic } = await readSecrets();
  if (!p.server) return { ok: false, said: 'Give the server address first (https://ntfy.sh, or your own ntfy server).' };
  if (!topic) return { ok: false, said: 'Give the topic first: the one your phone\'s ntfy app subscribes to.' };
  if (!roomToSend(sent, Date.now())) return { ok: false, said: `${SENDS_HOUR} sends an hour is the most: try again later.` };
  sent.push(Date.now());
  const r = await sendLine(p.server, topic, 'TOMLIN test: agent summaries will come here.', post);
  return r.ok ? { ok: true, said: 'Sent. If it did not reach your phone, check the topic in its ntfy app.' } : { ok: false, said: `Not sent: ${r.why}.` };
}

/** The Windows notification's words for a finished run: the person and the event only, never what was found. */
export function windowsLine(o: { agentName: string; job: string; state: string; line: string }): string | null {
  if (o.state === 'stopped') return null;
  if (o.state === 'done' && saysNothingNew(o.line.replace(/^Summary:\s*/i, ''))) return null;
  const first = o.agentName.split(/\s+/)[0] || o.agentName;
  const lead = `${first}'s ${/^[A-Z][a-z]/.test(o.job) ? o.job[0].toLowerCase() + o.job.slice(1) : o.job}`;
  return o.state === 'failed' || o.state === 'skipped' ? `${lead} did not finish. It needs you.` : `${lead} finished. Its report is on Home.`;
}
