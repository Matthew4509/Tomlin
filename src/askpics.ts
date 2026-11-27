// Pictures sent with a message for the chat model to look at: read from the page (a data: URL), checked to be a PNG or
// JPEG picture (llama.cpp reads pictures with stb_image, which has no WebP: the page turns a WebP into a PNG first), kept in data/chatpics/<chat>/ beside the chat, and sent to llama-server as image_url parts of the
// person's message (OpenAI's format, which llama-server reads when it was started with the model's vision add-on).
// Only to a model on this PC: a linked PC's worker door carries text turns only. The plain functions are tested in
// test/askpics.test.ts.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.ts';

/** The largest picture taken, in bytes (the page makes bigger ones smaller first). */
export const PIC_MAX_BYTES = 8 << 20;
/** The most pictures sent with one turn: the newest ones of the chat, each with the message it came with. */
export const PICTURES_SENT = 3;

/** The kinds of picture taken, by type, with the file ending they are kept under. */
export const PIC_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const TYPE_OF: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg' };

/** A picture as it was sent: its type and its bytes. */
export interface Picture {
  mime: string;
  data: Buffer;
}

/** The type a picture's first bytes say it is, or '' (not a PNG, JPEG or WebP). A WebP is known, and not taken. */
export function pictureKind(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * The picture a message carries (`picture`: a data: URL from the page): null when there is none, its words when it is not
 * a picture that can be sent. Its bytes must be the kind its type says.
 */
export function readPicture(v: unknown): Picture | { error: string } | null {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(v) : null;
  if (!m) return { error: 'That picture could not be read. Add a PNG, JPEG or WebP picture.' };
  if ((m[2].length * 3) / 4 > PIC_MAX_BYTES + 3) return { error: `That picture is too large (over ${PIC_MAX_BYTES >> 20} MB). Add a smaller one.` };
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || pictureKind(data) !== m[1]) return { error: 'That file is not the picture it says it is. Add a PNG, JPEG or WebP picture.' };
  const size = pictureSize(data);
  if (size && (!size.width || !size.height || Math.max(size.width, size.height) > PIC_SIDE_MOST || size.width * size.height > PIC_PIXELS_MOST)) {
    return { error: `That picture is too large to look at (${size.width} x ${size.height}). Add one no more than ${PIC_SIDE_MOST} on its longest side.` };
  }
  return { mime: m[1], data };
}

/** The longest side of a picture taken (the page makes them at most 1024 first; this is for one sent another way). */
export const PIC_SIDE_MOST = 8192;
/** The most pixels a picture taken may have: the vision model's runner unpacks every one of them before it looks. */
export const PIC_PIXELS_MOST = 36_000_000;

/**
 * The width and height a PNG's or JPEG's header says, or null when it does not say (the bytes are then left to the
 * runner, which refuses what it cannot read). Read from the header only, so a few bytes claiming a huge picture are
 * found before anything unpacks them.
 */
export function pictureSize(data: Buffer): { width: number; height: number } | null {
  if (pictureKind(data) === 'image/png') {
    if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (pictureKind(data) !== 'image/jpeg') return null;
  // The markers after the start: each with its length, up to the frame header (SOF0 to SOF15, less DHT, JPG and DAC).
  for (let at = 2; at + 4 <= data.length;) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = data.readUInt16BE(at + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > data.length) return null;
      return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
    }
    at += 2 + len;
  }
  return null;
}

/** A picture's data: URL, as llama-server takes it in an image_url part. */
export const dataUrlOf = (p: Picture): string => `data:${p.mime};base64,${p.data.toString('base64')}`;

/** A picture to send: the text of the message it came with (to find that message's turn), and the picture. */
export interface PicTurn {
  text: string;
  url: string;
}

/**
 * The chat's messages as sent to the runner, with each picture on the person's message it came with: that message's text
 * becomes a text part, and the pictures image_url parts before it. A message found by its text (the latest one that
 * holds it, as turns that come together are joined); a picture whose message is no longer sent (folded away) is left out.
 */
export function withPictures<T extends { role: string; content: unknown }>(messages: T[], pics: readonly PicTurn[]): Array<T | (Omit<T, 'content'> & { content: unknown[] })> {
  if (!pics.length) return messages;
  const at = new Map<number, string[]>();
  for (const p of pics) {
    const text = p.text.trim();
    if (!text) continue;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && typeof m.content === 'string' && m.content.includes(text)) {
        at.set(i, [...(at.get(i) ?? []), p.url]);
        break;
      }
    }
  }
  return messages.map((m, i) => {
    const urls = at.get(i);
    return urls ? { ...m, content: [...urls.map(url => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: m.content as string }] } : m;
  });
}

/** Where the pictures sent in chats are kept: data/chatpics/<chat id>/<12 letters>.<png|jpg>. */
export class AskPics {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'chatpics');
  }

  private folder(chatId: string): string {
    if (!/^[a-f0-9]{12}$/.test(chatId)) throw new Error('Not a chat.');
    return join(this.dir, chatId);
  }

  /** Keeps a picture for a chat; its file name. */
  async save(chatId: string, p: Picture): Promise<string> {
    const name = `${randomBytes(6).toString('hex')}.${PIC_TYPES[p.mime]}`;
    await mkdir(this.folder(chatId), { recursive: true });
    await writeAtomic(join(this.folder(chatId), name), p.data);
    return name;
  }

  /** A chat's picture by its file name (only a name save gave), or null when it is not there. */
  async read(chatId: string, file: string): Promise<Picture | null> {
    const m = /^[a-f0-9]{12}\.(png|jpg)$/.exec(file);
    if (!m || !/^[a-f0-9]{12}$/.test(chatId)) return null;
    try {
      return { mime: TYPE_OF[m[1]], data: await readFile(join(this.folder(chatId), file)) };
    } catch {
      return null;
    }
  }

  /** Everything kept for a chat (when the chat is deleted). */
  async drop(chatId: string): Promise<void> {
    if (/^[a-f0-9]{12}$/.test(chatId)) await rm(this.folder(chatId), { recursive: true, force: true });
  }
}

/** Said when the chat answers on a linked PC: the worker door carries text only. */
export const PICTURES_HERE_ONLY = 'Pictures go only to a model on this PC for now. This chat answers on a linked PC, so the picture was not sent: send it in a chat whose model runs on this PC.';

/** Said when the model that would answer cannot look at pictures. `loadedWithout`: it has the add-on, but would not start with it. */
export function noVisionWords(model: string, loadedWithout = false): string {
  const name = model || 'This model';
  return loadedWithout
    ? `${name} cannot look at pictures now: it would not start with its vision add-on (the mmproj file beside it), so it was loaded without it. The vision file may be made for another model: get the one made for this model, then load it again.`
    : `${name} cannot look at pictures: it needs a vision add-on (an mmproj file in the same folder as the model). Pick a model that reads pictures (Settings, Models, tick Reads pictures), then load it and send the picture again.`;
}
