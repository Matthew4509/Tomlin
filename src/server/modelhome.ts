// Where models are kept (src/modelhome.ts): the folder downloads go to, chosen on any drive; the models on this PC by
// drive; and moving the models already here into the chosen folder, leaving a loaded one where it is.
import { readdirSync } from 'node:fs';
import { totalmem } from 'node:os';
import { driveAdvice } from '../driveadvice.ts';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { modelParts } from '../carry.ts';
import { ModelsHome, SPARE, byDrive, driveKinds, driveOf, drives, drivesKnown, filesToMove, forgetDrives, freeOn, idleMove, kindsKnown, modelFiles, moveFiles, moveModels, otherDriveHint, ssdTarget, wholeDrive, type MoveState } from '../modelhome.ts';
import { isNetworkPath, NETWORK_WHY, overlaps } from '../workspace.ts';
import { HOME, ROOT, type Routes, chatModels, json, modelsHome } from './core.ts';
import { hfBusy } from './hf.ts';
import { images, loadShapes, runOn, runners } from './panes.ts';

const loaded = (state: string | undefined) => state === 'connected' || state === 'loading';

/** Why nothing can be downloaded or moved in now: the chosen folder's drive is not there. '' when it is. */
export function noHomeWhy(home: ModelsHome = modelsHome): string {
  const gone = home.missing();
  return gone ? `Your models are kept in ${gone}, and that folder is not there now. Plug its drive in, or choose another folder (Models, Import models, Where models are kept), then try again.` : '';
}

/** The chosen folder put to use by everything that downloads, lists and lends models. */
function apply(): void {
  const dir = modelsHome.dir();
  chatModels.setOwn(join(dir, 'chat'));
  images.registry.dir = dir;
}

// A full drive names another drive that has room, and a missing models folder is said before a download starts.
images.registry.elsewhere = async need => otherDriveHint(need, modelsHome.dir(), await drives());
images.registry.noHome = () => noHomeWhy();
// This PC's drives and whether each is a hard disk or an SSD (the HDD mark on a model's row): asked now, as Windows is slow to say.
void driveKinds().catch(() => undefined);
void drives().catch(() => undefined);

/** Every file a loaded model is using now (lower case, full paths): never moved. */
export function inUseNow(): Set<string> {
  const out = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (p) out.add(resolve(p).toLowerCase());
  };
  for (const p of runners) {
    const v = p.view;
    if (!v.model || !loaded(v.state)) continue;
    const path = chatModels.path(v.model);
    if (path) {
      add(path);
      let names: string[] = [];
      try {
        names = readdirSync(dirname(path));
      } catch {
        // its folder cannot be read: the file itself is still kept
      }
      // The parts of a model in parts, and a vision add-on beside it, stay with it.
      for (const n of modelParts(basename(path), names)) add(join(dirname(path), n));
      for (const n of names) if (/mmproj/i.test(n)) add(join(dirname(path), n));
    }
    const draft = runOn(p).draft;
    if (draft) add(chatModels.path(draft));
  }
  const iv = images.pane.view;
  if (iv.model && loaded(iv.state)) {
    const m = images.registry.get(iv.model);
    for (const f of m?.files ?? []) add(images.registry.filePath(m!, f));
  }
  return out;
}

const downloading = () => hfBusy() || images.registry.allDownloads().some(d => !d.done && !d.error);

let move: { state: MoveState; ac: AbortController } | null = null;
/** A Move to SSD between its first check and its start (it reads the drives and tests the folder meanwhile). */
let ssdStarting = false;
const moving = () => move?.state.state === 'moving' || ssdStarting;

/** The models on this PC with the full path of each (a chat model in parts counts once, by its first part). */
function modelsHere(): { name: string; path: string; bytes: number }[] {
  const out: { name: string; path: string; bytes: number }[] = [];
  let ollamaAt: string | null | undefined;
  for (const m of chatModels.list()) {
    // Ollama keeps all its models in one place: looked up once.
    if (m.where === 'ollama' && ollamaAt === undefined) ollamaAt = chatModels.path(m.id);
    const path = m.where === 'ollama' ? ollamaAt : chatModels.path(m.id);
    if (path) out.push({ name: basename(m.file).replace(/\.gguf$/i, ''), path, bytes: m.bytes });
  }
  for (const m of images.registry.models) {
    if (m.kind !== 'image' || !images.registry.installed(m)) continue;
    out.push({ name: m.name, path: images.registry.filePath(m, m.files[0]), bytes: images.registry.bytes(m) });
  }
  return out;
}

/** What the page shows under "Where models are kept". */
async function view() {
  const all = await drives();
  const dir = modelsHome.dir();
  const missing = modelsHome.missing();
  const waiting = filesToMove(modelsHome.others());
  const free = missing ? null : await freeOn(dir).then(n => (Number.isFinite(n) ? n : null));
  const drive = driveOf(dir);
  return {
    dir,
    usual: modelsHome.usual,
    isUsual: modelsHome.chosen() === null,
    missing,
    free,
    drive,
    // Twice this PC's RAM free on the drive is suggested, less than its RAM warned about (src/driveadvice.ts); nothing is stopped.
    advice: missing ? '' : driveAdvice(totalmem(), free, drive, all.find(x => x.drive.toLowerCase() === drive.toLowerCase())?.total ?? null),
    // The models still in a folder used before, which Move brings into the chosen one.
    toMove: { files: waiting.length, bytes: waiting.reduce((n, f) => n + f.bytes, 0), from: modelsHome.others().filter(d => filesToMove([d]).length) },
    byDrive: byDrive(modelsHere(), all),
    drives: all,
    move: move?.state ?? idleMove(),
  };
}

/**
 * Keep models in `dir` from now on (null or '': the usual folder again): downloads and copies from linked PCs go there,
 * the models already here stay where they are and are still used, until Move. Asked by this PC's page, and by a linked
 * admin PC for a headless node (src/jobrun/node.ts /worker/models-where, which sends only a drive's TOMLIN models folder).
 */
export async function chooseModelsHome(want: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (moving()) return { status: 409, body: { error: 'Models are being moved now. Wait for that to finish, or stop it, then try again.' } };
  if (downloading()) return { status: 409, body: { error: 'A model is downloading now. Wait for it, or stop it, then choose the folder.' } };
  if (want === null || want === '') {
    modelsHome.set(null);
    apply();
    return { status: 200, body: { ...(await view()), said: `Models are kept in the usual folder again: ${modelsHome.usual}.` } };
  }
  const dir = String(want).trim().replace(/^"|"$/g, '');
  // A network folder: models are run from it, and another PC could change them there.
  if (isNetworkPath(dir)) return { status: 400, body: { error: `For the models, ${NETWORK_WHY}.` } };
  if (wholeDrive(dir)) return { status: 400, body: { error: `${dir} is a whole drive. Name a folder on it for the models (for example ${dir.replace(/[\\/]+$/, '')}\\TOMLIN models), then try again.` } };
  if (!isAbsolute(dir)) return { status: 400, body: { error: 'Type the whole path of the folder, starting with its drive (for example D:\\TOMLIN models).' } };
  // The app folder is replaced by an update, and the data folder is backed up whole: models go in neither.
  if (overlaps(dir, [ROOT, HOME.data, HOME.backups])) return { status: 400, body: { error: 'Models cannot be kept inside TOMLIN\'s own program, data or backups folder (or in a folder that holds one of them). Pick another folder.' } };
  const other = chatModels.other();
  if (other && resolve(other).toLowerCase() === resolve(dir).toLowerCase()) return { status: 400, body: { error: `${dir} is already connected as another program's models folder (Connect). Pick a folder of TOMLIN's own, for example ${driveOf(dir)}\\TOMLIN models.` } };
  forgetDrives();
  const on = (await drives()).find(d => d.drive === driveOf(dir));
  if (on && /^fat(32|16|12)?$/i.test(on.fs)) return { status: 400, body: { error: `${on.drive} is formatted as ${on.fs}, which cannot hold a file bigger than 4 GB, and most models are bigger. Use a drive formatted as exFAT or NTFS (a USB drive can be formatted again in File Explorer; that erases it).` } };
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, '.tomlin-write-test');
    await writeFile(probe, 'x');
    await rm(probe, { force: true });
  } catch (e) {
    return { status: 400, body: { error: `TOMLIN cannot write in ${dir} (${((e as Error).message || '').split('\n')[0].slice(0, 160)}). Check the drive is plugged in and not read-only, then try again.` } };
  }
  modelsHome.set(dir);
  apply();
  const v = await view();
  return { status: 200, body: { ...v, said: `Models are kept in ${dir} from now on: new downloads and copies from linked PCs go there.${v.toMove.files ? ' The models already on this PC stay where they are and are still used; press Move to bring them here.' : ''}` } };
}

/**
 * A linked admin PC picks one of this PC's drives for new models: its "TOMLIN models" folder, or the usual folder when
 * the usual folder is on that drive. Only a drive letter crosses, so no other folder can be named from another PC.
 */
export async function chooseModelsDrive(drive: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const usual = driveOf(modelsHome.usual) === drive;
  return chooseModelsHome(usual ? null : `${drive}\\TOMLIN models`);
}

/** GET requests answered here, by path. */
export const modelHomeGet: Routes = {
  '/api/models/where': async ({ res }) => json(res, 200, await view()),
};

/** POST requests answered here, by path (the body is read already). */
export const modelHomePost: Routes = {
  // {dir}: keep models in that folder from now on (downloads go there; the models already here stay where they are
  // and are still used, until Move). {dir: null}: the usual folder again.
  '/api/models/where': async ({ res, b }) => {
    const a = await chooseModelsHome(b.dir);
    return json(res, a.status, a.body);
  },
  // Moves the models still in a folder used before into the chosen one. A loaded model is left where it is and named.
  '/api/models/move': async ({ res }) => {
    if (moving()) return json(res, 200, await view());
    if (downloading()) return json(res, 409, { error: 'A model is downloading now. Wait for it, or stop it, then move the models.' });
    const gone = noHomeWhy();
    if (gone) return json(res, 400, { error: gone });
    const from = modelsHome.others();
    const job = { state: idleMove(), ac: new AbortController() };
    job.state.state = 'moving';
    job.state.to = modelsHome.dir();
    move = job;
    void (async () => {
      try {
        await moveModels(from, modelsHome.dir(), { state: job.state, signal: job.ac.signal, inUse: p => inUseNow().has(resolve(p).toLowerCase()) });
      } catch (e) {
        job.state.state = 'failed';
        job.state.said = `The move stopped: ${((e as Error).message || String(e)).split('\n')[0].slice(0, 200)}. What was moved so far is in the new folder, and the rest is where it was.`;
      }
      // A folder used before that is empty now is not read again.
      for (const d of from) if (!filesToMove([d]).length && d !== modelsHome.usual) modelsHome.forget(d);
      forgetDrives();
      chatModels.forget();
      void loadShapes().catch(() => undefined);
    })();
    return json(res, 200, await view());
  },
  // {id}: one chat model on a hard disk moved to an SSD of this PC (the PC window's "Move to SSD"), with the move above:
  // copied, checked by size, and only then removed. Into the chosen models folder when that is on an SSD with room;
  // else into "TOMLIN models" on the SSD with the most room, which becomes where models are kept (the folder used
  // until now is still read). The page follows it in /api/models/where's `move`.
  '/api/models/to-ssd': async ({ res, b }) => {
    if (moving()) return json(res, 409, { error: 'Models are being moved now. Wait for that to finish, then try again.' });
    // Held from here until the move is set (or refused): a second click or tab meanwhile is told to wait, never started
    // beside it (two moves wrote the same copy).
    ssdStarting = true;
    try {
      return await toSsd(res, b);
    } finally {
      ssdStarting = false;
    }
  },
  // The Storage page's Look again: this PC's drives read afresh (a drive plugged in since), then the same view.
  '/api/storage/drives': async ({ res }) => {
    forgetDrives();
    await drives().catch(() => []);
    return json(res, 200, await view());
  },
  '/api/models/move/stop': async ({ res }) => {
    if (moving()) move?.ac.abort();
    return json(res, 200, await view());
  },
};

/** Move to SSD after its first check (the route above holds the door while this runs). */
async function toSsd(res: Parameters<Routes[string]>[0]['res'], b: Record<string, unknown>) {
  {
    if (downloading()) return json(res, 409, { error: 'A model is downloading now. Wait for it, or stop it, then move this one.' });
    const id = typeof b.id === 'string' ? b.id : '';
    const m = chatModels.list().find(x => x.id === id);
    const path = m ? chatModels.path(id) : null;
    if (!m || !path) return json(res, 404, { error: 'That model is not on this PC any more.' });
    const name = basename(m.file).replace(/\.gguf$/i, '');
    if (m.where !== 'own') return json(res, 400, { error: `${name} is kept in another program's folder, so TOMLIN does not move it: that program would lose it. Move it in that program, or copy it into TOMLIN's models folder.` });
    if (inUseNow().has(resolve(path).toLowerCase())) return json(res, 409, { error: `${name} is loaded now: press Drop in the top bar first, then Move to SSD.` });
    // Free space now, not as last read (an action waits for the whole reading, unlike the list).
    forgetDrives();
    await Promise.all([drives(), driveKinds()]);
    const t = ssdTarget(path, m.bytes, modelsHome.dir(), drivesKnown(), kindsKnown());
    if (!t) return json(res, 409, { error: kindsKnown()[driveOf(path)] === 'hdd' ? `No SSD of this PC has room for ${name} now (it needs its size and ${SPARE / 2 ** 30} GB to spare). Free up space on one, then try again.` : `${name} is not on a hard disk.` });
    if (t.newHome) {
      try {
        await mkdir(t.dir, { recursive: true });
        const probe = join(t.dir, '.tomlin-write-test');
        await writeFile(probe, 'x');
        await rm(probe, { force: true });
      } catch (e) {
        return json(res, 400, { error: `TOMLIN cannot write in ${t.dir} (${((e as Error).message || '').split('\n')[0].slice(0, 160)}), so nothing was moved.` });
      }
      modelsHome.set(t.dir);
      apply();
    }
    // The model's files (all its parts), at the same place inside the new folder's chat/.
    let names: string[] = [];
    try {
      names = readdirSync(dirname(path));
    } catch {
      // its folder cannot be read now: the file itself still moves
    }
    const files = modelFiles(modelParts(basename(path), names).map(n => join(dirname(path), n)), ['chat', ...m.file.split('/').slice(0, -1)].join('/'));
    const job = { state: idleMove(), ac: new AbortController() };
    job.state.state = 'moving';
    job.state.to = modelsHome.dir();
    move = job;
    void (async () => {
      try {
        await moveFiles(files, modelsHome.dir(), { state: job.state, signal: job.ac.signal, inUse: p => inUseNow().has(resolve(p).toLowerCase()) });
      } catch (e) {
        job.state.state = 'failed';
        job.state.said = `The move stopped: ${((e as Error).message || String(e)).split('\n')[0].slice(0, 200)}. ${name} is still where it was.`;
      }
      forgetDrives();
      chatModels.forget();
      void loadShapes().catch(() => undefined);
    })();
    return json(res, 200, { move: job.state, said: `Moving ${name} to ${t.drive} (an SSD). It stays where it is until the copy there is checked.${t.newHome ? ` Models are kept in ${t.dir} from now on: new downloads go there too, and the folder used until now is still read.` : ''}` });
  }
}
