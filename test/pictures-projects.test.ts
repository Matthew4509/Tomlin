// Pictures and projects: the words to leave out and the size asked reach the PC that draws; a project's picture is
// drawn by its artist from a picture prompt; Home's Lets go! is planned; a picture alone stays one step; a plan names
// no file nobody makes; hiring through POST /api/staff can set "Draw as". Rules from the source, plus the way through
// read from the source as test/drawquality.test.ts does. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawChoices } from '../src/nodestaff.ts';
import { askedDrawSize, shortSizeWords, topSide } from '../src/quality.ts';
import { picturePrompt, pictureOnlyPlan, plainPictureAsk, stepArtist, tieUnmadeFiles } from '../src/picturestep.ts';
import { cleanStep, type Step } from '../src/jobs.ts';
import { drawAsChange } from '../src/staff.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const fn = (text: string, start: RegExp) => start.exec(text)![0];

// ---- 15: the words to leave out ----

test('the words to leave out go with a picture asked of a linked PC', () => {
  assert.deepEqual(drawChoices({ negative: '  insect,   bug, extra rotors ' }), { negative: 'insect, bug, extra rotors' });
  assert.deepEqual(drawChoices({ negative: '' }), {});
  assert.deepEqual(drawChoices({ negative: 42 }), {});
  assert.equal(drawChoices({ negative: 'x'.repeat(3000) }).negative!.length, 1000);
});

test('they go all the way: the Images window and the queue, the door of that PC, and the picture it draws', () => {
  const pictures = read('src/server/pictures.ts');
  assert.match(fn(pictures, /async function startAway\([\s\S]*?\n\}/), /\.\.\.drawChoices\(asked\)/);
  const queued = fn(pictures, /export async function queuedPicture\([\s\S]*?\n\}/);
  // The asked words, a picked style's (src/styles.ts), then the artist's own.
  assert.match(queued, /const negative = \[o\.negative\?\.trim\(\), extra\.negative, recipe\?\.negative\]/, 'the asked words and the artist\'s own');
  assert.match(queued, /jobRoutes\.drawOn\(away\.r, \{[^}]*\.\.\.\(negative \? \{ negative \} : \{\}\)/);
  assert.match(queued, /images\.generate\(\{ prompt: o\.prompt, negative: o\.negative,/, 'drawn here too');
  assert.match(read('src/jobrun/links.ts'), /export async function drawOn\(r: Remote, ask: \{[^}]*negative\?: string/);
  const node = read('src/jobrun/node.ts');
  assert.match(fn(node, /async function workerDraw\([\s\S]*?\n\}/), /const choices = nodestaff\.drawChoices\(b\);/);
  assert.match(fn(node, /async function drawShared\([\s\S]*?\n\}/), /negative: ask\.negative[,}]/);
  assert.match(fn(pictures, /export async function drawForPc\([\s\S]*?\n\}/), /images\.generate\(\{ prompt: o\.prompt, negative: o\.negative,/);
  // The queue keeps them with the picture.
  assert.match(read('src/queue.ts'), /\['negative', str\(r\.negative, 1000\)\]/);
  assert.match(read('src/server/queue.ts'), /negative: it\.negative, \.\.\.chosen, \.\.\.refs(, \.\.\.look)? \}, signal/);
});

test('a queued picture kept while the host is away still carries its words to leave out and its size', () => {
  // The queue asks with its request id (src/jobrun/pictureback.ts) and the words and size together; the id names them
  // too, so a changed item asks anew, and an item without words keeps the id it had before.
  const run = fn(read('src/server/queue.ts'), /async function runPicture\([\s\S]*?\n\}/);
  assert.match(run, /ridOf\(\{[^}]*width: it\.width \?\? 0, height: it\.height \?\? 0, \.\.\.\(it\.negative \? \{ negative: it\.negative \} : \{\}\), \.\.\.chosen, \.\.\.refs(, \.\.\.look)? \}\)/);
  assert.match(run, /queuedPicture\(\{[^}]*width: it\.width, height: it\.height, rid, negative: it\.negative, \.\.\.chosen, \.\.\.refs(, \.\.\.look)? \}/);
  // An item with no @Name pictures adds nothing to the id, so it keeps the id it had before.
  assert.match(run, /const refs = it\.refs\?\.length \? \{ refs: it\.refs \} : \{\};/);
  const queued = fn(read('src/server/pictures.ts'), /export async function queuedPicture\([\s\S]*?\n\}/);
  assert.match(queued, /jobRoutes\.drawOn\(away\.r, \{ prompt, style, width: o\.width, height: o\.height, \.\.\.\(negative \? \{ negative \} : \{\}\), .*\.\.\.\(o\.rid \? \{ rid: o\.rid \} : \{\}\) \}/);
  assert.match(queued, /await got\.taken\(\);/);
  // drawOn sends everything asked, with the id, to that PC; that PC's kept draw passes the words on.
  const drawOn = fn(read('src/jobrun/links.ts'), /export async function drawOn\([\s\S]*?\n\}/);
  // keepMs is this PC's own wait for a cut stream, never sent.
  assert.match(drawOn, /const \{ rid: askedRid, keepMs, refImages, \.\.\.rest \} = ask;/);
  assert.match(drawOn, /const body: Record<string, unknown> = \{ \.\.\.\(rid \? \{ \.\.\.rest, rid \} : rest\), \.\.\.\(refsGo \? \{ refImages \} : \{\}\) \};/);
  const shared = fn(read('src/jobrun/node.ts'), /async function drawShared\([\s\S]*?\n\}/);
  assert.match(shared, /drawFor\(res, keep,/);
  assert.match(shared, /width: ask\.width, height: ask\.height,[^}]*negative: ask\.negative, \.\.\.\(ask\.refData\?\.length \? \{ refData: ask\.refData \} : \{\}\) \}/);
});

test('a queued picture keeps Draft, Mid or High and its seed, and draws with them here and on a linked PC (Q1)', async () => {
  const Q = await import('../src/queue.ts');
  const base = { id: 'abc123', kind: 'picture', title: 'a fox', prompt: 'a fox', added: '2026-11-26T00:00:00.000Z', project: '' };
  const kept = Q.cleanItem({ ...base, quality: 'high', seed: 42 })!;
  assert.equal(kept.quality, 'high');
  assert.equal(kept.seed, 42);
  // Anything else is left out: the PC's own choice and a new seed, as before.
  const odd = Q.cleanItem({ ...base, quality: 'ultra', seed: -1 })!;
  assert.equal(odd.quality, undefined);
  assert.equal(odd.seed, undefined);
  // Every seed the Images window takes is kept (up to 2^32 - 1, src/drawrefs.ts SEED_MOST); past it, left out.
  assert.equal(Q.cleanItem({ ...base, seed: 2 ** 31 })!.seed, 2 ** 31);
  assert.equal(Q.cleanItem({ ...base, seed: 2 ** 32 })!.seed, undefined);
  assert.equal(Q.cleanItem({ ...base, seed: 1.5 })!.seed, undefined);
  // Added with them, run with them; an item with neither keeps the request id it had before.
  const server = read('src/server/queue.ts');
  assert.match(server, /quality: raw\.quality, seed: raw\.seed, project: projectId/);
  const run = fn(server, /async function runPicture\([\s\S]*?\n\}/);
  assert.match(run, /const chosen = \{ \.\.\.\(it\.quality \? \{ quality: it\.quality \} : \{\}\), \.\.\.\(it\.seed !== undefined \? \{ seed: it\.seed \} : \{\}\) \};/);
  const queued = fn(read('src/server/pictures.ts'), /export async function queuedPicture\([\s\S]*?\n\}/);
  assert.match(queued, /\.\.\.drawChoices\(\{ quality: o\.quality, seed: o\.seed \}\), \.\.\.\(refImages\.length \? \{ refImages \} : \{\}\), queue: true/, 'sent to a linked PC');
  assert.match(queued, /\.\.\.\(o\.quality \? \{ quality: o\.quality \} : \{\}\), \.\.\.\(o\.seed !== undefined \? \{ seed: o\.seed \} : \{\}\), \.\.\.\(refPaths\.length \? \{ refs: refPaths \} : \{\}\) \}\);/, 'drawn here');
  assert.deepEqual(drawChoices({ quality: 'mid', seed: 42 }), { quality: 'mid', seed: 42 });
  assert.deepEqual(drawChoices({ quality: undefined, seed: undefined }), {});
  // The Images window's Add to the queue sends them (the seed only when Random is off).
  const page = fn(read('public/queue.js'), /function pictureFields\(\) \{[\s\S]*?\n {2}\}/);
  assert.match(page, /input\[name="img-quality"\]:checked/);
  assert.match(page, /!\$\('#img-random'\)\?\.checked && \/\^\\d\+\$\/\.test\(seedText\)/);
  assert.match(page, /quality, seed, project:/);
});

// ---- 16: the size asked ----

const qwen = { native: 1024, quality: { draft: 512, mid: 768, high: 1024 } };
const sd15 = { native: 512, quality: { draft: 384, mid: 512, high: 640 } };
const sdxl = { native: 1024, quality: { draft: 768, mid: 1024, high: 1024 } };

test('a size asked exactly is drawn at that size when the model can, not at the quality\'s smaller one', () => {
  // The fault: 1024 x 1024 asked, Mid on this model is 768, so it was drawn at 768 and enlarged without a word.
  assert.deepEqual(askedDrawSize(qwen, 'mid', { width: 1024, height: 1024 }), { size: { width: 1024, height: 1024 }, short: false });
  assert.deepEqual(askedDrawSize(sdxl, 'mid', { width: 1024, height: 1024 }), { size: { width: 1024, height: 1024 }, short: false });
  // Wide: the asked shape, as many pixels as asked.
  assert.deepEqual(askedDrawSize(qwen, 'mid', { width: 1024, height: 576 }).size, { width: 1024, height: 576 });
  // Smaller than the quality's own: never drawn smaller than that.
  assert.deepEqual(askedDrawSize(qwen, 'high', { width: 512, height: 512 }).size, { width: 1024, height: 1024 });
  // A Draft was asked: its own smaller size stays.
  assert.deepEqual(askedDrawSize(qwen, 'draft', { width: 1024, height: 1024 }), { size: { width: 512, height: 512 }, short: false });
});

test('more than the model draws: its largest, and words that say so', () => {
  assert.equal(topSide(sd15), 640);
  const r = askedDrawSize(sd15, 'mid', { width: 1024, height: 1024 });
  assert.deepEqual(r, { size: { width: 640, height: 640 }, short: true });
  assert.equal(shortSizeWords('Pebble Photo 2', r.size, { width: 1024, height: 1024 }), 'Pebble Photo 2 draws at most 640 x 640 pixels, less than the 1024 x 1024 asked for: it was drawn at 640 x 640 and enlarged to 1024 x 1024.');
});

test('the size asked is used for a linked PC and for the queue, and the words come back', () => {
  const images = read('src/images.ts');
  assert.match(images, /const exact = !base && opts\.exactSize === true && asked && target0 \? askedDrawSize\(m, quality, target0\) : null;/);
  assert.match(images, /const generated = base \? base\.generated : exact \? exact\.size : qualitySize\(m, quality, target0\);/);
  assert.match(images, /if \(exact\?\.short\) job\.sizeNote = shortSizeWords\(/);
  assert.match(images, /note: \[job\.sizeNote, job\.note\]\.filter\(Boolean\)\.join\(' '\),/, 'sent back to the PC that asked');
  const pictures = read('src/server/pictures.ts');
  assert.match(fn(pictures, /export async function drawForPc\([\s\S]*?\n\}/), /exactSize: o\.width !== undefined \|\| o\.height !== undefined/);
  assert.match(fn(pictures, /export async function queuedPicture\([\s\S]*?\n\}/), /exactSize: o\.width !== undefined \|\| o\.height !== undefined/);
  assert.match(read('src/server/queue.ts'), /\$\{got\.note \? ` \$\{got\.note\}` : ''\}/, 'the queue line says it');
});

// ---- 17: a project's picture: its artist, a picture prompt ----

test('a picture step is drawn by the hire with its role, not by whoever the Images window draws as', () => {
  const team = [
    { id: 'pip-writer', role: 'writer', draws: false },
    { id: 'rowan-sketch', role: 'designer', draws: true },
    { id: 'juno-paint', role: 'artist', draws: true },
  ];
  assert.equal(stepArtist('artist', team, 'rowan-sketch'), 'juno-paint');
  assert.equal(stepArtist('designer', team, 'juno-paint'), 'rowan-sketch');
  // Nobody with that role: an artist, then "Draw as", then anyone who draws.
  assert.equal(stepArtist('designer', team.filter(h => h.id !== 'rowan-sketch'), ''), 'juno-paint');
  assert.equal(stepArtist('artist', [{ id: 'ivy-icons', role: 'designer', draws: true }], 'ivy-icons'), 'ivy-icons');
  assert.equal(stepArtist('artist', [team[0]], 'pip-writer'), undefined, 'a hire who does not draw never draws');
});

test('the picture model gets what the picture shows, not the planner\'s brief about files and pages', () => {
  const brief = 'Create a high-quality photo of a lighthouse on a cliff at dusk with waves below. The style should be realistic, trustworthy, and neutral modern. Ensure the image is high resolution suitable for a hero section. Save the file as \'lighthouse-dusk.jpg\'.';
  assert.equal(picturePrompt('Lighthouse picture', brief), 'photo of a lighthouse on a cliff at dusk with waves below, realistic');
  assert.equal(picturePrompt('2. A red kite over hills', 'Save it under specialists/images/kite.png.'), 'A red kite over hills', 'nothing left: the title');
  assert.equal(picturePrompt('Fox', 'A small fox asleep in snow, soft light'), 'A small fox asleep in snow, soft light');
});

test('the queue gives a project\'s picture step to its artist, with the picture prompt', () => {
  const q = read('src/server/queue.ts');
  const at = q.indexOf("if (r.kind === 'picture') {");
  const part = q.slice(at, at + 900);
  assert.match(part, /const as = stepArtist\(r\.role, staff\.list\(\)/);
  assert.match(part, /const prompt = picturePrompt\(r\.title, r\.brief\);/);
  assert.match(part, /title: prompt, prompt, \.\.\.\(as \? \{ as \} : \{\}\)/);
});

// ---- 18: Home's Lets go! is planned ----

test('Lets go! makes the project and adds it to the queue, which plans and splits it (no chat)', () => {
  const home = read('public/homeview.js');
  assert.match(home, /api\('\/api\/projects\/create', \{ name: \$\('#home-name'\)\.value, about, prompt, pm: homeAsk\.pm, go: true, plan: true \}\)/);
  assert.match(home, /app\.addToQueue\(\[\{ kind: 'project', project: r\.id \}\]\)/);
  assert.doesNotMatch(home, /app\.sendNow\(prompt \|\| about\)/);
  const work = read('src/server/work.ts');
  const create = fn(work, /async function projectCreate\([\s\S]*?\n\}/);
  assert.match(create, /const planned = b\.go === true && b\.plan === true;/);
  assert.match(create, /const go = b\.go === true && !planned;/, 'no chat is made for a planned one');
  assert.match(create, /\.\.\.\(planned \? \{ plan: true, picture: pictureOnly \} : \{\}\)/);
  // The queue plans a project saved with no plan before it runs its steps.
  assert.match(read('src/server/queue.ts'), /if \(!\(await jobRoutes\.loadJob\(it\.project\)\)\) \{\s*st\.stage = 'Making the plan';/);
});

// ---- 19: a picture alone is one step; no file nobody makes ----

test('a one-line picture request is a plain picture; a page or text is not', () => {
  assert.equal(plainPictureAsk('a red kite flying over green hills on a windy day, high quality, photo'), true);
  assert.equal(plainPictureAsk('draw a fox asleep in the snow'), true);
  assert.equal(plainPictureAsk('a landing page for a bakery with a photo of bread'), false);
  assert.equal(plainPictureAsk('write a blog post with a picture of a kite'), false);
  assert.equal(plainPictureAsk('a photo of a kite\nand a page about kites'), false);
  assert.equal(plainPictureAsk('a kite festival schedule'), false, 'no picture asked');
  const plan = pictureOnlyPlan('a red kite over green hills, photo');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].role, 'artist');
  assert.deepEqual(plan[0].files, []);
  assert.equal(plan[0].brief, 'a red kite over green hills, photo');
});

test('the planner is not asked for a picture alone; every plan has unmade file names taken out', () => {
  const a = read('src/jobrun/actions.ts');
  const plan = fn(a, /async function planNow\([\s\S]*?\n\}/);
  assert.ok(plan.indexOf('if (plainPictureAsk(goal))') < plan.indexOf("seatBrain(team, 'pm'"), 'checked before a planner is loaded');
  assert.match(plan, /const steps = pictureOnlyPlan\(goal\);/);
  assert.match(plan, /const parsed = tieUnmadeFiles\(folders\.writerHandIn\(jobs\.parsePlan\(text\), there\)\.steps, there\)\.steps;/);
});

const step = (o: Record<string, unknown>) => cleanStep(o) as Step;

test('a brief that names a file no step makes: a picture becomes "the picture from step N"; anything else is taken out', () => {
  const steps = [
    step({ title: 'Page', role: 'coder', files: 'index.html', brief: 'Write index.html with a hero section.', check: 'It opens.' }),
    step({ title: 'Hero picture', role: 'artist', files: '', brief: 'A red kite over green hills at dusk, photo.', check: 'The kite shows.' }),
    step({ title: 'Picture in page', role: 'coder', files: 'index.html', brief: 'Put specialists/images/kite_hills.jpg in the hero of index.html. Link styles/extra.css too.', check: 'kite_hills.jpg shows on the page.' }),
  ];
  const r = tieUnmadeFiles(steps, new Set(['README.md']));
  assert.deepEqual(r.fixed.sort(), ['specialists/images/kite_hills.jpg', 'styles/extra.css', 'kite_hills.jpg'].sort());
  assert.equal(r.steps[2].brief, "Put the picture from step 2 (its file name is in step 2's summary once it is drawn) in the hero of index.html.");
  assert.equal(r.steps[2].check, "the picture from step 2 (its file name is in step 2's summary once it is drawn) shows on the page.");
  assert.equal(r.steps[0].brief, 'Write index.html with a hero section.', 'a file a step makes stays');
  // Files there already, or made by a step, in a folder or not, stay; so do names like Node.js.
  const kept = tieUnmadeFiles([step({ title: 'Docs', role: 'writer', files: 'docs/guide.md', brief: 'Explain README.md and guide.md for Node.js users.', check: '' })], new Set(['README.md']));
  assert.deepEqual(kept.fixed, []);
});

// ---- 20: "Draw as" from POST /api/staff ----

test('"Draw as" from a hire or a change: set when asked for someone who draws, cleared when they stop', () => {
  const artist = { id: 'juno-paint', role: 'artist' };
  const writer = { id: 'pip-writer', role: 'writer' };
  assert.equal(drawAsChange(true, artist, ''), 'juno-paint');
  assert.equal(drawAsChange(true, artist, 'juno-paint'), null, 'already');
  assert.equal(drawAsChange(undefined, artist, ''), null, 'not asked: left as it is');
  assert.equal(drawAsChange(true, writer, ''), null, 'a writer does not draw');
  assert.equal(drawAsChange(false, artist, 'juno-paint'), '');
  assert.equal(drawAsChange(false, artist, 'rowan-sketch'), null, 'someone else stays');
  assert.equal(drawAsChange(undefined, writer, 'pip-writer'), '', 'changed to a role that does not draw');
});

test('POST /api/staff uses it when hiring and when changing', () => {
  const team = read('src/server/team.ts');
  const at = team.indexOf("'/api/staff': async ({ res, b }) => {");
  const route = team.slice(at, team.indexOf("'/api/staff/wake'", at));
  assert.match(route, /const made = await staff\.hire\(/);
  assert.match(route, /const drawAs = drawAsChange\(b\.drawAs, made, \(await store\.settings\(\)\)\.imageAs\);/);
  assert.match(route, /const drawAs = nowDraws \? drawAsChange\(b\.drawAs, nowDraws, \(await store\.settings\(\)\)\.imageAs\) : null;/);
  assert.equal((route.match(/if \(drawAs !== null\) await store\.saveSettings\(\{ imageAs: drawAs \}\);/g) ?? []).length, 2);
});
