// The chat models TOMLIN can use: its own models/ folder, plus one other folder named in models-folder.txt (LM Studio's,
// for example; the files stay where they are). A model's id is its path inside its folder; one from the other folder
// starts "*/" (a character no Windows file name can hold, so the two can never be confused).
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { listModels, modelPath } from './llama.ts';
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
}

export class Models {
  readonly own: string;
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

  /** The other folder, when there is one and it is a folder. */
  other(): string | null {
    let dir: string | undefined;
    try {
      dir = readFileSync(this.settingFile, 'utf8').split(/\r?\n/)[0].trim().replace(/^"|"$/g, '');
    } catch {
      dir = this.envOther;
    }
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
    writeFileSync(this.settingFile, `${dir}\r\n`);
  }

  list(): ModelEntry[] {
    if (this.cacheMs > 0 && this.listed && Date.now() - this.listed.at < this.cacheMs) return [...this.listed.list];
    const all = this.walk();
    if (this.cacheMs > 0) this.listed = { at: Date.now(), list: all };
    return [...all];
  }

  private walk(): ModelEntry[] {
    const own = listModels(this.own).map(m => ({ id: m.file, file: m.file, bytes: m.bytes, where: 'own' as const }));
    // An older copy's models keep the same id, so a hire given one before the new version still finds it.
    for (const dir of this.copies()) {
      for (const m of listModels(dir)) if (!own.some(o => o.id === m.file)) own.push({ id: m.file, file: m.file, bytes: m.bytes, where: 'own' as const });
    }
    const dir = this.other();
    const other = dir ? listModels(dir).map(m => ({ id: OTHER + m.file, file: m.file, bytes: m.bytes, where: 'other' as const })) : [];
    const ollama = this.ollama ? listOllama(this.ollama).map(m => ({ id: OLLAMA + m.name, file: m.name, bytes: m.bytes, where: 'ollama' as const })) : [];
    return [...own, ...other, ...ollama].sort((a, b) => a.bytes - b.bytes);
  }

  /** A model's full path from its id, only when listing found it. */
  path(id: string): string | null {
    if (id.startsWith(OLLAMA)) {
      return this.ollama ? listOllama(this.ollama).find(m => m.name === id.slice(OLLAMA.length))?.blob ?? null : null;
    }
    if (id.startsWith(OTHER)) {
      const dir = this.other();
      return dir ? modelPath(dir, id.slice(OTHER.length)) : null;
    }
    return modelPath(this.own, id) ?? this.copies().map(dir => modelPath(dir, id)).find(Boolean) ?? null;
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
