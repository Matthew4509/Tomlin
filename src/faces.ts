// Profile photos, one per person: TOMLIN, each hire, and the owner ("me"). Each is its own small square copy in
// data/faces/ (index.json + <who>.png), so deleting a chat's pictures never takes a face with it and one person's photo
// is never shown for another. The plain functions are tested in test/faces.test.ts.
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fitTo } from './imaging.ts';
import { readData, writeAtomic } from './atomic.ts';

/** The square every face is cut to (the middle of the picture is kept). */
export const FACE_SIZE = 256;

export interface Face {
  /** The gallery picture it was cut from, and that picture's prompt (shown as the photo's tooltip). */
  picture: string;
  prompt: string;
  at: string;
}
export type FaceMap = Record<string, Face>;

/** A key names one person: manager, me or staff:<hire id>. */
export const isFaceKey = (who: string): boolean => /^(manager|me|staff:[a-z0-9-]{1,80})$/.test(who);

/** The file a face is kept in: "staff:rowan" -> "staff-rowan.png". */
export const faceFile = (who: string): string => `${who.replace(':', '-')}.png`;

/** Every face, for the page. The `v` in each address changes when the photo does, so a browser never shows the old
 * one from its cache. */
export function visibleFaces(all: FaceMap): Record<string, { url: string; prompt: string }> {
  const out: Record<string, { url: string; prompt: string }> = {};
  for (const [who, f] of Object.entries(all)) {
    if (!isFaceKey(who)) continue;
    out[who] = { url: `/api/faces/file/${encodeURIComponent(who)}?v=${encodeURIComponent(f.at)}`, prompt: f.prompt };
  }
  return out;
}

export class Faces {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async all(): Promise<FaceMap> {
    const raw = await readData<FaceMap | null>(join(this.dir, 'index.json'), null);
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).filter(([who]) => isFaceKey(who) && existsSync(join(this.dir, faceFile(who)))));
  }

  private async write(map: FaceMap): Promise<void> {
    await writeAtomic(join(this.dir, 'index.json'), JSON.stringify(map, null, 1));
  }

  /** Cuts `image` to a square and keeps it as `who`'s photo (replacing any before). */
  async set(who: string, image: Buffer, from: { id: string; prompt: string }, now = new Date()): Promise<Face> {
    if (!isFaceKey(who)) throw new Error('No such person.');
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(join(this.dir, faceFile(who)), await fitTo(image, { width: FACE_SIZE, height: FACE_SIZE }, 'crop'));
    const face: Face = { picture: from.id, prompt: from.prompt.slice(0, 300), at: now.toISOString() };
    await this.write({ ...(await this.all()), [who]: face });
    return face;
  }

  /** Takes `who`'s photo away (they show their initials again). True when there was one. */
  async clear(who: string): Promise<boolean> {
    const map = await this.all();
    if (!isFaceKey(who) || !map[who]) return false;
    delete map[who];
    await this.write(map);
    await rm(join(this.dir, faceFile(who)), { force: true });
    return true;
  }

  /** The file of `who`'s photo, or null. */
  async path(who: string): Promise<string | null> {
    return isFaceKey(who) && (await this.all())[who] ? join(this.dir, faceFile(who)) : null;
  }
}
