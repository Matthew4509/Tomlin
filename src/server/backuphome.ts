// Where the backups other PCs send here are kept (restore points, and the project backups in git): "backups from other PCs"
// in the home, or a folder chosen on another drive (a PC set up as a network backup, with a big drive for it). The choice is
// one small file in the home, backups-home.txt, kept the way models-home.txt keeps where models are (src/modelhome.ts).
// Changed only while nothing is kept in the folder used now: moving backups already kept is not done yet, so a PC that
// holds some is told so and nothing changes. Every use of the folder asks backupsHome.dir() each time, so a change counts
// at once. Tested in test/backuphome.test.ts.
import { readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { totalmem } from 'node:os';
import { driveAdvice } from '../driveadvice.ts';
import { drives, driveOf, forgetDrives, freeOn, wholeDrive } from '../modelhome.ts';
import { isNetworkPath, NETWORK_WHY, overlaps } from '../workspace.ts';
import { HOME, ROOT, type Routes, backupsHome, json, modelsHome } from './core.ts';

/** How many linked PCs have a folder of backups in `dir` (one folder a PC; nothing when the folder is not there yet). */
async function keptIn(dir: string): Promise<number> {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).length;
}

async function view() {
  const dir = backupsHome.dir();
  const missing = backupsHome.missing();
  const all = await drives();
  const free = missing ? null : await freeOn(dir).then(n => (Number.isFinite(n) ? n : null));
  const drive = driveOf(dir);
  return {
    dir,
    usual: backupsHome.usual,
    isUsual: backupsHome.chosen() === null,
    missing,
    free,
    drive,
    /** Linked PCs that have backups kept in the folder used now. */
    kept: missing ? 0 : await keptIn(dir),
    advice: missing ? '' : driveAdvice(totalmem(), free, drive, all.find(x => x.drive.toLowerCase() === drive.toLowerCase())?.total ?? null),
    /** This PC's drives, offered as one-click choices on the page. */
    drives: all,
  };
}

export const backupHomeGet: Routes = {
  '/api/backups/where': async ({ res }) => json(res, 200, await view()),
};

export const backupHomePost: Routes = {
  // {dir}: keep other PCs' backups in that folder from now on. {dir: null}: the usual folder again. Refused while the folder
  // used now holds backups: they would be left behind there, out of sight, and a restore point could not be found.
  '/api/backups/where': async ({ res, b }) => {
    const back = b.dir === null || b.dir === '';
    const dir = back ? backupsHome.usual : String(b.dir).trim().replace(/^"|"$/g, '');
    const kept = backupsHome.missing() ? 0 : await keptIn(backupsHome.dir());
    if (kept && dir.toLowerCase() !== backupsHome.dir().toLowerCase()) {
      return json(res, 409, { error: `${kept} linked PC${kept === 1 ? ' keeps' : 's keep'} backups in ${backupsHome.dir()} now. Moving backups to another folder is not built yet, so nothing was changed: they would be left behind there. Remove them from that folder first if you no longer need them.` });
    }
    if (back) {
      backupsHome.set(null);
      return json(res, 200, { ...(await view()), said: `Backups are kept in the usual folder again: ${backupsHome.usual}.` });
    }
    // A network folder: a git repository on a share is slow and breaks when two PCs write it.
    if (isNetworkPath(dir)) return json(res, 400, { error: `For backups, ${NETWORK_WHY}.` });
    if (wholeDrive(dir)) return json(res, 400, { error: `${dir} is a whole drive. Name a folder on it for the backups (for example ${dir.replace(/[\\/]+$/, '')}\\Tomlin\\backups), then try again.` });
    if (!isAbsolute(dir)) return json(res, 400, { error: 'Type the whole path of the folder, starting with its drive (for example D:\\Tomlin\\backups).' });
    // The app folder is replaced by an update, the data folder is backed up whole, and models have their own folder.
    if (overlaps(dir, [ROOT, HOME.data, HOME.backups, modelsHome.dir()])) return json(res, 400, { error: 'Backups cannot be kept inside TOMLIN\'s own program, data, backups or models folder (or in a folder that holds one of them). Pick another folder.' });
    forgetDrives();
    const on = (await drives()).find(d => d.drive === driveOf(dir));
    if (on && /^fat(32|16|12)?$/i.test(on.fs)) return json(res, 400, { error: `${on.drive} is formatted as ${on.fs}, which cannot hold a file bigger than 4 GB, and a restore point can be bigger. Use a drive formatted as exFAT or NTFS.` });
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, '.tomlin-write-test');
      await writeFile(probe, 'x');
      await rm(probe, { force: true });
    } catch (e) {
      return json(res, 400, { error: `TOMLIN cannot write in ${dir} (${((e as Error).message || '').split('\n')[0].slice(0, 160)}). Check the drive is plugged in and not read-only, then try again.` });
    }
    backupsHome.set(dir);
    return json(res, 200, { ...(await view()), said: `Backups from other PCs are kept in ${dir} from now on.` });
  },
};
