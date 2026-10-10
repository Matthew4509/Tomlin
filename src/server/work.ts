// The workspace: its files, the live preview, the blog writer and Start project.
import type { ServerResponse } from 'node:http';
import { readFile, stat, copyFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';
import { repeatCut, streamChat } from '../engine.ts';
import { cleanPrompt } from '../chatpic.ts';
import { toneOf } from '../persona.ts';
import { nowModel, sizeB, roleOf, drawsFor, type StaffMember } from '../staff.ts';
import * as ws from '../workspace.ts';
import { blogAsk, blogSystem, splitPost, blogSlug, blogFile, BLOG_PICTURE_SYSTEM } from '../blog.ts';
import * as project from '../project.ts';
import { jobId, validId, cleanProjectFolder, cleanTeam, folderStamp, type Team } from '../jobs.ts';
import { checkMessage, REFUSAL } from '../filter.ts';
import { HOME, ROOT, type Routes, SECURITY_HEADERS, chatModels, chats, json, shortName, staff, staffId, store, workspaceDir } from './core.ts';
import { chat, chatList, contextBytes, fit, images, lastUsed, main, runOf } from './panes.ts';
import { answeringBusy, askOnce, endAnswer, imageSpecialist, takeChat } from './answering.ts';
import { jobRoutes } from './jobs.ts';
import { appLock, appLockOn } from './locks.ts';

// ---- Live preview (PLAN F10 G7): the workspace's pages, shown in a sandbox beside a job ----
// Served at /preview/<key>/<path>: the key is made at each start and given only to the page (through /api/preview,
// behind the app lock), so the frame's own requests need no cookie. Every answer carries a CSP sandbox: the page runs
// its own scripts but has no origin of its own, cannot call TOMLIN or any other address (connect-src 'none'),
// cannot load anything from outside this PC, and cannot send a form.
const PREVIEW_KEY = randomBytes(16).toString('hex');
const PREVIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const PREVIEW_HEADERS = {
  'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export async function previewFile(res: ServerResponse, path: string): Promise<void> {
  const m = /^\/preview\/([a-f0-9]{32})\/(.+)$/.exec(path);
  const notHere = (why: string) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...PREVIEW_HEADERS });
    res.end(why);
  };
  if (!m || m[1] !== PREVIEW_KEY) return notHere('This preview is out of date: press Reload in the job window.');
  // The frame's own requests carry no cookie, so the key opens it; while the app lock is shut, it opens nothing.
  if (appLockOn() && !appLock.isOpen()) return notHere('TOMLIN is locked. Open it with its PIN, then press Reload.');
  let rel: string;
  try {
    rel = decodeURIComponent(m[2]);
  } catch {
    return notHere('Not found.');
  }
  const type = PREVIEW_TYPES[extname(rel).toLowerCase()];
  const full = type ? await ws.inside(await workspaceDir(), rel, false) : null;
  const st = full ? await stat(full).catch(() => null) : null;
  if (!full || !st?.isFile() || st.size > ws.MAX_BYTES) return notHere(`${rel} is not in the workspace (or is not a file a page can show).`);
  res.writeHead(200, { 'content-type': type, ...PREVIEW_HEADERS });
  res.end(await readFile(full));
}

/** The pages the preview can show (newest first), the key, and a stamp that changes whenever a workspace file does. */
async function previewView() {
  const files = await ws.list(await workspaceDir());
  return {
    key: PREVIEW_KEY,
    pages: files.filter(f => /\.html?$/i.test(f.path) && !f.path.startsWith('jobs/')).map(f => f.path),
    stamp: files.reduce((t, f) => (f.at > t ? f.at : t), '') + `:${files.length}`,
  };
}

// ---- Files and the blog writer ----

/** The blog post, written by the connected chat model and streamed to the page. Nothing is saved until the person says. */
async function blogWrite(res: ServerResponse, b: Record<string, unknown>): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...SECURITY_HEADERS });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ask = blogAsk(b);
  if (!ask) { send('error', { text: 'Type what the post is about first.' }); return void res.end(); }
  if (chat.view.state !== 'connected' || !chat.worker.base) { send('error', { text: 'No chat model is loaded: the blog writer uses the one in the host\'s chat. Press Connect there, then press Write the post again.' }); return void res.end(); }
  const verdict = checkMessage(ask.topic, { recent: [] });
  if (!verdict.ok) { send('refused', { text: REFUSAL[verdict.reason] }); return void res.end(); }
  if (answeringBusy(main())) { send('error', { text: 'The chat model is answering in a chat now. Wait for it to finish (or press Stop in that chat), then press Write the post again.' }); return void res.end(); }
  const ac = new AbortController();
  takeChat(ac, main(), '', '', 'The blog writer');
  res.once('close', () => endAnswer(ac));
  lastUsed.chat = Date.now();
  res.on('close', () => ac.abort());
  let shown = '';
  try {
    // The tone picked in the blog writer, else the chat's.
    const tone = toneOf(typeof b.tone === 'string' && b.tone ? b.tone : (await store.settings()).tone).prompt;
    await streamChat(chat.worker.base, chat.view.model ?? '', [{ role: 'system', content: blogSystem(ask, tone) }, { role: 'user', content: `Write the post about: ${ask.topic}` }], text => {
      const cut = repeatCut(text);
      shown = cut ?? text;
      send('text', { text: shown });
      if (cut !== null) ac.abort();
    }, ac.signal, 2048);
  } catch (error) {
    if (!ac.signal.aborted) { send('error', { text: `The model stopped part-way: ${(error as Error).message}. Try again.` }); return void res.end(); }
  } finally {
    endAnswer(ac);
    lastUsed.chat = Date.now();
  }
  const post = splitPost(shown);
  send('done', { title: post.title, body: post.body, words: post.body.split(/\s+/).filter(Boolean).length });
  res.end();
}

/** Saves the post as blog/<name>.md in the workspace (never over an existing post: a number is added). */
async function blogSave(b: Record<string, unknown>) {
  const root = await workspaceDir();
  const title = String(b.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const text = String(b.body ?? '').trim();
  if (!title || !text) return { status: 400, body: { error: 'The post needs a title and some text.' } };
  // Saving the same post again writes over its own file (the old version is kept as .bak); a new post gets a new name.
  const again = typeof b.path === 'string' && /^blog\/[\w.-]+\.md$/.test(b.path) && (await ws.read(root, b.path).then(r => !('error' in r))) ? b.path : '';
  const slug = blogSlug(title);
  let rel = again || `blog/${slug}.md`;
  if (!again) for (let n = 2; await ws.read(root, rel).then(r => !('error' in r)); n++) rel = `blog/${slug}-${n}.md`;
  const r = await ws.save(root, rel, blogFile(title, text));
  return 'error' in r ? { status: 400, body: r } : { status: 200, body: { path: r.path } };
}

/** A saved post's title and opening (the picture prompt is written from them). */
async function blogOpening(path: unknown) {
  const root = await workspaceDir();
  const file = await ws.read(root, path);
  if ('error' in file) return { error: file.error, root, file: null, name: '', opening: '' };
  const title = /^title:\s*(".*")\s*$/m.exec(file.text)?.[1];
  const name = title ? (JSON.parse(title) as string) : file.path;
  const opening = file.text.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*\n/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().slice(0, 900);
  return { error: '', root, file, name, opening };
}

/**
 * The picture prompt for a saved post, written by the chat model and shown in the "Send to…" card before anything is
 * drawn (read it, change it, copy it, or send it to an artist). The artist suggested is the one chosen to draw, unless
 * they only make icons (the designer would turn the post's photo into one).
 */
async function blogPrompt(b: Record<string, unknown>) {
  if (chat.view.state !== 'connected') return { status: 409, body: { error: 'Connect a chat model first: it writes the picture prompt from the post.' } };
  const post = await blogOpening(b.path);
  if (!post.file) return { status: 404, body: { error: post.error } };
  const prompt = cleanPrompt(await askOnce(BLOG_PICTURE_SYSTEM, `Title: ${post.name}\n\n${post.opening}`, 120));
  if (!prompt) return { status: 500, body: { error: 'The chat model could not think of a picture. Try again.' } };
  const chosen = await imageSpecialist();
  return { status: 200, body: { prompt, as: chosen && drawsFor(chosen.role, 'blog') ? `staff:${chosen.id}` : '' } };
}

/**
 * A picture for a saved post: drawn from the prompt sent from the card (or one the chat model writes now), by the artist
 * picked there (or none: this PC's picture model), and copied next to the post.
 */
async function blogPicture(b: Record<string, unknown>) {
  // {chat, as}: the chat the picture goes into ('' = none) and who draws it ('' = nobody), named by the page. The
  // server's open chat and "Draw as" are whichever window chose last, so they decide neither.
  if (typeof b.chat !== 'string' || typeof b.as !== 'string') return { status: 400, body: { error: 'Nothing was drawn: this names no chat or artist for the picture (the page may be from an older TOMLIN). Reload the page, then draw again.' } };
  const inChat = b.chat ? await chats.get(b.chat) : null;
  if (b.chat && !inChat) return { status: 404, body: { error: 'Nothing was drawn: the chat this picture was for is not there any more (it may have been deleted in another window). Open a chat from the list, then draw again.' } };
  const given = typeof b.prompt === 'string' ? b.prompt.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  if (!given && chat.view.state !== 'connected') return { status: 409, body: { error: 'Connect a chat model first: it writes the picture prompt from the post.' } };
  if (images.pane.view.state !== 'connected') return { status: 409, body: { error: 'Connect a picture model in the Images window first. Nothing loads by itself.' } };
  const post = await blogOpening(b.path);
  if (!post.file) return { status: 404, body: { error: post.error } };
  const { root, file, name } = post;
  const prompt = given || cleanPrompt(await askOnce(BLOG_PICTURE_SYSTEM, `Title: ${name}\n\n${post.opening}`, 120));
  if (!prompt) return { status: 500, body: { error: 'The chat model could not think of a picture. Try again.' } };
  // Picked in the card ("staff:<id>", or '' for nobody).
  const who = staffId(b.as) ? staff.get(b.as.slice(6)) ?? null : null;
  if (b.as && (!who || !roleOf(who.role).kind)) return { status: 400, body: { error: 'That artist is not on the team any more. Pick another in the card.' } };
  // The blog writer is opened from a chat: its picture belongs to the chat that window had open.
  const job = await images.generate({ prompt, drafts: 1, source: 'chat', mode: 'blog', chat: inChat?.id, ...(who ? { as: who.id } : {}) });
  if (!('id' in job)) return { status: 422, body: { error: job.error } };
  await job.done;
  const pic = job.results[0];
  if (!pic) return { status: 500, body: { error: job.error ?? 'The picture did not come out. Try again.' } };
  await images.gallery.update(pic.id, { kept: true });
  const from = await images.gallery.file(pic.output);
  if (!from) return { status: 500, body: { error: 'The picture file is missing.' } };
  const ext = pic.output.slice(pic.output.lastIndexOf('.'));
  const picRel = file.path.replace(/\.md$/i, '') + ext;
  const dest = await ws.inside(root, picRel, false);
  if (!dest) return { status: 400, body: { error: 'Could not place the picture next to the post.' } };
  await copyFile(from, dest);
  const base = picRel.split('/').pop()!;
  // Read again: the post may have been changed in Files while the picture was drawn (minutes), and that change stays.
  const again = await blogOpening(b.path);
  const body = (again.file?.text ?? file.text).replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*\n+/, '').replace(/^!\[[^\]]*\]\([^)]*\)\s*/, '');
  const text = blogFile(name, body.trim(), { picture: base, alt: pic.altText ?? name });
  const saved = await ws.save(root, file.path, text);
  return 'error' in saved ? { status: 400, body: saved } : { status: 200, body: { path: file.path, picture: picRel, prompt } };
}

// ---- Start project: the questions, the look, who could do each kind of work; code writes the cards into the job folder ----

/** Everyone and everything that could do project work: hires here and on linked PCs, and models nobody was hired on yet. */
async function projectCandidates(): Promise<project.Candidate[]> {
  const s = await store.settings();
  const models = chatList();
  const pictures = images.list();
  const chatFit = (id: string) => fit((chatModels.list().find(m => m.id === id)?.bytes ?? 0) + contextBytes(id, runOf(s, id)), 'chat').level;
  const local = (m: { id: string; name: string; bytes: number }, hire: StaffMember | null): project.Candidate =>
    ({ kind: 'chat', hire: hire?.name ?? null, role: hire?.role ?? null, model: shortName(m.name), where: 'This PC', sizeB: sizeB(m.name, m.bytes), ctx: runOf(s, m.id).ctx, fit: chatFit(m.id) });
  const out: project.Candidate[] = [];
  for (const h of staff.list()) {
    const now = nowModel(h);
    if (roleOf(h.role).kind) {
      const x = pictures.find(p => p.id === now && p.installed);
      if (x) out.push({ kind: 'image', hire: h.name, role: h.role, model: shortName(x.name), where: 'This PC', sizeB: 0, ctx: 0, fit: x.fit.level });
    } else if (now?.startsWith('remote:')) {
      const r = s.remotes.find(x => x.id === now.slice(7));
      const hello = r ? jobRoutes.lastHello(r.id) : null;
      if (r && hello?.model) out.push({ kind: 'chat', hire: h.name, role: h.role, model: shortName(hello.model), where: r.name, sizeB: sizeB(hello.model, 0), ctx: hello.ctx, fit: 'ok' });
    } else {
      const m = models.find(x => x.id === now);
      if (m) out.push(local(m, h));
    }
  }
  for (const m of models) out.push(local(m, null));
  for (const x of pictures.filter(p => p.installed)) out.push({ kind: 'image', hire: null, role: null, model: shortName(x.name), where: 'This PC', sizeB: 0, ctx: 0, fit: x.fit.level });
  return out;
}

/** Projects saved from Start project that have no plan yet (newest first). */
async function savedProjects() {
  const root = await workspaceDir();
  const files = new Set((await ws.list(root)).map(f => f.path));
  const out: { id: string; statement: string; created: string }[] = [];
  for (const f of files) {
    const m = /^jobs\/([^/]+)\/project\.json$/.exec(f);
    if (!m || files.has(`jobs/${m[1]}/plan.json`)) continue;
    const r = await ws.read(root, f);
    if ('error' in r) continue;
    try {
      const p = JSON.parse(r.text);
      out.push({ id: m[1], statement: String(p.name || p.answers?.statement || p.prompt || ''), created: String(p.created ?? '') });
    } catch { /* a broken file is left alone */ }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

/** The hires who chat: who may lead a project (artists and designers draw). */
const chatHireIds = () => staff.list().filter(m => !roleOf(m.role).kind).map(m => m.id);

/**
 * Home's name, folder and project manager, cleaned: the folder is made inside the workspace (the date and time when it
 * is left empty). An error in words when the folder cannot be one.
 */
async function projectPlace(b: Record<string, unknown>): Promise<{ folder: string; team: Team } | { error: string }> {
  const typed = String(b.folder ?? '').trim();
  const folder = typed ? cleanProjectFolder(typed) : folderStamp();
  if (!folder) return { error: 'Use a plain folder name for the project, such as 2026-10-07-1116 or tip-calculator (no : * ? " < > |, and not "jobs", "chats" or "notes": those folders are kept for the plans, quick chats and notes). It is made inside the workspace folder; to work somewhere else, change the workspace folder in Files.' };
  try {
    await mkdir(join(await workspaceDir(), ...folder.split('/')), { recursive: true });
  } catch (err) {
    return { error: `The project folder could not be made in the workspace folder (${(err as NodeJS.ErrnoException).code ?? 'Windows would not make it'}). Check the workspace folder in Files, then try again.` };
  }
  return { folder, team: cleanTeam({ pm: String(b.pm ?? '') }, chatHireIds()) };
}

/** "Lets create a project" on Home: the project's folder, its Scope card (the person's own words, by code) and the default design brief. */
async function projectCreate(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const place = await projectPlace(b);
  if ('error' in place) return { status: 400, body: place };
  const q = project.cleanQuick(b, place.folder);
  if ('error' in q) return { status: 400, body: q };
  const verdict = checkMessage([q.name, q.about, q.prompt].join('\n'), { recent: [] });
  if (!verdict.ok) return { status: 400, body: { error: REFUSAL[verdict.reason] } };
  // A mini description that wishes for what nobody can promise goes on the Scope card as a hope, not as the statement.
  const hope = q.about && project.wishLine(q.about) ? q.about : null;
  const wish = project.wishLine(q.about, q.prompt);
  const now = new Date();
  const id = jobId(now);
  const scope = project.quickScope(q, hope);
  const brief = project.designBrief(project.DESIGN_DEFAULT);
  const root = await workspaceDir();
  for (const [file, text] of [['project.json', JSON.stringify({ id, created: now.toISOString(), ...q, team: place.team, wish }, null, 2)], ['scope.md', scope], ['design.md', brief]] as const) {
    const r = await ws.save(root, project.projectPath(id, file), text);
    if ('error' in r) return { status: 500, body: { error: `The project could not be saved in the workspace folder (${r.error}).` } };
  }
  return { status: 200, body: { id, name: q.name, folder: q.folder, path: join(root, ...q.folder.split('/')) } };
}

/** The pencil on the Scope card or the design brief: the person's own text replaces the card the planner and the steps read. */
async function projectCard(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const which = b.which === 'scope' || b.which === 'design' ? b.which : null;
  if (!validId(b.id) || !which) return { status: 400, body: { error: 'That card is not one of a project here.' } };
  const text = String(b.text ?? '').replace(/\r/g, '').trim();
  if (!text) return { status: 400, body: { error: 'The card is empty: type what it should say, or press Cancel to keep it as it was.' } };
  if (text.length > 6000) return { status: 400, body: { error: `The card is ${text.length.toLocaleString()} characters: keep it under 6,000, so a small model can still read it with the step.` } };
  const verdict = checkMessage(text, { recent: [] });
  if (!verdict.ok) return { status: 400, body: { error: REFUSAL[verdict.reason] } };
  const r = await ws.save(await workspaceDir(), project.projectPath(b.id, which === 'scope' ? 'scope.md' : 'design.md'), `${text}\n`, false);
  if ('error' in r) return { status: 404, body: { error: 'That project has no such card any more (its folder was moved or deleted).' } };
  return { status: 200, body: { text } };
}

async function projectSetup() {
  return {
    // Home's form: the default folder (the date and time), where it goes, and who may lead a project.
    folder: folderStamp(),
    workspace: await workspaceDir(),
    staff: staff.list().filter(m => !roleOf(m.role).kind).map(m => ({ id: m.id, name: m.name, role: roleOf(m.role).name })),
    questions: project.QUESTIONS,
    look: { type: project.TYPE_STYLES, weights: project.WEIGHTS, sizes: project.SIZES, palettes: project.PALETTES, layouts: project.LAYOUTS, defaults: project.DESIGN_DEFAULT },
    suggestions: project.suggestHires(await projectCandidates()),
    saved: await savedProjects(),
  };
}

const projectTexts = (a: project.Answers) => [a.what, ...a.must];

export async function projectPost(p: string, b: Record<string, unknown>, res: ServerResponse): Promise<boolean> {
  if (p !== '/api/projects/check' && p !== '/api/projects/save') return false;
  const raw = (b.answers && typeof b.answers === 'object' ? b.answers : {}) as Record<string, unknown>;
  const a = project.cleanAnswers(p === '/api/projects/check' ? { ...raw, statement: '' } : raw);
  if ('error' in a) return json(res, 400, { error: a.error }), true;
  const verdict = checkMessage(projectTexts(a).join('\n'), { recent: [] });
  if (!verdict.ok) return json(res, 400, { error: REFUSAL[verdict.reason] }), true;
  const hope = projectTexts(a).find(t => project.wishLine(t)) ?? null;
  const wish = hope ? project.wishLine(hope) : null;
  // A wish is not a function: it goes on the Scope card as "Hope, not promised", not as F3.
  if (hope && a.must.includes(hope)) a.must = a.must.filter(t => t !== hope);
  if (p === '/api/projects/check') return json(res, 200, { statement: a.statement, wish, answers: a }), true;
  const design = project.cleanDesign((b.design && typeof b.design === 'object' ? b.design : {}) as Record<string, unknown>);
  // The name, folder and project manager typed on Home's "Lets create a project" come with it.
  const home = (b.home && typeof b.home === 'object' ? b.home : {}) as Record<string, unknown>;
  const place = await projectPlace(home);
  if ('error' in place) return json(res, 400, place), true;
  const now = new Date();
  const id = jobId(now);
  const scope = project.scopeCard(a, hope);
  const brief = project.designBrief(design);
  const root = await workspaceDir();
  const name = String(home.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Project ${place.folder}`;
  for (const [file, text] of [['project.json', JSON.stringify({ id, created: now.toISOString(), name, folder: place.folder, team: place.team, answers: a, design, wish }, null, 2)], ['scope.md', scope], ['design.md', brief]] as const) {
    const r = await ws.save(root, project.projectPath(id, file), text);
    if ('error' in r) return json(res, 500, { error: `The project could not be saved in the workspace folder (${r.error}).` }), true;
  }
  return json(res, 200, { id, scope, design: brief, chars: scope.length + brief.length, folder: `jobs/${id}` }), true;
}

async function projectGet(id: string | null) {
  if (!validId(id)) return null;
  const root = await workspaceDir();
  const read = async (f: 'scope.md' | 'design.md' | 'project.json') => {
    const r = await ws.read(root, project.projectPath(id, f));
    return 'error' in r ? null : r.text;
  };
  const [scope, design, meta] = await Promise.all([read('scope.md'), read('design.md'), read('project.json')]);
  if (!scope || !design || !meta) return null;
  const p = JSON.parse(meta);
  return { id, scope, design, chars: scope.length + design.length, statement: String(p.answers?.statement || p.prompt || p.about || ''), folder: `jobs/${id}` };
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const workGet: Routes = {
  '/api/preview': async ({ res }) => json(res, 200, await previewView()),
  '/api/files': async ({ res }) => {
    const root = await workspaceDir();
    return json(res, 200, { folder: root, files: await ws.list(root) });
  },
  '/api/projects/setup': async ({ res }) => json(res, 200, await projectSetup()),
  '/api/projects/get': async ({ res, url }) => {
    const pr = await projectGet(url.searchParams.get('id'));
    return pr ? json(res, 200, pr) : json(res, 404, { error: 'That project is not in this workspace any more.' });
  },
  '/api/files/read': async ({ res, url }) => {
    const r = await ws.read(await workspaceDir(), url.searchParams.get('path'));
    return json(res, 'error' in r ? 404 : 200, r);
  },
  '/api/files/picture': async ({ res, url }) => {
    const full = await ws.inside(await workspaceDir(), url.searchParams.get('path'), false);
    const type = ({ '.png': 'image/png', '.webp': 'image/webp' } as Record<string, string>)[extname(full ?? '').toLowerCase()];
    if (!full || !type) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return void res.end(await readFile(full).catch(() => Buffer.alloc(0)));
  },
};

/** POST requests answered here, by path (the body is read already). */
export const workPost: Routes = {
  '/api/files/save': async ({ res, b }) => {
    const r = await ws.save(await workspaceDir(), b.path, b.text, b.create !== false);
    return json(res, 'error' in r ? 400 : 200, r);
  },
  '/api/files/folder': async ({ res, b }) => {
    const path = ws.cleanFolder(b.path);
    if (path === null) return json(res, 400, { error: 'Use a full folder path such as C:\\Users\\you\\Documents\\Writing (not a drive root or a Windows folder). Leave it empty for the default folder.' });
    // TOMLIN's own folders (the app, and the home with your chats) are never a workspace: Files could read your
    // chats there, and a job step could write over the app's own code.
    if (path && ws.overlaps(path, [ROOT, HOME.home])) return json(res, 400, { error: `That folder is (or holds) one of TOMLIN's own folders (${HOME.home} or ${ROOT}). Choose a folder of your own, such as one in Documents. Nothing was changed.` });
    // mkdir answers with the first folder it made, so a typo in the path is reported, not silently made.
    let made: string | undefined;
    if (path) {
      try {
        made = await mkdir(path, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const why = code === 'ENOENT' ? 'that drive is not on this PC' : code === 'EACCES' || code === 'EPERM' ? 'Windows does not allow writing there' : 'Windows would not make it';
        return json(res, 400, { error: `Could not use that folder: ${why}. Check the drive letter and the spelling, or choose a folder in your own Documents. Nothing was changed.` });
      }
    }
    await store.saveSettings({ workspace: path });
    const root = await workspaceDir();
    return json(res, 200, { folder: root, made: made ?? null, files: await ws.list(root) });
  },
  '/api/blog': async ({ res, b }) => {
    return blogWrite(res, b);
  },
  '/api/blog/save': async ({ res, b }) => {
    const r = await blogSave(b);
    return json(res, r.status, r.body);
  },
  '/api/blog/picture': async ({ res, b }) => {
    const r = await blogPicture(b);
    return json(res, r.status, r.body);
  },
  '/api/blog/prompt': async ({ res, b }) => {
    const r = await blogPrompt(b);
    return json(res, r.status, r.body);
  },
  '/api/projects/create': async ({ res, b }) => {
    const r = await projectCreate(b);
    return json(res, r.status, r.body);
  },
  '/api/projects/card': async ({ res, b }) => {
    const r = await projectCard(b);
    return json(res, r.status, r.body);
  },
};
