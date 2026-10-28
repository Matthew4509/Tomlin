// Update this install (This PC: models and updates): Check zip takes a TOMLIN zip uploaded from the page, with its .sig when it
// was picked too; Check git finds the newest GitHub Release of TOMLIN's repo and downloads its zip, which must carry the
// release signature (src/release.ts). A hand-picked zip whose signature is missing or fails is a warning the person may
// override (Install anyway); a download is refused. Either way the zip's listing is checked, it is opened beside this
// copy (as an unzip by hand would) and walked again (src/newcopy.ts), and checked as a whole TOMLIN that is newer than
// this one (or the same version with other files). Update now starts it once as a test; only when it answers does this
// copy end and its launcher start the new one, as an update pushed from a linked PC does (src/update.ts). The old copy
// stays beside it for going back. Linked PCs are then updated from this one with Update it (or Update all linked PCs).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { freeBytes, roomWhy } from '../carry.ts';
import { missingFiles } from '../installer.ts';
import { entriesWhy, testStart, unpackedWhy, zipEntries } from '../newcopy.ts';
import { latestOf, noRelease, repoOf, type SigCode, sigOf, WARN, zipCheck, type Latest } from '../release.ts';
import * as update from '../update.ts';
import { BUILD, ROOT, type Routes, VERSION, json, restartInto } from './core.ts';
import { backupRunning } from './bridge.ts';
import { jobRoutes } from './jobs.ts';

/** A TOMLIN zip is about 190 MB; anything past this is not one. */
const MAX_ZIP = 2 * 1024 ** 3;
/** Beside this copy, as the new copy will be (the same drive, so the move in is a rename). */
const PARENT = dirname(ROOT);
const ZIP = join(PARENT, '.tomlin-upload.zip');
const STAGING = join(PARENT, '.tomlin-upload');
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const run = promisify(execFile);

type Check = { code: SigCode; why: string };
/** The zip opened and checked, waiting for "Update now": where it came from, and how its signature checked. */
let ready: { dir: string; version: string; build: string; source: 'file' | 'git'; check: Check } | null = null;
let busy = false;

/** The signature as the page shows it: signed, or the warning a hand-picked zip gets. */
const signing = (c: Check) => ({ signed: !c.code, code: c.code, warning: c.code ? `${WARN[c.code]} It may not be from TOMLIN's maker.` : '' });

// An upload left from an earlier run (TOMLIN closed before Update now) is not kept: it is several hundred MB.
void Promise.all([rm(ZIP, { force: true }), rm(STAGING, { recursive: true, force: true })]).catch(() => undefined);

const restarts = () => process.env.TOMLIN_LOOP === '1';
const notRestarting = 'This TOMLIN was not started by its installed program or Start TOMLIN.cmd, so it cannot start a new version by itself. Close it, unzip the new version and start it with Install TOMLIN.cmd there.';

/** The app folder in what was unzipped: the folder itself, or the one folder in it (tomlin-<version>, as npm run pack makes). */
async function appFolder(dir: string): Promise<string | null> {
  if (await stat(join(dir, 'package.json')).catch(() => null)) return dir;
  const inside = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory());
  if (inside.length === 1 && (await stat(join(dir, inside[0].name, 'package.json')).catch(() => null))) return join(dir, inside[0].name);
  return null;
}

const notAZip = 'That file could not be opened as a zip. Download the TOMLIN zip again, then try it here.';

/**
 * The zip at ZIP checked, opened beside this copy and checked again: it waits for Update now (`ready`), or why it was
 * not taken. `signature` checks its signature once its version is known.
 */
async function openZip(source: 'file' | 'git', signature: (version: string) => Check): Promise<{ version: string; build: string; mine: string; mineBuild: string; signed: boolean; code: SigCode; warning: string } | { error: string }> {
  await rm(STAGING, { recursive: true, force: true });
  // Its own listing first: nothing is opened from a zip with a link, a climbing name, or far more in it than a TOMLIN.
  const listed = await zipEntries(ZIP).then(entriesWhy, () => notAZip);
  if (listed) return { error: listed };
  await mkdir(STAGING, { recursive: true });
  const no = async (error: string) => {
    await rm(STAGING, { recursive: true, force: true });
    return { error };
  };
  // Windows' own tar opens zip files (it refuses names that climb out of the folder).
  try {
    await run(tar, ['-x', '-f', ZIP, '-C', STAGING], { windowsHide: true, maxBuffer: 1 << 20 });
  } catch {
    return no(notAZip);
  }
  const dir = await appFolder(STAGING);
  if (!dir) return no('That zip has no TOMLIN in it (no package.json at its top or in its one folder). Pick the tomlin-<version>.zip file.');
  // What was opened, walked again: the listing could have said less than it holds.
  const opened = await unpackedWhy(STAGING, dir);
  if (opened) return no(opened);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8').catch(() => '{}'));
  const build = await update.buildId(dir).catch(() => '');
  const why = update.zipWhy(pkg, missingFiles(dir), build, VERSION, BUILD);
  if (why) return no(why);
  const check = signature(pkg.version);
  ready = { dir, version: pkg.version, build, source, check };
  return { version: pkg.version, build: update.shortBuild(build), mine: VERSION, mineBuild: update.shortBuild(BUILD), ...signing(check) };
}

// ---- Check git: the newest GitHub Release, its signed zip downloaded and opened here ----

/** TOMLIN's repo on GitHub (package.json `repository`; TOMLIN_RELEASE_REPO for another), and where GitHub answers. */
const REPO = repoOf(process.env.TOMLIN_RELEASE_REPO || JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).repository);
const API = (process.env.TOMLIN_RELEASE_API || 'https://api.github.com').replace(/\/$/, '');
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': `TOMLIN/${VERSION}` };
/** The download from git now: what it is doing, how far, and how it ended (a fault, or ready to Update now). */
let git: { state: 'downloading' | 'checking' | 'opening' | 'ready' | 'failed'; version: string; got: number; bytes: number; error: string } | null = null;

/** The newest release on GitHub, or why it could not be read (fault, reason, way out in one sentence each). */
async function latest(): Promise<Latest | string> {
  if (!REPO) return 'This TOMLIN does not name its GitHub repo, so it cannot check git. Use Check zip with a zip from the TOMLIN releases page.';
  let r: Response;
  try {
    r = await fetch(`${API}/repos/${REPO}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return `GitHub did not answer (${(e as Error).name === 'TimeoutError' ? 'it took too long' : 'no connection'}). Check this PC is online, then press Check git again; or use Check zip with a zip copied from another PC.`;
  }
  if (r.status === 404) return noRelease(REPO, VERSION);
  if (r.status === 403 || r.status === 429) return 'GitHub is turning this PC away for asking too often just now. Wait an hour, then press Check git again.';
  if (!r.ok) return `GitHub answered ${r.status}. Try Check git again later.`;
  // A stand-in GitHub (TOMLIN_RELEASE_API, for checks) serves its own downloads; the real one's are on github.com.
  const l = latestOf(await r.json().catch(() => null), process.env.TOMLIN_RELEASE_API ? `${API}/` : undefined);
  return typeof l === 'string' ? `Nothing to take: ${l}.` : l;
}

/** Downloads `url` to `to` (at most `max` bytes), counting as it goes; its SHA-256. */
async function download(url: string, to: string, max: number, onBytes: (n: number) => void): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': HEADERS['user-agent'] }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status} for ${basename(new URL(url).pathname)}`);
  const hash = createHash('sha256');
  let got = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      got += chunk.length;
      hash.update(chunk);
      onBytes(got);
      done(got > max ? new Error('the download is bigger than a TOMLIN zip can be') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(r.body as never), count, createWriteStream(to));
  return hash.digest('hex');
}

/** The newest release's zip, downloaded, its signature checked, then opened and checked as an uploaded one is. */
async function fetchRelease(l: Latest): Promise<void> {
  busy = true;
  ready = null;
  git = { state: 'downloading', version: l.version, got: 0, bytes: l.zip.bytes, error: '' };
  const fail = (error: string) => { git = { ...git!, state: 'failed', error }; };
  try {
    const sigRes = await fetch(l.sig.url, { headers: { 'user-agent': HEADERS['user-agent'] }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    const sig = sigRes.ok ? await sigRes.json().catch(() => null) : null;
    if (!sig) return fail(`Its signature could not be downloaded (GitHub answered ${sigRes.status}). Press Check git again later.`);
    const sha = await download(l.zip.url, ZIP, MAX_ZIP, n => { if (git) git.got = n; });
    git = { ...git, state: 'checking' };
    // A download is never opened without the release signature (a hand-picked zip may be, after a warning).
    const c = zipCheck(sig, l.version, sha);
    if (c.code === 'newkey') return fail(`TOMLIN ${l.version} on GitHub is signed with a key this TOMLIN does not know, so it was not opened. If TOMLIN's maker changed keys, install this one version by hand once: download tomlin-${l.version}.zip and its .sig from the releases page, then Check zip with both (Install anyway). Check git takes the ones after it.`);
    if (c.code) return fail(`TOMLIN ${l.version} was downloaded but not opened: ${c.why}.`);
    git = { ...git, state: 'opening' };
    const opened = await openZip('git', () => c);
    if ('error' in opened) return fail(opened.error);
    git = { ...git, state: 'ready' };
  } catch (e) {
    fail(`The download stopped: ${(e as Error).message.replace(/\.$/, '')}. Press Check git again to start it again.`);
  } finally {
    await rm(ZIP, { force: true }).catch(() => undefined);
    busy = false;
  }
}

/**
 * POST /api/install/zip: the body is the zip itself, its .sig (when picked too) in a header. Saved, opened and checked;
 * nothing changes until Update now.
 */
export async function takeZip(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!restarts()) return json(res, 409, { error: notRestarting });
  if (busy) return json(res, 409, { error: 'A zip is being opened already. Wait for it, then try again.' });
  const sig = sigOf(req.headers['x-tomlin-sig']);
  const size = Number(req.headers['content-length']);
  if (Number.isFinite(size) && size > MAX_ZIP) return json(res, 413, { error: 'That file is too big to be a TOMLIN zip (they are about 200 MB).' });
  // The zip, and its files opened beside it (about two and a half times the zip).
  const room = Number.isFinite(size) && size > 0 ? roomWhy(Math.round(size * 3.5), await freeBytes(PARENT), 'this PC') : null;
  if (room) return json(res, 507, { error: `The zip was not taken: ${room}` });
  busy = true;
  ready = null;
  try {
    await rm(STAGING, { recursive: true, force: true });
    let got = 0;
    const hash = createHash('sha256');
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        got += chunk.length;
        hash.update(chunk);
        done(got > MAX_ZIP ? new Error('that file is too big to be a TOMLIN zip') : null, chunk);
      },
    });
    await pipeline(req, count, createWriteStream(ZIP));
    if (!got) return json(res, 400, { error: 'Nothing came in: pick the zip again.' });
    const sha = hash.digest('hex');
    const opened = await openZip('file', version => zipCheck(sig, version, sha));
    if ('error' in opened) return json(res, 400, opened);
    return json(res, 200, opened);
  } catch (e) {
    await rm(STAGING, { recursive: true, force: true }).catch(() => undefined);
    return json(res, 500, { error: `The zip was not taken: ${(e as Error).message.replace(/\.$/, '')}. Try again.` });
  } finally {
    await rm(ZIP, { force: true }).catch(() => undefined);
    busy = false;
  }
}

export const selfUpdateGet: Routes = {
  // What Update this install shows: this copy's version, whether it can start a new one, a zip waiting for Update now.
  '/api/install/zip': async ({ res }) => json(res, 200, { version: VERSION, build: update.shortBuild(BUILD), restarts: restarts(), ready: ready ? { version: ready.version, build: update.shortBuild(ready.build), ...signing(ready.check) } : null, git, repo: REPO, busy }),
};

export const selfUpdatePost: Routes = {
  // Check git: the newest release on GitHub, and whether it is newer than this copy (nothing is downloaded yet).
  '/api/install/git-check': async ({ res }) => {
    const l = await latest();
    if (typeof l === 'string') return json(res, 502, { error: l });
    return json(res, 200, { version: l.version, published: l.published, notes: l.notes, bytes: l.zip.bytes, newer: update.newer(l.version, VERSION), mine: VERSION, repo: REPO });
  },
  // Download it: the zip and its signature come down, are checked, and the zip is opened; the page follows `git` (GET
  // /api/install/zip) until it is ready for Update now or says why not.
  '/api/install/git-get': async ({ res, b }) => {
    if (!restarts()) return json(res, 409, { error: notRestarting });
    if (busy) return json(res, 409, { error: 'An update is being downloaded or opened already. Wait for it, then try again.' });
    const l = await latest();
    if (typeof l === 'string') return json(res, 502, { error: l });
    if (l.version !== b.version) return json(res, 409, { error: `GitHub now has TOMLIN ${l.version}, not ${String(b.version)}. Press Check git again.` });
    if (!update.newer(l.version, VERSION)) return json(res, 409, { error: `This PC runs ${VERSION} already: nothing newer on GitHub.` });
    const room = roomWhy(Math.round((l.zip.bytes || 200 * 1024 ** 2) * 3.5), await freeBytes(PARENT), 'this PC');
    if (room) return json(res, 507, { error: `Not downloaded: ${room}` });
    void fetchRelease(l);
    return json(res, 202, { version: l.version, bytes: l.zip.bytes });
  },
  // Update now: the checked copy is started once as a test, then becomes tomlin-<version> beside this one, and this copy
  // ends so it starts. anyway: the person pressed Install anyway on a hand-picked zip's warning.
  '/api/install/zip-go': async ({ res, b }) => {
    if (!ready || ready.version !== b.version) return json(res, 409, { error: 'That zip is no longer waiting here (TOMLIN started again, or another was picked). Upload it again.' });
    if (!restarts()) return json(res, 409, { error: notRestarting });
    if (busy) return json(res, 409, { error: 'An update is being opened or tested already. Wait for it, then try again.' });
    if (ready.check.code && ready.source !== 'file') return json(res, 409, { error: 'A download from GitHub is never installed without its signature.' });
    if (ready.check.code && b.anyway !== true) return json(res, 409, { error: `This zip is not signed by TOMLIN's maker: ${WARN[ready.check.code]} Press Install anyway only if you trust where it came from.` });
    const serving = jobRoutes.servingNow();
    if (serving.length) return json(res, 409, { error: 'A linked PC is using this one now (an answer or a picture). Wait for it to finish, then press Update now again.' });
    if (backupRunning()) return json(res, 409, { error: backupRunning() });
    const { dir, version } = ready;
    // Started once as a test before anything changes: a copy that does not come up never takes over.
    busy = true;
    const failed = await testStart(dir, version).catch(e => `it could not be started (${(e as Error).message})`).finally(() => { busy = false; });
    if (failed) {
      ready = null;
      await rm(STAGING, { recursive: true, force: true }).catch(() => undefined);
      return json(res, 422, { error: `TOMLIN ${version} was not installed: started once as a test, ${failed}. Nothing was changed, and this copy goes on as it is. Download the zip again, or tell TOMLIN's maker.` });
    }
    if (ready?.dir !== dir) return json(res, 409, { error: 'That zip is no longer waiting here (another was picked while it was tested). Upload it again.' });
    git = null;
    for (const d of ['models/chat', 'models/image/loras']) await mkdir(join(dir, ...d.split('/')), { recursive: true });
    const final = await update.newFolder(PARENT, version);
    await rename(dir, final);
    ready = null;
    await rm(STAGING, { recursive: true, force: true }).catch(() => undefined);
    json(res, 200, { folder: basename(final), version });
    console.log(`TOMLIN ${version} was uploaded: this copy ends and ${basename(final)} starts.`);
    await restartInto(final);
  },
  '/api/install/zip-drop': async ({ res }) => {
    ready = null;
    if (!busy) git = null;
    if (!busy) await rm(STAGING, { recursive: true, force: true }).catch(() => undefined);
    return json(res, 200, { ok: true });
  },
};
