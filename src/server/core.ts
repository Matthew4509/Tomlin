// The server's shared parts: the home folder and data opened at start, the stores, the hardware, and the replies.
// Every other part of the server (src/server/*.ts) builds on these; this module imports none of them.
import { ByModel, ByStaff, Ledger, Meter, Uptime } from '../meter.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHardware, Sampler } from '../hardware.ts';
import { logConsole, openLog } from '../log.ts';
import { overlaps } from '../workspace.ts';
import { Runtimes } from '../runtimes.ts';
import { Models } from '../models.ts';
import { Store, type ChatLine, type Settings } from '../store.ts';
import * as leftovers from '../leftovers.ts';
import { Staff } from '../staff.ts';
import { Faces } from '../faces.ts';
import { PcProfileStore } from '../pcprofile.ts';
import * as mute from '../mute.ts';
import * as notes from '../notes.ts';
import * as notify from '../notify.ts';
import { Chats, whoKind } from '../chats.ts';
import * as memory from '../memory.ts';
import { Speeds } from '../speed.ts';
import { Hidden } from '../hidden.ts';
import { cachedOtherModelDirs } from '../oldcopies.ts';
import { autostart } from '../autostart.ts';
import * as keep from '../keep.ts';
import { LOCK_FILE, releaseHome, takeHomeOrRepair } from '../onecopy.ts';
import { HfList } from '../hflist.ts';
import { buildId, NEXT_COPY_FILE, RESTART_INTO } from '../update.ts';

export const staffId = (v: unknown) => (typeof v === 'string' && v.startsWith('staff:') && staff.get(v.slice(6)) ? v : null);
/** What the chat with this PC's own assistant is called until it is given a name: the host (it is not one of the staff). */
export const HOST_NAME = 'The host';
/**
 * The host (this PC's own assistant, apart from the staff) is switched off and hidden for now (2.0.31: people found it
 * confusing). Off: no host row, no new chat with it, its old chats kept to read; staff do the talking. true brings it back.
 */
export const HOST_ON = false;
export const HOST_OFF = 'The host is switched off for now, so this chat is kept to read. Talk to one of your staff instead: pick them in the left panel, or hire someone with Hire staff (Settings, Set up, Staff).';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PORT = Number(process.env.TOMLIN_PORT ?? 8740);
/** The exit code of a copy that did not start because TOMLIN already runs (the home is taken, or the port). */
export const ALREADY_RUNNING = 77;

export const VERSION = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version as string;
/**
 * What code this copy is (src/update.ts buildId): a short hash of its app files, read once in the background so start-up
 * never waits for it. '' until it is read (a fraction of a second), or when the files could not be read; linked PCs
 * then go by the version alone.
 */
export let BUILD = '';
void buildId(ROOT).then(b => { BUILD = b; }, () => undefined);
// What he keeps lives in one home folder outside the app folder (src/keep.ts), so an update finds it again. An import
// or a restore asked for last time runs now, before anything opens a file; a new version backs the data up first.
export const HOME = keep.resolveHome();
// One copy per home, checked before anything opens a file: a second one stops here, touching nothing.
{
  // A lock left behind (a crash, a power cut) is repaired here (src/onecopy.ts); something answering on the port is
  // the copy that runs.
  const answers = () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2500) }).then(() => true, () => false);
  const took = await takeHomeOrRepair(HOME.home, answers);
  if ('other' in took) {
    console.error(took.unsure
      ? `TOMLIN may already be running for ${HOME.home} (process ${took.other}), and Windows could not say whether that process is TOMLIN, so this one did not start. If TOMLIN is open, use that one (its window, or its icon by the clock). If it is not, start it once more in 20 seconds: the second start checks again and repairs the lock by itself.`
      : `TOMLIN is already running for ${HOME.home}${took.other > 0 ? ` (process ${took.other})` : ''}, so this one did not start. Use that one (its window, or its icon by the clock), or close it first and start this one again.`);
    // 77: already running (the installed program then opens the one that runs instead of saying it failed).
    process.exit(ALREADY_RUNNING);
  }
  if (took.repaired) console.log(`Repaired the start lock: ${took.repaired}. ${join(HOME.home, LOCK_FILE)} now names this copy.`);
  process.on('exit', () => releaseHome(HOME.home));
}
export const startupOf = autostart(ROOT);
/**
 * Ends this copy so its launcher (Start TOMLIN.cmd, or TOMLIN.exe by the clock) starts the whole new copy in `dir`: an
 * update pushed from a linked PC, or a TOMLIN zip uploaded under Nodes and memory. Ended a moment later, so the answer
 * reaches whoever asked first.
 */
export async function restartInto(dir: string): Promise<void> {
  // "Start with Windows" meant the app, not the folder: it now starts the new copy.
  if (await startupOf.on().catch(() => false)) await autostart(dir).set(true).catch(() => undefined);
  await writeFile(join(ROOT, NEXT_COPY_FILE), dir);
  setTimeout(() => process.exit(RESTART_INTO), 1500).unref();
}
export const ready = await keep.prepare(HOME, ROOT, VERSION, {
  // "Start with Windows" pointed at the copy imported from: it now starts this one (the tick meant the app, not the folder).
  repoint: async from => (await autostart(from).on()) && (await startupOf.set(true), true),
});
if (ready.state === 'too-new') {
  console.error(`Your data in ${HOME.data} was last used by TOMLIN ${ready.app}, which changed how it is kept. This copy (${VERSION}) is older and cannot read it safely. Start ${ready.app} or newer, or put a backup back from ${HOME.backups} with that version.`);
  process.exit(1);
}

export const store = new Store(HOME.data);
await store.settings();
// Every conversation is its own chat (src/chats.ts). The first time, the old one-file-per-person chats move in.
export const chats = new Chats(store);
/** Set once every part of the server is in place: what follows a saved chat file (its notification). */
export const hooks = { chatSaved: async (_file: string, _lines: ChatLine[]): Promise<void> => undefined };
store.onChatSaved = async (file, lines) => {
  await chats.saved(file, lines);
  await hooks.chatSaved(file, lines);
};
// The team notebook and one per hire (src/memory.ts).
export const notebooks = new memory.Notebooks(store);
await chats.moveOld(await readdir(store.dir).catch(() => [] as string[]));
// No chat open yet (the first start with chats): the latest one with whoever is chosen opens.
if (!(await chats.get(store.peek()!.chatId))) await store.saveSettings({ chatId: (await chats.latestFor(whoKind(store.peek()!.who)))?.id ?? '' });
export const runtimes = new Runtimes(join(ROOT, 'runtime'), join(ROOT, 'runtimes.json'), HOME.runtime);
export const chatModels = new Models(join(HOME.models, 'chat'), HOME.modelsFile, process.env.TOMLIN_MODELS);
chatModels.cacheMs = 2000;
// Models still in this app folder (versions before the home kept them here) and in the copies beside it are lent in place.
const besideCopies = cachedOtherModelDirs(ROOT);
export const cachedCopies = () => [join(ROOT, 'models'), ...besideCopies()];
{
  const copies = cachedCopies;
  chatModels.copies = () => copies().map(d => join(d, 'chat'));
}
export const staff = await Staff.load(HOME.data);
// How fast each model answers, here and on linked PCs: every real answer, and Test speed (src/speed.ts).
export const speeds = await Speeds.load(HOME.data);
/** Models hidden from the lists a model is picked from (Nodes and memory, Models on this PC, Hide). */
export const hidden = await Hidden.load(HOME.data);
// One profile photo per person (src/faces.ts), kept in data/faces.
export const faces = new Faces(join(store.dir, 'faces'));
// Each PC's name, make and model and photo as you know it (src/pcprofile.ts), kept in data/pc-profiles.
export const pcProfiles = new PcProfileStore(join(store.dir, 'pc-profiles'));
export const hardware = await readHardware();
export const sampler = new Sampler(hardware);
sampler.start();
// Closing the window (or Ctrl+C) ends the model processes too: exit handlers run on these signals.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(0));
// A background save or job that fails is written to this window; it never stops the server (and the models it runs).
// The log file (PLAN F10 G8): data/logs, a week kept; console.error and console.warn land there too.
openLog(join(HOME.data, 'logs'));
logConsole();
process.on('unhandledRejection', e => console.error('Something failed in the background:', e));
// The same for a fault outside any request (an 'error' nobody listened for): logged, and the models keep running.
process.on('uncaughtException', e => console.error('Something failed and was caught at the last moment:', e));
// Model runners left running by a copy that was ended hard last time are ended now (only this copy's own, checked).
const leftOver = await leftovers.cleanUp(store.dir).catch(() => 0);
if (leftOver) console.log(`Ended ${leftOver} model runner${leftOver === 1 ? '' : 's'} left running from last time.`);

/** Mute per chat, staff member and job room, and Mute all (quiet, not stopped). */
export const mutes = new mute.MuteStore(store.dir);
// The chat's scratch pad and snippet library (src/notes.ts): only the page reads them.
export const noteStore = new notes.NotesStore(store.dir);
/** Finished / question / stuck: a silent Windows notification when the page is not in front, a sound while it is open. */
export const notifier = new notify.Notifier(store.dir);
notifier.base = `http://127.0.0.1:${PORT}/`;
/** What this PC's chat models did (src/meter.ts): its totals, the host's per-PC and per-project tally, linked PCs' checks. */
export const meter = await new Meter(join(store.dir, 'meter.json')).load();
export const ledger = await new Ledger(join(store.dir, 'usage-ledger.json')).load();
export const uptime = await new Uptime(join(store.dir, 'uptime.json')).load();
export const byStaff = await new ByStaff(join(store.dir, 'usage-staff.json')).load();
export const byModel = await new ByModel(join(store.dir, 'usage-models.json')).load();
/** When this copy of TOMLIN started (a node tells it in its hello: "running for"). */
export const STARTED_AT = new Date().toISOString();

/** Hugging Face's GGUF chat models (shipped, or Models > Rescan Hugging Face), so a search reads this copy, not Hugging Face. */
export const hfList = new HfList(join(store.dir, 'hf-list.json'), join(ROOT, 'registry', 'hf-list.json.gz'));

// ---- Replies ----

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(value));
}

/** OpenAI-style error body, for the /v1 endpoints. */
/**
 * A fault's words for the page. A message written for people (thrown on purpose) is shown as it is; a system error
 * (a file held, a disk full: it has a code, and often a full path) becomes one plain sentence, its detail in the log.
 */
export function saidError(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  // A full disk: said as one (the log may not take the details either), with the drive and what to do.
  if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) {
    const drive = typeof e.path === 'string' ? /^([A-Za-z]:)[\\/]/.exec(e.path)?.[1]?.toUpperCase() : undefined;
    return `The disk${drive ? ` (drive ${drive})` : ''} is full, so TOMLIN could not save that. Free some space on it (empty the Recycle Bin, or delete big files you do not need), then try again. Nothing saved before was changed.`;
  }
  if (e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) return `Something went wrong in TOMLIN: a file or folder could not be used (${e.code}). The details are in the log (Settings, Your data, Open log).`;
  return `Something went wrong in TOMLIN: ${e?.message ?? String(error)}`;
}

/** A caught fault for the page: a message TOMLIN wrote on purpose as it is, a system error (it has a code) in plain words. */
export const faultWords = (error: unknown): string => (typeof (error as NodeJS.ErrnoException)?.code === 'string' && /^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code!) ? saidError(error) : (error as Error)?.message ?? String(error));

export function apiError(res: ServerResponse, status: number, message: string, code = 'tomlin_error'): void {
  json(res, status, { error: { message, type: code, code } });
}

export async function body(req: IncomingMessage, limit = 30 << 20): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('The request is too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new Error('The request was not valid JSON.');
  }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

export async function staticFile(res: ServerResponse, path: string): Promise<void> {
  // The second look (/alt/) was dropped and its files deleted: an old bookmark to it opens the app.
  if (/^\/alt(\/|$)/.test(path)) return void res.writeHead(302, { location: '/', ...SECURITY_HEADERS }).end();
  const name = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/, '');
  if (!/^[\w.-]+$/.test(name)) return json(res, 404, { error: 'Not found.' });
  try {
    const data = await readFile(join(ROOT, 'public', name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

export const GB = 2 ** 30;

export const gbText = (n: number) => `${(n / GB).toFixed(1)} GB`;

/** Settings as the page may see them: the worker PCs' keys stay on the server. */
export function publicSettings(s: Settings) {
  return { ...s, remotes: s.remotes.map(({ id, name, url }) => ({ id, name, url })) };
}

/** "Qwen3.5-0.8B-Q4_K_M" -> "Qwen3.5-0.8B": the name a person knows, without the file's packing. */
export const shortName = (n: string | undefined) => (n ?? '').replace(/\s*[(+].*$/, '').replace(/[-_.](?:i?q\d\w*|f16|bf16)$/i, '').replace(/-it$/i, '');

export const DATA_DIR = HOME.data;

/** The workspace folder (made when it is first needed). */
export async function workspaceDir(): Promise<string> {
  const chosen = (await store.settings()).workspace;
  // A folder that is (or holds) the app or its home was never allowed to be chosen; one saved before is not used.
  const dir = chosen && !overlaps(chosen, [ROOT, HOME.home]) ? chosen : join(DATA_DIR, 'workspace');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** One request as a route sees it: `b` is the body read as JSON (empty for GET). */
interface Ask { req: IncomingMessage; res: ServerResponse; url: URL; p: string; b: Record<string, unknown> }
/** A route answers its request itself (the reply is written by the route). */
export type Route = (a: Ask) => unknown;
/** Routes by exact path. */
export type Routes = Record<string, Route>;
