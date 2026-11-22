// The deep audit of 23 Nov 2026 (2.1.14): one test per finding, each failing before its fix. TOM-007 (three stale
// tests: fastupdate, loadeta, settingslook) is covered by those tests passing again.
// Run: node --test test/audit-2026-11-23.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardwareChanges, gpusFrom } from '../src/hardware.ts';
import { storeSpots } from '../src/jobrun/downloads.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const GB = 2 ** 30;

// TOM-001: "Scan for hardware changes" believed a reading where PowerShell and nvidia-smi timed out (a busy PC): it wiped
// the cards and the NVIDIA driver from the running record, and said the card was taken out.
const good = {
  cpuName: 'Intel(R) Core(TM) i7-6700K CPU @ 4.00GHz', cores: 4, threads: 8, ram: 48 * GB,
  nvidiaDriver: '581.57',
  gpus: [{ name: 'Quadro P2000', vendor: 'nvidia' as const, total: 5 * GB, integrated: false, cc: 6.1 }],
};

test('TOM-001 a reading where PowerShell and nvidia-smi both timed out is not reported as the card being removed', () => {
  const failed = { ...good, nvidiaDriver: null, gpus: gpusFrom('', [], [], []) };
  const said = hardwareChanges(good, failed);
  assert.deepEqual(said, [], `the scan would tell the owner: ${said.join('; ')}`);
  // nvidia-smi alone timing out: the cards are still listed by Windows, the driver is not read.
  assert.deepEqual(hardwareChanges(good, { ...good, gpus: [...good.gpus], nvidiaDriver: null }), []);
});

test('TOM-001 rescanHardware keeps a good record over a reading that lost the cards or the driver, and lastCim is kept', () => {
  const core = read('src/server/core.ts');
  const body = core.slice(core.indexOf('export async function rescanHardware'), core.indexOf('export const sampler'));
  assert.ok(body.length > 50, 'rescanHardware found');
  const before = body.slice(0, body.indexOf('Object.assign(hardware'));
  assert.match(before, /now\.gpus\.length[\s\S]*now\.gpus = was\.gpus;[\s\S]*now\.nvidiaDriver = was\.nvidiaDriver;/);
  assert.match(read('src/hardware.ts'), /if \(cim\) lastCim = cim;/);
});

// TOM-002: each Linked PC tile's status dot (.sdot, absolute) was drawn in the window's corner: .pc-tile had no position.
test('TOM-002 a linked PC tile holds its own status dot', () => {
  const css = read('public/style.css');
  const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.pc-tile[^{}\n]*)\{([^}]*)\}/g)].map(m => ({ sel: m[2].trim(), body: m[3] }));
  assert.ok(rules.some(r => r.sel === '.pc-tile' && /position:\s*relative/.test(r.body)));
});

// TOM-003: the storage rename missed one message: "...or set the Model store to Spread."
test('TOM-003 the Duplicate refusal names switches the page has', () => {
  const said = storeSpots('mirror', [{ pc: 'a', pcName: 'This PC', drive: 'D:', free: 500 * GB }, { pc: 'a', pcName: 'This PC', drive: 'E:', free: 500 * GB }] as never, 10 * GB);
  assert.equal(typeof said, 'string');
  assert.doesNotMatch(String(said), /Model store|Spread|Mirror/);
  assert.match(String(said), /Main model storage to Extended/);
});

// TOM-004: "This PC · This PC" on Network Storage; "My PC / This PC / This PC" on the Cluster page.
test('TOM-004 this PC is not called "This PC" twice', () => {
  const js = read('public/storage.js');
  const line = js.slice(js.indexOf('const pcState = p =>'), js.indexOf('\n', js.indexOf('const pcState = p =>')));
  assert.ok(line.length > 20, 'pcState found');
  assert.doesNotMatch(line, /p\.here \? 'This PC'/);
  assert.match(js, /el\('b', \{ text: p\.name \}\), p\.here \? null : el\('span'/);
  const home = read('public/home.js');
  const host = home.slice(home.indexOf("const host = el('div'"), home.indexOf('const joins = '));
  assert.equal(host.match(/'This PC'/g)?.length, 1, 'the tag only');
});

// TOM-005: "it frees that drive" and "Move them to C:" were said when the old folder was on the same drive.
test('TOM-005 "frees that drive" is said only when the old folder is on another drive', () => {
  const js = read('public/storage.js');
  const at = js.indexOf('it frees that drive');
  assert.ok(at > 0, 'the sentence is there');
  const fn = js.slice(js.indexOf('function drawMove()'), js.indexOf('function draw()'));
  assert.match(fn, /const otherDrive = [^;]*from[^;]*slice\(0, 2\)[^;]*w\.drive/);
  assert.match(fn, /otherDrive \? '; it frees that drive' : ''/);
  assert.match(fn, /otherDrive \? `Move them to \$\{w\.drive\}` : 'Move them to the new folder'/);
});

// TOM-006: the guest pass sync lines used the bare name, so two PCs both called "Worker PC" could not be told apart.
test('TOM-006 the guest pass sync lines tell two PCs of the same name apart', () => {
  const js = read('public/home.js');
  const at = js.indexOf("$('#node-pass-sync').replaceChildren(");
  assert.ok(at > 0, 'the sync lines are drawn here');
  const line = js.slice(at, js.indexOf('\n', at));
  assert.doesNotMatch(line, /text: `\$\{p\.name\} \$\{words\(p\)\}/);
  assert.match(line, /app\.pcLabel\(p\.id\)/);
});
