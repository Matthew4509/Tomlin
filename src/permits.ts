// Permissions for what a chat's model may do on its own (Settings, Permissions, and the card in a chat that asks):
// each kind is Manual (asked the first time in each answer, unless allowed for the thread) or Auto (never asked). The
// card shows where every kind stands and can turn one to Auto for this thread or always. Plain parts, tested in
// test/permits.test.ts; the chat's side is in src/server/chat.ts answerTurn, the card in public/chatview.js.
//
// The newer kinds (screen, the laptop helper, git, notes, and the ones that act: focus, input, run, edit, download)
// have a tier each instead of Manual or Auto: Never (not offered to the model at all), Look only (asked once an
// answer), Ask each time (a card for every call, Once or No) and Allowed (no card). A tier only chooses when to ask:
// the window list, the folder list, the key list and every other guard are code and apply after the tier says yes.

/** The two first kinds: Manual or Auto, as they always were. */
export type OldKind = 'files' | 'web';
/** Kinds that only read. */
export type LookKind = 'screen' | 'machine' | 'git' | 'notes' | 'subagent';
/** Kinds that change something or run something. */
export type ActKind = 'focus' | 'input' | 'run' | 'edit' | 'download';
export type TierKind = LookKind | ActKind;
/** What a model may be allowed to do. More kinds go here (and in KINDS) as tools are added. */
export type Kind = OldKind | TierKind;
export type Mode = 'ask' | 'auto';
export type Tier = 'never' | 'look' | 'each' | 'allowed';

export const TIER_NAME: Record<Tier, string> = { never: 'Never', look: 'Look only', each: 'Ask each time', allowed: 'Allowed' };

export interface Permissions {
  files: Mode;
  web: Mode;
  /** Wait 1-5 s (at random) between pages on the same site, so a site's firewall does not ban this PC for a burst. */
  webDelay: boolean;
  /** The tier of each newer kind. */
  tiers: Record<TierKind, Tier>;
  /** The windows the screen tools may name, look at and act on ("mstsc.exe|192.168.1.20 - *"). None: no screen tools. */
  windows: string[];
  /** The folders the coding tools may work in (real paths). None: no coding tools. */
  folders: string[];
  /** Named commands the person wrote for run_command, beside test, build, lint and typecheck ("docs=npm run docs"). */
  commands: string[];
  /** The role bundles: research adds notes and findings to a chat with Web on; coding adds git and run in a listed folder. */
  research: boolean;
  coding: boolean;
}

export const KINDS: Array<{ kind: OldKind; name: string; what: string }> = [
  { kind: 'files', name: 'Files', what: 'list, read and save files in the chat\'s folder (nothing is run or deleted)' },
  { kind: 'web', name: 'Web', what: 'search the web and read pages' },
];

/** The newer kinds, in the order shown. `tiers`: what the person may choose; `safe`: where it stands until they do. */
export const TIER_KINDS: Array<{ kind: TierKind; name: string; what: string; acts: boolean; safe: Tier; tiers: Tier[] }> = [
  { kind: 'screen', name: 'Screen', what: 'name and read the windows on your list (as text, nothing is clicked)', acts: false, safe: 'look', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'machine', name: 'Laptop helper', what: 'read a linked helper\'s menus and window state as text', acts: false, safe: 'look', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'git', name: 'Git (read)', what: 'read status, diff, log and history in a folder on your coding list', acts: false, safe: 'look', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'notes', name: 'Notes', what: 'save a research note, working notes and checked quotes in the chat\'s folder, and suggest a finding for you to save', acts: false, safe: 'look', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'subagent', name: 'Subagent', what: 'have a second model check a draft against its quotes: on an available node, or queued to run on this PC after the answer', acts: false, safe: 'look', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'focus', name: 'Bring a window to the front', what: 'bring a window on your list to the front (it can take the keyboard from what you are doing)', acts: true, safe: 'never', tiers: ['never', 'each'] },
  { kind: 'input', name: 'Click and type', what: 'click and press keys in a window on your list, one card for each action', acts: true, safe: 'never', tiers: ['never', 'each'] },
  { kind: 'run', name: 'Run a named command', what: 'run test, build, lint or typecheck in a folder on your coding list', acts: true, safe: 'never', tiers: ['never', 'each', 'allowed'] },
  { kind: 'edit', name: 'Edit with a diff', what: 'change a file by a patch you see first', acts: true, safe: 'never', tiers: ['never', 'each', 'allowed'] },
  { kind: 'download', name: 'Download a file', what: 'save a file from the web into the chat\'s folder (never opened or run)', acts: true, safe: 'never', tiers: ['never', 'each'] },
];

const SAFE_TIERS = Object.fromEntries(TIER_KINDS.map(k => [k.kind, k.safe])) as Record<TierKind, Tier>;

export const DEFAULT_PERMISSIONS: Permissions = { files: 'ask', web: 'ask', webDelay: true, tiers: { ...SAFE_TIERS }, windows: [], folders: [], commands: [], research: false, coding: false };

const lines = (v: unknown, was: string[], most: number, long: number): string[] =>
  (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.replace(/[\r\n\t]/g, ' ').trim()).filter(x => x && x.length <= long))].slice(0, most) : was);

/**
 * Permissions as saved or sent, with only known values (anything else falls back to the safe default). A tier a kind
 * does not have (Allowed for clicks, Look only for a kind that acts) is not kept: it falls to Never for a kind that
 * acts, and to what it was for one that reads.
 */
export function cleanPermissions(raw: unknown, was: Permissions = DEFAULT_PERMISSIONS): Permissions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (v: unknown, d: Mode): Mode => (v === 'auto' || v === 'ask' ? v : d);
  const t = (o.tiers && typeof o.tiers === 'object' ? o.tiers : {}) as Record<string, unknown>;
  const tiers = Object.fromEntries(TIER_KINDS.map(k => {
    const v = t[k.kind];
    if (v === undefined) return [k.kind, was.tiers?.[k.kind] ?? k.safe];
    return [k.kind, (k.tiers as unknown[]).includes(v) ? (v as Tier) : k.acts ? 'never' : was.tiers?.[k.kind] ?? k.safe];
  })) as Record<TierKind, Tier>;
  return {
    files: mode(o.files, was.files),
    web: mode(o.web, was.web),
    webDelay: typeof o.webDelay === 'boolean' ? o.webDelay : was.webDelay,
    tiers,
    windows: lines(o.windows, was.windows ?? [], 20, 200),
    folders: lines(o.folders, was.folders ?? [], 20, 400),
    commands: lines(o.commands, was.commands ?? [], 20, 300),
    research: typeof o.research === 'boolean' ? o.research : was.research === true,
    coding: typeof o.coding === 'boolean' ? o.coding : was.coding === true,
  };
}

export const isKind = (x: unknown): x is Kind => KINDS.some(k => k.kind === x) || TIER_KINDS.some(k => k.kind === x);
export const isTierKind = (x: unknown): x is TierKind => TIER_KINDS.some(k => k.kind === x);

/** Where a newer kind stands (Never when the settings do not say). */
export const tierOf = (p: Pick<Permissions, 'tiers'> | undefined, kind: TierKind): Tier => p?.tiers?.[kind] ?? SAFE_TIERS[kind] ?? 'never';

/** The role presets: they only set tiers the person can see and change, and never raise a kind that acts. */
export function withRole(p: Permissions, role: 'research' | 'coding', on: boolean): Permissions {
  return cleanPermissions({ [role]: on }, p);
}

/**
 * The person's answer on the card: once (this answer), thread (Auto in this chat), always (Auto everywhere, saved in
 * Settings), no (not in this answer).
 */
export type Permit = 'once' | 'thread' | 'always' | 'no';
export const cleanPermit = (x: unknown): Permit | null => (x === 'once' || x === 'thread' || x === 'always' || x === 'no' ? x : null);

/** What an Ask each time card shows beside the words: the last capture and where a click would land. */
export interface CardExtra {
  image?: string;
  mark?: { x: number; y: number; w: number; h: number };
  /** The exact command, or the diff, in a fixed-width block. */
  detail?: string;
  /** Asked although it is allowed: the answer read text that looked like orders for an AI (Gate.hold). */
  held?: string;
}

export interface GateOpts {
  /** Allowed without asking now: Auto in Settings, or Auto for this thread. */
  allowed: (kind: Kind) => boolean;
  /** Puts the card to the person; `what` says what the model is about to do. `each`: an Ask each time card (Once or No). */
  ask: (kind: Kind, what: string, each?: boolean, extra?: CardExtra) => Promise<Permit>;
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

  private heldWhy = '';

  constructor(o: GateOpts) {
    this.o = o;
  }

  /**
   * The answer has read text that looked like orders for an AI (a web page, a file, a tool's result: src/promptscan.ts
   * guardData). For the rest of this answer every tool use is asked on its own card, Auto and Allowed included, and no
   * answer is kept: a page cannot use a permission given for the person's own ask. `why` is said on the card.
   */
  hold(why: string): void {
    if (!this.heldWhy) this.heldWhy = why;
  }

  get held(): string {
    return this.heldWhy;
  }

  /** A held answer's card: any yes is for this one use only. */
  private heldAsk(kind: Kind, what: string, extra?: CardExtra): Promise<boolean> {
    const p = this.queue.then(async () => (await this.o.ask(kind, what, true, { ...extra, held: this.heldWhy }).catch((): Permit => 'no')) !== 'no');
    this.queue = p.catch(() => false);
    return p;
  }

  permitted(kind: Kind, what: string): Promise<boolean> {
    if (this.heldWhy) return this.heldAsk(kind, what);
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

  /**
   * Ask each time: every call puts up its own card, one at a time, and only Once is a yes. Nothing is kept, whatever
   * the answer, and `allowed` is not asked: a kind at this tier is never Auto.
   */
  each(kind: Kind, what: string, extra?: CardExtra): Promise<boolean> {
    if (this.heldWhy) return this.heldAsk(kind, what, extra);
    const p =this.queue.then(async () => (await this.o.ask(kind, what, true, extra).catch((): Permit => 'no')) === 'once');
    this.queue = p.catch(() => false);
    return p;
  }

  /** By the kind's tier: Never is a no, Ask each time a card for this call, Look only a card once an answer, Allowed a yes. */
  byTier(tier: Tier, kind: TierKind, what: string, extra?: CardExtra): Promise<boolean> {
    if (tier === 'never') return Promise.resolve(false);
    if (this.heldWhy) return this.heldAsk(kind, what, extra);
    if (tier === 'allowed') return Promise.resolve(true);
    return tier === 'each' ? this.each(kind, what, extra) : this.permitted(kind, what);
  }
}

const DENIED_NAME: Record<TierKind, [string, string]> = {
  screen: ['looking at the screen', 'window'],
  machine: ['reading the laptop helper', 'menu'],
  git: ['reading git', 'repository'],
  notes: ['saving notes', 'note'],
  subagent: ['a subagent', 'subagent'],
  focus: ['bringing a window to the front', 'window'],
  input: ['clicking or typing', 'window'],
  run: ['running a command', 'command'],
  edit: ['editing a file', 'file'],
  download: ['downloading a file', 'file'],
};

/** What the model is told when a kind was not allowed. */
export function deniedWords(kind: Kind): string {
  if (kind !== 'files' && kind !== 'web') {
    const [name, what] = DENIED_NAME[kind];
    return `The person did not allow ${name} for this call. It is NOT allowed, so nothing was done and nothing was read from the ${what}. `
      + `You must not state or describe anything as if it happened or as if it came from the ${what}. `
      + 'Say plainly that it was not done, then answer only from what you already know, labelled "from what I already know". '
      + 'Say they can allow it next time.';
  }
  const files = kind === 'files';
  const name = files ? 'file access' : 'web access';
  const what = files ? 'file' : 'page';
  return `The person did not allow ${name} for this answer. It is NOT allowed, so the ${what} was NOT read and nothing was done. `
    + `You must not state or describe anything as if it came from the ${what}, and do not say "based on the live ${what}". `
    + `Say plainly that you did not read it, then answer only from what you already know, labelled "from what I already know, not from ${files ? 'a file' : 'the page'}". `
    + 'Say they can allow it next time.';
}
