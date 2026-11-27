// Where work goes in the workspace (src/folders.ts): a chat's Save, a quick chat's files going into a project, a note
// saved from the right panel, a picture kept in a project's chat, and the work handed in to a project.
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { cleanSource, ignoreSources, sourceName, writeSource } from '../sources.ts';
import * as folders from '../folders.ts';
import * as ws from '../workspace.ts';
import { cleanProjectFolder } from '../jobs.ts';
import { type WorkFile, playPage, sortWork } from '../projectwork.ts';
import type { ChatInfo } from '../chats.ts';
import type { Picture } from '../gallery.ts';
import { type Routes, chats, json, staff, staffId, workspaceDir } from './core.ts';
import { jobRoutes } from './jobs.ts';
import { images } from './panes.ts';

/** A project's folder in the workspace ('' when it is kept at the top), or null when there is no such project. */
export async function projectFolder(id: string | undefined): Promise<string | null> {
  if (!id) return null;
  const job = await jobRoutes.loadJob(id);
  // Cleaned as the job's own steps clean it (jobRoot): plan.json is a file in the workspace, so a folder written into it
  // ("..", a path to somewhere else) must never become the folder a chat's file tools work in.
  if (job) return (job.folder ? cleanProjectFolder(job.folder) : null) ?? '';
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

/** Where a picture went in a project (its workspace path), or why it did not: the picture is in the gallery either way. */
export type PictureSaved = { project: string; name: string; path: string } | { project: string; name: string; error: string };

/** A project's name as the page shows it. */
async function projectName(id: string): Promise<string> {
  const job = await jobRoutes.loadJob(id).catch(() => null);
  if (job) return job.name || job.goal || 'the project';
  const info = await jobRoutes.projectInfo(id).catch(() => null);
  return info?.name || info?.goal || 'the project';
}

/** One save of a picture at a time, so two presses never write the picture's list of projects over each other. */
let savingTurn: Promise<unknown> = Promise.resolve();

/**
 * A gallery picture handed in to project `project` (Save to project, or kept in a project's chat): a copy in its
 * specialists\images folder, and the project written on the picture (savedTo) so the viewer lists it.
 */
export function pictureToProject(project: string, p: Picture): Promise<PictureSaved> {
  const run = savingTurn.then(async () => {
    const name = await projectName(project);
    const r = await handInTo(project, p.prompt, await images.gallery.file(p.output), p.output);
    if ('error' in r) return { project, name, error: r.error };
    if (p.icoFiles?.length) await handInIconSizes(p.icoFiles, r.path);
    const was = (await images.gallery.get(p.id))?.savedTo ?? [];
    await images.gallery.update(p.id, { savedTo: [...was.filter(s => s.project !== project), { project, name, path: r.path }] }).catch(() => undefined);
    return { project, name, path: r.path };
  });
  savingTurn = run.catch(() => undefined);
  return run;
}

/**
 * An icon's sizes and .ico (Icon sizes, under Advanced) go with it into the project, beside its copy and named after it:
 * "<copy>-16.png" ... "<copy>.ico". One whose name is taken there is left (never written over); a fault in one never
 * stops the hand-in, which is in the project either way.
 */
async function handInIconSizes(icoFiles: string[], copy: string): Promise<void> {
  const root = await workspaceDir();
  const at = await ws.inside(root, copy, false);
  if (!at) return;
  const stem = at.slice(0, at.length - extname(at).length);
  for (const rel of icoFiles) {
    const size = /-(\d{1,4})\.png$/i.exec(rel)?.[1];
    const dest = size ? `${stem}-${size}.png` : /\.ico$/i.test(rel) ? `${stem}.ico` : null;
    const from = dest ? await images.gallery.file(rel) : null;
    if (!dest || !from) continue;
    await copyFile(from, dest, constants.COPYFILE_EXCL).catch(() => undefined);
  }
}

/** The copy this picture already has in that project, while its file is still there. */
async function savedIn(p: Picture, project: string): Promise<{ project: string; name: string; path: string } | null> {
  const s = p.savedTo?.find(x => x.project === project);
  if (!s) return null;
  const at = await ws.inside(await workspaceDir(), s.path, false);
  return at && existsSync(at) ? s : null;
}

/**
 * A queue picture handed in to its project once: the copy it has there already (handed in before TOMLIN was closed,
 * its queue line not yet marked done) is the answer, so a restart never makes a second copy. Written on the picture.
 */
export async function handInOnce(project: string, p: Picture): Promise<PictureSaved> {
  const had = await savedIn((await images.gallery.get(p.id)) ?? p, project);
  return had ?? pictureToProject(project, p);
}

/**
 * A picture kept in a chat that belongs to a project is handed in to that project: a copy goes into its
 * specialists\images folder, named with the date and time and the picture's first words. Where it went, or why not
 * (the picture is in the gallery either way); null when its chat is in no project.
 */
export async function handInPicture(p: Picture, file: string | null): Promise<PictureSaved | null> {
  if (!p.chat) return null;
  const c = await chats.get(p.chat).catch(() => null);
  if (!c?.project) return null;
  if (!file) return { project: c.project, name: await projectName(c.project), error: 'the picture file is not in the gallery' };
  // Kept, taken back to Drafts and kept again: the copy it has there is the answer; one taken away is made again.
  return handInOnce(c.project, p);
}

/** Opens a folder in Windows Explorer without waiting for it; true when it started. Tests put their own in. */
export const folderOpener = {
  open: async (dir: string): Promise<boolean> => {
    if (process.platform !== 'win32') return false;
    const cp = await import('node:child_process');
    return new Promise(done => {
      const child = cp.spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
      child.once('spawn', () => (child.unref(), done(true)));
      child.once('error', () => done(false));
    });
  },
};

/**
 * A picture handed in to project `project` (a picture drawn by the queue names its own project): a copy in its
 * specialists\images folder, named with the date and time and the picture's first words. Its workspace path, or why not.
 */
export async function handInTo(project: string, prompt: string, file: string | null, output: string, kind: 'picture' | 'clip' | 'voice' = 'picture'): Promise<{ path: string } | { error: string }> {
  try {
    const folder = await projectFolder(project);
    if (folder === null) return { error: 'that project is not in this workspace any more' };
    if (!file) return { error: kind === 'clip' ? 'the clip file is not on the Videos shelf' : kind === 'voice' ? 'the voice-over is not on the Voice shelf' : 'the picture file is not in the gallery' };
    const ext = extname(output).toLowerCase();
    const first = kind === 'clip' ? folders.clipPath(folder, prompt, ext || '.webm') : kind === 'voice' ? folders.voicePath(folder, prompt, ext || '.wav') : folders.picturePath(folder, prompt, ext || '.png');
    const at = await ws.inside(await workspaceDir(), first, false);
    if (!at) return { error: 'its folder is outside the workspace' };
    // Two pictures of one prompt kept in the same minute have the same name: the second gets " 2", never written over.
    const rel = folders.freeName(first, r => existsSync(join(dirname(at), r.split('/').pop()!)));
    const dest = join(dirname(at), rel.split('/').pop()!);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file, dest, constants.COPYFILE_EXCL);
    if (kind === 'picture') await handInSource(file, dest, folder ? join(await workspaceDir(), folder) : await workspaceDir());
    return { path: rel };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * A clip made in a chat that belongs to a project is handed in to that project as a picture is: a copy in its
 * specialists\videos folder, named with the date and time and the clip's first words. Never a fault: the clip is on the
 * Videos shelf either way.
 */
export async function handInClip(c: { file: string; prompt: string; chat: string }, file: string): Promise<void> {
  if (!c.chat) return;
  const chat = await chats.get(c.chat).catch(() => null);
  if (!chat?.project) return;
  const r = await handInTo(chat.project, c.prompt, file, c.file, 'clip');
  if ('error' in r) console.warn(`A clip was not copied to its project: ${r.error}`);
}

/** A voice-over made from a project's chat is handed in the same way, to its specialistsoice folder. */
export async function handInVoice(v: { file: string; text: string; chat: string }, file: string): Promise<void> {
  if (!v.chat) return;
  const chat = await chats.get(v.chat).catch(() => null);
  if (!chat?.project) return;
  const r = await handInTo(chat.project, v.text, file, v.file, 'voice');
  if ('error' in r) console.warn(`A voice-over was not copied to its project: ${r.error}`);
}

/**
 * The image source goes with a picture handed in (src/sources.ts): written beside the copy under the copy's name, and
 * git is told to leave image sources out of that project. Never a fault: the picture is handed in either way.
 */
async function handInSource(file: string, dest: string, project: string): Promise<void> {
  try {
    const s = cleanSource(JSON.parse(await readFile(join(dirname(file), sourceName(basename(file))), 'utf8')));
    if (!s) return;
    await writeSource(dirname(dest), { ...s, file: basename(dest) });
    await ignoreSources(project);
  } catch {
    // no source beside it (a picture from before sources): nothing to hand in
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

/** The folder a project page's Open folder opens, by part: the project's own, or one of its specialists folders. */
const PART_DIRS: Record<string, string[]> = { '': [], pictures: [folders.SPECIALISTS, 'images'], writing: [folders.SPECIALISTS, 'writer'], videos: [folders.SPECIALISTS, 'videos'], chats: [folders.CHATS] };

export const placesGet: Routes = {
  '/api/project/work': async ({ res, url }) => {
    // ?id=<project>: its project page (public/projectpage.js): the files in its folder by kind (src/projectwork.ts),
    // with paths from the workspace's top, as /api/files/read and /api/files/picture take them.
    const id = url.searchParams.get('id') ?? '';
    const folder = await projectFolder(id);
    if (folder === null) return json(res, 404, { error: 'That project is not in this workspace any more.' });
    const name = await projectName(id);
    // Kept at the top of the workspace: its files are everyone's, so none are listed as its own.
    if (!folder) return json(res, 200, { id, name, folder: '', top: true, work: sortWork([]), play: null });
    const root = await workspaceDir();
    const under = await ws.filesUnder(root, folder).catch(() => null);
    const found: WorkFile[] = [];
    for (const path of (under?.files ?? []).slice(0, 2000)) {
      const s = await stat(join(root, path)).catch(() => null);
      if (s) found.push({ path: path.slice(folder.length + 1), bytes: s.size, at: s.mtime.toISOString() });
    }
    const work = sortWork(found);
    const withTop = (l: WorkFile[]) => l.map(f => ({ ...f, path: `${folder}/${f.path}` }));
    const play = playPage(work.code);
    return json(res, 200, {
      id, name, folder, top: false, play: play ? `${folder}/${play}` : null,
      work: { code: withTop(work.code), pictures: withTop(work.pictures), writing: withTop(work.writing), videos: withTop(work.videos), chats: withTop(work.chats), more: work.more },
    });
  },
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
  '/api/images/to-project': async ({ res, b }) => {
    // {id, project}: Save to project on a picture: a copy in that project's specialists\images folder. No project: the
    // project of the chat it was drawn in. A draft is added to the gallery first: saving it somewhere is keeping it.
    const p = await images.gallery.get(String(b.id ?? ''));
    if (!p || p.removed || p.private) return json(res, 404, { error: 'That picture is not in the gallery any more.' });
    let project = typeof b.project === 'string' ? b.project : '';
    if (!project && p.chat) project = (await chats.get(p.chat).catch(() => null))?.project ?? '';
    if (!project) return json(res, 400, { error: 'Pick a project: this picture was drawn in a chat with no project.' });
    if ((await projectFolder(project)) === null) return json(res, 404, { error: 'That project is not in this workspace any more. Pick another.' });
    const already = await savedIn(p, project);
    if (already) return json(res, 200, { picture: p, saved: { ...already, already: true } });
    if (p.kept === false) await images.gallery.keep(p.id, true);
    const saved = await pictureToProject(project, p);
    const picture = (await images.gallery.get(p.id)) ?? p;
    if ('error' in saved) return json(res, 400, { error: `Not saved to ${saved.name}: ${saved.error}. It is in the gallery.`, picture, saved });
    return json(res, 200, { picture, saved });
  },
  '/api/project/open-folder': async ({ res, b }) => {
    // {project, part}: a project page's Open folder: the project's folder, or its pictures, writing, videos or chats
    // folder, in Windows Explorer. Only a folder named here, inside the project: no path is taken from the page.
    const project = typeof b.project === 'string' ? b.project : '';
    const part = typeof b.part === 'string' && b.part in PART_DIRS ? b.part : null;
    const folder = project ? await projectFolder(project) : null;
    if (folder === null) return json(res, 404, { error: 'That project is not in this workspace any more.' });
    if (part === null) return json(res, 400, { error: 'Open which folder? The project\'s, or its pictures, writing, videos or chats.' });
    const root = await workspaceDir();
    const rel = [folder, ...PART_DIRS[part]].filter(Boolean).join('/');
    const at = rel ? await ws.inside(root, `${rel}/x`, false) : join(root, 'x');
    if (!at) return json(res, 400, { error: "That project's folder is outside the workspace, so it is not opened." });
    const dir = dirname(at);
    if (!existsSync(dir)) return json(res, 404, { error: `Nothing has been saved there for ${await projectName(project)} yet.` });
    if (!(await folderOpener.open(dir))) return json(res, 500, { error: `Windows could not open the folder. It is ${dir}.` });
    return json(res, 200, { ok: true, dir });
  },
  '/api/images/open-folder': async ({ res, b }) => {
    // {project}: that project's specialists\images folder in Windows Explorer. Only a project's own folder, inside the
    // workspace: no path is taken from the page.
    const project = typeof b.project === 'string' ? b.project : '';
    const folder = project ? await projectFolder(project) : null;
    if (folder === null) return json(res, 404, { error: 'That project is not in this workspace any more.' });
    const at = await ws.inside(await workspaceDir(), `${folders.projectImages(folder)}/x`, false);
    if (!at) return json(res, 400, { error: "That project's pictures folder is outside the workspace, so it is not opened." });
    const dir = dirname(at);
    if (!existsSync(dir)) return json(res, 404, { error: `No pictures have been saved to ${await projectName(project)} yet.` });
    if (!(await folderOpener.open(dir))) return json(res, 500, { error: `Windows could not open the folder. It is ${dir}.` });
    return json(res, 200, { ok: true, dir });
  },
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
  '/api/chats/save-whole': async ({ res, b }) => {
    // {id, text}: Save on the whole chat: into its project's chats folder, or a chat in Default into its own chats
    // folder (src/folders.ts wholeChatPath), never over another file.
    const c = await chats.get(String(b.id ?? '')).catch(() => null);
    if (!c) return json(res, 404, { error: 'That chat is not here any more.' });
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) return json(res, 400, { error: 'This chat has no messages yet: there is nothing to save.' });
    const folder = c.project ? await projectFolder(c.project) : null;
    if (c.project && folder === null) return json(res, 404, { error: 'This chat\'s project is not in this workspace any more. Pick another project in the chat\'s top bar, or Default, then Save again.' });
    const own = folder === null ? await chats.folderOf(c.id) : '';
    if (own === null) return json(res, 404, { error: 'That chat is not here any more.' });
    const root = await workspaceDir();
    const first = folders.wholeChatPath({ chatFolder: own, projectFolder: folder, title: c.title });
    let rel = first;
    for (let n = 2; n < 1000 && (await ws.read(root, rel).then(r => !('error' in r))); n++) rel = first.replace(/\.txt$/, ` ${n}.txt`);
    const r = await ws.save(root, rel, `${text}\n`);
    if ('error' in r) return json(res, 400, { error: `The chat was not saved: ${r.error}` });
    return json(res, 200, { path: r.path, where: r.path.slice(0, r.path.lastIndexOf('/')).replace(/\//g, '\\') });
  },
};
