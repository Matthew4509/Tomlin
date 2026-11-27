// A Videographer's shot list (src/shots.ts): the queue in the right panel of their chat. Each shot's clip is asked of
// the same clips as Make clip (src/server/clips.ts), so it waits its turn on the hire's PC and lands on the Videos shelf.
// A shot's start picture is made ready as Make clip's is (fitStart): a picture kept for the list, one in the gallery or
// a project, or the last frame of the shot before, read here from the clip (its frames are VP8 key frames, which sharp
// reads as WebP: framesHere) or, when that cannot be done, by an open page. A blank frame is never carried on from. That
// frame is matched to the colours of the first shot unless the list has it turned off (src/colourmatch.ts).
// The list is kept in data/shots.json and carries on after TOMLIN restarts; it looks at every list once a second.
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../atomic.ts';
import { isVideographer, progressLine, startFromPage } from '../clips.ts';
import { namedChat } from '../chats.ts';
import sharp from 'sharp';
import { blankFrame, carryFrame } from '../colourmatch.ts';
import { keepAwakeHolder } from '../keepawake.ts';
import { fitTo } from '../imaging.ts';
import { PICTURE_NAME, Shots, TAKES, type RefSource, type ShotList, type StartPictures, type Take } from '../shots.ts';
import type { ClipRecord } from '../gallery.ts';
import { type JoinPart, joinWebm, lastFrameWebp } from '../webmjoin.ts';
import { HOME, SECURITY_HEADERS, type Routes, chats, json, staff, store } from './core.ts';
import { expandForChat } from './cards.ts';
import { clipHooks, clipShelf, clips, fitStart, startChosen, startInto } from './clips.ts';
import { chatGone, chatPersonHere, chatToSend, clipModelOf, sendTarget } from './people.ts';
import { noteKept } from './pairing.ts';

const PICTURES = join(HOME.data, 'shots', 'pictures');
const NOT_HERE = 'That start picture is not on this PC any more. Pick it again.';

/** A shot's start picture: read (a kept PNG, or one already on this PC), fitted to the clip, kept with it once made. */
export const startPictures: StartPictures = {
  async give(ask, from) {
    let chosen: { png: Buffer; file: string; name: string };
    if ('kept' in from) {
      const file = join(PICTURES, from.kept);
      const png = PICTURE_NAME.test(from.kept) ? await readFile(file).catch(() => null) : null;
      if (!png) return { refused: NOT_HERE };
      chosen = { png, file, name: from.name || 'start frame' };
    } else {
      const got = await startChosen({ startFrom: from.from, startName: from.name });
      if (!got) return { refused: NOT_HERE };
      if ('error' in got) return { refused: got.error };
      chosen = got;
    }
    const fit = await fitStart(chosen, ask, ask.model);
    if ('error' in fit) return { refused: fit.error };
    await startInto(fit.start, ask.chat);
    return { ask: { ...ask, startPicture: fit.startPicture, start: fit.start } };
  },
};

/** Pictures kept for the list that no shot uses any more: removed, unless a clip on the shelf started from one. */
async function dropPictures(names: string[]): Promise<void> {
  const used = new Set((await clipShelf.all()).filter(c => !c.removed && c.start?.path).map(c => c.start!.path));
  for (const n of names) {
    const file = join(PICTURES, n);
    if (PICTURE_NAME.test(n) && !used.has(file)) await rm(file, { force: true }).catch(() => undefined);
  }
}

export const shots = await Shots.load({
  file: join(HOME.data, 'shots.json'), clips, starts: startPictures,
  // The named cards' words to leave out go into each shot's negative prompt, as for a picture.
  expand: async (prompt, chat) => {
    const e = await expandForChat(prompt, chat);
    return { prompt: e.prompt, avoid: e.avoid };
  },
  exists: async clip => !!(await clipShelf.get(clip)),
  dropPictures,
});
shots.turn();
setInterval(() => shots.turn(), 1000).unref();

// A deleted chat takes its shot list with it, and its clips stop: nothing more is made or written for it.
chatGone.push(async chat => {
  clips.dropChat(chat);
  await shots.dropChat(chat);
});

type Hire = Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'>;

/** The Videographer a chat is with, their PC and model now (as Make clip finds them). */
function hireOf(who: string): Hire | { error: string } {
  const member = who.startsWith('staff:') ? staff.get(who.slice(6)) : undefined;
  if (!member || !isVideographer(member)) return { error: 'A shot list is a Videographer\'s: open their chat and add the shots there.' };
  const { model, pc } = clipModelOf(member);
  const pcName = pc === 'here' ? 'this PC' : store.peek()?.remotes.find(r => r.id === pc)?.name ?? 'the linked PC';
  return { who, name: member.name.split(/\s+/)[0], pc, pcName, model };
}

/** The chat named and its hire; `make`: a new chat is made for the first shot. */
async function chatOf(b: Record<string, unknown>, make = false): Promise<{ chat: string; hire: Hire } | { error: string; status: number }> {
  const named = namedChat(b, make);
  if ('error' in named) return { error: named.error, status: 400 };
  const to = await sendTarget(named);
  if ('error' in to) return to;
  if (to.chat && !chatPersonHere(to.chat.who)) return { error: 'The person in this chat is no longer on the team, so its shot list can be read but not carried on.', status: 400 };
  const hire = hireOf(to.who);
  if ('error' in hire) return { ...hire, status: 400 };
  if (to.chat) return { chat: to.chat.id, hire };
  const made = await chatToSend(to);
  await chats.rename(made.id, `Shot list: ${String(b.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 50)}`).catch(() => undefined);
  return { chat: made.id, hire };
}

const out = (chat: string) => shots.view(chat, v => progressLine(v));
const id = (b: Record<string, unknown>) => String(b.id ?? '').slice(0, 20);

/** For the changes to one shot: the chat, then `act`, then the list as it is now. */
const onShot = (act: (chat: string, b: Record<string, unknown>) => Promise<unknown>): Routes[string] => async ({ res, b }) => {
  const c = await chatOf(b);
  if ('error' in c) return json(res, c.status, { error: c.error });
  const r = await act(c.chat, b);
  if (r && typeof r === 'object' && 'refused' in r) return json(res, 400, { error: (r as { refused: string }).refused, list: out(c.chat) });
  return json(res, 200, { chat: c.chat, list: out(c.chat) });
};

/** A PNG kept for the shot list under a new name. */
async function keepPng(png: Buffer): Promise<string> {
  const name = `${randomBytes(8).toString('hex')}.png`;
  await writeAtomic(join(PICTURES, name), png);
  return name;
}

/** A PNG the page sent (a picture from a file, a clip's last frame), kept for the shot list under a new name. */
async function keepPicture(data: unknown): Promise<string | { error: string }> {
  const png = startFromPage(data);
  if (!png) return { error: 'No picture came with that.' };
  if ('error' in png) return png;
  return keepPng(png);
}

/** Shot 1's start picture as its clip took it (fitted to its size): the colours a list keeps. Null when it is gone. */
async function refPicture(s: RefSource): Promise<Buffer | null> {
  const p = s.picture;
  if (!p) return null;
  let png: Buffer | null = null;
  if ('kept' in p) png = PICTURE_NAME.test(p.kept) ? await readFile(join(PICTURES, p.kept)).catch(() => null) : null;
  else {
    const got = await startChosen({ startFrom: p.from, startName: p.name });
    png = got && !('error' in got) ? got.png : null;
  }
  return png ? fitTo(png, { width: s.width, height: s.height }, 'crop') : null;
}

/**
 * The last frame the page sent, kept: matched to the list's colours when it keeps them (the frame as read is kept too,
 * as `raw`), and the reference written into the list the first time.
 */
async function keepFrame(chat: string, png: Buffer): Promise<{ file: string; raw?: string }> {
  const raw = await keepPng(png);
  const c = shots.colourOf(chat);
  if (!c) return { file: raw };
  const got = await carryFrame(png, { ref: c.ref, key: c.source.key, picture: c.source.picture ? () => refPicture(c.source) : null });
  if (got.ref) await shots.setRef(chat, got.ref);
  return got.png ? { file: await keepPng(got.png), raw } : { file: raw };
}

/**
 * A clip's last frame, for the shot that carries on from it: refused when it is blank (a hidden page read black, 27 Nov),
 * else kept (colour matched as the list says) and set on the shot. 409 when the list moved on meanwhile.
 */
async function takeFrame(chat: string, shot: string, clip: string, png: Buffer): Promise<{ status: number; error?: string }> {
  if (!shots.carriesOn(chat, shot, clip)) return { status: 409, error: 'That shot no longer carries on from that clip.' };
  if (await blankFrame(png).catch(() => true)) return { status: 400, error: 'That last frame is blank (black or one flat colour), so the next shot does not start from it. It is read again.' };
  const kept = await keepFrame(chat, png);
  const r = await shots.setFrame(chat, shot, clip, kept.file, kept.raw);
  const drop = (names: Array<string | undefined>) => Promise.all(names.filter(Boolean).map(n => rm(join(PICTURES, n!), { force: true }).catch(() => undefined)));
  if ('refused' in r) {
    await drop([kept.file, kept.raw]);
    return { status: 409, error: r.refused };
  }
  await drop(r.old);
  return { status: 200 };
}

/**
 * The last frame of a clip on the Videos shelf, read here (src/webmjoin.ts lastFrameWebp: every frame is a VP8 key frame,
 * which sharp reads as a WebP picture) as a PNG; null when it cannot be (the page then reads it, as before).
 */
export async function lastFramePng(file: string): Promise<Buffer | null> {
  const bytes = await readFile(join(clipShelf.dir, file)).catch(() => null);
  if (!bytes) return null;
  const webp = lastFrameWebp(bytes);
  if ('error' in webp) return null;
  return sharp(webp).png().toBuffer().catch(() => null);
}

/** Frames being read here now (chat|shot|clip), so a slow read is not started twice. */
const reading = new Set<string>();
/** Each list waiting on a last frame gets it read here, with no page open: a hidden or closed page no longer stops it. */
async function framesHere(): Promise<void> {
  for (const f of shots.needFrames()) {
    const key = `${f.chat}|${f.shot}|${f.clip}`;
    if (reading.has(key)) continue;
    reading.add(key);
    try {
      const png = await lastFramePng(f.file);
      if (!png) continue;
      // Read from the clip itself, a blank frame is how the clip really ends (a fade out): the shot says so and stops,
      // never waits for ever. (A blank one sent by a page may be a hidden page's: that is refused and read again.)
      if (await blankFrame(png).catch(() => false)) {
        const n = (shots.get(f.chat)?.shots.findIndex(s => s.id === f.shot) ?? -1) + 1;
        await shots.blankEnd(f.chat, f.shot, f.clip, n);
        continue;
      }
      await takeFrame(f.chat, f.shot, f.clip, png);
    } catch (e) {
      console.warn(`A shot's last frame could not be read here: ${(e as Error).message}`);
    } finally {
      reading.delete(key);
    }
  }
}
setInterval(() => void framesHere(), 3000).unref();

/**
 * While a shot list runs on this PC, Windows is asked not to sleep (the screen may still turn off): a list runs for hours,
 * often on a linked PC, and this PC is the one that starts each shot. Test copies (their own home) never ask.
 */
const listAwake = process.env.TOMLIN_HOME || process.env.TOMLIN_DATA ? null : keepAwakeHolder();
setInterval(() => listAwake?.set(shots.anyRunning()), 15_000).unref();

/**
 * Join: every shot that is made (its kept take, or its last), in the list's order, into one WebM (src/webmjoin.ts), put
 * on the Videos shelf as a clip of this chat and handed in to its project as any clip is. Skipped shots are left out, and
 * so are shots not made yet (or failed), named in its words, so the list can be watched before it is finished.
 */
async function joinShots(chat: string): Promise<{ clip: ClipRecord; shots: number; seconds: number; left: number[] } | { error: string; status: number }> {
  const l = chat ? shots.get(chat) : null;
  if (!l) return { error: 'This chat has no shot list.', status: 404 };
  // The shots made so far, so the list can be watched as one video while the rest are still being made; the ones not
  // made yet (or failed) are left out and named.
  const parts: { name: string; take: Take }[] = [];
  const out: number[] = [];
  for (const [i, s] of l.shots.entries()) {
    if (s.state === 'skipped') continue;
    const take = s.takes.find(t => t.clip === s.kept) ?? s.takes.at(-1);
    if (s.state !== 'done' || !take) {
      out.push(i + 1);
      continue;
    }
    parts.push({ name: `Shot ${i + 1}`, take });
  }
  if (parts.length < 2) return { error: `Two made shots or more are needed to join${out.length ? `: shot${out.length > 1 ? 's' : ''} ${listWords(out)} ${out.length > 1 ? 'are' : 'is'} not made yet` : ''}.`, status: 409 };
  const t0 = Date.now();
  const read: JoinPart[] = [];
  for (const p of parts) {
    const f = await clipShelf.file(p.take.file);
    const bytes = f ? await readFile(f.path).catch(() => null) : null;
    if (!bytes) return { error: `${p.name}'s clip is not on the Videos shelf any more: make it again, or skip it.`, status: 409 };
    read.push({ name: p.name, bytes });
  }
  const joined = joinWebm(read);
  if ('error' in joined) return { error: joined.error, status: 409 };
  const id = randomBytes(6).toString('hex');
  const tmp = join(clipShelf.dir, `joining-${id}.webm`);
  await writeAtomic(tmp, joined.bytes);
  const file = await clipShelf.take(tmp, `video-${id}.webm`);
  const first = parts[0].take;
  const clip: ClipRecord = {
    id, at: new Date().toISOString(), prompt: `${l.name}'s shot list joined: ${parts.map(p => p.name.replace('Shot ', '')).join(', ').replace(/^/, 'shots ')}, ${joined.seconds} s${out.length ? ` (not made yet: ${listWords(out)})` : ''}`, seconds: joined.seconds,
    width: first.width, height: first.height, quality: 'joined', model: l.model, file, mime: 'video/webm', bytes: joined.bytes.length,
    tookMs: Date.now() - t0, who: l.who, chat, pc: 'this PC', joined: parts.map(p => Number(p.name.replace('Shot ', ''))),
  };
  await clipShelf.add(clip);
  // Into the project as any clip of a project's chat is (never a fault: it is on the shelf either way).
  await clipHooks.made?.(clip, join(clipShelf.dir, file)).catch(e => console.warn(`A joined video could not be copied to its project: ${(e as Error).message}`));
  return { clip, shots: parts.length, seconds: joined.seconds, left: out };
}

/** 3, 4 and 6. */
const listWords = (ns: number[]) => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`);

export const shotsGet: Routes = {
  // ?chat=<id>: that chat's shot list (null when it has none).
  '/api/shots': ({ res, url }) => json(res, 200, { list: out(String(url.searchParams.get('chat') ?? '').slice(0, 80)) }),
  // The last frames any open page should read now: lists waiting at a shot that carries on from the shot before.
  '/api/shots/frames': ({ res }) => json(res, 200, { frames: shots.needFrames() }),
  // ?f=<name>: a start picture kept for the shot list.
  '/api/shots/picture': async ({ res, url }) => {
    const f = String(url.searchParams.get('f') ?? '');
    if (!PICTURE_NAME.test(f)) return json(res, 404, { error: 'That picture is not kept here.' });
    const data = await readFile(join(PICTURES, f)).catch(() => null);
    if (!data) return json(res, 404, { error: 'That picture is not kept here any more.' });
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, ...SECURITY_HEADERS, 'cache-control': 'no-store' });
    res.end(data);
  },
};

export const shotsPost: Routes = {
  // {chatId, who, prompt, seconds, size, quality, start}: a shot at the end of the list (a new chat for the first one).
  '/api/shots/add': async ({ res, b }) => {
    const c = await chatOf(b, true);
    if ('error' in c) return json(res, c.status, { error: c.error });
    const r = await shots.add(c.chat, c.hire, b);
    if ('refused' in r) return json(res, 400, { error: r.refused, chat: c.chat });
    return json(res, 200, { chat: c.chat, shot: r.id, list: out(c.chat) });
  },
  '/api/shots/edit': onShot((chat, b) => shots.edit(chat, id(b), b)),
  '/api/shots/move': onShot((chat, b) => shots.move(chat, id(b), Number(b.to))),
  '/api/shots/skip': onShot((chat, b) => shots.skip(chat, id(b))),
  '/api/shots/redo': onShot((chat, b) => shots.redo(chat, id(b), b.takes === TAKES ? TAKES : 1)),
  // Keep this one: noted for which pictures make good starts (src/pairing.ts), that take kept and the others not.
  '/api/shots/keep': onShot(async (chat, b) => {
    const r = await shots.keep(chat, id(b), String(b.clip ?? '').slice(0, 40));
    if (!('refused' in r) && r.kept) await noteKept(r.kept, r.takes.map(t => t.clip)).catch(e => console.warn(`A kept take could not be noted: ${(e as Error).message}`));
    return r;
  }),
  '/api/shots/delete': onShot((chat, b) => shots.remove(chat, id(b))),
  // {chatId, do: start | draft | upgrade | pause | stop, at?}: run the list (at: an ISO time to start it then).
  '/api/shots/run': async ({ res, b }) => {
    // Pause and Stop work in any chat that has a list, even once its Videographer has left the team.
    if (b.do === 'pause' || b.do === 'stop') {
      const named = namedChat(b, false);
      if ('error' in named) return json(res, 400, { error: named.error });
      if (!('id' in named) || !shots.get(named.id)) return json(res, 404, { error: 'This chat has no shot list.' });
      await (b.do === 'pause' ? shots.pause(named.id) : shots.stop(named.id));
      return json(res, 200, { chat: named.id, list: out(named.id) });
    }
    const c = await chatOf(b);
    if ('error' in c) return json(res, c.status, { error: c.error });
    const at = typeof b.at === 'string' ? b.at.slice(0, 40) : null;
    const r = b.do === 'upgrade' ? await shots.upgrade(c.chat, c.hire)
      : b.do === 'draft' ? await shots.start(c.chat, c.hire, { at, draft: true })
      : b.do === 'start' ? await shots.start(c.chat, c.hire, { at })
      : { refused: 'Start, Pause or Stop: nothing else is done to a shot list.' };
    if (r && 'refused' in r) return json(res, 400, { error: r.refused, list: out(c.chat) });
    return json(res, 200, { chat: c.chat, list: out(c.chat) });
  },
  // {data: "data:image/png;base64,..."}: a start picture from a file, kept for the shot list; gives its name.
  '/api/shots/picture': async ({ res, b }) => {
    const name = await keepPicture(b.data);
    if (typeof name !== 'string') return json(res, 400, name);
    return json(res, 200, { file: name });
  },
  // {chat, id, clip, data}: the page read the last frame of `clip` (the take before shot `id`): the list carries on.
  // The frame is matched to the list's colours first when it keeps them (Keep the colours of the first shot).
  '/api/shots/frame': async ({ res, b }) => {
    const sent = startFromPage(b.data);
    if (!sent || 'error' in sent) return json(res, 400, sent ?? { error: 'No picture came with that.' });
    const r = await takeFrame(String(b.chat ?? '').slice(0, 80), id(b), String(b.clip ?? '').slice(0, 40), sent);
    return json(res, r.status, r.status === 200 ? { ok: true } : { error: r.error });
  },
  // {chatId}: every made shot's kept take, in order, joined into one video on the Videos shelf (and the project).
  '/api/shots/join': async ({ res, b }) => {
    const named = namedChat(b, false);
    if ('error' in named) return json(res, 400, { error: named.error });
    const r = await joinShots('id' in named ? named.id : '');
    return 'error' in r ? json(res, r.status, { error: r.error }) : json(res, 200, r);
  },
  // {chatId, on}: Keep the colours of the first shot, on or off.
  '/api/shots/colour': async ({ res, b }) => {
    const c = await chatOf(b);
    if ('error' in c) return json(res, c.status, { error: c.error });
    await shots.setColour(c.chat, c.hire, b.on !== false);
    return json(res, 200, { chat: c.chat, list: out(c.chat) });
  },
};
