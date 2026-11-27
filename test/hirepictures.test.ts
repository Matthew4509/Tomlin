// Hire staff and Edit staff with picture models, as the 27 Nov walk found them: a picture hire saw no models until one
// was installed (F1), picture lists had no fit for the graphics card (F3), the HP 800's 4 GB card was offered
// Z-Image Turbo, which then drew on the processor for 68 minutes (L8), Add new lost the hire in progress (F5), a
// picture hire with no model said "Offline" (F6), Make a clip opened Edit staff once right after hiring (F15), and the
// steps went 1 then 3.
// Run: node --test test/hirepictures.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { GB, pictureFit } from '../src/calc.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const reg = (id: string) => {
  const r = JSON.parse(read(`registry/${id}.json`));
  return { bytes: r.files.reduce((n: number, f: { bytes: number }) => n + f.bytes, 0), minRamGB: r.minRamGB, minVramGB: r.minVramGB, native: r.native, cpuBelowGB: r.cpuBelowGB, steps: r.defaults?.steps };
};
const zimage = reg('z-image-turbo');

// ---- F3 and L8: the fit on the PC's graphics card ----

test('Z-Image Turbo (10 GB) on a 5 GB card: too big for this PC\'s card, it draws on the processor, about an hour a picture', () => {
  const f = pictureFit(zimage, { ram: 32 * GB, vram: 5 * GB, cores: 4 })!;
  assert.equal(f.level, 'cpu');
  assert.equal(f.word, "Too big for this PC's card");
  assert.match(f.short, /^too big for this PC's card: slow: roughly .* a picture$/);
  assert.match(f.line, /draws on the processor/);
  // The HP 800 took 68 minutes: the guess is the right size (between half an hour and two hours).
  assert.ok(f.minutes! >= 30 && f.minutes! <= 120, String(f.minutes));
});

test('the HP 800\'s 4 GB card, as a linked PC: "that PC\'s card", with the slow line', () => {
  const f = pictureFit(zimage, { ram: 16 * GB, vram: 4 * GB }, '"HP 800"')!;
  assert.equal(f.level, 'cpu');
  assert.equal(f.word, "Too big for that PC's card");
  assert.match(f.line, /the card of "HP 800" has 4\.0 GB/);
});

test('a 12 GB card fits Z-Image Turbo; a model that overfills a card it is made for is tight; too little RAM is not enough memory', () => {
  assert.equal(pictureFit(zimage, { ram: 32 * GB, vram: 12 * GB })!.level, 'ok');
  assert.equal(pictureFit(reg('qwen-image-2.1'), { ram: 32 * GB, vram: 5 * GB })!.level, 'tight');
  assert.equal(pictureFit(reg('qwen-image-2.1'), { ram: 32 * GB, vram: 5 * GB })!.short, 'tight');
  assert.equal(pictureFit(zimage, { ram: 8 * GB, vram: 12 * GB })!.level, 'no');
  // A 16 GB PC reports a little under 16: it is not refused a 16 GB model.
  assert.equal(pictureFit(zimage, { ram: 15.8 * GB, vram: 12 * GB })!.level, 'ok');
  // DreamShaper on a PC with no card: fine, but it says it draws on the processor and about how long.
  const ds = pictureFit(reg('dreamshaper8-lcm'), { ram: 8 * GB, vram: 0, cores: 2 })!;
  assert.equal(ds.level, 'ok');
  assert.match(ds.line, /processor, roughly 3 min a picture/);
  // RealVisXL below its cpuBelowGB card draws on the processor from the start.
  assert.equal(pictureFit(reg('realvisxl-v5-lightning'), { ram: 16 * GB, vram: 4 * GB })!.level, 'cpu');
  assert.equal(pictureFit(zimage, { ram: 0, vram: 0 }), null);
});

// ---- The page: Hire staff's picture cards, the steps, Add new, Edit staff's list, the Images window's list ----

const hire = read('public/hire.js');
const team = read('public/team.js');
const app = read('public/app.js');
const home = read('public/home.js');
const grab = (src: string, re: RegExp) => {
  const m = re.exec(src);
  assert.ok(m, String(re));
  return m[0];
};
const GBs = 'const GBs = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;';
const run = <T>(code: string, expr: string, extra: Record<string, unknown> = {}): T => {
  const box: Record<string, unknown> = { out: null, ...extra };
  runInNewContext(`${code}\nout = ${expr};`, box);
  return box.out as T;
};
const pictureCard = (c: Record<string, unknown>) => run<{ missing: boolean; state: string; size: string; licence: string; fit: { warn: boolean; text: string } }>(`${GBs}\n${grab(hire, /  function pictureWords\(c\) \{[\s\S]*?\n  \}\n/)}`, 'pictureWords(c)', { c });
const onFive = pictureFit(zimage, { ram: 32 * GB, vram: 5 * GB, cores: 4 });

test('F1, F3, L8: a picture card in Hire staff says its size, its licence, whether it is here, and that it is too big for the card and slow', () => {
  const z = pictureCard({ id: 'z-image-turbo', label: 'Z-Image Turbo', pc: '', bytes: zimage.bytes, here: false, licence: 'Apache-2.0 (model and text encoder; commercial use allowed).', nonCommercial: false, cardFit: onFive });
  assert.equal(z.missing, true);
  assert.equal(z.state, 'Not downloaded');
  assert.equal(z.size, 'file 10 GB');
  assert.equal(z.licence, 'Licence: Apache-2.0');
  assert.equal(z.fit.warn, true);
  assert.match(z.fit.text, /^⚠ Too big for this PC's card · .*draws on the processor: slow: roughly .* a picture\.$/);
  const flux = pictureCard({ id: 'flux2-dev', label: 'FLUX.2 dev', pc: '', bytes: 39 * GB, here: true, licence: 'FLUX non-commercial', nonCommercial: true, cardFit: pictureFit(reg('flux2-dev'), { ram: 128 * GB, vram: 48 * GB }) });
  assert.equal(flux.state, 'Installed');
  assert.match(flux.licence, /not for paid work/);
  assert.equal(flux.fit.warn, false);
  assert.match(flux.fit.text, /^Fits · /);
});

test('F1: a picture hire\'s cards are drawn by pictureWords, with Get it for one not downloaded, which cannot be picked', () => {
  const card = grab(hire, /  function pictureCard\(c\) \{[\s\S]*?\n  \}\n/);
  assert.match(card, /disabled: w\.missing/);
  assert.match(card, /Get it on the Models page/);
  assert.match(hire, /if \(kind\(\) === 'image'\) return pictureCard\(c\);/);
  // The style samples are for the models here.
  assert.match(grab(hire, /  function drawStyles\(\) \{[\s\S]*?\n  \}\n/), /offered\(hs\.pc\)\.filter\(c => c\.here !== false\)/);
});

test('the steps are numbered 1, 2, 3 with a PC to assign, and 1, 2 without one (it went 1 then 3)', () => {
  const steps = (pcs: boolean) => run<{ pcs: string; models: string }>(grab(hire, /  const stepNumbers = .*\n/), `stepNumbers(${pcs})`);
  assert.deepEqual({ ...steps(true) }, { pcs: '2', models: '3' });
  assert.deepEqual({ ...steps(false) }, { pcs: '2', models: '2' });
  assert.match(grab(hire, /  function drawAll\(\) \{[\s\S]*?\n  \}\n/), /stepNumbers\(/);
});

test('F5: Add new and Get it keep the hire in progress: it is parked and opened again as it was', () => {
  const src = `${grab(hire, /  const parkOf = [\s\S]*?\n  \}\);\n/)}\n${grab(hire, /  function unpark\(p\) \{[\s\S]*?\n  \}\n/)}`;
  const hs = { role: 'artist', pc: 'pcA', model: 'dreamshaper8-lcm', look: { gender: 'woman' }, lookPicked: true, move: null, fromMenu: true };
  const p = run<Record<string, unknown>>(src, 'parkOf(hs, "Ella", true)', { hs });
  const back = { role: '', pc: '', model: '', look: null, lookPicked: false, move: null, fromMenu: false };
  const opts = run<Record<string, unknown>>(src, 'unpark(p)', { p, hs: back });
  assert.deepEqual({ ...opts }, { role: 'artist', pc: 'pcA', page: true, fromMenu: true, move: null, name: 'Ella', resume: p });
  // Every way to the Models page from this window goes through toModels (never a bare close and open, which lost it).
  const outside = hire.replace(/  function toModels\(cat\) \{[\s\S]*?\n  \}\n/, '');
  assert.doesNotMatch(outside, /dlg\.close\(\);\s*app\.openModels\(/);
  assert.equal((outside.match(/toModels\(/g) ?? []).length, 4);
  // openHire puts the parked model and look back.
  assert.match(grab(hire, /  app\.openHire = async [\s\S]*?\n  \};\n/), /if \(resume\) \{[\s\S]*hs\.model = resume\.model[\s\S]*hs\.look = resume\.look/);
});

test('F3: Edit staff\'s Select model and the Images window\'s list say tight or too big for this PC\'s card', () => {
  const tag = run<(m: unknown, pane: string) => string>(grab(app, /function modelTag\(m, pane\) \{[\s\S]*?\n\}\n/), 'modelTag');
  assert.equal(tag({ installed: true, cardFit: onFive, fit: { level: 'ok' } }, 'image'), ` (${onFive!.short})`);
  assert.equal(tag({ installed: true, cardFit: { short: 'tight' }, fit: { level: 'ok' } }, 'image'), ' (tight)');
  assert.equal(tag({ installed: false, cardFit: onFive }, 'image'), ' (not downloaded)');
  assert.equal(tag({ installed: true, cardFit: { short: '' }, fit: { level: 'no' } }, 'image'), ' (too big now)');
  // A chat model's card is another thing (its own field): only the memory free now.
  assert.equal(tag({ fit: { level: 'tight' }, card: 'no' }, 'chat'), ' (tight)');
  assert.match(app, /modelTag\(m, name\)/);
  const choices = run<(m: unknown) => { name: string }[]>(`const FIT = { ok: '', tight: ' (tight on memory)', no: ' (too big now)' };\nconst AGAINST = {};\n${grab(team, /function brainChoices\(m\) \{[\s\S]*?\n\}\n/)}`, 'brainChoices');
  const list = choices({ kind: 'image', models: [{ id: 'z', name: 'Z-Image Turbo', sizeB: 10, unit: 'GB', installed: true, fit: 'ok', against: 'any', cardFit: onFive }], pcBrains: [] });
  assert.match(list[0].name, /Z-Image Turbo · about 10GB · too big for this PC's card: slow: roughly/);
});

// ---- F6: a picture hire with no model says so, not Offline ----

test('F6: a hire with no model says "No model" in the left panel, not Offline', () => {
  const word = run<(s: unknown) => string | undefined>(grab(home, /const staffWord = .*\n/), 'staffWord');
  assert.equal(word({ state: 'none', activity: 'offline', text: 'No picture model given' }), 'No model');
  assert.equal(word({ state: 'none', activity: 'offline', text: 'Video model not downloaded on this PC yet' }), 'Model not downloaded');
  assert.equal(word({ state: 'off', activity: 'offline', text: 'Its PC is off' }), undefined);
  assert.equal(word({ state: 'asleep', activity: 'available' }), undefined);
  assert.match(home, /activity: staffActivity\(s\), activityWord: staffWord\(s\)/);
});

// ---- F15: Make a clip right after hiring opens the chat, never Edit staff over it ----

test('F15: a button pressed on the new hire\'s card while the hire is still settling is not covered by Edit staff', async () => {
  const after = grab(team, /app\.afterHire = async hired => \{[\s\S]*?\n\};\n/);
  const use = grab(team, /let useTurn = 0;\n/);
  const opened: string[] = [];
  const box: Record<string, unknown> = {
    app: { loadChats: async () => { (box.press as () => void)(); }, loadFaces: async () => undefined, chatAgain: async () => null, drawAs: () => undefined },
    team: { data: { staff: [] } }, api: async () => undefined, loadModels: async () => undefined, showChat: () => undefined, setView: () => undefined,
    dlg: { open: false }, teamDraw: () => undefined, useModelOf: async () => undefined, openProfile: (id: string) => opened.push(id), askStartChat: async () => 'no',
    hired: { id: 'p1', kind: 'video', model: null }, done: null,
  };
  runInNewContext(`${use}\nfunction press() { useTurn++; }\n${after}\ndone = app.afterHire(hired);`, box);
  await box.done;
  assert.deepEqual(opened, []);
  // Nothing pressed meanwhile: a hire with no model still opens their profile.
  (box.app as { loadChats: () => Promise<void> }).loadChats = async () => undefined;
  runInNewContext('done = app.afterHire(hired);', box);
  await box.done;
  assert.deepEqual(opened, ['p1']);
  // Each use button on the cards counts a press.
  assert.match(grab(team, /function staffCard\(m\) \{[\s\S]*?\n\}\n/), /use\?\.addEventListener\('click', async \(\) => \{\n\s+useTurn\+\+;/);
});

// ---- The side menu's Hire staff opens Hire staff ----

test('the side menu\'s Hire staff opens the Hire staff window (it opened All staff)', () => {
  const view = read('public/homeview.js');
  assert.match(view, /else if \(b\.dataset\.setup === 'staff'\) app\.openHire\(\{ page: true, fromMenu: true \}\);/);
  assert.match(read('public/index.html'), /data-setup="staff"[^>]*>.*Hire staff<\/button>/);
});

// ---- F1 and F3 on a fresh PC: every picture model in the list, with its fit, licence and whether it is here ----

test('a fresh PC: Hire staff lists every picture model in the list, not downloaded, each with its fit, licence and size; Edit staff and the Images window have the fit too', { timeout: 600_000 }, async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { startPc } = await import('./pcs.ts');
  const top = mkdtempSync(join(tmpdir(), 'tomlin-hirepictures-'));
  const noOllama = join(top, 'no-ollama');
  mkdirSync(noOllama);
  const pc = await startPc({ root: ROOT, home: join(top, 'home'), env: { OLLAMA: noOllama } });
  try {
    const view = (await pc.get('/api/staff')).body;
    const image = view.hireChoices.image.filter((c: { pc: string }) => !c.pc);
    const ids = image.map((c: { id: string }) => c.id).sort();
    assert.ok(ids.includes('z-image-turbo') && ids.includes('dreamshaper8-lcm') && ids.includes('flux2-dev'), ids.join(', '));
    for (const c of image) {
      assert.equal(c.here, false, c.id);
      assert.ok(c.bytes > 0, c.id);
      assert.equal(typeof c.licence, 'string');
      assert.ok(c.cardFit && typeof c.cardFit.word === 'string' && typeof c.cardFit.line === 'string', c.id);
    }
    assert.equal(image.find((c: { id: string }) => c.id === 'flux2-dev').nonCommercial, true);
    assert.equal(image.find((c: { id: string }) => c.id === 'z-image-turbo').nonCommercial, false);
    // A helper (the voice, the sharpener) is not a picture model.
    assert.ok(!ids.includes('kokoro-82m') && !ids.includes('realesrgan-x4-anime6b'));
    const hired = await pc.post('/api/staff', { action: 'hire', name: 'Ella', role: 'artist' });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    const ella = hired.body.staff.find((s: { name: string }) => s.name === 'Ella');
    // Edit staff's Select model: each picture model with its fit for this PC's card.
    for (const x of ella.models) assert.ok(x.cardFit && 'short' in x.cardFit, x.id);
    // The Images window's model list.
    const models = (await pc.get('/api/models')).body;
    for (const x of models.image) assert.ok(x.cardFit && 'short' in x.cardFit, x.id);
  } finally {
    await pc.stop();
    rmSync(top, { recursive: true, force: true });
  }
});
