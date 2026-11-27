// The shot list's routes (src/server/shots.ts) in a throwaway TOMLIN home: the first shot makes the Videographer's
// chat, shots are changed and made in order on this PC with the pretend runner (test/fakeclip.ts), a start picture from
// a file is kept and served and the clip starts from it, a shot carrying on waits for the page to send the last frame of
// the shot before, the list is in data/shots.json, and only a Videographer has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { useTestEnv } from './env.ts';
import { FakeVideoRunner } from './fakeclip.ts';
import type { VideoJob, VideoProgress } from '../src/videotypes.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-shotsroute-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');

const { staff, HOME } = await import('../src/server/core.ts');
const { setVideoRunner } = await import('../src/server/clips.ts');
const { shotsGet, shotsPost, shots } = await import('../src/server/shots.ts');
const { WAIT_PAGE } = await import('../src/shots.ts');

/** The pretend runner, noting each clip's start picture while it is made (the fitted copy goes once the clip ends). */
class Watched extends FakeVideoRunner {
  readonly starts: Array<{ prompt: string; start: string | null; there: boolean; png: boolean }> = [];
  override async make(job: VideoJob, on: (p: VideoProgress) => void, signal: AbortSignal) {
    const p = job.startPicture ?? null;
    this.starts.push({ prompt: job.prompt, start: p, there: !!p && existsSync(p), png: !!p && readFileSync(p).subarray(1, 4).toString() === 'PNG' });
    return super.make(job, on, signal);
  }
}
const runner = new Watched({ fps: 2 });
setVideoRunner(runner);

const call = async (routes: any, path: string, b: unknown, url?: URL) => {
  let status = 0;
  let body: any;
  let raw: Buffer | null = null;
  let type = '';
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; type = h?.['content-type'] ?? ''; return this; },
    end(x: string | Buffer) { if (type.startsWith('image/')) raw = Buffer.from(x); else body = JSON.parse(String(x)); },
  };
  await routes[path]({ res, b, url: url ?? new URL(`http://x${path}`) });
  return { status, body, raw, type };
};
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) {
    if (ok()) return;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error(`never: ${what}`);
};

// A small real PNG (8 by 8, one colour).
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
// A last frame with a picture in it (a flat one is blank and refused: src/colourmatch.ts isBlank).
const framePng = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 40, b: 60 } } })
  .composite([{ input: Buffer.from('<svg width="8" height="8"><rect width="4" height="8" fill="#f0e0d0"/></svg>') }]).png().toBuffer();
const frameUrl = `data:image/png;base64,${framePng.toString('base64')}`;
const blackUrl = `data:image/png;base64,${(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()).toString('base64')}`;

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

test('a Videographer\'s shot list through its routes, with start pictures', async () => {
  const vic = await staff.hire('Vic Example', 'videographer', 'default', 'wan22-ti2v-5b');
  const who = `staff:${vic.id}`;
  // The first shot makes the chat.
  const a = await call(shotsPost, '/api/shots/add', { chatId: '', who, prompt: 'a lighthouse at dusk', seconds: 2, size: 'wide', quality: 'draft' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const chat = a.body.chat;
  assert.ok(chat);
  assert.equal(a.body.list.top, '1 shot · 2 s of video · time not known yet on this PC');
  const b = await call(shotsPost, '/api/shots/add', { chatId: chat, prompt: 'the beam sweeps the sea', seconds: 1, size: 'tall', quality: 'draft', start: { kind: 'last' } });
  assert.equal(b.status, 200);
  const [one, two] = b.body.list.shots;
  // Move, edit, a refusal said plainly.
  let r = await call(shotsPost, '/api/shots/move', { chatId: chat, id: two.id, to: 0 });
  assert.deepEqual(r.body.list.shots.map((s: any) => s.id), [two.id, one.id]);
  await call(shotsPost, '/api/shots/move', { chatId: chat, id: two.id, to: 1 });
  r = await call(shotsPost, '/api/shots/edit', { chatId: chat, id: one.id, prompt: '', seconds: 2 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /what the shot should show/);
  // A start picture from a file: kept as a PNG under its own name, served back, and a third shot starts from it.
  r = await call(shotsPost, '/api/shots/picture', { data: dataUrl });
  assert.equal(r.status, 200);
  const file = r.body.file;
  assert.match(file, /^[0-9a-f]{16}\.png$/);
  const pic = await call(shotsGet, '/api/shots/picture', {}, new URL(`http://x/api/shots/picture?f=${file}`));
  assert.equal(pic.type, 'image/png');
  assert.deepEqual(pic.raw, png);
  assert.equal((await call(shotsGet, '/api/shots/picture', {}, new URL('http://x/api/shots/picture?f=..%2Fshots.json'))).status, 404);
  assert.equal((await call(shotsPost, '/api/shots/picture', { data: 'data:image/jpeg;base64,/9j/' })).status, 400);
  r = await call(shotsPost, '/api/shots/add', { chatId: chat, prompt: 'a red door opens', seconds: 1, size: 'square', quality: 'draft', start: { kind: 'picture', file, name: 'red door' } });
  assert.equal(r.status, 200);
  // Run it: the first is made, then the list waits for the page to read its last frame.
  r = await call(shotsPost, '/api/shots/run', { chatId: chat, do: 'start' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => shots.get(chat)!.said === WAIT_PAGE, 'waiting for the last frame');
  const frames = (await call(shotsGet, '/api/shots/frames', {})).body.frames;
  const take = shots.get(chat)!.shots[0].takes[0];
  assert.deepEqual(frames, [{ chat, shot: two.id, clip: take.clip, file: take.file }]);
  assert.equal((await call(shotsPost, '/api/shots/frame', { chat, id: two.id, clip: 'nope', data: dataUrl })).status, 409);
  assert.equal((await call(shotsPost, '/api/shots/frame', { chat, id: two.id, clip: take.clip, data: 'data:text/html;base64,PGI+' })).status, 400);
  // A black frame (a hidden page's) is refused and the list keeps waiting; a real one is taken.
  r = await call(shotsPost, '/api/shots/frame', { chat, id: two.id, clip: take.clip, data: blackUrl });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /blank/);
  assert.notEqual(shots.get(chat)!.shots[1].frame?.clip, take.clip);
  r = await call(shotsPost, '/api/shots/frame', { chat, id: two.id, clip: take.clip, data: frameUrl });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Keep the colours of the first shot (on): shot 1 started from nothing, so this first frame is the list's reference.
  assert.equal(shots.get(chat)!.ref?.from, 'frame');
  assert.deepEqual(shots.get(chat)!.ref?.key, 'frame');
  await until(() => shots.get(chat)!.run === 'idle', 'the list ended');
  const end = await call(shotsGet, '/api/shots', {}, new URL(`http://x/api/shots?chat=${chat}`));
  assert.deepEqual(end.body.list.shots.map((s: any) => s.state), ['done', 'done', 'done'], JSON.stringify(end.body.list.shots.map((s: any) => s.error)));
  assert.equal(end.body.list.said, 'Done: 3 of 3 shots made.');
  // Each clip was asked with its start picture, a fitted PNG there while it was made; the first with none.
  assert.deepEqual(runner.starts.map(s => [s.prompt, !!s.start, s.there, s.png]), [['a lighthouse at dusk', false, false, false], ['the beam sweeps the sea', true, true, true], ['a red door opens', true, true, true]]);
  assert.ok(runner.starts.every(s => !s.start || !existsSync(s.start)), 'the fitted copies are gone');
  // The pictures kept for the list stay (a take made again starts from them again).
  assert.ok(existsSync(join(HOME.data, 'shots', 'pictures', file)));
  assert.equal(JSON.parse(readFileSync(join(HOME.data, 'shots.json'), 'utf8')).lists[chat].shots.length, 3);
  assert.equal((await call(shotsPost, '/api/shots/run', { chatId: chat, do: 'dance' })).status, 400);
  // A hire whose model makes clips from words only: a shot with a start picture fails with that line.
  const wes = await staff.hire('Wes Example', 'videographer', 'default', 'wan21-t2v-1.3b');
  const w = await call(shotsPost, '/api/shots/add', { chatId: '', who: `staff:${wes.id}`, prompt: 'a door', seconds: 1, quality: 'draft', start: { kind: 'picture', file, name: 'door' } });
  await call(shotsPost, '/api/shots/run', { chatId: w.body.chat, do: 'start' });
  await until(() => shots.get(w.body.chat)!.run === 'idle', 'the words-only list ended');
  assert.match(shots.get(w.body.chat)!.shots[0].error ?? '', /makes clips from words only/);
  // Only a Videographer has a shot list.
  const ari = await staff.hire('Ari Example', 'writer', 'default', 'made-up');
  const no = await call(shotsPost, '/api/shots/add', { chatId: '', who: `staff:${ari.id}`, prompt: 'x' });
  assert.equal(no.status, 400);
  assert.match(no.body.error, /Videographer/);
});
