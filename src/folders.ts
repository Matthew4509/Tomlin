// Where work goes in the workspace, one place per kind, with names that sort by time:
//   chats\2026-10-07-1530\           a quick chat's saved files (a chat in Default); moved into a project when the chat
//                                    is put in one ("saved properly")
//   notes\2026-10-07-1530 <words>.md  a note saved from the right panel (Default)
//   <project>\                        the project's own files, and in it:
//     specialists\writer\             what the writer hands in, each file starting with the date and time
//     specialists\images\             the artists' and designers' pictures (cover art, illustrations), the same way
//     admin notes\                    notes saved from the right panel for this project
//   jobs\<id>\                        each project's plan, cards, handoff cards (named with the date and time) and report
// The project manager and the auditor read a project's specialists folders for the work handed in, newest first, not
// the whole workspace: a small (1B) specialist hands in a file, and the newest is on top.
// Plain functions, tested in test/folders.test.ts.

export const CHATS = 'chats';
export const NOTES = 'notes';
export const SPECIALISTS = 'specialists';
export const ADMIN_NOTES = 'admin notes';
/** Workspace folders kept for these: a project cannot take their names. */
export const RESERVED = [CHATS, NOTES];

const pad = (n: number) => String(n).padStart(2, '0');

/** The date and time in this PC's own time, "2026-10-07-1530": the same stamp as a project folder made on Home. */
export function stamp(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** The stamp a name starts with, or null. */
export function stampOf(name: string): string | null {
  return /^(\d{4}-\d{2}-\d{2}-\d{4})(?:-\d+)?(?=$| |-)/.exec(name)?.[1] ?? null;
}

/**
 * Files no model is given: the person's notes (notes\, a project's admin notes\: "no model reads them") and the quick
 * chats' folders (chats\: not a project's work). The planner, the auditor and every step leave them out.
 */
export function keptFromModels(path: string): boolean {
  return new RegExp(`^(${NOTES}|${CHATS})/|(^|/)${ADMIN_NOTES}/`, 'i').test(path);
}

/** The specialist folder a role hands its work into: the writer's "writer", an artist's or a designer's "images". */
export function specialistFolder(role: string): string | null {
  return role === 'writer' ? 'writer' : role === 'artist' || role === 'designer' ? 'images' : null;
}

/** A file name with the date and time in front ("2026-10-07-1530 chapter-1.md"); one that has a stamp keeps it. */
export function stamped(name: string, now = new Date()): string {
  return stampOf(name) ? name : `${stamp(now)} ${name}`;
}

/** A note's first words, for its file name: letters, digits, spaces and hyphens only, at most `max` characters. */
export function firstWords(text: string, max = 40): string {
  const words = text.replace(/[^\p{L}\p{N}\s-]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ');
  let out = '';
  for (const w of words) {
    if ((out ? `${out} ${w}` : w).length > max) break;
    out = out ? `${out} ${w}` : w;
  }
  return (out || words[0]?.slice(0, max) || '').replace(/[-\s]+$/, '') || 'note';
}

/** Folders joined by "/", the workspace itself ('') left out. */
const inProject = (projectFolder: string, ...rest: string[]) => [projectFolder, ...rest].filter(Boolean).join('/');

/**
 * Where a note from the right panel is saved: notes\<stamp> <words>.md, or (`projectFolder`, '' for a project kept at
 * the top of the workspace) that project's admin notes.
 */
export function notePath(text: string, projectFolder: string | null, now = new Date()): string {
  const name = `${stamp(now)} ${firstWords(text)}.md`;
  return projectFolder === null ? `${NOTES}/${name}` : inProject(projectFolder, ADMIN_NOTES, name);
}

/** A quick chat's folder, from when it was started: chats/2026-10-07-1530, with -2, -3 when another chat has that minute. */
export function chatFolder(created: string, taken: Iterable<string>): string {
  const t = Date.parse(created);
  const base = `${CHATS}/${stamp(Number.isNaN(t) ? new Date() : new Date(t))}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Where Save puts a file from a chat, and whether its name starts with the date and time: a chat in Default saves into
 * its own chats\<stamp> folder; a chat in a project into the project, and a writer's, artist's or designer's chat into
 * that project's specialists folder, stamped (code keeps its own name: index.html must stay index.html).
 */
export function saveTo(o: { chatFolder: string; projectFolder: string | null; role: string }): { dir: string; stamped: boolean } {
  if (o.projectFolder === null) return { dir: o.chatFolder, stamped: false };
  const sp = specialistFolder(o.role);
  return sp ? { dir: inProject(o.projectFolder, SPECIALISTS, sp), stamped: true } : { dir: o.projectFolder, stamped: false };
}

/** Where an artist's or designer's picture kept in a project chat is handed in: specialists\images\<stamp> <words>.png. */
export function picturePath(projectFolder: string, prompt: string, ext: string, now = new Date()): string {
  return inProject(projectFolder, SPECIALISTS, 'images', `${stamp(now)} ${firstWords(prompt)}${ext}`);
}

/**
 * A quick chat's files going into a project: each one under `from` to the same place under `dest` ('' = the top of the
 * workspace). Going into a specialists folder (`stampWith`, the chat's own date and time) each name starts with it.
 * A file whose name is taken there stays where it is (nothing is written over).
 */
export function moves(files: string[], from: string, dest: string, there: Set<string>, stampWith = ''): { move: { from: string; to: string }[]; stay: string[] } {
  const move: { from: string; to: string }[] = [];
  const stay: string[] = [];
  for (const f of files) {
    if (!f.startsWith(`${from}/`)) continue;
    const rest = f.slice(from.length + 1);
    const named = stampWith && !rest.includes('/') && !stampOf(rest) ? `${stampWith} ${rest}` : rest;
    const to = dest ? `${dest}/${named}` : named;
    if (there.has(to)) stay.push(f);
    else move.push({ from: f, to });
  }
  return { move, stay };
}

export interface HandedIn {
  /** The specialist folder ("writer", "images"). */
  folder: string;
  /** Relative to the project folder. */
  path: string;
  bytes: number;
  /** When it was handed in: the stamp in its name, else when the file was last saved. */
  when: string;
}

/** The work handed in to a project's specialists folders, newest first (by the stamp in each name). */
export function handedIn(files: { path: string; bytes: number; at: string }[]): HandedIn[] {
  const out: HandedIn[] = [];
  for (const f of files) {
    const m = new RegExp(`^${SPECIALISTS}/([^/]+)/(.+)$`).exec(f.path);
    if (!m || /\.bak$/i.test(f.path)) continue;
    const t = Date.parse(f.at);
    out.push({ folder: m[1], path: f.path, bytes: f.bytes, when: stampOf(m[2].split('/').pop()!) ?? stamp(Number.isNaN(t) ? new Date(0) : new Date(t)) });
  }
  return out.sort((a, b) => b.when.localeCompare(a.when) || b.path.localeCompare(a.path));
}

/** The handed-in work as lines for the project manager and the auditor: newest first, the newest of each folder marked. */
export function handedInLines(list: HandedIn[], max = 20): string[] {
  const first = new Set<string>();
  return list.slice(0, max).map(h => {
    const newest = !first.has(h.folder);
    first.add(h.folder);
    return `${h.path} (${h.bytes.toLocaleString('en-GB')} characters${newest ? `, the newest from the ${h.folder} folder` : ''})`;
  });
}

const TEXT_FILE = /\.(md|txt)$/i;
/** Text that belongs to the project itself, not handed-in work: it stays where it is planned. */
const PROJECT_TEXT = /^(readme|license|licence|changelog|contributing|notes?)\b/i;

/**
 * The writer's new text files planned at the top of a project go into specialists/writer, each named with the date and
 * time ("specialists/writer/2026-10-07-1530 chapter-1.md"), and every step that names one (its files, title, brief and
 * check) follows, so a later step still finds it. Files that are there already, or are planned in a folder, stay.
 */
export function writerHandIn<S extends { role: string; files: string[]; title: string; brief: string; check: string }>(steps: S[], existing: Set<string>, now = new Date()): { steps: S[]; moved: Record<string, string> } {
  const moved: Record<string, string> = {};
  for (const s of steps) {
    if (s.role !== 'writer') continue;
    for (const f of s.files) if (!f.includes('/') && TEXT_FILE.test(f) && !PROJECT_TEXT.test(f) && !existing.has(f)) moved[f] = `${SPECIALISTS}/writer/${stamped(f, now)}`;
  }
  if (!Object.keys(moved).length) return { steps, moved };
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = (text: string) => Object.entries(moved).reduce((t, [a, b]) => t.replace(new RegExp(`(?<![\\w/.-])${esc(a)}(?![\\w.-])`, 'g'), b), text);
  return { moved, steps: steps.map(s => ({ ...s, files: s.files.map(f => moved[f] ?? f), title: words(s.title), brief: words(s.brief), check: words(s.check) })) };
}
