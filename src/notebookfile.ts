// A notebook as a plain Markdown file a person can open in Notepad (or any notes app pointed at the folder), and read
// back by code, never by a model. The file is the memory; a small sidecar beside it keeps who wrote each entry and when.
//
//   # Memory: Fern (artist)
//
//   ## Always send
//   - The shop's name is spelled Tomlin & Co.
//
//   ## Style guide
//   - Warm light, no text in pictures.
//     Keep faces out of product shots.
//
// An entry is a bullet ("- ", "* " or "+ " at the start of a line) with the lines under it indented, or a block of
// plain lines up to the next blank line, heading or bullet (as a person types by hand). "## " starts a group; the
// "# " title is only a name for people. Whatever a person writes loads as best it can: no line is ever refused, and an
// entry with a key or password in it is kept in the file but flagged, so it is never sent to a model.
// The plain functions are tested in test/notebookfile.test.ts.
import { createHash } from 'node:crypto';

/** The group a line goes into when none is named. */
export const DEFAULT_GROUP = 'Notes';
/** Lines from Pin on a message. */
export const PIN_GROUP = 'Pinned';

export interface FileEntry {
  group: string;
  text: string;
}

export interface ParsedBook {
  /** Every group in file order, empty ones too (a heading with nothing under it yet). */
  groups: string[];
  entries: FileEntry[];
}

const HEADING = /^(#{1,2})(?:[ \t]+(.*?))?[ \t#]*$/;
const BULLET = /^[-*+][ \t]+(.*)$/;
const INDENTED = /^(?: {2}|\t)(.*)$/;

/** A group's name as kept: one line, no heading marks, at most 80 characters; the default when nothing is left. */
export const cleanGroup = (name: unknown): string => String(name ?? '').replace(/[\r\n\t]+/g, ' ').trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 80) || DEFAULT_GROUP;

/** Reads a notebook file. Never throws: a file in any shape gives its entries, in file order. */
export function parseBook(text: string): ParsedBook {
  const groups: string[] = [];
  const entries: FileEntry[] = [];
  let group = '';
  // The entry being read: its lines, whether it began with a bullet, and blank lines seen since its last line.
  let cur: { lines: string[]; bullet: boolean } | null = null;
  let blanks = 0;
  const useGroup = () => {
    if (!group) {
      group = DEFAULT_GROUP;
      if (!groups.includes(group)) groups.push(group);
    }
    return group;
  };
  const end = () => {
    if (cur) {
      const t = cur.lines.join('\n').trim();
      if (t) entries.push({ group: useGroup(), text: t });
    }
    cur = null;
    blanks = 0;
  };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/[ \t]+$/, '');
    if (!line) {
      if (cur) blanks++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      end();
      // A bare "##" names nothing: the group goes on.
      if (!h[2]?.trim()) continue;
      // "# " is the file's title; a "# " further down is read as a group, as a person may mean it.
      if (h[1] === '##' || entries.length || groups.length) {
        group = cleanGroup(h[2]);
        if (!groups.includes(group)) groups.push(group);
      }
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      end();
      cur = { lines: [b[1]], bullet: true };
      continue;
    }
    const ind = INDENTED.exec(line);
    // Under a bullet, indented lines carry on the entry, after blank lines too (so an entry can hold a blank line).
    if (cur && ind && cur.bullet) {
      cur.lines.push(...Array(blanks).fill(''), ind[1]);
      blanks = 0;
      continue;
    }
    // A plain line straight after the last one (no blank line between) carries it on, as a person types a block.
    if (cur && !blanks) {
      cur.lines.push(cur.bullet && ind ? ind[1] : line);
      continue;
    }
    end();
    cur = { lines: [line.trim() ? line.replace(/^\s+/, '') : line], bullet: false };
  }
  end();
  return { groups, entries };
}

/** Writes a notebook file: the title, then each group with its entries as bullets, lines under them indented. */
export function writeBook(title: string, groups: string[], entries: FileEntry[]): string {
  const order = [...groups];
  for (const e of entries) if (!order.includes(e.group)) order.push(e.group);
  const out = [`# ${title.replace(/[\r\n]+/g, ' ').trim() || 'Memory'}`, ''];
  for (const g of order) {
    out.push(`## ${g}`, '');
    const mine = entries.filter(e => e.group === g);
    for (const e of mine) {
      const [first, ...rest] = e.text.split('\n');
      out.push(`- ${first}`, ...rest.map(l => (l ? `  ${l}` : '')));
    }
    if (mine.length) out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** The key an entry's sidecar facts are kept under: its text, so the file itself carries no ids. */
export const entryHash = (text: string): string => createHash('sha1').update(text.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
