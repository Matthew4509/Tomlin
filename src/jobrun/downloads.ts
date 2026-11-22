// Every PC's downloads list in one window (src/dlqueue.ts): this PC's and each linked PC's (not a guest's), each line
// with its PC, "56%" or "pending", and Cancel. Each PC keeps and works through its own list, so this PC only shows it
// and passes Cancel on. And the Model store filled from here: a model goes into the store pool (Network page), on the
// drive with the most room (Spread) or on two drives on two different PCs (Mirror), each PC downloading it itself.
import * as dj from '../drivejobs.ts';
import type { DlLine } from '../dlqueue.ts';
import { SPARE } from '../modelhome.ts';
import type { Remote } from '../store.ts';
import { d } from './shared.ts';
import { remoteStatus } from './links.ts';
import { wireFor } from './copies.ts';
import { storageView } from './storage.ts';

export interface PcDownloads {
  pc: string;
  pcName: string;
  ok: boolean;
  /** Why its list is not shown ('' when it is): off, or an older TOMLIN with no list. */
  why: string;
  lines: DlLine[];
}

/** A linked PC's list as it said it last: shown, marked, while it does not answer. */
const lastSaid = new Map<string, DlLine[]>();
/** A list asked for takes this long at most: the window is drawn without the PCs that are slow to answer. */
const ASK_MS = 4000;

const inTime = <T>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('did not answer in time')), ASK_MS))]);
const linesOf = (v: unknown): DlLine[] => (Array.isArray((v as { lines?: unknown })?.lines) ? ((v as { lines: DlLine[] }).lines) : []);

/** GET /api/network/downloads: this PC's list, then each linked PC's. */
export async function downloadsView(): Promise<{ pcs: PcDownloads[] }> {
  const here = await d.fetch('/worker/dl-queue', {}, 'This PC');
  const mine: PcDownloads = { pc: 'here', pcName: 'This PC', ok: true, why: '', lines: linesOf(here.json) };
  const s = await d.store.settings();
  const status = await remoteStatus({ known: true });
  const others = await Promise.all(status.filter(r => r.role !== 'guest').map(async (r): Promise<PcDownloads> => {
    const remote = s.remotes.find(x => x.id === r.id);
    const can = r.ok && 'can' in r && Array.isArray(r.can) ? r.can : null;
    if (remote && r.ok && can?.includes('dl-queue')) {
      try {
        const lines = linesOf(await inTime(wireFor(remote).ask('/worker/dl-queue', {})));
        lastSaid.set(r.id, lines);
        return { pc: r.id, pcName: r.name, ok: true, why: '', lines };
      } catch {
        // Said below as not answering, with its last list.
      }
    }
    const why = r.ok && can && !can.includes('dl-queue') ? 'Runs an older TOMLIN with no downloads list: update it to see one here.' : 'Not answering now: its list as it was last seen. It carries on by itself while it is on.';
    return { pc: r.id, pcName: r.name, ok: false, why, lines: lastSaid.get(r.id) ?? [] };
  }));
  return { pcs: [mine, ...others.filter(p => p.lines.length || p.ok)] };
}

const linked = async (pc: unknown): Promise<Remote | { error: string; status: number }> => {
  const r = (await d.store.settings()).remotes.find(x => x.id === pc);
  if (!r) return { status: 404, error: 'That PC is not linked to this one any more. Open Network to link it again.' };
  if (r.role === 'guest') return { status: 403, error: 'You are a guest on that PC: its downloads are its owner\'s.' };
  return r;
};

const DOORS = { cancel: '/worker/dl-cancel', again: '/worker/dl-again', clear: '/worker/dl-clear' } as const;

/** POST /api/network/download-line { pc, id, act: 'cancel' | 'again' | 'clear' }: passed on to that PC's list. */
export async function downloadLineOn(b: Record<string, unknown>) {
  const act = b.act === 'cancel' || b.act === 'again' || b.act === 'clear' ? b.act : null;
  if (!act) return { status: 400, body: { error: 'Choose Cancel, Download again or Clear.' } };
  const ask = { id: String(b.id ?? '') };
  if (b.pc === 'here' || !b.pc) {
    const a = await d.fetch(DOORS[act], ask, 'This PC');
    return { status: a.status, body: a.json };
  }
  const r = await linked(b.pc);
  if ('error' in r) return { status: r.status, body: { error: r.error } };
  try {
    return { status: 200, body: await wireFor(r).ask(DOORS[act], ask) };
  } catch (e) {
    const { status, said } = e as { status?: number; said?: string };
    return { status: status === 404 ? 404 : 409, body: { error: said ?? `"${r.name}" did not answer: ${(e as Error).message}` } };
  }
}

/** A drive of the store pool a model could go to: on a PC that answers, with room for it and 2 GB more. */
interface Spot { pc: string; pcName: string; drive: string; free: number }

/**
 * Where a model of `bytes` goes in the store pool: Spread, the one drive with the most room; Mirror, the two drives with
 * the most room on two different PCs. Pure (tested in test/dlqueue.test.ts).
 */
export function storeSpots(mode: dj.Mode, drives: Spot[], bytes: number): Spot[] | string {
  const fits = drives.filter(x => x.free >= bytes + SPARE).sort((a, b) => b.free - a.free);
  if (mode === 'spread') return fits.length ? [fits[0]] : drives.length ? 'No drive in Main model storage has room for it (with 2 GB left free). Add another drive to Main model storage under Network Storage, or free some space.' : 'Main model storage has no drive yet. Add one under Network Storage first: + Add under Main model storage.';
  const first = fits[0];
  const second = first && fits.find(x => x.pc !== first.pc);
  if (first && second) return [first, second];
  if (new Set(drives.map(x => x.pc)).size < 2) return 'Main model storage is set to Duplicate, which keeps two copies on two different PCs, and its drives are all on one PC. Add a drive on another PC, or set Main model storage to Extended under Network Storage.';
  return 'Main model storage is set to Duplicate, and no two drives on two different PCs both have room for it (with 2 GB left free). Free some space, or add a drive.';
}

/** POST /api/network/store-get { repo, rev, name, bytes }: the model goes into the Model store, each PC downloading its copy. */
export async function storeGetOn(b: Record<string, unknown>) {
  const repo = String(b.repo ?? '');
  const name = String(b.name ?? '');
  const bytes = Number(b.bytes) > 0 ? Number(b.bytes) : 0;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !name || !bytes) return { status: 400, body: { error: 'Choose a model to keep in Main model storage.' } };
  const view = await storageView();
  const pool = view.pools.find(p => p.job === 'store')!;
  const canGet = new Set(view.pcs.filter(p => p.here || (p.ok && p.may.store)).map(p => p.id));
  const status = await remoteStatus({ known: true });
  const listed = new Set(status.filter(r => r.ok && 'can' in r && Array.isArray(r.can) && r.can.includes('dl-queue')).map(r => r.id));
  const spots = pool.drives.filter(x => x.ok && canGet.has(x.pc) && (x.pc === 'here' || listed.has(x.pc))).map(x => ({ pc: x.pc, pcName: x.pcName, drive: x.drive, free: x.free }));
  const picked = storeSpots(pool.mode, spots, bytes);
  if (typeof picked === 'string') return { status: 409, body: { error: picked } };
  const ask = { kind: 'chat', repo, rev: String(b.rev ?? 'main'), name, to: 'store' };
  const done: string[] = [];
  const faults: string[] = [];
  for (const x of picked) {
    try {
      if (x.pc === 'here') {
        const a = await d.fetch('/worker/fetch-start', { ...ask, drive: x.drive }, 'This PC');
        if (a.status !== 200) throw Object.assign(new Error(String(a.json.error ?? 'it was not added')), { said: String(a.json.error ?? '') });
      } else {
        const r = await linked(x.pc);
        if ('error' in r) throw new Error(r.error);
        await wireFor(r).ask('/worker/fetch-start', { ...ask, drive: x.drive });
      }
      done.push(`${x.pcName} ${x.drive}`);
    } catch (e) {
      faults.push(`${x.pcName} ${x.drive}: ${(e as { said?: string }).said || (e as Error).message}`);
    }
  }
  if (!done.length) return { status: 409, body: { error: `${name} was not added to Main model storage. ${faults.join(' ')}` } };
  const said = `${name} is in the downloads list of ${done.join(' and ')}${pool.mode === 'mirror' && done.length === 2 ? ' (two copies, Duplicate)' : ''}.${faults.length ? ` Not added on ${faults.join(' ')}` : ''}`;
  return { status: 200, body: { said } };
}
