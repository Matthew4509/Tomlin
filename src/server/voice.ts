// Voice-overs: lines typed are read aloud on this PC (src/voice.ts, Kokoro 82M on the CPU) and kept on the Voice shelf
// (src/gallery.ts VoiceShelf, data/voice), and one made from a project's chat is copied into that project. The voice
// model is a helper in the picture registry (registry/kokoro-82m.json), downloaded as other helpers are. Tests set a
// pretend engine with setVoiceEngine (test/fakevoice.ts).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SPEEDS, TEXT_MAX, VOICES, VOICE_MODEL_ID, cleanSpeak, kokoroEngine, speak, speechPlan, wavFile, type VoiceEngine } from '../voice.ts';
import { VoiceShelf, type VoiceRecord } from '../gallery.ts';
import { freeOn } from '../lowdisk.ts';
import { images } from './panes.ts';
import { HOME, SECURITY_HEADERS, type Routes, chats, decoded, json } from './core.ts';

export const voiceShelf = new VoiceShelf(join(HOME.data, 'voice'));

/** Set by src/server.ts: a voice-over made from a project's chat is copied into that project (src/server/places.ts). */
export const voiceHooks: { made: ((v: VoiceRecord, file: string) => Promise<void>) | null } = { made: null };

/** Under this much free space where voice-overs are kept, none is made. */
const LOW_BYTES = 200 * 2 ** 20;

let engineSet: VoiceEngine | null = null;
/** The engine voice-overs are read with: a pretend one in tests; null goes back to Kokoro. */
export function setVoiceEngine(e: VoiceEngine | null): void {
  engineSet = e;
}

let kokoro: { key: string; engine: VoiceEngine } | null = null;
/** Kokoro on its downloaded files, or why it cannot read now. */
function engineNow(): VoiceEngine | string {
  if (engineSet) return engineSet;
  const reg = images.registry;
  const m = reg.get(VOICE_MODEL_ID);
  if (!m) return 'This copy of TOMLIN does not list the voice model.';
  if (!reg.installed(m)) return 'The voice model is not on this PC yet: press Get the voice model first.';
  const model = m.files.find(f => f.role === 'onnx');
  if (!model) return 'The voice model\'s list of files has no model file.';
  const key = reg.filePath(m, model);
  if (kokoro?.key !== key) {
    kokoro = {
      key,
      engine: kokoroEngine({
        model: key,
        voice: id => {
          const f = m.files.find(x => x.role === 'voice' && x.name === id);
          return f ? reg.filePath(m, f) : null;
        },
      }),
    };
  }
  return kokoro.engine;
}

/** The voice model as the panel shows it: here or not, its size, and its download when one is running. */
function modelView() {
  const reg = images.registry;
  const m = reg.get(VOICE_MODEL_ID);
  if (!m) return null;
  return { id: m.id, name: m.name, licence: m.licence, bytes: reg.bytes(m), installed: reg.installed(m), download: reg.download(m.id) ?? null };
}

/** One voice-over at a time: Kokoro uses every CPU core it is given. */
let reading = false;

async function speakRoute(res: ServerResponse, b: Record<string, unknown>) {
  const ask = cleanSpeak(b);
  if ('error' in ask) return json(res, 400, { error: ask.error });
  const engine = engineNow();
  if (typeof engine === 'string') return json(res, 409, { error: engine, needModel: true });
  if (reading) return json(res, 409, { error: 'A voice-over is being read now. Wait for it to finish, then press Speak again.' });
  const plan = speechPlan(ask.text);
  if (!plan.length) return json(res, 400, { error: 'There are no words in that to read. Type a line of words.' });
  // Taken before anything is waited for: presses that arrive together each saw "not reading" while the first was
  // still checking the free space, and all were read at once.
  reading = true;
  try {
    const free = await freeOn(voiceShelf.dir).then(f => f ?? freeOn(HOME.data));
    if (free !== null && free < LOW_BYTES) return json(res, 507, { error: 'There is almost no free space where voice-overs are kept. Free some space, then try again.' });
    // The chat it was made from: kept only when it is a chat here (a project's chat hands the WAV in to its project).
    const asked = typeof b.chat === 'string' ? b.chat.slice(0, 80) : '';
    const chat = asked && (await chats.get(asked).catch(() => null)) ? asked : '';
    return await readAloud(res, ask, plan, engine, chat);
  } finally {
    reading = false;
  }
}

async function readAloud(res: ServerResponse, ask: { text: string; voice: string; speed: number }, plan: ReturnType<typeof speechPlan>, engine: VoiceEngine, chat: string) {
  const started = Date.now();
  try {
    const samples = await speak(plan, engine, ask.voice, ask.speed);
    if (!samples.length) return json(res, 500, { error: 'The voice gave back no sound. Try again; if it happens again, download the voice model again on the Models page.' });
    const wav = wavFile(samples, engine.rate);
    const id = randomBytes(6).toString('hex');
    const file = await voiceShelf.save(wav, `voice-${id}.wav`);
    const v: VoiceRecord = { id, at: new Date().toISOString(), text: ask.text, voice: ask.voice, speed: ask.speed, seconds: Math.round((samples.length / engine.rate) * 10) / 10, file, bytes: wav.length, tookMs: Date.now() - started, chat };
    await voiceShelf.add(v);
    await voiceHooks.made?.(v, join(voiceShelf.dir, file)).catch(e => console.warn(`A voice-over could not be copied to its project: ${(e as Error).message}`));
    return json(res, 200, { item: v });
  } catch (e) {
    return json(res, 500, { error: `The voice could not read that: ${(e as Error).message.replace(/\.$/, '')}. Try again.` });
  }
}

export const voiceGet: Routes = {
  // The voices, speeds and the voice model (here or not, its download).
  '/api/voice/options': async ({ res }) => json(res, 200, { ready: !!engineSet || !!modelView()?.installed, reading, model: modelView(), voices: VOICES, speeds: SPEEDS, textMax: TEXT_MAX }),
  // The Voice shelf, newest first: ?chat= for one chat's, ?q= for words in the text.
  '/api/voice/shelf': async ({ res, url }) => {
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(200, Number(url.searchParams.get('limit')) || 60);
    const chat = url.searchParams.get('chat');
    return json(res, 200, await voiceShelf.list(offset, limit, (url.searchParams.get('q') ?? '').slice(0, 200), chat === null ? undefined : chat.slice(0, 80)));
  },
};

export const voicePost: Routes = {
  // {text, voice, speed, chat}: the lines read aloud, the WAV kept on the Voice shelf (and in the chat's project).
  '/api/voice/speak': ({ res, b }) => speakRoute(res, b),
  // {id} or {ids: [...]}: voice-overs deleted from the shelf, their files from this PC.
  '/api/voice/delete': async ({ res, b }) => {
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).slice(0, 500).map(x => String(x ?? '').slice(0, 40)).filter(Boolean);
    let deleted = 0;
    for (const id of ids) if (await voiceShelf.remove(id)) deleted++;
    return deleted || !ids.length ? json(res, 200, { ok: true, deleted }) : json(res, 404, { error: 'That voice-over is not on the shelf any more.' });
  },
};

/** GET /api/voice/file/<month>/<name>: a WAV from the shelf, in parts when the player asks for a range. */
export async function voiceFile(req: IncomingMessage, res: ServerResponse, p: string): Promise<boolean> {
  const m = /^\/api\/voice\/file\/(.+)$/.exec(p);
  if (!m) return false;
  const rel = decoded(m[1]);
  const path = rel === null ? null : await voiceShelf.file(rel);
  const size = path ? await stat(path).then(s => s.size, () => -1) : -1;
  if (!path || size < 0) return json(res, 404, { error: 'That voice-over is not on the shelf any more.' }), true;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const head = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', ...SECURITY_HEADERS, 'cache-control': 'no-store' };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}`, ...SECURITY_HEADERS });
      return res.end(), true;
    }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...head, 'content-length': size });
  createReadStream(path).pipe(res);
  return true;
}
