// The downloads list of one PC: chat models from Hugging Face lined up, downloaded one at a time, in the order added.
// Each PC keeps its own list (data/download-queue.json), so a linked PC handed 100 downloads works through them alone,
// with the PC that asked turned off; a restart carries on with the one that was running (a file carries on from its
// .part). A download goes into the models folder ('models') or onto one of the PC's Model store drives ('store', the
// Network page's drive jobs, src/drivejobs.ts). Pure: the list, its order and its words; src/server/hf.ts runs it.
// Tested in test/dlqueue.test.ts.

export type DlState = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'cancelled';
export type DlTo = 'models' | 'store';

export interface DlFile { path: string; bytes: number; sha256: string }

export interface DlItem {
  id: string;
  repo: string;
  rev: string;
  /** The model's name (its file name without .gguf, as Hugging Face lists it). */
  name: string;
  bytes: number;
  files: DlFile[];
  to: DlTo;
  /** The Model store drive ("E:") for 'store'; '' for the models folder. */
  drive: string;
  state: DlState;
  got: number;
  error: string;
  added: string;
  ended?: string;
  /** Who added it: 'This PC', or the linked PC that asked. */
  by: string;
}

/** Finished lines kept under the list (newest first), so he can see what came and went. */
export const KEEP_FINISHED = 20;
export const STORE_FOLDER = 'TOMLIN Model store';

const STATES: DlState[] = ['waiting', 'running', 'done', 'failed', 'stopped', 'cancelled'];
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

function cleanFile(v: unknown): DlFile | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const path = str(o.path, 500);
  const sha256 = str(o.sha256, 64).toLowerCase();
  // A path inside the model's folder only: no drive, no climbing out.
  if (!path || /^[\\/]|^[a-zA-Z]:|(^|[\\/])\.\.([\\/]|$)/.test(path) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { path, bytes: num(o.bytes), sha256 };
}

export function cleanItem(v: unknown): DlItem | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const files = Array.isArray(o.files) ? o.files.map(cleanFile) : [];
  if (!files.length || files.some(f => !f)) return null;
  const repo = str(o.repo, 200);
  const to: DlTo = o.to === 'store' ? 'store' : 'models';
  const drive = str(o.drive, 3).toUpperCase();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !str(o.name) || !str(o.id, 40)) return null;
  if (to === 'store' && !/^[A-Z]:$/.test(drive)) return null;
  const state = STATES.includes(o.state as DlState) ? (o.state as DlState) : 'waiting';
  return {
    id: str(o.id, 40), repo, rev: str(o.rev, 80) || 'main', name: str(o.name), bytes: num(o.bytes), files: files as DlFile[],
    to, drive: to === 'store' ? drive : '', state, got: num(o.got), error: str(o.error, 600), added: str(o.added, 40) || new Date(0).toISOString(),
    ...(str(o.ended, 40) ? { ended: str(o.ended, 40) } : {}), by: str(o.by, 80) || 'This PC',
  };
}

export const cleanList = (v: unknown): DlItem[] => (Array.isArray(v) ? v.map(cleanItem).filter((x): x is DlItem => !!x) : []);

/** Read at start: the one that was running when TOMLIN stopped is first in line again (its file carries on). */
export const afterRestart = (list: DlItem[]): DlItem[] => list.map(x => (x.state === 'running' ? { ...x, state: 'waiting' as const } : x));

const open = (x: DlItem) => x.state === 'waiting' || x.state === 'running';

/** The next to start: the first one waiting, none while one runs. */
export const nextUp = (list: DlItem[]): DlItem | undefined => (list.some(x => x.state === 'running') ? undefined : list.find(x => x.state === 'waiting'));

/** The same model to the same place, already in the list and not finished. */
export const sameOpen = (list: DlItem[], x: Pick<DlItem, 'repo' | 'name' | 'to' | 'drive'>): DlItem | undefined =>
  list.find(y => open(y) && y.repo === x.repo && y.name === x.name && y.to === x.to && y.drive === x.drive);

/** Its place in line: 0 running, 1 next, …; -1 when it is not in line. */
export function placeOf(list: DlItem[], id: string): number {
  const line = list.filter(open).sort((a, b) => (a.state === 'running' ? -1 : b.state === 'running' ? 1 : 0));
  return line.findIndex(x => x.id === id);
}

/** What the ones not yet finished will still write on a drive (by drive letter, "" for the models folder). */
export function stillToCome(list: DlItem[], to: DlTo, drive: string): number {
  return list.filter(x => open(x) && x.to === to && x.drive === drive).reduce((n, x) => n + Math.max(0, x.bytes - x.got), 0);
}

/** Every one not finished stays; finished ones are kept up to KEEP_FINISHED, newest first. */
export function trimmed(list: DlItem[]): DlItem[] {
  const done = list.filter(x => !open(x)).sort((a, b) => String(b.ended ?? '').localeCompare(String(a.ended ?? ''))).slice(0, KEEP_FINISHED);
  return list.filter(x => open(x) || done.includes(x));
}

/** Cancel: one waiting is taken out of line at once ('cancelled'); one running is stopped by its runner. */
export function cancelled(list: DlItem[], id: string, at: string): { list: DlItem[]; stopRunning: boolean; found: boolean } {
  const x = list.find(y => y.id === id);
  if (!x) return { list, stopRunning: false, found: false };
  if (x.state === 'running') return { list, stopRunning: true, found: true };
  if (x.state !== 'waiting') return { list, stopRunning: false, found: true };
  return { list: list.map(y => (y.id === id ? { ...y, state: 'cancelled' as const, ended: at } : y)), stopRunning: false, found: true };
}

/** Download again (a stopped, failed or cancelled one): back at the end of the line, carrying on from what it has. */
export function again(list: DlItem[], id: string): DlItem[] {
  const x = list.find(y => y.id === id);
  if (!x || open(x) || x.state === 'done') return list;
  return [...list.filter(y => y.id !== id), { ...x, state: 'waiting', error: '', ended: undefined }];
}

/** Takes the finished lines away. */
export const cleared = (list: DlItem[]): DlItem[] => list.filter(open);

/** How far one is, as the list says it: "56%", "pending", "done", "stopped", "cancelled", "failed". */
export function dlWords(x: Pick<DlItem, 'state' | 'got' | 'bytes'>): string {
  if (x.state === 'running') return x.bytes ? `${Math.min(99, Math.floor((x.got / x.bytes) * 100))}%` : 'starting';
  if (x.state === 'waiting') return 'pending';
  return x.state;
}

/** Where it goes, as the list says it: "models folder" or "Model store E:". */
export const whereWords = (x: Pick<DlItem, 'to' | 'drive'>): string => (x.to === 'store' ? `Main model storage ${x.drive}` : 'models folder');

/** One line as a linked PC sends it (no file list: the PC that shows it does not need it). */
export const lineOf = (x: DlItem) => ({ id: x.id, repo: x.repo, name: x.name, bytes: x.bytes, got: x.got, state: x.state, to: x.to, drive: x.drive, error: x.error, added: x.added, ended: x.ended ?? '', by: x.by, words: dlWords(x), where: whereWords(x) });
export type DlLine = ReturnType<typeof lineOf>;

/** The list as shown: the one running, then the ones waiting in order, then the finished ones, newest first. */
export function shown(list: DlItem[]): DlLine[] {
  const run = list.filter(x => x.state === 'running');
  const wait = list.filter(x => x.state === 'waiting');
  const done = list.filter(x => !open(x)).sort((a, b) => String(b.ended ?? '').localeCompare(String(a.ended ?? '')));
  return [...run, ...wait, ...done].map(lineOf);
}
