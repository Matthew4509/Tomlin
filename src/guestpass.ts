// Guest passes: a node's owner makes a pass (a label, 1 day / 1 week / no limit, which nodes and models), and a PC that
// types its code links here as a guest. A guest is a link with less in it, not an account: its staff, notebooks and
// chats stay on its own PC. It may use the models its pass names, see its own answers and pull TOMLIN updates (when
// the owner ticked that); nothing else. The code is shown once when made and never kept: the node keeps only the key
// the link is proven with (scrypt of the code, src/link.ts pairKey), as slow to guess from as the setup code's.
// A link with no role is a link as it always was. Every door asks doorRefusal; plain functions, tested in
// test/guestpass.test.ts (and at the real doors in test/guestdoors.test.ts).
import { randomBytes, randomInt } from 'node:crypto';
import { pairKey } from './link.ts';

export type PassLength = 'day' | 'week' | 'none';
const LENGTH_MS: Record<PassLength, number | null> = { day: 86_400_000, week: 7 * 86_400_000, none: null };
export const PASS_LENGTHS = Object.keys(LENGTH_MS) as PassLength[];

export interface GuestPass {
  id: string;
  label: string;
  /** The key a linking PC proves the code with (base64url); '' once removed. Never the code. */
  key: string;
  length: PassLength;
  created: string;
  /** When it ends; null for no limit. */
  expires: string | null;
  /** The nodes it lets the guest use (by id): this PC, and on a host the nodes it is linked to (copied to each). */
  nodes: string[];
  /** The models (chat and picture, by id) the guest may use on this PC. */
  models: string[];
  /** On the host that made it: each node's models (a model's id is that PC's own). A node's copy has only `models`. */
  nodeModels?: Record<string, string[]>;
  /** Goes up by one at each change (made 1, removed 2): a node never takes an older copy over a newer one. */
  rev: number;
  /** On a node: the admin link (its keep id) of the host that gave it. Absent: made on this PC. */
  by?: string;
  /** Guests whose link this PC renewed after their request, with the new end (null: never expires). Never sent to a node. */
  renewals?: Renewal[];
  /** How many times it was used to link. */
  uses: number;
  /** The last time a guest with it used a door here. */
  lastSeen: string | null;
  /** Removed: kept without its key, so a later copy to other nodes can say so. */
  revoked?: boolean;
}

/** The part of a link a door looks at. */
export interface LinkRole {
  role?: string;
  passId?: string;
  expires?: string | null;
  /** Renewed by its host after a request: its own end date counts from then on, past its pass's. */
  renewed?: boolean;
  /** Its host pressed Block on a request from it: it may not ask again. */
  blocked?: boolean;
  /** When its pass was removed (here, by its host, or with its host's link): it may collect work for COLLECT_MS. */
  endedAt?: string;
}

/** What a door needs to know about this node. */
export interface PassState {
  id: string;
  name: string;
  passes?: GuestPass[];
  /** This node's links: a pass a host gave counts only while that host is linked here as an admin. */
  paired?: (LinkRole & { keep?: string; from?: string; hash: string })[];
}

/** A link's keep id, as the node files its restore points under it (src/jobrun/node.ts keepOf): names a giver. */
export const linkKeep = (l: { keep?: string; from?: string; hash: string }) => l.keep ?? l.from ?? l.hash.slice(0, 16);

/** Passes a node keeps from one host at most. */
export const MAX_FROM_HOST = 200;

/** Links a pass may hold at once: a fourth pushes out its oldest. */
export const LINKS_PER_PASS = 3;
/** Live passes on one node at most. */
export const MAX_PASSES = 50;

// The setup code's alphabet (src/share.ts): no 0 O 1 I L.
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newPassCode(): string {
  const c = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(0, CODE_CHARS.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function passExpired(p: Pick<GuestPass, 'expires'>, now = Date.now()): boolean {
  return p.expires !== null && !(now < at(p.expires));
}
export function passLive(p: GuestPass, now = Date.now()): boolean {
  return !p.revoked && !!p.key && !passExpired(p, now);
}

/** A label as typed: letters, digits, spaces and . ' - only, 40 at most. */
const cleanLabel = (v: unknown) => String(v ?? '').replace(/[^\w .'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const cleanIds = (v: unknown, most = 200) => [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x && x.length <= 300))].slice(0, most);

/** A new pass for this node (`nodeId`): the record to keep, and its code to show once. */
export async function makePass(b: { label?: unknown; length?: unknown; models?: unknown; scope?: { id: string; models: string[] }[] }, nodeId: string, now = Date.now(), avoid: { codes?: string[]; keys?: string[] } = {}): Promise<{ pass: GuestPass; code: string } | { error: string }> {
  // `scope` (checked by the caller against the PCs it knows): the nodes picked, each with its models. Else this PC.
  const scope = b.scope ?? [{ id: nodeId, models: cleanIds(b.models) }];
  if (!scope.length) return { error: 'Pick at least one PC the pass is for.' };
  const label = cleanLabel(b.label);
  if (!label) return { error: 'Give the pass the name of the person it is for.' };
  const length = PASS_LENGTHS.find(x => x === b.length);
  if (!length) return { error: 'Pick 1 day, 1 week or no limit.' };
  const bare = (c: string) => c.replace(/[^A-Z0-9]/g, '');
  for (;;) {
    const code = newPassCode();
    // Never the setup code or another pass's code (one in 800 billion, but checked).
    if ((avoid.codes ?? []).some(c => bare(String(c).toUpperCase()) === bare(code))) continue;
    const key = (await pairKey(code, '')).toString('base64url');
    if ((avoid.keys ?? []).includes(key)) continue;
    const ms = LENGTH_MS[length];
    return {
      code,
      pass: {
        id: randomBytes(4).toString('hex'), label, key, length, created: new Date(now).toISOString(), expires: ms === null ? null : new Date(now + ms).toISOString(),
        nodes: scope.map(x => x.id), models: cleanIds(scope.find(x => x.id === nodeId)?.models), ...(b.scope ? { nodeModels: Object.fromEntries(scope.map(x => [x.id, cleanIds(x.models)])) } : {}), uses: 0, lastSeen: null, rev: 1,
      },
    };
  }
}

/**
 * The doors a guest may call (exact names; anything else is refused, a door added later too): hello (the models it
 * may use), stats (this PC's meters during its chat), run and draw (on its pass's models), its own answers (result,
 * taken, stop, tool-result, usage), and pulling TOMLIN (update-list, update-get: only with the owner's tick, as for any link).
 */
export const GUEST_DOORS: readonly string[] = ['/worker/hello', '/worker/stats', '/worker/run', '/worker/draw', '/worker/tool-result', '/worker/result', '/worker/taken', '/worker/stop', '/worker/usage', '/worker/update-list', '/worker/update-get'];

/**
 * Every other door a linked PC can call today, refused to a guest: pushing an update, a runner or a model, copying
 * models, downloads, backups and restore points, project backups, run settings and tests, Max mode and the cluster,
 * this PC's log, starting or stopping it, changing its permissions (src/permset.ts), the backup owner's doors and the host PIN's (src/hostpin.ts). Listed so the tests can name every door; the
 * refusal does not depend on this list (doorRefusal allows GUEST_DOORS only).
 */
export const HOST_ONLY_DOORS: readonly string[] = [
  '/worker/ask-answer', '/worker/back', '/worker/owner-set', '/worker/claim', '/worker/claim-state', '/worker/log', '/worker/switch',
  '/worker/fetch-start', '/worker/fetch-state', '/worker/fetch-stop', '/worker/dl-queue', '/worker/dl-cancel', '/worker/dl-again', '/worker/dl-clear',
  '/worker/runner-offer', '/worker/runner-put', '/worker/runner-state', '/worker/runner-drop', '/worker/runner-remove',
  '/worker/run-set', '/worker/model-remove', '/worker/ctx-set', '/worker/free',
  '/worker/update-offer', '/worker/update-put', '/worker/update-finish', '/worker/update-drop', '/worker/update-pin',
  '/worker/carry-files', '/worker/carry-get', '/worker/carry-offer', '/worker/carry-put', '/worker/carry-drop', '/worker/carry-sum',
  '/worker/backup-list', '/worker/backup-get', '/worker/backup-put',
  '/worker/git-files', '/worker/git-get', '/worker/git-have', '/worker/git-log', '/worker/git-commit', '/worker/git-put',
  '/worker/max-open', '/worker/cluster-test', '/worker/passes-put', '/worker/peer-put', '/worker/peer-hello', '/worker/peer-ping', '/worker/peer-copy', '/worker/pass-ask', '/worker/pass-answer', '/worker/power-off', '/worker/perm-set',
  '/worker/host-pin-set', '/worker/host-pin-drop', '/worker/drive-jobs', '/worker/models-where', '/worker/hardware-rescan',
  // A clip for a linked PC (src/videolink.ts): a host's only; a guest makes none.
  '/worker/video-make', '/worker/video-state', '/worker/video-get', '/worker/video-stop', '/worker/video-drop',
  // The admin PC sets and reads this PC's agents, and collects their reports (src/server/agents.ts).
  '/worker/agents',
];

export interface Refusal {
  status: number;
  error: string;
  guest: 'refused' | 'expired' | 'removed' | 'scope' | 'blocked';
  /** When the pass ended (for "expired"). */
  expired?: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/** The pass a guest link was made with, or undefined. */
export const passOf = (state: PassState, who: LinkRole) => (state.passes ?? []).find(p => p.id === who.passId);

/**
 * THE check, at every door a linked PC can call (and both Upgrade doors): null when this link may go on, else what to
 * answer. A link with no role is a link as before (null at every door). A guest: its pass must be here and not removed,
 * name this node, not have ended (the link's own end date too), and the door must be one of GUEST_DOORS.
 */
export function doorRefusal(state: PassState, who: LinkRole, door: string, now = Date.now()): Refusal | null {
  if (who.role === undefined) return null;
  const pc = state.name;
  if (who.role !== 'guest') return { status: 403, error: `"${pc}" does not know what this link may do. Link it again.`, guest: 'refused' };
  const pass = passOf(state, who);
  // Work already done for it can still be collected for a while after its pass ended (expired, or removed with a stamp).
  const collecting = (since: string | null | undefined) => COLLECT_DOORS.includes(door) && !!since && now - at(since) < COLLECT_MS;
  if (!pass || pass.revoked || !giverHere(state, pass)) return collecting(who.endedAt) ? null : { status: 401, error: 'that PC no longer knows this one (it was removed there, or set up again)', guest: 'removed' };
  if (!pass.nodes.includes(state.id)) return { status: 403, error: `your guest pass does not include "${pc}".`, guest: 'scope' };
  const ends = linkEnds(who, pass);
  if (ends && !(now < at(ends))) {
    // Expired, not removed: one thing more, a request to its host (one link that once had a pass, never a stranger).
    if (door === ASK_DOOR) return who.blocked ? { status: 403, error: `the owner of "${pc}" does not take requests from this PC.`, guest: 'blocked' } : null;
    if (collecting(ends)) return null;
    return { status: 403, error: `your guest pass on "${pc}" ended on ${day(ends)}. Ask its owner for a new one.`, guest: 'expired', expired: ends };
  }
  if (!GUEST_DOORS.includes(door)) return { status: 403, error: door === ASK_DOOR ? `your guest pass on "${pc}" has not ended: there is nothing to ask for.` : `a guest pass on "${pc}" does not allow that: only its models, and pulling TOMLIN updates.`, guest: 'refused' };
  return null;
}

/** When a guest link ends: its own date once renewed, else the earlier of its own and its pass's. Null: no end. */
export function linkEnds(who: LinkRole, pass: Pick<GuestPass, 'expires'>): string | null {
  if (who.renewed) return who.expires ?? null;
  return [who.expires ?? null, pass.expires].filter((x): x is string => !!x).sort((a, b) => at(a) - at(b))[0] ?? null;
}

/** A pass made here, or given by a host still linked here as an admin (a removed host's passes end with its link). */
function giverHere(state: PassState, pass: GuestPass): boolean {
  return !pass.by || (state.paired ?? []).some(l => l.role === undefined && linkKeep(l) === pass.by);
}

/** Whether the pair door may link a guest with this pass: live, for this node, made here or from a host still linked. */
export const passUsable = (state: PassState, pass: GuestPass, now = Date.now()) => passLive(pass, now) && pass.nodes.includes(state.id) && giverHere(state, pass);

/** The models a pass lets a guest use on node `nodeId`. */
export const passModels = (pass: GuestPass, nodeId: string) => pass.nodeModels?.[nodeId] ?? pass.models;

/** Whether this link may use model `id` here: any for a link with no role, only its pass's for a guest. */
export function modelAllowed(state: PassState, who: LinkRole, id: string | null | undefined): boolean {
  if (who.role === undefined) return true;
  const pass = passOf(state, who);
  return who.role === 'guest' && !!id && !!pass && !pass.revoked && giverHere(state, pass) && passModels(pass, state.id).includes(id);
}

/**
 * A new link joins the list: a link with no role as before (ten such links at most, the oldest goes); a guest's beside
 * them, never pushing one out (three per pass at most, its oldest goes). `dropped`: the names that went.
 */
export function addLink<T extends LinkRole & { name: string }>(paired: T[], entry: T): { paired: T[]; dropped: string } {
  let gone: T[];
  if (entry.role === undefined) {
    const hosts = paired.filter(x => x.role === undefined);
    gone = hosts.slice(0, Math.max(0, hosts.length - 9));
  } else {
    const same = paired.filter(x => x.role !== undefined && x.passId === entry.passId);
    gone = same.slice(0, Math.max(0, same.length - (LINKS_PER_PASS - 1)));
  }
  return { paired: [...paired.filter(x => !gone.includes(x)), entry], dropped: gone.map(x => x.name).join(', ') };
}

/** Remove: the pass keeps no key and leaves the page; the links made with it go. */
export function revokePass<T extends LinkRole>(passes: GuestPass[], paired: T[], id: unknown, now = Date.now()): { passes: GuestPass[]; paired: T[] } {
  return {
    passes: passes.map(p => (p.id === id && !p.revoked ? { ...p, key: '', revoked: true, rev: (p.rev || 1) + 1 } : p)),
    paired: stampEnded(paired, new Set([String(id)]), now),
  };
}

/** The guest links made with these passes, stamped as ended now (kept for the collect window, then dropped). */
export function stampEnded<T extends LinkRole>(paired: T[], passIds: Set<string>, now = Date.now()): T[] {
  return paired.map(x => (x.role !== undefined && passIds.has(x.passId ?? '') && !x.endedAt ? { ...x, endedAt: new Date(now).toISOString() } : x));
}

/** Guest links whose pass ended over COLLECT_MS ago: gone from the list. */
export function dropEnded<T extends LinkRole>(paired: T[], now = Date.now()): T[] {
  return paired.filter(x => !x.endedAt || now - at(x.endedAt) < COLLECT_MS);
}

/** A host's link removed here: the passes it gave end now, and their guests get the collect window. */
export function endGiver<T extends LinkRole>(passes: GuestPass[], paired: T[], keep: string, now = Date.now()): { passes: GuestPass[]; paired: T[] } {
  const ids = new Set(passes.filter(p => p.by === keep && !p.revoked).map(p => p.id));
  return {
    passes: passes.map(p => (ids.has(p.id) ? { ...p, key: '', revoked: true, rev: (p.rev || 1) + 1 } : p)),
    paired: stampEnded(paired, ids, now),
  };
}

/**
 * What the Network page is shown: one line each (no key), removed ones left out, ended ones marked. `from`: the name of
 * the host that gave it (null: made here), read from this PC's links.
 */
export function passView(passes: GuestPass[] | undefined, now = Date.now(), paired: { name: string; keep?: string; from?: string; hash: string; role?: string }[] = []) {
  return (passes ?? []).filter(p => !p.revoked).map(p => ({ id: p.id, label: p.label, length: p.length, created: p.created, expires: p.expires, lastSeen: p.lastSeen, uses: p.uses, models: p.models, nodes: p.nodes, nodeModels: p.nodeModels ?? null, renewals: (p.renewals ?? []).map(r => ({ pcName: r.pcName, name: r.name, until: r.until, live: r.until === null || now < at(r.until) })), from: p.by ? (paired.find(l => l.role === undefined && linkKeep(l) === p.by)?.name ?? 'a host no longer linked') : null, expired: passExpired(p, now) }));
}

/** Passes as read from share.json: one that is not whole is dropped; a removed one keeps no key. */
export function cleanPasses(raw: unknown): GuestPass[] {
  if (!Array.isArray(raw)) return [];
  const out: GuestPass[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const length = PASS_LENGTHS.find(l => l === o.length);
    const expires = o.expires === null ? null : typeof o.expires === 'string' && !Number.isNaN(Date.parse(o.expires)) ? o.expires : undefined;
    if (typeof o.id !== 'string' || !/^[0-9a-z]{8}$/.test(o.id) || !length || expires === undefined || typeof o.created !== 'string' || Number.isNaN(Date.parse(o.created))) continue;
    const revoked = o.revoked === true;
    const nm = o.nodeModels && typeof o.nodeModels === 'object' && !Array.isArray(o.nodeModels) ? Object.fromEntries(Object.entries(o.nodeModels as Record<string, unknown>).filter(([k]) => /^[0-9a-z]{8}$/.test(k)).slice(0, 50).map(([k, v]) => [k, cleanIds(v)])) : null;
    out.push({
      id: o.id, label: cleanLabel(o.label) || 'Guest', key: !revoked && typeof o.key === 'string' && /^[\w-]{43}$/.test(o.key) ? o.key : '', length, created: o.created, expires,
      nodes: cleanIds(o.nodes, 50), models: cleanIds(o.models), ...(nm ? { nodeModels: nm } : {}), uses: Math.max(0, Math.floor(Number(o.uses) || 0)),
      lastSeen: typeof o.lastSeen === 'string' && !Number.isNaN(Date.parse(o.lastSeen)) ? o.lastSeen : null, rev: Math.max(1, Math.floor(Number(o.rev) || 1)),
      ...(typeof o.by === 'string' && /^[\w-]{1,64}$/.test(o.by) ? { by: o.by } : {}), ...(revoked ? { revoked: true } : {}),
      ...(Array.isArray(o.renewals) ? { renewals: cleanRenewals(o.renewals) } : {}),
    });
  }
  return out;
}

/** Renewals as kept: whole ones only, 20 at most. */
function cleanRenewals(raw: unknown[]): Renewal[] {
  return raw.flatMap((x): Renewal[] => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at)) || !(o.until === null || (typeof o.until === 'string' && !Number.isNaN(Date.parse(o.until))))) return [];
    return [{ pc: typeof o.pc === 'string' && /^[0-9a-z]{8}$/.test(o.pc) ? o.pc : null, pcName: cleanLabel(o.pcName) || 'a PC', name: cleanLabel(o.name) || 'A guest PC', until: o.until as string | null, at: o.at }];
  }).slice(-20);
}

/** Notes that the pass was used now: true when that is worth saving (the first time, then once a minute at most). */
export function touchSeen(p: GuestPass, now = Date.now()): boolean {
  if (p.lastSeen && now - at(p.lastSeen) < 60_000) return false;
  p.lastSeen = new Date(now).toISOString();
  return true;
}

// ---- Phase 2: a host's passes copied to the nodes it is linked to (a backup node too) ----
// The host sends each node, over the sealed link, its whole set: every pass it made for that node (removed ones too),
// as that node sees it, with the host's table generation. The node keeps them as given by that host's link and acknowledges
// the generation; the host shows which nodes have the latest and sends again at each hello until they do. A node never
// passes on what it was given, and a node no host can reach still ends a pass at its own end date.

/** The next generation of a host's table: one more than the last, and never behind the clock (a fresh start goes on). */
export const nextGen = (prev: number | undefined, now = Date.now()) => Math.max((prev ?? 0) + 1, now);

/** What node `nodeId` is sent: the passes made here for it (removed ones too), with only its own models; no uses. */
export function syncSet(passes: GuestPass[] | undefined, nodeId: string): GuestPass[] {
  return (passes ?? []).filter(p => !p.by && p.nodes.includes(nodeId)).map(p => ({
    id: p.id, label: p.label, key: p.revoked ? '' : p.key, length: p.length, created: p.created, expires: p.expires,
    nodes: [nodeId], models: [...passModels(p, nodeId)], uses: 0, lastSeen: null, rev: p.rev || 1, ...(p.revoked ? { revoked: true } : {}),
  }));
}

/**
 * A node takes a host's set (`incoming`, from the admin link `by`, generation `gen`). An older generation than the last
 * taken from that host changes nothing (`stale`). Each record must be whole and for this node; one with the id of a pass
 * made here or given by another host is dropped. A record replaces the one kept only at a higher revision, so a removed
 * pass is never brought back by an older copy; this node's own uses and last seen are kept. `gone`: whether a giver's
 * link is no longer here (a host linked again under a new link takes over what its old link gave). A pass that host gave before
 * and no longer sends ends here. `taken`: the records that changed something.
 */
export function mergeFrom(local: GuestPass[], incoming: unknown, o: { by: string; gen: number; lastGen?: number; nodeId: string; gone?: (by: string) => boolean }): { passes: GuestPass[]; stale: boolean; taken: number } {
  if (o.lastGen !== undefined && o.gen < o.lastGen) return { passes: local, stale: true, taken: 0 };
  const sent = cleanPasses(Array.isArray(incoming) ? incoming.slice(0, MAX_FROM_HOST * 2) : []).filter(p => p.nodes.length === 1 && p.nodes[0] === o.nodeId && (p.revoked || !!p.key)).slice(0, MAX_FROM_HOST);
  let taken = 0;
  const out = local.map(p => ({ ...p }));
  for (const p of sent) {
    const i = out.findIndex(x => x.id === p.id);
    const kept = i >= 0 ? out[i] : undefined;
    // Another host's, or one made here: never taken over; one a link no longer here gave goes to the new giver.
    const orphan = !!kept?.by && kept.by !== o.by && o.gone?.(kept.by) === true;
    if (kept && kept.by !== o.by && !orphan) continue;
    if (kept && !orphan && p.rev <= kept.rev) continue;
    const next: GuestPass = { ...p, by: o.by, uses: kept?.uses ?? 0, lastSeen: kept?.lastSeen ?? null, ...(p.revoked ? { key: '' } : {}) };
    delete next.nodeModels;
    if (kept) out[i] = next;
    else out.push(next);
    taken++;
  }
  const ids = new Set(sent.map(p => p.id));
  for (const p of out) {
    if (p.by === o.by && !p.revoked && !ids.has(p.id)) {
      p.revoked = true;
      p.key = '';
      p.rev = (p.rev || 1) + 1;
      taken++;
    }
  }
  // Most kept from one host: its newest, removed ones last to stay.
  const mine = out.filter(p => p.by === o.by);
  const over = mine.length - MAX_FROM_HOST;
  const drop = new Set(over > 0 ? [...mine].sort((a, b) => Number(!a.revoked) - Number(!b.revoked) || at(a.created) - at(b.created)).slice(0, over) : []);
  return { passes: out.filter(p => !drop.has(p)), stale: false, taken };
}

// ---- Phase 3: an ended pass, the access request, collecting work, and the guest's pull ----

/** The door an expired guest link asks its host through; nothing else is open to it. */
export const ASK_DOOR = '/worker/pass-ask';
/** After a pass ends, its guest may still collect work already done (finished, or running for it) this long. */
export const COLLECT_MS = 2 * 3600_000;
/** The doors open to it then: where an answer is, taken, and Stop. Nothing new runs. */
export const COLLECT_DOORS: readonly string[] = ['/worker/result', '/worker/taken', '/worker/stop'];
/** A request is plain text of this many characters at most. */
export const ASK_TEXT_MAX = 200;
const ASK_GAP_MS = 10 * 60_000;
const ASK_DAY_MAX = 5;

/** A request from an expired guest link, kept on the node until its host answers (on its own screen). */
export interface PassAsk {
  id: string;
  /** The link's fingerprint (its token's hash). */
  link: string;
  /** The link's name, as the guest PC gave it. */
  name: string;
  passId: string;
  /** The host link that gave the pass (absent: made on the node itself): only that host is shown it, and answers it. */
  by?: string;
  /** When the pass ended. */
  expired: string;
  text: string;
  at: string;
  answer?: 'renewed' | 'denied' | 'blocked';
  reason?: string;
  length?: RenewLength;
  answeredAt?: string;
}

/** "Renew for", on the host's answer to a request: a number of days, or never expires. */
export const RENEW_LENGTHS = [
  { id: 'day', label: '1 day', days: 1 },
  { id: '2days', label: '2 days', days: 2 },
  { id: '3days', label: '3 days', days: 3 },
  { id: 'week', label: '1 week', days: 7 },
  { id: '2weeks', label: '2 weeks', days: 14 },
  { id: '30days', label: '30 days', days: 30 },
  { id: '90days', label: '90 days', days: 90 },
  { id: 'never', label: 'Never expires', days: null },
] as const;
export type RenewLength = typeof RENEW_LENGTHS[number]['id'];
/** A renew length as sent ('none' from an older page is Never expires), or undefined. */
export const cleanRenew = (v: unknown): RenewLength | undefined => (v === 'none' ? 'never' : RENEW_LENGTHS.find(x => x.id === v)?.id);

/** A guest link this PC renewed: on which PC (null: this one), the guest's name, and its new end (null: never). */
export interface Renewal {
  pc: string | null;
  pcName: string;
  name: string;
  until: string | null;
  at: string;
}

/** Notes on pass `passId` that a guest's link was renewed (the same guest on the same PC again: one line, the newer). */
export function noteRenewal(passes: GuestPass[], passId: unknown, r: Omit<Renewal, 'at'>, now = Date.now()): GuestPass[] {
  return passes.map(p => p.id !== passId ? p : { ...p, renewals: [...(p.renewals ?? []).filter(x => !(x.pc === r.pc && x.name === r.name)), { ...r, at: new Date(now).toISOString() }].slice(-20) });
}

/** A request's words: plain text (no markup, no control characters), spaces folded, 200 characters at most. */
export const cleanAskText = (v: unknown) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ASK_TEXT_MAX);

/** Why link `link` may not send a request now ('' when it may): one waiting at a time, 10 minutes apart, 5 a day. */
export function askWhy(asks: PassAsk[], link: string, now = Date.now()): string {
  const mine = asks.filter(a => a.link === link);
  if (mine.some(a => !a.answer)) return 'a request from this PC is already waiting for the owner';
  const last = Math.max(0, ...mine.map(a => at(a.answeredAt ?? a.at)));
  if (now - last < ASK_GAP_MS) return `wait ${Math.ceil((ASK_GAP_MS - (now - last)) / 60_000)} minutes before asking again`;
  if (mine.filter(a => now - at(a.at) < 86_400_000).length >= ASK_DAY_MAX) return `${ASK_DAY_MAX} requests were sent from this PC today: try again tomorrow`;
  return '';
}

/** What an expired guest is told beside its refusal: whether it may ask, and its last request's state. */
export function askState(asks: PassAsk[], who: LinkRole & { hash: string }): { canAsk: boolean; ask: { state: 'waiting' | 'denied' | 'blocked' | 'renewed'; at: string; reason: string } | null } {
  const last = asks.filter(a => a.link === who.hash).sort((a, b) => at(a.at) - at(b.at)).at(-1);
  return {
    canAsk: !who.blocked && !(last && !last.answer),
    ask: last ? { state: last.answer ?? 'waiting', at: last.at, reason: last.reason ?? '' } : null,
  };
}

/**
 * The host's answer to request `id`: renew (1 day, 1 week or no limit: the SAME link's end moves, so its guest types
 * nothing), deny (with a reason it is shown), or block (that link may not ask again).
 */
export function answerAsk<T extends LinkRole & { hash: string }>(asks: PassAsk[], paired: T[], id: unknown, a: { answer: unknown; length?: unknown; reason?: unknown }, now = Date.now()): { asks: PassAsk[]; paired: T[]; ask: PassAsk } | { error: string } {
  const q = asks.find(x => x.id === id);
  if (!q) return { error: 'That request is not here any more.' };
  if (q.answer) return { error: 'That request was answered already.' };
  const when = new Date(now).toISOString();
  const linkOf = (x: T) => x.role === 'guest' && x.hash === q.link;
  if (!paired.some(linkOf)) return { error: 'The PC that asked is not linked any more.' };
  let next: PassAsk;
  let links = paired;
  if (a.answer === 'renew') {
    const length = cleanRenew(a.length);
    if (!length) return { error: 'Pick how long to renew it for.' };
    const days = RENEW_LENGTHS.find(x => x.id === length)!.days;
    links = paired.map(x => (linkOf(x) ? { ...x, expires: days === null ? null : new Date(now + days * 86_400_000).toISOString(), renewed: true } : x));
    next = { ...q, answer: 'renewed', length, answeredAt: when };
  } else if (a.answer === 'deny') {
    next = { ...q, answer: 'denied', reason: cleanAskText(a.reason), answeredAt: when };
  } else if (a.answer === 'block') {
    links = paired.map(x => (linkOf(x) ? { ...x, blocked: true } : x));
    next = { ...q, answer: 'blocked', answeredAt: when };
  } else return { error: 'Answer with renew, deny or block.' };
  return { asks: asks.map(x => (x === q ? next : x)), paired: links, ask: next };
}

/** Requests kept on a node: the waiting ones, and answered ones for 7 days (the rate limit reads them); 200 at most. */
export function keepAsks(asks: PassAsk[], now = Date.now()): PassAsk[] {
  return asks.filter(a => !a.answer || now - at(a.answeredAt ?? a.at) < 7 * 86_400_000).slice(-200);
}

/** Requests as read from share.json: one that is not whole is dropped. */
export function cleanAsks(raw: unknown): PassAsk[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): PassAsk[] => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const ok = typeof o.id === 'string' && /^[0-9a-f]{8}$/.test(o.id) && typeof o.link === 'string' && /^[0-9a-f]{64}$/.test(o.link) && typeof o.passId === 'string' && typeof o.at === 'string' && typeof o.expired === 'string';
    if (!ok) return [];
    const answer = (['renewed', 'denied', 'blocked'] as const).find(v => v === o.answer);
    return [{ id: o.id as string, link: o.link as string, name: cleanLabel(o.name) || 'A guest PC', passId: String(o.passId).slice(0, 16), ...(typeof o.by === 'string' ? { by: o.by.slice(0, 64) } : {}), expired: o.expired as string, text: cleanAskText(o.text), at: o.at as string, ...(answer ? { answer } : {}), ...(typeof o.reason === 'string' ? { reason: cleanAskText(o.reason) } : {}), ...(cleanRenew(o.length) ? { length: cleanRenew(o.length) } : {}), ...(typeof o.answeredAt === 'string' ? { answeredAt: o.answeredAt } : {}) }];
  });
}

/** A version's numbers ("2.0.96" -> [2, 0, 96]); whether `a` is newer than `b`. */
const versionNewer = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/**
 * Why this PC may not take TOMLIN from linked PC `remote` ('' when it may, by these rules; the pull's own checks still
 * apply). From a guest network: only a newer version (never the same with other files, never older), and when this PC
 * is also linked to PCs as an admin (its home network), only when its owner chose this one. Any other link: as before.
 */
export function guestPullWhy(remote: { id: string; role?: string }, remotes: { id: string; role?: string }[], theirs: string, mine: string, chosen: boolean): string {
  if (remote.role !== 'guest') return '';
  if (!versionNewer(theirs, mine)) return `only a newer TOMLIN is taken from a network this PC is a guest on (it runs ${theirs || 'an older one'}, this PC ${mine})`;
  if (!chosen && remotes.some(r => r.id !== remote.id && r.role !== 'guest')) return 'this PC is also linked to its own PCs as their admin: choose to update from this guest network (press Update from it, and say yes)';
  return '';
}

/** What Search says about a PC it found, by this PC's link to it (none: not linked). */
export function foundState(r: { role?: string; expires?: string | null; passEnd?: { state: 'expired' | 'removed'; at: string } | null } | undefined, now = Date.now()): { state: 'new' | 'admin' | 'guest' | 'expired'; text: string } {
  if (!r || r.passEnd?.state === 'removed') return { state: 'new', text: 'Network found: enter the code' };
  if (r.role !== 'guest') return { state: 'admin', text: 'You are already connected (admin)' };
  if (r.passEnd?.state === 'expired') return { state: 'expired', text: 'Pass expired: ask the host' };
  if (!r.expires) return { state: 'guest', text: 'Connected as guest, no end date' };
  const ms = Math.max(0, at(r.expires) - now);
  const n = ms >= 20 * 3600_000 ? [Math.max(1, Math.round(ms / 86_400_000)), 'day'] as const : ms >= 3600_000 ? [Math.round(ms / 3600_000), 'hour'] as const : [Math.max(1, Math.round(ms / 60_000)), 'minute'] as const;
  return { state: 'guest', text: `Connected as guest, expires in ${n[0]} ${n[1]}${n[0] === 1 ? '' : 's'}` };
}
