// Chats: every conversation is its own file, data/chats/<id>.json (the lines), listed in data/chats/index.json (who it
// is with, its title, when it was started and last used). A chat is with one person: the manager, one hire
// ("staff:<id>"); that never changes, so one person's answers are never read by another. Pictures drawn while a chat is open carry its id in the gallery (src/gallery.ts), so each chat keeps its own.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatLine, Store } from './store.ts';
import { chatFolder } from './folders.ts';

export interface ChatInfo {
  id: string;
  /** 'manager', 'staff:<id>', or 'node:<paired PC id>:<hire id>' (a hire who lives on a paired PC). */
  who: string;
  title: string;
  created: string;
  updated: string;
  messages: number;
  /** Set when he gave it a name himself: the first message no longer renames it. */
  named?: boolean;
  /** The handoff this chat started from (written by the model at the end of the chat named in `from`). */
  opening?: string;
  from?: string;
  /** How full the chat was at its last answer, in percent of what the model can read (src/memory.ts fill). */
  fill?: number;
  /** The "getting large" bar was answered at this fill (75, or 90 after a second Ignore; 100 once handed off). */
  askedLarge?: number;
  /** Think was chosen in this chat's box (the model works an answer out first); Quick when not set. */
  think?: boolean;
  /** Pinned in the left panel: it stays under Projects, above the recent chats, until unpinned. */
  pinned?: boolean;
  /** The project (its job id) this chat's work belongs to; none = Default, the chats by date. */
  project?: string;
  /** Its own folder in the workspace while it is in Default, "chats/2026-10-07-1530" (src/folders.ts), named once. */
  folder?: string;
}

export const NEW_TITLE = 'New chat';
const INDEX = 'chats/index.json';
const ID = /^[a-f0-9]{12}$/;

/** A chat's title from its first message: one line, about 48 characters, cut at a word. */
export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return NEW_TITLE;
  if (one.length <= 48) return one;
  const cut = one.slice(0, 48);
  const at = cut.lastIndexOf(' ');
  return `${(at > 24 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/** The chat's facts after its lines changed: count, last used, and the title from the first message he typed. */
export function describe(info: ChatInfo, lines: ChatLine[], now = new Date().toISOString()): ChatInfo {
  const first = lines.find(l => l.role === 'user' && !l.refused);
  const title = info.named || info.title !== NEW_TITLE || !first ? info.title : titleFrom(first.content);
  return { ...info, title, messages: lines.length, updated: lines.length !== info.messages ? now : info.updated };
}

/** A name given to a chat (a subject), as kept: one line, at most 80 characters. */
export function cleanTitle(title: unknown): string {
  return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Where "Create new subject" lands with this person: their chat already called that (in any case) opens; else the chat
 * on the asking window's screen (openId) takes the name when it is theirs and still empty and unnamed; else null, and
 * a new chat is made.
 */
export function subjectFor(list: ChatInfo[], who: string, title: string, openId: string, project = ''): { chat: ChatInfo; existed: boolean } | null {
  // A subject belongs to its project: "blog photos" with the artist for one project is not the one for another.
  const same = list.find(c => c.who === who && c.title.toLowerCase() === title.toLowerCase() && (c.project ?? '') === project);
  if (same) return { chat: same, existed: true };
  const empty = list.find(c => c.id === openId && c.who === who && !c.messages && !c.named && c.title === NEW_TITLE);
  return empty ? { chat: empty, existed: false } : null;
}

/** Which kind of person a "who" setting is: the chat is with them. */
export function whoKind(who: string): string {
  return who.startsWith('staff:') || who.startsWith('node:') ? who : 'manager';
}

/**
 * The chat a send, Stop or other chat action names: {chatId} for a chat that exists, or {chatId: '', who} for a new
 * chat with that person (made by its first message). A body that names no chat is refused: the server's "chat open now"
 * is whichever window opened one last, so a message sent without its own chat could land in someone else's.
 */
export function namedChat(b: Record<string, unknown>, newAllowed = true): { id: string } | { who: string } | { error: string } {
  if (typeof b.chatId !== 'string' || b.chatId.length > 80) return { error: 'This names no chat, so nothing was done (the page may be from an older TOMLIN). Reload the page, then try again.' };
  if (b.chatId) return { id: b.chatId };
  if (!newAllowed) return { error: 'This chat has no messages yet, so there is nothing to do this to.' };
  if (typeof b.who !== 'string' || !b.who || b.who.length > 80) return { error: 'This names no chat and nobody to start one with. Pick who the chat is with, then send again.' };
  return { who: whoKind(b.who) };
}

/**
 * A chat named in an address (?chat=<id>, or ?chat=&who=<person> for a chat with no messages yet, and &plain= for how
 * the host talks), as namedChat reads a body. An address with no ?chat names nothing, and is refused there.
 */
export function chatQuery(q: URLSearchParams): Record<string, unknown> {
  const get = (k: string) => q.get(k) ?? undefined;
  return { chatId: get('chat'), who: get('who'), plain: get('plain') };
}

/** The old one-file-per-person chats (before chats existed), turned into one chat each. Only files with lines move. */
export function oldChats(files: string[]): Array<{ file: string; who: string }> {
  return files.flatMap(f => {
    if (f === 'chat.json') return [{ file: f, who: 'manager' }];
    const m = /^chat-staff-([a-z0-9-]{1,40})\.json$/.exec(f);
    return m ? [{ file: f, who: `staff:${m[1]}` }] : [];
  });
}

/** Chats left in the list by the private chat (taken out of the app) are never listed or opened; their files stay as they are. */
const shown = (c: ChatInfo) => c.who !== 'partner';

export class Chats {
  private cache: ChatInfo[] | null = null;
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  file(id: string): string {
    if (!ID.test(id)) throw new Error('Not a chat.');
    return `chats/${id}.json`;
  }

  private async index(): Promise<ChatInfo[]> {
    if (!this.cache) {
      const list = await this.store.readJson<ChatInfo[]>(INDEX, []);
      this.cache = Array.isArray(list) ? list.filter(c => c && ID.test(c.id) && typeof c.who === 'string') : [];
    }
    return this.cache;
  }

  // A save that fails (a full disk) leaves the list in memory changed and the file not: the list is read from the file
  // again, so a refused rename or new chat never shows as done (and comes undone at the next start).
  private async write(): Promise<void> {
    try {
      await this.store.writeJson(INDEX, this.cache ?? []);
    } catch (e) {
      this.cache = null;
      throw e;
    }
  }

  /** Newest first (by when it was last used). */
  async list(): Promise<ChatInfo[]> {
    return (await this.index()).filter(shown).sort((a, b) => b.updated.localeCompare(a.updated) || b.created.localeCompare(a.created));
  }

  async get(id: unknown): Promise<ChatInfo | null> {
    return typeof id === 'string' ? (await this.index()).find(c => c.id === id && shown(c)) ?? null : null;
  }

  async create(who: string, at = new Date().toISOString()): Promise<ChatInfo> {
    const c: ChatInfo = { id: randomBytes(6).toString('hex'), who, title: NEW_TITLE, created: at, updated: at, messages: 0 };
    (await this.index()).push(c);
    await this.write();
    return c;
  }

  /** The chat with this person used most recently, if any. */
  async latestFor(who: string): Promise<ChatInfo | null> {
    return (await this.list()).find(c => c.who === who) ?? null;
  }

  async lines(id: string): Promise<ChatLine[]> {
    return this.store.chat(this.file(id));
  }

  /** Called whenever a chat file is written: keeps the list's title, count and time right. */
  async saved(file: string, lines: ChatLine[]): Promise<void> {
    const id = /^chats\/([a-f0-9]{12})\.json$/.exec(file)?.[1];
    const list = await this.index();
    const i = list.findIndex(c => c.id === id);
    if (i < 0) return;
    list[i] = describe(list[i], lines);
    await this.write();
  }

  /** Changes a chat's own facts (fill, the handoff answer); the title and count are kept by saved(). */
  async mark(id: string, patch: Partial<Pick<ChatInfo, 'fill' | 'askedLarge' | 'think' | 'pinned'>>): Promise<ChatInfo | null> {
    const c = (await this.index()).find(x => x.id === id);
    if (!c) return null;
    Object.assign(c, patch);
    await this.write();
    return c;
  }

  /** A new chat with the same person that carries on from `from`, with the handoff it ends with as its opening note. */
  async carryOn(from: ChatInfo, opening: string, at = new Date().toISOString()): Promise<ChatInfo> {
    const c = await this.create(from.who, at);
    const base = from.title.replace(/ \(carried on(?: \d+)?\)$/, '');
    const n = (await this.index()).filter(x => x.title.startsWith(`${base} (carried on`)).length;
    Object.assign(c, { title: `${base} (carried on${n ? ` ${n + 1}` : ''})`, named: true, opening, from: from.id });
    await this.write();
    return c;
  }

  /**
   * A picture asked for in an artist's chat (drawn in the pictures pane, not written as a line): the chat moves to the
   * top of the list, and a chat still called "New chat" takes its name from the first thing asked.
   */
  async touch(id: string, asked: string, at = new Date().toISOString()): Promise<ChatInfo | null> {
    const c = (await this.index()).find(x => x.id === id);
    if (!c) return null;
    if (!c.named && c.title === NEW_TITLE) c.title = titleFrom(asked);
    c.updated = at;
    await this.write();
    return c;
  }

  async rename(id: string, title: string): Promise<ChatInfo | null> {
    const list = await this.index();
    const c = list.find(x => x.id === id);
    const clean = cleanTitle(title);
    if (!c || !clean) return null;
    Object.assign(c, { title: clean, named: true });
    await this.write();
    return c;
  }

  /** Puts a chat in a project (its job id), or back in Default (''). */
  /** The chat's own workspace folder (chats/<when it was started>), named the first time it is asked for, then kept. */
  async folderOf(id: string): Promise<string | null> {
    const list = await this.index();
    const c = list.find(x => x.id === id);
    if (!c) return null;
    if (!c.folder || !/^chats\/\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/.test(c.folder)) {
      c.folder = chatFolder(c.created, list.map(x => x.folder ?? ''));
      await this.write();
    }
    return c.folder;
  }

  async setProject(id: string, project: string): Promise<ChatInfo | null> {
    const c = (await this.index()).find(x => x.id === id);
    if (!c) return null;
    if (project) c.project = project;
    else delete c.project;
    await this.write();
    return c;
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.index();
    const i = list.findIndex(c => c.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    await this.write();
    await rm(join(this.store.dir, this.file(id)), { force: true });
    return true;
  }

  /**
   * Once, the first time chats exist: each old per-person chat file with lines becomes one chat (its title from the
   * first message, its time from the last line). The old files are left where they were, untouched.
   */
  async moveOld(files: string[]): Promise<ChatInfo[]> {
    if (await this.store.readJson<unknown>(INDEX, null)) return [];
    const made: ChatInfo[] = [];
    this.cache = [];
    for (const { file, who } of oldChats(files)) {
      const lines = await this.store.chat(file);
      if (!Array.isArray(lines) || !lines.length) continue;
      const c = await this.create(who, lines[0].at || new Date().toISOString());
      await this.store.writeJson(this.file(c.id), lines);
      const i = this.cache.findIndex(x => x.id === c.id);
      this.cache[i] = describe(c, lines, lines[lines.length - 1].at || c.created);
      made.push(this.cache[i]);
    }
    await this.write();
    return made;
  }
}
