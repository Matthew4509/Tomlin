// Which pictures make good starts for video, through the routes in a throwaway TOMLIN home: a clip made (with the
// pretend runner, test/fakeclip.ts) from a gallery picture that says its model and style is noted in data/pairing.json
// with those facts only, made again from it counts as made again, a file says nothing so its facts stay not known,
// deleting is noted, and the start warning and the lines come back plain. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Picture } from '../src/gallery.ts';
import { useTestEnv } from './env.ts';
import { FakeVideoRunner } from './fakeclip.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-pairing-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');

const { staff, HOME } = await import('../src/server/core.ts');
const { setVideoRunner, clipsPost, clips } = await import('../src/server/clips.ts');
const { pairingGet, pairingPost, startFactsOf } = await import('../src/server/pairing.ts');
const { images } = await import('../src/server/panes.ts');
setVideoRunner(new FakeVideoRunner({ fps: 2 }));

const call = async (routes: any, path: string, b: unknown, url?: URL) => {
  let status = 0;
  let body: any;
  const res = { writeHead(s: number) { status = s; return res; }, end(x: string) { body = JSON.parse(String(x)); } };
  await routes[path]({ res, b, url: url ?? new URL(`http://x${path}`) });
  return { status, body };
};
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) {
    if (ok()) return;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error(`never: ${what}`);
};
const notes = () => JSON.parse(readFileSync(join(HOME.data, 'pairing.json'), 'utf8')).clips as any[];

// A small real PNG (8 by 8, one colour).
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=', 'base64');

async function picture(id: string, extra: Partial<Picture> = {}): Promise<Picture> {
  const output = await images.gallery.save(`${id}.png`, png);
  const p: Picture = {
    id, at: new Date().toISOString(), prompt: `a fox ${id}`, modelPrompt: '', negative: '', mode: 'custom', model: 'dreamshaper-8', modelName: 'DreamShaper 8 (SD 1.5)', seed: 1, steps: 4, cfg: 1,
    sampler: 'lcm', generated: { width: 8, height: 8 }, target: { width: 8, height: 8 }, fit: 'crop', device: 'cpu', seconds: 1,
    draft: false, original: output, output, format: 'png', bytes: png.length, kept: true, ...extra,
  };
  await images.gallery.add(p);
  return p;
}

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

test('clips made from start pictures are noted with the facts the pictures give, and nothing more', async () => {
  const vic = await staff.hire('Vic Example', 'videographer', 'default', 'wan22-ti2v-5b');
  const who = `staff:${vic.id}`;
  const anime = await picture('anime1', { style: 'anime' });
  const plain = await picture('plain1');

  // The warning for a picture in a style that drifts; none for one that does not say its style.
  let r = await call(pairingGet, '/api/pairing/start', null, new URL(`http://x/api/pairing/start?gallery=${anime.id}`));
  assert.equal(r.body.style, 'anime');
  assert.equal(r.body.warning, 'This picture is in Anime: video models tend to pull it toward real life, so faces may change. A Photo or Cinematic still holds better.');
  r = await call(pairingGet, '/api/pairing/start', null, new URL(`http://x/api/pairing/start?gallery=${encodeURIComponent(plain.output)}`));
  assert.deepEqual([r.body.style, r.body.warning], [null, '']);

  const make = async (b: Record<string, unknown>) => {
    const m = await call(clipsPost, '/api/clips/make', { who, prompt: 'the fox looks up', seconds: 1, size: 'square', quality: 'draft', ...b });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    await until(() => clips.view(m.body.job.id)?.state === 'done', 'the clip is made');
    return { chat: m.body.chat as string, clip: clips.view(m.body.job.id)!.clip! };
  };
  const one = await make({ chatId: '', startFrom: { gallery: anime.id } });
  let n = notes();
  assert.equal(n.length, 1);
  assert.deepEqual({ ...n[0], at: '' }, { clip: one.clip.id, at: '', start: `gallery:${anime.id}`, pictureModel: 'dreamshaper-8', pictureName: 'DreamShaper 8', style: 'anime', video: one.clip.model, again: false });

  // Made again from the same picture: counted as made again.
  const two = await make({ chatId: one.chat, startFrom: { gallery: anime.id } });
  n = notes();
  assert.equal(n.find(x => x.clip === two.clip.id).again, true);

  // A picture from a file says nothing: its facts stay not known.
  const three = await make({ chatId: one.chat, start: `data:image/png;base64,${png.toString('base64')}` });
  const f = notes().find(x => x.clip === three.clip.id);
  assert.deepEqual([f.pictureModel, f.pictureName, f.style, f.again], [null, null, null, false]);

  // A clip with no start picture is not noted.
  await make({ chatId: one.chat });
  assert.equal(notes().length, 3);

  // Deleted: noted with when.
  r = await call(clipsPost, '/api/clips/delete', { id: one.clip.id });
  assert.equal(r.status, 200);
  assert.ok(notes().find(x => x.clip === one.clip.id).deletedAt);

  // The facts of a gallery picture's file, found by its path.
  const facts = await startFactsOf(join(images.gallery.dir, anime.output));
  assert.equal(facts.style, 'anime');
  assert.equal((await startFactsOf(join(home, 'nowhere.png'))).pictureModel, null);

  // The lines: the clip deleted within the day is counted (not kept); the others are too new to tell.
  r = await call(pairingPost, '/api/pairing/lines', { pictures: [{ key: 'dreamshaper-8', name: 'DreamShaper 8 (SD 1.5)' }], videos: [{ id: one.clip.model, name: 'Wan 2.2 5B' }] });
  const [line] = r.body.pictures['dreamshaper-8'];
  assert.equal(line.tag, 'Seen');
  assert.equal(line.text, 'DreamShaper 8 has not gone well with Wan 2.2 5B yet');
  assert.match(line.hover, /^Seen: kept 0 of 1 clip with Wan 2\.2 5B \(Anime kept 0 of 1\); 1 made again from the same picture\.$/);
  assert.equal(r.body.videos[one.clip.model].tag, 'Seen');
});
