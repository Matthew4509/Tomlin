// Drive jobs and the two storage pools of the Network page. Each PC keeps the jobs of its own drives (drive-jobs.json in
// its home): Model store (one copy of models, never loaded from) and Backups. Which drive the models run from is not a
// job here: it is the folder "Models are kept in" (src/modelhome.ts), shown on that drive's line. A linked PC is told
// the jobs in the hello (drives[].jobs) and an admin may set them there (/worker/drive-jobs), with that PC owner's tick
// for each job: "Accept models from linked PCs" for Model store, "Enable backups" for Backups.
// The admin keeps how each pool keeps its files (drive-pools.json): Spread (each file once, every drive's room adds up)
// or Mirror (two copies of each file, always on two different PCs, so half the room). Nothing is copied into a pool
// yet: the queue fills them later. Here the pools are set up, measured and warned about. Tested in test/drivejobs.test.ts.
import { readFileSync, renameSync } from 'node:fs';
import { writeAtomicSync } from './atomic.ts';

export const JOBS = ['store', 'backups'] as const;
export type Job = (typeof JOBS)[number];
export type Mode = 'spread' | 'mirror';
export type Pools = Record<Job, { mode: Mode }>;

/** The pools' names as the page says them. */
export const POOL_WORDS: Record<Job, string> = { store: 'Main model storage', backups: 'Backup storage' };
/** Backups cannot be downloaded again, so they are mirrored unless he chooses Spread; models are spread. */
export const POOLS_FIRST: Pools = { store: { mode: 'spread' }, backups: { mode: 'mirror' } };
/** Under this share of a pool's room free, the pool says it is nearly full. */
export const NEARLY_FULL = 0.1;

/** A drive's jobs as saved or sent: known jobs only, each once, in the usual order. */
export const cleanJobList = (v: unknown): Job[] => (Array.isArray(v) ? JOBS.filter(j => v.includes(j)) : []);

/** Saved drive jobs: { "D:": ["store"] }, drive letters only, a drive with no job left out. */
export function cleanJobs(v: unknown): Record<string, Job[]> {
  const out: Record<string, Job[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    const drive = k.toUpperCase();
    const jobs = cleanJobList(list);
    if (/^[A-Z]:$/.test(drive) && jobs.length) out[drive] = jobs;
  }
  return out;
}

export function cleanPools(v: unknown): Pools {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, { mode?: unknown } | undefined>;
  const mode = (j: Job): Mode => (o[j]?.mode === 'spread' || o[j]?.mode === 'mirror' ? o[j]!.mode as Mode : POOLS_FIRST[j].mode);
  return { store: { mode: mode('store') }, backups: { mode: mode('backups') } };
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The read a change is made from: a file that is not there is null, but one that cannot be read now (a virus scanner
 * holding it, a permission set wrong) throws, so the change is refused and nothing is saved over the jobs it holds.
 * A file that is there but damaged is set aside beside itself, never written over.
 */
function readForChange(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    const keptAs = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, keptAs);
    console.error(`${file} could not be read and was set aside as ${keptAs}.`);
    return null;
  }
}

let jobsFile = '';
let poolsFile = '';
/** Where this PC keeps its drive jobs and its pools (set once at start from the home: src/server/core.ts). */
export function useFiles(jobs: string, pools: string): void {
  jobsFile = jobs;
  poolsFile = pools;
}

/** This PC's drive jobs now (read each time: small, and set from two places). */
export const jobsHere = (): Record<string, Job[]> => (jobsFile ? cleanJobs(readJson(jobsFile)) : {});

/** Sets one of this PC's drives' jobs (an empty list: no job). */
export function setJobsHere(drive: string, jobs: unknown): Record<string, Job[]> {
  const all = jobsFile ? cleanJobs(readForChange(jobsFile)) : {};
  const d = drive.toUpperCase();
  const list = cleanJobList(jobs);
  if (list.length) all[d] = list;
  else delete all[d];
  if (jobsFile) writeAtomicSync(jobsFile, JSON.stringify(all, null, 2));
  return all;
}

export const poolsHere = (): Pools => cleanPools(poolsFile ? readJson(poolsFile) : null);

export function setPoolMode(pool: Job, mode: Mode): Pools {
  const all = cleanPools(poolsFile ? readForChange(poolsFile) : null);
  all[pool] = { mode };
  if (poolsFile) writeAtomicSync(poolsFile, JSON.stringify(all, null, 2));
  return all;
}

/** Why a linked PC may not give one of this PC's drives a job: the owner's tick for that job is off ('' when it may). */
export function jobRefused(jobs: Job[], allow: { receive: boolean; backup: boolean }, name: string): string {
  if (jobs.includes('store') && !allow.receive) return `"${name}" does not accept models from linked PCs: its owner can turn on "Accept models from linked PCs" on This PC, then its drive can be part of Main model storage`;
  if (jobs.includes('backups') && !allow.backup) return `"${name}" does not keep backups for linked PCs: its owner can turn on "Enable backups" on This PC, then its drive can be part of Backup storage`;
  return '';
}

// ---- The pools, measured ----

export interface PoolDrive {
  pc: string;
  pcName: string;
  drive: string;
  label: string;
  total: number;
  free: number;
  /** The PC answers now: a PC that is off is listed, not counted. */
  ok: boolean;
}

export interface PoolView {
  job: Job;
  name: string;
  mode: Mode;
  drives: PoolDrive[];
  /** How much the pool can keep (Mirror: each file twice, on two PCs), and how much of that is free, in bytes. */
  size: number;
  free: number;
  /** How many different PCs hold its drives (counted ones). */
  pcs: number;
  warnings: string[];
}

const TB = 2 ** 40;
const GB = 2 ** 30;
export const sizeWords = (n: number): string => (n >= TB ? `${Math.round((n / TB) * 10) / 10} TB` : `${Math.round(n / GB)} GB`);

/**
 * Room for files kept twice on two different PCs: half the room of all drives, but never more than the room outside the
 * PC with the most (each file's second copy has to be on another PC). One PC alone: nothing.
 */
export function mirrorRoom(perPc: number[]): number {
  const all = perPc.reduce((a, b) => a + b, 0);
  const most = Math.max(0, ...perPc);
  return Math.max(0, Math.min(all / 2, all - most));
}

export function poolView(job: Job, mode: Mode, drives: PoolDrive[]): PoolView {
  const counted = drives.filter(d => d.ok);
  const byPc = new Map<string, { total: number; free: number; name: string; n: number }>();
  for (const d of counted) {
    const p = byPc.get(d.pc) ?? { total: 0, free: 0, name: d.pcName, n: 0 };
    p.total += d.total;
    p.free += d.free;
    p.n += 1;
    byPc.set(d.pc, p);
  }
  const pcs = [...byPc.values()];
  const size = mode === 'mirror' ? mirrorRoom(pcs.map(p => p.total)) : pcs.reduce((a, p) => a + p.total, 0);
  const free = mode === 'mirror' ? mirrorRoom(pcs.map(p => p.free)) : pcs.reduce((a, p) => a + p.free, 0);
  const name = POOL_WORDS[job];
  const warnings: string[] = [];
  for (const d of drives.filter(x => !x.ok)) warnings.push(`${d.pcName} is not answering now: its drive ${d.drive} is left out of the room shown.`);
  if (mode === 'mirror' && counted.length && pcs.length < 2) {
    const one = pcs[0];
    warnings.push(one.n > 1
      ? `Both drives are in ${one.name}: if that PC fails, both copies are lost. Duplicate keeps its two copies on two different PCs, so add a drive on another PC. Until then nothing can be kept twice.`
      : `Duplicate keeps two copies of each file on two different PCs: add a drive on another PC. Until then nothing can be kept twice.`);
  }
  if (mode === 'spread' && job === 'backups' && counted.length > 1) warnings.push('Extended keeps each backup once: if a drive fails, the backups on it are lost. Backups cannot be downloaded again; Duplicate keeps two copies.');
  if (size > 0 && free < size * NEARLY_FULL) warnings.push(`${name} is nearly full: ${sizeWords(free)} free of ${sizeWords(size)}.`);
  return { job, name, mode, drives, size, free, pcs: pcs.length, warnings };
}

/** The one line a pool box says under its name: "Mirror · 2 drives · 2 TB · 1.3 TB free". */
export function poolLine(v: PoolView): string {
  if (!v.drives.length) return `${v.mode === 'mirror' ? 'Duplicate' : 'Extended'} · no drive yet`;
  const n = v.drives.length;
  if (v.mode === 'mirror' && v.size === 0 && v.pcs < 2) return `Duplicate · ${n} drive${n === 1 ? '' : 's'} · no room until a drive on another PC is added`;
  return `${v.mode === 'mirror' ? 'Duplicate' : 'Extended'} · ${n} drive${n === 1 ? '' : 's'} · ${sizeWords(v.size)} · ${sizeWords(v.free)} free`;
}
