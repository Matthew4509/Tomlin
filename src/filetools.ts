// File tools for a chat: the model may list, read and save text files in the chat's folder (the project's folder in
// the workspace, or the whole workspace in Default) while it answers, once the person allows it there (Allow once:
// this answer; Allow for this thread: kept on the chat). Everything goes through src/workspace.ts, so nothing outside
// the folder is touched, nothing is run and nothing is deleted; a changed file keeps one .bak. Plain parts, tested in
// test/filetools.test.ts; the model's side (calls and results) is in src/engine.ts streamChat.
import type { ToolDef } from './webtools.ts';
import * as ws from './workspace.ts';
import { paramsB, withFileTools } from './staff.ts';
import { checkSave, looksSecret } from './rules.ts';
import { secretPath } from './codetools.ts';
import { OWNED_WHY, ownedByTomlin } from './folders.ts';

/** A file whose name says it holds keys or passwords (the same names git_read refuses, and a few more). */
export function secretFile(path: string): boolean {
  const rel = path.replace(/\\/g, '/');
  const name = rel.split('/').pop()?.toLowerCase() ?? '';
  // secretPath refuses all of a top-level data\ (TOMLIN's own settings, lock and stick keys, for git_read). In a chat's
  // folder that is often where tables and documents live, so only its .json files keep that refusal; the rest are read
  // and still withheld when their text looks like a key (withheldWhy).
  return secretPath(/^data\//i.test(rel) && !/\.json$/i.test(rel) ? rel.replace(/^data\//i, '_/') : rel) || /^(credentials?|secrets?|passwords?|service[-_]?account[\w-]*|[\w-]*[-_.](credentials?|secrets?|tokens?|passwords?))\.[a-z]+$/.test(name) || /^(auth|token)s?\.json$/.test(name);
}

/**
 * Why a file a tool read is not given to the model, or null. Keys and passwords are never read, as git_read and
 * run_command withhold them: by the file's name first, then by what is in it. Every tool that reads a file from the
 * chat's folder goes through this (read_file here; read_document, find_in_text, keep_quote and table_stats in
 * src/researchtools.ts: audit P6). `text` null: only the name is checked (before a document is opened).
 */
export function withheldWhy(path: string, text: string | null): string | null {
  if (secretFile(path)) return `Not read: ${path} is a file of keys or passwords by its name, so it is never read. Tell the person; do not guess what it holds.`;
  if (text !== null && looksSecret(text)) return `Not read: ${path} looks like it holds a password, key or token, so it was withheld. Tell the person; do not guess what it holds.`;
  return null;
}

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

/** Said after a save_file that was not allowed: the answer goes on in the chat, in full (a denied save once left a short or broken answer). */
export const SAVE_DENIED = 'The person did not allow saving files for this answer, so nothing was saved. Do not call save_file again. Write the whole answer here in the chat now, in full, with the code in code blocks (one block for each file, with the file name on the line above it), and say they can allow saving next time.';

/** What a model is told when a file call was not allowed: a save carries on in the chat, a read answers from what it knows. */
export const deniedFor = (name: string): string => (name === 'save_file' ? SAVE_DENIED : DENIED);

/**
 * Whether a message needs the file tools. A request that opens with a making word (write, build, create...) and names no
 * existing file or folder, and does not ask for a save, is answered in the chat: offered the tools, a model asked for a
 * "Looking at the files" card first with nothing to look at, and a no on it left a short or broken answer (7 of 15
 * project requests on Qwen3-Coder-30B, 17 Nov 2026). Any other message keeps the tools only when it points at files (a
 * file, folder or repo word, a path, a named file, a save) or the chat is in a project: a plain question, or a question
 * with the code pasted in, is answered in the chat (43 of 157 soak prompts raised a file card on Qwen3-Coder-30B, among
 * them "What is 7 times 8?" and pasted-code questions, and an unanswered card holds the answer for 5 minutes).
 */
export function wantsFiles(message: string, inProject = false): boolean {
  const m = message.slice(0, 4000);
  const makes = /^\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would) you\s+(?:please\s+)?|i (?:need|want) you to\s+|i(?:'d| would) like you to\s+)?(?:write|make|create|build|code|generate|implement|design|draft|produce|program|give me|show me)\b/i;
  // "save it", "save as x.js" ask for a file; "save to localStorage" is part of what is being built.
  const saves = /\bsave\s+(?:it|this|that|them|these|the (?:files?|code|page|game|result)|as|to|into|in)\b(?!\s*(?:local|session|the browser|a browser|browser|memory))|\b(?:to|onto|on) (?:a |the |my )?(?:file|disk|drive|folder)\b|\bin (?:a |the |my )?(?:folder|directory)\b/i;
  const path = /(?:^|[\s"'`(])(?:[\w.-]+[\\/])+[\w.-]+\.\w{1,6}\b/;
  if (!makes.test(m)) {
    // No message of its own (Continue) carries on whatever the answer was doing.
    if (!m.trim() || inProject || saves.test(m) || path.test(m)) return true;
    const words = /\b(?:files?|folders?|director(?:y|ies)|repos?|repositor(?:y|ies)|codebase|workspace|hard drive|disk)\b/i;
    // A file named after "my", "the", "in"... (not a method call such as console.log( or res.json( ).
    const named = /\b(?:my|the|this|that|our|in|of|from|to|open|read|edit|update|fix|see|check|into)\s+[\w.\/\\-]*[\w-]\.(?:jsx?|tsx?|mjs|cjs|py|rb|php|sh|ps1|bat|md|txt|json|csv|tsv|ya?ml|toml|xml|html?|css|sql|docx?|xlsx?|pdf)\b(?!\s*[(\[])/i;
    const looks = /\b(?:look|go|read|scan|search|browse|grep|walk)\s+(?:through|over|at|in|into)?\s*(?:all\s+)?(?:the|my|our)\s+(?:code|source|sources|app|site|scripts?|tests?)\b/i;
    return words.test(m) || named.test(m) || looks.test(m);
  }
  const existing = /\b(?:my|the|this|that|our|these|those|existing|current)\s+(?:\w+\s+)?(?:files?|folders?|directory|directories|repo|repository|codebase|project|workspace)\b/i;
  return saves.test(m) || existing.test(m) || path.test(m);
}

/**
 * wantsFiles for an answer: a Continue has no message of its own, so it is asked about the last thing the person said in
 * the chat (the question the cut answer was answering). Offered the tools on every Continue, a plain chat could be given
 * the "Looking at the files" card again (walk of 17 Nov).
 */
export function wantsFilesFor(message: string, lines: { role: string; content: string }[], inProject = false): boolean {
  if (message.trim()) return wantsFiles(message, inProject);
  const said = [...lines].reverse().find(l => l.role === 'user')?.content;
  return wantsFiles(typeof said === 'string' ? said : '', inProject);
}

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
    if (isFileTool(name) && !(await this.permitted(fileCallWords(name, args).replace(/…$/, '')))) return deniedFor(name);
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(args || '{}') as Record<string, unknown>;
      if (!a || typeof a !== 'object') throw new Error('not an object');
    } catch {
      return 'The call could not be read: its arguments are not JSON.';
    }
    if (name === 'list_files') {
      const { files, more } = await ws.listAll(this.root);
      if (!files.length) return 'There are no text or code files in this folder yet.';
      // Past the list's limit the count is not known: said as more files, so the model does not take the list as all.
      const past = more ? `There are more files in this folder than the ${files.length} listed here: read one by its path with read_file.` : '';
      let out = '';
      for (const [i, f] of files.entries()) {
        const line = `${f.path} (${f.bytes.toLocaleString('en-GB')} bytes)\n`;
        if (out.length + line.length > this.perCall) return `${out}(and ${more ? 'over ' : ''}${files.length - i} more)`;
        out += line;
      }
      return past ? `${out}${past}` : out.trimEnd();
    }
    if (name === 'read_file') {
      const r = await ws.read(this.root, a.path);
      if ('error' in r) return r.error;
      const withheld = withheldWhy(r.path, r.text);
      if (withheld) return withheld;
      const parts = Math.max(1, Math.ceil(r.text.length / this.perCall));
      if (parts === 1) return `${r.path}:\n${r.text}`;
      const part = Math.min(parts, Math.max(1, Math.floor(Number(a.part) || 1)));
      const more = part < parts ? ` (ask for part ${part + 1} for the rest)` : '';
      return `${r.path}, part ${part} of ${parts}${more}:\n${r.text.slice((part - 1) * this.perCall, part * this.perCall)}`;
    }
    if (name === 'save_file') {
      // TOMLIN's own files (jobs\: project rules and plans; the person's notes) are never a model's to write (audit P5).
      const owned = ws.cleanPath(a.path);
      if (owned && ownedByTomlin(owned)) return OWNED_WHY(owned);
      // Standing rules, checked in code (src/rules.ts): no empty or gutted save, no keys or passwords.
      const was = await ws.read(this.root, a.path);
      const refused = typeof a.text === 'string' ? checkSave('error' in was ? null : was.text, a.text) : null;
      if (refused) return refused;
      const r = await ws.save(this.root, a.path, a.text, true, true);
      if ('error' in r) return r.error;
      this.saved.push(r.path);
      return r.created ? `Saved ${r.path} (new file).` : `Saved ${r.path} (the old one is kept as ${r.path}.bak).`;
    }
    return `There is no tool called "${name}". The file tools are list_files, read_file and save_file.`;
  }
}
