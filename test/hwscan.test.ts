// Network's "Scan for hardware changes" and "Push updates to network" (the top of the page).
// Run: node --test test/hwscan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardwareChanges, type HardwareInfo } from '../src/hardware.ts';
import { HOST_ONLY_DOORS } from '../src/guestpass.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
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
  assert.match(core, /const now = await readHardware\(\);[\s\S]{0,400}?Object\.assign\(hardware, now\);\n\s+return hardwareChanges\(was, now\);/);
  const node = read('src/jobrun/node.ts');
  assert.match(node, /if \(p === '\/worker\/hardware-rescan'\) \{\n\s+const changes = d\.rescanHardware \? await d\.rescanHardware\(\) : \[\];/);
  assert.equal(node.match(/'models-where', 'cache-set', 'hardware-rescan'\]/g)?.length, 2, 'said in both hellos');
  assert.ok(HOST_ONLY_DOORS.includes('/worker/hardware-rescan'));
  const scan = read('src/jobrun/hwscan.ts');
  assert.match(scan, /if \(!h\.can\.includes\('hardware-rescan'\)\) return `"\$\{name\}": runs an older TOMLIN, which reads its hardware only when it starts: update it, then scan again\.`;/);
  assert.match(scan, /filter\(r => r\.role !== 'guest'\)/);
  assert.match(read('src/jobrun.ts'), /case '\/api\/network\/hardware-scan': reply\(await hardwareScan\(\)\); return true;/);
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
