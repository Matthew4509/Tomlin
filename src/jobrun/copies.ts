// Copies between linked PCs (src/carry.ts), this PC's side: models both ways, restore points, and updates pushed.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as git from '../gitstore.ts';
import * as share from '../share.ts';
import * as link from '../link.ts';
import * as carry from '../carry.ts';
import * as update from '../update.ts';
import * as pb from '../projectbackup.ts';
import type { Remote } from '../store.ts';
import { d, sleep } from './shared.ts';
import { hello, remoteStatus } from './links.ts';
import type { Hello } from '../jobrun.ts';

// ---- Copies between linked PCs (src/carry.ts): this PC's side ----

/** How this PC talks to a linked PC for copies: sealed requests, a piece of a file each way as sealed bytes. */
function wireFor(r: Remote): carry.Wire {
  const keys = link.keysOf(r.key);
  if (!keys) throw new Error(`"${r.name}" was linked before links were encrypted. Link it again: Other PCs, Find PCs on my network, then its setup code.`);
  const said = async (res: Response, id: string): Promise<Record<string, unknown>> => {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const v = (typeof data.box === 'string' ? link.openAnswer(keys, id, 0, data.box) : data) as Record<string, unknown>;
    return v && typeof v === 'object' ? v : {};
  };
  const call = async (path: string, body: Record<string, unknown>, piece?: Buffer) => {
    const headers: Record<string, string> = { authorization: `Link ${share.hashToken(r.token)}` };
    // A piece is 16 MB: 5 minutes is 55 KB a second, slower than any home network that works.
    let tries = 0;
    for (;;) {
      // Sealed afresh for each try: the node takes each sealed request once, so a resend of the same one is refused.
      const req = link.sealRequest(keys, path, body);
      const id = link.requestId(req.box);
      // A piece sent: the request rides in a header and the piece, sealed, is the body.
      const init: RequestInit = piece
        ? { method: 'POST', headers: { ...headers, 'x-link': req.box, 'content-type': 'application/octet-stream' }, body: new Uint8Array(link.sealBytes(link.toNode(keys), piece, `piece|${id}`)) }
        : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(req) };
      try {
        return { res: await fetch(`${r.url}${path}`, { ...init, signal: AbortSignal.timeout(300_000) }), id };
      } catch (e) {
        // The network dropped for a moment: twice more, a few seconds apart, before it counts.
        if (++tries > 2) throw new Error(`"${r.name}" could not be reached at ${r.url} (${(e as Error).message}). Press it again to carry on from where it stopped.`);
        await sleep(3000);
      }
    }
  };
  const fault = (v: Record<string, unknown>, status: number) => new Error(`"${r.name}": ${String(v.error ?? `it answered ${status}`)}`);
  return {
    async ask(path, body) {
      const { res, id } = await call(path, body);
      const v = await said(res, id);
      if (!res.ok) throw fault(v, res.status);
      return v;
    },
    async getPiece(path, body) {
      const { res, id } = await call(path, body);
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('application/octet-stream')) throw fault(await said(res, id), res.status);
      const piece = link.openBytes(link.toHost(keys), Buffer.from(await res.arrayBuffer()), `piece|${id}`);
      if (!piece) throw new Error(`a piece from "${r.name}" could not be opened (changed on the way), so it was refused. Press it again to carry on.`);
      return piece;
    },
    async putPiece(path, body, piece) {
      const { res, id } = await call(path, body, piece);
      const v = await said(res, id);
      // Out of place (a piece that crossed twice after a dropped answer): it says where it is, and the copy carries on from there.
      if (res.status === 409 && typeof v.at === 'number') return v;
      if (!res.ok) throw fault(v, res.status);
      return v;
    },
  };
}

export const transfers = new carry.Transfers();

/** Every linked PC as the copies need it: what it shares and lets this PC do (kept models when it is off). */
async function netPcs(): Promise<carry.NetPc[]> {
  const s = await d.store.settings();
  return (await remoteStatus()).map(r => ('allow' in r && r.ok
    ? { id: r.id, name: r.name, ok: true, away: r.away ?? null, can: r.can ?? [], allow: r.allow ?? null, models: r.models ?? [], backupsOnly: r.backupsOnly, disk: r.disk ?? null, memory: r.memory }
    : { id: r.id, name: r.name, ok: false, away: null, can: [], allow: null, models: s.remotes.find(x => x.id === r.id)?.models ?? [], backupsOnly: r.backupsOnly, disk: null, memory: null }));
}

/** What tells one PC from another in a list: its RAM, its graphics card and that card's memory (from its hello). */
function specsOf(memory: unknown): { ram: number | null; gpu: string | null; vram: number | null } {
  const m = (memory && typeof memory === 'object' ? memory : {}) as { ram?: { total?: unknown }; gpu?: { name?: unknown; total?: unknown } | null };
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return { ram: num(m.ram?.total), gpu: m.gpu && typeof m.gpu.name === 'string' ? m.gpu.name.slice(0, 80) : null, vram: num(m.gpu?.total) };
}

/** Why a backup of `bytes` would not fit on that PC's backup disk now ('' when it fits, or its disk is not known). */
function roomOn(pc: carry.NetPc, bytes: number): string {
  return pc.disk ? carry.roomWhy(bytes, pc.disk.free, `"${pc.name}"`) ?? '' : '';
}

/** "My local LLMs": every model the linked PCs share, and what this PC can send them. */
export async function network() {
  const pcs = await netPcs();
  const pictures = d.pictureModels();
  const chats = d.chatList();
  return {
    rows: carry.networkList(pcs, { chatFiles: chats.map(m => m.id), pictures: pictures.filter(m => m.installed).map(m => m.id) }),
    pcs: await Promise.all(pcs.map(async pc => ({ id: pc.id, name: pc.name, ok: pc.ok, send: carry.sendWhy(pc), backup: carry.backupWhy(pc), projects: carry.projectsWhy(pc), projectsDone: (await projectsDone())[pc.id] ?? null, shares: pc.models.length }))),
    mine: [
      ...chats.filter(m => !m.id.startsWith('ollama:')).map(m => ({ kind: 'chat' as const, id: m.id, name: m.name, bytes: m.bytes })),
      ...pictures.filter(m => m.installed).map(m => ({ kind: 'image' as const, id: m.id, name: m.name.replace(/\s*\(.*\)$/, ''), bytes: m.bytes ?? 0 })),
    ],
    transfers: transfers.view(),
  };
}

const GBs = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

/** Starts a copy of a linked PC's shared model to this PC. */
export async function copyFrom(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more. Close this window and open it again.' } };
  const kind = b.kind === 'image' ? 'image' : 'chat';
  const model = String(b.model ?? '');
  const pc = (await netPcs()).find(x => x.id === r.id)!;
  const shared = pc.models.find(m => m.id === model && m.kind === kind);
  const why = !shared ? `"${r.name}" no longer shares that model.` : carry.copyWhy(pc, model);
  if (why) return { status: 409, body: { error: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`.replace(/\.\.$/, '.') } };
  const w = wireFor(r);
  const dest = async (files: { name: string; bytes: number }[]): Promise<string[] | string> => {
    const need = files.reduce((n, f) => n + f.bytes, 0);
    if (kind === 'image') {
      const here = d.carry.pictureDest(model);
      if (!here) return 'this PC does not know that picture model: update TOMLIN here first.';
      if (here.length !== files.length || here.some((f, k) => f.bytes !== files[k].bytes)) return `"${r.name}" has another version of that picture model: update TOMLIN on both PCs.`;
      if (here.every(f => f.have)) return 'it is on this PC already.';
      const room = carry.roomWhy(need, await carry.freeBytes(here[0].path), 'this PC');
      return room ?? here.map(f => f.path);
    }
    const names = files.map(f => carry.safeModelFile(f.name));
    if (names.some(n => !n)) return `"${r.name}" named a file that is not a model file, so nothing was copied.`;
    // There only when every part is whole: a split model cut off part way is carried on with.
    if ((await Promise.all(names.map((n, k) => carry.sizeOf(join(d.carry.chatDir, n!))))).every((n, k) => n === files[k].bytes)) return 'it is on this PC already (Models).';
    const room = carry.roomWhy(need, await carry.freeBytes(d.carry.chatDir), 'this PC');
    return room ?? names.map(n => join(d.carry.chatDir, n!));
  };
  const t = transfers.start({ kind: 'copy', what: shared!.name, pc: r.id, pcName: r.name }, async (progress, signal) => {
    await carry.pull(w, { kind, model, dest, progress, signal });
    d.carry.onInstalled();
    return `${shared!.name} is on this PC now (${GBs(shared!.bytes)}), copied from "${r.name}". ${kind === 'image' ? 'An artist can draw with it.' : 'Pick it in the chat or for a hire.'}`;
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

/** Starts sending one of this PC's models to a linked PC (installed in its models folder). */
export async function sendTo(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more. Close this window and open it again.' } };
  const kind = b.kind === 'image' ? 'image' : 'chat';
  const model = String(b.model ?? '');
  const pc = (await netPcs()).find(x => x.id === r.id)!;
  const why = carry.sendWhy(pc);
  if (why) return { status: 409, body: { error: `${why.charAt(0).toUpperCase()}${why.slice(1)}.` } };
  const files = kind === 'image' ? d.carry.pictureFiles(model) : d.carry.chatFiles(model);
  if (!files?.length) return { status: 404, body: { error: 'That model is not on this PC any more (or it is an Ollama model, which cannot be sent).' } };
  const name = kind === 'image' ? (d.pictureModels().find(m => m.id === model)?.name.replace(/\s*\(.*\)$/, '') ?? model) : (d.chatList().find(m => m.id === model)?.name ?? model);
  const w = wireFor(r);
  const t = transfers.start({ kind: 'send', what: name, pc: r.id, pcName: r.name }, async (progress, signal) => {
    const sent = await carry.push(w, { kind, model, name, files, progress, signal });
    return sent ? `${name} is on "${r.name}" now. Its owner ticks it under "Models to share with others" there if this PC should use it.` : `${name} was on "${r.name}" already: nothing was sent.`;
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

/** A linked PC's restore points of this PC's data. */
export async function keptOn(pcId: string | null) {
  const r = (await d.store.settings()).remotes.find(x => x.id === pcId);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  try {
    const v = await wireFor(r).ask('/worker/backup-list', {});
    return { status: 200, body: { backups: Array.isArray(v.backups) ? v.backups : [], allowed: v.allowed === true } };
  } catch (e) {
    return { status: 502, body: { error: (e as Error).message } };
  }
}

/** Makes a backup of this PC's data now and keeps it on a linked PC too. */
export async function backupTo(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  const pc = (await netPcs()).find(x => x.id === r.id)!;
  const why = carry.backupWhy(pc);
  if (why) return { status: 409, body: { error: `${why.charAt(0).toUpperCase()}${why.slice(1)}.` } };
  const w = wireFor(r);
  const t = transfers.start({ kind: 'backup', what: 'A restore point of your data', pc: r.id, pcName: r.name }, async (progress, signal) => {
    const name = await d.carry.makeBackup(`kept on ${r.name}`);
    await carry.pushBackup(w, { file: join(d.carry.backupsDir, name), name, progress, signal });
    return `Backed up as "${name.replace(/\.zip$/, '')}": one copy in this PC's backups, one on "${r.name}" (it keeps your newest ${carry.KEEP_FOR_PC}).`;
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

/** This copy's app files with their hashes, kept between updates (hashing 300 MB takes a few seconds). */
const ownHashes = new Map<string, { key: string; sha: string }>();

/** Sends this PC's TOMLIN to a linked PC that runs an older one; it starts the new version by itself. */
export async function updatePc(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  let h: Hello;
  try {
    h = await hello(r, 5000);
  } catch (e) {
    return { status: 502, body: { error: `"${r.name}" could not be reached (${(e as Error).message}).` } };
  }
  const why = update.updateWhy({ name: r.name, ok: true, version: h.version, build: h.build, away: h.away, can: h.can, restarts: h.restarts, allowUpdate: h.allow?.update === true }, d.version, d.build());
  if (why === null) return { status: 409, body: { error: `"${r.name}" already runs TOMLIN ${h.version || d.version}${h.build && h.build === d.build() ? `, the same files as this PC (build ${update.shortBuild(h.build)})` : ''}.` } };
  if (why) return { status: 409, body: { error: `${why.charAt(0).toUpperCase()}${why.slice(1)}.` } };
  // The version sent is the one this copy runs, but the files are read from its folder: a folder changed since this
  // copy started (a newer version unzipped or built over it) would send files that say another version, and that PC
  // refuses them at the very end. Said here, before anything is sent.
  const onDisk = await update.versionIn(d.update.root);
  if (onDisk && onDisk !== d.version) return { status: 409, body: { error: `This PC runs TOMLIN ${d.version}, but its folder now holds ${onDisk}: it changed after TOMLIN started here, so the files would not match the version sent. Close TOMLIN on this PC and start it again, then press Update it.` } };
  const w = wireFor(r);
  const t = transfers.start({ kind: 'update', what: `TOMLIN ${d.version}`, pc: r.id, pcName: r.name }, async (progress, signal) => {
    const files = await update.appFiles(d.update.root, ownHashes);
    // What is sent is what this copy runs: its build id, read at start, must still be its folder's (else the PC there
    // would run other files than this one, and still look different from it afterwards).
    const sent = update.buildIdOf(files);
    const mine = d.build();
    if (mine && sent !== mine) throw new Error(`this PC's folder changed after TOMLIN started here (its files are no longer build ${update.shortBuild(mine)}, the one that runs), so nothing was sent. Close TOMLIN on this PC and start it again, then press Update it.`);
    const before = h.up?.since ?? null;
    const push = (list: update.AppFile[]) => update.pushUpdate(w, { version: d.version, root: d.update.root, files: list, progress, signal, waiting: busy => progress({ wait: busy }) });
    // A PC from before the TOMLIN name refuses "Start TOMLIN.cmd" (nothing is kept there yet): the same copy again, with
    // the launcher under the name it takes.
    const folder = await push(files).catch(e => (update.refusedNewNames(e) ? push(update.forOlderNode(files)) : Promise.reject(e)));
    progress({ stage: 'check', wait: '' });
    // It ends and starts the new copy: asked again until it answers with the new version and the files sent (about 10 to
    // 30 seconds). Before it ends it still answers with the same version when only the files differ, so its build id
    // must be the one sent; an older TOMLIN that says none goes by the version.
    for (let t0 = Date.now(); Date.now() - t0 < 180_000; await sleep(3000)) {
      const now = await hello(r, 3000).catch(() => null);
      if (now?.version !== d.version) continue;
      // One short line (the window puts "Sent: <size>." before it); the folder and the backup are as every update does.
      if (!now.build || now.build === sent) return '';
      if (now.up?.since && now.up.since !== before) throw new Error(`"${r.name}" started again with TOMLIN ${now.version}, but its files are build ${update.shortBuild(now.build)}, not ${update.shortBuild(sent)} as sent. Look in "${folder}" on that PC, then press Update it again.`);
    }
    throw new Error(`the new version is in "${folder}" on "${r.name}", but it has not answered for 3 minutes. Look at that PC: its TOMLIN window says what happened.`);
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

/** Brings a restore point kept on a linked PC back into this PC's backups (Your data then puts it back as any other). */
export async function bringBack(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  const name = carry.safeBackupName(b.name);
  const bytes = Number(b.bytes);
  if (!name || !Number.isSafeInteger(bytes) || bytes <= 0) return { status: 400, body: { error: 'That is not one of the restore points kept there. Close this window and open it again.' } };
  const dest = join(d.carry.backupsDir, name);
  if ((await carry.sizeOf(dest)) === bytes) return { status: 409, body: { error: 'That one is in this PC\'s backups already: Settings, Your data and updates, then Put back.' } };
  const room = carry.roomWhy(bytes, await carry.freeBytes(d.carry.backupsDir), 'this PC');
  if (room) return { status: 507, body: { error: `${room.charAt(0).toUpperCase()}${room.slice(1)}` } };
  const w = wireFor(r);
  const t = transfers.start({ kind: 'bring', what: name.replace(/\.zip$/, ''), pc: r.id, pcName: r.name }, async (progress, signal) => {
    await carry.pullBackup(w, { name, bytes, dest, progress, signal });
    return 'It is in this PC\'s backups now: Settings, Your data and updates, then Put back beside it.';
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

// ---- Project backups to linked PCs (src/gitstore.ts): the workspace, and the Bridge projects ticked "Copy to my
// nodes" (src/projectbackup.ts, each under "Bridge projects/<name>/"), as one commit in a git repository there ----

/** What the last project backup to each linked PC did, by its id (data/project-backups.json). */
export interface ProjectsDone {
  at: number;
  commit: string;
  files: number;
  bytes: number;
  /** The workspace as it was then (paths, sizes, times): the same now = nothing to back up. */
  sig: string;
  /** Each Bridge project in that backup, by its folder (lower case): its own signature then, and its size. */
  parts?: Record<string, { name: string; sig: string; files: number; bytes: number }>;
}
const DONE_FILE = 'project-backups.json';
/** Each file's git id by path, kept while its size and time stay the same (hashing every file each time is slow). */
const HASH_FILE = 'project-hashes.json';
/** How often the projects are checked for changes and backed up to the PCs that allow it. */
const EVERY_MS = 10 * 60_000;
/** The first round, a while after start (the PCs answer their first hello by then). */
const FIRST_MS = 2 * 60_000;
// TOMLIN_PROJECT_ROUND_SECONDS: a test copy runs its rounds every few seconds (the first one too), so a test sees them.
const ROUND_TEST_MS = Math.max(1000, Math.round(Number(process.env.TOMLIN_PROJECT_ROUND_SECONDS) * 1000)) || 0;

const projectsDone = () => d.store.readJson<Record<string, ProjectsDone>>(DONE_FILE, {});

/** What one backup takes: the workspace at the top, each ticked Bridge project in its own folder. */
interface BackupSet {
  files: git.WorkFile[];
  more: boolean;
  /** The whole set: the same now as at the last backup = nothing to send. */
  sig: string;
  parts: Record<string, { name: string; dir: string; sig: string; files: number; bytes: number; left: { path: string; bytes: number }[]; how: 'git' | 'folder'; note?: string }>;
}
const chosen = async () => pb.cleanChosen(await d.store.readJson(pb.CHOSEN_FILE, {}));
/** A whole backup's size: what a PC's disk needs room for the first time (later ones send only what changed). */
const setBytes = (set: { files: { bytes: number }[] }) => set.files.reduce((n, f) => n + f.bytes, 0);
async function backupSet(): Promise<BackupSet> {
  const ws = await git.workFiles(await d.workspaceDir());
  const files = [...ws.files];
  let more = ws.more;
  const parts: BackupSet['parts'] = {};
  const { dirs } = await chosen();
  const names = pb.namesOf(dirs);
  for (const dir of dirs) {
    const name = names.get(pb.keyOf(dir))!;
    const got = await pb.projectFiles(dir);
    more ||= got.more;
    for (const f of got.files) files.push({ ...f, path: `${pb.PREFIX}/${name}/${f.path}` });
    parts[pb.keyOf(dir)] = { name, dir, sig: pb.signatureOf(got.files), files: got.files.length, bytes: got.files.reduce((n, f) => n + f.bytes, 0), left: got.left, how: got.how, note: got.note };
  }
  return { files, more, sig: git.signature(files), parts };
}

/** The set's files with their git ids (those unchanged since the last time from the kept list). */
async function hashed(set: BackupSet, signal: AbortSignal): Promise<(git.WorkFile & { id: string })[]> {
  const kept = await d.store.readJson<Record<string, { bytes: number; mtime: number; id: string }>>(HASH_FILE, {});
  const now: Record<string, { bytes: number; mtime: number; id: string }> = {};
  const out: (git.WorkFile & { id: string })[] = [];
  for (const f of set.files) {
    if (signal.aborted) throw new Error('Stopped.');
    const k = kept[f.path];
    let id = k && k.bytes === f.bytes && k.mtime === f.mtime ? k.id : '';
    if (!id) {
      try {
        id = (await git.blobIdOfFile(f.full)).id;
      } catch {
        continue; // gone, or open in another program: it goes in the next backup
      }
    }
    now[f.path] = { bytes: f.bytes, mtime: f.mtime, id };
    out.push({ ...f, id });
  }
  await d.store.writeJson(HASH_FILE, now);
  return out;
}

/** Backs up the workspace and the ticked Bridge projects to one linked PC: only the files it does not have cross, then one commit there. */
async function sendProjects(r: Remote, progress: (p: Partial<Pick<carry.Transfer, 'done' | 'bytes'>>) => void, signal: AbortSignal): Promise<string> {
  const w = wireFor(r);
  const set = await backupSet();
  const { more, sig } = set;
  const files = await hashed(set, signal);
  const ids = [...new Set(files.map(f => f.id))];
  const missing = new Set<string>();
  for (let k = 0; k < ids.length; k += carry.MAX_IDS) {
    if (signal.aborted) throw new Error('Stopped.');
    const v = await w.ask('/worker/git-have', { ids: ids.slice(k, k + carry.MAX_IDS) });
    for (const id of Array.isArray(v.missing) ? v.missing : []) if (git.isId(id)) missing.add(id);
  }
  // One file for each id the node lacks (two files with the same contents cross once).
  const send = [...new Map(files.filter(f => missing.has(f.id)).map(f => [f.id, f])).values()];
  const bytes = send.reduce((n, f) => n + f.bytes, 0);
  let done = 0;
  progress({ done, bytes });
  for (const f of send) {
    let at = 0;
    do {
      if (signal.aborted) throw new Error('Stopped.');
      const piece = f.bytes ? await carry.readPiece(f.full, at) : Buffer.alloc(0);
      if (f.bytes && !piece.length) throw new Error(`${f.path} got shorter while it was sent: back up again`);
      const v = await w.putPiece('/worker/git-put', { id: f.id, bytes: f.bytes, from: at }, piece);
      if (v.done === true) break;
      const next = Number(v.at);
      if (!Number.isSafeInteger(next) || next <= at) throw new Error(`"${r.name}" did not take ${f.path}: back up again`);
      at = next;
      progress({ done: done + at, bytes });
    } while (at < f.bytes);
    done += f.bytes;
    progress({ done, bytes });
  }
  const when = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const c = await w.ask('/worker/git-commit', { files: files.map(f => ({ path: f.path, id: f.id })), message: `Projects backed up ${when}: ${files.length} file${files.length === 1 ? '' : 's'}` });
  if (!git.isId(c.id)) throw new Error(`"${r.name}" did not say it kept the backup`);
  const parts = Object.fromEntries(Object.entries(set.parts).map(([k, v]) => [k, { name: v.name, sig: v.sig, files: v.files, bytes: v.bytes }]));
  await d.store.updateJson<Record<string, ProjectsDone>>(DONE_FILE, {}, all => ({ ...all, [r.id]: { at: Date.now(), commit: c.id as string, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), sig, parts } }));
  bridgeCache = null;
  const left = more ? ` Only the first ${files.length.toLocaleString('en')} files were taken (a backup holds at most that many).` : '';
  if (c.same === true) return `Nothing changed since the last backup on "${r.name}".${left}`;
  return `Backed up ${files.length} file${files.length === 1 ? '' : 's'} to "${r.name}" (${send.length ? `${bytes >= 2 ** 20 ? GBs(bytes) : `${Math.max(1, Math.round(bytes / 1024))} KB`} sent` : 'nothing new to send'}).${left}`;
}

/** "Back up projects now" in My local LLMs. */
export async function projectsTo(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  const pc = (await netPcs()).find(x => x.id === r.id)!;
  const why = carry.projectsWhy(pc);
  if (why) return { status: 409, body: { error: `${why.charAt(0).toUpperCase()}${why.slice(1)}.` } };
  const t = transfers.start({ kind: 'projects', what: 'Your projects', pc: r.id, pcName: r.name }, (progress, signal) => sendProjects(r, progress, signal));
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

/** The project backups kept on a linked PC (newest first), and when this PC last sent one there. */
export async function projectsOn(pcId: string | null) {
  const r = (await d.store.settings()).remotes.find(x => x.id === pcId);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  try {
    const v = await wireFor(r).ask('/worker/git-log', {});
    return { status: 200, body: { commits: Array.isArray(v.commits) ? v.commits : [], allowed: v.allowed === true, done: (await projectsDone())[r.id] ?? null } };
  } catch (e) {
    return { status: 502, body: { error: (e as Error).message } };
  }
}

/**
 * Brings the projects of a backup on a linked PC back into a new folder here ("restored projects"); nothing is replaced.
 * With `only` (the folder name a Bridge project has in the backup), only that project comes back, into a folder named
 * after it.
 */
export async function projectsBack(b: Record<string, unknown>) {
  const r = (await d.store.settings()).remotes.find(x => x.id === b.pc);
  if (!r) return { status: 404, body: { error: 'That PC is not linked to this one any more.' } };
  const only = typeof b.only === 'string' && !b.only.includes('/') && git.safePath(`${pb.PREFIX}/${b.only}`) ? `${pb.PREFIX}/${b.only}/` : null;
  const w = wireFor(r);
  const t0 = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const pcLabel = r.name.replace(/[^\w .()-]+/g, '-');
  const label = only ? `${String(b.only).slice(0, 40)} from ${pcLabel.slice(0, 30)}` : pcLabel.slice(0, 40);
  const dest = join(dirname(d.carry.backupsDir), 'restored projects', `${label} ${t0.getFullYear()}-${two(t0.getMonth() + 1)}-${two(t0.getDate())} ${two(t0.getHours())}${two(t0.getMinutes())}`);
  const t = transfers.start({ kind: 'restore', what: only ? String(b.only) : 'Your projects', pc: r.id, pcName: r.name }, async (progress, signal) => {
    const v = await w.ask('/worker/git-files', git.isId(b.commit) ? { commit: b.commit } : {});
    const all = (Array.isArray(v.files) ? v.files : []).map(f => f as Record<string, unknown>).filter(f => git.safePath(f.path) && git.isId(f.id));
    const files: Record<string, unknown>[] = only ? all.filter(f => String(f.path).startsWith(only)).map(f => ({ ...f, path: String(f.path).slice(only.length) })) : all;
    if (only && !files.length) throw new Error(`The newest backup on "${r.name}" has no copy of ${String(b.only)} yet: back it up first (Back up now).`);
    const bytes = files.reduce((n, f) => n + (Number(f.bytes) || 0), 0);
    const room = carry.roomWhy(bytes, await carry.freeBytes(dirname(dest)), 'this PC');
    if (room) throw new Error(room);
    let done = 0;
    for (const f of files) {
      const file = join(dest, ...String(f.path).split('/'));
      const size = Number(f.bytes) || 0;
      await mkdir(dirname(file), { recursive: true });
      const part = carry.partOf(file);
      await rm(part, { force: true });
      await writeFile(part, '');
      for (let at = 0; at < size;) {
        if (signal.aborted) throw new Error('Stopped.');
        progress({ done: done + at, bytes });
        const piece = await w.getPiece('/worker/git-get', { id: f.id, from: at });
        if (!piece.length) throw new Error(`"${r.name}" sent an empty piece of ${String(f.path)}`);
        const a = await carry.addPiece(part, at, piece);
        if ('error' in a) throw new Error(`${String(f.path)} changed here while it came in: bring them back again`);
        at = a.at;
      }
      if (!(await carry.finish(part, file, size))) throw new Error(`${String(f.path)} came in at the wrong size: bring them back again`);
      done += size;
    }
    progress({ done: bytes, bytes });
    return `Brought back ${files.length} file${files.length === 1 ? '' : 's'} into ${dest}. Nothing in your ${only ? 'project' : 'workspace'} was changed: copy what you need from there.`;
  });
  return 'error' in t ? { status: 409, body: t } : { status: 200, body: { transfer: t } };
}

/** Every 10 minutes: the projects go to each linked PC that keeps backups, when something changed since the last one. */
export function startProjectBackups(): void {
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    try {
      const set = await backupSet();
      const pcs = carry.backupOrder((await netPcs()).filter(pc => !carry.projectsWhy(pc) && !roomOn(pc, setBytes(set))));
      if (!pcs.length) return;
      const done = await projectsDone();
      const sig = set.sig;
      for (const pc of pcs) {
        if (done[pc.id]?.sig === sig) continue;
        const r = (await d.store.settings()).remotes.find(x => x.id === pc.id);
        if (!r) continue;
        const t = transfers.start({ kind: 'projects', what: 'Your projects', pc: r.id, pcName: r.name }, (progress, signal) => sendProjects(r, progress, signal));
        if ('error' in t) continue; // that PC is busy with another copy: the next round
        while (transfers.view().find(x => x.id === t.id)?.state === 'working') await sleep(2000);
      }
    } catch {
      // a PC that went off, a folder that could not be read: the next round tries again
    } finally {
      running = false;
    }
  };
  setTimeout(() => void round(), ROUND_TEST_MS || FIRST_MS).unref();
  setInterval(() => void round(), ROUND_TEST_MS || EVERY_MS).unref();
}

// ---- The Bridge's view of these backups (its project rows and each project's git window, src/server/bridge.ts) ----

/** where: the PC's address on the home network (two PCs can have the same name). */
export interface BridgeCopy { pc: string; pcName: string; where: string; at: number; current: boolean }
export interface BridgeProject {
  name: string;
  /** What a backup would take now. */
  files: number;
  bytes: number;
  left: { path: string; bytes: number }[];
  how: 'git' | 'folder';
  note?: string;
  /** The newest copy on each linked PC; current = nothing in the project changed since. */
  copies: BridgeCopy[];
}
export interface BridgeBackups {
  /** Linked PCs, and why each cannot take a backup now ('' when it can). */
  pcs: { id: string; name: string; where: string; why: string; backupsOnly: boolean; ram: number | null; gpu: string | null; vram: number | null; disk: { total: number; free: number } | null }[];
  /** The ticked projects, by folder (lower case). */
  projects: Record<string, BridgeProject>;
  at: number;
}
let bridgeCache: { at: number; view: BridgeBackups } | null = null;
let bridgeBusy: Promise<BridgeBackups> | null = null;

/** Read afresh: the linked PCs (asked over the network) and what each ticked project holds now. */
export function bridgeBackups(): Promise<BridgeBackups> {
  bridgeBusy ??= (async () => {
    const [pcs, set, done, settings] = await Promise.all([netPcs().catch(() => [] as carry.NetPc[]), backupSet(), projectsDone(), d.store.settings()]);
    const nameOf = (id: string) => pcs.find(x => x.id === id)?.name ?? settings.remotes.find(x => x.id === id)?.name ?? 'a PC no longer linked';
    const whereOf = (id: string) => hostOf(settings.remotes.find(x => x.id === id)?.url);
    const projects: Record<string, BridgeProject> = {};
    for (const [k, v] of Object.entries(set.parts)) {
      const copies: BridgeCopy[] = [];
      for (const [pcId, dn] of Object.entries(done)) {
        const was = dn.parts?.[k];
        if (was) copies.push({ pc: pcId, pcName: nameOf(pcId), where: whereOf(pcId), at: dn.at, current: was.sig === v.sig });
      }
      copies.sort((a, b) => b.at - a.at);
      projects[k] = { name: v.name, files: v.files, bytes: v.bytes, left: v.left, how: v.how, note: v.note, copies };
    }
    const view: BridgeBackups = { pcs: carry.backupOrder(pcs.map(pc => ({ id: pc.id, name: pc.name, where: whereOf(pc.id), why: carry.projectsWhy(pc) || roomOn(pc, setBytes(set)), backupsOnly: pc.backupsOnly === true, ...specsOf(pc.memory), disk: pc.disk ?? null }))), projects, at: Date.now() };
    bridgeCache = { at: view.at, view };
    return view;
  })().finally(() => { bridgeBusy = null; });
  return bridgeBusy;
}
/** The last view at once (the list is drawn every few seconds), read again in the background once a minute old. */
export function bridgeBackupsNow(): BridgeBackups | null {
  if (!bridgeCache || Date.now() - bridgeCache.at > 60_000) void bridgeBackups().catch(() => undefined);
  return bridgeCache?.view ?? null;
}

/** "Copy to my nodes" ticked or not for one project. */
export async function bridgeBackupSet(dir: string, on: boolean): Promise<BridgeBackups> {
  await d.store.updateJson(pb.CHOSEN_FILE, {}, now => {
    const rest = pb.cleanChosen(now).dirs.filter(x => pb.keyOf(x) !== pb.keyOf(dir));
    return { dirs: on ? [...rest, dir] : rest };
  });
  return bridgeBackups();
}

/** A linked PC's address without the port ("192.168.0.40"), or '' when it has none. */
function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
}

/**
 * "Back up now": a backup to every linked PC that keeps them, or only to the ones chosen (by id). Says where it went,
 * with each copy's transfer id so the window can follow it (bridgeBackupProgress).
 */
export async function bridgeBackupNow(only?: string[]): Promise<{ ok: boolean; started: string[]; ids: string[]; error?: string }> {
  const pcs = await netPcs();
  const bytes = setBytes(await backupSet());
  const can = carry.backupOrder(pcs.filter(pc => !carry.projectsWhy(pc) && !roomOn(pc, bytes) && (!only || only.includes(pc.id))));
  if (only && !only.length) return { ok: false, started: [], ids: [], error: 'No PC is chosen. Tick at least one PC to back up to.' };
  if (!can.length) {
    return { ok: false, started: [], ids: [], error: only && pcs.length ? 'None of the chosen PCs can take a backup now: read the line under each one.' : pcs.length ? `No linked PC can take a backup now: ${pcs.map(pc => carry.projectsWhy(pc)).join('; ')}.` : 'No PC is linked yet. Link one (TOMLIN, Link another PC), then tick "Enable backups" on it.' };
  }
  const started: string[] = [];
  const ids: string[] = [];
  const settings = await d.store.settings();
  for (const pc of can) {
    const r = settings.remotes.find(x => x.id === pc.id);
    if (!r) continue;
    const t = transfers.start({ kind: 'projects', what: 'Your projects', pc: r.id, pcName: r.name }, (progress, signal) => sendProjects(r, progress, signal));
    if (!('error' in t)) { started.push(r.name); ids.push(t.id); }
    else {
      // already backing up to that PC (the 10-minute round, or a press a moment ago): follow that copy instead
      const busy = transfers.view().find(x => x.pc === r.id && x.state === 'working' && x.kind === 'projects');
      if (busy) { started.push(r.name); ids.push(busy.id); }
    }
  }
  return started.length ? { ok: true, started, ids } : { ok: false, started, ids, error: 'Every linked PC that keeps backups is busy with another copy now. Try again in a minute.' };
}

/** How the copies Back up now started are going: each one's PC, state (working, done, failed, stopped) and words. */
export function bridgeBackupProgress(ids: string[]) {
  return transfers.view().filter(t => ids.includes(t.id)).map(t => ({ id: t.id, pc: t.pc, pcName: t.pcName, state: t.state, done: t.done, bytes: t.bytes, said: t.said }));
}

/** "Bring back": one project from the newest backup on a linked PC, into a new folder ("restored projects"). */
export async function bridgeBackupBack(dir: string, pc: string): Promise<{ ok: boolean; error?: string; to?: string }> {
  const name = (await projectsDone())[pc]?.parts?.[pb.keyOf(dir)]?.name;
  if (!name) return { ok: false, error: 'That PC has no backup of this project yet.' };
  const r = await projectsBack({ pc, only: name });
  return r.status === 200 ? { ok: true, to: join(dirname(d.carry.backupsDir), 'restored projects') } : { ok: false, error: String((r.body as { error?: unknown }).error ?? 'It could not start.') };
}
