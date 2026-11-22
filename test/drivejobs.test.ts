// Drive jobs and the Model store and Backups pools (src/drivejobs.ts, src/jobrun/storage.ts, public/netmap.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dj from '../src/drivejobs.ts';
import { cleanDrives } from '../src/carry.ts';
import { HOST_ONLY_DOORS } from '../src/guestpass.ts';

const ROOT = join(import.meta.dirname, '..');
const TB = 2 ** 40;
const drive = (pc: string, letter: string, total: number, free: number, ok = true): dj.PoolDrive => ({ pc, pcName: pc, drive: letter, label: '', total, free, ok });

test('saved jobs keep known jobs on drive letters only, each once, and drop a drive with none', () => {
  assert.deepEqual(dj.cleanJobs({ 'd:': ['backups', 'store', 'store', 'x'], 'E:': [], '\\\\pc\\s': ['store'], F: 'store' }), { 'D:': ['store', 'backups'] });
  assert.deepEqual(dj.cleanJobs(null), {});
  assert.deepEqual(dj.cleanJobList(['backups', 'nope']), ['backups']);
});

test('models are spread and backups mirrored until he chooses otherwise', () => {
  assert.deepEqual(dj.cleanPools(null), { store: { mode: 'spread' }, backups: { mode: 'mirror' } });
  assert.deepEqual(dj.cleanPools({ store: { mode: 'mirror' }, backups: { mode: 'raid' } }), { store: { mode: 'mirror' }, backups: { mode: 'mirror' } });
});

test('jobs and pools are kept in their own files and read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drivejobs-'));
  try {
    dj.useFiles(join(dir, 'drive-jobs.json'), join(dir, 'drive-pools.json'));
    dj.setJobsHere('d:', ['store']);
    dj.setJobsHere('E:', ['backups', 'store']);
    assert.deepEqual(dj.jobsHere(), { 'D:': ['store'], 'E:': ['store', 'backups'] });
    dj.setJobsHere('D:', []);
    assert.deepEqual(dj.jobsHere(), { 'E:': ['store', 'backups'] });
    dj.setPoolMode('store', 'mirror');
    assert.equal(dj.poolsHere().store.mode, 'mirror');
    assert.match(readFileSync(join(dir, 'drive-pools.json'), 'utf8'), /"mirror"/);
  } finally {
    dj.useFiles('', '');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Spread adds every drive up; Mirror is half, and never more than the room outside the fullest PC', () => {
  const two = [drive('A', 'D:', 2 * TB, 2 * TB), drive('B', 'D:', 2 * TB, 1 * TB)];
  assert.equal(dj.poolView('store', 'spread', two).size, 4 * TB);
  assert.equal(dj.poolView('store', 'spread', two).free, 3 * TB);
  assert.equal(dj.poolView('backups', 'mirror', two).size, 2 * TB);
  assert.equal(dj.poolView('backups', 'mirror', two).free, 1 * TB);
  // 4 TB on one PC and 1 TB on another: only 1 TB can be kept twice.
  assert.equal(dj.mirrorRoom([4 * TB, 1 * TB]), 1 * TB);
  assert.equal(dj.mirrorRoom([4 * TB]), 0);
  assert.equal(dj.poolLine(dj.poolView('backups', 'mirror', two)), 'Duplicate · 2 drives · 2 TB · 1 TB free');
  assert.equal(dj.poolLine(dj.poolView('store', 'spread', [])), 'Extended · no drive yet');
  assert.equal(dj.poolLine(dj.poolView('backups', 'mirror', [drive('A', 'D:', TB, TB)])), 'Duplicate · 1 drive · no room until a drive on another PC is added');
});

test('a mirror on one PC warns that both copies would be lost with it', () => {
  const same = dj.poolView('backups', 'mirror', [drive('HP 800', 'D:', TB, TB), drive('HP 800', 'E:', TB, TB)]);
  assert.equal(same.size, 0);
  assert.match(same.warnings.join(' '), /Both drives are in HP 800: if that PC fails, both copies are lost/);
  const one = dj.poolView('backups', 'mirror', [drive('Z820', 'D:', TB, TB)]);
  assert.match(one.warnings.join(' '), /add a drive on another PC/);
});

test('a pool warns when nearly full, when a PC is off, and when backups are spread', () => {
  const full = dj.poolView('store', 'spread', [drive('Z820', 'D:', TB, 0.05 * TB)]);
  assert.match(full.warnings.join(' '), /Main model storage is nearly full/);
  const off = dj.poolView('store', 'spread', [drive('Z820', 'D:', TB, TB), drive('HP', 'D:', TB, TB, false)]);
  assert.equal(off.size, TB);
  assert.match(off.warnings.join(' '), /HP is not answering now: its drive D: is left out/);
  const spread = dj.poolView('backups', 'spread', [drive('A', 'D:', TB, TB), drive('B', 'D:', TB, TB)]);
  assert.match(spread.warnings.join(' '), /Extended keeps each backup once/);
});

test('a linked PC gives a drive a job only with that PC owner\'s tick for it', () => {
  assert.equal(dj.jobRefused(['store'], { receive: true, backup: false }, 'Z820'), '');
  assert.match(dj.jobRefused(['backups'], { receive: true, backup: false }, 'Z820'), /"Enable backups"/);
  assert.match(dj.jobRefused(['store'], { receive: false, backup: true }, 'Z820'), /"Accept models from linked PCs"/);
  assert.equal(dj.jobRefused([], { receive: false, backup: false }, 'Z820'), '');
});

test('a hello\'s drives carry their jobs; the door is refused to a guest', () => {
  assert.deepEqual(cleanDrives([{ drive: 'd:', label: 'Big', total: 100, free: 50, jobs: ['store', 'bad'] }]), [{ drive: 'D:', label: 'Big', total: 100, free: 50, jobs: ['store'] }]);
  assert.ok(HOST_ONLY_DOORS.includes('/worker/drive-jobs'));
  const node = readFileSync(join(ROOT, 'src', 'jobrun', 'node.ts'), 'utf8');
  assert.match(node, /if \(p === '\/worker\/drive-jobs'\)/);
  assert.match(node, /jobRefused\(jobs\.filter\(j => !had\.includes\(j\)\)/);
  const routes = readFileSync(join(ROOT, 'src', 'jobrun.ts'), 'utf8');
  assert.match(routes, /'\/api\/network\/storage'/);
  assert.match(routes, /'\/api\/network\/drive-jobs'/);
  assert.match(routes, /'\/api\/network\/pool'/);
});

test('the Network map is an overview: no drives or pools on it (they are on the Storage page)', () => {
  const js = readFileSync(join(ROOT, 'public', 'netmap.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
  assert.doesNotMatch(html, /id="net-pools"/);
  assert.doesNotMatch(js, /netDrives|drawNetPools|NET_JOB_CHOICES/);
  assert.doesNotMatch(css, /\.net-drives? \{|\.net-pool/);
  // The jobs and pools are set on the Storage page instead.
  const storage = readFileSync(join(ROOT, 'public', 'storage.js'), 'utf8');
  assert.match(storage, /ask\('\/api\/network\/drive-jobs', \{ pc, drive, jobs \}\)/);
  assert.match(storage, /ask\('\/api\/network\/pool', \{ pool: t\.job, mode: m\.mode \}\)/);
  // Under the PCs: an arrow to Model backups | Project backups, half a row each, each with Add (Storage, that tile's picker).
  assert.match(js, /const NET_STORES = \[\{ job: 'store', name: 'Model backups' \}, \{ job: 'backups', name: 'Project backups' \}\];/);
  assert.match(js, /netMapLink\('keeps its files in', !stores\.some\(s => s\.n\)\),\n\s+el\('div', \{ class: 'net-map-row net-stores' \}, \.\.\.stores\.map\(s => s\.box\)\)/);
  assert.match(js, /netMapBtn\('Add', \(\) => app\.openStorage\?\.\(\{ add: t\.job \}\), !n\)/);
  assert.match(css, /\.net-stores > \.net-store \{ width: calc\(50% - 5px\); \}/);
  assert.match(storage, /st\.adding = tileOf\(add\) \? add : '';/);
  // Main model storage's (!): downloads can be queued straight into it, each PC fetching its own copy.
  assert.match(storage, /note: 'You can queue models to download directly, and it will download by itself even if all other PCs are off\.'/);
  assert.match(storage, /class: 'storage-i', type: 'button', text: '!', title: t\.note/);
});
