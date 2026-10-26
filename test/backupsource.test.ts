import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupSource, gitExe } from '../tools/backup-source.ts';

// Every folder made here is removed when the file ends.
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tomlin-srcbak-'));
  made.push(d);
  return d;
};
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const git = (dir: string, ...args: string[]) => execFileSync(gitExe(), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8', windowsHide: true });
const tar = () => process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function repo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'master');
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
  git(d, 'add', 'a.ts');
  git(d, 'commit', '-q', '-m', 'first');
  mkdirSync(join(d, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(d, 'docs', 'handoffs', 'HANDOFF-1.md'), 'notes\n');
  writeFileSync(join(d, 'TOKEN-LOG.md'), 'tokens\n');
  writeFileSync(join(d, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(d, 'node_modules'));
  writeFileSync(join(d, 'node_modules', 'big.js'), 'ignored\n');
  // A repo inside (the public clone) keeps its own history and is left out.
  mkdirSync(join(d, 'inner'));
  git(join(d, 'inner'), 'init', '-q');
  writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n');
  return d;
}

test('a source backup holds every commit and the notes, and a second run with nothing new makes nothing', () => {
  const src = repo();
  const dest = join(tmp(), 'backups');
  const one = backupSource({ repo: src, dest, now: new Date(2026, 9, 26, 2, 0, 0) });
  assert.equal(one.made, join(dest, '2026-10-26 020000'));
  // The bundle brings the history back.
  const back = join(tmp(), 'back');
  execFileSync(gitExe(), ['clone', '-q', join(one.made, 'source.bundle'), back], { windowsHide: true });
  assert.equal(git(back, 'log', '--format=%s').trim(), 'first');
  const listed = execFileSync(tar(), ['-t', '-f', join(one.made, 'notes.zip')], { encoding: 'utf8' });
  assert.match(listed, /docs\/handoffs\/HANDOFF-1\.md/);
  assert.match(listed, /TOKEN-LOG\.md/);
  assert.match(listed, /\.gitignore/);
  assert.doesNotMatch(listed, /node_modules|inner/);
  assert.equal(existsSync(join(one.made, 'work.patch')), false, 'nothing uncommitted yet');

  assert.equal(backupSource({ repo: src, dest, now: new Date(2026, 9, 26, 3, 0, 0) }).made, null);
  assert.match(readFileSync(join(dest, 'backup-log.txt'), 'utf8'), /Made 2026-10-26 020000[\s\S]*Nothing new/);

  // An uncommitted change and a changed note are new: they go in, the change as work.patch.
  writeFileSync(join(src, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(src, 'docs', 'handoffs', 'HANDOFF-2.md'), 'more\n');
  const two = backupSource({ repo: src, dest, now: new Date(2026, 9, 26, 4, 0, 0) });
  assert.ok(two.made);
  const listed2 = execFileSync(tar(), ['-t', '-f', join(two.made, 'notes.zip')], { encoding: 'utf8' });
  assert.match(listed2, /HANDOFF-2\.md/);
  // The patch puts the change back on a clone of the bundle.
  const back2 = join(tmp(), 'back2');
  execFileSync(gitExe(), ['clone', '-q', join(two.made, 'source.bundle'), back2], { windowsHide: true });
  git(back2, 'apply', join(two.made, 'work.patch'));
  assert.equal(readFileSync(join(back2, 'a.ts'), 'utf8').replace(/\r/g, ''), 'export const a = 2;\n');
});

test('older source backups thin out by age as data backups do, and a half-made one is never counted', () => {
  const src = repo();
  const dest = join(tmp(), 'backups');
  // Forty nightly runs: the newest 5, then one a day / week / quarter stay.
  for (let i = 40; i >= 1; i--) {
    writeFileSync(join(src, 'TOKEN-LOG.md'), `tokens ${i}\n`);
    backupSource({ repo: src, dest, now: new Date(2026, 9, 26 - i, 2, 0, 0) });
  }
  mkdirSync(join(dest, '2026-10-26 010000.part'));
  writeFileSync(join(src, 'TOKEN-LOG.md'), 'tokens now\n');
  const last = backupSource({ repo: src, dest, now: new Date(2026, 9, 26, 2, 0, 0) });
  const runs = readdirSync(dest).filter(n => /^\d{4}-\d\d-\d\d \d{6}$/.test(n));
  assert.ok(runs.length < 15 && runs.length >= 8, `kept ${runs.length}`);
  assert.ok(runs.includes('2026-10-26 020000'));
  assert.ok(last.removed.length > 0);
  for (const r of runs) assert.ok(existsSync(join(dest, r, 'source.bundle')), r);
});

test('a backup that cannot be made says so in the log and throws', () => {
  const dest = join(tmp(), 'backups');
  assert.throws(() => backupSource({ repo: join(tmp(), 'not-a-repo'), dest }));
  assert.match(readFileSync(join(dest, 'backup-log.txt'), 'utf8'), /FAILED/);
});
