// The admin PC's side of Bootable USB (Settings): its admin key pair, every stick it minted (each with its own id and
// public key, the PC it linked as, when last seen, and whether it is marked lost), and the best run settings found for
// each kind of hardware its nodes have (so an identical PC, a twin, starts with them). Kept in usb.json in TOMLIN's
// data folder, which is never in a restore point sent to another PC. The private key never leaves this PC.
import * as adminkey from './adminkey.ts';

/** One kind of hardware: the same processor, RAM size (to 4 GB) and cards. */
export interface HardwareKind {
  /** The fingerprint (hardwareKind below). */
  kind: string;
  /** In words: "Xeon E5-2670 x2 · 256 GB · RTX 3060 12 GB". */
  label: string;
  /** The nodes seen with it (their link ids) and when last. */
  pcs: string[];
  /** The best settings found for a model on this kind, by model file name. */
  best: Record<string, KindBest>;
}

export interface KindBest {
  /** The PC it was measured on (link id; 'here' for this PC) and when. */
  pc: string;
  at: string;
  /** Writing speed, tokens a second. */
  tps: number;
  /** The run settings that gave it (src/runset.ts keys: layers on the card, threads, flash attention, ...). */
  settings: Record<string, unknown>;
}

/** One stick this admin minted. */
export interface StickRecord {
  /** The stick's id (16 hex) and its public key: the admin links only to a node that proves this key. */
  id: string;
  pub: string;
  /** When it was minted, onto which drive, as which node name. */
  at: string;
  drive: string;
  name: string;
  /** The link id of the PC started from it, once linked. */
  pc?: string;
  /** When this PC last heard from it (linked and answering, or found by a scan). */
  lastSeen?: string;
  /** Marked lost: never linked again, and its link here is removed. */
  lost?: boolean;
}

export interface UsbRecords {
  /** The admin key pair; null until made. Its private half never leaves this PC. */
  key: adminkey.KeyPair | null;
  made: string;
  /** Every stick minted from this PC with this key, oldest first. */
  sticks: StickRecord[];
  kinds: HardwareKind[];
}

/** Its file in TOMLIN's data folder. */
export const FILE = 'usb.json';

export const EMPTY: UsbRecords = { key: null, made: '', sticks: [], kinds: [] };

/** A stick on the list that may link: known and not marked lost. Its public key, or ''. */
export const stickPubOf = (r: UsbRecords, id: string): string => r.sticks.find(s => s.id === id && !s.lost)?.pub ?? '';

/** The records with one stick changed (nothing when it is not on the list). */
export const withStick = (r: UsbRecords, id: string, change: Partial<StickRecord>): UsbRecords => ({ ...r, sticks: r.sticks.map(s => (s.id === id ? { ...s, ...change } : s)) });

/** usb.json made safe. A key or stick that is not whole is dropped (a shared key from 2.1.18 and before is one). */
export function cleanRecords(raw: unknown): UsbRecords {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max = 80) => String(v ?? '').slice(0, max);
  const when = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v.slice(0, 40) : undefined);
  const sticks = (Array.isArray(o.sticks) ? o.sticks : []).slice(-adminkey.KEY_PCS).flatMap((s): StickRecord[] => {
    const id = adminkey.cleanStickId(s?.id);
    const pub = adminkey.cleanPub(s?.pub);
    if (!id || !pub) return [];
    const pc = typeof s.pc === 'string' && /^[0-9a-f]{8}$/.test(s.pc) ? s.pc : undefined;
    const lastSeen = when(s.lastSeen);
    return [{ id, pub, at: str(s.at, 40), drive: str(s.drive, 8), name: str(s.name, 40), ...(pc ? { pc } : {}), ...(lastSeen ? { lastSeen } : {}), ...(s.lost === true ? { lost: true } : {}) }];
  });
  const kinds = (Array.isArray(o.kinds) ? o.kinds : []).slice(0, 200).flatMap((k): HardwareKind[] => {
    if (!k || typeof k.kind !== 'string' || !k.kind) return [];
    const best: Record<string, KindBest> = {};
    for (const [model, b] of Object.entries(k.best && typeof k.best === 'object' ? k.best : {})) {
      const v = b as Record<string, unknown>;
      const tps = Number(v?.tps);
      if (!Number.isFinite(tps) || tps <= 0) continue;
      best[str(model, 200)] = { pc: str(v.pc, 16), at: str(v.at, 40), tps, settings: v.settings && typeof v.settings === 'object' ? (v.settings as Record<string, unknown>) : {} };
    }
    return [{ kind: str(k.kind, 200), label: str(k.label, 200), pcs: (Array.isArray(k.pcs) ? k.pcs : []).map((p: unknown) => str(p, 16)).filter(Boolean).slice(0, adminkey.KEY_PCS), best }];
  });
  return { key: adminkey.cleanPair(o.key), made: str(o.made, 40), sticks, kinds };
}

/** What a PC's hardware reading needs for its kind. */
export interface KindFacts {
  cpu?: { name?: string; cores?: number; sockets?: number } | null;
  ramBytes?: number;
  cards?: { name?: string; vram?: number }[];
}

const GB = 2 ** 30;

/**
 * A PC's kind of hardware: the processor, the RAM rounded to 4 GB (two of the same box may read a little apart) and the
 * cards with their memory, in a fixed order. Two PCs of one kind are twins: the best settings of one suit the other.
 */
export function hardwareKind(f: KindFacts): { kind: string; label: string } {
  const cpu = String(f.cpu?.name ?? 'unknown processor').replace(/\((R|TM)\)/gi, '').replace(/\s*@.*$/, '').replace(/\bCPU\b/gi, '').replace(/\s+/g, ' ').trim();
  const sockets = Number(f.cpu?.sockets) > 1 ? ` x${Number(f.cpu?.sockets)}` : '';
  const ram = Math.max(0, Math.round((Number(f.ramBytes) || 0) / (4 * GB)) * 4);
  const cards = (f.cards ?? []).map(c => `${String(c.name ?? 'card').replace(/^NVIDIA\s+|^AMD\s+|^Intel\(R\)\s+/i, '').trim()} ${Math.round((Number(c.vram) || 0) / GB)} GB`).sort();
  const label = [`${cpu}${sockets}`, `${ram} GB`, ...cards].join(' · ');
  return { kind: label.toLowerCase(), label };
}

/** The records with a PC counted under its kind (moved from another kind if its hardware changed). */
export function notePc(r: UsbRecords, pc: string, facts: KindFacts): UsbRecords {
  const { kind, label } = hardwareKind(facts);
  const kinds = r.kinds.map(k => ({ ...k, pcs: k.pcs.filter(p => p !== pc || k.kind === kind) }));
  const at = kinds.find(k => k.kind === kind);
  if (at) {
    if (!at.pcs.includes(pc)) at.pcs.push(pc);
  } else kinds.push({ kind, label, pcs: [pc], best: {} });
  return { ...r, kinds };
}

/** A measured speed kept for its kind when it beats the best so far for that model (or the best was measured with the same settings). */
export function noteBest(r: UsbRecords, facts: KindFacts, model: string, run: KindBest): { records: UsbRecords; better: boolean } {
  const withPc = notePc(r, run.pc, facts);
  const { kind } = hardwareKind(facts);
  const k = withPc.kinds.find(x => x.kind === kind)!;
  const was = k.best[model];
  const same = was && JSON.stringify(was.settings) === JSON.stringify(run.settings);
  if (was && !same && was.tps >= run.tps) return { records: withPc, better: false };
  k.best[model] = run;
  return { records: withPc, better: true };
}

/** The best settings known for a PC's kind and a model, and whether that PC is a twin (measured on another PC). */
export function bestFor(r: UsbRecords, facts: KindFacts, model: string, pc: string): { best: KindBest; twin: boolean } | null {
  const { kind } = hardwareKind(facts);
  const b = r.kinds.find(x => x.kind === kind)?.best[model];
  return b ? { best: b, twin: b.pc !== pc } : null;
}

/** A twin under this share of its kind's best speed is flagged: bad RAM, a hot card or the wrong driver, usually. */
export const TWIN_SLOW = 0.85;
export const twinSlow = (best: number, got: number) => best > 0 && got < best * TWIN_SLOW;
