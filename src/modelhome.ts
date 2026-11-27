// Where models are kept. By default that is models/ in the home (on the drive Windows is on); a person with a small
// C: drive can choose another folder (D:, a USB drive), and downloads then go there. The choice is one small file in
// the home, models-home.txt: its first line is the chosen folder (empty: the usual one), and the lines after it are
// folders used before, which are still read where they are until their models are moved (moveModels). A model that is
// loaded is never moved: it is named, and the rest carry on. Also here: this PC's drives with their free space, for
// the list of models by drive and for the "that drive is full, another has room" words.
// The server's side is src/server/modelhome.ts; tested in test/modelhome.test.ts.
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeAtomicSync } from './atomic.ts';

const GB = 2 ** 30;
const gb = (n: number) => `${(Math.max(0, n) / GB).toFixed(1)} GB`;
const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** Kept free on a drive after a download or a move: 2 GB, as copies, restore points and backups keep (it was 0.5 GB). */
export const SPARE = 2 * GB;

/** The drive a path is on: "C:" for a drive letter, "\\pc\share" for a network folder. */
export function driveOf(path: string): string {
  const root = parse(resolve(path)).root.replace(/[\\/]+$/, '');
  return /^[a-z]:$/i.test(root) ? root.toUpperCase() : root;
}

/** A whole drive (D:\) or a whole network share: a folder on it is asked for instead. */
export function wholeDrive(dir: string): boolean {
  return /^[a-z]:[\\/]?$/i.test(dir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(dir);
}

/** The choice of where models are kept (models-home.txt). `usual`: models/ in the home. */
export class ModelsHome {
  readonly usual: string;
  private file: string;

  constructor(file: string, usual: string) {
    this.file = file;
    this.usual = usual;
  }

  private read(): { dir: string | null; earlier: string[] } {
    let lines: string[];
    try {
      lines = readFileSync(this.file, 'utf8').split(/\r?\n/).map(l => l.trim().replace(/^"|"$/g, ''));
    } catch {
      return { dir: null, earlier: [] };
    }
    const dir = lines[0] && !same(lines[0], this.usual) ? lines[0] : null;
    const earlier: string[] = [];
    for (const l of lines.slice(1)) {
      if (!l || same(l, this.usual) || (dir && same(l, dir)) || earlier.some(e => same(e, l))) continue;
      earlier.push(l);
    }
    return { dir, earlier };
  }

  private write(dir: string | null, earlier: string[]): void {
    if (!dir && !earlier.length) return rmSync(this.file, { force: true });
    // Whole or not at all: a full disk never leaves the choice empty (models would be looked for in the wrong folder).
    writeAtomicSync(this.file, `${[dir ?? '', ...earlier].join('\r\n')}\r\n`);
  }

  /** The folder chosen, or null while the usual one is used. */
  chosen(): string | null {
    return this.read().dir;
  }

  /** Where models are kept now: downloads go here (chat/, image/ and helpers/ inside it). */
  dir(): string {
    return this.read().dir ?? this.usual;
  }

  /** The chosen folder, when it is not there now (its drive is unplugged, or came back under another letter). */
  missing(): string | null {
    const dir = this.read().dir;
    if (!dir) return null;
    try {
      if (statSync(dir).isDirectory()) return null;
    } catch {
      // not there
    }
    return dir;
  }

  /** The folders used before (the usual one too, once another is chosen): their models are still used where they are. */
  others(): string[] {
    const r = this.read();
    return [...(r.dir ? [this.usual] : []), ...r.earlier];
  }

  /** Keeps models in `dir` from now on (null: the usual folder again). The folder used until now stays read. */
  set(dir: string | null): void {
    const r = this.read();
    const now = dir && !same(dir, this.usual) ? dir : null;
    const earlier = [...r.earlier, ...(r.dir ? [r.dir] : [])].filter((e, i, all) => !(now && same(e, now)) && all.findIndex(x => same(x, e)) === i);
    this.write(now, earlier);
  }

  /** A folder used before that holds no model any more is not read again. */
  forget(dir: string): void {
    const r = this.read();
    this.write(r.dir, r.earlier.filter(e => !same(e, dir)));
  }
}

// ---- This PC's drives ----

export interface Drive {
  /** "C:" */
  drive: string;
  /** The name Windows shows for it ("New Volume"), when it has one. */
  label: string;
  /** A drive Windows calls removable (a USB stick; a USB hard disk can read as a fixed drive). */
  removable: boolean;
  /** How it is formatted ("NTFS", "exFAT", "FAT32"); '' when not known. */
  fs: string;
  free: number;
  total: number;
}

/** What Windows' Get-Volume answered (as JSON), as drives: only those with a letter and a size. */
export function drivesFrom(text: string): Drive[] {
  let got: unknown;
  try {
    got = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = (Array.isArray(got) ? got : [got]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  return rows
    .map(r => ({ drive: `${String(r.d ?? '').toUpperCase()}:`, label: String(r.l ?? ''), removable: String(r.t ?? '') === 'Removable', fs: String(r.x ?? ''), free: Number(r.f) || 0, total: Number(r.s) || 0 }))
    .filter(d => /^[A-Z]:$/.test(d.drive) && d.total > 0)
    .sort((a, b) => a.drive.localeCompare(b.drive));
}

const VOLUMES = 'Get-Volume | Where-Object DriveLetter | ForEach-Object { [pscustomobject]@{ d = [string]$_.DriveLetter; l = [string]$_.FileSystemLabel; t = [string]$_.DriveType; x = [string]$_.FileSystem; s = [double]$_.Size; f = [double]$_.SizeRemaining } } | ConvertTo-Json -Compress';
let drivesKept: { at: number; list: Drive[]; full: number } | null = null;
/** The next asking reads the drives again (a folder was chosen, models were moved). */
export function forgetDrives(): void {
  drivesKept = null;
}

/** This PC's drives with their free space now (asked of Windows, at most once in 15 s). Empty when it cannot be read. */
export async function drives(): Promise<Drive[]> {
  if (process.platform !== 'win32') return [];
  if (drivesKept && Date.now() - drivesKept.at < 15_000) return drivesKept.list;
  // One reading at a time: callers meanwhile share it (each started its own PowerShell before).
  return (drivesReading ??= readDrives().finally(() => {
    drivesReading = null;
  }));
}

let drivesReading: Promise<Drive[]> | null = null;

async function readDrives(): Promise<Drive[]> {
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const text = await new Promise<string>(done => execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', VOLUMES], { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 }, (_e, out) => done(String(out ?? ''))));
  let list = drivesFrom(text);
  if (!list.length) {
    // Windows did not say: the letters that answer, without a name.
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const s = await statfs(`${l}:\\`).catch(() => null);
      if (s && s.blocks > 0) list.push({ drive: `${l}:`, label: '', removable: false, fs: '', free: s.bavail * s.bsize, total: s.blocks * s.bsize });
    }
  }
  // The letters Windows has that are not drives in that list (a network drive, a card reader with no card): not a change.
  const letters = await lettersNow();
  notVolumes = new Set([...(letters ?? [])].filter(l => !list.some(d => d.drive === l)));
  drivesKept = { at: Date.now(), list, full: Date.now() };
  return list;
}

/** The drive letters in fsutil's answer ("Drives: C:\ D:\"). */
export const lettersFrom = (text: string): Set<string> => new Set([...text.matchAll(/\b([A-Z]):\\/gi)].map(m => `${m[1].toUpperCase()}:`));

/** The drive letters Windows has now, from fsutil: a small program (about 15 ms of CPU, against 400 ms for PowerShell). Null when it cannot say. */
async function lettersNow(): Promise<Set<string> | null> {
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'fsutil.exe');
  const text = await new Promise<string | null>(done => execFile(exe, ['fsinfo', 'drives'], { windowsHide: true, timeout: 5000 }, (e, out) => done(e ? null : String(out ?? ''))));
  return text === null ? null : lettersFrom(text);
}
let notVolumes = new Set<string>();

/** Whether Windows still has the same drives as `list` (letters it had then that are not drives left aside). */
export const sameDrives = (letters: Set<string>, aside: Set<string>, list: Drive[]): boolean => {
  const now = [...letters].filter(l => !aside.has(l));
  return now.length === list.length && list.every(d => now.includes(d.drive));
};

/** The whole reading (names, kinds) is taken again at least this often; free space is read again more often. */
export const DRIVES_FULL_MS = 10 * 60_000;

/**
 * The drives as last read, with their free space read again (no program for that), when Windows still has the same
 * letters; anything else (a drive added or taken out, one that does not answer, an old reading) reads them all again.
 * A linked PC's hello asks for this once a minute: it started a PowerShell each time (about 400 ms of CPU and 30 MB).
 */
async function freshenDrives(): Promise<void> {
  const kept = drivesKept;
  if (!kept || Date.now() - kept.full >= DRIVES_FULL_MS) return void (await drives());
  const letters = await lettersNow();
  const list = letters && sameDrives(letters, notVolumes, kept.list)
    ? await Promise.all(kept.list.map(async d => {
      const s = await statfs(`${d.drive}\\`).catch(() => null);
      return s && s.blocks > 0 ? { ...d, free: s.bavail * s.bsize, total: s.blocks * s.bsize } : null;
    }))
    : null;
  if (!list || list.some(d => !d)) {
    if (drivesKept === kept) drivesKept = null;
    return void (await drives());
  }
  if (drivesKept === kept) drivesKept = { at: Date.now(), list: list as Drive[], full: kept.full };
}
let freshening: Promise<void> | null = null;

/** The drives as they were last read (empty before the first reading): for lists drawn without waiting on Windows. */
export const drivesKnown = (): Drive[] => drivesKept?.list ?? [];

// ---- Hard disk or SSD ----

/** What a drive is made of, as Windows says it: an SSD (or faster), or a hard disk with spinning platters. */
export type DriveKind = 'ssd' | 'hdd';

/**
 * Windows' answer (as JSON: each drive letter with its physical disk's MediaType) as a kind per drive ("C:" -> 'ssd').
 * MediaType comes as a word (HDD, SSD, SCM) or, from some versions, a number (3 HDD, 4 SSD, 5 SCM). "Unspecified"
 * (a RAID card or a virtual disk often says that) is left out: nothing is shown for a drive Windows does not name.
 */
export function kindsFrom(text: string): Record<string, DriveKind> {
  let got: unknown;
  try {
    got = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, DriveKind> = {};
  for (const r of (Array.isArray(got) ? got : [got]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')) {
    const drive = `${String(r.d ?? '').toUpperCase()}:`;
    const m = String(r.m ?? '').trim().toUpperCase();
    const kind: DriveKind | null = m === 'HDD' || m === '3' ? 'hdd' : m === 'SSD' || m === '4' || m === 'SCM' || m === '5' ? 'ssd' : null;
    // A drive letter on two disks (a spanned volume), one of them a hard disk: as slow as a hard disk.
    if (!/^[A-Z]:$/.test(drive) || !kind) continue;
    if (out[drive] && out[drive] !== kind) {
      out[drive] = 'hdd';
      continue;
    }
    out[drive] = kind;
  }
  return out;
}

// Get-PhysicalDisk once (it is the slow part: 10 s and more on some PCs), joined to each lettered partition's disk.
const KINDS = '$pd = @{}; Get-PhysicalDisk | ForEach-Object { $pd[[string]$_.DeviceId] = [string]$_.MediaType }; Get-Partition | Where-Object DriveLetter | ForEach-Object { [pscustomobject]@{ d = [string]$_.DriveLetter; m = $pd[[string]$_.DiskNumber] } } | ConvertTo-Json -Compress';
let kindsKept: { at: number; kinds: Record<string, DriveKind> } | null = null;
let kindsAsking: Promise<Record<string, DriveKind>> | null = null;

/**
 * Each drive's kind, asked of Windows at most once in 10 minutes (disks do not change kind); an answer that named none
 * (Windows was slow or said nothing) is asked again after 30 s. Empty when not known. One asking at a time.
 */
export async function driveKinds(): Promise<Record<string, DriveKind>> {
  if (process.platform !== 'win32') return {};
  if (kindsKept && Date.now() - kindsKept.at < (Object.keys(kindsKept.kinds).length ? 600_000 : 30_000)) return kindsKept.kinds;
  kindsAsking ??= (async () => {
    const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const text = await new Promise<string>(done => execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', KINDS], { windowsHide: true, timeout: 45_000, maxBuffer: 1 << 20 }, (_e, out) => done(String(out ?? ''))));
    kindsKept = { at: Date.now(), kinds: kindsFrom(text) };
    kindsAsking = null;
    return kindsKept.kinds;
  })();
  return kindsAsking;
}
/** The kinds as last read (empty before the first reading). */
export const kindsKnown = (): Record<string, DriveKind> => kindsKept?.kinds ?? {};

/**
 * Where a model on a hard disk could go on an SSD: null when it is not on a hard disk, or no SSD of this PC has room
 * (its size and SPARE). The chosen models folder when that is on an SSD with room (`newHome` false: the move is the
 * usual move into it); else the SSD with the most room, in a new "TOMLIN models" folder there, which becomes where
 * models are kept (`newHome` true: downloads go there too, and the folder used until now is still read).
 */
export function ssdTarget(modelPath: string, bytes: number, home: string, all: Drive[], kinds: Record<string, DriveKind>): { drive: string; dir: string; free: number; newHome: boolean } | null {
  const from = driveOf(modelPath);
  if (kinds[from] !== 'hdd') return null;
  // FAT cannot hold a file over 4 GB: such a drive is not offered.
  const room = (d: Drive) => kinds[d.drive] === 'ssd' && !d.removable && !/^fat/i.test(d.fs) && d.drive !== from && d.free >= bytes + SPARE;
  const homeDrive = all.find(d => d.drive === driveOf(home));
  if (homeDrive && room(homeDrive)) return { drive: homeDrive.drive, dir: home, free: homeDrive.free, newHome: false };
  const best = all.filter(room).sort((a, b) => b.free - a.free)[0];
  return best ? { drive: best.drive, dir: `${best.drive}\\TOMLIN models`, free: best.free, newHome: true } : null;
}

/**
 * How fast each drive gave a model up, from the loads timed before (`seconds` from Load to ready): the best of them,
 * bytes a second. A load also waits on the card, so this is a floor on the drive's speed; a drive with no timed load
 * is not in the answer.
 */
export function driveReadSpeeds(loads: { drive: string; bytes: number; seconds: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of loads) {
    if (!(l.seconds > 0) || !(l.bytes > 0)) continue;
    out[l.drive] = Math.max(out[l.drive] ?? 0, l.bytes / l.seconds);
  }
  return out;
}

/** What a PC tells the others about its drives: letter, name, size and free space (the My PC window's "Free space" line). */
export interface DriveReport {
  drive: string;
  label: string;
  total: number;
  free: number;
}

/** This PC's drives as they are told to a linked PC (at most 8, the fixed ones first); empty when Windows does not say. */
export async function driveReport(): Promise<DriveReport[]> {
  return reportOf(await drives().catch((): Drive[] => []));
}

/**
 * The same, without waiting: as last read, and read again in the background when that is old. For a linked PC's
 * hello, which the main PC gives 3 s: a PowerShell reading on a busy PC took longer, and the PC read as off.
 */
export function driveReportNow(): DriveReport[] {
  if (!drivesKept || Date.now() - drivesKept.at >= 15_000) freshening ??= freshenDrives().catch(() => undefined).finally(() => (freshening = null));
  return reportOf(drivesKnown());
}

function reportOf(all: Drive[]): DriveReport[] {
  return [...all].sort((a, b) => Number(a.removable) - Number(b.removable) || a.drive.localeCompare(b.drive)).slice(0, 8).map(d => ({ drive: d.drive, label: d.label, total: Math.round(d.total), free: Math.round(d.free) }));
}

/** Free bytes on the drive `dir` is on (the nearest folder above it that is there); Infinity when it cannot be read. */
export async function freeOn(dir: string): Promise<number> {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const s = await statfs(d).catch(() => null);
    if (s) return s.bavail * s.bsize;
    if (dirname(d) === d) return Infinity;
  }
}

/**
 * Said after "not enough free disk space" when another drive of this PC has room for `need` bytes: which one, and
 * where to choose it. Empty when none has.
 */
export function otherDriveHint(need: number, here: string, all: Drive[]): string {
  const d = roomyDrive(need, here, all);
  return d ? ` Or keep your models on another drive: ${d.drive}${d.label ? ` (${d.label})` : ''} has ${gb(d.free)} free. Choose it under Network Storage (or Models, Import models, Where models are kept).` : '';
}

/** The drive other than `here`'s with the most room for `need` and the spare, never one formatted FAT (no file over 4 GB). */
function roomyDrive(need: number, here: string, all: Drive[]): Drive | undefined {
  const at = driveOf(here);
  return all.filter(x => x.drive !== at && x.free >= need + SPARE && !/^fat(32|16|12)?$/i.test(x.fs)).sort((a, b) => b.free - a.free)[0];
}

/**
 * The same, said by a PC that was sent a model it has no room for, to the PC that sent it: that PC's owner picks the
 * drive here (nothing is changed from the other PC).
 */
export function theirDriveHint(need: number, here: string, all: Drive[]): string {
  const d = roomyDrive(need, here, all);
  return d ? ` It has ${gb(d.free)} free on ${d.drive}${d.label ? ` (${d.label})` : ''}: pick its ${d.drive} under Network Storage, Where each PC runs its models from (on the PC that sent it, or on this one), then send it again.` : '';
}

/** The models on this PC, by the drive each is on: for the list split C:, D:, USB. */
export function byDrive(models: { name: string; path: string; bytes: number }[], all: Drive[]): { drive: string; label: string; removable: boolean; free: number | null; bytes: number; models: { name: string; bytes: number }[] }[] {
  const rows = new Map<string, { drive: string; label: string; removable: boolean; free: number | null; bytes: number; models: { name: string; bytes: number }[] }>();
  for (const m of models) {
    const drive = driveOf(m.path);
    const known = all.find(d => d.drive === drive);
    const row = rows.get(drive) ?? { drive, label: known?.label ?? '', removable: known?.removable ?? false, free: known ? known.free : null, bytes: 0, models: [] };
    row.bytes += m.bytes;
    row.models.push({ name: m.name, bytes: m.bytes });
    rows.set(drive, row);
  }
  return [...rows.values()].sort((a, b) => a.drive.localeCompare(b.drive));
}

// ---- Moving the models already here into the folder chosen ----

export interface MoveState {
  state: 'idle' | 'moving' | 'done' | 'stopped' | 'failed';
  to: string;
  /** Bytes moved so far, and bytes in all. */
  got: number;
  bytes: number;
  /** Files moved. */
  moved: number;
  /** The file being moved now. */
  now: string;
  skipped: { name: string; why: string }[];
  /** The result in plain words, once it has ended. */
  said: string;
}

export const idleMove = (): MoveState => ({ state: 'idle', to: '', got: 0, bytes: 0, moved: 0, now: '', skipped: [], said: '' });

/** The folders inside a models folder that hold model files. */
const PARTS = ['chat', 'image', 'helpers'];
const IN_USE = 'it is in use';

export interface MoveFile {
  /** Path inside the models folder, with forward slashes ("chat/pub/m/x.gguf"). */
  rel: string;
  path: string;
  bytes: number;
}

/** Every model file under the folders `from` (their chat/, image/ and helpers/), half-downloaded ones left out. */
export function filesToMove(from: string[]): MoveFile[] {
  const out: MoveFile[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = join(dir, n);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 5 && !n.startsWith('.')) walk(full, `${rel}/${n}`, depth + 1);
      } else if (!n.endsWith('.part')) out.push({ rel: `${rel}/${n}`, path: full, bytes: st.size });
    }
  };
  for (const root of from) for (const part of PARTS) walk(join(root, part), part, 0);
  return out;
}

const sizeOf = (path: string) => stat(path).then(s => s.size, () => -1);
const busyCode = (e: unknown) => ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');

/** True when the two files hold the same bytes (read side by side, a few MB at a time). */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const fa = await open(a, 'r');
  try {
    const fb = await open(b, 'r');
    try {
      const size = 4 * 1024 * 1024;
      const ba = Buffer.alloc(size);
      const bb = Buffer.alloc(size);
      for (let at = 0; ; ) {
        const [ra, rb] = await Promise.all([fa.read(ba, 0, size, at), fb.read(bb, 0, size, at)]);
        if (ra.bytesRead !== rb.bytesRead) return false;
        if (!ra.bytesRead) return true;
        if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
        at += ra.bytesRead;
      }
    } finally {
      await fb.close();
    }
  } finally {
    await fa.close();
  }
}

/** False when another program holds the file (a loaded model): Windows then refuses to open it for writing. */
async function freeToMove(path: string): Promise<boolean> {
  try {
    await (await open(path, 'r+')).close();
    return true;
  } catch (e) {
    return !busyCode(e);
  }
}

export interface MoveOptions {
  /** True for a file a loaded model is using now (asked just before that file is moved). */
  inUse?: (path: string) => boolean;
  signal?: AbortSignal;
  /** The state kept up to date while it works (the page reads it). */
  state?: MoveState;
  free?: (dir: string) => Promise<number>;
  /** The move itself, for tests (another drive answers EXDEV). */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Moves every model file under the folders `from` into `to`, keeping its place inside (chat/, image/, helpers/). On the
 * same drive that is a rename; to another drive each file is copied, checked by size, put in place and only then
 * removed from where it was, so a move cut off never loses a model. A file in use is skipped and named, and so is one
 * there is no room for or whose name is taken by a different file; the rest carry on.
 */
export async function moveModels(from: string[], to: string, o: MoveOptions = {}): Promise<MoveState> {
  return moveFiles(filesToMove(from.filter(f => !same(f, to))), to, o);
}

/** The files of one model, for moveFiles: `rel` is its path inside its models folder ("chat/sub/x.gguf"). */
export function modelFiles(paths: string[], relDir: string): MoveFile[] {
  return paths.flatMap(p => {
    const bytes = statSync(p, { throwIfNoEntry: false })?.size;
    return bytes === undefined ? [] : [{ rel: `${relDir}/${p.split(/[\\/]/).pop()}`, path: p, bytes }];
  });
}

/** Moves `files` into `to` at their `rel` places, as moveModels does (each file whole or not at all). */
export async function moveFiles(files: MoveFile[], to: string, o: MoveOptions = {}): Promise<MoveState> {
  const s = o.state ?? idleMove();
  Object.assign(s, { state: 'moving', to, got: 0, bytes: files.reduce((n, f) => n + f.bytes, 0), moved: 0, now: '', skipped: [], said: '' });
  const move = o.rename ?? rename;
  const free = o.free ?? freeOn;
  const skip = (f: MoveFile, why: string) => {
    s.skipped.push({ name: f.rel.split('/').pop()!, why });
    s.bytes -= f.bytes;
  };
  for (const f of files) {
    if (o.signal?.aborted) break;
    const dest = join(to, ...f.rel.split('/'));
    s.now = f.rel.split('/').pop()!;
    if (o.inUse?.(f.path) || !(await freeToMove(f.path))) {
      skip(f, IN_USE);
      continue;
    }
    const there = await sizeOf(dest);
    // The same name and size is not the same file (another revision of a model can be as big): only a file whose bytes
    // match is counted as already moved; any other is a different file and this one stays where it is.
    if (there >= 0 && (there !== f.bytes || !(await sameBytes(f.path, dest).catch(() => false)))) {
      skip(f, 'a different file of that name is already in the new folder');
      continue;
    }
    try {
      if (there === f.bytes) {
        // Already in the new folder, whole: only the copy left behind goes.
        await unlink(f.path);
        s.got += f.bytes;
      } else {
        await mkdir(dirname(dest), { recursive: true });
        let across = false;
        try {
          await move(f.path, dest);
          s.got += f.bytes;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
          across = true;
        }
        // Another drive: copied (its bytes are counted as they are written).
        const why = across ? await copyAcross(f, dest, s, free, o.signal) : '';
        if (why) {
          skip(f, why);
          continue;
        }
      }
      s.moved++;
    } catch (e) {
      if (o.signal?.aborted) break;
      skip(f, busyCode(e) ? IN_USE : `Windows said: ${((e as Error).message || String(e)).split('\n')[0].slice(0, 160)}`);
    }
  }
  s.now = '';
  s.state = o.signal?.aborted ? 'stopped' : 'done';
  s.said = moveSaid(s);
  return s;
}

/** One file to another drive: copied beside its place, checked, put in place, then removed from where it was. Returns why not, or ''. */
async function copyAcross(f: MoveFile, dest: string, s: MoveState, free: (dir: string) => Promise<number>, signal?: AbortSignal): Promise<string> {
  const room = await free(dirname(dest));
  if (f.bytes + SPARE > room) return `there is not enough free space on ${driveOf(dest)} (it needs ${gb(f.bytes)}, and ${gb(room)} is free)`;
  const part = `${dest}.part`;
  const before = s.got;
  try {
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        s.got += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(createReadStream(f.path), counter, createWriteStream(part), { signal });
    if ((await sizeOf(part)) !== f.bytes) throw new Error('the copy did not come out whole');
    await rename(part, dest);
  } catch (e) {
    s.got = before;
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
  try {
    await unlink(f.path);
  } catch (e) {
    // It could not be taken from where it was (a model loaded meanwhile): it stays there, and the copy goes.
    s.got = before;
    await rm(dest, { force: true }).catch(() => undefined);
    if (busyCode(e)) return IN_USE;
    throw e;
  }
  s.got = before + f.bytes;
  return '';
}

/** What a move did, in plain words. */
export function moveSaid(s: MoveState): string {
  const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
  if (!s.moved && !s.skipped.length) return s.state === 'stopped' ? 'Stopped before anything was moved.' : `There was nothing to move: your models are in ${s.to} already.`;
  const out: string[] = [];
  if (s.state === 'stopped') out.push('Stopped. Press Move again to carry on.');
  out.push(s.moved ? `Moved ${s.moved} model file${s.moved === 1 ? '' : 's'} (${gb(s.got)}) to ${s.to}.` : 'No model file was moved.');
  const busy = s.skipped.filter(x => x.why === IN_USE).map(x => x.name);
  if (busy.length) out.push(`${list(busy)} could not be moved as ${busy.length === 1 ? 'it is' : 'they are'} in use${s.moved ? '; all others are now moved to the new location' : ''}. Press Drop in the top bar, then Move again. Until then ${busy.length === 1 ? 'it is' : 'they are'} still used from where ${busy.length === 1 ? 'it is' : 'they are'}.`);
  for (const x of s.skipped.filter(x => x.why !== IN_USE).slice(0, 4)) out.push(`${x.name} was not moved: ${x.why}.`);
  const rest = s.skipped.filter(x => x.why !== IN_USE).length - 4;
  if (rest > 0) out.push(`${rest} more ${rest === 1 ? 'was' : 'were'} not moved.`);
  return out.join(' ');
}
