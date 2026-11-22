// The Network page's storage, this PC's side (src/drivejobs.ts): every PC's drives with their jobs, the two pools
// (Model store, Backups) measured, and the doors that set a drive's job (here, or on a linked PC with its owner's
// tick) and a pool's Spread or Mirror. Guests are left out: a guest's host tells it nothing about its drives.
import * as brains from '../brains.ts';
import * as dj from '../drivejobs.ts';
import { drives, drivesKnown, driveOf } from '../modelhome.ts';
import { d } from './shared.ts';
import { lastHello, remoteStatus } from './links.ts';
import { wireFor } from './copies.ts';

interface PcDrive { drive: string; label: string; total: number; free: number; jobs: dj.Job[] }
interface PcStorage {
  id: string;
  name: string;
  here: boolean;
  ok: boolean;
  /** Not ok, but it did answer (and refused): not the same as off. */
  answered?: boolean;
  /** On, but it answered only the longer check (src/jobrun/links.ts checkSlow): busy, or a disk waking. */
  slow?: boolean;
  /** The drive the PC's models run from ('' when not known). */
  modelsDrive: string;
  drives: PcDrive[];
  /** Which jobs this PC may be given from here: always both on this PC; on a linked PC, its owner's ticks. */
  may: Record<dj.Job, boolean>;
  /** Why its drives cannot be given jobs from here ('' when they can). */
  why: string;
  /** Why which drive its new models go to cannot be picked from here ('' when it can: always so on this PC). */
  modelsWhy: string;
}

/**
 * A drive set from here keeps what was set until that PC's next hello says it (the hello in hand can be a few seconds
 * old). Kept per PC and drive, for a minute at most.
 */
const justSet = new Map<string, { jobs: dj.Job[]; at: number }>();
const SET_KEEP_MS = 60_000;
/** The same for a linked PC's models drive picked from here: kept until its hello says it, a minute at most. */
const modelsSet = new Map<string, { drive: string; at: number }>();
const modelsDriveOf = (pc: string, said: string): string => {
  const s = modelsSet.get(pc);
  return s && Date.now() - s.at < SET_KEEP_MS ? s.drive : said;
};
const withSet = (pc: string, x: PcDrive): PcDrive => {
  const s = justSet.get(`${pc}|${x.drive}`);
  return s && Date.now() - s.at < SET_KEEP_MS ? { ...x, jobs: s.jobs } : x;
};

/** This PC's drives: as last read, read again behind (a reading takes Windows a few seconds); the first time, read now. */
async function drivesHere() {
  if (!drivesKnown().length) return drives().catch(() => []);
  void drives().catch(() => []);
  return drivesKnown();
}

async function pcsNow(): Promise<PcStorage[]> {
  const s = await d.store.settings();
  const labels = brains.pcLabels(s.remotes);
  const mine = dj.jobsHere();
  const here: PcStorage = {
    id: 'here', name: 'This PC', here: true, ok: true, modelsDrive: driveOf(d.carry.chatDir),
    drives: (await drivesHere()).map(x => withSet('here', { drive: x.drive, label: x.label, total: x.total, free: x.free, jobs: mine[x.drive] ?? [] })),
    may: { store: true, backups: true }, why: '', modelsWhy: '',
  };
  const status = await remoteStatus();
  const others = status.filter(r => r.role !== 'guest').map((r): PcStorage => {
    const h = lastHello(r.id);
    const ok = r.ok === true;
    const hd = ((ok && 'drives' in r ? r.drives : h?.drives) ?? []) as PcDrive[];
    const allow = ok && 'allow' in r ? r.allow : null;
    const can = ok && 'can' in r && Array.isArray(r.can) ? r.can : [];
    // Off is said apart from answered-but-refused (its link no longer there, or another fault): the second is not fixed
    // by switching it on, so its own words are shown.
    const answered = !ok && 'answered' in r && r.answered === true;
    const off = answered ? `It answered but did not let this PC in: ${'error' in r && r.error ? String(r.error) : 'no reason given'}` : 'Not answering now';
    const why = !ok ? off : !can.includes('drive-jobs') ? 'Runs an older TOMLIN: update it to give its drives a job' : '';
    const modelsWhy = !ok ? off : !can.includes('models-where') ? 'Runs an older TOMLIN: update it to pick its models drive from here'
      : allow?.receive !== true ? 'Its owner has not ticked "Accept models from linked PCs"' : '';
    return {
      id: r.id, name: labels[r.id] ?? r.name, here: false, ok, answered, slow: ok && 'slow' in r && r.slow === true,
      modelsDrive: modelsDriveOf(r.id, (ok && 'modelsDrive' in r ? r.modelsDrive : h?.modelsDrive) ?? ''),
      drives: hd.map(x => withSet(r.id, { drive: x.drive, label: x.label, total: x.total, free: x.free, jobs: dj.cleanJobList(x.jobs) })),
      may: { store: allow?.receive === true, backups: allow?.backup === true }, why, modelsWhy,
    };
  });
  return [here, ...others];
}

/** GET /api/network/storage: the PCs with their drives, and the two pools. */
export async function storageView() {
  const pcs = await pcsNow();
  const modes = dj.poolsHere();
  const pools = dj.JOBS.map(job => {
    const members = pcs.flatMap(p => p.drives.filter(x => x.jobs.includes(job)).map(x => ({ pc: p.id, pcName: p.name, drive: x.drive, label: x.label, total: x.total, free: x.free, ok: p.ok })));
    const v = dj.poolView(job, modes[job].mode, members);
    return { ...v, line: dj.poolLine(v) };
  });
  return { pcs, pools };
}

/** POST /api/network/drive-jobs { pc: 'here' | a linked PC's id, drive, jobs: ['store' | 'backups'] }. */
export async function driveJobsOn(b: Record<string, unknown>) {
  const drive = String(b.drive ?? '').toUpperCase();
  const jobs = dj.cleanJobList(b.jobs);
  if (!/^[A-Z]:$/.test(drive)) return { status: 400, body: { error: 'Choose a drive first.' } };
  if (b.pc === 'here' || !b.pc) {
    if (!(await drivesHere()).some(x => x.drive === drive)) return { status: 404, body: { error: `This PC has no drive ${drive} now.` } };
    dj.setJobsHere(drive, jobs);
    justSet.delete(`here|${drive}`);
    return { status: 200, body: { said: saidOf('This PC', drive, jobs), ...(await storageView()) } };
  }
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more. Open Network to link it again.' } };
  if (r.role === 'guest') return { status: 403, body: { error: 'You are a guest on that PC: its drives are its owner\'s.' } };
  try {
    const a = await wireFor(r).ask('/worker/drive-jobs', { drive, jobs });
    justSet.set(`${r.id}|${drive}`, { jobs: dj.cleanJobList(a.jobs), at: Date.now() });
    return { status: 200, body: { said: saidOf(r.name, drive, jobs), ...(await storageView()) } };
  } catch (e) {
    const { status, said } = e as { status?: number; said?: string };
    return { status: status === 403 || status === 404 ? status : 409, body: { error: said ?? (e as Error).message } };
  }
}

/**
 * POST /api/network/models-where { pc: a linked PC's id, drive }: new models on that PC (downloads, copies sent to it)
 * go to that drive from now on, for a node with no screen. Its owner's "Accept models from linked PCs" tick is asked
 * there; the models already on it stay where they are. This PC's own choice is /api/models/where.
 */
export async function modelsWhereOn(b: Record<string, unknown>) {
  const drive = String(b.drive ?? '').toUpperCase();
  if (!/^[A-Z]:$/.test(drive)) return { status: 400, body: { error: 'Choose a drive first.' } };
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more. Open Network to link it again.' } };
  if (r.role === 'guest') return { status: 403, body: { error: "You are a guest on that PC: its drives are its owner's." } };
  try {
    const a = await wireFor(r).ask('/worker/models-where', { drive });
    modelsSet.set(r.id, { drive: String(a.drive ?? drive), at: Date.now() });
    return { status: 200, body: { said: `${r.name}: new models go to ${String(a.dir || drive)} from now on. The models already there stay where they are and are still used.`, ...(await storageView()) } };
  } catch (e) {
    const { status, said } = e as { status?: number; said?: string };
    return { status: status === 403 || status === 404 ? status : 409, body: { error: said ?? (e as Error).message } };
  }
}

/** POST /api/network/pool { pool: 'store' | 'backups', mode: 'spread' | 'mirror' }. */
export async function poolModeOn(b: Record<string, unknown>) {
  const pool = b.pool === 'store' || b.pool === 'backups' ? b.pool : null;
  const mode = b.mode === 'spread' || b.mode === 'mirror' ? b.mode : null;
  if (!pool || !mode) return { status: 400, body: { error: 'Choose a storage and Duplicate or Extended.' } };
  dj.setPoolMode(pool, mode);
  return { status: 200, body: { said: `${dj.POOL_WORDS[pool]}: ${mode === 'mirror' ? 'Duplicate, two copies of each file on two different PCs' : 'Extended, each file kept once'}.`, ...(await storageView()) } };
}

function saidOf(pc: string, drive: string, jobs: dj.Job[]): string {
  return jobs.length ? `${pc} ${drive} is now ${jobs.map(j => dj.POOL_WORDS[j]).join(' and ')}.` : `${pc} ${drive} now has no job.`;
}
