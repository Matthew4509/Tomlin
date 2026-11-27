// P4: a card smaller than a picture model is known to run out on is not tried first on Auto (RealVisXL on a 4 GB K1200
// sat 3 minutes at step 0, then ran out at step 2 and moved to the CPU, 26 Nov). T1: pictures on several linked PCs are
// drawn at once from the Images window, and each one still going is shown, not only the newest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('P4: RealVisXL goes straight to the CPU on Auto below 5 GB, says why, and a card asked for is still tried', () => {
  const rv = JSON.parse(read('registry/realvisxl-v5-lightning.json'));
  assert.equal(rv.cpuBelowGB, 5);
  assert.equal(rv.minVramGB, 5);
  assert.match(rv.about, /a 4 GB card runs out part-way/);
  const img = read('src/images.ts');
  // A11: the CPU only when its picture runner is here (devicesFor leaves it out otherwise), else Auto as usual.
  assert.match(img, /const cpuOnly = small && asked === 'auto' && !devices \? this\.deps\.devicesFor\('sd', 'cpu'\) : \[\];/);
  assert.match(img, /const tried = devices \?\? \(cpuOnly\.length \? cpuOnly : this\.deps\.devicesFor\('sd', asked\)\);/);
  assert.match(img, /note: note \?\? \(cpuOnly\.length && small \? small : undefined\) \?\?/);
  assert.match(read('src/server/panes.ts'), /const cpu: Device\[\] = runtimes\.installed\(engine, 'cpu'\) \? \['cpu'\] : \[\];\s*if \(asked === 'cpu'\) return cpu;/);
  assert.match(img, /if \(!card\?\.total \|\| !m\.cpuBelowGB\) return null;/);
  // Only RealVisXL has it: Z-Image Turbo and Qwen-Image 2.1 Turbo draw on a 5 GB card with part of them in RAM.
  for (const id of ['z-image-turbo', 'qwen-image-2.1-turbo', 'qwen-image-2.1', 'flux1-krea-dev', 'flux2-dev', 'qwen-image', 'dreamshaper8-lcm', 'sd15-realistic-lcm']) {
    assert.equal(JSON.parse(read(`registry/${id}.json`)).cpuBelowGB, undefined, id);
  }
});

test('T1: one picture at a time on each linked PC, several PCs at once, the others listed with their own Cancel', () => {
  const pic = read('src/server/pictures.ts');
  assert.match(pic, /const awayJobs = new Map<string, AwayJob>\(\);/);
  assert.doesNotMatch(pic, /let awayJob\b/);
  assert.doesNotMatch(pic, /The Images window is following a picture/);
  assert.match(pic, /if \(running\(awayJobs\.get\(away\.r\.id\)\)\) \{/);
  assert.match(pic, /awayJobs\.set\(away\.r\.id, job\);/);
  assert.match(pic, /export const awayBusy = \(\): string\[\] =>/);
  assert.match(pic, /const away = want \? \[\.\.\.awayJobs\.values\(\)\]\.find\(j => j\.id === want\) : undefined;/);
  // The queue waits for every PC drawing one, not only the newest.
  assert.match(read('src/server/queue.ts'), /for \(const pc of awayBusy\(\)\) busy\.add\(`pc:\$\{pc\}`\);/);
  // A13: worked out once, so the shown one and the others listed always agree.
  assert.match(read('src/server/panes.ts'), /\.\.\.\(\(job\) => \(\{ job, also: alsoDrawing\(job\?\.id \?\? null\) \}\)\)\(paneJob\(\)\),/);
  assert.match(pic, /for \(const \[pc, j\] of awayJobs\) if \(!AWAY_RUNNING\.includes\(j\.state\) && Date\.now\(\) - j\.startedAt > KEEP_DRAWING_MS \+ 3600_000\) awayJobs\.delete\(pc\);/);
  // A8: the time so far moves on, and a failed Cancel can be pressed again.
  const imgs = read('public/images.js');
  assert.match(imgs, /Math\.floor\(\(j\.elapsed \?\? 0\) \/ 5\)\]\)\);/);
  assert.match(imgs, /\.catch\(error => \{ b\.disabled = false; showFault\(fault, error\.message\); \}\);/);
  const page = read('public/images.js');
  assert.match(page, /drawAlso\(s\.panes\.image\.also\);/);
  assert.match(page, /text: `Also drawing: \$\{j\.who\} on "\$\{pc\}"`/);
  assert.match(page, /api\('\/api\/images\/cancel', \{ id: j\.id \}\)/);
  assert.match(read('public/index.html'), /<div class="net-list img-also" id="img-also" aria-live="polite" hidden><\/div>/);
});

test('A1: the Auto note names the model (the part in brackets taken off, not the whole name)', () => {
  const img = read('src/images.ts');
  const line = img.slice(img.indexOf('private smallCard('), img.indexOf('private hardwareFit('));
  assert.ok(line.includes('$' + "{m.name.replace(/\\s*\\(.*\\)$/, '')} needs a graphics card"), 'the bracketed part only');
  assert.ok(!line.includes('/s*(.*)$/'), 'not the pattern without its backslashes');
  assert.equal('RealVisXL V5.0 Lightning (SDXL, 4 steps)'.replace(/\s*\(.*\)$/, ''), 'RealVisXL V5.0 Lightning');
});

test('A2: Cancel stops only the picture it names; one that has just ended is never swapped for another still going', () => {
  const pic = read('src/server/pictures.ts');
  const c = pic.slice(pic.indexOf("'/api/images/cancel'"), pic.indexOf('};', pic.indexOf("'/api/images/cancel'")));
  assert.match(c, /const want = typeof b\.id === 'string' && b\.id \? b\.id : paneJob\(\)\?\.id \?\? null;/);
  assert.match(c, /const going = running\(away\);\s*if \(going\) away\.ac\.abort\(\);\s*return json\(res, 200, \{ ok: true, \.\.\.\(going \? \{\} : \{ ended: true \}\) \}\);/);
  assert.match(c, /if \(want && here\?\.id !== want\) return json\(res, 200, \{ ok: true, ended: true \}\);/);
  assert.ok(c.indexOf('here?.id !== want') < c.indexOf('images.post('), 'this PC\'s own picture is cancelled only when it is the one named');
});
