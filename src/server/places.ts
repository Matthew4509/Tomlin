// Where work goes in the workspace (src/folders.ts): a chat's Save, a quick chat's files going into a project, a note
// saved from the right panel, a picture kept in a project's chat, and the work handed in to a project.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rmdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import * as folders from '../folders.ts';
import * as ws from '../workspace.ts';
import type { ChatInfo } from '../chats.ts';
import { type Routes, chats, json, staff, staffId, workspaceDir } from './core.ts';
import { jobRoutes } from './jobs.ts';

/** A project's folder in the workspace ('' when it is kept at the top), or null when there is no such project. */
export async function projectFolder(id: string | undefined): Promise<string | null> {
  if (!id) return null;
  const job = await jobRoutes.loadJob(id);
  if (job) return job.folder ?? '';
  // Saved on Home and not planned yet: its folder is in its project file.
  return (await jobRoutes.projectInfo(id))?.folder ?? null;
}

/** The role a chat's person has (a hire's role; the manager plans), for which specialist folder their work goes in. */
const roleOfChat = (c: ChatInfo) => (staffId(c.who) ? staff.get(c.who.slice(6))?.role ?? 'default' : c.who === 'manager' ? 'pm' : 'default');

/** Where Save on a code block in this chat puts the file, and whether its name starts with the date and time. */
export async function saveToOf(c: ChatInfo): Promise<{ dir: string; stamped: boolean } | null> {
  const folder = await chats.folderOf(c.id);
  return folders.saveTo({ chatFolder: folder ?? '', projectFolder: await projectFolder(c.project), role: roleOfChat(c) });
}

/**
 * A quick chat put into a project ("saved properly"): the files saved in its own chats\<stamp> folder move to where
 * Save puts them in that project. One whose name is taken there stays (nothing is written over). Said in plain words.
 */
export async function moveChatFiles(c: ChatInfo): Promise<string> {
  const from = c.folder;
  const to = await saveToOf(c);
  if (!from || !to || c.project === undefined) return '';
  const root = await workspaceDir();
  const all = await ws.list(root);
  const files = all.map(f => f.path).filter(p => p.startsWith(`${from}/`));
  if (!files.length) return '';
  const plan = folders.moves(files, from, to.dir, new Set(all.map(f => f.path)), to.stamped ? folders.stampOf(from.split('/').pop()!) ?? '' : '');
  let moved = 0;
  for (const m of plan.move) {
    const a = await ws.inside(root, m.from);
    const b = await ws.inside(root, m.to);
    if (!a || !b) {
      plan.stay.push(m.from);
      continue;
    }
    // Looked at on the disk just before the move: the list above stops at 500 files, and Windows' rename writes
    // over a file of that name (in any case of letters) without a word.
    if (existsSync(b)) {
      plan.stay.push(m.from);
      continue;
    }
    try {
      await mkdir(dirname(b), { recursive: true });
      await rename(a, b);
      moved++;
    } catch {
      plan.stay.push(m.from);
    }
  }
  // The chat's own folder goes when it is empty (rmdir never removes a folder with something in it).
  if (!plan.stay.length) {
    const dir = await ws.inside(root, `${from}/x.txt`);
    if (dir) await rmdir(dirname(dir)).catch(() => undefined);
  }
  const where = (to.dir || 'the workspace folder').replace(/\//g, '\\');
  return [
    moved ? `${moved} file${moved === 1 ? '' : 's'} from this chat moved into ${where}.` : '',
    plan.stay.length ? `${plan.stay.length === 1 ? `${plan.stay[0].split('/').pop()} stayed` : `${plan.stay.length} files stayed`} in ${from.replace(/\//g, '\\')}: ${plan.stay.length === 1 ? 'a file of that name is' : 'files of those names are'} already in the project.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * A picture kept in a chat that belongs to a project is handed in to that project: a copy goes into its
 * specialists\images folder, named with the date and time and the picture's first words. Never a fault: the picture
 * is in the gallery either way.
 */
export async function handInPicture(p: { output: string; prompt: string; chat?: string }, file: string | null): Promise<void> {
  if (!file || !p.chat) return;
  const c = await chats.get(p.chat).catch(() => null);
  if (!c?.project) return;
  // Not handed in: the picture is still in the gallery.
  await handInTo(c.project, p.prompt, file, p.output);
}

/**
 * A picture handed in to project `project` (a picture drawn by the queue names its own project): a copy in its
 * specialists\images folder, named with the date and time and the picture's first words. Its workspace path, or why not.
 */
export async function handInTo(project: string, prompt: string, file: string | null, output: string): Promise<{ path: string } | { error: string }> {
  try {
    const folder = await projectFolder(project);
    if (folder === null) return { error: 'that project is not in this workspace any more' };
    if (!file) return { error: 'the picture file is not in the gallery' };
    const rel = folders.picturePath(folder, prompt, extname(output).toLowerCase() || '.png');
    const dest = await ws.inside(await workspaceDir(), rel, false);
    if (!dest) return { error: 'its folder is outside the workspace' };
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file, dest);
    return { path: rel };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const placesGet: Routes = {
  '/api/project/handed': async ({ res, url }) => {
    // ?id=<project>: the work its specialists handed in, newest first (src/folders.ts).
    const folder = await projectFolder(url.searchParams.get('id') ?? '');
    if (folder === null) return json(res, 404, { error: 'That project is not in this workspace any more.' });
    const root = await workspaceDir();
    const all = await ws.list(root);
    const inIt = all.filter(f => !folder || f.path.startsWith(`${folder}/`)).map(f => ({ ...f, path: folder ? f.path.slice(folder.length + 1) : f.path }));
    return json(res, 200, { folder, handed: folders.handedIn(inIt) });
  },
};

export const placesPost: Routes = {
  '/api/notes/save': async ({ res, b }) => {
    // {text, project}: a note from the right panel saved as a file: notes\<stamp> <words>.md, or the project's admin notes.
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) return json(res, 400, { error: 'The scratch pad is empty: type the note first, then Save note.' });
    const project = String(b.project ?? '');
    const folder = project ? await projectFolder(project) : null;
    if (project && folder === null) return json(res, 404, { error: 'That project is not in this workspace any more. Pick another, or Notes.' });
    const path = folders.notePath(text, folder);
    const r = await ws.save(await workspaceDir(), path, `${text}\n`);
    if ('error' in r) return json(res, 400, { error: `The note was not saved: ${r.error}` });
    return json(res, 200, { path: r.path, where: r.path.slice(0, r.path.lastIndexOf('/')).replace(/\//g, '\\') });
  },
};
