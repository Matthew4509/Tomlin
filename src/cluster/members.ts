// The cluster entry: a saved set of linked PCs (by id) with one on/off switch, so a cluster such as two HP 800s and a Z820
// can be switched on quickly and off again without being built each time. On: models too big for this PC borrow from these
// PCs and no others, and each of them is held for the cluster (greyed out in the list, no staff, chats or pictures sent
// there). Off: the set is kept and nothing is borrowed. With no set saved, the old rule stands (every linked PC whose
// owner allows it is borrowed from; "Don't borrow from it" opts one out). "This PC takes part" off (`out`): this PC only
// connects to the cluster and sends the chat, and one member (`loader`, src/cluster/loader.ts) loads the model and
// borrows from the others; this PC borrows from nobody. Pure: src/jobrun/maxhost.ts and linking.ts use it.

export interface ClusterSet {
  /** Whether the cluster is switched on. Never true with no member. */
  on: boolean;
  /** The linked PCs in it, by id, in the order they were added. */
  members: string[];
  /**
   * Set when this PC does not take part (the "This PC takes part" switch off): it connects to the cluster and sends the
   * chat, and `loader` loads the model and borrows from the other members (src/cluster/loader.ts). Unset: this PC takes
   * part and loads the model itself, as every cluster did before.
   */
  out?: true;
  /** With `out`: the member that loads the model. Always one of `members`. */
  loader?: string;
  /**
   * Set when the owner chose "This PC takes part" on (an explicit saved choice), with PCs in the cluster or before any
   * (read top to bottom, the switch comes first: the choice waits for the PCs). Unset with `out` unset: nothing was chosen
   * yet, which the page shows as Off; a cluster saved that way still runs the old way (this PC loads the model) until the
   * owner chooses, and a choice is never made for them. Never set with `out`.
   */
  part?: true;
}

export const NO_CLUSTER: ClusterSet = { on: false, members: [] };

/** The most PCs in one cluster (the planner and the stream ports are made for a handful, not a rack). */
export const MAX_MEMBERS = 8;

/**
 * A saved value read back: ids only, no repeats, at most MAX_MEMBERS; `on` only when there is someone to switch on; this
 * PC out only with a loader that is still a member (otherwise it takes part again, as before the switch existed).
 */
export function cleanCluster(raw: unknown): ClusterSet {
  const o = raw && typeof raw === 'object' ? (raw as { on?: unknown; members?: unknown; out?: unknown; loader?: unknown; part?: unknown }) : {};
  const members = [...new Set((Array.isArray(o.members) ? o.members : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, MAX_MEMBERS);
  const out = o.out === true && typeof o.loader === 'string' && members.includes(o.loader);
  return { on: o.on === true && members.length > 0, members, ...(out ? { out: true as const, loader: o.loader as string } : o.part === true ? { part: true as const } : {}) };
}

/** The set with `ids` as its members: only PCs still linked, kept in the order given; off when it is left empty. */
export function withMembers(c: ClusterSet, ids: unknown, linked: string[]): ClusterSet {
  const list = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === 'string' && linked.includes(x));
  return cleanCluster({ ...c, members: list });
}

/** The set switched on or off; null when it is switched on with no member to use. */
export function withOn(c: ClusterSet, on: boolean): ClusterSet | null {
  if (on && !c.members.length) return null;
  return cleanCluster({ ...c, on });
}

/**
 * The set with this PC taking part (its old way: it loads the model) or out, connecting only, with `loader` loading it.
 * `chosen`: true only when the owner pressed it on (their saved choice, `part`); a fall-back by the server never sets it.
 */
export function withHere(c: ClusterSet, takesPart: boolean, loader = '', chosen = false): ClusterSet | null {
  const { out: _out, loader: _loader, part: _part, ...rest } = c;
  if (takesPart) return cleanCluster(chosen ? { ...rest, part: true } : rest);
  if (!c.members.includes(loader)) return null;
  return cleanCluster({ ...rest, out: true, loader });
}

/** Whether the owner chose "This PC takes part" on, as the page shows it: never on by itself (no set, or nothing chosen: Off). */
export const takesPartChosen = (c: ClusterSet | undefined | null): boolean => !!c && c.part === true && !c.out;

/**
 * Why a PC cannot be added to the cluster now ('' when it can): it is off, asleep or not answering, or its owner logged it
 * off. `seenAt`: when it last answered (ms), when known.
 */
export function addWhy(name: string, h: { ok: boolean; away?: unknown; seenAt?: number | null }): string {
  if (h.ok && !h.away) return '';
  const seen = h.seenAt ? ` (last seen ${new Date(h.seenAt).toISOString().slice(0, 16).replace('T', ' ')})` : '';
  return h.ok ? `"${name}" is logged off for now: its owner pressed "I need to use the pc". Add it when it is started again.` : `"${name}" is off, asleep or not answering${seen}, so it cannot be added to the cluster. Switch it on, then add it.`;
}

/** Whether this PC takes part in the set (it loads the model): true unless it was switched out. */
export const takesPart = (c: ClusterSet | undefined | null): boolean => !c?.out;

/** Whether a set exists (a saved set, on or off, takes over from the old rule). */
export const hasCluster = (c: ClusterSet | undefined | null): c is ClusterSet => !!c && c.members.length > 0;

/** Whether PC `id` is in the set, on or off. */
export const isMember = (c: ClusterSet | undefined | null, id: string): boolean => !!c && c.members.includes(id);

/**
 * Whether PC `id` is held for the cluster now: the cluster is on and it is in it. The loader of a cluster this PC stays
 * out of is not held: the chats for the cluster go to it.
 */
export const heldFor = (c: ClusterSet | undefined | null, id: string): boolean => !!c && c.on && c.members.includes(id) && !(c.out && c.loader === id);

/** The set kept to the PCs still linked (`ids`); off when nobody is left. Every save runs it, so no path can leave a dangling member. */
export const onlyLinked = (c: ClusterSet, ids: string[]): ClusterSet => (c.members.every(x => ids.includes(x)) ? c : cleanCluster({ ...c, members: c.members.filter(x => ids.includes(x)) }));

/** The set without PC `id` (it was unlinked); off when nobody is left. */
export const without = (c: ClusterSet, id: string): ClusterSet => cleanCluster({ ...c, members: c.members.filter(x => x !== id) });

/** What a held PC says on the page and when work is sent to it. */
export const heldWhy = (name: string): string => `"${name}" is in the cluster, which is switched on: its card, RAM and cores are held for models too big for this PC. Switch the cluster off to use it for staff again (the Cluster card, or Network).`;
