// A Videographer is hired like an Artist (phase 3 of the Videographer plan): the role, the words for their model,
// Hire staff (Images, then Video (Videographer), and the video models with the fits guide), Edit staff, Move to another
// PC, and the Models page's Video filter. The page parts are read from the page's own files, as test/editstaff.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROLES, drawAsChange, drawsFor, drawsPictures, makesVideo, roleOf, workKind } from '../src/staff.ts';
import { hireModel, hireModelShort } from '../src/hiremodel.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the Videographer is a video role, after the picture roles, with no audition and no picture recipe', () => {
  const v = ROLES.find(r => r.id === 'videographer')!;
  assert.ok(v);
  assert.equal(v.name, 'Videographer');
  assert.equal(v.kind, 'video');
  assert.deepEqual(v.audition, []);
  assert.equal(v.recipe, undefined);
  assert.equal(v.pictures, undefined);
  assert.match(v.hint, /video clips/);
  assert.equal(ROLES.at(-1)!.id, 'videographer');
  assert.equal(roleOf('videographer').id, 'videographer');
});

test('a Videographer makes clips, not pictures: never "Draw as", never drawing a step, and a kind of its own', () => {
  assert.equal(makesVideo('videographer'), true);
  assert.equal(makesVideo('artist'), false);
  assert.equal(drawsPictures('videographer'), false);
  assert.equal(drawsPictures('artist'), true);
  assert.equal(drawsPictures('designer'), true);
  assert.equal(drawsPictures('coder'), false);
  for (const mode of ['icon', 'blog', 'custom']) assert.equal(drawsFor('videographer', mode), false);
  assert.equal(drawsFor('artist', 'blog'), true);
  assert.deepEqual(['coder', 'artist', 'videographer', 'default'].map(workKind), ['chat', 'image', 'video', 'chat']);
  // Asked to be "Draw as": nothing changes for a Videographer; one who was it stops being it.
  assert.equal(drawAsChange(true, { id: 'v1', role: 'videographer' }, ''), null);
  assert.equal(drawAsChange(undefined, { id: 'v1', role: 'videographer' }, 'v1'), '');
});

test('their model in words: a video model given, none given, one not downloaded here yet, one on a linked PC', () => {
  const known = [{ id: 'wan21-t2v-1.3b', name: 'Wan 2.1 1.3B' }, { id: 'wan22-ti2v-5b-q8', name: 'Wan 2.2 5B Q8' }];
  const here = [{ id: 'wan21-t2v-1.3b', name: 'Wan 2.1 1.3B' }];
  const pcs = [{ id: 'ab12cd34', name: 'Z820', models: known, loaded: null }];
  const f = { video: true, here, pcs, connected: null, known };
  assert.deepEqual(hireModel('wan21-t2v-1.3b', f), { state: 'here', name: 'Wan 2.1 1.3B', pc: 'this PC', text: 'Wan 2.1 1.3B', pick: false });
  const none = hireModel(null, f);
  assert.equal(none.state, 'none');
  assert.equal(none.text, 'no video model given, and none is loaded here');
  assert.equal(none.pick, true);
  const notYet = hireModel('wan22-ti2v-5b-q8', f);
  assert.equal(notYet.state, 'missing');
  assert.equal(notYet.text, 'Wan 2.2 5B Q8, not downloaded on this PC yet');
  assert.equal(notYet.pick, true);
  assert.equal(hireModelShort(notYet), 'its model is no longer here');
  const there = hireModel('remote:ab12cd34:wan22-ti2v-5b-q8', f);
  assert.equal(there.state, 'pc');
  assert.equal(there.text, 'Wan 2.2 5B Q8 on "Z820"');
  // An id not in the list at all is still "no longer on this PC", as for the other kinds.
  assert.match(hireModel('gone-model', f).text, /no longer on this PC/);
});

test('Hire staff: Role Images holds Video (Videographer), and its cards are the video models with the fits guide', () => {
  const hire = read('public/hire.js');
  // The Videographer sits under the Images tile, named "Video (Videographer)" in the sub-role list.
  assert.match(hire, /const kindOf = r => \(r\?\.kind === 'image' \|\| r\?\.kind === 'video' \? 'image' : 'chat'\);/);
  assert.match(hire, /const subName = r => \(r\.kind === 'video' \? `Video \(\$\{r\.name\}\)` : r\.name\);/);
  assert.match(hire, /text: subName\(r\)/);
  // The model kind follows the role: video cards from hireChoices.video.
  assert.match(hire, /role\(\)\?\.kind === 'image' \|\| role\(\)\?\.kind === 'video' \? role\(\)\.kind : 'chat'/);
  assert.match(hire, /hireChoices\?\.\[kind\(\)\]/);
  assert.match(hire, /if \(kind\(\) === 'video'\) return videoCard\(c\);/);
  // The three fit words, the line under them, and a model not downloaded here cannot be picked: Get it instead.
  assert.match(hire, /c\.videoFit === 'Fits' \? `Fits · \$\{c\.fitLine\}`/);
  assert.match(hire, /c\.videoFit === 'Not enough memory'/);
  assert.match(hire, /disabled: missing/);
  // The hire in progress is kept while the Models page is open (toModels, test/hirepictures.test.ts).
  assert.match(hire, /text: 'Get it on the Models page', onclick: \(\) => toModels\('video'\) \}/);
  assert.match(hire, /list\.find\(c => c\.here !== false\)/, 'a model not downloaded here is never picked for them');
  // A video model goes from this PC to a linked PC only: the network block shows for a Videographer on a linked PC.
  assert.match(hire, /block\.hidden = !d\(\)\?\.pcs\.length \|\| \(video && !hs\.pc\);/);
});

test('the server offers video choices for this PC and each linked PC, and checks a video model on hire, change and move', () => {
  const team = read('src/server/team.ts');
  assert.match(team, /video: \[\.\.\.videoChoices\(''\), \.\.\.pcs\.filter\(r => !r\.backupsOnly && !r\.heldByCluster\)\.flatMap\(r => videoChoices\(r\.id\)\)\]/);
  // This PC's card, or the linked PC's (its graphics memory as it said last), for the fits guide.
  assert.match(team, /const card = pc \? \(mem\?\.vram \?/);
  assert.match(team, /: cardHere\(\);/);
  // A video model is one of the list (here or on a linked PC); a chat or picture model is refused for a Videographer.
  assert.match(team, /kind === 'video' \? !!videoModel\(ref\.id\)/);
  assert.match(team, /\(!video \|\| !!videoModel\(ref\.model\)\)/);
  assert.match(team, /That is not a \$\{kind === 'video' \? 'video' : image \? 'picture' : 'chat'\} model/);
  // Changing between chat, picture and video takes the old kind's model off.
  assert.match(team, /workKind\(b\.role\) !== workKind\(was\.role\)/);
  // A move onto a card that cannot hold it is refused in words.
  assert.match(team, /more than the card of \$\{pc \? `"\$\{pc\.name\}"` : 'this PC'\} has\. Pick a smaller video model, or another PC\./);
  // Edit staff: their kind is video, with the list and each linked PC's choices; no wake and no audition.
  assert.match(team, /kind: 'video',\r?\n\s+use: hireModelOf\(m\),/);
  assert.match(team, /video model loads when a clip is made: there is nothing to wake\./);
  assert.match(team, /A Videographer has no audition yet/);
});

test('Edit staff: video models with their fit, Get it for one not downloaded, no audition, speed, tone or tokens', () => {
  const team = read('public/team.js');
  assert.match(team, /videographer: 'M4 6h11/, 'a video camera icon');
  assert.match(team, /const notChat = m => m\?\.kind === 'image' \|\| m\?\.kind === 'video';/);
  assert.match(team, /if \(m\.kind === 'video'\) \{\r?\n\s+return \[/);
  assert.match(team, /x\.installed \? '' : 'not downloaded', x\.videoFit \?\? 'card not known'/);
  assert.match(team, /is not downloaded on this PC yet\. `, el\('button', \{ class: 'link', type: 'button', text: 'Get it on the Models page'/);
  assert.match(team, /SHOW_AUDITION && !video \? section\('Audition'/);
  assert.match(team, /if \(!tones\.length \|\| notChat\(m\) \|\| m\.role === 'default'\) return null;/);
  assert.match(team, /const usage = notChat\(m\) \? null/);
  // The role change asks first across all three kinds.
  assert.match(team, /const doing = \{ image: 'draw', video: 'make clips' \}\[toKind\] \?\? 'chat';/);
  // Move to another PC is Hire staff's window for them (app.openMove), which shows that PC's video models.
  assert.match(team, /app\.openMove\?\.\(m, at\)/);
});

test('Home\'s move window treats a Videographer\'s models as video ones, and never copies one between PCs', () => {
  const home = read('public/home.js');
  assert.match(home, /const workOf = s => \(s\.kind === 'image' \|\| s\.kind === 'video' \? s\.kind : 'chat'\);/);
  assert.match(home, /hireChoices\?\.\[workOf\(s\)\] \?\? \[\]\)\.filter\(c => c\.here !== false\)/);
  assert.match(home, /!same && workOf\(s\) !== 'video' \?/);
});

test('the Models page has a Video models filter, and downloads a video model through its own door', () => {
  const models = read('public/models.js');
  assert.match(models, /\['image', 'Picture models'\], \['video', 'Video models'\]/);
  assert.match(models, /api\('\/api\/videomodels'\)/);
  assert.match(models, /for \(const x of d\.video \?\? \[\]\)/);
  assert.match(models, /kind: 'video', name: x\.short, tag: x\.fit \?\? ''/);
  assert.match(models, /downloadBtn\(x, '\/api\/videomodels'\)/);
  assert.match(models, /api\(`\$\{door\}\/start`, \{ id: x\.id \}\)/);
  const server = read('src/server/videomodels.ts');
  assert.match(server, /'\/api\/videomodels\/start'/);
  assert.match(server, /'\/api\/videomodels\/stop'/);
  assert.match(read('src/server.ts'), /sitecheckGet, videoModelsGet, modelHomeGet\);/);
});
