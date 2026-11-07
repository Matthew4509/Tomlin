// File tools for a chat: the model may list, read and save text files in the chat's folder (the project's folder in
// the workspace, or the whole workspace in Default) while it answers, once the person allows it there (Allow once:
// this answer; Allow for this thread: kept on the chat). Everything goes through src/workspace.ts, so nothing outside
// the folder is touched, nothing is run and nothing is deleted; a changed file keeps one .bak. Plain parts, tested in
// test/filetools.test.ts; the model's side (calls and results) is in src/engine.ts streamChat.
import type { ToolDef } from './webtools.ts';
import * as ws from './workspace.ts';
import { paramsB, withFileTools } from './staff.ts';

/** Offered to a model of 4B or more (or of a size its name does not tell): a 0.8B offered them stopped answering what was asked. */
export const FILES_MIN_B = 4;
export const filesFit = (model: string): boolean => (paramsB(model) ?? FILES_MIN_B) >= FILES_MIN_B;

/** The person's answer to "may this chat use your files?" (src/permits.ts: always is Auto in Settings). */
export { cleanPermit, type Permit } from './permits.ts';
import { deniedWords, type Permit } from './permits.ts';

export const FILE_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the text and code files in the folder you work in, newest first, with their sizes. Paths are relative to that folder.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one text or code file from the folder you work in. A long file comes in parts: ask for part 2, 3 and so on.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The file\'s path as list_files gives it, for example src/app.js.' }, part: { type: 'integer', description: 'Which part of a long file (1 when not given).' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_file',
      description: 'Write a text or code file to the drive, in the folder you work in: a new file, or the whole of a changed one (the old one is kept as .bak). Folders in the path are made.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The file\'s path, for example src/app.js.' }, text: { type: 'string', description: 'The whole file, every line.' } }, required: ['path', 'text'] },
    },
  },
];

const NAMES = new Set(FILE_TOOLS.map(t => t.function.name));
export const isFileTool = (name: string) => NAMES.has(name);

/** Rounds of calls before the answer is asked for with the tools off: a change is a list, a read or two and a save. */
export const FILE_ROUNDS = 6;

/** Added to the system turn when the file tools are on. */
export const FILES_LINE = 'You can work on the person\'s files yourself, in the folder this chat works in: list_files shows them, read_file reads one, save_file writes one to the drive. The person is asked to allow it the first time. Read a file before you change it, save the whole file, and say which files you saved.';

const DENIED = deniedWords('files');

/**
 * The turns with FILES_LINE at the end of the system turn (one is put first when there is none), and a hire's lines that
 * send code to a block for the Save button turned to save_file (src/staff.ts withFileTools).
 */
export function withFilesLine<T extends { role: string; content: string }>(turns: T[]): T[] {
  const i = turns.findIndex(t => t.role === 'system');
  if (i < 0) return [{ role: 'system', content: FILES_LINE } as T, ...turns];
  return turns.map((t, j) => (j === i ? { ...t, content: t.content ? `${withFileTools(t.content)}\n\n${FILES_LINE}` : FILES_LINE } : t));
}

/** What a file call is doing, for the answer's place while it runs. */
export function fileCallWords(name: string, args: string): string {
  let path = '';
  try {
    path = String((JSON.parse(args) as { path?: unknown }).path ?? '').slice(0, 120);
  } catch {
    // the words below do without it
  }
  if (name === 'read_file') return path ? `Reading ${path}…` : 'Reading a file…';
  if (name === 'save_file') return path ? `Saving ${path}…` : 'Saving a file…';
  return 'Looking at the files…';
}

export class FileTurn {
  /** The files saved in this answer, in order. */
  readonly saved: string[] = [];
  private readonly root: string;
  /** Characters one call may give back (a long file comes in parts of this size). */
  private readonly perCall: number;
  /** Allowed for this answer (the thread already, or Allow once / for this thread now); false after a no; null: not asked yet. */
  private allowed: boolean | null;
  private asking: Promise<boolean> | null = null;
  private readonly ask?: (what: string) => Promise<Permit>;
  private readonly onThread?: () => Promise<void>;

  /** `ask`: puts the question to the person (none: nothing is touched). `onThread`: keeps Allow for this thread on the chat. */
  constructor(root: string, o: { perCall: number; allowed: boolean; ask?: (what: string) => Promise<Permit>; onThread?: () => Promise<void> }) {
    this.root = root;
    this.perCall = Math.max(500, o.perCall);
    this.allowed = o.allowed ? true : null;
    this.ask = o.ask;
    this.onThread = o.onThread;
  }

  /** Whether this call may go ahead: asked once per answer (calls made while the question is open wait for it). */
  private permitted(what: string): Promise<boolean> {
    if (this.allowed !== null) return Promise.resolve(this.allowed);
    this.asking ??= (async () => {
      const p = this.ask ? await this.ask(what).catch((): Permit => 'no') : 'no';
      if (p === 'thread' || p === 'always') await this.onThread?.();
      return (this.allowed = p !== 'no');
    })();
    return this.asking;
  }

  async run(name: string, args: string): Promise<string> {
    if (isFileTool(name) && !(await this.permitted(fileCallWords(name, args).replace(/…$/, '')))) return DENIED;
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(args || '{}') as Record<string, unknown>;
      if (!a || typeof a !== 'object') throw new Error('not an object');
    } catch {
      return 'The call could not be read: its arguments are not JSON.';
    }
    if (name === 'list_files') {
      const files = await ws.list(this.root);
      if (!files.length) return 'There are no text or code files in this folder yet.';
      let out = '';
      for (const [i, f] of files.entries()) {
        const line = `${f.path} (${f.bytes.toLocaleString('en-GB')} bytes)\n`;
        if (out.length + line.length > this.perCall) return `${out}(and ${files.length - i} more)`;
        out += line;
      }
      return out.trimEnd();
    }
    if (name === 'read_file') {
      const r = await ws.read(this.root, a.path);
      if ('error' in r) return r.error;
      const parts = Math.max(1, Math.ceil(r.text.length / this.perCall));
      if (parts === 1) return `${r.path}:\n${r.text}`;
      const part = Math.min(parts, Math.max(1, Math.floor(Number(a.part) || 1)));
      const more = part < parts ? ` (ask for part ${part + 1} for the rest)` : '';
      return `${r.path}, part ${part} of ${parts}${more}:\n${r.text.slice((part - 1) * this.perCall, part * this.perCall)}`;
    }
    if (name === 'save_file') {
      const r = await ws.save(this.root, a.path, a.text);
      if ('error' in r) return r.error;
      this.saved.push(r.path);
      return r.created ? `Saved ${r.path} (new file).` : `Saved ${r.path} (the old one is kept as ${r.path}.bak).`;
    }
    return `There is no tool called "${name}". The file tools are list_files, read_file and save_file.`;
  }
}
