// Who a chat can be with, which chat is open, the Chats tab's list and the profile photos.
import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as brains from '../brains.ts';
import { WHO, whoOf, cleanName } from '../persona.ts';
import { levelOf, roleOf, type StaffMember } from '../staff.ts';
import { isFaceKey, visibleFaces } from '../faces.ts';
import { LOOK_OPTIONS, cleanLook } from '../look.ts';
import * as mute from '../mute.ts';
import { cleanTitle, subjectFor, whoKind, type ChatInfo } from '../chats.ts';
import * as nodestaff from '../nodestaff.ts';
import { HOST_NAME, HOST_ON, type Route, type Routes, chats, faces, json, mutes, publicSettings, shortName, staff, staffId, store } from './core.ts';
import { chatList, images } from './panes.ts';
import { chatWork, stopChats } from './answering.ts';
import { docStore, liveAnswers } from './chat.ts';
import { jobRoutes } from './jobs.ts';
import { moveChatFiles, saveToOf } from './places.ts';

export const whoList = () => [...WHO.map(({ id, name, hint }) => ({ id, name, hint })), ...staff.list().filter(m => !roleOf(m.role).kind).map(m => ({ id: 'staff:' + m.id, name: m.name + ' (' + roleOf(m.role).name + ', ' + levelOf(m.level).name + ')', hint: roleOf(m.role).hint, staff: true }))];
export const whoId = (v: unknown) => staffId(v) ?? whoOf(v).id;

// ---- Chats: which one is open, starting one, the list for the left panel ----

/** Whether the person a chat is with is still here: a hire who left is not. */
// A hire who lived on a linked PC ('node:<pc>:<hire>') is retired, and the host is off for now: their old chats are kept to read.
export const chatPersonHere = (who: string) => (who.startsWith('staff:') ? !!staffId(who) : !who.startsWith('node:') && HOST_ON);

/** The chat open now, if it is still with the person chosen; null when the next message should start a new one. */
export async function openChat(): Promise<ChatInfo | null> {
  const s = await store.settings();
  const c = await chats.get(s.chatId);
  // A chat with someone who left stays open to read (sending says why it cannot go on).
  return c && (c.who === whoKind(s.who) || !chatPersonHere(c.who)) ? c : null;
}

/**
 * The chat a send names (src/chats.ts namedChat), and who answers in it: a hire's chat is theirs; the host answers as
 * the plain way of talking the page sends (Standard, Professional, Friend), else the one last chosen. A new chat is not
 * made here: its first message makes it (chatToSend).
 */
export type SendTarget = { chat: ChatInfo | null; who: string };
export async function sendTarget(named: { id: string } | { who: string }, plain?: unknown): Promise<SendTarget | { error: string; status: number }> {
  const s = await store.settings();
  const host = () => (typeof plain === 'string' && whoOf(plain).id === plain ? plain : whoKind(s.who) === 'manager' ? s.who : 'standard');
  if ('id' in named) {
    const c = await chats.get(named.id);
    if (!c) return { error: 'That chat is not there any more (it may have been deleted in another window). Pick a chat from the list, or start a new one.', status: 404 };
    return { chat: c, who: c.who === 'manager' ? host() : c.who };
  }
  if (!chatPeople().some(p => p.who === named.who)) return { error: 'The person this chat was to be with is not on the team any more. Pick someone from the list.', status: 400 };
  return { chat: null, who: named.who === 'manager' ? host() : named.who };
}

/** The chat a message goes into: the one named, or a new one with that person, which becomes the open chat. */
export async function chatToSend(t: SendTarget): Promise<ChatInfo> {
  if (t.chat) return t.chat;
  const made = await chats.create(whoKind(t.who));
  await store.saveSettings({ who: whoId(t.who), chatId: made.id });
  return made;
}

/**
 * The host is off: when the one chosen to answer is still the host (a new install, settings from before 2.0.31, or the
 * one chosen was fired), the first hire who chats takes over, with their latest chat. With nobody hired the page says
 * to hire someone. Run at start and when the team or the one chosen changes, never when a window reads its chat: a
 * read in one window must not change what another reopens. Gives the chat to reopen when it chose again, else null.
 */
export async function offHost(): Promise<string | null> {
  if (HOST_ON) return null;
  const s = await store.settings();
  if (whoKind(s.who) !== 'manager') return null;
  const first = staff.list().find(m => !roleOf(m.role).kind);
  if (!first) return null;
  const open = await chats.get(s.chatId);
  // An old host chat he opened to read stays open; the next message goes to the hire.
  return (await store.saveSettings({ who: `staff:${first.id}`, ...(open && open.who === 'manager' && s.chatId ? {} : { chatId: (await chats.latestFor(`staff:${first.id}`))?.id ?? '' }) })).chatId;
}

/**
 * Chooses who answers; when that is someone else than the open chat is with, their latest chat opens (or none yet).
 * Gives that chat's id ('' for none), so the window that chose reads it by id, not whichever chat another window opens
 * in between.
 */
export async function setWho(to: string): Promise<string> {
  // An artist's chat is the pictures pane: they become the one who draws there.
  const s = await store.saveSettings({ who: to, ...(isArtistWho(to) ? { imageAs: to.startsWith('staff:') ? to.slice(6) : to } : {}) });
  const open = await chats.get(s.chatId);
  const opened = !open || open.who !== whoKind(to) ? (await store.saveSettings({ chatId: (await chats.latestFor(whoKind(to)))?.id ?? '' })).chatId : s.chatId;
  // The host is off: the host chosen (firing the one chosen does that) hands over to the first hire who chats.
  return (await offHost()) ?? opened;
}

/** Everyone a new chat can be with: the manager and each hire who chats. */
export function chatPeople() {
  const s = store.peek()!;
  const models = chatList();
  const modelName = (id: string | null | undefined) => shortName(models.find(m => m.id === id)?.name) || 'no model given';
  // A hire's preferred brain: a model here, or what a paired PC said it has loaded the last time it was asked.
  const where = (m: StaffMember): { model: string; pc: string; pcId?: string } => {
    const b = brains.parseRef(m.model);
    if (b.kind !== 'remote') return { model: modelName(m.model), pc: 'this PC' };
    const r = s.remotes.find(x => x.id === b.pc);
    const h = r ? jobRoutes.lastHello(r.id) : null;
    const pc = r?.name ?? 'a PC no longer paired';
    // One of the models that PC lets linked PCs use, by name; else what it had loaded when it last answered.
    if (b.model) return { model: shortName(jobRoutes.sharedName(b.pc, b.model)), pc, ...(r ? { pcId: r.id } : {}) };
    return { model: h?.model ? shortName(h.model) : 'what it has loaded', pc, ...(r ? { pcId: r.id } : {}) };
  };
  const pictures = images.list();
  // roleId: the role by its id ('host' for the host), for what "Write it as a prompt for…" asks (src/sendto.ts).
  const people: Array<{ who: string; name: string; avatar: string; role: string; roleId: string; model: string; pc: string; pcId?: string; hint: string; kind: 'chat' | 'image'; named?: boolean }> = [
    // The host: this PC's own assistant, not one of the staff (it answers on the chat model connected here). Off for now.
    ...(HOST_ON ? [{ kind: 'chat' as const, who: 'manager', name: s.managerName || HOST_NAME, avatar: s.managerName ? s.managerName.slice(0, 2).toUpperCase() : 'H', named: !!s.managerName, role: 'Not staff: this PC\'s own assistant', roleId: 'host', model: modelName(s.hostModel || s.chat.model), pc: 'this PC', hint: 'The host: this PC\'s own assistant, not one of the staff. It answers on its own model (the pencil beside it in the left panel), and how it talks (Standard, Professional, Friend) is set in the chat settings.' }] : []),
    ...staff.list().filter(m => !roleOf(m.role).kind).map(m => ({
      kind: 'chat' as const, who: `staff:${m.id}`, name: m.name, avatar: m.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(), role: roleOf(m.role).name, roleId: roleOf(m.role).id, ...where(m), hint: roleOf(m.role).hint,
    })),
    // Artists: their chat is the pictures pane, and what you type there is drawn word for word.
    ...staff.list().filter(m => roleOf(m.role).kind).map(m => ({
      kind: 'image' as const, who: `staff:${m.id}`, name: m.name, avatar: m.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(), role: `${roleOf(m.role).name} · draws what you ask`, roleId: roleOf(m.role).id,
      model: String(m.model ?? '').startsWith('remote:') ? 'draws on a linked PC' : shortName(pictures.find(x => x.id === m.model)?.name.replace(/\s*\(.*\)$/, '')) || 'the picture model connected here', pc: String(m.model ?? '').startsWith('remote:') ? where(m).pc : 'this PC',
      hint: `${m.name} draws: what you type in their chat goes to the picture model just as you type it.`,
    })),
  ];
  return people;
}

/** Whether a "who" is an artist: a picture hire. */
export function isArtistWho(who: string): boolean {
  const m = staffId(who) ? staff.get(who.slice(6)) : undefined;
  return !!m && !!roleOf(m.role).kind;
}

/** Said (by the app, no model) when a picture is asked for in a chat that does not draw: who draws, and where. */
export function artistPointer(): string {
  const names = chatPeople().filter(p => p.kind === 'image').map(p => p.name.split(/\s+/)[0]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
  return names.length
    ? `Pictures are drawn by ${list === names[0] ? 'your artist, ' : ''}${list}. Open ${names[0]} in the left panel (or New chat, then ${names[0]}) and type what to draw: the words go to the picture model just as you type them.`
    : 'Pictures are drawn by an artist. Hire one under Staff: hire and edit (pick the role Artist), then open their chat and type what to draw: the words go to the picture model just as you type them.';
}

/** Everyone who can have a profile photo: you, the chat people (as above) and the picture specialists. */
function facePeople() {
  const initials = (name: string) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return [
    { who: 'me', name: 'You', avatar: 'You', role: 'Your own photo, beside your messages' },
    ...chatPeople().map(({ who, name, avatar, role }) => ({ who, name, avatar, role })),
    ...staff.list().filter(m => roleOf(m.role).kind && !chatPeople().some(p => p.who === `staff:${m.id}`)).map(m => ({ who: `staff:${m.id}`, name: m.name, avatar: initials(m.name), role: roleOf(m.role).name })),
  ];
}

async function facesView() {
  // looks: each hire's drawn person (src/look.ts), for those with one; lookOptions: the parts and their colours to draw.
  const looks = Object.fromEntries(staff.list().flatMap(m => { const l = cleanLook(m.look); return l ? [[`staff:${m.id}`, l]] : []; }));
  return { faces: visibleFaces(await faces.all()), people: facePeople(), looks, lookOptions: LOOK_OPTIONS };
}

/** The Chats tab's list (newest first), each with whom and how many pictures. */
async function chatsView() {
  const people = chatPeople();
  const pics = await images.gallery.countByChat();
  const nameOf = (who: string) => people.find(p => p.who === who) ?? (who.startsWith('node:') ? { name: 'Someone on another PC', avatar: '?', role: 'Worked on a linked PC (linked PCs no longer lend staff)' } : who.startsWith('staff:') ? { name: 'Someone who left the team', avatar: '?', role: 'Left the team' } : { name: HOST_NAME, avatar: '?', role: '' });
  const list = (await chats.list()).map(c => {
    const p = nameOf(c.who);
    return { ...c, name: p.name, avatar: p.avatar, role: p.role, here: chatPersonHere(c.who), pictures: pics[c.id] ?? 0 };
  });
  const open = await openChat();
  return { chats: list, current: open ? open.id : '', people };
}

/** The chats being answered now, by whom and where (job steps are Home's own line). */
/** The person a chat's `who` names. The host answers as a plain way of talking (Standard, Professional, Friend). */
export function personFor(who: string, people = chatPeople()) {
  return people.find(x => x.who === who) ?? (!staffId(who) && !nodestaff.parseNodeWho(who) ? people.find(x => x.who === 'manager') : undefined);
}

export async function answeringNow() {
  const known = chatPeople();
  return Promise.all([...chatWork.values()].map(async w => {
    const p = personFor(w.who, known);
    return { who: w.who, name: p?.name ?? 'Someone', role: p?.role.replace(/ · draws what you ask$/, '') ?? '', pc: p?.pc ?? '', chat: w.chatId, title: (await chats.get(w.chatId))?.title ?? '', what: w.what, seconds: Math.max(0, Math.round((Date.now() - w.startedAt) / 1000)) };
  }));
}

/** A profile photo: GET /api/faces/file/<who>. */
export async function faceFile(face: RegExpExecArray, res: ServerResponse): Promise<void> {
  const who = decodeURIComponent(face[1]);
  const file = await faces.path(who);
  if (!file) return json(res, 404, { error: 'Not found.' });
  const png = await readFile(file).catch(() => null);
  if (!png) return json(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  return void res.end(png);
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const peopleGet: Routes = {
  '/api/chats': async ({ res }) => json(res, 200, await chatsView()),
  '/api/faces': async ({ res }) => json(res, 200, await facesView()),
};

/** A project a chat can be in: planned (a job), or saved on Home and not planned yet. */
const projectKnown = async (id: string) => !!(await jobRoutes.loadJob(id)) || !!(await jobRoutes.projectInfo(id));

const openOrNew: Route = async ({ res, p, b }) => {
  // Starting a chat loads nothing: it picks the person (and their model in the list); Connect is still his.
  const target = p === '/api/chats/new' ? null : await chats.get(b.id);
  if (p === '/api/chats/open' && !target) return json(res, 404, { error: 'That chat is not there any more. Pick another from the list.' });
  const kind = target ? target.who : String(b.who ?? '');
  if (!target && !chatPeople().some(x => x.who === kind)) return json(res, 400, { error: 'Choose who the chat is with.' });
  // The manager answers as the plain "who" last chosen (Standard, Professional, Friend), sent by the page.
  const plain = whoOf(b.plain).id === b.plain ? whoOf(b.plain).id : (await store.settings()).who;
  const to = kind === 'manager' ? (staffId(plain) ? 'standard' : whoOf(plain).id) : kind;
  // A subject (a chat named for what it is about): one already called that opens, an empty chat open now takes the name.
  const title = p === '/api/chats/new' && b.title !== undefined ? cleanTitle(b.title) : '';
  if (p === '/api/chats/new' && b.title !== undefined && !title) return json(res, 400, { error: 'Type a name for the subject first.' });
  // The project it is made for (Tools, Create new subject): checked, so a chat never points at a project that is gone.
  const project = p === '/api/chats/new' && typeof b.project === 'string' ? b.project : '';
  if (project && !(await projectKnown(project))) return json(res, 404, { error: 'That project is not in this workspace any more. Pick another, or Default.' });
  // {chatId}: the chat on that window's screen, the only one that may take the name (the server's open chat is
  // whichever window opened one last). None sent: a new chat is made.
  const onScreen = typeof b.chatId === 'string' ? b.chatId : '';
  const found = title ? subjectFor(await chats.list(), kind, title, onScreen, project) : null;
  const made = target ?? found?.chat ?? (await chats.create(kind));
  const named = title && !found?.existed ? (await chats.rename(made.id, title)) ?? made : made;
  // A new subject (or the empty chat that took its name) goes into that project at once; one found is in it already.
  const c = p === '/api/chats/new' && !found?.existed && (named.project ?? '') !== project ? (await chats.setProject(named.id, project)) ?? named : named;
  // Opening another chat leaves an answer running (Working now and "Open the chat" bring it back); opening the chat
  // being answered shows it carrying on.
  const busyHere = [...chatWork.values()].some(w => w.chatId === c.id);
  if (chatPersonHere(c.who)) await store.saveSettings({ who: whoId(to) });
  await store.saveSettings({ chatId: c.id });
  const member = c.who.startsWith('staff:') ? staff.get(c.who.slice(6)) : undefined;
  const artist = !!member && !!roleOf(member.role).kind;
  if (chatPersonHere(c.who) && isArtistWho(c.who)) await store.saveSettings({ imageAs: member ? member.id : c.who });
  return json(res, 200, { chat: { ...c, here: chatPersonHere(c.who), live: liveAnswers.has(c.id) }, existed: !!found?.existed, answering: busyHere, lines: await chats.lines(c.id), model: artist ? null : member?.model ?? (c.who === 'manager' ? (await store.settings()).hostModel || null : null), imageModel: artist ? member!.model ?? null : null, settings: publicSettings(await store.settings()) });
};

/** POST requests answered here, by path (the body is read already). */
export const peoplePost: Routes = {
  '/api/chats/new': openOrNew,
  '/api/chats/open': openOrNew,
  '/api/names': async ({ res, b }) => {
    // {who: 'manager', name}: the name he gives the manager.
    const name = cleanName(b.name);
    if (name === null) return json(res, 400, { error: 'That name cannot be used: use letters, spaces, hyphens or apostrophes, up to 30 characters.' });
    if (b.who === 'manager') {
      await store.saveSettings({ managerName: name });
    } else {
      return json(res, 400, { error: 'Choose who to name.' });
    }
    return json(res, 200, await chatsView());
  },
  '/api/chats/project': async ({ res, b }) => {
    // A chat's work belongs to a project (its job id), or to Default (''): the chats by date.
    const c = await chats.get(b.id);
    if (!c) return json(res, 404, { error: 'That chat is not there any more. Pick another from the list.' });
    const project = String(b.project ?? '');
    if (project && !(await projectKnown(project))) return json(res, 404, { error: 'That project is not in this workspace any more. Pick another, or Default.' });
    const now = await chats.setProject(c.id, project);
    // Put in a project ("saved properly"): the files saved from this quick chat move into the project.
    const said = now && project ? await moveChatFiles(now) : '';
    return json(res, 200, { chat: now && { ...now, saveTo: await saveToOf(now) }, said, ...(await chatsView()) });
  },
  '/api/chats/pin': async ({ res, b }) => {
    // {id, on}: pinned chats sit under Projects in the left panel and stay there until unpinned.
    const c = await chats.get(b.id);
    if (!c) return json(res, 404, { error: 'That chat is not there any more (it may have been deleted in another window). Pick another from the list.' });
    await chats.mark(c.id, { pinned: b.on === true });
    return json(res, 200, await chatsView());
  },
  '/api/chats/rename': async ({ res, b }) => {
    const c = await chats.get(b.id);
    const r = c ? await chats.rename(c.id, String(b.title ?? '')) : null;
    return r ? json(res, 200, { chat: r }) : json(res, 400, { error: 'Type a name for the chat.' });
  },
  '/api/faces': async ({ res, b }) => {
    // {who, picture}: that picture becomes who's profile photo; {who, picture: null}: their photo is taken away.
    const who = String(b.who ?? '');
    const person = isFaceKey(who) ? facePeople().find(x => x.who === who) : undefined;
    if (!person) return json(res, 404, { error: 'That person is not on the team any more. Pick someone from the list.' });
    if (b.picture === null) {
      await faces.clear(who);
      return json(res, 200, await facesView());
    }
    // {file}: a gallery file (the old one-per-browser photo, moved in once by the page).
    const pic = typeof b.file === 'string' ? (await images.gallery.all()).find(x => x.output === b.file) : await images.gallery.get(String(b.picture ?? ''));
    const file = pic && !pic.removed ? await images.gallery.file(pic.output) : null;
    if (!pic || !file) return json(res, 404, { error: 'That picture is not in the gallery any more. Pick another one.' });
    await faces.set(who, await readFile(file), { id: pic.id, prompt: pic.prompt });
    return json(res, 200, await facesView());
  },
  '/api/chats/delete': async ({ res, b }) => {
    const c = await chats.get(b.id);
    if (!c) return json(res, 404, { error: 'That chat is not there any more.' });
    stopChats(a => a.chatId === c.id);
    // An answer or picture still running for it saves nothing after this, so its file is never written again.
    store.chatEmptied(chats.file(c.id));
    if ((await store.settings()).chatId === c.id) await store.saveSettings({ chatId: '' });
    const pictures = await images.gallery.forgetChat(c.id, b.pictures === 'delete');
    await chats.remove(c.id);
    await docStore.drop(c.id);
    const m = await mutes.get();
    if (m.items[`chat:${c.id}`]) await mutes.save(mute.set(m, `chat:${c.id}`, 'off'));
    return json(res, 200, { ok: true, pictures, deleted: b.pictures === 'delete' });
  },
};
