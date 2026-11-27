// Each PC's downloads list (src/dlqueue.ts, src/server/hf.ts), every PC's list in one window (src/jobrun/downloads.ts,
// public/dlchip.js), and the Model store filled from the Models page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as DQ from '../src/dlqueue.ts';
import { storeSpots } from '../src/jobrun/downloads.ts';
import { HOST_ONLY_DOORS } from '../src/guestpass.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const GB = 2 ** 30;
const SHA = 'a'.repeat(64);
const item = (id: string, over: Partial<DQ.DlItem> = {}): DQ.DlItem => ({
  id, repo: 'Qwen/Qwen3-8B-GGUF', rev: 'abc', name: `Qwen3-8B-${id}`, bytes: 10 * GB, files: [{ path: `Qwen3-8B-${id}.gguf`, bytes: 10 * GB, sha256: SHA }],
  to: 'models', drive: '', state: 'waiting', got: 0, error: '', added: `2026-11-20T10:00:0${id.length}Z`, by: 'This PC', ...over,
});

test('a saved list keeps good lines only: a file path cannot leave the model folder, a store line needs its drive', () => {
  const good = item('a');
  assert.deepEqual(DQ.cleanList([good]), [good]);
  assert.deepEqual(DQ.cleanList([{ ...good, files: [{ path: '..\\..\\Windows\\x.gguf', bytes: 1, sha256: SHA }] }]), []);
  assert.deepEqual(DQ.cleanList([{ ...good, files: [{ path: 'C:\\x.gguf', bytes: 1, sha256: SHA }] }]), []);
  assert.deepEqual(DQ.cleanList([{ ...good, files: [{ path: 'x.gguf', bytes: 1, sha256: 'nothex' }] }]), []);
  assert.deepEqual(DQ.cleanList([{ ...good, to: 'store', drive: '' }]), []);
  assert.equal(DQ.cleanList([{ ...good, to: 'store', drive: 'e:' }])[0].drive, 'E:');
  assert.deepEqual(DQ.cleanList('nope'), []);
});

test('one at a time, in the order added; after a restart the one that was running is first again', () => {
  const list = [item('a', { state: 'done' }), item('b'), item('c')];
  assert.equal(DQ.nextUp(list)?.id, 'b');
  assert.equal(DQ.nextUp([item('a', { state: 'running' }), item('b')]), undefined);
  const back = DQ.afterRestart([item('a', { state: 'running', got: 5 * GB }), item('b')]);
  assert.equal(back[0].state, 'waiting');
  assert.equal(back[0].got, 5 * GB);
  assert.equal(DQ.nextUp(back)?.id, 'a');
  assert.equal(DQ.placeOf([item('a', { state: 'running' }), item('b'), item('c')], 'c'), 2);
});

test('Cancel takes a pending one out at once and has the runner stop the one running; Download again goes to the end', () => {
  const list = [item('a', { state: 'running' }), item('b'), item('c')];
  const c = DQ.cancelled(list, 'b', 'now');
  assert.equal(c.list.find(x => x.id === 'b')?.state, 'cancelled');
  assert.equal(c.stopRunning, false);
  assert.equal(DQ.cancelled(list, 'a', 'now').stopRunning, true);
  assert.equal(DQ.cancelled(list, 'zz', 'now').found, false);
  const again = DQ.again(c.list, 'b');
  assert.deepEqual(again.map(x => x.id), ['a', 'c', 'b']);
  assert.equal(again[2].state, 'waiting');
  assert.equal(DQ.again([item('d', { state: 'done' })], 'd')[0].state, 'done');
});

test('the same model to the same place is in the list once; the room still to come counts per drive', () => {
  const list = [item('a', { state: 'running', got: 4 * GB }), item('b', { to: 'store', drive: 'E:' }), item('c', { state: 'done' })];
  assert.ok(DQ.sameOpen(list, { repo: 'Qwen/Qwen3-8B-GGUF', name: 'Qwen3-8B-a', to: 'models', drive: '' }));
  assert.equal(DQ.sameOpen(list, { repo: 'Qwen/Qwen3-8B-GGUF', name: 'Qwen3-8B-c', to: 'models', drive: '' }), undefined);
  assert.equal(DQ.stillToCome(list, 'models', ''), 6 * GB);
  assert.equal(DQ.stillToCome(list, 'store', 'E:'), 10 * GB);
});

test('the list says each line as he asked: "56%" or "pending", running first, then pending, then the finished ones', () => {
  assert.equal(DQ.dlWords({ state: 'running', got: 56, bytes: 100 }), '56%');
  assert.equal(DQ.dlWords({ state: 'running', got: 100, bytes: 100 }), '99%');
  assert.equal(DQ.dlWords({ state: 'waiting', got: 0, bytes: 100 }), 'pending');
  assert.equal(DQ.whereWords({ to: 'store', drive: 'E:' }), 'Main model storage E:');
  const shown = DQ.shown([item('x', { state: 'done', ended: '1' }), item('a'), item('r', { state: 'running' }), item('y', { state: 'cancelled', ended: '2' })]);
  assert.deepEqual(shown.map(x => x.id), ['r', 'a', 'y', 'x']);
  assert.equal('files' in shown[0], false);
  const many = Array.from({ length: 30 }, (_, k) => item(`f${k}`, { state: 'done', ended: String(k).padStart(2, '0') }));
  const kept = DQ.trimmed([...many, item('w')]);
  assert.equal(kept.length, DQ.KEEP_FINISHED + 1);
  assert.ok(kept.some(x => x.id === 'w'));
});

test('the Model store: Spread takes the drive with most room; Mirror takes two drives on two different PCs', () => {
  const spots = [{ pc: 'here', pcName: 'This PC', drive: 'E:', free: 100 * GB }, { pc: 'here', pcName: 'This PC', drive: 'F:', free: 300 * GB }, { pc: 'z', pcName: 'Z820', drive: 'D:', free: 50 * GB }];
  assert.deepEqual((storeSpots('spread', spots, 20 * GB) as { drive: string }[]).map(x => x.drive), ['F:']);
  assert.deepEqual((storeSpots('mirror', spots, 20 * GB) as { pc: string; drive: string }[]).map(x => `${x.pc} ${x.drive}`), ['here F:', 'z D:']);
  assert.match(storeSpots('mirror', spots.slice(0, 2), 20 * GB) as string, /all on one PC/);
  assert.match(storeSpots('mirror', spots, 60 * GB) as string, /no two drives on two different PCs/);
  assert.match(storeSpots('spread', [], GB) as string, /no drive yet/);
  assert.match(storeSpots('spread', spots, 400 * GB) as string, /has room/);
});

test('wired in: Download adds to the list; the list runs at start; a node keeps its own and its doors are the owner\'s', () => {
  const hf = read('src', 'server', 'hf.ts');
  assert.doesNotMatch(hf, /hfJob/);
  assert.match(hf, /dlSet\(\[\.\.\.dlNow\(\), item\]\);\s*\n\s*dlPump\(\);/);
  assert.match(hf, /if \(dlRun === run\) dlRun = null;[\s\S]{0,200}dlPump\(\);/);
  assert.match(hf, /jobsHere\(\)\[drive\] \?\? \[\]\)\.includes\('store'\)/);
  assert.match(hf, /DQ\.STORE_FOLDER/);
  assert.match(read('src', 'server.ts'), /resumeDownloads\(\);/);
  const node = read('src', 'jobrun', 'node.ts');
  assert.ok(node.includes("['/worker/dl-queue', '/worker/dl-cancel', '/worker/dl-again', '/worker/dl-clear'].includes(p)"));
  assert.match(node, /'drive-jobs', 'dl-queue'(, ('[a-z-]+'|[A-Z_]+))*]/);
  for (const door of ['/worker/dl-queue', '/worker/dl-cancel', '/worker/dl-again', '/worker/dl-clear']) assert.ok(HOST_ONLY_DOORS.includes(door), door);
  const routes = read('src', 'jobrun.ts');
  for (const r of ['/api/network/downloads', '/api/network/download-line', '/api/network/store-get']) assert.ok(routes.includes(`'${r}'`), r);
  // Several downloads to one linked PC can be followed at once: they wait in that PC's list.
  assert.match(read('src', 'carry.ts'), /!\(t\.kind === 'fetch' && x\.kind === 'fetch'\)/);
});

test('the page: the chip opens the downloads window, each line its PC, file, how far, and Cancel; the Model store in To', () => {
  const chip = read('public', 'dlchip.js');
  const html = read('public', 'index.html');
  assert.match(html, /<dialog id="dl-dlg"/);
  assert.match(chip, /api\('\/api\/network\/downloads'\)/);
  assert.match(chip, /text: 'Cancel'/);
  assert.match(chip, /el\('span', \{ class: 'dl-line-pc', text: x\.pcName \}\)/);
  assert.match(chip, /dlDlg\.showModal\(\)/);
  const models = read('public', 'models.js');
  assert.match(models, /value: 'store', text: `Main model storage/);
  assert.match(models, /api\('\/api\/network\/store-get'/);
  assert.match(models, /Pending in the downloads list/);
  const css = read('public', 'style.css');
  const block = css.slice(css.indexOf('dialog.dl-dlg {'), css.indexOf('@media (max-width: 560px) { .dl-line'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(block, /font-size: (1[01]|[0-9])px/);
});

test('Downloads shows copies between PCs as lines ("Downloading to <PC>", how far, about how long), and which PCs must stay on (W2-21)', () => {
  const chip = read('public', 'dlchip.js');
  // Nothing is said to be downloading only when nothing is: a copy between PCs counts.
  assert.match(chip, /!open\.length && !dlCopies\.length \? el\('p', \{ class: 'hint', text: 'Nothing is downloading or waiting\.' \}\) : null,/);
  assert.match(chip, /text: here \? `Downloading to this PC from \$\{t\.pcName\}` : `Downloading to \$\{t\.pcName\}`/);
  assert.match(chip, /'This runs in the background\. Other PCs can be used or turned off, as long as these stay on: '/);
  assert.match(chip, /api\('\/api\/network\/stop', \{ id: t\.id \}\)/);
  // The two sums, run here on the page's own code.
  const dlGB = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);
  const body = (name: string) => chip.slice(chip.indexOf(`function ${name}(`), chip.indexOf('\n}\n', chip.indexOf(`function ${name}(`)) + 2);
  const dlLeft = new Function('Date', `${body('dlLeft')}; return dlLeft;`)({ now: () => 1_000_000 + 600_000 });
  // 10 GB of 100 GB in 10 minutes: 90 GB more at the same speed is 90 minutes, said in hours past 90 minutes.
  assert.equal(dlLeft({ started: 1_000_000, done: 10 * 2 ** 30, bytes: 100 * 2 ** 30 }), 'about 1.5 h left');
  assert.equal(dlLeft({ started: 1_000_000, done: 50 * 2 ** 30, bytes: 100 * 2 ** 30 }), 'about 10 min left');
  assert.equal(dlLeft({ started: 1_000_000, done: 0, bytes: 100 }), '');
  void dlGB;
  const stay = new Function('dlCopies', `const DL_WHY = { backup: 'backup in progress', projects: 'backup in progress', restore: 'backup in progress', update: 'update in progress', pull: 'update in progress', bring: 'update in progress' };
    const dlWhy = t => DL_WHY[t.kind] ?? 'copy in progress'; ${body('dlStayOn')}; return dlStayOn;`);
  const f = stay([{ kind: 'copy', pcName: 'Worker PC' }, { kind: 'backup', pcName: 'Spare PC' }]);
  assert.deepEqual(f([{ pc: 'abc', pcName: 'Attic PC' }]), ['This PC (copy in progress)', 'Worker PC (copy in progress)', 'Spare PC (backup in progress)', 'Attic PC (download in progress)']);
});
