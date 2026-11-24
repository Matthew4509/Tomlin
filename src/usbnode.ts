// A PC started from a Bootable USB stick (Settings, Bootable USB): Debian on the stick runs this same TOMLIN as a node.
// The stick's tomlin\tomlin-node.json, written by Mint (src/usbmint.ts), says who its admin is. At every start it is
// read (TOMLIN_USB_NODE names it: stick/start.sh sets it) and laid over share.json: node mode on, the admin's public key,
// and the ticks the admin chose at Mint. What the node's owner set since (its name, a PIN) is kept. The stick's own key
// pair (src/adminkey.ts) is read from the stick at every start and never copied into share.json.
import { readFileSync } from 'node:fs';
import * as adminkey from './adminkey.ts';
import { cleanAllow, type Allow } from './carry.ts';
import type { ShareState } from './share.ts';

/** What Mint writes onto a stick (tomlin\tomlin-node.json). */
export interface StickConfig {
  /** The format, so an older TOMLIN can refuse a newer stick plainly. 1 (one shared admin key) is no longer read. */
  v: 2;
  /** The admin's public key: only the PC holding its private half can link to this stick. */
  adminPub: string;
  /** This stick's own identity: its id and key pair, made at Mint for this stick alone. */
  stick: adminkey.StickIdentity;
  /** The admin PC's name, shown on the node's screen ("Waiting for <admin>"). */
  admin: string;
  /** The name a node takes the first time, before anyone renames it ("USB node", then its own number). */
  name: string;
  /** The ticks a minted node starts with (Sharing permissions). */
  allow: Allow;
  /** "Allow unencrypted cluster links" on the node (Mint's tick). */
  plainLinks: boolean;
  /** The link port (8741 unless changed). */
  port: number;
  /** When it was minted, and by which TOMLIN. */
  minted: string;
  version: string;
}

/** What a minted node may do at first, unless the admin unticks it at Mint: take models, be tested, lend, be turned off. */
export const STICK_ALLOW: Allow = { pull: false, backup: false, update: false, tune: true, lend: true, receive: true, give: false, off: true };

/** A stick config made safe: null when it is not one (no key, or a newer format). */
export function cleanStick(raw: unknown): StickConfig | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.v !== 2) return null;
  const adminPub = adminkey.cleanPub(o.adminPub);
  const stick = adminkey.cleanIdentity(o.stick);
  if (!adminPub || !stick) return null;
  const text = (v: unknown, max: number, dflt: string) => String(v ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, max) || dflt;
  const port = Number(o.port);
  return {
    v: 2,
    adminPub,
    stick,
    admin: text(o.admin, 40, 'the admin PC'),
    name: text(o.name, 40, 'USB node'),
    allow: o.allow && typeof o.allow === 'object' ? cleanAllow(o.allow) : { ...STICK_ALLOW },
    plainLinks: o.plainLinks === true,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8741,
    minted: text(o.minted, 40, ''),
    version: text(o.version, 20, ''),
  };
}

/** The stick's config, read from the file TOMLIN_USB_NODE names, or null (not a stick, or no readable config). */
export function readStick(env: NodeJS.ProcessEnv = process.env): StickConfig | null {
  const file = env.TOMLIN_USB_NODE;
  if (!file) return null;
  try {
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return cleanStick(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * share.json with the stick laid over it. Node mode is always on (a stick node is nothing else). One admin per stick:
 * minted again by another admin, the old admin's links are dropped, so the old admin PC can no longer reach it. The name
 * and the ticks are set only the first time (`fresh`: no share.json yet), so what the admin changes later over the link
 * stays.
 */
export function applyStick(state: ShareState, stick: StickConfig, fresh: boolean): ShareState {
  const newAdmin = !!state.adminPub && state.adminPub !== stick.adminPub;
  const { adminKeys: _gone, ...rest } = state as ShareState & { adminKeys?: unknown };
  return {
    ...rest,
    on: true,
    usbNode: true,
    adminPub: stick.adminPub,
    ...(newAdmin ? { paired: (state.paired ?? []).filter(x => x.byKey !== true) } : {}),
    ...(fresh ? { name: stick.name, allow: { ...stick.allow }, plainLinks: stick.plainLinks, port: stick.port } : {}),
  };
}
