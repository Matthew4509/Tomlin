// Where work goes in the workspace (src/folders.ts): a chat's Save, a quick chat's files going into a project, a note
// saved from the right panel, a picture kept in a project's chat, and the work handed in to a project.
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rmdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
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

/** The folder a coder hire's file tools work in (src/filetools.ts): the chat's project's, or the whole workspace in Default. */
export async function chatFilesRoot(project: string | undefined): Promise<string> {
  const dir = await workspaceDir();
  const sub = await projectFolder(project);
  const root = sub ? join(dir, sub) : dir;
  await mkdir(root, { recursive: true });
  return root;
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
  // This chat's folder itself: the browsing list stops at 500 files across the workspace and shows only text files.
  const under = await ws.filesUnder(root, from).catch(() => null);
  if (!under || (!under.files.length && !under.links.length)) return '';
  const plan = folders.moves(under.files, from, to.dir, new Set(), to.stamped ? folders.stampOf(from.split('/').pop()!) ?? '' : '');
  let moved = 0;
  const stuck = [...under.links];
  for (const m of plan.move) {
    const a = await ws.inside(root, m.from, false);
    const b = await ws.inside(root, m.to, false);
    if (!a || !b) {
      stuck.push(m.from);
      continue;
    }
    // Looked at on the disk just before the move: Windows' rename writes over a file of that name (in any case of
    // letters) without a word.
    if (existsSync(b)) {
      plan.stay.push(m.from);
      continue;
    }
    try {
      await mkdir(dirname(b), { recursive: true });
      await rename(a, b);
      moved++;
    } catch {
      stuck.push(m.from);
    }
  }
  // The chat's own folder goes when it is empty, its emptied sub-folders first (rmdir never removes a folder with something in it).
  for (const rel of [...under.folders].reverse().concat(from)) {
    const dir = await ws.inside(root, `${rel}/x`, false);
    if (dir) await rmdir(dirname(dir)).catch(() => undefined);
  }
  const where = (to.dir || 'the workspace folder').replace(/\//g, '\\');
  const here = from.replace(/\//g, '\\');
  return [
    moved ? `${moved} file${moved === 1 ? '' : 's'} from this chat moved into ${where}.` : '',
    plan.stay.length ? `${plan.stay.length === 1 ? `${plan.stay[0].split('/').pop()} stayed` : `${plan.stay.length} files stayed`} in ${here}: ${plan.stay.length === 1 ? 'a file of that name is' : 'files of those names are'} already in the project.` : '',
    stuck.length ? `${stuck.length === 1 ? `${stuck[0].split('/').pop()} could` : `${stuck.length} items could`} not be moved and stayed in ${here}${stuck.length === 1 ? '' : ` (${stuck.slice(0, 3).map(s => s.split('/').pop()).join(', ')}${stuck.length > 3 ? '…' : ''})`}: move ${stuck.length === 1 ? 'it' : 'them'} by hand if the project needs ${stuck.length === 1 ? 'it' : 'them'}.` : '',
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
    const first = folders.picturePath(folder, prompt, extname(output).toLowerCase() || '.png');
    const at = await ws.inside(await workspaceDir(), first, false);
    if (!at) return { error: 'its folder is outside the workspace' };
    // Two pictures of one prompt kept in the same minute have the same name: the second gets " 2", never written over.
    const rel = folders.freeName(first, r => existsSync(join(dirname(at), r.split('/').pop()!)));
    const dest = join(dirname(at), rel.split('/').pop()!);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file, dest, constants.COPYFILE_EXCL);
    return { path: rel };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * The first answer of a chat started by Lets go! on Home, kept as a file where Save puts this chat's work (the project
 * folder, or a writer's specialists\writer), named with the date and time and the prompt's first words; never over
 * another file. Its workspace path, or why not (the answer is in the chat either way); null when no file is wanted.
 * The mark goes first, whatever happens to the file: the next answer is another answer, and is never saved as the first
 * (the page holds this one's words, for Save the file again).
 */
export async function keepFirstAnswer(c: ChatInfo, prompt: string, text: string): Promise<{ path: string } | { error: string } | null> {
  if (!c.saveAnswer || !c.project || !text.trim()) return null;
  await chats.mark(c.id, { saveAnswer: undefined });
  return saveAnswer(c, prompt, text);
}

/** One answer as a file, as keepFirstAnswer says. */
async function saveAnswer(c: ChatInfo, prompt: string, text: string): Promise<{ path: string } | { error: string }> {
  try {
    const to = await saveToOf(c);
    if (!to) return { error: 'that project is not in this workspace any more' };
    const root = await workspaceDir();
    const first = folders.answerPath(to.dir, prompt);
    let rel = first;
    for (let n = 2; await ws.read(root, rel).then(r => !('error' in r)); n++) rel = first.replace(/\.md$/, ` ${n}.md`);
    const r = await ws.save(root, rel, `${text.trim()}\n`);
    return 'error' in r ? { error: r.error } : { path: r.path };
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
  '/api/chats/keep-answer': async ({ res, b }) => {
    // {id, prompt, text}: Save the file again, for a first answer whose file could not be saved.
    const c = await chats.get(String(b.id ?? '')).catch(() => null);
    if (!c) return json(res, 404, { error: 'That chat is not here any more.' });
    const text = typeof b.text === 'string' ? b.text : '';
    if (!c.project || !text.trim()) return json(res, 400, { error: 'There is nothing to save for this chat: the answer is in the chat.' });
    const r = await saveAnswer(c, String(b.prompt ?? ''), text);
    return 'error' in r ? json(res, 400, { error: `The file was not saved: ${r.error}. Check the project's folder in Files, then try again.` }) : json(res, 200, r);
  },
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
