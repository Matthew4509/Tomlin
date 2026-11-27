// The Voice routes (src/server/voice.ts) in a throwaway TOMLIN home, with the pretend engine (test/fakevoice.ts): Speak
// writes a WAV onto the Voice shelf and hands it to the project hook, the shelf lists and serves it (whole and in
// parts), one voice-over is read at a time, a fault is said plainly, Delete removes the file, and with no engine set
// the voice model (not downloaded in this home) is asked for. No real model is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { useTestEnv } from './env.ts';
import { FakeVoiceEngine } from './fakevoice.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-voiceroute-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');

const { voiceGet, voicePost, voiceFile, voiceHooks, voiceShelf, setVoiceEngine } = await import('../src/server/voice.ts');

const call = async (routes: any, path: string, b: unknown = {}, url?: URL) => {
  let status = 0;
  let body: any;
  const res = {
    writeHead(s: number) { status = s; return this; },
    end(x: string) { body = JSON.parse(String(x)); },
  };
  await routes[path]({ res, b, url: url ?? new URL(`http://x${path}`) });
  return { status, body };
};

/** GET /api/voice/file/...: the status, headers and every byte sent. */
const fetchFile = async (rel: string, range?: string) => {
  const res = Object.assign(new PassThrough(), {
    status: 0,
    head: {} as Record<string, unknown>,
    writeHead(s: number, h: Record<string, unknown>) { this.status = s; this.head = h; return this; },
  });
  const bits: Buffer[] = [];
  res.on('data', (c: Buffer) => bits.push(c));
  const done = new Promise(r => res.on('end', r));
  const req = { headers: range ? { range } : {} };
  const answered = await voiceFile(req as never, res as never, `/api/voice/file/${rel}`);
  await done;
  return { answered, status: res.status, head: res.head, bytes: Buffer.concat(bits) };
};

test.after(() => {
  setVoiceEngine(null);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

test('with no engine set, Speak asks for the voice model (it is listed, not downloaded in this home)', async () => {
  setVoiceEngine(null);
  const o = await call(voiceGet, '/api/voice/options');
  assert.equal(o.status, 200);
  assert.equal(o.body.ready, false);
  assert.equal(o.body.model.id, 'kokoro-82m');
  assert.equal(o.body.model.installed, false);
  assert.ok(o.body.model.bytes > 90 * 2 ** 20 && o.body.model.bytes < 100 * 2 ** 20);
  assert.equal(o.body.voices.length, 8);
  const r = await call(voicePost, '/api/voice/speak', { text: 'Hello.' });
  assert.equal(r.status, 409);
  assert.equal(r.body.needModel, true);
  assert.match(r.body.error, /Get the voice model/);
});

test('Speak writes a WAV on the Voice shelf, hands it to the project hook, and the shelf lists and serves it', async () => {
  const e = new FakeVoiceEngine();
  setVoiceEngine(e);
  const handed: { text: string; file: string; there: boolean }[] = [];
  voiceHooks.made = async (v, file) => void handed.push({ text: v.text, file, there: existsSync(file) });
  const o = await call(voiceGet, '/api/voice/options');
  assert.equal(o.body.ready, true);
  const r = await call(voicePost, '/api/voice/speak', { text: 'The tide comes in.\nThe gulls cry.', voice: 'af_bella', speed: 0.9, chat: 'no-such-chat' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.item;
  assert.equal(v.voice, 'af_bella');
  assert.equal(v.speed, 0.9);
  assert.equal(v.chat, '', 'a chat that is not here is not kept');
  assert.match(v.file, /^\d{4}-\d{2}\/voice-[0-9a-f]{12}\.wav$/);
  assert.equal(e.asked.length, 2);
  const path = join(voiceShelf.dir, v.file);
  const wav = readFileSync(path);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.length, v.bytes);
  assert.ok(v.seconds > 0.6, 'the pause between the lines is in it');
  assert.deepEqual(handed, [{ text: 'The tide comes in.\nThe gulls cry.', file: path, there: true }]);
  const list = await call(voiceGet, '/api/voice/shelf');
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, v.id);
  const q = await call(voiceGet, '/api/voice/shelf', {}, new URL('http://x/api/voice/shelf?q=gulls%20tide'));
  assert.equal(q.body.total, 1);
  const none = await call(voiceGet, '/api/voice/shelf', {}, new URL('http://x/api/voice/shelf?q=elephant'));
  assert.equal(none.body.total, 0);
  const whole = await fetchFile(v.file);
  assert.equal(whole.status, 200);
  assert.equal(whole.head['content-type'], 'audio/wav');
  assert.deepEqual(whole.bytes, wav);
  const part = await fetchFile(v.file, 'bytes=0-43');
  assert.equal(part.status, 206);
  assert.deepEqual(part.bytes, wav.subarray(0, 44));
  voiceHooks.made = null;
});

test('only files the shelf wrote are served', async () => {
  const bad = await fetchFile('..%2F..%2Fsettings.json');
  assert.equal(bad.answered, true);
  assert.equal(bad.status, 404, 'not found, nothing streamed');
  assert.match(bad.bytes.toString(), /not on the shelf/);
  assert.equal((await voiceShelf.file('2026-11/other.wav')), null);
});

test('one voice-over at a time; a fault in the engine is said and nothing is kept', async () => {
  let release: (() => void) | null = null;
  const slow = new FakeVoiceEngine();
  const said = slow.say.bind(slow);
  slow.say = async (t, v, s) => {
    await new Promise<void>(r => (release = r));
    return said(t, v, s);
  };
  setVoiceEngine(slow);
  const first = call(voicePost, '/api/voice/speak', { text: 'Wait for me.' });
  for (let i = 0; i < 500 && !release; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(release, 'the engine was asked');
  const second = await call(voicePost, '/api/voice/speak', { text: 'Me too.' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /being read now/);
  (release as (() => void) | null)?.();
  assert.equal((await first).status, 200);
  const before = (await call(voiceGet, '/api/voice/shelf')).body.total;
  const broken = new FakeVoiceEngine();
  broken.fail = 'out of memory';
  setVoiceEngine(broken);
  const r = await call(voicePost, '/api/voice/speak', { text: 'This breaks.' });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /could not read that: out of memory/);
  assert.equal((await call(voiceGet, '/api/voice/shelf')).body.total, before);
  // And no words at all.
  setVoiceEngine(new FakeVoiceEngine());
  assert.equal((await call(voicePost, '/api/voice/speak', { text: '...' })).status, 400);
  assert.equal((await call(voicePost, '/api/voice/speak', { text: '' })).status, 400);
});

test('Delete removes the voice-over and its file', async () => {
  const list = await call(voiceGet, '/api/voice/shelf');
  const v = list.body.items[0];
  const path = join(voiceShelf.dir, v.file);
  assert.ok(existsSync(path));
  assert.equal((await call(voicePost, '/api/voice/delete', { id: v.id })).status, 200);
  assert.ok(!existsSync(path));
  assert.equal((await call(voicePost, '/api/voice/delete', { id: v.id })).status, 404);
  assert.equal((await call(voiceGet, '/api/voice/shelf')).body.total, list.body.total - 1);
});
