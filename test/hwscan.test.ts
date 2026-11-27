// Network's "Scan for hardware changes" and "Push updates to network" (the top of the page).
// Run: node --test test/hwscan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardwareChanges, type HardwareInfo } from '../src/hardware.ts';
import { HOST_ONLY_DOORS } from '../src/guestpass.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const GB = 2 ** 30;
const base: HardwareInfo = { cpuName: 'Xeon E5-2640', cores: 6, threads: 12, ram: 64 * GB, gpus: [{ name: 'RTX 3060', vendor: 'nvidia', total: 12 * GB, integrated: false } as HardwareInfo['gpus'][number]], nvidiaDriver: '560.94' };

test('what changed is said in plain words, and nothing when nothing did', () => {
  assert.deepEqual(hardwareChanges(base, { ...base, gpus: [...base.gpus] }), []);
  assert.deepEqual(hardwareChanges(base, { ...base, ram: 256 * GB }), ['RAM 64 GB → 256 GB']);
  assert.deepEqual(hardwareChanges(base, { ...base, cpuName: 'Xeon E5-2670', cores: 16, threads: 32 }), ['processor Xeon E5-2640 → Xeon E5-2670']);
  assert.deepEqual(hardwareChanges(base, { ...base, cores: 12, threads: 24 }), ['processor 6 cores, 12 threads → 12 cores, 24 threads']);
  const two = { ...base, gpus: [...base.gpus, { name: 'RTX 3060', vendor: 'nvidia', total: 12 * GB, integrated: false } as HardwareInfo['gpus'][number]] };
  assert.deepEqual(hardwareChanges(base, two), ['graphics RTX 3060 (12 GB) → RTX 3060 (12 GB), RTX 3060 (12 GB)']);
  assert.deepEqual(hardwareChanges(base, { ...base, nvidiaDriver: '581.57' }), ['NVIDIA driver 560.94 → 581.57']);
});

test('this PC is read again in place, a linked PC through its own door (a host\'s only), an older one named as such', () => {
  const core = read('src/server/core.ts');
  assert.match(core, /const now = await readHardware\(\);[\s\S]{0,700}?Object\.assign\(hardware, now\);\n\s+return hardwareChanges\(was, now\);/);
  const node = read('src/jobrun/node.ts');
  assert.match(node, /if \(p === '\/worker\/hardware-rescan'\) \{\n\s+const changes = d\.rescanHardware \? await d\.rescanHardware\(\) : \[\];/);
  assert.equal(node.match(/'models-where', 'cache-set', 'hardware-rescan'(, ('[a-z-]+'|[A-Z_]+))*\]/g)?.length, 2, 'said in both hellos');
  assert.ok(HOST_ONLY_DOORS.includes('/worker/hardware-rescan'));
  const scan = read('src/jobrun/hwscan.ts');
  assert.match(scan, /if \(!h\.can\.includes\('hardware-rescan'\)\) return `"\$\{name\}": runs an older TOMLIN, which reads its hardware only when it starts: update it, then scan again\.`;/);
  // Every linked PC but a guest link, or (a PC's own window) only that one; this PC is read only for the whole scan.
  assert.match(scan, /filter\(r => r\.role !== 'guest' && \(!only \|\| r\.id === only\)\)/);
  assert.match(scan, /const mine = !only && d\.rescanHardware \? await d\.rescanHardware\(\) : \[\];/);
  assert.match(read('src/jobrun.ts'), /case '\/api\/network\/hardware-scan': reply\(await hardwareScan\(typeof b\.pc === 'string' \? b\.pc : ''\)\); return true;/);
});

test('Network has Scan for hardware changes left of Fast update (Linked PCs); Manage updates has Push updates to network, which runs Update all', () => {
  const html = read('public/index.html');
  const linked = html.slice(html.indexOf('<h3 id="node-linked-title">Linked PCs</h3>'), html.indexOf('<div class="set-card">', html.indexOf('id="node-linked-title"')));
  assert.match(linked, /<span class="net-linked-acts"><button class="btn" type="button" id="net-hw-scan"[^>]*>Scan for hardware changes<\/button>\s+<button class="btn primary fast-update" type="button" id="node-fast-update"/);
  const head = html.slice(html.indexOf('<h2 id="nodes-title">Network</h2>'), html.indexOf('id="net-map"'));
  assert.doesNotMatch(head, /net-hw-scan|net-push-updates/);
  const upd = html.slice(html.indexOf('id="updates-page"'), html.indexOf('id="models-page"'));
  assert.match(upd, /<h3 id="upd-network-title">Update your linked PCs<\/h3>/);
  assert.match(upd, /id="net-push-updates">Push updates to network<\/button>/);
  const home = read('public/home.js');
  assert.match(home, /\$\('#net-push-updates'\)\.addEventListener\('click', \(\) => updateAllLinked\(\)\);/);
  assert.match(home, /const r = await api\('\/api\/network\/hardware-scan', \{\}\);/);
});

test('a card swapped for another make is seen; only a missing nvidia-smi answer keeps the old reading', () => {
  const amd = { ...base, gpus: [{ name: 'Radeon RX 6600', vendor: 'amd', total: 8 * GB, integrated: false } as HardwareInfo['gpus'][number]], nvidiaDriver: null };
  assert.deepEqual(hardwareChanges(base, amd), ['graphics RTX 3060 (12 GB) → Radeon RX 6600 (8 GB)', 'NVIDIA driver 560.94 → none'], 'the NVIDIA card and its driver really went');
  assert.deepEqual(hardwareChanges(base, { ...base, gpus: [...base.gpus], nvidiaDriver: null }), [], 'the card still listed: nvidia-smi only did not answer');
  const core = read('src/server/core.ts');
  assert.match(core, /const smiUnread = !!was\.nvidiaDriver && !now\.nvidiaDriver && now\.gpus\.some\(g => g\.vendor === 'nvidia'\);/);
});

test('a scan in progress shows: the button says Scanning…, a spinning ring before the line, the label back after', () => {
  const home = read('public/home.js');
  assert.match(home, /b\.textContent = 'Scanning…';\n\s+said\.hidden = false;\n\s+said\.replaceChildren\(el\('span', \{ class: 'net-spin', 'aria-hidden': 'true' \}\), 'Reading the hardware/);
  assert.match(home, /b\.textContent = label;\n\s+b\.disabled = false;/);
  const manage = read('public/manage.js');
  assert.match(manage, /scan\.textContent = 'Scanning…';\n\s+scanSaid\.replaceChildren\(el\('span', \{ class: 'net-spin', 'aria-hidden': 'true' \}\), 'Reading the hardware/);
  assert.match(manage, /scan\.textContent = 'Scan now';\n\s+scan\.disabled = false;/);
});

test('Fast update and Update all say Updating… with a spinning ring from the press until every PC has started', () => {
  const home = read('public/home.js');
  // Every Update all button and the lines under them, while the run asks each PC and its PIN.
  assert.match(home, /function updateAllBusy\(buttons, words\) \{[\s\S]*?'net-spin'[\s\S]*?'Updating…'/);
  assert.match(home, /updateAllBusy\(busy, 'Asking the linked PCs which can update…'\)/);
  assert.match(home, /updateAllBusy\(buttons, `Starting the update on "\$\{p\.name\}"…`\)/);
  // Put back however the run ends; a refresh meanwhile leaves Updating… alone.
  assert.match(home, /\} finally \{\s*updatingAll = false;\s*busy\.forEach\(\(x, i\) => x\.replaceChildren\(\.\.\.labels\[i\]\)\);/);
  assert.match(home, /if \(updatingAll\) return;/);
  // The left panel's button is Manage, not this run: greyed out only, never relabelled.
  assert.match(home, /const busy = buttons\.filter\(x => x\.id !== 'rail-fast-update'\);/);
  const manage = read('public/manage.js');
  assert.match(manage, /up\.replaceChildren\(el\('span', \{ class: 'net-spin', 'aria-hidden': 'true' \}\), 'Updating…'\);/);
});
