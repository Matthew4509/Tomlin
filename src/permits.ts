// Permissions for what a chat's model may do on its own (Settings, Permissions, and the card in a chat that asks):
// each kind is Manual (asked the first time in each answer, unless allowed for the thread) or Auto (never asked). The
// card shows where every kind stands and can turn one to Auto for this thread or always. Plain parts, tested in
// test/permits.test.ts; the chat's side is in src/server/chat.ts answerTurn, the card in public/chatview.js.

/** What a model may be allowed to do. More kinds go here (and in KINDS) as tools are added. */
export type Kind = 'files' | 'web';
export type Mode = 'ask' | 'auto';

export interface Permissions {
  files: Mode;
  web: Mode;
  /** Wait 1-5 s (at random) between pages on the same site, so a site's firewall does not ban this PC for a burst. */
  webDelay: boolean;
}

export const KINDS: Array<{ kind: Kind; name: string; what: string }> = [
  { kind: 'files', name: 'Files', what: 'list, read and save files in the chat\'s folder (nothing is run or deleted)' },
  { kind: 'web', name: 'Web', what: 'search the web and read pages' },
];

export const DEFAULT_PERMISSIONS: Permissions = { files: 'ask', web: 'ask', webDelay: true };

/** Permissions as saved or sent, with only known values (anything else falls back to the safe default). */
export function cleanPermissions(raw: unknown, was: Permissions = DEFAULT_PERMISSIONS): Permissions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (v: unknown, d: Mode): Mode => (v === 'auto' || v === 'ask' ? v : d);
  return { files: mode(o.files, was.files), web: mode(o.web, was.web), webDelay: typeof o.webDelay === 'boolean' ? o.webDelay : was.webDelay };
}

export const isKind = (x: unknown): x is Kind => KINDS.some(k => k.kind === x);

/**
 * The person's answer on the card: once (this answer), thread (Auto in this chat), always (Auto everywhere, saved in
 * Settings), no (not in this answer).
 */
export type Permit = 'once' | 'thread' | 'always' | 'no';
export const cleanPermit = (x: unknown): Permit | null => (x === 'once' || x === 'thread' || x === 'always' || x === 'no' ? x : null);

export interface GateOpts {
  /** Allowed without asking now: Auto in Settings, or Auto for this thread. */
  allowed: (kind: Kind) => boolean;
  /** Puts the card to the person; `what` says what the model is about to do. */
  ask: (kind: Kind, what: string) => Promise<Permit>;
  /** Keeps a thread or always answer (on the chat, or in Settings). */
  keep?: (kind: Kind, p: 'thread' | 'always') => Promise<void>;
}

/**
 * One answer's permissions: each kind is asked at most once per answer (calls made while the card is open wait for
 * it); a no holds for the rest of the answer. Asks for different kinds wait for each other, so only one card shows.
 */
export class Gate {
  private readonly said = new Map<Kind, Promise<boolean>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly o: GateOpts;

  constructor(o: GateOpts) {
    this.o = o;
  }

  permitted(kind: Kind, what: string): Promise<boolean> {
    if (this.o.allowed(kind)) return Promise.resolve(true);
    let p = this.said.get(kind);
    if (!p) {
      p = this.queue.then(async () => {
        if (this.o.allowed(kind)) return true;
        const a = await this.o.ask(kind, what).catch((): Permit => 'no');
        if (a === 'thread' || a === 'always') await this.o.keep?.(kind, a).catch(() => undefined);
        return a !== 'no';
      });
      this.queue = p.catch(() => false);
      this.said.set(kind, p);
    }
    return p;
  }
}

/** What the model is told when a kind was not allowed. */
export function deniedWords(kind: Kind): string {
  const name = kind === 'files' ? 'file access' : 'web access';
  return `The person did not allow ${name} for this answer, so nothing was done. Answer without it, and say they can allow it next time.`;
}
