// Update this install from a TOMLIN zip (Nodes and memory, Update this install): the zip is uploaded from the page,
// opened beside this copy (as an unzip by hand would), checked as a whole TOMLIN that is newer than this one (or the
// same version with other files), then this copy ends and its launcher starts the new one, as an update pushed from a
// linked PC does (src/update.ts). The old copy stays beside it for going back. Linked PCs are then updated from this
// one with Update it (or Update all linked PCs).
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { freeBytes, roomWhy } from '../carry.ts';
import { missingFiles } from '../installer.ts';
import * as update from '../update.ts';
import { BUILD, ROOT, type Routes, VERSION, json, restartInto } from './core.ts';
import { jobRoutes } from './jobs.ts';

/** A TOMLIN zip is about 190 MB; anything past this is not one. */
const MAX_ZIP = 2 * 1024 ** 3;
/** Beside this copy, as the new copy will be (the same drive, so the move in is a rename). */
const PARENT = dirname(ROOT);
const ZIP = join(PARENT, '.tomlin-upload.zip');
const STAGING = join(PARENT, '.tomlin-upload');
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const run = promisify(execFile);

/** The zip opened and checked, waiting for "Update now". */
let ready: { dir: string; version: string; build: string } | null = null;
let busy = false;

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

/** POST /api/install/zip: the body is the zip itself. Saved, opened and checked; nothing changes until Update now. */
export async function takeZip(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!restarts()) return json(res, 409, { error: notRestarting });
  if (busy) return json(res, 409, { error: 'A zip is being opened already. Wait for it, then try again.' });
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
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        got += chunk.length;
        done(got > MAX_ZIP ? new Error('that file is too big to be a TOMLIN zip') : null, chunk);
      },
    });
    await pipeline(req, count, createWriteStream(ZIP));
    if (!got) return json(res, 400, { error: 'Nothing came in: pick the zip again.' });
    await mkdir(STAGING, { recursive: true });
    // Windows' own tar opens zip files (it refuses names that climb out of the folder).
    try {
      await run(tar, ['-x', '-f', ZIP, '-C', STAGING], { windowsHide: true, maxBuffer: 1 << 20 });
    } catch {
      await rm(STAGING, { recursive: true, force: true });
      return json(res, 400, { error: 'That file could not be opened as a zip. Download the TOMLIN zip again, then upload it here.' });
    }
    const dir = await appFolder(STAGING);
    const pkg = dir ? JSON.parse(await readFile(join(dir, 'package.json'), 'utf8').catch(() => '{}')) : {};
    const build = dir ? await update.buildId(dir).catch(() => '') : '';
    const why = dir ? update.zipWhy(pkg, missingFiles(dir), build, VERSION, BUILD) : 'That zip has no TOMLIN in it (no package.json at its top or in its one folder). Pick the tomlin-<version>.zip file.';
    if (why) {
      await rm(STAGING, { recursive: true, force: true });
      return json(res, 400, { error: why });
    }
    ready = { dir: dir!, version: pkg.version, build };
    return json(res, 200, { version: pkg.version, build: update.shortBuild(build), mine: VERSION, mineBuild: update.shortBuild(BUILD) });
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
  '/api/install/zip': async ({ res }) => json(res, 200, { version: VERSION, build: update.shortBuild(BUILD), restarts: restarts(), ready: ready ? { version: ready.version, build: update.shortBuild(ready.build) } : null }),
};

export const selfUpdatePost: Routes = {
  // Update now: the checked copy becomes tomlin-<version> beside this one, and this copy ends so it starts.
  '/api/install/zip-go': async ({ res, b }) => {
    if (!ready || ready.version !== b.version) return json(res, 409, { error: 'That zip is no longer waiting here (TOMLIN started again, or another was picked). Upload it again.' });
    if (!restarts()) return json(res, 409, { error: notRestarting });
    const serving = jobRoutes.servingNow();
    if (serving.length) return json(res, 409, { error: 'A linked PC is using this one now (an answer or a picture). Wait for it to finish, then press Update now again.' });
    const { dir, version } = ready;
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
    if (!busy) await rm(STAGING, { recursive: true, force: true }).catch(() => undefined);
    return json(res, 200, { ok: true });
  },
};
