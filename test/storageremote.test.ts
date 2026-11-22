// Storage on a node with no screen: the admin PC picks which of the node's drives new models go to. Only with the
// node owner's "Accept models from linked PCs" tick, only a drive letter crosses (never a folder), and the node's
// folder is that drive's "TOMLIN models" or its usual one. Read from the source, as the other door tests are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const node = read('src/jobrun/node.ts');
const route = node.slice(node.indexOf("if (p === '/worker/models-where')"), node.indexOf("if (p === '/worker/run-set')"));

test('the node: refused while its owner is using it, refused without the Accept models tick, a known drive letter only', () => {
  assert.ok(route.length > 0, 'the route is there');
  const away = route.indexOf('if (away)');
  const tick = route.indexOf('.receive)');
  const letter = route.indexOf('/^[A-Z]:$/.test(drive)');
  const set = route.indexOf('d.modelsDrive(drive)');
  assert.ok(away >= 0 && tick > away && letter > tick && set > letter, 'away, then the tick, then the drive, then the change');
  assert.match(route, /driveReportNow\(\)\.some\(x => x\.drive === drive\)/);
  // Nothing but the drive is read from the body: no folder can be named from another PC.
  assert.deepEqual([...route.matchAll(/(?<![.\w])body\.(\w+)/g)].map(m => m[1]), ['drive']);
  assert.match(route, /noted\(/, 'the owner sees it in the log');
});

test('the node says it can be asked, in both hellos', () => {
  assert.equal(node.match(/'drive-jobs', 'dl-queue', 'models-where', 'cache-set', 'hardware-rescan']/g)?.length, 2);
});

test('the node picks the drive\'s TOMLIN models folder, or its usual folder when that is on the same drive', () => {
  const mh = read('src/server/modelhome.ts');
  const fn = mh.slice(mh.indexOf('export async function chooseModelsDrive'), mh.indexOf('/** GET requests answered here'));
  assert.match(fn, /const usual = driveOf\(modelsHome\.usual\) === drive;/);
  assert.match(fn, /chooseModelsHome\(usual \? null : `\$\{drive\}\\\\TOMLIN models`\)/);
  // The same checks as this PC's own choice (moving, downloading, FAT, cannot write): one function for both.
  assert.match(mh, /'\/api\/models\/where': async \(\{ res, b \}\) => \{\r?\n\s*const a = await chooseModelsHome\(b\.dir\);/);
});

test('the admin: the button is off with the reason when the node is off, older, or its owner has not ticked Accept models', () => {
  const st = read('src/jobrun/storage.ts');
  assert.match(st, /!ok \? off : !can\.includes\('models-where'\) \? 'Runs an older TOMLIN: update it to pick its models drive from here'/);
  // Off, and answered-but-refused, are said apart: the second with the PC's own words.
  assert.match(st, /const off = answered \? `It answered but did not let this PC in: \$\{/);
  assert.match(read('public/storage.js'), /p\.answered \? 'Answered, but did not let this PC in' : 'Not answering now'\) : p\.slow \? 'On, slow to answer'/);
  assert.match(st, /allow\?\.receive !== true \? 'Its owner has not ticked "Accept models from linked PCs"'/);
  assert.match(st, /wireFor\(r\)\.ask\('\/worker\/models-where', \{ drive \}\)/);
  assert.match(read('src/jobrun.ts'), /case '\/api\/network\/models-where': reply\(await modelsWhereOn\(b\)\)/);
  const page = read('public/storage.js');
  // Where each PC runs its models from: a drive list, off with the reason (p.modelsWhy) when it cannot be set from here.
  assert.match(page, /const why = here \? '' : !p\.ok \? pcState\(p\) : p\.modelsWhy;/);
  assert.match(page, /disabled: !!why \|\| !drives\.length, title: why \|\|/);
  assert.match(page, /ask\('\/api\/network\/models-where', \{ pc: p\.id, drive: pick\.value \}\)/);
});

test('a guest never reaches it: the door is the host\'s only', async () => {
  const { HOST_ONLY_DOORS } = await import('../src/guestpass.ts');
  assert.ok(HOST_ONLY_DOORS.includes('/worker/models-where'));
});
