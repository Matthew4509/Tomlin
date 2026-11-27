// A project's work, by kind, for its project page (public/projectpage.js): the files in its folder sorted into code
// (the project's own files, which keep their names), pictures, writing and videos (the specialists folders, see
// src/folders.ts), and the chats saved from it. Its admin notes are the person's and left out. Plain, tested in
// test/projectpage.test.ts.
import { ADMIN_NOTES, CHATS, SPECIALISTS } from './folders.ts';
import { SOURCE_END } from './sources.ts';

export interface WorkFile { path: string; bytes: number; at: string }
export interface Work { code: WorkFile[]; pictures: WorkFile[]; writing: WorkFile[]; videos: WorkFile[]; chats: WorkFile[]; more: Record<Part, number> }
export type Part = 'code' | 'pictures' | 'writing' | 'videos' | 'chats';

/** At most this many of each kind are listed, newest first; `more` says how many were left out. */
export const WORK_MOST = 60;
/** Pictures the page can show (served by /api/files/picture). */
export const SHOWN_PICTURE = /\.(png|webp)$/i;

/** Which kind a file is, by where it is in the project folder (its path relative to that folder); null: left out. */
export function partOf(rel: string): Part | null {
  const p = rel.replace(/\\/g, '/');
  const low = p.toLowerCase();
  if (low.startsWith(`${ADMIN_NOTES}/`)) return null;
  if (low.startsWith(`${CHATS}/`)) return 'chats';
  if (low.startsWith(`${SPECIALISTS}/images/`)) return 'pictures';
  if (low.startsWith(`${SPECIALISTS}/writer/`)) return 'writing';
  if (low.startsWith(`${SPECIALISTS}/videos/`)) return 'videos';
  // Characters and locations (src/cards.ts) have their own strip on the project page.
  if (low.startsWith(`${SPECIALISTS}/characters/`) || low.startsWith(`${SPECIALISTS}/locations/`)) return null;
  if (low.startsWith(`${SPECIALISTS}/`)) return 'writing';
  // A picture's source notes (beside it) and the files tools keep for themselves are not work to show.
  const name = p.split('/').pop() ?? '';
  if (name.startsWith('.') || /(^|\/)(node_modules|\.git)\//.test(p)) return null;
  return 'code';
}

/** The project's files (paths relative to its folder) sorted by kind, newest first, at most WORK_MOST of each. */
export function sortWork(files: WorkFile[]): Work {
  const all: Record<Part, WorkFile[]> = { code: [], pictures: [], writing: [], videos: [], chats: [] };
  for (const f of files) {
    const part = partOf(f.path);
    if (f.path.toLowerCase().endsWith(SOURCE_END)) continue;
    if (part) all[part].push(f);
  }
  const more = { code: 0, pictures: 0, writing: 0, videos: 0, chats: 0 } as Record<Part, number>;
  const out = {} as Work;
  for (const k of Object.keys(all) as Part[]) {
    const list = all[k].sort((a, b) => b.at.localeCompare(a.at));
    more[k] = Math.max(0, list.length - WORK_MOST);
    (out as unknown as Record<Part, WorkFile[]>)[k] = list.slice(0, WORK_MOST);
  }
  out.more = more;
  return out;
}

/** The page to play the project with: its index.html at the top, or else the only page at the top. */
export function playPage(code: WorkFile[]): string | null {
  const top = code.filter(f => !f.path.includes('/') && /\.html?$/i.test(f.path));
  return top.find(f => /^index\.html?$/i.test(f.path))?.path ?? (top.length === 1 ? top[0].path : null);
}
