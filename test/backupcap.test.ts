// Local backups of data\ have a cap in bytes as well as by age (src/keep.ts keptBySize), and the Bridge's run logs are
// not in them (nor lost by a restore). On real temp folders where files are made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as keep from '../src/keep.ts';

const GB = 2 ** 30;
const b = (day: number, bytes: number): keep.Backup => ({ name: `2026-11-${String(day).padStart(2, '0')} 100000 by hand.zip`, at: day, bytes });

test('backups by size: the oldest go while they take more than a tenth of the drive or 5 times the newest; the newest 2 always stay', () => {
  assert.deepEqual([keep.BACKUPS_SHARE, keep.BACKUPS_TIMES, keep.KEEP_ALWAYS], [0.1, 5, 2]);
  const all = [b(1, 3 * GB), b(2, 3 * GB), b(3, 3 * GB), b(4, 3 * GB), b(5, 3 * GB), b(6, 3 * GB), b(7, 3 * GB)];
  const byAge = new Set(all.map(x => x.name));
  // 3 GB of data, 7 kept by age: 5 times the newest is 15 GB, so the newest 5 stay.
  assert.deepEqual([...keep.keptBySize(all, byAge, null)].map(n => n.slice(8, 10)), ['07', '06', '05', '04', '03']);
  // A small drive (100 GB): a tenth is 10 GB, so 3 of them.
  assert.deepEqual([...keep.keptBySize(all, byAge, 100 * GB)].map(n => n.slice(8, 10)), ['07', '06', '05']);
  // A tiny drive: still the newest 2.
  assert.deepEqual([...keep.keptBySize(all, byAge, 10 * GB)].map(n => n.slice(8, 10)), ['07', '06']);
  // Only what the age rule kept is counted, and zips a little larger than the newest still fit 5.
  const varied = [b(1, 3.1 * GB), b(2, 3.1 * GB), b(3, 3.05 * GB), b(4, 3.02 * GB), b(5, 3 * GB)];
  assert.equal(keep.keptBySize(varied, new Set(varied.map(x => x.name)), null).size, 5);
  assert.deepEqual([...keep.keptBySize(all, new Set([all[0].name, all[6].name]), null)].sort(), [all[0].name, all[6].name].sort());
  assert.equal(keep.keptBySize([], new Set(), null).size, 0);
});

test('a small zip whose name is not a backup\'s (put there by hand, or brought back from a linked PC) does not shrink the cap to nothing', () => {
  const all = [b(1, 3 * GB), b(2, 3 * GB), b(3, 3 * GB), b(4, 3 * GB), b(5, 3 * GB), { name: 'zz notes.zip', at: 6, bytes: 1024 }];
  const kept = keep.keptBySize(all, new Set(all.map(x => x.name)), null);
  // 5 times the newest backup (3 GB) still holds all five backups; before, 5 times 1 KB kept only two of them.
  for (const x of all.slice(0, 5)) assert.ok(kept.has(x.name), `${x.name} was let go`);
});

test('a data backup leaves out the Bridge run logs, and a restore keeps the ones in place', async () => {
  const top = await mkdtemp(join(tmpdir(), 'sm-keep-logs-'));
  try {
    const home = keep.resolveHome({ TOMLIN_HOME: join(top, 'TOMLIN') });
    const put = async (file: string, text: string) => {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, text);
    };
    await put(join(home.data, 'settings.json'), '{"v":"first"}');
    await put(join(home.data, 'bridge', 'logs', 'site-run.log'), 'a program writing all day');
    await put(join(home.data, 'bridge', 'settings.json'), '{}');
    const root = join(top, 'apps', 'tomlin-2.0.99');
    await put(join(root, 'package.json'), JSON.stringify({ name: 'tomlin', version: '2.0.99' }));
    await put(join(root, 'runtimes.json'), JSON.stringify({ runtimes: {} }));
    await keep.prepare(home, root, '2.0.99');
    const name = await keep.backup(home, 'by hand');
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const listed = execFileSync(tar, ['-t', '-f', join(home.backups, name)], { encoding: 'utf8' });
    assert.match(listed, /bridge\/settings\.json/);
    assert.doesNotMatch(listed, /bridge\/logs/);
    // Put back: the logs as they are now stay.
    await put(join(home.data, 'settings.json'), '{"v":"second"}');
    await put(join(home.data, 'bridge', 'logs', 'site-run.log'), 'newer lines');
    await keep.planNext(home, { do: 'restore', name });
    await keep.prepare(home, root, '2.0.99');
    assert.equal(await readFile(join(home.data, 'settings.json'), 'utf8'), '{"v":"first"}');
    assert.equal(await readFile(join(home.data, 'bridge', 'logs', 'site-run.log'), 'utf8'), 'newer lines');
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});
