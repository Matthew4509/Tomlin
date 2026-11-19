// The PC windows and the model list, as a walk of the installed copy found them: a PC that is off, Escape in a model's
// menu, a PC with two cards, one state in two places, two PCs with one name, a model found twice, a split model.
// Run: node --test test/pcwindows.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strongestFirst } from '../src/hardware.ts';
import { cardFix, cardList } from '../src/pccards.ts';
import { pcLook } from '../src/home.ts';
import { cleanComputer, pcLabels } from '../src/brains.ts';
import { listModels, plainModelName, splitPart } from '../src/llama.ts';
import { incompleteWords, onShow, sameFiles, type ModelEntry } from '../src/models.ts';
import { bitsPerWeight, sizeB } from '../src/staff.ts';

const GB = 2 ** 30;
const pcs = readFileSync(new URL('../public/pcs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const team = readFileSync(new URL('../public/team.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const costs = readFileSync(new URL('../src/server/costs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ---- 4: the strongest card first ----

test('a PC with an old card in the first slot and an NVIDIA card in the second: the NVIDIA card comes first', () => {
  const gpus = [
    { name: 'ATI FirePro V (FireGL V) Graphics Adapter', vendor: 'amd', total: 2 * GB, integrated: false },
    { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', total: 12 * GB, integrated: false },
  ];
  assert.deepEqual(strongestFirst(gpus).map(g => g.name), ['NVIDIA GeForce RTX 3060', 'ATI FirePro V (FireGL V) Graphics Adapter']);
  // A chip in the processor last; between two of a make, the most memory first.
  const mixed = [
    { name: 'Intel UHD 630', vendor: 'intel', total: null, integrated: true },
    { name: 'Radeon small', vendor: 'amd', total: 4 * GB, integrated: false },
    { name: 'Radeon big', vendor: 'amd', total: 16 * GB, integrated: false },
  ];
  assert.deepEqual(strongestFirst(mixed).map(g => g.name), ['Radeon big', 'Radeon small', 'Intel UHD 630']);
  assert.equal(gpus[0].vendor, 'amd', 'the list given is not changed');
});

test('an older PC that named its old card: the NVIDIA card is worked out from the cards together', () => {
  const old = { ram: { total: 64 * GB, used: 10 * GB }, gpu: { name: 'ATI FirePro V (FireGL V) Graphics Adapter', total: 2 * GB, used: GB, shared: false }, cards: { count: 2, total: 14 * GB } };
  const fixed = cardFix(old, { nvidia: true, last: null }) as typeof old & { gpu: { guessed?: boolean } };
  assert.equal(fixed.gpu.total, 12 * GB);
  assert.equal(fixed.gpu.name, 'NVIDIA card');
  assert.equal(fixed.gpu.guessed, true);
  assert.deepEqual(cardList(fixed).map(c => c.total), [12 * GB, 2 * GB], 'both cards, the one used first on top');
  // Its runner's own line names the card when it has started a model there.
  const named = cardFix(old, { nvidia: true, last: { lines: ['ggml_cuda_init: found 1 CUDA devices:', '  Device 0: NVIDIA GeForce RTX 3060, compute capability 8.6, VMM: yes'] } }) as typeof old;
  assert.equal(named.gpu!.name, 'NVIDIA GeForce RTX 3060');
});

test('a PC that lists its cards, one with no NVIDIA card, or one card only: as it came', () => {
  const listed = { gpu: { name: 'RTX 3060', total: 12 * GB }, cards: { count: 2, total: 14 * GB, list: [{ name: 'RTX 3060', total: 12 * GB }, { name: 'FirePro', total: 2 * GB }] } };
  assert.deepEqual(cardFix(listed, { nvidia: true }), listed, 'a good list comes through as it is');
  // A stray entry in the list, or too many, never reaches the window: the list passed on is the cleaned one.
  const odd = { gpu: { name: 'RTX', total: 1 }, cards: { count: 2, list: [{ name: 'RTX', total: 1 }, null, { name: 7 }, ...Array.from({ length: 20 }, () => ({ name: 'X', total: 1 }))] } };
  const cleaned = cardFix(odd, { nvidia: true }) as { cards: { count: number; list: unknown[] } };
  assert.equal(cleaned.cards.list.length, 6, 'of the first 8 entries, the 6 with a name and a size');
  assert.ok(cleaned.cards.list.every(c => c !== null && typeof (c as { name: unknown }).name === 'string'));
  assert.equal(cleaned.cards.count, 2, 'the rest of the memory as it came');
  const amdOnly = { gpu: { name: 'Radeon', total: 8 * GB }, cards: { count: 2, total: 16 * GB } };
  assert.equal(cardFix(amdOnly, { nvidia: false }), amdOnly);
  const one = { gpu: { name: 'FirePro', total: 2 * GB }, cards: { count: 1, total: 2 * GB } };
  assert.equal(cardFix(one, { nvidia: true }), one);
  assert.equal(cardFix(null, { nvidia: true }), null);
});

test('the window lists each card and says which one is used first', () => {
  assert.match(pcs, /rows\.push\(\['Graphics cards', cards\.map\(\(c, i\) => `\$\{c\.name\}, \$\{GBs\(c\.total\)\}\$\{i \? '' : ' \(used first\)'\}`\)/);
});

// ---- 5: one state, the same word in the left panel and the window ----

test('a PC that answers with nothing loaded is Asleep in both places; one that does not answer is Offline', () => {
  assert.deepEqual(pcLook({ ok: true, model: null }), { state: 'asleep', text: 'Asleep: no model loaded', activity: 'available', word: 'Asleep' });
  assert.equal(pcLook({ ok: true, model: 'Qwen3.5-2B' }).word, 'Available');
  assert.equal(pcLook({ ok: false }).word, 'Offline');
  assert.equal(pcLook({ ok: true, model: null, away: '2026-01-02T03:04:05Z' }).word, 'In use by its owner');
  assert.equal(pcLook({ ok: true, model: null, backupsOnly: true }).word, 'Available', 'a Backups only PC is not called asleep');
});

test('the left panel and the window both show the server\'s word', () => {
  // A PC held by the cluster (switched on) says so; otherwise the server's word, as before.
  assert.match(home, /p\.word \?\? \(asleep \? 'Asleep' : undefined\)/);
  assert.match(pcs, /text: look\.word/);
  assert.match(costs, /pcLook\(\{ ok: !!h, model: h\?\.model/);
});

// ---- 2: a PC that is off ----

test('a PC that does not answer: plain words, never the network\'s own error', () => {
  assert.match(costs, /fault = answered \? `It answered but said: [^`]+` : NOT_ANSWERING;/);
  assert.doesNotMatch(costs, /not reachable on your network \(\$\{said\}\)/);
  // Its version line says the plain words; nothing adds "Did not answer just now: <error>".
  assert.doesNotMatch(pcs, /Did not answer just now: \$\{v\.fault/);
});

test('the window is titled with that PC\'s name at once and drawn from what it said last before it is asked', () => {
  const open = /app\.openPc = id => \{[\s\S]*?\n  \};/.exec(pcs)?.[0] ?? '';
  assert.match(open, /\$\('#pc-title'\)\.textContent = app\.pcLabel\?\.\(id \|\| 'here'\)/);
  assert.ok(open.indexOf("textContent = app.pcLabel") < open.indexOf("'Reading…'"), 'the title is set before Reading…');
  assert.match(open, /load\(id \|\| 'here', true\)/);
  assert.match(pcs, /&quick=1/);
  assert.match(costs, /'\/api\/pc': async \(\{ res, url \}\) => \{\n    const r = await pcView\(url\.searchParams\.get\('id'\) \?\? 'here', url\.searchParams\.get\('quick'\) === '1'\);/);
  // Its usage log and its hello are asked at once: one wait of 3 s for a PC that is off, not two.
  assert.match(costs, /await Promise\.all\(\[\n    jobRoutes\.syncUsage\(r!, 3000\)/);
});

// ---- 3: Escape in a model's menu ----

test('Escape with a model\'s menu open closes the menu only; the bin has a label', () => {
  assert.match(pcs, /dlg\.addEventListener\('keydown', e => \{\n    const menu = e\.key === 'Escape' \? openMenu\(\) : null;\n    if \(!menu\) return;\n    e\.preventDefault\(\);\n    e\.stopPropagation\(\);/);
  assert.match(pcs, /dlg\.addEventListener\('cancel', e => \{\n    const menu = openMenu\(\);\n    if \(!menu\) return;\n    e\.preventDefault\(\);/);
  assert.equal((pcs.match(/svgIcon\(BIN, 18\), el\('span', \{ text: 'Delete' \}\)/g) ?? []).length, 2, 'both bins, this PC\'s and a linked PC\'s');
});

// ---- 16: two PCs with one name ----

test('two linked PCs with one name are told apart by the computer\'s own name, else their address', () => {
  const a = { id: 'aa11bb22', name: 'Worker PC', url: 'http://192.168.50.21:8741', computer: 'STUDY-TOWER' };
  const b = { id: 'cc33dd44', name: 'Worker PC', url: 'http://192.168.50.22:8741', computer: 'GARAGE-BOX' };
  const c = { id: 'ee55ff66', name: 'Laptop', url: 'http://192.168.50.23:8741' };
  assert.deepEqual(pcLabels([a, b, c]), { aa11bb22: 'Worker PC (STUDY-TOWER)', cc33dd44: 'Worker PC (GARAGE-BOX)', ee55ff66: 'Laptop' });
  // An older TOMLIN does not say its computer's name: the address.
  assert.deepEqual(pcLabels([{ ...a, computer: undefined }, b]), { aa11bb22: 'Worker PC (192.168.50.21)', cc33dd44: 'Worker PC (GARAGE-BOX)' });
  // The same computer name on both says nothing: the address.
  assert.equal(pcLabels([a, { ...b, computer: 'study-tower' }]).aa11bb22, 'Worker PC (192.168.50.21)');
  assert.equal(cleanComputer('<b>DESK-01</b>'), 'bDESK-01b');
  assert.equal(cleanComputer(42), '');
});

test('All staff groups by the PC\'s id, so two PCs with one name are two groups', () => {
  const draw = /function teamDraw\(\) \{[\s\S]*?\n\}/.exec(team)?.[0] ?? '';
  assert.match(draw, /new Map\(\[\['', \[\]\], \.\.\.linked\.map\(p => \[p\.id, \[\]\]\)\]\)/);
  assert.match(draw, /app\.pcLabel\?\.\(p\.id\)/);
  assert.doesNotMatch(draw, /linked\.find\(p => p\.name === pc\)/);
});

test('a PC just linked is asked for a name, its own or the computer\'s offered', () => {
  assert.match(home, /if \(r\?\.linked\) askPcName\(fault, r\.linked\);/);
  assert.match(home, /api\('\/api\/pc\/profile', \{ id: pc\.id, name \}\)/);
  const linking = readFileSync(new URL('../src/jobrun/linking.ts', import.meta.url), 'utf8');
  assert.match(linking, /return \{ status: 200, body: \{ \.\.\.\(await setup\(\)\), linked \} \};/);
});

// ---- 9: a split model ----

/** A folder of fake model files (sizes in bytes; contents do not matter here). */
function folder(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-split-'));
  for (const [name, size] of Object.entries(files)) {
    mkdirSync(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...name.split('/')), Buffer.alloc(size));
  }
  return dir;
}

test('a split model is one entry, under its first part, with the size of all its parts', () => {
  const dir = folder({ 'Big-Model-Q4_K_M-00001-of-00003.gguf': 300, 'Big-Model-Q4_K_M-00002-of-00003.gguf': 300, 'Big-Model-Q4_K_M-00003-of-00003.gguf': 100, 'small.gguf': 50 });
  try {
    const got = listModels(dir);
    assert.deepEqual(got, [{ file: 'small.gguf', bytes: 50 }, { file: 'Big-Model-Q4_K_M-00001-of-00003.gguf', bytes: 700, parts: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a split model with a part missing is listed as incomplete (and with its first part missing too)', () => {
  const dir = folder({ 'A-00001-of-00004.gguf': 10, 'A-00002-of-00004.gguf': 10, 'A-00004-of-00004.gguf': 10, 'sub/B-00002-of-00002.gguf': 7 });
  try {
    const got = listModels(dir).sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual(got, [{ file: 'A-00001-of-00004.gguf', bytes: 30, parts: 4, missing: [3] }, { file: 'sub/B-00002-of-00002.gguf', bytes: 7, parts: 2, missing: [1] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(incompleteWords('A', { parts: 4, missing: [3] }), 'A is not complete: part 3 of 4 is missing, so it cannot be loaded. Download it again, or copy the missing part into the same folder.');
  assert.match(incompleteWords('A', { parts: 4, missing: [2, 3] }), /parts 2 and 3 of 4 are missing/);
  assert.equal(incompleteWords('A', { parts: 4 }), '');
});

test('a split model shows under its plain name, and its size guess is not thrown by the part numbers', () => {
  assert.equal(plainModelName('folder/GLM-4.5-Air-UD-Q4_K_XL-00001-of-00002.gguf'), 'GLM-4.5-Air-UD-Q4_K_XL');
  assert.deepEqual(splitPart('X-00002-of-00004.gguf'), { base: 'X', part: 2, of: 4 });
  assert.equal(splitPart('X.gguf'), null);
  // The size from the name when it says; else from all its bytes at its quantisation's bits.
  assert.equal(sizeB('Qwen3-235B-A22B-Q4_K_M-00001-of-00003', 140 * GB), 235);
  assert.equal(bitsPerWeight('Some-Model-UD-Q2_K_XL-00001-of-00002'), 2.7);
  assert.equal(bitsPerWeight('Some-Model-Q8_0'), 8.5);
  assert.equal(bitsPerWeight('Some-Model-BF16'), 16);
  assert.equal(bitsPerWeight('Some-Model'), null);
  // 85 GB at Q8 is about 86B, not the 141B a Q4 guess gave.
  assert.equal(Math.round(sizeB('Some-Model-Q8_0-00001-of-00002', 85 * GB)), 86);
  // No quantisation in the name: about 0.6 GB a billion, as before.
  assert.equal(sizeB('Some-Model', 6 * GB), 10);
});

test('an incomplete model is refused when loaded, with the plain words', () => {
  const panes = readFileSync(new URL('../src/server/panes.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(panes, /const incomplete = incompleteWords\(name, entry\);\n  if \(incomplete\) return \{ error: incomplete \};/);
});

// ---- 8: the same model found twice ----

const entry = (id: string, file: string, bytes: number, where: ModelEntry['where']): ModelEntry => ({ id, file, bytes, where });

test('the same file in two folders is one row; a hire on either one sees theirs', () => {
  const list = [entry('Qwen3.5-2B-Q4_K_M.gguf', 'Qwen3.5-2B-Q4_K_M.gguf', 1300, 'own'), entry('*/Qwen3.5-2B-Q4_K_M.gguf', 'Qwen3.5-2B-Q4_K_M.gguf', 1300, 'other'), entry('*/other.gguf', 'other.gguf', 99, 'other'), entry('ollama:qwen', 'qwen', 1300, 'ollama')];
  const twins = sameFiles(list);
  assert.deepEqual(twins.get('*/Qwen3.5-2B-Q4_K_M.gguf'), { keep: 'Qwen3.5-2B-Q4_K_M.gguf', ids: ['Qwen3.5-2B-Q4_K_M.gguf', '*/Qwen3.5-2B-Q4_K_M.gguf'] });
  assert.equal(twins.has('*/other.gguf'), false);
  assert.equal(twins.has('ollama:qwen'), false);
  assert.deepEqual(list.filter(m => onShow(m.id, twins)).map(m => m.id), ['Qwen3.5-2B-Q4_K_M.gguf', '*/other.gguf', 'ollama:qwen']);
  // A hire given the other folder's copy sees that one, not both.
  assert.deepEqual(list.filter(m => onShow(m.id, twins, ['*/Qwen3.5-2B-Q4_K_M.gguf'])).map(m => m.id), ['*/Qwen3.5-2B-Q4_K_M.gguf', '*/other.gguf', 'ollama:qwen']);
  // The one loaded is the one kept on show.
  assert.equal(sameFiles(list, ids => ids.find(id => id.startsWith('*/'))).get('Qwen3.5-2B-Q4_K_M.gguf')!.keep, '*/Qwen3.5-2B-Q4_K_M.gguf');
  // Two files of one name but different sizes are two models.
  assert.equal(sameFiles([entry('a/x.gguf', 'a/x.gguf', 1, 'own'), entry('*/x.gguf', 'x.gguf', 2, 'other')]).size, 0);
});

test('the row says where the copies are', async () => {
  const { copiesWords } = await import('../src/models.ts');
  assert.equal(copiesWords(['Qwen3.5-2B-Q4_K_M.gguf', '*/Qwen3.5-2B-Q4_K_M.gguf'], 'Qwen3.5-2B-Q4_K_M.gguf', 'D:\\Shared models'), "2 copies: in TOMLIN's models folder and in D:\\Shared models. Delete removes the one in TOMLIN's models folder.");
  assert.equal(copiesWords(['one.gguf'], 'one.gguf', null), '');
  assert.match(pcs, /x\.copiesNote \? el\('p', \{ class: 'hint pc-model-staff', text: x\.copiesNote \}\)/);
});

test('Open sharing and cluster permissions: the ticks are found after Network is drawn, and while this PC is not a node it says why', () => {
  const js = readFileSync(join(import.meta.dirname, '..', 'public', 'home.js'), 'utf8');
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  const from = js.indexOf('app.openSharePermissions = async () => {');
  assert.ok(from > 0, 'the handler is found');
  const handler = js.slice(from, js.indexOf('\n};', from));
  // One place, opened from Network, This PC, and Manage PC and updates.
  assert.ok(js.includes("for (const b of document.querySelectorAll('[data-perms-open]')) b.addEventListener('click', () => app.openSharePermissions());"));
  // Network no longer has its own button: its Sharing page is the ticks themselves.
  assert.equal((html.match(/data-perms-open/g) ?? []).length, 1, 'a button on This PC');
  assert.ok(readFileSync(join(import.meta.dirname, '..', 'public', 'pcs.js'), 'utf8').includes("text: 'Sharing and cluster permissions', onclick: () => { dlg.close(); app.openSharePermissions?.(); }"), 'and in Manage PC and updates');
  // Not under the Permissions page's name: mute.js, loaded after home.js, sets app.openPermissions to that page, and
  // these buttons opened it instead of the ticks.
  assert.doesNotMatch(js, /app\.openPermissions = /);
  assert.match(readFileSync(join(import.meta.dirname, '..', 'public', 'mute.js'), 'utf8'), /app\.openPermissions = openPermissions;/);
  assert.ok(handler.indexOf('await refreshNodes()') < handler.indexOf("closest('[hidden]')"), 'drawn first, then looked for');
  assert.match(handler, /Turn it on to set them/);
  assert.match(js, /if \(sh\.on\) \$\('#node-allow-why'\)\.hidden = true;/);
  // The line sits beside the switch, outside Setup (which is hidden while the PC is not a node).
  assert.ok(html.indexOf('id="node-allow-why"') < html.indexOf('id="node-setup"'));
});
