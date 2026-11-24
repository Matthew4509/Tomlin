// One low-disk floor and a warning (src/lowdisk.ts): a log line under 10 GB, a louder one under 5 GB, one when there is
// room again, a notification at most once a day per drive (kept across a restart), places on one drive read once.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskStep, drivesOf, freeOn, LOW_DISK, LowDiskWatch, PICTURE_ROOM, pictureRoomLine, VERY_LOW_DISK } from '../src/lowdisk.ts';

const GB = 2 ** 30;
const HOUR = 3600_000;
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test('the floor: a line going under it, a louder one under 5 GB, one with room again; a notification once a day', () => {
  assert.equal(LOW_DISK, 10 * GB);
  assert.equal(VERY_LOW_DISK, 5 * GB);
  const ok = { level: 'ok' as const, toldAt: 0 };
  const at = 100 * 24 * HOUR;
  assert.deepEqual(diskStep(ok, 50 * GB, 'C:', 'your data', at), { state: ok, line: null, tell: null });
  const low = diskStep(ok, 8 * GB, 'C:', 'your data', at);
  assert.equal(low.state.level, 'low');
  assert.equal(low.line?.loud, false);
  assert.match(low.line!.text, /^Drive C: has 8\.0 GB free, under the 10\.0 GB TOMLIN keeps free\. TOMLIN keeps your data there\./);
  assert.match(low.tell!, /Drive C: is nearly full: 8\.0 GB free/);
  // Still low an hour later: no new line, no second notification the same day.
  const again = diskStep(low.state, 7.5 * GB, 'C:', 'your data', at + HOUR);
  assert.deepEqual([again.line, again.tell, again.state.level], [null, null, 'low']);
  // Under 5 GB: said louder, but the notification waits for its day.
  const worse = diskStep(again.state, 3 * GB, 'C:', 'your data', at + 2 * HOUR);
  assert.equal(worse.state.level, 'very low');
  assert.equal(worse.line?.loud, true);
  assert.match(worse.line!.text, /only 3\.0 GB free/);
  assert.equal(worse.tell, null);
  // A day after the last one: told again.
  assert.match(diskStep(worse.state, 3 * GB, 'C:', 'your data', at + 25 * HOUR).tell ?? '', /nearly full/);
  // Back over 10 GB but under 11: still low (a drive at the floor is not said every few minutes); 11 GB: room again.
  const hover = diskStep(worse.state, 10.5 * GB, 'C:', 'your data', at + 3 * HOUR);
  assert.deepEqual([hover.state.level, hover.line], ['very low', null]);
  const room = diskStep(hover.state, 12 * GB, 'C:', 'your data', at + 4 * HOUR);
  assert.equal(room.state.level, 'ok');
  assert.match(room.line!.text, /^Drive C: has room again: 12\.0 GB free\.$/);
  assert.equal(room.tell, null);
  assert.equal(room.state.toldAt, at, 'the time of the last notification is kept');
});

test('a notification time from the future (the clock was set back) does not hold every notification back for years', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const years = 5 * 365 * 24 * HOUR;
  const r = diskStep({ level: 'ok', toldAt: now + years }, 3 * GB, 'C:', 'your data', now);
  assert.ok(r.tell, 'a nearly full drive is told');
  assert.equal(r.state.toldAt, now);
  // A clock set back a little is no reason to tell again at once.
  assert.equal(diskStep({ level: 'very low', toldAt: now + 2 * HOUR }, 3 * GB, 'C:', 'your data', now).tell, null);
});

test('places on one drive are read once and named together', () => {
  assert.deepEqual(drivesOf([{ path: 'C:\\Users\\a\\TOMLIN\\data', what: 'your data' }, { path: 'c:\\Users\\a\\TOMLIN\\models', what: 'your models' }, { path: 'D:\\Models', what: 'your models' }, { path: '', what: 'nothing' }]), [
    { drive: 'C:', path: 'C:\\Users\\a\\TOMLIN\\data', what: 'your data and your models' },
    { drive: 'D:', path: 'D:\\Models', what: 'your models' },
  ]);
});

test('the watch: says it in the log and tells once a day per drive, even across a restart; a drive it cannot read is skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-lowdisk-'));
  made.push(dir);
  const file = join(dir, 'disk-warned.json');
  const free: Record<string, number | null> = { 'C:\\data': 4 * GB, 'D:\\models': 60 * GB, 'E:\\gone': null };
  const said: string[] = [];
  const told: string[] = [];
  const make = () => new LowDiskWatch({
    places: () => [{ path: 'C:\\data', what: 'your data' }, { path: 'D:\\models', what: 'your models' }, { path: 'E:\\gone', what: 'old models' }],
    free: async p => free[p],
    say: (loud, text) => said.push(`${loud ? 'LOUD' : 'warn'} ${text}`),
    tell: text => void told.push(text),
    file,
  });
  const w = make();
  const t0 = Date.now();
  await w.check(t0);
  assert.equal(w.level('C:'), 'very low');
  assert.equal(w.level('D:'), 'ok');
  assert.equal(said.length, 1);
  assert.match(said[0], /^LOUD Drive C: is nearly full/);
  assert.equal(told.length, 1);
  assert.ok(JSON.parse(readFileSync(file, 'utf8'))['c:'] === t0);
  await w.check(t0 + HOUR);
  assert.equal(told.length, 1, 'once a day');
  // A restart the same day: the log says it again (a new run), the notification does not.
  const restarted = make();
  await restarted.check(t0 + 2 * HOUR);
  assert.equal(said.length, 2);
  assert.equal(told.length, 1);
  free['D:\\models'] = 9 * GB;
  await restarted.check(t0 + 3 * HOUR);
  assert.equal(told.length, 2, 'another drive is told on its own');
  assert.match(told[1], /Drive D: .*your models there/);
  // A watch whose tell fails, or whose places throw, never throws.
  await new LowDiskWatch({ places: () => { throw new Error('no'); }, say: () => undefined, tell: () => undefined }).check();
  await new LowDiskWatch({ places: () => [{ path: 'C:\\x', what: 'x' }], free: async () => GB, say: () => undefined, tell: () => Promise.reject(new Error('no')) }).check();
  // The real reading of a folder that is there, and of one that is not.
  assert.ok(((await freeOn(dir)) ?? 0) > 0);
  assert.equal(await freeOn(join(dir, 'missing', 'deeper')), null);
});

test('the picture pane reminds under 2 GB free where pictures are kept, and is quiet with room or when it cannot read', () => {
  assert.equal(PICTURE_ROOM, 2 * GB);
  assert.equal(pictureRoomLine(1.6 * GB, 'C:'), 'Drive C: has 1.6 GB free. Pictures still save; free up space soon.');
  assert.equal(pictureRoomLine(0, ''), 'The drive the gallery is on has 0.0 GB free. Pictures still save; free up space soon.');
  assert.equal(pictureRoomLine(2 * GB, 'C:'), '');
  assert.equal(pictureRoomLine(50 * GB, 'D:'), '');
  assert.equal(pictureRoomLine(null, 'C:'), '');
});

test('the picture pane has a place for the reminder and shows it only when the gallery answer has one', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<p class="hint img-lowdisk" id="img-lowdisk" role="status" hidden><\/p>/);
  const js = readFileSync(new URL('../public/images.js', import.meta.url), 'utf8');
  assert.match(js, /\$\('#img-lowdisk'\)\.hidden = !g\.lowDisk;/);
});
