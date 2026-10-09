// Remote workers: another PC running TOMLIN can lend its connected chat model to this one's jobs.
// The worker side is OFF until its owner turns it on. When on, it listens on the home network for three things only:
// pair (with this PC's setup code, and a 6-digit PIN only if its owner asks for one), whoami (only that this is Smart
// Manager, its name and whether a PIN is asked: so a PC can find it on the home network), hello (what model is loaded, the models its owner lets
// linked PCs use, and the staff it lends), run (one prompt or a chat in, text out; a chat with one of its hires; or a chat on one of those models,
// loaded first when it is not), switch (one of its hires to another of the models it gave them), draw (a prompt and a
// style in, one picture out, on the picture model its owner connected), back (start again after someone at the PC
// pressed "I need to use the pc"). Since F7 every message after pair is sealed (src/link.ts). It never reads or writes the manager's files:
// the manager sends the brief and file text, the worker sends text or a picture back. Since 2.0.32 its owner may also
// let linked PCs copy its shared models, send it models, or keep restore points on it (src/carry.ts): off until ticked. Only private (LAN) addresses are answered,
// wrong PINs are limited, and the worker keeps only a hash of each paired manager's token.
// The plain functions are tested in test/share.test.ts.
import type { Allow } from './carry.ts';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** True for this PC and the home network: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10. */
export function isPrivateAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const ip = raw.replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
  }
  return false;
}

export const newPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const newToken = () => randomBytes(32).toString('hex');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Wrong PINs: after 5 in 10 minutes from one address, that address is refused for 10 minutes. */
export class PinGuard {
  private tries = new Map<string, number[]>();
  private now: () => number;
  constructor(now = () => Date.now()) {
    this.now = now;
  }
  private recent(ip: string): number[] {
    const t = (this.tries.get(ip) ?? []).filter(x => this.now() - x < 10 * 60_000);
    this.tries.set(ip, t);
    return t;
  }
  /** Minutes until this address may try again, or 0. */
  lockedFor(ip: string): number {
    const t = this.recent(ip);
    return t.length >= 5 ? Math.ceil((10 * 60_000 - (this.now() - t[t.length - 5])) / 60_000) : 0;
  }
  wrong(ip: string): void {
    this.recent(ip).push(this.now());
  }
  right(ip: string): void {
    this.tries.delete(ip);
  }
}

/** A worker address as typed ("192.168.1.20", "192.168.1.20:8741", "http://desk.local:8741/") -> "http://host:port", or null. */
export function cleanWorkerUrl(input: unknown, defaultPort = 8741): string | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 200) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // An address must be on the home network; a name (e.g. desk.local) is allowed, the worker refuses anything not on the LAN.
  if (isIP(host) && !isPrivateAddress(host)) return null;
  if (!isIP(host) && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host)) return null;
  const port = u.port ? Number(u.port) : defaultPort;
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

export interface ShareState {
  on: boolean;
  port: number;
  /** The name this PC shows to managers (typed by its owner; never the computer's own name). */
  name: string;
  /** This PC's own id (made once, kept; not secret): a PC that links again finds the same chats with its staff. */
  id: string;
  /** This PC's setup code (made once, kept): a PC that wants to link with this one must type it. */
  code: string;
  /** Whether a PIN is asked for as well as the setup code (off by default). */
  pinOn: boolean;
  pin: string;
  paired: { name: string; hash: string; at: string; /** The linking PC's own id (newer copies send it), so linking again replaces its old link. */ from?: string; /** The encrypted link's keys (src/link.ts); a link from before has none and must be made again. */ key?: string; /** Where this link's restore points and update are kept here: made at linking, never said by the linking PC (links made before use `from`). */ keep?: string }[];
  /** Someone at this PC pressed "I need to use the pc" (F7 E5): when, and the models loaded then (they load again at the restart). */
  away?: { since: string; held: { chat: string[]; image: string | null }; /** Logged out for the hours the main PC agreed to: it starts again by itself then. */ until?: string } | null;
  /** Someone at this PC sent the main PC "I need to use the pc, please log out for N hours" from the lock screen: the main PC answers it. */
  ask?: PcAsk | null;
  /** The chat models linked PCs may use (ticked by this PC's owner): they hire their own staff on them. None until ticked. */
  models?: string[];
  /** What linked PCs may do here besides using those models (src/carry.ts): copy them, keep restore points, send models. None until ticked. */
  allow?: Allow;
  /** The last update a linked PC pushed here (src/update.ts): to which version, by whom, when. */
  updated?: { version: string; by: string; at: string } | null;
}

export const DEFAULT_SHARE: ShareState = { on: false, port: 8741, name: 'Worker PC', id: '', code: '', pinOn: false, pin: '', paired: [], models: [] };

// A setup code: 8 letters and digits with the easily confused ones (0 O 1 I L) left out, shown as ABCD-EFGH.
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newCode(): string {
  const c = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(0, CODE_CHARS.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
/** A code as typed ("abcd efgh", "ABCD-EFGH") -> "ABCDEFGH" (letters and digits only, capitals). */
export const cleanCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);

/** Whether a PC asking to link typed the right setup code (and the PIN, when this PC asks for one). */
export function pairAllowed(state: Pick<ShareState, 'code' | 'pinOn' | 'pin'>, code: unknown, pin: unknown): boolean {
  const want = cleanCode(state.code);
  if (!want || !safeEqual(cleanCode(code), want)) return false;
  if (!state.pinOn) return true;
  return !!state.pin && safeEqual(String(pin ?? '').replace(/\D/g, ''), state.pin);
}

/** Every address on the home network next to this PC's own (the same /24), for "Find PCs on my network". */
export function scanTargets(own: string[]): string[] {
  const out = new Set<string>();
  for (const a of own) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
    if (!m || !isPrivateAddress(a)) continue;
    for (let i = 1; i < 255; i++) out.add(`${m[1]}.${m[2]}.${m[3]}.${i}`);
  }
  return [...out];
}

/** The paired manager whose token this is, or null. */
export function pairedBy(state: ShareState, token: string | undefined): ShareState['paired'][number] | null {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const h = hashToken(token);
  return state.paired.find(p => safeEqual(p.hash, h)) ?? null;
}

/** The paired manager a link fingerprint (the token's hash, F7) names, or null. The sealing proves it is that PC. */
export function pairedByHash(state: ShareState, hash: string | undefined): ShareState['paired'][number] | null {
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return state.paired.find(p => safeEqual(p.hash, hash)) ?? null;
}

/** Reads a worker's event stream (text, then done or error) and calls onText with the text so far; any other event goes to onEvent. */
export async function readStream(res: Response, onText: (text: string) => void, onEvent?: (event: string, data: Record<string, unknown>) => void, idleMs = 75_000): Promise<string> {
  if (!res.body) throw new Error('The worker sent nothing back.');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    // The worker writes a line every 20 s even while it thinks: this long with nothing means it is gone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`The worker went quiet for ${Math.round(idleMs / 1000)} s (it may have been closed, asleep or off the network).`));
        void reader.cancel().catch(() => undefined);
      }, idleMs);
    });
    const { value, done } = await Promise.race([reader.read(), silent]).finally(() => clearTimeout(timer));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
      if (ev === 'text') onText((text = data.text));
      else if (ev === 'error' || ev === 'refused') throw new Error(`The worker said: ${data.text}`);
      else if (ev === 'done') {
        onEvent?.('done', data);
        return text;
      }
      else if (ev) onEvent?.(ev, data);
    }
  }
  throw new Error('The worker stopped before it finished (it may have been closed or disconnected).');
}

// ---- "Send host": someone at a node asks the main PC to log out for a while (the main PC decides) ----

/** The hours a request from the lock screen may ask for. */
export const ASK_HOURS = [1, 2, 4] as const;

export interface PcAsk {
  hours: number;
  /** When it was sent (it names the request: an answer to an older one is refused). */
  at: string;
  answer?: 'yes' | 'no';
  /** The main PC that answered, and when. */
  by?: string;
  answeredAt?: string;
}

/** The request as it is sent and shown, word for word. */
export const askText = (hours: number) => `I need to use the pc, please log out for ${hours} hour${hours === 1 ? '' : 's'}`;

/** A request still waiting for an answer, as a node's hello tells it; null when none. */
export const askPending = (a: PcAsk | null | undefined): { hours: number; at: string } | null => (a && !a.answer ? { hours: a.hours, at: a.at } : null);

/** One of the hours offered, or null. */
export const cleanAskHours = (v: unknown): number | null => (ASK_HOURS as readonly number[]).includes(Number(v)) ? Number(v) : null;

/** When a "yes" to a request sent ends: the node starts again by itself then. */
export const askUntil = (hours: number, now = Date.now()) => new Date(now + hours * 3600_000).toISOString();
