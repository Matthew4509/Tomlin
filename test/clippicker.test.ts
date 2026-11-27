// Start from a picture, in a Videographer's chat in a project (F7): This project lists the Artists' pictures
// (specialists\images), and the Characters and Locations tabs each card's own pictures (specialists\characters\<Name>,
// specialists\locations\<Name>), which a clip may start from. Run in a throwaway home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestEnv } from './env.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-clippicker-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');
const { chats, workspaceDir } = await import('../src/server/core.ts');
const { clipsGet, startChosen } = await import('../src/server/clips.ts');
(await import('../src/server/jobs.ts')).startJobs();

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

const call = async (routes: any, path: string, url: URL) => {
  let status = 0;
  let body: any;
  const res = { writeHead(s: number) { status = s; return res; }, end(x: string) { body = JSON.parse(String(x)); } };
  await routes[path]({ res, b: null, url });
  return { status, body };
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=', 'base64');

test('a project chat\'s picker offers its characters\' and locations\' pictures, and a clip can start from one', async () => {
  const ws = await workspaceDir();
  const id = '20261128-0300-ab12';
  mkdirSync(join(ws, 'jobs', id), { recursive: true });
  const at = '2026-11-28T03:00:00.000Z';
  writeFileSync(join(ws, 'jobs', id, 'plan.json'), JSON.stringify({ id, goal: 'A fox film', folder: 'Fox film', created: at, updated: at, notes: '', steps: [] }));
  const card = (kind: string, name: string, files: string[]) => {
    const dir = join(ws, 'Fox film', 'specialists', kind === 'character' ? 'characters' : 'locations', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'card.json'), JSON.stringify({ kind, name, words: 'a red fox', avoid: '', refs: [], at }));
    for (const f of files) writeFileSync(join(dir, f), PNG);
  };
  card('character', 'Ember', ['front.png', 'side.png', 'notes.txt']);
  card('location', 'Pine forest', ['dusk.png']);
  mkdirSync(join(ws, 'Fox film', 'specialists', 'images'), { recursive: true });
  writeFileSync(join(ws, 'Fox film', 'specialists', 'images', '2026-11-28-0300 a fox.png'), PNG);
  const c = await chats.create('staff:v1');
  await chats.setProject(c.id, id);

  const r = await call(clipsGet, '/api/clips/project-pictures', new URL(`http://x/api/clips/project-pictures?chat=${c.id}`));
  assert.equal(r.status, 200);
  assert.equal(r.body.project, 'Fox film');
  assert.deepEqual(r.body.pictures.map((p: { name: string }) => p.name), ['2026-11-28-0300 a fox.png']);
  const byName = Object.fromEntries(r.body.cards.map((k: { kind: string; name: string; pictures: string[] }) => [k.name, { kind: k.kind, pictures: [...k.pictures].sort() }]));
  assert.deepEqual(byName, {
    Ember: { kind: 'character', pictures: ['Fox film/specialists/characters/Ember/front.png', 'Fox film/specialists/characters/Ember/side.png'] },
    'Pine forest': { kind: 'location', pictures: ['Fox film/specialists/locations/Pine forest/dusk.png'] },
  });
  // The tile the page makes is a start picture the server reads.
  const got = await startChosen({ startFrom: { project: byName.Ember.pictures[0] }, startName: 'Ember' });
  assert.ok(got && !('error' in got), JSON.stringify(got));
  assert.deepEqual(got.png, PNG);

  // A chat with no project has no cards to offer.
  const plain = await chats.create('staff:v1');
  const none = await call(clipsGet, '/api/clips/project-pictures', new URL(`http://x/api/clips/project-pictures?chat=${plain.id}`));
  assert.deepEqual(none.body, { project: null, pictures: [], cards: [] });
});

test('the picker has Characters and Locations tabs that list each card\'s pictures under its name', () => {
  const js = readFileSync(join(import.meta.dirname, '..', 'public', 'clips.js'), 'utf8');
  assert.match(js, /\['character', 'Characters'\], \['location', 'Locations'\]/);
  assert.match(js, /if \(tab === 'character' \|\| tab === 'location'\)/);
  assert.match(js, /\{ from: \{ project: p \}, src: projectUrl\(p\) \}, k\.name\)/);
});

test('a clip started from a picture in a project chat opens the Videographer\'s chat in that same project (F8)', () => {
  const root = join(import.meta.dirname, '..', 'public');
  const clips = readFileSync(join(root, 'clips.js'), 'utf8');
  const chatsJs = readFileSync(join(root, 'chats.js'), 'utf8');
  const from = clips.slice(clips.indexOf('app.clipFromPicture = async'), clips.indexOf('async function carryOn'));
  // The project is read before any chat changes, and handed on for one Videographer or a pick of several.
  assert.match(from, /const project = app\.chatProject\?\.\(\) \?\? '';[\s\S]*intoVideographer\(team\[0\]\.who, pick, name, '', project\)[\s\S]*intoVideographer\(p\.who, pick, name, '', project\)/);
  assert.match(clips, /async function intoVideographer\(who, pick, name = '', prompt = '', project = ''\) \{\s*await app\.openVideographer\(who, project\);/);
  // Their latest chat in that project, else a new one made in it.
  assert.match(chatsJs, /c\.who === who && \(!project \|\| c\.project === project\)/);
  assert.match(chatsJs, /api\('\/api\/chats\/new', \{ who, plain: plainWho\(\), \.\.\.\(project \? \{ project \} : \{\}\) \}\)/);
  assert.match(chatsJs, /app\.chatProject = \(\) => chatUi\.open\?\.project \?\? '';/);
});
