// Which pictures make good starts for video (src/pairing.ts): the expected fit of every style, the notes built from a
// start picture's facts only (unknown when it does not say), kept / not kept / too soon, made again, the lines (Seen
// only with clips counted), and the pages and routes that show them. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../src/pairing.ts';
import { STYLES } from '../src/styles.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const DAY = P.KEEP_MS;
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const vname = (id: string) => (id === 'wan22-5b' ? 'Wan 2.2 5B' : id);

test('every style has an expected fit with one short reason: photo-like ones hold, drawn ones drift, Auto depends', () => {
  for (const s of STYLES) {
    const e = P.EXPECTED[s.id];
    assert.ok(e, `${s.id} has an expected fit`);
    assert.ok(e.reason.length > 10 && e.reason.length <= 100, `${s.id}: one short line`);
    assert.doesNotMatch(e.reason, /#[0-9a-f]{3,6}\b/i);
  }
  assert.deepEqual(STYLES.filter(s => P.EXPECTED[s.id].fit === 'good').map(s => s.id), ['photo', 'cinematic', 'cdrama']);
  for (const id of ['anime', 'cartoon', 'ink', 'watercolour', 'pixel', 'icon', 'surreal']) assert.equal(P.EXPECTED[id].fit, 'drifts', id);
  assert.equal(P.EXPECTED.auto.fit, 'depends');
  assert.match(P.EXPECTED.auto.reason, /Depends on the look drawn/);
  assert.equal(P.FIT_LABEL.good, 'Good start for video');
  assert.equal(P.FIT_LABEL.drifts, 'Changes look in video');
  assert.equal(P.expectedOf('blog').fit, 'good', 'the old value for Photo');
  assert.equal(P.expectedOf('nonsense').fit, 'depends');
});

test('the drift warning: only for a style that drifts, in plain words, never for one not known', () => {
  assert.equal(P.driftWarning('anime'), 'This picture is in Anime: video models tend to pull it toward real life, so faces may change. A Photo or Cinematic still holds better.');
  assert.match(P.driftWarning('ink'), /^This picture is in Chinese ink:/);
  assert.equal(P.driftWarning('photo'), '');
  assert.equal(P.driftWarning('cinematic'), '');
  assert.equal(P.driftWarning('auto'), '');
  assert.equal(P.driftWarning(null), '');
  assert.equal(P.driftWarning(undefined), '');
});

test('a start picture\'s facts come from what it says, and stay not known when it says nothing', () => {
  const here = P.factsOfPicture({ id: 'p1', model: 'dreamshaper-8', modelName: 'DreamShaper 8 (SD 1.5)', device: 'cuda', style: 'anime' });
  assert.deepEqual(here, { key: 'gallery:p1', pictureModel: 'dreamshaper-8', pictureName: 'DreamShaper 8', style: 'anime' });
  // A linked PC's picture names its model only; no style recorded: not known, never guessed from its mode.
  const there = P.factsOfPicture({ id: 'p2', model: 'remote', modelName: 'Juggernaut XL (SDXL) on Worker', device: 'on Worker' });
  assert.deepEqual(there, { key: 'gallery:p2', pictureModel: null, pictureName: 'Juggernaut XL', style: null });
  assert.equal(P.factsOfPicture({ id: 'p3', model: 'x', modelName: '', style: 'not-a-style' }).style, null);
  assert.equal(P.factsOfPicture({ id: 'p4', model: 'x', modelName: '' }).pictureName, null);
  assert.deepEqual(P.factsOfSample('dreamshaper-8', 'pixel'), { key: 'sample:dreamshaper-8/pixel', pictureModel: 'dreamshaper-8', pictureName: 'dreamshaper-8', style: 'pixel' });
  assert.deepEqual(P.unknownFacts('file:c:\\x.png'), { key: 'file:c:\\x.png', pictureModel: null, pictureName: null, style: null });
});

test('a clip is noted once, with its facts; the same start with the same video model counts as made again', () => {
  const facts = P.factsOfPicture({ id: 'p1', model: 'ds8', modelName: 'DreamShaper 8', style: 'anime' });
  let f = P.withClip(P.emptyPairing(), facts, { id: 'c1', at: at(0), model: 'wan22-5b' });
  assert.equal(f.clips.length, 1);
  assert.deepEqual(f.clips[0], { clip: 'c1', at: at(0), start: 'gallery:p1', pictureModel: 'ds8', pictureName: 'DreamShaper 8', style: 'anime', video: 'wan22-5b', again: false });
  assert.equal(P.withClip(f, facts, { id: 'c1', at: at(5), model: 'wan22-5b' }), f, 'noted already');
  f = P.withClip(f, facts, { id: 'c2', at: at(10), model: 'wan22-5b' });
  assert.equal(f.clips[1].again, true);
  f = P.withClip(f, facts, { id: 'c3', at: at(20), model: 'wan21-1.3b' });
  assert.equal(f.clips[2].again, false, 'another video model');
  // A start with no key (none known) is never "again".
  f = P.withClip(f, P.unknownFacts(null), { id: 'c4', at: at(30), model: 'wan22-5b' });
  f = P.withClip(f, P.unknownFacts(null), { id: 'c5', at: at(40), model: 'wan22-5b' });
  assert.equal(f.clips[4].again, false);
});

test('kept: Keep pressed, or still on the shelf a day on; not kept: another take kept, or deleted within the day', () => {
  const facts = P.factsOfPicture({ id: 'p1', model: 'ds8', modelName: 'DreamShaper 8', style: 'photo' });
  let f = P.emptyPairing();
  for (const id of ['a', 'b', 'c', 'd', 'e']) f = P.withClip(f, facts, { id, at: at(0), model: 'wan22-5b' });
  f = P.withKept(f, 'a', ['a', 'b'])!;
  f = P.withDeleted(f, ['c'], new Date(T0 + DAY / 2))!;
  f = P.withDeleted(f, ['d'], new Date(T0 + DAY * 2))!;
  const now = T0 + DAY / 4;
  const o = (id: string, t: number) => P.outcomeOf(f.clips.find(n => n.clip === id)!, t);
  assert.equal(o('a', now), 'kept');
  assert.equal(o('b', now), 'not kept');
  assert.equal(o('e', now), 'too soon');
  assert.equal(o('e', T0 + DAY), 'kept');
  assert.equal(o('c', T0 + DAY * 3), 'not kept');
  assert.equal(o('d', T0 + DAY * 3), 'kept');
  // Keep pressed on the other take afterwards: that one kept, the first not.
  f = P.withKept(f, 'b', ['a', 'b'])!;
  assert.equal(o('b', now), 'kept');
  assert.equal(o('a', now), 'not kept');
  assert.equal(P.withKept(f, 'zz', ['zz']), null, 'nothing noted: nothing written');
  assert.equal(P.withDeleted(f, ['c'], new Date()), null, 'deleted already');
});

test('the rows count per picture model, style and video model; the file read back drops what does not fit', () => {
  let f = P.emptyPairing();
  const anime = P.factsOfPicture({ id: 'p1', model: 'ds8', modelName: 'DreamShaper 8', style: 'anime' });
  const photo = P.factsOfPicture({ id: 'p2', model: 'ds8', modelName: 'DreamShaper 8', style: 'photo' });
  f = P.withClip(f, anime, { id: 'c1', at: at(0), model: 'wan22-5b' });
  f = P.withClip(f, anime, { id: 'c2', at: at(0), model: 'wan22-5b' });
  f = P.withClip(f, photo, { id: 'c3', at: at(0), model: 'wan22-5b' });
  f = P.withDeleted(f, ['c1', 'c2'], new Date(T0 + 1000))!;
  const rows = P.seenRows(P.cleanPairing(JSON.parse(JSON.stringify(f))), T0 + DAY * 2);
  assert.equal(rows.length, 2);
  const a = rows.find(r => r.style === 'anime')!;
  assert.deepEqual({ made: a.made, counted: a.counted, kept: a.kept, again: a.again }, { made: 2, counted: 2, kept: 0, again: 1 });
  const p = rows.find(r => r.style === 'photo')!;
  assert.deepEqual({ made: p.made, counted: p.counted, kept: p.kept }, { made: 1, counted: 1, kept: 1 });
  const bad = P.cleanPairing({ version: 1, clips: [{ clip: 'x' }, { clip: 'y', at: 'not a date', video: 'v' }, { clip: 'z', at: at(0), video: 'v', style: 'made-up', pictureModel: '../etc' }, 'junk'] });
  assert.equal(bad.clips.length, 1);
  assert.equal(bad.clips[0].style, null);
  assert.equal(bad.clips[0].pictureModel, null);
  assert.deepEqual(P.cleanPairing(null), P.emptyPairing());
});

test('the lines: Expected with nothing counted, Seen only with clips counted (too soon is not counted)', () => {
  const fresh = P.withClip(P.emptyPairing(), P.factsOfPicture({ id: 'p1', model: 'ds8', modelName: 'DreamShaper 8', style: 'photo' }), { id: 'c1', at: at(0), model: 'wan22-5b' });
  const soon = P.seenRows(fresh, T0 + 1000);
  const tile = P.styleFit('photo', 'ds8', 'DreamShaper 8', soon, vname);
  assert.equal(tile.tag, 'Expected');
  assert.equal(tile.label, 'Good start for video');
  assert.match(tile.hover, /Expected, not seen yet\.$/);
  assert.doesNotMatch(tile.hover, /Seen:/);
  const later = P.seenRows(fresh, T0 + DAY);
  const seen = P.styleFit('photo', 'ds8', 'DreamShaper 8', later, vname);
  assert.equal(seen.tag, 'Seen');
  assert.match(seen.hover, /Seen: kept 1 of 1 clip with Wan 2\.2 5B\./);
  // Another picture model's clips are not this one's.
  assert.equal(P.styleFit('photo', 'other', 'Other', later, vname).tag, 'Expected');
  assert.equal(P.styleFit('anime', 'ds8', 'DreamShaper 8', later, vname).label, 'Changes look in video');
  assert.equal(P.styleFit('auto', 'ds8', 'DreamShaper 8', later, vname).label, 'Depends on the look drawn');

  const video = { id: 'wan22-5b', name: 'Wan 2.2 5B' };
  const none = P.pictureLine({ key: 'ds8', name: 'DreamShaper 8' }, video, soon);
  assert.deepEqual([none.text, none.tag], ['DreamShaper 8 goes well with Wan 2.2 5B (styles Photo, Cinematic and Chinese drama (realistic))', 'Expected']);
  const yes = P.pictureLine({ key: 'ds8', name: 'DreamShaper 8' }, video, later);
  assert.deepEqual([yes.text, yes.tag], ['DreamShaper 8 goes well with Wan 2.2 5B (styles Photo)', 'Seen']);
  assert.match(yes.hover, /^Seen: kept 1 of 1 clip with Wan 2\.2 5B \(Photo kept 1 of 1\)\.$/);
  const v0 = P.videoLine(video, soon);
  assert.deepEqual([v0.text, v0.tag], ['Starts best from pictures in Photo, Cinematic and Chinese drama (realistic)', 'Expected']);
  const v1 = P.videoLine(video, later);
  assert.deepEqual([v1.text, v1.tag], ['Starts best from pictures in Photo, drawn by DreamShaper 8', 'Seen']);
});

test('a linked PC\'s picture model is matched by its name; clips that all went badly say so', () => {
  let f = P.emptyPairing();
  const there = P.factsOfPicture({ id: 'p9', model: 'remote', modelName: 'Juggernaut XL (SDXL) on Worker', device: 'on Worker', style: 'cartoon' });
  f = P.withClip(f, there, { id: 'c1', at: at(0), model: 'wan22-5b' });
  f = P.withDeleted(f, ['c1'], new Date(T0 + 60_000))!;
  const rows = P.seenRows(f, T0 + DAY);
  const line = P.pictureLine({ key: 'juggernaut-xl', name: 'Juggernaut XL (SDXL)' }, { id: 'wan22-5b', name: 'Wan 2.2 5B' }, rows);
  assert.deepEqual([line.text, line.tag], ['Juggernaut XL has not gone well with Wan 2.2 5B yet', 'Seen']);
  assert.match(line.hover, /kept 0 of 1 clip/);
});

test('the server notes clips, keeps and deletes, and the pages show the lines', () => {
  const clips = read('src/server/clips.ts');
  assert.match(clips, /noteClip\(clip\)/);
  assert.match(clips, /noteDeleted\(gone\)/);
  assert.match(read('src/server/shots.ts'), /noteKept\(r\.kept, r\.takes\.map/);
  const server = read('src/server/pairing.ts');
  assert.match(server, /join\(HOME\.data, 'pairing\.json'\)/);
  assert.match(server, /updateData/, 'written whole, in turn');
  assert.match(server, /'\/api\/pairing\/start'/);
  assert.match(server, /'\/api\/pairing\/lines'/);
  assert.match(read('src/server.ts'), /pairingGet/);
  assert.match(read('src/server/stylesamples.ts'), /gallery\.update\(pic\.id, \{ style: r\.style \}\)/);
  assert.match(read('src/images.ts'), /\.\.\.\(job\.style \? \{ style: job\.style \} : \{\}\)/);
  const pick = read('public/stylepick.js');
  assert.match(pick, /style-video/);
  assert.match(pick, /For video: \$\{fit\.hover\}/);
  const hire = read('public/hire.js');
  assert.match(hire, /\/api\/pairing\/lines/);
  assert.match(hire, /modelsOf\('video', true\)/, 'picture lines only for video models installed');
  assert.match(hire, /pairs\?\.videos\?\.\[modelKey\(c\)\]/);
  const clipsPage = read('public/clips.js');
  assert.match(clipsPage, /\/api\/pairing\/start\?/);
  assert.match(clipsPage, /clip-start-drift/);
  const css = read('public/style.css');
  assert.match(css, /\.style-tile \.style-video\.drifts \{ color: var\(--warn\); \}/);
  assert.match(css, /\.hs-pair \{[^}]*font-size: var\(--fs-xs\)/);
  for (const f of ['public/stylepick.js', 'public/hire.js', 'public/clips.js', 'src/pairing.ts', 'src/server/pairing.ts']) assert.doesNotMatch(read(f), /#[0-9a-f]{6}\b/i, `${f}: colours named in words`);
});
