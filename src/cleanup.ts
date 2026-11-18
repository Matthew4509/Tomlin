// Free up space: which models to offer for removal when a disk is short of room, and the sums behind the dialog
// (public/cleanup.js). Pure: the server (src/server/cleanup.ts) gathers the models, this ranks them.
// Categories: Pictures = the draw models; Code = a chat model whose name or file has "coder" or "code" in it; Chat = the
// rest. (TOMLIN keeps no tags on models, so there is no manual tag.)

export const GB = 2 ** 30;
/** Room left free after an install, as everywhere else (src/carry.ts SPARE). */
export const SPARE = 2 * GB;

export type Cat = 'chat' | 'code' | 'pictures';
export const CATS: Cat[] = ['chat', 'code', 'pictures'];
export const CAT_WORDS: Record<Cat, string> = { chat: 'Chat', code: 'Code', pictures: 'Pictures' };

/** One installed model as the server gathers it. */
export interface CleanInput {
  id: string;
  name: string;
  kind: 'chat' | 'image';
  /** The file name (a chat model), for the Code test. */
  file?: string;
  bytes: number;
  /** When it last answered or drew (ms); null when never recorded. */
  usedAt: number | null;
  /** The file's modified time (ms); the stand-in when there is no record. */
  installedAt: number | null;
  loaded?: boolean;
  busy?: boolean;
  hidden?: boolean;
  ollama?: boolean;
  /** Hires who work on it. */
  usedBy?: string[];
  /** The files that would go, by name. */
  files?: string[];
  /** The drive its files are on ("D:"), when known: deleting it frees room there only. */
  drive?: string;
}

/** A Windows path's drive ("D:"), or '' (a share, or not known). */
export function driveOf(path: string): string {
  const m = /^([A-Za-z]):/.exec(path ?? '');
  return m ? `${m[1].toUpperCase()}:` : '';
}

/** Whether removing row `r` frees room on `drive` ('' = not known: counted, as before drives were told apart). */
export const onDrive = (r: Pick<CleanInput, 'drive'>, drive: string) => !drive || !r.drive || r.drive === drive;

export interface CleanRow extends CleanInput {
  cat: Cat;
  /** The time it is ranked by: the record, else the file's time. */
  sortAt: number;
  /** False: only the file's time is known ("not used since install"). */
  recorded: boolean;
  /** Why it cannot be removed from here now ('' when it can). */
  block: string;
  /** The only installed model of its category. */
  only: boolean;
}

export function categoryOf(m: Pick<CleanInput, 'kind' | 'name' | 'file'>): Cat {
  if (m.kind === 'image') return 'pictures';
  return /code/i.test(`${m.name} ${m.file ?? ''}`) ? 'code' : 'chat';
}

/** Why a model cannot be removed now ('' when it can). */
export function blockWhy(m: Pick<CleanInput, 'loaded' | 'busy' | 'hidden' | 'ollama'>): string {
  if (m.loaded || m.busy) return 'in use now (press Drop in the top bar first)';
  if (m.ollama) return 'kept by Ollama (remove it in Ollama)';
  if (m.hidden) return 'hidden (unhide it first)';
  return '';
}

/** Oldest use first; a tie goes to the larger one (more room back), then by name. */
const byLeastUsed = (a: CleanRow, b: CleanRow) => a.sortAt - b.sortAt || b.bytes - a.bytes || a.name.localeCompare(b.name);

/** Every model with its category, rank time, block and "only one of its kind", least used first. */
export function prepare(models: CleanInput[]): CleanRow[] {
  const rows: CleanRow[] = models.map(m => ({
    ...m,
    cat: categoryOf(m),
    sortAt: m.usedAt ?? m.installedAt ?? 0,
    recorded: m.usedAt !== null,
    block: blockWhy(m),
    only: false,
  }));
  for (const c of CATS) {
    const mine = rows.filter(r => r.cat === c);
    if (mine.length === 1) mine[0].only = true;
  }
  return rows.sort(byLeastUsed);
}

/** Whether the quick wins may offer it: free to remove, no hire works on it, not the only one of its kind. */
export const suggestable = (r: CleanRow) => !r.block && !r.usedBy?.length && !r.only;

/** What must be freed for `wanted` bytes to install with SPARE left: nothing when it already fits. */
export function shortBy(wanted: number, free: number, spare = SPARE): number {
  return Math.max(0, wanted + spare - free);
}

export interface Suggestion {
  /** In the order shown: the least-used of each category, then further least-used ones. */
  ids: string[];
  /** The first few of them that cover the need (none when there is no need). */
  ticked: string[];
  /** Whether everything suggestable would cover it. */
  covers: boolean;
}

/**
 * The quick wins: the least-used suggestable model of each category (chat, code, pictures), then further least-used
 * ones, from any category, until what they free covers `short`. With no need (short 0) it is the per-category ones
 * alone. `ticked` is the shortest start of that order that covers the need. `drive`: the drive that is short of room
 * (where the model would go): only models on it are offered, as deleting one on another drive frees nothing there.
 */
export function suggest(rows: CleanRow[], short: number, drive = ''): Suggestion {
  const ok = rows.filter(r => suggestable(r) && onDrive(r, drive)).sort(byLeastUsed);
  const picks: CleanRow[] = [];
  for (const c of CATS) {
    const first = ok.find(r => r.cat === c);
    if (first) picks.push(first);
  }
  const sum = (l: CleanRow[]) => l.reduce((n, r) => n + r.bytes, 0);
  for (const r of ok) {
    if (sum(picks) >= short) break;
    if (!picks.includes(r)) picks.push(r);
  }
  const ticked: CleanRow[] = [];
  if (short > 0) for (const r of picks) {
    if (sum(ticked) >= short) break;
    ticked.push(r);
  }
  return { ids: picks.map(r => r.id), ticked: ticked.map(r => r.id), covers: sum(ok) >= short };
}

export interface Tally {
  /** Bytes the install needs (the model and the spare room). */
  need: number;
  free: number;
  freed: number;
  /** Still missing (0 when enough). */
  left: number;
  enough: boolean;
}

/** The running total: ticked models' sizes against what is needed. `wanted` null: only freeing space, nothing to install. */
export function tally(ticked: Pick<CleanInput, 'bytes'>[], free: number, wanted: number | null, spare = SPARE): Tally {
  const freed = ticked.reduce((n, r) => n + r.bytes, 0);
  const need = wanted === null ? 0 : wanted + spare;
  const left = Math.max(0, need - free - freed);
  return { need, free, freed, left, enough: wanted === null ? freed > 0 : left === 0 };
}

export const gbWords = (n: number) => (n <= 0 ? '0 GB' : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

/** "Needs 33.2 GB, free 21.0 GB, freed so far 14.5 GB". */
export function tallyWords(t: Tally): string {
  return `${t.need ? `Needs ${gbWords(t.need)}, ` : ''}free ${gbWords(t.free)}, freed so far ${gbWords(t.freed)}`;
}

const DAY = 86_400_000;
/** "3 days ago", "today", "2 months ago". */
export function agoWords(at: number, now: number): string {
  const d = Math.floor(Math.max(0, now - at) / DAY);
  if (d < 1) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 60) return `${d} days ago`;
  return `${Math.floor(d / 30)} months ago`;
}

/** "last used 3 days ago", or "not used since install" when only the file's time is known. */
export function lastUsedWords(r: Pick<CleanRow, 'recorded' | 'sortAt'>, now: number): string {
  if (r.recorded) return `last used ${agoWords(r.sortAt, now)}`;
  return r.sortAt ? `not used since install (${agoWords(r.sortAt, now)})` : 'not used since install';
}
