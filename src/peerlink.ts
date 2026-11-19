// Peers: two PCs linked to the same host, allowed to call each other directly (docs/PLAN-2026-11-17-NODE-TO-NODE.md,
// section 3). The host introduces them: for "A may call B" it makes a token and 64 key bytes, sends A the token and the
// key, and sends B the token's hash and the key, each over the sealed link it already has to that PC. A PC never finds or
// accepts a peer by itself. A peer is NOT a linked PC: it is kept in its own lists, never in a PC's links, so nothing
// that reads links (staff, model lists, backups, the cluster set) ever sees one. Every request from a peer asks
// peerRefusal first; the door's own ticks (models, accept models, cluster) still apply after it.
// This file is the records and the check only, pure, tested in test/peerlink.test.ts. No door uses it yet.
import { randomBytes } from 'node:crypto';
import { linkKeep, type GuestPass } from './guestpass.ts';
import { keysOf, keysText } from './link.ts';
import { hashToken, isPrivateAddress } from './share.ts';

/** What a peer may be used for. */
export type PeerScope = 'copy' | 'runner' | 'cluster';
export const PEER_SCOPES: readonly PeerScope[] = ['copy', 'runner', 'cluster'];

/** A peer's ping: who it is talking to and whether it still may. Open to a live peer of any scope. */
export const PEER_HELLO = '/worker/peer-hello';

/** The doors a peer may call, by scope (exact names; anything else is refused, a door added later too). */
export const PEER_DOORS: Record<PeerScope, readonly string[]> = {
  copy: ['/worker/carry-files', '/worker/carry-get', '/worker/carry-sum', '/worker/carry-offer', '/worker/carry-put', '/worker/carry-drop'],
  runner: ['/worker/runner-offer', '/worker/runner-put', '/worker/runner-state', '/worker/runner-drop'],
  cluster: ['/worker/max-open', '/worker/cluster-test'],
};

/** Peer records one PC keeps from one host at most (each list). */
export const MAX_PEERS = 100;
/** Addresses kept for a peer at most. */
const MAX_ADDRS = 8;

/** One end of an introduction, as the host knows it. */
export interface PeerEnd {
  id: string;
  name: string;
  /** Its home-network addresses, as it last said them ("192.168.0.20"); the caller tries each. */
  addrs: string[];
  /** The port its link door answers on (8741 unless its owner changed it). */
  port?: number;
}

/** On the host: "`from` may call `to`". Kept whole so it can be sent again; a removed one keeps no token and no key. */
export interface Intro {
  id: string;
  from: PeerEnd;
  to: PeerEnd;
  token: string;
  key: string;
  scopes: PeerScope[];
  /** When it ends; null for no end. */
  expires: string | null;
  /** The guest pass it was made for, when there is one: it ends with that pass. */
  passId?: string;
  /** Goes up by one at each change: a PC never takes an older copy over a newer one. */
  rev: number;
  created: string;
  revoked?: boolean;
}

/** On the PC that answers: a peer that may call here. Only the token's hash is kept. */
export interface PeerIn {
  id: string;
  /** The calling PC's own id, and its name. */
  pc: string;
  name: string;
  hash: string;
  key: string;
  scopes: PeerScope[];
  expires: string | null;
  passId?: string;
  /** The admin link (its keep id) of the host that gave it: it counts only while that host is linked here. */
  by: string;
  rev: number;
  created: string;
  lastUsed: string | null;
  revoked?: boolean;
  /** Removed on this PC by its owner: the host cannot bring it back. */
  removedHere?: boolean;
}

/** On the PC that calls: a peer it may call. */
export interface PeerOut {
  id: string;
  pc: string;
  name: string;
  addrs: string[];
  port: number;
  token: string;
  key: string;
  scopes: PeerScope[];
  expires: string | null;
  passId?: string;
  by: string;
  rev: number;
  created: string;
  revoked?: boolean;
  removedHere?: boolean;
}

/** What one PC keeps: who may call it, and whom it may call. */
export interface PeerTable {
  in: PeerIn[];
  out: PeerOut[];
}
export const NO_PEERS: PeerTable = { in: [], out: [] };

const PC_ID = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const cleanName = (v: unknown) => String(v ?? '').replace(/[^\w .'()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanScopes = (v: unknown): PeerScope[] => PEER_SCOPES.filter(s => Array.isArray(v) && v.includes(s));
/** Home-network addresses only: one that points anywhere else is dropped, never called. */
/** A link door's port as said; 8741 (the usual one) when it is not a port. */
const cleanPort = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 ? (v as number) : 8741);
const cleanAddrs = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.length <= 45 && isPrivateAddress(x)))].slice(0, MAX_ADDRS);

/** A new introduction, `from` may call `to`: the record the host keeps. The two PCs must be different, with a scope. */
export function makeIntro(from: PeerEnd, to: PeerEnd, o: { scopes: unknown; expires?: string | null; passId?: string }, now = Date.now()): Intro | { error: string } {
  if (!PC_ID.test(from.id) || !PC_ID.test(to.id)) return { error: 'Both PCs must be linked to this one.' };
  if (from.id === to.id) return { error: 'A PC is not introduced to itself: pick two different PCs.' };
  const scopes = cleanScopes(o.scopes);
  if (!scopes.length) return { error: 'Pick what the two PCs may do together.' };
  if (o.expires != null && !isDate(o.expires)) return { error: 'That end date is not a date.' };
  const end = (e: PeerEnd): PeerEnd => ({ id: e.id, name: cleanName(e.name) || 'A PC', addrs: cleanAddrs(e.addrs), port: cleanPort(e.port) });
  return {
    id: randomBytes(4).toString('hex'), from: end(from), to: end(to), token: randomBytes(32).toString('hex'), key: keysText(randomBytes(64)),
    scopes, expires: o.expires ?? null, ...(o.passId ? { passId: String(o.passId).slice(0, 16) } : {}), rev: 1, created: new Date(now).toISOString(),
  };
}

/**
 * A PC's addresses or port as it says them now: every introduction that names it takes them, at a higher revision so the
 * PCs that call it are sent them. `changed`: whether anything did.
 */
export function moveEnd(intros: Intro[], end: PeerEnd): { intros: Intro[]; changed: boolean } {
  const addrs = cleanAddrs(end.addrs);
  const port = cleanPort(end.port);
  let changed = false;
  const same = (e: PeerEnd) => e.port === port && e.addrs.length === addrs.length && e.addrs.every(a => addrs.includes(a));
  const out = intros.map(x => {
    if (x.revoked || !addrs.length || (x.to.id !== end.id && x.from.id !== end.id)) return x;
    const side = x.to.id === end.id ? 'to' : 'from';
    if (same(x[side])) return x;
    changed = true;
    return { ...x, [side]: { ...x[side], addrs, port }, rev: x.rev + 1 };
  });
  return { intros: out, changed };
}

/** Remove on the host: the introduction keeps no token and no key, and each PC is told at its next send. */
export function revokeIntro(intros: Intro[], id: unknown): Intro[] {
  return intros.map(x => (x.id === id && !x.revoked ? { ...x, token: '', key: '', revoked: true, rev: x.rev + 1 } : x));
}

/** What PC `nodeId` is sent: its half of every introduction that names it (removed ones too, with nothing secret). */
export function peerSet(intros: Intro[] | undefined, nodeId: string): { in: Omit<PeerIn, 'by' | 'lastUsed'>[]; out: Omit<PeerOut, 'by'>[] } {
  const same = (x: Intro) => ({ id: x.id, scopes: [...x.scopes], expires: x.expires, ...(x.passId ? { passId: x.passId } : {}), rev: x.rev, created: x.created, ...(x.revoked ? { revoked: true } : {}) });
  const list = intros ?? [];
  return {
    in: list.filter(x => x.to.id === nodeId).map(x => ({ ...same(x), pc: x.from.id, name: x.from.name, hash: x.revoked ? '' : hashToken(x.token), key: x.revoked ? '' : x.key })),
    out: list.filter(x => x.from.id === nodeId).map(x => ({ ...same(x), pc: x.to.id, name: x.to.name, addrs: [...x.to.addrs], port: cleanPort(x.to.port), token: x.revoked ? '' : x.token, key: x.revoked ? '' : x.key })),
  };
}

/** A host's introductions as read from its saved file: one that is not whole, or was removed, is dropped. */
export function cleanIntros(raw: unknown): Intro[] {
  const end = (v: unknown): PeerEnd | null => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return typeof o.id === 'string' && PC_ID.test(o.id) ? { id: o.id, name: cleanName(o.name) || 'A PC', addrs: cleanAddrs(o.addrs), port: cleanPort(o.port) } : null;
  };
  return (Array.isArray(raw) ? raw : []).flatMap((x): Intro[] => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const from = end(o.from);
    const to = end(o.to);
    const scopes = cleanScopes(o.scopes);
    const expires = o.expires === null ? null : isDate(o.expires) ? o.expires : undefined;
    if (!from || !to || from.id === to.id || o.revoked === true || typeof o.id !== 'string' || !PC_ID.test(o.id) || typeof o.token !== 'string' || !HEX64.test(o.token) || !keysOf(o.key) || !scopes.length || expires === undefined || !isDate(o.created)) return [];
    return [{ id: o.id, from, to, token: o.token, key: o.key as string, scopes, expires, ...(typeof o.passId === 'string' && o.passId ? { passId: o.passId.slice(0, 16) } : {}), rev: Math.max(1, Math.floor(Number(o.rev) || 1)), created: o.created }];
  });
}

/** The part every record shares, read back; null when it is not whole. A removed one keeps no key. */
function cleanShared(o: Record<string, unknown>) {
  const expires = o.expires === null ? null : isDate(o.expires) ? o.expires : undefined;
  if (typeof o.id !== 'string' || !PC_ID.test(o.id) || typeof o.pc !== 'string' || !PC_ID.test(o.pc) || expires === undefined || !isDate(o.created)) return null;
  const revoked = o.revoked === true;
  const key = !revoked && keysOf(o.key) ? (o.key as string) : '';
  const scopes = cleanScopes(o.scopes);
  if (!revoked && (!key || !scopes.length)) return null;
  return {
    id: o.id, pc: o.pc, name: cleanName(o.name) || 'A PC', key, scopes, expires, ...(typeof o.passId === 'string' && o.passId ? { passId: o.passId.slice(0, 16) } : {}),
    by: typeof o.by === 'string' && /^[\w-]{1,64}$/.test(o.by) ? o.by : '', rev: Math.max(1, Math.floor(Number(o.rev) || 1)), created: o.created,
    ...(revoked ? { revoked: true } : {}), ...(o.removedHere === true ? { removedHere: true } : {}),
  };
}

/** A PC's peers as read from its saved file or as sent by a host: a record that is not whole is dropped. */
export function cleanPeers(raw: unknown): PeerTable {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { in?: unknown; out?: unknown };
  const rows = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const ins: PeerIn[] = [];
  for (const x of rows(o.in)) {
    const s = cleanShared(x);
    const hash = s && !s.revoked && typeof x.hash === 'string' && HEX64.test(x.hash) ? x.hash : '';
    if (!s || (!s.revoked && !hash)) continue;
    ins.push({ ...s, hash, lastUsed: isDate(x.lastUsed) ? x.lastUsed : null });
  }
  const outs: PeerOut[] = [];
  for (const x of rows(o.out)) {
    const s = cleanShared(x);
    const token = s && !s.revoked && typeof x.token === 'string' && HEX64.test(x.token) ? x.token : '';
    if (!s || (!s.revoked && !token)) continue;
    outs.push({ ...s, token, addrs: cleanAddrs(x.addrs), port: cleanPort(x.port) });
  }
  return { in: ins, out: outs };
}

/**
 * A PC takes a host's set (`incoming`, from the admin link `by`, generation `gen`). An older generation than the last
 * taken from that host changes nothing (`stale`). A record that names this PC as its own peer is dropped. One with the
 * id of a record another host gave is never taken over (unless that host's link is gone: `gone`). A record replaces
 * the one kept only at a higher revision, so a removed peer is never brought back by an older copy, and one the owner
 * removed here is never brought back at all. A peer that host gave before and no longer sends ends here.
 */
export function mergePeers(local: PeerTable, incoming: unknown, o: { by: string; gen: number; lastGen?: number; nodeId: string; gone?: (by: string) => boolean }): { peers: PeerTable; stale: boolean; taken: number } {
  if (o.lastGen !== undefined && o.gen < o.lastGen) return { peers: local, stale: true, taken: 0 };
  const sent = cleanPeers(incoming);
  let taken = 0;
  function merge<T extends PeerIn | PeerOut>(kept: T[], got: T[]): T[] {
    const out = kept.map(p => ({ ...p }));
    const mine = got.filter(p => p.pc !== o.nodeId).slice(0, MAX_PEERS);
    for (const p of mine) {
      const i = out.findIndex(x => x.id === p.id);
      const was = i >= 0 ? out[i] : undefined;
      const orphan = !!was && was.by !== o.by && o.gone?.(was.by) === true;
      if (was && was.by !== o.by && !orphan) continue;
      if (was?.removedHere) continue;
      if (was && !orphan && p.rev <= was.rev) continue;
      const next = { ...p, by: o.by, ...('lastUsed' in p ? { lastUsed: (was as PeerIn | undefined)?.lastUsed ?? null } : {}) } as T;
      delete next.removedHere;
      if (was) out[i] = next;
      else out.push(next);
      taken++;
    }
    const ids = new Set(mine.map(p => p.id));
    for (const p of out) {
      if (p.by === o.by && !p.revoked && !ids.has(p.id)) {
        Object.assign(p, ended(p));
        taken++;
      }
    }
    // Most kept from one host: the live ones first, then the newest removed.
    const theirs = out.filter(p => p.by === o.by);
    const over = theirs.length - MAX_PEERS;
    const drop = new Set(over > 0 ? [...theirs].sort((a, b) => Number(!a.revoked) - Number(!b.revoked) || at(a.created) - at(b.created)).slice(0, over) : []);
    return out.filter(p => !drop.has(p));
  }
  return { peers: { in: merge(local.in, sent.in), out: merge(local.out, sent.out) }, stale: false, taken };
}

/** A record ended: nothing secret is kept, and its revision goes up. */
function ended<T extends PeerIn | PeerOut>(p: T): T {
  return { ...p, key: '', ...('hash' in p ? { hash: '' } : { token: '' }), revoked: true, rev: p.rev + 1 };
}

/** The owner of this PC removes peer `id` here, at once: both directions with that id go, and the host cannot put them back. */
export function removeHere(table: PeerTable, id: unknown): PeerTable {
  const cut = <T extends PeerIn | PeerOut>(list: T[]) => list.map(p => (p.id === id && !p.removedHere ? { ...(p.revoked ? p : ended(p)), removedHere: true } : p));
  return { in: cut(table.in), out: cut(table.out) };
}

/** A host's link removed here: every peer it gave ends now. */
export function endPeerGiver(table: PeerTable, keep: string): PeerTable {
  const cut = <T extends PeerIn | PeerOut>(list: T[]) => list.map(p => (p.by === keep && !p.revoked ? ended(p) : p));
  return { in: cut(table.in), out: cut(table.out) };
}

/** The peer a link fingerprint (the token's hash) names here, or undefined. Removed ones have no hash and never match. */
export const peerByHash = (table: PeerTable, hash: string | undefined) => (hash && HEX64.test(hash) ? table.in.find(p => !!p.hash && p.hash === hash) : undefined);

/** What the check needs to know about this PC. */
export interface PeerState {
  id: string;
  name: string;
  /** The owner's tick "Let PCs my host introduces connect to this PC directly". */
  allowPeers: boolean;
  /** This PC's links: a peer counts only while the host that gave it is linked here as an admin. */
  paired?: { role?: string; keep?: string; from?: string; hash: string }[];
  /** This PC's guest passes: a peer made for a pass ends with it. */
  passes?: Pick<GuestPass, 'id' | 'expires' | 'revoked' | 'nodes'>[];
}

export interface PeerRefusal {
  status: number;
  error: string;
  peer: 'removed' | 'off' | 'network' | 'ended' | 'scope' | 'refused';
}

/**
 * THE check, at every request from a peer (and again while a long stream stays open): null when it may go on, else what
 * to answer. `from` is the address the request came from. A pass's copy on a PC names only that PC, so which other PCs
 * a pass covers is said by the peer record itself, which only the host that made the pass can give.
 */
export function peerRefusal(state: PeerState, peer: PeerIn | undefined, door: string, from: string | undefined, now = Date.now()): PeerRefusal | null {
  const pc = state.name;
  const gone: PeerRefusal = { status: 401, error: 'that PC no longer knows this one (it was removed there, or its host is no longer linked there)', peer: 'removed' };
  if (!peer || peer.revoked || !peer.hash || !keysOf(peer.key)) return gone;
  if (!(state.paired ?? []).some(l => l.role === undefined && linkKeep(l) === peer.by)) return gone;
  if (!state.allowPeers) return { status: 403, error: `the owner of "${pc}" has not ticked "Let PCs my host introduces connect to this PC directly".`, peer: 'off' };
  if (!isPrivateAddress(from)) return { status: 403, error: `"${pc}" only answers PCs on its own home network.`, peer: 'network' };
  if (peer.expires !== null && !(now < at(peer.expires))) return { status: 403, error: `the direct link to "${pc}" has ended.`, peer: 'ended' };
  if (peer.passId) {
    const pass = (state.passes ?? []).find(p => p.id === peer.passId);
    if (!pass || pass.revoked) return gone;
    if (!pass.nodes.includes(state.id)) return { status: 403, error: `the guest pass this direct link was made for does not include "${pc}".`, peer: 'scope' };
    if (pass.expires !== null && !(now < at(pass.expires))) return { status: 403, error: `the guest pass this direct link to "${pc}" was made for has ended.`, peer: 'ended' };
  }
  if (door !== PEER_HELLO && !peer.scopes.some(s => PEER_DOORS[s].includes(door))) return { status: 403, error: `the direct link to "${pc}" does not allow that.`, peer: 'refused' };
  return null;
}

/** Notes that the peer was used now: true when that is worth saving (the first time, then once a minute at most). */
export function touchPeer(p: PeerIn, now = Date.now()): boolean {
  if (p.lastUsed && now - at(p.lastUsed) < 60_000) return false;
  p.lastUsed = new Date(now).toISOString();
  return true;
}
