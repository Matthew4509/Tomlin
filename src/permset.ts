// A host changes a linked PC's sharing permissions from its own Network page (22 Nov 2026), so a node in another room is
// managed from the PC its owner sits at. Two things must both be true on the node: its owner's tick "Allow host to test
// and change model run settings" (src/carry.ts Allow.tune, ticked at that PC; its words say it covers these), and its app lock PIN
// or the host PIN it holds from this link, typed on the host for this one change (checked there, wrong tries counted per
// link, as for an update or a turn-off). That tick itself is never changed from another PC: only its owner, at that PC,
// gives or takes away the right to manage it. A guest link never reaches the door (src/guestpass.ts allows only
// GUEST_DOORS). Each change is said in the node's own window, its log, and on its Network page.
// Plain parts, tested in test/permset.test.ts; the door is in src/jobrun/node.ts, the host side in src/jobrun/copies.ts.

export const PERM_DOOR = '/worker/perm-set';
/** In a node's hello `can`: it has the door. */
export const PERM_CAN = 'perm-set';

/** The permissions a host may change there, in the order its Network page shows them. Never `tune` (see above). */
export const PERM_KEYS = ['lend', 'plainLinks', 'update', 'off', 'backup', 'receive', 'give', 'pull'] as const;
export type PermKey = (typeof PERM_KEYS)[number];
export type PermSet = Partial<Record<PermKey, boolean>>;

/** Each one's words, as the node's own Network page says them. */
export const PERM_WORDS: Record<PermKey, string> = {
  lend: 'Allow to be used as part of a cluster',
  plainLinks: 'Allow unencrypted cluster links',
  update: 'Allow host to update TOMLIN remotely',
  off: 'Allow host to turn this PC off',
  backup: 'Enable backups',
  receive: 'Accept models from linked PCs',
  give: 'Let linked PCs pull TOMLIN updates from here',
  pull: 'Sharing of models',
};

/** The changes asked for: only known permissions, each true or false; words for anything else. */
export function cleanPermSet(raw: unknown): PermSet | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'no permission to change was sent';
  const out: PermSet = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'tune') return `"Allow host to test and change model run settings" is changed only at that PC itself`;
    if (!(PERM_KEYS as readonly string[]).includes(k)) return `"${k}" is not a permission another PC can change`;
    if (typeof v !== 'boolean') return `"${k}" must be on or off`;
    out[k as PermKey] = v;
  }
  return Object.keys(out).length ? out : 'no permission to change was sent';
}

/** One line for the node's window and log: what changed, and who changed it. Nothing changed: ''. */
export function permWords(before: Record<PermKey, boolean>, set: PermSet, by: string): string {
  const changed = PERM_KEYS.filter(k => k in set && set[k] !== before[k]);
  if (!changed.length) return '';
  return `"${by}" changed this PC's permissions: ${changed.map(k => `${PERM_WORDS[k]} ${set[k] ? 'on' : 'off'}`).join(', ')}.`;
}

type Pin = { ok: true } | { status: number; error: string };

export interface PermSetDeps {
  /** The owner's tick that lets a host manage this PC (Allow.tune). */
  allowed: () => boolean;
  pcName: () => string;
  /** The app lock PIN as typed on the host, checked here; or the host PIN that link gave (`host`, src/hostpin.ts). */
  pinCheck: (pin: unknown, who: string, host?: { pin: unknown; link: string | undefined }) => Promise<Pin>;
  /** The permissions as they are now. */
  current: () => Record<PermKey, boolean>;
  /** Saves the changes; `said` is the line for the window and log ('' when nothing changed). */
  apply: (set: PermSet, said: string, by: string) => Promise<void>;
}

/** The node's door: the answer for one request from a linked PC. Never throws. */
export function permSetSide(d: PermSetDeps) {
  return async (body: Record<string, unknown>, who: { key: string; name: string; link?: string }): Promise<{ status: number; json: Record<string, unknown> }> => {
    const name = d.pcName();
    // Not answered without the owner's tick: the door would only serve to try PINs.
    if (!d.allowed()) return { status: 403, json: { error: `"${name}" does not let a host change its permissions (its owner ticks "Allow host to test and change model run settings" there, on This PC).` } };
    const set = cleanPermSet(body.set);
    if (typeof set === 'string') return { status: 400, json: { error: `${set.charAt(0).toUpperCase()}${set.slice(1)}.` } };
    const pin = await d.pinCheck(body.appPin, who.key, body.hostPin !== undefined ? { pin: body.hostPin, link: who.link } : undefined);
    if ('error' in pin) return { status: pin.status, json: { error: `"${name}" ${pin.error}.`, needPin: pin.status === 403 } };
    const said = permWords(d.current(), set, who.name);
    try {
      await d.apply(set, said, who.name);
    } catch (e) {
      return { status: 500, json: { error: `"${name}" could not save its permissions: ${(e as Error).message}` } };
    }
    return { status: 200, json: { said: said ? said.replace(/^"[^"]*" changed this PC's/, `Changed "${name}"'s`) : `"${name}" already had those permissions.`, now: d.current() } };
  };
}
