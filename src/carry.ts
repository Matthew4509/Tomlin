// Copies between linked PCs (2.0.32). A model one PC shares can be copied to another, so it is not downloaded from
// Hugging Face again (delete it here to save room, copy it back from a node later); a host can send one of its models
// to a node (installed there from here); and a host can keep a restore point (a backup of its data) on a node. The
// owner of each PC ticks what linked PCs may do there (Nodes and memory, "Sharing permissions"): nothing until
// ticked, and only the models ticked under "Models to share with others" are ever seen or copied.
// Files cross the encrypted link (src/link.ts) in pieces of 16 MB, each one a request of its own, sealed with the
// link's keys and tied to that request: a piece changed on the way, sent twice or out of place is refused, and a copy
// cut short carries on from where it stopped. The parts (both sides) are here, tested in test/carry.test.ts; the doors
// are in src/jobrun/copies.ts (this PC asking) and src/jobrun/node.ts (a node answering).
import { open, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SharedModel } from './nodestaff.ts';
import * as git from './gitstore.ts';

// ---- What linked PCs may do here ----

export interface Allow {
  /** "Sharing of models": linked PCs may copy the models ticked to share. */
  pull: boolean;
  /** "Enable backups": a linked PC may keep its projects (a git repository) and restore points (its data) here. */
  backup: boolean;
  /** "Allow host to push models": a linked PC may send one of its models here, installed in this PC's models folder. */
  push: boolean;
  /** "Allow host to update TOMLIN remotely" (2.0.33): a linked PC with a newer version may install it here (src/update.ts). */
  update: boolean;
}

export const NO_ALLOW: Allow = { pull: false, backup: false, push: false, update: false };

export function cleanAllow(raw: unknown): Allow {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { pull: o.pull === true, backup: o.backup === true, push: o.push === true, update: o.update === true };
}

/** "Allow all" is ticked when every one is. */
export const allowsAll = (a: Allow) => a.pull && a.backup && a.push && a.update;

// ---- Sizes ----

/** One piece of a file on the link. */
export const PIECE = 16 * 2 ** 20;
/** Room left free on a disk after a copy, so a PC is never filled to the brim. */
export const SPARE = 2 * 2 ** 30;
/** Restore points kept on a node for each linked PC: the newest ones; older ones go as a new one comes in. */
export const KEEP_FOR_PC = 3;
/** Nothing larger crosses as one file (the biggest chat models on Hugging Face are split well below this). */
const MAX_FILE = 200 * 2 ** 30;

const GB = (n: number) => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;

// ---- Names that may cross ----

/** A chat model file as one PC names it to another: a file name only, a .gguf, never a way out of the folder. */
export function safeModelFile(v: unknown): string | null {
  return typeof v === 'string' && /^[\w][\w .()+[\]-]{0,199}\.gguf$/i.test(v) && !v.includes('..') ? v : null;
}

/** A backup's file name as a host names it: as keep.ts makes them ("2026-10-06 101500 by hand.zip"). */
export function safeBackupName(v: unknown): string | null {
  return typeof v === 'string' && /^[\w][\w .()-]{0,150}\.zip$/i.test(v) && !v.includes('..') ? v : null;
}

/** The files of a chat model: its first part and the parts beside it (name-00001-of-00003.gguf ...), in order; else it. */
export function modelParts(first: string, names: string[]): string[] {
  const m = /^(.*)-00001-of-(\d{5})\.gguf$/i.exec(first);
  if (!m) return [first];
  const count = Number(m[2]);
  const want = Array.from({ length: count }, (_, k) => `${m[1]}-${String(k + 1).padStart(5, '0')}-of-${m[2]}.gguf`.toLowerCase());
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]));
  return want.every(w => byLower.has(w)) ? want.map(w => byLower.get(w)!) : [first];
}

/** The key two PCs' copies of one model share: a chat model by its file name, a picture model by its id. */
export const modelKey = (kind: 'chat' | 'image', id: string) => (kind === 'image' ? `image:${id}` : `chat:${basename(id.replace(/\\/g, '/')).toLowerCase()}`);

// ---- What the node network has ----

/** A linked PC as its last hello said (or, when it is off, as kept). */
export interface NetPc {
  id: string;
  name: string;
  ok: boolean;
  away: string | null;
  can: string[];
  /** What it lets linked PCs do; null from a PC older than 2.0.32. */
  allow: Allow | null;
  models: SharedModel[];
  /** Kept for backups only (set on this PC): no work is sent to it. */
  backupsOnly?: boolean;
  /** Its backup disk as its hello said it (null: an older TOMLIN, or off). */
  disk?: { total: number; free: number } | null;
  /** Its memory as its hello said it (RAM, graphics card), to tell PCs apart in a list. */
  memory?: unknown;
}

export interface NetPlace {
  pc: string;
  pcName: string;
  /** The model's id on that PC. */
  model: string;
  /** It can be copied from there now. */
  copy: boolean;
  /** Why not, in plain words ('' when it can). */
  why: string;
}

export interface NetRow {
  key: string;
  name: string;
  kind: 'chat' | 'image';
  bytes: number;
  /** Already on this PC. */
  here: boolean;
  on: NetPlace[];
}

/** Why a PC cannot let this one copy its shared model `id` now ('' when it can). */
export function copyWhy(pc: NetPc, id: string): string {
  if (id.startsWith('ollama:')) return `it is an Ollama model on "${pc.name}": get it in Ollama here instead`;
  if (!pc.ok) return `"${pc.name}" is off or not answering now`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.can.includes('carry') || !pc.allow) return `"${pc.name}" runs an older TOMLIN: update it there to copy its models`;
  if (!pc.allow.pull) return `"${pc.name}" lets other PCs use it, not copy it (its owner can tick "Sharing of models" there)`;
  return '';
}

/**
 * Every model the linked PCs share (ticked to share with others), once each, with the PCs that have it and whether
 * it can be copied from each; chat models first, then pictures, by name. Nothing a PC has not ticked is ever listed.
 */
export function networkList(pcs: NetPc[], here: { chatFiles: string[]; pictures: string[] }): NetRow[] {
  const rows = new Map<string, NetRow>();
  const chatHere = new Set(here.chatFiles.map(f => basename(f.replace(/\\/g, '/')).toLowerCase()));
  for (const pc of pcs) {
    for (const m of pc.models) {
      const key = modelKey(m.kind, m.id);
      const row = rows.get(key) ?? { key, name: m.name, kind: m.kind, bytes: m.bytes, here: m.kind === 'image' ? here.pictures.includes(m.id) : chatHere.has(key.slice(5)), on: [] };
      const why = copyWhy(pc, m.id);
      row.on.push({ pc: pc.id, pcName: pc.name, model: m.id, copy: !why, why });
      rows.set(key, row);
    }
  }
  // A PC it can be copied from first.
  for (const r of rows.values()) r.on.sort((a, b) => Number(b.copy) - Number(a.copy));
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'chat' ? -1 : 1));
}

/** Why one of this PC's models cannot be sent to a linked PC now ('' when it can). */
export function sendWhy(pc: NetPc): string {
  if (!pc.ok) return `"${pc.name}" is off or not answering now`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.can.includes('carry') || !pc.allow) return `"${pc.name}" runs an older TOMLIN: update it there first`;
  if (!pc.allow.push) return `"${pc.name}" does not let other PCs install models on it (its owner can tick "Allow host to push models" there)`;
  return '';
}

/** Why this PC's projects cannot be backed up to a linked PC now ('' when they can). */
export function projectsWhy(pc: NetPc): string {
  if (!pc.ok) return `"${pc.name}" is off or not answering now`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.can.includes('git') || !pc.allow) return `"${pc.name}" runs an older TOMLIN: update it there to back up projects to it`;
  if (!pc.allow.backup) return `"${pc.name}" does not keep backups for other PCs (its owner can tick "Enable backups" there)`;
  return '';
}

/** Why a restore point cannot be kept on a linked PC now ('' when it can). */
export function backupWhy(pc: NetPc): string {
  if (!pc.ok) return `"${pc.name}" is off or not answering now`;
  if (pc.away) return `"${pc.name}" is being used by its owner for now`;
  if (!pc.can.includes('carry') || !pc.allow) return `"${pc.name}" runs an older TOMLIN: update it there first`;
  if (!pc.allow.backup) return `"${pc.name}" does not keep restore points for other PCs (its owner can tick "Enable backups" there)`;
  return '';
}

// ---- Room on a disk ----

/** Bytes free on the disk that holds `dir` (its nearest folder that exists); Infinity when it cannot be read. */
export async function freeBytes(dir: string): Promise<number> {
  for (let d = dir, k = 0; k < 30; d = dirname(d), k++) {
    try {
      const s = await statfs(d);
      return s.bavail * s.bsize;
    } catch {
      if (dirname(d) === d) break;
    }
  }
  return Infinity;
}

/** Size and free bytes of the disk that holds `dir` (its nearest folder that exists); null when it cannot be read. */
export async function diskOf(dir: string): Promise<{ total: number; free: number } | null> {
  for (let d = dir, k = 0; k < 30; d = dirname(d), k++) {
    try {
      const s = await statfs(d);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      if (dirname(d) === d) break;
    }
  }
  return null;
}

/** A disk as a hello says it: both numbers whole and sensible, else null. */
export function cleanDisk(v: unknown): { total: number; free: number } | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const total = Number(o.total), free = Number(o.free);
  return Number.isFinite(total) && Number.isFinite(free) && total > 0 && free >= 0 && free <= total ? { total: Math.round(total), free: Math.round(free) } : null;
}

/**
 * The order PCs are offered and backed up to: "Backups only" PCs first (they are there for it), then the rest, each
 * group by name and then address so two PCs with one name keep their places.
 */
export function backupOrder<T extends { name: string; where?: string; backupsOnly?: boolean }>(pcs: T[]): T[] {
  return [...pcs].sort((a, b) => Number(!!b.backupsOnly) - Number(!!a.backupsOnly) || a.name.localeCompare(b.name) || String(a.where ?? '').localeCompare(String(b.where ?? ''), undefined, { numeric: true }));
}

/** Null when `need` more bytes fit on that disk with SPARE left over; else why not, in plain words. */
export function roomWhy(need: number, free: number, where: string): string | null {
  if (need + SPARE <= free) return null;
  return `there is not enough room on ${where}: it needs ${GB(need)} and ${GB(free)} is free (${GB(SPARE)} is kept free).`;
}

// ---- Pieces of a file ----

/** The file being received beside where it goes, until it is whole. */
export const partOf = (dest: string) => `${dest}.part`;

/** Bytes of a file (0 when it is not there). */
export async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** One piece of `file` from byte `from` (shorter at the end). */
export async function readPiece(file: string, from: number, size = PIECE): Promise<Buffer> {
  const h = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await h.read(buf, 0, size, from);
    return buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
}

/**
 * Adds a piece to the file being received, only when it starts where that file ends now (a piece sent again, or one
 * missed, is refused with where the file is, so the sender carries on from there). Gives the new size.
 */
export async function addPiece(part: string, from: number, piece: Buffer): Promise<{ at: number } | { error: string; at: number }> {
  const at = await sizeOf(part);
  if (from !== at) return { error: 'a piece came out of place', at };
  await mkdir(dirname(part), { recursive: true });
  const h = await open(part, at ? 'r+' : 'w');
  try {
    await h.write(piece, 0, piece.length, at);
  } finally {
    await h.close();
  }
  return { at: at + piece.length };
}

/** Where a copy coming in carries on: the end of its part, or the start when the part is longer than the file (left from something else). */
async function startAt(part: string, bytes: number): Promise<number> {
  const at = await sizeOf(part);
  if (at <= bytes) return at;
  await rm(part, { force: true });
  return 0;
}

/** A received file that reached its size takes its place. False when it is not whole (it stays as a part). */
export async function finish(part: string, dest: string, bytes: number): Promise<boolean> {
  if ((await sizeOf(part)) !== bytes) return false;
  await rm(dest, { force: true });
  await rename(part, dest);
  return true;
}

// ---- Restore points kept here for linked PCs ----

/** The folder for one linked PC's restore points: named by its id (or its link, from a PC that sends none). */
export const keptFolder = (root: string, pc: string) => join(root, pc.replace(/[^\w-]/g, '').slice(0, 40) || 'unknown');

export interface Kept {
  name: string;
  bytes: number;
  at: number;
}

/** A linked PC's restore points kept here, newest first (parts still coming in left out). */
export async function listKept(dir: string): Promise<Kept[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: Kept[] = [];
  for (const name of names.filter(n => safeBackupName(n))) {
    try {
      const s = await stat(join(dir, name));
      out.push({ name, bytes: s.size, at: s.mtimeMs });
    } catch {
      // gone
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Keeps the newest KEEP_FOR_PC restore points in `dir`. */
export async function trimKept(dir: string): Promise<void> {
  for (const old of (await listKept(dir)).slice(KEEP_FOR_PC)) await rm(join(dir, old.name), { force: true });
}

// ---- The node's side ----

/** A file this PC can send: what it is called on the link, where it is, how big. */
export interface FileRef {
  name: string;
  path: string;
  bytes: number;
}

export interface NodeDeps {
  allow: () => Allow;
  /** The model ids ticked to share with others. */
  ticked: () => string[];
  pcName: () => string;
  /** A chat model's files (all parts) by its id; null when it is not here or cannot be sent (Ollama). */
  chatFiles: (id: string) => FileRef[] | null;
  /** An installed picture model's files by its id; null when it is not installed. */
  pictureFiles: (id: string) => FileRef[] | null;
  /** Where a chat model sent here goes (this PC's own chat models folder). */
  chatDir: string;
  /** A chat model file of this name is here already (in any of its folders). */
  chatHas: (name: string) => boolean;
  /** Where each file of picture model `id` goes here, and whether it is here whole; null when this PC does not know it. */
  pictureDest: (id: string) => { name: string; path: string; bytes: number; have: boolean }[] | null;
  /** The folder of restore points kept for linked PCs. */
  keptRoot: string;
  freeBytes?: (dir: string) => Promise<number>;
  /** Told when a linked PC's projects were backed up here (the page's list is read again). */
  onProjects?: () => void;
  /** Told when a model was installed here from a linked PC (lists are read again; it is shared from then on). */
  onInstalled?: (name: string, model: { kind: 'chat' | 'image'; id: string }) => void;
}

/** What a door answers: JSON with a status, or a piece of a file. */
export type NodeAnswer = { status: number; json: Record<string, unknown> } | { status: 200; piece: Buffer };

const no = (status: number, error: string): NodeAnswer => ({ status, json: { error } });
const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : -1);

/** The doors of a node for copies: /worker/carry-* and /worker/backup-*. `who` is the linked PC asking (its folder key and name). */
export function nodeSide(d: NodeDeps) {
  const room = d.freeBytes ?? freeBytes;
  /** Files being written now, by whom, so two PCs never write one file together. */
  const writing = new Map<string, { pc: string; at: number }>();
  const claim = (file: string, pc: string): boolean => {
    const w = writing.get(file);
    if (w && w.pc !== pc && Date.now() - w.at < 120_000) return false;
    writing.set(file, { pc, at: Date.now() });
    return true;
  };

  /** A shared model's files, when linked PCs may copy it. */
  function shared(b: Record<string, unknown>): FileRef[] | string {
    if (!d.allow().pull) return `"${d.pcName()}" does not let other PCs copy its models now (its owner ticks "Sharing of models" under Nodes and memory).`;
    const id = typeof b.model === 'string' ? b.model : '';
    if (!d.ticked().includes(id)) return `"${d.pcName()}" does not share that model now.`;
    const files = b.kind === 'image' ? d.pictureFiles(id) : d.chatFiles(id);
    return files?.length ? files : `that model is not on "${d.pcName()}" any more, or it cannot be copied (an Ollama model).`;
  }

  /** Where each file of a model sent here goes; or why it cannot come. */
  function incoming(b: Record<string, unknown>): { files: { name: string; path: string; bytes: number }[]; have: boolean } | string {
    if (!d.allow().push) return `"${d.pcName()}" does not let other PCs install models on it now (its owner ticks "Allow host to push models" under Nodes and memory).`;
    const raw = Array.isArray(b.files) ? b.files.slice(0, 64) : [];
    if (b.kind === 'image') {
      const dest = typeof b.model === 'string' ? d.pictureDest(b.model) : null;
      if (!dest) return `"${d.pcName()}" runs a TOMLIN that does not know that picture model: update it there first.`;
      const sent = raw.map(f => int((f as Record<string, unknown>)?.bytes));
      if (sent.length !== dest.length || dest.some((f, k) => f.bytes !== sent[k])) return `"${d.pcName()}" knows another version of that picture model: update TOMLIN on both PCs.`;
      return { files: dest.map(({ name, path, bytes }) => ({ name, path, bytes })), have: dest.every(f => f.have) };
    }
    const files: { name: string; path: string; bytes: number }[] = [];
    for (const f of raw) {
      const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const name = safeModelFile(x.name);
      const bytes = int(x.bytes);
      if (!name || bytes <= 0 || bytes > MAX_FILE) return 'a file of that model was not named as a model file, so it was refused.';
      files.push({ name, path: join(d.chatDir, name), bytes });
    }
    if (!files.length) return 'no files were named.';
    return { files, have: d.chatHas(files[0].name) };
  }

  return async function handle(p: string, b: Record<string, unknown>, who: { key: string; name: string }, piece?: Buffer): Promise<NodeAnswer> {
    switch (p) {
      case '/worker/carry-files': {
        const files = shared(b);
        if (typeof files === 'string') return no(403, files);
        return { status: 200, json: { files: files.map(f => ({ name: f.name, bytes: f.bytes })) } };
      }
      case '/worker/carry-get': {
        const files = shared(b);
        if (typeof files === 'string') return no(403, files);
        const f = files[int(b.file)];
        const from = int(b.from);
        if (!f || from < 0 || from >= f.bytes) return no(400, 'that piece is not part of the model.');
        return { status: 200, piece: await readPiece(f.path, from) };
      }
      case '/worker/carry-offer': {
        const got = incoming(b);
        if (typeof got === 'string') return no(403, got);
        if (got.have) return { status: 200, json: { have: true } };
        const at = await Promise.all(got.files.map(f => sizeOf(partOf(f.path))));
        const need = got.files.reduce((n, f, k) => n + f.bytes - Math.min(at[k], f.bytes), 0);
        const why = roomWhy(need, await room(dirname(got.files[0].path)), `"${d.pcName()}"`);
        if (why) return no(507, why);
        return { status: 200, json: { have: false, at } };
      }
      case '/worker/carry-put': {
        const got = incoming(b);
        if (typeof got === 'string') return no(403, got);
        const f = got.files[int(b.file)];
        if (!f || !piece) return no(400, 'that piece is not part of the model.');
        // A file already whole here is never written over by a copy (only its unfinished part takes pieces).
        if ((await sizeOf(f.path)) === f.bytes) return no(409, `${basename(f.path)} is already whole on "${d.pcName()}".`);
        if (!claim(f.path, who.key)) return no(409, `another PC is sending that model to "${d.pcName()}" now.`);
        const r = await addPiece(partOf(f.path), int(b.from), piece);
        if ('error' in r) return { status: 409, json: r };
        if (r.at > f.bytes) {
          await rm(partOf(f.path), { force: true });
          return no(400, 'more came than the file holds, so it was thrown away. Send it again.');
        }
        const done = r.at === f.bytes && (await finish(partOf(f.path), f.path, f.bytes));
        if (done) {
          writing.delete(f.path);
          if (int(b.file) === got.files.length - 1) d.onInstalled?.(String(b.name ?? f.name), b.kind === 'image' ? { kind: 'image', id: String(b.model) } : { kind: 'chat', id: got.files[0].name });
        }
        return { status: 200, json: { at: r.at, done } };
      }
      case '/worker/carry-drop': {
        // A send that was stopped: its unfinished parts go (whole files stay).
        const got = incoming(b);
        if (typeof got === 'string') return no(403, got);
        for (const f of got.files) {
          const w = writing.get(f.path);
          if (w && w.pc !== who.key) continue;
          writing.delete(f.path);
          await rm(partOf(f.path), { force: true });
        }
        return { status: 200, json: { ok: true } };
      }
      // A linked PC's own restore points: listing and bringing one back work even after "Enable backups" is
      // unticked (they are that PC's data); a new one needs the tick.
      case '/worker/backup-list':
        return { status: 200, json: { backups: await listKept(keptFolder(d.keptRoot, who.key)), allowed: d.allow().backup } };
      case '/worker/backup-put': {
        if (!d.allow().backup) return no(403, `"${d.pcName()}" does not keep restore points for other PCs now (its owner ticks "Enable backups" under Nodes and memory).`);
        const name = safeBackupName(b.name);
        const bytes = int(b.bytes);
        const from = int(b.from);
        if (!name || bytes <= 0 || bytes > MAX_FILE || !piece) return no(400, 'that restore point was not named as one, so it was refused.');
        const dir = keptFolder(d.keptRoot, who.key);
        const dest = join(dir, name);
        if (from === 0) {
          const why = roomWhy(bytes, await room(dir), `"${d.pcName()}"`);
          if (why) return no(507, why);
          // A new one starts: a part left by one that was stopped or cut is thrown away (it would never be finished).
          for (const n of await readdir(dir).catch(() => [] as string[])) if (n.endsWith('.zip.part') && n !== `${name}.part`) await rm(join(dir, n), { force: true });
        }
        if (!claim(dest, who.key)) return no(409, 'that restore point is coming in already.');
        const r = await addPiece(partOf(dest), from, piece);
        if ('error' in r) return { status: 409, json: r };
        if (r.at > bytes) {
          await rm(partOf(dest), { force: true });
          return no(400, 'more came than the restore point holds, so it was thrown away. Send it again.');
        }
        const done = r.at === bytes && (await finish(partOf(dest), dest, bytes));
        if (done) {
          writing.delete(dest);
          await writeOwner(dir, who.name);
          await trimKept(dir);
        }
        return { status: 200, json: { at: r.at, done } };
      }
      case '/worker/backup-get': {
        const name = safeBackupName(b.name);
        const from = int(b.from);
        const file = name ? join(keptFolder(d.keptRoot, who.key), name) : '';
        const bytes = file ? await sizeOf(file) : 0;
        if (!bytes || from < 0 || from >= bytes) return no(404, `that restore point is not kept on "${d.pcName()}" any more.`);
        return { status: 200, piece: await readPiece(file, from) };
      }
      // ---- Project backups: a git repository kept here for each host (src/gitstore.ts) ----
      case '/worker/git-have': {
        // Which of these files (by their git id) this PC does not have yet: only those are sent.
        if (!d.allow().backup) return no(403, backupOff(d.pcName()));
        const ids = Array.isArray(b.ids) ? b.ids.slice(0, MAX_IDS).filter(git.isId) : [];
        const repo = projectsRepo(d.keptRoot, who.key);
        const missing: string[] = [];
        for (const id of ids) if (!(await git.hasObject(repo, id))) missing.push(id);
        return { status: 200, json: { missing } };
      }
      case '/worker/git-put': {
        if (!d.allow().backup) return no(403, backupOff(d.pcName()));
        const id = git.isId(b.id) ? b.id : '';
        const bytes = int(b.bytes);
        const from = int(b.from);
        if (!id || bytes < 0 || bytes > MAX_FILE || from < 0 || !piece) return no(400, 'that file of the backup was not named as one, so it was refused.');
        const repo = projectsRepo(d.keptRoot, who.key);
        await git.initRepo(repo);
        if (await git.hasObject(repo, id)) return { status: 200, json: { at: bytes, done: true } };
        const part = join(repo, 'incoming', `${id}.part`);
        if (from === 0) {
          const why = roomWhy(bytes, await room(repo), `"${d.pcName()}"`);
          if (why) return no(507, why);
          await rm(part, { force: true });
          await mkdir(dirname(part), { recursive: true });
          await writeFile(part, '');
        }
        const r = piece.length ? await addPiece(part, from, piece) : { at: await sizeOf(part) };
        if ('error' in r) return { status: 409, json: r };
        if (r.at > bytes) {
          await rm(part, { force: true });
          return no(400, 'more came than the file holds, so it was thrown away. Back up again.');
        }
        if (r.at < bytes) return { status: 200, json: { at: r.at, done: false } };
        const ok = await git.storeBlobFile(repo, part, id);
        await rm(part, { force: true });
        if (!ok) return no(400, 'a file of the backup changed on the way, so it was not kept. Back up again.');
        return { status: 200, json: { at: bytes, done: true } };
      }
      case '/worker/git-commit': {
        if (!d.allow().backup) return no(403, backupOff(d.pcName()));
        const raw = Array.isArray(b.files) ? b.files : [];
        if (raw.length > MAX_FILES) return no(400, `a backup holds at most ${MAX_FILES.toLocaleString('en')} files.`);
        const files: git.Entry[] = [];
        for (const f of raw) {
          const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
          const path = git.safePath(x.path);
          if (!path || !git.isId(x.id)) return no(400, 'a file of the backup was not named as one, so the backup was refused.');
          files.push({ path, id: x.id });
        }
        const repo = projectsRepo(d.keptRoot, who.key);
        try {
          const c = await git.commitFiles(repo, files, typeof b.message === 'string' ? b.message.slice(0, 300) : 'Backup');
          await writeOwner(keptFolder(d.keptRoot, who.key), who.name);
          d.onProjects?.();
          return { status: 200, json: c };
        } catch (e) {
          return no(409, `${(e as Error).message}: back up again.`);
        }
      }
      // Listing and bringing back work even after "Enable backups" is unticked (they are that PC's projects).
      case '/worker/git-log': {
        const repo = projectsRepo(d.keptRoot, who.key);
        const log = await git.logOf(repo, 30).catch(() => [] as git.Commit[]);
        return { status: 200, json: { commits: log.map(c => ({ id: c.id, at: c.at, message: c.message })), allowed: d.allow().backup } };
      }
      case '/worker/git-files': {
        const repo = projectsRepo(d.keptRoot, who.key);
        const id = git.isId(b.commit) ? b.commit : await git.headOf(repo);
        if (!id) return no(404, `no projects of yours are kept on "${d.pcName()}".`);
        try {
          const c = await git.readCommit(repo, id);
          const files = await git.listTree(repo, c.tree);
          const out = [];
          for (const f of files) out.push({ ...f, bytes: await git.blobSize(repo, f.id) });
          // Unpacked copies left from an earlier bringing back go (they are made again when asked).
          await rm(join(repo, 'out'), { recursive: true, force: true });
          return { status: 200, json: { commit: id, at: c.at, files: out } };
        } catch {
          return no(404, `that backup is not kept on "${d.pcName()}" any more.`);
        }
      }
      case '/worker/git-get': {
        const repo = projectsRepo(d.keptRoot, who.key);
        const id = git.isId(b.id) ? b.id : '';
        const from = int(b.from);
        if (!id || !(await git.hasObject(repo, id))) return no(404, `that file is not kept on "${d.pcName()}" any more.`);
        const out = join(repo, 'out', id);
        if (from === 0 || !(await exists(out))) await git.blobToFile(repo, id, out);
        const bytes = await sizeOf(out);
        if (from < 0 || (bytes && from >= bytes)) return no(400, 'that piece is not part of the file.');
        return { status: 200, piece: bytes ? await readPiece(out, from) : Buffer.alloc(0) };
      }
      default:
        return no(404, 'this PC does not know that door.');
    }
  };
}

// ---- Project backups kept here ----

/** Ids asked about in one go, and files in one backup. */
export const MAX_IDS = 2000;
export const MAX_FILES = 100_000;
const backupOff = (pc: string) => `"${pc}" does not keep backups for other PCs now (its owner ticks "Enable backups" under Nodes and memory).`;

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The git repository of one linked PC's projects, beside its restore points. */
export const projectsRepo = (root: string, pc: string) => join(keptFolder(root, pc), 'projects.git');

/** Projects kept here for linked PCs, for this PC's own page: whose, the newest backup, how many files and backups. */
export async function projectsHere(root: string): Promise<{ key: string; name: string; at: number; files: number; backups: number; folder: string }[]> {
  const out: { key: string; name: string; at: number; files: number; backups: number; folder: string }[] = [];
  for (const k of await readdir(root).catch(() => [] as string[])) {
    const repo = join(root, k, 'projects.git');
    const log = await git.logOf(repo, 500).catch(() => [] as git.Commit[]);
    if (!log.length) continue;
    let name = 'A linked PC';
    try {
      name = String(JSON.parse(await readFile(join(root, k, 'pc.json'), 'utf8')).name || name);
    } catch {
      // no name kept
    }
    const files = (await git.listTree(repo, log[0].tree).catch(() => [] as git.Entry[])).length;
    out.push({ key: k, name, at: log[0].at, files, backups: log.length, folder: repo });
  }
  return out;
}

/** Writes the newest backup of one linked PC's projects into `dest` (a new folder). Gives how many files. */
export async function projectsOut(root: string, key: string, dest: string): Promise<number> {
  const repo = projectsRepo(root, key);
  const head = await git.headOf(repo);
  if (!head) throw new Error('no projects are kept here for that PC');
  const c = await git.readCommit(repo, head);
  const files = await git.listTree(repo, c.tree);
  let n = 0;
  for (const f of files) {
    const path = git.safePath(f.path);
    if (!path) continue;
    await git.blobToFile(repo, f.id, join(dest, ...path.split('/')));
    n++;
  }
  return n;
}

/** The name of the PC whose restore points a folder holds, shown on the node's page. */
async function writeOwner(dir: string, name: string) {
  await writeFile(join(dir, 'pc.json'), JSON.stringify({ name: String(name).slice(0, 40) }));
}

/** Restore points kept on this PC for linked PCs, for its own page: whose, how many, how big. */
export async function keptHere(root: string): Promise<{ name: string; count: number; bytes: number; newest: number }[]> {
  const out: { name: string; count: number; bytes: number; newest: number }[] = [];
  for (const k of await readdir(root).catch(() => [] as string[])) {
    const list = await listKept(join(root, k));
    if (!list.length) continue;
    let name = 'A linked PC';
    try {
      name = String(JSON.parse(await readFile(join(root, k, 'pc.json'), 'utf8')).name || name);
    } catch {
      // no name kept
    }
    out.push({ name, count: list.length, bytes: list.reduce((n, x) => n + x.bytes, 0), newest: Math.max(...list.map(x => x.at)) });
  }
  return out;
}

// ---- The host's side ----

/** How the host talks to one linked PC: sealed requests, answered with JSON or a piece. Errors carry the PC's words. */
export interface Wire {
  ask: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getPiece: (path: string, body: Record<string, unknown>) => Promise<Buffer>;
  putPiece: (path: string, body: Record<string, unknown>, piece: Buffer) => Promise<Record<string, unknown>>;
}

export interface Progress {
  done: number;
  bytes: number;
}

/**
 * Copies a shared model from a linked PC: each file into its place here (a .part beside it until it is whole, so a copy
 * cut short carries on from there next time). `dest(k, name, bytes)` says where file k goes, or why it cannot.
 */
export async function pull(w: Wire, o: { kind: 'chat' | 'image'; model: string; dest: (files: { name: string; bytes: number }[]) => Promise<string[] | string>; progress: (p: Progress) => void; signal: AbortSignal }): Promise<{ files: string[] }> {
  const got = await w.ask('/worker/carry-files', { kind: o.kind, model: o.model });
  const files = (Array.isArray(got.files) ? got.files : []).map(f => ({ name: String((f as Record<string, unknown>).name ?? ''), bytes: int((f as Record<string, unknown>).bytes) }));
  if (!files.length || files.some(f => f.bytes <= 0)) throw new Error('that PC named no files for this model.');
  const where = await o.dest(files);
  if (typeof where === 'string') throw new Error(where);
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  let before = 0;
  for (const [k, f] of files.entries()) {
    const part = partOf(where[k]);
    if ((await sizeOf(where[k])) === f.bytes) {
      before += f.bytes;
      continue;
    }
    for (let at = await startAt(part, f.bytes); at < f.bytes;) {
      if (o.signal.aborted) throw new Error('Stopped.');
      o.progress({ done: before + at, bytes });
      const piece = await w.getPiece('/worker/carry-get', { kind: o.kind, model: o.model, file: k, from: at });
      if (!piece.length) throw new Error('that PC sent an empty piece.');
      const r = await addPiece(part, at, piece);
      if ('error' in r) throw new Error(`the copy here changed while it came in (${r.error}). Press it again to carry on.`);
      at = r.at;
    }
    if (!(await finish(part, where[k], f.bytes))) throw new Error('the copy came in at the wrong size, so it was not used. Press it again.');
    before += f.bytes;
  }
  o.progress({ done: bytes, bytes });
  return { files: where };
}

/** Sends one of this PC's models to a linked PC, carrying on from what it has of it. False when it was there already. */
export async function push(w: Wire, o: { kind: 'chat' | 'image'; model: string; name: string; files: FileRef[]; progress: (p: Progress) => void; signal: AbortSignal }): Promise<boolean> {
  const ask = { kind: o.kind, model: o.model, name: o.name, files: o.files.map(f => ({ name: f.name, bytes: f.bytes })) };
  const offer = await w.ask('/worker/carry-offer', ask);
  if (offer.have === true) return false;
  const at0 = Array.isArray(offer.at) ? offer.at.map(int) : [];
  const bytes = o.files.reduce((n, f) => n + f.bytes, 0);
  let before = 0;
  for (const [k, f] of o.files.entries()) {
    let at = Math.max(0, at0[k] ?? 0);
    if (at > f.bytes) at = 0;
    while (at < f.bytes) {
      if (o.signal.aborted) {
        await w.ask('/worker/carry-drop', ask).catch(() => undefined);
        throw new Error('Stopped.');
      }
      o.progress({ done: before + at, bytes });
      const r = await w.putPiece('/worker/carry-put', { ...ask, file: k, from: at }, await readPiece(f.path, at));
      at = int(r.at);
      if (at < 0) throw new Error('that PC did not say how much it has.');
    }
    before += f.bytes;
  }
  o.progress({ done: bytes, bytes });
  return true;
}

/** Sends a restore point (a backup zip here) to a linked PC. */
export async function pushBackup(w: Wire, o: { file: string; name: string; progress: (p: Progress) => void; signal: AbortSignal }): Promise<void> {
  const bytes = await sizeOf(o.file);
  if (!bytes) throw new Error('the backup was not made.');
  for (let at = 0; at < bytes;) {
    if (o.signal.aborted) throw new Error('Stopped.');
    o.progress({ done: at, bytes });
    const r = await w.putPiece('/worker/backup-put', { name: o.name, bytes, from: at }, await readPiece(o.file, at));
    at = int(r.at);
    if (at < 0) throw new Error('that PC did not say how much it has.');
  }
  o.progress({ done: bytes, bytes });
}

/** Brings a restore point kept on a linked PC back into this PC's backups folder. */
export async function pullBackup(w: Wire, o: { name: string; bytes: number; dest: string; progress: (p: Progress) => void; signal: AbortSignal }): Promise<void> {
  const part = partOf(o.dest);
  for (let at = await startAt(part, o.bytes); at < o.bytes;) {
    if (o.signal.aborted) throw new Error('Stopped.');
    o.progress({ done: at, bytes: o.bytes });
    const piece = await w.getPiece('/worker/backup-get', { name: o.name, from: at });
    if (!piece.length) throw new Error('that PC sent an empty piece.');
    const r = await addPiece(part, at, piece);
    if ('error' in r) throw new Error(`the copy here changed while it came in (${r.error}). Press it again.`);
    at = r.at;
  }
  if (!(await finish(part, o.dest, o.bytes))) throw new Error('the restore point came in at the wrong size, so it was not used. Press it again.');
  o.progress({ done: o.bytes, bytes: o.bytes });
}

// ---- Copies running on the host, for its page ----

export interface Transfer {
  id: string;
  /** copy: a model from a linked PC; send: one of this PC's to a linked PC; backup: a restore point to it; bring: one back; update: this TOMLIN to it; projects: the projects backed up to it; restore: brought back from it. */
  kind: 'copy' | 'send' | 'backup' | 'bring' | 'update' | 'projects' | 'restore';
  what: string;
  pc: string;
  pcName: string;
  done: number;
  bytes: number;
  state: 'working' | 'done' | 'stopped' | 'failed';
  /** An update only: the step it is on (comparing the files, sending them, starting the new version there, checking it answers). */
  stage?: 'compare' | 'send' | 'start' | 'check';
  /** An update only: what that PC is busy with while the new version waits to start there. */
  wait?: string;
  said: string;
  started: number;
  ended: number | null;
}

/** The copies this PC is making or made (the last 12), one at a time per linked PC. */
export class Transfers {
  private list: Transfer[] = [];
  private stops = new Map<string, AbortController>();
  private n = 0;

  view(): Transfer[] {
    return this.list.map(t => ({ ...t }));
  }

  /** What Stop leaves, said when it is pressed: a copy here carries on; a send was cleared on that PC. */
  static stopped(kind: Transfer['kind'], pcName: string): string {
    if (kind === 'send') return `Stopped. Nothing half-sent is left on "${pcName}": Send a copy starts it again.`;
    if (kind === 'backup' || kind === 'projects') return 'Stopped. Back up again when you are ready.';
    if (kind === 'update') return `Stopped. Nothing was changed on "${pcName}": it still runs its old version.`;
    return 'Stopped. Press it again to carry on from where it stopped.';
  }

  /** Starts one (returns at once); refused while that linked PC has one running. */
  start(t: Pick<Transfer, 'kind' | 'what' | 'pc' | 'pcName'>, run: (progress: (p: Partial<Pick<Transfer, 'done' | 'bytes' | 'stage' | 'wait'>>) => void, signal: AbortSignal) => Promise<string>): Transfer | { error: string } {
    const busy = this.list.find(x => x.pc === t.pc && x.state === 'working');
    if (busy) return { error: `"${t.pcName}" is busy with "${busy.what}" now. Wait for it, or stop it, then try again.` };
    const job: Transfer = { ...t, id: `t${++this.n}`, done: 0, bytes: 0, state: 'working', said: '', started: Date.now(), ended: null };
    const ac = new AbortController();
    this.stops.set(job.id, ac);
    this.list = [job, ...this.list].slice(0, 12);
    void run(p => Object.assign(job, p), ac.signal).then(said => {
      job.state = 'done';
      job.said = said;
    }, e => {
      job.state = ac.signal.aborted ? 'stopped' : 'failed';
      job.said = ac.signal.aborted ? Transfers.stopped(job.kind, job.pcName) : (e as Error).message;
    }).finally(() => {
      job.ended = Date.now();
      this.stops.delete(job.id);
    });
    return job;
  }

  stop(id: string): boolean {
    const ac = this.stops.get(id);
    ac?.abort();
    return !!ac;
  }
}
