// Character sets on disk (src/cards.ts): a project's characters and locations, one folder each under its specialists
// folder, with card.json and the card's pictures. The routes the Images window's Character sets uses, and the @names
// filled in for a picture, a queued picture, a clip and a shot of a chat in a project (expandForProject).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as C from '../cards.ts';
import * as folders from '../folders.ts';
import * as ws from '../workspace.ts';
import { writeAtomic } from '../atomic.ts';
import { type Routes, chats, json, workspaceDir } from './core.ts';
import { images } from './panes.ts';
import { projectFolder } from './places.ts';

/** A card with its folder and pictures (paths from the workspace's top, as /api/files/picture takes them). */
export interface CardView extends C.Card { folder: string; pictures: string[] }

/** The folder a card of `kind` called `name` has in the project folder (relative to the workspace's top). */
const cardDir = (project: string, kind: C.CardKind, name: string) => [project, folders.SPECIALISTS, C.KIND_FOLDER[kind], name].filter(Boolean).join('/');

/** The project's folder for cards, or an error: none for a project kept at the top of the workspace. */
async function folderFor(projectId: unknown): Promise<{ folder: string } | { error: string; status: number }> {
  const folder = typeof projectId === 'string' && projectId ? await projectFolder(projectId) : null;
  if (folder === null) return { error: 'That project is not in this workspace any more.', status: 404 };
  // Character sets offers a new project for them in the same place (public/charsets.js), so the words name that button.
  if (!folder) return { error: 'This project is kept at the top of the workspace, so it has no folder of its own to keep characters and locations in. Press Make a project for these characters in Character sets: it makes a project with its own folder and moves this chat into it.', status: 409 };
  return { folder };
}

/** Every card of a project, characters first, then by name. A folder without a good card.json is passed over. */
export async function cardsOf(folder: string): Promise<CardView[]> {
  const root = await workspaceDir();
  const out: CardView[] = [];
  for (const kind of C.CARD_KINDS) {
    const base = await ws.inside(root, `${[folder, folders.SPECIALISTS, C.KIND_FOLDER[kind]].join('/')}/x`, false);
    if (!base) continue;
    const dir = join(base, '..');
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const card = C.cleanCard(await readFile(join(dir, name, C.CARD_FILE), 'utf8').then(JSON.parse).catch(() => null));
      if (!card || card.kind !== kind || card.name !== name) continue;
      const rel = cardDir(folder, kind, name);
      const files = (await readdir(join(dir, name)).catch(() => [] as string[])).filter(C.isCardPicture);
      const dated = await Promise.all(files.map(async f => ({ f, at: (await stat(join(dir, name, f)).catch(() => null))?.mtimeMs ?? 0 })));
      out.push({ ...card, refs: card.refs.filter(r => files.includes(r)), folder: rel, pictures: dated.sort((a, b) => a.at - b.at).map(x => `${rel}/${x.f}`).slice(0, C.PICTURES_MOST) });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'character' ? -1 : 1));
}

/** The @names of `prompt` filled in from the cards of project `projectId` (the prompt as it was with no project or none named). */
export async function expandForProject(prompt: string, projectId: string | undefined | null): Promise<C.Expanded & { refs: string[]; refsAt: string[] }> {
  const none = { prompt, avoid: '', used: [], refs: [], refsAt: [] };
  if (!projectId || !prompt.includes('@')) return none;
  const folder = await projectFolder(projectId).catch(() => null);
  if (!folder) return none;
  const cards = await cardsOf(folder).catch(() => [] as CardView[]);
  const e = C.expandPrompt(prompt, cards);
  // The ticked pictures as full paths inside the workspace, for a model that takes reference pictures (src/images.ts
  // refPictures): characters first, as the cards are; one outside the workspace is left out.
  const root = await workspaceDir();
  // refsAt: the same pictures as the workspace names them, for something kept to draw later (a queued picture).
  const refs: string[] = [];
  const refsAt: string[] = [];
  for (const c of e.used as CardView[]) for (const r of c.refs) {
    const at = await ws.inside(root, `${c.folder}/${r}`, false);
    if (!at) continue;
    refs.push(at);
    refsAt.push(`${c.folder}/${r}`);
  }
  return { ...e, refs, refsAt };
}

/** The same for a chat's project. */
export async function expandForChat(prompt: string, chatId: string | undefined | null): Promise<C.Expanded & { refs: string[] }> {
  const c = chatId ? await chats.get(chatId).catch(() => null) : null;
  return expandForProject(prompt, c?.project);
}

/** A negative prompt with the named cards' avoid words added. */
export const withAvoid = (negative: unknown, avoid: string): string | undefined => {
  const n = typeof negative === 'string' ? negative.trim() : '';
  return avoid ? (n ? `${n}, ${avoid}` : avoid) : n || undefined;
};

async function writeCard(folder: string, card: C.Card): Promise<string> {
  const root = await workspaceDir();
  const at = await ws.inside(root, `${cardDir(folder, card.kind, card.name)}/${C.CARD_FILE}`, false);
  if (!at) throw new Error('That folder is outside the workspace.');
  await mkdir(join(at, '..'), { recursive: true });
  await writeAtomic(at, `${JSON.stringify(card, null, 2)}\n`);
  return at;
}

export const cardsGet: Routes = {
  '/api/cards': async ({ res, url }) => {
    // ?project=<id>: its characters and locations.
    const f = await folderFor(url.searchParams.get('project'));
    if ('error' in f) return json(res, f.status, { error: f.error });
    return json(res, 200, { cards: await cardsOf(f.folder), views: C.SHEET_VIEWS });
  },
};

export const cardsPost: Routes = {
  '/api/cards/save': async ({ res, b }) => {
    // {project, card: {kind, name, words, avoid, refs}, was?: name before a rename}: written; a new name renames its folder.
    const f = await folderFor(b.project);
    if ('error' in f) return json(res, f.status, { error: f.error });
    const card = C.cleanCard({ ...(b.card as object), at: new Date().toISOString() });
    if (!card) return json(res, 400, { error: `Give it a name: letters, numbers, spaces, - and ', at most ${C.NAME_MOST} characters.` });
    // CON, NUL, COM1 and the rest are Windows' device names: no folder can have one, so the card is refused for its name.
    if (ws.isDeviceName(card.name)) return json(res, 400, { error: `"${card.name}" is a name Windows keeps for a device, so no folder can be called it. Pick another name.` });
    const all = await cardsOf(f.folder);
    // A new card (no `was`, as "+ Character" sends) never writes over one of that name: a second window or the same
    // name typed again would lose the first card's words, avoid words and ticks.
    if (typeof b.was !== 'string' && all.some(c => c.kind === card.kind && c.name === card.name)) return json(res, 409, { error: `There is a ${card.kind} called "${card.name}" already. Open it to change it, or pick another name.` });
    const was = typeof b.was === 'string' && b.was !== card.name ? all.find(c => c.kind === card.kind && c.name === b.was) : undefined;
    // One name across characters and locations, so @Name means one card.
    if (all.some(c => c.name.toLowerCase() === card.name.toLowerCase() && c !== was && !(c.kind === card.kind && c.name === card.name))) return json(res, 409, { error: `"${card.name}" is taken already in this project. Pick another name.` });
    const root = await workspaceDir();
    if (was) {
      const from = await ws.inside(root, `${was.folder}/x`, false);
      const to = await ws.inside(root, `${cardDir(f.folder, card.kind, card.name)}/x`, false);
      if (!from || !to) return json(res, 400, { error: 'That folder is outside the workspace.' });
      const fromDir = join(from, '..');
      const toDir = join(to, '..');
      // Only the letter case changes (Pine forest to pine forest): Windows sees one folder, so it goes by a passing name.
      const caseOnly = fromDir !== toDir && fromDir.toLowerCase() === toDir.toLowerCase();
      if (!caseOnly && existsSync(toDir)) return json(res, 409, { error: `A folder called "${card.name}" is there already. Pick another name.` });
      if (caseOnly) {
        const passing = `${fromDir}.renaming-${randomBytes(3).toString('hex')}`;
        await rename(fromDir, passing);
        await rename(passing, toDir);
      } else await rename(fromDir, toDir);
    }
    await writeCard(f.folder, card);
    return json(res, 200, { cards: await cardsOf(f.folder), saved: card.name });
  },
  '/api/cards/remove': async ({ res, b }) => {
    // {project, kind, name}: the card is no longer one (its card.json goes); its pictures stay in its folder.
    const f = await folderFor(b.project);
    if ('error' in f) return json(res, f.status, { error: f.error });
    const card = (await cardsOf(f.folder)).find(c => c.kind === b.kind && c.name === b.name);
    if (!card) return json(res, 404, { error: 'That card is not in this project any more.' });
    const at = await ws.inside(await workspaceDir(), `${card.folder}/${C.CARD_FILE}`, false);
    if (at) await rm(at, { force: true });
    return json(res, 200, { cards: await cardsOf(f.folder), said: `${card.name} is no longer a ${card.kind}. Its pictures stay in ${card.folder}.` });
  },
  '/api/cards/picture': async ({ res, b }) => {
    // {project, kind, name, picture: a gallery picture's id}: a copy goes into the card's folder; the first one is ticked.
    const r = await pictureToCard(b.project, b.kind, b.name, String(b.picture ?? ''));
    if ('error' in r) return json(res, r.status, { error: r.error });
    return json(res, 200, r);
  },
};

/**
 * A copy of gallery picture `pictureId` goes into card `name`'s folder of project `projectId`; a card with no reference
 * yet has it ticked. Used by Add (above) and by the queue when a sheet's view is drawn (src/server/queue.ts).
 */
export async function pictureToCard(projectId: unknown, kind: unknown, cardName: unknown, pictureId: string): Promise<{ cards: CardView[]; added: string } | { error: string; status: number }> {
  const f = await folderFor(projectId);
  if ('error' in f) return f;
  const card = (await cardsOf(f.folder)).find(c => c.kind === kind && c.name === cardName);
  if (!card) return { error: 'That card is not in this project any more.', status: 404 };
  if (card.pictures.length >= C.PICTURES_MOST) return { error: `${card.name} has ${C.PICTURES_MOST} pictures already. Take some out of its folder first.`, status: 409 };
  const p = await images.gallery.get(pictureId);
  if (!p || p.removed || p.private) return { error: 'That picture is not in the gallery any more.', status: 404 };
  const from = await images.gallery.file(p.output);
  if (!from || !existsSync(from)) return { error: 'That picture\'s file is not there any more.', status: 404 };
  const root = await workspaceDir();
  const ext = extname(from).toLowerCase() || '.png';
  const base = `${folders.stamp()} ${card.kind === 'character' ? 'view' : 'plate'}`;
  let name = `${base}${ext}`;
  for (let i = 2; existsSync(join(root, card.folder, name)); i++) name = `${base} ${i}${ext}`;
  const at = await ws.inside(root, `${card.folder}/${name}`, false);
  if (!at) return { error: 'That folder is outside the workspace.', status: 400 };
  await copyFile(from, at);
  if (!card.refs.length) await writeCard(f.folder, { ...card, refs: [name] });
  return { cards: await cardsOf(f.folder), added: `${card.folder}/${name}` };
}
