// What TOMLIN keeps between runs, in the data folder: settings (per pane: last model picked, device, CPU cores, idle
// unload) and the chat. Written whole each time, through a temporary file, so a crash never leaves half a file.
import { join } from 'node:path';
import type { Asked } from './worker.ts';
import { cleanShared, type SharedModel } from './nodestaff.ts';
import { readData, updateData, writeAtomic } from './atomic.ts';

export interface PaneSettings {
  /** The model last picked (only shown as the choice; nothing loads until Connect). */
  model: string | null;
  asked: Asked;
  /** CPU cores (threads) the runner may use; 0 = all physical cores. */
  threads: number;
  /** Unload after this many idle minutes; 0 = never (the default). */
  idleMinutes: number;
}

export interface Settings {
  chat: PaneSettings;
  image: PaneSettings;
  /** Seconds the last load of each model took, for the progress bar's estimate. */
  loadSeconds: Record<string, number>;
  /** Measured picture speed per model, device and decoder: seconds a step, seconds to decode one picture. */
  timings: Record<string, { perStep: number; decode: number }>;
  /** Drafts older than this many days are cleared away; 0 = keep them forever (the default: the person decides). */
  draftDays: number;
  /** Who TOMLIN is in chat (an id from persona.ts) and the tone for pieces of writing; both saved. */
  who: string;
  tone: string;
  /** The picture specialist (a hire with an image role) pictures are drawn as; '' = none. */
  imageAs: string;
  /** The folder Files and the blog writer work in; '' = the default one in the data folder. */
  workspace: string;
  /** How each chat model is started (by model id): context size, cache type, mixture-of-experts weights in RAM. */
  run: Record<string, RunOptions>;
  /** RETIRED with "Who does the work" (each job's team took its place): kept in old settings files, read by nothing. */
  jobModels: Record<string, string>;
  /** Worker PCs this one has paired with (the token is this PC's key to that worker). */
  remotes: Remote[];
  /** Retired in 2.0.30 ("Keep loaded" was dropped): kept in the file for older copies, read by nothing. */
  keep: string[];
  /** The chat open now (an id from src/chats.ts); '' = none yet: the first message starts one. */
  chatId: string;
  /** The name the manager answers to, given by him; '' = "TOMLIN". */
  managerName: string;
  /**
   * The host's own chat model (its pencil in the left panel, or what was connected in its chat): opening a hire's chat
   * no longer changes what the host answers on. Settings saved before it start with the chat model picked then.
   */
  hostModel: string;
  /** RETIRED with "Who does the work" (each job's team took its place): kept in old settings files, read by nothing. */
  bigReads: 'biggest' | 'picked';
}

export interface RunOptions {
  ctx: number;
  cache: 'f16' | 'q8_0' | 'q4_0';
  /** Where the weights go on a graphics device (src/llama.ts ChatRun). Settings saved before kept cpuMoe: true = 'ram'. */
  place: 'auto' | 'card' | 'ram';
}

export interface Remote {
  id: string;
  name: string;
  url: string;
  token: string;
  /** The encrypted link's keys (src/link.ts, F7 E1); a PC linked before has none and must be linked again. */
  key?: string;
  /** The models that PC lets linked PCs use, as it last said (kept so a hire on one keeps its model's name while it is off). */
  models?: SharedModel[];
  /** "Backups only": a PC kept for backups (a storage box). No hire, chat, job or picture is sent to it, no model is
   * copied to it, and it is first in line for project backups. Set here, on this PC; that PC is not told. */
  backupsOnly?: boolean;
}

export const DEFAULT_RUN: RunOptions = { ctx: 8192, cache: 'f16', place: 'auto' };

export interface ChatLine {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** Speed of the answer, shown under it. */
  perSecond?: number;
  /** Where the answer (or picture) was made: "on laptop 9B", "on this PC 1.7B". */
  ran?: string;
  /** A message that broke the fixed limits (lines from before 2.0.44): kept on screen, never sent to the model. */
  refused?: boolean;
  /** The fault that ended a turn before any answer was written ("... needs about 23.5 GB"): kept on screen after a reload, never sent to a model. */
  failed?: boolean;
  /** A picture drawn in the chat: the gallery file (under /api/images/file/), the prompt it came from and its alt text. */
  picture?: { output: string; prompt: string; alt?: string };
  /** The answer reached its length limit before it was finished: the page offers Continue. */
  cut?: boolean;
  /** Stop was pressed part way (in the chat, or the queue's Stop): the words so far are kept. A queued message runs again on Resume. */
  stopped?: boolean;
  /** The documents' pages the model was given for this answer ("manual.pdf page 31"), shown under it. */
  sources?: string;
  /** A message sent here with "Send to…": where it came from ("Sam's chat"), shown under it, never sent to a model. */
  from?: string;
  /** A message the queue sent: its queue item's id, so a run again finds this item's own line, not one with the same words. */
  queued?: string;
  /** An answer handed on with "Send to…": to whom ("Dana · blog photos"), shown under it, never sent to a model. */
  sent?: string[];
  /** What the model worked out before this answer (Think), folded above it; never sent to a model again. */
  thought?: { text: string; seconds: number };
  /** The connection to the linked PC writing this answer was lost: it is still owed (src/outbox.ts), with Reconnect. */
  waiting?: { rid: string; pc: string; name: string };
  /** Said under the answer, never sent to a model ("Collected from Worker PC after the connection was lost."). */
  note?: string;
}

const DEFAULT_PANE: PaneSettings = { model: null, asked: 'auto', threads: 0, idleMinutes: 0 };

export class Store {
  readonly dir: string;
  private cache: Settings | null = null;
  /** The first read, shared by every caller that asks before it finishes. */
  private loading: Promise<Settings> | null = null;
  /** Told after every chat file is written (src/chats.ts keeps each chat's title, count and time from it). */
  onChatSaved: ((file: string, lines: ChatLine[]) => Promise<void>) | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** `fallback` only when the file is not there; a damaged one is set aside and reported (src/atomic.ts readData). */
  readJson<T>(name: string, fallback: T, o: { leave?: boolean } = {}): Promise<T> {
    return readData(join(this.dir, name), fallback, o);
  }

  /** Reads, changes and saves one JSON file in one turn (src/atomic.ts updateData): a change made meanwhile is kept. */
  updateJson<T>(name: string, fallback: T, change: (now: T) => T | undefined | Promise<T | undefined>): Promise<T> {
    return updateData(join(this.dir, name), fallback, change);
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await writeAtomic(join(this.dir, name), JSON.stringify(value, null, 1));
  }

  settings(): Promise<Settings> {
    if (this.cache) return Promise.resolve(this.cache);
    return (this.loading ??= this.load());
  }

  private async load(): Promise<Settings> {
    const s = await this.readJson<Partial<Settings>>('settings.json', {});
    // Fields this version does not know (written by a newer copy) are carried through, so going back never erases them.
    this.cache ??= { ...s, chat: { ...DEFAULT_PANE, ...s.chat }, image: { ...DEFAULT_PANE, ...s.image }, loadSeconds: s.loadSeconds ?? {}, timings: s.timings ?? {}, draftDays: s.draftDays ?? 0, who: s.who && s.who !== 'partner' ? s.who : 'standard', tone: s.tone ?? 'natural', imageAs: s.imageAs ?? '', workspace: s.workspace ?? '', run: s.run ?? {}, jobModels: s.jobModels ?? {}, remotes: (s.remotes ?? []).map(({ staff: _retired, ...r }: Remote & { staff?: unknown }) => ({ ...r, ...(Array.isArray(r.models) ? { models: cleanShared(r.models) } : {}) })), keep: Array.isArray(s.keep) ? s.keep.filter(x => typeof x === 'string') : [], chatId: typeof s.chatId === 'string' ? s.chatId : '', managerName: typeof s.managerName === 'string' ? s.managerName : '', hostModel: typeof s.hostModel === 'string' ? s.hostModel : s.chat?.model ?? '', bigReads: s.bigReads === 'picked' ? 'picked' : 'biggest' };
    return this.cache;
  }

  /** The settings already read (null before the first read), for code that cannot wait. */
  peek(): Settings | null {
    return this.cache;
  }

  /** `run` and `jobModels` are merged key by key; `remotes` is replaced whole. */
  async saveSettings(change: { chat?: Partial<PaneSettings>; image?: Partial<PaneSettings>; loadSeconds?: Record<string, number>; timings?: Settings['timings']; draftDays?: number; who?: string; tone?: string; imageAs?: string; workspace?: string; run?: Record<string, RunOptions>; jobModels?: Record<string, string>; remotes?: Remote[]; keep?: string[]; chatId?: string; managerName?: string; hostModel?: string; bigReads?: 'biggest' | 'picked' }): Promise<Settings> {
    await this.settings();
    // Read after the wait: another save may have changed it meanwhile, and its change must stay.
    const s = this.cache!;
    this.cache = { ...s, chat: { ...s.chat, ...change.chat }, image: { ...s.image, ...change.image }, loadSeconds: { ...s.loadSeconds, ...change.loadSeconds }, timings: { ...s.timings, ...change.timings }, draftDays: change.draftDays ?? s.draftDays, who: change.who ?? s.who, tone: change.tone ?? s.tone, imageAs: change.imageAs ?? s.imageAs, workspace: change.workspace ?? s.workspace, run: { ...s.run, ...change.run }, jobModels: { ...s.jobModels, ...change.jobModels }, remotes: change.remotes ?? s.remotes, keep: change.keep ?? s.keep, chatId: change.chatId ?? s.chatId, managerName: change.managerName ?? s.managerName, hostModel: change.hostModel ?? s.hostModel, bigReads: change.bigReads ?? s.bigReads };
    const next = this.cache;
    try {
      await this.writeJson('settings.json', next);
    } catch (e) {
      // Not saved (a full disk): the settings go back to what the file holds, unless a later change already replaced them.
      if (this.cache === next) this.cache = s;
      throw e;
    }
    return next;
  }

  /** Each character keeps its own conversation, so Standard answers are never read by the optional character and the other way round. */
  async chat(file = 'chat.json'): Promise<ChatLine[]> {
    return this.readJson<ChatLine[]>(file, []);
  }

  async saveChat(lines: ChatLine[], file = 'chat.json'): Promise<void> {
    await this.writeJson(file, lines);
    await this.onChatSaved?.(file, lines);
  }

  /** How many times each chat file was emptied or deleted (Clear, Delete) since the start. */
  private chatGens = new Map<string, number>();

  /** A mark taken when an answer starts: `changeChat(file, fn, mark)` saves nothing once the chat was cleared since. */
  chatMark(file: string): number {
    return this.chatGens.get(file) ?? 0;
  }

  /** Clear or Delete: an answer still running in this chat must not write its old lines back. */
  chatEmptied(file: string): void {
    this.chatGens.set(file, this.chatMark(file) + 1);
  }

  /**
   * Reads, changes and saves a chat in one turn, so lines added meanwhile (another answer, a picture) are kept.
   * `change` gives back the new lines, or undefined to save nothing. With `mark` (from chatMark when the answer
   * started), nothing is saved once the chat was cleared or deleted since. Returns the lines saved, or null.
   */
  async changeChat(file: string, change: (lines: ChatLine[]) => ChatLine[] | undefined, mark?: number): Promise<ChatLine[] | null> {
    let saved: ChatLine[] | null = null;
    await updateData<ChatLine[]>(join(this.dir, file), [], lines => {
      if (mark !== undefined && mark !== this.chatMark(file)) return undefined;
      const next = change(Array.isArray(lines) ? lines : []);
      if (next) saved = next;
      return next;
    });
    if (saved) await this.onChatSaved?.(file, saved);
    return saved;
  }
}
