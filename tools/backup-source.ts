// A copy of the source on a second drive, for a PC whose git history lives on this disk only. Nothing leaves the PC.
//   npm run backup-source -- D:\TOMLIN-source-backups      (or set TOMLIN_SOURCE_BACKUP; the nightly task runs this)
// Each run that finds something new makes one folder named "<date> <time>" holding source.bundle (git bundle --all:
// every branch and commit, checked with git bundle verify; git clone source.bundle brings it all back) and notes.zip
// (what git does not hold: every file not in git and not ignored, such as the working notes, pictures and settings
// files and the token log; a git repo inside the folder is left to its own history, and ignored files such as
// node_modules, runtime and models are left out), with work.patch beside them when some changes are not committed yet
// (git apply work.patch in the clone puts them back). A run that
// finds nothing new since the last one makes nothing. Older folders thin out by age as data backups do (keptByAge).
// Each run adds one line to backup-log.txt in the backup folder. Tested in test/backupsource.test.ts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keptByAge } from '../src/keep.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Copied whole into notes.zip when they are there, even when git tracks them (the token log is never committed). */
export const NOTES = ['TOKEN-LOG.md'];
const RUN = /^\d{4}-\d\d-\d\d \d{6}$/;
const STAMP = 'last-stamp.txt';

/** git, found on the PATH or where Git for Windows installs it (it is not always on the PATH of a scheduled task). */
export function gitExe(): string {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return 'git';
  } catch {}
  const installed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
  if (existsSync(installed)) return installed;
  throw new Error('git was not found (on the PATH or in Program Files\\Git)');
}

const tarExe = () => process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const two = (n: number) => String(n).padStart(2, '0');
const runName = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;

/** What notes.zip holds: the files not in git and not ignored (a repo inside shows as "dir/" and is left out), and the
 * NOTES that are there, as [path from the repo, size, time]. */
function noteFiles(repo: string, untracked: string[], notes: string[]): [string, number, number][] {
  const names = new Set([...untracked.filter(f => f && !f.endsWith('/')), ...notes.filter(n => existsSync(join(repo, n)))]);
  return [...names].sort().filter(f => statSync(join(repo, f)).isFile()).map(f => {
    const s = statSync(join(repo, f));
    return [f, s.size, Math.floor(s.mtimeMs)];
  });
}

export interface SourceBackup {
  /** The folder made, or null when nothing changed since the last run. */
  made: string | null;
  /** Older folders taken away by age. */
  removed: string[];
  said: string;
}

/** One backup of `repo` into `dest` (see the top of this file). Throws, after logging, when a part cannot be made. */
export function backupSource({ repo = ROOT, dest, notes = NOTES, now = new Date() }: { repo?: string; dest: string; notes?: string[]; now?: Date }): SourceBackup {
  mkdirSync(dest, { recursive: true });
  const log = (line: string) => appendFileSync(join(dest, 'backup-log.txt'), `${runName(new Date())}  ${line}\r\n`);
  try {
    const git = gitExe();
    const g = (args: string[]) => execFileSync(git, ['-C', repo, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 1024 ** 3 });
    const refs = g(['for-each-ref', '--format=%(objectname) %(refname)']).toString();
    const patch = g(['diff', 'HEAD', '--binary']);
    const files = noteFiles(repo, g(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0'), notes);
    const stamp = createHash('sha256').update(refs).update(patch).update(JSON.stringify(files)).digest('hex');
    const last = existsSync(join(dest, STAMP)) ? readFileSync(join(dest, STAMP), 'utf8').trim() : '';
    if (stamp === last) {
      const said = 'Nothing new since the last backup.';
      log(said);
      return { made: null, removed: [], said };
    }
    const name = runName(now);
    const folder = join(dest, name);
    const part = `${folder}.part`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    g(['bundle', 'create', join(part, 'source.bundle'), '--all']);
    g(['bundle', 'verify', join(part, 'source.bundle')]);
    if (patch.length) writeFileSync(join(part, 'work.patch'), patch);
    if (files.length) {
      // The files are named in a list (hundreds of names do not fit on one command line). Windows' tar misreads a
      // second -C after -T, so work.patch stays beside the zip.
      writeFileSync(join(part, 'files.txt'), files.map(f => f[0]).join('\n') + '\n');
      execFileSync(tarExe(), ['-a', '-c', '-f', join(part, 'notes.zip'), '-C', repo, '-T', join(part, 'files.txt')], { stdio: 'ignore', windowsHide: true });
      rmSync(join(part, 'files.txt'), { force: true });
      const listed = execFileSync(tarExe(), ['-t', '-f', join(part, 'notes.zip')], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
      if (listed.length < files.length) throw new Error(`notes.zip holds ${listed.length} entries, ${files.length} files were to go in`);
    }
    renameSync(part, folder);
    writeFileSync(join(dest, STAMP), stamp);
    // Thinned as data backups are: the newest 5, then one a day for a week, a week for a month, a quarter for a year.
    const runs = readdirSync(dest).filter(n => RUN.test(n) && statSync(join(dest, n)).isDirectory())
      .map(n => ({ name: n, at: new Date(+n.slice(0, 4), +n.slice(5, 7) - 1, +n.slice(8, 10), +n.slice(11, 13), +n.slice(13, 15), +n.slice(15, 17)).getTime(), bytes: 0 }));
    const kept = keptByAge(runs, now);
    const removed = runs.filter(r => !kept.has(r.name)).map(r => r.name);
    for (const r of removed) rmSync(join(dest, r), { recursive: true, force: true });
    const mb = (statSync(join(folder, 'source.bundle')).size / 1024 ** 2).toFixed(1);
    const said = `Made ${name}: source.bundle ${mb} MB (verified), ${files.length} file(s) not in git${patch.length ? ' and the uncommitted changes' : ''}.${removed.length ? ` Took away ${removed.length} older.` : ''}`;
    log(said);
    return { made: folder, removed, said };
  } catch (e) {
    log(`FAILED: ${(e as Error).message.split('\n')[0]}`);
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2] ?? process.env.TOMLIN_SOURCE_BACKUP;
  if (!dest) {
    console.error('Name the backup folder: npm run backup-source -- D:\\TOMLIN-source-backups (or set TOMLIN_SOURCE_BACKUP).');
    process.exit(1);
  }
  try {
    console.log(backupSource({ dest: resolve(dest) }).said);
  } catch (e) {
    console.error(`Source backup FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
}
