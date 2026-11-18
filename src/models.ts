// The chat models TOMLIN can use: its own models/ folder, plus one other folder named in models-folder.txt (LM Studio's,
// for example; the files stay where they are). A model's id is its path inside its folder; one from the other folder
// starts "*/" (a character no Windows file name can hold, so the two can never be confused).
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeAtomicSync } from './atomic.ts';
import { listModels } from './llama.ts';
import { listOllama, ollamaDir } from './ollama.ts';

const OTHER = '*/';
// Ollama's models are named by Ollama (qwen3:4b); "ollama:" cannot start a path in either folder.
const OLLAMA = 'ollama:';

export interface ModelEntry {
  id: string;
  /** Path inside its folder. */
  file: string;
  bytes: number;
  where: 'own' | 'other' | 'ollama';
  /** A split model: how many parts it has, and the parts not there (it cannot be loaded while any is missing). */
  parts?: number;
  missing?: number[];
}

/** A split model with a part missing, in plain words: what is missing and that it cannot be loaded. */
export function incompleteWords(name: string, m: { parts?: number; missing?: number[] }): string {
  const miss = m.missing ?? [];
  if (!miss.length) return '';
  const which = miss.length === 1 ? `part ${miss[0]}` : `parts ${miss.slice(0, -1).join(', ')} and ${miss[miss.length - 1]}`;
  return `${name} is not complete: ${which} of ${m.parts ?? '?'} ${miss.length === 1 ? 'is' : 'are'} missing, so it cannot be loaded. Download it again, or copy the missing ${miss.length === 1 ? 'part' : 'parts'} into the same folder.`;
}

/**
 * The same model file found twice (in TOMLIN's own folder and the other folder, say): the same file name and size.
 * For each such group, the id kept on show (`keep` picks it: the first of the group it likes, else the own folder's)
 * and every id in the group. A model found once is not in the answer. Ollama's models have names of their own and are
 * never matched.
 */
export function sameFiles(list: ModelEntry[], keep: (ids: string[]) => string | undefined = () => undefined): Map<string, { keep: string; ids: string[] }> {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of list) {
    if (m.where === 'ollama') continue;
    const key = `${basename(m.file).toLowerCase()}|${m.bytes}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const out = new Map<string, { keep: string; ids: string[] }>();
  const rank = (m: ModelEntry) => (m.where === 'own' ? 0 : 1);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ids = [...g].sort((a, b) => rank(a) - rank(b)).map(m => m.id);
    const kept = keep(ids) ?? ids[0];
    for (const id of ids) out.set(id, { keep: kept, ids });
  }
  return out;
}

/**
 * Where the copies of a model found twice are, for its row ('' for a model found once): "2 copies: in TOMLIN's models
 * folder and in D:\LLM. Delete removes the one in TOMLIN's models folder." (`kept`: the id the row's buttons act on).
 */
export function copiesWords(ids: string[], kept: string, other: string | null): string {
  if (ids.length < 2) return '';
  const where = (id: string) => (id.startsWith('*/') ? (other ? `in ${other}` : 'in the other models folder') : "in TOMLIN's models folder");
  const places = [...new Set(ids.map(where))];
  return `${ids.length} copies: ${places.slice(0, -1).join(', ')}${places.length > 1 ? ' and ' : ''}${places[places.length - 1]}. Delete removes the one ${where(kept)}.`;
}

/**
 * A list with the same model file found twice shown once (sameFiles' rule: the same name and size; Ollama's models,
 * named by Ollama, are never matched). The first of each group stays, so TOMLIN's own folder comes first when listed first.
 */
export function oncePerFile<T extends { id: string; name: string; bytes: number }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter(m => {
    if (m.id.startsWith(OLLAMA)) return true;
    const key = `${m.name.toLowerCase()}|${m.bytes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether model `id` gets its own row in a list: a model found once always does; of the same file found twice, the one
 * `mine` names (a hire's own model, so their choice shows as theirs), else the one sameFiles kept.
 */
export function onShow(id: string, twins: Map<string, { keep: string; ids: string[] }>, mine: (string | null | undefined)[] = []): boolean {
  const t = twins.get(id);
  if (!t) return true;
  const theirs = t.ids.find(x => mine.includes(x));
  return (theirs ?? t.keep) === id;
}

export class Models {
  /** Where this copy's own chat models are kept, and where a download goes (setOwn: Where models are kept). */
  own: string;
  private settingFile: string;
  private envOther: string | undefined;
  private ollama: string | null;
  /** models/chat folders of other copies of TOMLIN beside this one: their files count as this copy's own. */
  copies: () => string[] = () => [];
  /**
   * How long a listing is reused, in ms (0: every call walks the folders). The server keeps it a moment, so a big or
   * slow "other folder" (a network drive) is walked once a few seconds, not on every status and search call.
   */
  cacheMs = 0;
  private listed: { at: number; list: ModelEntry[] } | null = null;

  /** The next listing walks the folders again (a download finished, the other folder changed). */
  forget(): void {
    this.listed = null;
  }

  /** `envOther`: a folder given by TOMLIN_MODELS; models-folder.txt, when there is one, wins (the page can change it). */
  /** `ollama`: Ollama's models folder; by default found on its own (TOMLIN_OLLAMA moves it, for tests). */
  constructor(own: string, settingFile: string, envOther?: string, ollama: string | null = process.env.TOMLIN_OLLAMA ?? ollamaDir()) {
    this.own = own;
    this.ollama = ollama;
    this.settingFile = settingFile;
    this.envOther = envOther;
  }

  /** Keeps this copy's own chat models in `dir` from now on (the folder used before is given as one of `copies`). */
  setOwn(dir: string): void {
    this.own = dir;
    this.forget();
  }

  /** The folder the setting names, there or not (null: none is set). */
  private named(): string | null {
    let dir: string | undefined;
    try {
      dir = readFileSync(this.settingFile, 'utf8').split(/\r?\n/)[0].trim().replace(/^"|"$/g, '');
    } catch {
      dir = this.envOther;
    }
    return dir || null;
  }

  /**
   * The other folder as it is set, when it is not there now (its drive is unplugged or came back under another
   * letter, or the folder was moved): the page says so, where an empty list would give no reason. Else null.
   */
  otherMissing(): string | null {
    const dir = this.named();
    if (!dir) return null;
    try {
      if (statSync(dir).isDirectory()) return null;
    } catch {
      // not there
    }
    return dir;
  }

  /** The other folder, when there is one and it is a folder. */
  other(): string | null {
    const dir = this.named();
    if (!dir) return null;
    try {
      if (!statSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
    return resolve(dir).toLowerCase() === resolve(this.own).toLowerCase() ? null : dir;
  }

  /** Uses `dir` as the other folder (written to models-folder.txt), or none. */
  setOther(dir: string | null): void {
    this.forget();
    if (dir === null) {
      rmSync(this.settingFile, { force: true });
      this.envOther = undefined;
      return;
    }
    // Whole or not at all: a full disk never leaves the setting empty (the other folder would be lost without a word).
    writeAtomicSync(this.settingFile, `${dir}\r\n`);
  }

  list(): ModelEntry[] {
    if (this.cacheMs > 0 && this.listed && Date.now() - this.listed.at < this.cacheMs) return [...this.listed.list];
    const all = this.walk();
    if (this.cacheMs > 0) this.listed = { at: Date.now(), list: all };
    return [...all];
  }

  private walk(): ModelEntry[] {
    // A split model's part count and missing parts go with it (src/llama.ts listModels).
    const split = (m: { parts?: number; missing?: number[] }) => ({ ...(m.parts ? { parts: m.parts } : {}), ...(m.missing?.length ? { missing: m.missing } : {}) });
    const own: ModelEntry[] = listModels(this.own).map(m => ({ id: m.file, file: m.file, bytes: m.bytes, where: 'own' as const, ...split(m) }));
    // An older copy's models keep the same id, so a hire given one before the new version still finds it.
    for (const dir of this.copies()) {
      for (const m of listModels(dir)) if (!own.some(o => o.id === m.file)) own.push({ id: m.file, file: m.file, bytes: m.bytes, where: 'own' as const, ...split(m) });
    }
    const dir = this.other();
    const other: ModelEntry[] = dir ? listModels(dir).map(m => ({ id: OTHER + m.file, file: m.file, bytes: m.bytes, where: 'other' as const, ...split(m) })) : [];
    const ollama = this.ollama ? listOllama(this.ollama).map(m => ({ id: OLLAMA + m.name, file: m.name, bytes: m.bytes, where: 'ollama' as const })) : [];
    return [...own, ...other, ...ollama].sort((a, b) => a.bytes - b.bytes);
  }

  /**
   * A model's full path from its id, only when listing found it (so a name can never reach outside its folder). Looked up
   * in the listing (kept a moment, cacheMs), not by walking the folder again for each model: 100 models in a folder of
   * 5,000 files took 41 s, every one of them on the server's thread.
   */
  path(id: string): string | null {
    if (id.startsWith(OLLAMA)) {
      return this.ollama ? listOllama(this.ollama).find(m => m.name === id.slice(OLLAMA.length))?.blob ?? null : null;
    }
    const m = this.list().find(x => x.id === id);
    if (!m) return null;
    if (id.startsWith(OTHER)) {
      const dir = this.other();
      return dir ? join(dir, ...m.file.split('/')) : null;
    }
    return [this.own, ...this.copies()].map(dir => join(dir, ...m.file.split('/'))).find(p => existsSync(p)) ?? null;
  }

  /** True when a file of this name is already in either folder (so a pinned model is "installed"). */
  has(fileName: string): boolean {
    const name = basename(fileName).toLowerCase();
    return this.list().some(m => m.where !== 'ollama' && basename(m.file).toLowerCase() === name);
  }

  /** Where a new download goes. */
  target(fileName: string): string {
    return join(this.own, basename(fileName));
  }
}
