// Everything TOMLIN keeps that could fill a drive, kept within bounds, on a node nobody opens as on a PC in use (a node
// filled a 256 GB drive: a 122.6 GB weight cache and 19 old program copies). What each cleanup removes, and when:
//
// Started here (startDiskCare, from src/server.ts once the server answers):
// - Low disk (src/lowdisk.ts): every 5 minutes the drives of the data and models folders are read. Under 10 GB free a
//   log line, under 5 GB a louder one, one when there is room again, and a notification at most once a day per drive.
//   Removes nothing.
// - Old parts (src/oldfiles.ts sweepParts), 1 minute after the start and every hour: ".part" files nothing wrote to for
//   7 days, directly in the models folders' chat, image, image\loras and helpers folders (downloads, copies from linked
//   PCs, model moves), in runtime\_downloads (runner downloads), and ".zip.part" files in each linked PC's folder under
//   "backups from other PCs" (restore points sent here).
// - Old runner zips (src/oldfiles.ts sweepUnpinned), 1 minute after the start: files in runtime\_downloads that no pin
//   of this version names (an older version's runner zips, about 1.2 GB each).
// - Project backups kept for linked PCs (src/projectstore.ts), 2 minutes after the start and every hour: each PC's
//   newest 30 backups are kept, older history and the files only it needed go (files written in the last day stay); all
//   of them together stay under 20 GB or a tenth of the drive, the oldest backups across every PC going first; a part
//   of a stopped send untouched for a day and files unpacked for a bring-back over 6 hours ago go.
//
// Done where the files are written (not scheduled):
// - Local backups of data\ (src/keep.ts backupSaying): after each backup, beyond keptByAge, the oldest go while all of
//   them take more than a tenth of the drive or 5 times the newest one; the newest 2 always stay. data\bridge\logs is
//   not in them.
// - Workspace ".bak" copies (src/workspace.ts save): the newest 5 time-stamped ones of each file stay.
// - The weight cache (src/maxlend.ts): brought under 24 GB at every start, hourly and around each loan (src/jobrun/node.ts);
//   after a loan ended by force, the cache files it wrote in its last 5 minutes go (one cut short would load as wrong
//   weights); after the disk floor ended a loan, the next loan runs without the cache until 44 GB is free.
// - Old program copies (src/installer.ts) at start; restore points kept for a linked PC (src/carry.ts): its newest 3.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.ts';
import * as mute from './mute.ts';
import { LowDiskWatch } from './lowdisk.ts';
import { sweepParts, sweepUnpinned, type Swept } from './oldfiles.ts';
import { trimProjectStores } from './projectstore.ts';

export interface CareDeps {
  /** TOMLIN's data folder (the home's data\). */
  data: string;
  /** The models folders in use now: where models are kept, and the home's usual one. Read each time. */
  models: () => string[];
  /** "backups from other PCs" in the home: restore points and project backups kept for linked PCs. */
  keptRoot: string;
  runtimes: { downloadsDir: string; downloadNames: () => string[] };
  notifier: { tell: (event: mute.Event, text: string, open: string) => Promise<unknown> };
  mutes: { get: () => Promise<mute.Mutes> };
}

const HOUR = 3600_000;
const gb = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

/** The folders model parts can be left in: chat, image, image\loras and helpers in each models folder. */
export const partFolders = (models: string[]): string[] => models.flatMap(m => [join(m, 'chat'), join(m, 'image'), join(m, 'image', 'loras'), join(m, 'helpers')]);

/** Every linked PC's folder under "backups from other PCs" (where restore points come in). */
async function pcFolders(keptRoot: string): Promise<string[]> {
  return (await readdir(keptRoot, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => join(keptRoot, e.name));
}

const said = (what: string, s: Swept) => `${what}: removed ${s.files} file${s.files === 1 ? '' : 's'} (${gb(s.bytes)}).`;

/** The old parts, once. Never throws. */
export async function sweepOldParts(d: Pick<CareDeps, 'models' | 'keptRoot' | 'runtimes'>, now = Date.now()): Promise<Swept> {
  const models = await sweepParts([...partFolders(d.models()), d.runtimes.downloadsDir], { now });
  const points = await sweepParts(await pcFolders(d.keptRoot), { now, ending: '.zip.part' });
  return { files: models.files + points.files, bytes: models.bytes + points.bytes, names: [...models.names, ...points.names] };
}

/** Starts every scheduled cleanup and the low-disk watch. Each runs on its own; none can stop the server. */
export function startDiskCare(d: CareDeps): void {
  new LowDiskWatch({
    places: () => [{ path: d.data, what: 'your data' }, ...d.models().slice(0, 1).map(path => ({ path, what: 'your models' }))],
    say: (loud, text) => (loud ? log.error : log.warn)('disk', text),
    tell: async text => {
      if (mute.shouldTell(await d.mutes.get(), [], 'stuck')) await d.notifier.tell('stuck', text, 'nodes:');
    },
    file: join(d.data, 'disk-warned.json'),
  }).start();
  const parts = async () => {
    const s = await sweepOldParts(d).catch(() => null);
    if (s?.files) log.info('disk', `${said('Unfinished downloads and copies untouched for 7 days', s)} ${s.names.slice(0, 5).join(', ')}${s.names.length > 5 ? ', ...' : ''}`);
  };
  const runners = async () => {
    const s = await sweepUnpinned(d.runtimes.downloadsDir, d.runtimes.downloadNames()).catch(() => null);
    if (s?.files) log.info('disk', said('Runner downloads this version does not use', s));
  };
  const projects = async () => {
    const r = await trimProjectStores(d.keptRoot).catch(() => null);
    if (r && (r.objects || r.leftovers)) log.info('disk', `Project backups kept for linked PCs: ${r.commits} older backup${r.commits === 1 ? '' : 's'} let go, ${r.objects + r.leftovers} files removed (${gb(r.bytes)}).`);
  };
  setTimeout(() => void parts().then(runners), 60_000).unref();
  setInterval(() => void parts(), HOUR).unref();
  setTimeout(() => void projects(), 2 * 60_000).unref();
  setInterval(() => void projects(), HOUR).unref();
}
